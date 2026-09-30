const express = require('express')
const { Quote, Deal, Company, Contact, Product, User, Activity } = require('../db')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { logActivity } = require('../lib/engine')
const { getSettings, currencyList } = require('../lib/money')
const {
  createQuote, reviseQuote, submitQuote, recalcQuote, evaluateApproval,
  lineFromProduct, applyAcceptedQuoteToDeal, expireStaleQuotes, EDITABLE_STATUSES,
} = require('../lib/quotes')
const { renderQuotePdf } = require('../lib/quote-pdf')

const router = express.Router()
router.use(requireAuth)

/* Quotes follow the deal's visibility: everyone can see them, only the owner
 * (or an admin) can change one. Approving is admin-only by definition — the
 * point of the rule is that the rep cannot wave it through themselves. */
function canEdit(req, quote) {
  return req.can('deals.editAny') || String(quote.owner) === String(req.user._id)
}
function requireOwner(req, res, quote) {
  if (canEdit(req, quote)) return true
  res.status(403).json({ error: 'Only the quote owner or an admin can change this quote' })
  return false
}

const POPULATE = [
  { path: 'company', select: 'name domain address industry' },
  { path: 'contact', select: 'firstName lastName email title' },
  { path: 'deal', select: 'name stage status currency' },
  { path: 'owner', select: 'name email' },
  { path: 'submittedBy', select: 'name' },
  { path: 'decidedBy', select: 'name' },
]

/* ---- List ---- */
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50)
  const filter = {}
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') }
  if (req.query.deal) filter.deal = req.query.deal
  if (req.query.company) filter.company = req.query.company
  if (req.query.owner) filter.owner = req.query.owner
  // Superseded versions are noise unless you are deliberately looking at history.
  if (req.query.includeSuperseded !== 'true' && !req.query.status) {
    filter.status = { $ne: 'superseded' }
  }

  const [items, total, pendingCount] = await Promise.all([
    Quote.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate(POPULATE).lean(),
    Quote.countDocuments(filter),
    Quote.countDocuments({ status: 'pending_approval' }),
  ])
  res.json({ items, total, page, pages: Math.ceil(total / limit), pendingApprovalCount: pendingCount })
})

/* ---- Single ---- */
router.get('/:id', async (req, res) => {
  const quote = await Quote.findById(req.params.id).populate(POPULATE).lean()
  if (!quote) return res.status(404).json({ error: 'Quote not found' })

  const [versions, activities, settings] = await Promise.all([
    Quote.find({ number: quote.number }).select('version status createdAt tcv currency').sort({ version: 1 }).lean(),
    Activity.find({ 'meta.quote': quote._id }).sort({ createdAt: -1 }).limit(100)
      .populate('user', 'name').lean(),
    getSettings(),
  ])

  res.json({
    quote,
    versions,
    activities,
    canEdit: canEdit(req, quote),
    canApprove: req.can('quotes.approve'),
    editable: EDITABLE_STATUSES.includes(quote.status),
    // Live preview of which rules this quote would breach, so a rep sees it
    // before submitting rather than after.
    wouldNeedApproval: evaluateApproval(quote, settings),
    appBaseUrl: settings.appBaseUrl || process.env.APP_BASE_URL || '',
  })
})

/* ---- Create from a deal ---- */
router.post('/', async (req, res) => {
  const { deal: dealId } = req.body || {}
  if (!dealId) return res.status(400).json({ error: 'A quote must belong to a deal' })
  const deal = await Deal.findById(dealId)
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  if (!req.can('deals.editAny') && String(deal.owner) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Only the deal owner or an admin can quote this deal' })
  }

  const quote = await createQuote({ deal, actorId: req.user._id, overrides: req.body || {} })
  const populated = await Quote.findById(quote._id).populate(POPULATE).lean()
  res.status(201).json({ quote: populated })
})

