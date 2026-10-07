const express = require('express')
const {
  Company, Contact, Activity, Enrollment, Task, Deal,
} = require('../db')
const { requireAuth, requirePermission, ownerScope } = require('../middleware/auth')
const { logActivity } = require('../lib/engine')
const { resolveCompany, domainFromWebsite, normalizeName } = require('../lib/companies')
const customFields = require('../lib/custom-fields')
const { findCompanyDuplicates, mergeCompanies, previewCompanyMerge } = require('../lib/dedupe')

const router = express.Router()
router.use(requireAuth)

/* Companies are visible to everyone — knowing that a colleague is already
 * working Acme is the whole point of having the object. Contact scoping is
 * unchanged: a rep still only opens contacts they own, and the company page
 * says plainly how many it is not showing them. */

const EDITABLE = [
  'name', 'domain', 'website', 'industry', 'employeeCount', 'phone',
  'linkedinUrl', 'location', 'timezone', 'address', 'description',
  'currentProvider', 'seatsNeeded', 'targetRoles', 'contractTiming',
  'budgetRange', 'tags', 'notes', 'source',
]

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* The list filters, shared by the list and by "delete everything matching".
 * Values are forced to strings so a crafted query cannot smuggle in a Mongo
 * operator ({ $ne: ... }) — that matters most for a delete. */
function buildListFilter(src = {}) {
  const str = (v) => (v === undefined || v === null ? '' : String(Array.isArray(v) ? v[0] : v)).trim()
  const filter = {}
  if (str(src.industry)) filter.industry = str(src.industry)
  if (str(src.owner)) {
    // A malformed owner id matches nothing — never "ignore it", which on a
    // bulk delete would quietly widen the filter to every owner.
    if (/^[0-9a-f]{24}$/i.test(str(src.owner))) filter.owner = str(src.owner)
    else filter._id = { $in: [] }
  }
  if (str(src.tag)) filter.tags = str(src.tag)

  const q = str(src.q)
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i')
    filter.$or = [{ name: rx }, { domain: rx }, { website: rx }, { industry: rx }]
  }
  return filter
}

const BULK_DELETE_MAX = 5000

/* Delete several companies at once: either the ids ticked on the page, or
 * every company matching the current filters. Same rules as deleting one:
 * a company with deals is skipped (a deal cannot exist without its company),
 * and contacts are detached and kept, never deleted.
 * Registered before the '/:id' routes so 'bulk-delete' is never read as an id. */
router.post('/bulk-delete', requirePermission('contacts.delete'), async (req, res) => {
  const { ids, allMatching, filters } = req.body || {}

  let filter
  if (allMatching) {
    filter = buildListFilter(filters || {})
  } else {
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'No companies selected' })
    }
    const clean = [...new Set(ids.map(String))].filter((id) => /^[0-9a-f]{24}$/i.test(id))
    if (!clean.length) return res.status(400).json({ error: 'No valid companies selected' })
    filter = { _id: { $in: clean } }
  }

  const targets = await Company.find(filter).select('_id name').limit(BULK_DELETE_MAX + 1).lean()
  if (targets.length > BULK_DELETE_MAX) {
    return res.status(400).json({
      error: `That would delete more than ${BULK_DELETE_MAX.toLocaleString()} companies at once. Narrow the filter and run it in parts.`,
    })
  }
  if (!targets.length) return res.json({ deleted: 0, detachedContacts: 0, skipped: 0, skippedNames: [] })

  const targetIds = targets.map((t) => t._id)
  const withDeals = new Set(
    (await Deal.distinct('company', { company: { $in: targetIds } })).map(String)
  )
  const deletable = targets.filter((t) => !withDeals.has(String(t._id))).map((t) => t._id)
  const skipped = targets.filter((t) => withDeals.has(String(t._id)))

  let detachedContacts = 0
  let deleted = 0
  if (deletable.length) {
    const detach = await Contact.updateMany({ company: { $in: deletable } }, { $set: { company: null } })
    detachedContacts = detach.modifiedCount || 0
    const result = await Company.deleteMany({ _id: { $in: deletable } })
    deleted = result.deletedCount || 0
  }

  res.json({
    deleted,
    detachedContacts,
    skipped: skipped.length,
    // Enough names to act on, without sending thousands back.
    skippedNames: skipped.slice(0, 20).map((t) => t.name),
  })
})

router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
  const filter = buildListFilter(req.query)

  const sortField = ['createdAt', 'lastActivityAt', 'name', 'seatsNeeded'].includes(req.query.sort)
    ? req.query.sort
    : 'lastActivityAt'
  const sortDir = req.query.dir === 'asc' ? 1 : -1

  const [items, total] = await Promise.all([
    Company.find(filter)
      .sort({ [sortField]: sortDir })
      .skip((page - 1) * limit).limit(limit)
      .populate('owner', 'name email')
      .lean(),
    Company.countDocuments(filter),
  ])

  // Contact counts for the page in one aggregate, not one query per row.
  const counts = await Contact.aggregate([
    { $match: { company: { $in: items.map((i) => i._id) } } },
    { $group: { _id: '$company', n: { $sum: 1 } } },
  ])
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]))
  for (const item of items) item.contactCount = countBy.get(String(item._id)) || 0
  await customFields.decorate('company', items)

  res.json({
    items, total, page, limit, pages: Math.ceil(total / limit),
    customFields: await customFields.getFields('company'),
  })
})

