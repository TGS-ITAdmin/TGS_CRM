const { Quote, Counter, Deal, Product, Settings, DEFAULT_QUOTE_APPROVAL } = require('../db')
const { recalcDeal, rateFor, round2, getSettings } = require('./money')
const { logActivity } = require('./engine')

/* Quotes.
 *
 * Three rules shape everything here:
 *
 *  1. A quote line is a SNAPSHOT. Prices are copied at build time, so a rate
 *     card change next month cannot rewrite what a client is looking at.
 *  2. A quote that has left the building is never edited in place. Changing
 *     one creates a new version that supersedes it, so what was accepted is
 *     exactly what was seen.
 *  3. Approval is evaluated from the quote's own numbers, not from what the
 *     rep claims. Every breached rule is recorded with the figure that
 *     breached it.
 */

const EDITABLE_STATUSES = ['draft', 'rejected']
const LIVE_STATUSES = ['approved', 'sent']

async function nextQuoteNumber(settings) {
  const year = new Date().getFullYear()
  // findOneAndUpdate with $inc is atomic, so two reps clicking at once cannot
  // be handed the same number.
  const counter = await Counter.findOneAndUpdate(
    { key: `quote:${year}` },
    { $inc: { value: 1 } },
    { upsert: true, new: true }
  )
  const prefix = settings.quoteNumberPrefix || 'Q'
  return `${prefix}-${year}-${String(counter.value).padStart(4, '0')}`
}

function lineTotals(line) {
  const qty = Number(line.quantity) || 0
  const unit = Number(line.unitPrice) || 0
  return round2(qty * unit)
}

/* Recomputes every derived figure on a quote. Mirrors the deal maths exactly —
 * a quote that disagrees with the deal it came from is worse than no quote. */
function recalcQuote(quote, settings) {
  const term = Math.max(0, Number(quote.termMonths) || 0)
  let mrr = 0
  let oneTime = 0
  let cost = 0

  for (const line of quote.lineItems || []) {
    const total = lineTotals(line)
    const list = Number(line.listPrice) || 0
    const unit = Number(line.unitPrice) || 0
    line.discountPercent = list > 0 && unit < list ? round2(((list - unit) / list) * 100) : 0

    // Hourly and per-unit lines are monthly volume: a BPO hourly contract
    // bills every month, it is not a one-off.
    if (line.pricingModel === 'one_time') oneTime += total
    else mrr += total

    const unitCost = Number(line.unitCost) || 0
    const qty = Number(line.quantity) || 0
    cost += line.pricingModel === 'one_time' ? unitCost * qty : unitCost * qty * term
  }

  quote.mrr = round2(mrr)
  quote.oneTimeTotal = round2(oneTime)
  quote.tcv = round2(mrr * term + oneTime)
  quote.totalCost = round2(cost)

  const rate = rateFor(settings, quote.currency)
  quote.fxRate = rate == null ? 1 : rate
  quote.mrrUsd = round2(quote.mrr * quote.fxRate)
  quote.tcvUsd = round2(quote.tcv * quote.fxRate)
  return quote
}

/* Which approval rules this quote breaches, and by how much.
 * Returns [] when it can be shared without a sign-off. */