/* ---- Update a draft ---- */
const EDITABLE_FIELDS = [
  'title', 'introMessage', 'terms', 'currency', 'termMonths',
  'validUntil', 'contact', 'notes', 'lineItems',
]

router.put('/:id', async (req, res) => {
  const quote = await Quote.findById(req.params.id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!requireOwner(req, res, quote)) return

  if (!EDITABLE_STATUSES.includes(quote.status)) {
    return res.status(409).json({
      error: `A ${quote.status.replace('_', ' ')} quote cannot be edited in place — what the client saw must stay what the client saw. Create a new version instead.`,
      canRevise: ['approved', 'sent', 'declined', 'expired'].includes(quote.status),
    })
  }

  const settings = await getSettings()
  const body = req.body || {}
  if (body.currency && !currencyList(settings).some((c) => c.code === body.currency)) {
    return res.status(400).json({ error: `${body.currency} is not in your currency list` })
  }

  for (const key of EDITABLE_FIELDS) if (body[key] !== undefined) quote[key] = body[key]
  // Editing a rejected quote puts it back in the rep's hands as a draft.
  if (quote.status === 'rejected') {
    quote.status = 'draft'
    quote.approvalReasons = []
    quote.decidedAt = null
    quote.decidedBy = null
  }
  recalcQuote(quote, settings)
  await quote.save()

  const populated = await Quote.findById(quote._id).populate(POPULATE).lean()
  res.json({ quote: populated, wouldNeedApproval: evaluateApproval(quote, settings) })
})

/* ---- Add a line straight from the rate card ---- */
router.post('/:id/lines', async (req, res) => {
  const quote = await Quote.findById(req.params.id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!requireOwner(req, res, quote)) return
  if (!EDITABLE_STATUSES.includes(quote.status)) {
    return res.status(409).json({ error: 'Only a draft quote can be changed' })
  }

  const settings = await getSettings()
  const { productId, quantity, unitPrice } = req.body || {}
  const product = await Product.findById(productId)
  if (!product) return res.status(404).json({ error: 'Product not found' })
  if (product.currency !== quote.currency) {
    return res.status(400).json({
      error: `${product.name} is priced in ${product.currency} but this quote is in ${quote.currency}. Mixing currencies on one quote would make the total meaningless.`,
    })
  }

  quote.lineItems.push(lineFromProduct(product, {
    quantity: Number(quantity) || 1,
    unitPrice: unitPrice == null ? undefined : Number(unitPrice),
    order: quote.lineItems.length,
  }))
  recalcQuote(quote, settings)
  await quote.save()
  res.json({ quote, wouldNeedApproval: evaluateApproval(quote, settings) })
})

/* ---- Submit for approval (auto-approves when nothing is breached) ---- */
router.post('/:id/submit', async (req, res) => {
  const quote = await Quote.findById(req.params.id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!requireOwner(req, res, quote)) return
  if (!EDITABLE_STATUSES.includes(quote.status)) {
    return res.status(409).json({ error: `That quote is already ${quote.status.replace('_', ' ')}` })
  }
  if (!quote.lineItems.length) {
    return res.status(400).json({ error: 'Add at least one line before submitting' })
  }

  const { reasons } = await submitQuote({ quote, actorId: req.user._id })
  const populated = await Quote.findById(quote._id).populate(POPULATE).lean()
  res.json({ quote: populated, reasons, autoApproved: reasons.length === 0 })
})

