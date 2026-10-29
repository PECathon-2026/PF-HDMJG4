
from urllib.parse import urlparse
import ipaddress
import socket

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
    allow_methods=["GET"],
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
async def fetch_url(url: str = Query(..., max_length=2048)):
    validate_public_url(url)

    try:
        async with httpx.AsyncClient(
            timeout=12,
            follow_redirects=False,
            headers={"User-Agent": "OpenfolioReader/0.1"},
        ) as client:
            response = await client.get(url)
    except httpx.TimeoutException:
        raise HTTPException(504, "Website request timed out.")
    except httpx.RequestError:
        raise HTTPException(502, "Could not fetch website.")

    if 300 <= response.status_code < 400:
        raise HTTPException(502, "Redirects are not supported yet.")

    if response.status_code >= 400:
        raise HTTPException(502, f"Website returned HTTP {response.status_code}.")

    if len(response.content) > 2_000_000:
        raise HTTPException(413, "Response exceeds the 2 MB limit.")

    return {
        "url": url,
        "status_code": response.status_code,
        "content_type": response.headers.get("content-type", ""),
        "body": response.text,
    }
