
import { useState } from "react";
import "./App.css";

const articles = [
  { id: 1, category: "TECHNOLOGY", title: "The quiet beauty of building things for the web", blog: "The Independent Developer", date: "12 min ago", read: false, color: "peach", excerpt: "On making useful things, embracing simplicity, and remembering that the internet was built by people sharing what they know." },
  { id: 2, category: "CULTURE", title: "Why the best ideas need room to breathe", blog: "Notes from Elsewhere", date: "1 hour ago", read: false, color: "blue", excerpt: "A reflection on attention, creative work, and the value of stepping away from the constant noise." },
  { id: 3, category: "SCIENCE", title: "A field guide to the night sky", blog: "Small Wonders", date: "3 hours ago", read: true, color: "green", excerpt: "Looking upward has always reminded us how much remains to be discovered." },
  { id: 4, category: "DESIGN", title: "The enduring appeal of things made by hand", blog: "Form & Function", date: "Yesterday", read: false, color: "lavender", excerpt: "What craftsmanship can teach us about digital products and thoughtful design." },
];

const starterFeeds = [
  { name: "The Independent Developer", url: "https://example.com/feed", count: 12 },
  { name: "Notes from Elsewhere", url: "https://example.org/feed", count: 8 },
  { name: "Small Wonders", url: "https://example.net/feed", count: 5 },
];

