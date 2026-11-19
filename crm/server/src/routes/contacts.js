const express = require('express')
const multer = require('multer')
const { parse } = require('csv-parse/sync')
const ExcelJS = require('exceljs')
const {
  Contact, Company, Activity, Enrollment, Task, OutboxMessage, Suppression, Campaign,
} = require('../db')
const { requireAuth, requirePermission, ownerScope, contactAccessScope } = require('../middleware/auth')
const {
  logActivity, suppressContactEverywhere, handleReply, lockCompany, pauseEnrollment, resumeEnrollment, materializeStage, enroll,
} = require('../lib/engine')
const { canUseCampaign } = require('../lib/permissions')
const {
  roleStatus, isLostStatus, applyLost, advanceStatus, statusList, statusForRole,
  REASON_UNSUBSCRIBED, EMAIL_STATUSES, DNC_STATUSES,
} = require('../lib/lifecycle')
const { resolveCompany, domainFromEmail, domainFromWebsite } = require('../lib/companies')
const customFields = require('../lib/custom-fields')
const { findContactDuplicates, mergeContacts, previewContactMerge } = require('../lib/dedupe')
const { ensureDealForMeeting } = require('../lib/deals')

const router = express.Router()
router.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

// Fields that live on the person. Everything describing the organisation —
// industry, seats needed, current provider — belongs to the Company.
const EDITABLE = [
  'firstName', 'lastName', 'title', 'email', 'phone', 'mobile',
  'linkedinUrl', 'location', 'timezone', 'source', 'notes', 'tags',
]

const EMAIL_STATUS_VALUES = EMAIL_STATUSES.map((s) => s.value)
const DNC_STATUS_VALUES = DNC_STATUSES.map((s) => s.value)

const lostReasonRequired = (res) => res.status(400).json({
  error: 'A Lost reason is required when a contact is set to Lost.',
  code: 'lost_reason_required',
})

const { cancelChannelWork, applySuppressionChanges } = require('../lib/suppression')
const { applyOutcome, findOutcome } = require('../lib/outcomes')
const { rebind: rebindAudit } = require('../lib/audit')


// Company-level fields a contact form or CSV may also carry.
const COMPANY_FIELDS = [
  'industry', 'website', 'employeeCount', 'location', 'timezone', 'linkedinUrl',
  'phone', 'address', 'currentProvider', 'seatsNeeded', 'targetRoles',
  'contractTiming', 'budgetRange',
]

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ---- List: server-side pagination, filters and sort ---- */
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
  const filter = { ...ownerScope(req) }

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') }
  if (req.query.owner && req.can('contacts.viewAll')) filter.owner = req.query.owner
  if (req.query.tag) filter.tags = req.query.tag
  if (req.query.source) filter.source = req.query.source
  if (req.query.company) filter.company = req.query.company
  if (req.query.dnc === 'true') filter.doNotContact = true
  if (req.query.dnc === 'false') filter.doNotContact = false
  if (req.query.nurture === 'true') filter.nurture = true
  if (req.query.nurture === 'false') filter.nurture = { $ne: true }
  if (EMAIL_STATUS_VALUES.includes(req.query.emailStatus)) filter.emailStatus = req.query.emailStatus
  if (DNC_STATUS_VALUES.includes(req.query.dncStatus)) filter.dncStatus = req.query.dncStatus

  /* Search. The whole text is tried first (so "A & W Plumbing" or an email
     still match as typed); then every word must match some field, so a full
     name like "William Todd" finds first name William + last name Todd. */
  const q = (req.query.q || '').trim()
  if (q) {
    const anyField = async (text) => {
      const rx = new RegExp(escapeRegex(text), 'i')
      const companyIds = await Company.find({ name: rx }).distinct('_id')
      return [
        { firstName: rx }, { lastName: rx }, { companyName: rx },
        { email: rx }, { phone: rx }, { title: rx }, { linkedinUrl: rx },
        ...(companyIds.length ? [{ company: { $in: companyIds } }] : []),
      ]
    }
    const words = q.split(/\s+/).filter(Boolean).slice(0, 6)
    if (words.length > 1) {
      const each = []
      for (const w of words) each.push({ $or: await anyField(w) })
      filter.$or = [...await anyField(q), { $and: each }]
    } else {
      filter.$or = await anyField(q)
    }
  }

  if (req.query.campaign) {
    const ids = await Enrollment.find({
      campaign: req.query.campaign,
      status: req.query.enrollmentStatus || 'active',
    }).distinct('contact')
    filter._id = { $in: ids }
  }

  const sortField = ['createdAt', 'lastActivityAt', 'lastName', 'status'].includes(req.query.sort)
    ? req.query.sort
    : 'lastActivityAt'
  const sortDir = req.query.dir === 'asc' ? 1 : -1

  const [items, total] = await Promise.all([
    Contact.find(filter)
      .sort({ [sortField]: sortDir })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('owner', 'name email')
      .populate('company', 'name domain industry seatsNeeded')
      .lean({ virtuals: true }),
    Contact.countDocuments(filter),
  ])

  // One query for the whole page rather than an N+1 per row.
  const enrollments = await Enrollment.find({
    contact: { $in: items.map((i) => i._id) },
    status: 'active',
  })
    .populate('campaign', 'name stages')
    .lean()
  const byContact = new Map()
  for (const e of enrollments) {
    const list = byContact.get(String(e.contact)) || []
    const stage = e.campaign?.stages?.[e.currentStageIndex] || null
    list.push({
      id: e._id,
      campaignId: e.campaign?._id,
      campaignName: e.campaign?.name || '(deleted)',
      stageName: stage?.name || '',
      channel: stage?.channel || '',
      dueAt: e.dueAt,
    })
    byContact.set(String(e.contact), list)
  }
  for (const item of items) item.enrollments = byContact.get(String(item._id)) || []
  await customFields.decorate('contact', items)

  res.json({
    items, total, page, limit, pages: Math.ceil(total / limit),
    customFields: await customFields.getFields('contact'),
  })
})

