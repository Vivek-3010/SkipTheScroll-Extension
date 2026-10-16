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
│   │   ├── routes/             # analyze.routes.js — GET /api/video, POST /api/analyze
│   │   ├── controllers/        # analyze.controller.js — pipeline orchestration
│   │   ├── services/           # youtube.service.js, groq.service.js
│   │   ├── utils/              # cleanComments, validateVideoId, retry, ApiError, arrays
│   │   └── prompts/            # allInOnePrompt.js (single-pass + extraction + synthesis prompts, schemas)
│   ├── scripts/                # smoke tests (npm test, key-free) + check-groq / live-groq-test (real API)
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
| AI        | Groq OpenAI-compatible `chat/completions` with JSON schema output |
| Storage   | None. Short-lived in-memory result cache only               |

No database, no auth, no TypeScript, no analytics.

---

## 1. Prerequisites

- **Node.js 18.17+** (tested on 22.x) and npm
- **Google Chrome**
- A **YouTube Data API v3** key (for `YOUTUBE_API_KEY`)
- A **Groq API key** (for `GROQ_API_KEY`)

### Getting a YouTube Data API v3 key

1. Open <https://console.cloud.google.com> and create/select a project.
2. **APIs & Services → Library → search "YouTube Data API v3" → Enable.**
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Copy the key. (The default quota is 10,000 units/day; a video analysis costs ~1 + 1 unit.)

### Getting a Groq API key

1. Open <https://console.groq.com/keys> and click **Create API Key**.
2. Copy the key value (no quotes, no `Bearer ` prefix).

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
| `GROQ_API_KEY`          | yes      | -                  | Groq API key. **Backend only.**                              |
| `PORT`                  | no       | `5178`             | Port the API listens on (must match the extension setting).  |
| `NODE_ENV`              | no       | `development`      | `development` / `production`.                                |
| `GROQ_MODEL`            | no       | `openai/gpt-oss-120b` | Model for analysis (single pass when the comments fit, otherwise extraction batches + synthesis). |
| `GROQ_MAX_TOKENS`       | no       | `3072`             | Shared budget for reasoning + the JSON answer on the verdict pass. Must keep `prompt + max_tokens` under `GROQ_REQUEST_TOKEN_BUDGET`, or Groq rejects the request (HTTP 413). |
| `GROQ_REQUEST_TOKEN_BUDGET` | no   | `8000`             | Per-request free-tier ceiling (`prompt + max_tokens`). Comment batches are sized against it, so the whole comment section is still analysed. |
| `GROQ_STARTUP_CHECK`    | no       | `true`             | One real model call at startup to surface key/model problems early. |
| `MAX_COMMENTS`          | no       | `500`              | Fetch cap: how many top-level threads are pulled from YouTube **and** analysed. Not an AI-token cap — larger sections are split into paced batches automatically. 1-500; values above 500 are clamped. |
| `YOUTUBE_TIMEOUT_MS`    | no       | `15000`            | YouTube request timeout.                                     |
| `GROQ_TIMEOUT_MS`       | no       | `120000`           | Groq request timeout.                                        |
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
  YouTube API key     : loaded (sha256:f86ec951, length 39)
  Groq API key        : loaded (sha256:a00c7182, length 56)
  Model               : openai/gpt-oss-120b
  AI endpoint         : https://api.groq.com/openai/v1/chat/completions
  Max tokens          : 3072 (shared with reasoning; sent as reasoning_effort=low)
  Request token budget: 8000 (prompt + max_tokens per AI call)
  Comment cap         : 500 threads (fetch + analysis, no AI cap)
  AI calls/run        : 1 when all comments fit one request, otherwise paced batches + 1 synthesis
  Cache TTL           : 600000ms
  --------------------------------------------
