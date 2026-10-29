# Openfolio

Openfolio is a browser-first RSS/Atom reader. Personal subscriptions and article caches stay in the user's browser; the backend provides a bounded public-page fetch proxy and a database-backed community discovery directory.

## Architecture

- **Frontend:** React + Vite. RSS/Atom parsing uses `fast-xml-parser`; full-text extraction uses Mozilla Readability in the browser; article HTML is sanitized with DOMPurify before rendering. Subscription/article state is stored in browser `localStorage`.
- **Backend:** FastAPI. `GET /api/fetch?url=...` returns raw page/feed content only. It does not parse feeds, extract article text, or persist fetched content. `GET /api/article` returns HTTP 410 because extraction moved to the browser.
- **Discovery:** SQLite stores community recommendations submitted explicitly by the user. Personal subscriptions are not automatically uploaded.

## Local setup

### Backend

```bash
cd backend
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

### Frontend

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open the local URL printed by Vite. The frontend currently expects the backend at `http://127.0.0.1:8000`.

## Configuration

- `OPENFOLIO_DATABASE`: optional SQLite file path. Defaults to `backend/openfolio.db`.
- `OPENFOLIO_RATE_LIMIT_SALT`: optional secret used to derive keyed client digests for the in-memory rate limiter. Set a random secret in deployment. If omitted, a random process-local secret is generated on startup.

Do not expose the development server directly to the public internet. For a public deployment, configure HTTPS, a production ASGI server, explicit allowed frontend origins, monitoring, and shared/distributed rate limiting if running multiple workers.

## Security and privacy threat model

### Data kept in the browser

- Subscription URLs and article cache/read state are saved in localStorage on the current browser profile.
- They are not automatically uploaded to the community API.
- Anyone with access to the same browser profile may be able to inspect its local storage. Do not use a shared device if that is a concern.

### Data stored by the backend

- SQLite stores community recommendations: name, URL, category, description, and submission timestamp.
- The backend does not persist fetched HTML/feed responses or personal subscription lists.
- Rate limiting derives an HMAC digest from the request client's IP using a secret salt. Only the digest is held in an in-memory bucket; raw IPs are not written to the database or logs by this application. In-memory entries expire on cleanup. The limiter resets on process restart and is per process.

### Server-side request forgery (SSRF) defenses

- Only HTTP and HTTPS URLs are accepted; credentials, local/reserved hostnames, invalid ports, and private/non-global IP addresses are rejected.
- Hostnames are checked for public DNS results before fetching. A custom `aiohttp` resolver repeats the check at connection time and supplies only the validated public IP addresses to the socket, reducing DNS-rebinding risk.
- Redirects are disabled. If a site redirects, the user must retry with its final URL. Every request has a timeout and a 2 MB response limit; unsupported content types are rejected.
- These controls reduce SSRF risk but do not replace a production egress firewall. Deploy with outbound network restrictions as an additional defense.

### Abuse controls and limitations

- `/api/fetch`: 40 requests per minute per client digest.
- `POST /api/discover`: 8 submissions per hour per client digest.
- `GET /api/discover`: 120 reads per minute per client digest.
- Rate limits are in-memory and reset on restart. Multi-worker deployments need a shared limiter. CORS is a browser policy, not authentication, and does not prevent non-browser clients from calling the API.
- Anonymous community submissions can contain spam. Production deployments should add moderation/reporting and monitoring before scaling.

### Article HTML safety

- Readability extracts content in the browser from the raw HTML response.
- DOMPurify sanitizes extracted HTML before it is cached and rendered. The rendering path sanitizes again because browser localStorage is not trusted.
- If extraction fails, Openfolio falls back to the plain-text feed summary rather than rendering unsanitized page HTML.

## Tests

Run backend URL validation tests from the `backend` directory:

```bash
python -m unittest discover -s tests -v
```

Run the frontend checks:

```bash
cd frontend
npm ci
npm run build
npm run lint
```

### Manual resilience test plan

1. Add a normal RSS feed and an Atom feed; confirm article titles, links, dates, and descending chronological order.
2. Paste a homepage with an RSS/Atom alternate link, then a homepage that relies on a common feed path.
3. Try malformed XML, an empty feed, an unreachable domain, and a slow site; confirm the UI reports a useful error without freezing.
4. Open a normal article; confirm browser-side extraction displays content. Use an article with scripts/unsafe markup in its page source and verify it is not executed or rendered.
5. Use an article whose extraction fails; confirm the feed excerpt remains available.
6. Reload the app and confirm subscriptions, article cache, and read/unread state persist.
7. Remove a subscription; confirm its cached articles are removed and the page selection returns to the library when necessary.
8. Try localhost, loopback, private-network IPs, URL credentials, and unsupported URL schemes against `/api/fetch`; each should be rejected.
9. Send repeated fetch/submission requests and confirm the API eventually returns HTTP 429.
10. Test a redirecting website; the API should reject the redirect rather than follow it automatically.
