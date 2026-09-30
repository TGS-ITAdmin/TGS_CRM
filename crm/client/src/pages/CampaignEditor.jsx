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
  const { can, mergeFields } = useAuth()
  const isAdmin = can('campaigns.manage')
  const toast = useToast()

  const [campaign, setCampaign] = useState(null)
  const [stageCounts, setStageCounts] = useState({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(null)
  const [confirming, setConfirming] = useState(null)

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
            {!campaign.active && ' · inactive'}
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
                Active — inactive campaigns are hidden from the enrol and move pickers
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
                    label="Wait before next stage"
                    hint={i === stages.length - 1 ? 'After this wait the contact finishes the campaign.' : `Contact moves to "${stages[i + 1].name}" after this many days.`}
                  >
                    <input className="input" type="number" min="0" value={stage.waitDays} disabled={!isAdmin}
                      onChange={(e) => setStage(i, 'waitDays', Number(e.target.value))} />
                  </Field>
                </div>

                <div className="hint" style={{ marginTop: -4, marginBottom: 12 }}>{CHANNEL_HELP[stage.channel]}</div>

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
