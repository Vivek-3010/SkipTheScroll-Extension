import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(here, '..', '..')

// Load server/.env (override with ENV_FILE=...).
const envFile = process.env.ENV_FILE
  ? path.resolve(serverRoot, process.env.ENV_FILE)
  : path.resolve(serverRoot, '.env')

const loadedEnvFile = fs.existsSync(envFile) ? envFile : null

if (loadedEnvFile) {
  dotenv.config({ path: loadedEnvFile })
}

const missing = []

function required(name, hint) {
  const value = (process.env[name] || '').trim()
  if (!value) missing.push(name)
  return value || hint || ''
}

function optionalInt(name, fallback, { min, max } = {}) {
  const raw = (process.env[name] || '').trim()
  const parsed = raw === '' ? NaN : Number.parseInt(raw, 10)
  let value = Number.isFinite(parsed) ? parsed : fallback
  if (typeof min === 'number') value = Math.max(min, value)
  if (typeof max === 'number') value = Math.min(max, value)
  return value
}

const youtubeApiKey = required('YOUTUBE_API_KEY', 'missing')
const groqApiKey = required('GROQ_API_KEY', 'missing')

if (missing.length) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}.\n` +
      `Env file looked at: ${envFile} (${loadedEnvFile ? 'found' : 'NOT FOUND'})\n` +
      `Copy server/.env.example -> server/.env, fill in the values, then restart the server.`
  )
}

const nodeEnv = (process.env.NODE_ENV || 'development').trim()

/** Short, non-reversible fingerprint so logs can prove WHICH key is loaded. */
function fingerprint(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8)
}

/**
 * Credential shape check - purely local, never touches the network and never
 * prints the value.
 *
 * No prefix is required: Google has shipped keys with several prefixes and new
 * key formats do not necessarily look like the classic "AIza...", so pinning
 * one would produce false alarms. What is checked instead is *paste damage*,
 * which is the actual common failure and always invalid:
 *
 *   - the whole `KEY=value` line pasted as the value
 *   - a `Bearer ` prefix (an OAuth token, not an API key)
 *   - surrounding quotes or stray whitespace
 *   - the variable name pasted into its own value
 *   - a value far too short to be a real key
 *
 * Anything else is accepted: whether the key actually works is decided by the
 * API, and `npm run check:groq` reports that authoritatively.
 */
export function inspectKey(label, secret, variableName = '') {
  const value = String(secret ?? '')
  const problems = []

  if (!value) problems.push('value is empty')
  if (/\s/.test(value)) problems.push('contains whitespace')
  if (/["']/.test(value)) problems.push('contains a quote character')
  if (value.includes('=')) problems.push('contains "=" (a whole KEY=value line seems to be pasted)')
  if (/^bearer\s/i.test(value)) problems.push('starts with "Bearer " (that is an OAuth token, not an API key)')
  if (variableName && value.toUpperCase().includes(variableName.toUpperCase())) {
    problems.push(`contains the variable name "${variableName}"`)
  }
  if (value.length < 20) problems.push(`is only ${value.length} characters long`)

  return {
    loaded: Boolean(value),
    fingerprint: value ? fingerprint(value) : null,
    length: value.length,
    // "Not obviously mangled" - this is NOT a statement about key validity.
    looksValid: problems.length === 0,
    problems,
  }
}

export const config = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  port: optionalInt('PORT', 5178, { min: 1, max: 65535 }),
  loadedEnvFile,

  youtube: {
    apiKey: youtubeApiKey,
    ...inspectKey('YOUTUBE_API_KEY', youtubeApiKey, 'YOUTUBE_API_KEY'),
    timeoutMs: optionalInt('YOUTUBE_TIMEOUT_MS', 15_000, { min: 1_000 }),
  },

  /**
   * Groq (OpenAI-compatible chat completions). The key stays on the server and
   * is only ever sent as an Authorization: Bearer header.
   */
  groq: {
    apiKey: groqApiKey,
    ...inspectKey('GROQ_API_KEY', groqApiKey, 'GROQ_API_KEY'),
    model: (process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim(),
    // gpt-oss spends part of this budget on reasoning, so 3072 keeps the
    // request's pre-flight estimate under the free tier's ~8k tokens/minute
    // wall (larger values re-trigger HTTP 413).
    maxTokens: optionalInt('GROQ_MAX_TOKENS', 3072, { min: 512 }),
    // Groq's free tier rejects a request whose estimate (prompt + max_tokens)
    // exceeds ~8000 tokens with HTTP 413 before the model runs, and only
    // allows ~8k tokens PER MINUTE in total. Big comment sections are analysed
    // in paced batches sized against this budget (see groq.service.js).
    requestTokenBudget: optionalInt('GROQ_REQUEST_TOKEN_BUDGET', 8000, { min: 2000 }),
    timeoutMs: optionalInt('GROQ_TIMEOUT_MS', 120_000, { min: 5_000 }),
    // Probe the configured model at startup so problems surface before a user
    // clicks "Analyze Comments". Set GROQ_STARTUP_CHECK=false to disable.
    startupCheck: (process.env.GROQ_STARTUP_CHECK || 'true').trim().toLowerCase() !== 'false',
  },

  // How many top-level comment threads are fetched from YouTube AND analysed.
  // commentThreads.list is paginated (100 per page) and stops as soon as this
  // many threads are collected. This is NOT limited by the AI budget anymore:
  // whatever does not fit one request is split into paced batches by
  // groq.service.js, so the default covers the vast majority of videos.
  comments: {
    max: optionalInt('MAX_COMMENTS', 500, { min: 1, max: 500 }),
    pageSize: 100,
    maxRepliesPerThread: 5,
  },

  cache: {
    ttlMs: optionalInt('CACHE_TTL_MS', 10 * 60_000, { min: 0 }),
    maxEntries: optionalInt('CACHE_MAX_ENTRIES', 20, { min: 1 }),
  },
}
