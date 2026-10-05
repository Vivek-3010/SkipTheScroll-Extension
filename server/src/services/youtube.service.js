import { config } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { withRetry } from '../utils/retry.js'

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'

/**
 * Thin wrapper around the YouTube Data API v3 REST endpoints.
 * Keeps the API key on the server and converts API failures into ApiError.
 */
async function youtubeFetch(resource, params) {
  const url = new URL(`${YOUTUBE_API_BASE}/${resource}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  // The key never leaves the backend.
  url.searchParams.set('key', config.youtube.apiKey)
  url.searchParams.set('prettyPrint', 'false')

  let res
  let body = null
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(config.youtube.timeoutMs),
    })
  } catch (err) {
    throw new ApiError(
      502,
      'YOUTUBE_NETWORK',
      `Could not reach the YouTube API: ${err.message}`,
      'This is usually a temporary network problem - try again in a few seconds.'
    )
  }

  body = await res.json().catch(() => null)

  if (!res.ok) {
    throw mapYouTubeError(res.status, body, resource)
  }
  return body || {}
}

/**
 * YouTube returns inconsistent `reason` codes across endpoints and error versions
 * (for example an invalid key can be "badRequest", "keyInvalid" or
 * details[].reason = "API_KEY_INVALID"), so we look at every signal we get.
 */
function mapYouTubeError(status, body, resource) {
  const apiError = body?.error || {}
  const reasons = [
    apiError?.errors?.[0]?.reason,
    ...(Array.isArray(apiError?.details) ? apiError.details.map((d) => d?.reason) : []),
    apiError?.status,
  ]
    .filter(Boolean)
    .map((value) => String(value).toUpperCase())

  const message = apiError?.message || `YouTube API request failed (HTTP ${status}).`
  const haystack = message.toLowerCase()

  const matches = (...needles) =>
    needles.some(
      (needle) =>
        reasons.some((reason) => reason.includes(needle.toUpperCase())) || haystack.includes(needle.toLowerCase())
    )

  if (matches('commentsdisabled', 'commentdisabled')) {
    return new ApiError(
      400,
      'COMMENTS_DISABLED',
      'Comments are turned off for this video.',
      'SkipTheScroll can only read comments, so there is nothing to analyse here.'
    )
  }

  if (status === 404 || matches('videonotfound', 'notfound')) {
    return new ApiError(
      404,
      'VIDEO_NOT_FOUND',
      'This video could not be found.',
      'It may be private, deleted, age restricted or blocked in this region.'
    )
  }

  if (
    status === 429 ||
    matches(
      'ratelimit',
      'quota',
      'resource_exhausted',
      'dailylimitexceeded',
      'userratelimit'
    )
  ) {
    return new ApiError(
      429,
      'YOUTUBE_RATE_LIMIT',
      `The YouTube API rate limit / quota was hit: ${message}`,
      'Wait a minute and try again. Check the quota of your Google Cloud project if this keeps happening.'
    )
  }

  if (
    status === 403 ||
    matches(
      'keyinvalid',
      'api_key',
      'apikey',
      'accessnotconfigured',
      'accessdenied',
      'forbidden',
      'permissiondenied',
      'unauthenticated',
      'apikeynotvalid'
    )
  ) {
    return new ApiError(
      502,
      'YOUTUBE_AUTH',
      `The YouTube API rejected the server API key: ${message}`,
      'Verify YOUTUBE_API_KEY in server/.env and make sure "YouTube Data API v3" is enabled for that project.'
    )
  }

  if (status >= 500) {
    return new ApiError(
      502,
      'YOUTUBE_SERVER_ERROR',
      `The YouTube API returned an error while calling "${resource}": ${message}`,
      'Temporary upstream failure - retrying usually works.'
    )
  }

  return new ApiError(502, 'YOUTUBE_ERROR', `YouTube API error while calling "${resource}": ${message}`)
}

function pickThumbnail(thumbnails = {}) {
  const order = ['maxresdefault', 'standarddefault', 'high', 'medium', 'default']
  for (const key of order) {
    if (thumbnails[key]?.url) return thumbnails[key].url
  }
  return null
}

function toInt(value) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : 0
}

/** Video metadata: title, channel, thumbnail, counts. */
export async function getVideoMetadata(videoId) {
  const data = await withRetry(
    () =>
      youtubeFetch('videos', {
        part: 'snippet,statistics,contentDetails',
        id: videoId,
      }),
    { label: 'youtube.videos', retries: 2 }
  )

  const video = data.items?.[0]
  if (!video) {
    throw new ApiError(
      404,
      'VIDEO_NOT_FOUND',
      `No YouTube video found for ID "${videoId}".`,
      'The video may be private, deleted or not available in this region.'
    )
  }

  const snippet = video.snippet || {}
  const stats = video.statistics || {}

  return {
    id: video.videoId || videoId,
    title: snippet.title || 'Unknown title',
    description: snippet.description ? snippet.description.slice(0, 600) : '',
    channel: snippet.channelTitle || 'Unknown channel',
    channelId: snippet.channelId || null,
    thumbnail: pickThumbnail(snippet.thumbnails),
    publishedAt: snippet.publishedAt || null,
    duration: video.contentDetails?.duration || null,
    viewCount: toInt(stats.viewCount),
    likeCount: toInt(stats.likeCount),
    commentCount: toInt(stats.commentCount),
    url: `https://www.youtube.com/watch?v=${video.videoId || videoId}`,
  }
}

/**
 * Fetches at most `maxComments` top-level comment threads (YouTube relevance
 * order), paginating only until that limit is reached. Replies are read from the
 * same payload, so no extra API calls are made.
 */
export async function fetchComments(videoId, options = {}) {
  const maxComments = Math.min(options.maxComments || config.comments.max, config.comments.max)
  const pageSize = config.comments.pageSize
  const maxReplies = options.maxReplies ?? config.comments.maxRepliesPerThread

  const threads = []
  let pageToken = null
  let pages = 0

  while (threads.length < maxComments && pages < 10) {
    const remaining = maxComments - threads.length
    const data = await withRetry(
      () =>
        youtubeFetch('commentThreads', {
          part: 'snippet,replies',
          videoId,
          maxResults: Math.min(pageSize, remaining),
          order: 'relevance',
          textFormat: 'plainText',
          pageToken,
        }),
      {
        label: 'youtube.commentThreads',
        retries: 2,
        onRetry: (attempt, err, delay) =>
          console.warn(`[skipthescroll] commentThreads retry #${attempt} in ${delay}ms (${err.code})`),
      }
    )
    pages += 1

    const items = data.items || []
    for (const item of items) {
      if (threads.length >= maxComments) break
      threads.push(item)
    }

    pageToken = data.nextPageToken || null
    if (!pageToken || items.length === 0) break
  }

  return {
    threads,
    truncated: Boolean(pageToken),
    pages,
  }
}

/** Convenience helper for the pre-analysis "video info" endpoint. */
export async function getVideoSummary(videoId) {
  const video = await getVideoMetadata(videoId)
  const commentsDisabled = video.commentCount === 0
  return {
    video,
    commentsEnabled: !commentsDisabled,
  }
}
