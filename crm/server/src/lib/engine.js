const {
  Contact,
  Company,
  Campaign,
  Enrollment,
  Task,
  OutboxMessage,
  Activity,
} = require('../db')
const { renderStage } = require('./merge')
const { suppressionReason } = require('./compliance')
const { channelBlock, callBlock, statusList, statusForRole } = require('./lifecycle')
const rules = require('./rules')

/* The stage engine.
 *
 * Rules, as specified:
 *  - A contact auto-advances to the next stage when its dueAt passes.
 *  - An EMAIL stage never auto-sends. It queues a merged draft in the outbox
 *    for one-click human approval.
 *  - A LINKEDIN or CALL stage becomes a task with the script already merged.
 *  - LinkedIn is never automated. There is no send path for it anywhere in
 *    this codebase; the rep copies the message and sends it themselves.
 *  - A contact may hold several active enrollments at once.
 *  - Exiting a campaign cancels its pending work but keeps all history.
 */

const DAY_MS = 24 * 60 * 60 * 1000

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * DAY_MS)
}

/* G11: a stage wait in business days (Mon–Fri, no holidays) unless the
 * campaign is set to calendar days. */
async function stageDue(campaign, from, days) {
  if (campaign && campaign.businessDays === false) return addDays(from, days)
  return rules.addBusinessDays(from, days, await rules.getRules())
}

/* G8 helper: "LinkedIn connected = Yes", read from a custom field whose key
 * mentions linkedin + connected (e.g. linkedin_connected). */
function linkedinConnected(contact) {
  const cf = contact.customFields || {}
  for (const [k, v] of Object.entries(cf instanceof Map ? Object.fromEntries(cf) : cf)) {
    if (/linked\s*in.*connect/i.test(k) || /linkedin_?connected/i.test(k)) {
      if (v === true || /^(yes|true|y|1)$/i.test(String(v).trim())) return true
    }
  }
  return false
}

/* Every activity is stamped with the company as well as the contact, so the
 * company timeline is a single indexed query instead of a fan-out over every
 * contact there. Callers may pass `company` explicitly; otherwise it is
 * resolved from the contact. */
async function logActivity(fields) {
  const payload = { ...fields }
  if (payload.contact && payload.company === undefined) {
    const contact = await Contact.findById(payload.contact).select('company').lean()
    payload.company = contact?.company || null
  }
  const doc = await Activity.create(payload)
  const now = new Date()
  if (payload.contact) {
    await Contact.updateOne({ _id: payload.contact }, { $set: { lastActivityAt: now } })
  }
  if (payload.company) {
    await Company.updateOne({ _id: payload.company }, { $set: { lastActivityAt: now } })
  }
  return doc
}

const CHANNEL_VERB = {
  linkedin: 'Send LinkedIn message',
  call: 'Call',
  email: 'Email',
}