router.get('/:id', async (req, res) => {
  const company = await Company.findById(req.params.id).populate('owner', 'name email').lean()
  if (!company) return res.status(404).json({ error: 'Company not found' })
  await customFields.decorate('company', company)

  const scope = ownerScope(req)
  const [visibleContacts, totalContacts, activities] = await Promise.all([
    Contact.find({ company: company._id, ...scope })
      .sort({ lastActivityAt: -1 }).limit(200)
      .populate('owner', 'name')
      .lean({ virtuals: true }),
    Contact.countDocuments({ company: company._id }),
    Activity.find({ company: company._id })
      .sort({ createdAt: -1 }).limit(200)
      .populate('user', 'name').populate('contact', 'firstName lastName')
      .populate('campaign', 'name').lean(),
  ])

  const contactIds = await Contact.find({ company: company._id }).distinct('_id')
  const [activeEnrollments, openTasks, deals] = await Promise.all([
    Enrollment.find({ contact: { $in: contactIds }, status: 'active' })
      .populate('campaign', 'name stages').populate('contact', 'firstName lastName').lean(),
    Task.countDocuments({ contact: { $in: contactIds }, status: 'pending' }),
    // Every deal, open and closed — the company page is the account history.
    Deal.find({ company: company._id })
      .sort({ status: 1, expectedCloseDate: 1 })
      .populate('owner', 'name').populate('primaryContact', 'firstName lastName')
      .lean(),
  ])

  res.json({
    company,
    contacts: visibleContacts,
    totalContacts,
    // Reps only see their own contacts; say so rather than silently hiding them.
    hiddenContacts: Math.max(0, totalContacts - visibleContacts.length),
    activities,
    activeEnrollments: activeEnrollments.map((e) => ({
      id: e._id,
      contact: e.contact,
      campaignName: e.campaign?.name || '(deleted)',
      stageName: e.campaign?.stages?.[e.currentStageIndex]?.name || '',
      channel: e.campaign?.stages?.[e.currentStageIndex]?.channel || '',
      dueAt: e.dueAt,
    })),
    openTasks,
    deals,
    customFields: await customFields.getFields('company'),
    dealTotals: {
      open: deals.filter((d) => d.status === 'open').length,
      won: deals.filter((d) => d.status === 'won').length,
      lost: deals.filter((d) => d.status === 'lost').length,
      openTcvUsd: Math.round(deals.filter((d) => d.status === 'open').reduce((s, d) => s + (d.tcvUsd || 0), 0) * 100) / 100,
      wonTcvUsd: Math.round(deals.filter((d) => d.status === 'won').reduce((s, d) => s + (d.tcvUsd || 0), 0) * 100) / 100,
    },
  })
})

router.post('/', requirePermission('contacts.edit'), async (req, res) => {
  const body = req.body || {}
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'A company name is required' })
  }
  const doc = {}
  for (const key of EDITABLE) if (body[key] !== undefined) doc[key] = body[key]
  if (body.customFields) {
    const { values, errors } = await customFields.applyValues('company', {}, body.customFields)
    if (errors.length) return res.status(400).json({ error: errors.join('. ') })
    doc.customFields = values
  }
  doc.owner = req.can('contacts.viewAll') && body.owner ? body.owner : req.user._id
  doc.domain = (doc.domain || domainFromWebsite(doc.website) || '').toLowerCase().trim()

  if (doc.domain) {
    const clash = await Company.findOne({ domain: doc.domain }).lean()
    if (clash) {
      return res.status(409).json({
        error: `${clash.name} already uses the domain ${doc.domain}`,
        companyId: clash._id,
      })
    }
  }
  // Warn on a same-name match rather than blocking — two genuinely different
  // companies can share a name, and the caller can confirm.
  if (!body.allowDuplicateName) {
    const normalized = normalizeName(doc.name)
    const candidates = await Company.find({
      name: new RegExp(`^${escapeRegex(String(doc.name).slice(0, 3))}`, 'i'),
    }).limit(50).lean()
    const hit = candidates.find((c) => normalizeName(c.name) === normalized)
    if (hit) {
      return res.status(409).json({
        error: `A company called "${hit.name}" already exists`,
        companyId: hit._id,
        canForce: true,
      })
    }
  }

  const company = await Company.create(doc)
  await logActivity({
    company: company._id,
    type: 'company_created',
    user: req.user._id,
    title: 'Company created',
  })
  res.status(201).json({ company })
})

