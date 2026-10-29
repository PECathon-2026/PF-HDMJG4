import { useEffect, useState } from "react";

import { openDB } from "idb";

import { XMLParser } from "fast-xml-parser";

import { Readability } from "@mozilla/readability";

import DOMPurify from "dompurify";

import "./App.css";



const API = "http://127.0.0.1:8000";

const DB_NAME = "openfolio-db";

const DB_VERSION = 1;



const SEED_FEEDS = [

  {

    name: "Hacker News",

    url: "https://hnrss.org/frontpage",

    description: "Technology, programming and the independent web.",

    color: "#f6c58b",

  },

  {

    name: "CSS-Tricks",

    url: "https://css-tricks.com/feed/",

    description: "Web development and frontend design.",

    color: "#c9d9f5",

  },

  {

    name: "Smashing Magazine",

    url: "https://www.smashingmagazine.com/feed/",

    description: "Design, UX and web development.",

    color: "#f4c8c8",

  },

  {

    name: "A List Apart",

    url: "https://alistapart.com/main/feed/",

    description: "Thoughtful writing about web design and standards.",

    color: "#cce7d0",

  },

  {

    name: "The Pragmatic Engineer",

    url: "https://newsletter.pragmaticengineer.com/feed",

    description: "Software engineering and technology careers.",

    color: "#e3d3f4",

  },

];



const dbPromise = openDB(DB_NAME, DB_VERSION, {

  upgrade(db) {

    if (!db.objectStoreNames.contains("feeds")) {

      db.createObjectStore("feeds", { keyPath: "url" });

    }

    if (!db.objectStoreNames.contains("articles")) {

      db.createObjectStore("articles", { keyPath: "id" });

    }

  },

});



const parser = new XMLParser({

  ignoreAttributes: false,

  attributeNamePrefix: "@_",

  textNodeName: "#text",

  trimValues: true,

  cdataPropName: "__cdata",

});



function textValue(value) {

  if (value == null) return "";



  if (typeof value === "string" || typeof value === "number") {

    return String(value);

  }



  if (Array.isArray(value)) {

    return textValue(value[0]);

  }



  if (typeof value === "object") {

    return textValue(value.__cdata ?? value["#text"] ?? "");

  }



  return "";

}



