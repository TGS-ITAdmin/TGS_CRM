const { Deal, Contact, Company, Settings, DEFAULT_DEAL_STAGES } = require('../db')
const { recalcDeal, getSettings } = require('./money')
const { logActivity } = require('./engine')

/* Deal lifecycle. Stage, probability and status are kept in step here and
 * nowhere else — a deal whose stage says Won but whose status says open is
 * the kind of inconsistency that quietly ruins every report. */

function stageList(settings) {
  const list = settings?.dealStages?.length ? settings.dealStages : DEFAULT_DEAL_STAGES
  return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function stageMeta(settings, key) {
  return stageList(settings).find((s) => s.key === key) || null
}

function firstOpenStage(settings) {
  return stageList(settings).find((s) => s.type === 'open') || stageList(settings)[0]
}

/* Apply a stage to a deal, keeping probability and status consistent.
 * `probability` is only auto-set when the caller has not overridden it. */
function applyStage(deal, stage, { keepProbability = false } = {}) {
  const now = new Date()
  const open = deal.stageHistory[deal.stageHistory.length - 1]
  if (open && !open.leftAt) open.leftAt = now

  deal.stage = stage.key
  deal.stageEnteredAt = now
  deal.stageHistory.push({
    stage: stage.key,
    stageName: stage.name,
    enteredAt: now,
    probability: keepProbability ? deal.probability : stage.probability,
  })

  if (!keepProbability) deal.probability = stage.probability
  deal.status = stage.type === 'won' ? 'won' : stage.type === 'lost' ? 'lost' : 'open'

  if (deal.status === 'won') {
    deal.wonAt = now
    deal.lostAt = null
    deal.probability = 100
    deal.forecastCategory = 'commit'
  } else if (deal.status === 'lost') {
    deal.lostAt = now
    deal.wonAt = null
    deal.probability = 0
    deal.forecastCategory = 'omitted'
  } else {
    deal.wonAt = null
    deal.lostAt = null
  }
  return deal
}

async function changeStage({ deal, stageKey, actorId, lostReason, closedNotes }) {
  const settings = await getSettings()
  const stage = stageMeta(settings, stageKey)
  if (!stage) throw Object.assign(new Error('Unknown pipeline stage'), { status: 400 })
  if (deal.stage === stageKey) return { changed: false, deal }

  const fromMeta = stageMeta(settings, deal.stage)
  applyStage(deal, stage)
  if (stage.type === 'lost') deal.lostReason = lostReason || deal.lostReason || ''
  if (closedNotes) deal.closedNotes = closedNotes
  deal.lastActivityAt = new Date()
  recalcDeal(deal, settings)
  await deal.save()

  await logActivity({
    deal: deal._id,
    company: deal.company,
    contact: deal.primaryContact || null,
    type: stage.type === 'won' ? 'deal_won' : stage.type === 'lost' ? 'deal_lost' : 'deal_stage_changed',
    user: actorId,
    title:
      stage.type === 'won'
        ? `Won — ${deal.name}`
        : stage.type === 'lost'
        ? `Lost — ${deal.name}${lostReason ? ` (${lostReason})` : ''}`
        : `${fromMeta ? fromMeta.name : 'Unknown'} → ${stage.name}`,
    body: closedNotes || '',
    meta: { from: deal.stage, to: stage.key, probability: deal.probability },
  })

  // Winning makes the people involved customers. Their lifecycle no longer
  // carries Won at all, so this is the only place that mark gets made.
  if (stage.type === 'won') {
    const ids = [deal.primaryContact, ...(deal.contacts || [])].filter(Boolean)
    if (ids.length) {
      await Contact.updateMany({ _id: { $in: ids } }, { $set: { status: 'customer' } })
      for (const id of ids) {
        await logActivity({
          contact: id,
          company: deal.company,
          type: 'status_change',
          user: actorId,
          title: `Status set to Customer — "${deal.name}" was won`,
          meta: { to: 'customer', automatic: true, deal: deal._id },
        })
      }
    }
  }

  return { changed: true, deal }
}

/* Create a deal prefilled from what we already know about the company.
 * Used by the meeting-booked trigger and by the "new deal" button. */
async function createDeal({ companyId, primaryContactId, actorId, overrides = {}, source = 'manual', campaignId = null }) {
  const settings = await getSettings()
  const company = await Company.findById(companyId)
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 })

  const stage = overrides.stage
    ? stageMeta(settings, overrides.stage) || firstOpenStage(settings)
    : firstOpenStage(settings)

  const deal = new Deal({
    name: overrides.name || `${company.name} — ${company.targetRoles || 'outsourcing'}`.slice(0, 140),
    company: company._id,
    primaryContact: primaryContactId || null,
    contacts: primaryContactId ? [primaryContactId] : [],
    owner: overrides.owner || actorId || company.owner || null,
    currency: overrides.currency || settings.reportingCurrency || 'USD',
    pricingMode: overrides.pricingMode || 'manual',
    amount: overrides.amount ?? 0,
    termMonths: overrides.termMonths ?? 12,
    expectedCloseDate: overrides.expectedCloseDate || null,
    forecastCategory: overrides.forecastCategory || 'pipeline',
    source,
    campaign: campaignId,
    notes: overrides.notes || '',
    tags: overrides.tags || [],
    stage: stage.key,
    probability: stage.probability,
    stageHistory: [{ stage: stage.key, stageName: stage.name, enteredAt: new Date(), probability: stage.probability }],
  })

  // Seats and roles describe the organisation, so a new deal starts from them
  // rather than making the rep retype what qualification already captured.
  if (company.seatsNeeded && deal.pricingMode === 'line_items') {
    deal.lineItems = [{
      name: company.targetRoles || 'Outsourced seats',
      pricingModel: 'per_seat_monthly',
      quantity: company.seatsNeeded,
      unitPrice: 0, listPrice: 0, order: 0,
    }]
  }

  recalcDeal(deal, settings)
  await deal.save()

  await logActivity({
    deal: deal._id,
    company: company._id,
    contact: primaryContactId || null,
    type: 'deal_created',
    user: actorId,
    title: `Deal created — ${deal.name}`,
    body: source === 'meeting_booked'
      ? 'Created automatically when a meeting was booked. Fill in the value and expected close date.'
      : '',
    meta: { source, seatsNeeded: company.seatsNeeded || null },
  })

  return deal
}

/* Fires when a contact reaches Meeting Booked, from a call outcome or a manual
 * status change. Deliberately does nothing when an open deal already exists —
 * a second meeting on a live deal is not a second deal. */
async function ensureDealForMeeting({ contact, actorId, campaignId = null }) {
  if (!contact?.company) return { created: false, reason: 'Contact has no company' }

  const existing = await Deal.findOne({ company: contact.company, status: 'open' }).lean()
  if (existing) return { created: false, reason: 'An open deal already exists', dealId: existing._id }

  const deal = await createDeal({
    companyId: contact.company,
    primaryContactId: contact._id,
    actorId,
    source: 'meeting_booked',
    campaignId,
  })
  return { created: true, dealId: deal._id, deal }
}

module.exports = {
  stageList, stageMeta, firstOpenStage, applyStage,
  changeStage, createDeal, ensureDealForMeeting,
}
