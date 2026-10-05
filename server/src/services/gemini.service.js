import { config } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { withRetry, RETRYABLE_CODES } from '../utils/retry.js'
import { buildBatchPrompt, BATCH_SCHEMA } from '../prompts/batchPrompt.js'
import { buildFinalPrompt, FINAL_SCHEMA, ALLOWED_VERDICTS } from '../prompts/finalPrompt.js'

const GEMINI_HOST = 'https://generativelanguage.googleapis.com'

/**
 * Quota exhaustion (free tier request allowance) as opposed to a per-minute
 * burst limit. Google words it as "quota exceeded ... free_tier_requests ...
 * billing details", so match on that rather than on the HTTP status alone.
 */
const QUOTA_RE = /free_tier|quota exceeded|exceeded your current quota|billing details|per day|per 24 hours/i

/** Pulls "Please retry in 6h57m59.1s" out of a quota message. */
export function parseRetryAfter(message) {
  const text = String(message || '')
  const hms = text.match(/in\s+(\d+)h(\d+)m(\d+(?:\.\d+)?)s/i)
  if (hms) {
    const hours = Number(hms[1])
    const minutes = Number(hms[2])
    const seconds = Math.round(Number(hms[3]))
    const parts = []
    if (hours) parts.push(`${hours}h`)
    if (minutes) parts.push(`${minutes}m`)
    if (seconds && !hours) parts.push(`${seconds}s`)
    return parts.join(' ') || `${seconds}s`
  }
  const secondsOnly = text.match(/in\s+(\d+(?:\.\d+)?)\s*s\b/i)
  if (secondsOnly) return `${Math.round(Number(secondsOnly[1]))}s`
  const ms = text.match(/retry[- ]after[:\s]+(\d+)\s*ms/i)
  if (ms) return `${ms[1]}ms`
  return null
}

function endpointFor(model) {
  return `${GEMINI_HOST}/${config.gemini.apiVersion}/models/${encodeURIComponent(model)}:generateContent`
}

/** Never let the API key reach a log line, even if the API echoes it back. */
function redact(value) {
  let text = String(value ?? '')
  const key = config.gemini.apiKey
  if (key) {
    text = text.split(key).join('[REDACTED_API_KEY]')
    for (const cut of [6, 4]) {
      const head = key.slice(0, cut)
      if (head.length > 3) text = text.split(head).join('[REDACTED_KEY_PREFIX]')
    }
  }
  return text
}

/**
 * Builds the request body.
 *
 * `thinkingConfig` is only included when GEMINI_THINKING_BUDGET is explicitly
 * set: Gemini 3.x models reject `thinkingBudget: 0`, and models that do not
 * support thinking reject the field entirely.
 */
export function buildRequestBody({ system, prompt, schema, temperature, maxOutputTokens }) {
  const generationConfig = {
    temperature: temperature ?? 0.2,
    topP: 0.95,
    maxOutputTokens: maxOutputTokens ?? 3072,
    responseMimeType: 'application/json',
    responseSchema: schema,
  }

  if (config.gemini.thinkingBudget !== null) {
    generationConfig.thinkingConfig = { thinkingBudget: config.gemini.thinkingBudget }
  }

  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  }
}

/**
 * Maps an HTTP failure to an ApiError.
 * Every branch keeps the real HTTP status, API status and API message so the
 * cause is never hidden behind a generic error.
 */