function cleanExcerpt(value) {

  return textValue(value)

    .replace(/<[^>]*>/g, " ")

    .replace(/&nbsp;/gi, " ")

    .replace(/&amp;/gi, "&")

    .replace(/&quot;/gi, '"')

    .replace(/&#39;/gi, "'")

    .replace(/&lt;/gi, "<")

    .replace(/&gt;/gi, ">")

    .replace(/\s+/g, " ")

    .trim()

    .slice(0, 500);

}



function getLink(link) {

  if (typeof link === "string") return link;



  if (Array.isArray(link)) {

    const alternate = link.find(

      (item) => item?.["@_rel"] === "alternate"

    );

    return getLink(alternate ?? link[0]);

  }



  if (link && typeof link === "object") {

    return link["@_href"] || textValue(link);

  }



  return "";

}



function parseFeed(xml, feedName, feedUrl) {

  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel;

  const atomFeed = parsed?.feed;

  const rawItems = channel ? channel.item : atomFeed?.entry;



  const entries = rawItems

    ? Array.isArray(rawItems)

      ? rawItems

      : [rawItems]

    : [];



  return entries

    .map((entry) => {

      const link = getLink(entry.link);

      const title = textValue(entry.title) || "Untitled article";

      const url = link || feedUrl;



      const date = textValue(

        entry.pubDate ??

          entry.published ??

          entry.updated ??

          entry["dc:date"]

      );



      const excerpt = cleanExcerpt(

        entry.description ??

          entry.summary ??

          entry.content ??

          entry["content:encoded"]

      );



      return {

        id: url,

        title,

        url,

        feedName,

        feedUrl,

        date,

        excerpt,

        read: false,

        fullHtml: "",

        fullTitle: "",

        byline: "",

      };

    })

    .filter((article) => article.url);

}



function normalizeFeedUrl(value) {

  const url = new URL(value.trim());



  if (!["http:", "https:"].includes(url.protocol)) {

    throw new Error("Please enter an HTTP or HTTPS URL.");

  }



  if (url.username || url.password) {

    throw new Error("URLs containing login credentials aren't allowed.");

  }



  url.hash = "";

  return url.href;

}



async function fetchRemote(url) {

  const response = await fetch(

    `${API}/api/fetch?url=${encodeURIComponent(url)}`

  );



  const result = await response.json().catch(() => ({}));



  if (!response.ok) {

    throw new Error(

      result.detail || `Request failed (${response.status}).`

    );

  }



  return result;

}



async function extractArticle(articleUrl) {

  const result = await fetchRemote(articleUrl);



  if (

    !result.body ||

    !result.content_type?.toLowerCase().includes("text/html")

  ) {

    throw new Error("This link did not return an HTML article.");

  }



  const documentCopy = new DOMParser().parseFromString(

    result.body,

    "text/html"

  );



  const parsedArticle = new Readability(documentCopy).parse();



  if (!parsedArticle?.content) {

    throw new Error("No readable article content could be extracted.");

  }



  return {

    title: parsedArticle.title || "Article",

    byline: parsedArticle.byline || "",

    content: DOMPurify.sanitize(parsedArticle.content, {

      USE_PROFILES: { html: true },

    }),

  };

}



function formatDate(date) {

  if (!date) return "";



  const parsed = new Date(date);



  if (Number.isNaN(parsed.getTime())) return "";



  return new Intl.DateTimeFormat("en", {

    month: "short",

    day: "numeric",

    year: "numeric",

  }).format(parsed);

}



function getHost(url) {

  try {

    return new URL(url).hostname.replace(/^www\./, "");

  } catch {

    return "";

  }

}



export default function App() {

  const [page, setPage] = useState("All articles");

  const [feedList, setFeedList] = useState([]);

  const [discoveryBlogs, setDiscoveryBlogs] = useState([]);

const [recommendations, setRecommendations] = useState([]);

  const [discoveryLoading, setDiscoveryLoading] = useState(false);

  const [items, setItems] = useState([]);

  const [selectedId, setSelectedId] = useState(null);

  const [search, setSearch] = useState("");

  const [feedUrl, setFeedUrl] = useState("");

  const [message, setMessage] = useState("");

  const [unreadOnly, setUnreadOnly] = useState(false);

  const [storageReady, setStorageReady] = useState(false);

  const [loadingFeed, setLoadingFeed] = useState(false);

  const [readerLoading, setReaderLoading] = useState(false);

  const [readerError, setReaderError] = useState("");

  const [readerOpen, setReaderOpen] = useState(false);

  const [refreshing, setRefreshing] = useState(false);



  const selectedArticle =

    items.find((article) => article.id === selectedId) ?? null;



  // Load subscriptions and articles from IndexedDB.

  useEffect(() => {

    let cancelled = false;



    async function loadSavedData() {

      try {

        const db = await dbPromise;

        const [savedFeeds, savedArticles] = await Promise.all([

          db.getAll("feeds"),

          db.getAll("articles"),

        ]);



        if (cancelled) return;



        setFeedList(savedFeeds);

        setItems(savedArticles);

      } catch (error) {

        console.error("Could not load local data:", error);



        if (!cancelled) {

          setMessage("Could not load local data. Check the browser console.");

        }

      } finally {

        if (!cancelled) setStorageReady(true);

      }

    }



    loadSavedData();



    return () => {

      cancelled = true;

    };

  }, []);



  // Persist subscriptions locally.

  useEffect(() => {

    if (!storageReady) return;



    async function saveFeeds() {

      try {

        const db = await dbPromise;

        const tx = db.transaction("feeds", "readwrite");



        await tx.store.clear();



        for (const feed of feedList) {

          await tx.store.put(feed);

        }



        await tx.done;

      } catch (error) {

        console.error("Could not save feeds:", error);

      }

    }



    saveFeeds();

  }, [feedList, storageReady]);



  // Persist articles, including extracted content, for offline reading.

  useEffect(() => {

    if (!storageReady) return;



    async function saveArticles() {

      try {

        const db = await dbPromise;

        const tx = db.transaction("articles", "readwrite");



        await tx.store.clear();



        for (const article of items) {

          await tx.store.put(article);

        }



        await tx.done;

      } catch (error) {

        console.error("Could not save articles:", error);

      }

    }



    saveArticles();

  }, [items, storageReady]);



async function loadDiscovery() {

  setDiscoveryLoading(true);



  try {

    const response = await fetch(`${API}/api/discover`);



    if (!response.ok) {

      throw new Error("Could not load blog recommendations.");

    }



    const result = await response.json();

    setDiscoveryBlogs(result.blogs || []);

  } catch (error) {

    console.error("Discovery error:", error);

    setMessage(

      "Could not load discovery blogs. Check that the backend is running."

    );

  } finally {

    setDiscoveryLoading(false);

  }

}
async function loadRecommendations(feedUrl) {
  try {
    const response = await fetch(
      `${API}/api/discover/recommend?url=${encodeURIComponent(feedUrl)}`
    );

    if (!response.ok) {
      throw new Error("Could not load recommendations.");
    }

    const result = await response.json();
    setRecommendations(result.recommendations || []);
  } catch (error) {
    console.error("Recommendation error:", error);
    setRecommendations([]);
  }
}

useEffect(() => {

  if (page === "Discover") {

    loadDiscovery();

  }

}, [page]);



  async function addFeed(event) {

    event.preventDefault();

    setMessage("");



    let normalizedUrl;



    try {

      normalizedUrl = normalizeFeedUrl(feedUrl);

    } catch (error) {

      setMessage(error.message || "Enter a valid feed URL.");

      return;

    }



    if (feedList.some((feed) => feed.url === normalizedUrl)) {

      setMessage("You're already subscribed to this feed.");

      return;

    }



    if (feedList.length >= 50) {

      setMessage("You've reached the 50-feed limit for this prototype.");

      return;

    }



    setLoadingFeed(true);



    try {

      const result = await fetchRemote(normalizedUrl);



      if (!result.body) {

        throw new Error("The server returned an empty response.");

      }



      const feedName = getHost(normalizedUrl);

      const parsedArticles = parseFeed(

        result.body,

        feedName,

        normalizedUrl

      );



      if (parsedArticles.length === 0) {

        throw new Error(

          "No articles found. Enter a valid RSS or Atom feed URL."

        );

      }



      setFeedList((current) => [

        ...current,

        { url: normalizedUrl, name: feedName },

      ]);



      setItems((current) => {

        const existingIds = new Set(

          current.map((article) => article.id)

        );



        const uniqueArticles = parsedArticles.filter(

          (article) => !existingIds.has(article.id)

        );



        return [...uniqueArticles, ...current].slice(0, 1000);

      });



      setFeedUrl("");

      setPage("All articles");

      setSelectedId(null);

      setReaderOpen(false);

      setMessage(`Subscribed to ${feedName}.`);

      // Update discovery popularity only after the feed was added locally.
      const isDiscoveryBlog = discoveryBlogs.some(
        (blog) => blog.url === normalizedUrl
      );

      if (isDiscoveryBlog) {
        try {
          const response = await fetch(`${API}/api/discover/subscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: normalizedUrl }),
          });

          if (!response.ok) {
            throw new Error(`Discovery count request failed (${response.status}).`);
          }

          const result = await response.json();
          setDiscoveryBlogs((currentBlogs) =>
            currentBlogs.map((blog) =>
              blog.url === result.blog.url ? result.blog : blog
            )
          );
        } catch (error) {
          console.error("Discovery count update failed:", error);
        }
      }

    } catch (error) {

      setMessage(error.message || "Could not load this feed.");

    } finally {

      setLoadingFeed(false);

    }

  }



  async function refreshFeeds() {

    if (!feedList.length || refreshing) return;



    setRefreshing(true);

    setMessage("");



    let addedCount = 0;

    const collected = [];



    try {

      for (const feed of feedList) {

        try {

          const result = await fetchRemote(feed.url);

          if (!result.body) continue;



          const freshArticles = parseFeed(

            result.body,

            feed.name,

            feed.url

          );



          collected.push(...freshArticles);

        } catch (error) {

          console.warn("Could not refresh:", feed.url, error);

        }

      }



      setItems((current) => {

        const existingIds = new Set(

          current.map((article) => article.id)

        );



        const unique = collected.filter((article) => {

          if (existingIds.has(article.id)) return false;

          existingIds.add(article.id);

          addedCount += 1;

          return true;

        });



        return [...unique, ...current].slice(0, 1000);

      });



      setMessage(

        addedCount

          ? `Refresh complete. Found ${addedCount} new articles.`

          : "Refresh complete. No new articles found."

      );

    } finally {

      setRefreshing(false);

    }

  }



  async function openArticle(article) {

    setSelectedId(article.id);

    setReaderOpen(true);

    setReaderError("");

    setPage("All articles");



    // Mark as read immediately.

    setItems((current) =>

      current.map((item) =>

        item.id === article.id ? { ...item, read: true } : item

      )

    );



    // Previously extracted content can be opened offline.

    if (article.fullHtml) return;



    if (!navigator.onLine) {

      setReaderError(

        "This article hasn't been saved for offline reading yet."

      );

      return;

    }



    setReaderLoading(true);



    try {

      const extracted = await extractArticle(article.url);



      setItems((current) =>

        current.map((item) =>

          item.id === article.id

            ? {

                ...item,

                fullHtml: extracted.content,

                fullTitle: extracted.title,

                byline: extracted.byline,

              }

            : item

        )

      );

    } catch (error) {

      setReaderError(

        error.message ||

          "Could not extract the article. You can still open the original website."

      );

    } finally {

      setReaderLoading(false);

    }

  }



  function toggleRead(articleId) {

    setItems((current) =>

      current.map((article) =>

        article.id === articleId

          ? { ...article, read: !article.read }

          : article

      )

    );

  }



  function removeFeed(url) {

    const articleIds = items

      .filter((article) => article.feedUrl === url)

      .map((article) => article.id);



    setFeedList((current) =>

      current.filter((feed) => feed.url !== url)

    );



    setItems((current) =>

      current.filter((article) => article.feedUrl !== url)

    );



    if (selectedArticle?.feedUrl === url) {

      setSelectedId(null);

      setReaderOpen(false);

    }



    setMessage("Subscription removed.");

  }



  function addSuggestedFeed(feed) {

    setFeedUrl(feed.url);

    setPage("Subscriptions");

    setMessage("The feed URL is ready. Select Add feed to subscribe.");

  }



  const visibleArticles = items.filter((article) => {

    const searchText = search.toLowerCase();



    const matchesSearch = [

      article.title,

      article.feedName,

      article.excerpt,

    ]

      .join(" ")

      .toLowerCase()

      .includes(searchText);



    const matchesUnread = !unreadOnly || !article.read;



    const matchesPage =

      page === "All articles" ||

      (page === "Unread" && !article.read) ||

      page === "Subscriptions";



    return matchesSearch && matchesUnread && matchesPage;

  });



  const unreadCount = items.filter((article) => !article.read).length;



  return (

    <div className="of-app">



      <aside className="of-sidebar">

        <div className="of-brand">

          <div className="of-logo">o</div>

          <div>

            <div className="of-brand-name">openfolio</div>

            <div className="of-tagline">A quieter corner of the web</div>

          </div>

        </div>



        <div>

          <div className="of-section-label">Your reading space</div>

          <nav className="of-nav">

            <button

              className={page === "All articles" ? "active" : ""}

              onClick={() => setPage("All articles")}

            >

              <span className="of-nav-icon">▤</span>

              All articles

            </button>



            <button

              className={page === "Unread" ? "active" : ""}

              onClick={() => {

                setPage("Unread");

                setUnreadOnly(false);

              }}

            >

              <span className="of-nav-icon">◉</span>

              Unread

              <span className="of-count">{unreadCount}</span>

            </button>



            <button

              className={page === "Subscriptions" ? "active" : ""}

              onClick={() => setPage("Subscriptions")}

            >

              <span className="of-nav-icon">▧</span>

              Feeds

              <span className="of-count">{feedList.length}</span>

            </button>



            <button

              className={page === "Discover" ? "active" : ""}

              onClick={() => setPage("Discover")}

            >

              <span className="of-nav-icon">✳</span>

              Discover

            </button>

          </nav>

        </div>



        <div className="of-sidebar-bottom">

          <div className="of-privacy">

            <strong>♧ Your reading stays yours</strong>

            Your subscriptions and saved articles live in this browser. Openfolio does not require an account.

          </div>

        </div>

      </aside>



      <main className="of-main">

        <header className="of-topbar">

          <div>

            <div className="of-heading">

              {page === "All articles"

                ? "Your reading garden"

                : page === "Unread"

                  ? "Still to explore"

                  : page === "Subscriptions"

                    ? "Your publications"

                    : "Find your next read"}

            </div>

            <div className="of-subheading">

              {page === "Discover"

                ? "Independent voices worth listening to."

                : `${items.length} articles · ${feedList.length} publications`}

            </div>

          </div>



          <input

            className="of-search"

            value={search}

            onChange={(event) => setSearch(event.target.value)}

            placeholder="⌕  Search articles and publications..."

            aria-label="Search articles and publications"

          />

        </header>



        <div className="of-content">

          {message && (

            <div className="of-message" role="status">

              {message}

              <button

                className="of-text-button"

                style={{ float: "right" }}

                onClick={() => setMessage("")}

              >

                Dismiss

              </button>

            </div>

          )}



          {page === "Discover" && (

            <>

              <div className="of-toolbar">

                <div>

                  <strong>Handpicked starting points</strong>

                  <div className="of-muted" style={{ marginTop: 5 }}>

                    Explore a few publications, then add their feeds.

                  </div>

                </div>

              </div>



              <div className="of-cards">

                {discoveryBlogs.filter((feed) =>

                  `${feed.name} ${feed.category || ""} ${feed.url}`

                    .toLowerCase()

                    .includes(search.toLowerCase())

                ).map((feed) => {

                  const subscribed = feedList.some(

                    (item) => item.url === feed.url

                  );



                  return (

                    <article className="of-card" key={feed.url}>

                      <div

                        className="of-card-color"

                        style={{ background: feed.color }}

                      >

                        ✳

                      </div>

                      <h3>{feed.name}</h3>
                      <p>{feed.category}</p>
                      <small>{feed.subscriber_count} readers subscribed</small>
                      <small>{feed.url}</small>

                      <button

                        className="of-button"

                        disabled={subscribed || loadingFeed}

                        onClick={() => addSuggestedFeed(feed)}

                      >

                        {subscribed ? "Already subscribed" : "Add publication"}

                      </button>

                    </article>

                  );

                })}

              </div>



              <div className="of-footer">

                Suggestions are a starter directory, not a popularity ranking.

              </div>

            </>

          )}



          {page === "Subscriptions" && (

            <>

              <section className="of-list-panel" style={{ marginBottom: 22 }}>

                <div className="of-panel-heading">

                  <span>Add a publication</span>

                  <span className="of-muted">RSS / Atom</span>

                </div>



                <div style={{ padding: 20 }}>

                  <form className="of-feed-form" onSubmit={addFeed}>

                    <input

                      className="of-input"

                      type="url"

                      value={feedUrl}

                      onChange={(event) => setFeedUrl(event.target.value)}

                      placeholder="https://example.com/feed.xml"

                      required

                    />

                    <button

                      className="of-button"

                      disabled={loadingFeed}

                      type="submit"

                    >

                      {loadingFeed ? "Adding..." : "Add feed"}

                    </button>

                  </form>

                  <div className="of-muted" style={{ marginTop: 10 }}>

                    Paste an RSS or Atom feed URL. A website homepage may not be a feed.

                  </div>

                </div>

              </section>



              <section className="of-list-panel">

                <div className="of-panel-heading">

                  <span>Your subscriptions</span>

                  <span className="of-muted">{feedList.length} feeds</span>

                </div>



                {feedList.length === 0 ? (

                  <div className="of-empty">

                    <div className="of-empty-icon">♧</div>

                    No publications yet. Add a feed above or visit Discover.

                  </div>

                ) : (

                  feedList.map((feed) => (

                    <div className="of-subscription" key={feed.url}>

                      <div>

                        <strong>{feed.name}</strong>

                        <small>{feed.url}</small>

                      </div>

                      <button

                        className="of-text-button"

                        onClick={() => removeFeed(feed.url)}

                      >

                        Remove

                      </button>

                    </div>

                  ))

                )}

              </section>

            </>

          )}



          {(page === "All articles" || page === "Unread") && (

            <>

              <div className="of-toolbar">

                <button

                  className="of-button of-button-light"

                  onClick={refreshFeeds}

                  disabled={refreshing || feedList.length === 0}

                >

                  {refreshing ? "Refreshing..." : "↻ Refresh feeds"}

                </button>



                <label className="of-checkbox">

                  <input

                    type="checkbox"

                    checked={unreadOnly}

                    onChange={(event) => setUnreadOnly(event.target.checked)}

                  />

                  Show unread only

                </label>



                <span className="of-muted" style={{ marginLeft: "auto" }}>

                  {visibleArticles.length} shown

                </span>

              </div>



              <div className="of-article-layout">

                <section className="of-list-panel">

                  <div className="of-panel-heading">

                    <span>Latest stories</span>

                    <span className="of-muted">{visibleArticles.length}</span>

                  </div>



                  {visibleArticles.length === 0 ? (

                    <div className="of-empty">

                      <div className="of-empty-icon">✳</div>

                      {items.length === 0

                        ? "Your reading garden is waiting. Add a feed to get started."

                        : "No matching articles. Try another search or filter."}

                    </div>

                  ) : (

                    visibleArticles.map((article) => (

                      <article

                        className={`of-article-row ${
                          selectedId === article.id ? "selected" : ""
                        }`}

                        key={article.id}

                        onClick={() => openArticle(article)}

                      >

                        <div className="of-row-meta">

                          {!article.read && <span className="of-dot" />}

                          <span>{article.feedName}</span>

                          {formatDate(article.date) && (

                            <>

                              <span>·</span>

                              <span>{formatDate(article.date)}</span>

                            </>

                          )}

                        </div>



                        <div className="of-article-title">

                          {article.title}

                        </div>



                        <div className="of-excerpt">

                          {article.excerpt || "Open this story to read more."}

                        </div>



                        <div className="of-row-actions">

                          <button

                            className="of-text-button"

                            onClick={(event) => {

                              event.stopPropagation();

                              toggleRead(article.id);

                            }}

                          >

                            {article.read

                              ? "Mark unread"

                              : "Mark as read"}

                          </button>



                          {article.fullHtml && (

                            <span className="of-muted">· Saved offline</span>

                          )}

                        </div>

                      </article>

                    ))

                  )}

                </section>



                <section className="of-reader">

                  {!readerOpen || !selectedArticle ? (

                    <div className="of-empty" style={{ paddingTop: 100 }}>

                      <div className="of-empty-icon">📖</div>

                      <strong style={{ color: "#657568" }}>

                        A little space to read

                      </strong>

                      <p>Select a story to open its reading view.</p>

                      <p className="of-muted">

                        Previously extracted articles are saved in this browser.

                      </p>

                    </div>

                  ) : (

                    <>

                      <div className="of-reader-top">

                        <button

                          className="of-text-button"

                          onClick={() => setReaderOpen(false)}

                        >

                          ← Close reader

                        </button>



                        <a

                          className="of-text-button"

                          href={selectedArticle.url}

                          target="_blank"

                          rel="noopener noreferrer"

                        >

                          Original ↗

                        </a>

                      </div>



                      <div className="of-reader-content">

                        <div className="of-row-meta">

                          <span>{selectedArticle.feedName}</span>

                          {formatDate(selectedArticle.date) && (

                            <>

                              <span>·</span>

                              <span>{formatDate(selectedArticle.date)}</span>

                            </>

                          )}

                        </div>



                        <h1>

                          {selectedArticle.fullTitle ||

                            selectedArticle.title}

                        </h1>



                        {selectedArticle.byline && (

                          <div className="of-byline">

                            By {selectedArticle.byline}

                          </div>

                        )}



                        {readerLoading && (

                          <div className="of-empty">

                            <div className="of-empty-icon">✳</div>

                            Extracting the article for comfortable reading...

                          </div>

                        )}



                        {readerError && !readerLoading && (

                          <div className="of-reader-error">

                            {readerError}

                            <div style={{ marginTop: 10 }}>

                              <a

                                href={selectedArticle.url}

                                target="_blank"

                                rel="noopener noreferrer"

                              >

                                Read on the original website ↗

                              </a>

                            </div>

                          </div>

                        )}



                        {!readerLoading && selectedArticle.fullHtml && (

                          <div

                            className="of-prose"

                            dangerouslySetInnerHTML={{

                              __html: selectedArticle.fullHtml,

                            }}

                          />

                        )}



                        {!readerLoading &&

                          !selectedArticle.fullHtml &&

                          !readerError && (

                            <div className="of-prose">

                              <p>

                                {selectedArticle.excerpt ||

                                  "No summary is available for this article."}

                              </p>

                            </div>

                          )}



                        <div style={{ marginTop: 30 }}>

                          <a

                            className="of-text-button"

                            href={selectedArticle.url}

                            target="_blank"

                            rel="noopener noreferrer"

                          >

                            Visit original publication ↗

                          </a>

                        </div>

                      </div>

                    </>

                  )}

                </section>

              </div>

            </>

          )}

        </div>

      </main>

    </div>

  );

}
