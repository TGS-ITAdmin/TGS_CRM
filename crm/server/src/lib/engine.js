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

  if (stage.channel === 'email') {
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
    return { kind: 'outbox', id: msg._id, missing: merged.missing }
  }

  const verb = CHANNEL_VERB[stage.channel] || 'Follow up with'
  const task = await Task.create({
    ...base,
    channel: stage.channel,
    title: `${verb} ${[contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.company || 'contact'} — ${stage.name}`,
    scriptBody: merged.body,
  })
  return { kind: 'task', id: task._id, missing: merged.missing }
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

  const already = await Enrollment.findOne({
    contact: contact._id,
    campaign: campaign._id,
    status: 'active',
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
    dueAt: addDays(now, campaign.stages[0].waitDays),
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
    return { advanced: false, completed: true }
  }

  // Work for the stage we are leaving is now stale — a first-touch message
  // sent after the second touch is worse than not sending it at all.
  await retireStageWork(enrollment._id, enrollment.currentStageIndex, contact._id, campaign._id)

  const stage = campaign.stages[nextIndex]
  enrollment.currentStageIndex = nextIndex
  enrollment.enteredStageAt = now
  enrollment.dueAt = addDays(now, stage.waitDays)
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
  enrollment.dueAt = addDays(now, stage.waitDays)
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

/* Scheduler tick. Processes everything whose dueAt has passed.
 * Batched so a backlog of thousands doesn't blow up memory. */
async function runDueEnrollments({ limit = 500, now = new Date() } = {}) {
  const due = await Enrollment.find({ status: 'active', dueAt: { $ne: null, $lte: now } })
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
    { contact: contactId, status: 'active' },
    { $set: { status: 'exited', exitReason: reason, exitedAt: new Date(), dueAt: null } }
  )
  return { tasksCancelled: tasks.modifiedCount, messagesCancelled: msgs.modifiedCount }
}

module.exports = {
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
