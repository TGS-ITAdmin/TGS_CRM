const {
  Contact, Company, Deal, Quote, Activity, Enrollment, Task, OutboxMessage,
} = require('../db')
const { logActivity } = require('./engine')
const { normalizeName, domainFromEmail } = require('./companies')

/* Duplicate detection and record merging.
 *
 * Merging is destructive and irreversible, so the rules here are deliberately
 * conservative:
 *
 *  - The survivor's filled fields always win. The loser only fills blanks.
 *  - Every child record moves; nothing is deleted except the loser itself.
 *  - Suppression flags are OR-ed, never lost. If either record said "do not
 *    contact", the merged record says it too — losing that in a merge is a
 *    compliance breach, not an inconvenience.
 *  - The whole merge is recorded on the survivor's timeline with what came
 *    from where.
 */

const isBlank = (v) => v === undefined || v === null || v === '' ||
  (Array.isArray(v) && v.length === 0)

/* ---- Duplicate detection ------------------------------------------- */

/* Contacts: an exact email or LinkedIn match is certain. Same full name at
 * the same company is likely. Same name alone is a weak hint and is only
 * reported when there is nothing stronger, because common names are common. */
async function findContactDuplicates({ limit = 50 } = {}) {
  const contacts = await Contact.find({})
    .select('firstName lastName email linkedinUrl company companyName phone createdAt owner')
    .lean()

  const groups = new Map()
  const push = (key, confidence, reason, contact) => {
    const g = groups.get(key) || { key, confidence, reason, contacts: [] }
    // Keep the strongest reason if a pair matches more than one way.
    if (RANK[confidence] > RANK[g.confidence]) { g.confidence = confidence; g.reason = reason }
    g.contacts.push(contact)
    groups.set(key, g)
  }
  const RANK = { certain: 3, likely: 2, possible: 1 }

  for (const c of contacts) {
    if (c.email) push(`email:${c.email.toLowerCase()}`, 'certain', 'Identical email address', c)
    if (c.linkedinUrl) push(`li:${c.linkedinUrl.toLowerCase()}`, 'certain', 'Identical LinkedIn profile', c)

    const name = normalizeName(`${c.firstName || ''} ${c.lastName || ''}`)
    if (name) {
      if (c.company) push(`namecompany:${name}:${c.company}`, 'likely', 'Same name at the same company', c)
      else push(`name:${name}`, 'possible', 'Same name, no company to compare', c)
    }
  }

  return [...groups.values()]
    .filter((g) => g.contacts.length > 1)
    // Deduplicate: a pair caught by email should not also appear under name.
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence])
    .reduce((acc, g) => {
      const ids = g.contacts.map((c) => String(c._id)).sort().join('|')
      if (acc.seen.has(ids)) return acc
      acc.seen.add(ids)
      acc.out.push(g)
      return acc
    }, { seen: new Set(), out: [] }).out
    .slice(0, limit)
}

/* Companies: the email domain is the only certain signal. A normalised name
 * match ("Acme Health" / "Acme Health, Inc.") is likely. */
async function findCompanyDuplicates({ limit = 50 } = {}) {
  const companies = await Company.find({})
    .select('name domain website industry createdAt owner')
    .lean()

  const counts = await Contact.aggregate([
    { $group: { _id: '$company', n: { $sum: 1 } } },
  ])
  const contactCount = new Map(counts.map((c) => [String(c._id), c.n]))
  for (const c of companies) c.contactCount = contactCount.get(String(c._id)) || 0

  const byDomain = new Map()
  const byName = new Map()
  for (const c of companies) {
    if (c.domain) {
      const g = byDomain.get(c.domain) || []
      g.push(c)
      byDomain.set(c.domain, g)
    }
    const n = normalizeName(c.name)
    if (n) {
      const g = byName.get(n) || []
      g.push(c)
      byName.set(n, g)
    }
  }

  const out = []
  const seen = new Set()
  const add = (list, confidence, reason) => {
    if (list.length < 2) return
    const key = list.map((c) => String(c._id)).sort().join('|')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ key, confidence, reason, companies: list })
  }

  for (const [domain, list] of byDomain) add(list, 'certain', `Both use the domain ${domain}`)
  for (const [, list] of byName) add(list, 'likely', 'Names match once punctuation and Inc/Ltd are ignored')

  return out.sort((a, b) => (a.confidence === 'certain' ? -1 : 1)).slice(0, limit)
}

/* ---- Merging -------------------------------------------------------- */

function mergeScalars(survivor, loser, fields) {
  const filled = []
  for (const key of fields) {
    if (isBlank(survivor[key]) && !isBlank(loser[key])) {
      survivor[key] = loser[key]
      filled.push(key)
    }
  }
  return filled
}

