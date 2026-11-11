/* Contact lifecycle: which status the CRM sets on its own, and the Lost /
 * Nurture / suppression rules.
 *
 * Statuses are edited in Settings, so the code never names one directly.
 * Instead each status can carry a `role` ("set automatically when …"). The
 * code asks for a role and gets whatever status currently holds it. When no
 * status has the role, it falls back to a status whose value or label matches
 * a familiar name (so an install that never set roles keeps working), and
 * when nothing matches it changes nothing — it never writes a status that
 * does not exist. */

const { Contact, Settings, DEFAULT_STATUSES } = require('../db')

const STATUS_ROLES = [
  { key: 'created', label: 'A contact is created', names: ['new'] },
  { key: 'contacted', label: 'First outreach is done', names: ['contacted'] },
  { key: 'replied', label: 'A reply is logged', names: ['replied', 'engaged', 'engaged replied'] },
  { key: 'meeting_booked', label: 'A meeting is booked', names: ['meeting booked', 'meeting_booked'] },
  { key: 'won', label: 'A deal is won (signed)', names: ['pilot signed', 'pilot_signed', 'signed', 'customer'] },
  { key: 'lost', label: 'Lost (needs a Lost reason)', names: ['lost'] },
]
const ROLE_KEYS = STATUS_ROLES.map((r) => r.key)

// The Lost reasons the CRM itself records.
const REASON_UNSUBSCRIBED = 'Unsubscribed / do-not-contact'
const REASON_NOT_INTERESTED = 'Not interested'