/* ---- Single contact with full timeline ---- */
router.get('/:id', async (req, res) => {
  const contact = await Contact.findOne({ _id: req.params.id, ...(await contactAccessScope(req)) })
    .populate('owner', 'name email')
    .populate('company')
    .lean({ virtuals: true })
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  await customFields.decorate('contact', contact)

  const [activities, enrollments, tasks, messages] = await Promise.all([
    Activity.find({ contact: contact._id })
      .sort({ createdAt: -1 }).limit(300)
      .populate('user', 'name').populate('campaign', 'name').lean(),
    Enrollment.find({ contact: contact._id })
      .sort({ createdAt: -1 }).populate('campaign', 'name stages').lean(),
    Task.find({ contact: contact._id, status: 'pending' }).sort({ dueAt: 1 }).lean(),
    OutboxMessage.find({ contact: contact._id, status: 'queued' }).sort({ createdAt: 1 }).lean(),
  ])

  res.json({
    contact,
    activities,
    enrollments: enrollments.map((e) => ({
      ...e,
      currentStage: e.campaign?.stages?.[e.currentStageIndex] || null,
      totalStages: e.campaign?.stages?.length || 0,
    })),
    pendingTasks: tasks,
    queuedMessages: messages,
    customFields: await customFields.getFields('contact'),
  })
})