function App() {
  const [page, setPage] = useState("All articles");
  const [feedList, setFeedList] = useState(starterFeeds);
  const [items, setItems] = useState(articles);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [message, setMessage] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [sharing, setSharing] = useState(false);

  const visibleItems = items.filter((article) => {
    const matchesSearch = `${article.title} ${article.blog} ${article.category}`.toLowerCase().includes(search.toLowerCase());
    const matchesUnread = !unreadOnly || !article.read;
    const matchesPage = page !== "Unread" || !article.read;
    const matchesFeed = !feedList.some((feed) => feed.name === page) || article.blog === page;
    return matchesSearch && matchesUnread && matchesPage && matchesFeed;
  });

  function addFeed(event) {
    event.preventDefault();
    const url = feedUrl.trim();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      if (feedList.some((feed) => feed.url === url)) {
        setMessage("This feed is already in your subscriptions.");
        return;
      }
      setFeedList((current) => [...current, { name: parsed.hostname, url, count: 0 }]);
      setFeedUrl("");
      setMessage("Feed saved to this session. Live feed fetching is the next step.");
    } catch {
      setMessage("Enter a valid http:// or https:// feed URL.");
    }
  }

  function markRead(article) {
    setItems((current) => current.map((item) => item.id === article.id ? { ...item, read: true } : item));
    setSelected({ ...article, read: true });
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="brand" onClick={() => { setPage("All articles"); setSelected(null); }}>
          <span className="brand-icon">o.</span>
          <span><strong>openfolio</strong><small>THE OPEN WEB, YOUR WAY</small></span>
        </button>

        <button className="add-feed" onClick={() => { setPage("Add a feed"); setSelected(null); }}>＋ Add a feed</button>

        <div className="nav-label">LIBRARY</div>
        {[
          ["All articles", "▤"],
          ["Unread", "◉"],
          ["Discover", "✳"],
        ].map(([label, icon]) => (
          <button key={label} className={`nav-link ${page === label ? "active" : ""}`} onClick={() => { setPage(label); setSelected(null); }}>
            <span>{icon}</span>{label}
            {label === "Unread" && <small>{items.filter((item) => !item.read).length}</small>}
          </button>
        ))}

        <div className="nav-label feeds-label">YOUR SUBSCRIPTIONS <span>{feedList.length}</span></div>
        {feedList.map((feed) => (
          <button key={feed.url} className={`feed-link ${page === feed.name ? "active" : ""}`} onClick={() => { setPage(feed.name); setSelected(null); }}>
            <span className="feed-dot" />{feed.name}
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
          <div className="breadcrumb">YOUR LIBRARY <span>/</span> {page.toUpperCase()}</div>
          <div className="top-actions">
            <label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your library..." /></label>
            <div className="avatar">O</div>
          </div>
        </header>

        {message && <div className="message-bar">{message}<button onClick={() => setMessage("")}>×</button></div>}

        {selected ? (
          <section className="reader-view">
            <button className="back-link" onClick={() => setSelected(null)}>← Back to library</button>
            <div className={`article-art art-${selected.color || "peach"}`}><span>{selected.category}</span><div className="art-shape">✳</div></div>
            <span className="category">{selected.category}</span>
            <h1>{selected.title}</h1>
            <div className="article-meta">{selected.blog} · {selected.date}</div>
            <p className="article-body">{selected.excerpt}</p>
            <p className="article-body">This is a preview article for the Openfolio interface. In the next step, we'll connect real RSS and Atom feeds and fetch the original article content safely.</p>
            <div className="demo-label">DEMO CONTENT · NOT A LIVE ARTICLE</div>
          </section>
        ) : page === "Add a feed" ? (
          <section className="page-content">
            <div className="page-heading"><span className="eyebrow">GROW YOUR LIBRARY</span><h1>Follow something good.</h1><p>Add an RSS or Atom feed URL to your personal reading list.</p></div>
            <form className="add-feed-form" onSubmit={addFeed}>
              <label>FEED URL</label>
              <input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="https://example.com/feed.xml" required />
              <button className="primary-button">Add subscription →</button>
            </form>
            <div className="note-card"><span>✳</span><div><strong>Not sure where to find a feed?</strong><p>In the next milestone, we'll add automatic feed discovery from a blog's website address.</p></div></div>
          </section>
        ) : page === "Discover" ? (
          <section className="page-content">
            <div className="page-heading"><span className="eyebrow">THE WIDER WEB</span><h1>Something new awaits.</h1><p>Discover independent voices beyond your usual reading list.</p></div>
            <div className="privacy-card"><div className="privacy-icon large">◇</div><div><h3>Anonymous discovery</h3><p>Share your subscriptions only if you choose. No account or persistent reader ID is required.</p><label className="toggle-row"><input type="checkbox" checked={sharing} onChange={(e) => setSharing(e.target.checked)} /><span>Opt in to anonymous sharing</span></label><small>{sharing ? "Opt-in selected. Server integration is not connected yet." : "Sharing is off. Your subscriptions stay on this device."}</small></div></div>
            <h2 className="subheading">Popular independent blogs</h2>
            {["The Marginalian", "Kottke.org", "A List Apart", "NASA Blogs"].map((name, index) => <div className="discover-row" key={name}><div className={`discover-avatar color-${index}`}>{name.charAt(0)}</div><div><strong>{name}</strong><p>Independent writing · Starter recommendation</p></div><button onClick={() => setMessage(`${name}: add its RSS feed URL to subscribe. Live recommendations are coming next.`)}>Explore ↗</button></div>)}
            <p className="demo-label">STARTER DISCOVERY LIST · NOT YET RANKED BY LIVE ANONYMOUS DATA</p>
          </section>
        ) : (
          <section className="page-content">
            <div className="welcome-row"><div><span className="eyebrow">A LITTLE SPACE TO THINK</span><h1>Your corner of the internet.</h1><p>A quieter way to keep up with the things you care about.</p></div><div className="welcome-symbol">✳</div></div>
            <div className="stats-row"><div><span>IN YOUR LIBRARY</span><strong>{items.length}</strong><small>Sample articles</small></div><div><span>SUBSCRIPTIONS</span><strong>{feedList.length}</strong><small>Local demo feeds</small></div><div><span>UNREAD</span><strong>{items.filter((item) => !item.read).length}</strong><small>Waiting for you</small></div></div>
            <div className="section-title"><div><h2>{page === "Unread" ? "Worth your attention" : page === "All articles" ? "Latest stories" : page}</h2><p>Independent voices, in chronological order.</p></div><label className="unread-toggle"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label></div>
            <div className="article-list">
              {visibleItems.map((article) => <article className="story-card" key={article.id}>
                <button className={`article-art art-${article.color}`} onClick={() => markRead(article)} aria-label={`Read ${article.title}`}><span>{article.category}</span><div className="art-shape">✳</div></button>
                <button className="story-content" onClick={() => markRead(article)}>
                  <span className="category">{article.category}</span><h3>{article.title}</h3><p>{article.excerpt}</p><div className="story-meta"><strong>{article.blog}</strong><span>· {article.date}</span>{article.read && <span className="read-tag">READ</span>}</div>
                </button>
                <button className="more-button" title="Open article" onClick={() => markRead(article)}>↗</button>
              </article>)}
              {!visibleItems.length && <div className="empty-state"><span>◇</span><h3>Nothing here just yet.</h3><p>Try another search or add a feed to grow your library.</p><button className="primary-button" onClick={() => setPage("Add a feed")}>Add a feed</button></div>}
            </div>
          </section>
        )}

        <footer className="footer"><span>OPENFOLIO © 2026</span><span>MADE FOR READERS, NOT ALGORITHMS.</span></footer>
      </main>
    </div>
  );
}

export default App;
