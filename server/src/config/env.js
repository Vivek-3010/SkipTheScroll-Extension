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

/**
 * Thinking budget is optional on purpose: some models (Gemini 3.x) reject
 * `thinkingBudget: 0`, so when it is not set we send no thinkingConfig at all
 * and let the model use its own default.
 *
 * Accepted values: "" | auto | none | unset  -> null (field omitted)
 *                  a number (e.g. 0, 1024, -1)
 */
function optionalThinkingBudget(name = 'GEMINI_THINKING_BUDGET') {
  const raw = (process.env[name] || '').trim().toLowerCase()
  if (raw === '' || raw === 'auto' || raw === 'none' || raw === 'unset' || raw === 'default') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return parsed >= 0 ? parsed : -1
}

const youtubeApiKey = required('YOUTUBE_API_KEY', 'missing')
const geminiApiKey = required('GEMINI_API_KEY', 'missing')

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
 * API, and `npm run check:gemini` reports that authoritatively.
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

  gemini: {
    apiKey: geminiApiKey,
    ...inspectKey('GEMINI_API_KEY', geminiApiKey, 'GEMINI_API_KEY'),
    model: (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim(),
    // Accepts "v1beta", "1beta" or "v1" and always yields "v1beta" / "v1".
    apiVersion: (process.env.GEMINI_API_VERSION || 'v1beta').trim().replace(/^(\d)/, 'v$1'),
    thinkingBudget: optionalThinkingBudget(),
    batchSize: optionalInt('GEMINI_BATCH_SIZE', 50, { min: 10, max: 200 }),
    concurrency: optionalInt('GEMINI_CONCURRENCY', 3, { min: 1, max: 8 }),
    timeoutMs: optionalInt('GEMINI_TIMEOUT_MS', 120_000, { min: 5_000 }),
    // Probe the configured model at startup so problems surface before a user
    // clicks "Analyze Comments". Set GEMINI_STARTUP_CHECK=false to disable.
    startupCheck: (process.env.GEMINI_STARTUP_CHECK || 'true').trim().toLowerCase() !== 'false',
  },

  // V1 hard limit: never analyse more than 500 comments, whatever the env says.
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
