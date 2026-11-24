const express = require('express')
const { Campaign, Enrollment, Contact, Task, OutboxMessage, User, CHANNELS } = require('../db')
const { requireAuth, requirePermission, ownerScope, contactAccessScope } = require('../middleware/auth')
const { canUseCampaign } = require('../lib/permissions')
const { sanitizeBranches } = require('../lib/outcomes')
const { enroll, advance, setStage, exitEnrollment, materializeStage, logActivity, skipStep } = require('../lib/engine')
const { renderStage } = require('../lib/merge')

const router = express.Router()
router.use(requireAuth)

/* `channels` is a schema virtual, and .lean() results do not carry virtuals
 * unless a plugin adds them — so the list came back without it and the
 * campaign picker crashed reading channels.join. Computed here instead. */
function withChannels(c) {
  return { ...c, channels: [...new Set((c.stages || []).map((s) => s.channel))] }
}

/* Who does the step: the contact owner (default), a role's shared queue or
 * one person. Anything unrecognised falls back to the default. */
function stageAssignment(s) {
  const { ROLES } = require('../lib/permissions')
  // A Lead scraping step with no choice made goes to the Lead scraper queue.
  if (s.channel === 'scrape' && s.assignMode === undefined) {
    return { assignMode: 'role', assignRole: 'lead_scraper', assignUser: null }
  }
  if (s.assignMode === 'role' && ROLES.includes(s.assignRole) && s.assignRole !== 'admin') {
    return { assignMode: 'role', assignRole: s.assignRole, assignUser: null }
  }
  if (s.assignMode === 'user' && /^[0-9a-f]{24}$/i.test(String(s.assignUser || ''))) {
    return { assignMode: 'user', assignRole: '', assignUser: String(s.assignUser) }
  }
  return { assignMode: '', assignRole: '', assignUser: null }
}

function sanitizeStages(stages) {
  if (!Array.isArray(stages)) return []
  /* Stages keep their id across saves, so a branch's "jump to" target stays
     pointed at the same stage when stages are edited or reordered. */
  const seen = new Set()
  const ids = stages.map((s) => {
    const id = String(s?._id || '')
    if (!/^[0-9a-f]{24}$/i.test(id) || seen.has(id)) return ''
    seen.add(id)
    return id
  })
  return stages.map((s, i) => {
    const channel = CHANNELS.includes(s.channel) ? s.channel : 'email'
    return {
      ...(ids[i] ? { _id: ids[i] } : {}),
      name: String(s.name || `Stage ${i + 1}`).trim(),
      channel,
      subject: String(s.subject || ''),
      body: String(s.body || ''),
      waitDays: Math.max(0, Number(s.waitDays) || 0),
      voicemail: channel === 'call' && !!s.voicemail,
      linkedinInvite: channel === 'linkedin' && !!s.linkedinInvite,
      branches: sanitizeBranches(s.branches, channel, i, ids),
      ...stageAssignment(s),
    }
  })
}

/* ---- List with live counts ---- */
router.get('/', async (req, res) => {
  const filter = {}
  if (req.query.active === 'true') filter.active = true
  if (req.query.active === 'false') filter.active = false

  const campaigns = await Campaign.find(filter).sort({ createdAt: -1 }).lean({ virtuals: true })

  const counts = await Enrollment.aggregate([
    { $group: { _id: { campaign: '$campaign', status: '$status' }, n: { $sum: 1 } } },
  ])
  const byCampaign = new Map()
  for (const c of counts) {
    const key = String(c._id.campaign)
    const entry = byCampaign.get(key) || { active: 0, completed: 0, exited: 0 }
    entry[c._id.status] = c.n
    byCampaign.set(key, entry)
  }

  res.json({
    campaigns: campaigns.map((c) => ({
      ...withChannels(c),
      counts: byCampaign.get(String(c._id)) || { active: 0, completed: 0, exited: 0 },
      // Whether this person may add or move contacts into it. Paused
      // campaigns count: contacts wait there until it is switched back on.
      canEnroll: canUseCampaign(req.user, c._id),
    })),
  })
})

router.get('/:id', async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).lean({ virtuals: true })
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

  // Per-stage live headcount, for the board and the campaign page.
  const perStage = await Enrollment.aggregate([
    { $match: { campaign: campaign._id, status: 'active' } },
    { $group: { _id: '$currentStageIndex', n: { $sum: 1 } } },
  ])
  const stageCounts = {}
  for (const s of perStage) stageCounts[s._id] = s.n

  res.json({ campaign: withChannels(campaign), stageCounts })
})

