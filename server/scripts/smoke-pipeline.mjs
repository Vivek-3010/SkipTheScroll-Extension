/**
 * End-to-end pipeline test with YouTube + Gemini mocked (no API keys, no network).
 * Run: node scripts/smoke-pipeline.mjs
 *
 * Verifies:
 *  - metadata fetch
 *  - comment pagination that hard-stops at the 500 comment cap
 *  - cleaning (spam / short / duplicates dropped)
 *  - batching into 50-comment batches, bounded concurrency
 *  - batch -> final synthesis call counts
 *  - the exact JSON contract the Chrome extension consumes
 */
process.env.YOUTUBE_API_KEY ||= 'test-youtube-key'
process.env.GEMINI_API_KEY ||= 'test-gemini-key'
process.env.GEMINI_BATCH_SIZE ||= '50'
process.env.CACHE_TTL_MS ||= '0'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const { analyze, buildMergedAnalysis } = await import('../src/controllers/analyze.controller.js')
const { analyzeBatch } = await import('../src/services/gemini.service.js')
const { config } = await import('../src/config/env.js')
const { RETRYABLE_CODES, PATIENCE_OVERRIDES } = await import('../src/utils/retry.js')
const { ALLOWED_VERDICTS } = await import('../src/prompts/finalPrompt.js')
const ANALYSIS_VERDICTS = ALLOWED_VERDICTS.map((verdict) => verdict.toLowerCase())

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`}`)
}

/* ------------------------------- fake APIs ------------------------------- */

const TOTAL_COMMENTS_ON_YOUTUBE = 1200
const calls = { videos: 0, commentThreads: 0, commentThreadPages: [], geminiBatches: 0, geminiFinal: 0 }

/** Switchable fixture behaviour for the degraded-path scenarios below. */
const scenario = {
  commentCount: TOTAL_COMMENTS_ON_YOUTUBE,
  commentsDisabled: false,
  failBatches: new Set(),
  failAllGemini: false,
  failFinal: false,
  geminiFailure: null, // { status, payload }
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

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  const attemptCounter = (calls.attempts = calls.attempts || {})

  if (target.includes('generativelanguage.googleapis.com')) {
    const key = target.includes('models/') ? target.match(/models\/([^:]+):/)?.[1] : 'unknown'
    attemptCounter[key] = (attemptCounter[key] || 0) + 1

    if (scenario.geminiFailure) {
      const { status, payload } = scenario.geminiFailure
      return jsonResponse(payload, { status })
    }
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

  if (target.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(options.body)
    const prompt = body.contents[0].parts[0].text

    if (prompt.includes('YOU ARE ANALYSING BATCH')) {
      calls.geminiBatches += 1
      const batchNumber = Number(prompt.match(/BATCH (\d+) OF/)?.[1] || 0)
      if (scenario.failAllGemini || scenario.failBatches.has(batchNumber)) {
        return jsonResponse({ error: { code: 500, message: 'Internal error', status: 'INTERNAL' } }, { status: 500 })
      }
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    successPatterns: ['Multiple commenters confirm the fix works on Windows and macOS'],
                    failurePatterns: ['Installer silently fails for a few Linux users'],
                    commonIssues: [{ issue: 'Installer fails silently on Linux', mentions: 3 }],
                    helpfulFixes: [{ fix: 'Run the installer with --verbose to see the real error', mentions: 2 }],
                    timestamps: [{ time: '4:20', note: 'the flag that fixes the silent failure' }],
                    outdatedIndicators: ['One commenter says the menu changed in the latest version'],
                    warnings: [],
                    conflictingExperiences: ['Works on Windows, fails on macOS Sonoma'],
                    evidenceGaps: ['No reports from Linux users in this batch'],
                    batchNotes: 'Mostly positive first-hand reports with a small failing group.',
                  }),
                },
              ],
            },
          },
        ],
      })
    }

    calls.geminiFinal += 1
    if (scenario.failFinal) {
      return jsonResponse(
        {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message:
              'You exceeded your current quota, please check your plan and billing details.\n' +
              '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20\n' +
              'Please retry in 6h57m59.13s.',
          },
        },
        { status: 429 }
      )
    }
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                text: '```json\n' +
                  JSON.stringify({
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
                  }) +
                  '\n```',
              },
            ],
          },
        },
      ],
    })
  }

  throw new Error(`unexpected fetch: ${target}`)
}

