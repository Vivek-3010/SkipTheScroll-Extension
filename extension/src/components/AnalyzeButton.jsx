import { MAX_COMMENTS } from '../lib/constants.js'

export default function AnalyzeButton({ onClick, disabled = false, loading = false, label = 'Analyze Comments' }) {
  return (
    <div className="bg-white px-4 pb-4 pt-3">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-indigo-600 to-fuchsia-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:from-indigo-500 hover:to-fuchsia-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:from-indigo-600 disabled:hover:to-fuchsia-600"
      >
        {loading ? (
          <>
            <svg viewBox="0 0 24 24" className="sts-spinner h-4 w-4" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            Analyzing...
          </>
        ) : (
          <>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="10" strokeOpacity="0.35" />
          </svg>
            {label}
          </>
        )}
      </button>
      <p className="mt-1.5 text-center text-[10px] text-slate-400">
        Reads every comment (up to {MAX_COMMENTS}). Runs on your own local server.
      </p>
    </div>
  )
}
