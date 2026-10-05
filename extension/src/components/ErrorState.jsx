export default function ErrorState({ error, title = 'Analysis failed', onRetry, onReset, retryLabel = 'Try again' }) {
  const message = error?.message || 'Something went wrong.'
  const hint = error?.hint
  const code = error?.code

  return (
    <div className="sts-in px-4 py-4">
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
        <div className="flex items-start gap-2">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5M12 16h.01" strokeLinecap="round" />
          </svg>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-rose-900">{title}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-rose-800">{message}</p>
            {hint && <p className="mt-1.5 text-[11px] leading-relaxed text-rose-700/90">{hint}</p>}
            {code && (
              <code className="mt-2 inline-block rounded bg-white/70 px-1.5 py-0.5 text-[10px] text-rose-700 ring-1 ring-rose-200">
                {code}
              </code>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            {retryLabel}
          </button>
        )}
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            Back
          </button>
        )}
      </div>
    </div>
  )
}