/* "acme.com" and "https://acme.com/" are the same site; store one form. */
function cleanWebsite(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (!url.hostname.includes('.')) return ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

/* The contact form's "Company website" field. A website typed for a company
 * that already exists fills it in or corrects it; an empty field never wipes
 * a website someone else entered. */
async function applyCompanyWebsite(company, body) {
  if (!company || body.company_website === undefined) return
  const website = cleanWebsite(body.company_website)
  if (!website || website === company.website) return
  company.website = website
  if (!company.domain) company.domain = domainFromWebsite(website)
  await company.save()
}

/* ---- Create ---- */
async function attachCompany(doc, body, req) {
  if (body.company) {
    // An explicit company id from the picker wins over any typed name.
    const existing = await Company.findById(body.company)
    if (existing) {
      doc.company = existing._id
      doc.companyName = existing.name
      await applyCompanyWebsite(existing, body)
      return existing
    }
  }
  const name = body.companyName || body.company
  if (!name && !doc.email) return null

  const extra = {}
  for (const key of COMPANY_FIELDS) {
    if (body[`company_${key}`] !== undefined) extra[key] = body[`company_${key}`]
  }
  const website = cleanWebsite(body.company_website)
  if (website) extra.website = website
  const company = await resolveCompany({
    name,
    email: doc.email,
    website,
    extra,
    ownerId: doc.owner || req.user._id,
    source: doc.source || 'manual',
  })
  if (company) {
    doc.company = company._id
    doc.companyName = company.name
    // Matched an existing company by domain or name: still record the website.
    await applyCompanyWebsite(company, body)
  }
  return company
}

router.post('/', requirePermission('contacts.edit'), async (req, res) => {
  const body = req.body || {}
  const doc = {}
  for (const key of EDITABLE) if (body[key] !== undefined) doc[key] = body[key]
  doc.status = body.status || (await roleStatus('created')) || 'new'
  if (body.lostReason !== undefined) doc.lostReason = String(body.lostReason || '').trim()
  if (body.nurture !== undefined) doc.nurture = !!body.nurture
  if (EMAIL_STATUS_VALUES.includes(body.emailStatus)) doc.emailStatus = body.emailStatus
  if (DNC_STATUS_VALUES.includes(body.dncStatus)) doc.dncStatus = body.dncStatus
  if (doc.emailStatus === 'unsubscribed') doc.unsubscribedAt = new Date()
  if (await isLostStatus(doc.status) && !doc.lostReason) return lostReasonRequired(res)
  if (body.customFields) {
    const { values, errors } = await customFields.applyValues('contact', {}, body.customFields)
    if (errors.length) return res.status(400).json({ error: errors.join('. ') })
    doc.customFields = values
  }
  doc.owner = req.can('contacts.viewAll') && body.owner ? body.owner : req.user._id
  doc.source = doc.source || 'manual'

  if (!doc.firstName && !doc.lastName && !body.companyName && !doc.email) {
    return res.status(400).json({ error: 'Give the contact at least a name, company, or email' })
  }

  const dupe = await findDuplicate(doc)
  if (dupe) {
    return res.status(409).json({
      error: `That ${dupe.field} already belongs to an existing contact`,
      contactId: dupe.contact._id,
      contactName: [dupe.contact.firstName, dupe.contact.lastName].filter(Boolean).join(' '),
    })
  }

  await attachCompany(doc, body, req)

  const contact = await Contact.create(doc)
  await logActivity({
    contact: contact._id,
    company: contact.company || null,
    type: 'contact_created',
    user: req.user._id,
    title: `Contact created (${doc.source})`,
  })
  res.status(201).json({ contact: contact.toJSON() })
})

async function findDuplicate(doc, excludeId = null) {
  const checks = []
  if (doc.email) checks.push(['email', { email: String(doc.email).toLowerCase() }])
  if (doc.linkedinUrl) checks.push(['LinkedIn URL', { linkedinUrl: doc.linkedinUrl }])
  for (const [field, filter] of checks) {
    const q = excludeId ? { ...filter, _id: { $ne: excludeId } } : filter
    const contact = await Contact.findOne(q).lean()
    if (contact) return { field, contact }
  }
  return null
}

/* ---- Update ---- */
router.put('/:id', requirePermission('contacts.edit'), async (req, res) => {
  const contact = await Contact.findOne({ _id: req.params.id, ...(await contactAccessScope(req)) })
  if (!contact) return res.status(404).json({ error: 'Contact not found' })

  const body = req.body || {}
  const changes = []
  let dealResult = null

  // G17: Lost needs a reason — checked before anything is changed.
  const nextStatus = body.status !== undefined ? body.status : contact.status
  const nextReason = body.lostReason !== undefined ? String(body.lostReason || '').trim() : contact.lostReason
  const willBeLost = await isLostStatus(nextStatus)
  if (willBeLost && !nextReason) return lostReasonRequired(res)

  if (body.lostReason !== undefined && nextReason !== (contact.lostReason || '')) {
    contact.lostReason = nextReason
    changes.push('lost reason')
  }
  if (body.nurture !== undefined && !!body.nurture !== !!contact.nurture) {
    contact.nurture = !!body.nurture
    changes.push(contact.nurture ? 'nurture on' : 'nurture off')
  }

  for (const key of EDITABLE) {
    if (body[key] !== undefined && String(contact[key] ?? '') !== String(body[key] ?? '')) {
      contact[key] = body[key]
      changes.push(key)
    }
  }
  if (body.customFields !== undefined) {
    const { values, errors } = await customFields.applyValues('contact', contact.customFields, body.customFields)
    if (errors.length) return res.status(400).json({ error: errors.join('. ') })
    contact.customFields = values
    contact.markModified('customFields')
  }

  if (body.company !== undefined || body.companyName !== undefined) {
    const before = String(contact.company || '')
    await attachCompany(contact, body, req)
    if (String(contact.company || '') !== before) changes.push('company')
  }

  if (body.status !== undefined && body.status !== contact.status) {
    const from = contact.status
    contact.status = body.status
    // Leaving Lost clears the reason; it described a Lost that no longer applies.
    if (!willBeLost && await isLostStatus(from) && body.lostReason === undefined) contact.lostReason = ''
    await logActivity({
      contact: contact._id,
      company: contact.company || null,
      type: 'status_change',
      user: req.user._id,
      title: `Status: ${from} → ${body.status}${willBeLost && contact.lostReason ? ` (${contact.lostReason})` : ''}`,
      meta: { from, to: body.status },
    })
    // Same handoff as a booked-meeting call outcome, for a manual status change.
    if (body.status === (await roleStatus('meeting_booked'))) {
      dealResult = await ensureDealForMeeting({ contact, actorId: req.user._id })
      // G2: a booked meeting locks the company too.
      await lockCompany({ contact, reason: `${contact.firstName || 'A contact'} booked a meeting`, actorId: req.user._id })
    }
  }

  if (body.owner !== undefined && req.can('contacts.viewAll') && String(contact.owner) !== String(body.owner)) {
    contact.owner = body.owner || null
    await Task.updateMany({ contact: contact._id, status: 'pending' }, { $set: { assignedTo: contact.owner } })
    await OutboxMessage.updateMany({ contact: contact._id, status: 'queued' }, { $set: { assignedTo: contact.owner } })
    await logActivity({
      contact: contact._id, company: contact.company || null,
      type: 'owner_change', user: req.user._id, title: 'Owner changed',
    })
  }

  const suppression = await applySuppressionChanges(contact, body, req.user._id)
  if (suppression.lostChange) {
    await logActivity({
      contact: contact._id, company: contact.company || null, type: 'status_change', user: req.user._id,
      title: `Status: ${suppression.lostChange.from} → ${suppression.lostChange.to} (${REASON_UNSUBSCRIBED})`,
      meta: { ...suppression.lostChange, automatic: true },
    })
  }
  for (const note of suppression.notes) {
    await logActivity({
      contact: contact._id, company: contact.company || null,
      type: note.startsWith('Flagged') ? 'dnc_added' : 'suppression_changed', user: req.user._id, title: note,
    })
  }

  const dupe = await findDuplicate(contact, contact._id)
  if (dupe) return res.status(409).json({ error: `That ${dupe.field} already belongs to another contact` })

  contact.lastActivityAt = new Date()
  await contact.save()
  if (changes.length) {
    await logActivity({
      contact: contact._id, company: contact.company || null,
      type: 'note', user: req.user._id,
      title: 'Details updated', body: `Changed: ${changes.join(', ')}`,
    })
  }
  res.json({ contact: contact.toJSON(), deal: dealResult })
})

router.delete('/:id', requirePermission('contacts.delete'), async (req, res) => {
  const contact = await Contact.findById(req.params.id)
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  await Promise.all([
    Activity.deleteMany({ contact: contact._id }),
    Enrollment.deleteMany({ contact: contact._id }),
    Task.deleteMany({ contact: contact._id }),
    OutboxMessage.deleteMany({ contact: contact._id }),
    Contact.deleteOne({ _id: contact._id }),
  ])
  res.json({ ok: true })
})

/* ---- Notes and manual reply logging ---- */
router.post('/:id/notes', async (req, res) => {
  const contact = await Contact.findOne({ _id: req.params.id, ...(await contactAccessScope(req)) })
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  const { body, type, channel, replyType, restartDate, outcome, enrollmentId, person } = req.body || {}
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Note cannot be empty' })

  /* A logged reply carries an outcome for its channel (email, LinkedIn or
     call). Older screens send `replyType` (positive, other, not_now,
     not_interested, unsubscribe); those map onto the same outcomes. */
  let ch = ['email', 'linkedin', 'call'].includes(channel) ? channel : 'email'
  let key = outcome
  if (type === 'reply_logged' && !findOutcome(ch, key)) {
    const legacy = ['positive', 'other', 'not_now', 'not_interested', 'unsubscribe'].includes(replyType) ? replyType : 'other'
    if (ch === 'linkedin' && legacy !== 'unsubscribe') key = `replied_${legacy}`
    else if (ch === 'call') key = { positive: 'connected', other: 'connected', not_now: 'not_now', not_interested: 'not_interested', unsubscribe: 'do_not_call' }[legacy]
    else { ch = 'email'; key = legacy }
  }
  const def = type === 'reply_logged' ? findOutcome(ch, key) : null

  const activity = await logActivity({
    contact: contact._id,
    company: contact.company || null,
    type: type === 'reply_logged' ? 'reply_logged' : 'note',
    channel: type === 'reply_logged' ? ch : (channel || ''),
    user: req.user._id,
    title: def ? `Reply: ${def.label}` : 'Note',
    body: String(body).trim(),
    meta: def ? { replyType: key } : undefined,
  })

  /* Global rules first (G1 stop on reply, G2 company lock, G3/G4/G8), then
     the branch of the campaign the reply belongs to — or the built-in
     default when that stage has no customised branch. */
  let replyResult = null
  let plan = []
  if (def) {
    let enrollment = null
    if (enrollmentId) enrollment = await Enrollment.findOne({ _id: enrollmentId, contact: contact._id })
    if (!enrollment) {
      const running = await Enrollment.find({ contact: contact._id, status: { $in: ['active', 'paused'] } })
      if (running.length === 1) enrollment = running[0]
    }
    const result = await applyOutcome({
      contact, channel: ch, outcome: key, enrollment, data: { restartDate, person }, actorId: req.user._id,
    })
    replyResult = result.replyResult
    plan = result.plan
  }

  // A logged reply is the signal the channel report hangs on, so nudge the
  // lifecycle forward if the contact is still at New or Contacted.
  const REPLIED = ['positive', 'other', 'not_now', 'replied_positive', 'replied_other', 'replied_not_now']
  if (def && REPLIED.includes(key)) {
    const moved = await advanceStatus(contact, 'replied', { from: ['created', 'contacted'] })
    if (moved) {
      await contact.save()
      await logActivity({
        contact: contact._id, company: contact.company || null,
        type: 'status_change', user: req.user._id,
        title: `Status: ${moved.from} → ${moved.to} (reply logged)`,
        meta: { ...moved, automatic: true },
      })
    }
  }
  res.status(201).json({ activity, reply: replyResult, next: plan })
})

/* ---- Bulk actions ---- */
router.post('/bulk', async (req, res) => {
  const { ids, action, value } = req.body || {}
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No contacts selected' })
  if (ids.length > 5000) return res.status(400).json({ error: 'Select at most 5,000 contacts at a time' })

  const scope = { _id: { $in: ids }, ...ownerScope(req) }
  const contacts = await Contact.find(scope).select('_id company').lean()
  const contactIds = contacts.map((l) => l._id)
  if (!contactIds.length) return res.status(404).json({ error: 'No matching contacts' })

  if (action === 'status') {
    if (!value) return res.status(400).json({ error: 'A status is required' })
    // G17: setting Lost in bulk needs one reason for the whole batch.
    const lost = await isLostStatus(value)
    const reason = String(req.body?.lostReason || '').trim()
    if (lost && !reason) return lostReasonRequired(res)
    const set = { status: value, lastActivityAt: new Date() }
    if (lost) set.lostReason = reason
    if (lost && req.body?.nurture !== undefined) set.nurture = !!req.body.nurture
    await Contact.updateMany({ _id: { $in: contactIds } }, { $set: set })
    await Activity.insertMany(
      contacts.map((c) => ({
        contact: c._id, company: c.company || null, type: 'status_change', user: req.user._id,
        title: `Status set to ${value}${lost ? ` (${reason})` : ''} (bulk)`, meta: { to: value, bulk: true },
      }))
    )
    return res.json({ ok: true, affected: contactIds.length })
  }

  // Email / call suppression in bulk, with the same rules as one contact.
  if (action === 'emailStatus' || action === 'dncStatus' || action === 'doNotContact') {
    const key = action
    const allowed = key === 'emailStatus' ? EMAIL_STATUS_VALUES : key === 'dncStatus' ? DNC_STATUS_VALUES : null
    if (allowed && !allowed.includes(value)) return res.status(400).json({ error: 'Pick a valid value' })
    const docs = await Contact.find({ _id: { $in: contactIds } })
    for (const c of docs) {
      const result = await applySuppressionChanges(c, { [key]: key === 'doNotContact' ? !!value : value }, req.user._id)
      c.lastActivityAt = new Date()
      await c.save()
      for (const note of result.notes) {
        await logActivity({ contact: c._id, company: c.company || null, type: 'suppression_changed', user: req.user._id, title: `${note} (bulk)` })
      }
    }
    return res.json({ ok: true, affected: docs.length })
  }

  if (action === 'owner') {
    if (!req.can('contacts.viewAll')) {
      return res.status(403).json({ error: 'You cannot reassign contacts to other people', permission: 'contacts.viewAll' })
    }
    await Contact.updateMany({ _id: { $in: contactIds } }, { $set: { owner: value || null } })
    await Task.updateMany({ contact: { $in: contactIds }, status: 'pending' }, { $set: { assignedTo: value || null } })
    await OutboxMessage.updateMany({ contact: { $in: contactIds }, status: 'queued' }, { $set: { assignedTo: value || null } })
    await Activity.insertMany(
      contacts.map((c) => ({ contact: c._id, company: c.company || null, type: 'owner_change', user: req.user._id, title: 'Owner changed (bulk)' }))
    )
    return res.json({ ok: true, affected: contactIds.length })
  }

  if (action === 'addTag' || action === 'removeTag') {
    if (!value) return res.status(400).json({ error: 'A tag is required' })
    const op = action === 'addTag' ? { $addToSet: { tags: value } } : { $pull: { tags: value } }
    await Contact.updateMany({ _id: { $in: contactIds } }, op)
    return res.json({ ok: true, affected: contactIds.length })
  }

  if (action === 'company') {
    if (!value) return res.status(400).json({ error: 'A company is required' })
    const company = await Company.findById(value)
    if (!company) return res.status(404).json({ error: 'Company not found' })
    await Contact.updateMany(
      { _id: { $in: contactIds } },
      { $set: { company: company._id, companyName: company.name } }
    )
    return res.json({ ok: true, affected: contactIds.length })
  }

  if (action === 'delete') {
    if (!req.can('contacts.delete')) {
      return res.status(403).json({ error: 'You do not have permission to delete contacts', permission: 'contacts.delete' })
    }
    await Promise.all([
      Activity.deleteMany({ contact: { $in: contactIds } }),
      Enrollment.deleteMany({ contact: { $in: contactIds } }),
      Task.deleteMany({ contact: { $in: contactIds } }),
      OutboxMessage.deleteMany({ contact: { $in: contactIds } }),
      Contact.deleteMany({ _id: { $in: contactIds } }),
    ])
    return res.json({ ok: true, affected: contactIds.length })
  }

  res.status(400).json({ error: `Unknown action "${action}"` })
})

/* ---- Duplicates and merging ---- */

router.get('/duplicates/scan', async (req, res) => {
  const groups = await findContactDuplicates({ limit: Number(req.query.limit) || 50 })
  res.json({
    groups,
    note: 'Email and LinkedIn matches are certain. Name matches are a suggestion — check before merging, because merging cannot be undone.',
  })
})

router.get('/:id/merge-preview/:loserId', async (req, res) => {
  try {
    res.json(await previewContactMerge({ survivorId: req.params.id, loserId: req.params.loserId }))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/:id/merge', requirePermission('records.merge'), async (req, res) => {
  try {
    const result = await mergeContacts({
      survivorId: req.params.id,
      loserId: req.body?.loserId,
      actorId: req.user._id,
    })
    res.json({
      ok: true,
      contact: result.survivor.toJSON(),
      filled: result.filled,
      moved: result.moved,
      inheritedSuppression: result.inheritedSuppression,
    })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

/* ---- CSV import ------------------------------------------------------
 * Two-step: POST /import/preview returns headers and a sample so the client
 * can map columns, then POST /import commits. Nothing is written on preview.
 * Company-level columns are applied to the resolved Company, not the person. */

function readCsv(buffer) {
  return parse(buffer, {
    columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true,
  })
}

/* Excel support. Detected by content, not just the file name: an .xlsx is a
 * zip archive (starts "PK"), the legacy .xls binary starts D0 CF 11 E0. */
function fileKind(file) {
  const b = file.buffer
  const name = String(file.originalname || '').toLowerCase()
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'xlsx'
  if (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls'
  if (name.endsWith('.xlsx')) return 'xlsx'
  if (name.endsWith('.xls')) return 'xls'
  return 'csv'
}

// An Excel cell can hold rich text, a hyperlink, a formula or a date. The
// importer wants the text a person would see in the cell.
function cellText(value) {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text || '').join('')
    if (value.hyperlink !== undefined) {
      const text = cellText(value.text).trim()
      const link = String(value.hyperlink || '').trim()
      // A LinkedIn column often shows "View profile" and hides the real URL,
      // so a web link wins over label text. Email links keep the visible
      // address, never the "mailto:" form.
      if (/^https?:\/\//i.test(link) && !/^https?:\/\//i.test(text)) return link
      return text || link.replace(/^mailto:/i, '')
    }
    if (value.result !== undefined) return cellText(value.result)
    if (value.text !== undefined) return cellText(value.text)
    if (value.error) return ''
    return ''
  }
  return String(value)
}

/* Column-name patterns used both to guess the mapping and, for Excel, to
 * find which row actually holds the headers. */
const HEADER_PATTERNS = {
  firstName: /^(first[\s_-]*name|fname|given)/i,
  lastName: /^(last[\s_-]*name|lname|surname|family)/i,
  email: /e[\s_-]?mail/i,
  phone: /^(phone|tel|direct)/i,
  mobile: /(mobile|cell)/i,
  title: /(title|position|role|job)/i,
  linkedinUrl: /(linked\s*in|li[\s_-]*url|profile[\s_-]*url)/i,
  location: /(location|city|country|region)/i,
  timezone: /(time\s*zone|timezone|tz)/i,
  companyName: /(company|organi[sz]ation|account|employer)/i,
  company_website: /(website|site|domain)/i,
  company_industry: /industry|vertical|sector/i,
  company_employeeCount: /(company size|employees|headcount)/i,
  company_linkedinUrl: /(company.*linked|linked.*company)/i,
  company_seatsNeeded: /(seats|fte|agents needed)/i,
  company_targetRoles: /(target roles|roles needed)/i,
  company_currentProvider: /(current provider|incumbent|existing vendor)/i,
  company_contractTiming: /(timing|timeline|renewal)/i,
  company_budgetRange: /budget/i,
  company_phone: /^(company|office|main|hq)[\s_-]*(phone|tel)/i,
  company_location: /^(company|hq)[\s_-]*(location|city)|headquarters/i,
  company_timezone: /^company[\s_-]*(time\s*zone|timezone|tz)/i,
  company_address: /address/i,
  tags: /^tags?$/i,
  notes: /(notes?|comment)/i,
}

// How much a row looks like a header row: recognised column names count
// most, other short labels a little. Emails, URLs and numbers count nothing —
// those are data, not headers.
function headerScore(values) {
  let recognised = 0
  let labels = 0
  for (const raw of values) {
    const v = String(raw || '').trim()
    if (!v || v.length > 60) continue
    if (/@|^https?:\/\/|^www\./i.test(v) || /^[\d\s()+.,:/-]+$/.test(v)) continue
    if (Object.values(HEADER_PATTERNS).some((rx) => rx.test(v))) recognised++
    else labels++
  }
  return { recognised, score: recognised * 3 + labels }
}

function sheetGrid(sheet) {
  const grid = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = []
    row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cellText(cell.value).trim() })
    for (let i = 0; i < values.length; i++) if (values[i] === undefined) values[i] = ''
    if (values.some((v) => v)) grid.push({ rowNumber: row.number, values })
  })
  return grid
}

/* Pick the header row among the first rows of a sheet. Spreadsheets often
 * open with a title ("Leads – October"), a date or a blank line before the
 * real column names, which made row 1 the wrong choice. */
function findHeader(grid) {
  let best = { index: 0, recognised: 0, score: -1 }
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const { recognised, score } = headerScore(grid[i].values)
    if (score > best.score) best = { index: i, recognised, score }
  }
  return best
}

