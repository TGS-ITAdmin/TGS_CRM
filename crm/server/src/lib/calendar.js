/* Calendar embed.
 *
 * The user pastes their own Google or Outlook calendar share URL and the CRM
 * iframes it. No OAuth, no tokens, and the CRM never reads the events — which
 * also means it cannot warn about clashes or attach meetings to deals. That
 * trade was made deliberately.
 *
 * The host allowlist is not decoration: an iframe pointing at an arbitrary URL
 * is an arbitrary page rendered inside the app's chrome, which is a convincing
 * place to ask someone for their password.
 */

const ALLOWED_HOSTS = [
  'calendar.google.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.live.com',
]

const HELP =
  'Paste the embed URL from Google Calendar (Settings → Settings for my calendars → ' +
  'Integrate calendar → Embed code) or the published-calendar URL from Outlook.'

/* Returns { ok, url } or { ok: false, error }. Accepts either a raw URL or a
 * pasted <iframe src="..."> block, because that is what the button in Google
 * Calendar actually copies. */
function normalizeCalendarUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) return { ok: true, url: '' }

  // People paste the whole iframe snippet far more often than the bare URL.
  const fromIframe = raw.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i)
  const candidate = fromIframe ? fromIframe[1] : raw

  let url
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, error: `That is not a URL. ${HELP}` }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'A calendar URL must be https.' }
  }
  if (!ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
    return {
      ok: false,
      error: `Only Google and Outlook calendars can be embedded, not ${url.hostname}. ${HELP}`,
    }
  }
  // Strip anything that could carry a credential into the frame.
  url.username = ''
  url.password = ''
  return { ok: true, url: url.toString() }
}

module.exports = { normalizeCalendarUrl, ALLOWED_HOSTS, HELP }
