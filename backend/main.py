"""Openfolio API: safe, bounded raw-page proxy and anonymous discovery storage.

Article/feed parsing and article extraction are deliberately performed in the browser.
"""

import asyncio
import hashlib
import hmac
import ipaddress
import os
import secrets
import socket
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import closing
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import aiohttp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Openfolio API")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.getenv("OPENFOLIO_DATABASE", os.path.join(BASE_DIR, "openfolio.db"))
MAX_RESPONSE_BYTES = 2_000_000
RATE_LIMIT_SALT = os.getenv("OPENFOLIO_RATE_LIMIT_SALT") or secrets.token_hex(32)

allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        *allowed_origins,
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# In-memory limiter: raw IPs are never written to disk or retained in the map.
# The map stores only a keyed digest and expires entries after their window.
_rate_buckets = defaultdict(deque)
_last_rate_cleanup = 0.0
_RATE_POLICIES = {
    "fetch": (40, 60),       # 40 page fetches per minute per client
    "discover_post": (8, 3600),  # 8 submissions per hour per client
    "discover_get": (120, 60),   # 120 directory reads per minute per client
}


def _client_digest(request: Request) -> str:
    raw_ip = request.client.host if request.client else "unknown"
    return hmac.new(
        RATE_LIMIT_SALT.encode("utf-8"),
        raw_ip.encode("utf-8", errors="replace"),
        hashlib.sha256,
    ).hexdigest()


def enforce_rate_limit(request: Request, action: str) -> None:
    global _last_rate_cleanup
    limit, window = _RATE_POLICIES[action]
    now = time.monotonic()
    key = (action, _client_digest(request))
    bucket = _rate_buckets[key]
    while bucket and now - bucket[0] >= window:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(
            status_code=429,
            detail="Rate limit reached. Please wait a little before trying again.",
            headers={"Retry-After": str(max(1, int(window - (now - bucket[0]))))},
        )
    bucket.append(now)

    # Expire keyed client digests regularly; no raw IP is retained or persisted.
    if now - _last_rate_cleanup > 60 or len(_rate_buckets) > 10_000:
        _last_rate_cleanup = now
        for old_key, old_bucket in list(_rate_buckets.items()):
            old_action = old_key[0]
            old_window = _RATE_POLICIES[old_action][1]
            while old_bucket and now - old_bucket[0] >= old_window:
                old_bucket.popleft()
            if not old_bucket:
                _rate_buckets.pop(old_key, None)


def normalize_public_url(url: str, *, resolve_dns: bool = True) -> str:
    """Validate and canonicalize an HTTP(S) URL; reject local/private destinations."""
    if not isinstance(url, str) or not url or len(url) > 2048:
        raise HTTPException(400, "Enter a valid URL (maximum 2048 characters).")
    if any(ord(ch) < 32 for ch in url) or "\\" in url:
        raise HTTPException(400, "URL contains invalid characters.")

    try:
        parsed = urlsplit(url.strip())
        scheme = parsed.scheme.lower()
        if scheme not in ("http", "https") or not parsed.hostname:
            raise HTTPException(400, "Enter a valid HTTP or HTTPS URL.")
        if parsed.username is not None or parsed.password is not None:
            raise HTTPException(400, "URL credentials are not allowed.")
        port = parsed.port
    except ValueError:
        raise HTTPException(400, "Invalid URL or port.")

    host = parsed.hostname.rstrip(".").lower()
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
        raise HTTPException(400, "Local or reserved hostnames are not allowed.")

    # Convert internationalized names to a stable ASCII form.
    try:
        try:
            ip_obj = ipaddress.ip_address(host)
            if not ip_obj.is_global:
                raise HTTPException(400, "Private or non-public IP addresses are not allowed.")
            host_ascii = ip_obj.compressed
        except ValueError:
            host_ascii = host.encode("idna").decode("ascii")
            if not host_ascii or len(host_ascii) > 253:
                raise HTTPException(400, "Invalid hostname.")
            labels = host_ascii.split(".")
            if any(not label or len(label) > 63 for label in labels):
                raise HTTPException(400, "Invalid hostname.")
            if resolve_dns:
                try:
                    infos = socket.getaddrinfo(
                        host_ascii,
                        port or (443 if scheme == "https" else 80),
                        type=socket.SOCK_STREAM,
                    )
                except socket.gaierror:
                    raise HTTPException(400, "Could not resolve hostname.")
                addresses = {ipaddress.ip_address(info[4][0]) for info in infos}
                if not addresses or any(not address.is_global for address in addresses):
                    raise HTTPException(400, "Host resolves to a private or non-public address.")
    except UnicodeError:
        raise HTTPException(400, "Invalid internationalized hostname.")

    # Rebuild netloc without credentials, normalize host and omit default ports.
    if ":" in host_ascii and not host_ascii.startswith("["):
        netloc_host = f"[{host_ascii}]"
    else:
        netloc_host = host_ascii
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        netloc = f"{netloc_host}:{port}"
    else:
        netloc = netloc_host

    # Canonicalize common equivalent URLs: remove fragments/tracking parameters,
    # sort remaining query parameters, and trim non-root trailing slashes.
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    tracking_keys = {"fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"}
    query_pairs = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        lowered = key.lower()
        if lowered.startswith("utm_") or lowered in tracking_keys:
            continue
        query_pairs.append((key, value))
    query_pairs.sort(key=lambda pair: (pair[0].lower(), pair[1]))
    canonical_query = urlencode(query_pairs, doseq=True)
    return urlunsplit((scheme, netloc, path, canonical_query, ""))


