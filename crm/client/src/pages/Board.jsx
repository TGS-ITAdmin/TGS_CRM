import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Channel, Empty, Loading, StatusPill } from '../components/ui.jsx'
import { fullName, companyName, dueLabel } from '../components/format.js'

/* Kanban view of one campaign. Dragging a card jumps that contact to the stage
 * you drop it on — the pending task or draft for the stage they leave is
 * cancelled and a fresh one is generated for where they land. */
export default function Board() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { statusMap, user } = useAuth()
  const toast = useToast()

  const [campaigns, setCampaigns] = useState([])
  const [board, setBoard] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dragging, setDragging] = useState(null)
  const [dropCol, setDropCol] = useState(null)

  useEffect(() => {
    api.listCampaigns({ active: 'true' })
      .then(({ campaigns }) => {
        setCampaigns(campaigns)
        const usable = campaigns.filter((c) => c.stages.length > 0)
        if (!id && usable.length) navigate(`/board/${usable[0]._id}`, { replace: true })
        if (!usable.length) setLoading(false)
      })
      .catch((e) => { toast.error(e.message); setLoading(false) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      setBoard(await api.getBoard(id))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  async function move(enrollmentId, columnIndex) {
    try {
      await api.setEnrollmentStage(enrollmentId, columnIndex)
      toast.success(`Moved to ${board.columns[columnIndex].name}`)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function remove(enrollmentId, name) {
    try {
      await api.exitEnrollment(enrollmentId, 'Removed from the board')
      toast.success(`${name} removed from this campaign`)
      load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function drop(columnIndex) {
    setDropCol(null)
    if (!dragging || dragging.fromIndex === columnIndex) { setDragging(null); return }
    const card = dragging
    setDragging(null)
    await move(card.enrollmentId, columnIndex)
  }

  const usable = campaigns.filter((c) => c.stages.length > 0)

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Board</h1>
          <div className="topbar-sub">Use a card's ⋯ menu to move a contact, or drag it onto another stage</div>
        </div>
        <div className="spacer" />
        <select
          className="select" style={{ maxWidth: 260 }} value={id || ''}
          onChange={(e) => navigate(`/board/${e.target.value}`)}
        >
          <option value="">Choose a campaign…</option>
          {usable.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
        </select>
        <button className="btn btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="page">
        {loading ? (
          <Loading />
        ) : !id || !board ? (
          <div className="card">
            <Empty icon="▦" title="No campaign to show"
              action={<Link className="btn btn-primary btn-sm" to="/campaigns">Go to campaigns</Link>}>
              Create a campaign with at least one stage, then come back here.
            </Empty>
          </div>
        ) : (
          <>
            {board.truncated && (
              <div className="banner banner-warn">
                <span>⚠</span>
                <div>
                  This campaign has more than 2,000 active contacts — the board shows the 2,000 due soonest.
                  Use <Link to={`/contacts?campaign=${id}`}>the contacts table</Link> for the full list.
                </div>
              </div>
            )}
            <div className="board">
              {board.columns.map((col) => (
                <div
                  key={col.index}
                  className={`board-col${dropCol === col.index ? ' drop-target' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDropCol(col.index) }}
                  onDragLeave={() => setDropCol((c) => (c === col.index ? null : c))}
                  onDrop={() => drop(col.index)}
                >
                  <div className="board-col-head">
                    <div className="row" style={{ marginBottom: 4 }}>
                      <Channel value={col.channel} showLabel={false} />
                      <span className="strong truncate" style={{ flex: 1 }}>{col.name}</span>
                      <span className="queue-count">{col.cards.length}</span>
                    </div>
                    <div className="small faint">
                      Stage {col.index + 1} · waits {col.waitDays} day{col.waitDays === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="board-col-body">
                    {col.cards.length === 0 && (
                      <div className="small faint center" style={{ padding: '18px 8px' }}>
                        {dropCol === col.index ? 'Drop here' : 'Empty'}
                      </div>
                    )}
                    {col.cards.map((card) => (
                      <div
                        key={card.enrollmentId}
                        className={`board-card${dragging?.enrollmentId === card.enrollmentId ? ' dragging' : ''}`}
                        draggable
                        onDragStart={() => setDragging({ enrollmentId: card.enrollmentId, fromIndex: col.index })}
                        onDragEnd={() => { setDragging(null); setDropCol(null) }}
                      >
                        <div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="board-card-name truncate">
                              <Link to={`/contacts/${card.contact._id}`}>{fullName(card.contact)}</Link>
                            </div>
                            <div className="small faint truncate">{companyName(card.contact) || card.contact.title || '—'}</div>
                          </div>
                          <CardMenu
                            columns={board.columns}
                            currentIndex={col.index}
                            onMove={(to) => move(card.enrollmentId, to)}
                            onRemove={() => remove(card.enrollmentId, fullName(card.contact))}
                          />
                        </div>
                        <div className="row" style={{ marginTop: 6, gap: 5 }}>
                          <StatusPill value={card.contact.status} statusMap={statusMap} />
                          {card.contact.doNotContact && <span className="tag" style={{ color: 'var(--danger)' }}>DNC</span>}
                        </div>
                        <div
                          className="small"
                          style={{ marginTop: 5, color: dueLabel(card.dueAt, user.timezone).startsWith('overdue') ? 'var(--danger)' : 'var(--text-faint)' }}
                        >
                          Moves on: {dueLabel(card.dueAt, user.timezone).replace(/^due /, '')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}

/* Explicit move control. Drag-and-drop is a nice shortcut but it is invisible
 * to a new rep and does not exist on a touch screen, so this menu — not the
 * drag — is the supported way to move a contact.
 *
 * Rendered through a portal: the column body scrolls, and a popover inside an
 * overflow container gets clipped. */
function CardMenu({ columns, currentIndex, onMove, onRemove }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const place = () => {
      const r = buttonRef.current.getBoundingClientRect()
      const width = 224
      const height = Math.min(360, 74 + columns.length * 32)
      setPos({
        left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
        // Flip above the button when there is not enough room below.
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
  }, [open, columns.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return
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

  const itemStyle = {
    width: '100%', textAlign: 'left', border: 0, background: 'none',
    font: 'inherit', fontSize: 12.5, cursor: 'pointer',
  }

  return (
    <>
      <button
        ref={buttonRef}
        className="btn btn-ghost btn-sm" aria-label="Move this contact" aria-expanded={open}
        style={{ padding: '0 6px', lineHeight: 1.4, flex: '0 0 auto' }}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
      >
        ⋯
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="card"
          style={{
            position: 'fixed', left: pos.left, top: pos.top, width: pos.width,
            zIndex: 90, boxShadow: 'var(--shadow-lg)', padding: 5,
            maxHeight: '60vh', overflowY: 'auto',
          }}
        >
          <div className="nav-group-label" style={{ padding: '5px 8px 3px' }}>Move to stage</div>
          {columns.map((c) => (
            <button
              key={c.index}
              className="nav-item"
              disabled={c.index === currentIndex}
              style={{ ...itemStyle, cursor: c.index === currentIndex ? 'default' : 'pointer', opacity: c.index === currentIndex ? 0.45 : 1 }}
              onClick={() => { setOpen(false); if (c.index !== currentIndex) onMove(c.index) }}
            >
              <Channel value={c.channel} showLabel={false} />
              <span className="truncate" style={{ flex: 1 }}>{c.index + 1}. {c.name}</span>
              {c.index === currentIndex && <span className="small faint">here</span>}
            </button>
          ))}
          <div className="divider" style={{ margin: '5px 0' }} />
          <button
            className="nav-item"
            style={{ ...itemStyle, color: 'var(--danger)' }}
            onClick={() => { setOpen(false); onRemove() }}
          >
            Remove from campaign
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
