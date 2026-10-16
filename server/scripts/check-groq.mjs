/**
 * Groq diagnostics. Makes real API calls and prints the exact HTTP status and
 * API message the API returned - never the API key.
 *
 *   npm run check:groq
 *
 * Useful when the analysis fails with GROQ_ERROR / GROQ_BAD_REQUEST: it
 * isolates which part of the request payload the model rejects.
 */
import crypto from 'node:crypto'
import { config } from '../src/config/env.js'
import { endpointFor, modelsEndpoint, toJsonSchema, supportsJsonSchema } from '../src/services/groq.service.js'
import { FINAL_SCHEMA } from '../src/prompts/allInOnePrompt.js'

const { apiKey, model, timeoutMs } = config.groq

/* ----------------------------- safe logging ----------------------------- */

/** Redacts the API key from any string before it is printed. */
function redact(value) {
  let text = String(value ?? '')
  if (apiKey) text = text.split(apiKey).join('[REDACTED_API_KEY]')
  // Groq may echo a *truncated* key back in error payloads.
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

function authHeaders() {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  }
}

safeLog('\n================ GROQ DIAGNOSTICS ================')
safeLog(`Env file loaded      : ${config.loadedEnvFile}`)
safeLog(`GROQ_MODEL           : ${model}`)
safeLog(`GROQ_API_KEY         : loaded (sha256:${fingerprint()}, length ${apiKey.length})`)
safeLog(
  `Value sanity         : ${
    config.groq.looksValid ? 'ok (no paste damage detected)' : `MALFORMED - ${config.groq.problems.join('; ')}`
  }`
)
safeLog(`Max tokens           : ${config.groq.maxTokens} (shared with reasoning)`)
safeLog(`Endpoint             : ${endpointFor()}`)
safeLog('==================================================\n')

if (!config.groq.looksValid) {
  safeLog('!! GROQ_API_KEY in server/.env is malformed:')
  config.groq.problems.forEach((problem) => safeLog(`   - ${problem}`))
  safeLog('   Put only the key value in the file: no quotes, no "Bearer ", no spaces,')
  safeLog('   and not the whole "GROQ_API_KEY=..." line.\n')
}

// The API itself is the authority on whether a key works, so ask it directly
// instead of guessing from the value's shape. This also reveals which models
// the key can actually reach.
const catalog = await probeModelCatalog()
if (catalog.ok && catalog.models) {
  safeLog(`\n  Available models (${catalog.models.length}): ${catalog.models.slice(0, 12).join(', ')}`)
  if (!catalog.models.includes(model)) {
    const close = catalog.models.filter((name) => name.includes(model.split('/').pop() || 'x'))
    safeLog(`\n  !! "${model}" is NOT in this key's model list.`)
    safeLog(`     Closest available: ${close.slice(0, 6).join(', ') || catalog.models.slice(0, 6).join(', ')}`)
    safeLog('     Set GROQ_MODEL in server/.env to one of these names.\n')
  }
}

/**
 * GETs the model catalog. Answers two questions the probes below cannot:
 *   1. does this key authenticate at all?
 *   2. which model names can this key actually reach?
 */
