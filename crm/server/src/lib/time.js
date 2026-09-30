/* Day boundaries in a specific IANA timezone.
 *
 * A task created at 14:00 is due "now", so a naive dueAt < Date.now() check
 * marks it overdue one second later and the whole queue turns red. Overdue
 * means "due before today started", measured in the rep's own timezone —
 * a Manila rep and a London rep should not disagree about what today is.
 */

function offsetMs(date, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]))
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
    )
    return asUTC - date.getTime()
  } catch {
    return 0 // unknown zone — fall back to UTC rather than throwing
  }
}

function startOfDay(timeZone, dayOffset = 0, now = new Date()) {
  const off = offsetMs(now, timeZone || 'UTC')
  const localMidnight = Math.floor((now.getTime() + off) / 86400000) * 86400000
  return new Date(localMidnight + dayOffset * 86400000 - off)
}

// Exclusive upper bound: the first instant of the following day.
function endOfDay(timeZone, dayOffset = 0, now = new Date()) {
  return startOfDay(timeZone, dayOffset + 1, now)
}

module.exports = { startOfDay, endOfDay, offsetMs }
