import { useState } from 'react'
import CompanyPicker from './CompanyPicker.jsx'
import { Modal } from './ui.jsx'

/* Pop-ups for changing contacts, shared by the Contacts list (for the
 * selected contacts) and the contact page (for that one contact). */

export function PickOne({ title, options, onConfirm, onClose, initial = '', hint = '' }) {
  const [value, setValue] = useState(initial || '')
  return (
    <Modal
      title={title} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!value} onClick={() => onConfirm(value)}>Apply</button>
        </>
      }
    >
      <select className="select" value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <div className="hint" style={{ marginTop: 8 }}>{hint}</div>}
    </Modal>
  )
}

export function SetCompanyDialog({ count, onConfirm, onClose }) {
  const [picked, setPicked] = useState({ company: '', companyName: '' })
  return (
    <Modal
      title={count === 1 ? 'Set the company' : `Set the company for ${count} contacts`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked.company} onClick={() => onConfirm(picked.company)}>
            Set company
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Company</label>
        <CompanyPicker value={picked.company} name={picked.companyName} onChange={setPicked} autoFocus />
      </div>
      <div className="hint">
        Pick an existing company from the list — free text is not enough here.
      </div>
    </Modal>
  )
}

export function TagDialog({ onConfirm, onClose, existing = [] }) {
  const [tag, setTag] = useState('')
  const [remove, setRemove] = useState(false)
  return (
    <Modal
      title="Tag contacts" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!tag.trim()} onClick={() => onConfirm(tag.trim(), remove)}>
            {remove ? 'Remove tag' : 'Add tag'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Tag</label>
        <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} autoFocus />
        {existing.length > 0 && (
          <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
            <span className="small faint">Current tags:</span>
            {existing.map((t) => (
              <button key={t} type="button" className="tag" style={{ cursor: 'pointer' }} title="Use this tag"
                onClick={() => { setTag(t); setRemove(true) }}>{t}</button>
            ))}
          </div>
        )}
      </div>
      <label className="row small">
        <input type="checkbox" className="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
        Remove this tag instead of adding it
      </label>
    </Modal>
  )
}
