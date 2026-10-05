import { useEffect, useState } from 'react'
import { LOADING_TIP, STAGES, STAGE_INTERVAL_MS } from '../lib/constants.js'

export default function LoadingState({ videoTitle }) {
  const [stageIndex, setStageIndex] = useState(0)
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const stageTimer = setInterval(() => {
      setStageIndex((index) => Math.min(index + 1, STAGES.length - 1))
    }, STAGE_INTERVAL_MS)
    return () => clearInterval(stageTimer)
  }, [])

  useEffect(() => {
    const tick = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(tick)
  }, [])

  const stage = STAGES[stageIndex]

  return (
    <div className="sts-in space-y-3 px-4 py-4">
      <div className="flex items-center gap-2.5">
        <svg viewBox="0 0 24 24" className="sts-spinner h-5 w-5 text-indigo-600" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
          <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <p className="text-[13px] font-semibold text-slate-900">{stage.label}</p>
      </div>

      <div className="space-y-1.5">
        {STAGES.map((item, index) => {
          const done = index < stageIndex
          const active = index === stageIndex
          return (
            <div key={item.key} className="flex items-start gap-2">
              <span
                className={[
                  'mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ring-1',
                  done
                    ? 'bg-emerald-500 text-white ring-emerald-500'
                    : active
                      ? 'sts-pulse bg-indigo-600 text-white ring-indigo-600'
                      : 'bg-white text-slate-400 ring-slate-300',
                ].join(' ')}
              >
                {done ? '✓' : index + 1}
              </span>
              <span className={active ? 'text-[11px] text-slate-700' : 'text-[11px] text-slate-400'}>
                {item.label}
                {active && <span className="text-slate-400"> {item.hint}</span>}
              </span>
            </div>
          )
        })}
      </div>

      <div className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
        <p className="text-[10px] leading-relaxed text-slate-500">
          {videoTitle ? `Analysing comments on "${videoTitle}".` : 'Analysing comments.'}{' '}
          {seconds}s elapsed.
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{LOADING_TIP}</p>
      </div>
    </div>
  )
}
