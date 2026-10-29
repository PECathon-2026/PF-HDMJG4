import sqlite3
from pathlib import Path
from pydantic import BaseModel
from urllib.parse import urlparse
import ipaddress
import socket
import asyncio
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Openfolio API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "Openfolio API"}


def validate_public_url(url: str):
    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(400, "Enter a valid HTTP or HTTPS URL.")

    if parsed.username or parsed.password:
        raise HTTPException(400, "URL credentials are not allowed.")

    host = parsed.hostname.lower()

    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise HTTPException(400, "Local network URLs are not allowed.")

    try:
        addresses = socket.getaddrinfo(
            host, None, type=socket.SOCK_STREAM
        )
    except socket.gaierror:
        raise HTTPException(400, "Could not resolve hostname.")

    if not addresses:
        raise HTTPException(400, "Could not resolve hostname.")

    for address in addresses:
        if not ipaddress.ip_address(address[4][0]).is_global:
            raise HTTPException(400, "Private network addresses are not allowed.")

    return url


@app.get("/api/fetch")

@app.get("/api/fetch")
async def fetch_url(url: str = Query(..., max_length=2048)):
    import ipaddress
    import socket
    from urllib.parse import urljoin, urlparse

    MAX_BYTES = 2_000_000
    MAX_REDIRECTS = 5

    async def validate_destination(target: str) -> str:
        parsed = urlparse(target)

        if parsed.scheme not in ("http", "https"):
            raise HTTPException(400, "Only HTTP and HTTPS URLs are allowed.")

        if not parsed.hostname or parsed.username or parsed.password:
            raise HTTPException(400, "Invalid website URL.")

        host = parsed.hostname

        try:
            ip = ipaddress.ip_address(host)
            addresses = [ip]
        except ValueError:
            try:
                records = await asyncio.to_thread(
                    socket.getaddrinfo, host, parsed.port or (
                        443 if parsed.scheme == "https" else 80
                    ), type=socket.SOCK_STREAM
                )
                addresses = list({
                    ipaddress.ip_address(record[4][0])
                    for record in records
                })
            except OSError:
                raise HTTPException(400, "Could not resolve website address.")

        if not addresses or any(
            not address.is_global for address in addresses
        ):
            raise HTTPException(400, "Private or local addresses are not allowed.")

        return target

    current_url = url

    try:
        async with httpx.AsyncClient(
            timeout=12,
            follow_redirects=False,
            headers={"User-Agent": "OpenfolioReader/0.1"},
            trust_env=False,
        ) as client:
            for redirect_number in range(MAX_REDIRECTS + 1):
                await validate_destination(current_url)

                async with client.stream("GET", current_url) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location")

                        if not location:
                            raise HTTPException(502, "Redirect has no destination.")

                        if redirect_number >= MAX_REDIRECTS:
                            raise HTTPException(502, "Too many redirects.")

                        current_url = urljoin(current_url, location)
                        continue

                    if response.status_code >= 400:
                        raise HTTPException(
                            502, f"Website returned HTTP {response.status_code}."
                        )

                    content = bytearray()

                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)

                        if len(content) > MAX_BYTES:
                            raise HTTPException(
                                413, "Response exceeds the 2 MB limit."
                            )

                    return {
                        "url": current_url,
                        "status_code": response.status_code,
                        "content_type": response.headers.get("content-type", ""),
                        "body": bytes(content).decode("utf-8", errors="replace"),
                    }

    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(504, "Website request timed out.")
    except httpx.RequestError:
        raise HTTPException(502, "Could not fetch website.")

    raise HTTPException(502, "Could not complete website request.")


# --- Anonymous blog discovery ---

DISCOVERY_DB = Path(__file__).with_name("discovery.db")

SEED_BLOGS = [
    {
        "url": "https://hnrss.org/frontpage",
        "name": "Hacker News",
        "category": "Technology",
        "count": 18,
    },
    {
        "url": "https://css-tricks.com/feed/",
        "name": "CSS-Tricks",
        "category": "Web Development",
        "count": 14,
    },
    {
        "url": "https://www.smashingmagazine.com/feed/",
        "name": "Smashing Magazine",
        "category": "Design",
        "count": 12,
    },
    {
        "url": "https://alistapart.com/main/feed/",
        "name": "A List Apart",
        "category": "Design",
        "count": 9,
    },
    {
        "url": "https://newsletter.pragmaticengineer.com/feed",
        "name": "The Pragmatic Engineer",
        "category": "Engineering",
        "count": 11,
    },
]