class PublicOnlyResolver(aiohttp.abc.AbstractResolver):
    """Resolve DNS at connection time and pin the socket to public IP results.

    This prevents a hostname from passing an earlier check and then resolving to
    a private address when the HTTP connection is made (DNS rebinding/TOCTOU).
    """

    async def resolve(self, host, port=0, family=socket.AF_INET):
        loop = asyncio.get_running_loop()
        try:
            ip = ipaddress.ip_address(host.strip("[]"))
            addresses = [(ip.version == 4 and socket.AF_INET or socket.AF_INET6, ip.compressed)]
        except ValueError:
            try:
                # Inspect both A and AAAA records even if the connector asks
                # for one family; a mixed public/private answer must fail closed.
                infos = await loop.getaddrinfo(
                    host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
                )
            except socket.gaierror as exc:
                raise OSError("Could not resolve hostname") from exc
            addresses = [(info[0], info[4][0]) for info in infos]

        unique = []
        seen = set()
        for address_family, address_text in addresses:
            address = ipaddress.ip_address(address_text.split("%", 1)[0])
            if not address.is_global:
                raise OSError("Host resolves to a private or non-public address")
            key = (address_family, address.compressed)
            if key not in seen:
                seen.add(key)
                unique.append({
                    "hostname": host,
                    "host": address.compressed,
                    "port": port,
                    "family": address_family,
                    "proto": 0,
                    "flags": socket.AI_NUMERICHOST,
                })
        if not unique:
            raise OSError("No public address was found")
        return unique

    async def close(self):
        return None


STARTER_FEEDS = [
    {"name": "NASA", "url": "https://www.nasa.gov/feed/", "category": "Science", "description": "Space missions, science news, and discoveries."},
    {"name": "Smashing Magazine", "url": "https://www.smashingmagazine.com/feed/", "category": "Design", "description": "Web design, accessibility, and frontend craft."},
    {"name": "Cloudflare Blog", "url": "https://blog.cloudflare.com/rss/", "category": "Technology", "description": "Internet infrastructure, security, and engineering."},
    {"name": "Simon Willison", "url": "https://simonwillison.net/atom/everything/", "category": "Personal Blogs", "description": "Programming, data, AI, and small experiments."},
    {"name": "The Marginalian", "url": "https://www.themarginalian.org/feed/", "category": "Writing", "description": "Essays about creativity, meaning, science, and art."},
    {"name": "Hacker News", "url": "https://hnrss.org/frontpage", "category": "Technology", "description": "Community-submitted technology stories and discussions."},
    {"name": "KrebsOnSecurity", "url": "https://krebsonsecurity.com/feed/", "category": "Technology", "description": "Investigative reporting on cybersecurity and online crime."},
    {"name": "Mozilla Hacks", "url": "https://hacks.mozilla.org/feed/", "category": "Technology", "description": "Web platform, browser, and developer articles."},
    {"name": "NPR News", "url": "https://feeds.npr.org/1001/rss.xml", "category": "Writing", "description": "News reporting and features from NPR."},
    {"name": "MIT Technology Review", "url": "https://www.technologyreview.com/feed/", "category": "Science", "description": "Reporting on emerging technology and scientific research."},
    {"name": "Ars Technica", "url": "https://feeds.arstechnica.com/arstechnica/index", "category": "Technology", "description": "Technology, science, policy, and computing coverage."},
    {"name": "CSS-Tricks", "url": "https://css-tricks.com/feed/", "category": "Design", "description": "Frontend development, CSS, and web design techniques."},
]