async function probeModelCatalog() {
  safeLog('\n--- 0. key authentication + model list (GET /models)')

  let res
  try {
    res = await fetch(modelsEndpoint(), {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    safeLog(`  RESULT : NETWORK FAILURE - ${err.message}`)
    return { ok: false }
  }

  const payload = await res.json().catch(() => null)
  safeLog(`  HTTP   : ${res.status} ${res.statusText}`)

  if (!res.ok) {
    safeLog(`  type   : ${payload?.error?.type || '-'}`)
    safeLog(`  message: ${payload?.error?.message || '-'}`)
    safeLog('  verdict: the API rejected this credential, so every probe below will fail too.')
    return { ok: false, http: res.status }
  }

  const models = (payload?.data || [])
    .map((entry) => String(entry?.id || ''))
    .filter(Boolean)
    .sort()
  safeLog(`  verdict: the key authenticates. ${models.length} models are reachable.`)
  return { ok: true, models }
}

async function probe(probeDef) {
  const started = Date.now()

  const res = await fetch(endpointFor(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: probeDef.system },
        { role: 'user', content: probeDef.user },
      ],
      stream: false,
      ...probeDef.extra,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const payload = await res.json().catch(() => null)

  safeLog(`\n--- ${probeDef.label}`)
  safeLog(`  HTTP   : ${res.status} ${res.statusText}  (${Date.now() - started}ms)`)

  if (!res.ok) {
    safeLog(`  type   : ${payload?.error?.type || '-'}`)
    safeLog(`  code   : ${payload?.error?.code || '-'}`)
    safeLog(`  message: ${payload?.error?.message || '-'}`)
    return { ok: false, status: res.status }
  }

  const choice = payload?.choices?.[0]
  const content = choice?.message?.content || ''
  safeLog(`  finish : ${choice?.finish_reason || '-'}`)
  safeLog(`  tokens : ${payload?.usage?.completion_tokens ?? '-'} completion / ${payload?.usage?.total_tokens ?? '-'} total`)
  if (choice?.message?.reasoning) safeLog('  note   : the model also returned a `reasoning` field (expected)')
  safeLog(`  reply  : ${content ? content.slice(0, 160) : '(empty content)'}`)

  if (!content) {
    safeLog('  verdict: HTTP 200 with no content - reasoning consumed max_tokens.')
    return { ok: false, status: res.status, empty: true }
  }

  try {
    let textContent = content.trim()
    const fence = textContent.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fence) textContent = fence[1].trim()
    const start = textContent.indexOf('{')
    const end = textContent.lastIndexOf('}')
    if (start !== -1 && end > start) textContent = textContent.slice(start, end + 1)
    // Mirrors the service's parseJsonLoose: tolerate trailing commas too.
    const parsed = JSON.parse(textContent.replace(/,\s*([}\]])/g, '$1'))
    safeLog(`  parsed : valid JSON with keys [${Object.keys(parsed).join(', ')}]`)
    return { ok: true, status: res.status, parsed }
  } catch {
    safeLog('  parsed : NOT valid JSON')
    return { ok: false, status: res.status, badJson: true }
  }
}

/* --------------------------------- probes --------------------------------- */

const ANSWER_INSTRUCTION =
  'Answer with JSON only. Example shape: {"ok": true, "note": "..."}'

const probes = [
  {
    label: '1. minimal chat completion (no extras)',
    system: 'You are a terse test assistant.',
    user: `${ANSWER_INSTRUCTION} Return {"ok": true}.`,
    extra: { max_tokens: 64 },
  },
  {
    label: '2. + max_tokens larger than production allows (8192)',
    system: 'You are a terse test assistant.',
    user: `${ANSWER_INSTRUCTION} Return {"ok": true}.`,
    extra: { max_tokens: 8192 },
  },
  {
    label: '3. + response_format json_object (what SkipTheScroll sends)',
    system: 'You return JSON only.',
    user: `${ANSWER_INSTRUCTION} Return {"ok": true, "note": "json_object works"}.`,
    extra: { max_tokens: 8192, response_format: { type: 'json_object' } },
  },
  {
    label: '4. + response_format json_schema (the real analysis schema)',
    system: 'You return JSON only, matching the schema exactly.',
    user: `${ANSWER_INSTRUCTION} Summarise: "two users say the fix worked".`,
    extra: {
      max_tokens: 8192,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'skipthescroll_verdict',
          strict: false,
          schema: toJsonSchema(FINAL_SCHEMA),
        },
      },
    },
  },
  {
    label: '5. + exact production payload (temperature / top_p / reasoning_effort low / 3072 tokens)',
    system: 'You return JSON only, matching the schema exactly.',
    user: `${ANSWER_INSTRUCTION} Summarise: "two users say the fix worked".`,
    extra: {
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: config.groq.maxTokens,
      reasoning_effort: 'low',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'skipthescroll_verdict',
          strict: false,
          schema: toJsonSchema(FINAL_SCHEMA),
        },
      },
    },
  },
]

let failed = 0
for (const probeDef of probes) {
  try {
    const result = await probe(probeDef)
    if (!result.ok) failed += 1
  } catch (err) {
    failed += 1
    safeLog(`\n--- ${probeDef.label}`)
    safeLog(`  RESULT : ${err.message}`)
  }
}

safeLog('\n==================================================')
if (failed === 0) {
  safeLog('RESULT: every probe passed.')
  safeLog(`Model ${model} works with the exact payload SkipTheScroll sends.`)
} else if (failed === 1 && probes.length - failed >= 3) {
  safeLog(`RESULT: ${failed} probe(s) failed, but the core calls work.`)
  safeLog('If only the json_schema probes failed, the service falls back to')
  safeLog('json_object automatically - the pipeline still works.')
} else {
  safeLog(`RESULT: ${failed} of ${probes.length} probes failed. The model/key combination is not usable.`)
  safeLog('Check the key at https://console.groq.com/keys and the model name above.')
}
safeLog(`json_schema mode: ${supportsJsonSchema() ? 'supported' : 'not supported by this model'}`)
safeLog('==================================================\n')

process.exit(failed > 0 && failed === probes.length ? 1 : 0)
