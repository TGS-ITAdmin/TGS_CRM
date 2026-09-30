import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { Field } from './ui.jsx'
import { CustomFieldSection } from './CustomFieldInput.jsx'
import { TIMEZONES } from './format.js'

const BLANK = {
  name: '', domain: '', website: '', industry: '', employeeCount: '', phone: '',
  linkedinUrl: '', location: '', timezone: '', address: '', description: '',
  currentProvider: '', seatsNeeded: '', targetRoles: '', contractTiming: '',
  budgetRange: '', tags: [], notes: '', source: 'manual',
}

export default function CompanyForm({ initial, onSubmit, onCancel, submitLabel = 'Save' }) {
  const { users, isAdmin, user, customFieldsFor } = useAuth()
  const [form, setForm] = useState({
    ...BLANK,
    ...(initial || {}),
    owner: initial?.owner?._id || initial?.owner || user.id,
    tags: initial?.tags || [],
    customFields: initial?.customFields || {},
    seatsNeeded: initial?.seatsNeeded ?? '',
  })
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await onSubmit({ ...form, seatsNeeded: form.seatsNeeded === '' ? null : Number(form.seatsNeeded) })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function addTag() {
    const t = tagInput.trim()
    if (!t) return
    setForm((f) => ({ ...f, tags: [...new Set([...f.tags, t])] }))
    setTagInput('')
  }

  return (
    <form onSubmit={submit}>
      {error && <div className="banner banner-danger">{error}</div>}

      <Field label="Company name"><input className="input" value={form.name} onChange={set('name')} required autoFocus /></Field>

      <div className="grid grid-2">
        <Field label="Email domain" hint="The dedupe key. Contacts with a matching work email attach here automatically.">
          <input className="input" value={form.domain} onChange={set('domain')} placeholder="acmehealth.com" />
        </Field>
        <Field label="Website"><input className="input" value={form.website} onChange={set('website')} /></Field>
        <Field label="Industry"><input className="input" value={form.industry} onChange={set('industry')} /></Field>
        <Field label="Company size"><input className="input" value={form.employeeCount} onChange={set('employeeCount')} placeholder="50–200" /></Field>
        <Field label="Main phone"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Company LinkedIn"><input className="input" value={form.linkedinUrl} onChange={set('linkedinUrl')} /></Field>
        <Field label="Location"><input className="input" value={form.location} onChange={set('location')} /></Field>
        <Field label="Timezone" hint="New contacts here inherit this for the call list.">
          <select className="select" value={form.timezone} onChange={set('timezone')}>
            <option value="">Unknown</option>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Address"><textarea className="textarea" style={{ minHeight: 60 }} value={form.address} onChange={set('address')} /></Field>

      <div className="divider" />
      <h3 style={{ marginBottom: 10 }}>Outsourcing qualification</h3>
      <p className="small muted" style={{ marginTop: -4 }}>
        These describe the organisation, so every contact here shares them — and a new deal prefills from them.
      </p>

      <div className="grid grid-2">
        <Field label="Current provider"><input className="input" value={form.currentProvider} onChange={set('currentProvider')} /></Field>
        <Field label="Seats / headcount needed"><input className="input" type="number" min="0" value={form.seatsNeeded} onChange={set('seatsNeeded')} /></Field>
        <Field label="Target roles"><input className="input" value={form.targetRoles} onChange={set('targetRoles')} placeholder="Customer support, back office…" /></Field>
        <Field label="Contract timing"><input className="input" value={form.contractTiming} onChange={set('contractTiming')} placeholder="Renewal in Q1, evaluating now…" /></Field>
        <Field label="Budget range"><input className="input" value={form.budgetRange} onChange={set('budgetRange')} /></Field>
        {isAdmin && (
          <Field label="Owner">
            <select className="select" value={form.owner || ''} onChange={set('owner')}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        )}
      </div>

      <Field label="Tags">
        <div className="row" style={{ marginBottom: 6 }}>
          <input className="input" value={tagInput} onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
            placeholder="Type a tag and press Enter" />
          <button type="button" className="btn btn-sm" onClick={addTag}>Add</button>
        </div>
        <div className="row wrap">
          {form.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
              <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 3px' }}
                onClick={() => setForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }))}>✕</button>
            </span>
          ))}
        </div>
      </Field>

      <CustomFieldSection
        fields={customFieldsFor('company')}
        values={form.customFields}
        onChange={(customFields) => setForm((f) => ({ ...f, customFields }))}
      />

      <Field label="Notes"><textarea className="textarea" value={form.notes} onChange={set('notes')} /></Field>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button className="btn btn-primary" disabled={busy || !form.name.trim()} type="submit">
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
