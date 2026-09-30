const express = require('express')
const bcrypt = require('bcryptjs')
const {
  User, Settings, Suppression, Contact, Deal, Quote,
  DEFAULT_STATUSES, CALL_OUTCOMES, FORECAST_CATEGORIES, PRICING_MODELS, QUOTE_STATUSES,
} = require('../db')
const { requireAuth, requirePermission, requireAdmin, can } = require('../middleware/auth')
const {
  PERMISSIONS, ALL_KEYS, ROLES, ROLE_PRESETS, sanitizeOverrides, ungrantable, describe,
} = require('../lib/permissions')
const { stageList } = require('../lib/deals')
const { currencyList } = require('../lib/money')
const customFields = require('../lib/custom-fields')
const { smtpStatus, verifySmtp } = require('../lib/mailer')
const { suppressContactEverywhere, logActivity } = require('../lib/engine')
const { MERGE_FIELDS } = require('../lib/merge')
const { domainOf } = require('../lib/compliance')

const router = express.Router()
router.use(requireAuth)

/* ---- Bootstrap: everything the client needs on load ---- */
router.get('/bootstrap', async (req, res) => {
  const settings = await Settings.findOne({ key: 'global' }).lean()
  const users = await User.find({ active: true }).select('name email role').lean()
  res.json({
    settings: {
      companyName: settings.companyName,
      physicalAddress: settings.physicalAddress,
      appBaseUrl: settings.appBaseUrl,
      contactStatuses: settings.contactStatuses && settings.contactStatuses.length
        ? settings.contactStatuses
        : DEFAULT_STATUSES,
      publicFormEnabled: settings.publicFormEnabled,
      reportingCurrency: settings.reportingCurrency || 'USD',
      lostReasons: settings.lostReasons || [],
      brandColor: settings.brandColor || '#2563eb',
      quoteValidDays: settings.quoteValidDays ?? 30,
    },
    quoteApproval: settings.quoteApproval || {},
    quoteStatuses: QUOTE_STATUSES,
    dealStages: stageList(settings),
    // Definitions are small and change rarely, so every form has them without
    // an extra round trip on open.
    customFields: {
      contact: await customFields.getFields('contact'),
      company: await customFields.getFields('company'),
      deal: await customFields.getFields('deal'),
    },
    currencies: currencyList(settings),
    forecastCategories: FORECAST_CATEGORIES,
    pricingModels: PRICING_MODELS,
    users: users.map((u) => ({ id: u._id, name: u.name, email: u.email, role: u.role })),
    callOutcomes: CALL_OUTCOMES,
    mergeFields: MERGE_FIELDS,
    smtp: await smtpStatus(req.user),
    can: req.user.toSafeJSON().can,
    permissionCatalogue: PERMISSIONS,
  })
})

/* ---- Company / compliance settings (admin) ---- */
router.get('/', requirePermission('settings.manage'), async (req, res) => {
  const settings = await Settings.findOne({ key: 'global' }).lean()
  if (settings.defaultSmtp) delete settings.defaultSmtp.pass
  res.json({ settings })
})

router.put('/', requirePermission('settings.manage'), async (req, res) => {
  const allowed = [
    'companyName',
    'physicalAddress',
    'unsubscribeText',
    'appBaseUrl',
    'contactStatuses',
    'publicFormEnabled',
    'reportingCurrency',
    'lostReasons',
    'brandColor',
    'quoteValidDays',
    'quoteTerms',
    'quoteNumberPrefix',
  ]
  const update = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key]
  }
  if (update.contactStatuses) {
    if (!Array.isArray(update.contactStatuses) || !update.contactStatuses.length) {
      return res.status(400).json({ error: 'At least one contact status is required' })
    }
    update.contactStatuses = update.contactStatuses.map((s, i) => ({
      value: String(s.value || '').trim() || `status_${i}`,
      label: String(s.label || '').trim() || `Status ${i + 1}`,
      color: s.color || '#64748b',
      funnelOrder: Number.isFinite(s.funnelOrder) ? s.funnelOrder : i,
    }))
  }
  const settings = await Settings.findOneAndUpdate({ key: 'global' }, { $set: update }, { new: true }).lean()
  res.json({ settings })
})

