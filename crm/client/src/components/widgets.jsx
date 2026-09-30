import { Link } from 'react-router-dom'
import { Empty } from './ui.jsx'
import { money, relativeDate, shortDate, num, pct } from './format.js'

/* "Sep – Nov" rather than "next 3 months": the window runs in whole calendar
 * months, so a deal three weeks out can sit outside it and look like a bug. */
function monthRange(start, end) {
  const fmt = (d) => new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(d))
  const last = new Date(end)
  last.setDate(0)
  return `${fmt(start)} – ${fmt(last)}`
}
import { LineChart } from './charts.jsx'

/* Dashboard widgets. Each one renders whatever its server builder returned and
 * is responsible for its own empty state — a dashboard full of blank cards is
 * worse than one that says why. */

function Stat({ label, value, sub, hot, ok }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 24, color: hot ? 'var(--danger)' : ok ? 'var(--ok)' : undefined }}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function MiniList({ rows, empty }) {
  if (!rows.length) return <div className="small faint" style={{ padding: '10px 0' }}>{empty}</div>
  return (
    <div className="col" style={{ gap: 0 }}>
      {rows.map((r, i) => (
        <div key={r.key || i} className="row" style={{
          padding: '8px 0', gap: 10,
          borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="truncate" style={{ fontSize: 13 }}>{r.title}</div>
            {r.sub && <div className="small faint truncate">{r.sub}</div>}
          </div>
          {r.right && <div className="small nowrap" style={{ textAlign: 'right' }}>{r.right}</div>}
        </div>
      ))}
    </div>
  )
}

export const WIDGETS = {
  my_work: ({ data }) => (
    <div className="grid grid-2" style={{ gap: 14 }}>
      <Stat label="Overdue" value={num(data.overdue)} hot={data.overdue > 0} sub="past their due date" />
      <Stat label="Due today" value={num(data.dueToday)} sub="on the clock now" />
      <Stat label="Drafts to approve" value={num(data.drafts)} sub="emails ready to send" />
      <Stat label="Done today" value={num(data.doneToday)} ok={data.doneToday > 0} sub="tasks completed" />
      {data.quotesPending > 0 && (
        <div style={{ gridColumn: '1 / -1' }}>
          <Link className="btn btn-sm btn-block" to="/quotes?status=pending_approval">
            {data.quotesPending} quote{data.quotesPending === 1 ? '' : 's'} waiting on approval →
          </Link>
        </div>
      )}
    </div>
  ),

  forecast_summary: ({ data }) => (
    <>
      <div className="grid grid-2" style={{ gap: 14 }}>
        <Stat label="Commit" value={money(data.commit, data.currency, { compact: true })} ok sub="reps say this lands" />
        <Stat label="Best case" value={money(data.commit + data.bestCase, data.currency, { compact: true })} sub="commit + upside" />
        <Stat label="Weighted" value={money(data.weighted, data.currency, { compact: true })} sub="the statistical view" />
        <Stat label="Already won" value={money(data.won, data.currency, { compact: true })} sub={`${num(data.wonCount)} closed`} />
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        {data.windowStart && data.windowEnd
          ? <>Deals closing {monthRange(data.windowStart, data.windowEnd)}.</>
          : <>Next {data.months} months.</>}
        {data.beyond > 0 && (
          <> {data.beyond} open deal{data.beyond === 1 ? ' closes' : 's close'} later than that.</>
        )}
        {data.undated > 0 && (
          <> <Link to="/deals?view=table">{data.undated} {data.undated === 1 ? 'has' : 'have'} no close date at all</Link> and
          {data.undated === 1 ? ' is' : ' are'} missing from every number here.</>
        )}
      </div>
    </>
  ),

  pipeline_by_stage: ({ data }) => {
    const max = Math.max(1, ...data.stages.map((s) => s.tcvUsd))
    if (!data.stages.some((s) => s.count > 0)) {
      return <Empty icon="💼" title="No open deals">Deals appear here as soon as you create one.</Empty>
    }
    return (
      <div className="col" style={{ gap: 8 }}>
        {data.stages.map((s) => (
          <div className="row" key={s.key} style={{ gap: 10, alignItems: 'center' }}>
            <div className="small truncate" style={{ width: 130, flex: '0 0 130px' }}>
              <span className="pill-dot" style={{ background: s.color, display: 'inline-block', marginRight: 6 }} />
              {s.name}
            </div>
            <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <div style={{ height: 20, width: `${Math.max(1, (s.tcvUsd / max) * 100)}%`, minWidth: 3,
                background: s.color, borderRadius: 4, opacity: 0.28 }} />
              <div style={{ position: 'absolute', top: 0, left: 0, height: 20,
                width: `${Math.max(0, (s.weightedUsd / max) * 100)}%`, background: s.color, borderRadius: 4 }} />
            </div>
            <div className="small nowrap right" style={{ width: 92, flex: '0 0 92px' }}>
              <div className="strong">{money(s.tcvUsd, data.currency, { compact: true })}</div>
              <div className="faint" style={{ fontSize: 11 }}>{s.count} deal{s.count === 1 ? '' : 's'}</div>
            </div>
          </div>
        ))}
        <div className="hint">Solid is weighted value; the faded bar behind it is the full value.</div>
      </div>
    )
  },

  my_deals: ({ data }) => (
    <MiniList
      empty="You have no open deals."
      rows={data.deals.map((d) => ({
        key: d._id,
        title: <Link to={`/deals/${d._id}`}>{d.name}</Link>,
        sub: [d.company, d.expectedCloseDate ? `closes ${relativeDate(d.expectedCloseDate)}` : 'no close date']
          .filter(Boolean).join(' · '),
        right: (
          <>
            <div className="strong">{money(d.tcvUsd, data.currency, { compact: true })}</div>
            <div className="faint" style={{ fontSize: 11 }}>{d.probability}%</div>
          </>
        ),
      }))}
    />
  ),

  stale_deals: ({ data }) => (
    <>
      <MiniList
        empty={`Nothing has gone quiet for ${data.cutoffDays}+ days.`}
        rows={data.deals.map((d) => ({
          key: d._id,
          title: <Link to={`/deals/${d._id}`}>{d.name}</Link>,
          sub: [d.company, d.owner].filter(Boolean).join(' · '),
          right: (
            <>
              <div style={{ color: 'var(--warn)' }}>{relativeDate(d.lastActivityAt)}</div>
              <div className="faint" style={{ fontSize: 11 }}>{money(d.tcvUsd, data.currency, { compact: true })}</div>
            </>
          ),
        }))}
      />
      {data.total > data.deals.length && (
        <div className="hint">{data.total - data.deals.length} more not shown.</div>
      )}
    </>
  ),

  quotes_pending: ({ data }) => (
    <>
      <div className="grid grid-2" style={{ gap: 14, marginBottom: 12 }}>
        <Stat label="Awaiting approval" value={num(data.pendingCount)} hot={data.pendingCount > 0}
          sub={data.canApprove ? 'waiting on you' : 'waiting on an admin'} />
        <Stat label="With the client" value={num(data.awaitingClient)}
          sub={data.unopened > 0 ? `${data.unopened} not opened yet` : 'all opened'} />
      </div>
      <MiniList
        empty="Nothing waiting for approval."
        rows={data.pending.map((q) => ({
          key: q._id,
          title: <Link to={`/quotes/${q._id}`}>{q.number}</Link>,
          sub: [q.company, ...(q.reasons || [])].filter(Boolean).join(' · '),
          right: <div className="strong">{money(q.tcv, q.currency, { compact: true })}</div>,
        }))}
      />
    </>
  ),

  recent_wins: ({ data }) => (
    <>
      <div className="grid grid-2" style={{ gap: 14, marginBottom: 10 }}>
        <Stat label="Won in 30 days" value={money(data.totalUsd, data.currency, { compact: true })} ok
          sub={`${num(data.count)} deal${data.count === 1 ? '' : 's'}`} />
        <Stat label="New MRR" value={money(data.mrrUsd, data.currency, { compact: true })} sub="recurring, per month" />
      </div>
      <MiniList
        empty="No wins in the last 30 days."
        rows={data.deals.map((d) => ({
          key: d._id,
          title: <Link to={`/deals/${d._id}`}>{d.name}</Link>,
          sub: [d.company, d.owner].filter(Boolean).join(' · '),
          right: (
            <>
              <div className="strong" style={{ color: 'var(--ok)' }}>{money(d.tcvUsd, data.currency, { compact: true })}</div>
              <div className="faint" style={{ fontSize: 11 }}>{shortDate(d.wonAt)}</div>
            </>
          ),
        }))}
      />
    </>
  ),

  channel_performance: ({ data }) => {
    const labels = { linkedin: 'LinkedIn', email: 'Email', call: 'Cold call' }
    if (!data.rows.some((r) => r.touches > 0)) {
      return <Empty icon="⇄" title="No touches logged">Complete some tasks and this fills in.</Empty>
    }
    return (
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Channel</th><th className="right">Touches</th><th className="right">Responses</th><th className="right">Rate</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.channel}>
                <td><span className={`chan chan-${r.channel}`}>{labels[r.channel]}</span></td>
                <td className="right">{num(r.touches)}</td>
                <td className="right">{num(r.responses)}</td>
                <td className="right strong">{pct(r.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="hint" style={{ padding: '8px 0 0' }}>Last {data.days} days.</div>
      </div>
    )
  },

  leaderboard: ({ data }) => (
    <MiniList
      empty="Nothing to compare yet."
      rows={data.rows.map((r) => ({
        key: r.id,
        title: r.name,
        sub: `${r.meetings} meeting${r.meetings === 1 ? '' : 's'} booked`,
        right: (
          <>
            <div className="strong">{money(r.wonUsd, data.currency, { compact: true })}</div>
            <div className="faint" style={{ fontSize: 11 }}>{r.wins} won</div>
          </>
        ),
      }))}
    />
  ),

  activity_trend: ({ data }) => {
    if (!data.weeks.length) return <Empty icon="📈" title="No activity logged yet" />
    return (
      <LineChart
        series={data.weeks}
        keys={[{ key: 'touches', label: 'Touches logged', color: 'var(--accent)' }]}
        height={160}
      />
    )
  },

  my_contacts: ({ data }) => (
    <>
      <MiniList
        empty={`Nothing of yours has been untouched for ${data.cutoffDays}+ days.`}
        rows={data.contacts.map((c) => ({
          key: c._id,
          title: <Link to={`/contacts/${c._id}`}>{c.name}</Link>,
          sub: c.company,
          right: <div className="faint">{relativeDate(c.lastActivityAt)}</div>,
        }))}
      />
      {data.total > data.contacts.length && (
        <div className="hint">{data.total - data.contacts.length} more not shown.</div>
      )}
    </>
  ),

  calendar: ({ data }) => {
    if (!data.embedUrl) {
      return (
        <Empty icon="📅" title="No calendar connected">
          Paste your Google or Outlook calendar link in{' '}
          <Link to="/settings">Settings → My profile</Link> and it appears here.
        </Empty>
      )
    }
    return (
      <>
        <iframe
          title="My calendar"
          src={data.embedUrl}
          style={{ width: '100%', height: 420, border: 0, borderRadius: 'var(--radius-sm)' }}
          /* Read-only embed of a third-party page: deny it everything it does
             not need, and do not give it access back to this origin. */
          sandbox="allow-scripts allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
        <div className="hint">
          Read-only. The CRM cannot see these events, so it can't warn about clashes or attach
          meetings to deals.
        </div>
      </>
    )
  },
}
