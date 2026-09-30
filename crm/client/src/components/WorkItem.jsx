import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from './Toast.jsx'
import { Channel, CopyButton, StatusPill } from './ui.jsx'
import { fullName, companyName, dueLabel, isOverdue } from './format.js'

/* One row of the work queue. Collapsed it shows who and why; expanded it
 * shows the merged script and everything needed to close the task without
 * leaving the page. */
export default function WorkItem({ task, onDone, defaultOpen = false }) {
  const { statusMap, callOutcomes, user } = useAuth()
  const toast = useToast()
  const [open, setOpen] = useState(defaultOpen)
  const [outcome, setOutcome] = useState('')
  const [notes, setNotes] = useState('')
  const [callbackDays, setCallbackDays] = useState('')
  const [busy, setBusy] = useState(false)

  const contact = task.contact
  if (!contact) return null
  const overdue = isOverdue(task.dueAt, user.timezone)
  const companyLabel = companyName(contact)

  async function run(fn, successMessage) {
    setBusy(true)
    try {
      await fn()
      if (successMessage) toast.success(successMessage)
      onDone?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const complete = () =>
    run(
      () =>
        api.completeTask(task._id, {
          outcome: outcome || undefined,
          notes: notes || undefined,
          callbackDays: callbackDays ? Number(callbackDays) : undefined,
        }),
      'Logged'
    )

  return (
    <div className={`work-item${overdue ? ' overdue' : ''}${open ? ' open' : ''}`}>
      <div className="work-row" onClick={() => setOpen((o) => !o)}>
        <Channel value={task.channel} showLabel={false} />
        <div className="work-main">
          <div className="work-name truncate">
            {fullName(contact)}
            {companyLabel && <span className="faint" style={{ fontWeight: 400 }}> · {companyLabel}</span>}
          </div>
          <div className="work-meta truncate">
            {task.stageName || task.title}
            {task.campaign?.name && <> · {task.campaign.name}</>}
            {' · '}
            <span style={{ color: overdue ? 'var(--danger)' : undefined, fontWeight: overdue ? 600 : 400 }}>
              {dueLabel(task.dueAt, user.timezone)}
            </span>
          </div>
        </div>
        <StatusPill value={contact.status} statusMap={statusMap} />
        <div className="work-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : task.channel === 'call' ? 'Call' : 'Open'}
          </button>
        </div>
      </div>

      {open && (
        <div className="work-body">
          <div className="row wrap" style={{ padding: '12px 0 10px' }}>
            {contact.linkedinUrl && (
              <a className="btn btn-sm" href={contact.linkedinUrl} target="_blank" rel="noreferrer noopener">
                Open LinkedIn ↗
              </a>
            )}
            {contact.phone && <a className="btn btn-sm" href={`tel:${contact.phone}`}>{contact.phone}</a>}
            {contact.email && <a className="btn btn-sm" href={`mailto:${contact.email}`}>{contact.email}</a>}
            <Link className="btn btn-sm" to={`/contacts/${contact._id}`}>Contact record</Link>
            <div className="spacer" />
            {task.scriptBody && <CopyButton text={task.scriptBody} label="Copy message" />}
          </div>

          {contact.doNotContact && (
            <div className="banner banner-danger">
              This contact is flagged <strong>do not contact</strong>. Close the task without reaching out.
            </div>
          )}

          {task.scriptBody ? (
            <div className="script-box">{task.scriptBody}</div>
          ) : (
            <div className="small faint">This stage has no script. Use your own judgement.</div>
          )}

          <div className="divider" />

          <div className="grid grid-2">
            {task.channel === 'call' && (
              <div className="field" style={{ margin: 0 }}>
                <label className="label">How did the call go?</label>
                <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  <option value="">Pick an outcome…</option>
                  {callOutcomes.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field" style={{ margin: 0 }}>
              <label className="label">
                {task.channel === 'call' ? 'Call them back in' : 'Remind me to follow up in'}
              </label>
              <select className="select" value={callbackDays} onChange={(e) => setCallbackDays(e.target.value)}>
                <option value="">{task.channel === 'call' ? 'No callback needed' : 'No reminder needed'}</option>
                <option value="1">1 day</option>
                <option value="2">2 days</option>
                <option value="3">3 days</option>
                <option value="7">1 week</option>
                <option value="14">2 weeks</option>
                <option value="30">1 month</option>
              </select>
            </div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label className="label">Notes (saved to the timeline)</label>
            <textarea
              className="textarea" style={{ minHeight: 62 }} value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened? Anything worth remembering next time."
            />
          </div>

          <div className="row">
            <button
              className="btn btn-primary" disabled={busy || (task.channel === 'call' && !outcome)}
              onClick={complete}
            >
              {busy ? 'Saving…' : task.channel === 'call' ? 'Log call & close' : 'Mark done'}
            </button>
            <button className="btn" disabled={busy}
              onClick={() => run(() => api.snoozeTask(task._id, 1), 'Snoozed to tomorrow')}>
              Snooze 1 day
            </button>
            <button className="btn" disabled={busy}
              onClick={() => run(() => api.snoozeTask(task._id, 7), 'Snoozed a week')}>
              Snooze 1 week
            </button>
            <div className="spacer" />
            <button className="btn btn-ghost btn-sm" disabled={busy}
              onClick={() => run(() => api.skipTask(task._id, 'Skipped from the work queue'), 'Skipped')}>
              Skip
            </button>
          </div>
          {task.channel === 'call' && !outcome && (
            <div className="hint">Pick an outcome — it is what makes the cold-call report meaningful.</div>
          )}
        </div>
      )}
    </div>
  )
}