/* Turns "the contact is now on stage N" into actual work a human can see. */
async function materializeStage({ enrollment, campaign, contact, stageIndex, actorId }) {
  const stage = campaign.stages[stageIndex]
  if (!stage) return null
  const R = await rules.getRules()
  const skip = async (title, body) => {
    await logActivity({
      contact: contact._id, type: 'step_skipped', channel: stage.channel,
      campaign: campaign._id, stageIndex, title, body,
    })
    return { kind: 'skipped', reason: body }
  }

  /* G8 bounce swap: an email step for a bounced address becomes a call (if
     calls are allowed) or a LinkedIn message (if connected), else it is
     skipped. Unsubscribed or do-not-contact are never swapped. */
  let channel = stage.channel
  let swappedFrom = ''
  if (channel === 'email' && contact.emailStatus === 'bounced' && !contact.doNotContact) {
    if (!callBlock(contact)) channel = 'call'
    else if (linkedinConnected(contact)) channel = 'linkedin'
    else return skip(`Email step skipped — ${stage.name}`, 'Email bounced; no call or LinkedIn route available')
    swappedFrom = 'email'
  }

  /* G12 compliance gate: cold flows create no email or call work until the
     sign-off is recorded. LinkedIn and internal work carry on. */
  if (campaign.cold && !R.complianceSignedOffAt && (channel === 'email' || channel === 'call')) {
    return skip(`${channel === 'email' ? 'Email' : 'Call'} step held — ${stage.name}`,
      'Compliance sign-off not recorded yet (cold flows send no email or calls until then)')
  }

  /* G9 touch caps in cold flows: 4 emails, 3 calls, 2 LinkedIn per flow. */
  if (campaign.cold) {
    const cap = Number(R.touchCaps[channel])
    const used = Number(enrollment.touches?.[channel] || 0)
    if (cap >= 0 && used >= cap) {
      return skip(`${channel === 'call' ? 'Call' : channel === 'email' ? 'Email' : 'LinkedIn'} step skipped — ${stage.name}`,
        `Touch cap reached: ${used} ${channel} touch${used === 1 ? '' : 'es'} already in this flow (limit ${cap})`)
    }
  }
  const countTouch = () => Enrollment.updateOne({ _id: enrollment._id }, { $inc: { [`touches.${channel}`]: 1 } })

  const merged = renderStage(stage, contact)
  const assignedTo = contact.owner || enrollment.enrolledBy || actorId || null
  const base = {
    contact: contact._id,
    enrollment: enrollment._id,
    campaign: campaign._id,
    stageIndex,
    stageName: stage.name,
    assignedTo,
    dueAt: new Date(),
  }

  if (channel === 'email') {
    const reason = await suppressionReason(contact)
    if (reason) {
      // Record the skip rather than silently dropping it — a rep looking at
      // the timeline should be able to see why this contact got no email.
      await OutboxMessage.create({
        ...base,
        to: contact.email || '(no address)',
        subject: merged.subject,
        body: merged.body,
        status: 'suppressed',
        error: reason,
      })
      await logActivity({
        contact: contact._id,
        type: 'email_suppressed',
        channel: 'email',
        campaign: campaign._id,
        stageIndex,
        title: `Email not queued — ${stage.name}`,
        body: reason,
      })
      return { kind: 'suppressed', reason }
    }

    const msg = await OutboxMessage.create({
      ...base,
      to: contact.email,
      subject: merged.subject,
      body: merged.body,
      status: 'queued',
    })
    await countTouch()
    return { kind: 'outbox', id: msg._id, missing: merged.missing }
  }

  /* Calls and LinkedIn follow their own suppression: a do-not-call status
     stops calls only, and an email unsubscribe never stops a call. The step
     is skipped and the reason logged; the campaign carries on. */
  const blocked = channelBlock(contact, channel)
  if (blocked) return skip(`${channel === 'call' ? 'Call' : 'LinkedIn'} step skipped — ${stage.name}`, blocked)

  const extra = {}
  let dueAt = base.dueAt
  if (campaign.businessDays !== false) dueAt = rules.onBusinessDay(dueAt, R)

  if (channel === 'call') {
    // G5: due at the contact's next call window (9–11am / 4–6pm local, Mon–Fri).
    dueAt = rules.nextCallWindow(dueAt, R, contact.timezone)
    // G6: only a "+ VM" step may leave a voicemail, and only one per flow.
    extra.voicemailAllowed = !swappedFrom && !!stage.voicemail && !enrollment.voicemailLeft
  }

  if (channel === 'linkedin' && stage.linkedinInvite && !swappedFrom) {
    // G10: at most N invites per profile (rep) per business day; overflow rolls on.
    extra.linkedinInvite = true
    const cap = Math.max(1, Number(R.linkedinInviteCap) || 20)
    for (let i = 0; i < 30; i++) {
      const { start, end } = rules.dayBounds(dueAt, R)
      const used = await Task.countDocuments({
        assignedTo: base.assignedTo, linkedinInvite: true,
        status: { $in: ['pending', 'done'] }, dueAt: { $gte: start, $lt: end },
      })
      if (used < cap) break
      dueAt = rules.addBusinessDays(dueAt, 1, R)
    }
  }

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.companyName || 'contact'
  const verb = swappedFrom
    ? (channel === 'call' ? 'Call (email bounced)' : 'LinkedIn message (email bounced)')
    : CHANNEL_VERB[channel] || 'Follow up with'
  const task = await Task.create({
    ...base,
    ...extra,
    dueAt,
    channel,
    swappedFrom,
    title: `${verb} ${name} — ${stage.name}`,
    scriptBody: swappedFrom
      ? `Their email bounced, so this replaces the email "${merged.subject || stage.name}". Use it as talking points:\n\n${merged.body}`
      : merged.body,
  })
  await countTouch()
  return { kind: 'task', id: task._id, missing: merged.missing }
}

