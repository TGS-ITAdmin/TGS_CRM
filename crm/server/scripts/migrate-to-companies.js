#!/usr/bin/env node
/* One-time migration: flat Leads  ->  Company + Contact.
 *
 *   node scripts/migrate-to-companies.js --dry-run    # report only, no writes
 *   node scripts/migrate-to-companies.js              # apply
 *
 * Safe to run twice: it skips leads that already have a matching contact.
 *
 * Contact ids are deliberately reused from the old lead ids, so enrollments,
 * tasks, outbox messages and activities only need their `lead` field renamed
 * to `contact` — no id remapping, and nothing can be orphaned by a partial run.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })

const { connect, mongoose, Company, Contact, Settings, DEFAULT_STATUSES } = require('../src/db')
const { resolveCompany, domainFromEmail, domainFromWebsite } = require('../src/lib/companies')

const DRY = process.argv.includes('--dry-run')

// Won and Lost no longer exist on a contact — the deal owns them.
const STATUS_MAP = { won: 'customer', lost: 'nurture' }

const COMPANY_FROM_LEAD = [
  ['companySize', 'employeeCount'],
  ['industry', 'industry'],
  ['website', 'website'],
  ['companyLinkedinUrl', 'linkedinUrl'],
  ['currentProvider', 'currentProvider'],
  ['seatsNeeded', 'seatsNeeded'],
  ['targetRoles', 'targetRoles'],
  ['contractTiming', 'contractTiming'],
  ['budgetRange', 'budgetRange'],
]

const CONTACT_FROM_LEAD = [
  'firstName', 'lastName', 'title', 'email', 'phone', 'linkedinUrl',
  'location', 'timezone', 'source', 'owner', 'tags', 'notes',
  'doNotContact', 'unsubscribedAt', 'unsubscribeToken',
  'lastActivityAt', 'lastContactedAt', 'createdAt', 'updatedAt',
]

function log(...args) {
  console.log(DRY ? '[dry-run]' : '[migrate]', ...args)
}

async function main() {
  await connect()
  const db = mongoose.connection.db

  const collections = (await db.listCollections().toArray()).map((c) => c.name)
  if (!collections.includes('leads')) {
    log('No `leads` collection found — nothing to migrate.')
    await mongoose.disconnect()
    return
  }

  const leads = await db.collection('leads').find({}).toArray()
  log(`found ${leads.length} leads`)

  const stats = {
    contactsCreated: 0, contactsSkipped: 0, companiesCreated: 0,
    companiesReused: 0, statusRemapped: 0, errors: [],
  }
  const companyCache = new Map()

  for (const lead of leads) {
    try {
      const already = await Contact.findById(lead._id).lean()
      if (already) { stats.contactsSkipped++; continue }

      // ---- Company ----
      let company = null
      const name = (lead.company || '').trim()
      const domain = domainFromEmail(lead.email) || domainFromWebsite(lead.website) || ''
      const cacheKey = domain || name.toLowerCase()

      if (cacheKey) {
        if (companyCache.has(cacheKey)) {
          company = companyCache.get(cacheKey)
          stats.companiesReused++
        } else if (!DRY) {
          const before = await Company.countDocuments()
          const extra = {}
          for (const [from, to] of COMPANY_FROM_LEAD) {
            if (lead[from] !== undefined && lead[from] !== null && lead[from] !== '') {
              extra[to] = lead[from]
            }
          }
          if (lead.location && !extra.location) extra.location = lead.location
          if (lead.timezone && !extra.timezone) extra.timezone = lead.timezone

          company = await resolveCompany({
            name, email: lead.email, website: lead.website, domain,
            extra, ownerId: lead.owner || null, source: 'migration',
          })
          if (company) {
            companyCache.set(cacheKey, company)
            if ((await Company.countDocuments()) > before) stats.companiesCreated++
            else stats.companiesReused++
          }
        } else {
          stats.companiesCreated++
        }
      }

      // ---- Contact ----
      const doc = { _id: lead._id }
      for (const key of CONTACT_FROM_LEAD) {
        if (lead[key] !== undefined) doc[key] = lead[key]
      }
      doc.companyName = name
      if (company) doc.company = company._id

      const mapped = STATUS_MAP[lead.status]
      doc.status = mapped || lead.status || 'new'
      if (mapped) stats.statusRemapped++

      if (!DRY) {
        await Contact.collection.insertOne(doc)
        if (mapped) {
          // Do not silently lose the fact that this was a win or a loss —
          // a deal can be reconstructed from the note.
          await db.collection('activities').insertOne({
            contact: lead._id,
            company: company ? company._id : null,
            type: 'note',
            title: `Migrated: previous status "${lead.status}" became "${mapped}"`,
            body: 'Won and Lost now belong to a Deal. Create a deal on this contact to record the outcome properly.',
            meta: { migration: true, previousStatus: lead.status },
            createdAt: new Date(),
            updatedAt: new Date(),
          })
        }
      }
      stats.contactsCreated++
    } catch (err) {
      stats.errors.push({ lead: String(lead._id), error: err.message })
    }
  }

  // ---- Child collections: rename `lead` -> `contact`, then stamp company ----
  if (!DRY) {
    for (const name of ['enrollments', 'tasks', 'outboxmessages', 'activities']) {
      if (!collections.includes(name)) continue
      const res = await db.collection(name).updateMany(
        { lead: { $exists: true } },
        { $rename: { lead: 'contact' } }
      )
      log(`${name}: renamed lead -> contact on ${res.modifiedCount} documents`)
    }

    // Old activity type names.
    await db.collection('activities').updateMany(
      { type: 'lead_created' }, { $set: { type: 'contact_created' } }
    )
    await db.collection('activities').updateMany(
      { type: 'lead_imported' }, { $set: { type: 'contact_imported' } }
    )

    // Backfill company on activities so the company timeline is populated.
    const contacts = await Contact.find({ company: { $ne: null } }).select('company').lean()
    let stamped = 0
    for (const c of contacts) {
      const r = await db.collection('activities').updateMany(
        { contact: c._id, company: { $in: [null, undefined] } },
        { $set: { company: c.company } }
      )
      stamped += r.modifiedCount
    }
    log(`activities: stamped company on ${stamped} documents`)

    // Settings: the status list is renamed and Won/Lost removed.
    const settings = await db.collection('settings').findOne({ key: 'global' })
    if (settings && settings.leadStatuses && !settings.contactStatuses) {
      const kept = settings.leadStatuses.filter((s) => !['won', 'lost'].includes(s.value))
      const hasCustomer = kept.some((s) => s.value === 'customer')
      if (!hasCustomer) {
        kept.push({ value: 'customer', label: 'Customer', color: '#16a34a', funnelOrder: 5 })
      }
      await db.collection('settings').updateOne(
        { key: 'global' },
        { $set: { contactStatuses: kept.length ? kept : DEFAULT_STATUSES }, $unset: { leadStatuses: '' } }
      )
      log('settings: leadStatuses -> contactStatuses, Won/Lost removed')
    }

    // The old collection is left in place, renamed, rather than dropped.
    if (stats.contactsCreated > 0 && !collections.includes('leads_migrated_backup')) {
      await db.collection('leads').rename('leads_migrated_backup')
      log('leads -> leads_migrated_backup (kept as a backup; drop it when you are happy)')
    }
  }

  console.log('\n' + JSON.stringify(stats, null, 2))
  if (DRY) console.log('\nDry run — nothing was written. Re-run without --dry-run to apply.')
  await mongoose.disconnect()
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
