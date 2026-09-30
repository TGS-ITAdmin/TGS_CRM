/* Merge-field rendering for campaign messages and call scripts.
 *
 * Syntax:  {{first_name}}            -> value, or '' if missing
 *          {{first_name|there}}      -> value, or 'there' if missing
 *
 * A blank value with no fallback would leave a hole in the sentence ("Hi ,")
 * so callers get a list of which fields came up empty and the UI warns before
 * anything is sent.
 */

/* Company values come from the linked Company record, falling back to the
 * denormalised companyName when a contact has no company yet. Callers must
 * populate('company') — an unpopulated ObjectId would render as a hex blob
 * in someone's outreach, so it is explicitly guarded against. */
function fieldMap(contact) {
  const c = contact || {}
  const co = c.company && typeof c.company === 'object' ? c.company : {}
  const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
  return {
    first_name: c.firstName || '',
    last_name: c.lastName || '',
    full_name: full,
    title: c.title || '',
    email: c.email || '',
    phone: c.phone || c.mobile || '',
    location: c.location || co.location || '',
    linkedin_url: c.linkedinUrl || '',
    source: c.source || '',

    company: co.name || c.companyName || '',
    company_size: co.employeeCount || '',
    industry: co.industry || '',
    website: co.website || '',
    company_linkedin_url: co.linkedinUrl || '',
    company_phone: co.phone || '',
    current_provider: co.currentProvider || '',
    seats_needed: co.seatsNeeded == null ? '' : String(co.seatsNeeded),
    target_roles: co.targetRoles || '',
    contract_timing: co.contractTiming || '',
    budget_range: co.budgetRange || '',
  }
}

const MERGE_FIELDS = Object.keys(fieldMap({}))

const TOKEN = /\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi

function render(template, contact, extra = {}) {
  const map = { ...fieldMap(contact), ...extra }
  const missing = new Set()
  const unknown = new Set()

  const text = String(template || '').replace(TOKEN, (match, rawKey, fallback) => {
    const key = rawKey.toLowerCase()
    if (!(key in map)) {
      unknown.add(key)
      return match // leave it visible rather than silently deleting it
    }
    const value = map[key]
    if (value) return value
    if (fallback != null && fallback.trim() !== '') return fallback.trim()
    missing.add(key)
    return ''
  })

  return { text, missing: [...missing], unknown: [...unknown] }
}

// Renders and reports whether the result is safe to send unreviewed.
function renderStage(stage, contact, extra = {}) {
  const subject = render(stage.subject || '', contact, extra)
  const body = render(stage.body || '', contact, extra)
  const missing = [...new Set([...subject.missing, ...body.missing])]
  const unknown = [...new Set([...subject.unknown, ...body.unknown])]
  return {
    subject: subject.text,
    body: body.text,
    missing,
    unknown,
    clean: missing.length === 0 && unknown.length === 0,
  }
}

module.exports = { render, renderStage, MERGE_FIELDS, fieldMap }
