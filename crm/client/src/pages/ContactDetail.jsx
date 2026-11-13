import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { CustomFieldValue } from '../components/CustomFieldInput.jsx'
import { useToast } from '../components/Toast.jsx'
import ContactForm from '../components/ContactForm.jsx'
import WorkItem from '../components/WorkItem.jsx'
import LostReasonDialog from '../components/LostReasonDialog.jsx'
import { Channel, Confirm, CopyButton, Empty, Loading, Modal, StatusPill } from '../components/ui.jsx'
import { dateTime, fullName, relativeDate } from '../components/format.js'

const DOT_CLASS = {
  email_sent: 'email', email_failed: 'alert', email_suppressed: 'alert',
  linkedin_action: 'linkedin', call_logged: 'call',
  unsubscribed: 'alert', dnc_added: 'alert',
}

function Row({ label, children }) {
  if (!children) return null
  return (
    <div style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: 13 }}>
      <div className="faint" style={{ width: 130, flex: '0 0 130px' }}>{label}</div>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  )
}

export default function ContactDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { statusMap, statuses, isAdmin, can, statusRoles, emailStatuses, dncStatuses } = useAuth()
  const toast = useToast()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState(null)
  // Status waiting on a Lost reason before it is saved.
  const [pendingLost, setPendingLost] = useState(null)
  const [note, setNote] = useState('')
  const [noteType, setNoteType] = useState('note')
  const [noteChannel, setNoteChannel] = useState('')
  const [replyType, setReplyType] = useState('positive')
  const [restartDate, setRestartDate] = useState('')
  const [campaigns, setCampaigns] = useState([])

  const load = useCallback(async () => {
    try {
      setData(await api.getContact(id))
    } catch (err) {
      toast.error(err.message)
      navigate('/contacts')
    } finally {
      setLoading(false)
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.listCampaigns({ active: 'true' }).then((d) => setCampaigns(d.campaigns)).catch(() => {})
  }, [])

  if (loading) return <Loading />
  if (!data) return null
  const { contact, activities, enrollments, pendingTasks, queuedMessages, customFields } = data
  const active = enrollments.filter((e) => e.status === 'active')

  async function saveNote() {
    if (!note.trim()) return
    try {
      const res = await api.addNote(contact._id, {
        body: note, type: noteType, channel: noteChannel || undefined,
        ...(noteType === 'reply_logged' ? { replyType, restartDate: restartDate || undefined } : {}),
      })
      setNote('')
      if (noteType !== 'reply_logged') toast.success('Note saved')
      else {
        const r = res.reply
        toast.success(r && r.paused
          ? `Reply logged · ${r.paused} flow${r.paused === 1 ? '' : 's'} paused${r.respondTask ? ' · Respond task created' : ''}`
          : 'Reply logged')
      }
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function act(fn, message) {
    try {
      await fn()
      toast.success(message)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <>
      <div className="topbar">
        <Link className="btn btn-ghost btn-sm" to="/contacts">←</Link>
        <div style={{ minWidth: 0 }}>
          <h1 className="truncate">{fullName(contact)}</h1>
          <div className="topbar-sub truncate">
            {[contact.title, contact.company?.name || contact.companyName].filter(Boolean).join(' · ') || 'No title or company recorded'}
          </div>
        </div>
        <div className="spacer" />
        <StatusPill value={contact.status} statusMap={statusMap} />
        <select
          className="select" style={{ maxWidth: 160 }} value={contact.status}
          onChange={(e) => {
            const status = e.target.value
            // Lost needs a reason first (G17).
            if (status && status === statusRoles.lost) setPendingLost(status)
            else act(() => api.updateContact(contact._id, { status }), 'Status updated')
          }}
        >
          {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button className="btn btn-sm" onClick={() => setDialog('edit')}>Edit</button>
        {can('campaigns.enroll') && (
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('enroll')}>Add to campaign</button>
        )}
      </div>

      <div className="page">
        {contact.company?.locked && (
          <div className="banner banner-warn">
            <span>🔒</span>
            <div>
              <strong>{contact.company.name} is locked</strong> — {contact.company.lockReason || 'someone there replied or booked'}.
              Other contacts there are paused and no one new can be enrolled.{' '}
              <Link to={`/companies/${contact.company._id}`}>Open the company</Link> to clear it.
            </div>
          </div>
        )}
        {(contact.status === statusRoles.lost || contact.nurture) && (
          <div className="banner banner-info">
            <span>ℹ</span>
            <div>
              {contact.status === statusRoles.lost && (
                <><strong>Lost</strong>{contact.lostReason ? ` — ${contact.lostReason}` : ''}. </>
              )}
              {contact.nurture && <><strong>Nurture is on</strong> — kept on the monthly nurture emails.</>}
              {contact.restartDate && <> Check back on {new Date(contact.restartDate).toLocaleDateString()}.</>}
            </div>
          </div>
        )}
        {!contact.doNotContact && (contact.emailStatus && contact.emailStatus !== 'valid') && (
          <div className="banner banner-warn">
            <span>✉</span>
            <div>
              <strong>No email:</strong>{' '}
              {contact.emailStatus === 'bounced'
                ? 'this address bounced. Email steps are skipped; calls and LinkedIn carry on.'
                : `unsubscribed${contact.unsubscribedAt ? ` on ${dateTime(contact.unsubscribedAt)}` : ''}. Email steps are skipped; calls are still allowed unless DNC status says otherwise.`}
            </div>
          </div>
        )}
        {!contact.doNotContact && contact.dncStatus && contact.dncStatus !== 'clear' && (
          <div className="banner banner-warn">
            <span>☎</span>
            <div>
              <strong>No calls:</strong>{' '}
              {(dncStatuses.find((d) => d.value === contact.dncStatus) || {}).label || contact.dncStatus}.
              Call steps are skipped; email and LinkedIn carry on unless Email status says otherwise.
            </div>
          </div>
        )}
        {contact.doNotContact && (
          <div className="banner banner-danger">
            <span>⛔</span>
            <div>
              <strong>Do not contact.</strong>{' '}
              This contact is fully suppressed: no emails, calls or LinkedIn tasks are created for them.
            </div>
          </div>
        )}

        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', alignItems: 'start' }}>
          {/* ---- Left column: work, campaigns, timeline ---- */}
          <div className="col" style={{ gap: 14 }}>
            {(pendingTasks.length > 0 || queuedMessages.length > 0) && (
              <div className="card">
                <div className="card-head"><h2>Open work</h2></div>
                <div className="card-body">
                  {pendingTasks.map((t) => (
                    <WorkItem key={t._id} task={{ ...t, contact }} onDone={load} />
                  ))}
                  {queuedMessages.map((m) => (
                    <div className="work-item" key={m._id}>
                      <div className="work-row" style={{ cursor: 'default' }}>
                        <Channel value="email" showLabel={false} />
                        <div className="work-main">
                          <div className="work-name truncate">{m.subject || '(no subject)'}</div>
                          <div className="work-meta">Draft waiting for approval · {m.stageName}</div>
                        </div>
                        <Link className="btn btn-sm" to="/outbox">Review →</Link>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>Campaigns</h2>
                <span className="small faint">{active.length} active</span>
              </div>
              <div className="card-body">
                {enrollments.length === 0 ? (
                  <Empty icon="⚑" title="Not in any campaign"
                    action={can('campaigns.enroll') ? <button className="btn btn-primary btn-sm" onClick={() => setDialog('enroll')}>Add to a campaign</button> : null}>
                    Adding this contact to a campaign generates their first task or draft straight away.
                  </Empty>
                ) : (
                  enrollments.map((e) => (
                    <div key={e._id} className="work-item">
                      <div className="work-row" style={{ cursor: 'default' }}>
                        <div className="work-main">
                          <div className="work-name">
                            {e.campaign
                              ? <Link to={`/campaigns/${e.campaign._id}`}>{e.campaign.name}</Link>
                              : <span className="faint">(deleted campaign)</span>}
                            {e.status !== 'active' && (
                              <span className="tag" style={{ marginLeft: 8 }}>
                                {e.status === 'paused'
                                  ? `paused — ${{ reply: 'they replied', company_lock: 'company locked', manual: 'by hand' }[e.pausedReason] || 'paused'}`
                                  : e.status}
                              </span>
                            )}
                          </div>
                          <div className="work-meta">
                            {e.currentStage ? (
                              <>
                                Stage {e.currentStageIndex + 1} of {e.totalStages} — {e.currentStage.name}
                                {' · '}<Channel value={e.currentStage.channel} />
                                {e.status === 'active' && e.dueAt && <> · moves on {relativeDate(e.dueAt)}</>}
                              </>
                            ) : (
                              e.exitReason || 'Finished'
                            )}
                          </div>
                        </div>
                        {e.status === 'paused' && (
                          <div className="work-actions">
                            <button className="btn btn-primary btn-sm"
                              onClick={() => act(() => api.resumeFlow(contact._id, e._id), 'Flow resumed')}>
                              Resume
                            </button>
                            <button className="btn btn-sm btn-ghost"
                              onClick={() => act(() => api.exitEnrollment(e._id, 'Removed from the contact page'), 'Removed from campaign')}>
                              Remove
                            </button>
                          </div>
                        )}
                        {e.status === 'active' && (
                          <div className="work-actions">
                            <button className="btn btn-sm"
                              onClick={() => act(() => api.pauseFlow(contact._id, e._id), 'Flow paused')}>
                              Pause
                            </button>
                            <button className="btn btn-sm"
                              onClick={() => act(() => api.snoozeEnrollment(e._id, 7), 'Snoozed a week')}>
                              Snooze
                            </button>
                            <button className="btn btn-sm"
                              onClick={() => act(() => api.advanceEnrollment(e._id), 'Moved to the next stage')}>
                              Next stage →
                            </button>
                            <button className="btn btn-sm btn-ghost"
                              onClick={() => act(() => api.exitEnrollment(e._id, 'Removed from the contact page'), 'Removed from campaign')}>
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
                {enrollments.length > 0 && can('campaigns.enroll') && (
                  <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setDialog('move')}>
                    Move to a different campaign
                  </button>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-head"><h2>Log something</h2></div>
              <div className="card-body">
                <div className="row" style={{ marginBottom: 8 }}>
                  <select className="select" style={{ maxWidth: 190 }} value={noteType}
                    onChange={(e) => setNoteType(e.target.value)}>
                    <option value="note">Note</option>
                    <option value="reply_logged">They replied</option>
                  </select>
                  {noteType === 'reply_logged' && (
                    <select className="select" style={{ maxWidth: 200 }} value={replyType}
                      onChange={(e) => setReplyType(e.target.value)}>
                      <option value="positive">Positive / interested</option>
                      <option value="other">Question / other</option>
                      <option value="not_now">Not now</option>
                      <option value="not_interested">Not interested</option>
                      <option value="unsubscribe">Stop / remove me</option>
                    </select>
                  )}
                  {noteType === 'reply_logged' && (
                    <select className="select" style={{ maxWidth: 150 }} value={noteChannel}
                      onChange={(e) => setNoteChannel(e.target.value)}>
                      <option value="">Which channel?</option>
                      <option value="linkedin">LinkedIn</option>
                      <option value="email">Email</option>
                      <option value="call">Call</option>
                    </select>
                  )}
                </div>
                <textarea
                  className="textarea" style={{ minHeight: 70 }} value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={noteType === 'reply_logged'
                    ? 'Paste what they said. Logging a reply is what feeds the channel report.'
                    : 'Anything worth remembering.'}
                />
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" disabled={!note.trim()} onClick={saveNote}>
                    Save
                  </button>
                  {noteType === 'reply_logged' && !noteChannel && (
                    <span className="hint" style={{ margin: 0 }}>Pick a channel so the report can attribute it.</span>
                  )}
                </div>
                {noteType === 'reply_logged' && replyType === 'not_now' && (
                  <div className="field" style={{ marginTop: 8, marginBottom: 0, maxWidth: 260 }}>
                    <label className="label">Check back on (optional)</label>
                    <input className="input" type="date" value={restartDate} onChange={(e) => setRestartDate(e.target.value)} />
                    <div className="hint">Blank = in 90 days. Nurture is switched on.</div>
                  </div>
                )}
                {noteType === 'reply_logged' && (
                  <div className="hint" style={{ marginTop: 8 }}>
                    {{
                      positive: 'Pauses their flows, locks the company, and creates a Respond task due within 15 minutes (business hours).',
                      other: 'Pauses their flows, locks the company, and creates a Respond task for the next business day.',
                      not_now: 'Pauses their flows and locks the company. Nurture on, with the check-back date above.',
                      not_interested: 'Lost (Not interested) with Nurture on; their flows end and the company is locked.',
                      unsubscribe: 'Email status → Unsubscribed (no more email). Lost; their flows end and the company is locked.',
                    }[replyType]}
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>Timeline</h2>
                <span className="small faint">{activities.length} entries</span>
              </div>
              <div className="card-body">
                {activities.length === 0 ? (
                  <Empty icon="🕓" title="Nothing yet">Activity appears here as you work this contact.</Empty>
                ) : (
                  <div className="timeline">
                    {activities.map((a) => (
                      <div className="tl-item" key={a._id}>
                        <span className={`tl-dot ${DOT_CLASS[a.type] || a.channel || ''}`} />
                        <div className="tl-title">{a.title}</div>
                        <div className="tl-meta">
                          {dateTime(a.createdAt)}
                          {a.user?.name && <> · {a.user.name}</>}
                          {a.campaign?.name && <> · {a.campaign.name}</>}
                          {!a.user && a.type === 'stage_advanced' && <> · automatic</>}
                        </div>
                        {a.body && <div className="tl-body">{a.body}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ---- Right column: the record ---- */}
          <div className="col" style={{ gap: 14 }}>
            <div className="card">
              <div className="card-head"><h2 style={{ flex: 1 }}>Details</h2></div>
              <div className="card-body" style={{ paddingTop: 8 }}>
                <Row label="Email">
                  {contact.email ? (
                    <div className="row" style={{ gap: 6 }}>
                      <a href={`mailto:${contact.email}`} className="truncate">{contact.email}</a>
                      <CopyButton text={contact.email} label="Copy" className="btn btn-ghost btn-sm" />
                    </div>
                  ) : null}
                </Row>
                <Row label="Phone">
                  {contact.phone ? (
                    <div className="row" style={{ gap: 6 }}>
                      <a href={`tel:${contact.phone}`}>{contact.phone}</a>
                      <CopyButton text={contact.phone} label="Copy" className="btn btn-ghost btn-sm" />
                    </div>
                  ) : null}
                </Row>
                <Row label="LinkedIn">
                  {contact.linkedinUrl ? (
                    <a href={contact.linkedinUrl} target="_blank" rel="noreferrer noopener">Open profile ↗</a>
                  ) : null}
                </Row>
                <Row label="Company">
                  {contact.company ? (
                    <Link to={`/companies/${contact.company._id}`}>{contact.company.name}</Link>
                  ) : contact.companyName ? (
                    <span className="faint">{contact.companyName} (not linked)</span>
                  ) : null}
                </Row>
                <Row label="Location">{contact.location}</Row>
                <Row label="Timezone">{contact.timezone || <span className="faint">Not set</span>}</Row>
                <Row label="Owner">{contact.owner?.name}</Row>
                <Row label="Source">{contact.source}</Row>
                <Row label="Tags">
                  {contact.tags?.length ? (
                    <div className="row wrap" style={{ gap: 4 }}>
                      {contact.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
                    </div>
                  ) : null}
                </Row>
                <Row label="Added">{dateTime(contact.createdAt)}</Row>
                <Row label="Last contacted">{contact.lastContactedAt ? relativeDate(contact.lastContactedAt) : <span className="faint">Never</span>}</Row>
              </div>
            </div>

            {contact.company ? (
              <div className="card">
                <div className="card-head">
                  <h2 style={{ flex: 1 }}>
                    <Link to={`/companies/${contact.company._id}`}>{contact.company.name}</Link>
                  </h2>
                </div>
                <div className="card-body" style={{ paddingTop: 8 }}>
                  <Row label="Industry">{contact.company.industry}</Row>
                  <Row label="Company size">{contact.company.employeeCount}</Row>
                  <Row label="Website">
                    {contact.company.website ? (
                      <a href={contact.company.website.startsWith('http') ? contact.company.website : `https://${contact.company.website}`}
                        target="_blank" rel="noreferrer noopener" className="truncate">{contact.company.website}</a>
                    ) : null}
                  </Row>
                  <Row label="Company LinkedIn">
                    {contact.company.linkedinUrl ? (
                      <a href={contact.company.linkedinUrl} target="_blank" rel="noreferrer noopener">Open ↗</a>
                    ) : null}
                  </Row>
                  <div className="divider" style={{ margin: '10px 0' }} />
                  <Row label="Current provider">{contact.company.currentProvider}</Row>
                  <Row label="Seats needed">{contact.company.seatsNeeded ?? null}</Row>
                  <Row label="Target roles">{contact.company.targetRoles}</Row>
                  <Row label="Contract timing">{contact.company.contractTiming}</Row>
                  <Row label="Budget">{contact.company.budgetRange}</Row>
                  <div className="hint" style={{ marginTop: 8 }}>
                    Qualification lives on the company, so everyone you know there shares it.{' '}
                    <Link to={`/companies/${contact.company._id}`}>Edit on the company →</Link>
                  </div>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-body">
                  <div className="small muted" style={{ marginBottom: 10 }}>
                    This contact is not linked to a company, so qualification details and the shared
                    timeline have nowhere to live.
                  </div>
                  <button className="btn btn-sm btn-block" onClick={() => setDialog('edit')}>
                    Link a company
                  </button>
                </div>
              </div>
            )}

            {customFields?.length > 0 && customFields.some((f) => f.active !== false) && (
              <div className="card">
                <div className="card-head"><h2>Additional details</h2></div>
                <div className="card-body" style={{ paddingTop: 8 }}>
                  {customFields.filter((f) => f.active !== false).map((f) => (
                    <Row key={f.key} label={f.label}>
                      <CustomFieldValue field={f} value={contact.customFields?.[f.key]} />
                    </Row>
                  ))}
                </div>
              </div>
            )}

            {contact.notes && (
              <div className="card">
                <div className="card-head"><h2>Notes</h2></div>
                <div className="card-body small" style={{ whiteSpace: 'pre-wrap' }}>{contact.notes}</div>
              </div>
            )}

            <div className="card">
              <div className="card-head"><h2>Outreach permissions</h2></div>
              <div className="card-body">
                <div className="field">
                  <label className="label">Email status</label>
                  <select className="select" value={contact.emailStatus || 'valid'}
                    onChange={(e) => act(() => api.updateContact(contact._id, { emailStatus: e.target.value }), 'Email status updated')}>
                    {emailStatuses.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <div className="hint">Unsubscribed stops emails only, and sets the contact to Lost.</div>
                </div>
                <div className="field">
                  <label className="label">DNC status</label>
                  <select className="select" value={contact.dncStatus || 'clear'}
                    onChange={(e) => act(() => api.updateContact(contact._id, { dncStatus: e.target.value }), 'DNC status updated')}>
                    {dncStatuses.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <div className="hint">Anything but Clear stops calls only. A do-not-call request also sets the contact to Lost.</div>
                </div>
                <label className="row small" style={{ gap: 8, marginBottom: 14, cursor: 'pointer' }}>
                  <input type="checkbox" className="checkbox" checked={!!contact.nurture}
                    onChange={(e) => act(() => api.updateContact(contact._id, { nurture: e.target.checked }),
                      e.target.checked ? 'Nurture on' : 'Nurture off')} />
                  Nurture (monthly nurture emails)
                </label>
                <button
                  className="btn btn-block btn-sm"
                  onClick={() =>
                    act(
                      () => api.updateContact(contact._id, { doNotContact: !contact.doNotContact }),
                      contact.doNotContact ? 'Flag cleared on the record' : 'Flagged do not contact'
                    )
                  }
                >
                  {contact.doNotContact ? 'Clear do-not-contact flag' : 'Flag do not contact (stops everything)'}
                </button>
                {contact.doNotContact && (
                  <div className="hint">
                    Clearing the flag here does not remove them from the global suppression list — do that in
                    Settings → Do Not Contact.
                  </div>
                )}
                {isAdmin && (
                  <button className="btn btn-danger btn-block btn-sm" style={{ marginTop: 8 }}
                    onClick={() => setDialog('delete')}>
                    Delete contact
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {dialog === 'edit' && (
        <Modal title="Edit contact" width="wide" onClose={() => setDialog(null)}>
          <ContactForm
            initial={contact} submitLabel="Save changes" onCancel={() => setDialog(null)}
            onSubmit={async (values) => {
              await api.updateContact(contact._id, values)
              toast.success('Contact updated')
              setDialog(null)
              load()
            }}
          />
        </Modal>
      )}

      {(dialog === 'enroll' || dialog === 'move') && (
        <EnrollDialog
          mode={dialog} campaigns={campaigns} contactId={contact._id}
          onClose={() => setDialog(null)}
          onDone={(msg) => { toast.success(msg); setDialog(null); load() }}
        />
      )}

      {pendingLost && (
        <LostReasonDialog
          initialReason={contact.lostReason} initialNurture={contact.nurture}
          onClose={() => setPendingLost(null)}
          onConfirm={async ({ lostReason, nurture }) => {
            await api.updateContact(contact._id, { status: pendingLost, lostReason, nurture })
            toast.success('Set to Lost')
            setPendingLost(null)
            load()
          }}
        />
      )}

      {dialog === 'delete' && (
        <Confirm
          danger title="Delete this contact" confirmLabel="Delete permanently"
          message="The contact, their whole timeline, tasks and queued emails are removed. This cannot be undone."
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteContact(contact._id)
            toast.success('Contact deleted')
            navigate('/contacts')
          }}
        />
      )}
    </>
  )
}

function EnrollDialog({ mode, campaigns, contactId, onClose, onDone }) {
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  // Only campaigns that have stages and that this person is allowed to use.
  const usable = campaigns.filter((c) => (c.stages || []).length > 0 && c.canEnroll !== false)

  async function go() {
    setBusy(true)
    try {
      if (mode === 'move') {
        const res = await api.moveContacts({ contactIds: [contactId], toCampaign: id })
        onDone(`Moved · ${res.cancelledTasks} task${res.cancelledTasks === 1 ? '' : 's'} and ${res.cancelledMessages} draft${res.cancelledMessages === 1 ? '' : 's'} cancelled`)
      } else {
        await api.enrollContacts(id, [contactId])
        onDone('Added to the campaign')
      }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={mode === 'move' ? 'Move to another campaign' : 'Add to a campaign'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={`btn ${mode === 'move' ? 'btn-danger' : 'btn-primary'}`} disabled={!id || busy} onClick={go}>
            {busy ? 'Working…' : mode === 'move' ? 'Move' : 'Add'}
          </button>
        </>
      }
    >
      {usable.length === 0 ? (
        <Empty icon="⚑" title="No usable campaigns">
          There is no active campaign with at least one stage that you are allowed to use.
          Create one, or ask an admin to give you access under Settings → Users.
        </Empty>
      ) : (
        <>
          <div className="field">
            <label className="label">Campaign</label>
            <select className="select" value={id} onChange={(e) => setId(e.target.value)} autoFocus>
              <option value="">Choose…</option>
              {usable.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name} ({c.stages.length} stage{c.stages.length === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </div>
          <div className="hint">
            {mode === 'move'
              ? 'Exits every campaign this contact is currently in, cancels their pending work, and starts them at stage 1 of the new one. The timeline keeps everything.'
              : 'The contact enters at stage 1 and their first task or draft is created immediately. Existing campaigns are left alone.'}
          </div>
        </>
      )}
    </Modal>
  )
}
