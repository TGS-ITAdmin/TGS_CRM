import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { CustomFieldValue } from '../components/CustomFieldInput.jsx'
import { useToast } from '../components/Toast.jsx'
import ContactForm from '../components/ContactForm.jsx'
import WorkItem from '../components/WorkItem.jsx'
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
  const { statusMap, statuses, isAdmin, can } = useAuth()
  const toast = useToast()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState(null)
  const [note, setNote] = useState('')
  const [noteType, setNoteType] = useState('note')
  const [noteChannel, setNoteChannel] = useState('')
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
      await api.addNote(contact._id, { body: note, type: noteType, channel: noteChannel || undefined })
      setNote('')
      toast.success(noteType === 'reply_logged' ? 'Reply logged' : 'Note saved')
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
          onChange={(e) => act(() => api.updateContact(contact._id, { status: e.target.value }), 'Status updated')}
        >
          {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button className="btn btn-sm" onClick={() => setDialog('edit')}>Edit</button>
        {can('campaigns.enroll') && (
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('enroll')}>Add to campaign</button>
        )}
      </div>

      <div className="page">
        {contact.doNotContact && (
          <div className="banner banner-danger">
            <span>⛔</span>
            <div>
              <strong>Do not contact.</strong>{' '}
              {contact.unsubscribedAt
                ? `This person unsubscribed on ${dateTime(contact.unsubscribedAt)}. Emailing them again would be a compliance breach.`
                : 'This contact is suppressed. No email will be queued or sent for them.'}
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
                            <Link to={`/campaigns/${e.campaign?._id}`}>{e.campaign?.name || '(deleted)'}</Link>
                            {e.status !== 'active' && (
                              <span className="tag" style={{ marginLeft: 8 }}>{e.status}</span>
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
                        {e.status === 'active' && (
                          <div className="work-actions">
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
              <div className="card-body">
                <button
                  className="btn btn-block btn-sm"
                  onClick={() =>
                    act(
                      () => api.updateContact(contact._id, { doNotContact: !contact.doNotContact }),
                      contact.doNotContact ? 'Flag cleared on the record' : 'Flagged do not contact'
                    )
                  }
                >
                  {contact.doNotContact ? 'Clear do-not-contact flag' : 'Flag do not contact'}
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
