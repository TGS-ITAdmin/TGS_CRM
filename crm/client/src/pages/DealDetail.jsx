import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { CustomFieldValue } from '../components/CustomFieldInput.jsx'
import { useToast } from '../components/Toast.jsx'
import DealForm from '../components/DealForm.jsx'
import { CloseLostDialog } from './Deals.jsx'
import { Confirm, Empty, Loading, Modal, StatusPill } from '../components/ui.jsx'
import { dateTime, fullName, money, relativeDate, daysSince, shortDate } from '../components/format.js'
import QuoteStatus from '../components/QuoteStatus.jsx'

function Row({ label, children }) {
  if (children === null || children === undefined || children === '') return null
  return (
    <div style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: 13 }}>
      <div className="faint" style={{ width: 150, flex: '0 0 150px' }}>{label}</div>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  )
}

export default function DealDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { stageMap, statusMap, reportingCurrency, forecastCategories, lostReasons, can } = useAuth()
  const isAdmin = can('deals.delete')
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState(null)
  const [closing, setClosing] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.getDeal(id))
    } catch (err) {
      toast.error(err.message)
      navigate('/deals')
    } finally {
      setLoading(false)
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  if (loading) return <Loading />
  if (!data) return null
  const { deal, activities, companyContacts, stages, canEdit, quotes = [], customFields, missingRequired = [] } = data
  const stage = stageMap.get(deal.stage)
  const age = daysSince(deal.stageEnteredAt)
  const weighted = deal.forecastCategory === 'omitted' || deal.status !== 'open'
    ? 0
    : (deal.tcvUsd || 0) * ((deal.probability || 0) / 100)

  async function move(stageKey) {
    const target = stageMap.get(stageKey)
    if (target?.type === 'lost') { setClosing(target); return }
    try {
      await api.setDealStage(deal._id, { stage: stageKey })
      toast.success(target?.type === 'won' ? 'Marked won' : `Moved to ${target?.name}`)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function act(fn, message) {
    setBusy(true)
    try {
      await fn()
      if (message) toast.success(message)
      load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <Link className="btn btn-ghost btn-sm" to="/deals">←</Link>
        <div style={{ minWidth: 0 }}>
          <h1 className="truncate">{deal.name}</h1>
          <div className="topbar-sub truncate">
            {deal.company ? <Link to={`/companies/${deal.company._id}`}>{deal.company.name}</Link> : 'No company'}
            {' · '}{money(deal.tcv, deal.currency)}
            {deal.currency !== reportingCurrency && ` (${money(deal.tcvUsd, reportingCurrency)})`}
          </div>
        </div>
        <div className="spacer" />
        {deal.status === 'open' && canEdit && (
          <select className="select" style={{ maxWidth: 190 }} value={deal.stage}
            onChange={(e) => move(e.target.value)}>
            {stages.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        )}
        {canEdit && <button className="btn btn-sm" onClick={() => setDialog('edit')}>Edit</button>}
      </div>

      <div className="page">
        {deal.status === 'won' && (
          <div className="banner banner-ok">
            <span>🏆</span>
            <div>
              <strong>Won</strong> on {shortDate(deal.wonAt)} — {money(deal.tcv, deal.currency)} total contract value
              {deal.mrr > 0 && `, ${money(deal.mrr, deal.currency)} per month`}.
              {canEdit && (
                <> <button className="btn btn-sm" style={{ marginLeft: 8 }}
                  onClick={() => act(() => api.reopenDeal(deal._id), 'Deal reopened')}>Reopen</button></>
              )}
            </div>
          </div>
        )}
        {deal.status === 'lost' && (
          <div className="banner banner-danger">
            <span>✕</span>
            <div>
              <strong>Lost</strong> on {shortDate(deal.lostAt)}{deal.lostReason && ` — ${deal.lostReason}`}.
              {deal.closedNotes && <div className="small" style={{ marginTop: 4 }}>{deal.closedNotes}</div>}
              {canEdit && (
                <> <button className="btn btn-sm" style={{ marginTop: 6 }}
                  onClick={() => act(() => api.reopenDeal(deal._id), 'Deal reopened')}>Reopen</button></>
              )}
            </div>
          </div>
        )}
        {missingRequired.length > 0 && deal.status === 'open' && (
          <div className="banner banner-warn">
            <span>⚠</span>
            <div style={{ flex: 1 }}>
              <strong>This deal cannot move to its next stage yet.</strong>{' '}
              {missingRequired.map((f) => `"${f.label}"`).join(', ')}{' '}
              {missingRequired.length === 1 ? 'is' : 'are'} required and still empty.
            </div>
            {canEdit && <button className="btn btn-sm" onClick={() => setDialog('edit')}>Fill them in</button>}
          </div>
        )}

        {deal.status === 'open' && !deal.expectedCloseDate && (
          <div className="banner banner-warn">
            <span>⚠</span>
            <div>
              No expected close date, so this deal is invisible to the forecast.
              {canEdit && <> <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => setDialog('edit')}>Set one</button></>}
            </div>
          </div>
        )}
        {!canEdit && (
          <div className="banner banner-info">
            <span>ℹ</span>
            <div>You can see this deal because everyone sees the whole pipeline, but only {deal.owner?.name || 'its owner'} or an admin can change it.</div>
          </div>
        )}

        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <div className="stat">
            <div className="stat-label">Total contract value</div>
            <div className="stat-value">{money(deal.tcv, deal.currency, { compact: true })}</div>
            <div className="stat-sub">
              {deal.termMonths ? `over ${deal.termMonths} months` : 'no term set'}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Monthly recurring</div>
            <div className="stat-value">{money(deal.mrr, deal.currency, { compact: true })}</div>
            <div className="stat-sub">{deal.oneTimeTotal > 0 ? `+ ${money(deal.oneTimeTotal, deal.currency)} one-off` : 'no one-off fees'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Weighted</div>
            <div className="stat-value">{money(weighted, reportingCurrency, { compact: true })}</div>
            <div className="stat-sub">{deal.probability}% × value</div>
          </div>
          <div className="stat">
            <div className="stat-label">In this stage</div>
            <div className="stat-value" style={{ color: age > 30 ? 'var(--warn)' : undefined }}>{age}d</div>
            <div className="stat-sub">{stage?.name || deal.stage}</div>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', alignItems: 'start' }}>
          <div className="col" style={{ gap: 14 }}>
            {deal.pricingMode === 'line_items' && deal.lineItems?.length > 0 && (
              <div className="card">
                <div className="card-head"><h2>What they're buying</h2></div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Item</th><th>Pricing</th><th className="right">Qty</th><th className="right">Price</th>
                        <th className="right">Discount</th><th className="right">Line</th></tr>
                    </thead>
                    <tbody>
                      {deal.lineItems.map((li) => (
                        <tr key={li._id}>
                          <td className="strong">{li.name}</td>
                          <td className="small faint">{li.pricingModel.replace(/_/g, ' ')}</td>
                          <td className="right">{li.quantity}</td>
                          <td className="right">{money(li.unitPrice, deal.currency)}</td>
                          <td className="right small" style={{ color: li.discountPercent > 0 ? 'var(--warn)' : undefined }}>
                            {li.discountPercent > 0 ? `−${li.discountPercent}%` : '—'}
                          </td>
                          <td className="right strong">{money(li.quantity * li.unitPrice, deal.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>Quotes</h2>
                {canEdit && (
                  <button className="btn btn-sm" disabled={busy}
                    onClick={() => act(async () => {
                      const { quote } = await api.createQuote({ deal: deal._id })
                      navigate(`/quotes/${quote._id}`)
                    })}>
                    + New quote
                  </button>
                )}
              </div>
              {quotes.length === 0 ? (
                <Empty icon="📄" title="No quotes yet">
                  A quote starts from this deal's pricing, so anything you've already itemised carries over.
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Quote</th><th>Status</th><th className="right">Value</th>
                        <th>Valid until</th><th>Client opened</th></tr>
                    </thead>
                    <tbody>
                      {quotes.map((q) => (
                        <tr key={q._id}>
                          <td>
                            <Link to={`/quotes/${q._id}`} className="strong">{q.number}</Link>
                            {q.version > 1 && <span className="faint small"> v{q.version}</span>}
                          </td>
                          <td>
                            <QuoteStatus status={q.status} />
                            {q.status === 'pending_approval' && q.approvalReasons?.length > 0 && (
                              <div className="small faint truncate" style={{ maxWidth: 200 }}>
                                {q.approvalReasons.map((r) => r.label).join(', ')}
                              </div>
                            )}
                          </td>
                          <td className="right strong">{money(q.tcv, q.currency, { compact: true })}</td>
                          <td className="small faint nowrap">{q.validUntil ? shortDate(q.validUntil) : '—'}</td>
                          <td className="small faint nowrap">
                            {q.firstViewedAt ? relativeDate(q.firstViewedAt)
                              : ['sent', 'approved'].includes(q.status) ? <span style={{ color: 'var(--warn)' }}>not yet</span> : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>People on this deal</h2>
                {canEdit && companyContacts.length > 0 && (
                  <button className="btn btn-sm" onClick={() => setDialog('add-contact')}>+ Add</button>
                )}
              </div>
              {(!deal.contacts || deal.contacts.length === 0) ? (
                <Empty icon="👤" title="Nobody attached yet">
                  Add the people you're actually talking to — the buying committee is what a deal review asks about.
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Name</th><th>Title</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {deal.contacts.map((c) => (
                        <tr key={c._id}>
                          <td>
                            <Link to={`/contacts/${c._id}`} className="strong">{fullName(c)}</Link>
                            {String(deal.primaryContact?._id || deal.primaryContact) === String(c._id) && (
                              <span className="tag" style={{ marginLeft: 6 }}>primary</span>
                            )}
                            <div className="small faint">{c.email}</div>
                          </td>
                          <td className="small">{c.title || '—'}</td>
                          <td><StatusPill value={c.status} statusMap={statusMap} /></td>
                          <td className="right">
                            {canEdit && (
                              <button className="btn btn-ghost btn-sm"
                                onClick={() => act(() => api.removeDealContact(deal._id, c._id), 'Removed')}>✕</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head"><h2>Stage history</h2></div>
              <div className="card-body">
                {deal.stageHistory?.length ? (
                  <div className="timeline">
                    {[...deal.stageHistory].reverse().map((h, i) => {
                      const days = h.leftAt
                        ? Math.max(0, Math.round((new Date(h.leftAt) - new Date(h.enteredAt)) / 86400000))
                        : daysSince(h.enteredAt)
                      return (
                        <div className="tl-item" key={i}>
                          <span className="tl-dot" style={{ borderColor: stageMap.get(h.stage)?.color }} />
                          <div className="tl-title">{h.stageName}</div>
                          <div className="tl-meta">
                            {dateTime(h.enteredAt)} · {days} day{days === 1 ? '' : 's'}{h.leftAt ? '' : ' so far'}
                            {h.probability != null && ` · ${h.probability}%`}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : <div className="small faint">No stage movement recorded.</div>}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>Deal timeline</h2>
                <span className="small faint">{activities.length} entries</span>
              </div>
              <div className="card-body">
                {activities.length === 0 ? (
                  <Empty icon="🕓" title="Nothing yet" />
                ) : (
                  <div className="timeline">
                    {activities.map((a) => (
                      <div className="tl-item" key={a._id}>
                        <span className={`tl-dot ${a.type === 'deal_won' ? 'call' : a.type === 'deal_lost' ? 'alert' : ''}`} />
                        <div className="tl-title">{a.title}</div>
                        <div className="tl-meta">
                          {dateTime(a.createdAt)}
                          {a.user?.name && <> · {a.user.name}</>}
                          {a.contact && <> · {fullName(a.contact)}</>}
                        </div>
                        {a.body && <div className="tl-body">{a.body}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="col" style={{ gap: 14 }}>
            <div className="card">
              <div className="card-head"><h2>Deal</h2></div>
              <div className="card-body" style={{ paddingTop: 8 }}>
                <Row label="Stage">{stage?.name || deal.stage}</Row>
                <Row label="Probability">{deal.probability}%</Row>
                <Row label="Forecast category">
                  {forecastCategories.find((c) => c.value === deal.forecastCategory)?.label || deal.forecastCategory}
                </Row>
                <Row label="Expected close">{deal.expectedCloseDate ? shortDate(deal.expectedCloseDate) : null}</Row>
                <Row label="Currency">
                  {deal.currency}
                  {deal.currency !== reportingCurrency && (
                    <span className="small faint"> · rate {deal.fxRate} stamped on save</span>
                  )}
                </Row>
                <Row label="Contract term">{deal.termMonths ? `${deal.termMonths} months` : null}</Row>
                <Row label="Owner">{deal.owner?.name}</Row>
                <Row label="Source">{deal.source}</Row>
                <Row label="From campaign">
                  {deal.campaign ? <Link to={`/campaigns/${deal.campaign._id}`}>{deal.campaign.name}</Link> : null}
                </Row>
                <Row label="Created">{dateTime(deal.createdAt)}</Row>
                <Row label="Last activity">{relativeDate(deal.lastActivityAt)}</Row>
              </div>
            </div>

            {deal.company && (
              <div className="card">
                <div className="card-head">
                  <h2 style={{ flex: 1 }}><Link to={`/companies/${deal.company._id}`}>{deal.company.name}</Link></h2>
                </div>
                <div className="card-body" style={{ paddingTop: 8 }}>
                  <Row label="Industry">{deal.company.industry}</Row>
                  <Row label="Seats needed">{deal.company.seatsNeeded ?? null}</Row>
                  <Row label="Target roles">{deal.company.targetRoles}</Row>
                </div>
              </div>
            )}

            {customFields?.length > 0 && customFields.some((f) => f.active !== false) && (
              <div className="card">
                <div className="card-head"><h2>Additional details</h2></div>
                <div className="card-body" style={{ paddingTop: 8 }}>
                  {customFields.filter((f) => f.active !== false).map((f) => (
                    <Row key={f.key} label={f.label}>
                      <CustomFieldValue field={f} value={deal.customFields?.[f.key]} />
                    </Row>
                  ))}
                </div>
              </div>
            )}

            {deal.notes && (
              <div className="card">
                <div className="card-head"><h2>Notes</h2></div>
                <div className="card-body small" style={{ whiteSpace: 'pre-wrap' }}>{deal.notes}</div>
              </div>
            )}

            {canEdit && deal.status === 'open' && (
              <div className="card">
                <div className="card-body">
                  <button className="btn btn-block btn-sm" style={{ marginBottom: 8 }}
                    onClick={() => move(stages.find((s) => s.type === 'won')?.key)}>
                    Mark won
                  </button>
                  <button className="btn btn-block btn-sm"
                    onClick={() => setClosing(stages.find((s) => s.type === 'lost'))}>
                    Mark lost
                  </button>
                </div>
              </div>
            )}
            {isAdmin && (
              <div className="card">
                <div className="card-body">
                  <button className="btn btn-danger btn-block btn-sm" onClick={() => setDialog('delete')}>Delete deal</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {dialog === 'edit' && (
        <Modal title="Edit deal" width="wide" onClose={() => setDialog(null)}>
          <DealForm
            initial={deal} lockCompany companyContacts={companyContacts}
            submitLabel="Save changes" onCancel={() => setDialog(null)}
            onSubmit={async (values) => {
              await api.updateDeal(deal._id, values)
              toast.success('Deal updated')
              setDialog(null)
              load()
            }}
          />
        </Modal>
      )}

      {dialog === 'add-contact' && (
        <AddContactDialog
          deal={deal} companyContacts={companyContacts}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); load() }}
        />
      )}

      {closing && (
        <CloseLostDialog deal={deal} stage={closing} lostReasons={lostReasons}
          onClose={() => setClosing(null)} onDone={() => { setClosing(null); load() }} />
      )}

      {dialog === 'delete' && (
        <Confirm
          danger title="Delete this deal" confirmLabel="Delete permanently"
          message="The deal and its timeline are removed. Contacts and the company are untouched. This cannot be undone."
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteDeal(deal._id)
            toast.success('Deal deleted')
            navigate('/deals')
          }}
        />
      )}
    </>
  )
}

function AddContactDialog({ deal, companyContacts, onClose, onDone }) {
  const toast = useToast()
  const attached = new Set((deal.contacts || []).map((c) => String(c._id)))
  const available = companyContacts.filter((c) => !attached.has(String(c._id)))
  const [picked, setPicked] = useState('')
  const [primary, setPrimary] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      title="Add someone to this deal" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.addDealContact(deal._id, { contactId: picked, primary })
                toast.success('Added')
                onDone()
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            Add
          </button>
        </>
      }
    >
      {available.length === 0 ? (
        <Empty icon="👤" title="Everyone at this company is already on the deal">
          Add a new contact on the company page first.
        </Empty>
      ) : (
        <>
          <div className="field">
            <label className="label">Contact</label>
            <select className="select" value={picked} onChange={(e) => setPicked(e.target.value)} autoFocus>
              <option value="">Choose…</option>
              {available.map((c) => (
                <option key={c._id} value={c._id}>
                  {[c.firstName, c.lastName].filter(Boolean).join(' ')}{c.title ? ` — ${c.title}` : ''}
                </option>
              ))}
            </select>
          </div>
          <label className="row small">
            <input type="checkbox" className="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} />
            Make this the primary contact
          </label>
          <div className="hint">Only people at this company can join the deal.</div>
        </>
      )}
    </Modal>
  )
}
