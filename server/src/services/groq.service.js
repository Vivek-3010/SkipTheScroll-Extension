import { config } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'
import { withRetry, RETRYABLE_CODES } from '../utils/retry.js'
import {
  buildAllInOnePrompt,
  buildExtractionPrompt,
  buildSynthesisPrompt,
  pickGroundingComments,
  renderComment,
  estimateTokens,
  EXTRACTION_SYSTEM,
  BATCH_CLIP_CHARS,
  BATCH_REPLY_CLIP_CHARS,
  FINAL_SCHEMA,
  EXTRACTION_SCHEMA,
  ALLOWED_VERDICTS,
} from '../prompts/allInOnePrompt.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Parses the duration-ish strings rate-limit headers use ("30", "30s", "1m",
 * "500ms", or ISO-8601 "PT30S") into milliseconds. Returns null when the value
 * is missing or in a shape we do not recognise.
 */
export function parseDuration(value) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()

  const iso = text.match(/^PT(\d+(?:\.\d+)?)(H|M|S)?$/i)
  if (iso) {
    const n = Number(iso[1])
    const unit = (iso[2] || 'S').toUpperCase()
    return Math.ceil(unit === 'H' ? n * 3_600_000 : unit === 'M' ? n * 60_000 : n * 1000)
  }

  const plain = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i)
  if (!plain) return null
  const n = Number(plain[1])
  const unit = (plain[2] || 's').toLowerCase()
  return Math.ceil(unit === 'ms' ? n : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 1000)
}

/**
 * Reads Groq's per-window token budget from response headers so the batcher can
 * pace itself instead of collecting avoidable 429s.
 * `x-ratelimit-remaining-tokens` is what is left in the current window;
 * `x-ratelimit-reset-tokens` is how long until that window refills.
 */
export function parseRateLimit(headers) {
  const get = (name) => {
    try {
      return headers?.get?.(name) ?? null
    } catch {
      return null
    }
  }

  const rawRemaining = get('x-ratelimit-remaining-tokens')
  const remaining = rawRemaining === null || rawRemaining === '' ? NaN : Number(rawRemaining)
  const resetMs = parseDuration(get('x-ratelimit-reset-tokens'))

  return {
    remainingTokens: Number.isFinite(remaining) ? remaining : null,
    resetAtMs: resetMs !== null ? Date.now() + resetMs : null,
  }
}

/**
 * Tracks how many tokens the current Groq window still allows. Before each
 * request the batcher waits for the window to refill when the next call would
 * obviously exceed it, which keeps multi-batch runs from burning their retries
 * on guaranteed 429s.
 */
class RateBudget {
  constructor() {
    this.remainingTokens = null
    this.resetAtMs = 0
  }

  observe(rate) {
    if (!rate) return
    if (rate.resetAtMs && rate.resetAtMs > Date.now()) {
      this.remainingTokens = rate.remainingTokens
      this.resetAtMs = rate.resetAtMs
    } else {
      this.remainingTokens = null
      this.resetAtMs = 0
    }
  }

  /** Called when a 429 arrives: the window is full until retry-after elapses. */
  noteWindow(ms) {
    if (Number.isFinite(ms) && ms > 0) {
      this.remainingTokens = 0
      this.resetAtMs = Date.now() + ms
    }
  }

  async waitFor(estimate) {
    if (this.remainingTokens === null || !this.resetAtMs) return
    const now = Date.now()
    if (this.resetAtMs <= now) {
      this.remainingTokens = null
      this.resetAtMs = 0
      return
    }
    if (this.remainingTokens >= estimate) return

    const wait = Math.min(this.resetAtMs - now + 300, 62_000)
    if (wait > 0) {
      console.log(
        `[skipthescroll] token budget full (${this.remainingTokens} left, need ~${estimate}); waiting ${Math.round(wait / 1000)}s for the window to refill`
      )
      await sleep(wait)
    }
    this.remainingTokens = null
    this.resetAtMs = 0
  }
}

/**
 * Splits comments into the smallest number of batches whose rendered text fits
 * `perBatchTokens`. The caller subtracts the system prompt, scaffolding and
 * output budget from Groq's limit before calling this.
 * `start` is the 0-based index of the batch's first comment in the full set.
 */
