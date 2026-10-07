import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Field, Loading } from '../components/ui.jsx'

const FIELD_LABELS = {
  firstName: 'First name', lastName: 'Last name', title: 'Job title',
  email: 'Work email', phone: 'Phone', mobile: 'Mobile',
  linkedinUrl: 'LinkedIn URL', location: 'Location', timezone: 'Timezone',
  source: 'Source', notes: 'Notes', tags: 'Tags',
  companyName: 'Company name',
  company_website: 'Company website', company_industry: 'Industry',
  company_employeeCount: 'Company size', company_linkedinUrl: 'Company LinkedIn',
  company_phone: 'Company phone', company_location: 'Company location',
  company_timezone: 'Company timezone', company_address: 'Company address',
  company_seatsNeeded: 'Seats needed', company_targetRoles: 'Target roles',
  company_currentProvider: 'Current provider', company_contractTiming: 'Contract timing',
  company_budgetRange: 'Budget range',
}

// Person fields first, then the company block — matching how a rep reads a list.
const PERSON_ORDER = [
  'firstName', 'lastName', 'email', 'phone', 'mobile', 'title',
  'linkedinUrl', 'location', 'timezone', 'tags', 'notes', 'source',
]
const COMPANY_ORDER = [
  'companyName', 'company_website', 'company_industry', 'company_employeeCount',
  'company_linkedinUrl', 'company_phone', 'company_location', 'company_timezone',
  'company_address', 'company_seatsNeeded', 'company_targetRoles',
  'company_currentProvider', 'company_contractTiming', 'company_budgetRange',
]

