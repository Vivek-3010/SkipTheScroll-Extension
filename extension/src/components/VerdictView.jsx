import { formatCount } from '../lib/youtube.js'
import { getConfidenceTone, getStatusTone, getVerdictTone } from '../lib/constants.js'

/* ------------------------------ small pieces ------------------------------ */

function Section({ title, icon, count, children, tone = 'text-slate-500' }) {
  return (
    <section className="border-t border-slate-100 px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon}
        <h3 className={['text-[11px] font-semibold uppercase tracking-wide', tone].join(' ')}>{title}</h3>
        {count > 0 && (
          <span className="rounded-full bg-slate-100 px-1.5 py-px text-[9px] font-semibold text-slate-500">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

function Bullets({ items, renderItem }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-1.5 text-[11px] leading-relaxed text-slate-700">
          <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-slate-300" />
          <span className="min-w-0">{renderItem ? renderItem(item) : item}</span>
        </li>
      ))}
    </ul>
  )
}

function MentionBadge({ count }) {
  if (!count || count < 2) return null
  return (
    <span className="ml-1 rounded bg-slate-100 px-1 py-px align-middle text-[9px] font-semibold text-slate-500">
      ×{count}
    </span>
  )
}

const ICONS = {
  issue: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 8v5m0 3h.01M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  fix: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  time: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 9v4m0 4h.01M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z" strokeLinecap="round" />
    </svg>
  ),
  conflict: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-sky-500" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 8h13l-3-3m9 11H7l3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  gap: (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.9-.9 1.5v.2" strokeLinecap="round" />
      <path d="M12 16.8h.01" strokeLinecap="round" />
    </svg>
  ),
}

/* ------------------------------ verdict view ------------------------------ */

