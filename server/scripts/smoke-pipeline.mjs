/**
 * End-to-end pipeline test with YouTube + Groq mocked (no real API keys, no
 * network). Run: node scripts/smoke-pipeline.mjs
 *
 * Verifies:
 *  - metadata fetch
 *  - comment pagination that stops at the MAX_COMMENTS thread cap
 *  - cleaning (spam / short / duplicates dropped)
 *  - a large comment section is analysed in MULTIPLE paced AI batches
 *    (extraction per batch + one synthesis call), never a "top 60 only" pass
 *  - transient 429s (incl. Groq's TPM wording that links to the billing page)
 *    are retried, while plan-quota 429s and 4xx are never retried
 *  - the 429 misclassification bug: a tokens-per-minute burst is NOT a quota
 *  - the exact JSON contract the Chrome extension consumes
 *  - the API key only ever travels in an Authorization header, never a query
 */
process.env.YOUTUBE_API_KEY ||= 'test-youtube-key'
process.env.GROQ_API_KEY ||= 'test-groq-key'
process.env.CACHE_TTL_MS ||= '0'
// Pin the cap the assertions below rely on so a developer's local server/.env
// (dotenv does not override already-set vars) cannot change the subject under test.
process.env.MAX_COMMENTS ||= '500'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const { analyze } = await import('../src/controllers/analyze.controller.js')
const {
  analyzeAllAtOnce,
  analyzeComments,
  mapGroqError,
  toJsonSchema,
  buildRequestBody,
  packCommentBatches,
  parseRateLimit,
  parseDuration,
  normalizeExtraction,
  setJsonSchemaSupported,
  supportsJsonSchema,
  redact,
} = await import('../src/services/groq.service.js')
const {
  FINAL_SCHEMA,
  EXTRACTION_SCHEMA,
  buildExtractionPrompt,
  buildSynthesisPrompt,
  mergeExtractions,
} = await import('../src/prompts/allInOnePrompt.js')
const { config } = await import('../src/config/env.js')
const { RETRYABLE_CODES, PATIENCE_OVERRIDES } = await import('../src/utils/retry.js')
const { ALLOWED_VERDICTS } = await import('../src/prompts/allInOnePrompt.js')
const ANALYSIS_VERDICTS = ALLOWED_VERDICTS.map((verdict) => verdict.toLowerCase())

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`}`)
}

/* ------------------------------- fake APIs ------------------------------- */

const TOTAL_COMMENTS_ON_YOUTUBE = 1200
const calls = { videos: 0, commentThreads: 0, commentThreadPages: [], aiAnalysis: 0, aiExtraction: 0, aiSynthesis: 0 }

/** Switchable fixture behaviour for the degraded-path scenarios below. */
const scenario = {
  commentCount: TOTAL_COMMENTS_ON_YOUTUBE,
  commentsDisabled: false,
  failAnalysisWith: null, // { status, payload } returned for EVERY analysis attempt
  aiFailuresBeforeSuccess: 0, // fail the first N analysis attempts (429), then succeed
}

const SUCCESS_COMMENTS = [
  'Confirmed working for me on Windows 11, followed every step and it worked first try',
  'This worked perfectly on my Mac after I restarted the machine, thanks for the video',
  'Worked out of the box on Ubuntu 22.04, exactly as described in the video',
  'Success here too, took about ten minutes and my issue is finally solved',
  'Confirmed working, the fix in this video solved the problem I had for two weeks',
]
const FAILURE_COMMENTS = [
  'Did not work for me at all on Windows 11, the installer fails silently every time',
  'Does not work on macOS Sonoma, the command line tool crashes on the first step',
  'Still broken after following the video twice, error message does not match what is shown',
  'Failed for me, the path in the video is wrong for Linux users on the latest version',
]
const NOISE_COMMENTS = ['nice', 'https://spam.example https://buy.example', '   ']

function commentFor(index) {
  const bucket = index % 20
  if (bucket === 7) return NOISE_COMMENTS[Math.floor(index / 20) % NOISE_COMMENTS.length]
  // "setup N" keeps every comment unique so de-duplication does not eat the fixtures.
  const setup = ` (my setup #${index})`
  if (bucket % 4 === 0) return `${FAILURE_COMMENTS[Math.floor(index / 20) % FAILURE_COMMENTS.length]}${setup}`
  return `${SUCCESS_COMMENTS[Math.floor(index / 20) % SUCCESS_COMMENTS.length]}${setup}`
}

function makeThread(index) {
  return {
    snippet: {
      totalReplyCount: 1,
      topLevelComment: {
        id: `thread_${index}`,
        snippet: {
          authorDisplayName: `user${index}`,
          authorChannelId: `UC${index}`,
          textDisplay: `${commentFor(index)} &amp; more`,
          likeCount: 500 - index,
          publishedAt: '2025-01-02T03:04:05Z',
        },
      },
      replies: [
        {
          snippet: {
            authorDisplayName: 'replier',
            textDisplay: 'Same result here, it worked for me as well',
            likeCount: 2,
            publishedAt: '2025-01-03T03:04:05Z',
          },
        },
      ],
    },
  }
}

