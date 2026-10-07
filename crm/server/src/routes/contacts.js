const express = require('express')
const multer = require('multer')
const { parse } = require('csv-parse/sync')
const ExcelJS = require('exceljs')
const {
  Contact, Company, Activity, Enrollment, Task, OutboxMessage, Suppression,
} = require('../db')
const { requireAuth, requirePermission, ownerScope } = require('../middleware/auth')
const { logActivity, suppressContactEverywhere } = require('../lib/engine')
const { resolveCompany, domainFromEmail } = require('../lib/companies')
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

  const q = (req.query.q || '').trim()
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i')
    const companyIds = await Company.find({ name: rx }).distinct('_id')
    filter.$or = [
      { firstName: rx }, { lastName: rx }, { companyName: rx },
      { email: rx }, { phone: rx }, { title: rx }, { linkedinUrl: rx },
      ...(companyIds.length ? [{ company: { $in: companyIds } }] : []),
    ]
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
  const contact = await Contact.findOne({ _id: req.params.id, ...ownerScope(req) })
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

/* ---- Create ---- */
async function attachCompany(doc, body, req) {
  if (body.company) {
    // An explicit company id from the picker wins over any typed name.
    const existing = await Company.findById(body.company)
    if (existing) {
      doc.company = existing._id
      doc.companyName = existing.name
      return existing
    }
  }
  const name = body.companyName || body.company
  if (!name && !doc.email) return null

  const extra = {}
  for (const key of COMPANY_FIELDS) {
    if (body[`company_${key}`] !== undefined) extra[key] = body[`company_${key}`]
  }
  const company = await resolveCompany({
    name,
    email: doc.email,
    website: body.company_website,
    extra,
    ownerId: doc.owner || req.user._id,
    source: doc.source || 'manual',
  })
  if (company) {
    doc.company = company._id
    doc.companyName = company.name
  }
  return company
}

