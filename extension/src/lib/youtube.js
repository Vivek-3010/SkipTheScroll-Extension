/**
 * YouTube URL helpers. No API key, no scraping - just the active tab URL.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/
const WATCH_RE = /[?&]v=([A-Za-z0-9_-]{11})/
const PATH_RE = /\/(?:shorts|embed|v|live|e)\/([A-Za-z0-9_-]{11})/
const SHORT_RE = /youtu\.be\/([A-Za-z0-9_-]{11})/

export function isYouTubeHost(hostname) {
  if (!hostname) return false
  const host = String(hostname).toLowerCase()
  return (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtu.be' ||
    host.endsWith('.youtu.be') ||
    host === 'm.youtube.com'
  )
}

/** Returns the 11 character video ID for a YouTube URL, or null. */
export function parseVideoId(url) {
  if (typeof url !== 'string' || !url) return null
  if (VIDEO_ID_RE.test(url)) return url

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!isYouTubeHost(parsed.hostname)) return null

  for (const pattern of [WATCH_RE, PATH_RE, SHORT_RE]) {
    const match = parsed.href.match(pattern)
    if (match) return match[1]
  }
  return null
}

/** Human readable comment count: 1234 -> "1.2K comments" */
export function formatCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function formatDuration(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}:${String(seconds % 60).padStart(2, '0')}`
  const hours = Math.floor(mins / 60)
  return `${hours}:${String(mins % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** Falls back to a YouTube thumbnail that is guaranteed to exist. */
export function fallbackThumbnail(videoId) {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null
}
