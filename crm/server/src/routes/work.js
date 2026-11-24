const express = require('express')
const {
  Task, OutboxMessage, Contact, Enrollment, Quote, Activity, Campaign, User, CALL_OUTCOMES,
} = require('../db')
const { requireAuth, assignedScope, ownerScope, claimableScope } = require('../middleware/auth')
const {
  logActivity, advance, enroll, suppressContactEverywhere, handleReply, lockCompany, skipStep, releaseHeld,
} = require('../lib/engine')
const { ROLE_PRESETS } = require('../lib/permissions')
const rules = require('../lib/rules')
const { applyOutcome, findOutcome } = require('../lib/outcomes')
const { sendMessage } = require('../lib/mailer')
const { suppressionReason } = require('../lib/compliance')
const { advanceStatus } = require('../lib/lifecycle')
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

  // Shared queue: steps given to this person's role that nobody has claimed.
  // Anything due in the next 7 days, so the team can see what is coming.
  const queueFilter = { ...claimableScope(req), ...live, dueAt: { $lt: weekEnd } }
  const [queueTasks, queueEmails, queueTaskCount, queueEmailCount] = await Promise.all([
    Task.find({ ...queueFilter, status: 'pending' }).sort({ dueAt: 1 }).limit(50)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    OutboxMessage.find({ ...queueFilter, status: 'queued' }).sort({ createdAt: 1 }).limit(50)
      .populate(CONTACT_POPULATE).populate('campaign', 'name').lean(),
    Task.countDocuments({ ...queueFilter, status: 'pending' }),
    OutboxMessage.countDocuments({ ...queueFilter, status: 'queued' }),
  ])

  // G13: more than 1 business day overdue is escalated.
  const R = await rules.getRules()
  const cutoff = rules.escalationCutoff(new Date(), R)
  for (const t of overdueTasks) t.escalated = new Date(t.dueAt) < cutoff
  const escalatedCount = overdueTasks.filter((t) => t.escalated).length

  res.json({
    dayStart,
    escalationCutoff: cutoff,
    overdue: overdueTasks,
    today: todayTasks,
    upcoming: upcomingTasks,
    awaitingApproval: queuedEmails,
    sharedQueue: {
      role: req.user.role,
      roleLabel: ROLE_PRESETS[req.user.role]?.label || req.user.role,
      tasks: queueTasks,
      emails: queueEmails,
      total: queueTaskCount + queueEmailCount,
    },
    counts: {
      overdue: counts[0],
      escalated: escalatedCount,
      dueToday: counts[1],
      awaitingApproval: counts[2],
      completedToday: counts[3],
      quotesPendingApproval: counts[4],
    },
  })
})

/* ---- Waiting on a reply ----
 * Email and LinkedIn steps that went out before today, where the contact is
 * still on that stage and no reply has been logged since. Reps log the
 * outcome here (or "No reply yet", which hides the row for a day). */
