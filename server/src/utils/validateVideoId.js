import { ApiError } from './ApiError.js'

/**
 * YouTube video IDs are exactly 11 characters from [A-Za-z0-9_-].
 */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

const WATCH_RE = /[?&]v=([A-Za-z0-9_-]{11})/
const PATH_RE = /\/(?:shorts|embed|v|live|e)\/([A-Za-z0-9_-]{11})/
const SHORT_RE = /youtu\.be\/([A-Za-z0-9_-]{11})/

export function isValidVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_RE.test(value.trim())
}

/**
 * Accepts a raw video ID or any common YouTube URL and returns the video ID,
 * or null when nothing usable is found.
 */
export function extractVideoId(input) {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value) return null

  if (VIDEO_ID_RE.test(value)) return value

  if (!/^https?:\/\//i.test(value)) return null

  const patterns = [WATCH_RE, PATH_RE, SHORT_RE]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) return match[1]
  }
  return null
}

/**
 * Normalises + validates user input coming from the extension.
 * Throws a 400 ApiError with a helpful message when invalid.
 */
export function validateVideoId(input) {
  if (input === undefined || input === null || input === '') {
    throw new ApiError(400, 'VIDEO_ID_MISSING', 'A "videoId" is required in the request body.')
  }
  if (typeof input !== 'string') {
    throw new ApiError(400, 'VIDEO_ID_INVALID', 'The "videoId" field must be a string.')
  }
  if (input.length > 300) {
    throw new ApiError(400, 'VIDEO_ID_INVALID', 'That does not look like a YouTube video ID or link.')
  }
  const videoId = extractVideoId(input)
  if (!videoId) {
    throw new ApiError(
      400,
      'VIDEO_ID_INVALID',
      `"${input.slice(0, 80)}" is not a valid YouTube video ID.`,
      'Expected an 11 character YouTube ID (for example "dQw4w9WgXcQ") or a full youtube.com link.'
    )
  }
  return videoId
}
