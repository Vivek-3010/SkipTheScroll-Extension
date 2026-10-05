import express from 'express'
import cors from 'cors'
import { config } from './config/env.js'
import analyzeRoutes from './routes/analyze.routes.js'
import { isApiError } from './utils/ApiError.js'
import { verifyGeminiSetup } from './services/gemini.service.js'

const app = express()

/* ------------------------------ startup log ------------------------------ */
// Prints the resolved configuration so it is obvious which model and which key
// the process actually loaded. Only a non-reversible sha256 prefix is shown.

function keyLine(label, key) {
  const flag = key.looksValid ? 'loaded' : `MALFORMED - ${key.problems.join('; ')}`
  return `  ${label.padEnd(20)}: ${flag} (sha256:${key.fingerprint}, length ${key.length})`
}

function logStartup() {
  const { gemini, youtube } = config
  console.log('\n  ---- SkipTheScroll server configuration ----')
  console.log(`  Env file            : ${config.loadedEnvFile || 'NOT FOUND (using process env)'}`)
  console.log(`  Port                : ${config.port}`)
  console.log(keyLine('YouTube API key', youtube))
  console.log(keyLine('Gemini API key', gemini))
  console.log(`  Model               : ${gemini.model}`)
  console.log(`  Gemini API version  : ${gemini.apiVersion}`)
  console.log(
    `  Thinking budget     : ${gemini.thinkingBudget === null ? 'not sent (model default)' : gemini.thinkingBudget}`
  )
  console.log(`  Comment cap         : ${config.comments.max}`)
  console.log(`  Batch size          : ${gemini.batchSize}  |  concurrency: ${gemini.concurrency}`)

  // Quota maths: every analysis costs one call per batch plus one synthesis.
  // The Gemini free tier allows only a handful of requests per day per model,
  // so this number decides how many analyses a key can do per day.
  const worstCaseBatches = Math.ceil(config.comments.max / gemini.batchSize)
  console.log(
    `  Gemini calls/run    : ${worstCaseBatches} batch + 1 synthesis = ${worstCaseBatches + 1} (worst case, ${config.comments.max} comments)`
  )
  console.log(`  Cache TTL           : ${config.cache.ttlMs}ms`)
  console.log('  --------------------------------------------')

  const malformed = [
    ['YOUTUBE_API_KEY', youtube],
    ['GEMINI_API_KEY', gemini],
  ].filter(([, key]) => !key.looksValid)

  for (const [name, key] of malformed) {
    console.error(
      `\n  !! ${name} in server/.env is malformed: ${key.problems.join('; ')}\n` +
        '     Put only the key value in the file - no quotes, no "Bearer ", no spaces,\n' +
        '     and not the whole "NAME=value" line. Any prefix/format is accepted.\n'
    )
  }
}

// The extension is loaded from chrome-extension://<id>, which is a unique origin
// each install, so CORS has to be permissive. There are no cookies and no auth
// in V1, and both API keys stay on this server.
app.use(cors())
app.use(express.json({ limit: '100kb' }))

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'skipthescroll-server',
    message: 'SkipTheScroll API. POST /api/analyze with { "videoId": "..." }',
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'skipthescroll-server',
    uptimeSeconds: Math.round(process.uptime()),
    commentCap: config.comments.max,
    model: config.gemini.model,
    geminiApiVersion: config.gemini.apiVersion,
    thinkingBudget: config.gemini.thinkingBudget,
    // Fingerprints only - enough to prove which key is loaded, useless if stolen.
    keys: {
      youtube: `sha256:${config.youtube.fingerprint}`,
      gemini: `sha256:${config.gemini.fingerprint}`,
    },
  })
})

app.use('/api', analyzeRoutes)

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}.` },
  })
})

// Central error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)

  // Malformed JSON body from express.json()
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
    })
  }

  if (isApiError(err)) {
    if (err.status >= 500) console.error(`[skipthescroll] ${err.code}: ${err.message}`)
    return res.status(err.status).json({
      ok: false,
      error: { code: err.code, message: err.message, hint: err.hint || null },
    })
  }

  console.error('[skipthescroll] Unhandled error:', err)
  res.status(500).json({
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on the SkipTheScroll server.',
      hint: config.isProd ? null : String(err?.message || err),
    },
  })
})

const server = app.listen(config.port, () => {
  console.log(`\n  SkipTheScroll server listening on http://localhost:${config.port}\n`)
  logStartup()

  // Prove the model + key combination works before a user tries to analyse.
  // Non-blocking, and never prevents the server from starting.
  if (config.gemini.startupCheck) {
    verifyGeminiSetup().catch(() => {})
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[skipthescroll] ${signal} received, shutting down.`)
    server.close(() => process.exit(0))
  })
}