async function readXlsx(buffer, wantedSheet) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  // Visible sheets with data, each with its own best header row.
  const candidates = workbook.worksheets
    .filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden')
    .map((ws) => {
      const grid = sheetGrid(ws)
      const header = grid.length ? findHeader(grid) : null
      return { ws, grid, header, dataRows: header ? grid.length - header.index - 1 : 0 }
    })
    .filter((c) => c.grid.length)
  if (!candidates.length) return { rows: [], meta: { sheets: [], sheet: '', headerRow: null } }

  /* Which sheet: the one the user picked; otherwise the sheet that was open
     when the file was saved (what "Save as CSV" would have exported), if it
     looks like a contact list; otherwise the most contact-list-like sheet.
     Picking simply the first sheet broke workbooks that lead with a summary
     or instructions tab. */
  const activeIndex = workbook.views?.[0]?.activeTab
  const active = activeIndex !== undefined ? workbook.worksheets[activeIndex] : null
  let chosen = wantedSheet && candidates.find((c) => c.ws.name === wantedSheet)
  if (!chosen && active) {
    const c = candidates.find((x) => x.ws === active)
    if (c && c.header.recognised > 0) chosen = c
  }
  if (!chosen) {
    chosen = [...candidates].sort((a, b) =>
      (b.header.recognised - a.header.recognised) || (b.dataRows - a.dataRows))[0]
  }

  // Blank headers get a name, repeated headers get a suffix, so no column
  // silently overwrites another.
  const headerValues = chosen.grid[chosen.header.index].values
  const width = Math.max(headerValues.length, ...chosen.grid.map((r) => r.values.length))
  const seen = new Map()
  const headers = []
  for (let i = 0; i < width; i++) {
    let name = (headerValues[i] || '').trim() || `Column ${i + 1}`
    const n = (seen.get(name) || 0) + 1
    seen.set(name, n)
    if (n > 1) name = `${name} (${n})`
    headers.push(name)
  }

  const rows = chosen.grid.slice(chosen.header.index + 1).map(({ values }) => {
    const row = {}
    headers.forEach((h, i) => { row[h] = values[i] || '' })
    return row
  })

  return {
    rows,
    meta: {
      sheets: candidates.map((c) => ({ name: c.ws.name, rows: Math.max(0, c.dataRows) })),
      sheet: chosen.ws.name,
      headerRow: chosen.grid[chosen.header.index].rowNumber,
      // In sheet order. Object.keys would move headers like "2026" first.
      headers,
    },
  }
}

