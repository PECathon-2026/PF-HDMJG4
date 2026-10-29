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
from urllib.parse import urlsplit, urlunsplit

import aiohttp
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Openfolio API")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.getenv("OPENFOLIO_DATABASE", os.path.join(BASE_DIR, "openfolio.db"))
MAX_RESPONSE_BYTES = 2_000_000
RATE_LIMIT_SALT = os.getenv("OPENFOLIO_RATE_LIMIT_SALT") or secrets.token_hex(32)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
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

    path = parsed.path or "/"
    return urlunsplit((scheme, netloc, path, parsed.query, ""))


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
        db.commit()


@app.on_event("startup")
def startup():
    init_database()


class RecommendationInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=8, max_length=2048)
    category: str = Field(min_length=1, max_length=40)
    description: str = Field(min_length=1, max_length=300)

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


@app.get("/api/discover")
def get_recommendations(request: Request):
    enforce_rate_limit(request, "discover_get")
    with closing(sqlite3.connect(DATABASE)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute("""
            SELECT id, name, url, category, description, created_at
            FROM recommendations
            ORDER BY created_at DESC, id DESC
            LIMIT 200
        """).fetchall()
    return {"recommendations": [dict(row) for row in rows]}


@app.post("/api/discover", status_code=201)
def submit_recommendation(request: Request, recommendation: RecommendationInput):
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
                INSERT INTO recommendations (name, url, category, description)
                VALUES (?, ?, ?, ?)
            """, (name, url, category, description))
            db.commit()
            new_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(409, "This feed has already been recommended.")
    except sqlite3.Error:
        raise HTTPException(500, "Could not save recommendation.")

    return {
        "id": new_id,
        "name": name,
        "url": url,
        "category": category,
        "description": description,
        "message": "Recommendation submitted.",
    }
