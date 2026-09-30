/* Small hand-rolled SVG charts. No charting dependency — these three shapes
 * are all the reports need, and they inherit the theme's CSS variables so
 * they read correctly in light and dark. */

const CHANNEL_COLOR = {
  linkedin: 'var(--linkedin)',
  email: 'var(--email)',
  call: 'var(--call)',
}

export function FunnelChart({ stages }) {
  if (!stages?.length) return null
  const max = Math.max(...stages.map((s) => s.entered), 1)

  return (
    <div className="col" style={{ gap: 2 }}>
      {stages.map((s, i) => {
        const width = Math.max(2, (s.entered / max) * 100)
        const dropped = i < stages.length - 1 ? s.dropOff : null
        return (
          <div key={s.index}>
            <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
              <div className="small" style={{ width: 150, flex: '0 0 150px' }}>
                <span className="strong truncate" style={{ display: 'block' }}>{s.name}</span>
                <span className="faint" style={{ fontSize: 11 }}>{s.channel}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    height: 30, width: `${width}%`, minWidth: 46,
                    background: CHANNEL_COLOR[s.channel] || 'var(--accent)',
                    borderRadius: 5, display: 'flex', alignItems: 'center',
                    paddingLeft: 9, color: '#fff', fontSize: 12.5, fontWeight: 650,
                  }}
                >
                  {s.entered.toLocaleString()}
                </div>
              </div>
              <div className="small right" style={{ width: 96, flex: '0 0 96px' }}>
                {s.shareOfStart != null && <span className="faint">{s.shareOfStart}% of start</span>}
              </div>
            </div>
            {s.stepConversion != null && (
              <div className="row" style={{ paddingLeft: 160, height: 20, gap: 8 }}>
                <span className="small" style={{ color: dropped > 0 ? 'var(--danger)' : 'var(--text-faint)' }}>
                  ↓ {s.stepConversion}% went on to the next stage
                  {dropped > 0 && ` · ${dropped.toLocaleString()} stopped here`}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function LineChart({ series, keys, height = 190 }) {
  if (!series?.length) return <div className="small faint">Not enough data yet.</div>

  const w = 720
  const h = height
  const pad = { top: 12, right: 12, bottom: 26, left: 34 }
  const max = Math.max(1, ...series.flatMap((p) => keys.map((k) => p[k.key] || 0)))
  const single = series.length === 1
  const stepX = single ? 0 : (w - pad.left - pad.right) / (series.length - 1)
  // A single bucket pinned to the left axis reads as a rendering fault.
  const x = (i) => (single ? (pad.left + w - pad.right) / 2 : pad.left + i * stepX)
  const y = (v) => pad.top + (1 - v / max) * (h - pad.top - pad.bottom)

  const ticks = [0, Math.round(max / 2), max]

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Trend over time">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={w - pad.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--text-faint)">{t}</text>
          </g>
        ))}
        {keys.map((k) => (
          <g key={k.key}>
            {!single && (
              <polyline
                fill="none" stroke={k.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                points={series.map((p, i) => `${x(i)},${y(p[k.key] || 0)}`).join(' ')}
              />
            )}
            {series.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p[k.key] || 0)} r={single ? 4 : 2.6} fill={k.color}>
                <title>{`${k.label}: ${p[k.key] || 0}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {series.map((p, i) => {
          // Thin the labels so they never overlap on a long range.
          const every = Math.ceil(series.length / 8)
          if (i % every !== 0) return null
          return (
            <text key={i} x={x(i)} y={h - 8} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
              {new Date(p.bucket).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </text>
          )
        })}
      </svg>
      <div className="row wrap" style={{ gap: 14, marginTop: 6 }}>
        {keys.map((k) => (
          <span key={k.key} className="small row" style={{ gap: 5 }}>
            <span style={{ width: 10, height: 3, background: k.color, borderRadius: 2 }} />
            {k.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function GroupedBars({ rows, bars, labelKey = 'label' }) {
  if (!rows?.length) return <div className="small faint">No data in this range.</div>
  const max = Math.max(1, ...rows.flatMap((r) => bars.map((b) => r[b.key] || 0)))

  return (
    <div className="col" style={{ gap: 12 }}>
      {rows.map((row, i) => (
        <div key={i}>
          <div className="small strong" style={{ marginBottom: 5 }}>{row[labelKey]}</div>
          <div className="col" style={{ gap: 4 }}>
            {bars.map((b) => (
              <div className="row" key={b.key} style={{ gap: 8 }}>
                <span className="small faint" style={{ width: 96, flex: '0 0 96px' }}>{b.label}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      height: 16, width: `${Math.max(1.5, ((row[b.key] || 0) / max) * 100)}%`,
                      background: b.color, borderRadius: 4, minWidth: 3,
                    }}
                  />
                </div>
                <span className="small strong right" style={{ width: 60, flex: '0 0 60px' }}>
                  {(row[b.key] || 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Donut({ slices, size = 132 }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (!total) return <div className="small faint">No data.</div>

  const r = size / 2 - 12
  const c = 2 * Math.PI * r
  let offset = 0

  return (
    <div className="row" style={{ gap: 16, alignItems: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Breakdown">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {slices.map((s, i) => {
            const len = (s.value / total) * c
            const el = (
              <circle
                key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={s.color} strokeWidth="16"
                strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
              >
                <title>{`${s.label}: ${s.value}`}</title>
              </circle>
            )
            offset += len
            return el
          })}
        </g>
        <text x="50%" y="50%" textAnchor="middle" dy="5" fontSize="17" fontWeight="650" fill="var(--text)">
          {total.toLocaleString()}
        </text>
      </svg>
      <div className="col" style={{ gap: 3 }}>
        {slices.map((s, i) => (
          <div key={i} className="row small" style={{ gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flex: '0 0 9px' }} />
            <span style={{ flex: 1 }}>{s.label}</span>
            <span className="strong">{s.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* Horizontal value bars for the pipeline. Deliberately not the campaign
 * FunnelChart: a pipeline stage is not a funnel step you drop out of, and
 * sizing bars by deal count hides the fact that one Contract-stage deal can
 * outweigh twenty in Discovery. */
export function ValueBars({ rows, currency, format }) {
  if (!rows?.length) return <div className="small faint">No open deals.</div>
  const max = Math.max(1, ...rows.map((r) => r.value))

  return (
    <div className="col" style={{ gap: 9 }}>
      {rows.map((r) => (
        <div className="row" key={r.key} style={{ gap: 10, alignItems: 'center' }}>
          <div className="small" style={{ width: 165, flex: '0 0 165px' }}>
            <span className="pill-dot" style={{ background: r.color, display: 'inline-block', marginRight: 6 }} />
            <span className="strong">{r.name}</span>
            <div className="faint" style={{ fontSize: 11, marginLeft: 12 }}>
              {r.count} deal{r.count === 1 ? '' : 's'} · {r.probability}%
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            <div style={{
              height: 26, width: `${Math.max(1, (r.value / max) * 100)}%`, minWidth: 4,
              background: r.color, borderRadius: 5, opacity: 0.28,
            }} />
            {/* The weighted bar sits inside the total, so the gap between them
                is visible at a glance rather than needing two charts. */}
            <div style={{
              position: 'absolute', top: 0, left: 0,
              height: 26, width: `${Math.max(0, (r.weighted / max) * 100)}%`,
              background: r.color, borderRadius: 5,
            }} />
          </div>
          <div className="right nowrap" style={{ width: 150, flex: '0 0 150px' }}>
            <div className="strong small">{format(r.value, currency, { compact: true })}</div>
            <div className="faint" style={{ fontSize: 11 }}>
              {format(r.weighted, currency, { compact: true })} weighted
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export { CHANNEL_COLOR }
