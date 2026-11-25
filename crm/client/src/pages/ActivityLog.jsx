import { Fragment, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Empty, Loading, Modal, Pager } from '../components/ui.jsx'
import { dateTime, relativeDate } from '../components/format.js'

/* Admin activity log: every change made by the team, with undo.
 * Kept for a year; undo is offered for 30 days. */

const TYPES = [
  ['Contact', 'Contacts'], ['Company', 'Companies'], ['Deal', 'Deals'], ['Quote', 'Quotes'],
  ['Campaign', 'Campaigns'], ['Enrollment', 'Campaign enrolments'], ['Task', 'Tasks'],
  ['OutboxMessage', 'Email drafts'], ['Settings', 'Settings'], ['User', 'Users'], ['Product', 'Rate card'],
  ['CustomField', 'Custom fields'], ['Suppression', 'Do-not-contact list'],
]
const PLURAL = {
  Contact: ['contact', 'contacts'], Company: ['company', 'companies'], Deal: ['deal', 'deals'], Quote: ['quote', 'quotes'],
  Campaign: ['campaign', 'campaigns'], Enrollment: ['enrolment', 'enrolments'], Task: ['task', 'tasks'],
  OutboxMessage: ['email draft', 'email drafts'], Settings: ['settings', 'settings'], User: ['user', 'users'],
  Product: ['rate card item', 'rate card items'], CustomField: ['custom field', 'custom fields'],
  SavedView: ['saved view', 'saved views'], Suppression: ['do-not-contact entry', 'do-not-contact entries'],
}
const VERB = { create: 'created', update: 'changed', delete: 'deleted' }

function countsText(counts = {}) {
  const parts = Object.entries(counts)
    .filter(([k]) => !k.startsWith('Activity:'))
    .map(([k, n]) => {
      const [model, action] = k.split(':')
      const [one, many] = PLURAL[model] || [model, model]
      return `${n} ${n === 1 ? one : many} ${VERB[action] || action}`
    })
  return parts.join(' · ') || 'timeline only'
}

function fmt(v) {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.map(fmt).join(', ') : '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return dateTime(v)
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 120 ? `${s.slice(0, 117)}…` : s
  }
  return String(v)
}

