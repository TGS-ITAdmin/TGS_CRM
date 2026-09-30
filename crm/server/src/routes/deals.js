const express = require('express')
const { Deal, Company, Contact, Activity, Quote, Settings, FORECAST_CATEGORIES } = require('../db')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { logActivity } = require('../lib/engine')
const { recalcDeal, getSettings, currencyList, unknownCurrencies } = require('../lib/money')
const { stageList, stageMeta, changeStage, createDeal } = require('../lib/deals')
const { resolveCompany } = require('../lib/companies')
const customFields = require('../lib/custom-fields')

const router = express.Router()
router.use(requireAuth)

/* Deal visibility differs from contacts by design: everyone sees every deal so
 * two reps cannot unknowingly work the same company, but only the owner (or an
 * admin) can change one. */
function canEdit(req, deal) {
  return req.can('deals.editAny') || String(deal.owner) === String(req.user._id)
}
function requireOwner(req, res, deal) {
  if (canEdit(req, deal)) return true
  res.status(403).json({ error: 'Only the deal owner or an admin can change this deal' })
  return false
}

const EDITABLE = [
  'name', 'primaryContact', 'contacts', 'probability', 'forecastCategory',
  'currency', 'pricingMode', 'amount', 'termMonths', 'expectedCloseDate',
  'source', 'notes', 'tags', 'lostReason', 'closedNotes',
]

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const POPULATE = [
  { path: 'company', select: 'name domain industry seatsNeeded targetRoles' },
  { path: 'primaryContact', select: 'firstName lastName email phone title' },
  { path: 'owner', select: 'name email' },
]

/* ---- Meta: everything the deal UI needs to render ---- */
router.get('/meta', async (req, res) => {
  const settings = await getSettings()
  res.json({
    stages: stageList(settings),
    currencies: currencyList(settings),
    reportingCurrency: settings.reportingCurrency || 'USD',
    forecastCategories: FORECAST_CATEGORIES,
    lostReasons: settings.lostReasons || [],
  })
})

/* ---- List ---- */
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50))
  const filter = {}

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') }
  else if (req.query.includeClosed !== 'true') filter.status = 'open'
  if (req.query.stage) filter.stage = { $in: String(req.query.stage).split(',') }
  if (req.query.owner) filter.owner = req.query.owner
  if (req.query.company) filter.company = req.query.company
  if (req.query.forecastCategory) filter.forecastCategory = { $in: String(req.query.forecastCategory).split(',') }
  if (req.query.tag) filter.tags = req.query.tag
  if (req.query.closeFrom || req.query.closeTo) {
    filter.expectedCloseDate = {}
    if (req.query.closeFrom) filter.expectedCloseDate.$gte = new Date(req.query.closeFrom)
    if (req.query.closeTo) filter.expectedCloseDate.$lte = new Date(req.query.closeTo)
  }

  const q = (req.query.q || '').trim()
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i')
    const companyIds = await Company.find({ name: rx }).distinct('_id')
    filter.$or = [{ name: rx }, ...(companyIds.length ? [{ company: { $in: companyIds } }] : [])]
  }

  const sortable = ['expectedCloseDate', 'tcvUsd', 'mrrUsd', 'createdAt', 'lastActivityAt', 'name', 'probability']
  const sortField = sortable.includes(req.query.sort) ? req.query.sort : 'expectedCloseDate'
  const sortDir = req.query.dir === 'asc' ? 1 : -1

  const [items, total, totals] = await Promise.all([
    Deal.find(filter).sort({ [sortField]: sortDir }).skip((page - 1) * limit).limit(limit)
      .populate(POPULATE).lean(),
    Deal.countDocuments(filter),
    Deal.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          tcvUsd: { $sum: '$tcvUsd' },
          mrrUsd: { $sum: '$mrrUsd' },
          weightedUsd: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$status', 'open'] }, { $ne: ['$forecastCategory', 'omitted'] }] },
                { $multiply: ['$tcvUsd', { $divide: ['$probability', 100] }] },
                0,
              ],
            },
          },
        },
      },
    ]),
  ])

  await customFields.decorate('deal', items)

  res.json({
    items, total, page, limit, pages: Math.ceil(total / limit),
    customFields: await customFields.getFields('deal'),
    totals: totals[0]
      ? {
          tcvUsd: Math.round(totals[0].tcvUsd * 100) / 100,
          mrrUsd: Math.round(totals[0].mrrUsd * 100) / 100,
          weightedUsd: Math.round(totals[0].weightedUsd * 100) / 100,
        }
      : { tcvUsd: 0, mrrUsd: 0, weightedUsd: 0 },
  })
})