export function mapGeminiError({ status, payload, model, label }) {
  const apiStatus = payload?.error?.status || 'UNKNOWN'
  const apiMessage = payload?.error?.message || '(no error message in response body)'
  const details = Array.isArray(payload?.error?.details) ? payload.error.details : []
  const apiReason = details.map((d) => d?.reason).filter(Boolean).join(', ') || '-'
  const thinkingSent =
    config.gemini.thinkingBudget === null ? 'not sent' : `thinkingBudget=${config.gemini.thinkingBudget}`

  const error = buildError({ status, apiStatus, apiReason, apiMessage, model })

  // Authoritative: retryability comes from the code that was actually assigned,
  // never from the raw HTTP status. A 429 daily-quota block is NOT retryable.
  const isRetryable = RETRYABLE_CODES.has(error.code)

  console.error(
    [
      '',
      '[GEMINI ERROR]',
      `Label       : ${label}`,
      `Model       : ${model}`,
      `Endpoint    : ${GEMINI_HOST}/${config.gemini.apiVersion}/models/${model}:generateContent`,
      `HTTP status : ${status}`,
      `API status  : ${apiStatus}`,
      `API reason  : ${apiReason}`,
      `Message     : ${apiMessage}`,
      `Request     : ${thinkingSent}, responseMimeType=application/json, responseSchema=yes`,
      `Code        : ${error.code}`,
      `Retryable   : ${isRetryable ? 'yes (transient)' : 'no (retrying cannot help)'}`,
      '',
    ].join('\n')
  )

  return error
}

/** Chooses the ApiError for an HTTP failure. Every branch keeps the real detail. */
function buildError({ status, apiStatus, apiReason, apiMessage, model }) {
  if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    // A burst limit clears in seconds and is worth retrying. A quota limit
    // (free tier = N requests/day) does not, so it must not be retried and the
    // popup needs to say when the quota comes back.
    if (QUOTA_RE.test(`${apiStatus} ${apiReason} ${apiMessage}`)) {
      const resetsIn = parseRetryAfter(apiMessage)
      return new ApiError(
        429,
        'GEMINI_QUOTA_EXCEEDED',
        `Gemini quota exhausted for model "${model}" (HTTP ${status}, ${apiStatus}): ${apiMessage}`,
        `This is a per-key/per-day quota, not a burst limit, so retrying now cannot help.` +
          (resetsIn ? ` Quota resets in about ${resetsIn}.` : '') +
          ' Check plan and billing details, or use a key from a project with a paid tier.'
      )
    }

    return new ApiError(
      429,
      'GEMINI_RATE_LIMIT',
      `Gemini rate limit hit (HTTP 429, ${apiStatus}): ${apiMessage}`,
      'Transient - retry shortly. Lower GEMINI_CONCURRENCY if it keeps happening.'
    )
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED|PERMISSION_DENIED|UNAUTHENTICATED/i.test(`${apiStatus} ${apiReason} ${apiMessage}`)) {
    return new ApiError(
      502,
      'GEMINI_AUTH',
      `Gemini rejected the API key (HTTP ${status}, ${apiStatus}): ${apiMessage}`,
      config.gemini.looksValid
        ? 'Check GEMINI_API_KEY in server/.env and make sure the key is allowed to use this model. ' +
          'Run "npm run check:gemini" in server/ to see the exact HTTP status and API message.'
        : `GEMINI_API_KEY in server/.env is malformed (${config.gemini.problems.join('; ')}). ` +
          'Put only the key value in the file - no quotes, no "Bearer ", no spaces.'
    )
  }
  if (status === 404) {
    return new ApiError(
      502,
      'GEMINI_MODEL',
      `Gemini model "${model}" not found (HTTP 404, ${apiStatus}): ${apiMessage}`,
      `Set GEMINI_MODEL in server/.env to a model this key can use (endpoint ${config.gemini.apiVersion}).`
    )
  }
  if (status === 400 || status === 422) {
    return new ApiError(
      502,
      'GEMINI_BAD_REQUEST',
      `Gemini rejected the request (HTTP ${status}, ${apiStatus}): ${apiMessage}`,
      'Not transient - do not retry. Common causes: unsupported generationConfig field for this model ' +
        '(try unsetting GEMINI_THINKING_BUDGET), a wrong GEMINI_API_VERSION, or an invalid responseSchema.'
    )
  }
  if (status === 413) {
    return new ApiError(
      502,
      'GEMINI_BAD_REQUEST',
      `Gemini request too large (HTTP 413): ${apiMessage}`,
      'Reduce GEMINI_BATCH_SIZE so fewer comments are sent per call.'
    )
  }
  if (status === 503 || apiStatus === 'UNAVAILABLE' || /high demand|overloaded|try again later/i.test(apiMessage)) {
    // Google returns this when a model is capacity-constrained. It is purely a
    // function of load, so it gets more attempts and longer waits than a 500.
    return new ApiError(
      503,
      'GEMINI_OVERLOADED',
      `Gemini model "${model}" is temporarily overloaded (HTTP ${status}, ${apiStatus}): ${apiMessage}`,
      'Transient - retried with longer backoff. If it persists, try a sibling model such as GEMINI_FALLBACK_MODEL.'
    )
  }
  if (status >= 500) {
    return new ApiError(
      502,
      'GEMINI_SERVER_ERROR',
      `Gemini server error (HTTP ${status}, ${apiStatus}): ${apiMessage}`
    )
  }
  if (status === 408) {
    return new ApiError(504, 'GEMINI_TIMEOUT', `Gemini timed out (HTTP 408, ${apiStatus}): ${apiMessage}`)
  }
  return new ApiError(
    502,
    'GEMINI_ERROR',
    `Unexpected Gemini response (HTTP ${status}, ${apiStatus}): ${apiMessage}`
  )
}

