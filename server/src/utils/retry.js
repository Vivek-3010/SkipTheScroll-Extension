import { ApiError } from './ApiError.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The ONLY failures worth repeating.
 *
 * Explicitly excluded (never retried, because retrying cannot help):
 *   GROQ_BAD_REQUEST (400/422), GROQ_REQUEST_TOO_LARGE (413), GROQ_AUTH (401/403),
 *   GROQ_MODEL (404), GROQ_QUOTA_EXCEEDED, GROQ_MALFORMED, GROQ_EMPTY,
 *   YOUTUBE_AUTH, YOUTUBE_ERROR, VIDEO_ID_*, COMMENTS_DISABLED,
 *   VIDEO_NOT_FOUND and every other 4xx.
 *
 * Retried: network failures, client timeouts, 408, 429 and 5xx.
 */
const RETRYABLE_CODES = new Set([
  // YouTube
  'YOUTUBE_NETWORK',
  'YOUTUBE_SERVER_ERROR',
  'YOUTUBE_RATE_LIMIT',
  // Groq
  'GROQ_NETWORK',
  'GROQ_TIMEOUT',
  'GROQ_RATE_LIMIT',
  'GROQ_SERVER_ERROR',
  'GROQ_OVERLOADED',
])

/**
 * Codes that deserve MORE patience than the default policy.
 * GROQ_OVERLOADED is HTTP 503 / "overloaded", which is a function of how busy
 * the model is rather than a fault in the request, so it gets extra attempts
 * and much longer waits.
 */
const PATIENCE_OVERRIDES = {
  GROQ_OVERLOADED: { retries: 5, baseDelayMs: 2000, factor: 2, maxDelayMs: 30_000 },
}

export { RETRYABLE_CODES, PATIENCE_OVERRIDES }

/**
 * Retry with exponential backoff + jitter.
 *
 * Only failures that are worth repeating are retried: network errors, 429s and
 * 5xx responses (identified by their ApiError code). 4xx validation problems are
 * re-thrown immediately.
 *
 * @param {Function} fn        async work to run
 * @param {object}   options
 * @param {number}   options.retries      extra attempts after the first (default 2)
 * @param {number}   options.baseDelayMs  first backoff delay (default 400)
 * @param {number}   options.factor       backoff multiplier (default 2)
 * @param {number}   options.maxDelayMs   backoff ceiling (default 5000)
 * @param {string}   options.label        used in logs
 * @param {Function} options.onRetry      (attempt, error, delayMs)
 * @param {object}   options.policy       overrides for the default policy
 * @param {number}   options.policy.retries
 * @param {number}   options.policy.baseDelayMs
 * @param {number}   options.policy.factor
 * @param {number}   options.policy.maxDelayMs
 */
export async function withRetry(fn, options = {}) {
  const { label = 'request', onRetry, policy } = options

  let attempt = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (err) {
      // A patient code (e.g. overload) restarts its own longer backoff schedule.
      const patience = PATIENCE_OVERRIDES[err?.code]
      const effective = patience ?? policy ?? {}

      const retries = effective.retries ?? 2
      const baseDelayMs = effective.baseDelayMs ?? 400
      const factor = effective.factor ?? 2
      const maxDelayMs = effective.maxDelayMs ?? 5000

      if (patience) attempt = 0

      const canRetry = attempt < retries && RETRYABLE_CODES.has(err?.code)
      if (!canRetry) throw err

      // A Groq burst 429 reports how long until the per-minute budget resets
      // (retry-after). Wait at least that long so the next attempt can actually
      // pass instead of burning retries on a window that has not reset yet.
      // Cap it so a huge "retry in 1 hour" does not block the server for an hour.
      const windowWait = Math.min(err?.retryAfterMs || 0, 60_000)
      const delay = Math.max(Math.min(maxDelayMs, baseDelayMs * factor ** attempt), windowWait)
      const jittered = Math.round(delay * (0.75 + Math.random() * 0.5))
      attempt += 1

      if (onRetry) {
        try {
          onRetry(attempt, err, jittered)
        } catch {
          /* logging must never break the retry loop */
        }
      }
      await sleep(jittered)
    }
  }
}

/**
 * Normalises anything thrown inside a pipeline into an ApiError.
 */
export function toApiError(err, fallbackStatus = 500, fallbackCode = 'INTERNAL_ERROR') {
  if (err instanceof ApiError) return err
  return new ApiError(fallbackStatus, fallbackCode, err?.message || 'Unexpected server error.')
}