/* After-campaign re-check (campaign.recheck). Only for someone who finished
 * with no response — still at New or Contacted, not Lost, not suppressed.
 * Anyone who replied, booked or opted out has already moved on. */
async function scheduleRecheck({ campaign, contact, enrollment, now = new Date() }) {
  const rc = campaign.recheck
  if (!rc || !rc.enabled) return null
  if (contact.doNotContact) return null
  const list = await statusList()
  const quiet = ['created', 'contacted'].map((r) => statusForRole(list, r)).filter(Boolean)
  if (quiet.length && !quiet.includes(contact.status)) return null

  const days = Math.max(1, Number(rc.days) || 30)
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.companyName || 'contact'
  const task = await Task.create({
    contact: contact._id,
    enrollment: enrollment._id,
    campaign: campaign._id,
    stageIndex: campaign.stages.length - 1,
    stageName: rc.title || 'Re-check',
    channel: 'internal',
    kind: 'recheck',
    title: `${rc.title || 'Re-check'} — ${name}`,
    scriptBody: rc.instructions || '',
    assignedTo: rc.assignTo || contact.owner || enrollment.enrolledBy || null,
    // "30 days" is calendar time; it lands on the next business day.
    dueAt: rules.onBusinessDay(addDays(now, days), await rules.getRules()),
  })
  await logActivity({
    contact: contact._id,
    type: 'recheck_logged',
    campaign: campaign._id,
    title: `Re-check scheduled in ${days} day${days === 1 ? '' : 's'}: ${rc.title || 'Re-check'}`,
  })
  return { id: task._id, dueAt: task.dueAt }
}

/* Enrol a contact into a campaign at stage 0. */
async function enroll({ contactId, campaignId, actorId }) {
  const [contact, campaign] = await Promise.all([
    Contact.findById(contactId).populate('company'),
    Campaign.findById(campaignId),
  ])
  if (!contact) throw Object.assign(new Error('Contact not found'), { status: 404 })
  if (!campaign) throw Object.assign(new Error('Campaign not found'), { status: 404 })
  if (!campaign.stages.length) {
    throw Object.assign(new Error('That campaign has no stages yet'), { status: 400 })
  }
  if (campaign.active === false) {
    throw Object.assign(new Error(`"${campaign.name}" is paused. Turn it back on before adding contacts.`), { status: 400 })
  }

  /* G2: nobody new is enrolled at a locked company (the contact who caused
     the lock is the exception — their own follow-up continues by hand). */
  const company = contact.company && contact.company._id ? contact.company : null
  if (company && company.locked && String(company.lockedBy || '') !== String(contact._id)) {
    throw Object.assign(
      new Error(`${company.name} is locked — someone there replied or booked. Clear the lock on the company first.`),
      { status: 409 }
    )
  }

  const already = await Enrollment.findOne({
    contact: contact._id,
    campaign: campaign._id,
    status: { $in: ['active', 'paused'] },
  })
  if (already) {
    return { enrollment: already, created: false }
  }

  const now = new Date()
  const enrollment = await Enrollment.create({
    contact: contact._id,
    campaign: campaign._id,
    currentStageIndex: 0,
    status: 'active',
    enteredStageAt: now,
    dueAt: await stageDue(campaign, now, campaign.stages[0].waitDays),
    history: [
      {
        stageIndex: 0,
        stageName: campaign.stages[0].name,
        channel: campaign.stages[0].channel,
        enteredAt: now,
      },
    ],
    enrolledBy: actorId || null,
  })

  const work = await materializeStage({
    enrollment,
    campaign,
    contact,
    stageIndex: 0,
    actorId,
  })

  await logActivity({
    contact: contact._id,
    type: 'campaign_enrolled',
    campaign: campaign._id,
    stageIndex: 0,
    user: actorId || null,
    channel: campaign.stages[0].channel,
    title: `Entered "${campaign.name}" at ${campaign.stages[0].name}`,
  })

  return { enrollment, created: true, work }
}