const EMAIL_STATUSES = [
  { value: 'valid', label: 'Valid' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
]
const DNC_STATUSES = [
  { value: 'clear', label: 'Clear' },
  { value: 'national_dnc', label: 'On National DNC' },
  { value: 'reassigned', label: 'Reassigned number' },
  { value: 'dnc_request', label: 'Do-not-call request' },
]

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

async function statusList() {
  const settings = await Settings.findOne({ key: 'global' }).select('contactStatuses').lean()
  return settings?.contactStatuses?.length ? settings.contactStatuses : DEFAULT_STATUSES
}

/* Status value for a role, or null if this install has none. */
function statusForRole(list, role) {
  const explicit = list.find((s) => s.role === role)
  if (explicit) return explicit.value
  const def = STATUS_ROLES.find((r) => r.key === role)
  if (!def) return null
  const wanted = new Set(def.names.map(norm))
  const byName = list.find((s) => !s.role && (wanted.has(norm(s.value)) || wanted.has(norm(s.label))))
  return byName ? byName.value : null
}

async function roleStatus(role) {
  return statusForRole(await statusList(), role)
}

async function isLostStatus(value) {
  if (!value) return false
  return (await roleStatus('lost')) === value
}

/* Mark a contact Lost (if this install has a Lost status), with a reason and
 * optionally Nurture on. Saves the contact. Returns the status label change
 * for the caller's activity log, or null when nothing changed. */
async function applyLost(contact, { reason, nurture } = {}) {
  const lost = await roleStatus('lost')
  const from = contact.status
  if (lost) contact.status = lost
  if (reason) contact.lostReason = reason
  if (nurture !== undefined) contact.nurture = !!nurture
  return lost && from !== lost ? { from, to: lost } : null
}

async function markLost(contact, opts = {}) {
  const change = await applyLost(contact, opts)
  await contact.save()
  return change
}

/* Move a contact to a role's status, but only forward from the listed roles
 * (e.g. "contacted" only from "created"). `from: null` means from anything. */
async function advanceStatus(contact, role, { from = null } = {}) {
  const list = await statusList()
  const target = statusForRole(list, role)
  if (!target || contact.status === target) return null
  if (from) {
    const allowed = from.map((r) => statusForRole(list, r)).filter(Boolean)
    if (!allowed.includes(contact.status)) return null
  }
  const prev = contact.status
  contact.status = target
  return { from: prev, to: target }
}

/* ---- Suppression, split by channel ----
 * doNotContact: nothing at all (an explicit, total opt-out).
 * emailStatus: unsubscribed / bounced stop email only.
 * dncStatus: anything but clear stops calls only. */
function emailBlock(contact) {
  if (!contact) return 'Contact not found'
  if (contact.doNotContact) return 'Contact is flagged do not contact'
  if (contact.emailStatus === 'unsubscribed' || contact.unsubscribedAt) return 'Contact unsubscribed from email'
  if (contact.emailStatus === 'bounced') return 'Email address bounced'
  return null
}

function callBlock(contact) {
  if (!contact) return 'Contact not found'
  if (contact.doNotContact) return 'Contact is flagged do not contact'
  const dnc = contact.dncStatus || 'clear'
  if (dnc !== 'clear') {
    return `Calls blocked: ${(DNC_STATUSES.find((d) => d.value === dnc) || { label: dnc }).label}`
  }
  return null
}

function linkedinBlock(contact) {
  if (!contact) return 'Contact not found'
  if (contact.doNotContact) return 'Contact is flagged do not contact'
  return null
}

function channelBlock(contact, channel) {
  if (channel === 'email') return emailBlock(contact)
  if (channel === 'call') return callBlock(contact)
  return linkedinBlock(contact)
}

/* One-time tidy-ups, safe to run on every start:
 *  - unsubscribedAt → emailStatus "unsubscribed" (older records)
 *  - copy values from custom fields that duplicate the new built-in ones
 *    ("Lost reason", "Nurture", "Email status", "DNC status"), only into
 *    built-ins that are still empty/default. */
async function migrateLifecycle({ CustomField }) {
  await Contact.updateMany(
    { unsubscribedAt: { $ne: null }, emailStatus: { $in: [null, 'valid'] } },
    { $set: { emailStatus: 'unsubscribed' } }
  )

  const defs = await CustomField.find({ object: 'contact' }).lean()
  const find = (...labels) => defs.find((d) => labels.map(norm).includes(norm(d.label)))
  const lostDef = find('Lost reason')
  const nurtureDef = find('Nurture', 'Nurture status')
  const emailDef = find('Email status')
  const dncDef = find('DNC status', 'Do not call status')
  if (!lostDef && !nurtureDef && !emailDef && !dncDef) return

  const emailMap = { valid: 'valid', bounced: 'bounced', unsubscribed: 'unsubscribed' }
  const dncMap = {
    clear: 'clear', 'on national dnc': 'national_dnc', 'national dnc': 'national_dnc',
    reassigned: 'reassigned', 'do not call request': 'dnc_request', 'do not call': 'dnc_request',
  }
  const keys = [lostDef, nurtureDef, emailDef, dncDef].filter(Boolean).map((d) => `customFields.${d.key}`)
  const contacts = await Contact.find({ $or: keys.map((k) => ({ [k]: { $exists: true, $nin: [null, ''] } })) })
    .select('customFields lostReason nurture emailStatus dncStatus').lean()

  for (const c of contacts) {
    const cf = c.customFields || {}
    const set = {}
    if (lostDef && cf[lostDef.key] && !c.lostReason) set.lostReason = String(cf[lostDef.key])
    if (nurtureDef && cf[nurtureDef.key] !== undefined && !c.nurture) {
      const v = cf[nurtureDef.key]
      if (v === true || ['yes', 'on', 'true'].includes(norm(v))) set.nurture = true
    }
    if (emailDef && cf[emailDef.key] && (!c.emailStatus || c.emailStatus === 'valid')) {
      const v = emailMap[norm(cf[emailDef.key])]
      if (v && v !== 'valid') set.emailStatus = v
    }
    if (dncDef && cf[dncDef.key] && (!c.dncStatus || c.dncStatus === 'clear')) {
      const v = dncMap[norm(cf[dncDef.key])]
      if (v && v !== 'clear') set.dncStatus = v
    }
    if (Object.keys(set).length) await Contact.updateOne({ _id: c._id }, { $set: set })
  }
}

module.exports = {
  STATUS_ROLES,
  ROLE_KEYS,
  EMAIL_STATUSES,
  DNC_STATUSES,
  REASON_UNSUBSCRIBED,
  REASON_NOT_INTERESTED,
  statusList,
  statusForRole,
  roleStatus,
  isLostStatus,
  applyLost,
  markLost,
  advanceStatus,
  emailBlock,
  callBlock,
  linkedinBlock,
  channelBlock,
  migrateLifecycle,
}
