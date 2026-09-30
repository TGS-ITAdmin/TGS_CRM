import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Empty, Loading, Modal } from '../components/ui.jsx'
import { fullName, shortDate, num } from '../components/format.js'

const CONFIDENCE = {
  certain: { label: 'Certain', color: 'var(--danger)' },
  likely: { label: 'Likely', color: 'var(--warn)' },
  possible: { label: 'Possible', color: 'var(--text-muted)' },
}

export default function Duplicates() {
  const { can } = useAuth()
  const isAdmin = can('records.merge')
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const object = params.get('object') === 'company' ? 'company' : 'contact'

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [merging, setMerging] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(object === 'company' ? await api.scanCompanyDuplicates() : await api.scanContactDuplicates())
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [object]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const groups = data?.groups || []

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Duplicates</h1>
          <div className="topbar-sub">Find records that are the same thing twice, and merge them</div>
        </div>
        <div className="spacer" />
        <div className="tabs" style={{ border: 0, margin: 0 }}>
          <button className={`tab${object === 'contact' ? ' active' : ''}`}
            onClick={() => setParams({ object: 'contact' })}>Contacts</button>
          <button className={`tab${object === 'company' ? ' active' : ''}`}
            onClick={() => setParams({ object: 'company' })}>Companies</button>
        </div>
        <button className="btn btn-sm" onClick={load}>Rescan</button>
      </div>

      <div className="page">
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            <strong>Merging cannot be undone.</strong> {data?.note}
            {!isAdmin && ' Only an admin can perform a merge.'}
          </div>
        </div>

        {loading ? <Loading label="Scanning…" /> : groups.length === 0 ? (
          <div className="card">
            <Empty icon="✅" title="No duplicates found">
              Nothing here looks like the same {object} twice.
            </Empty>
          </div>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            {groups.map((g) => (
              <div className="card" key={g.key}>
                <div className="card-head">
                  <span className="pill" style={{ color: CONFIDENCE[g.confidence]?.color, borderColor: `${CONFIDENCE[g.confidence]?.color}55` }}>
                    <span className="pill-dot" />{CONFIDENCE[g.confidence]?.label}
                  </span>
                  <span className="small muted" style={{ flex: 1 }}>{g.reason}</span>
                  <span className="small faint">
                    {(g.contacts || g.companies).length} records
                  </span>
                </div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        {object === 'contact'
                          ? <><th>Name</th><th>Email</th><th>Phone</th><th>Added</th></>
                          : <><th>Company</th><th>Domain</th><th className="right">Contacts</th><th>Added</th></>}
                        {isAdmin && <th className="right">Keep this one</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(g.contacts || g.companies).map((rec) => (
                        <tr key={rec._id}>
                          {object === 'contact' ? (
                            <>
                              <td><Link to={`/contacts/${rec._id}`} className="strong">{fullName(rec)}</Link></td>
                              <td className="small">{rec.email || <span className="faint">—</span>}</td>
                              <td className="small">{rec.phone || <span className="faint">—</span>}</td>
                            </>
                          ) : (
                            <>
                              <td><Link to={`/companies/${rec._id}`} className="strong">{rec.name}</Link></td>
                              <td className="small mono">{rec.domain || <span className="faint">—</span>}</td>
                              <td className="right">{num(rec.contactCount)}</td>
                            </>
                          )}
                          <td className="small faint nowrap">{shortDate(rec.createdAt)}</td>
                          {isAdmin && (
                            <td className="right">
                              <button className="btn btn-sm"
                                onClick={() => setMerging({
                                  object,
                                  keep: rec,
                                  others: (g.contacts || g.companies).filter((x) => String(x._id) !== String(rec._id)),
                                })}>
                                Keep &amp; merge others
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {merging && (
        <MergeDialog
          {...merging}
          onClose={() => setMerging(null)}
          onDone={() => { setMerging(null); load() }}
        />
      )}
    </>
  )
}

function MergeDialog({ object, keep, others, onClose, onDone }) {
  const toast = useToast()
  const [loseId, setLoseId] = useState(others[0]?._id || '')
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const keepName = object === 'contact' ? fullName(keep) : keep.name

  useEffect(() => {
    if (!loseId) return
    setLoading(true)
    setPreview(null)
    const fn = object === 'contact' ? api.previewContactMerge : api.previewCompanyMerge
    fn(keep._id, loseId)
      .then(setPreview)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false))
  }, [loseId]) // eslint-disable-line react-hooks/exhaustive-deps

  const moving = Object.entries(preview?.wouldMove || {}).filter(([, n]) => n > 0)
  // Typing the name is friction on purpose: this is the one action in the app
  // with no undo.
  const confirmed = confirmText.trim().toLowerCase() === 'merge'

  return (
    <Modal
      title={`Merge into ${keepName}`} width="wide" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || !loseId || !confirmed || loading}
            onClick={async () => {
              setBusy(true)
              try {
                const fn = object === 'contact' ? api.mergeContacts : api.mergeCompanies
                const res = await fn(keep._id, loseId)
                toast.success(
                  `Merged${res.filled?.length ? ` — filled ${res.filled.length} blank field${res.filled.length === 1 ? '' : 's'}` : ''}`
                )
                onDone()
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            {busy ? 'Merging…' : 'Merge permanently'}
          </button>
        </>
      }
    >
      {others.length > 1 && (
        <div className="field">
          <label className="label">Which duplicate to merge in</label>
          <select className="select" value={loseId} onChange={(e) => setLoseId(e.target.value)}>
            {others.map((o) => (
              <option key={o._id} value={o._id}>
                {object === 'contact' ? `${fullName(o)}${o.email ? ` — ${o.email}` : ''}` : o.name}
              </option>
            ))}
          </select>
          <div className="hint">Merge one at a time so you can see what each brings with it.</div>
        </div>
      )}

      {loading && <Loading label="Working out what would change…" />}

      {preview && (
        <>
          <div className="banner banner-info">
            <span>→</span>
            <div>
              Keeping <strong>{keepName}</strong>. The other record is deleted, and everything attached
              to it moves across.
            </div>
          </div>

          {preview.inheritsSuppression && (
            <div className="banner banner-danger">
              <span>⛔</span>
              <div>
                The duplicate is flagged <strong>do not contact</strong>, so the surviving record will be
                too. A suppression is never dropped by a merge.
              </div>
            </div>
          )}

          <div className="grid grid-2">
            <div>
              <div className="label">Blanks that get filled</div>
              {preview.wouldFill.length === 0 ? (
                <div className="small faint">Nothing — the record you are keeping is already more complete.</div>
              ) : (
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {preview.wouldFill.map((f) => <li key={f}>{f}</li>)}
                </ul>
              )}
            </div>
            <div>
              <div className="label">Values that get discarded</div>
              {preview.wouldDiscard.length === 0 ? (
                <div className="small faint">Nothing conflicts.</div>
              ) : (
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {preview.wouldDiscard.map((d) => (
                    <li key={d.field}>
                      <strong>{d.field}</strong>: keeping “{String(d.keeping)}”, losing “{String(d.discarding)}”
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="divider" />
          <div className="label">What moves across</div>
          {moving.length === 0 ? (
            <div className="small faint">Nothing is attached to the duplicate.</div>
          ) : (
            <div className="row wrap" style={{ gap: 6 }}>
              {moving.map(([k, n]) => <span className="tag" key={k}>{n} {k}</span>)}
            </div>
          )}

          <div className="divider" />
          <div className="field">
            <label className="label">Type <code className="kbd">merge</code> to confirm</label>
            <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
              placeholder="merge" autoComplete="off" />
            <div className="hint">This is the only action in the CRM with no undo.</div>
          </div>
        </>
      )}
    </Modal>
  )
}
