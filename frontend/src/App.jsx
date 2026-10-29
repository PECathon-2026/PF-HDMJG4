
import { useEffect, useMemo, useState } from "react";
import { XMLParser } from "fast-xml-parser";
import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import "./App.css";

const API = "http://127.0.0.1:8000";
const FEEDS_KEY = "openfolio-feeds";
const ARTICLES_KEY = "openfolio-articles";

const SHARE_CATEGORIES = [
  "Technology",
  "Design",
  "Writing",
  "Science",
  "Personal Blogs",
];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  cdataPropName: "__cdata",
});

function loadSavedData(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

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

function normalizeCommunityUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return String(value || "").trim();
    }
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    const trackingKeys = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"]);
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !trackingKeys.has(key.toLowerCase()))
      .sort(([keyA, valueA], [keyB, valueB]) => keyA.toLowerCase().localeCompare(keyB.toLowerCase()) || valueA.localeCompare(valueB));
    url.search = "";
    for (const [key, value] of query) url.searchParams.append(key, value);
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.href;
  } catch {
    return String(value || "").trim();
  }
}

function normalizeArticleUrl(value, feedUrl) {
  try {
    const url = new URL(value, feedUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) return feedUrl;
    url.hash = "";
    return url.href;
  } catch {
    return feedUrl;
  }
}

