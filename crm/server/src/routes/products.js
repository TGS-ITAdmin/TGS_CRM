const express = require('express')
const { Product, Quote, PRICING_MODELS } = require('../db')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { getSettings, currencyList } = require('../lib/money')

const router = express.Router()
router.use(requireAuth)

/* The rate card. Everyone can read it — a rep needs it to build a quote —
 * but only an admin changes it, because the floor price is a margin control. */

const EDITABLE = [
  'name', 'sku', 'description', 'category', 'pricingModel',
  'currency', 'listPrice', 'floorPrice', 'unitCost', 'active', 'order',
]

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

router.get('/', async (req, res) => {
  const filter = {}
  if (req.query.active !== 'all') filter.active = req.query.active === 'false' ? false : true
  if (req.query.category) filter.category = req.query.category
  const q = (req.query.q || '').trim()
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i')
    filter.$or = [{ name: rx }, { sku: rx }, { category: rx }]
  }

  const [items, categories] = await Promise.all([
    Product.find(filter).sort({ order: 1, name: 1 }).lean(),
    Product.distinct('category', { category: { $gt: '' } }),
  ])
  res.json({ items, categories, pricingModels: PRICING_MODELS })
})

router.post('/', requirePermission('products.manage'), async (req, res) => {
  const body = req.body || {}
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'A product name is required' })
  }
  const settings = await getSettings()
  const doc = {}
  for (const key of EDITABLE) if (body[key] !== undefined) doc[key] = body[key]
  doc.currency = doc.currency || settings.reportingCurrency || 'USD'
  if (!currencyList(settings).some((c) => c.code === doc.currency)) {
    return res.status(400).json({ error: `${doc.currency} is not in your currency list` })
  }
  if (!PRICING_MODELS.includes(doc.pricingModel || 'per_seat_monthly')) {
    return res.status(400).json({ error: 'Unknown pricing model' })
  }
  // A floor above list would make every quote need approval by construction.
  if (Number(doc.floorPrice) > 0 && Number(doc.floorPrice) > Number(doc.listPrice)) {
    return res.status(400).json({
      error: 'The floor price cannot be above the list price — every quote would then need approval.',
    })
  }
  if (doc.sku) {
    const clash = await Product.findOne({ sku: doc.sku }).lean()
    if (clash) return res.status(409).json({ error: `SKU ${doc.sku} is already used by ${clash.name}` })
  }
  doc.createdBy = req.user._id
  const product = await Product.create(doc)
  res.status(201).json({ product })
})

router.put('/:id', requirePermission('products.manage'), async (req, res) => {
  const product = await Product.findById(req.params.id)
  if (!product) return res.status(404).json({ error: 'Product not found' })
  const body = req.body || {}
  const settings = await getSettings()

  for (const key of EDITABLE) if (body[key] !== undefined) product[key] = body[key]
  if (!currencyList(settings).some((c) => c.code === product.currency)) {
    return res.status(400).json({ error: `${product.currency} is not in your currency list` })
  }
  if (product.floorPrice > 0 && product.floorPrice > product.listPrice) {
    return res.status(400).json({
      error: 'The floor price cannot be above the list price — every quote would then need approval.',
    })
  }
  if (product.sku) {
    const clash = await Product.findOne({ sku: product.sku, _id: { $ne: product._id } }).lean()
    if (clash) return res.status(409).json({ error: `SKU ${product.sku} is already used by ${clash.name}` })
  }
  await product.save()
  res.json({ product })
})

router.delete('/:id', requirePermission('products.manage'), async (req, res) => {
  const product = await Product.findById(req.params.id)
  if (!product) return res.status(404).json({ error: 'Product not found' })

  /* Quote lines snapshot their prices, so deleting a product cannot corrupt an
   * existing quote — but it does break the reporting link back to the rate
   * card. Deactivating keeps the history intact and hides it from the picker,
   * which is what people actually want. */
  const used = await Quote.countDocuments({ 'lineItems.product': product._id })
  if (used > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `${product.name} appears on ${used} quote${used === 1 ? '' : 's'}. Deactivate it instead — it will disappear from the picker while your quote history keeps working.`,
      quoteCount: used,
      canDeactivate: true,
    })
  }
  await Product.deleteOne({ _id: product._id })
  res.json({ ok: true })
})

module.exports = router
