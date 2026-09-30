import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Channel, Empty, Field, Loading, Modal } from '../components/ui.jsx'
import { num } from '../components/format.js'

/* Starter templates. A blank campaign editor is where most CRMs lose people —
 * these give a working three-touch sequence to edit rather than a void. */
const TEMPLATES = [
  {
    key: 'multi',
    name: 'Multi-channel outbound',
    description: 'LinkedIn connect → email → cold call → LinkedIn follow-up',
    stages: [
      { name: 'LinkedIn connection request', channel: 'linkedin', waitDays: 3,
        body: 'Hi {{first_name|there}} — I work with {{industry|operations}} teams on outsourced support. Given what {{company}} is building, thought it was worth connecting.' },
      { name: 'Intro email', channel: 'email', waitDays: 4,
        subject: 'Support capacity for {{company}}',
        body: 'Hi {{first_name|there}},\n\nWe run offshore support and back-office teams for companies around the size of {{company}}. Most clients come to us when hiring locally stops keeping up with volume.\n\nWorth a short call to see whether the numbers work for you?\n\nBest,' },
      { name: 'Cold call', channel: 'call', waitDays: 3,
        body: 'OPENER\n"Hi {{first_name|there}}, it\'s [your name] from [company]. I sent you a note about support capacity — do you have thirty seconds?"\n\nREASON FOR CALLING\nWe build offshore support teams. Companies your size usually call us when local hiring can\'t keep pace with ticket volume.\n\nQUALIFY\n- Who handles support today, in-house or outsourced?\n- Roughly how many people?\n- What breaks first when volume spikes?\n\nCLOSE\n"Worth twenty minutes to walk through what a team would cost?"' },
      { name: 'LinkedIn follow-up', channel: 'linkedin', waitDays: 7,
        body: 'Hi {{first_name|there}} — circling back. If support capacity is not a priority right now, no problem at all. If it becomes one, I am easy to find.' },
    ],
  },
  {
    key: 'email',
    name: 'Email-only sequence',
    description: 'Three emails over two weeks',
    stages: [
      { name: 'Email 1 — intro', channel: 'email', waitDays: 4, subject: 'Quick question about {{company}}',
        body: 'Hi {{first_name|there}},\n\n[Why you are reaching out to them specifically.]\n\n[One line on what you do.]\n\nWorth a short conversation?\n\nBest,' },
      { name: 'Email 2 — value', channel: 'email', waitDays: 5, subject: 'Re: Quick question about {{company}}',
        body: 'Hi {{first_name|there}},\n\n[A concrete result you got for a similar company.]\n\nHappy to share the detail if useful.\n\nBest,' },
      { name: 'Email 3 — break-up', channel: 'email', waitDays: 5, subject: 'Closing the loop',
        body: 'Hi {{first_name|there}},\n\nI have not heard back, so I will stop here. If the timing changes, just reply to this message.\n\nBest,' },
    ],
  },
  {
    key: 'call',
    name: 'Cold call list',
    description: 'Two dials with a callback gap',
    stages: [
      { name: 'First dial', channel: 'call', waitDays: 3,
        body: 'OPENER\n"Hi {{first_name|there}}, [your name] from [company]. Have I caught you at a bad time?"\n\nREASON\n[One sentence.]\n\nQUALIFY\n- [Question 1]\n- [Question 2]\n\nCLOSE\n"Can I book twenty minutes to show you the numbers?"' },
      { name: 'Second dial', channel: 'call', waitDays: 5,
        body: 'OPENER\n"Hi {{first_name|there}}, [your name] again — I tried you last week about [topic]."\n\nIf voicemail: leave name, company, one-line reason, and your number twice.' },
    ],
  },
  { key: 'blank', name: 'Start from scratch', description: 'One empty stage you fill in yourself',
    stages: [{ name: 'Stage 1', channel: 'email', waitDays: 3, subject: '', body: '' }] },
]

