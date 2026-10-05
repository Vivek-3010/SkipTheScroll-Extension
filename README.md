# SkipTheScroll

Skip thousands of comments. Get the answer in seconds.

SkipTheScroll is a Chrome extension (Manifest V3) + Node/Express backend that reads the comments under a
YouTube tutorial / review / problem-solving video and tells you what the community actually reports:

- Does it work, or does it fail for most people?
- How confident can we be from the evidence?
- What breaks, and what fixes did people find?
- Is the video outdated?
- Where do commenters disagree?

It does **not** summarise comments. It looks for *repeated, corroborated* patterns and explicitly says
"not enough evidence" when the comment section cannot support a conclusion.

---

## Project structure

```
skipthescroll/
├── server/                     # Express backend (holds all API keys)
│   ├── src/
│   │   ├── index.js            # app + error handling
│   │   ├── config/env.js       # env loading/validation
│   │   ├── routes/             # /api/video, /api/analyze
│   │   ├── controllers/        # pipeline orchestration
│   │   ├── services/           # youtube.service.js, gemini.service.js
│   │   ├── utils/              # cleanComments, validateVideoId, retry, ApiError, arrays
│   │   └── prompts/            # batchPrompt.js, finalPrompt.js
│   ├── scripts/                # key-free smoke tests (npm test)
│   ├── .env.example
│   └── package.json
├── extension/                  # React + Vite popup (Manifest V3)
│   ├── public/manifest.json
│   ├── public/icons/
│   ├── src/popup/              # index.html, main.jsx, Popup.jsx, popup.css
│   ├── src/components/         # Header, VideoInfo, AnalyzeButton, LoadingState, ErrorState, VerdictView
│   ├── src/lib/                # api.js, youtube.js, constants.js
│   ├── vite.config.js
│   └── package.json
└── README.md
```

## Tech stack

| Layer     | Choice                                                     |
| --------- | ---------------------------------------------------------- |
| Extension | React 19 + Vite + Tailwind CSS 4, Manifest V3, plain JS/JSX |
| Backend   | Node.js + Express 5 (ESM)                                  |
| Data      | YouTube Data API v3 (`videos.list`, `commentThreads.list`)  |
| AI        | Gemini `generateContent` REST API with JSON schema output   |
| Storage   | None. Short-lived in-memory result cache only               |

No database, no auth, no TypeScript, no analytics.

---

## 1. Prerequisites

- **Node.js 18.17+** (tested on 22.x) and npm
- **Google Chrome**
- A **YouTube Data API v3** key (for `YOUTUBE_API_KEY`)
- A **Gemini API key** (for `GEMINI_API_KEY`)

### Getting a YouTube Data API v3 key

1. Open <https://console.cloud.google.com> and create/select a project.
2. **APIs & Services → Library → search "YouTube Data API v3" → Enable.**
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Copy the key. (The default quota is 10,000 units/day; a video analysis costs ~1 + 1 unit.)

### Getting a Gemini API key

1. Open <https://aistudio.google.com/apikey> and click **Create API key**.
2. Copy the key.

---

## 2. Install

```bash
# from the repository root
cd server
npm install

cd ../extension
npm install
```

## 3. Environment variables

Create the backend env file:

