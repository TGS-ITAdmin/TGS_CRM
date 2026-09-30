import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { Field } from './ui.jsx'
import { CustomFieldSection } from './CustomFieldInput.jsx'
import CompanyPicker from './CompanyPicker.jsx'
import { money, dateInput } from './format.js'

const PRICING_LABELS = {
  per_seat_monthly: 'Per seat / month',
  one_time: 'One-off fee',
  hourly: 'Per hour',
  per_unit: 'Per unit',
}
const PRICING_HINTS = {
  per_seat_monthly: 'Quantity = number of seats',
  one_time: 'Charged once — counts toward contract value, not MRR',
  hourly: 'Quantity = estimated hours per month',
  per_unit: 'Quantity = estimated units per month',
}

const blankLine = (order) => ({
  name: '', pricingModel: 'per_seat_monthly', quantity: 1,
  unitPrice: 0, listPrice: 0, order,
})

/* Live totals are computed here as well as on the server. The server's number
 * is authoritative — this exists so a rep sees TCV change as they type rather
 * than after a save. */
function totals(form) {
  const term = Math.max(0, Number(form.termMonths) || 0)
  if (form.pricingMode !== 'line_items') {
    const tcv = Number(form.amount) || 0
    return { mrr: term > 0 ? tcv / term : 0, oneTime: 0, tcv }
  }
  let mrr = 0
  let oneTime = 0
  for (const item of form.lineItems || []) {
    const line = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)
    if (item.pricingModel === 'one_time') oneTime += line
    else mrr += line
  }
  return { mrr, oneTime, tcv: mrr * term + oneTime }
}