export default function Campaigns() {
  const { can } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [campaigns, setCampaigns] = useState(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    try {
      const { campaigns } = await api.listCampaigns()
      setCampaigns(campaigns)
    } catch (err) {
      toast.error(err.message)
    }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!campaigns) return <Loading />

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Campaigns</h1>
          <div className="topbar-sub">A campaign is a sequence of stages. Each stage has a channel and its own message or script.</div>
        </div>
        <div className="spacer" />
        {can('campaigns.manage') && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ New campaign</button>}
      </div>

      <div className="page">
        {campaigns.length === 0 ? (
          <div className="card">
            <Empty icon="⚑" title="No campaigns yet"
              action={can('campaigns.manage')
                ? <button className="btn btn-primary" onClick={() => setCreating(true)}>Create your first campaign</button>
                : <span className="small">Ask an admin to set one up.</span>}>
              Start from a template — a working multi-channel sequence you can edit — or build one from scratch.
            </Empty>
          </div>
        ) : (
          <div className="grid grid-2">
            {campaigns.map((c) => (
              <div className="card" key={c._id}>
                <div className="card-head">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 className="truncate">
                      <Link to={`/campaigns/${c._id}`}>{c.name}</Link>
                    </h2>
                    <div className="small faint truncate">{c.description || `${c.stages.length} stages`}</div>
                  </div>
                  {!c.active && <span className="tag">Inactive</span>}
                </div>
                <div className="card-body">
                  <div className="row wrap" style={{ marginBottom: 12, gap: 5 }}>
                    {c.stages.map((s, i) => (
                      <span key={i} className={`chan chan-${s.channel}`} title={`${s.name} · wait ${s.waitDays}d`}>
                        {i + 1}. {s.name}
                      </span>
                    ))}
                    {c.stages.length === 0 && <span className="small faint">No stages yet</span>}
                  </div>
                  <div className="grid grid-3" style={{ gap: 8 }}>
                    <div><div className="stat-label">Running</div><div className="strong">{num(c.counts.active)}</div></div>
                    <div><div className="stat-label">Finished</div><div className="strong">{num(c.counts.completed)}</div></div>
                    <div><div className="stat-label">Exited</div><div className="strong">{num(c.counts.exited)}</div></div>
                  </div>
                  <div className="row" style={{ marginTop: 14 }}>
                    <Link className="btn btn-sm" to={`/campaigns/${c._id}`}>{can('campaigns.manage') ? 'Edit' : 'View'}</Link>
                    <Link className="btn btn-sm" to={`/board/${c._id}`}>Board</Link>
                    <Link className="btn btn-sm" to={`/reports?campaign=${c._id}&tab=funnel`}>Funnel</Link>
                    <Link className="btn btn-sm btn-ghost" to={`/contacts?campaign=${c._id}`}>Contacts</Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <NewCampaign
          onClose={() => setCreating(false)}
          onCreated={(c) => navigate(`/campaigns/${c._id}`)}
        />
      )}
    </>
  )
}

function NewCampaign({ onClose, onCreated }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('multi')
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const chosen = TEMPLATES.find((t) => t.key === template)
      const { campaign } = await api.createCampaign({
        name: name.trim(),
        description: chosen.key === 'blank' ? '' : chosen.description,
        stages: chosen.stages,
      })
      toast.success('Campaign created — now edit the messages')
      onCreated(campaign)
    } catch (err) {
      toast.error(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New campaign" onClose={onClose} width="wide"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? 'Creating…' : 'Create campaign'}
          </button>
        </>
      }
    >
      <Field label="Campaign name" hint="Something you will recognise in six months — 'Healthcare US Q3', not 'Campaign 2'.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus
          placeholder="e.g. Healthcare US — Q3 outbound" />
      </Field>

      <label className="label">Start from</label>
      <div className="col" style={{ gap: 8 }}>
        {TEMPLATES.map((t) => (
          <label
            key={t.key}
            className="card"
            style={{
              padding: '11px 13px', cursor: 'pointer', display: 'flex', gap: 11, alignItems: 'flex-start',
              borderColor: template === t.key ? 'var(--accent)' : undefined,
              background: template === t.key ? 'var(--accent-soft)' : undefined,
            }}
          >
            <input type="radio" className="checkbox" name="tpl" checked={template === t.key}
              onChange={() => setTemplate(t.key)} style={{ marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <div className="strong">{t.name}</div>
              <div className="small muted">{t.description}</div>
              <div className="row wrap" style={{ marginTop: 6, gap: 4 }}>
                {t.stages.map((s, i) => <Channel key={i} value={s.channel} />)}
              </div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  )
}
