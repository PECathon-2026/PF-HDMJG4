# Openfolio — Privacy-First RSS Reader

Openfolio is a privacy-focused, offline-first RSS and Atom feed reader. It allows users to subscribe to websites, read articles, manage reading progress, and discover new feeds through anonymous community recommendations.

## 1. Architecture Overview

Openfolio uses a client-server architecture consisting of a frontend, backend API, and database.

### Architecture Diagram

```text
                  USER
                   |
                   v
          +------------------+
          |  REACT FRONTEND  |
          |     (Vite)       |
          +------------------+
                   |
       +-----------+-----------+
       |           |           |
       v           v           v
 Subscriptions  Timeline    Discover
       |           |           |
       v           v           |
 Feed Discovery   RSS/Atom     |
       |           |           |
       v           v           |
 Article       Reading         |
 Extraction    View            |
       |           |           |
       +-----------+           |
                   |           |
             IndexedDB         |
             Local Cache       |
                   |           |
                   v           |
              Offline Reading |
                               |
                    API Requests
                         |
                         v
              +----------------------+
              |    FASTAPI BACKEND   |
              +----------------------+
                         |
              +----------+----------+
              |                     |
              v                     v
          /api/fetch          /api/discover/
          Fetch Route         batch
                              recommendations
                              popular
              |                     |
              v                     v
         External URLs         Discovery Logic
                                    |
                                    v
                              +-----------+
                              | DATABASE  |
                              | SQLite /  |
                              | PostgreSQL|
                              +-----------+
```

### Client Responsibilities

- Automatic RSS and Atom feed discovery.
- RSS and Atom XML parsing in the browser.
- Unified chronological timeline.
- Subscription management.
- Read and unread article tracking.
- Article extraction using a readability library.
- HTML sanitization using DOMPurify.
- Local caching using IndexedDB or localStorage.
- Offline-first reading experience.
- Anonymous subscription sharing with explicit opt-in.

### Server Responsibilities

The backend provides two main services.

**A. Fetch Route**

```http
GET /api/fetch?url=https://example.com/feed.xml
```

The fetch route retrieves remote website content and returns the raw response to the client.

Responsibilities:
- Handle browser CORS restrictions.
- Fetch remote URLs.
- Return raw response content.
- Handle timeouts and network errors.
- Validate URLs and reject private or local network destinations.

The server does not parse or store feed or article content.

**B. Discovery API**

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/discover/batch` | Submit subscriptions anonymously |
| GET | `/api/discover/recommendations` | Recommend feeds |
| GET | `/api/discover/popular` | Return popular feeds |

The discovery service calculates feed popularity and co-subscription recommendations.

---

## 2. Setup Instructions

### Prerequisites

- Node.js (LTS)
- npm
- Python 3.10+
- Git

### Clone the Repository

```bash
git clone https://github.com/PECathon-2026/PF-HDMJG4.git
cd Openfolio
```

### Frontend Setup

```bash
cd frontend
npm install
```

Create a `.env` file inside the frontend directory:

```env
VITE_API_BASE_URL=http://localhost:8000
```

Start the frontend:

```bash
npm run dev
```

Frontend URL:

```text
http://localhost:5173
```

### Backend Setup

Open another terminal:

```bash
cd backend
```

Create a virtual environment:

```bash
python -m venv venv
```

Activate it on Windows:

```bash
venv\Scripts\activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Start the backend:

```bash
uvicorn main:app --reload --port 8000
```

Backend URL:

```text
http://localhost:8000
```

API documentation:

```text
http://localhost:8000/docs
```

### Environment Variables

| Variable | Description |
|---|---|
| `VITE_API_BASE_URL` | Backend API URL |
| `ALLOWED_ORIGINS` | Allowed frontend origins |
| `DATABASE_URL` | Database connection string |

Example backend `.env`:

```env
ALLOWED_ORIGINS=http://localhost:5173
DATABASE_URL=your_database_connection_string
```

Only configure variables supported by the actual implementation.

---

## 3. Privacy & Threat Model

Privacy is a core principle of Openfolio.

### What the Server Stores

The discovery service stores aggregated subscription information, including:

- Normalized feed URLs.
- Feed popularity counts.
- Co-subscription statistics.
- Recommendation-related data.

If IP-based abuse protection is implemented, IP information must be stored only as a salted hash with a short expiration period.

### What the Server Never Stores

Openfolio is designed not to store:

- User accounts or passwords.
- Personal identities.
- Persistent user identifiers.
- Individual reading history.
- Read/unread status.
- Locally cached articles.
- Full extracted article content.
- Personal subscription lists by default.

Personal reading data remains on the user's device.

### Explicit Opt-In Sharing

Subscription sharing is disabled by default.

The sharing process:

1. The user opens the Discover page.
2. The user is informed about anonymous subscription sharing.
3. The user explicitly enables sharing.
4. The client submits subscriptions as one anonymous batch.
5. The backend validates and normalizes URLs.
6. The database updates aggregated feed statistics.
7. The user receives community recommendations.

