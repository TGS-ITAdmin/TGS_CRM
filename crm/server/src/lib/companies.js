const { Company, Activity } = require('../db')

/* Companies are matched on email domain first and name second.
 *
 * Domain is the only reliable key: two people typing "Acme Health" and
 * "Acme Health Inc." are at the same company, and both have @acmehealth.com
 * addresses. Names alone produce either duplicates or wrong merges. */

// Personal mailboxes must never become a company record.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'qq.com', '163.com',
])

function domainFromEmail(email) {
  const at = String(email || '').lastIndexOf('@')
  if (at === -1) return ''
  const domain = email.slice(at + 1).toLowerCase().trim()
  return FREE_EMAIL_DOMAINS.has(domain) ? '' : domain
}

function domainFromWebsite(website) {
  if (!website) return ''
  try {
    const url = String(website).trim()
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`
    const host = new URL(withScheme).hostname.toLowerCase()
    return host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// "Acme Health, Inc." and "acme health inc" collapse to the same key.
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|pty|plc|sa|srl|group|holdings)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/* Find an existing company, or create one. Returns null when there is nothing
 * to go on — a contact with no company is legitimate and must not produce a
 * company called "" . */
async function resolveCompany({ name, email, website, domain, extra = {}, ownerId = null, source = 'manual' }) {
  const resolvedDomain = (domain || domainFromEmail(email) || domainFromWebsite(website) || '').trim()
  const cleanName = String(name || '').trim()

  if (!resolvedDomain && !cleanName) return null

  if (resolvedDomain) {
    const byDomain = await Company.findOne({ domain: resolvedDomain })
    if (byDomain) return byDomain
  }

  if (cleanName) {
    const normalized = normalizeName(cleanName)
    if (normalized) {
      // Narrow by a loose regex, then compare normalised names in JS — a
      // normalised index would need maintaining on every write.
      const candidates = await Company.find({
        name: new RegExp(`^${cleanName.slice(0, 3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
      })
        .limit(50)
        .exec()
      const hit = candidates.find((c) => normalizeName(c.name) === normalized)
      if (hit) {
        // Backfill the domain if we have learned it since.
        if (resolvedDomain && !hit.domain) {
          hit.domain = resolvedDomain
          await hit.save()
        }
        return hit
      }
    }
  }

  const company = await Company.create({
    name: cleanName || resolvedDomain,
    domain: resolvedDomain,
    website: website || (resolvedDomain ? `https://${resolvedDomain}` : ''),
    owner: ownerId,
    source,
    ...extra,
  })
  await Activity.create({
    company: company._id,
    type: 'company_created',
    user: ownerId,
    title: `Company created (${source})`,
  })
  return company
}

module.exports = {
  resolveCompany,
  domainFromEmail,
  domainFromWebsite,
  normalizeName,
  FREE_EMAIL_DOMAINS,
}