function evaluateApproval(quote, settings) {
  /* Fall back to the defaults, not to {}. An install whose settings document
   * predates this feature must still enforce the rules — defaulting a margin
   * control to "off" is the dangerous direction to fail in. */
  const stored = settings && settings.quoteApproval
  const rules = stored && Object.keys(stored).length ? stored : DEFAULT_QUOTE_APPROVAL
  const reasons = []

  const discounted = (quote.lineItems || []).filter((l) => (l.discountPercent || 0) > 0)
  const maxDiscount = discounted.reduce((m, l) => Math.max(m, l.discountPercent || 0), 0)

  if (rules.anyDiscount?.enabled && discounted.length > 0) {
    reasons.push({
      rule: 'anyDiscount',
      label: 'A discount has been applied',
      detail: `${discounted.length} line${discounted.length === 1 ? '' : 's'} priced below list (largest ${maxDiscount}%)`,
    })
  }

  if (rules.discountOver?.enabled) {
    const limit = Number(rules.discountOver.percent) || 0
    if (maxDiscount > limit) {
      reasons.push({
        rule: 'discountOver',
        label: `Discount above ${limit}%`,
        detail: `Largest discount on this quote is ${maxDiscount}%`,
      })
    }
  }

  if (rules.valueOver?.enabled) {
    const limit = Number(rules.valueOver.amount) || 0
    if ((quote.tcvUsd || 0) > limit) {
      reasons.push({
        rule: 'valueOver',
        label: `Contract value above ${limit.toLocaleString()}`,
        detail: `This quote is worth ${Math.round(quote.tcvUsd).toLocaleString()} in the reporting currency`,
      })
    }
  }

  if (rules.rateFloor?.enabled) {
    // The floor is the guard that actually protects margin: a 5% discount off
    // an already-thin rate can be worse than 20% off a fat one.
    const under = (quote.lineItems || []).filter(
      (l) => (Number(l.floorPrice) || 0) > 0 && (Number(l.unitPrice) || 0) < Number(l.floorPrice)
    )
    if (under.length) {
      reasons.push({
        rule: 'rateFloor',
        label: 'Priced below the floor rate',
        detail: under
          .map((l) => `${l.name}: ${l.unitPrice} vs floor ${l.floorPrice}`)
          .join('; '),
      })
    }
  }

  if (rules.minTerm?.enabled) {
    const min = Number(rules.minTerm.months) || 0
    if ((Number(quote.termMonths) || 0) < min) {
      reasons.push({
        rule: 'minTerm',
        label: `Term shorter than ${min} months`,
        detail: `This quote runs for ${quote.termMonths} month${quote.termMonths === 1 ? '' : 's'}`,
      })
    }
  }

  return reasons
}

/* Copies a product onto a quote line, snapshotting its prices. */
function lineFromProduct(product, { quantity = 1, unitPrice, order = 0 } = {}) {
  return {
    product: product._id,
    name: product.name,
    description: product.description || '',
    pricingModel: product.pricingModel,
    quantity,
    listPrice: product.listPrice,
    unitPrice: unitPrice == null ? product.listPrice : unitPrice,
    floorPrice: product.floorPrice || 0,
    unitCost: product.unitCost || 0,
    order,
  }
}

/* Builds a fresh draft quote for a deal. Seeds its lines from the deal's own
 * line items when it has them, so a rep who priced the deal does not retype it. */
async function createQuote({ deal, actorId, overrides = {} }) {
  const settings = await getSettings()
  const number = await nextQuoteNumber(settings)

  const validDays = Number(settings.quoteValidDays) || 30
  const lines = (overrides.lineItems || deal.lineItems || []).map((l, i) => ({
    product: l.product || null,
    name: l.name,
    description: l.description || '',
    pricingModel: l.pricingModel,
    quantity: l.quantity,
    listPrice: l.listPrice || l.unitPrice || 0,
    unitPrice: l.unitPrice || 0,
    floorPrice: l.floorPrice || 0,
    unitCost: l.unitCost || 0,
    order: i,
  }))

  const quote = new Quote({
    number,
    version: 1,
    deal: deal._id,
    company: deal.company,
    contact: overrides.contact || deal.primaryContact || null,
    status: 'draft',
    title: overrides.title || deal.name,
    introMessage: overrides.introMessage || '',
    terms: overrides.terms != null ? overrides.terms : settings.quoteTerms || '',
    lineItems: lines,
    currency: overrides.currency || deal.currency || 'USD',
    termMonths: overrides.termMonths ?? deal.termMonths ?? 12,
    validUntil: overrides.validUntil || new Date(Date.now() + validDays * 86400000),
    owner: actorId || deal.owner || null,
  })

  recalcQuote(quote, settings)
  await quote.save()

  await logActivity({
    deal: deal._id,
    company: deal.company,
    contact: quote.contact,
    type: 'quote_created',
    user: actorId,
    title: `Quote ${quote.number} drafted`,
    meta: { quote: quote._id, tcv: quote.tcv, currency: quote.currency },
  })

  return quote
}