Users can use Openfolio without enabling subscription sharing.

### Threat Model

| Threat | Protection |
|---|---|
| Accidental subscription sharing | Explicit opt-in |
| Duplicate subscriptions | URL normalization |
| Malicious URLs | HTTP/HTTPS validation |
| Private network access | Private IP and localhost rejection |
| Oversized submissions | Batch-size limits |
| Automated spam | Rate limiting or another abuse-protection mechanism |
| Malicious article HTML | DOMPurify sanitization |
| Network failures | Error handling and local caching |
| Unauthorized cross-origin requests | CORS configuration |

### Accepted Limitations

Openfolio minimizes the collection of personal information but does not guarantee absolute anonymity against every network-level observer.

- Hosting providers may observe incoming network connections.
- Malicious websites may provide misleading feed content.
- Spam submissions may influence community recommendations.
- Browser storage may be lost if the user clears browser data.

---

## 4. Demo Instructions

### Sample Websites to Test

| Website | URL | Feature to Test |
|---|---|---|
| BBC News | https://www.bbc.com/news | Feed discovery |
| NASA | https://www.nasa.gov | RSS discovery |
| The Verge | https://www.theverge.com | Feed parsing |
| Ars Technica | https://arstechnica.com | Article extraction |
| Smashing Magazine | https://www.smashingmagazine.com | Reading view |
| Hacker News | https://news.ycombinator.com | Feed discovery |

Feed availability can change. If homepage autodiscovery fails, try the website's published RSS or Atom feed URL.

### Edge Case Testing

**Test 1: Website Without a Feed**

Use a website that does not publish RSS or Atom.

Expected result:
- The application attempts feed autodiscovery.
- It checks common feed paths.
- It displays a clear error if no feed exists.
- The application does not crash.

**Test 2: Dead Feed**

Enter an invalid or unavailable feed URL.

Expected result:
- An appropriate error is displayed.
- Other subscriptions continue working.
- The timeline remains accessible.
- Previously cached articles remain available.

**Test 3: Article Extraction Failure**

Open an article whose content cannot be extracted.

Expected result:
- The application attempts article extraction.
- Extraction failure is handled gracefully.
- The original feed summary is displayed as a fallback.
- The reading view remains usable.

**Test 4: Duplicate URLs**

Try adding equivalent URLs:

```text
https://example.com/feed
https://example.com/feed/
https://EXAMPLE.com/feed
```

Expected result:
- URLs are normalized.
- Equivalent feeds are deduplicated.
- Duplicate subscriptions do not inflate popularity counts.

Normalization must preserve meaningful differences in feed paths and query parameters.

**Test 5: Offline Reading**

1. Subscribe to a working feed.
2. Open several articles.
3. Disconnect the internet.
4. Reload the application.
5. Open previously cached articles.

Expected result:
- Cached posts remain accessible.
- Previously cached article content can be read.
- Reading state is preserved.
- The application remains usable offline.

**Test 6: Anonymous Discovery**

1. Open the Discover page.
2. Verify that sharing is disabled by default.
3. Enable anonymous sharing.
4. Submit subscriptions.
5. Check the backend logs or database.
6. Request popular feeds.
7. Request recommendations.

Expected result:
- Subscriptions are submitted only after opt-in.
- Feed popularity is updated.
- Recommendations use co-subscription patterns.
- Already-followed feeds are excluded.
- No account or persistent user ID is required.

---

## 5. Main Features

- RSS and Atom feed support.
- Automatic feed discovery.
- Unified chronological timeline.
- Subscription management.
- Read/unread tracking.
- Full-text article reading.
- HTML sanitization.
- Graceful extraction fallback.
- Local article caching.
- Offline-first reading.
- Anonymous community discovery.
- Popular feed rankings.
- Co-subscription recommendations.
- URL normalization and deduplication.
- Privacy-focused architecture.

---

## 6. Deployment

Openfolio can be deployed using Vercel.

Recommended architecture:

```text
                 VERCEL
                   |
          +--------+--------+
          |                 |
          v                 v
      FRONTEND           BACKEND
      React/Vite         FastAPI
                            |
                            v
                     HOSTED DATABASE
                       PostgreSQL
```

Configure the production frontend environment variable:

```env
VITE_API_BASE_URL=https://YOUR-BACKEND-URL
```

Configure backend CORS to allow the deployed frontend domain.

Use a persistent hosted database for discovery information. Do not rely on serverless local SQLite storage for production persistence.

---

## 7. Project Goal

Openfolio aims to provide a fast, privacy-conscious reading experience without requiring user accounts or centralized tracking.

Its architecture separates personal reading data from anonymous community discovery while keeping feed parsing, article extraction, and offline caching on the client side.

**Read privately. Discover collectively. Own your reading experience.**
