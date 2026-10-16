# SkipTheScroll — backend

Express (Node 18.17+, ESM) that fetches YouTube comments with the YouTube Data API v3 and turns them into a
community verdict with Groq (OpenAI-compatible chat completions). **All API keys stay in this process.**

## Run

```bash
npm install
cp .env.example .env        # Windows: Copy-Item .env.example .env
# edit .env: YOUTUBE_API_KEY, GROQ_API_KEY
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
      "repliesAnalyzed": 213,
      "droppedTotal": 12,
      "duplicates": 3,
      "spamOrPromotional": 7,
      "tooShortOrEmpty": 2,
      "maxLikes": 4211,
      "withReplies": 88,
      "replyComments": 213,
      "successSignals": 61,
      "failureSignals": 18,
      "oldestCommentAt": "...",
      "newestCommentAt": "...",
      "batchesAnalyzed": 6,
      "batchesRequested": 6,
      "batchSize": 84,
      "fetchLimit": 500,
      "truncated": true,
      "failedBatches": 0,
      "aiCalls": 7,
      "analysisMode": "batched"
    },
    "meta": {
      "source": "groq",
      "tookMs": 18400,
      "model": "openai/gpt-oss-120b",
      "commentCap": 500,
      "aiCalls": 7,
      "analysisMode": "batched",
      "analyzedAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

`verdict` is always one of: `works`, `mostly works`, `mixed results`, `often fails`, `does not work`,
`unclear`, `insufficient evidence`.

When there is nothing to analyse (comments disabled, no comments, all comments spam) the server returns
`200` with `meta.source: "rule-based"`, `verdict: "insufficient evidence"`, `confidence: 0` — it never
invents a conclusion and never spends AI calls.

`stats` reports coverage honestly instead of implying the whole comment section was read when it was not:
`commentsAnalyzed` + `repliesAnalyzed` are the comments the model actually received, `truncated` is true
**only** when YouTube had more top-level threads than the fetch cap allowed, and a batched run reports
`batchesAnalyzed` / `batchesRequested` / `failedBatches` (plus `aiCalls`, `analysisMode`). A partial run adds
an explicit `evidenceGaps` line saying how many batches failed.

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
| `GROQ_RATE_LIMIT`      | 429  | Groq burst rate limit (clears in seconds).                 |
| `GROQ_QUOTA_EXCEEDED`  | 429  | Plan / credits exhausted. **Never retried** — retrying cannot help. |
| `YOUTUBE_AUTH`         | 502  | Key invalid or API not enabled for the key's project.      |
| `YOUTUBE_NETWORK`      | 502  | Network failure / timeout talking to YouTube.              |
| `YOUTUBE_SERVER_ERROR` | 502  | YouTube 5xx.                                               |
| `GROQ_AUTH`            | 502  | `GROQ_API_KEY` rejected (401/403).                         |
| `GROQ_MODEL`           | 502  | `GROQ_MODEL` not found (404) or unreachable for this key.  |
| `GROQ_BAD_REQUEST`     | 502  | Groq 400/422 — bad payload. Never retried.                 |
| `GROQ_REQUEST_TOO_LARGE` | 502 | Groq 413 — `prompt + max_tokens` exceeded the free-tier budget. The service splits the batch and retries, never a hard failure by itself. |
| `GROQ_SERVER_ERROR`    | 502  | Groq 5xx. Retried with backoff.                            |
| `GROQ_OVERLOADED`      | 503  | Model capacity / "overloaded". Retried with longer backoff. |
| `GROQ_NETWORK`         | 502  | Could not reach Groq. Retried.                             |
| `GROQ_TIMEOUT`         | 504  | Groq exceeded `GROQ_TIMEOUT_MS`. Retried.                  |
| `GROQ_EMPTY`           | 502  | HTTP 200 but empty content — usually reasoning ate `max_tokens`. |
| `GROQ_MALFORMED`       | 502  | Groq returned non-JSON (repaired when possible).           |
| `INTERNAL_ERROR`       | 500  | Anything unexpected (logged server-side).                  |

`meta.source` is one of:

| Source            | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `groq`            | Full analysis: the AI pass(es) produced the verdict.                 |
| `rule-based`      | Nothing to analyse (no comments, disabled, all spam). No AI spend.   |

Shape: `{ "ok": false, "error": { "code", "message", "hint" } }` — `hint` is safe to show in the popup.

When the first AI call fails for a specific, non-transient reason (bad key, wrong model, quota,
bad payload) the response uses **that** `GROQ_*` code, and the message names the root cause — transient
429s/5xx are retried first inside the service. A failure on a **later** batch (once some batches have
succeeded) does not throw: the batches already paid for are kept, `stats.failedBatches` is set, and the
popup shows a "N of M batches could not be analysed" gap.

## Tests

No API keys and no network needed — both scripts stub the HTTP layer.

```bash
npm test            # runs both
npm run test:utils      # video-id validation, cleaning, retry/backoff, prompt contents
npm run test:pipeline   # full pipeline with YouTube + Groq mocked
```

`test:pipeline` asserts the things that break silently: pagination stops exactly at the fetch cap (500),
every fetched thread is either analysed or accounted for as dropped, a large comment section is split into
multiple batches with exactly one extraction call per batch plus a single synthesis call, a transient failure
is retried before it surfaces, a systemic failure on the first batch surfaces with a real `GROQ_*` code, and
the response contains every field the popup reads.

## Behaviour notes

- **500 comment cap.** `commentThreads.list` is paginated (100 per page) but stops as soon as
  `MAX_COMMENTS` (default 500) threads are collected. This is a fetch cap, **not** an AI-token cap anymore:
  comment sections that do not fit one request are split into paced batches (see below), so `MAX_COMMENTS`
  only bounds how many threads are pulled from YouTube. Replies come from the same payload (max 5 per thread).
- **Cleaning.** HTML tags and entities stripped, whitespace collapsed, comments shorter than 8 characters
  dropped, WhatsApp/phone/promo bait dropped, exact duplicates removed, remaining comments sorted by likes
  so the most corroborated ones always survive the cap.
- **One pass or paced batches.** If every cleaned comment fits one request the model extracts the patterns
  AND produces the final verdict in a single `json_schema` response (`FINAL_SCHEMA`, `analysisMode:
  "single-pass"`). Larger sections are packed into batches sized against `GROQ_REQUEST_TOKEN_BUDGET`; each
  batch is one extraction call (`EXTRACTION_SCHEMA`, no verdict field) and the merged extractions are judged
  by one final synthesis call (`analysisMode: "batched"`, `aiCalls = batches + 1`). Either way **every**
  fetched comment is read — there is no "top N only" path. The batcher paces itself using Groq's
  rate-limit headers, and a `GROQ_REQUEST_TOO_LARGE` (HTTP 413) response splits and retries the batch.
- **Retries + partial runs.** Transient failures are retried with exponential backoff + jitter, waiting out a
  429's `retry-after` window; a plan-quota block and 4xx fail fast with an actionable `GROQ_*` code. A
  failure on the first batch is systemic and throws; a failure on a later batch keeps the batches already
  analysed, stops after two consecutive failures, and reports coverage via `stats.failedBatches`.
- **Caching.** Results are cached in memory for `CACHE_TTL_MS` (default 10 min, max `CACHE_MAX_ENTRIES`).
  Concurrent requests for the same video share one in-flight run, so double clicks cannot double-bill
  your quota. Responses reuse the cache send `X-SkipTheScroll-Cache: HIT | INFLIGHT`. No database.

## Diagnosing Groq problems

```bash
npm run check:groq
```

This prints the resolved configuration (model, key fingerprint - never the key), then:

1. **`GET /openai/v1/models`** — proves whether the key authenticates at all and lists every model it can
   reach. If the configured model is missing, the script says so and suggests close alternatives.
2. Five progressively richer `:chat/completions` probes, reporting the exact HTTP status, API type and
   API message for each, so you can see exactly which part of the payload the model rejects:

| Probe | Adds |
| ----- | ---- |
| 1 | minimal chat completion |
| 2 | `max_tokens` larger than production allows (8192) |
| 3 | `response_format: { type: "json_object" }` |
| 4 | `response_format: { type: "json_schema", … }` with the real verdict schema |
| 5 | the exact production payload: `temperature` / `top_p` / `reasoning_effort=low` / 3072 tokens |

The script also reports whether the model supports `json_schema` at all. If it does not, the service
downgrades itself to `json_object` for the rest of the process, so the pipeline keeps working.

There is also a live end-to-end check of the real prompts and schema, which does **not** touch YouTube
quota:

```bash
npm run test:live
```

It runs one real analysis call over a fixed, single-request-sized sample of deliberately messy comments
(timestamps, conflicting reports, an outdated instruction, a spam comment, plus long comments to stress the
token budget), then prints the normalised output and checks it against the response contract the popup
consumes. (The pipeline itself batches larger comment sections; this only validates one request's prompt and
schema.)

> Both scripts spend AI quota. Point `GROQ_MODEL` at a model with allowance left before running them.

### Reasoning models, `max_tokens` and the free-tier budget

`openai/gpt-oss-120b` is a reasoning model: part of the `max_tokens` budget is spent thinking, and the
visible JSON answer shares what is left. By default gpt-oss models are sent `reasoning_effort=low`,
which cuts the thinking budget ~6x (measured: 3983 → ~600 tokens) with no visible loss of answer quality.
If `max_tokens` is too small the model can answer with HTTP 200 and **empty** content, which surfaces as
`GROQ_EMPTY`.

The free tier also rejects a request whose estimated total exceeds ~8,000 tokens per minute with HTTP 413
**before the model runs**. `GROQ_MAX_TOKENS` defaults to `3072` and `GROQ_REQUEST_TOKEN_BUDGET` to `8000`.
The analysing layer never lets a single request cross that line: it packs comments into batches sized against
`GROQ_REQUEST_TOKEN_BUDGET`, so a request stays valid instead of being rejected. If a batch is still too
large, the service halves and retries it. The rule to remember when tuning:
`prompt_tokens + max_tokens ≤ GROQ_REQUEST_TOKEN_BUDGET`.

### Key shape

No prefix is required — the only checks are for paste damage, which is always invalid: a whole `KEY=value`
line, a `Bearer ` prefix, quotes, whitespace, the variable name pasted into its own value, or fewer than
20 characters. A 401 from Groq is reported with its real status and message; `npm run check:groq` settles
whether the credential is actually good. The key is only ever sent as `Authorization: Bearer …` — never in
the URL, never to the extension.

### Startup log

Every start prints the resolved configuration and (unless `GROQ_STARTUP_CHECK=false`) sends one tiny
real request so problems surface before you click anything:

```
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
```

```
[GROQ STARTUP CHECK] FAILED
Model       : openai/gpt-oss-120b
Endpoint    : https://api.groq.com/openai/v1/chat/completions
HTTP status : 401
API type    : invalid_request_error
Message     : Invalid API Key
```

The `sha256:` fingerprint is a one-way hash prefix: it proves *which* key the process loaded without ever
revealing it. Keys are additionally redacted from every logged message.

### Failure log format

```
[GROQ ERROR]
Label       : groq.analysis
Model       : openai/gpt-oss-120b
Endpoint    : https://api.groq.com/openai/v1/chat/completions
HTTP status : 401
API type    : invalid_request_error
API code    : invalid_api_key
Retry-After : null
Message     : Invalid API Key
Request     : response_format=json_schema
Code        : GROQ_AUTH
Retryable   : no (retrying cannot help)
```

## Environment variables

See `../README.md` for the full table, or `.env.example`. Required: `YOUTUBE_API_KEY`, `GROQ_API_KEY`.

Groq-specific:

| Variable               | Default                | Notes                                                                 |
| ---------------------- | ---------------------- | --------------------------------------------------------------------- |
| `GROQ_MODEL`           | `openai/gpt-oss-120b`  | Model for extraction batches + the final synthesis pass.              |
| `GROQ_MAX_TOKENS`      | `3072`                 | Shared budget for reasoning + the JSON answer on the verdict pass. Keep `prompt + max_tokens` under `GROQ_REQUEST_TOKEN_BUDGET` or Groq rejects the request (HTTP 413). |
| `GROQ_REQUEST_TOKEN_BUDGET` | `8000`            | Per-request free-tier ceiling (`prompt + max_tokens`). Batches are sized against it; only lower it for a stricter tier. |
| `GROQ_STARTUP_CHECK`   | `true`                 | One real model call at startup; set `false` to skip.                   |
| `GROQ_TIMEOUT_MS`      | `120000`               | Per-request timeout.                                                   |

No key prefix is assumed — only paste damage is flagged (a whole `KEY=value` line, a `Bearer ` prefix,
quotes, whitespace, the variable name inside its own value, or fewer than 20 characters). Anything that
survives that check is accepted; whether it works is decided by the API, and `npm run check:groq` reports
that authoritatively.

## Layout

```
src/
├── index.js                        express app, CORS, JSON, 404 + error handler, shutdown
├── config/env.js                   loads .env, validates keys, clamps tunables
├── routes/analyze.routes.js        GET /video, POST /analyze
├── controllers/analyze.controller.js  pipeline, cache, in-flight dedupe, response assembly
├── services/youtube.service.js     videos.list + commentThreads.list, error mapping, retries
├── services/groq.service.js        chat/completions + JSON schema, batch packing/pacing, normalisation
├── utils/cleanComments.js          HTML/entities, spam + duplicate filtering, sorting
├── utils/validateVideoId.js        ID/URL extraction and validation
├── utils/retry.js                  backoff + jitter retry helper
├── utils/arrays.js                 chunk + bounded-concurrency map (test reuse)
├── utils/ApiError.js               HTTP-aware error type
└── prompts/allInOnePrompt.js       single-pass + extraction + synthesis prompts, schemas, merge

scripts/
├── smoke-utils.mjs                 offline unit checks (no keys)
├── smoke-pipeline.mjs              full pipeline with both APIs mocked (no keys)
├── check-groq.mjs                  live Groq diagnostics (spends AI quota)
└── live-groq-test.mjs              real prompts over fixed synthetic comments (no YouTube quota)
```
