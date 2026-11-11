const express = require('express')
const {
  Task, OutboxMessage, Contact, Enrollment, Quote, Activity, Campaign, CALL_OUTCOMES,
} = require('../db')
const { requireAuth, assignedScope, ownerScope } = require('../middleware/auth')
const { logActivity, advance, enroll, suppressContactEverywhere } = require('../lib/engine')
const { sendMessage } = require('../lib/mailer')
const { suppressionReason } = require('../lib/compliance')
const { advanceStatus, markLost, REASON_NOT_INTERESTED, REASON_UNSUBSCRIBED } = require('../lib/lifecycle')
const { ensureDealForMeeting } = require('../lib/deals')
const { startOfDay, endOfDay } = require('../lib/time')

const router = express.Router()
router.use(requireAuth)

const outcomeMap = new Map(CALL_OUTCOMES.map((o) => [o.value, o]))

/* Open work from a paused (inactive) campaign stays out of the queues until
 * the campaign is switched back on. Work with no campaign is unaffected. */
async function notPaused() {
  const paused = await Campaign.find({ active: false }).distinct('_id')
  return paused.length ? { campaign: { $nin: paused } } : {}
}
const CONTACT_FIELDS =
  'firstName lastName company companyName title email phone mobile linkedinUrl status timezone location owner doNotContact unsubscribedAt emailStatus dncStatus nurture lostReason'
// Nested populate: the work queue shows the company name, and the merge
// preview on a task needs the company's own fields.
const CONTACT_POPULATE = { path: 'contact', select: CONTACT_FIELDS, populate: { path: 'company', select: 'name domain industry seatsNeeded timezone' } }

/* ---- My Day: the landing page. One call, everything a rep needs. ----
 * Buckets are measured against the signed-in rep's own timezone, so
 * "today" means their today. */
router.get('/my-day', async (req, res) => {
  const tz = req.user.timezone || 'UTC'
  const dayStart = startOfDay(tz)
  const dayEnd = endOfDay(tz)
  const weekEnd = endOfDay(tz, 7)
  const scope = assignedScope(req)
  const live = await notPaused()

  const overdueFilter = { ...scope, ...live, status: 'pending', dueAt: { $lt: dayStart } }
  const todayFilter = { ...scope, ...live, status: 'pending', dueAt: { $gte: dayStart, $lt: dayEnd } }

  const [overdueTasks, todayTasks, upcomingTasks, queuedEmails, counts] = await Promise.all([
    Task.find(overdueFilter)
      .sort({ dueAt: 1 }).limit(100)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    Task.find(todayFilter)
      .sort({ dueAt: 1 }).limit(100)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    Task.find({ ...scope, ...live, status: 'pending', dueAt: { $gte: dayEnd, $lt: weekEnd } })
      .sort({ dueAt: 1 }).limit(50)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    OutboxMessage.find({ ...scope, ...live, status: 'queued' })
      .sort({ createdAt: 1 }).limit(100)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    Promise.all([
      Task.countDocuments(overdueFilter),
      Task.countDocuments(todayFilter),
      OutboxMessage.countDocuments({ ...scope, ...live, status: 'queued' }),
      Task.countDocuments({ ...scope, status: 'done', completedAt: { $gte: dayStart } }),
      // Quotes stuck behind an approval are blocked work, so they belong in
      // the same badge count as everything else waiting on someone.
      req.can('quotes.approve')
        ? Quote.countDocuments({ status: 'pending_approval' })
        : Quote.countDocuments({ status: 'pending_approval', owner: req.user._id }),
    ]),
  ])

  res.json({
    dayStart,
    overdue: overdueTasks,
    today: todayTasks,
    upcoming: upcomingTasks,
    awaitingApproval: queuedEmails,
    counts: {
      overdue: counts[0],
      dueToday: counts[1],
      awaitingApproval: counts[2],
      completedToday: counts[3],
      quotesPendingApproval: counts[4],
    },
  })
})

