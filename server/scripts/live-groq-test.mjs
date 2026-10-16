/**
 * Live AI validation: runs the REAL single-pass analysis prompt against a fixed
 * set of deliberately messy synthetic comments with your REAL Groq key, so the
 * prompt quality, structured output and the token budget (free tier ~8k/min)
 * can be checked without spending YouTube quota.
 *
 *   npm run test:live
 *
 * Costs ONE real AI call and no YouTube calls. Uses a fixed single-request-sized
 * sample of comments (60) so the request fits the free-tier budget. The pipeline
 * itself reads every fetched comment by splitting larger sections into batches;
 * this only validates one request's prompt + schema. Set GROQ_MODEL in
 * server/.env first if your current model is rate limited.
 */
import { config } from '../src/config/env.js'
import { analyzeAllAtOnce } from '../src/services/groq.service.js'

const MODEL = config.groq.model
// One request has to fit the free-tier budget, so the live prompt check uses a
// single-request-sized sample rather than the full (now batched) fetch cap.
const SAMPLE = Math.min(config.comments.max, 60)
console.log(`\n=== LIVE AI TEST (model: ${MODEL}) ===`)
console.log(`max_tokens: ${config.groq.maxTokens} (shared with reasoning; reasoning_effort=low)`)
console.log(`sample size: ${SAMPLE} comments in ONE request (the pipeline batches larger sections)\n`)

const video = {
  id: 'test1234567',
  title: 'How to fix a Wi-Fi router that keeps dropping (Windows 11, 2024)',
  channel: 'TechHowTo',
  publishedAt: '2024-03-11T00:00:00.000Z',
  duration: 'PT14M22S',
  commentCount: 480,
}

const now = Date.now()
const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString()

/** Deliberately messy, realistic comments: jargon, timestamps, conflicts, spam. */
const handWritten = [
  {
    author: 'Ravi K',
    text: 'Worked for me on Windows 11, took about 5 minutes. The part at 4:20 is the key, I had missed that step completely.',
    likes: 214,
    publishedAt: daysAgo(10),
    replies: [],
  },
  {
    author: 'anon_4412',
    text: 'didnt work for me at all, router still drops every 20 mins. i have the exact same TP-Link model.',
    likes: 88,
    publishedAt: daysAgo(9),
    replies: [],
  },
  {
    author: 'Marta',
    text: 'This fixed it! Cleared the DNS cache then rebooted the modem. Been stable for 6 days now.',
    likes: 156,
    publishedAt: daysAgo(8),
    replies: [],
  },
  {
    author: 'LinuxDad',
    text: 'Does not work on Linux - there is no exact ipconfig /flushdns equivalent. The video only covers Windows.',
    likes: 71,
    publishedAt: daysAgo(7),
    replies: [],
  },
  {
    author: 'DevinS',
    text: 'Careful: the DNS flush command shown at 6:05 is the old Windows 10 one. On 11 you need an elevated terminal or it silently fails. That is probably why the linux users in the replies say it breaks.',
    likes: 341,
    publishedAt: daysAgo(6),
    replies: [],
  },
  {
    author: 'quietfan99',
    text: 'Worked but only temporarily. It broke again after a firmware update about a week later, so this is a band-aid not a real fix.',
    likes: 97,
    publishedAt: daysAgo(5),
    replies: [],
  },
  {
    author: 'Sam T',
    text: 'The 4:20 step is the actual fix, everything else in the video is fluff. Verified on two different routers.',
    likes: 62,
    publishedAt: daysAgo(4),
    replies: [],
  },
  {
    author: 'promo_hunter',
    text: 'BEST DEAL ON ROUTERS!!! Visit my channel for 90% off!!!',
    likes: 0,
    publishedAt: daysAgo(4),
    replies: [],
  },
  {
    author: 'Yuki',
    text: 'I am on Linux and there is no ipconfig /flushdns equivalent that works the same way. The video does not cover this at all.',
    likes: 74,
    publishedAt: daysAgo(3),
    replies: [],
  },
]