/* One entry point for every accepted format. Returns plain row objects keyed
 * by header, exactly like the CSV reader, so the rest of the import is shared.
 * `meta` describes the Excel sheet that was read (null for CSV). */
async function readRows(file, sheet) {
  const kind = fileKind(file)
  if (kind === 'xls') {
    const err = new Error('Old .xls files are not supported. In Excel, use File → Save As → Excel Workbook (.xlsx) or CSV, then upload that.')
    err.status = 400
    throw err
  }
  if (kind === 'xlsx') return readXlsx(file.buffer, sheet)
  return { rows: readCsv(file.buffer), meta: null }
}

const IMPORT_FIELDS = [
  ...EDITABLE,
  'companyName',
  ...COMPANY_FIELDS.map((f) => `company_${f}`),
]

/* The names each field goes by: the label shown on the mapping screen first,
 * then common spellings in exported lists. A column whose name is exactly one
 * of these maps without any guessing — so a file using the CRM's own labels
 * ("Company location", "Seats needed") always maps itself. */
const FIELD_NAMES = {
  firstName: ['First name', 'First', 'Given name', 'fname'],
  lastName: ['Last name', 'Last', 'Surname', 'Family name', 'lname'],
  title: ['Job title', 'Title', 'Position', 'Role', 'Designation'],
  email: ['Work email', 'Email', 'Email address', 'E-mail', 'Business email'],
  phone: ['Phone', 'Phone number', 'Direct phone', 'Direct dial', 'Telephone'],
  mobile: ['Mobile', 'Mobile phone', 'Cell', 'Cell phone'],
  linkedinUrl: ['LinkedIn URL', 'LinkedIn', 'Personal LinkedIn URL', 'LinkedIn profile', 'Profile URL'],
  location: ['Location', 'City', 'Contact location'],
  timezone: ['Timezone', 'Time zone', 'Their timezone'],
  source: ['Source', 'Lead source'],
  notes: ['Notes', 'Note', 'Comments'],
  tags: ['Tags', 'Tag'],
  companyName: ['Company name', 'Company', 'Organization', 'Organisation', 'Account', 'Account name', 'Business name'],
  company_website: ['Company website', 'Website', 'Company URL', 'Domain', 'Web site'],
  company_industry: ['Industry', 'Company industry', 'Vertical', 'Sector'],
  company_employeeCount: ['Company size', 'Employees', 'Employee count', 'Headcount', '# Employees'],
  company_linkedinUrl: ['Company LinkedIn', 'Company LinkedIn URL', 'Company LinkedIn page'],
  company_phone: ['Company phone', 'Main phone', 'Office phone', 'Company phone number'],
  company_location: ['Company location', 'Company city', 'HQ', 'HQ location', 'Headquarters'],
  company_timezone: ['Company timezone', 'Company time zone'],
  company_address: ['Company address', 'Address', 'Street address', 'Business address'],
  company_seatsNeeded: ['Seats needed', 'Seats', 'FTE', 'Agents needed'],
  company_targetRoles: ['Target roles', 'Roles needed'],
  company_currentProvider: ['Current provider', 'Incumbent', 'Existing vendor'],
  company_contractTiming: ['Contract timing', 'Timing', 'Renewal date'],
  company_budgetRange: ['Budget range', 'Budget'],
}