/* Move an enrollment to its next stage. Called by the scheduler when dueAt
 * passes, and by a rep clicking "advance now". */
async function advance({ enrollment, actorId = null, manual = false }) {
  const campaign = await Campaign.findById(enrollment.campaign)
  const contact = await Contact.findById(enrollment.contact).populate('company')
  if (!campaign || !contact) {
    enrollment.status = 'exited'
    enrollment.exitReason = 'Contact or campaign no longer exists'
    enrollment.exitedAt = new Date()
    enrollment.dueAt = null
    await enrollment.save()
    return { advanced: false, reason: 'missing' }
  }

  const now = new Date()
  const nextIndex = enrollment.currentStageIndex + 1

  // Close the history entry we're leaving.
  const openEntry = enrollment.history[enrollment.history.length - 1]
  if (openEntry && !openEntry.leftAt) openEntry.leftAt = now

  if (nextIndex >= campaign.stages.length) {
    enrollment.status = 'completed'
    enrollment.dueAt = null
    enrollment.exitedAt = now
    await enrollment.save()
    await logActivity({
      contact: contact._id,
      type: 'campaign_completed',
      campaign: campaign._id,
      user: actorId,
      title: `Finished "${campaign.name}"`,
    })
    const recheck = await scheduleRecheck({ campaign, contact, enrollment, now })
    return { advanced: false, completed: true, recheck }
  }

  // Work for the stage we are leaving is now stale — a first-touch message
  // sent after the second touch is worse than not sending it at all.
  await retireStageWork(enrollment._id, enrollment.currentStageIndex, contact._id, campaign._id)

  const stage = campaign.stages[nextIndex]
  enrollment.currentStageIndex = nextIndex
  enrollment.enteredStageAt = now
  enrollment.dueAt = await stageDue(campaign, now, stage.waitDays)
  enrollment.history.push({
    stageIndex: nextIndex,
    stageName: stage.name,
    channel: stage.channel,
    enteredAt: now,
  })
  await enrollment.save()

  const work = await materializeStage({
    enrollment,
    campaign,
    contact,
    stageIndex: nextIndex,
    actorId,
  })

  await logActivity({
    contact: contact._id,
    type: 'stage_advanced',
    campaign: campaign._id,
    stageIndex: nextIndex,
    channel: stage.channel,
    user: manual ? actorId : null,
    title: `Moved to ${stage.name}${manual ? '' : ' (automatic)'}`,
    meta: { manual, work: work && work.kind },
  })

  return { advanced: true, stageIndex: nextIndex, work }
}

/* Jump an enrollment to a specific stage — forwards or backwards. Used by the
 * board's drag-and-drop. Pending work for the stage being left is cancelled so
 * a rep is never holding a task for a stage the contact is no longer on. */
