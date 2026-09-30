import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import WorkItem from '../components/WorkItem.jsx'
import { Empty, Loading } from '../components/ui.jsx'
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
  const { user, smtp } = useAuth()
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
            <div className="stat-sub">past their due date</div>
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