router.post('/', requirePermission('campaigns.manage'), async (req, res) => {
  const { name, description, stages } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Campaign name is required' })
  const campaign = await Campaign.create({
    name: String(name).trim(),
    description: description || '',
    stages: sanitizeStages(stages),
    createdBy: req.user._id,
  })
  res.status(201).json({ campaign: campaign.toJSON() })
})

router.put('/:id', requirePermission('campaigns.manage'), async (req, res) => {
  const campaign = await Campaign.findById(req.params.id)
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

  const { name, description, stages, active, recheck, cold, businessDays } = req.body || {}
  if (cold !== undefined) campaign.cold = !!cold
  if (businessDays !== undefined) campaign.businessDays = !!businessDays
  if (name !== undefined) campaign.name = String(name).trim()
  if (description !== undefined) campaign.description = description
  if (active !== undefined) campaign.active = !!active
  if (recheck !== undefined) {
    const rc = recheck || {}
    campaign.recheck = {
      enabled: !!rc.enabled,
      days: Math.min(365, Math.max(1, parseInt(rc.days, 10) || 30)),
      title: String(rc.title || '').trim().slice(0, 200) || 'Re-check',
      instructions: String(rc.instructions || '').slice(0, 5000),
      assignTo: /^[0-9a-f]{24}$/i.test(String(rc.assignTo || '')) ? rc.assignTo : null,
    }
  }

  const before = campaign.stages.map((st) => ({ name: st.name, channel: st.channel, subject: st.subject, body: st.body }))
  if (stages !== undefined) {
    const next = sanitizeStages(stages)
    const activeCount = await Enrollment.countDocuments({ campaign: campaign._id, status: 'active' })
    // Shrinking a live campaign would strand contacts on a stage that no longer
    // exists, so refuse rather than silently dropping them.
    if (activeCount > 0 && next.length < campaign.stages.length) {
      const stranded = await Enrollment.countDocuments({
        campaign: campaign._id,
        status: 'active',
        currentStageIndex: { $gte: next.length },
      })
      if (stranded > 0) {
        return res.status(409).json({
          error: `${stranded} active contact${stranded === 1 ? '' : 's'} sit${stranded === 1 ? 's' : ''} on the stages you are removing. Move them first, or end the campaign.`,
        })
      }
    }
    campaign.stages = next
  }
  await campaign.save()
  // Optional: bring open tasks and unsent drafts on edited steps up to date.
  const refreshed = Array.isArray(req.body?.refreshOpenWork)
    ? await refreshOpenWork(campaign, before, req.body.refreshOpenWork)
    : null
  res.json({ campaign: campaign.toJSON(), refreshed })
})

/* Open work on the given steps: tasks not yet done and emails not yet sent.
 * The editor asks this before saving a changed script. */
const openTaskQuery = (campaignId, index) => ({ campaign: campaignId, stageIndex: index, status: 'pending', kind: { $in: ['', null] } })
const openDraftQuery = (campaignId, index) => ({ campaign: campaignId, stageIndex: index, status: { $in: ['queued', 'failed'] } })

router.get('/:id/open-work', async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).select('stages').lean()
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
  const indexes = String(req.query.stages || '').split(',').map(Number)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < campaign.stages.length)
  const steps = []
  for (const i of [...new Set(indexes)]) {
    const [tasks, drafts] = await Promise.all([
      Task.countDocuments(openTaskQuery(campaign._id, i)),
      OutboxMessage.countDocuments(openDraftQuery(campaign._id, i)),
    ])
    steps.push({ index: i, name: campaign.stages[i].name, tasks, drafts })
  }
  res.json({ steps })
})

/* Re-fill open work from the step's new wording, for each contact. Due dates,
 * who it is assigned to and anything already logged are kept. A step whose
 * channel changed is left alone (the work no longer fits it), and so is an
 * email someone already edited by hand before sending. */