[GROQ STARTUP CHECK] OK  model=openai/gpt-oss-120b http=200 latency=250ms json_schema=true
```

The `sha256:…` fingerprints are one-way hashes: they prove *which* key the process loaded without ever
printing it. Keys are additionally redacted from every log line. If a key looks like it was pasted wrong
(whole `KEY=value` line, `Bearer ` prefix, quotes, whitespace, under 20 chars) the server says so at
startup instead of failing later.

When Groq fails, the terminal shows the real cause — HTTP status, API type, API message and whether
the failure was retryable — and the API response carries the root-cause code (e.g. `GROQ_AUTH`) rather
than a generic `GROQ_ERROR`. See `server/README.md` for the full format.

Check it is alive:

```bash
curl http://localhost:5178/api/health
```

Optional: `npm test` runs two key-free smoke tests (no API keys, no network) that cover the cleaning /
validation / retry / prompt logic and the whole analysis pipeline with both APIs mocked —
including the 500-thread fetch cap, the batched analysis flow (one extraction call per batch + one
synthesis), degraded paths and the JSON contract the popup consumes.

Two real-call diagnostics sit next to them (both need `GROQ_API_KEY`, neither spends YouTube quota):

```bash
npm run check:groq   # 5 probes: plain call → big max_tokens → json_object → json_schema → exact production payload
npm run test:live    # one real single-request analysis pass over synthetic messy comments (1 AI call)
```

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
   (a few seconds for a small comment section; larger sections take longer because each batch is a separate
   paced AI call; results are cached in memory for 10 minutes).
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
        2. commentThreads.list      paginated, hard stop at MAX_COMMENTS (500) threads, replies included
        3. cleanComments            strip HTML/entities, drop <8 char + spam + duplicates, sort by likes
        4. analyse                  one Groq pass when the comments fit, else paced extraction batches + one synthesis
        5. response                 { video, analysis, stats, meta }
```

Prompt guardrails (every prompt):

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
    "stats": { "commentsAnalyzed": 500, "commentCountOnYouTube": 4310, "truncated": true, "batchesAnalyzed": 6, "batchesRequested": 6, "failedBatches": 0, "aiCalls": 7, "analysisMode": "batched", "maxLikes": 4211, "...": "..." },
    "meta": { "source": "groq", "tookMs": 18400, "model": "openai/gpt-oss-120b", "commentCap": 500, "aiCalls": 7, "analysisMode": "batched", "analyzedAt": "2026-10-06T16:20:00.000Z" }
  },
  "cached": false
}
```

## Error shape

```jsonc
{ "ok": false, "error": { "code": "COMMENTS_DISABLED", "message": "...", "hint": "..." } }
```

Handled cases: invalid/missing video ID, comments disabled, video not found, zero comments,
all-spam comment sections, YouTube quota/rate limits, invalid YouTube key, Groq rate limits (transient
bursts retried with a `retry-after` wait), plan quota exhausted, invalid Groq key, unknown Groq model,
malformed Groq JSON, empty (reasoning-only) Groq responses, network failures, request timeouts.
Temporary failures are retried with exponential backoff + jitter; 4xx problems fail fast.

## AI quota: read this before testing

The number of Groq calls depends on the size of the comment section, and SkipTheScroll always reads **every**
fetched comment — it never analyses only the top N:

```
calls per analysis = 1                       (all comments fit one request)
                   = batches + 1             (larger sections: one extraction call per batch,
                                              then one synthesis call for the final verdict)
