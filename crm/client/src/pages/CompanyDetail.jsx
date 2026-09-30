import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { CustomFieldValue } from '../components/CustomFieldInput.jsx'
import { useToast } from '../components/Toast.jsx'
import CompanyForm from '../components/CompanyForm.jsx'
import DealForm from '../components/DealForm.jsx'
import ContactForm from '../components/ContactForm.jsx'
import { Channel, Confirm, Empty, Loading, Modal, StatusPill } from '../components/ui.jsx'
import { dateTime, fullName, relativeDate, num, money, shortDate } from '../components/format.js'

const DOT_CLASS = {
  email_sent: 'email', email_failed: 'alert', email_suppressed: 'alert',
  linkedin_action: 'linkedin', call_logged: 'call',
  unsubscribed: 'alert', dnc_added: 'alert',
}

function Row({ label, children }) {
  if (!children) return null
  return (
    <div style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: 13 }}>
      <div className="faint" style={{ width: 140, flex: '0 0 140px' }}>{label}</div>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  )
}

export default function CompanyDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { statusMap, can, stageMap, reportingCurrency } = useAuth()
  const isAdmin = can('contacts.delete')
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await api.getCompany(id))
    } catch (err) {
      toast.error(err.message)
      navigate('/companies')
    } finally {
      setLoading(false)
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  if (loading) return <Loading />
  if (!data) return null
  const { company, contacts, totalContacts, hiddenContacts, activities, activeEnrollments, openTasks, deals, dealTotals, customFields } = data

  return (
    <>
      <div className="topbar">
        <Link className="btn btn-ghost btn-sm" to="/companies">←</Link>
        <div style={{ minWidth: 0 }}>
          <h1 className="truncate">{company.name}</h1>
          <div className="topbar-sub truncate">
            {[company.industry, company.domain, company.location].filter(Boolean).join(' · ') || 'No details recorded yet'}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => setDialog('add-deal')}>+ Deal</button>
        <button className="btn btn-sm" onClick={() => setDialog('add-contact')}>+ Contact</button>
        <button className="btn btn-sm" onClick={() => setDialog('edit')}>Edit</button>
      </div>

      <div className="page">
        <div className="grid grid-4" style={{ marginBottom: 18 }}>
          <div className="stat">
            <div className="stat-label">Contacts</div>
            <div className="stat-value">{num(totalContacts)}</div>
            <div className="stat-sub">{hiddenContacts ? `${hiddenContacts} owned by others` : 'all visible to you'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">In campaigns</div>
            <div className="stat-value">{num(activeEnrollments.length)}</div>
            <div className="stat-sub">active enrollments</div>
          </div>
          <div className="stat">
            <div className="stat-label">Open tasks</div>
            <div className="stat-value">{num(openTasks)}</div>
            <div className="stat-sub">across everyone here</div>
          </div>
          <div className="stat">
            <div className="stat-label">Open pipeline</div>
            <div className="stat-value">{money(dealTotals?.openTcvUsd ?? 0, reportingCurrency, { compact: true })}</div>
            <div className="stat-sub">
              {num(dealTotals?.open ?? 0)} open
              {dealTotals?.won ? ` · ${money(dealTotals.wonTcvUsd, reportingCurrency, { compact: true })} won` : ''}
            </div>
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', alignItems: 'start' }}>
          <div className="col" style={{ gap: 14 }}>
            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>Deals</h2>
                <button className="btn btn-sm" onClick={() => setDialog('add-deal')}>+ New deal</button>
              </div>
              {!deals || deals.length === 0 ? (
                <Empty icon="💼" title="No deals yet">
                  A deal appears here automatically when you log a booked meeting with anyone at this company.
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Deal</th><th>Stage</th><th className="right">Value</th><th className="right">MRR</th>
                        <th>Close date</th><th>Owner</th></tr>
                    </thead>
                    <tbody>
                      {deals.map((d) => (
                        <tr key={d._id}>
                          <td>
                            <Link to={`/deals/${d._id}`} className="strong">{d.name}</Link>
                            {d.status !== 'open' && (
                              <span className="tag" style={{ marginLeft: 6, color: d.status === 'won' ? 'var(--ok)' : 'var(--danger)' }}>
                                {d.status}
                              </span>
                            )}
                            {d.primaryContact && (
                              <div className="small faint">{fullName(d.primaryContact)}</div>
                            )}
                          </td>
                          <td className="small">
                            <span className="pill-dot" style={{ background: stageMap.get(d.stage)?.color, display: 'inline-block', marginRight: 5 }} />
                            {stageMap.get(d.stage)?.name || d.stage}
                          </td>
                          <td className="right strong">{money(d.tcvUsd, reportingCurrency, { compact: true })}</td>
                          <td className="right small">{d.mrrUsd ? money(d.mrrUsd, reportingCurrency, { compact: true }) : '—'}</td>
                          <td className="small faint nowrap">{d.expectedCloseDate ? shortDate(d.expectedCloseDate) : '—'}</td>
                          <td className="small">{d.owner?.name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>People here</h2>
                <button className="btn btn-sm" onClick={() => setDialog('add-contact')}>+ Add</button>
              </div>
              {contacts.length === 0 ? (
                <Empty icon="👤" title="No contacts you can see">
                  {hiddenContacts > 0
                    ? `${hiddenContacts} contact${hiddenContacts === 1 ? ' is' : 's are'} owned by other reps.`
                    : 'Add the first person you know at this company.'}
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Name</th><th>Title</th><th>Status</th><th>Channels</th><th>Owner</th><th>Last activity</th></tr>
                    </thead>
                    <tbody>
                      {contacts.map((c) => (
                        <tr key={c._id}>
                          <td>
                            <Link to={`/contacts/${c._id}`} className="strong">{fullName(c)}</Link>
                            {c.doNotContact && <span className="tag" style={{ marginLeft: 6, color: 'var(--danger)' }}>DNC</span>}
                            <div className="small faint truncate" style={{ maxWidth: 220 }}>{c.email || '—'}</div>
                          </td>
                          <td className="small truncate" style={{ maxWidth: 160 }}>{c.title || '—'}</td>
                          <td><StatusPill value={c.status} statusMap={statusMap} /></td>
                          <td>
                            <div className="row" style={{ gap: 4 }}>
                              {c.linkedinUrl && <Channel value="linkedin" showLabel={false} />}
                              {c.email && <Channel value="email" showLabel={false} />}
                              {(c.phone || c.mobile) && <Channel value="call" showLabel={false} />}
                            </div>
                          </td>
                          <td className="small">{c.owner?.name || <span className="faint">—</span>}</td>
                          <td className="small faint nowrap">{relativeDate(c.lastActivityAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {hiddenContacts > 0 && contacts.length > 0 && (
                <div className="card-body tight">
                  <div className="hint" style={{ padding: '8px 0' }}>
                    {hiddenContacts} more contact{hiddenContacts === 1 ? '' : 's'} at this company {hiddenContacts === 1 ? 'is' : 'are'} owned
                    by other reps and not shown here.
                  </div>
                </div>
              )}
            </div>

            {activeEnrollments.length > 0 && (
              <div className="card">
                <div className="card-head"><h2>Active campaigns</h2></div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Contact</th><th>Campaign</th><th>Stage</th><th>Moves on</th></tr></thead>
                    <tbody>
                      {activeEnrollments.map((e) => (
                        <tr key={e.id}>
                          <td className="strong">{e.contact ? fullName(e.contact) : '—'}</td>
                          <td className="small">{e.campaignName}</td>
                          <td className="small"><Channel value={e.channel} /> {e.stageName}</td>
                          <td className="small faint nowrap">{relativeDate(e.dueAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h2 style={{ flex: 1 }}>Company timeline</h2>
                <span className="small faint">everything, across every contact here</span>
              </div>
              <div className="card-body">
                {activities.length === 0 ? (
                  <Empty icon="🕓" title="Nothing yet">Activity from anyone at this company lands here.</Empty>
                ) : (
                  <div className="timeline">
                    {activities.map((a) => (
                      <div className="tl-item" key={a._id}>
                        <span className={`tl-dot ${DOT_CLASS[a.type] || a.channel || ''}`} />
                        <div className="tl-title">{a.title}</div>
                        <div className="tl-meta">
                          {dateTime(a.createdAt)}
                          {a.contact && <> · <Link to={`/contacts/${a.contact._id}`}>{fullName(a.contact)}</Link></>}
                          {a.user?.name && <> · {a.user.name}</>}
                          {a.campaign?.name && <> · {a.campaign.name}</>}
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
              <div className="card-head"><h2>Details</h2></div>
              <div className="card-body" style={{ paddingTop: 8 }}>
                <Row label="Email domain">{company.domain ? <span className="mono small">{company.domain}</span> : null}</Row>
                <Row label="Website">
                  {company.website ? (
                    <a href={company.website.startsWith('http') ? company.website : `https://${company.website}`}
                      target="_blank" rel="noreferrer noopener" className="truncate">{company.website}</a>
                  ) : null}
                </Row>
                <Row label="Industry">{company.industry}</Row>
                <Row label="Company size">{company.employeeCount}</Row>
                <Row label="Main phone">{company.phone ? <a href={`tel:${company.phone}`}>{company.phone}</a> : null}</Row>
                <Row label="LinkedIn">
                  {company.linkedinUrl ? <a href={company.linkedinUrl} target="_blank" rel="noreferrer noopener">Open ↗</a> : null}
                </Row>
                <Row label="Location">{company.location}</Row>
                <Row label="Timezone">{company.timezone}</Row>
                <Row label="Address">{company.address}</Row>
                <Row label="Owner">{company.owner?.name}</Row>
                <Row label="Source">{company.source}</Row>
                <Row label="Tags">
                  {company.tags?.length ? (
                    <div className="row wrap" style={{ gap: 4 }}>
                      {company.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
                    </div>
                  ) : null}
                </Row>
                <Row label="Added">{dateTime(company.createdAt)}</Row>
              </div>
            </div>

            <div className="card">
              <div className="card-head"><h2>Qualification</h2></div>
              <div className="card-body" style={{ paddingTop: 8 }}>
                <Row label="Current provider">{company.currentProvider}</Row>
                <Row label="Seats needed">{company.seatsNeeded ?? null}</Row>
                <Row label="Target roles">{company.targetRoles}</Row>
                <Row label="Contract timing">{company.contractTiming}</Row>
                <Row label="Budget">{company.budgetRange}</Row>
                {!company.currentProvider && !company.seatsNeeded && !company.targetRoles && (
                  <div className="small faint">Nothing captured yet. Fill this in as you qualify.</div>
                )}
              </div>
            </div>

            {customFields?.length > 0 && customFields.some((f) => f.active !== false) && (
              <div className="card">
                <div className="card-head"><h2>Additional details</h2></div>
                <div className="card-body" style={{ paddingTop: 8 }}>
                  {customFields.filter((f) => f.active !== false).map((f) => (
                    <Row key={f.key} label={f.label}>
                      <CustomFieldValue field={f} value={company.customFields?.[f.key]} />
                    </Row>
                  ))}
                </div>
              </div>
            )}

            {company.description && (
              <div className="card">
                <div className="card-head"><h2>About</h2></div>
                <div className="card-body small" style={{ whiteSpace: 'pre-wrap' }}>{company.description}</div>
              </div>
            )}
            {company.notes && (
              <div className="card">
                <div className="card-head"><h2>Notes</h2></div>
                <div className="card-body small" style={{ whiteSpace: 'pre-wrap' }}>{company.notes}</div>
              </div>
            )}

            <div className="card">
              <div className="card-body">
                <Link className="btn btn-block btn-sm" to={`/contacts?company=${company._id}`}>
                  See these contacts in the table
                </Link>
                {isAdmin && (
                  <button className="btn btn-danger btn-block btn-sm" style={{ marginTop: 8 }}
                    onClick={() => setDialog('delete')}>
                    Delete company
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {dialog === 'edit' && (
        <Modal title="Edit company" width="wide" onClose={() => setDialog(null)}>
          <CompanyForm
            initial={company} submitLabel="Save changes" onCancel={() => setDialog(null)}
            onSubmit={async (values) => {
              await api.updateCompany(company._id, values)
              toast.success('Company updated')
              setDialog(null)
              load()
            }}
          />
        </Modal>
      )}

      {dialog === 'add-deal' && (
        <Modal title={`New deal for ${company.name}`} width="wide" onClose={() => setDialog(null)}>
          <DealForm
            lockCompany
            companyContacts={contacts}
            initial={{
              company: company._id, companyName: company.name,
              name: `${company.name} — ${company.targetRoles || 'outsourcing'}`,
            }}
            submitLabel="Create deal"
            onCancel={() => setDialog(null)}
            onSubmit={async (values) => {
              await api.createDeal({ ...values, company: company._id })
              toast.success('Deal created')
              setDialog(null)
              load()
            }}
          />
        </Modal>
      )}

      {dialog === 'add-contact' && (
        <Modal title={`New contact at ${company.name}`} width="wide" onClose={() => setDialog(null)}>
          <ContactForm
            lockCompany
            initial={{ company: company._id, companyName: company.name, timezone: company.timezone, location: company.location }}
            submitLabel="Create contact"
            onCancel={() => setDialog(null)}
            onSubmit={async (values) => {
              await api.createContact({ ...values, company: company._id })
              toast.success('Contact created')
              setDialog(null)
              load()
            }}
          />
        </Modal>
      )}

      {dialog === 'delete' && (
        <Confirm
          danger title="Delete this company" confirmLabel="Delete company"
          message={
            totalContacts > 0
              ? `${totalContacts} contact${totalContacts === 1 ? '' : 's'} belong to ${company.name}. They will be detached and kept — only the company record is deleted.`
              : `${company.name} will be deleted. This cannot be undone.`
          }
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteCompany(company._id, true)
            toast.success('Company deleted')
            navigate('/companies')
          }}
        />
      )}
    </>
  )
}
