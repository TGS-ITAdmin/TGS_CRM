/* Response outcomes and per-stage branches.
 *
 * A rep records what happened (an outcome). The CRM then:
 *   1. runs the fixed global rules for that kind of outcome (G1 stop on
 *      reply + G2 company lock for conversations; G3 / G4 / G8 suppression),
 *   2. runs the stage's branch for that outcome — or, when the stage has no
 *      customised branch, the built-in default, which is exactly what the
 *      CRM did before branches existed.
 *
 * Branches apply to the campaign the outcome belongs to (the task's
 * campaign, or the one the rep picks), at the stage the contact is on NOW.
 *
 * Every effect goes through step(), so the same code can describe what an
 * outcome will do (dry run, for the confirmation screen) and then do it. */

const { Contact, Campaign, Enrollment, Task, Suppression, CustomField } = require('../db')
const engine = require('./engine')
const rules = require('./rules')
const {
  applyLost, roleStatus, isLostStatus, REASON_NOT_INTERESTED, REASON_UNSUBSCRIBED,
} = require('./lifecycle')

const O = (key, label, kind, extra = {}) => ({ key, label, kind, ...extra })

/* kind: conversation → G1 + G2 always run; branch may only stay paused or exit.
 *       suppression  → the fixed rule (G3 / G4 / G8) always runs; extras only.
 *       neutral      → nothing fixed; any path.
 *       timer        → the stage's wait ran out; any path except stay. */
const OUTCOMES = {
  call: [
    O('connected', 'Connected', 'conversation', { respond: true }),
    O('voicemail', 'Voicemail', 'neutral'),
    O('no_answer', 'No answer', 'neutral'),
    O('gatekeeper', 'Gatekeeper', 'neutral'),
    O('wrong_number', 'Wrong number', 'neutral'),
    O('callback_requested', 'Callback requested', 'conversation'),
    O('not_interested', 'Not interested', 'conversation'),
    O('meeting_booked', 'Meeting booked', 'conversation'),
    O('do_not_call', "Don't call again", 'suppression'),
    O('wrong_person', 'Wrong person', 'neutral', { needsPerson: true }),
    O('not_now', 'Not now', 'conversation', { needsDate: true }),
  ],
  email: [
    O('positive', 'Positive reply', 'conversation', { respond: true, positive: true }),
    O('other', 'Question / other', 'conversation', { respond: true }),
    O('not_now', 'Not now', 'conversation', { needsDate: true }),
    O('not_interested', 'Not interested', 'conversation'),
    O('unsubscribe', 'Stop / remove me', 'suppression'),
    O('wrong_person', 'Wrong person', 'neutral', { needsPerson: true }),
    O('out_of_office', 'Out of office / auto-reply', 'neutral'),
    O('bounced', 'Bounced', 'suppression'),
  ],
  linkedin: [
    O('invite_accepted', 'Invite accepted', 'neutral'),
    O('replied_positive', 'Replied positive', 'conversation', { respond: true, positive: true }),
    O('replied_other', 'Replied other', 'conversation', { respond: true }),
    O('replied_not_now', 'Replied not now', 'conversation', { needsDate: true }),
    O('replied_not_interested', 'Replied not interested', 'conversation'),
  ],
  scrape: [
    O('found', 'Found the details', 'neutral'),
    O('partly_found', 'Found some details', 'neutral'),
    O('not_found', 'Could not find details', 'neutral'),
  ],
  any: [O('no_response', 'No response (the wait runs out)', 'timer')],
}

// LinkedIn replies behave like the matching email reply.
const BASE = {
  replied_positive: 'positive',
  replied_other: 'other',
  replied_not_now: 'not_now',
  replied_not_interested: 'not_interested',
}

const ALLOWED_PATHS = {
  conversation: ['stay', 'exit'],
  suppression: [],
  neutral: ['stay', 'continue', 'jump', 'wait', 'retry', 'exit'],
  timer: ['continue', 'jump', 'wait', 'retry', 'exit'],
}