/* ---- Task list with filters ---- */
router.get('/tasks', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50)
  const filter = { ...assignedScope(req) }
  if (req.query.status) filter.status = req.query.status
  else filter.status = 'pending'
  if (filter.status === 'pending' && !req.query.campaign) Object.assign(filter, await notPaused())
  if (req.query.channel) filter.channel = req.query.channel
  if (req.query.campaign) filter.campaign = req.query.campaign
  if (req.query.assignedTo && req.can('contacts.viewAll')) filter.assignedTo = req.query.assignedTo

  const [items, total] = await Promise.all([
    Task.find(filter).sort({ dueAt: 1 }).skip((page - 1) * limit).limit(limit)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    Task.countDocuments(filter),
  ])
  res.json({ items, total, page, pages: Math.ceil(total / limit) })
})

/* ---- Call list: timezone-aware, sorted by who is reachable now ---- */
router.get('/call-list', async (req, res) => {
  const filter = { ...assignedScope(req), status: 'pending', channel: 'call', ...(await notPaused()) }
  if (req.query.campaign) filter.campaign = req.query.campaign

  const tasks = await Task.find(filter)
    .sort({ dueAt: 1 })
    .limit(300)
    .populate(CONTACT_POPULATE)
    .populate('campaign', 'name')
    .lean()

  // Local hour is computed here so every rep sees the same answer regardless
  // of their own machine clock.
  const now = new Date()
  const enriched = tasks
    .filter((t) => t.contact)
    .map((t) => {
      const tz = t.contact.timezone || ''
      let localTime = null
      let localHour = null
      if (tz) {
        try {
          const fmt = new Intl.DateTimeFormat('en-GB', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
          })
          localTime = fmt.format(now)
          localHour = parseInt(localTime.slice(0, 2), 10)
        } catch {
          localTime = null
        }
      }
      const inBusinessHours = localHour == null ? null : localHour >= 8 && localHour < 18
      return { ...t, contactLocalTime: localTime, contactLocalHour: localHour, inBusinessHours }
    })

  // Callable-now first, then unknown timezone, then out-of-hours.
  const rank = (t) => (t.inBusinessHours === true ? 0 : t.inBusinessHours === null ? 1 : 2)
  enriched.sort((a, b) => rank(a) - rank(b) || new Date(a.dueAt) - new Date(b.dueAt))

  res.json({ items: enriched, callOutcomes: CALL_OUTCOMES, checkedAt: now })
})

