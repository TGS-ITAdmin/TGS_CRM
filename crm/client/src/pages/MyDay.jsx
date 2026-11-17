import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import WorkItem from '../components/WorkItem.jsx'
import { Channel, Empty, Loading } from '../components/ui.jsx'
import { useToast } from '../components/Toast.jsx'
import { ConfirmNext } from '../components/OutcomeBits.jsx'
import { requestNotificationPermission, notificationPermission } from '../components/useReminders.js'
import { num } from '../components/format.js'

function Section({ title, count, hot, children, empty }) {
  return (
    <div className="queue-section">
      <div className="queue-head">
        <span className="queue-title">{title}</span>
        <span className={`queue-count${hot ? ' hot' : ''}`}>{count}</span>
      </div>
      {count === 0 ? <div className="card"><div className="card-body small faint">{empty}</div></div> : children}
    </div>
  )
}

export default function MyDay({ counts }) {
  const { user, smtp, can } = useAuth()
  const [team, setTeam] = useState(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notifState, setNotifState] = useState(notificationPermission())

  const load = useCallback(async () => {
    try {
      setData(await api.myDay())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  // G13: the team's tasks more than 1 business day overdue, for managers.
  useEffect(() => {
    if (can('reports.viewTeam')) api.escalations().then(setTeam).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Loading />
  if (!data) return null

  const c = data.counts
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'
  const nothingToDo = c.overdue + c.dueToday + c.awaitingApproval === 0

  return (
    <>
      <div className="topbar">
        <div>
          <h1>My Day</h1>
          <div className="topbar-sub">
            {greeting}, {user.name.split(' ')[0]} · {new Intl.DateTimeFormat(undefined, {
              weekday: 'long', day: 'numeric', month: 'long', timeZone: user.timezone || undefined,
            }).format(new Date())}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="page">
        {smtp?.complianceBlocked && (
          <div className="banner banner-warn">
            <span>⚠</span>
            <div>
              <strong>Email sending is switched off.</strong> {smtp.complianceBlocked}{' '}
              <Link to="/settings">Fix it in Settings →</Link>
            </div>
          </div>
        )}
        {!smtp?.configured && !smtp?.complianceBlocked && (
          <div className="banner banner-info">
            <span>ℹ</span>
            <div>
              No mail server is connected yet, so nothing can actually be sent. Drafts still queue up and
              show you exactly what would go out. <Link to="/settings">Add SMTP details →</Link>
            </div>
          </div>
        )}
        {notifState === 'default' && (
          <div className="banner banner-info">
            <span>🔔</span>
            <div style={{ flex: 1 }}>
              Turn on browser notifications and this tab will tell you when a contact comes due.
            </div>
            <button
              className="btn btn-sm"
              onClick={async () => setNotifState(await requestNotificationPermission())}
            >
              Enable
            </button>
          </div>
        )}

        <div className="grid grid-4" style={{ marginBottom: 20 }}>
          <div className={`stat${c.overdue ? ' hot' : ''}`}>
            <div className="stat-label">Overdue</div>
            <div className="stat-value">{num(c.overdue)}</div>
            <div className="stat-sub">{c.escalated ? `${num(c.escalated)} escalated (1+ business day)` : 'past their due date'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Due today</div>
            <div className="stat-value">{num(c.dueToday)}</div>
            <div className="stat-sub">on the clock now</div>
          </div>
          <Link to="/outbox" className="stat clickable" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="stat-label">Awaiting approval</div>
            <div className="stat-value">{num(c.awaitingApproval)}</div>
            <div className="stat-sub">emails ready to send →</div>
          </Link>
          <div className="stat">
            <div className="stat-label">Done today</div>
            <div className="stat-value">{num(c.completedToday)}</div>
            <div className="stat-sub">tasks completed</div>
          </div>
        </div>

        {nothingToDo && (
          <div className="card" style={{ marginBottom: 20 }}>
            <Empty icon="✅" title="Your queue is clear">
              Nothing is due. New work appears here automatically as contacts reach their next stage.
              <div style={{ marginTop: 12 }}>
                <Link className="btn btn-sm" to="/contacts">Browse contacts</Link>{' '}
                <Link className="btn btn-sm" to="/campaigns">Manage campaigns</Link>
              </div>
            </Empty>
          </div>
        )}

        {team && team.total > 0 && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-head">
              <h2 style={{ flex: 1 }}>Team escalations</h2>
              <span className="small faint">Tasks more than 1 business day overdue</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Owner</th><th className="num">Escalated</th><th>Oldest</th><th>Examples</th></tr></thead>
                <tbody>
                  {team.owners.map((o) => (
                    <tr key={o.owner}>
                      <td><strong>{o.owner}</strong></td>
                      <td className="num" style={{ color: 'var(--danger)' }}>{o.count}</td>
                      <td className="nowrap small">{new Date(o.oldest).toLocaleDateString()}</td>
                      <td className="small">{o.tasks.slice(0, 3).map((t) => t.title).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {c.overdue > 0 && (
          <Section title="Overdue" count={c.overdue} hot empty="Nothing overdue.">
            {data.overdue.map((t) => (
              <WorkItem key={t._id} task={t} onDone={load} />
            ))}
          </Section>
        )}

        <Section title="Due today" count={c.dueToday} empty="Nothing else due today.">
          {data.today.map((t) => (
            <WorkItem key={t._id} task={t} onDone={load} />
          ))}
        </Section>

        <WaitingReplies />

        {c.awaitingApproval > 0 && (
          <div className="queue-section">
            <div className="queue-head">
              <span className="queue-title">Emails waiting for your approval</span>
              <span className="queue-count">{c.awaitingApproval}</span>
            </div>
            <div className="card">
              <div className="card-body">
                <p className="small muted" style={{ marginBottom: 12 }}>
                  These drafts were generated when contacts reached an email stage. Nothing sends until you
                  review and click send.
                </p>
                <Link className="btn btn-primary btn-sm" to="/outbox">Review {c.awaitingApproval} draft{c.awaitingApproval === 1 ? '' : 's'} →</Link>
              </div>
            </div>
          </div>
        )}

        {data.upcoming.length > 0 && (
          <div className="queue-section">
            <div className="queue-head">
              <span className="queue-title">Coming up this week</span>
              <span className="queue-count">{data.upcoming.length}</span>
            </div>
            {data.upcoming.slice(0, 12).map((t) => (
              <WorkItem key={t._id} task={t} onDone={load} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ---------------- Waiting on a reply ----------------
 * Emails and LinkedIn messages that went out before today, still on that
 * stage, with no reply logged. Log what came back in one click, or "No reply
 * yet" (hidden for a day). The outcome runs the stage's branch. */
const QUICK = {
  email: ['positive', 'other', 'not_now', 'not_interested', 'unsubscribe', 'out_of_office', 'bounced'],
  linkedin: ['invite_accepted', 'replied_positive', 'replied_other', 'replied_not_now', 'replied_not_interested'],
}

function WaitingReplies() {
  const { outcomeCatalogue } = useAuth()
  const toast = useToast()
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState(null)

  const load = useCallback(() => {
    api.waitingReplies().then((d) => setItems(d.items || [])).catch(() => setItems([]))
  }, [])
  useEffect(() => { load() }, [load])
  if (!items || !items.length) return null

  const label = (ch, key) => ((outcomeCatalogue?.[ch] || []).find((o) => o.key === key) || {}).label || key

  async function log(item, key) {
    await api.addNote(item.contact._id, {
      type: 'reply_logged', channel: item.channel, outcome: key, enrollmentId: item.enrollmentId,
      body: `${label(item.channel, key)} (logged from Waiting on a reply)`,
    })
    toast.success(`${label(item.channel, key)} logged`)
    load()
  }

  async function pick(item, key) {
    setBusy(`${item.enrollmentId}:${key}`)
    try {
      const p = await api.outcomePreview({ contactId: item.contact._id, enrollmentId: item.enrollmentId, channel: item.channel, outcome: key })
      if (p.destructive) setConfirm({ item, key, plan: p.plan })
      else await log(item, key)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="queue-section">
      <div className="queue-head">
        <span className="queue-title">Waiting on a reply</span>
        <span className="queue-count">{items.length}</span>
      </div>
      <div className="card">
        <div className="card-body small muted" style={{ paddingBottom: 4 }}>
          Check the inbox or LinkedIn for each one, then log what came back. The stage's branch decides what happens next.
        </div>
        {items.map((it) => (
          <div key={`${it.enrollmentId}`} className="work-row" style={{ cursor: 'default', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Channel value={it.channel} showLabel={false} />
            <div className="work-main" style={{ minWidth: 220 }}>
              <div className="work-name truncate">
                <Link to={`/contacts/${it.contact._id}`}>{[it.contact.firstName, it.contact.lastName].filter(Boolean).join(' ') || 'Contact'}</Link>
                <span className="faint" style={{ fontWeight: 400 }}> · {it.contact.company?.name || it.contact.companyName || ''}</span>
              </div>
              <div className="work-meta truncate">
                {it.campaign?.name} · {it.stageName} · {it.channel === 'email' ? 'sent' : 'done'} {new Date(it.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </div>
            </div>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {(QUICK[it.channel] || []).map((k) => (
                <button key={k} className="btn btn-sm" disabled={!!busy} onClick={() => pick(it, k)}>
                  {busy === `${it.enrollmentId}:${k}` ? '…' : label(it.channel, k)}
                </button>
              ))}
              <button className="btn btn-sm btn-ghost" disabled={!!busy}
                onClick={async () => {
                  try { await api.noReplyYet(it.enrollmentId); load() } catch (err) { toast.error(err.message) }
                }}>
                No reply yet
              </button>
            </div>
          </div>
        ))}
      </div>
      {confirm && (
        <ConfirmNext
          plan={confirm.plan}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm
            setConfirm(null)
            try { await log(c.item, c.key) } catch (err) { toast.error(err.message) }
          }}
        />
      )}
    </div>
  )
}