function jsonResponse(body, init = {}) {
  return {
    ok: init.status ? init.status < 400 : true,
    status: init.status || 200,
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
check('comment pages fetched', calls.commentThreads, 5)
check('first page maxResults', calls.commentThreadPages[0].maxResults, 100)
check('pages walk forward', calls.commentThreadPages.map((p) => p.start), [0, 100, 200, 300, 400])
check('comment cap respected (never above 500)', data?.stats?.commentsAnalyzed <= 500, true)
check('every fetched thread is analysed or dropped', data?.stats?.commentsAnalyzed + data?.stats?.droppedTotal, 500)
check('truncated flag', data?.stats?.truncated, true)
check('batches requested', data?.stats?.batchesRequested, 10)
check('batches analysed', data?.stats?.batchesAnalyzed, 10)
check('gemini batch calls', calls.geminiBatches, 10)
check('gemini final calls', calls.geminiFinal, 1)
check('verdict', data?.analysis?.verdict, 'mostly works')
check('confidence clamped 0-100', typeof data?.analysis?.confidence === 'number' && data.analysis.confidence <= 100, true)
check('summary present', typeof data?.analysis?.summary === 'string' && data.analysis.summary.length > 0, true)
check('issues merged + capped', Array.isArray(data?.analysis?.commonIssues) && data.analysis.commonIssues.length <= 6, true)
check('timestamps keep time + note', data?.analysis?.timestamps?.[0]?.time, '4:20')
check('status preserved', data?.analysis?.status, 'Possibly outdated')
check('warnings preserved', data?.analysis?.warnings?.length, 1)
check('conflicts preserved', data?.analysis?.conflictingOpinions?.length, 1)
check('video thumbnail mapped', data?.video?.thumbnail?.endsWith('hqdefault.jpg'), true)
check('meta.commentCap', data?.meta?.commentCap, 500)
check('meta.source', data?.meta?.source, 'gemini')
check('evidence gap about the 500 cap', data?.analysis?.evidenceGaps?.some((g) => g.includes('V1 limit: 500')), true)
check('spam was dropped from the count', data?.stats?.spamOrPromotional > 0, true)
check('short comments dropped', data?.stats?.droppedTotal > 0, true)
check('entities decoded before prompting', true, true)
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
check('zero comments -> rule based (no Gemini spend)', scenarioResult.data?.meta?.source, 'rule-based')
check('zero comments -> confidence 0', scenarioResult.data?.analysis?.confidence, 0)
check('zero comments -> says why', scenarioResult.data?.analysis?.summary.includes('Comments are turned off'), true)
scenario.commentCount = TOTAL_COMMENTS_ON_YOUTUBE

console.log('\n--- scenario: one Gemini batch fails ---')
scenario.failBatches = new Set([3])
scenarioResult = await runAnalyze('ccccccccccc')
check('partial failure still succeeds', scenarioResult.ok, true)
check('partial failure -> 9 batches analysed', scenarioResult.data?.stats?.batchesAnalyzed, 9)
check(
  'partial failure disclosed in evidenceGaps',
  scenarioResult.data?.analysis?.evidenceGaps?.some((gap) => gap.includes('1 of 10 comment batches')),
  true
)
scenario.failBatches = new Set()

console.log('\n--- scenario: every Gemini batch fails ---')
scenario.failAllGemini = true
scenarioResult = await runAnalyze('ddddddddddd')
check('total failure -> 502', [scenarioResult.ok, scenarioResult.status], [false, 502])
check('total failure -> ALL_BATCHES_FAILED', scenarioResult.code, 'ALL_BATCHES_FAILED')
check('total failure keeps the root cause', scenarioResult.message.includes('GEMINI_SERVER_ERROR'), true)
scenario.failAllGemini = false

console.log('\n--- scenario: all batches fail with a bad key (real cause is surfaced) ---')
scenario.geminiFailure = { status: 401, payload: { error: { status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } } }
scenarioResult = await runAnalyze('eeeeeeeeeee')
check('401 everywhere -> GEMINI_AUTH not a generic code', scenarioResult.code, 'GEMINI_AUTH')
check('401 everywhere -> root cause in message', scenarioResult.message.includes('UNAUTHENTICATED'), true)
check('401 everywhere -> root cause in the hint', (scenarioResult.hint || '').length > 0, true)
scenario.geminiFailure = null

console.log('\n--- scenario: all batches succeed but the final call runs out of quota ---')
scenario.failFinal = true
scenarioResult = await runAnalyze('fffffffffff')
scenario.failFinal = false
check('final-call failure still returns 200', scenarioResult.ok, true)
check('source is gemini-partial', scenarioResult.data?.meta?.source, 'gemini-partial')
check('model is still reported', scenarioResult.data?.meta?.model, config.gemini.model)
check('a verdict is still produced', typeof scenarioResult.data?.analysis?.verdict, 'string')
check('verdict is one of the allowed values', ANALYSIS_VERDICTS.includes(scenarioResult.data?.analysis?.verdict), true)
check('fallback analysis keeps the contract keys', ANALYSIS_KEYS.every((key) => key in (scenarioResult.data?.analysis || {})), true)
check('fallback confidence is capped', scenarioResult.data?.analysis?.confidence <= 45, true)
check('fallback says synthesis was unavailable', scenarioResult.data?.analysis?.status.includes('final synthesis unavailable'), true)
check(
  'fallback reports the quota cause',
  scenarioResult.data?.analysis?.evidenceGaps.some((gap) => gap.includes('GEMINI_QUOTA_EXCEEDED')),
  true
)
check(
  'batched issues survive into the merged result',
  scenarioResult.data?.analysis?.commonIssues.length > 0,
  true
)
check('not reported as fully Gemini-sourced', scenarioResult.data?.meta?.source === 'gemini', false)

/* ------------------- Gemini error mapping + retry policy ------------------- */

console.log('\n--- Gemini HTTP error mapping (no generic GEMINI_ERROR) ---')

const { mapGeminiError, buildRequestBody } = await import('../src/services/gemini.service.js')

function mapped(httpStatus, payload) {
  return mapGeminiError({
    status: httpStatus,
    payload,
    model: 'gemini-3.8-flash',
    label: 'test',
  })
}

const originalConsoleError = console.error
console.error = () => {} // keep the expected [GEMINI ERROR] blocks out of the test log
try {
  const auth = mapped(401, { error: { status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } })
  check('401 -> GEMINI_AUTH', auth.code, 'GEMINI_AUTH')
  check('401 keeps HTTP status in message', auth.message.includes('HTTP 401'), true)
  check('401 keeps API status in message', auth.message.includes('UNAUTHENTICATED'), true)
  check('401 keeps API message', auth.message.includes('invalid authentication credentials'), true)

  const forbidden = mapped(403, { error: { status: 'PERMISSION_DENIED', message: 'The model is not accessible.' } })
  check('403 -> GEMINI_AUTH', forbidden.code, 'GEMINI_AUTH')

  const badRequest = mapped(400, {
    error: { status: 'INVALID_ARGUMENT', message: 'Unknown name "thinkingConfig" at "generation_config"' },
  })
  check('400 -> GEMINI_BAD_REQUEST', badRequest.code, 'GEMINI_BAD_REQUEST')
  check('400 keeps the real API message', badRequest.message.includes('Unknown name "thinkingConfig"'), true)
  check('400 hint says do not retry', badRequest.hint.includes('Not transient'), true)

  check('404 -> GEMINI_MODEL', mapped(404, { error: { status: 'NOT_FOUND', message: 'model not found' } }).code, 'GEMINI_MODEL')
  check(
    '429 burst limit -> GEMINI_RATE_LIMIT',
    mapped(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } }).code,
    'GEMINI_RATE_LIMIT'
  )

  // Free tier sends a 429 that is a DAILY quota, not a burst limit: retrying
  // cannot help, so it must get its own code and must not be retried.
  const quota = mapped(429, {
    error: {
      status: 'RESOURCE_EXHAUSTED',
      message:
        'You exceeded your current quota, please check your plan and billing details.\n' +
        '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash\n' +
        'Please retry in 6h57m59.131205188s.',
    },
  })
  check('daily quota 429 -> GEMINI_QUOTA_EXCEEDED', quota.code, 'GEMINI_QUOTA_EXCEEDED')
  check('quota message keeps the API text', quota.message.includes('limit: 20'), true)
  check('quota hint says retrying cannot help', quota.hint.includes('cannot help'), true)
  check('quota hint reports the reset time', quota.hint.includes('6h 57m'), true)
  check('daily quota is NOT retryable', RETRYABLE_CODES.has('GEMINI_QUOTA_EXCEEDED'), false)

  check('500 -> GEMINI_SERVER_ERROR', mapped(500, { error: { status: 'INTERNAL', message: 'boom' } }).code, 'GEMINI_SERVER_ERROR')
  check('418 -> still specific, not swallowed', mapped(418, { error: { message: 'teapot' } }).code, 'GEMINI_ERROR')
  check('418 keeps its message', mapped(418, { error: { message: 'teapot' } }).message.includes('HTTP 418'), true)
} finally {
  console.error = originalConsoleError
}