// "Company  Location", "company_location" and "COMPANY-LOCATION:" are one name.
function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim()
}

/* Suggest a field for each column. Three passes, each only for columns and
 * fields still free, so one column is never used twice:
 *   1. the column name is exactly a known name for a field;
 *   2. a column starting with "Company …" tries the company fields' patterns
 *      (otherwise "Company location" was taken by the person's Location);
 *   3. everything else tries the patterns in order. */
function guessMapping(headers) {
  const guesses = {}
  const usedHeaders = new Set()
  const assign = (field, header) => {
    if (guesses[field] || usedHeaders.has(header)) return false
    guesses[field] = header
    usedHeaders.add(header)
    return true
  }

  const byName = new Map()
  for (const [field, names] of Object.entries(FIELD_NAMES)) {
    for (const n of [field, ...names]) {
      const key = normHeader(n)
      if (!byName.has(key)) byName.set(key, field)
    }
  }
  for (const header of headers) {
    const field = byName.get(normHeader(header))
    if (field) assign(field, header)
  }

  const entries = Object.entries(HEADER_PATTERNS)
  const companyEntries = entries.filter(([f]) => f.startsWith('company_') || f === 'companyName')
  for (const header of headers) {
    if (usedHeaders.has(header)) continue
    const list = /^(company|organi[sz]ation|account|business)\b/i.test(header.trim())
      ? [...companyEntries, ...entries]
      : entries
    for (const [field, rx] of list) {
      if (rx.test(header) && assign(field, header)) break
    }
  }

  // The company LinkedIn column must not steal the personal one.
  if (guesses.linkedinUrl && guesses.linkedinUrl === guesses.company_linkedinUrl) {
    delete guesses.company_linkedinUrl
  }
  return guesses
}