export function packCommentBatches(
  comments,
  { perBatchTokens, clipChars = BATCH_CLIP_CHARS, replyClipChars = BATCH_REPLY_CLIP_CHARS } = {}
) {
  const list = Array.isArray(comments) ? comments : []
  const available = Math.max(200, Number(perBatchTokens) || 0)

  const batches = []
  let current = []
  let cost = 0
  let start = 0

  const flush = () => {
    if (!current.length) return
    batches.push({ comments: current, start })
    start += current.length
    current = []
    cost = 0
  }

  for (const comment of list) {
    const commentCost = estimateTokens(renderComment(comment, current.length, { clipChars, replyClipChars })) + 2
    if (current.length && cost + commentCost > available) flush()
    current.push(comment)
    cost += commentCost
  }
  flush()

  return batches
}

/**
 * Groq's OpenAI-compatible chat completions endpoint.
 *
 * Called over plain REST on purpose: there is no SDK to keep in sync, and the
 * API key never leaves the server process.
 */
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

export function endpointFor() {
  return `${GROQ_BASE_URL}/chat/completions`
}

export function modelsEndpoint() {
  return `${GROQ_BASE_URL}/models`
}

/** Never let the API key reach a log line, even if the API echoes it back. */
export function redact(value) {
  let text = String(value ?? '')
  const key = config.groq.apiKey
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
 * The prompt schemas use the uppercase dialect the prompts were written in
 * (`type: 'OBJECT'`). Groq expects standard JSON Schema, so the types are
 * lowercased here rather than editing the prompts.
 */
export function toJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toJsonSchema)
  if (!schema || typeof schema !== 'object') return schema

  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') out[key] = value.toLowerCase()
    else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSchema(v)]))
    } else if (key === 'items') out.items = toJsonSchema(value)
    else out[key] = toJsonSchema(value)
  }
  return out
}

/**
 * Some Groq models accept `json_schema`, others only `json_object`. We try the
 * stronger contract first and fall back permanently (per process) if the API
 * rejects it, so one unsupported model cannot break the whole pipeline.
 */
let jsonSchemaSupported = true

export function supportsJsonSchema() {
  return jsonSchemaSupported
}

/** Test seam: forces the weaker json_object mode. */
export function setJsonSchemaSupported(value) {
  jsonSchemaSupported = Boolean(value)
}

function buildResponseFormat(schemaName, schema) {
  if (!jsonSchemaSupported) return { type: 'json_object' }
  return {
    type: 'json_schema',
    json_schema: { name: schemaName, strict: false, schema: toJsonSchema(schema) },
  }
}

/**
 * Reasoning models (the gpt-oss family) spend a large chunk of max_tokens on
 * thinking before answering - measured up to 85% of the completion budget and
 * 5-6x higher than needed. `low` keeps the answers short and the per-analysis
 * token cost inside the free-tier budget. Other models ignore the knob, so it
 * is only sent for the family that supports it.
 */
function reasoningEffort() {
  return config.groq.model.startsWith('openai/gpt-oss') ? 'low' : undefined
}

/** Builds the chat-completions request body. */
export function buildRequestBody({ system, prompt, schemaName, schema, temperature, maxTokens }) {
  return {
    model: config.groq.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: temperature ?? 0.2,
    top_p: 0.95,
    ...(reasoningEffort() ? { reasoning_effort: reasoningEffort() } : {}),
    max_tokens: maxTokens ?? config.groq.maxTokens,
    stream: false,
    response_format: buildResponseFormat(schemaName, schema),
  }
}

/**
 * Maps an HTTP failure to an ApiError.
 * Every branch keeps the real HTTP status, API status and API message so the
 * cause is never hidden behind a generic error.
 */