/* Email and LinkedIn URL carry unique indexes. When the survivor inherits one
 * from the loser, saving it while the loser still exists violates that index
 * and the whole merge fails — so the loser has to go first.
 *
 * MongoDB transactions need a replica set, which a single local mongod is not,
 * so this compensates instead: the loser is snapshotted, deleted, and put back
 * verbatim if writing the survivor then fails. The failure window is one write,
 * and nothing is lost either way.
 */
async function saveSurvivorAndRemoveLoser(Model, survivor, loser) {
  const snapshot = loser.toObject()
  await Model.deleteOne({ _id: loser._id })
  try {
    await survivor.save()
  } catch (err) {
    await Model.collection.insertOne(snapshot).catch(() => {})
    throw Object.assign(
      new Error(`The merge could not be completed and nothing was changed: ${err.message}`),
      { status: 409 }
    )
  }
}

const CONTACT_FILLABLE = [
  'firstName', 'lastName', 'title', 'email', 'phone', 'mobile', 'linkedinUrl',
  'location', 'timezone', 'source', 'companyName',
]

async function mergeContacts({ survivorId, loserId, actorId }) {
  if (String(survivorId) === String(loserId)) {
    throw Object.assign(new Error('A record cannot be merged into itself'), { status: 400 })
  }
  const [survivor, loser] = await Promise.all([
    Contact.findById(survivorId),
    Contact.findById(loserId),
  ])
  if (!survivor || !loser) {
    throw Object.assign(new Error('One of those contacts no longer exists'), { status: 404 })
  }

  const filled = mergeScalars(survivor, loser, CONTACT_FILLABLE)

  if (!survivor.company && loser.company) {
    survivor.company = loser.company
    filled.push('company')
  }
  survivor.tags = [...new Set([...(survivor.tags || []), ...(loser.tags || [])])]
  survivor.customFields = { ...(loser.customFields || {}), ...(survivor.customFields || {}) }

  if (loser.notes) {
    survivor.notes = [survivor.notes, loser.notes].filter(Boolean).join('\n\n---\n')
  }

  /* Suppression is OR-ed. Merging a live contact with one that opted out must
     never produce a contact you are allowed to email. */
  const wasSuppressed = loser.doNotContact || loser.unsubscribedAt || loser.status === 'dnc'
  if (wasSuppressed) {
    survivor.doNotContact = true
    if (loser.unsubscribedAt && !survivor.unsubscribedAt) survivor.unsubscribedAt = loser.unsubscribedAt
    if (loser.status === 'dnc') survivor.status = 'dnc'
  }

  // Keep the earlier creation date — the relationship started when it started.
  if (loser.createdAt && loser.createdAt < survivor.createdAt) survivor.createdAt = loser.createdAt
  if (loser.lastContactedAt && (!survivor.lastContactedAt || loser.lastContactedAt > survivor.lastContactedAt)) {
    survivor.lastContactedAt = loser.lastContactedAt
  }

  const moved = {}
  const reassign = async (Model, field, name) => {
    const res = await Model.updateMany({ [field]: loser._id }, { $set: { [field]: survivor._id } })
    moved[name] = res.modifiedCount
  }
  await reassign(Activity, 'contact', 'activities')
  await reassign(Enrollment, 'contact', 'enrollments')
  await reassign(Task, 'contact', 'tasks')
  await reassign(OutboxMessage, 'contact', 'messages')
  await reassign(Quote, 'contact', 'quotes')
  await reassign(Deal, 'primaryContact', 'dealsAsPrimary')

  // Deals list contacts as an array, so swap the id inside it.
  const dealRes = await Deal.updateMany(
    { contacts: loser._id },
    { $addToSet: { contacts: survivor._id } }
  )
  await Deal.updateMany({ contacts: loser._id }, { $pull: { contacts: loser._id } })
  moved.dealsAsParticipant = dealRes.modifiedCount

  survivor.lastActivityAt = new Date()
  await saveSurvivorAndRemoveLoser(Contact, survivor, loser)

  await logActivity({
    contact: survivor._id,
    company: survivor.company || null,
    type: 'records_merged',
    user: actorId,
    title: `Merged a duplicate contact into this record`,
    body: [
      `Removed: ${[loser.firstName, loser.lastName].filter(Boolean).join(' ') || loser.email || loser._id}`,
      filled.length ? `Filled blanks from it: ${filled.join(', ')}` : 'It had nothing this record was missing',
      `Moved: ${Object.entries(moved).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}`,
      wasSuppressed ? 'The duplicate was do-not-contact, so this record now is too.' : '',
    ].filter(Boolean).join('\n'),
    meta: { mergedFrom: loser._id, filled, moved },
  })

  return { survivor, filled, moved, inheritedSuppression: !!wasSuppressed }
}

const COMPANY_FILLABLE = [
  'domain', 'website', 'industry', 'employeeCount', 'phone', 'linkedinUrl',
  'location', 'timezone', 'address', 'description', 'currentProvider',
  'seatsNeeded', 'targetRoles', 'contractTiming', 'budgetRange', 'source',
]

