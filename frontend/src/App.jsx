
import { useState } from "react";
import { XMLParser } from "fast-xml-parser";
import "./App.css";

const API = "http://127.0.0.1:8000";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  cdataPropName: "__cdata",
});

function textValue(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (value && typeof value === "object") {
    if ("__cdata" in value) return textValue(value.__cdata);
    if ("#text" in value) return textValue(value["#text"]);
  }

  return "";
}

function cleanExcerpt(value) {
  return textValue(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArticleUrl(value, feedUrl) {
  try {
    const url = new URL(value, feedUrl);
    if (!["http:", "https:"].includes(url.protocol)) return feedUrl;
    return url.href;
  } catch {
    return feedUrl;
  }
}

function parseFeed(xml, feedName, feedUrl) {
  const parsed = xmlParser.parse(xml);
  const root = parsed.rss?.channel || parsed.feed;

  if (!root) {
    throw new Error("This URL did not return a supported RSS or Atom feed.");
  }

  let entries = [];

  if (root.item) {
    entries = Array.isArray(root.item) ? root.item : [root.item];
  } else if (root.entry) {
    entries = Array.isArray(root.entry) ? root.entry : [root.entry];
  }

  if (!entries.length) {
    throw new Error("No articles were found in this feed.");
  }

  return entries.map((entry, index) => {
    let articleUrl = "";
    const links = Array.isArray(entry.link)
      ? entry.link
      : entry.link
        ? [entry.link]
        : [];

    for (const link of links) {
      if (typeof link === "string") {
        articleUrl = link;
        break;
      }

      if (
        link &&
        typeof link === "object" &&
        (link["@_rel"] === "alternate" || !link["@_rel"]) &&
        (link["@_href"] || link["#text"])
      ) {
        articleUrl = link["@_href"] || link["#text"];
        break;
      }
    }

    articleUrl ||= textValue(entry.guid || entry.id) || feedUrl;
    articleUrl = normalizeArticleUrl(articleUrl, feedUrl);

    const title = cleanExcerpt(entry.title) || "Untitled article";
    const rawDate = textValue(
      entry.pubDate ||
      entry.published ||
      entry.updated ||
      entry["dc:date"]
    );

    const timestamp = rawDate ? Date.parse(rawDate) || 0 : 0;

    const rawDescription =
      entry.description ??
      entry.summary ??
      entry["content:encoded"] ??
      entry.content ??
      "";

    const excerpt =
      cleanExcerpt(rawDescription).slice(0, 350) ||
      "Open the original article to continue reading.";

    return {
      id: `${feedUrl}|${articleUrl}`,
      category: "ARTICLE",
      title,
      blog: feedName,
      date: timestamp
        ? new Date(timestamp).toLocaleDateString()
        : "Date unavailable",
      timestamp,
      read: false,
      color: ["peach", "blue", "green", "lavender"][index % 4],
      excerpt,
      url: articleUrl,
      feedUrl,
    };
  });
}

function App() {
  const [page, setPage] = useState("All articles");
  const [feedList, setFeedList] = useState([]);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [message, setMessage] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);

  const visibleItems = items
    .filter((article) => {
      const matchesSearch =
        `${article.title} ${article.blog} ${article.category}`
          .toLowerCase()
          .includes(search.toLowerCase());

      const matchesUnread = !unreadOnly || !article.read;
      const matchesPage = page !== "Unread" || !article.read;
      const matchesFeed =
        !feedList.some((feed) => feed.name === page) ||
        article.blog === page;

      return (
        matchesSearch &&
        matchesUnread &&
        matchesPage &&
        matchesFeed
      );
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  async function addFeed(event) {
    event.preventDefault();

    if (busy) return;

    const url = feedUrl.trim();
    let parsedUrl;

    try {
      parsedUrl = new URL(url);

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported.");
      }
    } catch {
      setMessage("Enter a valid feed URL beginning with https:// or http://.");
      return;
    }

    if (feedList.some((feed) => feed.url === url)) {
      setMessage("You have already subscribed to this feed.");
      return;
    }

    setBusy(true);
    setMessage("Fetching and parsing the feed…");

    try {
      const response = await fetch(
        `${API}/api/fetch?url=${encodeURIComponent(url)}`
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.detail || `Feed request failed (${response.status}).`
        );
      }

      const contentType = (result.content_type || "").toLowerCase();

      if (
        contentType &&
        !contentType.includes("xml") &&
        !contentType.includes("rss") &&
        !contentType.includes("atom") &&
        !contentType.includes("text/plain") &&
        !contentType.includes("rdf")
      ) {
        throw new Error(
          "This URL returned a webpage, not an obvious RSS/Atom feed. Try its feed URL."
        );
      }

      const name = parsedUrl.hostname.replace(/^www\./i, "");
      const newArticles = parseFeed(result.body, name, url);

      setFeedList((current) => [
        ...current,
        { name, url, count: newArticles.length },
      ]);

      setItems((current) => {
        const existingIds = new Set(current.map((item) => item.id));
        const uniqueArticles = newArticles.filter(
          (item) => !existingIds.has(item.id)
        );

        return [...current, ...uniqueArticles].sort(
          (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
        );
      });

      setPage(name);
      setSelected(null);
      setFeedUrl("");
      setMessage(
        `Successfully loaded ${newArticles.length} articles from ${name}.`
      );
    } catch (error) {
      setMessage(
        error.message ||
          "Unable to load this feed. Check the URL and backend server."
      );
    } finally {
      setBusy(false);
    }
  }

  function markRead(article) {
    const updated = { ...article, read: true };

    setItems((current) =>
      current.map((item) =>
        item.id === article.id ? updated : item
      )
    );

    setSelected(updated);
  }

  function toggleRead(article, event) {
    event?.stopPropagation();

    setItems((current) =>
      current.map((item) =>
        item.id === article.id
          ? { ...item, read: !item.read }
          : item
      )
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => {
            setPage("All articles");
            setSelected(null);
          }}
        >
          <span className="brand-icon">o.</span>
          <span>
            <strong>openfolio</strong>
            <small>THE OPEN WEB, YOUR WAY</small>
          </span>
        </button>

        <button
          className="add-feed"
          onClick={() => {
            setPage("Add a feed");
            setSelected(null);
            setMessage("");
          }}
        >
          ＋ Add a feed
        </button>

        <div className="nav-label">LIBRARY</div>

        {[
          ["All articles", "▤"],
          ["Unread", "◉"],
          ["Discover", "✳"],
        ].map(([label, icon]) => (
          <button
            key={label}
            className={`nav-link ${page === label ? "active" : ""}`}
            onClick={() => {
              setPage(label);
              setSelected(null);
              setMessage("");
            }}
          >
            <span>{icon}</span>
            {label}
            {label === "Unread" && (
              <small>{items.filter((item) => !item.read).length}</small>
            )}
          </button>
        ))}

        <div className="nav-label feeds-label">
          YOUR SUBSCRIPTIONS <span>{feedList.length}</span>
        </div>

        {feedList.map((feed) => (
          <button
            key={feed.url}
            className={`feed-link ${page === feed.name ? "active" : ""}`}
            onClick={() => {
              setPage(feed.name);
              setSelected(null);
              setMessage("");
            }}
          >
            <span className="feed-dot" />
            {feed.name}
          </button>
        ))}

        <div className="sidebar-bottom">
          <div className="privacy-icon">◇</div>
          <strong>Your reading is yours.</strong>
          <p>No accounts. No tracking. Just the web you choose.</p>
          <span>PRIVACY BY DESIGN</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            YOUR LIBRARY <span>/</span> {page.toUpperCase()}
          </div>

          <div className="top-actions">
            <label className="search-box">
              <span>⌕</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search your library..."
              />
            </label>
            <div className="avatar">O</div>
          </div>
        </header>

        {message && (
          <div className="message-bar" role="status">
            {message}
            <button onClick={() => setMessage("")}>×</button>
          </div>
        )}

        {selected ? (
          <section className="reader-view">
            <button
              className="back-link"
              onClick={() => setSelected(null)}
            >
              ← Back to library
            </button>

            <div className={`article-art art-${selected.color || "peach"}`}>
              <span>{selected.category}</span>
              <div className="art-shape">✳</div>
            </div>

            <span className="category">{selected.category}</span>
            <h1>{selected.title}</h1>
            <div className="article-meta">
              {selected.blog} · {selected.date}
            </div>
            <p className="article-body">{selected.excerpt}</p>

            <p className="article-body">
              This is the feed's available summary. Full article extraction
              will be added next.
            </p>

            <a
              className="primary-button"
              href={selected.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Read original article ↗
            </a>
          </section>
        ) : page === "Add a feed" ? (
          <section className="page-content">
            <div className="page-heading">
              <span className="eyebrow">GROW YOUR LIBRARY</span>
              <h1>Follow something good.</h1>
              <p>
                Add a direct RSS or Atom feed URL to your personal reading list.
              </p>
            </div>

            <form className="add-feed-form" onSubmit={addFeed}>
              <label htmlFor="feed-url">FEED URL</label>
              <input
                id="feed-url"
                type="url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                placeholder="https://hnrss.org/frontpage"
                required
              />

              <button className="primary-button" disabled={busy}>
                {busy ? "Loading feed…" : "Add subscription →"}
              </button>
            </form>

            <div className="note-card">
              <span>✳</span>
              <div>
                <strong>Try a feed to get started</strong>
                <p>
                  For example, https://hnrss.org/frontpage is a public RSS feed.
                  Paste the feed URL itself, not just a blog homepage.
                </p>
              </div>
            </div>
          </section>
        ) : page === "Discover" ? (
          <section className="page-content">
            <div className="page-heading">
              <span className="eyebrow">THE WIDER WEB</span>
              <h1>Something new awaits.</h1>
              <p>
                Discover independent voices beyond your usual reading list.
              </p>
            </div>

            <div className="privacy-card">
              <div className="privacy-icon large">◇</div>
              <div>
                <h3>Anonymous discovery</h3>
                <p>
                  Sharing is optional. The live anonymous recommendation
                  service has not been connected yet.
                </p>

                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={sharing}
                    onChange={(event) => setSharing(event.target.checked)}
                  />
                  <span>Opt in to anonymous sharing</span>
                </label>

                <small>
                  {sharing
                    ? "Opt-in selected locally; no subscriptions have been sent."
                    : "Sharing is off. Your subscriptions stay on this device."}
                </small>
              </div>
            </div>

            <h2 className="subheading">Popular feed to try</h2>

            <div className="discover-row">
              <div className="discover-avatar color-0">H</div>
              <div>
                <strong>Hacker News</strong>
                <p>Technology · Community links</p>
              </div>
              <button
                onClick={() => {
                  setFeedUrl("https://hnrss.org/frontpage");
                  setPage("Add a feed");
                  setMessage("Feed URL filled in. Click Add subscription.");
                }}
              >
                Add feed ↗
              </button>
            </div>

            <p className="demo-label">
              STARTER SUGGESTION · NOT A LIVE RANKED RECOMMENDATION
            </p>
          </section>
        ) : (
          <section className="page-content">
            <div className="welcome-row">
              <div>
                <span className="eyebrow">A LITTLE SPACE TO THINK</span>
                <h1>Your corner of the internet.</h1>
                <p>
                  A quieter way to keep up with the things you care about.
                </p>
              </div>
              <div className="welcome-symbol">✳</div>
            </div>

            <div className="stats-row">
              <div>
                <span>IN YOUR LIBRARY</span>
                <strong>{items.length}</strong>
                <small>Loaded articles</small>
              </div>
              <div>
                <span>SUBSCRIPTIONS</span>
                <strong>{feedList.length}</strong>
                <small>Feeds on this page</small>
              </div>
              <div>
                <span>UNREAD</span>
                <strong>{items.filter((item) => !item.read).length}</strong>
                <small>Waiting for you</small>
              </div>
            </div>

            <div className="section-title">
              <div>
                <h2>
                  {page === "Unread"
                    ? "Worth your attention"
                    : page === "All articles"
                      ? "Latest stories"
                      : page}
                </h2>
                <p>Independent voices, in chronological order.</p>
              </div>

              <label className="unread-toggle">
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(event) => setUnreadOnly(event.target.checked)}
                />
                Unread only
              </label>
            </div>

            <div className="article-list">
              {visibleItems.map((article) => (
                <article className="story-card" key={article.id}>
                  <button
                    className={`article-art art-${article.color}`}
                    onClick={() => markRead(article)}
                    aria-label={`Read ${article.title}`}
                  >
                    <span>{article.category}</span>
                    <div className="art-shape">✳</div>
                  </button>

                  <button
                    className="story-content"
                    onClick={() => markRead(article)}
                  >
                    <span className="category">{article.category}</span>
                    <h3>{article.title}</h3>
                    <p>{article.excerpt}</p>
                    <div className="story-meta">
                      <strong>{article.blog}</strong>
                      <span> · {article.date}</span>
                      {article.read && (
                        <span className="read-tag">READ</span>
                      )}
                    </div>
                  </button>

                  <button
                    className="more-button"
                    title={article.read ? "Mark unread" : "Mark read"}
                    onClick={(event) => toggleRead(article, event)}
                  >
                    {article.read ? "○" : "↗"}
                  </button>
                </article>
              ))}

              {!visibleItems.length && (
                <div className="empty-state">
                  <span>◇</span>
                  <h3>Nothing here just yet.</h3>
                  <p>
                    Add an RSS or Atom feed to fill your library with real
                    articles.
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => {
                      setPage("Add a feed");
                      setSelected(null);
                    }}
                  >
                    Add a feed
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        <footer className="footer">
          <span>OPENFOLIO © 2026</span>
          <span>MADE FOR READERS, NOT ALGORITHMS.</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
