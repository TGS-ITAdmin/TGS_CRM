import { useEffect, useState } from 'react'
import { api } from '../api'
import { Modal } from './ui.jsx'

/* Shared pieces for recording an outcome (task cards and Log reply):
 * the extra fields some outcomes need, the "What happens next" preview, and
 * the confirmation shown before anything destructive happens. */

export function OutcomeFields({ def, person, setPerson, restartDate, setRestartDate }) {
  if (!def) return null
  if (def.needsPerson) {
    const set = (k) => (e) => setPerson({ ...person, [k]: e.target.value })
    return (
      <div style={{ marginTop: 10 }}>
        <div className="label">Who is the right person? (they are added and start this campaign at stage 1)</div>
        <div className="grid grid-3">
          <input className="input" placeholder="First name" value={person.firstName || ''} onChange={set('firstName')} />
          <input className="input" placeholder="Last name" value={person.lastName || ''} onChange={set('lastName')} />
          <input className="input" placeholder="Email" value={person.email || ''} onChange={set('email')} />
        </div>
      </div>
    )
  }
  if (def.needsDate) {
    return (
      <div className="field" style={{ marginTop: 10, marginBottom: 0, maxWidth: 260 }}>
        <label className="label">Check back on (optional)</label>
        <input className="input" type="date" value={restartDate} onChange={(e) => setRestartDate(e.target.value)} />
        <div className="hint">Blank = in 90 days.</div>
      </div>
    )
  }
  return null
}

/* Asks the server what an outcome will do — a dry run of the same code that
 * runs when it is logged — and refreshes when the inputs change. */
export function useOutcomePreview(params) {
  const [state, setState] = useState({ plan: [], destructive: false, loading: false })
  const key = JSON.stringify(params || null)
  useEffect(() => {
    if (!params || !params.outcome) {
      setState({ plan: [], destructive: false, loading: false })
      return undefined
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(() => {
      api.outcomePreview(params)
        .then((d) => live && setState({ plan: d.plan || [], destructive: !!d.destructive, customised: !!d.customised, loading: false }))
        .catch(() => live && setState({ plan: [], destructive: false, loading: false }))
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

export function NextStepBox({ preview }) {
  if (!preview || (!preview.plan.length && !preview.loading)) return null
  return (
    <div className="banner banner-info" style={{ marginTop: 10, alignItems: 'flex-start' }}>
      <span>→</span>
      <div style={{ flex: 1 }}>
        <div className="small strong">What happens next{preview.customised ? ' (customised for this stage)' : ''}</div>
        {preview.loading && !preview.plan.length
          ? <div className="small faint">Checking…</div>
          : (
            <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {preview.plan.map((p, i) => (
                <li key={i} style={p.destructive ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{p.text}</li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

/* Guardrail: anything that ends a campaign, sets Lost or flags do not
 * contact is confirmed first, listing exactly what will happen. */
export function ConfirmNext({ plan, onCancel, onConfirm, busy }) {
  return (
    <Modal
      title="Confirm what happens next"
      onClose={() => !busy && onCancel()}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onCancel}>Go back</button>
          <button className="btn btn-danger" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : 'Yes, do this'}</button>
        </>
      }
    >
      <p className="small">This outcome will:</p>
      <ul className="small" style={{ paddingLeft: 18 }}>
        {plan.map((p, i) => (
          <li key={i} style={p.destructive ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{p.text}</li>
        ))}
      </ul>
    </Modal>
  )
}
