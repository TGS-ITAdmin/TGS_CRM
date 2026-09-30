import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import QuoteStatus, { QUOTE_STATUS_META } from '../components/QuoteStatus.jsx'
import { Empty, Loading, Pager } from '../components/ui.jsx'
import { money, relativeDate, shortDate, num } from '../components/format.js'

const FILTERS = [
  { key: '', label: 'Live' },
  { key: 'pending_approval', label: 'Needs approval' },
  { key: 'draft', label: 'Drafts' },
  { key: 'sent', label: 'Sent' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'declined,expired', label: 'Lost / expired' },
]

export default function Quotes() {
  const { can, users, reportingCurrency } = useAuth()
  const isAdmin = can('quotes.approve')
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const query = useMemo(() => ({
    status: params.get('status') || '',
    owner: params.get('owner') || '',
    page: Number(params.get('page')) || 1,
    limit: 50,
  }), [params])

  const setQuery = (patch) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k)
      else next.set(k, String(v))
    }
    if (!('page' in patch)) next.delete('page')
    setParams(next)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.listQuotes(query))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const items = data?.items || []
  const pending = data?.pendingApprovalCount || 0

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Quotes</h1>
          <div className="topbar-sub">
            Build from the rate card, get it approved, share the link. You send it — the CRM does not.
          </div>
        </div>
        <div className="spacer" />
        {isAdmin && (
          <select className="select" style={{ maxWidth: 170 }} value={query.owner}
            onChange={(e) => setQuery({ owner: e.target.value })}>
            <option value="">All owners</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
      </div>

      <div className="page">
        {pending > 0 && (
          <div className="banner banner-warn">
            <span>⏳</span>
            <div style={{ flex: 1 }}>
              <strong>{pending} quote{pending === 1 ? '' : 's'} waiting for approval.</strong>{' '}
              {isAdmin ? 'Nothing can be shared with a client until you clear them.' : 'An admin has to clear them before you can share them.'}
            </div>
            {query.status !== 'pending_approval' && (
              <button className="btn btn-sm" onClick={() => setQuery({ status: 'pending_approval' })}>Show them</button>
            )}
          </div>
        )}

        <div className="tabs">
          {FILTERS.map((f) => (
            <button key={f.key || 'live'} className={`tab${query.status === f.key ? ' active' : ''}`}
              onClick={() => setQuery({ status: f.key })}>
              {f.label}
              {f.key === 'pending_approval' && pending > 0 && (
                <span className="nav-badge" style={{ marginLeft: 6 }}>{pending}</span>
              )}
            </button>
          ))}
        </div>

        <div className="card">
          {loading ? <Loading /> : items.length === 0 ? (
            <Empty icon="📄" title="No quotes here">
              Quotes are built from a deal — open one and click <strong>New quote</strong>.{' '}
              <Link to="/deals">Go to deals →</Link>
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Quote</th><th>Company</th><th>Status</th>
                    <th className="right">Value</th><th>Valid until</th>
                    <th>Client opened</th><th>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((q) => {
                    const expiringSoon = q.status === 'sent' && q.validUntil &&
                      new Date(q.validUntil) - Date.now() < 7 * 86400000
                    return (
                      <tr key={q._id}>
                        <td>
                          <Link to={`/quotes/${q._id}`} className="strong">{q.number}</Link>
                          {q.version > 1 && <span className="faint small"> v{q.version}</span>}
                          <div className="small faint truncate" style={{ maxWidth: 240 }}>
                            {q.title || q.deal?.name || '—'}
                          </div>
                        </td>
                        <td className="small">
                          {q.company ? <Link to={`/companies/${q.company._id}`}>{q.company.name}</Link> : '—'}
                        </td>
                        <td>
                          <QuoteStatus status={q.status} />
                          {q.status === 'pending_approval' && q.approvalReasons?.length > 0 && (
                            <div className="small faint truncate" style={{ maxWidth: 180 }}>
                              {q.approvalReasons.map((r) => r.label).join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="right strong">{money(q.tcv, q.currency, { compact: true })}</td>
                        <td className="small nowrap" style={{ color: expiringSoon ? 'var(--warn)' : 'var(--text-faint)' }}>
                          {q.validUntil ? shortDate(q.validUntil) : '—'}
                          {expiringSoon && <div style={{ fontSize: 11 }}>expiring soon</div>}
                        </td>
                        <td className="small faint nowrap">
                          {q.firstViewedAt ? relativeDate(q.firstViewedAt)
                            : ['sent', 'approved'].includes(q.status) ? <span style={{ color: 'var(--warn)' }}>not yet</span> : '—'}
                        </td>
                        <td className="small">{q.owner?.name || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data && (
            <div className="sticky-actions">
              <Pager page={data.page} pages={data.pages} total={data.total} onPage={(p) => setQuery({ page: p })} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}
