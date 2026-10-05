/**
 * Gemini diagnostics. Makes real API calls and prints the exact HTTP status,
 * API status and message the API returned - never the API key.
 *
 *   npm run check:gemini
 *
 * Useful when the analysis fails with GEMINI_ERROR / GEMINI_BAD_REQUEST: it
 * isolates which part of the request payload the model rejects.
 */
import crypto from 'node:crypto'
import { config } from '../src/config/env.js'
import { endpointFor } from '../src/services/gemini.service.js'

const { apiKey, model, apiVersion, thinkingBudget } = config.gemini

/* ----------------------------- safe logging ----------------------------- */

/** Redacts the API key from any string before it is printed. */
function redact(value) {
  let text = String(value ?? '')
  if (apiKey) text = text.split(apiKey).join('[REDACTED_API_KEY]')
  // Google sometimes echoes a *truncated* key back in error payloads.
  if (apiKey && apiKey.length > 8) {
    for (const cut of [6, 4]) {
      const head = apiKey.slice(0, cut)
      if (head.length > 3) text = text.split(head).join('[REDACTED_KEY_PREFIX]')
    }
  }
  return text
}

function safeLog(...parts) {
  console.log(...parts.map((part) => (typeof part === 'string' ? redact(part) : part)))
}

function fingerprint() {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
}

safeLog('\n================ GEMINI DIAGNOSTICS ================')
safeLog(`Env file loaded      : ${config.loadedEnvFile}`)
safeLog(`GEMINI_MODEL         : ${model}`)
safeLog(`GEMINI_API_VERSION   : ${apiVersion}`)
safeLog(`GEMINI_API_KEY       : loaded (sha256:${fingerprint()}, length ${apiKey.length})`)
safeLog(
  `Value sanity         : ${
    config.gemini.looksValid
      ? 'ok (no paste damage detected)'
      : `MALFORMED - ${config.gemini.problems.join('; ')}`
  }`
)
safeLog(`Thinking budget      : ${thinkingBudget === null ? 'not sent (model default)' : thinkingBudget}`)
safeLog(`Endpoint              : ${endpointFor(model)}`)
safeLog('=====================================================\n')

if (!config.gemini.looksValid) {
  safeLog('!! GEMINI_API_KEY in server/.env is malformed:')
  config.gemini.problems.forEach((problem) => safeLog(`   - ${problem}`))
  safeLog('   Put only the key value in the file: no quotes, no "Bearer ", no spaces,')
  safeLog('   and not the whole "GEMINI_API_KEY=..." line.\n')
}

// The API itself is the authority on whether a key works, so ask it directly
// instead of guessing from the value's shape. This also reveals which models
// the key can actually reach.
const catalog = await probeModelCatalog()
if (catalog.ok && catalog.models) {
  safeLog(`\n  Available models (${catalog.models.length}): ${catalog.models.slice(0, 12).join(', ')}`)
  if (!catalog.models.includes(model)) {
    const close = catalog.models.filter((name) => name.includes(model.split('-').pop() || 'x'))
    safeLog(`\n  !! "${model}" is NOT in this key's model list.`)
    safeLog(`     Closest available: ${close.slice(0, 6).join(', ') || catalog.models.slice(0, 6).join(', ')}`)
    safeLog('     Set GEMINI_MODEL in server/.env to one of these names.\n')
  }
}

/* -------------------------------- probes -------------------------------- */

const TINY_SCHEMA = {
  type: 'OBJECT',
  properties: { ok: { type: 'BOOLEAN' }, note: { type: 'STRING' } },
  required: ['ok'],
}

