# SkipTheScroll — backend

Express (Node 18.17+, ESM) that fetches YouTube comments with the YouTube Data API v3 and turns them into a
community verdict with Gemini. **All API keys stay in this process.**

## Run

```bash
npm install
cp .env.example .env        # Windows: Copy-Item .env.example .env
# edit .env: YOUTUBE_API_KEY, GEMINI_API_KEY
npm start                   # or: npm run dev  (auto restart on change)
```

Default port `5178`. Verify:

```bash
curl http://localhost:5178/api/health
```

## Endpoints

### `POST /api/analyze`

```bash
curl -X POST http://localhost:5178/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"videoId":"dQw4w9WgXcQ"}'
```

`videoId` may be a raw 11-character ID **or** any YouTube URL (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`).

```jsonc
{
  "ok": true,
  "cached": false,
  "data": {
    "video": {
      "id": "dQw4w9WgXcQ",
      "title": "...",
      "description": "...",
      "channel": "...",
      "channelId": "...",
      "thumbnail": "https://i.ytimg.com/...",
      "publishedAt": "...",
      "duration": "PT3M33S",
      "viewCount": 1600000000,
      "likeCount": 17000000,
      "commentCount": 4310,
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    },
    "analysis": {
      "verdict": "mostly works",
      "doesItWork": "Mostly",
      "confidence": 82,
      "confidenceReason": "31 independent success reports across 480 comments, 4 failures, all on one OS.",
      "summary": "...",
      "commonIssues": [{ "issue": "Command fails on Windows paths", "mentions": 6 }],
      "helpfulFixes": [{ "fix": "Use forward slashes in the config path", "mentions": 4 }],
      "timestamps": [{ "time": "4:20", "note": "the setting that fixes it" }],
      "status": "Likely still relevant",
      "warnings": [],
      "conflictingOpinions": ["Works on macOS 14 but not on Windows 11"],
      "evidenceGaps": ["Nobody reported results on Linux."],
      "successReports": 31,
      "failureReports": 4
    },
    "stats": {
      "commentCountOnYouTube": 4310,
      "threadsFetched": 500,
      "commentsAnalyzed": 500,
      "droppedTotal": 12,
      "duplicates": 3,
      "spamOrPromotional": 7,
      "maxLikes": 4211,
      "withReplies": 88,
      "replyComments": 213,
      "successSignals": 61,
      "failureSignals": 18,
      "oldestCommentAt": "...",
      "newestCommentAt": "...",
      "batchesAnalyzed": 10,
      "batchesRequested": 10,
      "truncated": true,
      "batchSize": 50
    },
    "meta": {
      "source": "gemini",
      "tookMs": 41230,
      "model": "gemini-3.8-flash",
      "commentCap": 500,
      "analyzedAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

`verdict` is always one of: `works`, `mostly works`, `mixed results`, `often fails`, `does not work`,
`unclear`, `insufficient evidence`.

When there is nothing to analyse (comments disabled, no comments, all comments spam) the server returns
`200` with `meta.source: "rule-based"`, `verdict: "insufficient evidence"`, `confidence: 0` — it never
invents a conclusion and never wastes Gemini calls.

### `GET /api/video?videoId=...`

Lightweight metadata for the popup before analysis (thumbnail, title, channel, counts).

```jsonc
{ "ok": true, "data": { "video": { "...": "..." }, "commentsEnabled": true } }
```

### `GET /api/health`

Liveness + config summary (`commentCap`, `model`, uptime). Never exposes keys.

### `GET /`

Service banner.

## Error codes

| Code                   | HTTP | When                                                       |
| ---------------------- | ---- | ---------------------------------------------------------- |
| `VIDEO_ID_MISSING`     | 400  | No `videoId` in the body / query.                          |
| `VIDEO_ID_INVALID`     | 400  | Not an 11-char ID or a YouTube URL.                        |
| `INVALID_JSON`         | 400  | Malformed JSON body.                                       |
| `COMMENTS_DISABLED`    | 400  | Comments are turned off for the video.                     |
| `VIDEO_NOT_FOUND`      | 404  | Private / deleted / region-blocked video.                  |
| `YOUTUBE_RATE_LIMIT`   | 429  | YouTube quota or rate limit.                               |
| `GEMINI_RATE_LIMIT`    | 429  | Gemini burst rate limit (clears in seconds).                 |
| `GEMINI_QUOTA_EXCEEDED`| 429  | Daily/per-key request allowance used up. **Never retried**; the message states when it resets. The allowance is per model. |
| `YOUTUBE_AUTH`         | 502  | Key invalid or API not enabled for the key's project.      |
| `YOUTUBE_NETWORK`      | 502  | Network failure / timeout talking to YouTube.              |
| `YOUTUBE_SERVER_ERROR` | 502  | YouTube 5xx.                                               |
| `GEMINI_AUTH`          | 502  | `GEMINI_API_KEY` rejected.                                 |
| `GEMINI_MODEL`         | 502  | `GEMINI_MODEL` not found (404).                            |
| `GEMINI_BAD_REQUEST`   | 502  | Gemini 400/413/422 — bad payload or wrong `GEMINI_API_VERSION`. Never retried. |
| `GEMINI_SERVER_ERROR`  | 502  | Gemini 5xx. Retried with backoff.                          |
| `GEMINI_OVERLOADED`    | 503  | Model capacity / "high demand". Retried with longer backoff. |
| `GEMINI_NETWORK`       | 502  | Could not reach Gemini. Retried.                           |
| `GEMINI_TIMEOUT`       | 504  | Gemini exceeded `GEMINI_TIMEOUT_MS`. Retried.              |
| `GEMINI_EMPTY`         | 502  | Empty/blocked Gemini response (`finishReason` logged).     |
| `GEMINI_MALFORMED`     | 502  | Gemini returned non-JSON (repaired when possible).         |
| `ALL_BATCHES_FAILED`   | 502  | Every batch failed *and* the failures were transient. The root cause is named in the message. |
| `INTERNAL_ERROR`       | 500  | Anything unexpected (logged server-side).                  |

`meta.source` is one of:

| Source            | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `gemini`          | Full analysis: every batch plus the final synthesis.                 |
| `gemini-partial`  | Batches were analysed but the final synthesis failed. Findings are merged mechanically, confidence is capped and `evidenceGaps` explains why. |
| `rule-based`      | Nothing to analyse (no comments, disabled, all spam). No Gemini spend. |

Shape: `{ "ok": false, "error": { "code", "message", "hint" } }` — `hint` is safe to show in the popup.

When every batch fails for a specific, non-transient reason (bad key, wrong model, bad payload) the
response uses **that** code instead of `ALL_BATCHES_FAILED`, and the message names the root cause.

## Tests

No API keys and no network needed — both scripts stub the HTTP layer.

```bash
npm test            # runs both
npm run test:utils      # video-id validation, cleaning, retry/backoff, prompt contents
npm run test:pipeline   # full pipeline with YouTube + Gemini mocked
```

`test:pipeline` asserts the things that break silently: pagination stops exactly at the 500 cap,
every fetched thread is either analysed or accounted for as dropped, batches = `ceil(500/50)`,
10 batch calls + 1 synthesis call, partial batch failure is disclosed in `evidenceGaps` instead of
silently changing the verdict, and the response contains every field the popup reads.

## Behaviour notes

- **500 comment cap.** `commentThreads.list` is paginated (100 per page) but stops as soon as 500 threads
  are collected; `MAX_COMMENTS` is clamped to 500. Replies come from the same payload (max 5 per thread).
- **Cleaning.** HTML tags and entities stripped, whitespace collapsed, comments shorter than 8 characters
  dropped, WhatsApp/phone/promo bait dropped, exact duplicates removed, remaining comments sorted by likes
  so the most corroborated ones always survive the cap.
- **Batching.** `GEMINI_BATCH_SIZE` (default 50) → up to 10 batches, `GEMINI_CONCURRENCY` (default 3) in
  parallel. A failed batch is logged and reported in `evidenceGaps`; the run only fails if *every* batch fails.
- **Retries.** Exponential backoff + jitter on network errors, 429 and 5xx (see `src/utils/retry.js`).
  4xx problems fail fast.
- **Caching.** Results are cached in memory for `CACHE_TTL_MS` (default 10 min, max `CACHE_MAX_ENTRIES`).
  Concurrent requests for the same video share one in-flight run, so double clicks cannot double-bill
  your quota. Responses reuse the cache send `X-SkipTheScroll-Cache: HIT | INFLIGHT`. No database.

## Diagnosing Gemini problems

```bash
npm run check:gemini
```

This prints the resolved configuration (model, API version, key fingerprint - never the key), then:

1. **`GET /models`** — proves whether the key authenticates at all and lists every model it can reach.
   If the configured model is missing, the script says so and suggests close alternatives.
2. Five progressively richer `:generateContent` probes, reporting the exact HTTP status, API status and
   API message for each, so you can see exactly which part of the payload the model rejects:

| Probe | Adds |
| ----- | ---- |
| 1 | minimal request |
| 2 | `responseMimeType` + `responseSchema` (JSON mode) |
| 3 | `systemInstruction` |
| 4 | `temperature` / `topP` / `maxOutputTokens` |
| 5 | `thinkingConfig` (only when `GEMINI_THINKING_BUDGET` is set) |

There is also a live end-to-end check of the real prompts and schema, which does **not** touch YouTube
quota:

```bash
npm run test:live
```

It runs one real batch call and one real synthesis call over a fixed set of deliberately messy comments
(timestamps, conflicting reports, an outdated instruction, a spam comment), then prints the normalised
output and checks it against the response contract the popup consumes.

> Both scripts spend Gemini quota. The free tier allows only a few requests per day **per model**, so
> point `GEMINI_MODEL` at a model with allowance left before running them.

### Key shape

No prefix is required — Google has shipped keys with several prefixes and new formats need not look like
the classic `AIza…`. The only checks are for paste damage, which is always invalid: a whole `KEY=value`
line, a `Bearer ` prefix, quotes, whitespace, or the variable name pasted into its own value. A 401 from
Google is reported with its real status and message; `npm run check:gemini` settles whether the
credential is actually good.

### Startup log

Every start prints the resolved configuration and (unless `GEMINI_STARTUP_CHECK=false`) sends one tiny
real request so problems surface before you click anything:

```
  ---- SkipTheScroll server configuration ----
  Env file            : ...\server\.env
  YouTube API key     : loaded (sha256:f86ec951, length 39)  ok
  Gemini API key      : loaded (sha256:a2559f8b, length 56)  WARNING - does not look like a Google API key
  Model               : gemini-3.8-flash
  Gemini API version  : v1beta
  Thinking budget     : not sent (model default)
  --------------------------------------------
[GEMINI STARTUP CHECK] FAILED
Model       : gemini-3.8-flash
HTTP status : 401
API status  : UNAUTHENTICATED
Message     : Request had invalid authentication credentials...
```

The `sha256:` fingerprint is a one-way hash prefix: it proves *which* key the process loaded without ever
revealing it. Keys are additionally redacted from every logged message.

### Failure log format

```
[GEMINI ERROR]
Label       : gemini.batch[3/10]
Model       : gemini-3.8-flash
Endpoint    : https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
HTTP status : 401
API status  : UNAUTHENTICATED
API reason  : ACCESS_TOKEN_TYPE_UNSUPPORTED
Message     : Request had invalid authentication credentials...
Request     : not sent, responseMimeType=application/json, responseSchema=yes
Retryable   : no (fix request/credentials first)
```

## Environment variables

See `../README.md` for the full table, or `.env.example`. Required: `YOUTUBE_API_KEY`, `GEMINI_API_KEY`.

Gemini-specific:

| Variable                  | Default             | Notes                                                                 |
| ------------------------- | ------------------- | --------------------------------------------------------------------- |
| `GEMINI_MODEL`            | `gemini-3.8-flash`  | Model for both passes.                                                 |
| `GEMINI_API_VERSION`      | `v1beta`            | `v1beta` or `v1`; `1beta` is accepted and normalised to `v1beta`.       |
| `GEMINI_THINKING_BUDGET`  | *unset*             | Unset/`auto`/`none`/`default`/empty → **no** `thinkingConfig` is sent. A number or `-1` sends it explicitly. |
| `GEMINI_STARTUP_CHECK`    | `true`              | One real model call at startup; set `false` to skip.                   |

No key prefix is assumed — only paste damage is flagged (a whole `KEY=value` line, a `Bearer ` prefix,
quotes, whitespace, or the variable name inside its own value). Anything that survives that check is
accepted; whether it works is decided by the API, and `npm run check:gemini` reports that authoritatively.

## Layout

```
src/
├── index.js                        express app, CORS, JSON, 404 + error handler, shutdown
├── config/env.js                   loads .env, validates keys, clamps tunables
├── routes/analyze.routes.js        GET /video, POST /analyze
├── controllers/analyze.controller.js  pipeline, cache, in-flight dedupe, response assembly
├── services/youtube.service.js     videos.list + commentThreads.list, error mapping, retries
├── services/gemini.service.js      generateContent + JSON schema, response normalisation
├── utils/cleanComments.js          HTML/entities, spam + duplicate filtering, sorting
├── utils/validateVideoId.js        ID/URL extraction and validation
├── utils/retry.js                  backoff + jitter retry helper
├── utils/arrays.js                 chunk + bounded-concurrency map
├── utils/ApiError.js               HTTP-aware error type
├── prompts/batchPrompt.js          per-batch prompt + JSON schema
└── prompts/finalPrompt.js          synthesis prompt + JSON schema + allowed verdicts

scripts/
├── smoke-utils.mjs                 offline unit checks (no keys)
└── smoke-pipeline.mjs              full pipeline with both APIs mocked (no keys)
```