router.post('/', requirePermission('contacts.edit'), async (req, res) => {
  const body = req.body || {}
  const doc = {}
  for (const key of EDITABLE) if (body[key] !== undefined) doc[key] = body[key]
  if (body.status) doc.status = body.status
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
  const contact = await Contact.findOne({ _id: req.params.id, ...ownerScope(req) })
  if (!contact) return res.status(404).json({ error: 'Contact not found' })

  const body = req.body || {}
  const changes = []
  let dealResult = null
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
    if (body.status === 'dnc') {
      contact.doNotContact = true
      await suppressContactEverywhere({
        contactId: contact._id,
        reason: 'Status set to Do Not Contact',
        actorId: req.user._id,
      })
    }
    await logActivity({
      contact: contact._id,
      company: contact.company || null,
      type: 'status_change',
      user: req.user._id,
      title: `Status: ${from} → ${body.status}`,
      meta: { from, to: body.status },
    })
    // Same handoff as a booked-meeting call outcome, for a manual status change.
    if (body.status === 'meeting_booked') {
      dealResult = await ensureDealForMeeting({ contact, actorId: req.user._id })
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

  if (body.doNotContact !== undefined && !!body.doNotContact !== contact.doNotContact) {
    contact.doNotContact = !!body.doNotContact
    if (contact.doNotContact) {
      await Suppression.updateOne(
        { email: contact.email || '', linkedinUrl: contact.linkedinUrl || '' },
        {
          $set: {
            email: contact.email || '',
            linkedinUrl: contact.linkedinUrl || '',
            reason: 'flagged on contact',
            addedBy: req.user._id,
          },
        },
        { upsert: true }
      )
      await suppressContactEverywhere({
        contactId: contact._id,
        reason: 'Flagged do-not-contact',
        actorId: req.user._id,
      })
      await logActivity({
        contact: contact._id, company: contact.company || null,
        type: 'dnc_added', user: req.user._id, title: 'Flagged do-not-contact',
      })
    }
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
  const contact = await Contact.findOne({ _id: req.params.id, ...ownerScope(req) })
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  const { body, type, channel } = req.body || {}
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Note cannot be empty' })

  const activity = await logActivity({
    contact: contact._id,
    company: contact.company || null,
    type: type === 'reply_logged' ? 'reply_logged' : 'note',
    channel: channel || '',
    user: req.user._id,
    title: type === 'reply_logged' ? 'Reply received' : 'Note',
    body: String(body).trim(),
  })

  // A logged reply is the signal the channel report hangs on, so nudge the
  // lifecycle forward if the contact is still sitting at Contacted.
  if (type === 'reply_logged' && ['new', 'contacted'].includes(contact.status)) {
    contact.status = 'engaged'
    await contact.save()
    await logActivity({
      contact: contact._id, company: contact.company || null,
      type: 'status_change', user: req.user._id,
      title: 'Status: contacted → engaged (reply logged)',
      meta: { from: 'contacted', to: 'engaged', automatic: true },
    })
  }
  res.status(201).json({ activity })
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
    await Contact.updateMany({ _id: { $in: contactIds } }, { $set: { status: value, lastActivityAt: new Date() } })
    await Activity.insertMany(
      contacts.map((c) => ({
        contact: c._id, company: c.company || null, type: 'status_change', user: req.user._id,
        title: `Status set to ${value} (bulk)`, meta: { to: value, bulk: true },
      }))
    )
    if (value === 'dnc') {
      await Contact.updateMany({ _id: { $in: contactIds } }, { $set: { doNotContact: true } })
      for (const id of contactIds) {
        await suppressContactEverywhere({ contactId: id, reason: 'Bulk do-not-contact', actorId: req.user._id })
      }
    }
    return res.json({ ok: true, affected: contactIds.length })
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
  const patterns = HEADER_PATTERNS
  const guesses = {}
  for (const header of headers) {
    for (const [field, rx] of Object.entries(patterns)) {
      if (!guesses[field] && rx.test(header)) { guesses[field] = header; break }
    }
  }
  // The company LinkedIn column must not steal the personal one.
  if (guesses.linkedinUrl && guesses.linkedinUrl === guesses.company_linkedinUrl) {
    delete guesses.company_linkedinUrl
  }

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

router.post('/import', requirePermission('contacts.import'), upload.single('file'), async (req, res) => {
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

  const suppressions = await Suppression.find().lean()
  const suppressedEmails = new Set(suppressions.filter((s) => s.email).map((s) => s.email))
  const suppressedDomains = new Set(suppressions.filter((s) => s.domain).map((s) => s.domain))

  const result = {
    total: rows.length, created: 0, updated: 0, skipped: 0,
    suppressed: 0, companiesCreated: 0, errors: [],
  }
  const seenEmail = new Set()
  const seenLinkedIn = new Set()
  const companiesBefore = await Company.countDocuments()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const doc = {}
    const companyExtra = {}
    let companyName = ''

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
      else if (field === 'email') doc.email = value.toLowerCase()
      else doc[field] = value
    }

    if (!doc.firstName && !doc.lastName && !companyName && !doc.email) {
      result.skipped++
      if (result.errors.length < 50) result.errors.push({ row: i + 2, error: 'No name, company or email' })
      continue
    }

    if (tag) doc.tags = [...new Set([...(doc.tags || []), tag])]
    doc.source = source
    doc.owner = owner

    if (doc.email && seenEmail.has(doc.email)) { result.skipped++; continue }
    if (doc.linkedinUrl && seenLinkedIn.has(doc.linkedinUrl)) { result.skipped++; continue }

    const domain = domainFromEmail(doc.email)
    if ((doc.email && suppressedEmails.has(doc.email)) || (domain && suppressedDomains.has(domain))) {
      doc.doNotContact = true
      doc.status = 'dnc'
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
      const existing = dupeOr.length ? await Contact.findOne({ $or: dupeOr }) : null

      if (existing) {
        if (onDuplicate === 'update') {
          for (const [k, v] of Object.entries(doc)) {
            if (k === 'owner' && !options.reassignOwner) continue
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
    } catch (err) {
      result.skipped++
      if (result.errors.length < 50) result.errors.push({ row: i + 2, error: err.message })
    }
  }

  result.companiesCreated = (await Company.countDocuments()) - companiesBefore
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

module.exports = router
