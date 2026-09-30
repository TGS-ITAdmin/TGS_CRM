import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Channel, Empty, Loading } from '../components/ui.jsx'
import { CHANNEL_COLOR, Donut, FunnelChart, GroupedBars, LineChart, ValueBars } from '../components/charts.jsx'
import { num, pct, shortDate, money, monthLabel } from '../components/format.js'

const TABS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'forecast', label: 'Forecast' },
  { key: 'funnel', label: 'Outreach funnel' },
  { key: 'channels', label: 'Channels' },
  { key: 'reps', label: 'Reps' },
  { key: 'scoreboard', label: 'Scoreboard' },
]

const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 12 months', days: 365 },
]

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
}

export default function Reports() {
  const { can } = useAuth()
  const isAdmin = can('reports.viewTeam')
  const toast = useToast()
  const [params, setParams] = useSearchParams()

  const tab = params.get('tab') || 'pipeline'
  const campaign = params.get('campaign') || ''
  const days = Number(params.get('days')) || 30

  const [campaigns, setCampaigns] = useState([])
  const [summary, setSummary] = useState(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const set = (patch) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k)
      else next.set(k, String(v))
    }
    setParams(next)
  }

  useEffect(() => {
    api.listCampaigns().then((d) => setCampaigns(d.campaigns)).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const range = { from: isoDaysAgo(days) }
    try {
      const [sum, main] = await Promise.all([
        api.reportSummary(range),
        tab === 'pipeline'
          ? api.reportPipeline(range)
          : tab === 'forecast'
          ? api.reportForecast({ months: 6 })
          : tab === 'funnel'
          ? campaign
            ? api.reportFunnel({ ...range, campaign })
            : Promise.resolve(null)
          : tab === 'channels'
          ? api.reportChannels({ ...range, campaign: campaign || undefined })
          : tab === 'reps'
          ? api.reportReps(range)
          : api.reportScoreboard({ ...range, campaign: campaign || undefined, unit: days <= 14 ? 'day' : 'week' }),
      ])
      setSummary(sum)
      setData(main)
    } catch (err) {
      toast.error(err.message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [tab, campaign, days]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Reports</h1>
          <div className="topbar-sub">
            {summary ? `${shortDate(summary.range.from)} – ${shortDate(summary.range.to)}` : 'Loading…'}
            {!isAdmin && ' · your contacts only'}
          </div>
        </div>
        <div className="spacer" />
        <select className="select" style={{ maxWidth: 150 }} value={days} onChange={(e) => set({ days: e.target.value })}>
          {PRESETS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
        </select>
        <select className="select" style={{ maxWidth: 230 }} value={campaign} onChange={(e) => set({ campaign: e.target.value })}>
          <option value="">{tab === 'funnel' ? 'Pick a campaign…' : 'All campaigns'}</option>
          {campaigns.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
        </select>
      </div>

      <div className="page">
        {summary && (
          <div className="grid grid-3" style={{ marginBottom: 18 }}>
            <div className="stat">
              <div className="stat-label">Contacts</div>
              <div className="stat-value">{num(summary.totalContacts)}</div>
              <div className="stat-sub">+{num(summary.newContacts)} added in range</div>
            </div>
            <div className="stat">
              <div className="stat-label">In campaigns</div>
              <div className="stat-value">{num(summary.activeEnrollments)}</div>
              <div className="stat-sub">active enrollments</div>
            </div>
            <div className="stat">
              <div className="stat-label">Touches</div>
              <div className="stat-value">{num(summary.touches)}</div>
              <div className="stat-sub">emails, messages and calls</div>
            </div>
            <div className="stat">
              <div className="stat-label">Open pipeline</div>
              <div className="stat-value">
                {money(summary.pipeline?.tcvUsd ?? 0, summary.reportingCurrency, { compact: true })}
              </div>
              <div className="stat-sub">
                {num(summary.pipeline?.openCount ?? 0)} deals ·{' '}
                {money(summary.pipeline?.weightedUsd ?? 0, summary.reportingCurrency, { compact: true })} weighted
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Won in range</div>
              <div className="stat-value" style={{ color: 'var(--ok)' }}>
                {money(summary.won?.tcvUsd ?? 0, summary.reportingCurrency, { compact: true })}
              </div>
              <div className="stat-sub">{num(summary.won?.count ?? 0)} deals closed</div>
            </div>
            <div className="stat">
              <div className="stat-label">Meetings booked</div>
              <div className="stat-value" style={{ color: 'var(--ok)' }}>{num(summary.meetings)}</div>
              <div className="stat-sub">
                {summary.touches > 0 && summary.meetings > 0
                  ? `${Math.round(summary.touches / summary.meetings)} touches each`
                  : 'none yet'}
              </div>
            </div>
          </div>
        )}

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => set({ tab: t.key })}>
              {t.label}
            </button>
          ))}
        </div>

        {loading ? <Loading /> : (
          <>
            {tab === 'pipeline' && <PipelineReport data={data} />}
            {tab === 'forecast' && <ForecastReport data={data} />}
            {tab === 'funnel' && <FunnelReport data={data} campaign={campaign} />}
            {tab === 'channels' && <ChannelsReport data={data} />}
            {tab === 'reps' && <RepsReport data={data} />}
            {tab === 'scoreboard' && <Scoreboard data={data} />}
          </>
        )}
      </div>
    </>
  )
}

