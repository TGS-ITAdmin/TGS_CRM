import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useToast } from './Toast.jsx'
import { Confirm, Field, Modal } from './ui.jsx'

/* A tab strip of saved filter sets above a list page.
 *
 * Sharing and pinning are separate: sharing makes a view available to the
 * team, pinning puts it in *your* strip. Someone tidying their own tabs never
 * rearranges a colleague's.
 */
export default function SavedViews({ object, currentFilters, currentSort, currentDir, onApply, activeViewId }) {
  const toast = useToast()
  const [views, setViews] = useState([])
  const [dialog, setDialog] = useState(null)
  const [managing, setManaging] = useState(false)

  const load = useCallback(async () => {
    try {
      const { views } = await api.listViews(object)
      setViews(views)
    } catch { /* a missing view strip should not break the page under it */ }
  }, [object])

  useEffect(() => { load() }, [load])

  const pinned = views.filter((v) => v.pinned)
  // A filter set worth saving is one that actually filters something.
  const hasFilters = Object.values(currentFilters || {}).some((v) => v !== '' && v != null)

  async function act(fn, message) {
    try {
      await fn()
      if (message) toast.success(message)
      await load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12, alignItems: 'center' }}>
        <button
          className={`tab${!activeViewId ? ' active' : ''}`}
          style={{ borderBottom: 0, padding: '5px 11px', borderRadius: 'var(--radius-sm)' }}
          onClick={() => onApply(null)}
        >
          All
        </button>
        {pinned.map((v) => (
          <button
            key={v._id}
            className={`tab${activeViewId === v._id ? ' active' : ''}`}
            style={{ borderBottom: 0, padding: '5px 11px', borderRadius: 'var(--radius-sm)' }}
            title={v.description || (v.shared && !v.mine ? `Shared by ${v.owner?.name}` : '')}
            onClick={() => onApply(v)}
          >
            {v.name}
            {v.shared && <span className="faint" style={{ marginLeft: 5, fontSize: 11 }}>shared</span>}
          </button>
        ))}

        <div className="spacer" />
        {hasFilters && (
          <button className="btn btn-sm" onClick={() => setDialog('save')}>Save this view</button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>
          Manage views{views.length ? ` (${views.length})` : ''}
        </button>
      </div>

      {dialog === 'save' && (
        <SaveViewDialog
          object={object} filters={currentFilters} sort={currentSort} dir={currentDir}
          onClose={() => setDialog(null)}
          onSaved={(view) => { setDialog(null); load(); onApply(view) }}
        />
      )}

      {managing && (
        <ManageViewsDialog
          views={views} onClose={() => setManaging(false)}
          onChanged={load} onApply={(v) => { setManaging(false); onApply(v) }}
          act={act}
        />
      )}
    </>
  )
}

function describeFilters(filters) {
  const parts = Object.entries(filters || {})
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}: ${v}`)
  return parts.length ? parts.join(' · ') : 'no filters'
}

function SaveViewDialog({ object, filters, sort, dir, onClose, onSaved }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [shared, setShared] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      title="Save this view" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                const { view } = await api.createView({
                  object, name, description, filters, sort, dir, shared,
                })
                toast.success('View saved and pinned')
                onSaved(view)
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            Save view
          </button>
        </>
      }
    >
      <Field label="Name" hint="What you would call it out loud — 'Untouched 14+ days', not 'View 3'.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Description" hint="Optional. Useful if you share it.">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="banner banner-info">
        <span>ℹ</span>
        <div>
          Saving these filters: <strong>{describeFilters(filters)}</strong>
          {sort && <> · sorted by {sort} {dir}</>}
        </div>
      </div>
      <label className="row small">
        <input type="checkbox" className="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        Share with the team
      </label>
      <div className="hint">
        Sharing makes it available to everyone. It only appears in their tabs if they pin it themselves.
      </div>
    </Modal>
  )
}

function ManageViewsDialog({ views, onClose, onChanged, onApply, act }) {
  const [deleting, setDeleting] = useState(null)

  return (
    <>
      <Modal title="Saved views" width="wide" onClose={onClose}
        footer={<button className="btn" onClick={onClose}>Done</button>}>
        {views.length === 0 ? (
          <div className="small muted">
            Nothing saved yet. Filter a list the way you like it, then click <strong>Save this view</strong>.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>View</th><th>Filters</th><th>Owner</th><th className="center">Pinned</th><th /></tr>
              </thead>
              <tbody>
                {views.map((v) => (
                  <tr key={v._id}>
                    <td>
                      <button className="btn btn-ghost btn-sm strong" style={{ padding: 0 }}
                        onClick={() => onApply(v)}>
                        {v.name}
                      </button>
                      {v.shared && <span className="tag" style={{ marginLeft: 6 }}>shared</span>}
                      {v.description && <div className="small faint">{v.description}</div>}
                    </td>
                    <td className="small faint truncate" style={{ maxWidth: 240 }}>{describeFilters(v.filters)}</td>
                    <td className="small">{v.mine ? 'You' : v.owner?.name || '—'}</td>
                    <td className="center">
                      <input type="checkbox" className="checkbox" checked={v.pinned}
                        onChange={(e) => act(() => api.pinView(v._id, e.target.checked), null).then(onChanged)} />
                    </td>
                    <td className="right nowrap">
                      {!v.mine && (
                        <button className="btn btn-sm"
                          onClick={() => act(() => api.duplicateView(v._id), 'Copied to your views').then(onChanged)}>
                          Copy
                        </button>
                      )}
                      {v.canEdit && (
                        <>
                          <button className="btn btn-ghost btn-sm"
                            onClick={() => act(() => api.updateView(v._id, { shared: !v.shared }),
                              v.shared ? 'No longer shared' : 'Shared with the team').then(onChanged)}>
                            {v.shared ? 'Unshare' : 'Share'}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(v)}>✕</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {deleting && (
        <Confirm
          danger title={`Delete "${deleting.name}"`} confirmLabel="Delete view"
          message={deleting.shared
            ? 'This view is shared. Deleting it removes it from anyone who pinned it.'
            : 'The view is removed. The records it filtered are untouched.'}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await act(() => api.deleteView(deleting._id, true), 'View deleted')
            setDeleting(null)
            onChanged()
          }}
        />
      )}
    </>
  )
}
