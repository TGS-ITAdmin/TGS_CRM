const express = require('express')
const rateLimit = require('express-rate-limit')
const { Contact, Settings, Suppression, User, Quote, Company, Deal } = require('../db')
const { logActivity, suppressContactEverywhere } = require('../lib/engine')
const { resolveCompany } = require('../lib/companies')
const { applyAcceptedQuoteToDeal } = require('../lib/quotes')
const { renderQuotePdf } = require('../lib/quote-pdf')
const { getSettings } = require('../lib/money')

const router = express.Router()

const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
})

function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;
 display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#111827;padding:24px}
@media (prefers-color-scheme:dark){body{background:#0b0f19;color:#e5e7eb}.card{background:#111827!important;border-color:#1f2937!important}}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;max-width:520px;width:100%}
h1{font-size:20px;margin:0 0 12px}
p{margin:0 0 16px;color:inherit;opacity:.85}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#dc2626;color:#fff;cursor:pointer}
button:hover{background:#b91c1c}
.muted{font-size:13px;opacity:.6}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`
}

/* ---- One-click unsubscribe ---- */

router.get('/u/:token', async (req, res) => {
  const contact = await Contact.findOne({ unsubscribeToken: req.params.token })
  const settings = await Settings.findOne({ key: 'global' }).lean()
  const company = settings?.companyName || 'us'

  if (!contact) {
    return res.status(404).send(page('Link not found', `<h1>That link is no longer valid</h1>
      <p>The opt-out link you followed does not match any record. If you are still receiving mail,
      reply to any message and ask to be removed.</p>`))
  }
  if (contact.unsubscribedAt) {
    return res.send(page('Already unsubscribed', `<h1>You are already opted out</h1>
      <p>${escapeHtml(contact.email)} will not receive further email from ${escapeHtml(company)}.</p>`))
  }

  res.send(page('Unsubscribe', `<h1>Unsubscribe from ${escapeHtml(company)}</h1>
    <p>Confirm and we will stop emailing <strong>${escapeHtml(contact.email)}</strong>.</p>
    <form method="post" action="/u/${encodeURIComponent(req.params.token)}">
      <button type="submit">Unsubscribe me</button>
    </form>
    <p class="muted" style="margin-top:20px">This takes effect immediately and cannot be undone by us without your request.</p>`))
})

// Handles both the form post and RFC 8058 List-Unsubscribe-Post one-click.
router.post('/u/:token', async (req, res) => {
  const contact = await Contact.findOne({ unsubscribeToken: req.params.token })
  if (!contact) return res.status(404).send(page('Link not found', '<h1>That link is no longer valid</h1>'))

  if (!contact.unsubscribedAt) {
    contact.unsubscribedAt = new Date()
    contact.doNotContact = true
    contact.status = 'dnc'
    await contact.save()

    if (contact.email) {
      await Suppression.updateOne(
        { email: contact.email },
        { $set: { email: contact.email, reason: 'unsubscribed' } },
        { upsert: true }
      )
    }
    await suppressContactEverywhere({ contactId: contact._id, reason: 'Unsubscribed' })
    await logActivity({
      contact: contact._id,
      type: 'unsubscribed',
      channel: 'email',
      title: 'Unsubscribed via email link',
    })
  }

  const settings = await Settings.findOne({ key: 'global' }).lean()
  // One-click clients want a bare 200, not HTML.
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded') &&
      req.body && req.body['List-Unsubscribe'] === 'One-Click') {
    return res.status(200).send('OK')
  }
  res.send(page('Unsubscribed', `<h1>Done — you are opted out</h1>
    <p>${escapeHtml(contact.email)} has been removed from all ${escapeHtml(settings?.companyName || 'our')} outreach.</p>`))
})

/* ---- Public inbound web form ---- */

router.get('/api/public/form-config', async (req, res) => {
  const settings = await Settings.findOne({ key: 'global' }).lean()
  res.json({
    enabled: !!settings?.publicFormEnabled,
    companyName: settings?.companyName || '',
    tokenRequired: !!process.env.PUBLIC_FORM_TOKEN,
  })
})

router.post('/api/public/contacts', formLimiter, async (req, res) => {
  const settings = await Settings.findOne({ key: 'global' }).lean()
  if (!settings?.publicFormEnabled) {
    return res.status(403).json({ error: 'The public form is switched off' })
  }

  const required = process.env.PUBLIC_FORM_TOKEN
  if (required && req.body?.token !== required) {
    return res.status(403).json({ error: 'Invalid form token' })
  }

  // Honeypot: a real person never fills a hidden field.
  if (req.body?.website_confirm) return res.json({ ok: true })

  const { firstName, lastName, email, phone, company, title, message, seatsNeeded, targetRoles } =
    req.body || {}

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
    return res.status(400).json({ error: 'A valid email address is required' })
  }
  if (!firstName && !lastName && !company) {
    return res.status(400).json({ error: 'Tell us your name or your company' })
  }

  const normalized = String(email).toLowerCase().trim()
  const existing = await Contact.findOne({ email: normalized })
  if (existing) {
    await logActivity({
      contact: existing._id,
      type: 'note',
      title: 'Submitted the web form again',
      body: message ? String(message).slice(0, 2000) : '',
    })
    return res.json({ ok: true, duplicate: true })
  }

  // Round-robin so inbound doesn't pile up on one person.
  const reps = await User.find({ active: true }).select('_id').sort({ createdAt: 1 }).lean()
  const count = await Contact.countDocuments({ source: 'web_form' })
  const owner = reps.length ? reps[count % reps.length]._id : null

  // Seats and target roles describe the organisation, so they land on the
  // company the submission resolves to, not on the person who filled the form.
  const companyName = String(company || '').slice(0, 200).trim()
  const seats = Number.isFinite(Number(seatsNeeded)) && seatsNeeded !== '' ? Number(seatsNeeded) : null
  const resolved = await resolveCompany({
    name: companyName,
    email: normalized,
    extra: {
      ...(seats !== null ? { seatsNeeded: seats } : {}),
      ...(targetRoles ? { targetRoles: String(targetRoles).slice(0, 300) } : {}),
    },
    ownerId: owner,
    source: 'web_form',
  })

  const contact = await Contact.create({
    firstName: String(firstName || '').slice(0, 120),
    lastName: String(lastName || '').slice(0, 120),
    email: normalized,
    phone: String(phone || '').slice(0, 60),
    company: resolved ? resolved._id : null,
    companyName: resolved ? resolved.name : companyName,
    title: String(title || '').slice(0, 200),
    notes: String(message || '').slice(0, 4000),
    source: 'web_form',
    status: 'new',
    owner,
  })

  await logActivity({
    contact: contact._id,
    company: resolved ? resolved._id : null,
    type: 'contact_created',
    title: 'Inbound web form submission',
    body: message ? String(message).slice(0, 2000) : '',
  })

  res.status(201).json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* Public quote — view, accept, decline                                 */
/* ------------------------------------------------------------------ */

const quoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please try again shortly.',
})

// Only these statuses are visible on the public link. A draft or a quote still
// waiting for an admin must never be reachable — that is the entire point of
// having an approval step.
const PUBLIC_STATUSES = ['approved', 'sent', 'accepted', 'declined', 'expired']

const PRICING_LABEL = {
  per_seat_monthly: 'per seat / month',
  one_time: 'one-off',
  hourly: 'per hour',
  per_unit: 'per unit',
}

function fmtMoney(n, currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: currency || 'USD',
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Number(n) || 0)
  } catch {
    return `${currency} ${(Number(n) || 0).toLocaleString()}`
  }
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

function quotePage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6f8;--surface:#fff;--border:#e3e6ea;--ink:#12161c;--muted:#626c7a;--accent:#2563eb;--ok:#16a34a;--danger:#dc2626;--warn:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#0c1017;--surface:#141a23;--border:#242d3a;--ink:#e8ecf1;--muted:#97a3b3}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:24px 16px 64px}
.wrap{max-width:720px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:28px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:15px;margin:24px 0 10px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.small{font-size:13px}
.row{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.spread{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
table{width:100%;border-collapse:collapse;margin:8px 0 0}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:8px 0;border-bottom:1px solid var(--border)}
td{padding:12px 0;border-bottom:1px solid var(--border);vertical-align:top}
td.r,th.r{text-align:right}
.totals{margin-top:18px;padding-top:14px;border-top:2px solid var(--border)}
.grand{font-size:21px;font-weight:650;color:var(--accent)}
.btn{display:inline-block;font:inherit;font-size:15px;font-weight:600;padding:12px 22px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--ink);cursor:pointer;text-decoration:none}
.btn-accept{background:var(--ok);border-color:var(--ok);color:#fff}
.btn-decline{background:transparent;color:var(--danger);border-color:var(--danger)}
.btn:hover{filter:brightness(.95)}
input,textarea,select{font:inherit;width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--ink)}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px;color:var(--muted)}
.field{margin-bottom:14px}
.banner{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:14px;border:1px solid}
.banner-ok{background:#e6f6ec;border-color:var(--ok);color:#14532d}
.banner-danger{background:#fdeaea;border-color:var(--danger);color:#7f1d1d}
.banner-warn{background:#fdf1de;border-color:var(--warn);color:#78350f}
@media (prefers-color-scheme:dark){.banner-ok{background:#12291a;color:#86efac}.banner-danger{background:#33191a;color:#fca5a5}.banner-warn{background:#33260f;color:#fcd34d}}
.accent-bar{height:5px;border-radius:99px;background:var(--accent);margin-bottom:22px}
.discount{color:var(--warn);font-size:12.5px}
</style></head><body><div class="wrap">${bodyHtml}</div></body></html>`
}

function renderQuoteHtml({ quote, company, settings, message = '' }) {
  const cur = quote.currency
  const lines = (quote.lineItems || []).map((l) => `
    <tr>
      <td>
        <strong>${escapeHtml(l.name)}</strong>
        ${l.description ? `<div class="small muted">${escapeHtml(l.description)}</div>` : ''}
        ${l.discountPercent > 0 ? `<div class="discount">List ${fmtMoney(l.listPrice, cur)} — ${l.discountPercent}% discount applied</div>` : ''}
      </td>
      <td class="r">${l.quantity}</td>
      <td class="r">${fmtMoney(l.unitPrice, cur)}<div class="small muted">${PRICING_LABEL[l.pricingModel] || ''}</div></td>
      <td class="r"><strong>${fmtMoney(l.quantity * l.unitPrice, cur)}</strong></td>
    </tr>`).join('')

  const expired = quote.validUntil && new Date(quote.validUntil) < new Date()
  const decided = quote.status === 'accepted' || quote.status === 'declined'
  const canDecide = !decided && !expired && quote.status !== 'expired'

  let actions = ''
  if (quote.status === 'accepted') {
    actions = `<div class="banner banner-ok"><strong>Accepted</strong> on ${fmtDate(quote.acceptedAt)}${quote.acceptedName ? ` by ${escapeHtml(quote.acceptedName)}` : ''}. We will be in touch to get things moving.</div>`
  } else if (quote.status === 'declined') {
    actions = `<div class="banner banner-danger"><strong>Declined</strong> on ${fmtDate(quote.declinedAt)}. Thank you for letting us know.</div>`
  } else if (expired || quote.status === 'expired') {
    actions = `<div class="banner banner-warn">This quote expired on ${fmtDate(quote.validUntil)}. Get in touch and we will refresh it for you.</div>`
  } else {
    actions = `
      <div class="card">
        <h2 style="margin-top:0">Ready to go ahead?</h2>
        <form method="post" action="/q/${encodeURIComponent(quote.publicToken)}/accept">
          <div class="field">
            <label for="name">Your full name</label>
            <input id="name" name="name" required autocomplete="name" placeholder="As you would sign it">
          </div>
          <p class="small muted">
            Accepting records your name, the date and your IP address as confirmation that you
            approved this quote. It is not a substitute for a signed contract.
          </p>
          <button class="btn btn-accept" type="submit">Accept this quote</button>
        </form>
        <details style="margin-top:22px">
          <summary class="small muted" style="cursor:pointer">Not going ahead?</summary>
          <form method="post" action="/q/${encodeURIComponent(quote.publicToken)}/decline" style="margin-top:14px">
            <div class="field">
              <label for="reason">Anything you can tell us? (optional)</label>
              <textarea id="reason" name="reason" rows="3" placeholder="Price, timing, went another way…"></textarea>
            </div>
            <button class="btn btn-decline" type="submit">Decline this quote</button>
          </form>
        </details>
      </div>`
  }

  return quotePage(`${quote.number} — ${settings.companyName || 'Quote'}`, `
    ${message}
    <div class="card">
      <div class="accent-bar"></div>
      <div class="spread">
        <div>
          <h1>${escapeHtml(settings.companyName || 'Quote')}</h1>
          <div class="small muted">${escapeHtml((settings.physicalAddress || '').replace(/\n+/g, ', '))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:650;color:var(--accent);font-size:17px">QUOTE</div>
          <div class="small muted">${escapeHtml(quote.number)}${quote.version > 1 ? ` · v${quote.version}` : ''}</div>
          <div class="small muted">Valid until ${fmtDate(quote.validUntil)}</div>
        </div>
      </div>

      <h2>Prepared for ${escapeHtml(company?.name || '')}</h2>
      ${quote.title ? `<p><strong>${escapeHtml(quote.title)}</strong></p>` : ''}
      ${quote.introMessage ? `<p class="muted">${escapeHtml(quote.introMessage)}</p>` : ''}

      <table>
        <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead>
        <tbody>${lines}</tbody>
      </table>

      <div class="totals">
        ${quote.mrr > 0 ? `<div class="spread"><span class="muted">Monthly recurring</span><strong>${fmtMoney(quote.mrr, cur)}</strong></div>` : ''}
        ${quote.mrr > 0 && quote.termMonths > 0 ? `<div class="spread"><span class="muted">Over ${quote.termMonths} months</span><strong>${fmtMoney(quote.mrr * quote.termMonths, cur)}</strong></div>` : ''}
        ${quote.oneTimeTotal > 0 ? `<div class="spread"><span class="muted">One-off fees</span><strong>${fmtMoney(quote.oneTimeTotal, cur)}</strong></div>` : ''}
        <div class="spread" style="margin-top:12px"><span style="font-weight:600">Total contract value</span><span class="grand">${fmtMoney(quote.tcv, cur)}</span></div>
      </div>

      ${quote.terms ? `<h2>Terms</h2><p class="small muted">${escapeHtml(quote.terms)}</p>` : ''}

      <p style="margin-top:22px">
        <a class="btn" href="/q/${encodeURIComponent(quote.publicToken)}/pdf">Download PDF</a>
      </p>
    </div>
    ${actions}
  `)
}

async function loadPublicQuote(token) {
  const quote = await Quote.findOne({ publicToken: token })
  if (!quote) return null
  if (!PUBLIC_STATUSES.includes(quote.status)) return null
  return quote
}

router.get('/q/:token', quoteLimiter, async (req, res) => {
  const quote = await loadPublicQuote(req.params.token)
  if (!quote) {
    return res.status(404).send(quotePage('Not found', `
      <div class="card"><h1>That quote link is not valid</h1>
      <p class="muted">It may have been withdrawn or replaced by a newer version.
      Get in touch with whoever sent it and they can send you a fresh link.</p></div>`))
  }

  const [company, settings] = await Promise.all([
    Company.findById(quote.company).lean(),
    getSettings(),
  ])

  // Record the first view once. A client opening it three times is not three
  // signals, but "they have not opened it at all" is worth a rep knowing.
  if (!quote.firstViewedAt) {
    quote.firstViewedAt = new Date()
    quote.viewCount = 1
    await quote.save()
    await logActivity({
      deal: quote.deal, company: quote.company, contact: quote.contact,
      type: 'quote_viewed',
      title: `Quote ${quote.number} opened by the client`,
      meta: { quote: quote._id },
    })
  } else {
    await Quote.updateOne({ _id: quote._id }, { $inc: { viewCount: 1 } })
  }

  res.send(renderQuoteHtml({ quote, company, settings }))
})

router.get('/q/:token/pdf', quoteLimiter, async (req, res) => {
  const quote = await loadPublicQuote(req.params.token)
  if (!quote) return res.status(404).send('Not found')

  const [company, contact, owner, settings] = await Promise.all([
    Company.findById(quote.company).lean(),
    quote.contact ? Contact.findById(quote.contact).lean() : null,
    quote.owner ? User.findById(quote.owner).select('name email').lean() : null,
    getSettings(),
  ])
  const pdf = await renderQuotePdf({ quote: quote.toObject(), company, contact, owner, settings })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', pdf.length)
  res.setHeader('Content-Disposition', `inline; filename="${quote.number}.pdf"`)
  res.send(pdf)
})

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return fwd || req.ip || ''
}

router.post('/q/:token/accept', quoteLimiter, async (req, res) => {
  const quote = await loadPublicQuote(req.params.token)
  const settings = await getSettings()
  if (!quote) return res.status(404).send(quotePage('Not found', '<div class="card"><h1>That quote link is not valid</h1></div>'))

  const company = await Company.findById(quote.company).lean()

  if (quote.status === 'accepted' || quote.status === 'declined') {
    return res.send(renderQuoteHtml({ quote, company, settings }))
  }
  if (quote.validUntil && new Date(quote.validUntil) < new Date()) {
    quote.status = 'expired'
    await quote.save()
    return res.send(renderQuoteHtml({ quote, company, settings }))
  }

  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) {
    return res.send(renderQuoteHtml({
      quote, company, settings,
      message: '<div class="banner banner-warn">Please enter your name to accept.</div>',
    }))
  }

  quote.status = 'accepted'
  quote.acceptedAt = new Date()
  quote.acceptedName = name
  quote.acceptedIp = clientIp(req)
  await quote.save()

  await logActivity({
    deal: quote.deal, company: quote.company, contact: quote.contact,
    type: 'quote_accepted',
    title: `Quote ${quote.number} accepted by ${name}`,
    body: `Accepted ${quote.acceptedAt.toISOString()} from ${quote.acceptedIp || 'an unrecorded address'}.`,
    meta: { quote: quote._id, tcv: quote.tcv, currency: quote.currency },
  })

  /* The deal should now say what the client actually agreed to. Without this
     the pipeline keeps whatever the rep guessed before quoting. */
  await applyAcceptedQuoteToDeal({ quote })

  res.send(renderQuoteHtml({ quote, company, settings }))
})

router.post('/q/:token/decline', quoteLimiter, async (req, res) => {
  const quote = await loadPublicQuote(req.params.token)
  const settings = await getSettings()
  if (!quote) return res.status(404).send(quotePage('Not found', '<div class="card"><h1>That quote link is not valid</h1></div>'))
  const company = await Company.findById(quote.company).lean()

  if (quote.status === 'accepted' || quote.status === 'declined') {
    return res.send(renderQuoteHtml({ quote, company, settings }))
  }

  quote.status = 'declined'
  quote.declinedAt = new Date()
  quote.declineReason = String(req.body?.reason || '').trim().slice(0, 2000)
  await quote.save()

  await logActivity({
    deal: quote.deal, company: quote.company, contact: quote.contact,
    type: 'quote_declined',
    title: `Quote ${quote.number} declined by the client`,
    body: quote.declineReason || 'No reason given.',
    meta: { quote: quote._id },
  })

  res.send(renderQuoteHtml({ quote, company, settings }))
})

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  )
}

module.exports = router
