import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Channel, Confirm, Field, Loading, Modal } from '../components/ui.jsx'

const CHANNELS = [
  { value: 'linkedin', label: 'LinkedIn message' },
  { value: 'email', label: 'Email' },
  { value: 'call', label: 'Cold call' },
]

const CHANNEL_HELP = {
  linkedin:
    'Becomes a task with this message merged and ready to copy. The CRM never sends on LinkedIn — automating LinkedIn breaks their terms and gets accounts restricted.',
  email:
    'Becomes a draft in Ready to Send. Nothing goes out until a person reviews and clicks send.',
  call: 'Becomes a call task with this script attached, and appears in the timezone-aware call list.',
}

export default function CampaignEditor() {
  const { id } = useParams()
  const { can, mergeFields, users } = useAuth()
  const isAdmin = can('campaigns.manage')
  const toast = useToast()

  const [campaign, setCampaign] = useState(null)
  const [stageCounts, setStageCounts] = useState({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(null)
  const [confirming, setConfirming] = useState(null)
  // Every campaign, for a branch's "exit and start another campaign" choice.
  const [allCampaigns, setAllCampaigns] = useState([])
  useEffect(() => { api.listCampaigns().then((d) => setAllCampaigns(d.campaigns || [])).catch(() => {}) }, [])

  const load = useCallback(async () => {
    try {
      const data = await api.getCampaign(id)
      setCampaign(data.campaign)
      setStageCounts(data.stageCounts)
      setDirty(false)
    } catch (err) {
      toast.error(err.message)
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  if (!campaign) return <Loading />
  const stages = campaign.stages

  const patch = (fn) => {
    setCampaign((c) => fn(structuredClone(c)))
    setDirty(true)
  }

  const setStage = (i, key, value) =>
    patch((c) => { c.stages[i][key] = value; return c })

  const addStage = () =>
    patch((c) => {
      c.stages.push({ name: `Stage ${c.stages.length + 1}`, channel: 'email', subject: '', body: '', waitDays: 3 })
      return c
    })

  const removeStage = (i) => patch((c) => { c.stages.splice(i, 1); return c })

  const moveStage = (i, dir) =>
    patch((c) => {
      const j = i + dir
      if (j < 0 || j >= c.stages.length) return c
      ;[c.stages[i], c.stages[j]] = [c.stages[j], c.stages[i]]
      return c
    })

  async function save() {
    setSaving(true)
    try {
      await api.updateCampaign(id, {
        name: campaign.name,
        description: campaign.description,
        stages: campaign.stages,
        active: campaign.active,
        recheck: campaign.recheck,
        cold: campaign.cold === true,
        businessDays: campaign.businessDays !== false,
      })
      toast.success('Campaign saved')
      load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const totalDays = stages.reduce((sum, s) => sum + Number(s.waitDays || 0), 0)

  return (
    <>
      <div className="topbar">
        <Link className="btn btn-ghost btn-sm" to="/campaigns">←</Link>
        <div style={{ minWidth: 0 }}>
          <h1 className="truncate">{campaign.name}</h1>
          <div className="topbar-sub">
            {stages.length} stage{stages.length === 1 ? '' : 's'} · runs {totalDays} day{totalDays === 1 ? '' : 's'} end to end
            {!campaign.active && ' · paused'}
          </div>
        </div>
        <div className="spacer" />
        <Link className="btn btn-sm" to={`/board/${id}`}>Board</Link>
        <Link className="btn btn-sm" to={`/reports?campaign=${id}&tab=funnel`}>Funnel</Link>
        {isAdmin && (
          <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        )}
      </div>

      <div className="page">
        {!isAdmin && (
          <div className="banner banner-info">
            <span>ℹ</span>
            <div>You are viewing this campaign. Only admins can change stages and messages.</div>
          </div>
        )}

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body">
            <div className="grid grid-2">
              <Field label="Campaign name">
                <input className="input" value={campaign.name} disabled={!isAdmin}
                  onChange={(e) => patch((c) => { c.name = e.target.value; return c })} />
              </Field>
              <Field label="Description">
                <input className="input" value={campaign.description} disabled={!isAdmin}
                  onChange={(e) => patch((c) => { c.description = e.target.value; return c })} />
              </Field>
            </div>
            {isAdmin && (
              <label className="row small">
                <input type="checkbox" className="checkbox" checked={campaign.active}
                  onChange={(e) => patch((c) => { c.active = e.target.checked; return c })} />
                Active — turn off to pause: nobody moves to the next stage, its open tasks and emails are hidden
                from My Day, the call list and Ready to Send, and no one can be added. Turning it back on picks up
                where it left off.
              </label>
            )}
            {isAdmin && (
              <label className="row small" style={{ marginTop: 8 }}>
                <input type="checkbox" className="checkbox" checked={campaign.cold === true}
                  onChange={(e) => patch((c) => { c.cold = e.target.checked; return c })} />
                Cold flow (F1–F3) — no email or call steps until the compliance sign-off is recorded, and touch
                caps apply (set both in Settings → Outreach rules).
              </label>
            )}
            {isAdmin && (
              <label className="row small" style={{ marginTop: 8 }}>
                <input type="checkbox" className="checkbox" checked={campaign.businessDays !== false}
                  onChange={(e) => patch((c) => { c.businessDays = e.target.checked; return c })} />
                Waits count business days (Mon–Fri, skipping holidays). Turn off for calendar-day flows like F6, F8, F9.
              </label>
            )}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body tight">
            <div className="small muted" style={{ padding: '8px 0' }}>
              <strong>Merge fields</strong> — click to copy. Add a fallback after a pipe so a blank never
              leaves a hole: <code className="kbd">{'{{first_name|there}}'}</code>
            </div>
            <div className="row wrap" style={{ gap: 4, paddingBottom: 8 }}>
              {mergeFields.map((f) => (
                <button
                  key={f} type="button" className="tag" style={{ cursor: 'pointer' }}
                  onClick={() => {
                    navigator.clipboard?.writeText(`{{${f}}}`)
                    toast.success(`Copied {{${f}}}`)
                  }}
                >
                  {`{{${f}}}`}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="col" style={{ gap: 12 }}>
          {stages.length > 0 && <FlowDiagram stages={stages} campaigns={allCampaigns} />}

          {stages.map((stage, i) => (
            <div className="card" key={i}>
              <div className="card-head">
                <span className="pill">{i + 1}</span>
                <Channel value={stage.channel} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="strong truncate">{stage.name}</span>
                  {stageCounts[i] > 0 && (
                    <span className="small faint"> · {stageCounts[i]} contact{stageCounts[i] === 1 ? '' : 's'} here now</span>
                  )}
                </div>
                <button className="btn btn-sm" onClick={() => setPreview(i)}>Preview</button>
                {isAdmin && (
                  <>
                    <button className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => moveStage(i, -1)}>↑</button>
                    <button className="btn btn-ghost btn-sm" disabled={i === stages.length - 1} onClick={() => moveStage(i, 1)}>↓</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(i)}>✕</button>
                  </>
                )}
              </div>
              <div className="card-body">
                <div className="grid grid-3">
                  <Field label="Stage name">
                    <input className="input" value={stage.name} disabled={!isAdmin}
                      onChange={(e) => setStage(i, 'name', e.target.value)} />
                  </Field>
                  <Field label="Channel">
                    <select className="select" value={stage.channel} disabled={!isAdmin}
                      onChange={(e) => setStage(i, 'channel', e.target.value)}>
                      {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </Field>
                  <Field
                    label="Wait before next stage (days)"
                    hint={i === stages.length - 1 ? 'After this wait the contact finishes the campaign.' : `Contact moves to "${stages[i + 1].name}" after this many days.`}
                  >
                    <input className="input" type="number" min="0" value={stage.waitDays} disabled={!isAdmin}
                      onChange={(e) => setStage(i, 'waitDays', Number(e.target.value))} />
                  </Field>
                </div>

                <div className="hint" style={{ marginTop: -4, marginBottom: 12 }}>{CHANNEL_HELP[stage.channel]}</div>
                {stage.channel === 'call' && (
                  <label className="row small" style={{ gap: 8, marginBottom: 12 }}>
                    <input type="checkbox" className="checkbox" checked={!!stage.voicemail} disabled={!isAdmin}
                      onChange={(e) => setStage(i, 'voicemail', e.target.checked)} />
                    “+ VM” — this call may leave the flow’s one voicemail
                  </label>
                )}
                {stage.channel === 'linkedin' && (
                  <label className="row small" style={{ gap: 8, marginBottom: 12 }}>
                    <input type="checkbox" className="checkbox" checked={!!stage.linkedinInvite} disabled={!isAdmin}
                      onChange={(e) => setStage(i, 'linkedinInvite', e.target.checked)} />
                    Connection invite — counts toward the daily invite cap per rep
                  </label>
                )}

                <BranchesPanel
                  stage={stage} index={i} stages={stages} campaignId={campaign._id}
                  campaigns={allCampaigns} disabled={!isAdmin}
                  onChange={(branches) => setStage(i, 'branches', branches)}
                />

                {stage.channel === 'email' && (
                  <Field label="Subject line">
                    <input className="input" value={stage.subject} disabled={!isAdmin}
                      onChange={(e) => setStage(i, 'subject', e.target.value)}
                      placeholder="Support capacity for {{company}}" />
                  </Field>
                )}

                <Field label={stage.channel === 'call' ? 'Call script' : 'Message'}>
                  <textarea
                    className="textarea mono" style={{ minHeight: 150 }} value={stage.body} disabled={!isAdmin}
                    onChange={(e) => setStage(i, 'body', e.target.value)}
                    placeholder={stage.channel === 'call'
                      ? 'OPENER\n…\n\nQUALIFY\n- …\n\nCLOSE\n…'
                      : 'Hi {{first_name|there}},\n\n…'}
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>

        {isAdmin && (
          <button className="btn" style={{ marginTop: 12 }} onClick={addStage}>+ Add stage</button>
        )}

        {stages.length === 0 && (
          <div className="banner banner-warn" style={{ marginTop: 14 }}>
            This campaign has no stages, so contacts cannot be added to it yet.
          </div>
        )}

        <RecheckSettings
          recheck={campaign.recheck || {}} users={users} disabled={!isAdmin} campaignName={campaign.name}
          onChange={(key, value) => patch((c) => { c.recheck = { ...(c.recheck || {}), [key]: value }; return c })}
        />
      </div>

      {preview !== null && (
        <PreviewModal campaignId={id} index={preview} stage={stages[preview]} onClose={() => setPreview(null)} />
      )}

      {confirming !== null && (
        <Confirm
          danger title="Remove this stage"
          confirmLabel="Remove stage"
          message={
            stageCounts[confirming] > 0
              ? `${stageCounts[confirming]} contact(s) are sitting on "${stages[confirming].name}" right now. Removing it will be rejected when you save until you move them off. Remove it from the draft anyway?`
              : `"${stages[confirming].name}" will be removed when you save.`
          }
          onClose={() => setConfirming(null)}
          onConfirm={() => { removeStage(confirming); setConfirming(null) }}
        />
      )}
    </>
  )
}

function PreviewModal({ campaignId, index, stage, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    api.previewStage(campaignId, index)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [campaignId, index])

  return (
    <Modal title={`Preview — ${stage.name}`} onClose={onClose} width="wide">
      {error && <div className="banner banner-danger">{error}</div>}
      {!data && !error && <Loading label="Merging against a real contact…" />}
      {data && (
        <>
          <div className="small faint" style={{ marginBottom: 12 }}>
            Merged against {data.contactUsed ? <strong>{data.contactUsed.name || 'a contact'}</strong> : 'no contact — add one first'}.
          </div>

          {data.missing.length > 0 && (
            <div className="banner banner-warn">
              <span>⚠</span>
              <div>
                <strong>Blank on this contact:</strong> {data.missing.map((m) => `{{${m}}}`).join(', ')}.
                Add a fallback like <code className="kbd">{'{{first_name|there}}'}</code> so the sentence still reads.
              </div>
            </div>
          )}
          {data.unknown.length > 0 && (
            <div className="banner banner-danger">
              <span>✕</span>
              <div>
                <strong>Not a real merge field:</strong> {data.unknown.map((m) => `{{${m}}}`).join(', ')}.
                These will go out as literal text.
              </div>
            </div>
          )}
          {data.clean && <div className="banner banner-ok"><span>✓</span><div>Merges cleanly.</div></div>}

          {stage.channel === 'email' && (
            <>
              <div className="label">Subject</div>
              <div className="script-box" style={{ marginBottom: 12 }}>{data.subject || '(empty)'}</div>
            </>
          )}
          <div className="label">{stage.channel === 'call' ? 'Script' : 'Message'}</div>
          <div className="script-box">{data.body || '(empty)'}</div>

          {stage.channel === 'email' && (
            <div className="hint" style={{ marginTop: 10 }}>
              Your company name, postal address and an unsubscribe link are appended automatically at send
              time — you do not need to add them here.
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

/* "After the last stage": an optional check task some days after a contact
 * finishes with no response — for F2, "is the job post still open?". The
 * person answering it can put the contact straight back into this campaign. */
function RecheckSettings({ recheck, users, disabled, campaignName, onChange }) {
  const on = !!recheck.enabled
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head"><h2>After the last stage</h2></div>
      <div className="card-body">
        <label className="row" style={{ gap: 9, alignItems: 'flex-start', cursor: disabled ? 'default' : 'pointer' }}>
          <input type="checkbox" className="checkbox" style={{ marginTop: 2 }} checked={on} disabled={disabled}
            onChange={(e) => onChange('enabled', e.target.checked)} />
          <div>
            <div className="strong small">Create a re-check task after the campaign ends with no response</div>
            <div className="hint" style={{ marginTop: 2 }}>
              The task asks one question. Answering <strong>Still open</strong> puts the contact back into
              “{campaignName}” from stage 1; <strong>Closed</strong> just logs it. Contacts who replied, booked,
              were marked Lost or opted out never get the task.
            </div>
          </div>
        </label>

        {on && (
          <div style={{ marginTop: 14 }}>
            <div className="grid grid-2">
              <div className="field">
                <label className="label">Days after the campaign ends</label>
                <input className="input" type="number" min="1" max="365" value={recheck.days ?? 30} disabled={disabled}
                  onChange={(e) => onChange('days', Number(e.target.value))} />
              </div>
              <div className="field">
                <label className="label">Assign the task to</label>
                <select className="select" value={recheck.assignTo || ''} disabled={disabled}
                  onChange={(e) => onChange('assignTo', e.target.value || null)}>
                  <option value="">The contact's owner</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label className="label">Task title</label>
              <input className="input" value={recheck.title ?? 'Check if the job post is still open'} disabled={disabled}
                onChange={(e) => onChange('title', e.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Instructions shown on the task</label>
              <textarea className="textarea" rows={3} value={recheck.instructions || ''} disabled={disabled}
                placeholder="e.g. Open the job post URL on the contact. If the CSR / dispatcher role is still listed, choose Still open."
                onChange={(e) => onChange('instructions', e.target.value)} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- Branches: what happens next, per outcome ----------------
 * One row per outcome for this stage's channel, plus "No response". A row
 * with no customised branch keeps the built-in default (the CRM's behaviour
 * before branches); "Customise" stores a branch for that outcome. */

const PATH_LABEL = {
  stay: 'No change',
  continue: 'Go to the next stage now',
  jump: 'Jump to a later stage',
  wait: 'Wait, then the next stage',
  retry: 'Retry this step later',
  exit: 'Leave this campaign',
}

function branchSummary(b, def, stages, campaigns, statuses, lostRole) {
  const parts = []
  const stageName = (id) => (stages.find((s) => String(s._id) === String(id)) || {}).name || 'a later stage'
  switch (b.path) {
    case 'stay': parts.push(def.kind === 'conversation' ? 'Flows stay paused' : 'No change to the flow'); break
    case 'continue': parts.push('Next stage now'); break
    case 'jump': parts.push(`Jump to "${stageName(b.toStage)}"`); break
    case 'wait': parts.push(`Wait ${b.days} business day${b.days === 1 ? '' : 's'}, then next stage`); break
    case 'retry': parts.push(`Retry in ${b.days} business day${b.days === 1 ? '' : 's'} (up to ${b.maxTries}×), then next stage`); break
    case 'exit': {
      const to = campaigns.find((c) => String(c._id) === String(b.moveTo))
      parts.push(to ? `Leave and start "${to.name}"` : 'Leave the campaign')
      break
    }
    default:
  }
  if (b.setStatus) {
    const label = (statuses.find((s) => s.value === b.setStatus) || {}).label || b.setStatus
    parts.push(b.setStatus === lostRole ? `Lost (${b.lostReason || 'no reason'})` : `Status → ${label}`)
  }
  if (b.nurture) parts.push(`Nurture on (${b.restartDays} days)`)
  if (b.taskTitle) parts.push(`Task: "${b.taskTitle}"`)
  if (b.dnc) parts.push('Flag do not contact')
  const fixed = def.kind === 'conversation' ? 'Pause flows + lock company, then: '
    : def.kind === 'suppression' ? `${def.defaultText}. Plus: ` : ''
  return fixed + (parts.join(' · ') || 'nothing extra')
}

function BranchesPanel({ stage, index, stages, campaignId, campaigns, disabled, onChange }) {
  const { outcomeCatalogue, statuses, statusRoles } = useAuth()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const outcomes = [...(outcomeCatalogue?.[stage.channel] || []), ...(outcomeCatalogue?.any || [])]
  const branches = (stage.branches || []).filter((b) => outcomes.some((o) => o.key === b.outcome))
  if (!outcomes.length) return null

  const save = (b) => {
    const rest = branches.filter((x) => x.outcome !== b.outcome)
    onChange([...rest, b])
    setEditing(null)
  }
  const reset = (key) => onChange(branches.filter((x) => x.outcome !== key))

  return (
    <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      <button type="button" className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'space-between', display: 'flex' }}
        onClick={() => setOpen((o) => !o)}>
        <span><strong>What happens next</strong> — by outcome</span>
        <span className="small faint">{branches.length ? `${branches.length} customised` : 'all defaults'} {open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ padding: '6px 10px 10px' }}>
          <div className="hint" style={{ marginTop: 0 }}>
            Applies when a rep logs this outcome while a contact is on this stage. Global rules (stop on reply,
            company lock, suppression) always run first.
          </div>
          <table className="data" style={{ marginTop: 6 }}>
            <tbody>
              {outcomes.map((o) => {
                const b = branches.find((x) => x.outcome === o.key)
                return (
                  <tr key={o.key}>
                    <td style={{ width: 190 }}><strong className="small">{o.label}</strong></td>
                    <td className="small">
                      {b
                        ? <span>{branchSummary(b, o, stages, campaigns, statuses, statusRoles.lost)}</span>
                        : <span className="faint">Default: {o.defaultText}</span>}
                    </td>
                    <td className="right nowrap">
                      {!disabled && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setEditing({ def: o, branch: b })}>
                            {b ? 'Edit' : 'Customise'}
                          </button>
                          {b && (
                            <button type="button" className="btn btn-ghost btn-sm" disabled={!!b.dnc}
                              title={b.dnc ? 'Untick “Flag do not contact” first' : 'Back to the built-in default'}
                              onClick={() => reset(o.key)}>
                              Reset
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <BranchForm
          def={editing.def} initial={editing.branch} stage={stage} index={index} stages={stages}
          campaignId={campaignId} campaigns={campaigns}
          onCancel={() => setEditing(null)} onSave={save}
        />
      )}
    </div>
  )
}

function BranchForm({ def, initial, stage, index, stages, campaignId, campaigns, onCancel, onSave }) {
  const { statuses, statusRoles, lostReasons, users } = useAuth()
  const allowed = def.allowedPaths || []
  const [b, setB] = useState(() => ({
    outcome: def.key,
    path: allowed[0] || 'stay',
    toStage: '', days: 2, maxTries: 2, moveTo: '',
    setStatus: '', lostReason: '', taskTitle: '', taskAssign: 'owner', taskDueDays: 0,
    nurture: false, restartDays: 90, dnc: false,
    ...(initial || {}),
    moveTo: initial?.moveTo ? String(initial.moveTo) : '',
  }))
  const [removeTyped, setRemoveTyped] = useState('')
  const set = (k, v) => setB((x) => ({ ...x, [k]: v }))

  const later = stages.map((s, j) => ({ s, j })).filter(({ j }) => j > index)
  const isLost = !!b.setStatus && b.setStatus === statusRoles.lost
  const removingDnc = !!initial?.dnc && !b.dnc
  const problems = []
  if (b.path === 'jump' && !b.toStage) problems.push('Pick the stage to jump to.')
  if (isLost && !b.lostReason) problems.push('Pick a Lost reason.')
  if (removingDnc && removeTyped !== 'REMOVE') problems.push('Type REMOVE to take off do-not-contact.')

  return (
    <Modal
      title={`${stage.name}: when the outcome is “${def.label}”`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={problems.length > 0}
            onClick={() => onSave({ ...b, moveTo: b.path === 'exit' && b.moveTo ? b.moveTo : null })}>
            Done
          </button>
        </>
      }
    >
      {def.kind === 'conversation' && (
        <div className="banner banner-info" style={{ marginBottom: 12 }}>
          <span>ℹ</span>
          <div className="small">This is a reply or conversation, so the global rules run first: all their flows are paused
            {def.respond ? ', a Respond task is created' : ''} and the company is locked. This branch can then end
            this campaign and add the actions below; it cannot keep the flow running.</div>
        </div>
      )}
      {def.kind === 'suppression' && (
        <div className="banner banner-info" style={{ marginBottom: 12 }}>
          <span>ℹ</span>
          <div className="small">Fixed rule, always applied: {def.defaultText}. You can add actions below.</div>
        </div>
      )}

      {allowed.length > 0 && (
        <div className="field">
          <label className="label">The flow</label>
          <select className="select" value={b.path} onChange={(e) => set('path', e.target.value)}>
            {allowed.map((p) => <option key={p} value={p}>{PATH_LABEL[p]}</option>)}
          </select>
        </div>
      )}

      {b.path === 'jump' && (
        <div className="field">
          <label className="label">Jump to (later stages only, so a contact can never loop)</label>
          <select className="select" value={b.toStage} onChange={(e) => set('toStage', e.target.value)}>
            <option value="">Choose…</option>
            {later.map(({ s, j }) => (
              <option key={j} value={s._id || ''} disabled={!s._id}>
                {j + 1}. {s.name}{s._id ? '' : ' (save the campaign first)'}
              </option>
            ))}
          </select>
        </div>
      )}
      {(b.path === 'wait' || b.path === 'retry') && (
        <div className="grid grid-2">
          <div className="field">
            <label className="label">{b.path === 'wait' ? 'Wait (business days)' : 'Retry after (business days)'}</label>
            <input className="input" type="number" min="0" max="60" value={b.days} onChange={(e) => set('days', Number(e.target.value))} />
          </div>
          {b.path === 'retry' && (
            <div className="field">
              <label className="label">Most tries per contact (then next stage)</label>
              <input className="input" type="number" min="1" max="5" value={b.maxTries} onChange={(e) => set('maxTries', Number(e.target.value))} />
            </div>
          )}
        </div>
      )}
      {b.path === 'exit' && (
        <div className="field">
          <label className="label">Then start another campaign (optional)</label>
          <select className="select" value={b.moveTo} onChange={(e) => set('moveTo', e.target.value)}>
            <option value="">No — just leave</option>
            {campaigns.filter((c) => String(c._id) !== String(campaignId) && (c.stages || []).length > 0).map((c) => (
              <option key={c._id} value={c._id}>{c.name}{c.active === false ? ' — paused' : ''}</option>
            ))}
          </select>
        </div>
      )}

      <div className="divider" />
      <div className="label">Also (optional)</div>
      <div className="grid grid-2">
        <div className="field">
          <label className="label">Set status</label>
          <select className="select" value={b.setStatus} onChange={(e) => set('setStatus', e.target.value)}>
            <option value="">Leave as is</option>
            {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {isLost && (
          <div className="field">
            <label className="label">Lost reason (required)</label>
            <select className="select" value={b.lostReason} onChange={(e) => set('lostReason', e.target.value)}>
              <option value="">Choose…</option>
              {lostReasons.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="grid grid-3">
        <div className="field">
          <label className="label">Create a task</label>
          <input className="input" placeholder="Task title (blank = none)" value={b.taskTitle} onChange={(e) => set('taskTitle', e.target.value)} />
        </div>
        <div className="field">
          <label className="label">For</label>
          <select className="select" value={b.taskAssign} onChange={(e) => set('taskAssign', e.target.value)}>
            <option value="owner">The contact's owner</option>
            <option value="step">Whoever did this step</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label">Due in (business days)</label>
          <input className="input" type="number" min="0" max="60" value={b.taskDueDays} onChange={(e) => set('taskDueDays', Number(e.target.value))} />
        </div>
      </div>
      <label className="row small" style={{ gap: 8, marginBottom: 8 }}>
        <input type="checkbox" className="checkbox" checked={b.nurture} onChange={(e) => set('nurture', e.target.checked)} />
        Turn Nurture on, checking back in
        <input className="input" type="number" min="1" max="730" style={{ width: 80 }} value={b.restartDays}
          onChange={(e) => set('restartDays', Number(e.target.value))} /> days
      </label>
      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" className="checkbox" checked={b.dnc} onChange={(e) => set('dnc', e.target.checked)} />
        Flag do not contact (stops all outreach and ends every campaign)
      </label>
      {removingDnc && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          <span>!</span>
          <div style={{ flex: 1 }}>
            <div className="small"><strong>You are removing a do-not-contact action.</strong> Contacts reaching this outcome
              would no longer be suppressed. Type REMOVE to confirm.</div>
            <input className="input" style={{ marginTop: 6, maxWidth: 160 }} value={removeTyped} onChange={(e) => setRemoveTyped(e.target.value)} />
          </div>
        </div>
      )}
      {problems.length > 0 && <div className="hint" style={{ color: 'var(--danger)', marginTop: 8 }}>{problems.join(' ')}</div>}
    </Modal>
  )
}

/* ---------------- Flow diagram ----------------
 * Stages left to right with the default "next" arrows (and their waits),
 * plus every customised branch: jumps as arcs above, retries as loops,
 * waits and exits listed under the stage they start from. */
const CH_COLOR = { email: 'var(--email)', call: 'var(--call)', linkedin: 'var(--linkedin)' }

function FlowDiagram({ stages, campaigns }) {
  const { outcomeCatalogue } = useAuth()
  const [open, setOpen] = useState(true)
  const W = 158; const H = 58; const G = 64
  const label = (ch, key) => ([...(outcomeCatalogue?.[ch] || []), ...(outcomeCatalogue?.any || [])].find((o) => o.key === key) || {}).label || key
  const short = (t, n = 20) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

  const jumps = []
  const loops = []
  const notes = stages.map(() => [])
  stages.forEach((st, i) => {
    for (const b of st.branches || []) {
      const what = label(st.channel, b.outcome)
      if (b.path === 'jump') {
        const j = stages.findIndex((x) => String(x._id) === String(b.toStage))
        if (j > i) jumps.push({ from: i, to: j, text: what })
      } else if (b.path === 'retry') loops.push({ at: i, text: `${what}: retry ${b.days}d ×${b.maxTries}` })
      else if (b.path === 'wait') notes[i].push(`◷ ${short(what, 16)}: wait ${b.days}d`)
      else if (b.path === 'exit') {
        const to = campaigns.find((c) => String(c._id) === String(b.moveTo))
        notes[i].push(`⇥ ${short(what, 16)}: ${to ? `→ ${short(to.name, 16)}` : 'exit'}`)
      } else if (b.path === 'continue') notes[i].push(`→ ${short(what, 16)}: next now`)
      const extras = [b.setStatus && 'status', b.taskTitle && 'task', b.nurture && 'nurture', b.dnc && 'DNC'].filter(Boolean)
      if (extras.length && !['jump', 'retry'].includes(b.path)) {
        if (!['wait', 'exit', 'continue'].includes(b.path)) notes[i].push(`• ${short(what, 16)}: ${extras.join(', ')}`)
      }
    }
  })
  const loopsAt = (i) => loops.filter((l) => l.at === i)
  // Jumps arc above the boxes; retry loops hang below them; notes under that.
  const arcTop = jumps.length ? 40 + jumps.length * 22 : 12
  const loopRoom = loops.length ? 34 : 0
  const maxNotes = Math.max(0, ...notes.map((n) => n.length))
  const width = 20 + stages.length * (W + G) + 90
  const height = arcTop + H + loopRoom + 22 + maxNotes * 15 + 8
  const x = (i) => 20 + i * (W + G)
  const y0 = arcTop

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <h2 style={{ flex: 1 }}>Flow diagram</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <div className="card-body" style={{ overflowX: 'auto' }}>
          <svg width={width} height={height} role="img" aria-label="Campaign flow diagram" style={{ display: 'block', fontFamily: 'inherit' }}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--text-muted)' }} />
              </marker>
              <marker id="arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--accent)' }} />
              </marker>
            </defs>

            {jumps.map((jmp, k) => {
              const sx = x(jmp.from) + W / 2; const ex = x(jmp.to) + W / 2
              const top = y0 - 44 - k * 22
              return (
                <g key={`j${k}`}>
                  <path d={`M${sx},${y0} C${sx},${top} ${ex},${top} ${ex},${y0 - 2}`} style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 1.5 }} markerEnd="url(#arrow-accent)" />
                  <text x={(sx + ex) / 2} y={y0 - 36 - k * 22 + 2} textAnchor="middle" style={{ fontSize: 10.5, fontWeight: 600, fill: 'var(--accent)', paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 3 }}>{short(jmp.text, 26)}</text>
                </g>
              )
            })}

            {stages.map((st, i) => (
              <g key={i}>
                {loopsAt(i).map((l, k) => (
                  <g key={k}>
                    <path d={`M${x(i) + W - 30},${y0 + H} C${x(i) + W - 20},${y0 + H + 24} ${x(i) + 20},${y0 + H + 24} ${x(i) + 30},${y0 + H + 2}`} style={{ fill: 'none', stroke: 'var(--warn)', strokeWidth: 1.4, strokeDasharray: '3 2' }} markerEnd="url(#arrow)" />
                    <text x={x(i) + W / 2} y={y0 + H + 32 + k * 12} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--warn)' }}>↻ {short(l.text, 30)}</text>
                  </g>
                ))}
                <rect x={x(i)} y={y0} width={W} height={H} rx={8} style={{ fill: 'var(--surface)', stroke: CH_COLOR[st.channel] || 'var(--border-strong)', strokeWidth: 1.6 }} />
                <text x={x(i) + 10} y={y0 + 22} style={{ fontSize: 12, fontWeight: 600, fill: 'var(--text)' }}>{short(`${i + 1}. ${st.name}`)}</text>
                <text x={x(i) + 10} y={y0 + 40} style={{ fontSize: 10.5, fill: CH_COLOR[st.channel] || 'var(--text-muted)' }}>
                  {st.channel === 'linkedin' ? 'LinkedIn' : st.channel === 'call' ? 'Call' : 'Email'}{(st.branches || []).length ? ` · ${st.branches.length} branch${st.branches.length === 1 ? '' : 'es'}` : ''}
                </text>
                <line x1={x(i) + W} y1={y0 + H / 2} x2={x(i) + W + G - 4} y2={y0 + H / 2} style={{ stroke: 'var(--text-muted)', strokeWidth: 1.3 }} markerEnd="url(#arrow)" />
                <text x={x(i) + W + G / 2} y={y0 + H / 2 - 6} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--text-muted)' }}>{st.waitDays}d</text>
                {notes[i].map((n, k) => (
                  <text key={k} x={x(i) + 2} y={y0 + H + loopRoom + 18 + k * 15} style={{ fontSize: 10.5, fill: 'var(--text-muted)' }}>{n}</text>
                ))}
              </g>
            ))}
            <rect x={x(stages.length)} y={y0 + H / 2 - 13} width={58} height={26} rx={13} style={{ fill: 'var(--surface-2)', stroke: 'var(--border-strong)' }} />
            <text x={x(stages.length) + 29} y={y0 + H / 2 + 4} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text-muted)' }}>Finish</text>
          </svg>
          <div className="hint">
            Straight arrows are the default path (the number is the wait). Blue arcs are jumps, dashed loops are retries;
            waits and exits are listed under their stage. Outcomes you have not customised follow their default.
          </div>
        </div>
      )}
    </div>
  )
}
