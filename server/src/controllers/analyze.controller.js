import { config } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { validateVideoId } from '../utils/validateVideoId.js'
import { cleanComments } from '../utils/cleanComments.js'
import { chunk, mapWithConcurrency } from '../utils/arrays.js'
import { getVideoMetadata, fetchComments, getVideoSummary } from '../services/youtube.service.js'
import { analyzeBatch, synthesizeFinalAnalysis } from '../services/gemini.service.js'

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

function buildStats({ video, comments, cleanStats, threadsFetched, batchesAnalyzed, batchesRequested }) {
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
    droppedTotal: cleanStats.dropped + cleanStats.duplicates + cleanStats.spam,
    duplicates: cleanStats.duplicates,
    spamOrPromotional: cleanStats.spam,
    maxLikes: cleanStats.maxLikes,
    withReplies: cleanStats.withReplies,
    replyComments,
    successSignals,
    failureSignals,
    oldestCommentAt,
    newestCommentAt,
    batchesAnalyzed,
    batchesRequested,
    truncated: Boolean(video.commentCount && video.commentCount > comments.length),
    batchSize: config.gemini.batchSize,
  }
}

/**
 * Rule-based fallback used when there is nothing worth sending to Gemini
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

  // 2. Comments (hard capped at 500 threads)
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

  // 4. Batch analysis (parallel, bounded)
  const batches = chunk(comments, config.gemini.batchSize)
  const failedBatches = []

  const results = await mapWithConcurrency(
    batches,
    config.gemini.concurrency,
    async (batch, index) => analyzeBatch({ video, comments: batch, batchIndex: index, batchCount: batches.length }),
    (err, index) => {
      console.warn(
        `[skipthescroll] batch ${index + 1}/${batches.length} failed: code=${err.code} status=${err.status} ${err.message}`
      )
      failedBatches.push({ index: index + 1, code: err.code || 'BATCH_FAILED', err })
    }
  )

  const usable = results.filter(Boolean)
  if (usable.length === 0) {
    // Surface the real reason (bad key, wrong model, bad request...) instead of
    // a generic "Gemini failed" - the batch errors are far more actionable.
    const cause = failedBatches[0]?.err
    const causeCode = cause?.code && cause.code !== 'GEMINI_SERVER_ERROR' && cause.code !== 'GEMINI_NETWORK'
      ? cause.code
      : 'ALL_BATCHES_FAILED'

    throw new ApiError(
      cause?.status && cause.status < 500 ? cause.status : 502,
      causeCode,
      `Gemini could not analyse any of the ${batches.length} comment batches. Root cause [${
        cause?.code || 'unknown'
      }]: ${cause?.message || 'unknown error'}`,
      cause?.hint || 'Run "npm run check:gemini" inside server/ for a full Gemini diagnostic.'
    )
  }

  // 5. Final synthesis. If this single call fails (quota exhausted, overload,
  //    timeout) the batch work is still valuable, so we fall back to a
  //    deterministic merge of the batch findings rather than throwing away a
  //    full analysis of up to 500 comments.
  const stats = buildStats({
    video,
    comments,
    cleanStats,
    threadsFetched: threads.length,
    batchesAnalyzed: usable.length,
    batchesRequested: batches.length,
  })
  stats.truncated = truncated || stats.truncated

  let analysis
  let source = 'gemini'
  try {
    analysis = await synthesizeFinalAnalysis({ video, batches: usable, stats })
  } catch (err) {
    const cause = failedBatches[0]?.err || err
    console.warn(
      `[skipthescroll] final synthesis failed (${err.code || err.message}); ` +
        'falling back to a deterministic merge of the per-batch findings.'
    )
    analysis = buildMergedAnalysis({ batches: usable, stats, cause })
    source = 'gemini-partial'
  }

  // 6. Make partial failures and hard limits visible instead of hiding them.
  const evidenceGaps = [...analysis.evidenceGaps]
  if (failedBatches.length) {
    evidenceGaps.push(
      `${failedBatches.length} of ${batches.length} comment batches could not be analysed, so some evidence is missing.`
    )
  }
  if (stats.truncated) {
    evidenceGaps.push(
      `Only the top ${stats.commentsAnalyzed} of ${stats.commentCountOnYouTube} comments were analysed (V1 limit: 500). Rare minority experiences may be missing.`
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

/* ------------------------ deterministic fallback ------------------------ */