```

Comments are packed into batches sized against `GROQ_REQUEST_TOKEN_BUDGET` (default **8000**), the free
tier's per-request ceiling. A request whose estimated total (`prompt + max_tokens`) exceeds it is rejected
with HTTP 413 **before the model runs**, so the batcher keeps every request under that line; if a batch still
overshoots, it is split and retried. `GROQ_MAX_TOKENS` (default `3072`) only bounds the final verdict pass.

`openai/gpt-oss-120b` is a **reasoning** model, so reasoning tokens count against `GROQ_MAX_TOKENS`. gpt-oss
models are always sent `reasoning_effort=low` (measured to cut the thinking budget ~6x while keeping answer
quality). If you raise `GROQ_MAX_TOKENS`, also raise `GROQ_REQUEST_TOKEN_BUDGET` (for a paid tier) so the
verdict request still fits.

The free tier also allows only ~8,000 tokens **per minute**, so a large analysis is spread over several
minutes: the batcher reads Groq's rate-limit headers and waits for the window to refill instead of collecting
avoidable 429s. A run that loses a batch mid-way (after some batches succeeded) reports it honestly in
`stats.failedBatches` and as an `evidenceGaps` line rather than pretending the whole section was read.

Structured output is requested with `response_format: json_schema` first. If a model does not support
it, the service downgrades itself to `json_object` once per process and keeps working, so a missing
capability cannot break the pipeline.

A transient 429 (tokens-per-minute burst) is retried automatically, waiting out the `retry-after`
window the API reports. A real plan-quota block (`GROQ_QUOTA_EXCEEDED`) is never retried — it fails
fast with an actionable message, because retrying cannot help.

## Troubleshooting

| Symptom                                             | Fix                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| Server exits at startup                            | `server/.env` missing keys — copy `.env.example` and fill them in.  |
| Popup: "Could not reach the SkipTheScroll server"  | Start the backend; confirm the port matches `VITE_API_BASE_URL`.    |
| `YOUTUBE_AUTH` error                                | Enable "YouTube Data API v3" for the key's project.                 |
| `YOUTUBE_RATE_LIMIT`                                | YouTube daily quota exhausted; wait or use another key/project.     |
| `GROQ_AUTH`                                         | 401/403 from Groq. Paste only the key value into `server/.env` — no `Bearer `, no quotes, no whole `KEY=value` line. |
| `GROQ_QUOTA_EXCEEDED`                               | Plan / credits exhausted. Retrying cannot help. Check billing at <https://console.groq.com>. |
| `GROQ_RATE_LIMIT`                                   | Burst limit (per-minute token budget full). Retried automatically with a `retry-after` wait, and the batcher paces itself; a large analysis simply takes longer. |
| `GROQ_REQUEST_TOO_LARGE`                            | A single request exceeded `GROQ_REQUEST_TOKEN_BUDGET`. The service splits the batch and retries automatically; only surfaces if it happens for every batch. |
| `GROQ_OVERLOADED`                                   | HTTP 503 "overloaded". Already retried with longer backoff; wait or switch model. |
| `GROQ_EMPTY`                                        | Reasoning ate the whole `max_tokens`. Raise `GROQ_MAX_TOKENS` (the batcher keeps requests within `GROQ_REQUEST_TOKEN_BUDGET`). |
| `GROQ_BAD_REQUEST`                                  | The model rejected the payload. Run `npm run check:groq` inside `server/` — probes 4/5 isolate whether it is `json_schema` or another field. |
| `GROQ_MODEL` error                                  | Set `GROQ_MODEL` to a model your key can access.                    |
| Anything Groq-related and unclear                   | `cd server && npm run check:groq` — probes print the exact HTTP status, API type and message, plus the model list your key can reach. |
| Analysis feels slow                                 | Small sections are one AI call (~3s); large sections make one paced call per batch plus a synthesis call, so they take longer. Free-tier TPM resets every minute; use `CACHE_TTL_MS` to avoid re-analysing the same video. |
| Extension popup blank after rebuild                 | Reload the extension on `chrome://extensions`.                      |

## Deliberate V1 scope

Included: real end-to-end analysis, robust error handling, retries, in-memory caching, honest
"insufficient evidence" states.

Intentionally **not** included: database, user accounts, authentication, payments, analytics,
comment pagination beyond `MAX_COMMENTS` (500), YouTube page scraping, model fine-tuning, Chrome Web Store
packaging.

### Notes on two small additions to the requested layout

- `GET /api/video` (same controller, no new file) lets the popup show the title/thumbnail/channel
  *before* you click Analyze, using the same YouTube key on the server — so the extension never
  scrapes the YouTube DOM and never needs a key.
- `src/utils/ApiError.js` (HTTP-aware error type) and `src/utils/arrays.js` (tiny, dependency-free
  helpers kept for test reuse) keep the controller readable.