/** One HTTP round trip. Returns the parsed response or throws a mapped ApiError. */
async function callGemini({ body, label, model }) {
  const url = `${endpointFor(model)}?key=${encodeURIComponent(config.gemini.apiKey)}`

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.gemini.timeoutMs),
    })
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError'
    console.error(
      [
        '[GEMINI ERROR]',
        `Label       : ${label}`,
        `Model       : ${model}`,
        `HTTP status : (none - ${aborted ? 'client timeout' : 'network failure'})`,
        `API status  : -`,
        `Message     : ${redact(err?.message)}`,
        `Retryable   : yes (transient)`,
        '',
      ].join('\n')
    )
    throw new ApiError(
      502,
      aborted ? 'GEMINI_TIMEOUT' : 'GEMINI_NETWORK',
      aborted
        ? `Gemini did not answer within ${config.gemini.timeoutMs}ms.`
        : `Could not reach the Gemini API: ${redact(err?.message)}`,
      'Transient - retried automatically before failing.'
    )
  }

  if (res.ok) return res

  const payload = await res.json().catch(() => null)
  throw mapGeminiError({ status: res.status, payload, model, label })
}

/**
 * Calls Gemini :generateContent with JSON-schema output and returns parsed JSON.
 * Uses the REST API directly so there is no SDK version to maintain.
 * Retries only transient failures (network, 408, 429, 5xx) - never 400/401/403.
 */
async function generateJson({ system, prompt, schema, temperature, maxOutputTokens, label }) {
  const model = config.gemini.model
  const body = buildRequestBody({ system, prompt, schema, temperature, maxOutputTokens })

  const res = await withRetry(() => callGemini({ body, label, model }), {
    label,
    policy: { retries: 2, baseDelayMs: 400, factor: 2, maxDelayMs: 5000 },
    onRetry: (attempt, err, delay) =>
      console.warn(
        `[skipthescroll] ${label} retry #${attempt} in ${delay}ms (code=${err.code} status=${err.status}) - ${redact(err.message)}`
      ),
  })

  const payload = await res.json().catch(() => null)
  const candidate = payload?.candidates?.[0]
  const rawText =
    candidate?.content?.parts?.map((part) => part?.text || '').join('') || candidate?.content?.parts?.[0]?.text || ''

  if (!rawText) {
    const finish = candidate?.finishReason || '-'
    const block = payload?.promptFeedback?.blockReason || '-'
    console.error(
      [
        '[GEMINI ERROR]',
        `Label       : ${label}`,
        `Model       : ${model}`,
        `HTTP status : ${res.status}`,
        `API status  : ${payload?.promptFeedback ? 'PROMPT_BLOCKED' : 'EMPTY_CANDIDATE'}`,
        `Message     : finishReason=${finish} blockReason=${block} (no text in candidates[0].content.parts)`,
        `Retryable   : no (finishReason=MAX_TOKENS means the schema/prompt did not fit in maxOutputTokens)`,
        '',
      ].join('\n')
    )
    throw new ApiError(
      502,
      'GEMINI_EMPTY',
      `Gemini returned no text (model=${model}, finishReason=${finish}, blockReason=${block}).`,
      'If finishReason=MAX_TOKENS raise maxOutputTokens or lower GEMINI_BATCH_SIZE; if the response was blocked, retry.'
    )
  }

  return parseJsonLoose(rawText, label)
}

