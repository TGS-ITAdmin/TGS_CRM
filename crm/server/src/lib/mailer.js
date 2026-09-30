const nodemailer = require('nodemailer')
const { Settings } = require('../db')
const { buildFooter, suppressionReason, sendingBlockedReason } = require('./compliance')

/* SMTP is intentionally unconfigured out of the box. Everything upstream —
 * queueing, merging, the approval queue — works with no credentials; only the
 * final handoff fails, and it fails with a clear message rather than silently
 * pretending to send. */

function resolveSmtp(user, settings) {
  const u = (user && user.smtp) || {}
  if (u.host && u.user) return { ...u.toObject?.() ?? u, _source: 'user' }
  const d = (settings && settings.defaultSmtp) || {}
  if (d.host && d.user) return { ...(d.toObject?.() ?? d), _source: 'shared' }
  return null
}

function transportFor(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: !!smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  })
}

async function smtpStatus(user) {
  const settings = await Settings.findOne({ key: 'global' }).lean()
  const smtp = resolveSmtp(user, settings)
  const blocked = await sendingBlockedReason()
  return {
    configured: !!smtp,
    source: smtp ? smtp._source : null,
    from: smtp ? `${smtp.fromName || ''} <${smtp.fromEmail || smtp.user}>`.trim() : null,
    complianceBlocked: blocked,
  }
}

async function verifySmtp(smtp) {
  const transport = transportFor(smtp)
  await transport.verify()
  return true
}

/* Sends one queued message. Returns { ok, sentBody, error }.
 * Never throws — the caller records the outcome on the outbox row either way. */
async function sendMessage({ message, contact, user }) {
  // notAttempted: nothing was tried, so the draft stays queued and can be
  // retried once the operator fixes the configuration.
  const blocked = await sendingBlockedReason()
  if (blocked) return { ok: false, notAttempted: true, error: blocked }

  // Re-check suppression at the last moment: the contact may have opted out
  // between the message being queued and a rep approving it.
  const reason = await suppressionReason(contact)
  if (reason) return { ok: false, suppressed: true, error: reason }

  const settings = await Settings.findOne({ key: 'global' }).lean()
  const smtp = resolveSmtp(user, settings)
  if (!smtp) {
    return {
      ok: false,
      notAttempted: true,
      error:
        'No SMTP credentials configured. Add them under Settings → Email, then send again.',
    }
  }

  const sentBody = message.body + '\n' + buildFooter(settings, contact)
  const fromEmail = smtp.fromEmail || smtp.user
  const from = smtp.fromName ? `"${smtp.fromName}" <${fromEmail}>` : fromEmail

  try {
    const transport = transportFor(smtp)
    const info = await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: sentBody,
      headers: {
        // RFC 8058 — lets mail clients offer a one-click unsubscribe.
        'List-Unsubscribe': `<${require('./compliance').unsubscribeUrl(settings, contact)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    })
    return { ok: true, sentBody, messageId: info.messageId }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

module.exports = { sendMessage, smtpStatus, verifySmtp, resolveSmtp }