/* ---- Board: open deals grouped by stage ---- */
router.get('/board', async (req, res) => {
  const settings = await getSettings()
  const filter = { status: 'open' }
  if (req.query.owner) filter.owner = req.query.owner
  if (req.query.company) filter.company = req.query.company
  if (req.query.includeClosed === 'true') delete filter.status

  const deals = await Deal.find(filter).sort({ expectedCloseDate: 1 }).limit(2000)
    .populate(POPULATE).lean()

  const columns = stageList(settings).map((s) => ({
    key: s.key, name: s.name, probability: s.probability, type: s.type, color: s.color,
    cards: [], tcvUsd: 0, weightedUsd: 0,
  }))
  const byKey = new Map(columns.map((c) => [c.key, c]))
  for (const deal of deals) {
    const col = byKey.get(deal.stage)
    if (!col) continue
    col.cards.push(deal)
    col.tcvUsd += deal.tcvUsd || 0
    if (deal.forecastCategory !== 'omitted' && deal.status === 'open') {
      col.weightedUsd += (deal.tcvUsd || 0) * ((deal.probability || 0) / 100)
    }
  }
  for (const c of columns) {
    c.tcvUsd = Math.round(c.tcvUsd * 100) / 100
    c.weightedUsd = Math.round(c.weightedUsd * 100) / 100
  }

  res.json({
    columns,
    reportingCurrency: settings.reportingCurrency || 'USD',
    truncated: deals.length >= 2000,
  })
})

/* ---- Single deal ---- */
router.get('/:id', async (req, res) => {
  const deal = await Deal.findById(req.params.id)
    .populate(POPULATE)
    .populate('contacts', 'firstName lastName email phone title status')
    .populate('campaign', 'name')
    .lean()
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  await customFields.decorate('deal', deal)

  const settings = await getSettings()
  const [activities, companyContacts, quotes] = await Promise.all([
    Activity.find({ deal: deal._id }).sort({ createdAt: -1 }).limit(200)
      .populate('user', 'name').populate('contact', 'firstName lastName').lean(),
    Contact.find({ company: deal.company?._id || deal.company })
      .select('firstName lastName email title status').lean({ virtuals: true }),
    Quote.find({ deal: deal._id }).sort({ createdAt: -1 })
      .select('number version status tcv currency tcvUsd validUntil createdAt sentAt acceptedAt firstViewedAt publicToken approvalReasons')
      .lean(),
  ])

  res.json({
    deal,
    activities,
    companyContacts,
    quotes,
    stages: stageList(settings),
    canEdit: canEdit(req, deal),
    customFields: await customFields.getFields('deal'),
    // What is still missing before this deal can move on, so the UI can warn
    // rather than letting the rep discover it at the stage change.
    missingRequired: (await customFields.missingRequired('deal', deal, {
      stage: deal.stage,
      stageOrder: stageList(settings).map((x) => x.key),
    })).map((f) => ({ key: f.key, label: f.label, requiredAtStage: f.requiredAtStage })),
  })
})

