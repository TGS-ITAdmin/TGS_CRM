import { Field } from './ui.jsx'

/* Renders one admin-defined field. Formula fields are read-only by
 * construction — they are computed server-side on every read, so an input
 * here would be a box whose value is thrown away. */
export default function CustomFieldInput({ field, value, onChange, currency }) {
  const common = { className: 'input', id: `cf_${field.key}` }

  if (field.type === 'formula') {
    return (
      <Field label={field.label} hint={field.helpText || 'Calculated automatically'}>
        <div className="input" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
          {value === null || value === undefined
            ? <span className="faint">Not enough data to calculate</span>
            : typeof value === 'number' ? value.toLocaleString() : String(value)}
        </div>
      </Field>
    )
  }

  let control
  switch (field.type) {
    case 'textarea':
      control = <textarea className="textarea" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'number':
      control = <input {...common} type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'currency':
      control = (
        <div className="row" style={{ gap: 6 }}>
          {currency && <span className="small faint">{currency}</span>}
          <input {...common} type="number" step="0.01" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        </div>
      )
      break
    case 'date':
      control = (
        <input {...common} type="date"
          value={value ? String(value).slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value)} />
      )
      break
    case 'checkbox':
      return (
        <div className="field">
          <label className="row small" style={{ cursor: 'pointer' }}>
            <input type="checkbox" className="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
            {field.label}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
          </label>
          {field.helpText && <div className="hint">{field.helpText}</div>}
        </div>
      )
    case 'select':
      control = (
        <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
      break
    case 'multiselect': {
      const selected = Array.isArray(value) ? value : []
      control = (
        <div className="row wrap" style={{ gap: 5 }}>
          {field.options.map((o) => {
            const on = selected.includes(o)
            return (
              <button
                key={o} type="button"
                className={`tag${on ? '' : ''}`}
                style={{
                  cursor: 'pointer', padding: '4px 10px',
                  background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: on ? 'var(--accent)' : 'var(--text-muted)',
                  borderColor: on ? 'var(--accent)' : 'var(--border)',
                }}
                onClick={() => onChange(on ? selected.filter((x) => x !== o) : [...selected, o])}
              >
                {on ? '✓ ' : ''}{o}
              </button>
            )
          })}
        </div>
      )
      break
    }
    case 'url':
      control = (
        <input {...common} type="url" placeholder="https://…" value={value ?? ''}
          onChange={(e) => onChange(e.target.value)} />
      )
      break
    default:
      control = <input {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
  }

  return (
    <Field
      label={<>{field.label}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}</>}
      hint={field.helpText || (field.requiredAtStage ? `Required from the ${field.requiredAtStage} stage onwards` : '')}
    >
      {control}
    </Field>
  )
}

/* Read-only display, for record sidebars. */
export function CustomFieldValue({ field, value }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
    return <span className="faint">—</span>
  }
  if (field.type === 'checkbox') return <span>{value ? 'Yes' : 'No'}</span>
  if (field.type === 'multiselect') {
    return (
      <div className="row wrap" style={{ gap: 4 }}>
        {value.map((v) => <span className="tag" key={v}>{v}</span>)}
      </div>
    )
  }
  if (field.type === 'url') {
    return <a href={value} target="_blank" rel="noreferrer noopener" className="truncate">{value}</a>
  }
  if (field.type === 'date') {
    try {
      return <span>{new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
    } catch { return <span>{String(value)}</span> }
  }
  if (field.type === 'number' || field.type === 'currency' || field.type === 'formula') {
    return <span>{typeof value === 'number' ? value.toLocaleString() : String(value)}</span>
  }
  return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>
}

/* A block of inputs for every field on an object. */
export function CustomFieldSection({ fields, values, onChange, currency, title = 'Additional details' }) {
  const editable = (fields || []).filter((f) => f.active !== false)
  if (!editable.length) return null
  return (
    <>
      <div className="divider" />
      <h3 style={{ marginBottom: 10 }}>{title}</h3>
      <div className="grid grid-2">
        {editable.map((f) => (
          <CustomFieldInput
            key={f.key} field={f} currency={currency}
            value={values?.[f.key]}
            onChange={(v) => onChange({ ...(values || {}), [f.key]: v })}
          />
        ))}
      </div>
    </>
  )
}