// What each outcome does when nobody has customised it (= today's behaviour).
const DEFAULT_TEXT = {
  connected: 'Pauses their flows, creates a Respond task, locks the company',
  voicemail: 'No change: the stage timer moves them on',
  no_answer: 'No change: the stage timer moves them on',
  gatekeeper: 'No change: the stage timer moves them on',
  wrong_number: 'No change: the stage timer moves them on',
  callback_requested: 'Pauses their flows and locks the company (the callback reminder is set on the card)',
  not_interested: 'Lost (Not interested), Nurture on, every campaign ends, company locked',
  meeting_booked: 'Meeting Booked status and a deal; flows paused, company locked',
  do_not_call: "No more calls (G4), Lost, every campaign ends, company locked",
  wrong_person: 'The right person is added at the same company and starts this campaign at stage 1; this contact leaves it',
  not_now: 'Flows paused, company locked, Nurture on with a check-back date (default +90 days)',
  positive: 'Pauses their flows, Respond task due in 15 minutes (business hours), company locked',
  other: 'Pauses their flows, Respond task for the next business day, company locked',
  unsubscribe: 'No more email (G3), Lost, every campaign ends, company locked',
  out_of_office: 'Wait 5 business days, then the next stage',
  bounced: 'Email marked Bounced; remaining email steps become calls or LinkedIn (G8)',
  invite_accepted: 'LinkedIn connected = Yes; no change to the flow',
  no_response: 'Next stage',
  found: 'Move to the next stage now',
  partly_found: 'Move to the next stage now',
  not_found: 'Leave the campaign (Contact info not found)',
}

function findOutcome(channel, key) {
  return (OUTCOMES[channel] || []).find((o) => o.key === key)
    || OUTCOMES.any.find((o) => o.key === key)
    || null
}

function catalogueForClient() {
  const out = {}
  for (const [channel, list] of Object.entries(OUTCOMES)) {
    out[channel] = list.map((o) => ({
      ...o,
      defaultText: DEFAULT_TEXT[BASE[o.key] || o.key] || '',
      allowedPaths: ALLOWED_PATHS[o.kind],
    }))
  }
  return out
}

/* Clean the branches an admin saved on a stage. Forward jumps only (rule:
 * no loops); paths limited by the outcome's kind. `stageIds` is the stage
 * order after saving; `index` is this stage's position. */
function sanitizeBranches(list, channel, index, stageIds) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const b of list) {
    const def = findOutcome(channel, b?.outcome)
    if (!def || seen.has(def.key)) continue
    seen.add(def.key)
    const allowed = ALLOWED_PATHS[def.kind]
    let path = allowed.includes(b.path) ? b.path : (allowed[0] || 'stay')
    let toStage = ''
    if (path === 'jump') {
      const target = stageIds.indexOf(String(b.toStage || ''))
      if (target > index) toStage = String(b.toStage)
      else path = def.kind === 'timer' ? 'continue' : 'stay'
    }
    out.push({
      outcome: def.key,
      path,
      toStage,
      days: Math.min(60, Math.max(0, Math.round(Number(b.days) || 0))),
      maxTries: Math.min(5, Math.max(1, Math.round(Number(b.maxTries) || 2))),
      moveTo: path === 'exit' && /^[0-9a-f]{24}$/i.test(String(b.moveTo || '')) ? b.moveTo : null,
      setStatus: String(b.setStatus || '').slice(0, 80),
      lostReason: String(b.lostReason || '').slice(0, 200),
      taskTitle: String(b.taskTitle || '').slice(0, 200),
      taskAssign: String(b.taskAssign || 'owner').slice(0, 40),
      taskDueDays: Math.min(60, Math.max(0, Math.round(Number(b.taskDueDays) || 0))),
      nurture: !!b.nurture,
      restartDays: Math.min(730, Math.max(1, Math.round(Number(b.restartDays) || 90))),
      dnc: !!b.dnc,
    })
  }
  return out
}

function branchFor(campaign, stageIndex, outcomeKey) {
  const stage = campaign?.stages?.[stageIndex]
  return (stage?.branches || []).find((b) => b.outcome === outcomeKey) || null
}

const fullName = (c) => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.companyName || 'contact'