/* ---- Create ---- */
router.post('/', async (req, res) => {
  const body = req.body || {}
  // The picker sends an id when one was chosen and free text otherwise; resolve
  // the text the same way contacts do rather than making the rep go and create
  // the company first.
  let companyId = body.company
  if (!companyId && body.companyName) {
    const resolved = await resolveCompany({
      name: body.companyName, ownerId: req.user._id, source: 'deal',
    })
    companyId = resolved?._id
  }
  if (!companyId) return res.status(400).json({ error: 'A deal must belong to a company' })
  try {
    const deal = await createDeal({
      companyId,
      primaryContactId: body.primaryContact || null,
      actorId: req.user._id,
      source: body.source || 'manual',
      overrides: body,
    })
    const populated = await Deal.findById(deal._id).populate(POPULATE).lean()
    res.status(201).json({ deal: populated })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

/* ---- Update ---- */
router.put('/:id', async (req, res) => {
  const deal = await Deal.findById(req.params.id)
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  if (!requireOwner(req, res, deal)) return

  const settings = await getSettings()
  const body = req.body || {}

  if (body.currency && unknownCurrencies(settings, [body.currency]).length) {
    return res.status(400).json({
      error: `${body.currency} is not in your currency list. Add it with a rate in Settings first.`,
    })
  }

  const changes = []
  for (const key of EDITABLE) {
    if (body[key] === undefined) continue
    const before = JSON.stringify(deal[key])
    deal[key] = body[key]
    if (JSON.stringify(deal[key]) !== before) changes.push(key)
  }
  if (body.customFields !== undefined) {
    const { values, errors } = await customFields.applyValues('deal', deal.customFields, body.customFields)
    if (errors.length) return res.status(400).json({ error: errors.join('. ') })
    deal.customFields = values
    deal.markModified('customFields')
  }
  if (body.lineItems !== undefined) { deal.lineItems = body.lineItems; changes.push('lineItems') }
  if (body.owner !== undefined && req.can('deals.editAny')) deal.owner = body.owner || null

  // Stage moves have side effects, so they never ride along on a field update.
  if (body.stage !== undefined && body.stage !== deal.stage) {
    return res.status(400).json({
      error: 'Use POST /api/deals/:id/stage to move a deal — it keeps probability, status and the timeline in step.',
    })
  }

  deal.lastActivityAt = new Date()
  recalcDeal(deal, settings)
  await deal.save()

  if (changes.length) {
    await logActivity({
      deal: deal._id, company: deal.company, contact: deal.primaryContact || null,
      type: 'note', user: req.user._id,
      title: 'Deal updated', body: `Changed: ${changes.join(', ')}`,
    })
  }
  const populated = await Deal.findById(deal._id).populate(POPULATE).lean()
  res.json({ deal: populated })
})

/* ---- Stage move ---- */
router.post('/:id/stage', async (req, res) => {
  const deal = await Deal.findById(req.params.id)
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  if (!requireOwner(req, res, deal)) return

  const settings = await getSettings()
  const stage = stageMeta(settings, req.body?.stage)
  if (!stage) return res.status(400).json({ error: 'Unknown pipeline stage' })

  // A loss without a reason is a loss you cannot learn from.
  if (stage.type === 'lost' && !String(req.body?.lostReason || '').trim()) {
    return res.status(400).json({
      error: 'Pick a reason for the loss — it is the only thing that makes the lost-deal report useful.',
      lostReasons: settings.lostReasons || [],
    })
  }

  /* Required-at-stage fields are enforced here, not just hidden in the UI.
     A rule that only exists in the form is not a rule. Losing a deal is exempt
     — demanding paperwork to record a loss just means losses go unrecorded. */
  if (stage.type !== 'lost') {
    const missing = await customFields.missingRequired('deal', deal, {
      stage: stage.key,
      stageOrder: stageList(settings).map((x) => x.key),
    })
    if (missing.length) {
      return res.status(400).json({
        error: `Fill in ${missing.map((f) => `"${f.label}"`).join(', ')} before moving this deal to ${stage.name}.`,
        missingRequired: missing.map((f) => ({ key: f.key, label: f.label })),
      })
    }
  }

  try {
    const { changed } = await changeStage({
      deal, stageKey: stage.key, actorId: req.user._id,
      lostReason: req.body?.lostReason, closedNotes: req.body?.closedNotes,
    })
    const populated = await Deal.findById(deal._id).populate(POPULATE).lean()
    res.json({ changed, deal: populated })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

/* ---- Reopen a closed deal ---- */
router.post('/:id/reopen', async (req, res) => {
  const deal = await Deal.findById(req.params.id)
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  if (!requireOwner(req, res, deal)) return
  if (deal.status === 'open') return res.status(400).json({ error: 'That deal is already open' })

  const settings = await getSettings()
  const target = stageMeta(settings, req.body?.stage) || stageList(settings).find((s) => s.type === 'open')
  if (!target || target.type !== 'open') {
    return res.status(400).json({ error: 'Pick an open stage to reopen into' })
  }
  await changeStage({ deal, stageKey: target.key, actorId: req.user._id })
  deal.lostReason = ''
  await deal.save()
  const populated = await Deal.findById(deal._id).populate(POPULATE).lean()
  res.json({ deal: populated })
})

/* ---- Contacts on the deal ---- */
router.post('/:id/contacts', async (req, res) => {
  const deal = await Deal.findById(req.params.id)
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  if (!requireOwner(req, res, deal)) return

  const { contactId, primary } = req.body || {}
  const contact = await Contact.findById(contactId)
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  if (String(contact.company) !== String(deal.company)) {
    return res.status(400).json({ error: 'That contact works somewhere else' })
  }
  if (!deal.contacts.some((c) => String(c) === String(contact._id))) deal.contacts.push(contact._id)
  if (primary) deal.primaryContact = contact._id
  await deal.save()
  const populated = await Deal.findById(deal._id).populate(POPULATE)
    .populate('contacts', 'firstName lastName email phone title status').lean()
  res.json({ deal: populated })
})

router.delete('/:id/contacts/:contactId', async (req, res) => {
  const deal = await Deal.findById(req.params.id)
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  if (!requireOwner(req, res, deal)) return
  deal.contacts = deal.contacts.filter((c) => String(c) !== String(req.params.contactId))
  if (String(deal.primaryContact) === String(req.params.contactId)) deal.primaryContact = deal.contacts[0] || null
  await deal.save()
  res.json({ ok: true })
})

router.delete('/:id', requirePermission('deals.delete'), async (req, res) => {
  const deal = await Deal.findById(req.params.id)
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  await Activity.deleteMany({ deal: deal._id })
  await Deal.deleteOne({ _id: deal._id })
  res.json({ ok: true })
})

module.exports = router