async function setStage({ enrollment, stageIndex, actorId }) {
  const campaign = await Campaign.findById(enrollment.campaign)
  const contact = await Contact.findById(enrollment.contact).populate('company')
  if (!campaign || !contact) throw Object.assign(new Error('Contact or campaign missing'), { status: 404 })

  const index = Number(stageIndex)
  if (!Number.isInteger(index) || index < 0 || index >= campaign.stages.length) {
    throw Object.assign(new Error('That stage does not exist'), { status: 400 })
  }
  if (index === enrollment.currentStageIndex) return { changed: false }

  const from = campaign.stages[enrollment.currentStageIndex]
  const stage = campaign.stages[index]
  const now = new Date()

  // Same treatment as an automatic advance: retire the stage being left so a
  // stale task cannot outlive the move, and record that it happened.
  await retireStageWork(enrollment._id, enrollment.currentStageIndex, contact._id, campaign._id)

  const openEntry = enrollment.history[enrollment.history.length - 1]
  if (openEntry && !openEntry.leftAt) openEntry.leftAt = now

  enrollment.currentStageIndex = index
  enrollment.enteredStageAt = now
  enrollment.dueAt = await stageDue(campaign, now, stage.waitDays)
  enrollment.history.push({
    stageIndex: index,
    stageName: stage.name,
    channel: stage.channel,
    enteredAt: now,
  })
  await enrollment.save()

  const work = await materializeStage({ enrollment, campaign, contact, stageIndex: index, actorId })

  await logActivity({
    contact: contact._id,
    type: 'stage_advanced',
    campaign: campaign._id,
    stageIndex: index,
    channel: stage.channel,
    user: actorId,
    title: `Moved from ${from ? from.name : 'a removed stage'} to ${stage.name}`,
    meta: { manual: true, work: work && work.kind },
  })

  return { changed: true, stageIndex: index, work }
}

/* Close out anything still pending for a stage the contact has just left.
 * Skipped rather than deleted, so the reports still show it was never done. */
async function retireStageWork(enrollmentId, stageIndex, contactId, campaignId) {
  const note = 'The contact moved to the next stage before this was done'
  const [tasks, msgs] = await Promise.all([
    Task.updateMany(
      { enrollment: enrollmentId, stageIndex, status: 'pending' },
      { $set: { status: 'skipped', notes: note } }
    ),
    OutboxMessage.updateMany(
      { enrollment: enrollmentId, stageIndex, status: 'queued' },
      { $set: { status: 'cancelled', error: note } }
    ),
  ])
  const dropped = tasks.modifiedCount + msgs.modifiedCount
  if (dropped > 0 && contactId) {
    await logActivity({
      contact: contactId,
      type: 'task_cancelled',
      campaign: campaignId,
      stageIndex,
      title: `${dropped} unfinished item${dropped === 1 ? '' : 's'} dropped when the contact moved on`,
      body: note,
      meta: { tasks: tasks.modifiedCount, messages: msgs.modifiedCount },
    })
  }
  return dropped
}

/* Cancel every pending piece of work an enrollment produced. History stays. */
async function cancelPendingWork(enrollmentId, note = 'Campaign changed') {
  const [tasks, msgs] = await Promise.all([
    Task.updateMany(
      { enrollment: enrollmentId, status: 'pending' },
      { $set: { status: 'cancelled', notes: note } }
    ),
    OutboxMessage.updateMany(
      { enrollment: enrollmentId, status: 'queued' },
      { $set: { status: 'cancelled', error: note } }
    ),
  ])
  return { tasksCancelled: tasks.modifiedCount, messagesCancelled: msgs.modifiedCount }
}

async function exitEnrollment({ enrollment, reason, actorId }) {
  const now = new Date()
  const openEntry = enrollment.history[enrollment.history.length - 1]
  if (openEntry && !openEntry.leftAt) openEntry.leftAt = now
  enrollment.status = 'exited'
  enrollment.exitReason = reason || 'Removed from campaign'
  enrollment.exitedAt = now
  enrollment.dueAt = null
  await enrollment.save()

  const cancelled = await cancelPendingWork(enrollment._id, reason || 'Removed from campaign')

  const campaign = await Campaign.findById(enrollment.campaign).lean()
  await logActivity({
    contact: enrollment.contact,
    type: 'campaign_exited',
    campaign: enrollment.campaign,
    user: actorId,
    title: `Left "${campaign ? campaign.name : 'campaign'}" — ${reason || 'removed'}`,
    meta: cancelled,
  })
  return cancelled
}

/* ---- G1 / G2: pausing and resuming flows ---- */

const PAUSE_LABEL = { reply: 'they replied', company_lock: 'company locked', manual: 'paused by hand' }

