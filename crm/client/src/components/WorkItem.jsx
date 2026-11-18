import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from './Toast.jsx'
import { Channel, CopyButton, Modal, StatusPill } from './ui.jsx'
import CampaignSelect, { CampaignChoiceHint } from './CampaignSelect.jsx'
import { ConfirmNext, NextStepBox, OutcomeFields, useOutcomePreview } from './OutcomeBits.jsx'
import { fullName, companyName, dueLabel, isOverdue } from './format.js'

/* One row of the work queue. Collapsed it shows who and why; expanded it
 * shows the merged script and everything needed to close the task without
 * leaving the page. */
export default function WorkItem({ task, onDone, defaultOpen = false }) {
  const { statusMap, callOutcomes, outcomeCatalogue, user, can } = useAuth()
  const toast = useToast()
  const [open, setOpen] = useState(defaultOpen)
  const [outcome, setOutcome] = useState('')
  const [notes, setNotes] = useState('')
  const [callbackDays, setCallbackDays] = useState('')
  const [busy, setBusy] = useState(false)
  // Outcome extras: the right person (Wrong person) and a check-back date (Not now).
  const [person, setPerson] = useState({})
  const [restartDate, setRestartDate] = useState('')
  const [confirming, setConfirming] = useState(null)
  const outcomeList = (outcomeCatalogue?.[task.channel] || []).length
    ? outcomeCatalogue[task.channel]
    : (task.channel === 'call' ? callOutcomes.map((o) => ({ key: o.value, label: o.label })) : [])
  const outcomeDef = outcomeList.find((o) => o.key === outcome) || null
  const preview = useOutcomePreview(
    outcome && task.kind !== 'recheck' && (task.channel === 'call' || task.channel === 'linkedin')
      ? { taskId: task._id, outcome, restartDate: restartDate || undefined, person }
      : null
  )
  // "Enroll in a campaign": the picker and its campaign list (loaded on open).
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [campaigns, setCampaigns] = useState(null)
  const [target, setTarget] = useState('')

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

  const outcomeBody = () => ({
    outcome: outcome || undefined,
    notes: notes || undefined,
    callbackDays: callbackDays ? Number(callbackDays) : undefined,
    person: outcomeDef?.needsPerson ? person : undefined,
    restartDate: outcomeDef?.needsDate && restartDate ? restartDate : undefined,
  })
  const doComplete = () => run(() => api.completeTask(task._id, outcomeBody()), 'Logged')
  // Guardrail: confirm first when the outcome ends a campaign, sets Lost or flags DNC.
  const complete = () => (preview.destructive ? setConfirming({ then: doComplete }) : doComplete())

  /* Log this task (with the outcome and notes on the card), then move the
   * contact: every campaign they are in ends, its pending work is cancelled,
   * and they start stage 1 of the chosen campaign. Same rules as Move. */
  const ENDING_OUTCOMES = ['not_interested', 'do_not_call']
  const canEnrollHere = can('campaigns.enroll') && task.kind !== 'recheck'
  const enrollBlocked = task.channel === 'call' && (!outcome || ENDING_OUTCOMES.includes(outcome))

  async function openEnroll() {
    setTarget('')
    setEnrollOpen(true)
    if (!campaigns) {
      try {
        const d = await api.listCampaigns()
        setCampaigns(d.campaigns || [])
      } catch (err) {
        toast.error(err.message)
        setEnrollOpen(false)
      }
    }
  }

  async function logAndEnroll() {
    const chosen = (campaigns || []).find((c) => c._id === target)
    setBusy(true)
    try {
      await api.completeTask(task._id, outcomeBody())
    } catch (err) {
      // Nothing was saved, so nothing else is attempted.
      toast.error(err.message)
      setBusy(false)
      return
    }
    try {
      const res = await api.moveContacts({
        contactIds: [contact._id],
        toCampaign: target,
        reason: `Moved to "${chosen?.name || 'another campaign'}" from a task`,
      })
      if (res.errors?.length) throw new Error(res.errors[0].error)
      toast.success(`${task.channel === 'call' ? 'Call logged' : 'Done'} · enrolled in "${chosen?.name}"`)
    } catch (err) {
      toast.error(`${task.channel === 'call' ? 'Call logged' : 'Task closed'}, but enrolling failed: ${err.message}`)
    } finally {
      setBusy(false)
      setEnrollOpen(false)
      onDone?.()
    }
  }

  const isRecheck = task.kind === 'recheck'
  const answerRecheck = (answer) =>
    run(
      () => api.completeTask(task._id, { answer, notes: notes || undefined }),
      answer === 'open'
        ? `Back into ${task.campaign?.name || 'the campaign'} from stage 1`
        : 'Logged — not re-enrolled'
    )

  return (
    <div className={`work-item${overdue ? ' overdue' : ''}${open ? ' open' : ''}`}>
      <div className="work-row" onClick={() => setOpen((o) => !o)}>
        <Channel value={task.channel} showLabel={false} />
        <div className="work-main">
          <div className="work-name truncate">
            {task.escalated && (
              <span className="tag" style={{ marginRight: 6, background: 'var(--danger)', color: '#fff' }}
                title="More than 1 business day overdue">Escalated</span>
            )}
            {task.kind === 'respond' && <span className="tag" style={{ marginRight: 6 }}>Reply</span>}
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
          ) : isRecheck ? (
            <div className="small faint">
              Check, then answer below. Still open puts them back into {task.campaign?.name || 'the campaign'}.
            </div>
          ) : (
            <div className="small faint">This stage has no script. Use your own judgement.</div>
          )}

          <div className="divider" />

          {!isRecheck && <div className="grid grid-2">
            {(task.channel === 'call' || (task.channel === 'linkedin' && outcomeList.length > 0)) && (
              <div className="field" style={{ margin: 0 }}>
                <label className="label">{task.channel === 'call' ? 'How did the call go?' : 'What happened? (optional)'}</label>
                <select className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  <option value="">{task.channel === 'call' ? 'Pick an outcome…' : 'Just sent — nothing back yet'}</option>
                  {outcomeList.filter((o) => o.key !== 'voicemail' || !task.enrollment || task.voicemailAllowed).map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
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
          </div>}

          {!isRecheck && (
            <>
              <OutcomeFields def={outcomeDef} person={person} setPerson={setPerson}
                restartDate={restartDate} setRestartDate={setRestartDate} />
              <NextStepBox preview={preview} />
            </>
          )}

          <div className="field" style={{ marginTop: 12 }}>
            <label className="label">Notes (saved to the timeline)</label>
            <textarea
              className="textarea" style={{ minHeight: 62 }} value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened? Anything worth remembering next time."
            />
          </div>

          <div className="row">
            {isRecheck ? (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={() => answerRecheck('open')}>
                  {busy ? 'Saving…' : `Still open — re-enrol in ${task.campaign?.name || 'campaign'}`}
                </button>
                <button className="btn" disabled={busy} onClick={() => answerRecheck('closed')}>
                  Closed / filled
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary" disabled={busy || (task.channel === 'call' && !outcome)}
                onClick={complete}
              >
                {busy ? 'Saving…' : task.channel === 'call' ? 'Log call & close' : 'Mark done'}
              </button>
            )}
            <button className="btn" disabled={busy}
              onClick={() => run(() => api.snoozeTask(task._id, 1), 'Snoozed to tomorrow')}>
              Snooze 1 day
            </button>
            <button className="btn" disabled={busy}
              onClick={() => run(() => api.snoozeTask(task._id, 7), 'Snoozed a week')}>
              Snooze 1 week
            </button>
            {canEnrollHere && (
              <button className="btn" disabled={busy || enrollBlocked} onClick={openEnroll}
                title={enrollBlocked
                  ? (outcome ? 'Not available after Not interested or Don\'t call again' : 'Pick how the call went first')
                  : 'Log this task, then move the contact to another campaign'}>
                Enroll in a campaign
              </button>
            )}
            <div className="spacer" />
            {task.assignRole && (
              <button className="btn btn-ghost btn-sm" disabled={busy}
                title="Put this back in the shared queue for someone else in the role to claim"
                onClick={() => run(() => api.releaseTask(task._id), 'Put back in the queue')}>
                Put back in queue
              </button>
            )}
            {task.enrollment && !task.isManual && !isRecheck && (
              <button className="btn btn-sm" disabled={busy}
                title="Skip this campaign step for this contact and move them to the next step now"
                onClick={() => run(() => api.skipTaskStep(task._id, 'Skipped from the work queue'), 'Step skipped — moved to the next step')}>
                Skip step →
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={busy}
              title="Close this task only. The contact stays on this step until its wait is over."
              onClick={() => run(() => api.skipTask(task._id, 'Skipped from the work queue'), 'Skipped')}>
              Skip task
            </button>
          </div>
          {task.channel === 'call' && !outcome && (
            <div className="hint">Pick an outcome — it is what makes the cold-call report meaningful.</div>
          )}
          {task.channel === 'call' && task.enrollment && (
            <div className="hint">
              {task.voicemailAllowed
                ? 'Voicemail: allowed on this call — it is the flow\u2019s one voicemail.'
                : 'No voicemail on this call (not a “+ VM” step, or the flow\u2019s one voicemail is used). If no one answers, log No Answer.'}
            </div>
          )}
          {task.swappedFrom === 'email' && (
            <div className="hint">This replaces an email step: their email bounced.</div>
          )}
          {canEnrollHere && task.channel === 'call' && ENDING_OUTCOMES.includes(outcome) && (
            <div className="hint">“Enroll in a campaign” is off for this outcome: the contact is being marked Lost.</div>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmNext
          plan={preview.plan} busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={async () => { const next = confirming.then; setConfirming(null); await next() }}
        />
      )}

      {enrollOpen && (
        <Modal
          title="Enroll in a campaign"
          onClose={() => !busy && setEnrollOpen(false)}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setEnrollOpen(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !target}
                onClick={() => {
                  if (!preview.destructive) return logAndEnroll()
                  setEnrollOpen(false)
                  setConfirming({ then: logAndEnroll })
                }}>
                {busy ? 'Working…' : task.channel === 'call' ? 'Log call & enroll' : 'Mark done & enroll'}
              </button>
            </>
          }
        >
          {!campaigns ? (
            <div className="small faint">Loading campaigns…</div>
          ) : (
            <>
              <div className="field">
                <label className="label">Campaign for {fullName(contact)}</label>
                <CampaignSelect campaigns={campaigns} value={target} onChange={setTarget} autoFocus />
              </div>
              <div className="hint">
                {task.channel === 'call'
                  ? `First the call is logged as “${outcomeDef?.label || outcome}”${notes ? ' with your notes' : ''}. `
                  : 'First this task is marked done. '}
                Then {contact.firstName || 'the contact'} leaves every campaign they are in now (their pending tasks
                and drafts are cancelled) and starts stage 1 of the campaign you pick. The timeline keeps everything.
              </div>
              <CampaignChoiceHint campaign={campaigns.find((c) => c._id === target)} />
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