def init_database():
    with closing(sqlite3.connect(DATABASE)) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS recommendations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        columns = {row[1] for row in db.execute("PRAGMA table_info(recommendations)")}
        if "popularity_count" not in columns:
            db.execute("ALTER TABLE recommendations ADD COLUMN popularity_count INTEGER NOT NULL DEFAULT 0")
        if "is_seed" not in columns:
            db.execute("ALTER TABLE recommendations ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0")
        db.execute("""
            CREATE TABLE IF NOT EXISTS co_subscription_pairs (
                url_a TEXT NOT NULL,
                url_b TEXT NOT NULL,
                contribution_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (url_a, url_b),
                CHECK (url_a < url_b)
            )
        """)
        # Canonicalize existing directory entries too, merging legacy duplicates.
        # This migration stores feed metadata/counts only, never reader batches.
        existing_rows = db.execute(
            "SELECT id, url, popularity_count FROM recommendations ORDER BY id ASC"
        ).fetchall()
        canonical_groups = {}
        for row_id, old_url, popularity_count in existing_rows:
            try:
                canonical_url = normalize_public_url(old_url, resolve_dns=False)
            except HTTPException:
                continue
            canonical_groups.setdefault(canonical_url, []).append((row_id, popularity_count))
        for canonical_url, group in canonical_groups.items():
            survivor_id = group[0][0]
            merged_popularity = sum(int(item[1] or 0) for item in group)
            duplicate_ids = [item[0] for item in group[1:]]
            if duplicate_ids:
                db.executemany(
                    "DELETE FROM recommendations WHERE id = ?",
                    [(row_id,) for row_id in duplicate_ids],
                )
            db.execute(
                "UPDATE recommendations SET url = ?, popularity_count = ? WHERE id = ?",
                (canonical_url, merged_popularity, survivor_id),
            )
        # Seed the discovery directory idempotently. Seeds are directory entries,
        # not a record of anyone's personal subscription list.
        for feed in STARTER_FEEDS:
            canonical_url = normalize_public_url(feed["url"], resolve_dns=False)
            db.execute("""
                INSERT OR IGNORE INTO recommendations
                    (name, url, category, description, popularity_count, is_seed)
                VALUES (?, ?, ?, ?, 0, 1)
            """, (feed["name"], canonical_url, feed["category"], feed["description"]))
            # If a seed URL was already submitted before this seed list existed,
            # mark that existing directory entry as seeded without losing its count.
            db.execute("UPDATE recommendations SET is_seed = 1 WHERE url = ?", (canonical_url,))
        db.commit()


class RecommendationInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=8, max_length=2048)
    category: str = Field(min_length=1, max_length=40)
    description: str = Field(min_length=1, max_length=300)

    class Config:
        extra = "forbid"


class BatchFeedInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=8, max_length=2048)
    category: str = Field(default="Personal Blogs", min_length=1, max_length=40)
    description: str = Field(default="An anonymously shared feed.", min_length=1, max_length=300)

    class Config:
        extra = "forbid"


class AnonymousBatchInput(BaseModel):
    feeds: list[BatchFeedInput] = Field(min_length=1, max_length=50)

    class Config:
        extra = "forbid"


class RecommendationQueryInput(BaseModel):
    subscriptions: list[str] = Field(default_factory=list, max_length=100)

    class Config:
        extra = "forbid"