/* -------------------------------------------------------------- */

function FunnelReport({ data, campaign }) {
  if (!campaign) {
    return (
      <div className="card">
        <Empty icon="⚑" title="Pick a campaign">
          The funnel shows how many contacts entered each stage of one campaign, and where they dropped off.
        </Empty>
      </div>
    )
  }
  if (!data) return null
  if (data.topOfFunnel === 0) {
    return (
      <div className="card">
        <Empty icon="◔" title="Nobody has entered this campaign yet">
          Add contacts to it and the funnel fills in as they move through.{' '}
          <Link to="/contacts">Go to contacts →</Link>
        </Empty>
      </div>
    )
  }

  const worst = [...data.stages]
    .filter((s) => s.stepConversion != null && s.entered >= 5)
    .sort((a, b) => a.stepConversion - b.stepConversion)[0]

  return (
    <div className="col" style={{ gap: 14 }}>
      {worst && worst.stepConversion < 60 && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            Your biggest drop-off is at <strong>{worst.name}</strong> — only {worst.stepConversion}% of the{' '}
            {num(worst.entered)} contacts that reached it moved on. That stage's message is the one worth rewriting.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>{data.campaign.name} — stage by stage</h2>
          <span className="small faint">{num(data.topOfFunnel)} contacts started</span>
        </div>
        <div className="card-body">
          <FunnelChart stages={data.stages} />
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 320px', alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h2 style={{ flex: 1 }}>The numbers</h2>
            <span className="small faint">counted per enrollment</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th><th>Stage</th><th>Channel</th><th className="right">Reached</th>
                  <th className="right">Here now</th><th className="right">Went on</th>
                  <th className="right">Step conv.</th><th className="right">Stopped</th>
                  <th className="right">Jumped in</th>
                </tr>
              </thead>
              <tbody>
                {data.stages.map((s) => (
                  <tr key={s.index}>
                    <td className="faint">{s.index + 1}</td>
                    <td className="strong">{s.name}</td>
                    <td><Channel value={s.channel} /></td>
                    <td className="right">{num(s.entered)}</td>
                    <td className="right">{num(s.currentlyHere)}</td>
                    <td className="right">{num(s.advancedToNext)}</td>
                    <td className="right strong"
                      style={{ color: s.stepConversion != null && s.stepConversion < 50 ? 'var(--danger)' : undefined }}>
                      {pct(s.stepConversion)}
                    </td>
                    <td className="right faint">{s.stepConversion == null ? '—' : num(s.dropOff)}</td>
                    <td className="right faint">{s.enteredOutOfSequence ? num(s.enteredOutOfSequence) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-body" style={{ paddingTop: 0 }}>
            <div className="hint">
              <strong>Step conv.</strong> is a cohort measure — of the contacts that reached this stage, the
              share that later reached the next one. <strong>Jumped in</strong> counts contacts that arrived
              at a stage without passing through the one before it, because someone moved them by hand.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Where they ended up</h2></div>
          <div className="card-body">
            <Donut slices={data.outcomes.map((o) => ({ label: o.label, value: o.n, color: o.color }))} />
            <div className="hint" style={{ marginTop: 12 }}>
              Current status of every contact that has ever been in this campaign.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- */

function ChannelsReport({ data }) {
  if (!data) return null
  const anyData = data.rows.some((r) => r.touches > 0)
  if (!anyData) {
    return (
      <div className="card">
        <Empty icon="⇄" title="No touches logged in this range">
          Complete some tasks and send some emails — this report compares what each channel actually returns.
        </Empty>
      </div>
    )
  }

  const best = [...data.rows].filter((r) => r.meetings > 0).sort((a, b) => (b.meetingRate || 0) - (a.meetingRate || 0))[0]

  return (
    <div className="col" style={{ gap: 14 }}>
      {best && (
        <div className="banner banner-ok">
          <span>✓</span>
          <div>
            <strong>{best.channel === 'call' ? 'Cold calling' : best.channel === 'email' ? 'Email' : 'LinkedIn'}</strong>{' '}
            is converting best right now — {pct(best.meetingRate)} of contacts touched booked a meeting, at{' '}
            {best.touchesPerMeeting} touches per meeting.
          </div>
        </div>
      )}

      <div className="grid grid-3">
        {data.rows.map((r) => (
          <div className="card" key={r.channel}>
            <div className="card-head">
              <Channel value={r.channel} />
              <div className="spacer" />
              <span className="small faint">{num(r.touches)} touches</span>
            </div>
            <div className="card-body">
              <div className="stat-label">Meetings booked</div>
              <div className="stat-value" style={{ color: CHANNEL_COLOR[r.channel] }}>{num(r.meetings)}</div>
              <div className="divider" style={{ margin: '12px 0' }} />
              <div className="col" style={{ gap: 6 }}>
                <div className="row small"><span style={{ flex: 1 }} className="faint">Contacts touched</span><span className="strong">{num(r.contactsTouched)}</span></div>
                <div className="row small"><span style={{ flex: 1 }} className="faint">Responses</span><span className="strong">{num(r.responses)}</span></div>
                <div className="row small"><span style={{ flex: 1 }} className="faint">Response rate</span><span className="strong">{pct(r.responseRate)}</span></div>
                <div className="row small"><span style={{ flex: 1 }} className="faint">Meeting rate</span><span className="strong">{pct(r.meetingRate)}</span></div>
                <div className="row small"><span style={{ flex: 1 }} className="faint">Touches per meeting</span><span className="strong">{r.touchesPerMeeting ?? '—'}</span></div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head"><h2>Side by side</h2></div>
        <div className="card-body">
          <GroupedBars
            labelKey="label"
            rows={data.rows.map((r) => ({
              label: r.channel === 'call' ? 'Cold call' : r.channel === 'email' ? 'Email' : 'LinkedIn',
              touches: r.touches, responses: r.responses, meetings: r.meetings,
            }))}
            bars={[
              { key: 'touches', label: 'Touches', color: 'var(--border-strong)' },
              { key: 'responses', label: 'Responses', color: 'var(--accent)' },
              { key: 'meetings', label: 'Meetings', color: 'var(--ok)' },
            ]}
          />
          <div className="hint" style={{ marginTop: 14 }}>{data.note}</div>
          {data.unattributedMeetings > 0 && (
            <div className="hint">
              {data.unattributedMeetings} meeting{data.unattributedMeetings === 1 ? '' : 's'} could not be
              attributed to a channel — no touch was logged before the booking.
            </div>
          )}
          {(data.emailIssues.email_failed || data.emailIssues.email_suppressed) && (
            <div className="banner banner-warn" style={{ marginTop: 12 }}>
              <span>⚠</span>
              <div>
                {data.emailIssues.email_failed ? `${data.emailIssues.email_failed} email(s) failed to send. ` : ''}
                {data.emailIssues.email_suppressed ? `${data.emailIssues.email_suppressed} were blocked by the do-not-contact list.` : ''}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- */

function RepsReport({ data }) {
  if (!data) return null
  if (!data.rows.length) return <div className="card"><Empty icon="👥" title="No users to report on" /></div>

  const totalOverdue = data.rows.reduce((s, r) => s + r.tasksOverdue, 0)

  return (
    <div className="col" style={{ gap: 14 }}>
      {totalOverdue > 0 && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            <strong>{num(totalOverdue)} tasks are overdue</strong> across the team. Overdue counts are live,
            not filtered by the date range.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Per rep</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Rep</th><th className="right">Touches</th><th className="right">LinkedIn</th>
                <th className="right">Email</th><th className="right">Calls</th>
                <th className="right">Contacts touched</th><th className="right">Meetings</th>
                <th className="right">Conv.</th><th className="right">Tasks done</th>
                <th className="right">Overdue</th><th className="right">Owns</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.user.id}>
                  <td>
                    <span className="strong">{r.user.name}</span>
                    <div className="small faint">{r.user.role === 'admin' ? 'Admin' : 'Rep'} · {r.user.timezone}</div>
                  </td>
                  <td className="right strong">{num(r.touches)}</td>
                  <td className="right">{num(r.byChannel.linkedin)}</td>
                  <td className="right">{num(r.byChannel.email)}</td>
                  <td className="right">{num(r.byChannel.call)}</td>
                  <td className="right">{num(r.contactsTouched)}</td>
                  <td className="right strong" style={{ color: r.meetingsBooked ? 'var(--ok)' : undefined }}>
                    {num(r.meetingsBooked)}
                  </td>
                  <td className="right">{pct(r.conversionRate)}</td>
                  <td className="right">{num(r.tasksCompleted)}</td>
                  <td className="right" style={{ color: r.tasksOverdue ? 'var(--danger)' : undefined, fontWeight: r.tasksOverdue ? 650 : 400 }}>
                    {num(r.tasksOverdue)}
                  </td>
                  <td className="right faint">{num(r.contactsOwned)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Activity by channel</h2></div>
        <div className="card-body">
          <GroupedBars
            rows={data.rows.map((r) => ({
              label: r.user.name,
              linkedin: r.byChannel.linkedin, email: r.byChannel.email, call: r.byChannel.call,
            }))}
            bars={[
              { key: 'linkedin', label: 'LinkedIn', color: 'var(--linkedin)' },
              { key: 'email', label: 'Email', color: 'var(--email)' },
              { key: 'call', label: 'Calls', color: 'var(--call)' },
            ]}
          />
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- */

function Scoreboard({ data }) {
  if (!data) return null

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>Trend — by {data.unit}</h2>
          <span className="small faint">
            {num(data.emails.sent)} emails sent · {num(data.emails.queued)} waiting for approval
          </span>
        </div>
        <div className="card-body">
          {data.series.length < 2 && (
            <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Only one {data.unit} of activity so far — a trend needs at least two to compare.
            </div>
          )}
          <LineChart
            series={data.series}
            keys={[
              { key: 'added', label: 'Contacts added to campaigns', color: 'var(--text-faint)' },
              { key: 'touches', label: 'Touches', color: 'var(--accent)' },
              { key: 'replies', label: 'Replies', color: 'var(--email)' },
              { key: 'meetings', label: 'Meetings booked', color: 'var(--ok)' },
              { key: 'won', label: 'Won', color: 'var(--warn)' },
            ]}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Campaigns in this range</h2></div>
        {data.campaigns.length === 0 ? (
          <Empty icon="⚑" title="Nobody was enrolled in this range">
            Add contacts to a campaign and this table fills in.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Campaign</th><th className="right">Stages</th><th className="right">Enrolled</th>
                  <th className="right">Running</th><th className="right">Finished</th>
                  <th className="right">Exited early</th><th className="right">Completion</th><th />
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => {
                  const finished = c.completed || 0
                  const done = finished + (c.exited || 0)
                  const rate = done > 0 ? Math.round((finished / done) * 100) : null
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/campaigns/${c.id}`} className="strong">{c.name}</Link>
                        {!c.active && <span className="tag" style={{ marginLeft: 6 }}>inactive</span>}
                      </td>
                      <td className="right faint">{c.stageCount}</td>
                      <td className="right strong">{num(c.enrolled)}</td>
                      <td className="right">{num(c.running)}</td>
                      <td className="right">{num(finished)}</td>
                      <td className="right">{num(c.exited)}</td>
                      <td className="right">{rate == null ? '—' : `${rate}%`}</td>
                      <td className="right">
                        <Link className="btn btn-sm" to={`/reports?tab=funnel&campaign=${c.id}`}>Funnel</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- */

function PipelineReport({ data }) {
  if (!data) return null
  const cur = data.reportingCurrency
  if (data.totals.openCount === 0 && data.closed.wonCount === 0 && data.closed.lostCount === 0) {
    return (
      <div className="card">
        <Empty icon="💼" title="No deals yet">
          Create a deal, or log a booked meeting and one appears automatically.{' '}
          <Link to="/deals">Go to deals →</Link>
        </Empty>
      </div>
    )
  }

  const worst = [...data.stages]
    .filter((s) => s.count > 0 && s.medianAgeDays !== null)
    .sort((a, b) => b.medianAgeDays - a.medianAgeDays)[0]

  return (
    <div className="col" style={{ gap: 14 }}>
      {worst && worst.medianAgeDays > 30 && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            Deals are sitting longest at <strong>{worst.name}</strong> — a median of {worst.medianAgeDays} days,
            with the stalest at {worst.stalest}. That is where the pipeline is congested.
          </div>
        </div>
      )}

      <div className="grid grid-4">
        <div className="stat">
          <div className="stat-label">Open pipeline</div>
          <div className="stat-value">{money(data.totals.openTcvUsd, cur, { compact: true })}</div>
          <div className="stat-sub">{num(data.totals.openCount)} deals</div>
        </div>
        <div className="stat">
          <div className="stat-label">Weighted</div>
          <div className="stat-value">{money(data.totals.weightedUsd, cur, { compact: true })}</div>
          <div className="stat-sub">value × stage probability</div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value">{pct(data.closed.winRate)}</div>
          <div className="stat-sub">{num(data.closed.wonCount)} won / {num(data.closed.lostCount)} lost in range</div>
        </div>
        <div className="stat">
          <div className="stat-label">Median sales cycle</div>
          <div className="stat-value">{data.closed.medianCycleDays ?? '—'}<span style={{ fontSize: 15 }}>{data.closed.medianCycleDays != null ? ' d' : ''}</span></div>
          <div className="stat-sub">created to won</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>Value by stage</h2>
          <span className="small faint">open deals only</span>
        </div>
        <div className="card-body">
          <ValueBars
            currency={cur} format={money}
            rows={data.stages.map((s) => ({
              key: s.key, name: s.name, color: s.color, count: s.count,
              probability: s.probability, value: s.tcvUsd, weighted: s.weightedUsd,
            }))}
          />
          <div className="hint" style={{ marginTop: 14 }}>
            The solid bar is the weighted value; the faded bar behind it is the full value. A wide gap
            means the money is sitting in early stages where it is least likely to land.
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Stage</th><th className="right">Deals</th><th className="right">Value</th>
                <th className="right">Weighted</th><th className="right">Avg deal</th>
                <th className="right">Median age</th><th className="right">Stalest</th>
              </tr>
            </thead>
            <tbody>
              {data.stages.map((s) => (
                <tr key={s.key}>
                  <td>
                    <span className="pill-dot" style={{ background: s.color, display: 'inline-block', marginRight: 6 }} />
                    <span className="strong">{s.name}</span>
                    <span className="small faint"> · {s.probability}%</span>
                  </td>
                  <td className="right">{num(s.count)}</td>
                  <td className="right strong">{money(s.tcvUsd, cur, { compact: true })}</td>
                  <td className="right">{money(s.weightedUsd, cur, { compact: true })}</td>
                  <td className="right small">{money(s.avgDealUsd, cur, { compact: true })}</td>
                  <td className="right small" style={{ color: s.medianAgeDays > 30 ? 'var(--warn)' : undefined }}>
                    {s.medianAgeDays ?? '—'}
                  </td>
                  <td className="right small faint">{s.stalest ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', alignItems: 'start' }}>
        <div className="card">
          <div className="card-head"><h2>Win rate by stage reached</h2></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Stage</th><th className="right">Deals that reached it</th><th className="right">Later won</th><th className="right">Win rate</th></tr></thead>
              <tbody>
                {data.conversion.map((c) => (
                  <tr key={c.key}>
                    <td className="strong">{c.name}</td>
                    <td className="right">{num(c.reached)}</td>
                    <td className="right">{num(c.won)}</td>
                    <td className="right strong">{pct(c.winRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-body" style={{ paddingTop: 0 }}>
            <div className="hint">
              Cohort-based: of every deal that ever reached this stage, the share eventually won. Rates should
              climb as you go down — if they don't, a later stage is not doing the qualifying job it looks like it is.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Why deals were lost</h2></div>
          <div className="card-body">
            {data.closed.lossReasons.length === 0 ? (
              <div className="small faint">No losses recorded in this range.</div>
            ) : (
              <Donut slices={data.closed.lossReasons.map((r, i) => ({
                label: r.reason, value: r.n,
                color: ['#dc2626', '#f59e0b', '#8b5cf6', '#0ea5e9', '#64748b', '#0d9488', '#be185d'][i % 7],
              }))} />
            )}
            <div className="hint" style={{ marginTop: 12 }}>
              Losing to price repeatedly is a pricing problem; losing to timing repeatedly is a targeting problem.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- */

function ForecastReport({ data }) {
  if (!data) return null
  const cur = data.reportingCurrency
  const totals = data.buckets.reduce((acc, b) => ({
    weighted: acc.weighted + b.weightedUsd,
    commit: acc.commit + b.commitUsd,
    bestCase: acc.bestCase + b.bestCaseUsd,
    won: acc.won + b.wonUsd,
    count: acc.count + b.count,
  }), { weighted: 0, commit: 0, bestCase: 0, won: 0, count: 0 })

  return (
    <div className="col" style={{ gap: 14 }}>
      {(data.undated > 0 || data.overdue > 0) && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            {data.undated > 0 && (
              <>
                <strong>{data.undated} open deal{data.undated === 1 ? ' has' : 's have'} no expected close date</strong>
                {' '}and are missing from every number below.{' '}
              </>
            )}
            {data.overdue > 0 && (
              <>{data.overdue} more {data.overdue === 1 ? 'is' : 'are'} past their close date and still open.</>
            )}{' '}
            <Link to="/deals?view=table">Fix them in the table view →</Link>
          </div>
        </div>
      )}

      <div className="grid grid-4">
        <div className="stat">
          <div className="stat-label">Commit</div>
          <div className="stat-value" style={{ color: 'var(--ok)' }}>{money(totals.commit, cur, { compact: true })}</div>
          <div className="stat-sub">reps say this lands</div>
        </div>
        <div className="stat">
          <div className="stat-label">Best case</div>
          <div className="stat-value">{money(totals.commit + totals.bestCase, cur, { compact: true })}</div>
          <div className="stat-sub">commit + upside</div>
        </div>
        <div className="stat">
          <div className="stat-label">Weighted</div>
          <div className="stat-value">{money(totals.weighted, cur, { compact: true })}</div>
          <div className="stat-sub">the statistical view</div>
        </div>
        <div className="stat">
          <div className="stat-label">Already won</div>
          <div className="stat-value">{money(totals.won, cur, { compact: true })}</div>
          <div className="stat-sub">closed inside the window</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>Next {data.months} months</h2>
          <span className="small faint">{num(totals.count)} open deals dated in this window</span>
        </div>
        <div className="card-body">
          <LineChart
            series={data.buckets.map((b) => ({ bucket: b.monthStart, ...b }))}
            keys={[
              { key: 'commitUsd', label: 'Commit', color: 'var(--ok)' },
              { key: 'weightedUsd', label: 'Weighted', color: 'var(--accent)' },
              { key: 'tcvUsd', label: 'All open', color: 'var(--text-faint)' },
              { key: 'wonUsd', label: 'Won', color: 'var(--warn)' },
            ]}
          />
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Month</th><th className="right">Deals</th><th className="right">Commit</th>
                <th className="right">Best case</th><th className="right">Pipeline</th>
                <th className="right">Weighted</th><th className="right">All open</th><th className="right">Won</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b) => (
                <tr key={b.month}>
                  <td className="strong">{monthLabel(b.month)}</td>
                  <td className="right">{num(b.count)}</td>
                  <td className="right strong" style={{ color: b.commitUsd ? 'var(--ok)' : undefined }}>
                    {money(b.commitUsd, cur, { compact: true })}
                  </td>
                  <td className="right">{money(b.bestCaseUsd, cur, { compact: true })}</td>
                  <td className="right small faint">{money(b.pipelineUsd, cur, { compact: true })}</td>
                  <td className="right">{money(b.weightedUsd, cur, { compact: true })}</td>
                  <td className="right small">{money(b.tcvUsd, cur, { compact: true })}</td>
                  <td className="right small" style={{ color: b.wonUsd ? 'var(--warn)' : undefined }}>
                    {money(b.wonUsd, cur, { compact: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          <div className="hint">{data.note}</div>
        </div>
      </div>
    </div>
  )
}