export default function DealForm({ initial, lockCompany, companyContacts = [], onSubmit, onCancel, submitLabel = 'Save' }) {
  const { users, isAdmin, user, currencies, forecastCategories, reportingCurrency, customFieldsFor } = useAuth()
  const [form, setForm] = useState({
    name: '', amount: 0, termMonths: 12, currency: reportingCurrency || 'USD',
    pricingMode: 'manual', lineItems: [], forecastCategory: 'pipeline',
    notes: '', tags: [],
    ...(initial || {}),
    // These five are normalised from whatever shape `initial` arrived in
    // (populated relation, bare id, or nothing), so they come after the spread.
    company: initial?.company?._id || initial?.company || '',
    companyName: initial?.company?.name || initial?.companyName || '',
    expectedCloseDate: dateInput(initial?.expectedCloseDate),
    owner: initial?.owner?._id || initial?.owner || user.id,
    primaryContact: initial?.primaryContact?._id || initial?.primaryContact || '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const t = totals(form)
  const cur = form.currency || 'USD'
  const rate = currencies.find((c) => c.code === cur)?.rate ?? 1

  function setLine(i, key, value) {
    setForm((f) => ({
      ...f,
      lineItems: f.lineItems.map((l, j) => (j === i ? { ...l, [key]: value } : l)),
    }))
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await onSubmit({
        ...form,
        amount: Number(form.amount) || 0,
        termMonths: Number(form.termMonths) || 0,
        expectedCloseDate: form.expectedCloseDate || null,
        primaryContact: form.primaryContact || null,
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      {error && <div className="banner banner-danger">{error}</div>}

      <Field label="Deal name" hint="Something you'd recognise in a list — 'Acme Health — 30 support seats'.">
        <input className="input" value={form.name} onChange={set('name')} required autoFocus />
      </Field>

      {!lockCompany && (
        <Field label="Company" hint="A deal always belongs to a company — that's what makes the account history work.">
          <CompanyPicker
            value={form.company} name={form.companyName}
            onChange={({ company, companyName }) => setForm((f) => ({ ...f, company, companyName }))}
          />
        </Field>
      )}

      {companyContacts.length > 0 && (
        <Field label="Primary contact">
          <select className="select" value={form.primaryContact} onChange={set('primaryContact')}>
            <option value="">No primary contact yet</option>
            {companyContacts.map((c) => (
              <option key={c._id} value={c._id}>
                {[c.firstName, c.lastName].filter(Boolean).join(' ')}{c.title ? ` — ${c.title}` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="divider" />
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ flex: 1 }}>Value</h3>
        <div className="tabs" style={{ border: 0, margin: 0 }}>
          <button type="button" className={`tab${form.pricingMode === 'manual' ? ' active' : ''}`}
            onClick={() => setForm((f) => ({ ...f, pricingMode: 'manual' }))}>
            One number
          </button>
          <button type="button" className={`tab${form.pricingMode === 'line_items' ? ' active' : ''}`}
            onClick={() => setForm((f) => ({
              ...f, pricingMode: 'line_items',
              lineItems: f.lineItems.length ? f.lineItems : [blankLine(0)],
            }))}>
            Itemised
          </button>
        </div>
      </div>

      <div className="grid grid-3">
        <Field label="Currency">
          <select className="select" value={form.currency} onChange={set('currency')}>
            {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
        </Field>
        <Field label="Contract term (months)" hint="Turns monthly revenue into total contract value.">
          <input className="input" type="number" min="0" value={form.termMonths} onChange={set('termMonths')} />
        </Field>
        <Field label="Expected close date" hint="Deals with no date are invisible to the forecast.">
          <input className="input" type="date" value={form.expectedCloseDate} onChange={set('expectedCloseDate')} />
        </Field>
      </div>

      {form.pricingMode === 'manual' ? (
        <Field label="Total contract value" hint="The whole contract, not the monthly figure. Monthly is derived from the term.">
          <input className="input" type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} />
        </Field>
      ) : (
        <>
          <div className="table-wrap" style={{ marginBottom: 10 }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ minWidth: 150 }}>Item</th><th style={{ width: 150 }}>Pricing</th>
                  <th style={{ width: 90 }}>Qty</th><th style={{ width: 110 }}>List price</th>
                  <th style={{ width: 110 }}>Your price</th><th className="right" style={{ width: 110 }}>Line</th><th />
                </tr>
              </thead>
              <tbody>
                {form.lineItems.map((item, i) => {
                  const line = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)
                  const list = Number(item.listPrice) || 0
                  const unit = Number(item.unitPrice) || 0
                  const discount = list > 0 && unit < list ? Math.round(((list - unit) / list) * 1000) / 10 : 0
                  return (
                    <tr key={i}>
                      <td><input className="input" value={item.name} placeholder="Support agent — Tier 1"
                        onChange={(e) => setLine(i, 'name', e.target.value)} /></td>
                      <td>
                        <select className="select" value={item.pricingModel}
                          onChange={(e) => setLine(i, 'pricingModel', e.target.value)}>
                          {Object.entries(PRICING_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        <div className="small faint" style={{ marginTop: 3 }}>{PRICING_HINTS[item.pricingModel]}</div>
                      </td>
                      <td><input className="input" type="number" min="0" value={item.quantity}
                        onChange={(e) => setLine(i, 'quantity', Number(e.target.value))} /></td>
                      <td><input className="input" type="number" min="0" step="0.01" value={item.listPrice}
                        onChange={(e) => setLine(i, 'listPrice', Number(e.target.value))} /></td>
                      <td>
                        <input className="input" type="number" min="0" step="0.01" value={item.unitPrice}
                          onChange={(e) => setLine(i, 'unitPrice', Number(e.target.value))} />
                        {discount > 0 && (
                          <div className="small" style={{ color: 'var(--warn)', marginTop: 3 }}>−{discount}%</div>
                        )}
                      </td>
                      <td className="right strong nowrap">{money(line, cur)}</td>
                      <td className="right">
                        <button type="button" className="btn btn-ghost btn-sm"
                          onClick={() => setForm((f) => ({ ...f, lineItems: f.lineItems.filter((_, j) => j !== i) }))}>✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm" style={{ marginBottom: 12 }}
            onClick={() => setForm((f) => ({ ...f, lineItems: [...f.lineItems, blankLine(f.lineItems.length)] }))}>
            + Add line
          </button>
        </>
      )}

      <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
        <div className="card-body tight">
          <div className="grid grid-3" style={{ padding: '10px 0' }}>
            <div>
              <div className="stat-label">Monthly recurring</div>
              <div className="strong" style={{ fontSize: 17 }}>{money(t.mrr, cur)}</div>
            </div>
            <div>
              <div className="stat-label">One-off fees</div>
              <div className="strong" style={{ fontSize: 17 }}>{money(t.oneTime, cur)}</div>
            </div>
            <div>
              <div className="stat-label">Total contract value</div>
              <div className="strong" style={{ fontSize: 17, color: 'var(--accent)' }}>{money(t.tcv, cur)}</div>
            </div>
          </div>
          {cur !== reportingCurrency && (
            <div className="hint" style={{ paddingBottom: 8 }}>
              Reports in {reportingCurrency}: {money(t.tcv * rate, reportingCurrency)} at the rate on file
              ({rate}). The rate is stamped on the deal when you save, so later rate changes won't rewrite it.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-2">
        <Field label="Forecast category" hint="Your judgement, separate from the stage probability.">
          <select className="select" value={form.forecastCategory} onChange={set('forecastCategory')}>
            {forecastCategories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Field>
        {isAdmin && (
          <Field label="Owner">
            <select className="select" value={form.owner || ''} onChange={set('owner')}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      {forecastCategories.find((c) => c.value === form.forecastCategory)?.description && (
        <div className="hint" style={{ marginTop: -8, marginBottom: 12 }}>
          {forecastCategories.find((c) => c.value === form.forecastCategory).description}
        </div>
      )}

      <CustomFieldSection
        fields={customFieldsFor('deal')}
        values={form.customFields}
        currency={form.currency}
        onChange={(customFields) => setForm((f) => ({ ...f, customFields }))}
      />

      <Field label="Notes"><textarea className="textarea" value={form.notes} onChange={set('notes')} /></Field>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button className="btn btn-primary" disabled={busy || !form.name.trim() || (!lockCompany && !form.company && !form.companyName)} type="submit">
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