async function setLinkedinConnected(contact) {
  const defs = await CustomField.find({ object: 'contact' }).lean()
  const def = defs.find((d) => /linked\s*in.*connect/i.test(d.key) || /linked\s*in.*connect/i.test(d.label || ''))
  if (!def) return false
  const value = Array.isArray(def.options) && def.options.length
    ? (def.options.find((o) => /^yes$/i.test(String(o.value ?? o))) || {}).value ?? 'Yes'
    : def.type === 'checkbox' ? true : 'Yes'
  contact.customFields = { ...(contact.customFields || {}), [def.key]: value }
  contact.markModified?.('customFields')
  await contact.save()
  return true
}

async function logStatus(contact, change, why, actorId) {
  if (!change) return
  await engine.logActivity({
    contact: contact._id, type: 'status_change', user: actorId || null,
    title: `Status: ${change.from} → ${change.to} (${why})`,
    meta: { ...change, automatic: true },
  })
}

/* ---- The engine ---- */

async function applyOutcome({
  contact, channel, outcome, enrollment = null, data = {}, actorId = null, stepOwner = null, dryRun = false,
}) {
  const def = findOutcome(channel, outcome)
  if (!def) throw Object.assign(new Error('Unknown outcome'), { status: 400 })
  const base = BASE[def.key] || def.key
  const who = contact.firstName || 'A contact'

  const plan = []
  const step = async (text, fn, destructive = false) => {
    plan.push({ text, destructive })
    if (!dryRun && fn) return fn()
    return null
  }

  const campaign = enrollment ? await Campaign.findById(enrollment.campaign) : null
  const stageIndex = enrollment ? enrollment.currentStageIndex : -1
  const stage = campaign?.stages?.[stageIndex] || null
  const branch = campaign ? branchFor(campaign, stageIndex, def.key) : null
  const where = campaign ? `"${campaign.name}"${stage ? ` at "${stage.name}"` : ''}` : ''
  let replyResult = null

  /* ---- Pieces shared by the defaults and the fixed rules ---- */
  const pauseAndLock = (respond, source) => step(
    respond
      ? `Pause all their flows and create a Respond task${def.positive ? ' due in 15 minutes (business hours)' : ''}; lock the company (G1, G2)`
      : 'Pause all their flows and lock the company (G1, G2)',
    async () => {
      replyResult = await engine.handleReply({ contact, positive: !!def.positive, respond, source, actorId })
    }
  )
  const endEverything = (reason, lostReason, opts = {}) => step(
    `Lost (${lostReason})${opts.nurture ? ', Nurture on' : ''}; every campaign they are in ends; company locked`,
    async () => {
      const lost = await applyLost(contact, { reason: lostReason, nurture: opts.nurture })
      if (opts.set) Object.assign(contact, opts.set)
      await contact.save()
      await logStatus(contact, lost, lostReason, actorId)
      await engine.suppressContactEverywhere({ contactId: contact._id, reason, actorId })
      await engine.lockCompany({ contact, reason: `${who} ${opts.lockWhy || 'responded'}`, actorId })
    },
    true
  )
  const nurtureFrom = (days) => {
    const given = data.restartDate && !Number.isNaN(Date.parse(data.restartDate)) ? new Date(data.restartDate) : null
    return given || new Date(Date.now() + (days || 90) * 86400000)
  }

  /* ---- 1. Fixed rules (always) ---- */
  if (def.kind === 'suppression') {
    if (base === 'do_not_call') {
      await endEverything('Do-not-call request', REASON_UNSUBSCRIBED, { set: { dncStatus: 'dnc_request' }, lockWhy: "asked not to be called" })
      await step('No more calls for good (G4)', () => engine.logActivity({
        contact: contact._id, type: 'suppression_changed', channel: 'call', user: actorId,
        title: 'Do-not-call request — calls stopped',
      }))
    } else if (base === 'unsubscribe') {
      await step('No more email for good (G3); Lost (Unsubscribed / do-not-contact); every campaign ends; company locked', async () => {
        await engine.lockCompany({ contact, reason: `${who} asked to stop`, actorId })
        const { applySuppressionChanges } = require('./suppression')
        const result = await applySuppressionChanges(contact, { emailStatus: 'unsubscribed' }, actorId)
        await contact.save()
        for (const note of result.notes) {
          await engine.logActivity({ contact: contact._id, type: 'suppression_changed', user: actorId, title: note })
        }
      }, true)
    } else if (base === 'bounced') {
      await step('Email marked Bounced; remaining email steps become a call or LinkedIn message (G8)', async () => {
        const { applySuppressionChanges } = require('./suppression')
        const result = await applySuppressionChanges(contact, { emailStatus: 'bounced' }, actorId)
        await contact.save()
        for (const note of result.notes) {
          await engine.logActivity({ contact: contact._id, type: 'suppression_changed', user: actorId, title: note })
        }
      })
    }
  }

  if (base === 'wrong_person') {
    const p = data.person || {}
    const named = [p.firstName, p.lastName, p.email].some((v) => String(v || '').trim())
    if (named) {
      const label = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email
      await step(`Add ${label} at the same company${campaign ? ` and start them at stage 1 of "${campaign.name}"` : ''}`, async () => {
        const fresh = await Contact.create({
          firstName: String(p.firstName || '').trim().slice(0, 120),
          lastName: String(p.lastName || '').trim().slice(0, 120),
          email: String(p.email || '').trim().toLowerCase().slice(0, 200),
          phone: String(p.phone || '').trim().slice(0, 60),
          title: String(p.title || '').trim().slice(0, 120),
          company: contact.company?._id || contact.company || null,
          companyName: contact.companyName || '',
          timezone: contact.timezone || '',
          owner: contact.owner || actorId,
          source: 'wrong_person',
          ...((await roleStatus('created')) ? { status: await roleStatus('created') } : {}),
        })
        await engine.logActivity({
          contact: fresh._id, type: 'note', user: actorId,
          title: `Added as the right person instead of ${fullName(contact)}`,
        })
        if (campaign) {
          try {
            await engine.enroll({ contactId: fresh._id, campaignId: campaign._id, actorId })
          } catch (err) {
            await engine.logActivity({ contact: fresh._id, type: 'note', user: actorId, title: `Could not start "${campaign.name}": ${err.message}` })
          }
        }
      })
    } else {
      await step('No new name given, so nobody new is added')
    }
  }

  if (def.kind === 'conversation' && branch) {
    // G1 + G2 for a customised branch: pause everything, then the branch.
    await pauseAndLock(!!def.respond, `responded (${def.label.toLowerCase()})`)
  }

  /* ---- 2a. Built-in default (no customised branch) ---- */
  if (!branch) {
    switch (base) {
      case 'connected':
        await pauseAndLock(true, 'answered a call'); break
      case 'callback_requested':
        await pauseAndLock(false, 'asked for a callback'); break
      case 'meeting_booked':
        await pauseAndLock(false, 'booked a meeting'); break
      case 'positive':
      case 'other':
        await pauseAndLock(true, 'replied'); break
      case 'not_now':
        await pauseAndLock(false, 'replied (not now)')
        await step(`Nurture on; check back ${data.restartDate ? `on ${new Date(data.restartDate).toLocaleDateString('en-US')}` : 'in 90 days'}`, async () => {
          contact.nurture = true
          contact.restartDate = nurtureFrom(90)
          await contact.save()
        })
        break
      case 'not_interested':
        await endEverything(channel === 'call' ? 'Not interested (call)' : 'Replied: not interested', REASON_NOT_INTERESTED, { nurture: true, lockWhy: 'is not interested' })
        break
      case 'wrong_person':
        if (enrollment && ['active', 'paused'].includes(enrollment.status)) {
          await step(`${fullName(contact)} leaves ${where}`, () => engine.exitEnrollment({ enrollment, reason: 'Wrong person', actorId }), true)
        }
        break
      case 'out_of_office':
        if (enrollment?.status === 'active' && stage) {
          await step('Wait 5 business days, then the next stage', async () => {
            enrollment.dueAt = await engine.stageDue(campaign, new Date(), 5)
            enrollment.pendingAction = 'continue'
            await enrollment.save()
          })
        }
        break
      case 'invite_accepted':
        await step('LinkedIn connected = Yes', () => setLinkedinConnected(contact))
        break
      case 'found':
      case 'partly_found':
        if (enrollment?.status === 'active') {
          const next = campaign?.stages?.[stageIndex + 1]
          await step(next ? `Move to the next stage, "${next.name}", now` : 'Finish the campaign now',
            () => engine.advance({ enrollment, actorId, manual: true }))
        }
        break
      case 'not_found':
        if (enrollment && ['active', 'paused'].includes(enrollment.status)) {
          await step(`${fullName(contact)} leaves ${where} (Contact info not found)`,
            () => engine.exitEnrollment({ enrollment, reason: 'Contact info not found', actorId }), true)
        }
        break
      default:
        if (def.kind === 'neutral') await step('No change: the stage timer moves them on')
    }
    return { plan, destructive: plan.some((p) => p.destructive), replyResult, branch: null }
  }

  /* ---- 2b. Customised branch ---- */
  if (base === 'invite_accepted') await step('LinkedIn connected = Yes', () => setLinkedinConnected(contact))
  await step(`Branch for "${def.label}"${where ? ` in ${where}` : ''}:`)
  await runPath({ branch, enrollment, campaign, contact, stage, kind: def.kind, actorId, step, where })
  await runExtras({ branch, contact, data, actorId, stepOwner, step })
  if (!dryRun) {
    await engine.logActivity({
      contact: contact._id, type: 'branch_applied', campaign: campaign._id, stageIndex, user: actorId,
      title: `Branch "${def.label}" at "${stage?.name || 'stage'}"`,
      body: plan.map((p) => p.text).join('\n'),
    })
  }
  return { plan, destructive: plan.some((p) => p.destructive), replyResult, branch }
}

