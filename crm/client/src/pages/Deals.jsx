import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import DealForm from '../components/DealForm.jsx'
import SavedViews from '../components/SavedViews.jsx'
import { Empty, Loading, Modal, Pager } from '../components/ui.jsx'
import { money, relativeDate, daysSince, num } from '../components/format.js'

function StagePill({ stage, stageMap }) {
  const meta = stageMap?.get(stage)
  const color = meta?.color || '#64748b'
  return (
    <span className="pill" style={{ color, borderColor: `${color}55` }}>
      <span className="pill-dot" />{meta?.name || stage}
    </span>
  )
}

export default function Deals() {
  const { stageMap, dealStages, users, can, reportingCurrency, forecastCategories, lostReasons } = useAuth()
  const isAdmin = can('deals.viewAll')
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const view = params.get('view') || 'board'

  const [board, setBoard] = useState(null)
  const [table, setTable] = useState(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [closing, setClosing] = useState(null)

  const owner = params.get('owner') || ''
  const page = Number(params.get('page')) || 1

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
      if (view === 'board') setBoard(await api.dealBoard({ owner: owner || undefined }))
      else setTable(await api.listDeals({ owner: owner || undefined, page, limit: 50, includeClosed: 'true' }))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [view, owner, page]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  async function moveTo(deal, stageKey) {
    const stage = stageMap.get(stageKey)
    // Losing needs a reason, so it goes through a dialog rather than a bare move.
    if (stage?.type === 'lost') { setClosing({ deal, stage }); return }
    try {
      await api.setDealStage(deal._id, { stage: stageKey })
      toast.success(stage?.type === 'won' ? `Won — ${deal.name}` : `Moved to ${stage?.name}`)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Deals</h1>
          <div className="topbar-sub">
            Everyone sees every deal; only the owner edits · values shown in {reportingCurrency}
          </div>
        </div>
        <div className="spacer" />
        <div className="tabs" style={{ border: 0, margin: 0 }}>
          <button className={`tab${view === 'board' ? ' active' : ''}`} onClick={() => setQuery({ view: 'board' })}>Board</button>
          <button className={`tab${view === 'table' ? ' active' : ''}`} onClick={() => setQuery({ view: 'table' })}>Table</button>
        </div>
        {isAdmin && (
          <select className="select" style={{ maxWidth: 170 }} value={owner} onChange={(e) => setQuery({ owner: e.target.value })}>
            <option value="">All owners</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ New deal</button>
      </div>

      <div className="page">
        <SavedViews
          object="deal"
          activeViewId={params.get('savedView') || null}
          currentFilters={{ owner, view }}
          currentSort="expectedCloseDate" currentDir="asc"
          onApply={(saved) => {
            const next = new URLSearchParams()
            if (saved) {
              for (const [k, v] of Object.entries(saved.filters || {})) {
                if (v !== '' && v != null) next.set(k, String(v))
              }
              next.set('savedView', saved._id)
            }
            setParams(next)
          }}
        />

        {loading ? <Loading /> : view === 'board' ? (
          <BoardView board={board} stageMap={stageMap} onMove={moveTo} reportingCurrency={reportingCurrency} onNew={() => setCreating(true)} />
        ) : (
          <TableView data={table} stageMap={stageMap} reportingCurrency={reportingCurrency}
            onPage={(p) => setQuery({ page: p })} onNew={() => setCreating(true)} />
        )}
      </div>

      {creating && (
        <Modal title="New deal" width="wide" onClose={() => setCreating(false)}>
          <DealForm
            submitLabel="Create deal"
            onCancel={() => setCreating(false)}
            onSubmit={async (values) => {
              await api.createDeal(values)
              toast.success('Deal created')
              setCreating(false)
              load()
            }}
          />
        </Modal>
      )}

      {closing && (
        <CloseLostDialog
          deal={closing.deal} stage={closing.stage} lostReasons={lostReasons}
          onClose={() => setClosing(null)}
          onDone={() => { setClosing(null); load() }}
        />
      )}
    </>
  )
}

function BoardView({ board, stageMap, onMove, reportingCurrency, onNew }) {
  if (!board) return null
  const anyDeals = board.columns.some((c) => c.cards.length)
  if (!anyDeals) {
    return (
      <div className="card">
        <Empty icon="💼" title="No deals yet" action={<button className="btn btn-primary btn-sm" onClick={onNew}>Create the first deal</button>}>
          A deal is created automatically when you log a booked meeting, or you can add one by hand.
        </Empty>
      </div>
    )
  }

  return (
    <>
      {board.truncated && (
        <div className="banner banner-warn">
          <span>⚠</span><div>More than 2,000 open deals — showing the 2,000 closing soonest. Use the table view for the rest.</div>
        </div>
      )}
      <div className="board">
        {board.columns.map((col) => (
          <div className="board-col" key={col.key}>
            <div className="board-col-head">
              <div className="row" style={{ marginBottom: 4 }}>
                <span className="pill-dot" style={{ background: col.color }} />
                <span className="strong truncate" style={{ flex: 1 }}>{col.name}</span>
                <span className="queue-count">{col.cards.length}</span>
              </div>
              <div className="small faint">
                {money(col.tcvUsd, reportingCurrency, { compact: true })}
                {col.type === 'open' && <> · {money(col.weightedUsd, reportingCurrency, { compact: true })} weighted</>}
              </div>
            </div>
            <div className="board-col-body">
              {col.cards.length === 0 && (
                <div className="small faint center" style={{ padding: '18px 8px' }}>Empty</div>
              )}
              {col.cards.map((deal) => (
                <DealCard key={deal._id} deal={deal} currentStage={col.key} stageMap={stageMap}
                  onMove={onMove} reportingCurrency={reportingCurrency} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function DealCard({ deal, currentStage, stageMap, onMove, reportingCurrency }) {
  const age = daysSince(deal.stageEnteredAt)
  const stale = age !== null && age > 30
  return (
    <div className="board-card">
      <div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="board-card-name truncate">
            <Link to={`/deals/${deal._id}`}>{deal.name}</Link>
          </div>
          <div className="small faint truncate">{deal.company?.name || '—'}</div>
        </div>
        <StageMenu currentStage={currentStage} stageMap={stageMap} onMove={(k) => onMove(deal, k)} />
      </div>
      <div className="row" style={{ marginTop: 6, gap: 6 }}>
        <span className="strong">{money(deal.tcvUsd, reportingCurrency, { compact: true })}</span>
        {deal.mrrUsd > 0 && <span className="small faint">{money(deal.mrrUsd, reportingCurrency, { compact: true })}/mo</span>}
      </div>
      <div className="row small" style={{ marginTop: 5, gap: 6 }}>
        <span className="faint">{deal.probability}%</span>
        {deal.forecastCategory === 'commit' && <span className="tag" style={{ color: 'var(--ok)' }}>Commit</span>}
        {deal.forecastCategory === 'omitted' && <span className="tag">Omitted</span>}
        <span className="spacer" />
        <span style={{ color: stale ? 'var(--warn)' : 'var(--text-faint)' }}>
          {age === 0 ? 'today' : `${age}d here`}
        </span>
      </div>
      {deal.expectedCloseDate && (
        <div className="small faint" style={{ marginTop: 3 }}>closes {relativeDate(deal.expectedCloseDate)}</div>
      )}
    </div>
  )
}

/* Same portal approach as the campaign board: a popover inside a scrolling
 * column gets clipped, and drag alone is not a usable primary control. */
function StageMenu({ currentStage, stageMap, onMove }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btn = useRef(null)
  const menu = useRef(null)
  const stages = [...stageMap.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  useEffect(() => {
    if (!open || !btn.current) return
    const place = () => {
      const r = btn.current.getBoundingClientRect()
      const width = 230
      const height = 60 + stages.length * 32
      setPos({
        left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
        top: r.bottom + height > window.innerHeight - 8 ? Math.max(8, r.top - height) : r.bottom + 4,
        width,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, stages.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (menu.current?.contains(e.target) || btn.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button ref={btn} className="btn btn-ghost btn-sm" aria-label="Move this deal" aria-expanded={open}
        style={{ padding: '0 6px', lineHeight: 1.4, flex: '0 0 auto' }}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>⋯</button>
      {open && pos && createPortal(
        <div ref={menu} className="card"
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex: 90,
            boxShadow: 'var(--shadow-lg)', padding: 5, maxHeight: '60vh', overflowY: 'auto' }}>
          <div className="nav-group-label" style={{ padding: '5px 8px 3px' }}>Move to stage</div>
          {stages.map((s) => (
            <button key={s.key} className="nav-item" disabled={s.key === currentStage}
              style={{ width: '100%', textAlign: 'left', border: 0, background: 'none', font: 'inherit',
                fontSize: 12.5, cursor: s.key === currentStage ? 'default' : 'pointer',
                opacity: s.key === currentStage ? 0.45 : 1 }}
              onClick={() => { setOpen(false); if (s.key !== currentStage) onMove(s.key) }}>
              <span className="pill-dot" style={{ background: s.color }} />
              <span className="truncate" style={{ flex: 1 }}>{s.name}</span>
              <span className="small faint">{s.probability}%</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

function TableView({ data, stageMap, reportingCurrency, onPage, onNew }) {
  if (!data) return null
  if (!data.items.length) {
    return (
      <div className="card">
        <Empty icon="💼" title="No deals" action={<button className="btn btn-primary btn-sm" onClick={onNew}>Create a deal</button>} />
      </div>
    )
  }
  return (
    <>
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-label">Total value</div>
          <div className="stat-value">{money(data.totals.tcvUsd, reportingCurrency, { compact: true })}</div>
          <div className="stat-sub">across {num(data.total)} deals</div>
        </div>
        <div className="stat">
          <div className="stat-label">Weighted</div>
          <div className="stat-value">{money(data.totals.weightedUsd, reportingCurrency, { compact: true })}</div>
          <div className="stat-sub">open deals × probability</div>
        </div>
        <div className="stat">
          <div className="stat-label">Monthly recurring</div>
          <div className="stat-value">{money(data.totals.mrrUsd, reportingCurrency, { compact: true })}</div>
          <div className="stat-sub">MRR if everything lands</div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Deal</th><th>Company</th><th>Stage</th><th className="right">Value</th>
                <th className="right">MRR</th><th className="right">Prob.</th><th>Forecast</th>
                <th>Close date</th><th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((d) => (
                <tr key={d._id}>
                  <td>
                    <Link to={`/deals/${d._id}`} className="strong">{d.name}</Link>
                    {d.status !== 'open' && (
                      <span className="tag" style={{ marginLeft: 6, color: d.status === 'won' ? 'var(--ok)' : 'var(--danger)' }}>
                        {d.status}
                      </span>
                    )}
                  </td>
                  <td className="small">
                    {d.company ? <Link to={`/companies/${d.company._id}`}>{d.company.name}</Link> : '—'}
                  </td>
                  <td><StagePill stage={d.stage} stageMap={stageMap} /></td>
                  <td className="right strong">{money(d.tcvUsd, reportingCurrency, { compact: true })}</td>
                  <td className="right small">{d.mrrUsd ? money(d.mrrUsd, reportingCurrency, { compact: true }) : '—'}</td>
                  <td className="right small">{d.probability}%</td>
                  <td className="small">{d.forecastCategory.replace('_', ' ')}</td>
                  <td className="small faint nowrap">{d.expectedCloseDate ? relativeDate(d.expectedCloseDate) : <span style={{ color: 'var(--warn)' }}>no date</span>}</td>
                  <td className="small">{d.owner?.name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sticky-actions">
          <Pager page={data.page} pages={data.pages} total={data.total} onPage={onPage} />
        </div>
      </div>
    </>
  )
}

export function CloseLostDialog({ deal, stage, lostReasons, onClose, onDone }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      title={`Mark "${deal.name}" as lost`} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" disabled={busy || !reason}
            onClick={async () => {
              setBusy(true)
              try {
                await api.setDealStage(deal._id, { stage: stage.key, lostReason: reason, closedNotes: notes })
                toast.success('Deal marked lost')
                onDone()
              } catch (err) {
                toast.error(err.message)
              } finally {
                setBusy(false)
              }
            }}>
            {busy ? 'Saving…' : 'Mark lost'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="label">Why was it lost?</label>
        <select className="select" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus>
          <option value="">Pick a reason…</option>
          {lostReasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="hint">
          Required. A loss with no reason tells you nothing later — this is the whole content of the
          lost-deal report.
        </div>
      </div>
      <div className="field">
        <label className="label">Anything worth remembering</label>
        <textarea className="textarea" style={{ minHeight: 80 }} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Who they went with, what the blocker was, when to try again…" />
      </div>
    </Modal>
  )
}