async function refreshOpenWork(campaign, before, indexes) {
  const { renderStage } = require('../lib/merge')
  const out = { tasks: 0, drafts: 0, editedKept: 0, channelChanged: 0 }
  for (const i of [...new Set(indexes.map(Number))]) {
    const now = campaign.stages[i]
    const old = before[i]
    if (!Number.isInteger(i) || !now || !old) continue
    if (old.channel !== now.channel) { out.channelChanged++; continue }

    const tasks = await Task.find(openTaskQuery(campaign._id, i))
    const drafts = await OutboxMessage.find(openDraftQuery(campaign._id, i))
    const ids = [...new Set([...tasks, ...drafts].map((w) => String(w.contact)))]
    const contacts = new Map((await Contact.find({ _id: { $in: ids } }).populate('company')).map((c) => [String(c._id), c]))

    for (const t of tasks) {
      const c = contacts.get(String(t.contact))
      if (!c) continue
      const m = renderStage(now, c)
      t.scriptBody = t.swappedFrom
        ? `Their email bounced, so this replaces the email "${m.subject || now.name}". Use it as talking points:\n\n${m.body}`
        : m.body
      if (old.name !== now.name && t.title.endsWith(` — ${old.name}`)) {
        t.title = `${t.title.slice(0, -old.name.length)}${now.name}`
      }
      t.stageName = now.name
      await t.save()
      out.tasks++
    }
    for (const d of drafts) {
      const c = contacts.get(String(d.contact))
      if (!c) continue
      const was = renderStage(old, c)
      if (d.body !== was.body || d.subject !== was.subject) { out.editedKept++; continue }
      const m = renderStage(now, c)
      d.subject = m.subject
      d.body = m.body
      d.stageName = now.name
      await d.save()
      out.drafts++
    }
  }
  return out
}

/* Delete a campaign. Anyone still running in it is exited first, which
 * cancels their pending tasks and queued emails, so nothing keeps firing for
 * a campaign that no longer exists. The contacts themselves, and every
 * activity already on their timelines, are kept. */
router.delete('/:id', requirePermission('campaigns.manage'), async (req, res) => {
  const campaign = await Campaign.findById(req.params.id)
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
  const activeCount = await Enrollment.countDocuments({ campaign: campaign._id, status: { $in: ['active', 'paused'] } })
  if (activeCount > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `${activeCount} contacts are still running in this campaign.`,
      activeCount,
      hint: 'Pass force=true to exit them all and delete the campaign.',
    })
  }

  const enrollments = await Enrollment.find({ campaign: campaign._id, status: { $in: ['active', 'paused'] } })
  let cancelledTasks = 0
  let cancelledMessages = 0
  for (const e of enrollments) {
    const cancelled = await exitEnrollment({ enrollment: e, reason: `Campaign "${campaign.name}" deleted`, actorId: req.user._id })
    cancelledTasks += cancelled?.tasksCancelled || 0
    cancelledMessages += cancelled?.messagesCancelled || 0
  }

  // Nobody should keep a campaign-access entry pointing at nothing.
  await User.updateMany({ allowedCampaigns: campaign._id }, { $pull: { allowedCampaigns: campaign._id } })
  await Campaign.deleteOne({ _id: campaign._id })

  res.json({ ok: true, deleted: true, exited: enrollments.length, cancelledTasks, cancelledMessages })
})

/* ---- Preview a stage message merged against a real contact ---- */
router.post('/:id/stages/:index/preview', async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).lean()
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
  const stage = campaign.stages[Number(req.params.index)]
  if (!stage) return res.status(404).json({ error: 'Stage not found' })

  let contact = null
  if (req.body?.contactId) contact = await Contact.findById(req.body.contactId).lean()
  if (!contact) contact = await Contact.findOne({ ...ownerScope(req) }).sort({ createdAt: -1 }).lean()

  const merged = renderStage(stage, contact || {})
  res.json({ ...merged, contactUsed: contact ? { id: contact._id, name: `${contact.firstName} ${contact.lastName}`.trim() } : null })
})

