const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#039': "'",
  nbsp: ' ',
  hellip: '...',
  mdash: '-',
  ndash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
}

const MIN_COMMENT_LENGTH = 8
const MAX_COMMENT_LENGTH = 1200
const MAX_REPLY_LENGTH = 400

const CONTACT_PATTERNS = [
  /whats\s*app/i,
  /wa\.?me/i,
  /\+\d{2}[\s-]?\d{3}[\s-]?\d{4}/,
  /t\.me\//i,
  /telegram/i,
  /dm\s+me\b/i,
]

const PROMO_PATTERNS = [
  /\bmy course\b/i,
  /\bbuy (?:my|our)\b/i,
  /\bpromo ?code\b/i,
  /\bdiscount (?:code|link)\b/i,
  /\buse code\b/i,
  /\bincredible tools?\b/i,
  /\bfiverr\b/i,
]

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase()
    if (HTML_ENTITIES[key]) return HTML_ENTITIES[key]
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return match
  })
}

/** HTML -> plain text, collapse whitespace, trim, clamp length. */
export function cleanText(raw, { maxLength = MAX_COMMENT_LENGTH } = {}) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ')
  text = decodeEntities(text)
  text = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  if (text.length > maxLength) text = `${text.slice(0, maxLength).trimEnd()}...`
  return text
}

function looksLikeSpam(text) {
  const letters = (text.match(/[a-z]/gi) || []).length
  if (letters < 4) return true
  const links = text.match(/https?:\/\/|www\./gi) || []
  if (links.length >= 2 && letters < 40) return true
  if (CONTACT_PATTERNS.some((re) => re.test(text))) return true
  return false
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Normalises one comment thread (top level comment + a few replies) into the
 * shape the prompts and the extension understand.
 */
export function normalizeThread(thread, { maxReplies = 5 } = {}) {
  const snippet = thread?.snippet?.topLevelComment?.snippet || {}
  const text = cleanText(snippet.textDisplay || snippet.textOriginal || '')
  if (!text) return null

  const replies = []
  const replyItems = thread?.snippet?.replies || []
  for (const reply of replyItems.slice(0, maxReplies)) {
    const replySnippet = reply?.snippet || {}
    const replyText = cleanText(replySnippet.textDisplay || replySnippet.textOriginal || '', {
      maxLength: MAX_REPLY_LENGTH,
    })
    if (!replyText || replyText.length < 3) continue
    replies.push({
      author: replySnippet.authorDisplayName || 'unknown',
      text: replyText,
      likes: toNumber(replySnippet.likeCount),
      publishedAt: replySnippet.publishedAt || null,
      flags: buildFlags(replyText),
    })
  }

  return {
    id: thread?.snippet?.topLevelComment?.id || null,
    author: snippet.authorDisplayName || 'unknown',
    authorIsChannelOwner: snippet.authorChannelId
      ? thread?.snippet?.authorChannelId === snippet.authorChannelId
      : false,
    text,
    likes: toNumber(snippet.likeCount),
    publishedAt: snippet.publishedAt || null,
    replyCount: toNumber(thread?.snippet?.totalReplyCount),
    flags: buildFlags(text),
    replies,
  }
}

function buildFlags(text) {
  return {
    hasLink: /https?:\/\/|www\./i.test(text),
    looksPromotional: PROMO_PATTERNS.some((re) => re.test(text)),
    mentionsContact: CONTACT_PATTERNS.some((re) => re.test(text)),
    mentionsQuestion: text.includes('?'),
  }
}

/**
 * Cleans the raw thread list returned by YouTube:
 *  - drops empty / tiny / spam-looking comments
 *  - de-duplicates identical text
 *  - sorts by likes (desc) so the highest-signal comments survive the cap
 *
 * @returns {{comments: object[], stats: object}}
 */
export function cleanComments(rawThreads, options = {}) {
  const { maxComments = 500, maxReplies = 5, minLength = MIN_COMMENT_LENGTH } = options

  const normalized = []
  let dropped = 0
  let duplicates = 0
  let spam = 0

  for (const thread of rawThreads || []) {
    const comment = normalizeThread(thread, { maxReplies })
    if (!comment) {
      dropped += 1
      continue
    }
    if (comment.text.length < minLength) {
      dropped += 1
      continue
    }
    if (looksLikeSpam(comment.text)) {
      spam += 1
      continue
    }
    normalized.push(comment)
  }

  // Highest liked first: the most agreed-upon experiences survive truncation.
  normalized.sort((a, b) => b.likes - a.likes)

  const seen = new Set()
  const deduped = []
  for (const comment of normalized) {
    const key = comment.text.toLowerCase().slice(0, 120)
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    deduped.push(comment)
    if (deduped.length >= maxComments) break
  }

  return {
    comments: deduped,
    stats: {
      raw: (rawThreads || []).length,
      kept: deduped.length,
      dropped,
      duplicates,
      spam,
      maxLikes: deduped.reduce((max, c) => Math.max(max, c.likes), 0),
      withReplies: deduped.filter((c) => c.replies.length > 0).length,
    },
  }
}
