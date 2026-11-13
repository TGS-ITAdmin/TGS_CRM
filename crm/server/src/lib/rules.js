/* Account-level outreach rules (spec section 3, G5 G9 G10 G11 G12 G13).
 *
 * Everything here is pure date arithmetic plus one cached settings read, so
 * the engine can ask "when is the next business day?" or "when is this
 * contact's next call window?" without knowing how either is configured. */

const { Settings } = require('../db')

const DEFAULT_RULES = {
  businessTimezone: 'America/New_York',
  holidays: ['2026-11-26', '2026-12-25', '2027-01-01'],
  callWindows: [{ start: 9, end: 11 }, { start: 16, end: 18 }],
  touchCaps: { email: 4, call: 3, linkedin: 2 },
  linkedinInviteCap: 20,
  workdayStartHour: 9,
  complianceSignedOffAt: null,
  complianceSignedOffBy: null,
}

let cache = { at: 0, value: null }

async function getRules({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 30000) return cache.value
  const s = await Settings.findOne({ key: 'global' }).select('rules').lean()
  const r = { ...DEFAULT_RULES, ...(s?.rules || {}) }
  r.touchCaps = { ...DEFAULT_RULES.touchCaps, ...(s?.rules?.touchCaps || {}) }
  if (!Array.isArray(r.holidays)) r.holidays = DEFAULT_RULES.holidays
  if (!Array.isArray(r.callWindows) || !r.callWindows.length) r.callWindows = DEFAULT_RULES.callWindows
  cache = { at: Date.now(), value: r }
  return r
}

function clearRulesCache() { cache = { at: 0, value: null } }

/* ---- Time-zone arithmetic (no library: Intl does the zone maths) ---- */

function validTz(tz, fallback) {
  try {
    if (tz) {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    }
  } catch { /* fall through */ }
  return fallback
}

// The wall-clock parts of `date` in `tz`.
function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  })
  const o = {}
  for (const p of f.formatToParts(date)) o[p.type] = p.value
  return {
    y: +o.year, m: +o.month, d: +o.day, hour: +o.hour, minute: +o.minute,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday),
    ymd: `${o.year}-${o.month}-${o.day}`,
  }
}

// The instant at which it is y-m-d h:mi in tz.
function zoned(y, m, d, h, mi, tz) {
  let t = Date.UTC(y, m - 1, d, h, mi)
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(t), tz)
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute)
    const want = Date.UTC(y, m - 1, d, h, mi)
    t += want - asUtc
  }
  return new Date(t)
}

// Noon on the following calendar day in tz (noon avoids DST edges).
function nextDay(p, tz) {
  const n = zoned(p.y, p.m, p.d, 12, 0, tz)
  return parts(new Date(n.getTime() + 24 * 3600 * 1000), tz)
}

function isBusinessDayParts(p, holidays) {
  return p.weekday >= 1 && p.weekday <= 5 && !holidays.includes(p.ymd)
}

function isBusinessDay(date, rules, tz) {
  return isBusinessDayParts(parts(date, validTz(tz, rules.businessTimezone)), rules.holidays)
}

/* `from` plus n business days, at the same local time of day. A start on a
 * weekend or holiday first rolls to the next business day's opening hour. */
function addBusinessDays(from, n, rules, tz) {
  const zone = validTz(tz, rules.businessTimezone)
  let p = parts(from, zone)
  let hour = p.hour
  let minute = p.minute
  if (!isBusinessDayParts(p, rules.holidays)) {
    while (!isBusinessDayParts(p, rules.holidays)) p = nextDay(p, zone)
    hour = rules.workdayStartHour
    minute = 0
  }
  let left = Math.max(0, Math.round(Number(n) || 0))
  while (left > 0) {
    p = nextDay(p, zone)
    if (isBusinessDayParts(p, rules.holidays)) left--
  }
  return zoned(p.y, p.m, p.d, hour, minute, zone)
}

/* `date`, or the next business day's opening hour if `date` is not on one. */
function onBusinessDay(date, rules, tz) {
  return addBusinessDays(date, 0, rules, tz)
}

/* G5: the earliest moment at or after `from` inside one of the call windows,
 * on a business day, in the contact's own time zone. */
function nextCallWindow(from, rules, contactTz) {
  const zone = validTz(contactTz, rules.businessTimezone)
  let p = parts(from, zone)
  for (let i = 0; i < 21; i++) {
    if (isBusinessDayParts(p, rules.holidays)) {
      for (const w of [...rules.callWindows].sort((a, b) => a.start - b.start)) {
        const start = zoned(p.y, p.m, p.d, w.start, 0, zone)
        const end = zoned(p.y, p.m, p.d, w.end, 0, zone)
        if (from < end) return from > start ? from : start
      }
    }
    p = nextDay(p, zone)
    from = zoned(p.y, p.m, p.d, 0, 0, zone)
  }
  return from
}

function inCallWindow(date, rules, contactTz) {
  const zone = validTz(contactTz, rules.businessTimezone)
  const p = parts(date, zone)
  if (!isBusinessDayParts(p, rules.holidays)) return false
  return rules.callWindows.some((w) => p.hour >= w.start && p.hour < w.end)
}

/* G1: when a Respond task is due. Positive replies: 15 minutes, counted
 * inside US business hours (9am–6pm business time zone, business days).
 * Anything else: by the next business day's opening hour. */
function respondDue(now, positive, rules) {
  const zone = rules.businessTimezone
  const p = parts(now, zone)
  const open = isBusinessDayParts(p, rules.holidays) && p.hour >= rules.workdayStartHour && p.hour < 18
  if (positive) {
    if (open) return new Date(now.getTime() + 15 * 60000)
    const next = addBusinessDays(p.hour >= 18 ? addBusinessDays(now, 1, rules) : now, 0, rules)
    const np = parts(next, zone)
    return zoned(np.y, np.m, np.d, rules.workdayStartHour, 15, zone)
  }
  const next = addBusinessDays(now, 1, rules)
  const np = parts(next, zone)
  return zoned(np.y, np.m, np.d, rules.workdayStartHour, 0, zone)
}

/* G13: the cut-off for "more than 1 business day overdue": the start of the
 * business day before today, in business time. */
function escalationCutoff(now, rules) {
  const zone = rules.businessTimezone
  let p = parts(now, zone)
  let back = 0
  while (back < 1) {
    const noon = zoned(p.y, p.m, p.d, 12, 0, zone)
    p = parts(new Date(noon.getTime() - 24 * 3600 * 1000), zone)
    if (isBusinessDayParts(p, rules.holidays)) back++
  }
  return zoned(p.y, p.m, p.d, 0, 0, zone)
}

// Start and end of the business-time day containing `date`.
function dayBounds(date, rules) {
  const zone = rules.businessTimezone
  const p = parts(date, zone)
  const start = zoned(p.y, p.m, p.d, 0, 0, zone)
  const np = nextDay(p, zone)
  return { start, end: zoned(np.y, np.m, np.d, 0, 0, zone) }
}

module.exports = {
  DEFAULT_RULES,
  getRules,
  clearRulesCache,
  parts,
  zoned,
  isBusinessDay,
  addBusinessDays,
  onBusinessDay,
  nextCallWindow,
  inCallWindow,
  respondDue,
  escalationCutoff,
  dayBounds,
}