/* ---- Board: contacts grouped by stage for one campaign ---- */
router.get('/:id/board', async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).lean()
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

  const contactScope = ownerScope(req)
  let contactFilter = null
  if (Object.keys(contactScope).length) {
    contactFilter = await Contact.find(contactScope).distinct('_id')
  }

  const query = { campaign: campaign._id, status: 'active' }
  if (contactFilter) query.contact = { $in: contactFilter }

  const enrollments = await Enrollment.find(query)
    .sort({ dueAt: 1 })
    .limit(2000)
    .populate({
      path: 'contact',
      select: 'firstName lastName company companyName title status email phone linkedinUrl owner doNotContact',
      populate: { path: 'company', select: 'name' },
    })
    .lean()

  const columns = campaign.stages.map((s, i) => ({
    index: i,
    name: s.name,
    channel: s.channel,
    waitDays: s.waitDays,
    cards: [],
  }))
  for (const e of enrollments) {
    const col = columns[e.currentStageIndex]
    if (col && e.contact) {
      col.cards.push({
        enrollmentId: e._id,
        dueAt: e.dueAt,
        heldForWork: !!e.heldForWork,
        enteredStageAt: e.enteredStageAt,
        contact: e.contact,
      })
    }
  }
  res.json({ campaign: { id: campaign._id, name: campaign.name }, columns, truncated: enrollments.length >= 2000 })
})

/* ---- Enrollment operations ------------------------------------------ */

// Enrol one or many contacts. A contact may hold several active enrollments.
function campaignDenied(req, res, campaignId) {
  if (!req.can('campaigns.enroll')) {
    res.status(403).json({
      error: 'You do not have permission to add or move contacts in campaigns. An admin can grant it under Settings → Users.',
      permission: 'campaigns.enroll',
    })
    return true
  }
  if (!canUseCampaign(req.user, campaignId)) {
    res.status(403).json({
      error: 'You are not allowed to add contacts to this campaign. An admin can change which campaigns you can use under Settings → Users.',
      permission: 'campaigns.enroll',
    })
    return true
  }
  return false
}

router.post('/:id/enroll', async (req, res) => {
  if (campaignDenied(req, res, req.params.id)) return
  const { contactIds } = req.body || {}
  if (!Array.isArray(contactIds) || !contactIds.length) return res.status(400).json({ error: 'No contacts selected' })
  if (contactIds.length > 5000) return res.status(400).json({ error: 'Enrol at most 5,000 contacts at a time' })

  const allowed = await Contact.find({ _id: { $in: contactIds }, ...ownerScope(req) }).select('_id').lean()

  const out = { enrolled: 0, alreadyIn: 0, errors: [] }
  for (const l of allowed) {
    try {
      const result = await enroll({ contactId: l._id, campaignId: req.params.id, actorId: req.user._id })
      if (result.created) out.enrolled++
      else out.alreadyIn++
    } catch (err) {
      if (out.errors.length < 25) out.errors.push({ contactId: l._id, error: err.message })
    }
  }
  res.json(out)
})

/* Move contacts from one campaign to another: exit the old enrollment (which
 * cancels its pending tasks and queued emails) and enrol in the new one at
 * stage 1. All history is preserved on the timeline. */
router.post('/move', async (req, res) => {
  const { contactIds, fromCampaign, toCampaign, reason } = req.body || {}
  if (!Array.isArray(contactIds) || !contactIds.length) return res.status(400).json({ error: 'No contacts selected' })
  if (!toCampaign) return res.status(400).json({ error: 'Pick a destination campaign' })
  if (campaignDenied(req, res, toCampaign)) return

  const target = await Campaign.findById(toCampaign)
  if (!target) return res.status(404).json({ error: 'Destination campaign not found' })
  if (!target.stages.length) return res.status(400).json({ error: 'The destination campaign has no stages yet' })

  const allowed = await Contact.find({ _id: { $in: contactIds }, ...ownerScope(req) }).select('_id').lean()
  const out = { moved: 0, exited: 0, cancelledTasks: 0, cancelledMessages: 0, errors: [] }

  for (const l of allowed) {
    try {
      const exitFilter = { contact: l._id, status: { $in: ['active', 'paused'] } }
      // Blank fromCampaign means "pull them out of everything they're in".
      if (fromCampaign) exitFilter.campaign = fromCampaign
      else exitFilter.campaign = { $ne: target._id }

      const current = await Enrollment.find(exitFilter)
      for (const e of current) {
        const cancelled = await exitEnrollment({
          enrollment: e,
          reason: reason || `Moved to "${target.name}"`,
          actorId: req.user._id,
        })
        out.exited++
        out.cancelledTasks += cancelled.tasksCancelled
        out.cancelledMessages += cancelled.messagesCancelled
      }

      const result = await enroll({ contactId: l._id, campaignId: target._id, actorId: req.user._id })
      if (result.created) out.moved++
    } catch (err) {
      if (out.errors.length < 25) out.errors.push({ contactId: l._id, error: err.message })
    }
  }
  res.json(out)
})