/* ---- Quote approval rules ---- */
router.get('/quote-approval', requirePermission('settings.manage'), async (req, res) => {
  const settings = await Settings.findOne({ key: 'global' }).lean()
  res.json({
    quoteApproval: settings.quoteApproval || {},
    quoteValidDays: settings.quoteValidDays ?? 30,
    quoteTerms: settings.quoteTerms || '',
    quoteNumberPrefix: settings.quoteNumberPrefix || 'Q',
    pendingApprovalCount: await Quote.countDocuments({ status: 'pending_approval' }),
  })
})

router.put('/quote-approval', requirePermission('settings.manage'), async (req, res) => {
  const body = req.body?.quoteApproval || {}
  const bool = (v) => !!v
  const num = (v, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }

  const cleaned = {
    anyDiscount: { enabled: bool(body.anyDiscount?.enabled) },
    valueOver: {
      enabled: bool(body.valueOver?.enabled),
      amount: num(body.valueOver?.amount, 250000),
    },
    discountOver: {
      enabled: bool(body.discountOver?.enabled),
      percent: Math.min(100, num(body.discountOver?.percent, 15)),
    },
    rateFloor: { enabled: bool(body.rateFloor?.enabled) },
    minTerm: {
      enabled: bool(body.minTerm?.enabled),
      months: num(body.minTerm?.months, 12),
    },
  }

  const update = { quoteApproval: cleaned }
  if (req.body?.quoteValidDays !== undefined) {
    update.quoteValidDays = Math.max(1, num(req.body.quoteValidDays, 30))
  }
  if (req.body?.quoteTerms !== undefined) update.quoteTerms = String(req.body.quoteTerms)
  if (req.body?.quoteNumberPrefix !== undefined) {
    update.quoteNumberPrefix = String(req.body.quoteNumberPrefix).trim().slice(0, 6) || 'Q'
  }

  const settings = await Settings.findOneAndUpdate(
    { key: 'global' }, { $set: update }, { new: true }
  ).lean()
  res.json({ quoteApproval: settings.quoteApproval, quoteValidDays: settings.quoteValidDays })
})

/* ---- Pipeline stages ---- */
router.put('/deal-stages', requirePermission('settings.manage'), async (req, res) => {
  const stages = req.body?.stages
  if (!Array.isArray(stages) || !stages.length) {
    return res.status(400).json({ error: 'At least one stage is required' })
  }

  const cleaned = stages.map((s, i) => ({
    key: String(s.key || '').trim() || `stage_${i}`,
    name: String(s.name || '').trim() || `Stage ${i + 1}`,
    probability: Math.max(0, Math.min(100, Number(s.probability) || 0)),
    type: ['open', 'won', 'lost'].includes(s.type) ? s.type : 'open',
    color: s.color || '#64748b',
    order: i,
  }))

  if (new Set(cleaned.map((s) => s.key)).size !== cleaned.length) {
    return res.status(400).json({ error: 'Stage keys must be unique' })
  }
  // A pipeline with no way to win or lose can never close a deal.
  if (!cleaned.some((s) => s.type === 'won')) {
    return res.status(400).json({ error: 'You need exactly one Won stage' })
  }
  if (!cleaned.some((s) => s.type === 'lost')) {
    return res.status(400).json({ error: 'You need exactly one Lost stage' })
  }
  if (!cleaned.some((s) => s.type === 'open')) {
    return res.status(400).json({ error: 'You need at least one open stage' })
  }

  // Removing a stage that deals are sitting in would strand them somewhere
  // the board cannot render.
  const keys = new Set(cleaned.map((s) => s.key))
  const stranded = await Deal.aggregate([
    { $match: { stage: { $nin: [...keys] } } },
    { $group: { _id: '$stage', n: { $sum: 1 } } },
  ])
  if (stranded.length) {
    return res.status(409).json({
      error: `Deals are still sitting in ${stranded.map((s) => `"${s._id}" (${s.n})`).join(', ')}. Move them first.`,
      stranded,
    })
  }

  const settings = await Settings.findOneAndUpdate(
    { key: 'global' }, { $set: { dealStages: cleaned } }, { new: true }
  ).lean()
  res.json({ dealStages: settings.dealStages })
})