```bash
cd server
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Fill in `server/.env`:

| Variable                | Required | Default            | Purpose                                                     |
| ----------------------- | -------- | ------------------ | ----------------------------------------------------------- |
| `YOUTUBE_API_KEY`       | yes      | -                  | YouTube Data API v3 key. **Backend only.**                   |
| `GEMINI_API_KEY`        | yes      | -                  | Gemini API key. **Backend only.**                            |
| `PORT`                  | no       | `5178`             | Port the API listens on (must match the extension setting).  |
| `NODE_ENV`              | no       | `development`      | `development` / `production`.                                |
| `GEMINI_MODEL`          | no       | `gemini-3.8-flash` | Model for batch + final pass.                                |
| `GEMINI_API_VERSION`    | no       | `v1beta`           | REST API version (`v1beta` or `v1`).                        |
| `GEMINI_THINKING_BUDGET`| no       | *unset*            | Unset/`auto` → **no** `thinkingConfig` is sent (safest). A number or `-1` sends it explicitly. |
| `GEMINI_STARTUP_CHECK`  | no       | `true`             | One real model call at startup to surface key/model problems early. |
| `MAX_COMMENTS`          | no       | `500`              | Comment cap. Values above 500 are clamped to 500 (V1 rule).  |
| `GEMINI_BATCH_SIZE`     | no       | `50`               | Comments per batch (500 → 10 batches).                       |
| `GEMINI_CONCURRENCY`    | no       | `3`                | Parallel Gemini calls. Lower it if you hit 429s.             |
| `YOUTUBE_TIMEOUT_MS`    | no       | `15000`            | YouTube request timeout.                                     |
| `GEMINI_TIMEOUT_MS`     | no       | `120000`           | Gemini request timeout.                                      |
| `CACHE_TTL_MS`          | no       | `600000`           | In-memory cache lifetime (`0` disables it).                  |
| `CACHE_MAX_ENTRIES`     | no       | `20`               | Max cached analyses kept in memory.                          |

To point the extension at a different backend host, set `VITE_API_BASE_URL` when building
(see `extension/README.md`).

> **Security:** `.env` is git-ignored and must never be committed. Neither API key is ever bundled into
> the extension — the popup only talks to `http://localhost:5178`.

## 4. Start the backend

```bash
cd server
npm start          # production-ish single run
npm run dev        # same, with --watch auto restart
```

Expected output:

```
  SkipTheScroll server listening on http://localhost:5178

  ---- SkipTheScroll server configuration ----
  Env file            : ...\server\.env
  Port                : 5178
  YouTube API key     : loaded (sha256:f86ec951, length 39)  ok
  Gemini API key      : loaded (sha256:a2559f8b, length 39)  ok
  Model               : gemini-3.8-flash
  Gemini API version  : v1beta
  Thinking budget     : not sent (model default)
  Comment cap         : 500
  Batch size          : 50  |  concurrency: 3
  --------------------------------------------
[GEMINI STARTUP CHECK] OK  model=gemini-3.8-flash api=v1beta http=200 latency=612ms reply=ok
```

The `sha256:…` fingerprints are one-way hashes: they prove *which* key the process loaded without ever
printing it. Keys are additionally redacted from every log line. If a key does not look like a Google
API key (`AIza…`, ~39 chars) the server says so at startup instead of failing later.

When Gemini fails, the terminal shows the real cause — HTTP status, API status, API message and whether
the failure was retryable — and the API response carries the root-cause code (e.g. `GEMINI_AUTH`) rather
than a generic `GEMINI_ERROR`. See `server/README.md` for the full format.

Check it is alive:

```bash
curl http://localhost:5178/api/health
```

Optional: `npm test` runs two key-free smoke tests (no API keys, no network) that cover the cleaning /
validation / retry / prompt logic and the whole analysis pipeline with both APIs mocked —
including the 500-comment cap, batching, degraded paths and the JSON contract the popup consumes.

## 5. Build the extension

```bash
cd extension
npm run build      # outputs extension/dist
```

`npm run dev` also exists for UI work, but Chrome must load the **built** `dist` folder.

## 6. Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the folder `extension/dist` (the one containing `manifest.json`)
5. Pin "SkipTheScroll" to the toolbar (optional but handy)

Reload the extension (refresh icon on the card) after every rebuild.

## 7. Test the complete flow

1. Keep the terminal with the server running open.
2. Open a YouTube video with a real comment section — for example a tutorial with hundreds of comments
   (`https://www.youtube.com/watch?v=dQw4w9WgXcQ` works for smoke testing).