export default function ImportContacts() {
  const { users, isAdmin, user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const fileRef = useRef(null)

  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [mapping, setMapping] = useState({})
  const [options, setOptions] = useState({
    owner: user.id, source: 'csv_import', tag: '', onDuplicate: 'skip', reassignOwner: false,
  })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  // `sheet` is only passed when the user picks a different tab of an Excel file.
  async function analyse(f, sheet) {
    if (!f) return
    setFile(f)
    setBusy(true)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', f)
      if (sheet) fd.append('sheet', sheet)
      const data = await api.importPreview(fd)
      setPreview(data)
      setMapping(data.suggestedMapping)
    } catch (err) {
      toast.error(err.message)
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('mapping', JSON.stringify(mapping))
      // Read the same Excel sheet the mapping was built from.
      fd.append('options', JSON.stringify({ ...options, sheet: preview?.sheet || undefined }))
      const { result } = await api.importCommit(fd)
      setResult(result)
      toast.success(`${result.created} contacts created`)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const mappedCount = Object.values(mapping).filter(Boolean).length
  const hasIdentity = mapping.email || mapping.firstName || mapping.lastName || mapping.companyName

  return (
    <>
      <div className="topbar">
        <Link className="btn btn-ghost btn-sm" to="/contacts">←</Link>
        <div>
          <h1>Import contacts</h1>
          <div className="topbar-sub">CSV or Excel upload with column mapping and duplicate detection</div>
        </div>
      </div>

      <div className="page narrow">
        {result ? (
          <div className="card">
            <div className="card-head"><h2>Import finished</h2></div>
            <div className="card-body">
              <div className="grid grid-4" style={{ marginBottom: 16 }}>
                <div className="stat"><div className="stat-label">Created</div><div className="stat-value">{result.created}</div></div>
                <div className="stat"><div className="stat-label">Updated</div><div className="stat-value">{result.updated}</div></div>
                <div className="stat"><div className="stat-label">Skipped</div><div className="stat-value">{result.skipped}</div></div>
                <div className="stat"><div className="stat-label">Suppressed</div><div className="stat-value">{result.suppressed}</div></div>
              </div>

              {result.companiesCreated > 0 && (
                <div className="banner banner-info">
                  <span>🏢</span>
                  <div>
                    {result.companiesCreated} new compan{result.companiesCreated === 1 ? 'y was' : 'ies were'} created
                    from this file. Contacts sharing an email domain were attached to the same company.
                  </div>
                </div>
              )}

              {result.suppressed > 0 && (
                <div className="banner banner-warn">
                  <span>⚠</span>
                  <div>
                    {result.suppressed} row{result.suppressed === 1 ? ' was' : 's were'} matched against your
                    do-not-contact list and imported already flagged. They will never be emailed.
                  </div>
                </div>
              )}

              {result.errors.length > 0 && (
                <>
                  <h3 style={{ margin: '14px 0 8px' }}>Rows that did not import</h3>
                  <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                    <table className="data">
                      <thead><tr><th>Row</th><th>Reason</th></tr></thead>
                      <tbody>
                        {result.errors.map((e, i) => (
                          <tr key={i}><td>{e.row}</td><td className="small">{e.error}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="row" style={{ marginTop: 18 }}>
                <button className="btn btn-primary" onClick={() => navigate('/contacts')}>View contacts</button>
                <button className="btn" onClick={() => { setResult(null); setPreview(null); setFile(null) }}>
                  Import another file
                </button>
              </div>
            </div>
          </div>
        ) : !preview ? (
          <div className="card">
            <div className="card-body">
              {busy ? (
                <Loading label="Reading your file…" />
              ) : (
                <>
                  <h2 style={{ marginBottom: 6 }}>Choose a CSV or Excel file</h2>
                  <p className="small muted">
                    Any column layout works — you map the columns on the next screen. Duplicates are matched
                    on email and LinkedIn URL, both inside the file and against contacts you already have.
                  </p>
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); analyse(e.dataTransfer.files[0]) }}
                    style={{
                      border: '2px dashed var(--border-strong)', borderRadius: 'var(--radius)',
                      padding: 36, textAlign: 'center', marginTop: 14, cursor: 'pointer',
                    }}
                    onClick={() => fileRef.current?.click()}
                  >
                    <div style={{ fontSize: 26, marginBottom: 8 }}>📄</div>
                    <div className="strong">Drop a CSV or Excel (.xlsx) file here, or click to choose one</div>
                    <div className="small faint" style={{ marginTop: 4 }}>Up to 25,000 rows per file · for Excel, the first sheet with data is used</div>
                  </div>
                  <input
                    ref={fileRef} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
                    onChange={(e) => analyse(e.target.files[0])}
                  />
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="banner banner-info">
              <span>✓</span>
              <div>
                <strong>{preview.rowCount.toLocaleString()} rows</strong> found in {file.name}
                {preview.sheet && <> (sheet <strong>{preview.sheet}</strong>, column names read from row {preview.headerRow})</>}.
                We matched {mappedCount} column{mappedCount === 1 ? '' : 's'} automatically — check them below.
              </div>
            </div>

            {preview.sheets?.length > 1 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-body">
                  <div className="field" style={{ marginBottom: 0, maxWidth: 420 }}>
                    <label className="label">This workbook has {preview.sheets.length} sheets — import from</label>
                    <select className="select" value={preview.sheet}
                      onChange={(e) => analyse(file, e.target.value)}>
                      {preview.sheets.map((sh) => (
                        <option key={sh.name} value={sh.name}>
                          {sh.name} ({sh.rows.toLocaleString()} row{sh.rows === 1 ? '' : 's'})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><h2>Map your columns</h2></div>
              <div className="card-body">
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th style={{ width: '35%' }}>CRM field</th><th style={{ width: '35%' }}>Your column</th><th>Example</th></tr>
                    </thead>
                    <tbody>
                      {[
                        { header: 'The person', fields: PERSON_ORDER },
                        { header: 'Their company', fields: COMPANY_ORDER },
                      ].flatMap((group) => [
                        <tr key={group.header}>
                          <td colSpan={3} style={{ background: 'var(--surface-2)', fontWeight: 640, fontSize: 12 }}>
                            {group.header}
                          </td>
                        </tr>,
                        ...group.fields.map((field) => {
                        const chosen = mapping[field] || ''
                        const example = chosen ? preview.sample.map((r) => r[chosen]).find(Boolean) : ''
                        return (
                          <tr key={field}>
                            <td>
                              <span className="strong">{FIELD_LABELS[field]}</span>
                              {(field === 'email' || field === 'linkedinUrl') && (
                                <div className="small faint">used for duplicate detection</div>
                              )}
                              {field === 'companyName' && (
                                <div className="small faint">matched to an existing company by email domain, or created</div>
                              )}
                            </td>
                            <td>
                              <select
                                className="select" value={chosen}
                                onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                              >
                                <option value="">— not imported —</option>
                                {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                              </select>
                            </td>
                            <td className="small faint truncate" style={{ maxWidth: 220 }}>{example || '—'}</td>
                          </tr>
                        )
                        }),
                      ])}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head"><h2>Import options</h2></div>
              <div className="card-body">
                <div className="grid grid-2">
                  {isAdmin && (
                    <Field label="Assign these contacts to">
                      <select className="select" value={options.owner}
                        onChange={(e) => setOptions((o) => ({ ...o, owner: e.target.value }))}>
                        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </Field>
                  )}
                  <Field label="Contact source" hint="Shows on the record and in reports.">
                    <input className="input" value={options.source}
                      onChange={(e) => setOptions((o) => ({ ...o, source: e.target.value }))} />
                  </Field>
                  <Field label="Tag every imported contact with" hint="Optional. Makes this batch easy to find later.">
                    <input className="input" value={options.tag} placeholder="e.g. healthcare-list-aug"
                      onChange={(e) => setOptions((o) => ({ ...o, tag: e.target.value }))} />
                  </Field>
                  <Field label="If a contact already exists">
                    <select className="select" value={options.onDuplicate}
                      onChange={(e) => setOptions((o) => ({ ...o, onDuplicate: e.target.value }))}>
                      <option value="skip">Skip the row — keep what we have</option>
                      <option value="update">Update the existing contact with the new values</option>
                    </select>
                  </Field>
                </div>
              </div>
            </div>

            {!hasIdentity && (
              <div className="banner banner-danger">
                Map at least one of email, first name, last name or company name — otherwise every row is skipped.
              </div>
            )}

            <div className="row">
              <button className="btn btn-primary btn-lg" disabled={busy || !hasIdentity} onClick={commit}>
                {busy ? <><span className="spinner" /> Importing…</> : `Import ${preview.rowCount.toLocaleString()} rows`}
              </button>
              <button className="btn" onClick={() => { setPreview(null); setFile(null) }} disabled={busy}>
                Choose a different file
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