/** Merges `{ issue, mentions }` items from every batch, most mentioned first. */
function mergeMentioned(batches, key, limit) {
  const totals = new Map()
  for (const batch of batches) {
    for (const item of batch?.[key] || []) {
      const text = item?.issue || item?.fix
      if (!text) continue
      const label = text.toLowerCase()
      const entry = totals.get(label) || { text, mentions: 0 }
      entry.mentions += item?.mentions || 1
      totals.set(label, entry)
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.mentions - a.mentions || a.text.length - b.text.length)
    .slice(0, limit)
    .map((entry) => ({ [key === 'commonIssues' ? 'issue' : 'fix']: entry.text, mentions: entry.mentions }))
}

function mergeStrings(batches, key, limit) {
  const seen = new Set()
  const out = []
  for (const batch of batches) {
    for (const text of batch?.[key] || []) {
      const label = String(text).toLowerCase()
      if (seen.has(label)) continue
      seen.add(label)
      out.push(text)
      if (out.length >= limit) return out
    }
  }
  return out
}

function mergeTimestamps(batches, limit) {
  const seen = new Set()
  const out = []
  for (const batch of batches) {
    for (const item of batch?.timestamps || []) {
      if (!item?.time) continue
      const label = item.time.toLowerCase()
      if (seen.has(label)) continue
      seen.add(label)
      out.push({ time: item.time, note: item.note || '' })
      if (out.length >= limit) return out
    }
  }
  return out
}

const FALLBACK_TONE = {
  works: 'Yes',
  'mostly works': 'Mostly',
  'mixed results': 'It depends',
  'often fails': 'Mostly not',
  'does not work': 'No',
}

/**
 * Used only when the final Gemini call could not complete. It never invents a
 * conclusion: the verdict comes from a majority tally over the per-batch
 * findings, and the confidence is deliberately low with the reason stated.
 */
export function buildMergedAnalysis({ batches, stats, cause }) {
  const list = Array.isArray(batches) ? batches : []

  let successVotes = 0
  let failureVotes = 0
  for (const batch of list) {
    const success = (batch?.successPatterns || []).length
    const failure = (batch?.failurePatterns || []).length
    if (success > failure) successVotes += 1
    else if (failure > success) failureVotes += 1
  }

  let verdict = 'mixed results'
  if (successVotes > failureVotes) verdict = successVotes > list.length * 0.75 ? 'works' : 'mostly works'
  else if (failureVotes > successVotes) verdict = failureVotes > list.length * 0.75 ? 'does not work' : 'often fails'
  if (!list.length) verdict = 'unclear'

  const conflicts = mergeStrings(list, 'conflictingExperiences', 6)
  const warnings = mergeStrings(list, 'warnings', 6)
  const commonIssues = mergeMentioned(list, 'commonIssues', 6)
  const helpfulFixes = mergeMentioned(list, 'helpfulFixes', 6)
  const timestamps = mergeTimestamps(list, 6)

  const causeText = cause?.code ? `${cause.code}` : 'the final synthesis call failed'

  return {
    verdict,
    doesItWork: FALLBACK_TONE[verdict] || 'Unclear',
    // Deliberately modest: no cross-batch reasoning happened, only a merge.
    confidence: list.length ? Math.min(45, Math.round(20 + list.length * 3)) : 0,
    confidenceReason:
      `Derived from ${list.length} comment batch${list.length === 1 ? '' : 'es'} without the final ` +
      `synthesis pass (${causeText}), so patterns were merged mechanically rather than reasoned over.`,
    summary:
      `Comments were analysed in ${list.length} batch${list.length === 1 ? '' : 'es'} (${stats?.commentsAnalyzed ?? 0} comments). ` +
      `${successVotes} batch${successVotes === 1 ? '' : 'es'} reported mostly success and ${failureVotes} reported mostly failure. ` +
      `The final synthesis call failed with ${causeText}, so this verdict is a mechanical merge and should be treated as a first pass.`,
    commonIssues,
    helpfulFixes,
    timestamps,
    status: 'Partially analysed - final synthesis unavailable',
    warnings,
    conflictingOpinions: conflicts,
    evidenceGaps: [
      `The final synthesis pass did not complete [${causeText}]` +
        (cause?.message ? `: ${String(cause.message).replace(/\s+/g, ' ').slice(0, 240)}` : '.') +
        ' Issues and fixes below are merged from the per-batch analysis, not cross-checked against each other.',
    ],
    successReports: 0,
    failureReports: 0,
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
            // "gemini-partial" still used the model, just not for the last pass.
            model: data.source.startsWith('gemini') ? config.gemini.model : null,
            commentCap: config.comments.max,
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