function parseFeed(xml, feedName, feedUrl) {
  const parsed = xmlParser.parse(xml);
  const root = parsed.rss?.channel || parsed.feed || parsed.RDF;

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
    const links = Array.isArray(entry.link)
      ? entry.link
      : entry.link
        ? [entry.link]
        : [];

    let articleUrl = "";

    for (const link of links) {
      if (typeof link === "string") {
        articleUrl = link;
        break;
      }

      if (
        link &&
        typeof link === "object" &&
        (link["@_rel"] === "alternate" || !link["@_rel"])
      ) {
        articleUrl = link["@_href"] || textValue(link["#text"]);
        if (articleUrl) break;
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
      entry["content:encoded"] ??
      entry.description ??
      entry.summary ??
      entry.content ??
      "";

    const excerpt =
      cleanExcerpt(rawDescription).slice(0, 350) ||
      "Open the article to read more.";

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

// Fetching stays on the existing backend proxy; parsing and discovery happen in the browser.
async function fetchFeedDocument(url) {
  const response = await fetch(
    `${API}/api/fetch?url=${encodeURIComponent(url)}`
  );

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The backend returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(result.detail || `Feed request failed (${response.status}).`);
  }

  if (typeof result.body !== "string") {
    throw new Error("The backend response did not contain page content.");
  }

  return result;
}

function findAlternateFeedLinks(html, pageUrl) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const links = Array.from(document.querySelectorAll("link[rel][href]"));

  return links
    .filter((link) => {
      const rel = (link.getAttribute("rel") || "")
        .toLowerCase()
        .split(/\s+/);
      const type = (link.getAttribute("type") || "").toLowerCase();
      return (
        rel.includes("alternate") &&
        (type.includes("rss") ||
          type.includes("atom") ||
          type.includes("rdf") ||
          type.includes("xml"))
      );
    })
    .map((link) => {
      try {
        const candidate = new URL(link.getAttribute("href"), pageUrl);
        return ["http:", "https:"].includes(candidate.protocol)
          ? candidate.href
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function discoverAndParseFeed(pageUrl, initialDocument) {
  const attempted = new Set([pageUrl]);
  const candidates = [
    ...findAlternateFeedLinks(initialDocument.body, pageUrl),
  ];

  // Common feed endpoints used by blogs and publishing platforms.
  const origin = new URL(pageUrl).origin;
  for (const path of ["/feed", "/feed/", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"]) {
    candidates.push(new URL(path, origin).href);
  }

  let lastError = new Error("No RSS or Atom feed was found at this address.");
  for (const candidate of candidates) {
    if (attempted.has(candidate)) continue;
    attempted.add(candidate);

    try {
      const document = await fetchFeedDocument(candidate);
      const name = new URL(candidate).hostname.replace(/^www\./i, "");
      const articles = parseFeed(document.body, name, candidate);
      return { feedUrl: candidate, name, articles };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Could not find a feed automatically. Try pasting the direct RSS/Atom URL. ${lastError.message}`
  );
}

const STARTER_RECOMMENDATIONS = [
  {
    name: "Hacker News",
    category: "Technology",
    tags: ["Technology", "Community"],
    description:
      "Interesting links and conversations from the tech community.",
    url: "https://hnrss.org/frontpage",
  },
  {
    name: "The Marginalian",
    category: "Writing",
    tags: ["Writing", "Science", "Culture"],
    description:
      "Essays exploring creativity, meaning, science, and art.",
    url: "https://www.themarginalian.org/feed/",
  },
  {
    name: "Smashing Magazine",
    category: "Design",
    tags: ["Design", "Technology"],
    description:
      "Practical ideas for people who design and build for the web.",
    url: "https://www.smashingmagazine.com/feed/",
  },
  {
    name: "NASA",
    category: "Science",
    tags: ["Science"],
    description:
      "News and discoveries about space, missions, and astronomy.",
    url: "https://www.nasa.gov/feed/",
  },
  {
    name: "Simon Willison",
    category: "Personal Blogs",
    tags: ["Personal Blogs", "Technology"],
    description:
      "Notes and experiments on programming, data, and technology.",
    url: "https://simonwillison.net/atom/everything/",
  },
];

const DISCOVER_CATEGORIES = [
  "All",
  ...SHARE_CATEGORIES,
];

function App() {
  const [page, setPage] = useState("All articles");

  const [feedList, setFeedList] = useState(() =>
    loadSavedData(FEEDS_KEY, [])
  );

  const [items, setItems] = useState(() =>
    loadSavedData(ARTICLES_KEY, [])
  );

  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [message, setMessage] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const [sharing, setSharing] = useState(false);
  const [discoverSearch, setDiscoverSearch] = useState("");
  const [discoverCategory, setDiscoverCategory] = useState("All");

  const [communityRecommendations, setCommunityRecommendations] =
    useState([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState("");
  const [submittingUrl, setSubmittingUrl] = useState("");

  // Priority 2: anonymous batch submission state
const [batchSubmitting, setBatchSubmitting] = useState(false);

// Priority 2: personalized recommendation loading state
const [personalizedLoading, setPersonalizedLoading] = useState(false);

// Priority 2: personalized recommendation results
const [
  personalizedRecommendations,
  setPersonalizedRecommendations,
] = useState([]);

  // State for choosing a category before recommending a subscription.
  const [recommendCategoryForUrl, setRecommendCategoryForUrl] =
    useState("");
  const [recommendCategory, setRecommendCategory] =
    useState("Personal Blogs");

  const [articleText, setArticleText] = useState("");
  const [articleHtml, setArticleHtml] = useState("");
  const [articleTitle, setArticleTitle] = useState("");
  const [articleBusy, setArticleBusy] = useState(false);
  const [articleError, setArticleError] = useState("");

  // Save personal subscriptions in the browser.
  useEffect(() => {
    try {
      localStorage.setItem(FEEDS_KEY, JSON.stringify(feedList));
    } catch {
      setMessage("Could not save subscriptions in this browser.");
    }
  }, [feedList]);

  // Save personal articles and their cached text in the browser.
  useEffect(() => {
    try {
      localStorage.setItem(ARTICLES_KEY, JSON.stringify(items));
    } catch {
      setMessage("Could not save articles. Browser storage may be full.");
    }
  }, [items]);

  // Load community recommendations when Discover is opened.
  useEffect(() => {
    if (page !== "Discover") return;

    let cancelled = false;

    async function loadCommunityRecommendations() {
      setCommunityLoading(true);
      setCommunityError("");

      try {
        const response = await fetch(`${API}/api/discover`);

        if (!response.ok) {
          throw new Error("Could not load community recommendations.");
        }

        const result = await response.json();

        if (!cancelled) {
          setCommunityRecommendations(
            Array.isArray(result.recommendations)
              ? result.recommendations
              : []
          );
        }
      } catch (error) {
        if (!cancelled) {
          setCommunityError(
            error.message || "Could not connect to the Openfolio backend."
          );
        }
      } finally {
        if (!cancelled) {
          setCommunityLoading(false);
        }
      }
    }

    loadCommunityRecommendations();

    return () => {
      cancelled = true;
    };
  }, [page]);

  // Extract full article content in the browser. The API only returns raw HTML.
  useEffect(() => {
    if (!selected) {
      setArticleText("");
      setArticleHtml("");
      setArticleTitle("");
      setArticleError("");
      setArticleBusy(false);
      return;
    }

    let cancelled = false;
    const sanitizeOptions = {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
      FORBID_ATTR: ["style", "srcdoc"],
    };
    const cachedHtml = selected.fullHtml
      ? DOMPurify.sanitize(selected.fullHtml, sanitizeOptions)
      : "";
    const cachedText = selected.fullText || "";

    setArticleHtml(cachedHtml);
    setArticleText(cachedText);
    setArticleTitle(selected.fullTitle || selected.title);
    setArticleError("");

    if (cachedHtml || cachedText) {
      setArticleBusy(false);
      return () => {
        cancelled = true;
      };
    }

    async function loadArticle() {
      setArticleBusy(true);
      try {
        const result = await fetchFeedDocument(selected.url);
        if (!result.content_type.toLowerCase().includes("html")) {
          throw new Error("This link did not return an HTML article.");
        }

        const parsedDocument = new DOMParser().parseFromString(
          result.body,
          "text/html"
        );
        const readable = new Readability(parsedDocument.cloneNode(true)).parse();
        if (!readable || !readable.content) {
          throw new Error("Could not extract readable article content.");
        }

        // Sanitize before rendering and before saving to local browser storage.
        const safeHtml = DOMPurify.sanitize(readable.content, sanitizeOptions);
        const textDocument = new DOMParser().parseFromString(safeHtml, "text/html");
        const safeText = (textDocument.body.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!safeText) {
          throw new Error("The article did not contain readable text.");
        }
        if (cancelled) return;

        setArticleHtml(safeHtml);
        setArticleText(safeText);
        setArticleTitle(readable.title || selected.title);
        setItems((current) =>
          current.map((item) =>
            item.id === selected.id
              ? {
                  ...item,
                  fullHtml: safeHtml,
                  fullText: safeText,
                  fullTitle: readable.title || selected.title,
                }
              : item
          )
        );
      } catch (error) {
        if (!cancelled) {
          setArticleError(
            error.message || "Could not load this article. Showing the feed summary instead."
          );
          // Keep articleText empty so the feed excerpt is shown as a fallback.
        }
      } finally {
        if (!cancelled) setArticleBusy(false);
      }
    }

    loadArticle();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  // Filter and sort the user's own article library.
  const visibleItems = useMemo(() => {
    return items
      .filter((article) => {
        const matchesSearch =
          `${article.title} ${article.blog} ${article.category}`
            .toLowerCase()
            .includes(search.toLowerCase());

        const matchesUnread = !unreadOnly || !article.read;
        const matchesPage = page !== "Unread" || !article.read;

        const isFeedPage = feedList.some((feed) => feed.name === page);
        const matchesFeed = !isFeedPage || article.blog === page;

        return (
          matchesSearch &&
          matchesUnread &&
          matchesPage &&
          matchesFeed
        );
      })
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }, [items, search, unreadOnly, page, feedList]);

  // Subscribe with either a direct feed URL or a blog homepage URL.
  async function addFeed(event) {
    event.preventDefault();
    if (busy) return;

    let url = feedUrl.trim();
    let parsedUrl;

    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported.");
      }
      if (parsedUrl.username || parsedUrl.password) {
        throw new Error("URLs containing usernames or passwords are not supported.");
      }
    } catch {
      setMessage("Enter a valid public HTTP or HTTPS website or feed URL.");
      return;
    }

    if (feedList.some((feed) => feed.url === url)) {
      setMessage("You have already subscribed to this feed.");
      return;
    }

    setBusy(true);
    setMessage("Checking for an RSS or Atom feed…");

    try {
      const initialDocument = await fetchFeedDocument(url);
      let resolved;

      try {
        const name = parsedUrl.hostname.replace(/^www\./i, "");
        const articles = parseFeed(initialDocument.body, name, url);
        resolved = { feedUrl: url, name, articles };
      } catch {
        setMessage("That looks like a website. Discovering its feed…");
        resolved = await discoverAndParseFeed(url, initialDocument);
      }

      if (feedList.some((feed) => feed.url === resolved.feedUrl)) {
        setMessage("You have already subscribed to this feed.");
        return;
      }

      const { feedUrl: resolvedFeedUrl, name, articles: newArticles } = resolved;
      setFeedList((current) => [
        ...current,
        { name, url: resolvedFeedUrl, count: newArticles.length },
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
      setMessage(error.message || "Unable to find or load this feed.");
    } finally {
      setBusy(false);
    }
  }

  // Remove a subscription and its cached articles from this browser.
  function removeSubscription(feed) {
    const confirmed = window.confirm(
      `Remove \"${feed.name}\" from your subscriptions? Its cached articles will also be removed.`
    );
    if (!confirmed) return;

    setFeedList((current) => current.filter((savedFeed) => savedFeed.url !== feed.url));
    setItems((current) =>
      current.filter((article) =>
        article.feedUrl ? article.feedUrl !== feed.url : article.blog !== feed.name
      )
    );

    if (page === feed.name || selected?.feedUrl === feed.url) {
      setPage("All articles");
      setSelected(null);
    }
    if (recommendCategoryForUrl === feed.url) {
      setRecommendCategoryForUrl("");
    }
    setMessage(`Removed ${feed.name} from your subscriptions.`);
  }

  // Submit a feed to the community with its chosen category.
  async function recommendToCommunity(feed) {
    if (submittingUrl) return;

    setSubmittingUrl(feed.url);
    setCommunityError("");

    try {
      const response = await fetch(`${API}/api/discover`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: feed.name,
          url: feed.url,
          category: feed.category || feed.tags?.[0] || "Writing",
          description: feed.description,
        }),
      });

      let result;

      try {
        result = await response.json();
      } catch {
        throw new Error("The server returned an invalid response.");
      }

      if (!response.ok) {
        if (response.status === 409) {
          throw new Error(
            "This feed has already been recommended to the community."
          );
        }

        throw new Error(
          result.detail || "Could not submit this recommendation."
        );
      }

      // Refresh the directory after the recommendation is saved.
      const refreshResponse = await fetch(`${API}/api/discover`);

      if (!refreshResponse.ok) {
        throw new Error(
          "Your recommendation was submitted, but the directory could not refresh."
        );
      }

      const refreshed = await refreshResponse.json();

      setCommunityRecommendations(
        Array.isArray(refreshed.recommendations)
          ? refreshed.recommendations
          : []
      );

      setRecommendCategoryForUrl("");
      setMessage(
        `${feed.name} was recommended to the community under ${feed.category || feed.tags?.[0] || "Writing"}.`
      );
    } catch (error) {
      setCommunityError(
        error.message || "Could not connect to the Openfolio backend."
      );
    } finally {
      setSubmittingUrl("");
    }
  }

  // Explicitly submit the whole subscription list as one anonymous batch.
  // The backend stores aggregate feed/pair counts, not this submitted list.
  async function shareSubscriptionsBatch() {
    if (!sharing) {
      setMessage("Turn on anonymous sharing first, then choose Share subscriptions.");
      return;
    }
    if (!feedList.length) {
      setMessage("Add at least one subscription before sharing.");
      return;
    }
    if (feedList.length > 50) {
      setMessage("Anonymous batches are limited to 50 subscriptions. Remove some feeds and try again.");
      return;
    }
    if (batchSubmitting) return;

    const confirmed = window.confirm(
      `Submit ${feedList.length} subscription${feedList.length === 1 ? "" : "s"} as one anonymous batch? Openfolio will keep aggregate popularity and co-subscription counts, not your submitted list.`
    );
    if (!confirmed) return;

    setBatchSubmitting(true);
    setCommunityError("");
    try {
      const response = await fetch(`${API}/api/discover/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feeds: feedList.map((feed) => ({
            name: feed.name,
            url: feed.url,
            category: feed.category || "Personal Blogs",
            description: feed.description || `A feed shared by an Openfolio reader: ${feed.name}.`,
          })),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.detail || "Could not submit the anonymous batch.");
      }

      const refresh = await fetch(`${API}/api/discover/popular`);
      if (refresh.ok) {
        const directory = await refresh.json();
        setCommunityRecommendations(
          Array.isArray(directory.recommendations) ? directory.recommendations : []
        );
      }
      setMessage(
        `Shared ${result.accepted_feeds} unique feeds. ${result.deduplicated_feeds} duplicate URL${result.deduplicated_feeds === 1 ? " was" : "s were"} removed. Only aggregate counts were saved.`
      );
    } catch (error) {
      setCommunityError(error.message || "Could not submit the anonymous batch.");
    } finally {
      setBatchSubmitting(false);
    }
  }

  // The list is sent only after the reader presses this button. The API uses
  // it for this response and does not persist the supplied subscription list.
  async function loadPersonalizedRecommendations() {
    if (personalizedLoading) return;
    setPersonalizedLoading(true);
    setCommunityError("");
    try {
      const response = await fetch(`${API}/api/discover/recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptions: feedList.map((feed) => feed.url) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.detail || "Could not generate recommendations.");
      }
      setPersonalizedRecommendations(
        Array.isArray(result.recommendations) ? result.recommendations : []
      );
      setMessage(
        `Found ${result.recommendations?.length || 0} recommendations, excluding feeds you already follow.`
      );
    } catch (error) {
      setCommunityError(error.message || "Could not generate recommendations.");
    } finally {
      setPersonalizedLoading(false);
    }
  }

  function markRead(article) {
    const updated = { ...article, read: true };

    setItems((current) =>
      current.map((item) =>
        item.id === article.id ? { ...item, read: true } : item
      )
    );

    setSelected(updated);
  }

  function toggleRead(article) {
    setItems((current) =>
      current.map((item) =>
        item.id === article.id
          ? { ...item, read: !item.read }
          : item
      )
    );

    if (selected?.id === article.id) {
      setSelected({ ...article, read: !article.read });
    }
  }

  // Combine built-in suggestions with recommendations from the database.
  const allRecommendations = [
    ...STARTER_RECOMMENDATIONS.map((feed) => ({
      ...feed,
      source: "starter",
    })),
    ...communityRecommendations.map((feed) => ({
      ...feed,
      tags: [feed.category || "Writing"],
      source: feed.is_seed ? "starter" : "community",
    })),
    ...personalizedRecommendations.map((feed) => ({
      ...feed,
      tags: [feed.category || "Writing"],
      source: "personalized",
    })),
  ];

  // Show only one entry for each URL.
  const uniqueRecommendations = Array.from(
    new Map(allRecommendations.map((feed) => [normalizeCommunityUrl(feed.url), feed])).values()
  );

  const filteredRecommendations = uniqueRecommendations.filter((feed) => {
    const query = discoverSearch.trim().toLowerCase();

    const matchesSearch =
      `${feed.name} ${feed.description || ""} ${(feed.tags || []).join(" ")}`
        .toLowerCase()
        .includes(query);

    const matchesCategory =
      discoverCategory === "All" ||
      (feed.tags || []).includes(discoverCategory);
    const matchesNotFollowed = !feedList.some(
      (savedFeed) => normalizeCommunityUrl(savedFeed.url) === normalizeCommunityUrl(feed.url)
    );

    return matchesSearch && matchesCategory && matchesNotFollowed;
  });

  return (
    <div className="app">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => {
            setPage("All articles");
            setSelected(null);
            setMessage("");
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

        {feedList.map((feed) => {
          const alreadyRecommended = communityRecommendations.some(
            (savedFeed) => normalizeCommunityUrl(savedFeed.url) === normalizeCommunityUrl(feed.url) && !savedFeed.is_seed
          );

          const categoryFormOpen = recommendCategoryForUrl === feed.url;

          return (
            <div className="subscription-item" key={feed.url}>
              <button
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

              {categoryFormOpen ? (
                <div className="recommend-category-form">
                  <label>
                    Share category
                    <select
                      value={recommendCategory}
                      onChange={(event) =>
                        setRecommendCategory(event.target.value)
                      }
                      disabled={Boolean(submittingUrl)}
                    >
                      {SHARE_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    className="recommend-feed-button"
                    disabled={Boolean(submittingUrl)}
                    onClick={() =>
                      recommendToCommunity({
                        name: feed.name,
                        url: feed.url,
                        category: recommendCategory,
                        description: `A feed recommended by an Openfolio reader: ${feed.name}.`,
                      })
                    }
                  >
                    {submittingUrl === feed.url
                      ? "Sharing…"
                      : "Submit recommendation"}
                  </button>

                  <button
                    type="button"
                    className="recommend-cancel-button"
                    disabled={Boolean(submittingUrl)}
                    onClick={() => setRecommendCategoryForUrl("")}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="recommend-feed-button"
                  disabled={Boolean(submittingUrl) || alreadyRecommended}
                  title={
                    alreadyRecommended
                      ? "Already recommended"
                      : "Recommend this feed to the community"
                  }
                  onClick={() => {
                    setRecommendCategory("Personal Blogs");
                    setRecommendCategoryForUrl(feed.url);
                  }}
                >
                  {alreadyRecommended ? "Recommended ✓" : "Recommend ↗"}
                </button>
              )}

              <button
                type="button"
                className="remove-subscription-button"
                onClick={() => removeSubscription(feed)}
                title={`Remove ${feed.name} from your subscriptions`}
              >
                Remove subscription
              </button>
            </div>
          );
        })}

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
            YOUR LIBRARY <span>/</span>{" "}
            {selected ? "READING" : page.toUpperCase()}
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

        {communityError && (
          <div className="message-bar" role="alert">
            {communityError}
            <button type="button" onClick={() => setCommunityError("")}>
              ×
            </button>
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
            <h1>{articleTitle || selected.title}</h1>

            <div className="article-meta">
              {selected.blog} · {selected.date}
            </div>

            <div className="article-body">
              {articleBusy ? (
                <p>Fetching the full article…</p>
              ) : (
                <>
                  {articleError && (
                    <p className="reader-fallback-note" role="status">
                      Full text unavailable: {articleError} Showing the feed summary if no cached article is available.
                    </p>
                  )}
                  {articleHtml ? (
                    <div
                      className="full-article-content"
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(articleHtml, {
                          USE_PROFILES: { html: true },
                          FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
                          FORBID_ATTR: ["style", "srcdoc"],
                        }),
                      }}
                    />
                  ) : (
                    <p className="full-article-text">
                      {articleText || selected.excerpt}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="reader-actions">
              <a
                className="primary-button"
                href={selected.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read original article ↗
              </a>

              <button
                className="back-link"
                onClick={() => toggleRead(selected)}
              >
                {selected.read ? "Mark as unread" : "Mark as read"}
              </button>
            </div>
          </section>
        ) : page === "Add a feed" ? (
          <section className="page-content">
            <div className="page-heading">
              <span className="eyebrow">GROW YOUR LIBRARY</span>
              <h1>Follow something good.</h1>
              <p>
                Paste a blog homepage or a direct RSS/Atom feed URL. Openfolio will try to find the feed automatically.
              </p>
            </div>

            <form className="add-feed-form" onSubmit={addFeed}>
              <label htmlFor="feed-url">WEBSITE OR FEED URL</label>
              <input
                id="feed-url"
                type="url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                placeholder="https://example.com or https://hnrss.org/frontpage"
                required
              />

              <button className="primary-button" disabled={busy}>
                {busy ? "Loading feed…" : "Add subscription →"}
              </button>
            </form>

            <div className="note-card">
              <span>✳</span>
              <div>
                <strong>Automatic feed discovery</strong>
                <p>Paste a blog homepage or a direct feed URL. We check RSS/Atom discovery links and common feed paths.</p>
              </div>
            </div>
          </section>
        ) : page === "Discover" ? (
          <section className="page-content">
            <div className="page-heading">
              <span className="eyebrow">THE WIDER WEB</span>
              <h1>Find your next favorite.</h1>
              <p>
                Independent voices, personal blogs, and thoughtful writing
                from across the open web.
              </p>
            </div>

            <div className="privacy-card">
              <div className="privacy-icon large">◇</div>
              <div>
                <h3>Discovery without tracking</h3>
                <p>
                  Explore these suggestions without creating an account.
                  Your personal subscriptions stay in your browser.
                  Community recommendations are submitted only when you
                  choose to share them.
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
                    ? "Sharing is enabled, but nothing is sent until you press the button and confirm."
                    : "Sharing is off. Your subscriptions are not submitted."}
                </small>
                <p className="privacy-detail">
                  A batch request includes your feed URLs temporarily so the server can count popularity and co-subscriptions. It does not save the submitted list, a batch ID, an account ID, or a raw IP address. Recommendation requests also send feed URLs only when you ask for them.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!sharing || !feedList.length || batchSubmitting}
                  onClick={shareSubscriptionsBatch}
                >
                  {batchSubmitting ? "Sharing batch…" : `Share ${feedList.length} subscriptions anonymously`}
                </button>
              </div>
            </div>

            <h2 className="subheading">Explore the open web</h2>

            {communityLoading && (
              <p role="status">Loading community recommendations…</p>
            )}

            <label className="discover-search">
              <span>⌕</span>
              <input
                type="search"
                value={discoverSearch}
                onChange={(event) => setDiscoverSearch(event.target.value)}
                placeholder="Search blogs, topics, and ideas..."
                aria-label="Search Discover recommendations"
              />

              {discoverSearch && (
                <button
                  type="button"
                  onClick={() => setDiscoverSearch("")}
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </label>

            <div
              className="discover-categories"
              aria-label="Filter by category"
            >
              {DISCOVER_CATEGORIES.map((category) => (
                <button
                  type="button"
                  key={category}
                  className={discoverCategory === category ? "active" : ""}
                  onClick={() => setDiscoverCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>

            <div className="recommendation-controls">
              <button
                type="button"
                className="primary-button"
                disabled={personalizedLoading || !feedList.length}
                onClick={loadPersonalizedRecommendations}
              >
                {personalizedLoading
                  ? "Finding recommendations…"
                  : "Recommend based on my subscriptions"}
              </button>
              {personalizedRecommendations.length > 0 && (
                <button
                  type="button"
                  className="recommend-cancel-button"
                  onClick={() => setPersonalizedRecommendations([])}
                >
                  Clear personalized results
                </button>
              )}
            </div>

            <p className="discover-result-count">
              {filteredRecommendations.length}{" "}
              {filteredRecommendations.length === 1
                ? "recommendation"
                : "recommendations"}
            </p>

            {filteredRecommendations.map((feed, index) => {
              const alreadyAdded = feedList.some(
                (savedFeed) => normalizeCommunityUrl(savedFeed.url) === normalizeCommunityUrl(feed.url)
              );

              const alreadyRecommended = communityRecommendations.some(
                (savedFeed) => normalizeCommunityUrl(savedFeed.url) === normalizeCommunityUrl(feed.url) && !savedFeed.is_seed
              );

              return (
                <div className="discover-row" key={feed.url}>
                  <div className={`discover-avatar color-${index % 3}`}>
                    {feed.name.charAt(0)}
                  </div>

                  <div className="discover-info">
                    <strong>{feed.name}</strong>
                    <p>{(feed.tags || []).join(" · ")}</p>
                    <p>{feed.description}</p>
                    {feed.reason && <small className="recommendation-reason">Why this is suggested: {feed.reason}</small>}
                    {feed.popularity_count >= 3 && (
                      <small>{feed.popularity_count} anonymous batch contributions</small>
                    )}

                    {feed.source === "community" && (
                      <small>Community recommendation</small>
                    )}
                    {feed.source === "personalized" && (
                      <small>Personalized · based on aggregate co-subscription patterns</small>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={alreadyAdded}
                    onClick={() => {
                      setFeedUrl(feed.url);
                      setPage("Add a feed");
                      setSelected(null);
                      setMessage(
                        `Feed URL filled in for ${feed.name}. Click Add subscription to try it.`
                      );
                    }}
                  >
                    {alreadyAdded ? "Added ✓" : "Try feed →"}
                  </button>

                  {feed.source === "starter" && (
                    <button
                      type="button"
                      disabled={
                        Boolean(submittingUrl) || alreadyRecommended
                      }
                      onClick={() => recommendToCommunity(feed)}
                    >
                      {submittingUrl === feed.url
                        ? "Sharing…"
                        : alreadyRecommended
                          ? "Recommended ✓"
                          : "Recommend to community"}
                    </button>
                  )}
                </div>
              );
            })}

            {!filteredRecommendations.length && !communityLoading && (
              <div className="empty-state">
                <span>◇</span>
                <h3>No matches yet.</h3>
                <p>
                  Try another search or choose a different category.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setDiscoverSearch("");
                    setDiscoverCategory("All");
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}

            <p className="demo-label">
              STARTER SUGGESTIONS · COMMUNITY SUBMISSIONS STORED BY THE BACKEND
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
                <small>Saved articles</small>
              </div>
              <div>
                <span>SUBSCRIPTIONS</span>
                <strong>{feedList.length}</strong>
                <small>Saved feeds</small>
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
                    onClick={() => toggleRead(article)}
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
                    Add an RSS or Atom feed to fill your library with
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
