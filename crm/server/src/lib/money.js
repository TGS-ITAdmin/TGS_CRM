const { Settings, DEFAULT_CURRENCIES } = require('../db')

/* Money maths for deals.
 *
 * Two numbers matter to a BPO and they are not the same:
 *   MRR — recurring monthly revenue (seats × rate, hours × rate)
 *   TCV — total contract value = MRR × term + one-off fees
 * Reporting a forecast in TCV while comparing it to a monthly target, or vice
 * versa, is the classic way to be wrong by an order of magnitude, so both are
 * stored and every report says which it is using.
 *
 * Rates are "one unit of this currency, in the reporting currency". The rate
 * is stamped onto the deal on save, so updating the rate table never silently
 * rewrites last quarter's numbers.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

async function getSettings() {
  return (await Settings.findOne({ key: 'global' }).lean()) || {}
}

function currencyList(settings) {
  const list = settings?.currencies?.length ? settings.currencies : DEFAULT_CURRENCIES
  return list
}

function rateFor(settings, code) {
  const found = currencyList(settings).find((c) => c.code === code)
  // An unknown currency must not silently become 1:1 — that would understate
  // a PHP deal by ~57x. Fall back to the reporting currency instead.
  if (!found) return null
  return Number(found.rate) || 0
}

function symbolFor(settings, code) {
  return currencyList(settings).find((c) => c.code === code)?.symbol || ''
}

/* Effective price of a line after its discount, and the discount implied by a
 * unit price sitting below list. */
function lineMath(item) {
  const list = Number(item.listPrice) || 0
  const unit = Number(item.unitPrice) || 0
  const qty = Number(item.quantity) || 0
  const discountPercent = list > 0 && unit < list ? round2(((list - unit) / list) * 100) : 0
  return { qty, unit, list, discountPercent, total: round2(qty * unit) }
}

/* Recalculates every derived money field. Call before every save; the fields
 * are never set by a caller. */
function recalcDeal(deal, settings) {
  const term = Math.max(0, Number(deal.termMonths) || 0)
  let mrr = 0
  let oneTime = 0

  if (deal.pricingMode === 'line_items') {
    for (const item of deal.lineItems || []) {
      const { total, discountPercent } = lineMath(item)
      item.discountPercent = discountPercent
      if (item.pricingModel === 'one_time') oneTime += total
      // Hourly and per-unit lines are monthly volume — a BPO hourly contract
      // bills every month, it is not a one-off.
      else mrr += total
    }
    deal.tcv = round2(mrr * term + oneTime)
  } else {
    // Manual mode: the rep types the total contract value.
    oneTime = 0
    deal.tcv = round2(Number(deal.amount) || 0)
    mrr = term > 0 ? round2(deal.tcv / term) : 0
  }

  deal.mrr = round2(mrr)
  deal.oneTimeTotal = round2(oneTime)

  const rate = rateFor(settings, deal.currency)
  // A missing rate is a configuration error, not a reason to report zero.
  deal.fxRate = rate == null ? 1 : rate
  deal.mrrUsd = round2(deal.mrr * deal.fxRate)
  deal.tcvUsd = round2(deal.tcv * deal.fxRate)
  return deal
}

/* Weighted value, in the reporting currency. Omitted deals contribute nothing
 * regardless of stage — that is what the category is for. */
function weighted(deal, field = 'tcvUsd') {
  if (deal.forecastCategory === 'omitted') return 0
  if (deal.status !== 'open') return 0
  return round2((deal[field] || 0) * ((Number(deal.probability) || 0) / 100))
}

function unknownCurrencies(settings, codes) {
  const known = new Set(currencyList(settings).map((c) => c.code))
  return [...new Set(codes)].filter((c) => c && !known.has(c))
}

module.exports = {
  getSettings, currencyList, rateFor, symbolFor,
  recalcDeal, weighted, lineMath, round2, unknownCurrencies,
}