router.get('/waiting-replies', async (req, res) => {
  const R = await rules.getRules()
  const { start } = rules.dayBounds(new Date(), R)
  const since = new Date(Date.now() - 30 * 86400000)
  const scope = assignedScope(req)
  const [emails, linkedin] = await Promise.all([
    OutboxMessage.find({ ...scope, status: 'sent', sentAt: { $gte: since, $lt: start }, enrollment: { $ne: null } })
      .select('contact enrollment campaign stageIndex stageName sentAt subject').sort({ sentAt: -1 }).limit(500).lean(),
    Task.find({ ...scope, status: 'done', channel: 'linkedin', completedAt: { $gte: since, $lt: start }, enrollment: { $ne: null } })
      .select('contact enrollment campaign stageIndex stageName completedAt').sort({ completedAt: -1 }).limit(500).lean(),
  ])
  const seen = new Set()
  const candidates = []
  for (const x of [
    ...emails.map((m) => ({ channel: 'email', at: m.sentAt, what: m.subject, ...m })),
    ...linkedin.map((t) => ({ channel: 'linkedin', at: t.completedAt, what: t.stageName, ...t })),
  ]) {
    const k = `${x.enrollment}:${x.stageIndex}`
    if (seen.has(k)) continue
    seen.add(k)
    candidates.push(x)
  }
  if (!candidates.length) return res.json({ items: [] })

  const enrollments = await Enrollment.find({
    _id: { $in: candidates.map((c) => c.enrollment) }, status: 'active', ...(await notPaused()),
  }).select('currentStageIndex replyCheckedAt').lean()
  const byId = new Map(enrollments.map((e) => [String(e._id), e]))
  const dayAgo = Date.now() - 86400000
  const live = candidates.filter((c) => {
    const e = byId.get(String(c.enrollment))
    if (!e || e.currentStageIndex !== c.stageIndex) return false
    return !(e.replyCheckedAt && new Date(e.replyCheckedAt).getTime() > dayAgo)
  })
  const replies = await Activity.find({
    contact: { $in: live.map((c) => c.contact) }, type: 'reply_logged', createdAt: { $gte: since },
  }).select('contact createdAt').lean()
  const lastReply = new Map()
  for (const r of replies) {
    const k = String(r.contact)
    if (!lastReply.has(k) || r.createdAt > lastReply.get(k)) lastReply.set(k, r.createdAt)
  }
  const waiting = live.filter((c) => !(lastReply.get(String(c.contact)) > c.at))
  const [contacts, campaigns] = await Promise.all([
    Contact.find({ _id: { $in: waiting.map((c) => c.contact) } }).select('firstName lastName companyName company').populate('company', 'name').lean(),
    Campaign.find({ _id: { $in: waiting.map((c) => c.campaign) } }).select('name').lean(),
  ])
  const cById = new Map(contacts.map((c) => [String(c._id), c]))
  const campById = new Map(campaigns.map((c) => [String(c._id), c]))
  res.json({
    items: waiting
      .filter((c) => cById.has(String(c.contact)))
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .slice(0, 100)
      .map((c) => ({
        enrollmentId: c.enrollment, channel: c.channel, at: c.at, what: c.what || '',
        stageName: c.stageName || '', contact: cById.get(String(c.contact)),
        campaign: campById.get(String(c.campaign)) ? { _id: c.campaign, name: campById.get(String(c.campaign)).name } : null,
      })),
  })
})

router.post('/waiting-replies/:enrollmentId/checked', async (req, res) => {
  const e = await Enrollment.findById(req.params.enrollmentId)
  if (!e) return res.status(404).json({ error: 'Not found' })
  const contact = await Contact.findOne({ _id: e.contact, ...ownerScope(req) }).select('_id').lean()
  if (!contact) return res.status(403).json({ error: 'That contact is not yours' })
  e.replyCheckedAt = new Date()
  await e.save()
  res.json({ ok: true })
})

/* ---- "What happens next?" for an outcome, before it is logged ----
 * A dry run of the outcome engine: the same code that will run, describing
 * each effect instead of doing it. `destructive` drives the confirmation. */
router.post('/outcome-preview', async (req, res) => {
  const { taskId, contactId, enrollmentId, channel, outcome, restartDate, person } = req.body || {}
  let ch = channel
  let enrollment = null
  let contact = null
  if (taskId) {
    const task = await Task.findOne({ _id: taskId, ...assignedScope(req) }).lean()
    if (!task) return res.status(404).json({ error: 'Task not found' })
    ch = task.channel
    contact = await Contact.findById(task.contact)
    if (task.enrollment) enrollment = await Enrollment.findById(task.enrollment)
  } else {
    contact = await Contact.findById(contactId)
    if (enrollmentId) enrollment = await Enrollment.findOne({ _id: enrollmentId, contact: contactId })
  }
  if (!contact) return res.status(404).json({ error: 'Contact not found' })
  if (!findOutcome(ch, outcome)) return res.json({ plan: [], destructive: false })
  const r = await applyOutcome({
    contact, channel: ch, outcome, enrollment, data: { restartDate, person }, actorId: req.user._id, dryRun: true,
  })
  res.json({ plan: r.plan, destructive: r.destructive, customised: !!r.branch })
})