export function mapGroqError({ status, payload, model, label, headers }) {
  const apiMessage =
    payload?.error?.message || payload?.message || '(no error message in response body)'
  const apiType = payload?.error?.type || 'UNKNOWN'
  const apiCode = payload?.error?.code || '-'
  const retryAfterHeader = headers?.get?.('retry-after') || '-'
  const combined = `${apiType} ${apiCode} ${apiMessage}`

  const error = buildError({ status, apiType, apiCode, apiMessage, combined, model, retryAfterHeader })

  // A burst 429 carries its own recovery window (retry-after header). Attach it
  // so withRetry can wait long enough for the per-minute budget to reset.
  const retryAfterMs = parseDuration(retryAfterHeader)
  if (error.code === 'GROQ_RATE_LIMIT' && retryAfterMs) {
    error.retryAfterMs = Math.min(retryAfterMs, 60_000)
  }

  // Authoritative: retryability comes from the code that was actually assigned,
  // never from the raw HTTP status. A quota block is NOT retryable.
  const isRetryable = RETRYABLE_CODES.has(error.code)

  console.error(
    [
      '',
      '[GROQ ERROR]',
      `Label       : ${label}`,
      `Model       : ${model}`,
      `Endpoint    : ${endpointFor()}`,
      `HTTP status : ${status}`,
      `API type    : ${apiType}`,
      `API code    : ${apiCode}`,
      `Retry-After : ${retryAfterHeader}`,
      `Message     : ${apiMessage}`,
      `Request     : response_format=${jsonSchemaSupported ? 'json_schema' : 'json_object'}`,
      `Code        : ${error.code}`,
      `Retryable   : ${isRetryable ? 'yes (transient)' : 'no (retrying cannot help)'}`,
      '',
    ].join('\n')
  )

  return error
}

/** Chooses the ApiError for an HTTP failure. Every branch keeps the real detail. */
function buildError({ status, apiType, apiCode, apiMessage, combined, model, retryAfterHeader }) {
  if (status === 429) {
    // The structured fields + wording together decide the class.
    //  - type "tokens"/"requests" ALWAYS means a burst limit (TPM/RPM) that
    //    clears in seconds. Groq's message for it even links to the billing
    //    dashboard ("Upgrade ... console.groq.com/settings/billing"), so any
    //    free-text match on words like "billing"/"plan" would misread it as a
    //    permanent account block and stop it being retried.
    //  - a real plan/credits block spells it out ("plan quota is exhausted",
    //    "insufficient credits") and is NOT retryable because retrying cannot help.
    const burstByType = apiType === 'tokens' || apiType === 'requests'
    const explicitQuota = /insufficient[_ ]quota|insufficient credits|credit balance|out of credits|quota (?:is|was) exhausted/i.test(
      combined
    )
    const isQuota = explicitQuota && !burstByType

    if (isQuota) {
      return new ApiError(
        429,
        'GROQ_QUOTA_EXCEEDED',
        `Groq quota exhausted for model "${model}" (HTTP ${status}, ${apiType}): ${apiMessage}`,
        'This is an account/plan limit, so retrying now cannot help. Check plan and billing at ' +
          'https://console.groq.com, or lower GROQ_MAX_TOKENS so each call costs fewer tokens.'
      )
    }
    return new ApiError(
      429,
      'GROQ_RATE_LIMIT',
      `Groq rate limit hit (HTTP ${status}, ${apiType}): ${apiMessage}`,
      `Transient - the per-minute token budget is full. Retry after ${retryAfterHeader}s ` +
        '(automatic), or raise MAX_COMMENTS slowly if it keeps happening.'
    )
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid_api_key|authentication/i.test(combined)) {
    return new ApiError(
      502,
      'GROQ_AUTH',
      `Groq rejected the API key (HTTP ${status}, ${apiType}): ${apiMessage}`,
      config.groq.looksValid
        ? 'Check GROQ_API_KEY in server/.env (create one at https://console.groq.com/keys). ' +
          'Run "npm run check:groq" for the exact HTTP status and API message.'
        : `GROQ_API_KEY in server/.env is malformed (${config.groq.problems.join('; ')}). ` +
          'Put only the key value in the file - no quotes, no "Bearer ", no spaces.'
    )
  }
  if (status === 404) {
    return new ApiError(
      502,
      'GROQ_MODEL',
      `Groq model "${model}" not found (HTTP 404, ${apiType}): ${apiMessage}`,
      'Set GROQ_MODEL in server/.env to a model this key can use. Run "npm run check:groq" to list them.'
    )
  }
  if (status === 413) {
    // Distinct from a plain bad request: the payload itself is valid, it is the
    // free-tier token budget that rejected it before the model ran. The batcher
    // reacts to this code by splitting the batch, so it must be identifiable.
    return new ApiError(
      502,
      'GROQ_REQUEST_TOO_LARGE',
      `Groq request too large for the free-tier token budget (HTTP 413): ${apiMessage}`,
      'This request (prompt + max_tokens) exceeds GROQ_REQUEST_TOKEN_BUDGET (~8000/min on the ' +
        'free tier). SkipTheScroll splits large comment sections automatically; lower MAX_COMMENTS ' +
        'or GROQ_REQUEST_TOKEN_BUDGET if it happens for every batch.'
    )
  }
  if (status === 400 || status === 422) {
    return new ApiError(
      502,
      'GROQ_BAD_REQUEST',
      `Groq rejected the request (HTTP ${status}, ${apiType}): ${apiMessage}`,
      'Not transient - do not retry. Common causes: a model that does not support response_format, ' +
        'a context length overflow (lower MAX_COMMENTS), or an invalid schema.'
    )
  }
  if (status === 503 || /overloaded|high demand|try again later|service unavailable/i.test(combined)) {
    // Capacity-constrained, not a fault in the request: more patience.
    return new ApiError(
      503,
      'GROQ_OVERLOADED',
      `Groq model "${model}" is temporarily overloaded (HTTP ${status}, ${apiType}): ${apiMessage}`,
      'Transient - retried with longer backoff. If it persists, try another GROQ_MODEL.'
    )
  }
  if (status >= 500) {
    return new ApiError(502, 'GROQ_SERVER_ERROR', `Groq server error (HTTP ${status}, ${apiType}): ${apiMessage}`)
  }
  if (status === 408) {
    return new ApiError(504, 'GROQ_TIMEOUT', `Groq timed out (HTTP ${status}, ${apiType}): ${apiMessage}`)
  }
  return new ApiError(502, 'GROQ_ERROR', `Unexpected Groq response (HTTP ${status}, ${apiType}): ${apiMessage}`)
}

