// Offline smoke test for the pure backend utils (no API keys needed).
// Run: node scripts/smoke-utils.mjs
import { validateVideoId, extractVideoId, isValidVideoId } from '../src/utils/validateVideoId.js'
import { cleanComments, cleanText } from '../src/utils/cleanComments.js'
import { chunk, mapWithConcurrency } from '../src/utils/arrays.js'
import { withRetry } from '../src/utils/retry.js'
import { buildAllInOnePrompt, FINAL_SCHEMA, ALLOWED_VERDICTS } from '../src/prompts/allInOnePrompt.js'

let failed = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${e}\n      got      ${a}`}`)
}

function checkThrows(name, fn, code) {
  try {
    fn()
    failed += 1
    console.log(`FAIL  ${name} (did not throw)`)
  } catch (err) {
    const ok = err.code === code
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -> ${err.code}`)
  }
}

/* --------------------------- validateVideoId --------------------------- */
check('raw id accepted', validateVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
check('watch url', validateVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ')
check('shorts url', extractVideoId('https://youtube.com/shorts/abcdefghijk'), 'abcdefghijk')
check('youtu.be url', extractVideoId('https://youtu.be/abcdefghijk?t=10'), 'abcdefghijk')
check('embed url', extractVideoId('https://www.youtube.com/embed/abcdefghijk'), 'abcdefghijk')
check('non-youtube url', extractVideoId('https://vimeo.com/abcdefghijk'), null)
check('too short id', isValidVideoId('abc'), false)
checkThrows('empty body id', () => validateVideoId(''), 'VIDEO_ID_MISSING')
checkThrows('garbage id', () => validateVideoId('not-a-video-id'), 'VIDEO_ID_INVALID')
checkThrows('non-youtube link', () => validateVideoId('https://vimeo.com/12345678901'), 'VIDEO_ID_INVALID')

/* ----------------------------- cleanComments ----------------------------- */
const thread = (text, likes = 0, replies = []) => ({
  snippet: {
    totalReplyCount: replies.length,
    topLevelComment: {
      id: `c${likes}`,
      snippet: {
        authorDisplayName: 'tester',
        authorChannelId: 'UC_x',
        textDisplay: text,
        likeCount: likes,
        publishedAt: '2025-01-02T03:04:05Z',
      },
    },
    replies: replies.map((r, i) => ({
      snippet: { authorDisplayName: `r${i}`, textDisplay: r, likeCount: 0, publishedAt: '2025-01-02T03:04:05Z' },
    })),
  },
})

check('strips tags + entities', cleanText('<b>Step 2</b> run &amp; test &#39;now&#39;'), "Step 2 run & test 'now'")

const { comments, stats } = cleanComments(
  [
    thread('This worked perfectly for me on Windows 11 after following every step in the video', 40, ['Same here, thanks!']),
    thread('nice'),                                   // too short -> dropped
    thread('Does not work on macOS Sonoma, the installer fails silently every time I try', 12),
    thread('https://spam.example https://more.spam', 1), // spam -> dropped
    thread('This worked perfectly for me on Windows 11 after following every step in the video', 40), // dupe -> dropped
    thread('  ', 5),                                  // empty -> dropped
  ],
  { maxComments: 500, maxReplies: 5 }
)

check('kept 2 usable comments', comments.length, 2)
check('sorted by likes desc', comments[0].likes, 40)
check('captures replies', comments[0].replies.length, 1)
check('stats.dropped (empty + too short)', stats.dropped, 2)
check('stats.duplicates', stats.duplicates, 1)
check('stats.spam', stats.spam, 1)
check('capped at maxComments', cleanComments([thread('a'.repeat(40), 5)], { maxComments: 1 }).comments.length, 1)
check('contact bait filtered', cleanComments([thread('whatsapp me on 9999999999 bro its a secret deal')], { maxComments: 5 }).comments.length, 0)

/* -------------------------------- arrays -------------------------------- */
check('chunks', chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
check(
  'mapWithConcurrency keeps order + survives failure',
  await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom')
    return n * 10
  }),
  [10, null, 30]
)

/* -------------------------------- retry --------------------------------- */
let attempts = 0
const retried = await withRetry(
  async () => {
    attempts += 1
    const err = new Error('flaky')
    err.code = 'GROQ_SERVER_ERROR'
    if (attempts < 3) throw err
    return 'ok'
  },
  { retries: 3, baseDelayMs: 1 }
)
check('withRetry recovers', [retried, attempts], ['ok', 3])

let failFast = 0
try {
  await withRetry(
    async () => {
      failFast += 1
      const err = new Error('bad request')
      err.code = 'VIDEO_ID_INVALID'
      throw err
    },
    { retries: 3, baseDelayMs: 1 }
  )
} catch {
  /* expected */
}
check('withRetry does not retry 4xx', failFast, 1)

/* -------------------------------- prompts -------------------------------- */
const video = {
  title: 'How to fix your PC in 10 minutes',
  channel: 'Tech Channel',
  publishedAt: '2023-04-01T00:00:00Z',
  duration: 'PT10M',
  commentCount: 4310,
}

const allInOne = buildAllInOnePrompt({
  video,
  comments,
  stats: {
    threadsFetched: 500,
    commentsAnalyzed: 500,
    droppedTotal: 12,
    maxLikes: 4211,
    withReplies: 88,
    replyComments: 213,
    successSignals: 61,
    failureSignals: 18,
    oldestCommentAt: '2023-05-01T00:00:00Z',
    newestCommentAt: '2025-01-02T03:04:05Z',
    batchesAnalyzed: 1,
    batchesRequested: 1,
  },
})
check('all-in-one prompt includes comment text', allInOne.prompt.includes('installer fails silently'), true)
check('all-in-one prompt includes video info', allInOne.prompt.includes('How to fix your PC in 10 minutes'), true)
check('all-in-one prompt includes hard stats', allInOne.prompt.includes('Threads analysed after cleaning: 500'), true)
check('all-in-one prompt has injection warning', allInOne.system.includes('UNTRUSTED DATA'), true)
check('all-in-one prompt warns against speculation', allInOne.system.includes('speculation'), true)
check('all-in-one prompt lists allowed verdicts', ALLOWED_VERDICTS.includes('insufficient evidence'), true)
check('all-in-one prompt asks for one schema shape', allInOne.prompt.includes('Return ONLY the JSON object described by the schema'), true)

// Long comments must be truncated so the whole set stays inside the token budget.
const longComment = { author: 'x', text: 'w'.repeat(1200), likes: 1, publishedAt: null, replies: [], flags: {} }
const longPrompt = buildAllInOnePrompt({ video, comments: [longComment], stats: {} })
check('long comments are truncated (ellipsis, full text dropped)', longPrompt.prompt.includes('…') && !longPrompt.prompt.includes('w'.repeat(1200)), true)
check('schema is the final verdict shape', FINAL_SCHEMA.properties.verdict.type, 'STRING')

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
