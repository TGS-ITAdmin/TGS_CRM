export function fullName(contact) {
  if (!contact) return ''
  const n = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
  // `company` is a populated relation, so it must never be used as a string
  // fallback — React throws on an object child and blanks the whole page.
  return n || companyName(contact) || contact.email || 'Unnamed contact'
}

// The company's display name, whether it arrived populated, as a bare id, or
// only as the denormalised text on the contact.
export function companyName(contact) {
  if (!contact) return ''
  const c = contact.company
  if (c && typeof c === 'object') return c.name || ''
  return contact.companyName || ''
}

export function relativeDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  const diff = d.getTime() - Date.now()
  const days = Math.round(diff / 86400000)
  const abs = Math.abs(diff)

  if (abs < 60000) return 'just now'
  if (abs < 3600000) {
    const m = Math.round(abs / 60000)
    return diff < 0 ? `${m}m ago` : `in ${m}m`
  }
  if (abs < 86400000 && Math.abs(days) < 1) {
    const h = Math.round(abs / 3600000)
    return diff < 0 ? `${h}h ago` : `in ${h}h`
  }
  if (days === 0) return diff < 0 ? 'earlier today' : 'later today'
  if (days === -1) return 'yesterday'
  if (days === 1) return 'tomorrow'
  if (days < 0) return `${-days} days ago`
  return `in ${days} days`
}

export function shortDate(value, timezone) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric', month: 'short', year: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date(value))
  } catch {
    return new Date(value).toLocaleDateString()
  }
}

export function dateTime(value, timezone) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(new Date(value))
  } catch {
    return new Date(value).toLocaleString()
  }
}

/* Overdue means "due before today began" in the user's own timezone — not
 * "dueAt is in the past". A task created five minutes ago is due now, not late. */
function tzOffsetMs(date, timeZone) {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value])
    )
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
    )
    return asUTC - date.getTime()
  } catch {
    return -new Date().getTimezoneOffset() * 60000
  }
}

export function startOfLocalDay(timezone, dayOffset = 0, now = new Date()) {
  const off = tzOffsetMs(now, timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)
  return new Date(Math.floor((now.getTime() + off) / 86400000) * 86400000 + dayOffset * 86400000 - off)
}

export const isOverdue = (value, timezone) =>
  !!value && new Date(value).getTime() < startOfLocalDay(timezone).getTime()

export function pct(n) {
  if (n === null || n === undefined) return '—'
  return `${n}%`
}

export function num(n) {
  return (n ?? 0).toLocaleString()
}

// Common IANA zones, enough for a PH team working US/UK/AU prospects.
export const TIMEZONES = [
  'Asia/Manila', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Kolkata', 'Asia/Dubai',
  'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland',
  'Europe/London', 'Europe/Dublin', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Madrid',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo', 'UTC',
]

/* Reads correctly in a work queue: a task due at 09:00 that you open at 14:00
 * is still "due today", not "5h ago". Only yesterday and earlier is late. */
export function dueLabel(value, timezone) {
  if (!value) return 'no due date'
  const due = new Date(value).getTime()
  const todayStart = startOfLocalDay(timezone).getTime()
  const tomorrowStart = startOfLocalDay(timezone, 1).getTime()
  if (due < todayStart) return `overdue — ${relativeDate(value)}`
  if (due < tomorrowStart) return 'due today'
  if (due < startOfLocalDay(timezone, 2).getTime()) return 'due tomorrow'
  return `due ${relativeDate(value)}`
}

/* ---------------- Money ---------------- */

/* Compact by default: a pipeline column showing "$1,240,000" wraps and stops
 * being scannable, where "$1.24M" does not. Full precision is available with
 * compact:false for detail views and anywhere a number is edited. */
export function money(amount, currency = 'USD', { compact = false, decimals } = {}) {
  const n = Number(amount) || 0
  const abs = Math.abs(n)
  const opts = {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: decimals ?? (abs < 100 && abs !== 0 ? 2 : 0),
    maximumFractionDigits: decimals ?? (abs < 100 && abs !== 0 ? 2 : 0),
  }
  if (compact && abs >= 10000) {
    opts.notation = 'compact'
    opts.maximumFractionDigits = 2
    opts.minimumFractionDigits = 0
  }
  try {
    return new Intl.NumberFormat(undefined, opts).format(n)
  } catch {
    // An unknown ISO code would otherwise throw and blank the whole cell.
    return `${currency} ${n.toLocaleString()}`
  }
}

export function monthLabel(iso) {
  if (!iso) return ''
  const [y, m] = String(iso).split('-')
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' })
      .format(new Date(Number(y), Number(m) - 1, 1))
  } catch {
    return iso
  }
}

// Days a deal has sat where it is — the single best staleness signal.
export function daysSince(value) {
  if (!value) return null
  return Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 86400000))
}

export function dateInput(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}
