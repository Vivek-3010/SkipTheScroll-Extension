import { config } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { validateVideoId } from '../utils/validateVideoId.js'
import { cleanComments } from '../utils/cleanComments.js'
import { getVideoMetadata, fetchComments, getVideoSummary } from '../services/youtube.service.js'
import { analyzeComments } from '../services/groq.service.js'

const SUCCESS_RE =
  /\b(work(?:ed|ing)?(?:s|ed)? (?:for me|out|perfectly|great|now)|did ?n'?t have to|successfully|solved (?:it|my)|fixed (?:it|my|this)|this (?:video|tutorial|guide|method|fix) (?:worked|is the|helped)|thank you (?:so much|for the fix)|confirmed working|can confirm)\b/i
const FAILURE_RE =
  /\b(did ?n'?t work|did not work|does ?n'?t work|not working|doesn'?t work|failed|failure|error(?:s|ed)?|crash(?:ed|es)?|stuck|can'?t (?:get|get it)|could ?n'?t|broken|still broken|no longer works|stopped working|gave up)\b/i

/* --------------------------- in-memory cache (V1) --------------------------- */

const resultCache = new Map() // videoId -> { expiresAt, data }
const inFlight = new Map() // videoId -> Promise<data>

function readCache(videoId) {
  if (config.cache.ttlMs <= 0) return null
  const entry = resultCache.get(videoId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(videoId)
    return null
  }
  return entry.data
}

function writeCache(videoId, data) {
  if (config.cache.ttlMs <= 0) return
  if (resultCache.size >= config.cache.maxEntries) {
    const oldestKey = resultCache.keys().next().value
    if (oldestKey !== undefined) resultCache.delete(oldestKey)
  }
  resultCache.set(videoId, { expiresAt: Date.now() + config.cache.ttlMs, data })
}

/* --------------------------------- helpers --------------------------------- */

function buildStats({
  video,
  comments,
  cleanStats,
  threadsFetched,
  batchesAnalyzed,
  batchesRequested,
  fetchTruncated = false,
}) {
  let successSignals = 0
  let failureSignals = 0
  let replyComments = 0
  let oldestCommentAt = null
  let newestCommentAt = null

  for (const comment of comments) {
    const all = [comment.text, ...comment.replies.map((r) => r.text)].filter(Boolean)
    for (const text of all) {
      if (SUCCESS_RE.test(text)) successSignals += 1
      if (FAILURE_RE.test(text)) failureSignals += 1
    }
    replyComments += comment.replies.length

    for (const iso of [comment.publishedAt, ...comment.replies.map((r) => r.publishedAt)]) {
      if (!iso) continue
      if (!oldestCommentAt || iso < oldestCommentAt) oldestCommentAt = iso
      if (!newestCommentAt || iso > newestCommentAt) newestCommentAt = iso
    }
  }

  return {
    commentCountOnYouTube: video.commentCount ?? 0,
    threadsFetched,
    commentsAnalyzed: comments.length,
    repliesAnalyzed: replyComments,
    droppedTotal: cleanStats.dropped + cleanStats.duplicates + cleanStats.spam,
    duplicates: cleanStats.duplicates,
    spamOrPromotional: cleanStats.spam,
    tooShortOrEmpty: cleanStats.dropped,
    maxLikes: cleanStats.maxLikes,
    withReplies: cleanStats.withReplies,
    replyComments,
    successSignals,
    failureSignals,
    oldestCommentAt,
    newestCommentAt,
    batchesAnalyzed,
    batchesRequested,
    batchSize: comments.length,
    fetchLimit: config.comments.max,
    // Only true when YouTube had MORE threads than the fetch cap allowed. It is
    // NOT set just because YouTube's comment count includes replies or because
    // short/spam comments were dropped - those are reported separately.
    truncated: fetchTruncated,
    failedBatches: 0,
    aiCalls: 0,
    analysisMode: batchesAnalyzed === 1 ? 'single-pass' : null,
  }
}

/**
 * Rule-based fallback used when there is nothing worth sending to the AI
 * (no comments / all spam). Never invents a conclusion.
 */
function buildInsufficientAnalysis(stats, reason, verdict = 'insufficient evidence') {
  return {
    verdict,
    doesItWork: 'Not enough evidence',
    confidence: 0,
    confidenceReason: reason,
    summary: `${reason} Treat this as "unknown", not as "good".`,
    commonIssues: [],
    helpfulFixes: [],
    timestamps: [],
    status: 'Unknown',
    warnings: [],
    conflictingOpinions: [],
    evidenceGaps: [
      reason,
      stats.commentCountOnYouTube === 0
        ? 'This video has no comments at all.'
        : `Only ${stats.commentsAnalyzed} usable comment(s) out of ${stats.commentCountOnYouTube} were available.`,
    ],
    successReports: 0,
    failureReports: 0,
  }
}

/* -------------------------------- pipeline -------------------------------- */

async function runPipeline(videoId) {
  const startedAt = Date.now()

  // 1. Metadata (title, channel, thumbnail, total comment count)
  const video = await getVideoMetadata(videoId)
  if (video.commentCount === 0) {
    const stats = buildStats({
      video,
      comments: [],
      cleanStats: { dropped: 0, duplicates: 0, spam: 0, maxLikes: 0, withReplies: 0 },
      threadsFetched: 0,
      batchesAnalyzed: 0,
      batchesRequested: 0,
    })
    return {
      video,
      analysis: buildInsufficientAnalysis(
        stats,
        'Comments are turned off for this video, so there is no community evidence to analyse.'
      ),
      stats,
      source: 'rule-based',
      tookMs: Date.now() - startedAt,
    }
  }

  // 2. Comments (fetched up to MAX_COMMENTS threads; the AI layer batches them)
  const { threads, truncated } = await fetchComments(videoId, { maxComments: config.comments.max })
  if (threads.length === 0) {
    const stats = buildStats({
      video,
      comments: [],
      cleanStats: { dropped: 0, duplicates: 0, spam: 0, maxLikes: 0, withReplies: 0 },
      threadsFetched: 0,
      batchesAnalyzed: 0,
      batchesRequested: 0,
    })
    return {
      video,
      analysis: buildInsufficientAnalysis(
        stats,
        'No readable comments were returned by the YouTube API for this video.'
      ),
      stats,
      source: 'rule-based',
      tookMs: Date.now() - startedAt,
    }
  }

  // 3. Clean / normalise
  const { comments, stats: cleanStats } = cleanComments(threads, {
    maxComments: config.comments.max,
    maxReplies: config.comments.maxRepliesPerThread,
  })

  if (comments.length === 0) {
    const stats = buildStats({
      video,
      comments: [],
      cleanStats,
      threadsFetched: threads.length,
      batchesAnalyzed: 0,
      batchesRequested: 0,
      fetchTruncated: truncated,
    })
    return {
      video,
      analysis: buildInsufficientAnalysis(
        stats,
        'Every fetched comment was empty, duplicated, too short or spam, so there was nothing usable to analyse.'
      ),
      stats,
      source: 'rule-based',
      tookMs: Date.now() - startedAt,
    }
  }

  // 4. Every cleaned comment is analysed. When the set does not fit one Groq
  //    request the service splits it into paced batches (see groq.service.js),
  //    so commentsAnalyzed is no longer capped by the AI token budget.
  const stats = buildStats({
    video,
    comments,
    cleanStats,
    threadsFetched: threads.length,
    batchesAnalyzed: 0,
    batchesRequested: 0,
    fetchTruncated: truncated,
  })

  // 5. AI analysis: one call when everything fits, batched extraction + a
  //    synthesis call otherwise. Transient failures (429 burst, 5xx, network)
  //    are retried inside the service - waits that respect a 429's retry-after
  //    window. Whatever still fails on the very first call is a real problem
  //    (bad key, wrong model, quota, malformed reply) and must surface as-is
  //    instead of being hidden behind a generic "AI failed".
  let result
  try {
    result = await analyzeComments({ video, comments, stats })
  } catch (err) {
    console.warn(`[skipthescroll] AI analysis failed: code=${err.code} status=${err.status} ${err.message}`)
    throw err
  }

  const { analysis, batches } = result
  const source = 'groq'

  // Report exactly what was covered: how many comments the model actually read
  // and how many batches failed, never hiding a partial run.
  stats.batchesAnalyzed = batches.analyzed
  stats.batchesRequested = batches.requested
  stats.failedBatches = batches.failed
  stats.aiCalls = batches.aiCalls
  stats.analysisMode = batches.singlePass ? 'single-pass' : 'batched'
  stats.batchSize = batches.singlePass ? comments.length : batches.maxSize
  if (batches.analyzedComments < comments.length) {
    stats.commentsAnalyzed = batches.analyzedComments
  }

  // 6. Make hard limits visible instead of hiding them.
  const evidenceGaps = [...analysis.evidenceGaps]
  if (stats.truncated) {
    evidenceGaps.push(
      `Only the top ${stats.threadsFetched} of the ${stats.commentCountOnYouTube} comments on YouTube ` +
        `were fetched and analysed (fetch limit: ${config.comments.max}). Rare minority experiences may be missing.`
    )
  }
  if (stats.failedBatches > 0) {
    evidenceGaps.push(
      `${stats.failedBatches} of ${stats.batchesRequested} comment batches could not be analysed ` +
        '(AI rate limit / temporary failure), so the verdict rests on the rest of the comments. Re-run in a few minutes.'
    )
  }
  if (stats.commentsAnalyzed < 20) {
    evidenceGaps.push(`Only ${stats.commentsAnalyzed} usable comments were available, which limits how strong any verdict can be.`)
  }

  return {
    video,
    analysis: { ...analysis, evidenceGaps },
    stats,
    source,
    tookMs: Date.now() - startedAt,
  }
}

/* ------------------------------- controllers ------------------------------- */

/** GET /api/video?videoId=... - lightweight info for the popup before analysing. */
export async function getVideoInfo(req, res, next) {
  try {
    const videoId = validateVideoId(req.query.videoId ?? req.query.url)
    const { video, commentsEnabled } = await getVideoSummary(videoId)
    res.json({ ok: true, data: { video, commentsEnabled } })
  } catch (err) {
    next(err)
  }
}

/** POST /api/analyze - the main pipeline. */
export async function analyze(req, res, next) {
  try {
    const videoId = validateVideoId(req.body?.videoId)

    const cached = readCache(videoId)
    if (cached) {
      res.set('X-SkipTheScroll-Cache', 'HIT')
      return res.json({ ok: true, data: cached, cached: true })
    }

    // De-duplicate concurrent clicks for the same video (saves quota).
    if (inFlight.has(videoId)) {
      const data = await inFlight.get(videoId)
      res.set('X-SkipTheScroll-Cache', 'INFLIGHT')
      return res.json({ ok: true, data, cached: true })
    }

    const promise = runPipeline(videoId)
      .then((data) => {
        const payload = {
          video: data.video,
          analysis: data.analysis,
          stats: data.stats,
          meta: {
            source: data.source,
            tookMs: data.tookMs ?? Date.now(),
            // rule-based ("no comments / all spam") means the model was not used.
            model: data.source.startsWith('groq') ? config.groq.model : null,
            commentCap: config.comments.max,
            aiCalls: data.stats?.aiCalls ?? 0,
            analysisMode: data.stats?.analysisMode ?? (data.source.startsWith('groq') ? 'single-pass' : 'rule-based'),
            analyzedAt: new Date().toISOString(),
          },
        }
        writeCache(videoId, payload)
        return payload
      })
      .finally(() => inFlight.delete(videoId))

    inFlight.set(videoId, promise)

    const data = await promise
    return res.json({ ok: true, data, cached: false })
  } catch (err) {
    return next(err)
  }
}
