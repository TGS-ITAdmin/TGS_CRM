import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { Field } from './ui.jsx'
import { CustomFieldSection } from './CustomFieldInput.jsx'
import CompanyPicker from './CompanyPicker.jsx'
import { TIMEZONES } from './format.js'

const BLANK = {
  firstName: '', lastName: '', title: '', email: '', phone: '', mobile: '',
  linkedinUrl: '', location: '', timezone: '', source: 'manual', notes: '', tags: [],
}

/* Person fields only. Anything describing the organisation — industry, seats
 * needed, current provider — lives on the Company and is edited there, so two
 * people at the same company can never disagree about it. */
export default function ContactForm({ initial, onSubmit, onCancel, submitLabel = 'Save', lockCompany }) {
  const { statuses, users, isAdmin, user, customFieldsFor } = useAuth()
  const [form, setForm] = useState({
    ...BLANK,
    ...(initial || {}),
    status: initial?.status || 'new',
    owner: initial?.owner?._id || initial?.owner || user.id,
    tags: initial?.tags || [],
    customFields: initial?.customFields || {},
    company: initial?.company?._id || initial?.company || '',
    companyName: initial?.company?.name || initial?.companyName || '',
  })
  const [showCompanyDetail, setShowCompanyDetail] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  // Only sent when creating a brand-new company; ignored if one already exists.
  const isNewCompany = !form.company && !!form.companyName.trim()

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await onSubmit(form)
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
    <form onSubmit={submit} id="contact-form">
      {error && <div className="banner banner-danger">{error}</div>}

      <div className="grid grid-2">
        <Field label="First name"><input className="input" value={form.firstName} onChange={set('firstName')} /></Field>
        <Field label="Last name"><input className="input" value={form.lastName} onChange={set('lastName')} /></Field>
        <Field label="Job title"><input className="input" value={form.title} onChange={set('title')} placeholder="COO, VP Operations…" /></Field>
        <Field label="Work email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Phone"><input className="input" value={form.phone} onChange={set('phone')} placeholder="+1 555 123 4567" /></Field>
        <Field label="Mobile"><input className="input" value={form.mobile} onChange={set('mobile')} /></Field>
      </div>

      {!lockCompany && (
        <Field label="Company">
          <CompanyPicker
            value={form.company}
            name={form.companyName}
            onChange={({ company, companyName }) => setForm((f) => ({ ...f, company, companyName }))}
          />
        </Field>
      )}

      {isNewCompany && !lockCompany && (
        <div className="card" style={{ marginBottom: 13, background: 'var(--surface-2)' }}>
          <div className="card-body tight">
            <button
              type="button" className="btn btn-ghost btn-sm" style={{ padding: '6px 0' }}
              onClick={() => setShowCompanyDetail((v) => !v)}
            >
              {showCompanyDetail ? '▾' : '▸'} Add details for this new company (optional)
            </button>
            {showCompanyDetail && (
              <div className="grid grid-2" style={{ paddingBottom: 10 }}>
                <Field label="Website"><input className="input" value={form.company_website || ''} onChange={set('company_website')} /></Field>
                <Field label="Industry"><input className="input" value={form.company_industry || ''} onChange={set('company_industry')} /></Field>
                <Field label="Company size"><input className="input" value={form.company_employeeCount || ''} onChange={set('company_employeeCount')} placeholder="50–200" /></Field>
                <Field label="Seats needed"><input className="input" type="number" min="0" value={form.company_seatsNeeded || ''} onChange={set('company_seatsNeeded')} /></Field>
                <Field label="Target roles"><input className="input" value={form.company_targetRoles || ''} onChange={set('company_targetRoles')} placeholder="Customer support, back office…" /></Field>
                <Field label="Current provider"><input className="input" value={form.company_currentProvider || ''} onChange={set('company_currentProvider')} /></Field>
              </div>
            )}
          </div>
        </div>
      )}

      <Field label="Personal LinkedIn URL" hint="Used for LinkedIn stages. The CRM never posts to LinkedIn — it opens the profile so you send the message yourself.">
        <input className="input" value={form.linkedinUrl} onChange={set('linkedinUrl')} placeholder="https://www.linkedin.com/in/…" />
      </Field>

      <div className="grid grid-2">
        <Field label="Location"><input className="input" value={form.location} onChange={set('location')} /></Field>
        <Field label="Their timezone" hint="Drives the call list's local-time column.">
          <select className="select" value={form.timezone} onChange={set('timezone')}>
            <option value="">Unknown</option>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </Field>
        <Field label="Lifecycle status">
          <select className="select" value={form.status} onChange={set('status')}>
            {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Source"><input className="input" value={form.source} onChange={set('source')} /></Field>
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
          <input
            className="input" value={tagInput} onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
            placeholder="Type a tag and press Enter"
          />
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
        fields={customFieldsFor('contact')}
        values={form.customFields}
        onChange={(customFields) => setForm((f) => ({ ...f, customFields }))}
      />

      <Field label="Notes">
        <textarea className="textarea" value={form.notes} onChange={set('notes')} />
      </Field>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button className="btn btn-primary" disabled={busy} type="submit">
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