/* ---- Complete a task ---- */
router.post('/tasks/:id/complete', async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'pending') return res.status(400).json({ error: 'That task is already closed' })

  const { outcome, notes, callbackDays, advanceNow } = req.body || {}
  let dealResult = null

  // The after-campaign re-check has its own answer instead of an outcome.
  if (task.kind === 'recheck') return completeRecheck(req, res, task)

  if (task.channel === 'call' && !outcome) {
    return res.status(400).json({ error: 'Pick a call outcome' })
  }
  if (outcome && !outcomeMap.has(outcome) && task.channel === 'call') {
    return res.status(400).json({ error: 'Unknown call outcome' })
  }

  task.status = 'done'
  task.outcome = outcome || ''
  task.notes = notes || ''
  task.completedAt = new Date()
  task.completedBy = req.user._id
  await task.save()

  const contact = await Contact.findById(task.contact)
  if (contact) {
    await logActivity({
      contact: contact._id,
      type: task.channel === 'call' ? 'call_logged' : 'linkedin_action',
      channel: task.channel,
      campaign: task.campaign,
      stageIndex: task.stageIndex,
      user: req.user._id,
      outcome: outcome || '',
      title: task.channel === 'call'
        ? `Call — ${outcomeMap.get(outcome)?.label || outcome}`
        : `LinkedIn — ${task.stageName || 'message sent'}`,
      // Store what was actually used, not a pointer to a template that may change.
      body: [task.scriptBody, notes ? `\n\nNotes: ${notes}` : ''].filter(Boolean).join(''),
    })

    contact.lastContactedAt = new Date()
    const statusChanges = []
    // The first outreach done moves a new contact to the "contacted" status.
    const touched = await advanceStatus(contact, 'contacted', { from: ['created'] })
    if (touched) statusChanges.push({ ...touched, why: 'first outreach' })

    const meta = outcomeMap.get(outcome)
    if (meta?.bookedMeeting) {
      const booked = await advanceStatus(contact, 'meeting_booked')
      if (booked) statusChanges.push({ ...booked, why: 'meeting booked' })
    }
    await contact.save()

    /* Not interested: Lost with that reason, and Nurture on. Their current
       campaigns end, but they are NOT suppressed — the monthly nurture emails
       still reach them. */
    if (outcome === 'not_interested') {
      const lost = await markLost(contact, { reason: REASON_NOT_INTERESTED, nurture: true })
      if (lost) statusChanges.push({ ...lost, why: REASON_NOT_INTERESTED })
      await suppressContactEverywhere({
        contactId: contact._id,
        reason: 'Not interested (call)',
        actorId: req.user._id,
      })
    }

    /* "Don't call again": a do-not-call request. Calls stop for good; the
       contact is Lost (Unsubscribed / do-not-contact) and their campaigns end. */
    if (outcome === 'do_not_call') {
      contact.dncStatus = 'dnc_request'
      const lost = await markLost(contact, { reason: REASON_UNSUBSCRIBED })
      if (lost) statusChanges.push({ ...lost, why: 'do-not-call request' })
      await suppressContactEverywhere({
        contactId: contact._id,
        reason: 'Do-not-call request',
        actorId: req.user._id,
      })
      await logActivity({
        contact: contact._id, type: 'suppression_changed', channel: 'call', user: req.user._id,
        title: 'Do-not-call request — calls stopped',
      })
    }

    for (const ch of statusChanges) {
      await logActivity({
        contact: contact._id, type: 'status_change', user: req.user._id,
        title: `Status: ${ch.from} → ${ch.to} (${ch.why})`,
        meta: { from: ch.from, to: ch.to, automatic: true },
      })
    }

    // A booked meeting is the handoff from outreach to pipeline. Creating the
    // deal here is what stops that handoff being a habit reps have to remember.
    if (meta?.bookedMeeting) {
      dealResult = await ensureDealForMeeting({
        contact,
        actorId: req.user._id,
        campaignId: task.campaign || null,
      })
    }
  }

  // "Call me back Thursday" becomes a real reminder, not a note nobody reads.
  let callbackTask = null
  if (callbackDays && Number(callbackDays) > 0) {
    callbackTask = await Task.create({
      contact: task.contact,
      enrollment: task.enrollment,
      campaign: task.campaign,
      stageIndex: task.stageIndex,
      stageName: task.stageName,
      channel: 'call',
      title: `Callback — ${contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') : 'contact'}`,
      scriptBody: task.scriptBody,
      assignedTo: req.user._id,
      dueAt: new Date(Date.now() + Number(callbackDays) * 86400000),
      isManual: true,
      notes: notes || '',
    })
  }

  let advanced = null
  if (advanceNow && task.enrollment) {
    const enrollment = await Enrollment.findById(task.enrollment)
    if (enrollment && enrollment.status === 'active') {
      advanced = await advance({ enrollment, actorId: req.user._id, manual: true })
    }
  }

  res.json({ ok: true, task, callbackTask, advanced, deal: dealResult })
})

/* Answer to an after-campaign re-check, e.g. F2's "is the job post still open?"
 *   answer 'open'   → the contact goes back into the same campaign at stage 1
 *   answer 'closed' → logged; nothing else happens
 * Re-enrolling is refused (and the task stays open) when the contact may no
 * longer be contacted, is already in another campaign, or the campaign is
 * paused — so the check can be answered again once that is sorted. */