async def download_page(url: str):
    # Check URL syntax and literal IPs here. DNS is validated asynchronously
    # by PublicOnlyResolver at connection time, which also pins the socket IP.
    normalized = normalize_public_url(url, resolve_dns=False)
    timeout = aiohttp.ClientTimeout(total=12, connect=4, sock_read=8)
    connector = aiohttp.TCPConnector(
        resolver=PublicOnlyResolver(),
        use_dns_cache=False,
        limit=10,
        ssl=True,
    )
    headers = {"User-Agent": "OpenfolioReader/1.0 (+RSS reader)"}

    try:
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            trust_env=False,
            headers=headers,
            auto_decompress=True,
        ) as session:
            async with session.get(
                normalized,
                allow_redirects=False,
                max_line_size=8190,
                max_field_size=8190,
            ) as response:
                if 300 <= response.status < 400:
                    raise HTTPException(
                        502,
                        "This website redirected the request. Try its final URL.",
                    )
                if response.status >= 400:
                    raise HTTPException(
                        502, f"Website returned HTTP {response.status}."
                    )

                content_type = response.headers.get("Content-Type", "").lower()
                supported = (
                    "html" in content_type
                    or "xml" in content_type
                    or "rss" in content_type
                    or "atom" in content_type
                    or "text/plain" in content_type
                )
                if content_type and not supported:
                    raise HTTPException(
                        415,
                        "Unsupported content type. Use a webpage or RSS/Atom feed.",
                    )

                declared_length = response.headers.get("Content-Length")
                if declared_length:
                    try:
                        if int(declared_length) > MAX_RESPONSE_BYTES:
                            raise HTTPException(413, "Response exceeds the 2 MB limit.")
                    except ValueError:
                        pass

                chunks = []
                total = 0
                async for chunk in response.content.iter_chunked(64 * 1024):
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        raise HTTPException(413, "Response exceeds the 2 MB limit.")
                    chunks.append(chunk)

                charset = response.charset or "utf-8"
                body_bytes = b"".join(chunks)
                try:
                    body = body_bytes.decode(charset, errors="replace")
                except LookupError:
                    body = body_bytes.decode("utf-8", errors="replace")

                return {
                    "url": normalized,
                    "status_code": response.status,
                    "content_type": content_type,
                    "body": body,
                }
    except HTTPException:
        raise
    except (aiohttp.ServerTimeoutError, TimeoutError):
        raise HTTPException(504, "Website request timed out.")
    except (aiohttp.ClientError, OSError, ValueError) as exc:
        message = str(exc).lower()
        if "private" in message or "non-public" in message:
            raise HTTPException(400, "Host resolves to a private or non-public address.")
        raise HTTPException(502, "Could not safely fetch this website.")


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "Openfolio API"}


@app.get("/api/fetch")
async def fetch_url(
    request: Request,
    url: str = Query(..., max_length=2048),
):
    enforce_rate_limit(request, "fetch")
    # Raw text only: the backend does not parse feeds, extract article text, or cache content.
    return await download_page(url)


@app.get("/api/article")
async def removed_article_endpoint():
    raise HTTPException(
        410,
        "Article extraction now happens in the browser. Fetch the raw HTML using /api/fetch.",
    )


def _directory_rows(db, *, limit=200, order="popularity"):
    db.row_factory = sqlite3.Row
    if order == "popularity":
        rows = db.execute("""
            SELECT id, name, url, category, description, created_at,
                   popularity_count, is_seed
            FROM recommendations
            ORDER BY popularity_count DESC, is_seed DESC, name COLLATE NOCASE ASC
            LIMIT ?
        """, (limit,)).fetchall()
    else:
        rows = db.execute("""
            SELECT id, name, url, category, description, created_at,
                   popularity_count, is_seed
            FROM recommendations
            ORDER BY name COLLATE NOCASE ASC LIMIT ?
        """, (limit,)).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/discover")
def get_recommendations(request: Request):
    """Compatibility directory endpoint, now ranked by aggregate popularity."""
    enforce_rate_limit(request, "discover_get")
    with closing(sqlite3.connect(DATABASE)) as db:
        recommendations = _directory_rows(db)
    return {"recommendations": recommendations}


@app.get("/api/discover/popular")
def get_popular_feeds(request: Request, limit: int = Query(20, ge=1, le=50)):
    enforce_rate_limit(request, "discover_get")
    with closing(sqlite3.connect(DATABASE)) as db:
        recommendations = _directory_rows(db, limit=limit)
    return {"recommendations": recommendations}


@app.post("/api/discover", status_code=201)
def submit_recommendation(request: Request, recommendation: RecommendationInput):
    """Legacy single-feed submission retained for compatibility."""
    enforce_rate_limit(request, "discover_post")
    name = recommendation.name.strip()
    category = recommendation.category.strip()
    description = recommendation.description.strip()
    if not name or not category or not description:
        raise HTTPException(400, "All fields must contain text.")

    url = normalize_public_url(recommendation.url.strip(), resolve_dns=True)
    try:
        with closing(sqlite3.connect(DATABASE, timeout=5)) as db:
            cursor = db.execute("""
                INSERT INTO recommendations
                    (name, url, category, description, popularity_count, is_seed)
                VALUES (?, ?, ?, ?, 1, 0)
                ON CONFLICT(url) DO UPDATE SET
                    popularity_count = recommendations.popularity_count + 1
            """, (name, url, category, description))
            db.commit()
            row = db.execute(
                "SELECT id, name, url, category, description, popularity_count FROM recommendations WHERE url = ?",
                (url,),
            ).fetchone()
    except sqlite3.Error:
        raise HTTPException(500, "Could not save recommendation.")

    return {
        "id": row[0], "name": row[1], "url": row[2], "category": row[3],
        "description": row[4], "popularity_count": row[5],
        "message": "Recommendation submitted.",
    }