// Pad up to the sample size with realistic-length variants (including
// near-the-limit long ones) so the live request exercises the real worst-case
// token budget for a single call.
const LONG = `Very long detailed report: the fix worked for me after I also disabled the power management option ${'for the adapter in Device Manager, because without that step the connection kept dropping every few minutes even after clearing the DNS cache and rebooting both the modem and the router. Definitely do that part too. '.repeat(3)}`
const comments = []
for (let i = 0; comments.length < SAMPLE; i += 1) {
  const seed = handWritten[i % handWritten.length]
  comments.push({
    ...seed,
    author: `${seed.author}_${Math.floor(i / handWritten.length)}`,
    // Sprinkle long comments and one reply-thread comment to stress the budget.
    text: i % 13 === 0 ? LONG : seed.text,
    replies:
      i === 0
        ? [{ author: 'reply_guy', text: 'Same result here, it also worked on my Dell after restarting', likes: 3, publishedAt: daysAgo(2) }]
        : [],
    publishedAt: daysAgo(Math.max(1, 15 - i)),
  })
}

const stats = {
  commentsAnalyzed: comments.length,
  commentCountOnYouTube: video.commentCount,
  truncated: true,
  droppedTotal: 1,
  droppedShort: 0,
  droppedSpam: 1,
  batchesAnalyzed: 1,
  batchesRequested: 1,
  batchSize: comments.length,
  threadsFetched: comments.length,
  successSignals: 25,
  failureSignals: 8,
  maxLikes: 341,
  withReplies: 1,
  replyComments: 1,
  oldestCommentAt: comments[comments.length - 1]?.publishedAt || '',
  newestCommentAt: comments[0]?.publishedAt || '',
}

console.log(`Running 1 real analysis call over ${comments.length} comments...`)
const startedAt = Date.now()
let analysis
try {
  analysis = await analyzeAllAtOnce({ video, comments, stats })
} catch (err) {
  console.log(`\n!! Analysis call failed: ${err.code || 'UNKNOWN'} (HTTP ${err.status || '?'})`)
  console.log(`   ${String(err.message).slice(0, 400)}`)
  if (err.hint) console.log(`   hint: ${err.hint}`)
  console.log('\n   If the code is GROQ_RATE_LIMIT, the per-minute token budget is full:')
  console.log('   wait a minute and re-run. If it is GROQ_QUOTA_EXCEEDED, the key ran out of credits.')
  process.exit(1)
}
console.log(`Analysis call finished in ${Date.now() - startedAt}ms\n`)

console.log('--- FINAL ANALYSIS (what the popup renders) ---')
console.log(JSON.stringify(analysis, null, 2))

const REQUIRED = [
  'verdict',
  'doesItWork',
  'confidence',
  'summary',
  'commonIssues',
  'helpfulFixes',
  'timestamps',
  'status',
  'warnings',
  'conflictingOpinions',
]
console.log('\n--- CONTRACT CHECK ---')
for (const key of REQUIRED) {
  const value = analysis[key]
  const ok =
    value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0 && key !== 'warnings')
  console.log(`  ${ok ? 'OK  ' : 'MISS'} ${key}${Array.isArray(value) ? ` (${value.length})` : ''}`)
}

const ALLOWED = [
  'works',
  'mostly works',
  'mixed results',
  'often fails',
  'does not work',
  'unclear',
  'insufficient evidence',
]
console.log(`\n  verdict "${analysis.verdict}" is a known value: ${ALLOWED.includes(analysis.verdict)}`)
console.log(`  confidence in 0..100: ${analysis.confidence >= 0 && analysis.confidence <= 100}`)
const missing = REQUIRED.some(
  (key) => analysis[key] === undefined || analysis[key] === null || (Array.isArray(analysis[key]) && analysis[key].length === 0 && key !== 'warnings')
)
console.log(`\n${missing ? 'CONTRACT BROKEN - fix the prompt/schema' : `CONTRACT OK (1 AI call, ${comments.length} comments, sample ${SAMPLE})`}`)
console.log(`=== DONE (model ${MODEL}) ===`)
process.exit(missing ? 1 : 0)