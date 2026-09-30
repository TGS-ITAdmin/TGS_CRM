import { useEffect, useRef, useState } from 'react'

export const CHANNEL_LABEL = { linkedin: 'LinkedIn', email: 'Email', call: 'Call' }
export const CHANNEL_ICON = { linkedin: 'in', email: '@', call: '☎' }

export function Channel({ value, showLabel = true }) {
  if (!value) return null
  return (
    <span className={`chan chan-${value}`}>
      <span aria-hidden="true">{CHANNEL_ICON[value]}</span>
      {showLabel && CHANNEL_LABEL[value]}
    </span>
  )
}

export function StatusPill({ value, statusMap }) {
  const meta = statusMap?.get(value)
  const color = meta?.color || '#64748b'
  return (
    <span className="pill" style={{ color, borderColor: color + '55' }}>
      <span className="pill-dot" />
      {meta?.label || value || '—'}
    </span>
  )
}

export function Initials({ name, size = 28 }) {
  const initials = String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  return (
    <span className="avatar" style={{ width: size, height: size, flexBasis: size, fontSize: size * 0.4 }}>
      {initials || '?'}
    </span>
  )
}

export function Empty({ icon = '📭', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      {title && <div className="empty-title">{title}</div>}
      {children && <div className="small">{children}</div>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading">
      <span className="spinner" />
      <span className="small">{label}</span>
    </div>
  )
}

export function Modal({ title, onClose, children, footer, width = '' }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${width}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await onConfirm() } finally { setBusy(false) }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>{message}</div>
    </Modal>
  )
}

export function Field({ label, hint, children, ...rest }) {
  return (
    <div className="field" {...rest}>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

/* Copy that reports back — reps live in this button all day. */
export function CopyButton({ text, label = 'Copy', className = 'btn btn-sm' }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text || '')
    } catch {
      // Clipboard API needs a secure context; fall back to a temp textarea.
      const ta = document.createElement('textarea')
      ta.value = text || ''
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* nothing more we can do */ }
      document.body.removeChild(ta)
    }
    setCopied(true)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? '✓ Copied' : label}
    </button>
  )
}

export function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="bar-track">
      <div className="bar-fill" style={{ width: `${pct}%`, background: color || undefined }} />
    </div>
  )
}

export function Pager({ page, pages, total, onPage }) {
  if (!pages || pages <= 1) {
    return <div className="small faint">{total} result{total === 1 ? '' : 's'}</div>
  }
  return (
    <div className="row">
      <div className="small faint" style={{ flex: 1 }}>
        {total.toLocaleString()} results · page {page} of {pages}
      </div>
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Prev</button>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</button>
    </div>
  )
}
