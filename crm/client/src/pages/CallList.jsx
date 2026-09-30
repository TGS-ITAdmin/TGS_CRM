import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import WorkItem from '../components/WorkItem.jsx'
import { Empty, Loading } from '../components/ui.jsx'
import { relativeDate } from '../components/format.js'

/* Cold-call queue ordered by who is actually reachable. Local time comes from
 * the server so every rep sees the same answer regardless of their own clock. */
export default function CallList() {
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [campaigns, setCampaigns] = useState([])
  const [campaign, setCampaign] = useState('')
  const [hideOutOfHours, setHideOutOfHours] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.callList({ campaign: campaign || undefined }))
    } finally {
      setLoading(false)
    }
  }, [campaign])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.listCampaigns({ active: 'true' }).then((d) => setCampaigns(d.campaigns)).catch(() => {})
  }, [])

  const items = data?.items || []
  const reachable = items.filter((t) => t.inBusinessHours === true)
  const unknown = items.filter((t) => t.inBusinessHours === null)
  const asleep = items.filter((t) => t.inBusinessHours === false)
  const shown = hideOutOfHours ? [...reachable, ...unknown] : items

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Call List</h1>
          <div className="topbar-sub">
            Sorted by who is inside business hours right now · your timezone is {user.timezone || 'not set'}
          </div>
        </div>
        <div className="spacer" />
        <select className="select" style={{ maxWidth: 220 }} value={campaign} onChange={(e) => setCampaign(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
        </select>
        <button className="btn btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="page">
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <div className="card">
            <Empty icon="☎" title="No calls queued"
              action={<Link className="btn btn-primary btn-sm" to="/campaigns">Set up a call campaign</Link>}>
              Call tasks appear here when a contact reaches a cold-call stage, or when you book a callback.
            </Empty>
          </div>
        ) : (
          <>
            <div className="grid grid-3" style={{ marginBottom: 18 }}>
              <div className="stat">
                <div className="stat-label">Callable now</div>
                <div className="stat-value" style={{ color: 'var(--call)' }}>{reachable.length}</div>
                <div className="stat-sub">between 8am and 6pm their time</div>
              </div>
              <div className="stat">
                <div className="stat-label">Out of hours</div>
                <div className="stat-value">{asleep.length}</div>
                <div className="stat-sub">wrong time to dial</div>
              </div>
              <div className="stat">
                <div className="stat-label">Timezone unknown</div>
                <div className="stat-value">{unknown.length}</div>
                <div className="stat-sub">set it on the contact record</div>
              </div>
            </div>

            {asleep.length > 0 && (
              <label className="row small" style={{ marginBottom: 12 }}>
                <input type="checkbox" className="checkbox" checked={hideOutOfHours}
                  onChange={(e) => setHideOutOfHours(e.target.checked)} />
                Hide the {asleep.length} contact{asleep.length === 1 ? '' : 's'} currently outside business hours
              </label>
            )}

            {shown.map((task) => (
              <div key={task._id} style={{ position: 'relative' }}>
                <div
                  className="small"
                  style={{
                    position: 'absolute', right: 14, top: -7, zIndex: 2,
                    background: task.inBusinessHours === true ? 'var(--call-soft)'
                      : task.inBusinessHours === false ? 'var(--warn-soft)' : 'var(--surface-2)',
                    color: task.inBusinessHours === true ? 'var(--call)'
                      : task.inBusinessHours === false ? 'var(--warn)' : 'var(--text-faint)',
                    border: '1px solid currentColor', borderRadius: 20, padding: '1px 9px',
                    fontWeight: 620, fontSize: 11,
                  }}
                >
                  {task.contactLocalTime
                    ? `${task.contactLocalTime} their time`
                    : 'timezone unknown'}
                </div>
                <WorkItem task={task} onDone={load} />
              </div>
            ))}

            {unknown.length > 0 && (
              <div className="hint" style={{ marginTop: 14 }}>
                {unknown.length} contact{unknown.length === 1 ? ' has' : 's have'} no timezone set, so we cannot
                tell whether it is a sane hour to call. Set it on the contact record — the CSV importer can map
                a timezone column too.
              </div>
            )}
            {data.checkedAt && (
              <div className="small faint" style={{ marginTop: 10 }}>
                Local times checked {relativeDate(data.checkedAt)}. Refresh for the current hour.
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