/* Pause one enrollment: its open tasks and queued emails are cancelled and
 * the stage timer stops. Resuming re-creates the current step. */
async function pauseEnrollment({ enrollment, reason, actorId, note }) {
  if (enrollment.status !== 'active') return false
  enrollment.status = 'paused'
  enrollment.pausedReason = reason
  enrollment.pausedAt = new Date()
  enrollment.dueAt = null
  await enrollment.save()
  await cancelPendingWork(enrollment._id, `Paused — ${PAUSE_LABEL[reason] || reason}`)
  const campaign = await Campaign.findById(enrollment.campaign).select('name').lean()
  await logActivity({
    contact: enrollment.contact, type: 'flow_paused', campaign: enrollment.campaign, user: actorId || null,
    title: `"${campaign ? campaign.name : 'Campaign'}" paused — ${PAUSE_LABEL[reason] || reason}`,
    body: note || '',
  })
  return true
}

async function resumeEnrollment({ enrollment, actorId }) {
  if (enrollment.status !== 'paused') {
    throw Object.assign(new Error('That flow is not paused'), { status: 400 })
  }
  const [campaign, contact] = await Promise.all([
    Campaign.findById(enrollment.campaign),
    Contact.findById(enrollment.contact).populate('company'),
  ])
  if (!campaign || !contact) throw Object.assign(new Error('Campaign or contact not found'), { status: 404 })
  if (contact.company?.locked && String(contact.company.lockedBy || '') !== String(contact._id)) {
    throw Object.assign(new Error(`${contact.company.name} is still locked. Clear the lock first.`), { status: 409 })
  }
  const now = new Date()
  const stage = campaign.stages[enrollment.currentStageIndex]
  enrollment.status = 'active'
  enrollment.pausedReason = ''
  enrollment.pausedAt = null
  enrollment.enteredStageAt = now
  enrollment.dueAt = await stageDue(campaign, now, stage ? stage.waitDays : 0)
  await enrollment.save()
  const work = await materializeStage({
    enrollment, campaign, contact, stageIndex: enrollment.currentStageIndex, actorId,
  })
  await logActivity({
    contact: contact._id, type: 'flow_resumed', campaign: campaign._id, user: actorId || null,
    title: `"${campaign.name}" resumed at ${stage ? stage.name : 'current stage'}`,
  })
  return { resumed: true, work }
}

/* G2: lock a company because `contact` replied or booked. Everyone else's
 * running flows there are paused. Returns how many were paused. */
async function lockCompany({ contact, reason, actorId }) {
  const companyId = contact.company?._id || contact.company
  if (!companyId) return 0
  const company = await Company.findById(companyId)
  if (!company) return 0
  if (!company.locked) {
    company.locked = true
    company.lockedAt = new Date()
    company.lockedBy = contact._id
    company.lockReason = reason
    await company.save()
    await logActivity({
      contact: contact._id, company: company._id, type: 'company_locked', user: actorId || null,
      title: `${company.name} locked — ${reason}`,
    })
  }
  const others = await Contact.find({ company: company._id, _id: { $ne: contact._id } }).distinct('_id')
  const list = await Enrollment.find({ contact: { $in: others }, status: 'active' })
  for (const e of list) await pauseEnrollment({ enrollment: e, reason: 'company_lock', actorId, note: reason })
  return list.length
}

async function unlockCompany({ companyId, actorId, resume = true }) {
  const company = await Company.findById(companyId)
  if (!company) throw Object.assign(new Error('Company not found'), { status: 404 })
  company.locked = false
  company.lockedAt = null
  company.lockedBy = null
  company.lockReason = ''
  await company.save()
  let resumed = 0
  if (resume) {
    const ids = await Contact.find({ company: company._id }).distinct('_id')
    const list = await Enrollment.find({ contact: { $in: ids }, status: 'paused', pausedReason: 'company_lock' })
    for (const e of list) {
      try { await resumeEnrollment({ enrollment: e, actorId }); resumed++ } catch { /* left paused */ }
    }
  }
  await logActivity({ company: company._id, type: 'company_unlocked', user: actorId || null, title: `${company.name} unlocked` })
  return { resumed }
}