router.put('/:id', requirePermission('contacts.edit'), async (req, res) => {
  const company = await Company.findById(req.params.id)
  if (!company) return res.status(404).json({ error: 'Company not found' })

  const body = req.body || {}
  const changes = []
  for (const key of EDITABLE) {
    if (body[key] !== undefined && String(company[key] ?? '') !== String(body[key] ?? '')) {
      company[key] = body[key]
      changes.push(key)
    }
  }
  if (body.customFields !== undefined) {
    const { values, errors } = await customFields.applyValues('company', company.customFields, body.customFields)
    if (errors.length) return res.status(400).json({ error: errors.join('. ') })
    company.customFields = values
    company.markModified('customFields')
  }
  if (body.owner !== undefined && req.can('contacts.viewAll')) company.owner = body.owner || null

  if (body.domain !== undefined) {
    const domain = String(body.domain || '').toLowerCase().trim()
    if (domain) {
      const clash = await Company.findOne({ domain, _id: { $ne: company._id } }).lean()
      if (clash) return res.status(409).json({ error: `${clash.name} already uses that domain` })
    }
    company.domain = domain
  }

  company.lastActivityAt = new Date()
  await company.save()

  // Keep the denormalised name on contacts in step, or search breaks quietly.
  if (changes.includes('name')) {
    await Contact.updateMany({ company: company._id }, { $set: { companyName: company.name } })
  }
  if (changes.length) {
    await logActivity({
      company: company._id, type: 'note', user: req.user._id,
      title: 'Company details updated', body: `Changed: ${changes.join(', ')}`,
    })
  }
  res.json({ company })
})

router.delete('/:id', requirePermission('contacts.delete'), async (req, res) => {
  const company = await Company.findById(req.params.id)
  if (!company) return res.status(404).json({ error: 'Company not found' })

  const dealCount = await Deal.countDocuments({ company: company._id })
  if (dealCount > 0) {
    return res.status(409).json({
      error: `${dealCount} deal${dealCount === 1 ? '' : 's'} belong to this company. A deal cannot exist without one, so delete or move those first.`,
      dealCount,
    })
  }

  const contactCount = await Contact.countDocuments({ company: company._id })
  if (contactCount > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `${contactCount} contact${contactCount === 1 ? '' : 's'} still belong to this company.`,
      contactCount,
      hint: 'Pass force=true to detach them and delete the company. The contacts themselves are kept.',
    })
  }
  // Detach rather than cascade — deleting a company must never delete people.
  await Contact.updateMany({ company: company._id }, { $set: { company: null } })
  await Company.deleteOne({ _id: company._id })
  res.json({ ok: true, detached: contactCount })
})

/* Attach an existing contact to this company, or create one on it. */
router.post('/:id/contacts', requirePermission('contacts.edit'), async (req, res) => {
  const company = await Company.findById(req.params.id)
  if (!company) return res.status(404).json({ error: 'Company not found' })

  const { contactId } = req.body || {}
  if (contactId) {
    const contact = await Contact.findOne({ _id: contactId, ...ownerScope(req) })
    if (!contact) return res.status(404).json({ error: 'Contact not found' })
    contact.company = company._id
    contact.companyName = company.name
    await contact.save()
    await logActivity({
      contact: contact._id, company: company._id, type: 'note', user: req.user._id,
      title: `Linked to ${company.name}`,
    })
    return res.json({ contact: contact.toJSON() })
  }

  const { firstName, lastName, email, title, phone, linkedinUrl } = req.body || {}
  if (!firstName && !lastName && !email) {
    return res.status(400).json({ error: 'Give the contact a name or an email' })
  }
  const contact = await Contact.create({
    firstName: firstName || '', lastName: lastName || '', email: email || '',
    title: title || '', phone: phone || '', linkedinUrl: linkedinUrl || '',
    company: company._id, companyName: company.name,
    owner: req.user._id, source: 'manual',
    timezone: company.timezone || '', location: company.location || '',
  })
  await logActivity({
    contact: contact._id, company: company._id, type: 'contact_created',
    user: req.user._id, title: `Contact created on ${company.name}`,
  })
  res.status(201).json({ contact: contact.toJSON() })
})

/* ---- Duplicates and merging ---- */

router.get('/duplicates/scan', async (req, res) => {
  const groups = await findCompanyDuplicates({ limit: Number(req.query.limit) || 50 })
  res.json({
    groups,
    note: 'A shared email domain is conclusive. A name match is a suggestion — check before merging, because merging cannot be undone.',
  })
})

router.get('/:id/merge-preview/:loserId', async (req, res) => {
  try {
    res.json(await previewCompanyMerge({ survivorId: req.params.id, loserId: req.params.loserId }))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/:id/merge', requirePermission('records.merge'), async (req, res) => {
  try {
    const result = await mergeCompanies({
      survivorId: req.params.id,
      loserId: req.body?.loserId,
      actorId: req.user._id,
    })
    res.json({ ok: true, company: result.survivor, filled: result.filled, moved: result.moved })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

/* Lightweight picker feed for company selectors. */
router.get('/search/quick', async (req, res) => {
  const q = (req.query.q || '').trim()
  const filter = q
    ? { $or: [{ name: new RegExp(escapeRegex(q), 'i') }, { domain: new RegExp(escapeRegex(q), 'i') }] }
    : {}
  const items = await Company.find(filter).select('name domain industry').sort({ name: 1 }).limit(20).lean()
  res.json({ items })
})

module.exports = router