/* ---- G13: team escalations, for the daily scoreboard ----
 * Tasks more than 1 business day overdue, grouped by the person they are
 * assigned to. Needs team-wide report access. */
router.get('/escalations', async (req, res) => {
  if (!req.can('reports.viewTeam')) return res.status(403).json({ error: 'Needs team-wide report access' })
  const R = await rules.getRules()
  const cutoff = rules.escalationCutoff(new Date(), R)
  const tasks = await Task.find({ status: 'pending', dueAt: { $lt: cutoff }, ...(await notPaused()) })
    .sort({ dueAt: 1 }).limit(500)
    .populate('assignedTo', 'name').populate('contact', 'firstName lastName companyName').populate('campaign', 'name').lean()
  const byOwner = new Map()
  for (const t of tasks) {
    let key = String(t.assignedTo?._id || 'none')
    const unclaimed = !t.assignedTo && t.assignRole
      ? `Unclaimed — ${ROLE_PRESETS[t.assignRole]?.label || t.assignRole} queue` : 'Unassigned'
    if (!t.assignedTo && t.assignRole) key = `role:${t.assignRole}`
    if (!byOwner.has(key)) byOwner.set(key, { owner: t.assignedTo?.name || unclaimed, count: 0, oldest: t.dueAt, tasks: [] })
    const g = byOwner.get(key)
    g.count++
    if (g.tasks.length < 10) g.tasks.push({ _id: t._id, title: t.title, dueAt: t.dueAt, channel: t.channel, contact: t.contact, campaign: t.campaign?.name || '' })
  }
  res.json({ cutoff, total: tasks.length, owners: [...byOwner.values()].sort((a, b) => b.count - a.count) })
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
  const callRules = await rules.getRules()
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
      // G5: inside the 9–11am / 4–6pm local call windows on a business day.
      const inCallWindow = tz ? rules.inCallWindow(now, callRules, tz) : null
      return { ...t, contactLocalTime: localTime, contactLocalHour: localHour, inBusinessHours, inCallWindow }
    })

  // Callable-now first, then unknown timezone, then out-of-hours.
  const rank = (t) => (t.inCallWindow === true ? 0 : t.inCallWindow === null ? 1 : 2)
  enriched.sort((a, b) => rank(a) - rank(b) || new Date(a.dueAt) - new Date(b.dueAt))

  res.json({ items: enriched, callOutcomes: CALL_OUTCOMES, checkedAt: now })
})

/* ---- Complete a task ---- */
const FOUND_LABELS = { email: 'Email', phone: 'Phone', mobile: 'Mobile', linkedinUrl: 'LinkedIn', title: 'Job title' }

/* What a lead scraper typed in: trimmed, empty boxes ignored, an email must
 * look like one and a LinkedIn link must be a linkedin.com address. */
function cleanFoundDetails(details) {
  const values = {}
  for (const field of Object.keys(FOUND_LABELS)) {
    const v = String(details?.[field] ?? '').trim().slice(0, field === 'linkedinUrl' ? 300 : 200)
    if (!v) continue
    if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: `"${v}" is not an email address` }
    if (field === 'linkedinUrl' && !/linkedin\.com\//i.test(v)) return { error: 'The LinkedIn link should be a linkedin.com address' }
    if ((field === 'phone' || field === 'mobile') && !/\d{5,}/.test(v.replace(/\D/g, ''))) return { error: `"${v}" does not look like a phone number` }
    values[field] = field === 'email' ? v.toLowerCase() : v
  }
  return { values }
}
/* Why a task the screen still shows is no longer open, in plain words. */
async function closedReason(task) {
  const by = task.completedBy ? await User.findById(task.completedBy).select('name').lean() : null
  const when = task.completedAt ? ` on ${new Date(task.completedAt).toDateString()}` : ''
  if (task.status === 'done') return `That task is already closed — marked done${by ? ` by ${by.name}` : ''}${when}. Your list has been refreshed.`
  const why = task.notes ? `: ${task.notes}` : ''
  return `That task is already closed (${task.status === 'skipped' ? 'skipped' : 'cancelled'}${why}). Your list has been refreshed.`
}