/** One HTTP round trip. Returns the parsed response or throws a mapped ApiError. */
async function callGroq({ body, label, model }) {
  const url = endpointFor()

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // Groq uses a bearer token, not a ?key= query parameter.
        authorization: `Bearer ${config.groq.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.groq.timeoutMs),
    })
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError'
    console.error(
      [
        '[GROQ ERROR]',
        `Label       : ${label}`,
        `Model       : ${model}`,
        `HTTP status : (none - ${aborted ? 'client timeout' : 'network failure'})`,
        `API type    : -`,
        `Message     : ${redact(err?.message)}`,
        `Retryable   : yes (transient)`,
        '',
      ].join('\n')
    )
    throw new ApiError(
      502,
      aborted ? 'GROQ_TIMEOUT' : 'GROQ_NETWORK',
      aborted ? `Groq did not answer within ${config.groq.timeoutMs}ms.` : `Could not reach the Groq API: ${redact(err?.message)}`,
      'Transient - retried automatically before failing.'
    )
  }

  if (res.ok) return res

  const payload = await res.json().catch(() => null)
  const mapped = mapGroqError({ status: res.status, payload, model, label, headers: res.headers })

  // A model that rejects json_schema is a permanent capability gap for this
  // process, not a per-request glitch: downgrade once and carry on.
  if (
    jsonSchemaSupported &&
    (res.status === 400 || res.status === 422) &&
    /response_format|json_schema|schema/i.test(payload?.error?.message || '')
  ) {
    console.warn(
      `[skipthescroll] ${model} rejected response_format=json_schema; downgrading to json_object for the rest of this process.`
    )
    jsonSchemaSupported = false
  }

  throw mapped
}

/**
 * Calls Groq chat completions with structured JSON output. Returns
 * `{ data, rate }` where `rate` is the rate-limit budget observed from the
 * response headers (used to pace batched runs).
 * Retries only transient failures (network, 408, 429 burst, 5xx) - never 400/401/403.
 */
async function generateJson({ system, prompt, schemaName, schema, temperature, maxTokens, label, policy }) {
  const model = config.groq.model
  const body = buildRequestBody({ system, prompt, schemaName, schema, temperature, maxTokens })

  const res = await withRetry(() => callGroq({ body, label, model }), {
    label,
    policy: policy ?? { retries: 2, baseDelayMs: 400, factor: 2, maxDelayMs: 5000 },
    onRetry: (attempt, err, delay) =>
      console.warn(
        `[skipthescroll] ${label} retry #${attempt} in ${delay}ms (code=${err.code} status=${err.status}) - ${redact(err.message)}`
      ),
  })

  const rate = parseRateLimit(res.headers)
  const payload = await res.json().catch(() => null)
  const choice = payload?.choices?.[0]
  const rawText = choice?.message?.content || ''

  if (!rawText || typeof rawText !== 'string') {
    const finish = choice?.finish_reason || '-'
    const reasoning = choice?.message?.reasoning
    console.error(
      [
        '[GROQ ERROR]',
        `Label       : ${label}`,
        `Model       : ${model}`,
        `HTTP status : ${res.status}`,
        `API type    : ${finish === 'length' ? 'MAX_TOKENS' : 'EMPTY_CONTENT'}`,
        `Message     : finish_reason=${finish}, message.content empty` +
          (reasoning ? ' (model spent the budget on reasoning)' : ''),
        `Retryable   : no (finish_reason=length means the answer did not fit in max_tokens)`,
        '',
      ].join('\n')
    )
    throw new ApiError(
      502,
      'GROQ_EMPTY',
      `Groq returned no content (model=${model}, finish_reason=${finish}).`,
      finish === 'length'
        ? 'Raise GROQ_MAX_TOKENS or lower MAX_COMMENTS so reasoning plus the JSON answer fits.'
        : 'The model returned reasoning only; retry or lower MAX_COMMENTS.'
    )
  }

  return { data: parseJsonLoose(rawText, label), rate }
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
      '[GROQ ERROR]',
      `Label       : ${label}`,
      `Model       : ${config.groq.model}`,
      `HTTP status : 200`,
      `API type    : MALFORMED_JSON`,
      `Message     : response was not valid JSON (${redact(text.slice(0, 400))})`,
      `Retryable   : no`,
      '',
    ].join('\n')
  )
  throw new ApiError(
    502,
    'GROQ_MALFORMED',
    `Groq returned a response that was not valid JSON (${label}): ${redact(text.slice(0, 200))}`,
    'Usually caused by truncated output - retry, or lower MAX_COMMENTS.'
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

function normalizeFinal(raw) {
  const verdict = normalizeVerdict(raw?.verdict)
  const evidenceGaps = toStrings(raw?.evidenceGaps, 6)

  return {
    verdict,
    doesItWork: str(raw?.doesItWork) || defaultDoesItWork(verdict),
    confidence: clampInt(raw?.confidence, 0, 100, 0),
    confidenceReason: str(raw?.confidenceReason),
    summary: str(raw?.summary, 'The AI did not return a summary for this video.'),
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

/** Normalises one extraction batch (no verdict fields). */
export function normalizeExtraction(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    commonIssues: toItems(source.commonIssues, 'issue', 12),
    helpfulFixes: toItems(source.helpfulFixes, 'fix', 12),
    timestamps: toItems(source.timestamps, 'time', 8),
    warnings: toStrings(source.warnings, 8),
    conflictingOpinions: toStrings(source.conflictingOpinions, 8),
    successReports: clampInt(source.successReports, 0, 100000, 0),
    failureReports: clampInt(source.failureReports, 0, 100000, 0),
  }
}

/* ------------------------------ public API ------------------------------ */

/**
 * The whole analysis.
 *
 * If every cleaned comment fits in ONE request (prompt + max_tokens under
 * GROQ_REQUEST_TOKEN_BUDGET) the model extracts the community patterns AND
 * produces the final verdict in a single response shaped by FINAL_SCHEMA.
 *
 * Larger comment sections are split into batches that each fit the free-tier
 * budget, one paced extraction call per batch, and the merged extractions are
 * judged by a final synthesis call. Either way every fetched comment is read -
 * there is no "top 60 only" path any more.
 *
 * Transient failures are retried inside generateJson with window-aware backoff
 * (a 429's retry-after is respected). A failure on the very first call is a
 * real problem (bad key, model, quota, malformed response) and surfaces as an
 * ApiError with a GROQ_* code; a mid-run failure on a later batch keeps the
 * batches that already succeeded and is reported to the caller so the response
 * can say exactly how much of the comment section was covered.
 *
 * @returns {{ analysis: object, batches: { requested, analyzed, failed, aiCalls, singlePass, maxSize, analyzedComments } }}
 */
export async function analyzeComments({ video, comments, stats }) {
  const all = Array.isArray(comments) ? comments : []

  const singlePrompt = buildAllInOnePrompt({ video, comments: all, stats })
  const singleEstimate =
    estimateTokens(singlePrompt.system) + estimateTokens(singlePrompt.prompt) + config.groq.maxTokens

  if (singleEstimate <= config.groq.requestTokenBudget) {
    try {
      const { data } = await generateJson({
        system: singlePrompt.system,
        prompt: singlePrompt.prompt,
        schemaName: 'skipthescroll_verdict',
        schema: FINAL_SCHEMA,
        temperature: 0.2,
        maxTokens: config.groq.maxTokens,
        label: 'groq.analysis',
      })
      return {
        analysis: normalizeFinal(data),
        batches: {
          requested: 1,
          analyzed: 1,
          failed: 0,
          aiCalls: 1,
          singlePass: true,
          maxSize: all.length,
          analyzedComments: all.length,
        },
      }
    } catch (err) {
      if (err.code !== 'GROQ_REQUEST_TOO_LARGE') throw err
      console.warn('[skipthescroll] single-pass request was too large; switching to batched analysis')
    }
  }

  return analyzeInBatches({ video, comments: all, stats })
}

/** Compact JSON budget per extraction call: reasoning (low) + the small schema. */
const EXTRACTION_MAX_TOKENS = 1536

async function analyzeInBatches({ video, comments, stats }) {
  const requestBudget = config.groq.requestTokenBudget
  const perBatchTokens = Math.max(
    400,
    requestBudget - EXTRACTION_MAX_TOKENS - estimateTokens(EXTRACTION_SYSTEM) - 350
  )

  const packed = packCommentBatches(comments, { perBatchTokens })
  const queue = packed.map((entry, index) => ({ ...entry, index }))
  const totalBatches = queue.length

  const rateBudget = new RateBudget()
  const extractions = []
  const failures = []

  let analyzedComments = 0
  let aiCalls = 0
  let completed = 0
  let consecutiveFailures = 0

  while (queue.length) {
    const entry = queue.shift()

    const promptParts = buildExtractionPrompt({
      video,
      comments: entry.comments,
      stats,
      batch: { index: entry.index, start: entry.start, totalBatches, totalComments: comments.length },
    })

    // The greedy packer is deliberately a little conservative; verify against
    // the real rendered prompt and split anything that still overshoots.
    const estimate =
      estimateTokens(promptParts.system) + estimateTokens(promptParts.prompt) + EXTRACTION_MAX_TOKENS
    if (estimate > requestBudget && entry.comments.length > 1) {
      queue.unshift(...splitEntry(entry))
      continue
    }

    try {
      await rateBudget.waitFor(estimate)
      const { data, rate } = await generateJson({
        system: promptParts.system,
        prompt: promptParts.prompt,
        schemaName: 'skipthescroll_extraction',
        schema: EXTRACTION_SCHEMA,
        temperature: 0.2,
        maxTokens: EXTRACTION_MAX_TOKENS,
        label: 'groq.extract',
        policy: { retries: 4, baseDelayMs: 800, factor: 2, maxDelayMs: 10_000 },
      })
      rateBudget.observe(rate)
      aiCalls += 1
      completed += 1
      consecutiveFailures = 0
      extractions.push(normalizeExtraction(data))
      analyzedComments += entry.comments.length
    } catch (err) {
      if (err.code === 'GROQ_REQUEST_TOO_LARGE') {
        // Our own sizing was off: halve and try again.
        if (entry.comments.length > 1) {
          queue.unshift(...splitEntry(entry))
          continue
        }
        failures.push(err)
        consecutiveFailures += 1
        continue
      }

      // Nothing has succeeded yet -> this is a systemic problem (auth, model,
      // quota, server), so it must surface instead of looking like "no data".
      if (completed === 0) throw err

      // A mid-run failure keeps the batches we already paid for, but two in a
      // row means the window is not recovering: stop and report the coverage.
      if (Number.isFinite(err?.retryAfterMs)) rateBudget.noteWindow(err.retryAfterMs)
      failures.push(err)
      consecutiveFailures += 1
      if (consecutiveFailures >= 2) break
    }
  }

  if (extractions.length === 0) {
    throw failures[failures.length - 1] || new ApiError(502, 'GROQ_ERROR', 'No comment batch could be analysed.')
  }

  // Final synthesis over the merged batch extractions, grounded in a few real
  // quotes. The quote list is trimmed until the request fits the budget.
  let grounding = pickGroundingComments(comments)
  let synthesis = buildSynthesisPrompt({
    video,
    stats: { ...stats, commentsAnalyzed: analyzedComments },
    batches: extractions,
    grounding,
    batchInfo: { requested: totalBatches },
  })

  while (
    grounding.length > 0 &&
    estimateTokens(synthesis.system) + estimateTokens(synthesis.prompt) + config.groq.maxTokens > requestBudget
  ) {
    grounding = grounding.slice(0, -1)
    synthesis = buildSynthesisPrompt({
      video,
      stats: { ...stats, commentsAnalyzed: analyzedComments },
      batches: extractions,
      grounding,
      batchInfo: { requested: totalBatches },
    })
  }

  await rateBudget.waitFor(
    estimateTokens(synthesis.system) + estimateTokens(synthesis.prompt) + config.groq.maxTokens
  )
  const { data } = await generateJson({
    system: synthesis.system,
    prompt: synthesis.prompt,
    schemaName: 'skipthescroll_verdict',
    schema: FINAL_SCHEMA,
    temperature: 0.2,
    maxTokens: config.groq.maxTokens,
    label: 'groq.synthesis',
  })
  aiCalls += 1

  return {
    analysis: normalizeFinal(data),
    batches: {
      requested: totalBatches,
      analyzed: extractions.length,
      failed: failures.length,
      aiCalls,
      singlePass: false,
      maxSize: packed.reduce((max, batch) => Math.max(max, batch.comments.length), 0),
      analyzedComments,
    },
  }
}

/** Half of an over-budget batch, preserving global comment offsets. */
function splitEntry(entry) {
  const mid = Math.floor(entry.comments.length / 2)
  return [
    { comments: entry.comments.slice(0, mid), start: entry.start, index: entry.index },
    { comments: entry.comments.slice(mid), start: entry.start + mid, index: entry.index },
  ]
}

/**
 * Single-call analysis (kept for the live prompt test and callers that know
 * their comment set already fits). The pipeline itself goes through
 * analyzeComments so big sections are batched.
 */
export async function analyzeAllAtOnce({ video, comments, stats }) {
  const { system, prompt } = buildAllInOnePrompt({ video, comments, stats })
  const { data } = await generateJson({
    system,
    prompt,
    schemaName: 'skipthescroll_verdict',
    schema: FINAL_SCHEMA,
    temperature: 0.2,
    maxTokens: config.groq.maxTokens,
    label: 'groq.analysis',
  })
  return normalizeFinal(data)
}

/**
 * Startup self-check: one tiny real request against the configured model.
 * Never throws - it only reports, so the server still boots.
 */
export async function verifyAiSetup() {
  const startedAt = Date.now()
  const model = config.groq.model

  try {
    const res = await fetch(endpointFor(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.groq.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 32,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await res.json().catch(() => null)

    if (!res.ok) {
      console.error(
        [
          '[GROQ STARTUP CHECK] FAILED',
          `Model       : ${model}`,
          `Endpoint    : ${endpointFor()}`,
          `HTTP status : ${res.status}`,
          `API type    : ${payload?.error?.type || '-'}`,
          `Message     : ${payload?.error?.message || '-'}`,
          '',
        ].join('\n')
      )
      return false
    }

    const text = payload?.choices?.[0]?.message?.content || '(empty)'
    console.log(
      `[GROQ STARTUP CHECK] OK  model=${model} http=${res.status} ` +
        `latency=${Date.now() - startedAt}ms json_schema=${jsonSchemaSupported} reply=${redact(text.trim().slice(0, 40))}`
    )
    return true
  } catch (err) {
    console.error(
      [
        '[GROQ STARTUP CHECK] FAILED',
        `Model       : ${model}`,
        `HTTP status : (none - ${err?.name === 'AbortError' ? 'timeout' : 'network failure'})`,
        `Message     : ${redact(err?.message)}`,
        '',
      ].join('\n')
    )
    return false
  }
}

export { normalizeFinal, normalizeVerdict }