router.post('/import/preview', requirePermission('contacts.import'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  let rows, meta
  try {
    ({ rows, meta } = await readRows(req.file, req.body?.sheet))
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    return res.status(400).json({ error: `Could not read that file: ${err.message}` })
  }
  if (!rows.length) {
    return res.status(400).json({
      error: meta?.sheet
        ? `The sheet "${meta.sheet}" has no data rows under its headers.`
        : 'That file has no data rows',
    })
  }

  const headers = meta?.headers || Object.keys(rows[0])
  const guesses = guessMapping(headers)

  res.json({
    headers,
    rowCount: rows.length,
    sample: rows.slice(0, 5),
    suggestedMapping: guesses,
    importableFields: IMPORT_FIELDS,
    // Excel only: which sheet and header row were used, and the other sheets.
    sheet: meta?.sheet || null,
    sheets: meta?.sheets || [],
    headerRow: meta?.headerRow || null,
  })
})

router.post('/import', requirePermission('contacts.import'), upload.single('file'), rebindAudit, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  let mapping, options
  try {
    mapping = JSON.parse(req.body.mapping || '{}')
    options = JSON.parse(req.body.options || '{}')
  } catch {
    return res.status(400).json({ error: 'Invalid mapping' })
  }

  let rows
  try {
    // Same sheet the preview used, so the mapping lines up with the columns.
    ({ rows } = await readRows(req.file, options.sheet))
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    return res.status(400).json({ error: `Could not read that file: ${err.message}` })
  }
  if (rows.length > 25000) {
    return res.status(400).json({ error: 'Import at most 25,000 rows per file' })
  }

  const owner = req.can('contacts.viewAll') && options.owner ? options.owner : req.user._id
  const source = options.source || 'csv_import'
  const tag = (options.tag || '').trim()
  const onDuplicate = options.onDuplicate === 'update' ? 'update' : 'skip'

  /* Optional: put the newly created contacts into a campaign at step 1.
     Rows that matched an existing contact are left where they are. */
  let campaign = null
  if (options.campaignId) {
    if (!/^[0-9a-f]{24}$/i.test(String(options.campaignId))) return res.status(400).json({ error: 'Unknown campaign' })
    campaign = await Campaign.findById(options.campaignId).select('name stages').lean()
    if (!campaign) return res.status(404).json({ error: 'That campaign no longer exists' })
    if (!canUseCampaign(req.user, campaign._id)) {
      return res.status(403).json({ error: `You cannot add contacts to "${campaign.name}"` })
    }
    if (!campaign.stages?.length) return res.status(400).json({ error: `"${campaign.name}" has no steps yet` })
  }
  const toEnroll = []

  const lostStatus = await roleStatus('lost')
  const createdStatus = await roleStatus('created')
  const suppressions = await Suppression.find().lean()
  const suppressedEmails = new Set(suppressions.filter((s) => s.email).map((s) => s.email))
  const suppressedDomains = new Set(suppressions.filter((s) => s.domain).map((s) => s.domain))

  const result = {
    total: rows.length, created: 0, updated: 0, skipped: 0,
    suppressed: 0, companiesCreated: 0, errors: [],
    // Rows whose email cell held text that is not an address ("No Email Address").
    invalidEmails: 0,
  }
  const seenEmail = new Set()
  const seenLinkedIn = new Set()
  const seenNameCo = new Set()
  const companiesBefore = await Company.countDocuments()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const doc = {}
    const companyExtra = {}
    let companyName = ''
    let badEmail = false

    for (const [field, header] of Object.entries(mapping)) {
      if (!header) continue
      const raw = row[header]
      if (raw === undefined || raw === null || String(raw).trim() === '') continue
      const value = String(raw).trim()

      if (field === 'companyName') { companyName = value; continue }
      if (field.startsWith('company_')) {
        const key = field.slice('company_'.length)
        if (!COMPANY_FIELDS.includes(key)) continue
        if (key === 'seatsNeeded') {
          const n = parseInt(value.replace(/[^0-9]/g, ''), 10)
          if (Number.isFinite(n)) companyExtra.seatsNeeded = n
        } else companyExtra[key] = value
        continue
      }
      if (!EDITABLE.includes(field)) continue
      if (field === 'tags') doc.tags = value.split(/[;,|]/).map((t) => t.trim()).filter(Boolean)
      else if (field === 'email') {
        /* Only a real address is kept. Text like "No Email Address" or "N/A"
           used to be stored as the email, so every such row looked like a
           duplicate of the first and was skipped. */
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) doc.email = value.toLowerCase()
        else badEmail = true
      } else if ((field === 'phone' || field === 'mobile') && !/\d/.test(value)) {
        // "Not publicly verified" and similar are notes, not numbers.
        continue
      } else doc[field] = value
    }

    if (!doc.firstName && !doc.lastName && !companyName && !doc.email) {
      result.skipped++
      if (result.errors.length < 50) result.errors.push({ row: i + 2, error: 'No name, company or email' })
      continue
    }

    if (tag) doc.tags = [...new Set([...(doc.tags || []), tag])]
    doc.source = source
    doc.owner = owner
    if (createdStatus && !doc.status) doc.status = createdStatus

    if (badEmail) result.invalidEmails = (result.invalidEmails || 0) + 1
    if (doc.email && seenEmail.has(doc.email)) { result.skipped++; continue }
    /* No email and no LinkedIn URL: the same first + last name at the same
       company is the same person (inside this file, and in the CRM below). */
    // A row with no name either (company only) is matched on company + phone.
    const hasName = !!(doc.firstName || doc.lastName)
    const phoneDigits = String(doc.phone || doc.mobile || '').replace(/\D/g, '')
    const nameKey = !doc.email && !doc.linkedinUrl && companyName && (hasName || phoneDigits)
      ? (hasName
        ? [doc.firstName, doc.lastName, companyName].map((v) => String(v || '').trim().toLowerCase()).join('|')
        : `phone:${phoneDigits}|${companyName.trim().toLowerCase()}`)
      : ''
    if (nameKey && seenNameCo.has(nameKey)) { result.skipped++; continue }
    if (doc.linkedinUrl && seenLinkedIn.has(doc.linkedinUrl)) { result.skipped++; continue }

    const domain = domainFromEmail(doc.email)
    // On the do-not-contact list: import them already blocked, as Lost.
    if ((doc.email && suppressedEmails.has(doc.email)) || (domain && suppressedDomains.has(domain))) {
      doc.doNotContact = true
      if (lostStatus) {
        doc.status = lostStatus
        doc.lostReason = REASON_UNSUBSCRIBED
      }
      result.suppressed++
    }

    try {
      const company = await resolveCompany({
        name: companyName,
        email: doc.email,
        website: companyExtra.website,
        extra: companyExtra,
        ownerId: owner,
        source,
      })
      if (company) {
        doc.company = company._id
        doc.companyName = company.name
        // Backfill company detail we learned from this row.
        const patch = {}
        for (const [k, v] of Object.entries(companyExtra)) {
          if (v !== undefined && v !== '' && !company[k]) patch[k] = v
        }
        if (Object.keys(patch).length) await Company.updateOne({ _id: company._id }, { $set: patch })
      } else if (companyName) {
        doc.companyName = companyName
      }

      const dupeOr = []
      if (doc.email) dupeOr.push({ email: doc.email })
      if (doc.linkedinUrl) dupeOr.push({ linkedinUrl: doc.linkedinUrl })
      let existing = dupeOr.length ? await Contact.findOne({ $or: dupeOr }) : null
      if (!existing && nameKey) {
        const exact = (v) => new RegExp(`^${escapeRegex(String(v || '').trim())}$`, 'i')
        const atCompany = [...(doc.company ? [{ company: doc.company }] : []), { companyName: exact(companyName) }]
        existing = await Contact.findOne(hasName
          ? { firstName: exact(doc.firstName), lastName: exact(doc.lastName), $or: atCompany }
          : {
              $and: [
                { $or: atCompany },
                { $or: [{ phone: exact(doc.phone || doc.mobile) }, { mobile: exact(doc.phone || doc.mobile) }] },
                { $or: [{ firstName: { $in: [null, ''] } }, { firstName: { $exists: false } }] },
              ],
            })
      }

      if (existing) {
        if (onDuplicate === 'update') {
          for (const [k, v] of Object.entries(doc)) {
            if (k === 'owner' && !options.reassignOwner) continue
            // An update never resets an existing contact back to "New".
            if (k === 'status' && v === createdStatus) continue
            if (k === 'tags') { existing.tags = [...new Set([...existing.tags, ...v])]; continue }
            existing[k] = v
          }
          await existing.save()
          result.updated++
        } else {
          result.skipped++
        }
      } else {
        const contact = await Contact.create(doc)
        if (campaign && !contact.doNotContact) toEnroll.push(contact._id)
        await Activity.create({
          contact: contact._id,
          company: contact.company || null,
          type: 'contact_imported',
          user: req.user._id,
          title: `Imported from ${req.file.originalname}`,
        })
        result.created++
      }
      if (doc.email) seenEmail.add(doc.email)
      if (doc.linkedinUrl) seenLinkedIn.add(doc.linkedinUrl)
      if (nameKey) seenNameCo.add(nameKey)
    } catch (err) {
      result.skipped++
      if (result.errors.length < 50) result.errors.push({ row: i + 2, error: err.message })
    }
  }

  result.companiesCreated = (await Company.countDocuments()) - companiesBefore
  if (campaign) {
    result.campaign = { id: campaign._id, name: campaign.name, enrolled: 0, notEnrolled: 0, errors: [] }
    for (const id of toEnroll) {
      try {
        const r = await enroll({ contactId: id, campaignId: campaign._id, actorId: req.user._id })
        if (r.created) result.campaign.enrolled++
      } catch (err) {
        result.campaign.notEnrolled++
        if (result.campaign.errors.length < 10) result.campaign.errors.push(err.message)
      }
    }
  }
  res.json({ result })
})

