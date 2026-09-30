import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

/* Type-ahead company selector.
 *
 * Free text is allowed and is the common case — a rep types "Acme Health" and
 * the server resolves it to an existing company by email domain or name, or
 * creates one. Picking from the list pins an exact company id, which wins over
 * whatever is typed. */
export default function CompanyPicker({ value, name, onChange, placeholder = 'Start typing a company…', autoFocus }) {
  const [query, setQuery] = useState(name || '')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef(null)
  const timer = useRef(null)

  useEffect(() => { setQuery(name || '') }, [name])

  useEffect(() => {
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  function search(q) {
    clearTimeout(timer.current)
    if (!q.trim()) { setResults([]); return }
    setLoading(true)
    timer.current = setTimeout(async () => {
      try {
        const { items } = await api.searchCompanies(q)
        setResults(items)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 220)
  }

  function type(v) {
    setQuery(v)
    setOpen(true)
    search(v)
    // Typing clears any pinned id — the text is now the source of truth.
    onChange({ company: '', companyName: v })
  }

  function pick(item) {
    setQuery(item.name)
    setOpen(false)
    onChange({ company: item._id, companyName: item.name })
  }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        className="input" value={query} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => type(e.target.value)}
        onFocus={() => { if (query.trim()) { setOpen(true); search(query) } }}
      />
      {value && (
        <div className="hint" style={{ marginTop: 4 }}>
          Linked to an existing company. Edit the text to link somewhere else.
        </div>
      )}
      {!value && query.trim() && (
        <div className="hint" style={{ marginTop: 4 }}>
          We'll match this to an existing company by email domain or name, or create one.
        </div>
      )}
      {open && (results.length > 0 || loading) && (
        <div
          className="card"
          style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 40, marginTop: 3, padding: 4, boxShadow: 'var(--shadow-lg)', maxHeight: 260, overflowY: 'auto' }}
        >
          {loading && <div className="small faint" style={{ padding: '7px 9px' }}>Searching…</div>}
          {results.map((item) => (
            <button
              key={item._id} type="button" className="nav-item"
              style={{ width: '100%', textAlign: 'left', border: 0, background: 'none', font: 'inherit', fontSize: 13, cursor: 'pointer' }}
              onClick={() => pick(item)}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="strong truncate" style={{ display: 'block' }}>{item.name}</span>
                {(item.domain || item.industry) && (
                  <span className="small faint">{[item.domain, item.industry].filter(Boolean).join(' · ')}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