def get_discovery_connection():
    connection = sqlite3.connect(DISCOVERY_DB)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_discovery_db():
    with get_discovery_connection() as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS discovery_blogs (
                url TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                subscriber_count INTEGER NOT NULL DEFAULT 0
            )
        """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS discovery_pairs (
                url_a TEXT NOT NULL,
                url_b TEXT NOT NULL,
                pair_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (url_a, url_b),
                CHECK (url_a < url_b)
            )
        """)

        for blog in SEED_BLOGS:
            connection.execute("""
                INSERT OR IGNORE INTO discovery_blogs
                    (url, name, category, subscriber_count)
                VALUES (?, ?, ?, ?)
            """, (
                blog["url"],
                blog["name"],
                blog["category"],
                blog["count"],
            ))


initialize_discovery_db()


class DiscoverySubscription(BaseModel):
    url: str
class DiscoveryBatch(BaseModel):
    urls: list[str]
    share: bool = False

@app.get("/api/discover")
def discover_blogs():
    with get_discovery_connection() as connection:
        rows = connection.execute("""
            SELECT url, name, category, subscriber_count
            FROM discovery_blogs
            ORDER BY subscriber_count DESC, name ASC
        """).fetchall()

    return {
        "blogs": [dict(row) for row in rows]
    }


@app.post("/api/discover/subscribe")
def count_discovery_subscription(payload: DiscoverySubscription):
    try:
        url = validate_public_url(payload.url)
    except HTTPException:
        raise

    with get_discovery_connection() as connection:
        existing = connection.execute(
            "SELECT url FROM discovery_blogs WHERE url = ?",
            (url,),
        ).fetchone()

        if not existing:
            raise HTTPException(
                status_code=404,
                detail="Blog not found in discovery."
            )

        connection.execute("""
            UPDATE discovery_blogs
            SET subscriber_count = subscriber_count + 1
            WHERE url = ?
        """, (url,))

        row = connection.execute("""
            SELECT url, name, category, subscriber_count
            FROM discovery_blogs
            WHERE url = ?
        """, (url,)).fetchone()

    return {"blog": dict(row)}


@app.post("/api/discover/submit")
def submit_discovery_batch(payload: DiscoveryBatch):
    if not payload.share:
        return {"shared": False, "pairs_updated": 0}

    urls = sorted(set(payload.urls))

    if len(urls) < 2:
        return {"shared": True, "pairs_updated": 0}

    if len(urls) > 100:
        raise HTTPException(
            status_code=400,
            detail="Maximum 100 subscriptions allowed."
        )

    pairs_updated = 0

    with get_discovery_connection() as connection:
        known_urls = {
            row["url"]
            for row in connection.execute(
                "SELECT url FROM discovery_blogs"
            ).fetchall()
        }

        urls = [url for url in urls if url in known_urls]

        for i in range(len(urls)):
            for j in range(i + 1, len(urls)):
                url_a, url_b = sorted((urls[i], urls[j]))

                connection.execute("""
                    INSERT INTO discovery_pairs (url_a, url_b, pair_count)
                    VALUES (?, ?, 1)
                    ON CONFLICT(url_a, url_b)
                    DO UPDATE SET pair_count = pair_count + 1
                """, (url_a, url_b))

                pairs_updated += 1

    return {"shared": True, "pairs_updated": pairs_updated}

@app.get("/api/discover/recommend")
def recommend_blogs(url: str):
    try:
        url = validate_public_url(url)
    except HTTPException:
        raise

    with get_discovery_connection() as connection:
        rows = connection.execute("""
            SELECT
                CASE
                    WHEN url_a = ? THEN url_b
                    ELSE url_a
                END AS recommended_url,
                pair_count
            FROM discovery_pairs
            WHERE url_a = ? OR url_b = ?
            ORDER BY pair_count DESC
        """, (url, url, url)).fetchall()

        recommendations = []

        for row in rows:
            blog = connection.execute("""
                SELECT url, name, category, subscriber_count
                FROM discovery_blogs
                WHERE url = ?
            """, (row["recommended_url"],)).fetchone()

            if blog:
                recommendations.append({
                    "url": blog["url"],
                    "name": blog["name"],
                    "category": blog["category"],
                    "subscriber_count": blog["subscriber_count"],
                    "reason": (
                        "Often followed together with the publication "
                        "you selected."
                    ),
                    "pair_count": row["pair_count"]
                })

    return {"recommendations": recommendations} 