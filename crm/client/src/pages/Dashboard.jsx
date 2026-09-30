import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { WIDGETS } from '../components/widgets.jsx'
import { Empty, Loading, Modal } from '../components/ui.jsx'

const SIZE_CLASS = { sm: 'dash-sm', md: 'dash-md', lg: 'dash-lg' }
const SIZE_LABEL = { sm: 'Narrow', md: 'Medium', lg: 'Wide' }

export default function Dashboard() {
  const { user, can } = useAuth()
  const isAdmin = can('settings.manage')
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.getDashboard())
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  if (loading) return <Loading />
  if (!data) return null

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Dashboard</h1>
          <div className="topbar-sub">
            {greeting}, {user.name.split(' ')[0]}
            {data.usingDefault && ' · showing the team default layout'}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={load}>Refresh</button>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>Customise</button>
      </div>

      <div className="page">
        {Object.keys(data.errors || {}).length > 0 && (
          <div className="banner banner-warn">
            <span>⚠</span>
            <div>
              {Object.keys(data.errors).length} widget{Object.keys(data.errors).length === 1 ? '' : 's'} could
              not load: {Object.entries(data.errors).map(([k, v]) => `${k} (${v})`).join(', ')}.
              The rest of the dashboard is unaffected.
            </div>
          </div>
        )}

        {data.layout.length === 0 ? (
          <div className="card">
            <Empty icon="▦" title="Your dashboard is empty"
              action={<button className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>Add some widgets</button>}>
              Pick from the widget library and arrange it however suits how you work.
            </Empty>
          </div>
        ) : (
          <div className="dash-grid">
            {data.layout.map((item) => {
              const meta = data.catalogue.find((c) => c.key === item.widget)
              const Widget = WIDGETS[item.widget]
              const widgetData = data.widgets[item.widget]
              if (!Widget) return null
              return (
                <div key={item.widget} className={`card ${SIZE_CLASS[item.size] || 'dash-md'}`}>
                  <div className="card-head">
                    <h2 style={{ flex: 1 }}>{meta?.name || item.widget}</h2>
                  </div>
                  <div className="card-body">
                    {data.errors?.[item.widget] ? (
                      <div className="small" style={{ color: 'var(--danger)' }}>
                        This widget failed to load: {data.errors[item.widget]}
                      </div>
                    ) : widgetData ? (
                      <Widget data={widgetData} />
                    ) : (
                      <div className="small faint">No data.</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {editing && (
        <CustomiseDialog
          layout={data.layout} catalogue={data.catalogue} isAdmin={isAdmin}
          usingDefault={data.usingDefault}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load() }}
        />
      )}
    </>
  )
}

function CustomiseDialog({ layout, catalogue, isAdmin, usingDefault, onClose, onSaved }) {
  const toast = useToast()
  const [items, setItems] = useState(layout.map((l) => ({ ...l })))
  const [busy, setBusy] = useState(false)

  const used = new Set(items.map((i) => i.widget))
  const available = catalogue.filter((c) => !used.has(c.key))

  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    setItems(next)
  }

  return (
    <Modal
      title="Customise your dashboard" width="wide" onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.resetDashboard()
                toast.success('Back to the team default')
                onSaved()
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            Reset to team default
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          {isAdmin && (
            <button className="btn" disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await api.saveDefaultDashboard(items)
                  await api.saveDashboard(items)
                  toast.success('Saved, and set as the default for new users')
                  onSaved()
                } catch (err) { toast.error(err.message) } finally { setBusy(false) }
              }}>
              Save &amp; set as team default
            </button>
          )}
          <button className="btn btn-primary" disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.saveDashboard(items)
                toast.success('Dashboard saved')
                onSaved()
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            Save
          </button>
        </>
      }
    >
      {usingDefault && (
        <div className="banner banner-info">
          <span>ℹ</span>
          <div>You are on the team default. Saving here makes it yours — changes to the default will not overwrite it.</div>
        </div>
      )}

      <h3 style={{ marginBottom: 8 }}>On your dashboard</h3>
      {items.length === 0 ? (
        <div className="small faint" style={{ marginBottom: 14 }}>Nothing yet — add something below.</div>
      ) : (
        <div className="col" style={{ gap: 6, marginBottom: 18 }}>
          {items.map((item, i) => {
            const meta = catalogue.find((c) => c.key === item.widget)
            return (
              <div className="card" key={item.widget} style={{ padding: '9px 12px' }}>
                <div className="row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="strong">{meta?.name || item.widget}</div>
                    <div className="small faint truncate">{meta?.description}</div>
                  </div>
                  <select className="select" style={{ maxWidth: 120 }} value={item.size}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))}>
                    {Object.entries(SIZE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn btn-ghost btn-sm" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="btn btn-ghost btn-sm"
                    onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <h3 style={{ marginBottom: 8 }}>Available widgets</h3>
      {available.length === 0 ? (
        <div className="small faint">Everything is already on your dashboard.</div>
      ) : (
        <div className="grid grid-2">
          {available.map((c) => (
            <button key={c.key} type="button" className="card"
              style={{ padding: '11px 13px', textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)' }}
              onClick={() => setItems([...items, { widget: c.key, size: c.defaultSize }])}>
              <div className="strong">+ {c.name}</div>
              <div className="small faint">{c.description}</div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
