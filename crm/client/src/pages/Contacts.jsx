import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, getToken } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import ContactForm from '../components/ContactForm.jsx'
import CompanyPicker from '../components/CompanyPicker.jsx'
import SavedViews from '../components/SavedViews.jsx'
import { Channel, Confirm, Empty, Loading, Modal, Pager, StatusPill } from '../components/ui.jsx'
import { fullName, relativeDate, num } from '../components/format.js'

export default function Contacts() {
  const { statuses, statusMap, users, isAdmin, can } = useAuth()
  const toast = useToast()
  const [params, setParams] = useSearchParams()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(new Set())
  const [campaigns, setCampaigns] = useState([])
  const [dialog, setDialog] = useState(null) // 'new' | 'enroll' | 'move' | 'bulk-status' | 'bulk-owner' | 'tag' | 'delete'

  const query = useMemo(() => ({
    q: params.get('q') || '',
    status: params.get('status') || '',
    owner: params.get('owner') || '',
    campaign: params.get('campaign') || '',
    tag: params.get('tag') || '',
    page: Number(params.get('page')) || 1,
    sort: params.get('sort') || 'lastActivityAt',
    dir: params.get('dir') || 'desc',
    limit: 50,
  }), [params])

  const setQuery = (patch) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v === null || v === undefined) next.delete(k)
      else next.set(k, String(v))
    }
    if (!('page' in patch)) next.delete('page')
    setParams(next)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.listContacts(query))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.listCampaigns({ active: 'true' }).then((d) => setCampaigns(d.campaigns)).catch(() => {})
  }, [])
  useEffect(() => { setSelected(new Set()) }, [query])

  const items = data?.items || []
  const allChecked = items.length > 0 && items.every((l) => selected.has(l._id))

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function bulk(action, value, message) {
    try {
      const res = await api.bulkContacts({ ids: [...selected], action, value })
      toast.success(`${message} — ${res.affected} contact${res.affected === 1 ? '' : 's'}`)
      setSelected(new Set())
      setDialog(null)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  function exportCsv() {
    // The export endpoint needs the bearer token, so fetch it and hand the
    // browser a blob rather than linking straight at the URL.
    fetch(`/api/contacts/export/csv${query.status ? `?status=${query.status}` : ''}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'contacts.csv'
        a.click()
        URL.revokeObjectURL(url)
      })
      .catch(() => toast.error('Export failed'))
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Contacts</h1>
          <div className="topbar-sub">{data ? `${num(data.total)} in view` : 'Loading…'}</div>
        </div>
        <div className="spacer" />
        {can('contacts.import') && <Link className="btn btn-sm" to="/contacts/import">Import contacts</Link>}
        {can('contacts.export') && <button className="btn btn-sm" onClick={exportCsv}>Export</button>}
        {can('contacts.edit') && (
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('new')}>+ New contact</button>
        )}
      </div>

      <div className="page">
        <SavedViews
          object="contact"
          activeViewId={params.get('view') || null}
          currentFilters={{ q: query.q, status: query.status, owner: query.owner, campaign: query.campaign, tag: query.tag }}
          currentSort={query.sort} currentDir={query.dir}
          onApply={(view) => {
            const next = new URLSearchParams()
            if (view) {
              for (const [k, v] of Object.entries(view.filters || {})) {
                if (v !== '' && v != null) next.set(k, String(v))
              }
              if (view.sort) next.set('sort', view.sort)
              if (view.dir) next.set('dir', view.dir)
              next.set('view', view._id)
            }
            setParams(next)
          }}
        />

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body tight">
            <div className="row wrap" style={{ padding: '6px 0' }}>
              <input
                className="input" style={{ maxWidth: 280 }} placeholder="Search name, company, email, phone…"
                defaultValue={query.q}
                onKeyDown={(e) => { if (e.key === 'Enter') setQuery({ q: e.target.value }) }}
              />
              <select className="select" style={{ maxWidth: 170 }} value={query.status}
                onChange={(e) => setQuery({ status: e.target.value })}>
                <option value="">All statuses</option>
                {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <select className="select" style={{ maxWidth: 200 }} value={query.campaign}
                onChange={(e) => setQuery({ campaign: e.target.value })}>
                <option value="">Any campaign</option>
                {campaigns.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
              </select>
              {can('contacts.viewAll') && (
                <select className="select" style={{ maxWidth: 170 }} value={query.owner}
                  onChange={(e) => setQuery({ owner: e.target.value })}>
                  <option value="">Any owner</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              )}
              {(query.q || query.status || query.campaign || query.owner || query.tag) && (
                <button className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams())}>
                  Clear filters
                </button>
              )}
            </div>
          </div>
        </div>

        {selected.size > 0 && (
          <div className="banner banner-info" style={{ alignItems: 'center' }}>
            <strong>{selected.size} selected</strong>
            <div className="row wrap" style={{ flex: 1 }}>
              {can('campaigns.enroll') && (
                <>
                  <button className="btn btn-sm" onClick={() => setDialog('enroll')}>Add to campaign</button>
                  <button className="btn btn-sm" onClick={() => setDialog('move')}>Move campaign</button>
                </>
              )}
              <button className="btn btn-sm" onClick={() => setDialog('bulk-status')}>Set status</button>
              {can('contacts.viewAll') && <button className="btn btn-sm" onClick={() => setDialog('bulk-owner')}>Reassign</button>}
              <button className="btn btn-sm" onClick={() => setDialog('tag')}>Tag</button>
              <button className="btn btn-sm" onClick={() => setDialog('set-company')}>Set company</button>
              {can('contacts.delete') && <button className="btn btn-sm btn-danger" onClick={() => setDialog('delete')}>Delete</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          </div>
        )}

        <div className="card">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty
              icon="👤" title="No contacts match"
              action={can('contacts.import')
                ? <Link className="btn btn-primary btn-sm" to="/contacts/import">Import a list</Link>
                : null}
            >
              {can('contacts.edit')
                ? 'Adjust the filters, add a contact by hand, or import a CSV.'
                : 'Adjust the filters — nothing here matches them right now.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="checkcol">
                      <input
                        type="checkbox" className="checkbox" checked={allChecked}
                        onChange={() =>
                          setSelected(allChecked ? new Set() : new Set(items.map((l) => l._id)))
                        }
                      />
                    </th>
                    <th>Name</th>
                    <th>Company</th>
                    <th>Status</th>
                    <th>Campaign / stage</th>
                    <th>Channels</th>
                    {can('contacts.viewAll') && <th>Owner</th>}
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((contact) => (
                    <tr key={contact._id} className={selected.has(contact._id) ? 'selected' : ''}>
                      <td className="checkcol">
                        <input type="checkbox" className="checkbox"
                          checked={selected.has(contact._id)} onChange={() => toggle(contact._id)} />
                      </td>
                      <td>
                        <Link to={`/contacts/${contact._id}`} className="strong">{fullName(contact)}</Link>
                        {contact.doNotContact && <span className="tag" style={{ marginLeft: 6, color: 'var(--danger)' }}>DNC</span>}
                        <div className="small faint truncate" style={{ maxWidth: 260 }}>
                          {contact.title || contact.email || '—'}
                        </div>
                      </td>
                      <td>
                        {contact.company ? (
                          <Link to={`/companies/${contact.company._id}`} className="truncate" style={{ display: 'block', maxWidth: 180 }}>
                            {contact.company.name}
                          </Link>
                        ) : (
                          <div className="truncate faint" style={{ maxWidth: 180 }}>{contact.companyName || '—'}</div>
                        )}
                        {contact.company?.seatsNeeded ? (
                          <div className="small faint">{contact.company.seatsNeeded} seats</div>
                        ) : null}
                      </td>
                      <td><StatusPill value={contact.status} statusMap={statusMap} /></td>
                      <td>
                        {contact.enrollments.length === 0 ? (
                          <span className="faint small">—</span>
                        ) : (
                          contact.enrollments.slice(0, 2).map((e) => (
                            <div key={e.id} className="small truncate" style={{ maxWidth: 220 }}>
                              <Link to={`/campaigns/${e.campaignId}`}>{e.campaignName}</Link>
                              <span className="faint"> · {e.stageName}</span>
                            </div>
                          ))
                        )}
                        {contact.enrollments.length > 2 && (
                          <div className="small faint">+{contact.enrollments.length - 2} more</div>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          {contact.linkedinUrl && <Channel value="linkedin" showLabel={false} />}
                          {contact.email && <Channel value="email" showLabel={false} />}
                          {contact.phone && <Channel value="call" showLabel={false} />}
                        </div>
                      </td>
                      {can('contacts.viewAll') && <td className="small">{contact.owner?.name || <span className="faint">—</span>}</td>}
                      <td className="small faint nowrap">{relativeDate(contact.lastActivityAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && (
            <div className="sticky-actions">
              <Pager page={data.page} pages={data.pages} total={data.total}
                onPage={(p) => setQuery({ page: p })} />
            </div>
          )}
        </div>
      </div>

      {dialog === 'new' && (
        <Modal title="New contact" width="wide" onClose={() => setDialog(null)}>
          <ContactForm
            submitLabel="Create contact"
            onCancel={() => setDialog(null)}
            onSubmit={async (values) => {
              await api.createContact(values)
              toast.success('Contact created')
              setDialog(null)
              load()
            }}
          />
        </Modal>
      )}

      {dialog === 'enroll' && (
        <CampaignPicker
          title={`Add ${selected.size} contact${selected.size === 1 ? '' : 's'} to a campaign`}
          campaigns={campaigns}
          confirmLabel="Add to campaign"
          note="Each contact enters at stage 1. A contact can run in several campaigns at once, so this does not remove them from anything they are already in."
          onClose={() => setDialog(null)}
          onConfirm={async (campaignId) => {
            const res = await api.enrollContacts(campaignId, [...selected])
            toast.success(`${res.enrolled} added${res.alreadyIn ? `, ${res.alreadyIn} already in it` : ''}`)
            setSelected(new Set())
            setDialog(null)
            load()
          }}
        />
      )}

      {dialog === 'move' && (
        <CampaignPicker
          title={`Move ${selected.size} contact${selected.size === 1 ? '' : 's'} to another campaign`}
          campaigns={campaigns}
          confirmLabel="Move contacts"
          danger
          note="This exits every campaign these contacts are currently in, cancels their pending tasks and queued emails, and enters them into the new campaign at stage 1. All history stays on the timeline."
          onClose={() => setDialog(null)}
          onConfirm={async (campaignId) => {
            const res = await api.moveContacts({ contactIds: [...selected], toCampaign: campaignId })
            toast.success(
              `${res.moved} moved · ${res.cancelledTasks} task${res.cancelledTasks === 1 ? '' : 's'} and ${res.cancelledMessages} draft${res.cancelledMessages === 1 ? '' : 's'} cancelled`
            )
            setSelected(new Set())
            setDialog(null)
            load()
          }}
        />
      )}

      {dialog === 'bulk-status' && (
        <PickOne
          title="Set status" options={statuses.map((s) => ({ value: s.value, label: s.label }))}
          onClose={() => setDialog(null)}
          onConfirm={(v) => bulk('status', v, 'Status updated')}
        />
      )}
      {dialog === 'bulk-owner' && (
        <PickOne
          title="Reassign owner" options={users.map((u) => ({ value: u.id, label: u.name }))}
          onClose={() => setDialog(null)}
          onConfirm={(v) => bulk('owner', v, 'Reassigned')}
        />
      )}
      {dialog === 'set-company' && (
        <SetCompanyDialog
          count={selected.size}
          onClose={() => setDialog(null)}
          onConfirm={(companyId) => bulk('company', companyId, 'Company set')}
        />
      )}
      {dialog === 'tag' && (
        <TagDialog
          onClose={() => setDialog(null)}
          onConfirm={(tag, remove) => bulk(remove ? 'removeTag' : 'addTag', tag, remove ? 'Tag removed' : 'Tag added')}
        />
      )}
      {dialog === 'delete' && (
        <Confirm
          danger title="Delete contacts" confirmLabel={`Delete ${selected.size}`}
          message={`This permanently removes ${selected.size} contact${selected.size === 1 ? '' : 's'} along with their timeline, tasks and queued emails. It cannot be undone.`}
          onClose={() => setDialog(null)}
          onConfirm={() => bulk('delete', null, 'Deleted')}
        />
      )}
    </>
  )
}

function CampaignPicker({ title, campaigns, note, confirmLabel, danger, onConfirm, onClose }) {
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  // Only campaigns that have stages and that this person is allowed to use.
  const usable = campaigns.filter((c) => (c.stages || []).length > 0 && c.canEnroll !== false)

  return (
    <Modal
      title={title} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={!id || busy}
            onClick={async () => {
              setBusy(true)
              try { await onConfirm(id) } catch (e) { toast.error(e.message) } finally { setBusy(false) }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {usable.length === 0 ? (
        <Empty icon="⚑" title="No usable campaigns">
          There is no active campaign with at least one stage that you are allowed to use.
          Create one, or ask an admin to give you access under Settings → Users.
        </Empty>
      ) : (
        <>
          <div className="field">
            <label className="label">Campaign</label>
            <select className="select" value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose…</option>
              {usable.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name} ({c.stages.length} stage{c.stages.length === 1 ? '' : 's'}{(c.channels || []).length ? `, ${c.channels.join(' + ')}` : ''})
                </option>
              ))}
            </select>
          </div>
          <div className="hint">{note}</div>
        </>
      )}
    </Modal>
  )
}

function PickOne({ title, options, onConfirm, onClose }) {
  const [value, setValue] = useState('')
  return (
    <Modal
      title={title} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!value} onClick={() => onConfirm(value)}>Apply</button>
        </>
      }
    >
      <select className="select" value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Modal>
  )
}

function SetCompanyDialog({ count, onConfirm, onClose }) {
  const [picked, setPicked] = useState({ company: '', companyName: '' })
  return (
    <Modal
      title={`Set the company for ${count} contact${count === 1 ? '' : 's'}`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked.company} onClick={() => onConfirm(picked.company)}>
            Set company
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Company</label>
        <CompanyPicker value={picked.company} name={picked.companyName} onChange={setPicked} autoFocus />
      </div>
      <div className="hint">
        Pick an existing company from the list — a bulk move needs an exact match, so free text is not
        enough here.
      </div>
    </Modal>
  )
}

function TagDialog({ onConfirm, onClose }) {
  const [tag, setTag] = useState('')
  const [remove, setRemove] = useState(false)
  return (
    <Modal
      title="Tag contacts" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!tag.trim()} onClick={() => onConfirm(tag.trim(), remove)}>
            {remove ? 'Remove tag' : 'Add tag'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Tag</label>
        <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} autoFocus />
      </div>
      <label className="row small">
        <input type="checkbox" className="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
        Remove this tag instead of adding it
      </label>
    </Modal>
  )
}