const PROBES = [
  {
    name: '1. minimal request (no generationConfig extras)',
    build: () => ({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }] }),
  },
  {
    name: '2. + responseMimeType/responseSchema (JSON mode)',
    build: () => ({
      contents: [{ role: 'user', parts: [{ text: 'Return {"ok":true,"note":"ping"}' }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: TINY_SCHEMA },
    }),
  },
  {
    name: '3. + systemInstruction',
    build: () => ({
      systemInstruction: { parts: [{ text: 'You reply with JSON only.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Return {"ok":true,"note":"ping"}' }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: TINY_SCHEMA },
    }),
  },
  {
    name: `4. + temperature/topP/maxOutputTokens`,
    build: () => ({
      contents: [{ role: 'user', parts: [{ text: 'Return {"ok":true,"note":"ping"}' }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.95,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseSchema: TINY_SCHEMA,
      },
    }),
  },
  {
    name: `5. + thinkingConfig.thinkingBudget=${thinkingBudget} (what SkipTheScroll sends today)`,
    build: () => ({
      contents: [{ role: 'user', parts: [{ text: 'Return {"ok":true,"note":"ping"}' }] }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.95,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        responseSchema: TINY_SCHEMA,
        ...(thinkingBudget === null ? {} : { thinkingConfig: { thinkingBudget } }),
      },
    }),
  },
]

/**
 * GETs the model catalog. Answers two questions the probes below cannot:
 *   1. does this key authenticate at all (as opposed to being rejected later)?
 *   2. which model names can this key actually reach?
 */
async function probeModelCatalog() {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models?pageSize=200&key=${encodeURIComponent(
    apiKey
  )}`

  safeLog('\n--- 0. key authentication (GET /models)')

  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(config.gemini.timeoutMs) })
  } catch (err) {
    safeLog(`  RESULT : NETWORK FAILURE - ${err.message}`)
    return { ok: false }
  }

  const payload = await res.json().catch(() => null)
  safeLog(`  HTTP   : ${res.status} ${res.statusText}`)

  if (!res.ok) {
    safeLog(`  status : ${payload?.error?.status || '-'}`)
    safeLog(`  message: ${payload?.error?.message || '-'}`)
    safeLog('  verdict: the API rejected this credential, so every probe below will fail too.')
    return { ok: false, http: res.status }
  }

  const models = (payload?.models || [])
    .filter((entry) => {
      const methods = entry?.supportedGenerationMethods
      return Array.isArray(methods) ? methods.includes('generateContent') : true
    })
    .map((entry) => String(entry?.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort()
  safeLog(`  verdict: the key authenticates. ${models.length} generateContent models are reachable.`)
  return { ok: true, models }
}

async function probe(probeDef) {
  // Uses the exact endpoint the service builds, so this script can never
  // disagree with production behaviour.
  const url = `${endpointFor(model)}?key=${encodeURIComponent(apiKey)}`

  safeLog(`\n--- ${probeDef.name}`)

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(probeDef.build()),
      signal: AbortSignal.timeout(config.gemini.timeoutMs),
    })
  } catch (err) {
    safeLog(`  RESULT : NETWORK FAILURE - ${err.message}`)
    return { ok: false }
  }

  const payload = await res.json().catch(() => null)
  const apiStatus = payload?.error?.status || '-'
  const apiMessage = payload?.error?.message || '-'

  safeLog(`  HTTP   : ${res.status} ${res.statusText}`)
  safeLog(`  status : ${apiStatus}`)
  if (!res.ok) {
    safeLog(`  message: ${apiMessage}`)
  } else {
    const finish = payload?.candidates?.[0]?.finishReason || '-'
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    safeLog(`  finish : ${finish}`)
    safeLog(`  text   : ${text.slice(0, 120) || '(empty)'}`)
  }
  return { ok: res.ok, http: res.status, apiStatus, apiMessage }
}

const results = []
for (const probeDef of PROBES) {
  results.push(await probe(probeDef))
}

const failed = results.filter((r) => !r.ok)
safeLog('\n================ SUMMARY ================')
PROBES.forEach((probeDef, index) => {
  const result = results[index]
  safeLog(`${result.ok ? 'OK  ' : 'FAIL'} ${probeDef.name} -> ${result.ok ? 'HTTP 200' : `HTTP ${result.http} ${result.apiStatus}`}`)
})
if (failed.length) {
  safeLog('\nFirst failing probe message (the real cause):')
  safeLog(`  ${failed[0].apiMessage}`)
}
safeLog('========================================\n')

process.exit(failed.length ? 1 : 0)