@app.post("/api/discover/batch", status_code=201)
def submit_anonymous_batch(request: Request, batch: AnonymousBatchInput):
    """Store aggregate counts only; never persist the submitted batch or client IP."""
    enforce_rate_limit(request, "discover_post")
    canonical_feeds = {}
    for feed in batch.feeds:
        url = normalize_public_url(feed.url.strip(), resolve_dns=True)
        # Canonical URL is the deduplication key. First entry wins within a batch.
        canonical_feeds.setdefault(url, {
            "name": feed.name.strip(),
            "url": url,
            "category": feed.category.strip() or "Personal Blogs",
            "description": feed.description.strip() or "An anonymously shared feed.",
        })
    if not canonical_feeds:
        raise HTTPException(400, "Add at least one valid feed before sharing.")

    urls = sorted(canonical_feeds)
    try:
        with closing(sqlite3.connect(DATABASE, timeout=10)) as db:
            db.execute("BEGIN IMMEDIATE")
            for feed in canonical_feeds.values():
                db.execute("""
                    INSERT INTO recommendations
                        (name, url, category, description, popularity_count, is_seed)
                    VALUES (?, ?, ?, ?, 1, 0)
                    ON CONFLICT(url) DO UPDATE SET
                        popularity_count = recommendations.popularity_count + 1
                """, (feed["name"], feed["url"], feed["category"], feed["description"]))

            # Persist only aggregate pair counts. No batch ID, account ID, raw IP,
            # or per-reader subscription list is stored.
            for index, url_a in enumerate(urls):
                for url_b in urls[index + 1:]:
                    db.execute("""
                        INSERT INTO co_subscription_pairs (url_a, url_b, contribution_count)
                        VALUES (?, ?, 1)
                        ON CONFLICT(url_a, url_b) DO UPDATE SET
                            contribution_count = contribution_count + 1
                    """, (url_a, url_b))
            db.commit()
    except sqlite3.Error:
        raise HTTPException(500, "Could not save anonymous aggregate counts.")

    return {
        "accepted_feeds": len(urls),
        "deduplicated_feeds": len(batch.feeds) - len(urls),
        "stored": "aggregate popularity and co-subscription counts only",
        "message": "Anonymous batch processed. The submitted batch itself was not stored.",
    }


@app.post("/api/discover/recommendations")
def recommend_for_subscriptions(request: Request, query: RecommendationQueryInput):
    """Return recommendations for supplied URLs without persisting that URL list."""
    enforce_rate_limit(request, "discover_get")
    subscribed = set()
    for raw_url in query.subscriptions:
        try:
            subscribed.add(normalize_public_url(raw_url, resolve_dns=False))
        except HTTPException:
            # Ignore invalid values rather than failing the whole recommendation request.
            continue

    with closing(sqlite3.connect(DATABASE)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute("""
            SELECT url_a, url_b, contribution_count
            FROM co_subscription_pairs
            WHERE contribution_count >= 2
        """).fetchall()
        pair_scores = {}
        pair_sources = {}
        for row in rows:
            a, b, count = row["url_a"], row["url_b"], row["contribution_count"]
            if a in subscribed and b not in subscribed:
                candidate, source = b, a
            elif b in subscribed and a not in subscribed:
                candidate, source = a, b
            else:
                continue
            pair_scores[candidate] = pair_scores.get(candidate, 0) + count
            if candidate not in pair_sources or count > pair_sources[candidate][1]:
                pair_sources[candidate] = (source, count)

        rows = db.execute("""
            SELECT id, name, url, category, description, created_at,
                   popularity_count, is_seed
            FROM recommendations
        """).fetchall()

    directory = {row["url"]: dict(row) for row in rows}
    candidates = [feed for url, feed in directory.items() if url not in subscribed]
    candidates.sort(
        key=lambda feed: (pair_scores.get(feed["url"], 0), feed.get("popularity_count", 0), feed["is_seed"], feed["name"].lower()),
        reverse=True,
    )
    output = []
    for feed in candidates[:30]:
        pair_info = pair_sources.get(feed["url"])
        if pair_info and pair_info[0] in directory:
            source_name = directory[pair_info[0]]["name"]
            reason = f"Often followed alongside {source_name}."
        elif feed.get("popularity_count", 0) >= 3:
            reason = "Frequently included in anonymous reader submissions."
        else:
            reason = f"A starter suggestion in {feed['category']}."
        feed["reason"] = reason
        feed["recommendation_basis"] = "co_subscription" if pair_info else "popularity_or_seed"
        output.append(feed)

    return {"recommendations": output, "excluded_count": len(subscribed)}

@app.on_event("startup")
def startup_event():
    init_database()