/* G1: a reply or a real conversation. Every running flow for the contact is
 * paused, a Respond task goes to the step owner (positive: due in 15
 * business-hour minutes), and the company is locked (G2). `respond: false`
 * skips the task when the outcome already says what happens next. */
async function handleReply({ contact, positive = false, respond = true, source = 'reply', actorId }) {
  const R = await rules.getRules()
  const running = await Enrollment.find({ contact: contact._id, status: 'active' })
  let owner = null
  for (const e of running) {
    const open = await Task.findOne({ enrollment: e._id, status: 'pending' }).select('assignedTo').lean()
    if (open?.assignedTo && !owner) owner = open.assignedTo
    await pauseEnrollment({ enrollment: e, reason: 'reply', actorId, note: source })
  }
  let task = null
  if (respond) {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.companyName || 'contact'
    task = await Task.create({
      contact: contact._id,
      channel: 'internal',
      kind: 'respond',
      isManual: true,
      title: `${positive ? 'Respond now (positive reply)' : 'Respond'} — ${name}`,
      scriptBody: positive
        ? 'Positive reply. Offer two times for the 30-minute process review, or book it straight into the calendar.'
        : 'Read the reply and answer it. Their flow is paused; resume it from the contact page if it should carry on.',
      assignedTo: owner || contact.owner || actorId || null,
      dueAt: rules.respondDue(new Date(), positive, R),
    })
  }
  const lockedOthers = await lockCompany({ contact, reason: `${contact.firstName || 'A contact'} ${source}`, actorId })
  return { paused: running.length, respondTask: task ? task._id : null, lockedOthers }
}

/* Scheduler tick. Processes everything whose dueAt has passed.
 * Batched so a backlog of thousands doesn't blow up memory. */
async function runDueEnrollments({ limit = 500, now = new Date() } = {}) {
  /* A paused (inactive) campaign does not move anyone on. Its contacts stay
     where they are and catch up when it is switched back on. */
  const paused = await Campaign.find({ active: false }).distinct('_id')
  const due = await Enrollment.find({
    status: 'active',
    dueAt: { $ne: null, $lte: now },
    ...(paused.length ? { campaign: { $nin: paused } } : {}),
  })
    .limit(limit)
    .exec()

  let advanced = 0
  let completed = 0
  const errors = []

  for (const enrollment of due) {
    try {
      const result = await advance({ enrollment, manual: false })
      if (result.advanced) advanced++
      if (result.completed) completed++
    } catch (err) {
      errors.push({ enrollment: enrollment._id.toString(), error: err.message })
    }
  }

  return { examined: due.length, advanced, completed, errors }
}

/* When a contact opts out or is marked DNC, stop everything in flight. */
async function suppressContactEverywhere({ contactId, reason, actorId, keepCallTasks = false }) {
  const filter = { contact: contactId, status: 'pending' }
  if (keepCallTasks) filter.channel = { $ne: 'call' }
  const [tasks, msgs] = await Promise.all([
    Task.updateMany(filter, { $set: { status: 'cancelled', notes: reason } }),
    OutboxMessage.updateMany(
      { contact: contactId, status: 'queued' },
      { $set: { status: 'cancelled', error: reason } }
    ),
  ])
  await Enrollment.updateMany(
    { contact: contactId, status: { $in: ['active', 'paused'] } },
    { $set: { status: 'exited', exitReason: reason, exitedAt: new Date(), dueAt: null, pausedReason: '' } }
  )
  return { tasksCancelled: tasks.modifiedCount, messagesCancelled: msgs.modifiedCount }
}

module.exports = {
  scheduleRecheck,
  stageDue,
  pauseEnrollment,
  resumeEnrollment,
  lockCompany,
  unlockCompany,
  handleReply,
  linkedinConnected,
  enroll,
  advance,
  setStage,
  retireStageWork,
  exitEnrollment,
  cancelPendingWork,
  runDueEnrollments,
  materializeStage,
  suppressContactEverywhere,
  logActivity,
  addDays,
}