router.post('/enrollments/:id/advance', async (req, res) => {
  const enrollment = await Enrollment.findById(req.params.id)
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })
  if (enrollment.status !== 'active') return res.status(400).json({ error: 'That enrollment is no longer active' })

  const contact = await Contact.findOne({ _id: enrollment.contact, ...ownerScope(req) })
  if (!contact) return res.status(403).json({ error: 'That contact is not yours' })

  const result = await advance({ enrollment, actorId: req.user._id, manual: true })
  res.json(result)
})

/* Skip the current step for this one contact and move them on now. */
router.post('/enrollments/:id/skip-step', async (req, res) => {
  const enrollment = await Enrollment.findById(req.params.id)
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })
  const contact = await Contact.findOne({ _id: enrollment.contact, ...(await contactAccessScope(req)) })
  if (!contact) return res.status(403).json({ error: 'That contact is not yours' })
  try {
    res.json(await skipStep({ enrollment, actorId: req.user._id, reason: String(req.body?.reason || '').slice(0, 300) }))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

/* Jump straight to a chosen stage — how the board's drag-and-drop moves a card. */
router.post('/enrollments/:id/stage', async (req, res) => {
  const enrollment = await Enrollment.findById(req.params.id)
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })
  if (enrollment.status !== 'active') return res.status(400).json({ error: 'That enrollment is no longer active' })

  const contact = await Contact.findOne({ _id: enrollment.contact, ...ownerScope(req) })
  if (!contact) return res.status(403).json({ error: 'That contact is not yours' })

  try {
    const result = await setStage({
      enrollment,
      stageIndex: req.body?.stageIndex,
      actorId: req.user._id,
    })
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.post('/enrollments/:id/exit', async (req, res) => {
  const enrollment = await Enrollment.findById(req.params.id)
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })
  if (!['active', 'paused'].includes(enrollment.status)) return res.status(400).json({ error: 'That enrollment is no longer active' })

  const contact = await Contact.findOne({ _id: enrollment.contact, ...ownerScope(req) })
  if (!contact) return res.status(403).json({ error: 'That contact is not yours' })

  const cancelled = await exitEnrollment({
    enrollment,
    reason: req.body?.reason || 'Removed from campaign',
    actorId: req.user._id,
  })
  res.json({ ok: true, ...cancelled })
})

/* Push the due date out without changing stage — "not yet, try next week". */
router.post('/enrollments/:id/snooze', async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.body?.days) || 3))
  const enrollment = await Enrollment.findById(req.params.id)
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })

  const contact = await Contact.findOne({ _id: enrollment.contact, ...ownerScope(req) })
  if (!contact) return res.status(403).json({ error: 'That contact is not yours' })

  enrollment.dueAt = new Date(Date.now() + days * 86400000)
  await enrollment.save()
  await Task.updateMany({ enrollment: enrollment._id, status: 'pending' }, { $set: { dueAt: enrollment.dueAt } })
  await logActivity({
    contact: contact._id,
    type: 'note',
    user: req.user._id,
    campaign: enrollment.campaign,
    title: `Snoozed ${days} day${days === 1 ? '' : 's'}`,
  })
  res.json({ ok: true, dueAt: enrollment.dueAt })
})

/* Re-create the work item for the current stage — useful if a rep cancelled
 * a task by mistake, or the template was fixed after the fact. */
router.post('/enrollments/:id/regenerate', async (req, res) => {
  const enrollment = await Enrollment.findById(req.params.id)
  if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' })
  const contact = await Contact.findOne({ _id: enrollment.contact, ...ownerScope(req) })
  if (!contact) return res.status(403).json({ error: 'That contact is not yours' })
  const campaign = await Campaign.findById(enrollment.campaign)
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

  await Task.updateMany(
    { enrollment: enrollment._id, stageIndex: enrollment.currentStageIndex, status: 'pending' },
    { $set: { status: 'cancelled', notes: 'Replaced by regenerated task' } }
  )
  await OutboxMessage.updateMany(
    { enrollment: enrollment._id, stageIndex: enrollment.currentStageIndex, status: 'queued' },
    { $set: { status: 'cancelled', error: 'Replaced by regenerated draft' } }
  )
  const work = await materializeStage({
    enrollment,
    campaign,
    contact,
    stageIndex: enrollment.currentStageIndex,
    actorId: req.user._id,
  })
  res.json({ ok: true, work })
})

module.exports = router