export default function ActivityLog() {
  const { isAdmin, users } = useAuth()
  const toast = useToast()
  // Links from Reports can open the log already filtered (?user=&model=&q=&days=).
  const [params] = useSearchParams()
  const [query, setQueryState] = useState(() => ({
    page: 1,
    q: params.get('q') || '',
    user: params.get('user') || '',
    model: params.get('model') || '',
    days: params.has('days') ? params.get('days') : '30',
  }))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(null)
  const [details, setDetails] = useState({})
  const [undo, setUndo] = useState(null)
  const [busy, setBusy] = useState(false)

  const setQuery = (patch) => setQueryState((q) => ({ ...q, page: 1, ...patch }))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.auditLog(query))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [JSON.stringify(query)]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (isAdmin) load() }, [load, isAdmin])

  if (!isAdmin) {
    return (
      <div className="page">
        <Empty icon="🔒" title="Admins only">The activity log is only available to admin accounts.</Empty>
      </div>
    )
  }

  async function toggle(id) {
    if (open === id) return setOpen(null)
    setOpen(id)
    if (!details[id]) {
      try {
        const d = await api.auditEntry(id)
        setDetails((x) => ({ ...x, [id]: d }))
      } catch (err) {
        toast.error(err.message)
      }
    }
  }

  async function startUndo(op) {
    setBusy(true)
    try {
      const r = await api.auditUndo(op._id, { dryRun: true })
      setUndo({ op, plan: r.plan || [] })
    } catch (err) {
      // 409: later changes block it — the server lists them.
      if (err.payload?.conflicts) setUndo({ op, conflicts: err.payload.conflicts, plan: err.payload.plan || [] })
      else toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function confirmUndo() {
    setBusy(true)
    try {
      const r = await api.auditUndo(undo.op._id, {})
      toast.success(`Undone · ${r.reverted} record${r.reverted === 1 ? '' : 's'} put back`)
      setUndo(null)
      setOpen(null)
      setDetails({})
      load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const items = data?.items || []

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Activity log</h1>
          <div className="topbar-sub">Every change your team makes · admins only · kept 1 year · undo available for 30 days</div>
        </div>
      </div>

      <div className="page">
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input className="input" style={{ maxWidth: 260 }} placeholder="Search action, record or person…"
                value={query.q} onChange={(e) => setQuery({ q: e.target.value })} />
              <select className="select" style={{ maxWidth: 200 }} value={query.user} onChange={(e) => setQuery({ user: e.target.value })}>
                <option value="">Anyone</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <select className="select" style={{ maxWidth: 200 }} value={query.model} onChange={(e) => setQuery({ model: e.target.value })}>
                <option value="">Any type of record</option>
                {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select className="select" style={{ maxWidth: 160 }} value={query.days} onChange={(e) => setQuery({ days: e.target.value })}>
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="">Last year</option>
              </select>
            </div>
          </div>
        </div>

        <div className="card">
          {loading && !data ? <Loading /> : items.length === 0 ? (
            <Empty icon="🕑" title="Nothing logged here yet">Changes appear as soon as someone makes them.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>When</th><th>Who</th><th>What</th><th>Records</th><th className="right">Undo</th></tr>
                </thead>
                <tbody>
                  {items.map((op) => (
                    <Fragment key={op._id}>
                      <tr style={{ cursor: 'pointer', opacity: op.undoneAt ? 0.6 : 1 }} onClick={() => toggle(op._id)}>
                        <td className="nowrap small" title={dateTime(op.at)}>{relativeDate(op.at)}<div className="faint">{dateTime(op.at)}</div></td>
                        <td className="nowrap">{op.userName || '—'}</td>
                        <td>
                          <strong>{op.headline}</strong>
                          {op.label && <span className="faint"> · {op.label}</span>}
                          {op.undoneAt && <div className="small" style={{ color: 'var(--warn)' }}>Undone by {op.undoneByName} · {relativeDate(op.undoneAt)}</div>}
                        </td>
                        <td className="small">{countsText(op.counts)}</td>
                        <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                          {op.canUndo ? (
                            <button className="btn btn-sm" disabled={busy} onClick={() => startUndo(op)}
                              title={`Available until ${dateTime(op.until)}`}>
                              Undo
                            </button>
                          ) : (
                            <span className="small faint" title={op.why}>{op.kind === 'undo' ? 'Undo entry' : op.undoneAt ? 'Undone' : 'Not available'}</span>
                          )}
                        </td>
                      </tr>
                      {open === op._id && (
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
                            <ChangeDetails d={details[op._id]} op={op} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && <div className="card-body"><Pager page={data.page} pages={data.pages} total={data.total} onPage={(p) => setQueryState((q) => ({ ...q, page: p }))} /></div>}
        </div>
      </div>

      {undo && (
        <Modal
          title={undo.conflicts ? 'This can’t be undone yet' : 'Undo this action?'}
          onClose={() => !busy && setUndo(null)}
          footer={undo.conflicts
            ? <button className="btn" onClick={() => setUndo(null)}>Close</button>
            : (
              <>
                <button className="btn" disabled={busy} onClick={() => setUndo(null)}>Cancel</button>
                <button className="btn btn-danger" disabled={busy} onClick={confirmUndo}>{busy ? 'Undoing…' : 'Undo'}</button>
              </>
            )}
        >
          <p className="small"><strong>{undo.op.headline}</strong>{undo.op.label ? ` · ${undo.op.label}` : ''} — {undo.op.userName}, {dateTime(undo.op.at)}</p>
          {undo.conflicts ? (
            <>
              <div className="banner banner-warn" style={{ marginBottom: 10 }}>
                <span>!</span>
                <div className="small">Later changes touched the same records, so undoing this now would wipe them out.
                  Undo these first (newest first), then come back:</div>
              </div>
              <ul className="small" style={{ paddingLeft: 18 }}>
                {undo.conflicts.map((c) => (
                  <li key={c._id}>
                    <strong>{c.headline}</strong>{c.label ? ` · ${c.label}` : ''} — {c.userName}, {dateTime(c.at)}
                    {c.records?.length > 0 && <div className="faint">Touched: {c.records.join(', ')}</div>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="small">This will:</p>
              <ul className="small" style={{ paddingLeft: 18 }}>
                {undo.plan.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
              <div className="hint">The undo is logged too. It cannot itself be undone.</div>
            </>
          )}
        </Modal>
      )}
    </>
  )
}

function ChangeDetails({ d, op }) {
  if (!d) return <div className="small faint" style={{ padding: 8 }}>Loading…</div>
  return (
    <div style={{ padding: '6px 4px' }}>
      {!op.canUndo && op.why && op.kind !== 'undo' && !op.undoneAt && (
        <div className="small" style={{ marginBottom: 8, color: 'var(--warn)' }}>Undo not available: {op.why}</div>
      )}
      {d.changes.length === 0 && <div className="small faint">Only timeline entries changed.</div>}
      {d.changes.map((c) => (
        <div key={`${c.seq}`} style={{ marginBottom: 10 }}>
          <div className="small">
            <strong>{c.label || c.modelLabel}</strong>
            <span className="faint"> · {c.modelLabel} {VERB[c.action]}</span>
          </div>
          {c.action === 'update' && c.fields.length > 0 && (
            <table className="data" style={{ marginTop: 4 }}>
              <thead><tr><th style={{ width: 180 }}>Field</th><th>Before</th><th>After</th></tr></thead>
              <tbody>
                {c.fields.map((f) => (
                  <tr key={f}>
                    <td className="small mono">{f}</td>
                    <td className="small" style={{ color: 'var(--text-muted)' }}>{fmt(c.before?.[f])}</td>
                    <td className="small">{fmt(c.after?.[f])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {(d.timelineEntries > 0 || d.more > 0) && (
        <div className="small faint">
          {d.timelineEntries > 0 && `${d.timelineEntries} timeline entr${d.timelineEntries === 1 ? 'y' : 'ies'} also recorded. `}
          {d.more > 0 && `${d.more} more change${d.more === 1 ? '' : 's'} not shown.`}
        </div>
      )}
    </div>
  )
}