/* ---- Currencies ---- */
router.put('/currencies', requirePermission('settings.manage'), async (req, res) => {
  const list = req.body?.currencies
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ error: 'At least one currency is required' })
  }
  const cleaned = list.map((c) => ({
    code: String(c.code || '').trim().toUpperCase().slice(0, 3),
    symbol: String(c.symbol || '').slice(0, 4),
    rate: Number(c.rate),
  }))
  if (cleaned.some((c) => !c.code)) return res.status(400).json({ error: 'Every currency needs a code' })
  if (cleaned.some((c) => !Number.isFinite(c.rate) || c.rate <= 0)) {
    return res.status(400).json({ error: 'Every currency needs a rate greater than zero' })
  }
  if (new Set(cleaned.map((c) => c.code)).size !== cleaned.length) {
    return res.status(400).json({ error: 'Currency codes must be unique' })
  }

  const reporting = String(req.body?.reportingCurrency || 'USD').toUpperCase()
  const reportingEntry = cleaned.find((c) => c.code === reporting)
  if (!reportingEntry) {
    return res.status(400).json({ error: `${reporting} must be in the list to be the reporting currency` })
  }
  // Rates are expressed in the reporting currency, so it is 1 by definition.
  if (reportingEntry.rate !== 1) {
    return res.status(400).json({
      error: `${reporting} is your reporting currency, so its rate must be exactly 1.`,
    })
  }

  await Settings.updateOne(
    { key: 'global' },
    { $set: { currencies: cleaned, reportingCurrency: reporting } }
  )
  res.json({ currencies: cleaned, reportingCurrency: reporting })
})

/* ---- SMTP ---- */
router.get('/smtp/status', async (req, res) => {
  res.json(await smtpStatus(req.user))
})

router.put('/smtp/mine', async (req, res) => {
  const { host, port, secure, user, pass, fromName, fromEmail } = req.body || {}
  req.user.smtp = {
    host: host || '',
    port: Number(port) || 587,
    secure: !!secure,
    user: user || '',
    // An empty password field means "leave the stored one alone".
    pass: pass ? pass : req.user.smtp?.pass || '',
    fromName: fromName || '',
    fromEmail: fromEmail || '',
  }
  await req.user.save()
  res.json({ user: req.user.toSafeJSON(), smtp: await smtpStatus(req.user) })
})

router.put('/smtp/shared', requirePermission('settings.manage'), async (req, res) => {
  const existing = await Settings.findOne({ key: 'global' })
  const { host, port, secure, user, pass, fromName, fromEmail } = req.body || {}
  existing.defaultSmtp = {
    host: host || '',
    port: Number(port) || 587,
    secure: !!secure,
    user: user || '',
    pass: pass ? pass : existing.defaultSmtp?.pass || '',
    fromName: fromName || '',
    fromEmail: fromEmail || '',
  }
  await existing.save()
  res.json({ ok: true })
})