async function runPath({ branch, enrollment, campaign, contact, stage, kind, actorId, step, where }) {
  if (kind === 'suppression') return
  const active = enrollment?.status === 'active'
  const idx = enrollment?.currentStageIndex ?? -1
  const next = campaign?.stages?.[idx + 1]
  switch (branch.path) {
    case 'stay':
      await step(kind === 'conversation' ? 'Their flows stay paused until someone resumes them' : 'No change: the stage timer moves them on')
      return
    case 'continue':
      if (!active) return step('Flow is not running, so it does not move')
      await step(next ? `Move to the next stage, "${next.name}", now` : 'Finish the campaign now',
        () => engine.advance({ enrollment, actorId, manual: true }))
      return
    case 'jump': {
      const target = campaign.stages.findIndex((s) => String(s._id) === String(branch.toStage))
      if (!active) return step('Flow is not running, so it does not move')
      if (target <= idx) {
        await step(next ? `Jump target is not ahead of this stage, so move to "${next.name}"` : 'Finish the campaign now',
          () => engine.advance({ enrollment, actorId, manual: true }))
        return
      }
      await step(`Jump to "${campaign.stages[target].name}"`,
        () => engine.setStage({ enrollment, stageIndex: target, actorId }))
      return
    }
    case 'wait':
      if (!active) return step('Flow is not running, so nothing is scheduled')
      await step(`Wait ${branch.days} business day${branch.days === 1 ? '' : 's'}, then ${next ? `"${next.name}"` : 'finish'}`, async () => {
        enrollment.dueAt = await engine.stageDue(campaign, new Date(), branch.days)
        enrollment.pendingAction = 'continue'
        await enrollment.save()
      })
      return
    case 'retry': {
      if (!active) return step('Flow is not running, so nothing is retried')
      const used = Number((enrollment.retries || {})[String(idx)] || 0)
      if (used >= branch.maxTries) {
        await step(`Already retried ${used} time${used === 1 ? '' : 's'} (limit ${branch.maxTries}), so ${next ? `move to "${next.name}"` : 'finish the campaign'}`,
          () => engine.advance({ enrollment, actorId, manual: true }))
        return
      }
      await step(`Retry "${stage.name}" in ${branch.days} business day${branch.days === 1 ? '' : 's'} (try ${used + 1} of ${branch.maxTries})`, async () => {
        enrollment.retries = { ...(enrollment.retries || {}), [String(idx)]: used + 1 }
        enrollment.markModified('retries')
        enrollment.pendingAction = 'retry'
        enrollment.dueAt = await engine.stageDue(campaign, new Date(), branch.days)
        await enrollment.save()
      })
      return
    }
    case 'exit': {
      if (!enrollment || !['active', 'paused'].includes(enrollment.status)) return
      const to = branch.moveTo ? await Campaign.findById(branch.moveTo).select('name').lean() : null
      await step(to ? `Leave ${where} and start "${to.name}" at stage 1` : `Leave ${where}`, async () => {
        await engine.exitEnrollment({ enrollment, reason: to ? `Branch: moved to "${to.name}"` : 'Branch: exit', actorId })
        if (to) await engine.enroll({ contactId: contact._id, campaignId: to._id, actorId })
      }, true)
      return
    }
    default:
  }
}

