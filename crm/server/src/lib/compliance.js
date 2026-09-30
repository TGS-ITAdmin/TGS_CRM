const { Suppression, Settings } = require('../db')

/* Every outbound email passes through here. There is deliberately no way to
 * bypass it from a route — suppression is checked when a message is queued
 * AND again immediately before the SMTP handoff, because a contact can opt out
 * in between. */

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

// Returns a reason string when the contact must not be emailed, else null.
async function suppressionReason(contact) {
  if (!contact) return 'Contact not found'
  if (contact.status === 'dnc') return 'Contact status is Do Not Contact'
  if (contact.doNotContact) return 'Contact is flagged Do Not Contact'
  if (contact.unsubscribedAt) return 'Contact unsubscribed'
  if (!contact.email) return 'Contact has no email address'

  const domain = domainOf(contact.email)
  const hit = await Suppression.findOne({
    $or: [
      { email: contact.email.toLowerCase() },
      ...(domain ? [{ domain }] : []),
      ...(contact.linkedinUrl ? [{ linkedinUrl: contact.linkedinUrl }] : []),
    ],
  }).lean()
  if (hit) {
    if (hit.domain && hit.domain === domain && !hit.email) {
      return `Domain ${domain} is on the do-not-contact list`
    }
    return `On the do-not-contact list (${hit.reason || 'manual'})`
  }
  return null
}

function unsubscribeUrl(settings, contact) {
  const base = (settings.appBaseUrl || process.env.APP_BASE_URL || '').replace(/\/+$/, '')
  return `${base}/u/${contact.unsubscribeToken}`
}

/* CAN-SPAM: commercial email needs a valid physical postal address and a
 * working opt-out. Both are appended at send time so they cannot be edited
 * out of a template by mistake. */
function buildFooter(settings, contact) {
  const lines = [
    '',
    '---',
    settings.companyName || '',
    settings.physicalAddress || '',
    '',
    `${settings.unsubscribeText || 'Opt out:'} ${unsubscribeUrl(settings, contact)}`,
  ]
  return lines.filter((l) => l !== null).join('\n')
}

// Blocks sending entirely until compliance settings are complete.
async function sendingBlockedReason() {
  const settings = await Settings.findOne({ key: 'global' }).lean()
  if (!settings) return 'Settings not initialised'
  if (!settings.physicalAddress || !settings.physicalAddress.trim()) {
    return 'A physical postal address is required in Settings before any email can be sent (CAN-SPAM).'
  }
  const base = settings.appBaseUrl || process.env.APP_BASE_URL || ''
  if (!base.trim()) {
    return 'An app base URL is required in Settings so unsubscribe links resolve.'
  }
  return null
}

module.exports = {
  suppressionReason,
  buildFooter,
  unsubscribeUrl,
  sendingBlockedReason,
  domainOf,
}