router.post('/smtp/test', async (req, res) => {
  const scope = req.body?.scope === 'shared' ? 'shared' : 'mine'
  let smtp
  if (scope === 'shared') {
    if (!can(req.user, 'settings.manage')) {
      return res.status(403).json({ error: 'You do not have permission to manage settings', permission: 'settings.manage' })
    }
    const settings = await Settings.findOne({ key: 'global' }).lean()
    smtp = settings.defaultSmtp
  } else {
    smtp = req.user.smtp
  }
  if (!smtp || !smtp.host) return res.status(400).json({ error: 'No SMTP host configured' })
  try {
    await verifySmtp(smtp)
    res.json({ ok: true, message: 'Connected to the mail server successfully.' })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/* ---- Users and access rights ---- */

/* Two rules make this safe to hand to a non-admin:
 *   - Nobody can grant a right they do not hold themselves.
 *   - Nobody can change their own role or permissions.
 * Plus one that stops the account locking itself out: the last active admin
 * cannot be demoted or deactivated.
 */

async function activeAdminCount(excludeId = null) {
  const filter = { role: 'admin', active: true }
  if (excludeId) filter._id = { $ne: excludeId }
  return User.countDocuments(filter)
}

router.get('/users', requirePermission('users.manage'), async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 })
  res.json({
    users: users.map((u) => u.toSafeJSON()),
    permissions: PERMISSIONS,
    roles: ROLES.map((role) => ({
      value: role,
      label: role === 'admin' ? 'Admin' : ROLE_PRESETS[role].label,
      description: role === 'admin'
        ? 'Everything, always. At least one account must stay an admin.'
        : ROLE_PRESETS[role].description,
      permissions: role === 'admin' ? ALL_KEYS : ROLE_PRESETS[role].permissions,
    })),
    // What the person looking at this screen may hand out.
    grantable: ALL_KEYS.filter((key) => can(req.user, key)),
  })
})

router.post('/users', requirePermission('users.manage'), async (req, res) => {
  const { name, email, password, role, timezone, permissions } = req.body || {}
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' })
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }
  if (!ROLES.includes(role || 'rep')) {
    return res.status(400).json({ error: 'Unknown role' })
  }
  const exists = await User.findOne({ email: String(email).toLowerCase() })
  if (exists) return res.status(409).json({ error: 'A user with that email already exists' })

  const chosenRole = role || 'rep'
  const overrides = sanitizeOverrides(chosenRole, permissions)
  const tooHigh = ungrantable(req.user, chosenRole, overrides)
  if (tooHigh.length) {
    return res.status(403).json({
      error: `You cannot give someone rights you do not have yourself: ${tooHigh.map((k) => describe(k).label).join(', ')}.`,
      permissions: tooHigh,
    })
  }

  const user = await User.create({
    name,
    email: String(email).toLowerCase(),
    passwordHash: await bcrypt.hash(password, 10),
    role: chosenRole,
    permissions: overrides,
    timezone: timezone || 'Asia/Manila',
    mustChangePassword: true,
  })
  res.status(201).json({ user: user.toSafeJSON() })
})

router.put('/users/:id', requirePermission('users.manage'), async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) return res.status(404).json({ error: 'User not found' })

  const { name, role, active, timezone, password, permissions } = req.body || {}
  const isSelf = user._id.equals(req.user._id)

  if (name !== undefined) user.name = name
  if (timezone !== undefined) user.timezone = timezone

  /* Changing your own rights is how a permissions system gets walked around,
     so it is refused outright rather than special-cased. */
  if ((role !== undefined && role !== user.role) || permissions !== undefined) {
    if (isSelf) {
      return res.status(400).json({
        error: 'You cannot change your own role or permissions. Ask another admin.',
      })
    }
  }

  if (role !== undefined && role !== user.role) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' })
    if (user.role === 'admin' && (await activeAdminCount(user._id)) === 0) {
      return res.status(400).json({
        error: 'This is the last admin. Make someone else an admin first, or the account will have nobody who can manage it.',
      })
    }
    user.role = role
    // Overrides are relative to a role preset, so they cannot survive a role
    // change — keeping them would silently grant or remove things.
    user.permissions = {}
    user.markModified('permissions')
  }

  if (permissions !== undefined) {
    const overrides = sanitizeOverrides(role || user.role, permissions)
    const tooHigh = ungrantable(req.user, role || user.role, overrides)
    if (tooHigh.length) {
      return res.status(403).json({
        error: `You cannot give someone rights you do not have yourself: ${tooHigh.map((k) => describe(k).label).join(', ')}.`,
        permissions: tooHigh,
      })
    }
    user.permissions = overrides
    user.markModified('permissions')
  }

  if (active !== undefined && !active) {
    if (isSelf) return res.status(400).json({ error: 'You cannot deactivate your own account' })
    if (user.role === 'admin' && (await activeAdminCount(user._id)) === 0) {
      return res.status(400).json({
        error: 'This is the last active admin. Promote someone else first.',
      })
    }
  }
  if (active !== undefined) user.active = !!active

  if (password) {
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }
    user.passwordHash = await bcrypt.hash(password, 10)
    user.mustChangePassword = true
  }

  await user.save()
  res.json({ user: user.toSafeJSON() })
})