/** Tolerates ```json fences, stray prose and trailing commas. */
function parseJsonLoose(rawText, label) {
  let text = String(rawText).trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) text = text.slice(start, end + 1)

  const attempts = [text, text.replace(/,\s*([}\]])/g, '$1')]
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {
      /* try next */
    }
  }
  console.error(
    [
      '[GEMINI ERROR]',
      `Label       : ${label}`,
      `Model       : ${config.gemini.model}`,
      `HTTP status : 200`,
      `API status  : MALFORMED_JSON`,
      `Message     : response was not valid JSON (${redact(text.slice(0, 400))})`,
      `Retryable   : no`,
      '',
    ].join('\n')
  )
  throw new ApiError(
    502,
    'GEMINI_MALFORMED',
    `Gemini returned a response that was not valid JSON (${label}): ${redact(text.slice(0, 200))}`,
    'Usually caused by truncated output - retry, or lower GEMINI_BATCH_SIZE.'
  )
}

/* ------------------------------ normalisers ------------------------------ */

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function toItems(value, keyName, limit) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    let text = ''
    let mentions = 0
    let secondary = ''

    if (typeof entry === 'string') {
      text = entry
    } else if (entry && typeof entry === 'object') {
      text = str(entry[keyName])
      mentions = clampInt(entry.mentions, 0, 999, 0)
      if (keyName === 'time') secondary = str(entry.note)
    }
    if (!text) continue

    const dedupeKey = `${keyName}:${text.toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const item = keyName === 'time' ? { time: text, note: secondary } : { [keyName]: text }
    if (keyName !== 'time' && mentions) item.mentions = mentions
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

function toStrings(value, limit) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    const text = str(entry)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

function normalizeVerdict(value) {
  const raw = str(value).toLowerCase().replace(/[.]+$/, '')
  // Longest match first so "mostly works" is not shortened to "works".
  const matches = ALLOWED_VERDICTS.filter((allowed) => raw === allowed || raw.includes(allowed)).sort(
    (a, b) => b.length - a.length
  )
  return matches[0] || 'unclear'
}

function normalizeBatch(raw) {
  return {
    successPatterns: toStrings(raw?.successPatterns, 8),
    failurePatterns: toStrings(raw?.failurePatterns, 8),
    commonIssues: toItems(raw?.commonIssues, 'issue', 8),
    helpfulFixes: toItems(raw?.helpfulFixes, 'fix', 8),
    timestamps: toItems(raw?.timestamps, 'time', 6),
    outdatedIndicators: toStrings(raw?.outdatedIndicators, 6),
    warnings: toStrings(raw?.warnings, 6),
    conflictingExperiences: toStrings(raw?.conflictingExperiences, 6),
    evidenceGaps: toStrings(raw?.evidenceGaps, 5),
    batchNotes: str(raw?.batchNotes),
  }
}

function normalizeFinal(raw) {
  const verdict = normalizeVerdict(raw?.verdict)
  const evidenceGaps = toStrings(raw?.evidenceGaps, 6)

  return {
    verdict,
    doesItWork: str(raw?.doesItWork) || defaultDoesItWork(verdict),
    confidence: clampInt(raw?.confidence, 0, 100, 0),
    confidenceReason: str(raw?.confidenceReason),
    summary: str(raw?.summary, 'Gemini did not return a summary for this video.'),
    commonIssues: toItems(raw?.commonIssues, 'issue', 6),
    helpfulFixes: toItems(raw?.helpfulFixes, 'fix', 6),
    timestamps: toItems(raw?.timestamps, 'time', 6),
    status: str(raw?.status, 'Unknown'),
    warnings: toStrings(raw?.warnings, 6),
    conflictingOpinions: toStrings(raw?.conflictingOpinions, 6),
    evidenceGaps,
    successReports: clampInt(raw?.successReports, 0, 100000, 0),
    failureReports: clampInt(raw?.failureReports, 0, 100000, 0),
  }
}

function defaultDoesItWork(verdict) {
  switch (verdict) {
    case 'works':
      return 'Yes'
    case 'mostly works':
      return 'Mostly'
    case 'mixed results':
      return 'It depends'
    case 'often fails':
      return 'Mostly not'
    case 'does not work':
      return 'No'
    default:
      return 'Not enough evidence'
  }
}

/* ------------------------------ public API ------------------------------ */

/** Analyses one batch of comments. Returns normalised batch findings. */
export async function analyzeBatch({ video, comments, batchIndex, batchCount }) {
  const { system, prompt } = buildBatchPrompt({ video, comments, batchIndex, batchCount })
  const raw = await generateJson({
    system,
    prompt,
    schema: BATCH_SCHEMA,
    temperature: 0.15,
    maxOutputTokens: 3072,
    label: `gemini.batch[${batchIndex + 1}/${batchCount}]`,
  })
  return normalizeBatch(raw)
}

/** Final synthesis pass across all batch findings. */
export async function synthesizeFinalAnalysis({ video, batches, stats }) {
  const { system, prompt } = buildFinalPrompt({ video, batches, stats })
  const raw = await generateJson({
    system,
    prompt,
    schema: FINAL_SCHEMA,
    temperature: 0.25,
    maxOutputTokens: 4096,
    label: 'gemini.final',
  })
  return normalizeFinal(raw)
}

/**
 * Startup self-check: one tiny request against the configured model.
 * Never throws - it only reports, so the server still boots.
 */
export async function verifyGeminiSetup() {
  const startedAt = Date.now()
  const model = config.gemini.model
  const url = `${endpointFor(model)}?key=${encodeURIComponent(config.gemini.apiKey)}`

  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
    generationConfig: { maxOutputTokens: 64 },
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await res.json().catch(() => null)

    if (!res.ok) {
      console.error(
        [
          '[GEMINI STARTUP CHECK] FAILED',
          `Model       : ${model}`,
          `Endpoint    : ${GEMINI_HOST}/${config.gemini.apiVersion}/models/${model}:generateContent`,
          `HTTP status : ${res.status}`,
          `API status  : ${payload?.error?.status || '-'}`,
          `Message     : ${payload?.error?.message || '-'}`,
          '',
        ].join('\n')
      )
      return false
    }

    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '(empty)'
    console.log(
      `[GEMINI STARTUP CHECK] OK  model=${model} api=${config.gemini.apiVersion} http=${res.status} ` +
        `latency=${Date.now() - startedAt}ms reply=${redact(text.trim().slice(0, 40))}`
    )
    return true
  } catch (err) {
    console.error(
      [
        '[GEMINI STARTUP CHECK] FAILED',
        `Model       : ${model}`,
        `HTTP status : (none - ${err?.name === 'AbortError' ? 'timeout' : 'network failure'})`,
        `Message     : ${redact(err?.message)}`,
        '',
      ].join('\n')
    )
    return false
  }
}

export { normalizeFinal, normalizeBatch, normalizeVerdict, endpointFor, redact }
