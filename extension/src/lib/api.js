import {
  API_BASE_URL,
  ANALYSIS_TIMEOUT_MS,
  VIDEO_INFO_TIMEOUT_MS,
} from './constants.js'

/**
 * The extension only ever talks to its own local backend.
 * API keys for YouTube and Gemini live exclusively in the backend .env file.
 */

class ApiError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.hint = hint || null
  }
}

async function request(path, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ApiError(
        'TIMEOUT',
        'The SkipTheScroll server took too long to respond.',
        `Is the backend still running on ${API_BASE_URL}?`
      )
    }
    throw new ApiError(
      'NETWORK_ERROR',
      `Could not reach the SkipTheScroll server at ${API_BASE_URL}.`,
      'Start it with "npm start" inside the server/ folder.'
    )
  } finally {
    clearTimeout(timer)
  }

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok || payload?.ok === false) {
    const error = payload?.error || {}
    throw new ApiError(
      error.code || `HTTP_${response.status}`,
      error.message || `The server returned HTTP ${response.status}.`,
      error.hint
    )
  }

  if (!payload?.data) {
    throw new ApiError('BAD_RESPONSE', 'The server returned an unexpected response.', null)
  }
  return payload.data
}

/** Video metadata for the popup (title, channel, thumbnail, comment count). */
export function fetchVideoInfo(videoId) {
  return request(`/api/video?videoId=${encodeURIComponent(videoId)}`, {
    timeoutMs: VIDEO_INFO_TIMEOUT_MS,
  })
}

/** Full comment analysis + community verdict. */
export function analyzeVideo(videoId) {
  return request('/api/analyze', {
    method: 'POST',
    body: { videoId },
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  })
}