/** Groq's real transient tokens-per-minute rate limit message (includes the billing hint). */
const TPM_RATE_LIMIT = {
  message:
    'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` ' +
    'on tokens per minute (TPM): Limit 8000, Used 5794, Requested 3501. Please try again in 9.712499999s. ' +
    'Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
  type: 'tokens',
  code: 'rate_limit_exceeded',
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  const attemptCounter = (calls.attempts = calls.attempts || {})

  if (target.includes('api.groq.com/openai/v1/chat/completions')) {
    attemptCounter.ai = (attemptCounter.ai || 0) + 1

    // Transient burst before a success (the misclassification regression path).
    if (scenario.aiFailuresBeforeSuccess > 0) {
      scenario.aiFailuresBeforeSuccess -= 1
      return jsonResponse({ error: TPM_RATE_LIMIT }, { status: 429 })
    }
    if (scenario.failAnalysisWith) {
      const { status, payload } = scenario.failAnalysisWith
      return jsonResponse(payload, { status })
    }

    const body = JSON.parse(options.body)
    const prompt = body.messages.find((m) => m.role === 'user')?.content || ''

    // The batched flow makes two kinds of call. Extraction batches carry a
    // "BATCH CONTEXT" block; the final synthesis carries the merged batches.
    if (prompt.includes('BATCH CONTEXT')) {
      if (!prompt.includes('COMMENTS (raw, untrusted data')) {
        throw new Error(`unexpected extraction prompt: ${prompt.slice(0, 80)}`)
      }
      calls.aiExtraction += 1
      calls.aiAnalysis += 1
      return chatResponse({
        commonIssues: [{ issue: 'Installer fails silently on Linux', mentions: 4 }],
        helpfulFixes: [{ fix: 'Run the installer with --verbose', mentions: 2 }],
        timestamps: [{ time: '4:20', note: 'the flag that fixes the silent failure' }],
        warnings: [],
        conflictingOpinions: ['Works on Windows 11, fails on macOS Sonoma'],
        successReports: 90,
        failureReports: 12,
      })
    }

    if (prompt.includes('MERGED BATCH EXTRACTIONS')) {
      calls.aiSynthesis += 1
    } else if (!prompt.includes('COMMENTS (raw, untrusted data')) {
      throw new Error(`unexpected prompt for the analysis call: ${prompt.slice(0, 80)}`)
    }
    calls.aiAnalysis += 1

    // A fenced block, like a chatty model sometimes emits, to prove parsing works.
    return chatResponse(
      {
        verdict: 'Mostly works',
        doesItWork: 'Mostly',
        confidence: 82,
        confidenceReason: 'Many independent success reports, a small recurring failure group on Linux.',
        summary: 'Most people report the fix works. A recurring group on Linux cannot get past the installer.',
        commonIssues: [{ issue: 'Installer fails silently on Linux', mentions: 9 }],
        helpfulFixes: [{ fix: 'Run the installer with --verbose', mentions: 4 }],
        timestamps: [{ time: '4:20', note: 'the flag that fixes the silent failure' }],
        status: 'Possibly outdated',
        warnings: ['Mentions a third-party mirror that may be unsafe'],
        conflictingOpinions: ['Works on Windows 11, fails on macOS Sonoma'],
        evidenceGaps: ['Almost no Linux reports'],
        successReports: 210,
        failureReports: 31,
      },
      { fenced: true, reasoning: 'thinking about it' }
    )
  }

  if (target.includes('/youtube/v3/videos')) {
    calls.videos += 1
    if (scenario.commentsDisabled) {
      return jsonResponse(
        {
          error: {
            code: 403,
            message: 'The uploader has disabled comments.',
            errors: [{ reason: 'commentsDisabled', domain: 'youtube.comment', message: 'commentsDisabled' }],
            status: 'PERMISSION_DENIED',
          },
        },
        { status: 403 }
      )
    }
    return jsonResponse({
      items: [
        {
          videoId: 'dQw4w9WgXcQ',
          snippet: {
            title: 'How to fix your PC in 10 minutes',
            description: 'A tutorial.',
            channelTitle: 'Tech Channel',
            channelId: 'UC123',
            publishedAt: '2023-04-01T00:00:00Z',
            thumbnails: { high: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' } },
          },
          statistics: { viewCount: '1600000', likeCount: '17000', commentCount: String(scenario.commentCount) },
          contentDetails: { duration: 'PT10M20S' },
        },
      ],
    })
  }

  if (target.includes('/youtube/v3/commentThreads')) {
    calls.commentThreads += 1
    const pageToken = new URL(target).searchParams.get('pageToken')
    const start = pageToken ? Number(pageToken.split('-')[1]) : 0
    const maxResults = Number(new URL(target).searchParams.get('maxResults'))
    calls.commentThreadPages.push({ start, maxResults })

    const items = Array.from({ length: maxResults }, (_, i) => makeThread(start + i))
    const nextStart = start + maxResults
    const body = { items, pageInfo: { totalResults: TOTAL_COMMENTS_ON_YOUTUBE } }
    if (nextStart < TOTAL_COMMENTS_ON_YOUTUBE) body.nextPageToken = `page-${nextStart}`
    return jsonResponse(body)
  }

  throw new Error(`unexpected fetch: ${target}`)
}

/** Wraps a payload in the OpenAI-compatible chat completion envelope. */
function chatResponse(payload, { fenced = false, reasoning = null } = {}) {
  const text = fenced ? '```json\n' + JSON.stringify(payload) + '\n```' : JSON.stringify(payload)
  return jsonResponse({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'openai/gpt-oss-120b',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: reasoning ? { role: 'assistant', content: text, reasoning } : { role: 'assistant', content: text },
      },
    ],
    usage: { prompt_tokens: 4000, completion_tokens: 1200, total_tokens: 5200 },
  })
}