async function completeRecheck(req, res, task) {
  const { answer, notes } = req.body || {}
  if (!['open', 'closed'].includes(answer)) {
    return res.status(400).json({ error: 'Answer the check: still open, or closed' })
  }
  const contact = await Contact.findById(task.contact)
  const campaign = await Campaign.findById(task.campaign)
  if (!contact) return res.status(404).json({ error: 'Contact not found' })

  let enrollment = null
  if (answer === 'open') {
    if (!campaign) return res.status(400).json({ error: 'That campaign no longer exists' })
    if (contact.doNotContact) return res.status(400).json({ error: 'This contact is flagged do not contact' })
    const elsewhere = await Enrollment.findOne({ contact: contact._id, status: 'active' }).populate('campaign', 'name').lean()
    if (elsewhere) {
      return res.status(409).json({
        error: `${contact.firstName || 'This contact'} is already running in "${elsewhere.campaign?.name || 'another campaign'}". `
          + 'Finish or remove that first, then answer this check again.',
      })
    }
    try {
      enrollment = await enroll({ contactId: contact._id, campaignId: campaign._id, actorId: req.user._id })
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message })
    }
  }

  task.status = 'done'
  task.outcome = answer
  task.notes = notes || ''
  task.completedAt = new Date()
  task.completedBy = req.user._id
  await task.save()

  await logActivity({
    contact: contact._id,
    type: 'recheck_logged',
    campaign: task.campaign,
    user: req.user._id,
    title: answer === 'open'
      ? `${task.stageName}: still open — back into "${campaign.name}"`
      : `${task.stageName}: closed — not re-enrolled`,
    body: notes || '',
  })

  res.json({ ok: true, task, reenrolled: !!enrollment })
}

router.post('/tasks/:id/skip', async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!task) return res.status(404).json({ error: 'Task not found' })
  task.status = 'skipped'
  task.notes = req.body?.reason || 'Skipped'
  task.completedAt = new Date()
  task.completedBy = req.user._id
  await task.save()
  res.json({ ok: true })
})

router.post('/tasks/:id/snooze', async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.body?.days) || 1))
  const task = await Task.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!task) return res.status(404).json({ error: 'Task not found' })
  task.dueAt = new Date(Date.now() + days * 86400000)
  await task.save()
  res.json({ ok: true, dueAt: task.dueAt })
})

/* Ad-hoc reminder unattached to any campaign. */
router.post('/tasks', async (req, res) => {
  const { contactId, title, dueAt, channel, notes } = req.body || {}
  const contact = await Contact.findOne({ _id: contactId, ...ownerScope(req) })
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  const task = await Task.create({
    contact: contact._id,
    channel: ['linkedin', 'call', 'email'].includes(channel) ? channel : 'call',
    title: title || `Follow up with ${[contact.firstName, contact.lastName].filter(Boolean).join(' ')}`,
    assignedTo: contact.owner || req.user._id,
    dueAt: dueAt ? new Date(dueAt) : new Date(),
    notes: notes || '',
    isManual: true,
  })
  res.status(201).json({ task })
})

/* ---- Outbox: the Ready-to-Send approval queue ------------------------ */

router.get('/outbox', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50)
  const filter = { ...assignedScope(req) }
  filter.status = req.query.status || 'queued'
  if (filter.status === 'queued') Object.assign(filter, await notPaused())
  if (req.query.campaign) filter.campaign = req.query.campaign

  const [items, total] = await Promise.all([
    OutboxMessage.find(filter)
      .sort({ createdAt: req.query.status === 'sent' ? -1 : 1 })
      .skip((page - 1) * limit).limit(limit)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    OutboxMessage.countDocuments(filter),
  ])
  res.json({ items, total, page, pages: Math.ceil(total / limit) })
})

router.put('/outbox/:id', async (req, res) => {
  const msg = await OutboxMessage.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!msg) return res.status(404).json({ error: 'Message not found' })
  if (msg.status !== 'queued') return res.status(400).json({ error: 'Only queued drafts can be edited' })
  if (req.body.subject !== undefined) msg.subject = req.body.subject
  if (req.body.body !== undefined) msg.body = req.body.body
  await msg.save()
  res.json({ message: msg })
})