3. Click the SkipTheScroll icon in the toolbar.
4. The popup shows thumbnail, title and channel → click **Analyze Comments**.
5. Progress shows *Fetching comments... → Analyzing community feedback... → Generating verdict...*
   (typically 20–60 s; results are cached in memory for 10 minutes).
6. You get: Community Confidence meter, *Does it work?*, Overall verdict, Summary, Common Issues,
   Fixes people say worked, Important Timestamps, Status (current/outdated), Warnings,
   Conflicting Opinions, and a collapsible "What this analysis could not determine".

You can also test the backend alone:

```bash
curl -X POST http://localhost:5178/api/analyze \
  -H "Content-Type: application/json" \
  -d "{\"videoId\":\"dQw4w9WgXcQ\"}"
```

More examples and the full response shape: [`server/README.md`](server/README.md).

---

## How the analysis works

```
Popup (active tab URL)
  → GET  /api/video?videoId=...     → thumbnail / title / channel / comment count
  → POST /api/analyze  { videoId }  → full verdict
        1. videos.list              metadata (+ total comment count)
        2. commentThreads.list      paginated, hard stop at 500 threads, replies included
        3. cleanComments            strip HTML/entities, drop <8 char + spam + duplicates, sort by likes
        4. 10 batches of ~50        Gemini, JSON-schema output, 3 in parallel, retry/backoff
        5. final synthesis pass     Gemini merges batches into one verdict + confidence
        6. response                 { video, analysis, stats, meta }
```

Prompt guardrails (both prompts):

- comment text is treated as **untrusted data**, never as instructions (prompt-injection safe)
- **never invent** anything; unknowns go into `evidenceGaps`
- a single highly liked comment is an **anecdote**; a pattern needs corroboration
- first-hand reports ("I tried it and…") count, questions and speculation do not
- timestamps are only reported when a commenter explicitly mentioned one

## Response shape (V1)

```jsonc
{
  "ok": true,
  "data": {
    "video": { "id": "...", "title": "...", "channel": "...", "thumbnail": "...", "commentCount": 1234 },
    "analysis": {
      "verdict": "Mostly works",              // works | mostly works | mixed results | often fails | does not work | unclear | insufficient evidence
      "doesItWork": "Mostly",
      "confidence": 82,                       // 0-100, based on volume + agreement
      "confidenceReason": "...",
      "summary": "...",
      "commonIssues": [{ "issue": "...", "mentions": 6 }],
      "helpfulFixes": [{ "fix": "...", "mentions": 3 }],
      "timestamps": [{ "time": "4:20", "note": "the setting that actually fixes it" }],
      "status": "Likely still relevant",
      "warnings": ["..."],
      "conflictingOpinions": ["..."],
      "evidenceGaps": ["..."],
      "successReports": 41,
      "failureReports": 6
    },
    "stats": { "commentsAnalyzed": 500, "commentCountOnYouTube": 4310, "truncated": true, "maxLikes": 4211, "...": "..." },
    "meta": { "source": "gemini", "tookMs": 41230, "model": "gemini-2.5-flash", "commentCap": 500 }
  },
  "cached": false
}
```

## Error shape

```jsonc
{ "ok": false, "error": { "code": "COMMENTS_DISABLED", "message": "...", "hint": "..." } }
```

Handled cases: invalid/missing video ID, comments disabled, video not found, zero comments,
all-spam comment sections, YouTube quota/rate limits, invalid YouTube key, Gemini rate limits,
invalid Gemini key, unknown Gemini model, malformed Gemini JSON, partial batch failures, network
failures, request timeouts. Temporary failures are retried with exponential backoff + jitter.

## Gemini quota: read this before testing

Every analysis costs one Gemini call per batch **plus one** synthesis call:

```
calls per analysis = ceil(MAX_COMMENTS / GEMINI_BATCH_SIZE) + 1
```