function jsonResponse(body, init = {}) {
  return {
    ok: init.status ? init.status < 400 : true,
    status: init.status || 200,
    headers: init.headers || new Map(),
    json: async () => body,
  }
}

/* --------------------------------- run ---------------------------------- */

function mockRes() {
  const res = { statusCode: null, body: null }
  res.json = (payload) => {
    res.body = payload
    return res
  }
  res.set = () => res
  return res
}

const res = mockRes()
const next = (err) => {
  throw err
}

const startedAt = Date.now()
await analyze({ body: { videoId: 'dQw4w9WgXcQ' } }, res, next)
const elapsed = Date.now() - startedAt
const payload = res.body
const data = payload?.data

check('response ok', payload?.ok, true)
check('videos.list called once', calls.videos, 1)
check('comment pages fetched until the 500-thread cap', calls.commentThreads, 5)
check('pagination page size is 100', calls.commentThreadPages[0].maxResults, 100)
check('pages walk forward from 0 in steps of 100', calls.commentThreadPages.map((p) => p.start), [0, 100, 200, 300, 400])
check('thread cap never exceeded', data?.stats?.threadsFetched, 500)
check('every fetched thread is analysed or dropped', data?.stats?.commentsAnalyzed + data?.stats?.droppedTotal, 500)
check('comments were actually kept (not capped at 60 anymore)', data?.stats?.commentsAnalyzed > 60, true)
check('truncated flag (more threads exist than the cap)', data?.stats?.truncated, true)
check('large set is split into multiple batches', data?.stats?.batchesRequested >= 2, true)
check('every batch was analysed', data?.stats?.batchesAnalyzed, data?.stats?.batchesRequested)
check('no failed batches on the happy path', data?.stats?.failedBatches, 0)
check('extraction call per batch', calls.aiExtraction, data?.stats?.batchesAnalyzed)
check('exactly one synthesis call', calls.aiSynthesis, 1)
check('aiCalls = batches + synthesis', data?.stats?.aiCalls, data?.stats?.batchesAnalyzed + 1)
check('all AI calls reached the mocked API', calls.aiAnalysis, data?.stats?.aiCalls)
check('analysis mode is batched', data?.stats?.analysisMode, 'batched')
check('verdict', data?.analysis?.verdict, 'mostly works')
check('confidence clamped 0-100', typeof data?.analysis?.confidence === 'number' && data.analysis.confidence <= 100, true)
check('summary present', typeof data?.analysis?.summary === 'string' && data.analysis.summary.length > 0, true)
check('issues capped', Array.isArray(data?.analysis?.commonIssues) && data.analysis.commonIssues.length <= 6, true)
check('timestamps keep time + note', data?.analysis?.timestamps?.[0]?.time, '4:20')
check('status preserved', data?.analysis?.status, 'Possibly outdated')
check('warnings preserved', data?.analysis?.warnings?.length, 1)
check('conflicts preserved', data?.analysis?.conflictingOpinions?.length, 1)
check('video thumbnail mapped', data?.video?.thumbnail?.endsWith('hqdefault.jpg'), true)
check('meta.commentCap is the fetch/analysis cap', data?.meta?.commentCap, 500)
check('meta.source', data?.meta?.source, 'groq')
check('meta.model is the configured Groq model', data?.meta?.model, config.groq.model)
check('meta.aiCalls mirrors stats', data?.meta?.aiCalls, data?.stats?.aiCalls)
check('meta.analysisMode', data?.meta?.analysisMode, 'batched')
check('evidence gap about the fetch cap', data?.analysis?.evidenceGaps?.some((g) => g.includes('fetch limit: 500')), true)
check('spam was dropped from the count', data?.stats?.spamOrPromotional > 0, true)
check('short comments dropped', data?.stats?.droppedTotal > 0, true)
const ANALYSIS_KEYS = [
  'verdict',
  'doesItWork',
  'confidence',
  'summary',
  'commonIssues',
  'helpfulFixes',
  'timestamps',
  'status',
  'warnings',
  'conflictingOpinions',
  'evidenceGaps',
]