export default function VerdictView({ data, onReanalyze, onReset, busy = false }) {
  if (!data) return null

  const analysis = data.analysis || {}
  const stats = data.stats || {}
  const meta = data.meta || {}
  const video = data.video || {}

  const tone = getVerdictTone(analysis.verdict)
  const status = getStatusTone(analysis.status)
  const confidence = Number(analysis.confidence) || 0
  const doesItWork =
    analysis.doesItWork || (tone.label === 'Insufficient evidence' ? 'Not enough evidence' : 'Unclear')

  const commentsAnalyzed = stats.commentsAnalyzed || 0
  const totalComments = stats.commentCountOnYouTube || video.commentCount || 0
  const signalTotal = (stats.successSignals || 0) + (stats.failureSignals || 0)

  return (
    <div className="sts-in">
      {/* Verdict hero */}
      <div className="bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Community verdict
          </span>
          <span
            className={['rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ring-1', status.chip].join(' ')}
            title={status.label}
          >
            {status.label}
          </span>
        </div>

        <div className="mt-1.5 flex items-center gap-2">
          <span className={['h-2.5 w-2.5 rounded-full', tone.dot].join(' ')} />
          <h2 className="text-[20px] font-bold leading-tight tracking-tight text-slate-900">
            {tone.label}
          </h2>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-slate-50 px-2.5 py-2 ring-1 ring-slate-200">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">Does it work?</p>
            <p className="mt-0.5 text-[13px] font-bold text-slate-900">{doesItWork}</p>
          </div>
          <div className="rounded-lg bg-slate-50 px-2.5 py-2 ring-1 ring-slate-200">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">Community confidence</p>
            <p className="mt-0.5 text-[13px] font-bold text-slate-900">{confidence}%</p>
          </div>
        </div>

        {/* Confidence meter */}
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className={['h-full rounded-full transition-all', getConfidenceTone(confidence)].join(' ')}
              style={{ width: `${Math.max(2, Math.min(100, confidence))}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
            <span>
              {formatCount(commentsAnalyzed)} of {formatCount(totalComments)} comments analysed
            </span>
            <span>
              {stats.successSignals || 0}✓ / {stats.failureSignals || 0}✗ signals
            </span>
          </div>
          {stats.truncated && (
            <p className="mt-1 text-[10px] leading-relaxed text-amber-700">
              Top {formatCount(commentsAnalyzed)} comments only (V1 limit is 500). Rare minority experiences may be
              missing.
            </p>
          )}
        </div>
      </div>

      {/* Summary */}
      <div className="border-t border-slate-100 bg-white px-4 py-3">
        <p className="text-[12px] leading-relaxed text-slate-800">{analysis.summary}</p>
        {analysis.confidenceReason && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
            <span className="font-semibold">Why this confidence: </span>
            {analysis.confidenceReason}
          </p>
        )}
      </div>

      {/* Common issues */}
      {(analysis.commonIssues?.length > 0 || analysis.helpfulFixes?.length > 0) && (
        <>
          {analysis.commonIssues?.length > 0 && (
            <Section title="Common issues" icon={ICONS.issue} count={analysis.commonIssues.length}>
              <Bullets
                items={analysis.commonIssues}
                renderItem={(issue) => (
                  <>
                    {issue.issue}
                    <MentionBadge count={issue.mentions} />
                  </>
                )}
              />
            </Section>
          )}

          {analysis.helpfulFixes?.length > 0 && (
            <Section title="Fixes people say worked" icon={ICONS.fix} count={analysis.helpfulFixes.length}>
              <Bullets
                items={analysis.helpfulFixes}
                renderItem={(fix) => (
                  <>
                    {fix.fix}
                    <MentionBadge count={fix.mentions} />
                  </>
                )}
              />
            </Section>
          )}
        </>
      )}

      {/* Timestamps */}
      {analysis.timestamps?.length > 0 && (
        <Section title="Important timestamps" icon={ICONS.time} count={analysis.timestamps.length}>
          <ul className="space-y-1.5">
            {analysis.timestamps.map((item, index) => (
              <li key={index} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-700">
                <code className="shrink-0 rounded bg-indigo-50 px-1 py-px font-mono text-[10px] font-semibold text-indigo-700 ring-1 ring-indigo-100">
                  {item.time}
                </code>
                <span className="min-w-0">{item.note || 'Referenced by a commenter.'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Warnings */}
      {analysis.warnings?.length > 0 && (
        <Section title="Warnings" icon={ICONS.warn} count={analysis.warnings.length} tone="text-amber-700">
          <Bullets
            items={analysis.warnings}
            renderItem={(warning) => (
              <span className="rounded bg-amber-50 px-1 py-px text-amber-900">{warning}</span>
            )}
          />
        </Section>
      )}

      {/* Conflicts */}
      {analysis.conflictingOpinions?.length > 0 && (
        <Section title="Conflicting opinions" icon={ICONS.conflict} count={analysis.conflictingOpinions.length}>
          <Bullets items={analysis.conflictingOpinions} />
        </Section>
      )}

      {/* Evidence gaps / limitations - never hide uncertainty */}
      {analysis.evidenceGaps?.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-2.5">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold text-slate-500 hover:text-slate-700">
              {ICONS.gap}
              What this analysis could not determine
              <span className="sts-pulse ml-auto text-[10px] text-slate-400 group-open:hidden">
                +{analysis.evidenceGaps.length}
              </span>
            </summary>
            <div className="mt-1.5">
              <Bullets items={analysis.evidenceGaps} />
            </div>
          </details>
        </div>
      )}

      {/* Footer meta */}
      <div className="border-t border-slate-100 bg-white px-4 py-2.5">
        <p className="text-[10px] leading-relaxed text-slate-400">
          {signalTotal} first-hand signal{signalTotal === 1 ? '' : 's'} detected
          {stats.maxLikes ? ` | top comment had ${formatCount(stats.maxLikes)} likes` : ''}
          {meta.tookMs ? ` | took ${(meta.tookMs / 1000).toFixed(1)}s` : ''}
          {meta.model ? ` | ${meta.model}` : ''}
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
          Verdict from community experience only. A popular comment is an anecdote, not proof.
        </p>

        <div className="mt-2 flex gap-2">
          {onReanalyze && (
            <button
              type="button"
              onClick={onReanalyze}
              disabled={busy}
              className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {busy ? 'Analyzing...' : 'Analyze again'}
            </button>
          )}
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg bg-white px-3 py-2 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50"
            >
              New video
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