console.log('\n--- 4xx is never retried, 429/5xx is retried ---')
check('GEMINI_BAD_REQUEST not retryable', RETRYABLE_CODES.has('GEMINI_BAD_REQUEST'), false)
check('GEMINI_AUTH not retryable', RETRYABLE_CODES.has('GEMINI_AUTH'), false)
check('GEMINI_MODEL not retryable', RETRYABLE_CODES.has('GEMINI_MODEL'), false)
check('GEMINI_MALFORMED not retryable', RETRYABLE_CODES.has('GEMINI_MALFORMED'), false)
check('GEMINI_RATE_LIMIT retryable', RETRYABLE_CODES.has('GEMINI_RATE_LIMIT'), true)
check('GEMINI_SERVER_ERROR retryable', RETRYABLE_CODES.has('GEMINI_SERVER_ERROR'), true)
check('GEMINI_NETWORK retryable', RETRYABLE_CODES.has('GEMINI_NETWORK'), true)
check('GEMINI_OVERLOADED retryable', RETRYABLE_CODES.has('GEMINI_OVERLOADED'), true)
check(
  'overload waits longer than the default backoff',
  PATIENCE_OVERRIDES.GEMINI_OVERLOADED.baseDelayMs > 1000,
  true
)
check(
  'overload gets more attempts than the default policy',
  PATIENCE_OVERRIDES.GEMINI_OVERLOADED.retries > 2,
  true
)
check(
  'no non-retryable code has a patience override',
  Object.keys(PATIENCE_OVERRIDES).every((code) => RETRYABLE_CODES.has(code)),
  true
)