check('analysis keys match extension contract', ANALYSIS_KEYS.every((key) => key in (data?.analysis || {})), true)

/* --------------------------- degraded scenarios --------------------------- */

async function runAnalyze(videoId) {
  const res = mockRes()
  try {
    await analyze({ body: { videoId } }, res, (err) => {
      throw err
    })
    return { ok: true, data: res.body.data }
  } catch (err) {
    return { ok: false, code: err.code, status: err.status, message: err.message, hint: err.hint }
  }
}

console.log('\n--- scenario: comments disabled ---')
scenario.commentsDisabled = true
let scenarioResult = await runAnalyze('aaaaaaaaaaa')
check('comments disabled -> 400 COMMENTS_DISABLED', [scenarioResult.ok, scenarioResult.code], [false, 'COMMENTS_DISABLED'])
scenario.commentsDisabled = false

console.log('\n--- scenario: zero comments on a video ---')
scenario.commentCount = 0
scenarioResult = await runAnalyze('bbbbbbbbbbb')
check('zero comments -> 200', scenarioResult.ok, true)
check('zero comments -> insufficient evidence', scenarioResult.data?.analysis?.verdict, 'insufficient evidence')
check('zero comments -> rule based (no AI spend)', scenarioResult.data?.meta?.source, 'rule-based')
check('zero comments -> confidence 0', scenarioResult.data?.analysis?.confidence, 0)
check('zero comments -> says why', scenarioResult.data?.analysis?.summary.includes('Comments are turned off'), true)
scenario.commentCount = TOTAL_COMMENTS_ON_YOUTUBE

console.log('\n--- scenario: the first batch extraction fails with a 500 ---')
scenario.failAnalysisWith = {
  status: 500,
  payload: { error: { message: 'Internal error', type: 'server_error', code: 'internal' } },
}
calls.attempts = {}
scenarioResult = await runAnalyze('ccccccccccc')
check('analysis failure -> 502', [scenarioResult.ok, scenarioResult.status], [false, 502])
check('analysis failure -> GROQ_SERVER_ERROR', scenarioResult.code, 'GROQ_SERVER_ERROR')
check('analysis failure keeps the root cause', scenarioResult.message.includes('Internal error'), true)
// A systemic failure on the very first batch surfaces instead of hiding behind
// a "no data" verdict. The batch extraction policy allows 1 + 4 retries.
check('analysis failure was retried', calls.attempts.ai, 5)
scenario.failAnalysisWith = null

console.log('\n--- scenario: analysis fails with a bad key (real cause surfaced) ---')
scenario.failAnalysisWith = {
  status: 401,
  payload: { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } },
}
calls.attempts = {}
scenarioResult = await runAnalyze('eeeeeeeeeee')
check('401 -> GROQ_AUTH not a generic code', scenarioResult.code, 'GROQ_AUTH')
check('401 -> root cause in message', scenarioResult.message.includes('Invalid API Key'), true)
check('401 -> hint is actionable', (scenarioResult.hint || '').length > 0, true)
// A 401 is never retried: exactly one attempt.
check('401 -> one attempt', calls.attempts.ai, 1)
scenario.failAnalysisWith = null

console.log('\n--- scenario: transient TPM rate limit (billing-URL message) then success ---')
// Groq's real tokens-per-minute wording ends with a link to the billing page.
// This MUST be classified as a transient burst (retried), never as a permanent
// plan-quota block. Fail twice, then the third attempt succeeds.
scenario.aiFailuresBeforeSuccess = 2
calls.attempts = {}
scenarioResult = await runAnalyze('fffffffffff')
check('TPM burst retried -> analysis succeeds', scenarioResult.ok, true)
check('TPM burst was retried twice', calls.attempts.ai, scenarioResult.data?.stats?.aiCalls + 2)
check('TPM burst -> source groq (no partial fallback needed)', scenarioResult.data?.meta?.source, 'groq')

