import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import CompanyForm from '../components/CompanyForm.jsx'
import SavedViews from '../components/SavedViews.jsx'
import { Confirm, Empty, Loading, Modal, Pager } from '../components/ui.jsx'
import { relativeDate, num } from '../components/format.js'

export default function Companies() {
  const { users, isAdmin, can } = useAuth()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  // Row actions: the company being edited (full record) or deleted (list row).
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)

  const canEdit = can('contacts.edit')
  const canDelete = can('contacts.delete')
  const showActions = canEdit || canDelete

  // The list row is a summary, so the edit form loads the whole record first.
  async function openEdit(id) {
    try {
      const data = await api.getCompany(id)
      setEditing(data.company)
    } catch (err) {
      toast.error(err.message)
    }
  }

  const query = useMemo(() => ({
    q: params.get('q') || '',
    industry: params.get('industry') || '',
    owner: params.get('owner') || '',
    page: Number(params.get('page')) || 1,
    sort: params.get('sort') || 'lastActivityAt',
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
      setData(await api.listCompanies(query))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const items = data?.items || []

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Companies</h1>
          <div className="topbar-sub">
            {data ? `${num(data.total)} in view` : 'Loading…'} · everyone can see every company
          </div>
        </div>
        <div className="spacer" />
        {can('contacts.edit') && (
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ New company</button>
        )}
      </div>

      <div className="page">
        <SavedViews
          object="company"
          activeViewId={params.get('view') || null}
          currentFilters={{ q: query.q, industry: query.industry, owner: query.owner }}
          currentSort={query.sort} currentDir="desc"
          onApply={(view) => {
            const next = new URLSearchParams()
            if (view) {
              for (const [k, v] of Object.entries(view.filters || {})) {
                if (v !== '' && v != null) next.set(k, String(v))
              }
              if (view.sort) next.set('sort', view.sort)
              next.set('view', view._id)
            }
            setParams(next)
          }}
        />

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body tight">
            <div className="row wrap" style={{ padding: '6px 0' }}>
              <input
                className="input" style={{ maxWidth: 300 }} placeholder="Search name, domain, industry…"
                defaultValue={query.q}
                onKeyDown={(e) => { if (e.key === 'Enter') setQuery({ q: e.target.value }) }}
              />
              <select className="select" style={{ maxWidth: 190 }} value={query.sort}
                onChange={(e) => setQuery({ sort: e.target.value })}>
                <option value="lastActivityAt">Recently active</option>
                <option value="name">Name A–Z</option>
                <option value="seatsNeeded">Seats needed</option>
                <option value="createdAt">Newest</option>
              </select>
              {can('contacts.viewAll') && (
                <select className="select" style={{ maxWidth: 180 }} value={query.owner}
                  onChange={(e) => setQuery({ owner: e.target.value })}>
                  <option value="">Any owner</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              )}
              {(query.q || query.owner || query.industry) && (
                <button className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams())}>Clear</button>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty
              icon="🏢" title="No companies match"
              action={<button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>Add a company</button>}
            >
              Companies are created automatically when you add or import a contact with a work email.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Company</th><th>Industry</th><th className="right">Contacts</th>
                    <th className="right">Seats</th><th>Target roles</th><th>Owner</th>
                    <th>Last activity</th>
                    {showActions && <th className="right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c._id}>
                      <td>
                        <Link to={`/companies/${c._id}`} className="strong">{c.name}</Link>
                        <div className="small faint truncate" style={{ maxWidth: 240 }}>
                          {c.domain || c.website || '—'}
                        </div>
                      </td>
                      <td className="small">{c.industry || <span className="faint">—</span>}</td>
                      <td className="right">{num(c.contactCount)}</td>
                      <td className="right">{c.seatsNeeded ?? <span className="faint">—</span>}</td>
                      <td className="small truncate" style={{ maxWidth: 200 }}>{c.targetRoles || <span className="faint">—</span>}</td>
                      <td className="small">{c.owner?.name || <span className="faint">—</span>}</td>
                      <td className="small faint nowrap">{relativeDate(c.lastActivityAt)}</td>
                      {showActions && (
                        <td className="right nowrap">
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            {canEdit && (
                              <button className="btn btn-sm" title={`Edit ${c.name}`}
                                onClick={() => openEdit(c._id)}>
                                Edit
                              </button>
                            )}
                            {canDelete && (
                              <button className="btn btn-danger btn-sm" title={`Delete ${c.name}`}
                                onClick={() => setDeleting(c)}>
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
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

      {creating && (
        <Modal title="New company" width="wide" onClose={() => setCreating(false)}>
          <CompanyForm
            submitLabel="Create company"
            onCancel={() => setCreating(false)}
            onSubmit={async (values) => {
              await api.createCompany(values)
              toast.success('Company created')
              setCreating(false)
              load()
            }}
          />
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit ${editing.name}`} width="wide" onClose={() => setEditing(null)}>
          <CompanyForm
            initial={editing} submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={async (values) => {
              await api.updateCompany(editing._id, values)
              toast.success('Company updated')
              setEditing(null)
              load()
            }}
          />
        </Modal>
      )}

      {deleting && (
        <Confirm
          danger title="Delete this company" confirmLabel="Delete company"
          message={
            deleting.contactCount > 0
              ? `${deleting.contactCount} contact${deleting.contactCount === 1 ? '' : 's'} belong to ${deleting.name}. They will be detached and kept — only the company record is deleted. This cannot be undone.`
              : `${deleting.name} will be deleted. This cannot be undone.`
          }
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteCompany(deleting._id, true)
              toast.success('Company deleted')
              setDeleting(null)
              load()
            } catch (err) {
              // e.g. the company still has deals — the server explains why.
              toast.error(err.message)
            }
          }}
        />
      )}
    </>
  )
}
