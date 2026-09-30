import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Confirm, Empty, Loading, Modal, Pager } from '../components/ui.jsx'
import { dateTime, fullName, num } from '../components/format.js'

const TABS = [
  { key: 'queued', label: 'Ready to send' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
  { key: 'suppressed', label: 'Blocked' },
  { key: 'cancelled', label: 'Cancelled' },
]

export default function Outbox() {
  const { smtp } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState('queued')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(new Set())
  const [editing, setEditing] = useState(null)
  const [confirmSend, setConfirmSend] = useState(null)
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.listOutbox({ status: tab, page, limit: 50 }))
      setSelected(new Set())
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [tab, page]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const items = data?.items || []
  const allChecked = items.length > 0 && items.every((m) => selected.has(m._id))
  const canSend = smtp?.configured && !smtp?.complianceBlocked

  async function openSendConfirm() {
    try {
      const check = await api.precheckOutbox([...selected])
      setConfirmSend(check)
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function doSend() {
    setSending(true)
    try {
      const res = await api.sendBatch([...selected])
      const bits = [`${res.sent} sent`]
      if (res.suppressed) bits.push(`${res.suppressed} blocked by compliance`)
      if (res.failed) bits.push(`${res.failed} failed`)
      if (res.notAttempted) bits.push(`${res.notAttempted} left queued — ${res.errors[0]?.error || 'setup incomplete'}`)
      res.failed || res.notAttempted ? toast.error(bits.join(' · ')) : toast.success(bits.join(' · '))
      setConfirmSend(null)
      load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Ready to Send</h1>
          <div className="topbar-sub">
            Drafts generated when contacts reached an email stage. Nothing goes out until you send it.
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="page">
        {smtp?.complianceBlocked && (
          <div className="banner banner-danger">
            <span>⛔</span>
            <div>
              <strong>Sending is blocked.</strong> {smtp.complianceBlocked}{' '}
              <Link to="/settings">Open Settings →</Link>
            </div>
          </div>
        )}
        {!smtp?.configured && !smtp?.complianceBlocked && (
          <div className="banner banner-warn">
            <span>⚠</span>
            <div>
              <strong>No mail server connected.</strong> You can review and edit drafts, but sending will
              fail until SMTP credentials are added. <Link to="/settings">Add them →</Link>
            </div>
          </div>
        )}

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`}
              onClick={() => { setTab(t.key); setPage(1) }}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'queued' && selected.size > 0 && (
          <div className="banner banner-info" style={{ alignItems: 'center' }}>
            <strong>{selected.size} selected</strong>
            <div className="spacer" />
            <button className="btn btn-primary btn-sm" disabled={!canSend} onClick={openSendConfirm}>
              Send {selected.size}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        <div className="card">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty
              icon={tab === 'queued' ? '📬' : '—'}
              title={tab === 'queued' ? 'Nothing waiting' : `No ${tab} messages`}
            >
              {tab === 'queued'
                ? 'Drafts land here automatically when a contact reaches an email stage in their campaign.'
                : 'Nothing to show for this filter.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {tab === 'queued' && (
                      <th className="checkcol">
                        <input type="checkbox" className="checkbox" checked={allChecked}
                          onChange={() => setSelected(allChecked ? new Set() : new Set(items.map((m) => m._id)))} />
                      </th>
                    )}
                    <th>To</th>
                    <th>Subject</th>
                    <th>Campaign / stage</th>
                    <th>{tab === 'sent' ? 'Sent' : 'Created'}</th>
                    {tab !== 'queued' && tab !== 'sent' && <th>Reason</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((m) => (
                    <tr key={m._id} className={selected.has(m._id) ? 'selected' : ''}>
                      {tab === 'queued' && (
                        <td className="checkcol">
                          <input type="checkbox" className="checkbox" checked={selected.has(m._id)}
                            onChange={() => setSelected((s) => {
                              const n = new Set(s)
                              n.has(m._id) ? n.delete(m._id) : n.add(m._id)
                              return n
                            })} />
                        </td>
                      )}
                      <td>
                        {m.contact ? (
                          <Link to={`/contacts/${m.contact._id}`} className="strong">{fullName(m.contact)}</Link>
                        ) : <span className="faint">(deleted contact)</span>}
                        <div className="small faint truncate" style={{ maxWidth: 220 }}>{m.to}</div>
                      </td>
                      <td className="truncate" style={{ maxWidth: 280 }}>{m.subject || <span className="faint">(no subject)</span>}</td>
                      <td className="small">
                        {m.campaign?.name}
                        <div className="faint">{m.stageName}</div>
                      </td>
                      <td className="small faint nowrap">{dateTime(m.sentAt || m.createdAt)}</td>
                      {tab !== 'queued' && tab !== 'sent' && (
                        <td className="small" style={{ color: 'var(--danger)', maxWidth: 260 }}>{m.error}</td>
                      )}
                      <td className="right nowrap">
                        <button className="btn btn-sm" onClick={() => setEditing(m)}>
                          {tab === 'queued' ? 'Review' : tab === 'failed' ? 'Retry' : 'View'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && (
            <div className="sticky-actions">
              <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
            </div>
          )}
        </div>
      </div>

      {editing && (
        <DraftModal
          message={editing} readOnly={!['queued', 'failed'].includes(editing.status)} canSend={canSend}
          onClose={() => setEditing(null)}
          onChanged={() => { setEditing(null); load() }}
        />
      )}

      {confirmSend && (
        <Confirm
          title={`Send ${confirmSend.sendable} email${confirmSend.sendable === 1 ? '' : 's'}`}
          confirmLabel={sending ? 'Sending…' : `Send ${confirmSend.sendable}`}
          onClose={() => setConfirmSend(null)}
          onConfirm={doSend}
          message={
            <>
              <p>
                {confirmSend.sendable} message{confirmSend.sendable === 1 ? '' : 's'} will be sent now, each
                with your company name, postal address and an unsubscribe link appended.
              </p>
              {confirmSend.blocked.length > 0 && (
                <div className="banner banner-warn" style={{ marginTop: 10 }}>
                  <span>⚠</span>
                  <div>
                    <strong>{confirmSend.blocked.length} will be skipped</strong> — these contacts are on the
                    do-not-contact list or have unsubscribed:
                    <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                      {confirmSend.blocked.slice(0, 6).map((b) => (
                        <li key={b.id} className="small">{b.to} — {b.reason}</li>
                      ))}
                      {confirmSend.blocked.length > 6 && <li className="small">…and {confirmSend.blocked.length - 6} more</li>}
                    </ul>
                  </div>
                </div>
              )}
            </>
          }
        />
      )}
    </>
  )
}

function DraftModal({ message, readOnly, canSend, onClose, onChanged }) {
  const toast = useToast()
  const [subject, setSubject] = useState(message.subject || '')
  const [body, setBody] = useState(message.body || '')
  const [busy, setBusy] = useState(false)

  // A leftover {{token}} means the merge failed — never let that reach a prospect.
  const unmerged = [...`${subject}\n${body}`.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0])

  async function run(fn, msg) {
    setBusy(true)
    try {
      await fn()
      toast.success(msg)
      onChanged()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={readOnly ? 'Message' : `Review — ${fullName(message.contact)}`}
      onClose={onClose} width="wide"
      footer={
        readOnly ? (
          <button className="btn" onClick={onClose}>Close</button>
        ) : (
          <>
            <button className="btn btn-ghost" disabled={busy}
              onClick={() => run(() => api.cancelOutbox(message._id, 'Cancelled during review'), 'Draft cancelled')}>
              Cancel this draft
            </button>
            <div className="spacer" />
            <button className="btn" disabled={busy}
              onClick={() => run(() => api.updateOutbox(message._id, { subject, body }), 'Draft saved')}>
              Save without sending
            </button>
            <button className="btn btn-primary" disabled={busy || !canSend}
              onClick={() => run(() => api.sendOutbox(message._id, { subject, body }), 'Sent')}>
              {busy ? 'Sending…' : message.status === 'failed' ? 'Retry send' : 'Send now'}
            </button>
          </>
        )
      }
    >
      <div className="small faint" style={{ marginBottom: 12 }}>
        To <strong>{message.to}</strong>
        {message.campaign?.name && <> · {message.campaign.name} · {message.stageName}</>}
      </div>

      {message.contact?.doNotContact && (
        <div className="banner banner-danger">
          <span>⛔</span>
          <div>This contact is flagged do-not-contact. Sending will be refused.</div>
        </div>
      )}
      {unmerged.length > 0 && !readOnly && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            <strong>Unresolved merge fields:</strong> {unmerged.join(', ')}. Fix them before sending —
            they will go out as literal text.
          </div>
        </div>
      )}

      <div className="field">
        <label className="label">Subject</label>
        <input className="input" value={subject} disabled={readOnly} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="field">
        <label className="label">Message</label>
        <textarea className="textarea" style={{ minHeight: 260 }} value={readOnly ? (message.sentBody || body) : body}
          disabled={readOnly} onChange={(e) => setBody(e.target.value)} />
      </div>

      {!readOnly && (
        <div className="hint">
          Your company name, postal address and a working unsubscribe link are appended automatically when
          this sends.
        </div>
      )}
      {message.error && (
        <div className={`banner ${message.status === 'queued' ? 'banner-warn' : 'banner-danger'}`} style={{ marginTop: 10 }}>
          <span>{message.status === 'queued' ? '⚠' : '✕'}</span>
          <div>
            {message.status === 'queued' && <strong>Last attempt did not go out: </strong>}
            {message.error}
          </div>
        </div>
      )}
    </Modal>
  )
}