console.log('\n--- scenario: plan quota exhausted (never retried, actionable error) ---')
scenario.failAnalysisWith = {
  status: 429,
  payload: {
    error: {
      message: 'Rate limit reached. Your plan quota is exhausted. Check billing details at https://console.groq.com.',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  },
}
calls.attempts = {}
scenarioResult = await runAnalyze('ggggggggggg')
check('plan quota -> GROQ_QUOTA_EXCEEDED', scenarioResult.code, 'GROQ_QUOTA_EXCEEDED')
check('plan quota -> exactly one attempt (never retried)', calls.attempts.ai, 1)
check('plan quota -> hint says retrying cannot help', (scenarioResult.hint || '').includes('cannot help'), true)
scenario.failAnalysisWith = null

/* -------------------- AI error mapping + retry policy -------------------- */

console.log('\n--- Groq HTTP error mapping (no generic GROQ_ERROR) ---')

function mapped(httpStatus, payload, headers = new Map()) {
  return mapGroqError({
    status: httpStatus,
    payload,
    model: 'openai/gpt-oss-120b',
    label: 'test',
    headers,
  })
}

const originalConsoleError = console.error
console.error = () => {} // keep the expected [GROQ ERROR] blocks out of the test log
try {
  const auth = mapped(401, {
    error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' },
  })
  check('401 -> GROQ_AUTH', auth.code, 'GROQ_AUTH')
  check('401 keeps HTTP status in message', auth.message.includes('HTTP 401'), true)
  check('401 keeps API type in message', auth.message.includes('invalid_request_error'), true)
  check('401 keeps API message', auth.message.includes('Invalid API Key'), true)

  const forbidden = mapped(403, { error: { message: 'Forbidden', type: 'permission_error' } })
  check('403 -> GROQ_AUTH', forbidden.code, 'GROQ_AUTH')

  const badRequest = mapped(400, {
    error: { message: 'Unknown parameter: response_format.json_schema', type: 'invalid_request_error' },
  })
  check('400 -> GROQ_BAD_REQUEST', badRequest.code, 'GROQ_BAD_REQUEST')
  check('400 keeps the real API message', badRequest.message.includes('response_format.json_schema'), true)
  check('400 hint says do not retry', badRequest.hint.includes('Not transient'), true)

  // 413 is its own code: the payload is valid, the free-tier token budget
  // rejected it. The batcher keys off this code to split the batch.
  const tooLarge = mapped(413, {
    error: { message: 'Request too large for model `openai/gpt-oss-120b`', type: 'tokens', code: 'rate_limit_exceeded' },
  })
  check('413 -> GROQ_REQUEST_TOO_LARGE (distinct from BAD_REQUEST)', tooLarge.code, 'GROQ_REQUEST_TOO_LARGE')
  check('413 is NOT retryable', RETRYABLE_CODES.has('GROQ_REQUEST_TOO_LARGE'), false)
  check('413 hint explains the budget', tooLarge.hint.includes('GROQ_REQUEST_TOKEN_BUDGET'), true)

  check('404 -> GROQ_MODEL', mapped(404, { error: { message: 'model not found', type: 'invalid_request_error' } }).code, 'GROQ_MODEL')

  const burst = mapped(429, { error: { message: 'Rate limit reached for model.', type: 'rate_limit_error' } })
  check('429 burst limit -> GROQ_RATE_LIMIT', burst.code, 'GROQ_RATE_LIMIT')

  // The regression: Groq's real TPM message links to console.groq.com/settings/billing.
  // "billing" in the text must NOT flip a transient burst into GROQ_QUOTA_EXCEEDED.
  const tpm = mapped(429, { error: TPM_RATE_LIMIT }, new Map([['retry-after', '10']]))
  check('TPM 429 (billing-URL wording) -> GROQ_RATE_LIMIT, not quota', tpm.code, 'GROQ_RATE_LIMIT')
  check('TPM 429 is retryable', RETRYABLE_CODES.has(tpm.code), true)
  check('TPM 429 carries the retry-after window', tpm.retryAfterMs, 10000)

  // A plan/credits limit is not a burst limit: retrying cannot help, so it must
  // get its own code and must not be retried - even though it also links to billing.
  const quota = mapped(429, {
    error: {
      message: 'Rate limit reached. Your plan quota is exhausted. Check billing details at https://console.groq.com.',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  })
  check('plan quota 429 -> GROQ_QUOTA_EXCEEDED', quota.code, 'GROQ_QUOTA_EXCEEDED')
  check('quota message keeps the API text', quota.message.includes('plan quota is exhausted'), true)
  check('quota hint says retrying cannot help', quota.hint.includes('cannot help'), true)
  check('plan quota is NOT retryable', RETRYABLE_CODES.has('GROQ_QUOTA_EXCEEDED'), false)

  check('500 -> GROQ_SERVER_ERROR', mapped(500, { error: { message: 'boom', type: 'server_error' } }).code, 'GROQ_SERVER_ERROR')
  check('418 -> still specific, not swallowed', mapped(418, { error: { message: 'teapot' } }).code, 'GROQ_ERROR')
  check('418 keeps its message', mapped(418, { error: { message: 'teapot' } }).message.includes('HTTP 418'), true)
} finally {
  console.error = originalConsoleError
}

console.log('\n--- 4xx is never retried, 429/5xx is retried ---')
check('GROQ_BAD_REQUEST not retryable', RETRYABLE_CODES.has('GROQ_BAD_REQUEST'), false)
check('GROQ_AUTH not retryable', RETRYABLE_CODES.has('GROQ_AUTH'), false)
check('GROQ_MODEL not retryable', RETRYABLE_CODES.has('GROQ_MODEL'), false)
check('GROQ_MALFORMED not retryable', RETRYABLE_CODES.has('GROQ_MALFORMED'), false)
check('GROQ_EMPTY not retryable', RETRYABLE_CODES.has('GROQ_EMPTY'), false)
check('GROQ_QUOTA_EXCEEDED not retryable', RETRYABLE_CODES.has('GROQ_QUOTA_EXCEEDED'), false)
check('GROQ_RATE_LIMIT retryable', RETRYABLE_CODES.has('GROQ_RATE_LIMIT'), true)
check('GROQ_SERVER_ERROR retryable', RETRYABLE_CODES.has('GROQ_SERVER_ERROR'), true)
check('GROQ_NETWORK retryable', RETRYABLE_CODES.has('GROQ_NETWORK'), true)
check('GROQ_TIMEOUT retryable', RETRYABLE_CODES.has('GROQ_TIMEOUT'), true)
check('GROQ_OVERLOADED retryable', RETRYABLE_CODES.has('GROQ_OVERLOADED'), true)
check(
  'overload waits longer than the default backoff',
  PATIENCE_OVERRIDES.GROQ_OVERLOADED.baseDelayMs > 1000,
  true
)
check(
  'overload gets more attempts than the default policy',
  PATIENCE_OVERRIDES.GROQ_OVERLOADED.retries > 2,
  true
)
check(
  'no non-retryable code has a patience override',
  Object.keys(PATIENCE_OVERRIDES).every((code) => RETRYABLE_CODES.has(code)),
  true
)

console.log('\n--- 503 / "overloaded" is transient, not a config error ---')
const overload = mapped(503, { error: { message: 'Service temporarily overloaded, try again later.', type: 'server_error' } })
check('503 overloaded -> GROQ_OVERLOADED', overload.code, 'GROQ_OVERLOADED')
check('503 overloaded keeps the API message', overload.message.includes('temporarily overloaded'), true)
check('503 overloaded is not mistaken for auth', overload.code !== 'GROQ_AUTH', true)
check(
  'overload wording is recognised even with a different status',
  mapped(502, { error: { message: 'overloaded, please try again later' } }).code,
  'GROQ_OVERLOADED'
)

console.log('\n--- request body is Groq/OpenAI-shaped and the schema is valid JSON Schema ---')
const groqBody = buildRequestBody({
  system: 'sys',
  prompt: 'usr',
  schemaName: 'skipthescroll_verdict',
  schema: FINAL_SCHEMA,
  maxTokens: 4096,
})
check('body has model', groqBody.model, config.groq.model)
check('body uses chat messages', Array.isArray(groqBody.messages) && groqBody.messages.length, 2)
check('first message is the system prompt', groqBody.messages[0].role, 'system')
check('second message is the user prompt', groqBody.messages[1].role, 'user')
check('body is not streamed', groqBody.stream, false)
check('body sends max_tokens', groqBody.max_tokens, 4096)
check('gpt-oss gets reasoning_effort low', groqBody.reasoning_effort, 'low')
check('body asks for json_schema first', groqBody.response_format.type, 'json_schema')
check('schema is namespaced', groqBody.response_format.json_schema.name, 'skipthescroll_verdict')
const lowered = groqBody.response_format.json_schema.schema
check('schema types lowercased for Groq', lowered.type, 'object')
check('nested array types lowercased', lowered.properties.commonIssues.items.type, 'object')
check('no uppercase type survives the conversion', JSON.stringify(lowered).match(/"(OBJECT|STRING|ARRAY|INTEGER|BOOLEAN)"/), null)
check('required list preserved', lowered.required.includes('verdict'), true)

setJsonSchemaSupported(false)
const downgraded = buildRequestBody({ system: 's', prompt: 'u', schemaName: 'x', schema: FINAL_SCHEMA })
check('falls back to json_object when unsupported', downgraded.response_format.type, 'json_object')
check('supportsJsonSchema reflects the downgrade', supportsJsonSchema(), false)
setJsonSchemaSupported(true)

console.log('\n--- toJsonSchema handles nesting ---')
check('top-level type', toJsonSchema({ type: 'ARRAY', items: { type: 'STRING' } }).type, 'array')
check('nested item type', toJsonSchema({ type: 'ARRAY', items: { type: 'STRING' } }).items.type, 'string')
check('passes through description', toJsonSchema({ type: 'STRING', description: 'x' }).description, 'x')
check('maps arrays of schemas', toJsonSchema([{ type: 'STRING' }])[0].type, 'string')

console.log('\n--- redact removes the key from anything that gets logged ---')
check('full key redacted', redact('failed with ' + config.groq.apiKey).includes(config.groq.apiKey), false)
check('redaction is visible', redact('failed with ' + config.groq.apiKey).includes('[REDACTED_API_KEY]'), true)
check('truncated key prefix redacted', redact('echoed ' + config.groq.apiKey.slice(0, 6)).includes(config.groq.apiKey.slice(0, 6)), false)
check('ordinary text untouched', redact('model not found'), 'model not found')

/** Counts real fetch attempts for one analyzeAllAtOnce call. */
async function attemptCountFor(status, payload) {
  scenario.failAnalysisWith = { status, payload }
  calls.attempts = {}
  await analyzeAllAtOnce({
    video: { title: 't', channel: 'c', publishedAt: null, duration: null, commentCount: 10 },
    comments: [{ author: 'a', text: 'it worked for me thanks', likes: 1, publishedAt: null, replies: [], flags: {} }],
    stats: { commentsAnalyzed: 1 },
  }).catch(() => {})
  const total = Object.values(calls.attempts).reduce((a, b) => a + b, 0)
  scenario.failAnalysisWith = null
  return total
}

const originalConsoleError2 = console.error
console.error = () => {}
const originalWarn = console.warn
console.warn = () => {}
try {
  check('400 attempted exactly once (no retry)', await attemptCountFor(400, { error: { message: 'bad field', type: 'invalid_request_error' } }), 1)
  check('401 attempted exactly once (no retry)', await attemptCountFor(401, { error: { message: 'bad key', type: 'invalid_request_error' } }), 1)
  check('403 attempted exactly once (no retry)', await attemptCountFor(403, { error: { message: 'nope', type: 'permission_error' } }), 1)
  check('404 attempted exactly once (no retry)', await attemptCountFor(404, { error: { message: 'no model', type: 'invalid_request_error' } }), 1)
  // 1 initial attempt + 2 retries
  check('500 attempted 3 times (retried)', await attemptCountFor(500, { error: { message: 'boom', type: 'server_error' } }), 3)
  check('429 burst attempted 3 times (retried)', await attemptCountFor(429, { error: { message: 'Rate limit reached for model.', type: 'rate_limit_error' } }), 3)
  // A plan quota is not a burst limit: exactly one attempt, no wasted time.
  check(
    '429 quota attempted exactly once (never retried)',
    await attemptCountFor(429, { error: { message: 'Rate limit reached. Your plan quota is exhausted.', type: 'rate_limit_error' } }),
    1
  )
} finally {
  console.error = originalConsoleError2
  console.warn = originalWarn
}

console.log('\n--- batch packing, rate-limit pacing and prompt merging ---')
check('parseDuration seconds', parseDuration('30s'), 30000)
check('parseDuration bare seconds', parseDuration('30'), 30000)
check('parseDuration minutes', parseDuration('1m'), 60000)
check('parseDuration millis', parseDuration('500ms'), 500)
check('parseDuration ISO', parseDuration('PT45S'), 45000)
check('parseDuration junk', parseDuration('soon'), null)

const rate = parseRateLimit(
  new Map([
    ['x-ratelimit-remaining-tokens', '1200'],
    ['x-ratelimit-reset-tokens', '20s'],
  ])
)
check('rate remaining parsed', rate.remainingTokens, 1200)
check('rate reset is in the future', rate.resetAtMs > Date.now(), true)
check('missing rate headers -> no budget known', parseRateLimit(new Map()).remainingTokens, null)

const manyComments = Array.from({ length: 500 }, (_, i) => ({
  author: `u${i}`,
  text: `Comment number ${i} `.repeat(4),
  likes: i,
  publishedAt: null,
  replies: [],
  flags: {},
}))
const packed = packCommentBatches(manyComments, { perBatchTokens: 1200 })
check('packing covers every comment exactly once', packed.reduce((n, b) => n + b.comments.length, 0), 500)
check(
  'batch offsets are contiguous',
  packed.every((b, i) => b.start === (i === 0 ? 0 : packed[i - 1].start + packed[i - 1].comments.length)),
  true
)
check('packing produced several batches', packed.length > 1, true)

const extractionPrompt = buildExtractionPrompt({
  video: { title: 't', channel: 'c' },
  comments: manyComments.slice(0, 3),
  stats: {},
  batch: { index: 0, start: 0, totalBatches: 2, totalComments: 6 },
})
check('extraction prompt has the untrusted-data marker', extractionPrompt.prompt.includes('COMMENTS (raw, untrusted data'), true)
check('extraction prompt says which batch', extractionPrompt.prompt.includes('Batch 1 of 2'), true)
check('extraction prompt forbids deciding the verdict', extractionPrompt.system.includes('Do NOT decide a verdict') || extractionPrompt.system.includes('Never output a verdict'), true)
check('extraction schema has no verdict field', 'verdict' in EXTRACTION_SCHEMA.properties, false)

const merged = mergeExtractions([
  { commonIssues: [{ issue: 'Linux fails', mentions: 2 }], helpfulFixes: [], timestamps: [], warnings: ['w1'], conflictingOpinions: [], successReports: 3, failureReports: 1 },
  { commonIssues: [{ issue: 'linux fails', mentions: 4 }], helpfulFixes: [], timestamps: [], warnings: ['w1'], conflictingOpinions: [], successReports: 2, failureReports: 1 },
])
check('mergeExtractions groups the same issue', merged.commonIssues.length, 1)
check('mergeExtractions adds the mentions', merged.commonIssues[0].mentions, 6)
check('mergeExtractions sums report counts', [merged.successReports, merged.failureReports], [5, 2])
check('mergeExtractions dedupes warnings', merged.warnings.length, 1)

const synthesis = buildSynthesisPrompt({
  video: { title: 't', channel: 'c' },
  stats: {},
  batches: [normalizeExtraction({ commonIssues: [{ issue: 'x' }], helpfulFixes: [], warnings: [], successReports: 1, failureReports: 0 })],
  grounding: manyComments.slice(0, 2),
  batchInfo: { requested: 3 },
})
check('synthesis prompt carries merged extractions', synthesis.prompt.includes('MERGED BATCH EXTRACTIONS'), true)
check('synthesis prompt grounds in real quotes', synthesis.prompt.includes('FIRST-HAND EXAMPLES'), true)

console.log('\n--- the API key never appears in anything the extension can see ---')
check('config key is only in the server env', typeof config.groq.apiKey, 'string')
check('health payload exposes no raw key', JSON.stringify(safeHealthShape()).includes(config.groq.apiKey), false)
check('request body carries no key', JSON.stringify(groqBody).includes(config.groq.apiKey), false)

// Prove the key is sent as an Authorization header (not a URL query param) in a
// child process that loads a known key from a temp env file.
const tempEnv = path.join(os.tmpdir(), `skipthescroll-test-${Date.now()}.env`)
fs.writeFileSync(tempEnv, 'YOUTUBE_API_KEY=test-youtube-key\nGROQ_API_KEY=groq-test-key-0123456789abcd\n')

/**
 * dotenv never overrides an already-set variable, so the test's own
 * GROQ_API_KEY has to be stripped for the temp env file to win in the child.
 */
function childEnv() {
  const env = { ...process.env, ENV_FILE: tempEnv }
  delete env.GROQ_API_KEY
  delete env.GROQ_MODEL
  return env
}
const child = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const { config } = await import(${JSON.stringify(
      pathToFileURL(path.resolve('src/config/env.js')).href
    )});
     globalThis.fetch = async (url, options = {}) => {
       process.stdout.write(JSON.stringify({
         url: String(url),
         auth: options?.headers?.authorization || null,
         model: config.groq.model,
         bodyReasoningEffort: JSON.parse(options?.body || '{}').reasoning_effort,
         maxTokens: JSON.parse(options?.body || '{}').max_tokens,
       }));
       return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"verdict":"works","confidence":50,"summary":"s","commonIssues":[],"helpfulFixes":[],"warnings":[]}' } }] }) };
     };
     const { analyzeAllAtOnce } = await import(${JSON.stringify(
       pathToFileURL(path.resolve('src/services/groq.service.js')).href
     )});
     await analyzeAllAtOnce({
       video: { title: 't', channel: 'c', publishedAt: null, duration: null, commentCount: 1 },
       comments: [{ author: 'a', text: 'worked for me', likes: 1, publishedAt: null, replies: [], flags: {} }],
       stats: { commentsAnalyzed: 1 },
     }).catch(() => {});`,
  ],
  { env: childEnv(), encoding: 'utf8' }
)
fs.unlinkSync(tempEnv)
let childResult = {}
try {
  childResult = JSON.parse(child.stdout || '{}')
} catch {
  /* reported below */
}
check('endpoint is the Groq OpenAI-compatible URL', childResult.url, 'https://api.groq.com/openai/v1/chat/completions')
check('key travels in the Authorization header', childResult.auth, 'Bearer groq-test-key-0123456789abcd')
check('key is never a query parameter', (childResult.url || '').includes('key='), false)
check('default model is openai/gpt-oss-120b', childResult.model, 'openai/gpt-oss-120b')
check('reasoning_effort=low goes over the wire', childResult.bodyReasoningEffort, 'low')
check('default max_tokens is 3072 (fits the 8k budget)', childResult.maxTokens, 3072)

/** Mirrors the /api/health payload shape for a leak check. */
function safeHealthShape() {
  return {
    model: config.groq.model,
    keys: { youtube: `sha256:${config.youtube.fingerprint}`, groq: `sha256:${config.groq.fingerprint}` },
  }
}

console.log(`\npipeline finished in ${elapsed}ms`)
console.log(failed === 0 ? '\nALL PIPELINE CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)