/* ---- Approve / reject (admin only, by design) ---- */
router.post('/:id/decide', requirePermission('quotes.approve'), async (req, res) => {
  const quote = await Quote.findById(req.params.id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (quote.status !== 'pending_approval') {
    return res.status(409).json({ error: 'That quote is not waiting for approval' })
  }
  const approve = req.body?.decision === 'approve'
  if (!approve && !String(req.body?.note || '').trim()) {
    return res.status(400).json({
      error: 'Say why you are rejecting it — the rep has to know what to change.',
    })
  }

  quote.status = approve ? 'approved' : 'rejected'
  quote.decidedAt = new Date()
  quote.decidedBy = req.user._id
  quote.decisionNote = req.body?.note || ''
  await quote.save()

  await logActivity({
    deal: quote.deal,
    company: quote.company,
    contact: quote.contact,
    type: approve ? 'quote_approved' : 'quote_rejected',
    user: req.user._id,
    title: `Quote ${quote.number} ${approve ? 'approved' : 'rejected'}`,
    body: quote.decisionNote,
    meta: { quote: quote._id },
  })

  const populated = await Quote.findById(quote._id).populate(POPULATE).lean()
  res.json({ quote: populated })
})

/* ---- Mark sent. The rep sends it themselves; this records that they did. ---- */
router.post('/:id/sent', async (req, res) => {
  const quote = await Quote.findById(req.params.id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!requireOwner(req, res, quote)) return
  if (quote.status !== 'approved') {
    return res.status(409).json({
      error: quote.status === 'pending_approval'
        ? 'This quote is still waiting for approval.'
        : `Only an approved quote can be marked sent (this one is ${quote.status.replace('_', ' ')}).`,
    })
  }
  quote.status = 'sent'
  quote.sentAt = new Date()
  quote.sentBy = req.user._id
  await quote.save()

  await logActivity({
    deal: quote.deal, company: quote.company, contact: quote.contact,
    type: 'quote_sent', user: req.user._id,
    title: `Quote ${quote.number} sent to the client`,
    body: req.body?.note || '',
    meta: { quote: quote._id },
  })
  const populated = await Quote.findById(quote._id).populate(POPULATE).lean()
  res.json({ quote: populated })
})

/* ---- New version of a quote that has left the building ---- */
router.post('/:id/revise', async (req, res) => {
  const quote = await Quote.findById(req.params.id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!requireOwner(req, res, quote)) return
  if (quote.status === 'accepted') {
    return res.status(409).json({ error: 'An accepted quote cannot be revised — it is the agreement.' })
  }
  if (EDITABLE_STATUSES.includes(quote.status)) {
    return res.status(409).json({ error: 'This quote is still a draft — edit it directly.' })
  }
  const copy = await reviseQuote({ quote, actorId: req.user._id })
  const populated = await Quote.findById(copy._id).populate(POPULATE).lean()
  res.status(201).json({ quote: populated })
})

/* ---- PDF ---- */
router.get('/:id/pdf', async (req, res) => {
  const quote = await Quote.findById(req.params.id).lean()
  if (!quote) return res.status(404).json({ error: 'Quote not found' })

  const [company, contact, owner, settings] = await Promise.all([
    Company.findById(quote.company).lean(),
    quote.contact ? Contact.findById(quote.contact).lean() : null,
    quote.owner ? User.findById(quote.owner).select('name email').lean() : null,
    getSettings(),
  ])

  const pdf = await renderQuotePdf({ quote, company, contact, owner, settings })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', pdf.length)
  res.setHeader(
    'Content-Disposition',
    `${req.query.inline === 'true' ? 'inline' : 'attachment'}; filename="${quote.number}${quote.version > 1 ? `-v${quote.version}` : ''}.pdf"`
  )
  res.send(pdf)
})

router.delete('/:id', async (req, res) => {
  const quote = await Quote.findById(req.params.id)
  if (!quote) return res.status(404).json({ error: 'Quote not found' })
  if (!requireOwner(req, res, quote)) return
  if (!EDITABLE_STATUSES.includes(quote.status)) {
    return res.status(409).json({
      error: 'Only a draft can be deleted. Anything the client may have seen stays on the record.',
    })
  }
  await Quote.deleteOne({ _id: quote._id })
  res.json({ ok: true })
})

/* Housekeeping: let an admin expire anything past its valid-until. */
router.post('/expire-stale', requirePermission('settings.manage'), async (req, res) => {
  const expired = await expireStaleQuotes()
  res.json({ expired })
})

module.exports = router