/* Deleting a person would orphan every contact, deal and activity they own,
 * so the account is deactivated instead and their records stay attached to a
 * name. Reassign first, then deactivate. */
router.delete('/users/:id', requireAdmin, async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) return res.status(404).json({ error: 'User not found' })
  if (user._id.equals(req.user._id)) {
    return res.status(400).json({ error: 'You cannot remove your own account' })
  }
  if (user.role === 'admin' && (await activeAdminCount(user._id)) === 0) {
    return res.status(400).json({ error: 'This is the last admin.' })
  }

  const [contacts, deals] = await Promise.all([
    Contact.countDocuments({ owner: user._id }),
    Deal.countDocuments({ owner: user._id }),
  ])
  user.active = false
  await user.save()
  res.json({
    ok: true,
    deactivated: true,
    owns: { contacts, deals },
    note: contacts + deals > 0
      ? `${user.name} still owns ${contacts} contact${contacts === 1 ? '' : 's'} and ${deals} deal${deals === 1 ? '' : 's'}. The account is deactivated rather than deleted so nothing is orphaned — reassign the records if someone else should pick them up.`
      : 'The account is deactivated. They can no longer sign in.',
  })
})

/* ---- Do-not-contact list ---- */
router.get('/suppressions', async (req, res) => {
  const q = (req.query.q || '').trim()
  const filter = q
    ? { $or: [{ email: new RegExp(q, 'i') }, { domain: new RegExp(q, 'i') }, { linkedinUrl: new RegExp(q, 'i') }] }
    : {}
  const [items, total] = await Promise.all([
    Suppression.find(filter).sort({ createdAt: -1 }).limit(500).populate('addedBy', 'name').lean(),
    Suppression.countDocuments(filter),
  ])
  res.json({ items, total })
})

router.post('/suppressions', requirePermission('suppression.manage'), async (req, res) => {
  const { email, domain, linkedinUrl, note } = req.body || {}
  if (!email && !domain && !linkedinUrl) {
    return res.status(400).json({ error: 'Provide an email, a domain, or a LinkedIn URL' })
  }
  const entry = await Suppression.create({
    email: email ? String(email).toLowerCase().trim() : '',
    domain: domain ? String(domain).toLowerCase().trim().replace(/^@/, '') : '',
    linkedinUrl: linkedinUrl ? String(linkedinUrl).trim() : '',
    note: note || '',
    reason: 'manual',
    addedBy: req.user._id,
  })

  // Flag any matching contacts immediately and stop work already in flight.
  const or = []
  if (entry.email) or.push({ email: entry.email })
  if (entry.linkedinUrl) or.push({ linkedinUrl: entry.linkedinUrl })
  if (entry.domain) or.push({ email: new RegExp(`@${entry.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
  let affected = 0
  if (or.length) {
    const contacts = await Contact.find({ $or: or }).select('_id').lean()
    affected = contacts.length
    for (const l of contacts) {
      await Contact.updateOne({ _id: l._id }, { $set: { doNotContact: true, status: 'dnc' } })
      await suppressContactEverywhere({
        contactId: l._id,
        reason: 'Added to do-not-contact list',
        actorId: req.user._id,
      })
      await logActivity({
        contact: l._id,
        type: 'dnc_added',
        user: req.user._id,
        title: 'Added to the do-not-contact list',
        body: note || '',
      })
    }
  }
  res.status(201).json({ entry, contactsFlagged: affected })
})

router.delete('/suppressions/:id', requirePermission('suppression.manage'), async (req, res) => {
  await Suppression.deleteOne({ _id: req.params.id })
  res.json({ ok: true })
})

module.exports = router
