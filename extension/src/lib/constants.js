/**
 * Shared constants for the popup. Backend location can be overridden at build
 * time with VITE_API_BASE_URL (see extension/.env.example in the README).
 */

const rawBase =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL) ||
  'http://localhost:5178'

export const API_BASE_URL = String(rawBase).replace(/\/+$/, '')

/** Hard V1 limit, mirrored from the server so the UI can explain itself. */
export const MAX_COMMENTS = 500

export const VIDEO_INFO_TIMEOUT_MS = 20_000
export const ANALYSIS_TIMEOUT_MS = 180_000

/** Progress copy shown while the server works. */
export const STAGES = [
  {
    key: 'fetch',
    label: 'Fetching comments...',
    hint: 'Pulling up to 500 top comments from YouTube.',
  },
  {
    key: 'analyze',
    label: 'Analyzing community feedback...',
    hint: 'Looking for repeated patterns across comments, not one-liners.',
  },
  {
    key: 'verdict',
    label: 'Generating verdict...',
    hint: 'Combining batch insights into a single community verdict.',
  },
]

export const STAGE_INTERVAL_MS = 3500

export const LOADING_TIP =
  'Tip: the whole analysis runs on your local SkipTheScroll server. First run can take 30-60 seconds.'

/** Tailwind class sets. Written out in full so Tailwind keeps them. */
export const VERDICT_TONES = {
  works: {
    label: 'Works',
    chip: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    bar: 'bg-emerald-500',
    dot: 'bg-emerald-500',
  },
  'mostly works': {
    label: 'Mostly works',
    chip: 'bg-teal-100 text-teal-800 ring-teal-200',
    bar: 'bg-teal-500',
    dot: 'bg-teal-500',
  },
  'mixed results': {
    label: 'Mixed results',
    chip: 'bg-amber-100 text-amber-900 ring-amber-200',
    bar: 'bg-amber-500',
    dot: 'bg-amber-500',
  },
  'often fails': {
    label: 'Often fails',
    chip: 'bg-orange-100 text-orange-900 ring-orange-200',
    bar: 'bg-orange-500',
    dot: 'bg-orange-500',
  },
  'does not work': {
    label: 'Does not work',
    chip: 'bg-rose-100 text-rose-800 ring-rose-200',
    bar: 'bg-rose-500',
    dot: 'bg-rose-500',
  },
  unclear: {
    label: 'Unclear',
    chip: 'bg-slate-200 text-slate-700 ring-slate-300',
    bar: 'bg-slate-400',
    dot: 'bg-slate-400',
  },
  'insufficient evidence': {
    label: 'Insufficient evidence',
    chip: 'bg-slate-200 text-slate-700 ring-slate-300',
    bar: 'bg-slate-400',
    dot: 'bg-slate-400',
  },
}

export const FALLBACK_TONE = VERDICT_TONES.unclear

export function getVerdictTone(verdict) {
  const key = String(verdict || '').toLowerCase().trim()
  return VERDICT_TONES[key] || FALLBACK_TONE
}

export function getConfidenceTone(confidence) {
  const value = Number(confidence) || 0
  if (value >= 75) return 'bg-emerald-500'
  if (value >= 50) return 'bg-amber-500'
  if (value >= 25) return 'bg-orange-500'
  return 'bg-slate-300'
}

export function getStatusTone(status) {
  const value = String(status || '').toLowerCase()
  if (!value || value === 'unknown') {
    return { chip: 'bg-slate-100 text-slate-600 ring-slate-200', label: 'Status unknown' }
  }
  if (value.includes('clearly')) {
    return { chip: 'bg-rose-100 text-rose-700 ring-rose-200', label: status }
  }
  if (value.includes('possibly')) {
    return { chip: 'bg-amber-100 text-amber-800 ring-amber-200', label: status }
  }
  if (value.includes('outdated') && !value.includes('not')) {
    return { chip: 'bg-orange-100 text-orange-800 ring-orange-200', label: status }
  }
  if (value.includes('still') || value.includes('relevant') || value.includes('current')) {
    return { chip: 'bg-emerald-100 text-emerald-700 ring-emerald-200', label: status }
  }
  return { chip: 'bg-slate-100 text-slate-600 ring-slate-200', label: status }
}