| `MAX_COMMENTS` | `GEMINI_BATCH_SIZE` | Calls per analysis |
| -------------- | ------------------- | ------------------ |
| 500            | 50 (default)        | **11**             |
| 500            | 100                 | 6                  |
| 500            | 200                 | 4                  |

The Gemini free tier allows only a handful of requests per day, and **the allowance is tracked per
model** — measured on a real key: `gemini-3.8-flash` allows 20/day while `gemini-3.7-flash` allowed
only 5/day. So on the free tier expect roughly **one full 500-comment analysis per day**, and retries
consume the allowance too.

To test more often:

1. `GEMINI_BATCH_SIZE=200` → 4 calls per analysis.
2. `CACHE_TTL_MS=600000` → re-analysing the same video inside 10 minutes costs nothing.
3. Switch `GEMINI_MODEL` — a model whose daily allowance you have not used yet.
4. Enable billing on the Google Cloud project for real headroom.

If the **final** synthesis call is blocked but the batch calls succeeded, you still get a verdict: the
server merges the per-batch findings deterministically and reports `meta.source: "gemini-partial"` with
the reason in `evidenceGaps`, rather than discarding the analysis.

## Troubleshooting

| Symptom                                             | Fix                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| Server exits at startup                            | `server/.env` missing keys — copy `.env.example` and fill them in.  |
| Popup: "Could not reach the SkipTheScroll server"  | Start the backend; confirm the port matches `VITE_API_BASE_URL`.    |
| `YOUTUBE_AUTH` error                                | Enable "YouTube Data API v3" for the key's project.                 |
| `YOUTUBE_RATE_LIMIT`                                | YouTube daily quota exhausted; wait or use another key/project.     |
| `GEMINI_AUTH`                                       | 401/403 from Google. Paste only the key value into `server/.env` — no `Bearer `, no quotes, no whole `KEY=value` line. |
| `GEMINI_QUOTA_EXCEEDED`                             | Daily/per-key request allowance used up. Retrying cannot help; the popup shows when it resets. Switch `GEMINI_MODEL` (the free-tier allowance is **per model**) or use a paid key. |
| `GEMINI_RATE_LIMIT`                                 | Burst limit. Lower `GEMINI_CONCURRENCY`, retry.                      |
| `GEMINI_OVERLOADED`                                 | HTTP 503 "high demand". Already retried with longer backoff; wait or switch model. |
| `GEMINI_BAD_REQUEST`                                | The model rejected the payload. Unset `GEMINI_THINKING_BUDGET`, or try `GEMINI_API_VERSION=v1`. Run `npm run check:gemini` inside `server/`. |
| `GEMINI_MODEL` error                                | Set `GEMINI_MODEL` to a model your key can access.                  |
| Anything Gemini-related and unclear                 | `cd server && npm run check:gemini` — probes print the exact HTTP status, API status and message, plus the model list your key can reach. |
| Analysis feels slow                                 | Normal for 500 comments (up to 11 Gemini calls). Use `CACHE_TTL_MS`. |
| Extension popup blank after rebuild                 | Reload the extension on `chrome://extensions`.                      |

## Deliberate V1 scope

Included: real end-to-end analysis, robust error handling, retries, in-memory caching, honest
"insufficient evidence" states.

Intentionally **not** included: database, user accounts, authentication, payments, analytics,
comment pagination beyond 500, YouTube page scraping, model fine-tuning, Chrome Web Store packaging.

### Notes on two small additions to the requested layout

- `GET /api/video` (same controller, no new file) lets the popup show the title/thumbnail/channel
  *before* you click Analyze, using the same YouTube key on the server — so the extension never
  scrapes the YouTube DOM and never needs a key.
- `src/utils/ApiError.js` (HTTP-aware error type) and `src/utils/arrays.js` (`chunk`,
  `mapWithConcurrency`) keep the controller readable; both are tiny and dependency-free.