/* ---- Export ---- */
router.get('/export/csv', requirePermission('contacts.export'), async (req, res) => {
  const filter = { ...ownerScope(req) }
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') }
  const contacts = await Contact.find(filter)
    .limit(25000).populate('owner', 'name').populate('company', 'name domain industry seatsNeeded').lean()

  const cols = ['firstName', 'lastName', 'title', 'email', 'phone', 'mobile',
    'linkedinUrl', 'location', 'timezone', 'status', 'source', 'tags', 'doNotContact']
  const esc = (v) => {
    const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [[...cols, 'company', 'companyDomain', 'industry', 'seatsNeeded', 'owner'].join(',')]
  for (const c of contacts) {
    lines.push([
      ...cols.map((k) => esc(c[k])),
      esc(c.company?.name || c.companyName),
      esc(c.company?.domain),
      esc(c.company?.industry),
      esc(c.company?.seatsNeeded),
      esc(c.owner?.name),
    ].join(','))
  }

  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"')
  res.send(lines.join('\n'))
})

/* ---- Pause / resume a contact's flow by hand (G1 follow-up) ---- */
router.post('/:id/enrollments/:enrollmentId/:action(pause|resume)', async (req, res) => {
  const contact = await Contact.findOne({ _id: req.params.id, ...ownerScope(req) })
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  const enrollment = await Enrollment.findOne({ _id: req.params.enrollmentId, contact: contact._id })
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })
  if (req.params.action === 'pause') {
    const ok = await pauseEnrollment({ enrollment, reason: 'manual', actorId: req.user._id })
    if (!ok) return res.status(400).json({ error: 'Only a running flow can be paused' })
    return res.json({ ok: true })
  }
  res.json(await resumeEnrollment({ enrollment, actorId: req.user._id }))
})

module.exports = router