router.post('/tasks/:id/complete', async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'pending') return res.status(400).json({ error: await closedReason(task) })

  const { outcome, notes, callbackDays, advanceNow, person, restartDate } = req.body || {}
  let dealResult = null
  let outcomeResult = null

  // The after-campaign re-check has its own answer instead of an outcome.
  if (task.kind === 'recheck') return completeRecheck(req, res, task)

  if (task.channel === 'call' && !outcome) {
    return res.status(400).json({ error: 'Pick a call outcome' })
  }
  if (outcome && !outcomeMap.has(outcome) && task.channel === 'call') {
    return res.status(400).json({ error: 'Unknown call outcome' })
  }
  // Lead scraping always says how it went: found, partly found or not found.
  if (task.channel === 'scrape' && !findOutcome('scrape', outcome)) {
    return res.status(400).json({ error: 'Pick what you found: Found, Found some or Not found' })
  }
  // LinkedIn tasks may say what happened (optional): invite accepted, a reply…
  if (outcome && task.channel === 'linkedin' && !findOutcome('linkedin', outcome)) {
    return res.status(400).json({ error: 'Unknown LinkedIn outcome' })
  }
  // G6: one voicemail per flow, and only on a "+ VM" step.
  if (task.channel === 'call' && outcome === 'voicemail' && task.enrollment && !task.voicemailAllowed) {
    return res.status(400).json({
      error: 'No voicemail on this call — either this step is not a "+ VM" step or the flow\'s one voicemail is used. Log it as No Answer.',
    })
  }

  // Details the lead scraper found, checked before anything is saved.
  let found = null
  if (task.channel === 'scrape') {
    found = cleanFoundDetails(req.body?.details)
    if (found.error) return res.status(400).json({ error: found.error })
  }

  task.status = 'done'
  task.outcome = outcome || ''
  task.notes = notes || ''
  task.completedAt = new Date()
  task.completedBy = req.user._id
  await task.save()

  const contact = await Contact.findById(task.contact)
  if (contact && task.channel === 'scrape') {
    /* Lead scraping is work on the record, not contact with the person: it
       fills in what was found and is logged on its own, never as a touch. */
    const added = []
    for (const [field, value] of Object.entries(found.values)) {
      if (String(contact[field] || '') === value) continue
      added.push(`${FOUND_LABELS[field]}: ${contact[field] ? `${contact[field]} → ` : ''}${value}`)
      contact[field] = value
    }
    await contact.save()
    const label = findOutcome('scrape', outcome)?.label || outcome
    await logActivity({
      contact: contact._id, type: 'lead_scraped', channel: 'scrape',
      campaign: task.campaign, stageIndex: task.stageIndex, user: req.user._id, outcome,
      title: `Lead scraping — ${label}${added.length ? ` · ${added.length} detail${added.length === 1 ? '' : 's'} added` : ''}`,
      body: [added.join('\n'), notes ? `Notes: ${notes}` : ''].filter(Boolean).join('\n\n'),
      meta: { added },
    })
    const enrollment = task.enrollment ? await Enrollment.findById(task.enrollment) : null
    outcomeResult = await applyOutcome({
      contact, channel: 'scrape', outcome, enrollment, data: {}, actorId: req.user._id, stepOwner: task.assignedTo,
    })
  } else if (contact) {
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
        : `LinkedIn — ${task.stageName || 'message sent'}${outcome ? ` · ${findOutcome('linkedin', outcome)?.label || outcome}` : ''}`,
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

    // G6: the flow's one voicemail is now used.
    if (outcome === 'voicemail' && task.enrollment) {
      await Enrollment.updateOne({ _id: task.enrollment }, { $set: { voicemailLeft: true } })
    }

    /* What happens next: the global rules for this outcome, then the stage's
       branch — or, if nobody customised it, the built-in default (the CRM's
       behaviour before branches). Applies to this task's campaign only. */
    if (outcome && (task.channel === 'call' || task.channel === 'linkedin')) {
      const enrollment = task.enrollment ? await Enrollment.findById(task.enrollment) : null
      outcomeResult = await applyOutcome({
        contact, channel: task.channel, outcome, enrollment,
        data: { person, restartDate }, actorId: req.user._id, stepOwner: task.assignedTo,
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

  // A contact waiting on this task moves to the next step now.
  await releaseHeld(task.enrollment)
  res.json({ ok: true, task, callbackTask, advanced, deal: dealResult, next: outcomeResult?.plan || [] })
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
  await releaseHeld(task.enrollment)
  res.json({ ok: true })
})

/* ---- Shared queue: claim and release ----
 * Claiming is a single conditional update, so two people clicking at the
 * same moment cannot both get it. Admins may claim from any queue. */
function claimFilter(req, id) {
  const f = { _id: id, assignedTo: null, assignRole: { $exists: true, $nin: ['', null] } }
  if (req.user.role !== 'admin') f.assignRole = req.user.role
  return f
}
async function claim(Model, req, res, openStatus) {
  const doc = await Model.findOneAndUpdate(
    { ...claimFilter(req, req.params.id), status: openStatus },
    { $set: { assignedTo: req.user._id, claimedAt: new Date() } },
    { new: true }
  )
  if (!doc) {
    const exists = await Model.findById(req.params.id).select('assignedTo').populate('assignedTo', 'name').lean()
    return res.status(409).json({
      error: exists?.assignedTo ? `Already claimed by ${exists.assignedTo.name}` : 'This is not in your queue any more',
    })
  }
  // Belt and braces: confirm it is still ours before saying so.
  const check = await Model.findById(doc._id).select('assignedTo').populate('assignedTo', 'name').lean()
  if (String(check?.assignedTo?._id || '') !== String(req.user._id)) {
    return res.status(409).json({ error: `Already claimed by ${check?.assignedTo?.name || 'someone else'}` })
  }
  res.json({ ok: true, item: doc })
}
async function release(Model, req, res, openStatus) {
  const doc = await Model.findOneAndUpdate(
    { _id: req.params.id, assignedTo: req.user._id, assignRole: { $exists: true, $nin: ['', null] }, status: openStatus },
    { $set: { assignedTo: null, claimedAt: null } },
    { new: true }
  )
  if (!doc) return res.status(404).json({ error: 'Only shared-queue work you claimed can be put back' })
  res.json({ ok: true })
}
router.post('/tasks/:id/claim', (req, res) => claim(Task, req, res, 'pending'))
router.post('/tasks/:id/release', (req, res) => release(Task, req, res, 'pending'))
router.post('/outbox/:id/claim', (req, res) => claim(OutboxMessage, req, res, 'queued'))
router.post('/outbox/:id/release', (req, res) => release(OutboxMessage, req, res, 'queued'))

/* Skip this campaign step for this contact and move them to the next step. */
router.post('/tasks/:id/skip-step', async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, ...assignedScope(req) })
  if (!task) return res.status(404).json({ error: 'Task not found' })
  if (task.status !== 'pending') return res.status(400).json({ error: await closedReason(task) })
  const enrollment = task.enrollment ? await Enrollment.findById(task.enrollment) : null
  if (!enrollment || enrollment.currentStageIndex !== task.stageIndex) {
    return res.status(400).json({ error: 'This task is not the contact\'s current campaign step, so there is no step to skip. Use Skip instead.' })
  }
  try {
    res.json(await skipStep({ enrollment, actorId: req.user._id, reason: String(req.body?.reason || '').slice(0, 300) }))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
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
  if (msg.status !== 'queued' && msg.status !== 'failed') await releaseHeld(msg.enrollment)
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
    if (msg.status !== 'queued' && msg.status !== 'failed') await releaseHeld(msg.enrollment)
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
  if (!['queued', 'failed'].includes(msg.status)) return res.status(400).json({ error: 'That message is not waiting to be sent' })
  msg.status = 'cancelled'
  msg.error = req.body?.reason || 'Cancelled by user'
  await msg.save()
  await releaseHeld(msg.enrollment)
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