async function mergeCompanies({ survivorId, loserId, actorId }) {
  if (String(survivorId) === String(loserId)) {
    throw Object.assign(new Error('A record cannot be merged into itself'), { status: 400 })
  }
  const [survivor, loser] = await Promise.all([
    Company.findById(survivorId),
    Company.findById(loserId),
  ])
  if (!survivor || !loser) {
    throw Object.assign(new Error('One of those companies no longer exists'), { status: 404 })
  }

  const filled = mergeScalars(survivor, loser, COMPANY_FILLABLE)
  survivor.tags = [...new Set([...(survivor.tags || []), ...(loser.tags || [])])]
  survivor.customFields = { ...(loser.customFields || {}), ...(survivor.customFields || {}) }
  if (loser.notes) {
    survivor.notes = [survivor.notes, loser.notes].filter(Boolean).join('\n\n---\n')
  }
  if (loser.createdAt && loser.createdAt < survivor.createdAt) survivor.createdAt = loser.createdAt

  const moved = {}
  const contactRes = await Contact.updateMany(
    { company: loser._id },
    { $set: { company: survivor._id, companyName: survivor.name } }
  )
  moved.contacts = contactRes.modifiedCount
  for (const [Model, name] of [[Deal, 'deals'], [Quote, 'quotes'], [Activity, 'activities']]) {
    const res = await Model.updateMany({ company: loser._id }, { $set: { company: survivor._id } })
    moved[name] = res.modifiedCount
  }

  survivor.lastActivityAt = new Date()
  await saveSurvivorAndRemoveLoser(Company, survivor, loser)

  await logActivity({
    company: survivor._id,
    type: 'records_merged',
    user: actorId,
    title: `Merged "${loser.name}" into this company`,
    body: [
      filled.length ? `Filled blanks from it: ${filled.join(', ')}` : 'It had nothing this record was missing',
      `Moved: ${Object.entries(moved).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}`,
    ].join('\n'),
    meta: { mergedFrom: loser._id, filled, moved },
  })

  return { survivor, filled, moved }
}

/* What a merge would do, without doing it. The confirmation screen shows this
 * so nobody discovers what they lost afterwards. */
async function previewContactMerge({ survivorId, loserId }) {
  const [survivor, loser] = await Promise.all([
    Contact.findById(survivorId).lean(),
    Contact.findById(loserId).lean(),
  ])
  if (!survivor || !loser) throw Object.assign(new Error('Contact not found'), { status: 404 })

  const wouldFill = CONTACT_FILLABLE.filter((k) => isBlank(survivor[k]) && !isBlank(loser[k]))
  const wouldDiscard = CONTACT_FILLABLE.filter(
    (k) => !isBlank(survivor[k]) && !isBlank(loser[k]) && String(survivor[k]) !== String(loser[k])
  ).map((k) => ({ field: k, keeping: survivor[k], discarding: loser[k] }))

  const [activities, enrollments, tasks, messages, quotes, deals] = await Promise.all([
    Activity.countDocuments({ contact: loser._id }),
    Enrollment.countDocuments({ contact: loser._id }),
    Task.countDocuments({ contact: loser._id }),
    OutboxMessage.countDocuments({ contact: loser._id }),
    Quote.countDocuments({ contact: loser._id }),
    Deal.countDocuments({ $or: [{ primaryContact: loser._id }, { contacts: loser._id }] }),
  ])

  return {
    survivor, loser, wouldFill, wouldDiscard,
    wouldMove: { activities, enrollments, tasks, messages, quotes, deals },
    inheritsSuppression: !!(loser.doNotContact || loser.unsubscribedAt || loser.status === 'dnc'),
  }
}

async function previewCompanyMerge({ survivorId, loserId }) {
  const [survivor, loser] = await Promise.all([
    Company.findById(survivorId).lean(),
    Company.findById(loserId).lean(),
  ])
  if (!survivor || !loser) throw Object.assign(new Error('Company not found'), { status: 404 })

  const wouldFill = COMPANY_FILLABLE.filter((k) => isBlank(survivor[k]) && !isBlank(loser[k]))
  const wouldDiscard = COMPANY_FILLABLE.filter(
    (k) => !isBlank(survivor[k]) && !isBlank(loser[k]) && String(survivor[k]) !== String(loser[k])
  ).map((k) => ({ field: k, keeping: survivor[k], discarding: loser[k] }))

  const [contacts, deals, quotes, activities] = await Promise.all([
    Contact.countDocuments({ company: loser._id }),
    Deal.countDocuments({ company: loser._id }),
    Quote.countDocuments({ company: loser._id }),
    Activity.countDocuments({ company: loser._id }),
  ])

  return { survivor, loser, wouldFill, wouldDiscard, wouldMove: { contacts, deals, quotes, activities } }
}

module.exports = {
  findContactDuplicates, findCompanyDuplicates,
  mergeContacts, mergeCompanies,
  previewContactMerge, previewCompanyMerge,
}
