import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { Modal } from './ui.jsx'

/* Asked whenever a contact (or a batch) is set to Lost. Lost always needs a
 * reason (rule G17); Nurture can be switched on at the same time, because a
 * contact can be Lost and in Nurture together. */
export default function LostReasonDialog({ count = 1, initialReason = '', initialNurture = false, onClose, onConfirm }) {
  const { lostReasons } = useAuth()
  const known = lostReasons.includes(initialReason)
  const [choice, setChoice] = useState(initialReason ? (known ? initialReason : '__other') : '')
  const [other, setOther] = useState(known ? '' : initialReason)
  const [nurture, setNurture] = useState(!!initialNurture)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reason = choice === '__other' ? other.trim() : choice

  async function confirm() {
    if (!reason) {
      setError('Pick a Lost reason.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onConfirm({ lostReason: reason, nurture })
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={count === 1 ? 'Why is this contact lost?' : `Why are these ${count} contacts lost?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !reason} onClick={confirm}>
            {busy ? 'Saving…' : 'Set to Lost'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Lost reason (required)</label>
        <select className="select" value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
          <option value="">— choose a reason —</option>
          {lostReasons.map((r) => <option key={r} value={r}>{r}</option>)}
          <option value="__other">Other…</option>
        </select>
      </div>
      {choice === '__other' && (
        <div className="field">
          <label className="label">Describe the reason</label>
          <input className="input" value={other} onChange={(e) => setOther(e.target.value)} />
        </div>
      )}
      <label className="row small" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" className="checkbox" checked={nurture} onChange={(e) => setNurture(e.target.checked)} />
        Also turn Nurture on (keeps them on the monthly nurture emails)
      </label>
      {error && <div className="banner banner-danger" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  )
}
