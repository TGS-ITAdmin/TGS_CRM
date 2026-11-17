/* Email / call / do-not-contact suppression changes, shared by the contact
 * routes and the outcome engine. Moved here unchanged from routes/contacts.js. */
const { Enrollment, Campaign, Task, OutboxMessage, Suppression } = require('../db')
const { suppressContactEverywhere, materializeStage } = require('./engine')
const { applyLost, REASON_UNSUBSCRIBED, EMAIL_STATUSES, DNC_STATUSES } = require('./lifecycle')

const EMAIL_STATUS_VALUES = EMAIL_STATUSES.map((s) => s.value)
const DNC_STATUS_VALUES = DNC_STATUSES.map((s) => s.value)

/* Stop one channel's pending work for a contact: queued emails, or open
 * call tasks. Used when an email or call status blocks that channel. */
async function cancelChannelWork(contactId, channel, reason) {
  if (channel === 'email') {
    const r = await OutboxMessage.updateMany(
      { contact: contactId, status: 'queued' },
      { $set: { status: 'cancelled', error: reason } }
    )
    return r.modifiedCount || 0
  }
  const r = await Task.updateMany(
    { contact: contactId, status: 'pending', channel },
    { $set: { status: 'cancelled', notes: reason } }
  )
  return r.modifiedCount || 0
}

/* Apply emailStatus / dncStatus / doNotContact changes from a form or bulk
 * edit. Returns notes for the timeline. The contact is not saved here.
 *  - Unsubscribed (email) or a do-not-call request: Lost with reason
 *    "Unsubscribed / do-not-contact", and their campaigns end.
 *  - Bounced: queued emails cancelled; the campaign carries on.
 *  - On National DNC / reassigned: open call tasks cancelled; email and
 *    LinkedIn carry on. */
async function applySuppressionChanges(contact, body, actorId) {
  const notes = []
  let endCampaigns = null

  if (body.emailStatus !== undefined && EMAIL_STATUS_VALUES.includes(body.emailStatus)
      && body.emailStatus !== (contact.emailStatus || 'valid')) {
    contact.emailStatus = body.emailStatus
    if (body.emailStatus === 'unsubscribed') {
      contact.unsubscribedAt = contact.unsubscribedAt || new Date()
      await cancelChannelWork(contact._id, 'email', 'Unsubscribed')
      endCampaigns = 'Unsubscribed from email'
      notes.push('Email status: Unsubscribed — emails stopped')
    } else if (body.emailStatus === 'bounced') {
      await cancelChannelWork(contact._id, 'email', 'Email bounced')
      notes.push('Email status: Bounced — queued emails cancelled')
      // G8: the email step they are on right now is swapped straight away;
      // later email steps are swapped when they come due.
      const running = await Enrollment.find({ contact: contact._id, status: 'active' })
      for (const e of running) {
        const campaign = await Campaign.findById(e.campaign)
        if (campaign?.stages?.[e.currentStageIndex]?.channel === 'email') {
          await materializeStage({ enrollment: e, campaign, contact, stageIndex: e.currentStageIndex, actorId })
        }
      }
    } else {
      contact.unsubscribedAt = null
      notes.push('Email status: Valid')
    }
  }

  if (body.dncStatus !== undefined && DNC_STATUS_VALUES.includes(body.dncStatus)
      && body.dncStatus !== (contact.dncStatus || 'clear')) {
    contact.dncStatus = body.dncStatus
    const label = DNC_STATUSES.find((d) => d.value === body.dncStatus).label
    if (body.dncStatus === 'clear') {
      notes.push('DNC status: Clear')
    } else {
      await cancelChannelWork(contact._id, 'call', `Calls blocked: ${label}`)
      notes.push(`DNC status: ${label} — calls stopped`)
      if (body.dncStatus === 'dnc_request') endCampaigns = 'Do-not-call request'
    }
  }

  if (body.doNotContact !== undefined && !!body.doNotContact !== !!contact.doNotContact) {
    contact.doNotContact = !!body.doNotContact
    if (contact.doNotContact) {
      await Suppression.updateOne(
        { email: contact.email || '', linkedinUrl: contact.linkedinUrl || '' },
        {
          $set: {
            email: contact.email || '',
            linkedinUrl: contact.linkedinUrl || '',
            reason: 'flagged on contact',
            addedBy: actorId,
          },
        },
        { upsert: true }
      )
      endCampaigns = 'Flagged do-not-contact'
      notes.push('Flagged do not contact — all outreach stopped')
    } else {
      notes.push('Do-not-contact flag removed')
    }
  }

  let lostChange = null
  if (endCampaigns) {
    lostChange = await applyLost(contact, { reason: REASON_UNSUBSCRIBED })
    await suppressContactEverywhere({ contactId: contact._id, reason: endCampaigns, actorId })
  }
  return { notes, lostChange }
}

module.exports = { cancelChannelWork, applySuppressionChanges, EMAIL_STATUS_VALUES, DNC_STATUS_VALUES }