async function runExtras({ branch, contact, data, actorId, stepOwner, step }) {
  if (branch.setStatus) {
    const lost = await isLostStatus(branch.setStatus)
    await step(lost ? `Status → Lost (${branch.lostReason || 'no reason set'})` : `Status → ${branch.setStatus}`, async () => {
      let change
      if (lost) change = await applyLost(contact, { reason: branch.lostReason || 'Not interested' })
      else if (contact.status !== branch.setStatus) {
        change = { from: contact.status, to: branch.setStatus }
        contact.status = branch.setStatus
      }
      await contact.save()
      await logStatus(contact, change, 'branch', actorId)
    }, lost)
  }
  if (branch.nurture) {
    await step(`Nurture on; check back ${data.restartDate ? `on ${new Date(data.restartDate).toLocaleDateString('en-US')}` : `in ${branch.restartDays} days`}`, async () => {
      const given = data.restartDate && !Number.isNaN(Date.parse(data.restartDate)) ? new Date(data.restartDate) : null
      contact.nurture = true
      contact.restartDate = given || new Date(Date.now() + branch.restartDays * 86400000)
      await contact.save()
    })
  }
  if (branch.taskTitle) {
    const assignee = branch.taskAssign === 'step' ? (stepOwner || contact.owner)
      : /^[0-9a-f]{24}$/i.test(branch.taskAssign) ? branch.taskAssign : contact.owner
    await step(`Task: "${branch.taskTitle}"${branch.taskDueDays ? ` in ${branch.taskDueDays} business day${branch.taskDueDays === 1 ? '' : 's'}` : ' today'}`, async () => {
      const R = await rules.getRules()
      await Task.create({
        contact: contact._id, channel: 'internal', isManual: true,
        title: `${branch.taskTitle} — ${fullName(contact)}`,
        assignedTo: assignee || actorId || null,
        dueAt: rules.addBusinessDays(new Date(), branch.taskDueDays, R),
      })
    })
  }
  if (branch.dnc) {
    await step('Flag do not contact: all outreach stops and every campaign ends', async () => {
      contact.doNotContact = true
      await contact.save()
      if (contact.email || contact.linkedinUrl) {
        await Suppression.updateOne(
          { email: contact.email || '', linkedinUrl: contact.linkedinUrl || '' },
          { $set: { email: contact.email || '', linkedinUrl: contact.linkedinUrl || '', reason: 'branch', addedBy: actorId } },
          { upsert: true }
        )
      }
      await engine.suppressContactEverywhere({ contactId: contact._id, reason: 'Flagged do not contact (branch)', actorId })
    }, true)
  }
}

/* ---- Timer: a stage's wait ran out (called by the scheduler) ----
 * Returns true when it handled the enrollment (retry, continue or a
 * customised No response branch); false means "do the usual advance". */
async function onStageDue(enrollment) {
  if (enrollment.pendingAction === 'retry') {
    await engine.retryStage({ enrollment })
    return true
  }
  if (enrollment.pendingAction === 'continue') {
    enrollment.pendingAction = ''
    await enrollment.save()
    await engine.advance({ enrollment, manual: false })
    return true
  }
  const campaign = await Campaign.findById(enrollment.campaign)
  const branch = branchFor(campaign, enrollment.currentStageIndex, 'no_response')
  if (!branch) return false
  const contact = await Contact.findById(enrollment.contact).populate('company')
  if (!contact) return false
  await applyOutcome({ contact, channel: 'any', outcome: 'no_response', enrollment, actorId: null })
  return true
}

module.exports = {
  OUTCOMES,
  ALLOWED_PATHS,
  DEFAULT_TEXT,
  findOutcome,
  catalogueForClient,
  sanitizeBranches,
  branchFor,
  applyOutcome,
  onStageDue,
}