/* A sent quote that needs changing becomes a new version. The old one is
 * marked superseded rather than deleted, so the audit trail survives. */
async function reviseQuote({ quote, actorId }) {
  const settings = await getSettings()
  const copy = new Quote({
    number: quote.number,
    version: quote.version + 1,
    supersedes: quote._id,
    deal: quote.deal,
    company: quote.company,
    contact: quote.contact,
    status: 'draft',
    title: quote.title,
    introMessage: quote.introMessage,
    terms: quote.terms,
    lineItems: quote.lineItems.map((l) => ({ ...(l.toObject?.() ?? l), _id: undefined })),
    currency: quote.currency,
    termMonths: quote.termMonths,
    validUntil: new Date(Date.now() + (Number(settings.quoteValidDays) || 30) * 86400000),
    owner: actorId || quote.owner,
  })
  recalcQuote(copy, settings)
  await copy.save()

  quote.status = 'superseded'
  quote.supersededBy = copy._id
  await quote.save()

  await logActivity({
    deal: quote.deal,
    company: quote.company,
    contact: quote.contact,
    type: 'quote_superseded',
    user: actorId,
    title: `Quote ${quote.number} v${quote.version} replaced by v${copy.version}`,
    meta: { quote: copy._id, previous: quote._id },
  })

  return copy
}

/* Submitting runs the rules. A clean quote is approved on the spot — there is
 * no reason to make an admin rubber-stamp something that breaks no rule. */
async function submitQuote({ quote, actorId }) {
  const settings = await getSettings()
  recalcQuote(quote, settings)
  const reasons = evaluateApproval(quote, settings)

  quote.approvalReasons = reasons
  quote.submittedAt = new Date()
  quote.submittedBy = actorId

  if (reasons.length === 0) {
    quote.status = 'approved'
    quote.decidedAt = new Date()
    quote.decidedBy = null
    quote.decisionNote = 'Auto-approved — breaks no approval rule'
  } else {
    quote.status = 'pending_approval'
    quote.decidedAt = null
    quote.decidedBy = null
    quote.decisionNote = ''
  }
  await quote.save()

  await logActivity({
    deal: quote.deal,
    company: quote.company,
    contact: quote.contact,
    type: reasons.length ? 'quote_submitted' : 'quote_approved',
    user: actorId,
    title: reasons.length
      ? `Quote ${quote.number} needs approval — ${reasons.map((r) => r.label).join(', ')}`
      : `Quote ${quote.number} approved automatically`,
    body: reasons.map((r) => `• ${r.label}: ${r.detail}`).join('\n'),
    meta: { quote: quote._id, reasons: reasons.map((r) => r.rule) },
  })

  return { quote, reasons }
}

/* When a client accepts, the deal should reflect what they accepted — that is
 * the whole point of quoting from the deal in the first place. */
async function applyAcceptedQuoteToDeal({ quote, actorId = null }) {
  const settings = await getSettings()
  const deal = await Deal.findById(quote.deal)
  if (!deal) return null

  deal.pricingMode = 'line_items'
  deal.lineItems = quote.lineItems.map((l, i) => ({
    product: l.product || null,
    name: l.name,
    description: l.description || '',
    pricingModel: l.pricingModel,
    quantity: l.quantity,
    listPrice: l.listPrice,
    unitPrice: l.unitPrice,
    order: i,
  }))
  deal.currency = quote.currency
  deal.termMonths = quote.termMonths
  recalcDeal(deal, settings)
  deal.lastActivityAt = new Date()
  await deal.save()
  return deal
}

async function expireStaleQuotes(now = new Date()) {
  const res = await Quote.updateMany(
    { status: { $in: ['approved', 'sent'] }, validUntil: { $ne: null, $lt: now } },
    { $set: { status: 'expired' } }
  )
  return res.modifiedCount
}

module.exports = {
  nextQuoteNumber, recalcQuote, evaluateApproval, lineFromProduct,
  createQuote, reviseQuote, submitQuote, applyAcceptedQuoteToDeal,
  expireStaleQuotes, EDITABLE_STATUSES, LIVE_STATUSES,
}