async function deliver(msg, user) {
  const contact = await Contact.findById(msg.contact)
  if (!contact) {
    msg.status = 'failed'
    msg.error = 'Contact no longer exists'
    await msg.save()
    return { ok: false, error: msg.error }
  }

  const result = await sendMessage({ message: msg, contact, user })

  if (result.ok) {
    msg.status = 'sent'
    msg.sentAt = new Date()
    msg.sentBy = user._id
    msg.sentBody = result.sentBody
    msg.error = ''
    await msg.save()

    await logActivity({
      contact: contact._id,
      type: 'email_sent',
      channel: 'email',
      campaign: msg.campaign,
      stageIndex: msg.stageIndex,
      user: user._id,
      title: `Email sent — ${msg.subject || msg.stageName}`,
      body: result.sentBody,
      meta: { to: msg.to },
    })

    contact.lastContactedAt = new Date()
    await advanceStatus(contact, 'contacted', { from: ['created'] })
    await contact.save()
    return { ok: true }
  }

  if (result.notAttempted) {
    // Nothing was actually tried — configuration is incomplete. Leave the
    // draft queued so it can be sent once the operator fixes it, and keep the
    // timeline clean: no attempt happened.
    msg.error = result.error
    await msg.save()
    return { ok: false, error: result.error, notAttempted: true }
  }

  msg.status = result.suppressed ? 'suppressed' : 'failed'
  msg.error = result.error
  await msg.save()
  await logActivity({
    contact: contact._id,
    type: result.suppressed ? 'email_suppressed' : 'email_failed',
    channel: 'email',
    campaign: msg.campaign,
    stageIndex: msg.stageIndex,
    user: user._id,
    title: result.suppressed ? 'Email blocked' : 'Email failed to send',
    body: result.error,
  })
  return { ok: false, error: result.error }
}

router.post('/outbox/:id/send', async (req, res) => {
  const msg = await OutboxMessage.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!msg) return res.status(404).json({ error: 'Message not found' })
  if (!['queued', 'failed'].includes(msg.status)) {
    return res.status(400).json({ error: 'That message has already been sent, cancelled or blocked' })
  }

  if (req.body?.subject !== undefined) msg.subject = req.body.subject
  if (req.body?.body !== undefined) msg.body = req.body.body
  // Retrying a previously failed send puts it back in the queue first.
  if (msg.status === 'failed') { msg.status = 'queued'; msg.error = '' }

  const result = await deliver(msg, req.user)
  if (!result.ok) return res.status(400).json({ error: result.error, message: msg })
  res.json({ ok: true, message: msg })
})

router.post('/outbox/send-batch', async (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No messages selected' })
  if (ids.length > 500) return res.status(400).json({ error: 'Send at most 500 at a time' })

  const msgs = await OutboxMessage.find({
    _id: { $in: ids },
    status: { $in: ['queued', 'failed'] },
    ...assignedScope(req),
  })
  for (const m of msgs) {
    if (m.status === 'failed') { m.status = 'queued'; m.error = '' }
  }
  const out = { sent: 0, failed: 0, suppressed: 0, notAttempted: 0, errors: [] }
  for (const msg of msgs) {
    const result = await deliver(msg, req.user)
    if (result.ok) out.sent++
    else if (result.notAttempted) {
      // Configuration problem — the same one will stop every message, so stop
      // here rather than logging the identical error hundreds of times.
      out.notAttempted = msgs.length - out.sent - out.failed - out.suppressed
      out.errors.push({ error: result.error })
      break
    } else if (msg.status === 'suppressed') out.suppressed++
    else {
      out.failed++
      if (out.errors.length < 25) out.errors.push({ to: msg.to, error: result.error })
    }
  }
  res.json(out)
})

router.post('/outbox/:id/cancel', async (req, res) => {
  const msg = await OutboxMessage.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!msg) return res.status(404).json({ error: 'Message not found' })
  if (msg.status !== 'queued') return res.status(400).json({ error: 'That message is not queued' })
  msg.status = 'cancelled'
  msg.error = req.body?.reason || 'Cancelled by user'
  await msg.save()
  res.json({ ok: true })
})

/* Dry-run compliance check before a batch send, so a rep sees what will be
 * blocked before clicking rather than after. */
router.post('/outbox/precheck', async (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No messages selected' })
  const msgs = await OutboxMessage.find({ _id: { $in: ids }, ...assignedScope(req) }).populate('contact').lean()
  const blocked = []
  for (const m of msgs) {
    const reason = await suppressionReason(m.contact)
    if (reason) blocked.push({ id: m._id, to: m.to, reason })
  }
  res.json({ total: msgs.length, blocked, sendable: msgs.length - blocked.length })
})

module.exports = router