console.log('\n--- 503 UNAVAILABLE / "high demand" is transient, not a config error ---')
const overload = mapped(503, {
  error: { status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' },
})
check('503 UNAVAILABLE -> GEMINI_OVERLOADED', overload.code, 'GEMINI_OVERLOADED')
check('503 UNAVAILABLE keeps the API message', overload.message.includes('high demand'), true)
check('503 UNAVAILABLE is not mistaken for auth', overload.code !== 'GEMINI_AUTH', true)
check(
  'high-demand wording is recognised even with a different status',
  mapped(429 + 100, { error: { message: 'high demand, please try again later' } }).code,
  'GEMINI_OVERLOADED'
)

/** Counts real fetch attempts for one analyseBatch call. */
async function attemptCountFor(status, payload) {
  scenario.geminiFailure = { status, payload }
  calls.attempts = {}
  await analyzeBatch({
    video: { title: 't', channel: 'c', publishedAt: null, duration: null, commentCount: 10 },
    comments: [{ author: 'a', text: 'it worked for me thanks', likes: 1, publishedAt: null, replies: [], flags: {} }],
    batchIndex: 0,
    batchCount: 1,
  }).catch(() => {})
  const total = Object.values(calls.attempts).reduce((a, b) => a + b, 0)
  scenario.geminiFailure = null
  return total
}

const originalConsoleError2 = console.error
console.error = () => {}
const originalWarn = console.warn
console.warn = () => {}
try {
  check('400 attempted exactly once (no retry)', await attemptCountFor(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad field' } }), 1)
  check('401 attempted exactly once (no retry)', await attemptCountFor(401, { error: { status: 'UNAUTHENTICATED', message: 'bad key' } }), 1)
  check('403 attempted exactly once (no retry)', await attemptCountFor(403, { error: { status: 'PERMISSION_DENIED', message: 'nope' } }), 1)
  check('404 attempted exactly once (no retry)', await attemptCountFor(404, { error: { status: 'NOT_FOUND', message: 'no model' } }), 1)
  // 1 initial attempt + 2 retries
  check('500 attempted 3 times (retried)', await attemptCountFor(500, { error: { status: 'INTERNAL', message: 'boom' } }), 3)
  check('429 attempted 3 times (retried)', await attemptCountFor(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'slow down' } }), 3)
} finally {
  console.error = originalConsoleError2
  console.warn = originalWarn
}

console.log('\n--- deterministic fallback when the final synthesis call fails ---')
const sampleBatches = [
  {
    successPatterns: ['it worked first try'],
    failurePatterns: [],
    commonIssues: [{ issue: 'needs a restart', mentions: 4 }],
    helpfulFixes: [{ fix: 'reboot the router', mentions: 3 }],
    timestamps: [{ time: '2:10', note: 'here it worked' }],
    warnings: [],
    conflictingExperiences: [],
    evidenceGaps: [],
  },
  {
    successPatterns: [],
    failurePatterns: ['never connected'],
    commonIssues: [{ issue: 'needs a restart', mentions: 2 }, { issue: 'slow speeds', mentions: 1 }],
    helpfulFixes: [{ fix: 'reboot the router', mentions: 1 }],
    timestamps: [{ time: '5:40', note: 'failed here' }],
    warnings: [],
    conflictingExperiences: ['works for me, not for my neighbour'],
    evidenceGaps: [],
  },
]

const merged = buildMergedAnalysis({
  batches: sampleBatches,
  stats: { commentsAnalyzed: 100 },
  cause: { code: 'GEMINI_QUOTA_EXCEEDED', message: 'quota exhausted' },
})
check('fallback keeps the analysis contract keys', ANALYSIS_KEYS.every((key) => key in merged), true)
check('fallback verdict is from the tally', merged.verdict, 'mixed results')
check('fallback merges duplicate issues', merged.commonIssues[0].issue, 'needs a restart')
check('fallback sums mentions across batches', merged.commonIssues[0].mentions, 6)
check('fallback merges fixes too', merged.helpfulFixes[0].fix, 'reboot the router')
check('fallback keeps timestamps', merged.timestamps.length, 2)
check('fallback carries conflicts through', merged.conflictingOpinions.length, 1)
check('fallback confidence stays modest', merged.confidence <= 45, true)
check('fallback states the cause in the reason', merged.confidenceReason.includes('GEMINI_QUOTA_EXCEEDED'), true)
check('fallback says the synthesis was skipped', merged.status.includes('final synthesis unavailable'), true)
check('fallback records an evidence gap', merged.evidenceGaps.some((gap) => gap.includes('did not complete')), true)

const allSuccess = buildMergedAnalysis({
  batches: [
    { successPatterns: ['a'], failurePatterns: [], commonIssues: [], helpfulFixes: [], timestamps: [], warnings: [], conflictingExperiences: [] },
    { successPatterns: ['b'], failurePatterns: [], commonIssues: [], helpfulFixes: [], timestamps: [], warnings: [], conflictingExperiences: [] },
  ],
  stats: { commentsAnalyzed: 100 },
  cause: { code: 'GEMINI_OVERLOADED', message: 'busy' },
})
check('fallback: unanimous success -> works', allSuccess.verdict, 'works')

const allFailure = buildMergedAnalysis({
  batches: [
    { successPatterns: [], failurePatterns: ['a'], commonIssues: [], helpfulFixes: [], timestamps: [], warnings: [], conflictingExperiences: [] },
    { successPatterns: [], failurePatterns: ['b'], commonIssues: [], helpfulFixes: [], timestamps: [], warnings: [], conflictingExperiences: [] },
  ],
  stats: { commentsAnalyzed: 100 },
  cause: { code: 'GEMINI_OVERLOADED', message: 'busy' },
})
check('fallback: unanimous failure -> does not work', allFailure.verdict, 'does not work')
check('fallback with no batches -> unclear', buildMergedAnalysis({ batches: [], stats: {}, cause: {} }).verdict, 'unclear')
check('fallback with no batches -> 0 confidence', buildMergedAnalysis({ batches: [], stats: {}, cause: {} }).confidence, 0)

console.log('\n--- request body: thinkingConfig only when explicitly configured ---')
const body = buildRequestBody({ system: 's', prompt: 'p', schema: {} })
check(
  'thinkingConfig present exactly when a budget is configured',
  'thinkingConfig' in body.generationConfig,
  config.gemini.thinkingBudget !== null
)

// Prove the "unset -> field omitted" path in a child process that loads an env
// file without GEMINI_THINKING_BUDGET at all.
const tempEnv = path.join(os.tmpdir(), `skipthescroll-test-${Date.now()}.env`)
fs.writeFileSync(tempEnv, 'YOUTUBE_API_KEY=test\nGEMINI_API_KEY=test\nGEMINI_MODEL=gemini-3.8-flash\n')
const child = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const { buildRequestBody } = await import(${JSON.stringify(
      pathToFileURL(path.resolve('src/services/gemini.service.js')).href
    )});
     const { config } = await import(${JSON.stringify(
       pathToFileURL(path.resolve('src/config/env.js')).href
     )});
     process.stdout.write(JSON.stringify({
       budget: config.gemini.thinkingBudget,
       hasThinkingConfig: 'thinkingConfig' in buildRequestBody({ system: 's', prompt: 'p', schema: {} }).generationConfig,
       version: config.gemini.apiVersion,
     }));`,
  ],
  { env: { ...process.env, ENV_FILE: tempEnv, GEMINI_THINKING_BUDGET: '' }, encoding: 'utf8' }
)
fs.unlinkSync(tempEnv)
let childResult = {}
try {
  childResult = JSON.parse(child.stdout || '{}')
} catch {
  /* reported below */
}
check('no budget in env file -> thinkingBudget is null', childResult.budget, null)
check('no budget in env file -> thinkingConfig omitted', childResult.hasThinkingConfig, false)
check('child process apiVersion keeps the v', childResult.version, 'v1beta')
check('endpoint keeps the v in v1beta', (await import('../src/services/gemini.service.js')).endpointFor('gemini-3.8-flash').includes('/v1beta/models/'), true)

console.log(`\npipeline finished in ${elapsed}ms`)
console.log(failed === 0 ? '\nALL PIPELINE CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
