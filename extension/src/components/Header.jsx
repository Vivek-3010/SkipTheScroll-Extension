export function Logo({ className = 'h-6 w-6' }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="stsLogo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a21caf" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="32" height="32" rx="9" fill="url(#stsLogo)" />
      <path
        d="M16 6.5v11.5m0 0 5-5m-5 5-5-5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 25.5h17"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.75"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function Header() {
  return (
    <header className="flex items-start gap-2.5 border-b border-slate-200 bg-white px-4 py-3">
      <Logo className="mt-0.5 h-7 w-7 shrink-0" />
      <div className="min-w-0">
        <h1 className="text-[15px] font-bold leading-tight tracking-tight text-slate-900">
          SkipTheScroll
        </h1>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
          Skip thousands of comments. Get the answer in seconds.
        </p>
      </div>
    </header>
  )
}
