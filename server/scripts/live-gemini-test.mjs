/**
 * Live Gemini validation: runs the REAL batch + final prompts against a real
 * video's worth of synthetic comments, so prompt quality and structured output
 * can be checked without spending YouTube quota.
 *
 * ENV_FILE must point at an env file whose GEMINI_MODEL still has free-tier
 * quota (the allowance is per model).
 */
import { config } from '../src/config/env.js'
import { analyzeBatch, synthesizeFinalAnalysis } from '../src/services/gemini.service.js'

const MODEL = config.gemini.model
console.log(`\n=== LIVE GEMINI TEST (model: ${MODEL}, api: ${config.gemini.apiVersion}) ===`)
console.log(`thinkingConfig: ${config.gemini.thinkingBudget === null ? 'not sent' : config.gemini.thinkingBudget}\n`)

const video = {
  id: 'test1234567',
  title: 'How to fix a Wi-Fi router that keeps dropping (Windows 11, 2024)',
  channel: 'TechHowTo',
  publishedAt: '2024-03-11T00:00:00.000Z',
  duration: 'PT14M22S',
  commentCount: 480,
}

/** Deliberately messy, realistic comments: jargon, timestamps, conflicts, spam. */
const comments = [
  {
    author: 'Ravi K',
    text: 'Worked for me on Windows 11, took about 5 minutes. The part at 4:20 is the key, I had missed that step completely.',
    likes: 214,
    publishedAt: '2024-03-12T10:00:00.000Z',
    replies: [],
  },
  {
    author: 'anon_4412',
    text: 'didnt work for me at all, router still drops every 20 mins. i have the exact same TP-Link model.',
    likes: 88,
    publishedAt: '2024-03-12T12:00:00.000Z',
    replies: [],
  },
  {
    author: 'Marta',
    text: 'This fixed it! Cleared the DNS cache then rebooted the modem. Been stable for 6 days now.',
    likes: 156,
    publishedAt: '2024-03-13T09:30:00.000Z',
    replies: [],
  },
  {
    author: 'DevinS',
    text: 'Careful: the DNS flush command shown at 6:05 is the old Windows 10 one. On 11 you need an elevated terminal or it silently fails. That is probably why the linux users in the replies say it breaks.',
    likes: 341,
    publishedAt: '2024-03-14T15:20:00.000Z',
    replies: [],
  },
  {
    author: 'quietfan99',
    text: 'Worked but only temporarily. It broke again after a firmware update about a week later, so this is a band-aid not a real fix.',
    likes: 97,
    publishedAt: '2024-03-15T11:45:00.000Z',
    replies: [],
  },
  {
    author: 'Sam T',
    text: 'The 4:20 step is the actual fix, everything else in the video is fluff. Verified on two different routers.',
    likes: 62,
    publishedAt: '2024-03-16T08:10:00.000Z',
    replies: [],
  },
  {
    author: 'promo_hunter',
    text: 'BEST DEAL ON ROUTERS!!! Visit my channel for 90% off!!!',
    likes: 0,
    publishedAt: '2024-03-16T08:11:00.000Z',
    replies: [],
  },
  {
    author: 'Yuki',
    text: 'I am on Linux and there is no ipconfig /flushdns equivalent that works the same way. The video does not cover this at all.',
    likes: 74,
    publishedAt: '2024-03-17T19:00:00.000Z',
    replies: [],
  },
]

const stats = {
  commentsAnalyzed: comments.length,
  commentCountOnYouTube: video.commentCount,
  truncated: true,
  droppedTotal: 1,
  droppedShort: 0,
  droppedSpam: 1,
  batchesAnalyzed: 1,
  batchesRequested: 1,
  batchSize: config.gemini.batchSize,
  threadsFetched: comments.length,
}

console.log(`Running 1 real batch call over ${comments.length} comments...`)
const startedAt = Date.now()
const batch = await analyzeBatch({ video, comments, batchIndex: 0, batchCount: 1 })
console.log(`Batch call finished in ${Date.now() - startedAt}ms\n`)

console.log('--- BATCH FINDINGS (normalised) ---')
console.log(JSON.stringify(batch, null, 2))

const missing = ['successPatterns', 'failurePatterns', 'commonIssues', 'helpfulFixes', 'timestamps'].filter(
  (key) => !Array.isArray(batch[key])
)
console.log(`\nArray fields intact: ${missing.length === 0 ? 'yes' : `NO -> ${missing.join(', ')}`}`)
console.log(`Evidence gaps reported by the model: ${batch.evidenceGaps.length}`)

console.log(`\nRunning 1 real final synthesis call...`)
const finalStartedAt = Date.now()
let analysis
try {
  analysis = await synthesizeFinalAnalysis({ video, batches: [batch], stats })
  console.log(`Final call finished in ${Date.now() - finalStartedAt}ms\n`)
} catch (err) {
  // The batch pass above is the important half. A quota block on this second
  // call must not look like a failed test run.
  console.log(`\n!! Final synthesis call failed: ${err.code || 'UNKNOWN'}`)
  console.log(`   ${String(err.message).slice(0, 300)}`)
  if (err.hint) console.log(`   hint: ${err.hint}`)
  console.log('\n=== BATCH PASS SUCCEEDED, FINAL PASS BLOCKED ===')
  console.log('    In the real pipeline this falls back to a deterministic merge of the')
  console.log('    batch findings (meta.source = "gemini-partial") instead of failing.\n')
  process.exit(0)
}

console.log('--- FINAL ANALYSIS (what the popup renders) ---')
console.log(JSON.stringify(analysis, null, 2))

const REQUIRED = ['verdict', 'doesItWork', 'confidence', 'summary', 'commonIssues', 'helpfulFixes', 'timestamps', 'status', 'warnings', 'conflictingOpinions']
console.log('\n--- CONTRACT CHECK ---')
for (const key of REQUIRED) {
  const value = analysis[key]
  const ok = value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0 && key !== 'warnings')
  console.log(`  ${ok ? 'OK  ' : 'MISS'} ${key}${Array.isArray(value) ? ` (${value.length})` : ''}`)
}

const ALLOWED = ['works', 'mostly works', 'mixed results', 'often fails', 'does not work', 'unclear', 'insufficient evidence']
console.log(`\n  verdict "${analysis.verdict}" is a known value: ${ALLOWED.includes(analysis.verdict)}`)
console.log(`  confidence in 0..100: ${analysis.confidence >= 0 && analysis.confidence <= 100}`)
console.log(`\n=== DONE (model ${MODEL}) ===`)
