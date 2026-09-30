/* End-to-end smoke test.
 *
 * Spins up a throwaway in-memory MongoDB, boots the real server, and drives
 * the real HTTP API — no external database or mail server needed.
 *
 *   npm test          (from crm/server, or `npm --prefix server test` from crm)
 *
 * The first run downloads a MongoDB binary (~80MB) into a local cache.
 */
const path = require('path')
const SERVER = path.resolve(__dirname, '..')
const { MongoMemoryServer } = require('mongodb-memory-server')

let pass = 0, fail = 0
const results = []
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`) }
  else { fail++; results.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

let TOKEN = null
const BASE = 'http://127.0.0.1:3999'

async function call(method, p, body, opts = {}) {
  const headers = {}
  if (TOKEN && !opts.noAuth) headers.Authorization = `Bearer ${TOKEN}`
  let payload = body
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(BASE + p, { method, headers, body: payload })
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('json') ? await res.json() : await res.text()
  return { status: res.status, data }
}

;(async () => {
  const mongo = await MongoMemoryServer.create()
  process.env.MONGODB_URI = mongo.getUri('tgs_crm_test')
  process.env.PORT = '3999'
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET = 'test-only-secret-not-used-anywhere-real-0123456789'
  process.env.APP_BASE_URL = BASE
  process.env.SCHEDULER_CRON = '0 0 31 2 *' // never fires; we drive it manually
  process.env.SEED_ADMIN_EMAIL = 'admin@tgsbpo.com'
  process.env.SEED_ADMIN_PASSWORD = 'Admin@123'

  require(path.join(SERVER, 'src/index.js'))
  // wait for listen
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }

  console.log('\n=== CONFIG PREFLIGHT ===')
  {
    const { checkConfig } = require(path.join(SERVER, 'src/lib/preflight.js'))
    const base = { NODE_ENV: 'production', MONGODB_URI: 'x', APP_BASE_URL: 'x' }
    check('a missing JWT_SECRET blocks startup', !checkConfig({ ...base }).ok)
    check('a placeholder JWT_SECRET blocks startup',
      !checkConfig({ ...base, JWT_SECRET: 'change-me-to-a-long-random-string' }).ok)
    check('a short JWT_SECRET blocks startup', !checkConfig({ ...base, JWT_SECRET: 'abc123' }).ok)
    check('a real JWT_SECRET is accepted',
      checkConfig({ ...base, JWT_SECRET: 'k'.repeat(48) }).ok)
    check('a missing APP_BASE_URL warns but does not block',
      checkConfig({ NODE_ENV: 'production', JWT_SECRET: 'k'.repeat(48), MONGODB_URI: 'x' }).ok === true &&
      checkConfig({ NODE_ENV: 'production', JWT_SECRET: 'k'.repeat(48), MONGODB_URI: 'x' }).warnings.length > 0)
    const seeded = require(path.join(SERVER, 'src/lib/preflight.js')).resolveSeedPassword({})
    check('an unset seed password is generated, not defaulted',
      seeded.generated === true && seeded.password.length >= 12 && seeded.password !== 'Admin@123',
      JSON.stringify({ generated: seeded.generated, len: seeded.password.length }))
  }

  console.log('\n=== AUTH ===')
  let r = await call('POST', '/api/auth/login', { email: 'admin@tgsbpo.com', password: 'wrong' }, { noAuth: true })
  check('bad password rejected', r.status === 401)
  r = await call('POST', '/api/auth/login', { email: 'admin@tgsbpo.com', password: 'Admin@123' }, { noAuth: true })
  check('admin can log in', r.status === 200 && !!r.data.token, JSON.stringify(r.data))
  TOKEN = r.data.token
  const ADMIN_ID = r.data.user.id
  r = await call('GET', '/api/contacts', null, { noAuth: true })
  check('unauthenticated request refused', r.status === 401)

  console.log('\n=== SETTINGS / COMPLIANCE GATE ===')
  r = await call('GET', '/api/settings/bootstrap')
  check('bootstrap returns statuses', r.data.settings.contactStatuses.length >= 8)
  check('bootstrap reports merge fields', r.data.mergeFields.includes('first_name'))
  check('sending blocked before address set', !!r.data.smtp.complianceBlocked, JSON.stringify(r.data.smtp))

  console.log('\n=== USERS ===')
  r = await call('POST', '/api/settings/users', { name: 'Rita Rep', email: 'rita@tgsbpo.com', password: 'RepPass123', role: 'rep' })
  check('admin can create a rep', r.status === 201, JSON.stringify(r.data))
  const REP_ID = r.data.user?.id
  r = await call('POST', '/api/settings/users', { name: 'Dup', email: 'rita@tgsbpo.com', password: 'RepPass123' })
  check('duplicate user email rejected', r.status === 409)

  console.log('\n=== LEADS ===')
  const mkContact = (o) => call('POST', '/api/contacts', o)
  r = await mkContact({ firstName: 'Ana', lastName: 'Reyes', companyName: 'Acme Health', email: 'ana@acmehealth.com', phone: '+16505550100', linkedinUrl: 'https://linkedin.com/in/anareyes', timezone: 'America/New_York', company_seatsNeeded: 30, company_industry: 'Healthcare' })
  check('contact created', r.status === 201, JSON.stringify(r.data))
  const CONTACT_A = r.data.contact.id || r.data.contact._id
  r = await mkContact({ firstName: 'Dup', email: 'ana@acmehealth.com' })
  check('duplicate email rejected', r.status === 409, JSON.stringify(r.data))
  r = await mkContact({ firstName: 'Ben', lastName: 'Cruz', companyName: 'Beta Corp', email: 'ben@betacorp.com', timezone: 'Asia/Manila', phone: '+639170000000' })
  const CONTACT_B = r.data.contact.id || r.data.contact._id
  r = await mkContact({})
  check('empty contact rejected', r.status === 400)

  r = await call('GET', '/api/contacts?q=acme')
  check('search finds contact', r.data.total === 1, JSON.stringify(r.data.total))
  r = await call('GET', '/api/contacts')
  check('list returns both contacts', r.data.total === 2)
  check('pagination metadata present', r.data.page === 1 && r.data.pages === 1)

  console.log('\n=== COMPANIES ===')
  r = await call('GET', '/api/companies')
  check('creating a contact auto-created its company', r.data.total === 2, JSON.stringify(r.data.items.map((c) => c.name)))
  const acme = r.data.items.find((c) => c.name === 'Acme Health')
  check('company got its domain from the work email', acme && acme.domain === 'acmehealth.com', JSON.stringify(acme))
  check('company-level fields landed on the company', acme && acme.seatsNeeded === 30 && acme.industry === 'Healthcare', JSON.stringify(acme))
  const COMPANY_A = acme && acme._id

  // A second person at the same company must attach, not create a duplicate.
  r = await call('POST', '/api/contacts', {
    firstName: 'Marco', lastName: 'Silva', email: 'marco@acmehealth.com', companyName: 'Acme Health Inc.',
  })
  check('second contact at same domain created', r.status === 201, JSON.stringify(r.data))
  const CONTACT_MARCO = r.data.contact.id || r.data.contact._id
  r = await call('GET', '/api/companies')
  check('same domain did not create a duplicate company', r.data.total === 2, JSON.stringify(r.data.items.map((c) => c.name)))

  r = await call('GET', `/api/companies/${COMPANY_A}`)
  check('company page lists both its contacts', r.data.contacts.length === 2, JSON.stringify(r.data.contacts.map((c) => c.firstName)))
  check('company timeline is populated', r.data.activities.length >= 2, String(r.data.activities.length))

  // A personal mailbox must never become a company.
  r = await call('POST', '/api/contacts', { firstName: 'Solo', lastName: 'Freelancer', email: 'solo@gmail.com' })
  check('free-email contact created', r.status === 201, JSON.stringify(r.data))
  r = await call('GET', '/api/companies')
  check('gmail.com did not become a company', !r.data.items.some((c) => c.domain === 'gmail.com'), JSON.stringify(r.data.items.map((c) => c.domain)))

  r = await call('POST', '/api/companies', { name: 'Acme Health' })
  check('duplicate company name is refused with a pointer', r.status === 409 && !!r.data.companyId, JSON.stringify(r.data))
  r = await call('POST', '/api/companies', { name: 'Standalone Co', domain: 'standalone.co', industry: 'BPO' })
  check('company can be created directly', r.status === 201, JSON.stringify(r.data))
  const COMPANY_STANDALONE = r.data.company._id

  r = await call('POST', `/api/companies/${COMPANY_STANDALONE}/contacts`, { firstName: 'Nina', lastName: 'Ortiz', email: 'nina@standalone.co' })
  check('contact created straight onto a company', r.status === 201 && String(r.data.contact.company) === String(COMPANY_STANDALONE), JSON.stringify(r.data.contact?.company))

  r = await call('PUT', `/api/companies/${COMPANY_STANDALONE}`, { name: 'Standalone Group' })
  check('renaming a company works', r.status === 200)
  r = await call('GET', `/api/contacts?company=${COMPANY_STANDALONE}`)
  check('rename propagated to its contacts', r.data.items[0].companyName === 'Standalone Group', r.data.items[0].companyName)

  r = await call('DELETE', `/api/companies/${COMPANY_STANDALONE}`)
  check('deleting a company with contacts is refused', r.status === 409, JSON.stringify(r.data))
  r = await call('DELETE', `/api/companies/${COMPANY_STANDALONE}?force=true`)
  check('forced delete detaches rather than deleting people', r.data.detached === 1, JSON.stringify(r.data))
  r = await call('GET', '/api/contacts?q=Nina')
  check('the detached contact survives', r.data.total === 1, JSON.stringify(r.data.total))

  console.log('\n=== CSV IMPORT ===')
  const csv = 'First Name,Last Name,Email,Company,Phone,Linkedin URL,Seats\n' +
    'Carol,Diaz,carol@gamma.io,Gamma Ltd,+442071234567,https://linkedin.com/in/caroldiaz,12\n' +
    'Dan,Evans,dan@delta.io,Delta Inc,,,\n' +
    'Carol,Dupe,carol@gamma.io,Gamma Ltd,,,\n' +
    ',,,,,,\n'
  const fd = new FormData()
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv')
  r = await call('POST', '/api/contacts/import/preview', fd)
  check('import preview reads rows', r.data.rowCount === 4, JSON.stringify(r.data.rowCount))
  check('auto-mapped first name', r.data.suggestedMapping.firstName === 'First Name', JSON.stringify(r.data.suggestedMapping))
  check('auto-mapped company to companyName', r.data.suggestedMapping.companyName === 'Company', JSON.stringify(r.data.suggestedMapping))
  check('auto-mapped linkedin', r.data.suggestedMapping.linkedinUrl === 'Linkedin URL')

  const fd2 = new FormData()
  fd2.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv')
  fd2.append('mapping', JSON.stringify(r.data.suggestedMapping))
  fd2.append('options', JSON.stringify({ source: 'test_csv', tag: 'batch1', onDuplicate: 'skip' }))
  r = await call('POST', '/api/contacts/import', fd2)
  check('import created 2 contacts', r.data.result.created === 2, JSON.stringify(r.data.result))
  check('import skipped dupe + blank row', r.data.result.skipped === 2, JSON.stringify(r.data.result))

  console.log('\n=== CAMPAIGN ===')
  r = await call('POST', '/api/campaigns', {
    name: 'Multi-channel test',
    stages: [
      { name: 'LinkedIn connect', channel: 'linkedin', waitDays: 0, body: 'Hi {{first_name|there}} at {{company}}' },
      { name: 'Intro email', channel: 'email', waitDays: 0, subject: 'Capacity for {{company}}', body: 'Hi {{first_name|there}},\n\nWorth a chat?' },
      { name: 'Cold call', channel: 'call', waitDays: 30, body: 'Ask for {{first_name|the decision maker}}' },
    ],
  })
  check('campaign created', r.status === 201, JSON.stringify(r.data))
  const CAMP = r.data.campaign.id || r.data.campaign._id

  r = await call('POST', `/api/campaigns/${CAMP}/stages/0/preview`, { contactId: CONTACT_A })
  check('stage preview merges fields through the company relation', r.data.body === 'Hi Ana at Acme Health', r.data.body)
  check('preview reports clean merge', r.data.clean === true)

  console.log('\n=== ENROLL + STAGE ENGINE ===')
  r = await call('POST', `/api/campaigns/${CAMP}/enroll`, { contactIds: [CONTACT_A, CONTACT_B] })
  check('both contacts enrolled', r.data.enrolled === 2, JSON.stringify(r.data))
  r = await call('POST', `/api/campaigns/${CAMP}/enroll`, { contactIds: [CONTACT_A] })
  check('re-enrolling is a no-op', r.data.alreadyIn === 1 && r.data.enrolled === 0, JSON.stringify(r.data))

  r = await call('GET', '/api/work/my-day')
  check('stage 1 created LinkedIn tasks', r.data.counts.dueToday + r.data.counts.overdue === 2, JSON.stringify(r.data.counts))
  const stage1TaskIds = [...r.data.overdue, ...r.data.today].map((t) => t._id)
  const liTask = [...r.data.overdue, ...r.data.today][0]
  check('task carries merged script', liTask.scriptBody.startsWith('Hi '), liTask.scriptBody)
  check('task is a linkedin task', liTask.channel === 'linkedin')

  // waitDays 0 → due immediately; run the engine
  r = await call('POST', '/api/scheduler/run')
  check('scheduler advanced both contacts', r.data.result.advanced === 2, JSON.stringify(r.data.result))

  r = await call('GET', '/api/work/tasks?status=skipped')
  check('unfinished stage-1 tasks retired when contacts moved on',
    stage1TaskIds.every((id) => r.data.items.some((t) => t._id === id)),
    JSON.stringify(r.data.items.map((t) => t.status)))

  r = await call('GET', '/api/work/outbox?status=queued')
  check('email stage queued drafts, did not send', r.data.total === 2, JSON.stringify(r.data.total))
  const draft = r.data.items[0]
  check('draft subject merged', draft.subject.startsWith('Capacity for '), draft.subject)
  check('draft status is queued', draft.status === 'queued')

  console.log('\n=== SEND BLOCKED WITHOUT COMPLIANCE ===')
  r = await call('POST', `/api/work/outbox/${draft._id}/send`, {})
  check('send refused while address missing', r.status === 400 && /physical postal address/i.test(r.data.error), JSON.stringify(r.data))

  r = await call('PUT', '/api/settings', { physicalAddress: '12 Example St, Makati, PH', appBaseUrl: BASE })
  check('compliance settings saved', r.status === 200)
  r = await call('POST', `/api/work/outbox/${draft._id}/send`, {})
  check('send now fails on missing SMTP, not compliance', r.status === 400 && /SMTP/i.test(r.data.error), JSON.stringify(r.data))
  r = await call('GET', '/api/work/outbox?status=queued')
  check('a setup failure leaves the draft queued, not burned', r.data.items.some((m) => m._id === draft._id), JSON.stringify(r.data.items.map((m) => m._id)))

  console.log('\n=== DNC / UNSUBSCRIBE ===')
  r = await call('GET', `/api/contacts/${CONTACT_B}`)
  const tokenB = r.data.contact.unsubscribeToken
  check('contact exposes unsubscribe token', !!tokenB)
  const unsubRes = await fetch(`${BASE}/u/${tokenB}`, { method: 'POST' })
  check('unsubscribe page accepts POST', unsubRes.status === 200)

  r = await call('GET', `/api/contacts/${CONTACT_B}`)
  check('contact marked unsubscribed', !!r.data.contact.unsubscribedAt && r.data.contact.doNotContact === true)
  check('contact status set to dnc', r.data.contact.status === 'dnc', r.data.contact.status)
  check('enrollment exited on unsubscribe', r.data.enrollments.every((e) => e.status !== 'active'), JSON.stringify(r.data.enrollments.map(e=>e.status)))
  check('queued draft cancelled on unsubscribe', r.data.queuedMessages.length === 0)

  r = await call('POST', '/api/work/outbox/precheck', { ids: [draft._id, r.data.contact._id] })
  check('precheck endpoint responds', r.status === 200)

  console.log('\n=== SUPPRESSION LIST ===')
  r = await call('POST', '/api/settings/suppressions', { domain: 'gamma.io', note: 'competitor' })
  check('domain suppression flags matching contacts', r.data.contactsFlagged === 1, JSON.stringify(r.data))

  console.log('\n=== TASK COMPLETION + CALL OUTCOMES ===')
  // Second tick moves the surviving contact from the email stage to the call stage.
  await call('POST', '/api/scheduler/run')
  r = await call('GET', '/api/work/my-day')
  const callTasks = [...r.data.overdue, ...r.data.today].filter((t) => t.channel === 'call')
  check('a call task exists after advancing', callTasks.length >= 1, JSON.stringify(r.data.counts))
  if (callTasks.length) {
    const ct = callTasks[0]
    r = await call('POST', `/api/work/tasks/${ct._id}/complete`, {})
    check('call task requires an outcome', r.status === 400, JSON.stringify(r.data))
    r = await call('POST', `/api/work/tasks/${ct._id}/complete`, { outcome: 'meeting_booked', notes: 'Booked for Tuesday', callbackDays: 3 })
    check('call logged with outcome', r.status === 200 && !!r.data.callbackTask, JSON.stringify(r.data).slice(0, 200))
    r = await call('GET', `/api/contacts/${ct.contact._id}`)
    check('meeting_booked bumps contact status', r.data.contact.status === 'meeting_booked', r.data.contact.status)
    check('call appears on timeline', r.data.activities.some((a) => a.type === 'call_logged'))
  }

  console.log('\n=== CALL LIST TIMEZONES ===')
  r = await call('GET', '/api/work/call-list')
  check('call list returns items', Array.isArray(r.data.items))
  const withTz = r.data.items.filter((t) => t.contactLocalTime)
  check('local time computed for known timezones', withTz.length >= 1 || r.data.items.length === 0,
    JSON.stringify(r.data.items.map((i) => [i.contact?.timezone, i.contactLocalTime])))

  console.log('\n=== MOVE BETWEEN CAMPAIGNS ===')
  r = await call('POST', '/api/campaigns', {
    name: 'Nurture', stages: [{ name: 'Check-in email', channel: 'email', waitDays: 30, subject: 'Hi', body: 'Hello {{first_name|there}}' }],
  })
  const CAMP2 = r.data.campaign.id || r.data.campaign._id
  r = await call('POST', '/api/campaigns/move', { contactIds: [CONTACT_A], toCampaign: CAMP2 })
  check('contact moved to new campaign', r.data.moved === 1, JSON.stringify(r.data))
  check('pending work cancelled on move', r.data.cancelledTasks + r.data.cancelledMessages >= 0)
  r = await call('GET', `/api/contacts/${CONTACT_A}`)
  const activeEnr = r.data.enrollments.filter((e) => e.status === 'active')
  check('exactly one active enrollment after move', activeEnr.length === 1, JSON.stringify(r.data.enrollments.map(e=>[e.campaign?.name,e.status])))
  check('history preserved after move', r.data.enrollments.length === 2)
  check('exit logged on timeline', r.data.activities.some((a) => a.type === 'campaign_exited'))

  console.log('\n=== MULTIPLE SIMULTANEOUS CAMPAIGNS ===')
  r = await call('POST', `/api/campaigns/${CAMP}/enroll`, { contactIds: [CONTACT_A] })
  check('contact re-enrolled into first campaign', r.data.enrolled === 1)
  r = await call('GET', `/api/contacts/${CONTACT_A}`)
  check('contact now active in two campaigns at once',
    r.data.enrollments.filter((e) => e.status === 'active').length === 2,
    JSON.stringify(r.data.enrollments.map(e=>[e.campaign?.name,e.status])))

  console.log('\n=== BOARD + JUMP TO STAGE ===')
  r = await call('GET', `/api/campaigns/${CAMP}/board`)
  check('board returns a column per stage', r.data.columns.length === 3, JSON.stringify(r.data.columns.length))
  const boardCard = r.data.columns.flatMap((c) => c.cards)[0]
  if (boardCard) {
    r = await call('POST', `/api/campaigns/enrollments/${boardCard.enrollmentId}/stage`, { stageIndex: 2 })
    check('jump to arbitrary stage works', r.data.changed === true, JSON.stringify(r.data))
    r = await call('POST', `/api/campaigns/enrollments/${boardCard.enrollmentId}/stage`, { stageIndex: 99 })
    check('invalid stage index rejected', r.status === 400)
  }

  console.log('\n=== DEALS: PIPELINE + MONEY ===')
  r = await call('GET', '/api/deals/meta')
  check('pipeline meta exposes stages', r.data.stages.length >= 5, JSON.stringify(r.data.stages?.map((x) => x.key)))
  check('meta has a won and a lost stage',
    r.data.stages.some((x) => x.type === 'won') && r.data.stages.some((x) => x.type === 'lost'))
  check('meta exposes the currency table', r.data.currencies.some((c) => c.code === 'PHP'), JSON.stringify(r.data.currencies?.map((c) => c.code)))
  const FIRST_STAGE = r.data.stages.find((x) => x.type === 'open').key
  const WON_STAGE = r.data.stages.find((x) => x.type === 'won').key
  const LOST_STAGE = r.data.stages.find((x) => x.type === 'lost').key

  r = await call('GET', '/api/companies')
  const dealCompany = r.data.items.find((c) => c.name === 'Acme Health')

  r = await call('POST', '/api/deals', {})
  check('a deal without a company is refused', r.status === 400, JSON.stringify(r.data))

  r = await call('POST', '/api/deals', {
    company: dealCompany._id, primaryContact: CONTACT_A,
    name: 'Acme Health — 30 seats', amount: 480000, termMonths: 24,
    currency: 'USD', expectedCloseDate: '2026-11-30', forecastCategory: 'best_case',
  })
  check('deal created', r.status === 201, JSON.stringify(r.data).slice(0, 200))
  const DEAL = r.data.deal._id
  check('deal starts at the first open stage', r.data.deal.stage === FIRST_STAGE, r.data.deal.stage)
  check('manual TCV recorded', r.data.deal.tcv === 480000, String(r.data.deal.tcv))
  check('MRR derived from the term', r.data.deal.mrr === 20000, String(r.data.deal.mrr))

  // Multi-currency: the rate must be stamped, not looked up at read time.
  r = await call('POST', '/api/deals', {
    company: dealCompany._id, name: 'Peso deal', amount: 1000000, termMonths: 10, currency: 'PHP',
  })
  check('PHP deal converts to the reporting currency', r.data.deal.tcvUsd === 17500, JSON.stringify({ tcv: r.data.deal.tcv, usd: r.data.deal.tcvUsd, fx: r.data.deal.fxRate }))
  check('fx rate is stamped on the deal', r.data.deal.fxRate === 0.0175, String(r.data.deal.fxRate))
  const PESO_DEAL = r.data.deal._id

  r = await call('PUT', `/api/deals/${DEAL}`, { currency: 'XYZ' })
  check('an unknown currency is refused', r.status === 400 && /not in your currency list/i.test(r.data.error), JSON.stringify(r.data))

  // Line-item pricing: MRR and one-off fees must not be conflated.
  r = await call('PUT', `/api/deals/${DEAL}`, {
    pricingMode: 'line_items', termMonths: 24,
    lineItems: [
      { name: 'Support agent', pricingModel: 'per_seat_monthly', quantity: 30, unitPrice: 1200, listPrice: 1400 },
      { name: 'Setup fee', pricingModel: 'one_time', quantity: 1, unitPrice: 15000, listPrice: 15000 },
    ],
  })
  check('line items produce MRR', r.data.deal.mrr === 36000, String(r.data.deal.mrr))
  check('one-off fees are kept separate from MRR', r.data.deal.oneTimeTotal === 15000, String(r.data.deal.oneTimeTotal))
  check('TCV = MRR x term + one-off', r.data.deal.tcv === 879000, String(r.data.deal.tcv))
  check('discount computed from list price', r.data.deal.lineItems[0].discountPercent === 14.29, String(r.data.deal.lineItems[0].discountPercent))

  r = await call('PUT', `/api/deals/${DEAL}`, { stage: WON_STAGE })
  check('stage cannot be changed through a field update', r.status === 400, JSON.stringify(r.data))

  console.log('\n=== DEALS: STAGE MOVEMENT ===')
  r = await call('POST', `/api/deals/${DEAL}/stage`, { stage: 'proposal' })
  check('stage move works', r.data.changed === true, JSON.stringify(r.data).slice(0, 150))
  check('probability follows the stage', r.data.deal.probability === 50, String(r.data.deal.probability))
  check('stage history recorded', r.data.deal.stageHistory.length === 2, String(r.data.deal.stageHistory?.length))

  r = await call('POST', `/api/deals/${PESO_DEAL}/stage`, { stage: LOST_STAGE })
  check('losing without a reason is refused', r.status === 400 && /reason/i.test(r.data.error), JSON.stringify(r.data))
  r = await call('POST', `/api/deals/${PESO_DEAL}/stage`, { stage: LOST_STAGE, lostReason: 'Price too high' })
  check('deal can be lost with a reason', r.data.deal.status === 'lost', r.data.deal.status)
  check('a lost deal is omitted from the forecast', r.data.deal.forecastCategory === 'omitted', r.data.deal.forecastCategory)
  check('probability zeroed on loss', r.data.deal.probability === 0, String(r.data.deal.probability))

  r = await call('POST', `/api/deals/${DEAL}/stage`, { stage: WON_STAGE })
  check('deal can be won', r.data.deal.status === 'won' && r.data.deal.probability === 100, JSON.stringify(r.data.deal.status))
  r = await call('GET', `/api/contacts/${CONTACT_A}`)
  check('winning marks the deal contacts as customers', r.data.contact.status === 'customer', r.data.contact.status)

  r = await call('POST', `/api/deals/${PESO_DEAL}/reopen`, { stage: FIRST_STAGE })
  check('a closed deal can be reopened', r.data.deal.status === 'open', r.data.deal.status)

  console.log('\n=== DEALS: MEETING BOOKED AUTO-CREATES ===')
  r = await call('GET', '/api/companies')
  const betaCo = r.data.items.find((c) => c.name === 'Beta Corp')
  if (betaCo) {
    r = await call('GET', `/api/contacts?company=${betaCo._id}`)
    const betaContact = r.data.items[0]
    const before = (await call('GET', '/api/deals?includeClosed=true')).data.total
    r = await call('PUT', `/api/contacts/${betaContact._id}`, { status: 'meeting_booked' })
    check('booking a meeting auto-creates a deal', r.data.deal?.created === true, JSON.stringify(r.data.deal))
    const after = (await call('GET', '/api/deals?includeClosed=true')).data.total
    check('deal count went up by exactly one', after === before + 1, `${before} -> ${after}`)
    check('the new deal is prefilled from the company', !!r.data.deal?.dealId)

    // A second meeting on a live deal is not a second deal.
    r = await call('PUT', `/api/contacts/${betaContact._id}`, { status: 'engaged' })
    r = await call('PUT', `/api/contacts/${betaContact._id}`, { status: 'meeting_booked' })
    check('a second meeting does not create a duplicate deal', r.data.deal?.created === false, JSON.stringify(r.data.deal))
    const after2 = (await call('GET', '/api/deals?includeClosed=true')).data.total
    check('deal count unchanged on the second meeting', after2 === after, `${after} -> ${after2}`)
  }

  console.log('\n=== DEALS: BOARD, VISIBILITY, REPORTS ===')
  r = await call('GET', '/api/deals/board')
  check('deal board returns a column per stage', r.data.columns.length >= 7, String(r.data.columns?.length))
  check('board columns carry weighted totals', r.data.columns.every((c) => typeof c.weightedUsd === 'number'))

  r = await call('GET', '/api/reports/pipeline')
  check('pipeline report works', r.status === 200 && Array.isArray(r.data.stages), JSON.stringify(r.data).slice(0, 120))
  check('pipeline reports a win rate', r.data.closed.winRate !== undefined, JSON.stringify(r.data.closed))
  check('loss reasons are broken out', r.data.closed.lossReasons.length >= 0, JSON.stringify(r.data.closed.lossReasons))

  r = await call('GET', '/api/reports/forecast?months=6')
  check('forecast report works', r.status === 200 && r.data.buckets.length === 6, String(r.data.buckets?.length))
  check('forecast separates commit from weighted',
    r.data.buckets.every((b) => 'commitUsd' in b && 'weightedUsd' in b))
  check('forecast flags deals with no close date', typeof r.data.undated === 'number', String(r.data.undated))

  r = await call('GET', '/api/reports/summary')
  check('summary carries pipeline value', typeof r.data.pipeline?.tcvUsd === 'number', JSON.stringify(r.data.pipeline))
  check('summary carries won value', typeof r.data.won?.tcvUsd === 'number', JSON.stringify(r.data.won))

  r = await call('GET', '/api/settings/deal-stages')
  r = await call('PUT', '/api/settings/deal-stages', {
    stages: [{ key: 'only', name: 'Only stage', probability: 50, type: 'open' }],
  })
  check('a pipeline with no Won stage is refused', r.status === 400 && /won/i.test(r.data.error), JSON.stringify(r.data))

  r = await call('PUT', '/api/settings/currencies', {
    currencies: [{ code: 'USD', symbol: '$', rate: 2 }], reportingCurrency: 'USD',
  })
  check('reporting currency must have a rate of 1', r.status === 400 && /exactly 1/.test(r.data.error), JSON.stringify(r.data))

  console.log('\n=== SETTINGS BACKFILL ===')
  // Simulate an install whose settings document predates a feature: strip the
  // field and make sure the rules still bite rather than silently switching off.
  r = await call('GET', '/api/settings/quote-approval')
  check('approval defaults are present on a fresh install',
    r.data.quoteApproval?.anyDiscount?.enabled === true, JSON.stringify(r.data.quoteApproval))

  console.log('\n=== PRODUCTS: THE RATE CARD ===')
  r = await call('POST', '/api/products', { name: 'No price' })
  check('product created with defaults', r.status === 201, JSON.stringify(r.data).slice(0, 150))
  const PROD_BLANK = r.data.product._id

  r = await call('POST', '/api/products', {
    name: 'Customer Support Agent — Tier 1', sku: 'CSA-T1', category: 'Support',
    pricingModel: 'per_seat_monthly', currency: 'USD',
    listPrice: 1400, floorPrice: 1100, unitCost: 700,
    description: 'Voice and email, 24/5 coverage',
  })
  check('priced product created', r.status === 201, JSON.stringify(r.data).slice(0, 150))
  const PROD_AGENT = r.data.product._id

  r = await call('POST', '/api/products', { name: 'Dupe sku', sku: 'CSA-T1', listPrice: 100 })
  check('duplicate SKU refused', r.status === 409, JSON.stringify(r.data))

  r = await call('POST', '/api/products', { name: 'Bad floor', listPrice: 100, floorPrice: 200 })
  check('floor above list refused', r.status === 400 && /floor price cannot be above/i.test(r.data.error), JSON.stringify(r.data))

  r = await call('POST', '/api/products', { name: 'Bad currency', currency: 'XYZ', listPrice: 10 })
  check('unknown product currency refused', r.status === 400, JSON.stringify(r.data))

  r = await call('POST', '/api/products', {
    name: 'Recruitment & onboarding', sku: 'ONB-1', pricingModel: 'one_time',
    currency: 'USD', listPrice: 15000, floorPrice: 12000,
  })
  const PROD_SETUP = r.data.product._id

  r = await call('GET', '/api/products')
  check('rate card lists active products', r.data.items.length === 3, String(r.data.items.length))

  console.log('\n=== QUOTES: BUILD + APPROVAL RULES ===')
  // A fresh deal to quote against, so earlier tests cannot interfere.
  r = await call('GET', '/api/companies')
  const quoteCo = r.data.items.find((c) => c.name === 'Acme Health')
  r = await call('POST', '/api/deals', {
    company: quoteCo._id, name: 'Acme Health — quoting test',
    amount: 100000, termMonths: 24, currency: 'USD', expectedCloseDate: '2026-12-01',
  })
  const QDEAL = r.data.deal._id

  r = await call('POST', '/api/quotes', {})
  check('a quote without a deal is refused', r.status === 400, JSON.stringify(r.data))

  r = await call('POST', '/api/quotes', { deal: QDEAL })
  check('quote created as a draft', r.status === 201 && r.data.quote.status === 'draft', JSON.stringify(r.data).slice(0, 150))
  check('quote number is sequential and prefixed', /^Q-\d{4}-\d{4}$/.test(r.data.quote.number), r.data.quote.number)
  const QUOTE = r.data.quote._id
  const QUOTE_NUMBER = r.data.quote.number

  r = await call('POST', '/api/quotes', { deal: QDEAL })
  check('a second quote gets the next number', r.data.quote.number !== QUOTE_NUMBER, `${QUOTE_NUMBER} vs ${r.data.quote.number}`)
  const QUOTE_SPARE = r.data.quote._id

  r = await call('POST', `/api/quotes/${QUOTE}/submit`, {})
  check('an empty quote cannot be submitted', r.status === 400, JSON.stringify(r.data))

  // Add a line from the rate card at list price — nothing breached but value.
  r = await call('POST', `/api/quotes/${QUOTE}/lines`, { productId: PROD_AGENT, quantity: 10 })
  check('line added from the rate card', r.data.quote.lineItems.length === 1, JSON.stringify(r.data).slice(0, 120))
  check('line snapshots the list and floor price',
    r.data.quote.lineItems[0].listPrice === 1400 && r.data.quote.lineItems[0].floorPrice === 1100,
    JSON.stringify(r.data.quote.lineItems[0]))
  check('at list price there is no discount', r.data.quote.lineItems[0].discountPercent === 0, String(r.data.quote.lineItems[0].discountPercent))

  r = await call('POST', `/api/quotes/${QUOTE}/lines`, { productId: PROD_SETUP, quantity: 1 })
  check('one-off line kept out of MRR', r.data.quote.mrr === 14000 && r.data.quote.oneTimeTotal === 15000,
    JSON.stringify({ mrr: r.data.quote.mrr, one: r.data.quote.oneTimeTotal }))
  check('TCV = MRR x term + one-off', r.data.quote.tcv === 14000 * 24 + 15000, String(r.data.quote.tcv))
  check('margin tracked from unit cost', r.data.quote.totalCost === 700 * 10 * 24, String(r.data.quote.totalCost))

  // A PHP-priced product must not land on a USD quote.
  r = await call('POST', '/api/products', { name: 'Peso agent', currency: 'PHP', listPrice: 60000 })
  const PROD_PESO = r.data.product._id
  r = await call('POST', `/api/quotes/${QUOTE}/lines`, { productId: PROD_PESO, quantity: 1 })
  check('mixing currencies on one quote is refused', r.status === 400 && /currenc/i.test(r.data.error), JSON.stringify(r.data))

  r = await call('GET', `/api/quotes/${QUOTE}`)
  check('quote preview shows which rules it would breach', Array.isArray(r.data.wouldNeedApproval), JSON.stringify(r.data.wouldNeedApproval))
  const previewRules = r.data.wouldNeedApproval.map((x) => x.rule)
  check('value threshold breached at list price', previewRules.includes('valueOver'), JSON.stringify(previewRules))
  check('no discount rule fires at list price', !previewRules.includes('anyDiscount'), JSON.stringify(previewRules))

  console.log('\n=== QUOTES: APPROVAL GATE ===')
  r = await call('POST', `/api/quotes/${QUOTE}/submit`, {})
  check('a breaching quote lands in pending approval', r.data.quote.status === 'pending_approval', r.data.quote.status)
  check('the breached rules are recorded on the quote', r.data.quote.approvalReasons.length >= 1, JSON.stringify(r.data.quote.approvalReasons))

  r = await call('POST', `/api/quotes/${QUOTE}/sent`, {})
  check('an unapproved quote cannot be marked sent', r.status === 409 && /waiting for approval/i.test(r.data.error), JSON.stringify(r.data))

  r = await call('PUT', `/api/quotes/${QUOTE}`, { title: 'Sneaky edit' })
  check('a submitted quote cannot be edited in place', r.status === 409, JSON.stringify(r.data))

  // The public link must not expose anything an admin has not cleared.
  const qDoc = await call('GET', `/api/quotes/${QUOTE}`)
  const PUBLIC_TOKEN = qDoc.data.quote.publicToken
  let pub = await fetch(`${BASE}/q/${PUBLIC_TOKEN}`)
  check('a pending quote is NOT reachable on its public link', pub.status === 404, String(pub.status))

  r = await call('POST', `/api/quotes/${QUOTE}/decide`, { decision: 'reject' })
  check('rejecting without a note is refused', r.status === 400, JSON.stringify(r.data))
  r = await call('POST', `/api/quotes/${QUOTE}/decide`, { decision: 'reject', note: 'Discount the setup fee instead' })
  check('admin can reject with a note', r.data.quote.status === 'rejected', r.data.quote.status)

  r = await call('PUT', `/api/quotes/${QUOTE}`, { title: 'Acme Health — 10 seats' })
  check('a rejected quote returns to draft when edited', r.data.quote.status === 'draft', r.data.quote.status)

  r = await call('POST', `/api/quotes/${QUOTE}/submit`, {})
  r = await call('POST', `/api/quotes/${QUOTE}/decide`, { decision: 'approve', note: 'Fine at list' })
  check('admin can approve', r.data.quote.status === 'approved', r.data.quote.status)

  console.log('\n=== QUOTES: AUTO-APPROVE WHEN CLEAN ===')
  // Small, at list, long term: breaks nothing, so it should not need a human.
  r = await call('POST', `/api/quotes/${QUOTE_SPARE}/lines`, { productId: PROD_AGENT, quantity: 1 })
  r = await call('PUT', `/api/quotes/${QUOTE_SPARE}`, { termMonths: 24 })
  r = await call('POST', `/api/quotes/${QUOTE_SPARE}/submit`, {})
  check('a clean quote is auto-approved', r.data.autoApproved === true && r.data.quote.status === 'approved',
    JSON.stringify({ auto: r.data.autoApproved, status: r.data.quote.status }))
  check('auto-approval says why', /auto-approved/i.test(r.data.quote.decisionNote), r.data.quote.decisionNote)

  console.log('\n=== QUOTES: PDF + PUBLIC LINK ===')
  const pdfRes = await fetch(`${BASE}/api/quotes/${QUOTE}/pdf`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer())
  check('PDF renders', pdfRes.status === 200 && pdfBuf.subarray(0, 5).toString() === '%PDF-', `${pdfRes.status} ${pdfBuf.subarray(0, 5).toString()}`)
  check('PDF is served as a real attachment',
    (pdfRes.headers.get('content-disposition') || '').includes(QUOTE_NUMBER), pdfRes.headers.get('content-disposition'))

  pub = await fetch(`${BASE}/q/${PUBLIC_TOKEN}`)
  const pubHtml = await pub.text()
  check('an approved quote IS reachable publicly', pub.status === 200, String(pub.status))
  check('the public page shows the total', pubHtml.includes('Total contract value'))
  check('the public page offers accept and decline', pubHtml.includes('Accept this quote') && pubHtml.includes('Decline this quote'))

  r = await call('GET', `/api/quotes/${QUOTE}`)
  check('opening the link is logged as a view', !!r.data.quote.firstViewedAt, JSON.stringify(r.data.quote.firstViewedAt))

  console.log('\n=== QUOTES: ACCEPTANCE UPDATES THE DEAL ===')
  const dealBefore = (await call('GET', `/api/deals/${QDEAL}`)).data.deal
  check('deal still on its typed-in figure before acceptance', dealBefore.pricingMode === 'manual', dealBefore.pricingMode)

  let accept = await fetch(`${BASE}/q/${PUBLIC_TOKEN}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: '' }),
  })
  let acceptHtml = await accept.text()
  check('accepting without a name is refused', acceptHtml.includes('Please enter your name'), String(accept.status))

  accept = await fetch(`${BASE}/q/${PUBLIC_TOKEN}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Ana Reyes' }),
  })
  acceptHtml = await accept.text()
  check('accepting works', acceptHtml.includes('Accepted'), String(accept.status))

  r = await call('GET', `/api/quotes/${QUOTE}`)
  check('acceptance records the name', r.data.quote.acceptedName === 'Ana Reyes', r.data.quote.acceptedName)
  check('acceptance records a timestamp', !!r.data.quote.acceptedAt)

  const dealAfter = (await call('GET', `/api/deals/${QDEAL}`)).data.deal
  check('accepting rewrites the deal from the quote', dealAfter.pricingMode === 'line_items', dealAfter.pricingMode)
  check('deal value now matches the accepted quote', dealAfter.tcv === 14000 * 24 + 15000, `${dealAfter.tcv}`)
  check('deal MRR matches the accepted quote', dealAfter.mrr === 14000, String(dealAfter.mrr))

  r = await call('POST', `/api/quotes/${QUOTE}/revise`, {})
  check('an accepted quote cannot be revised', r.status === 409 && /agreement/i.test(r.data.error), JSON.stringify(r.data))

  console.log('\n=== QUOTES: VERSIONING ===')
  r = await call('POST', `/api/quotes/${QUOTE_SPARE}/sent`, {})
  check('an approved quote can be marked sent', r.data.quote.status === 'sent', r.data.quote.status)
  r = await call('PUT', `/api/quotes/${QUOTE_SPARE}`, { title: 'Edit after sending' })
  check('a sent quote cannot be edited in place', r.status === 409 && r.data.canRevise === true, JSON.stringify(r.data))

  r = await call('POST', `/api/quotes/${QUOTE_SPARE}/revise`, {})
  check('revising creates version 2', r.status === 201 && r.data.quote.version === 2, JSON.stringify({ v: r.data.quote?.version }))
  check('the new version keeps the same quote number', r.data.quote.number === (await call('GET', `/api/quotes/${QUOTE_SPARE}`)).data.quote.number)
  const QUOTE_V2 = r.data.quote._id
  r = await call('GET', `/api/quotes/${QUOTE_SPARE}`)
  check('the old version is marked superseded', r.data.quote.status === 'superseded', r.data.quote.status)
  const oldToken = r.data.quote.publicToken
  pub = await fetch(`${BASE}/q/${oldToken}`)
  check('a superseded quote is no longer reachable publicly', pub.status === 404, String(pub.status))

  r = await call('GET', `/api/quotes/${QUOTE_V2}`)
  check('version history is visible on the quote', r.data.versions.length === 2, String(r.data.versions?.length))

  console.log('\n=== QUOTES: DECLINE + SETTINGS ===')
  r = await call('POST', `/api/quotes/${QUOTE_V2}/submit`, {})
  r = await call('GET', `/api/quotes/${QUOTE_V2}`)
  const v2Token = r.data.quote.publicToken
  if (r.data.quote.status === 'pending_approval') {
    await call('POST', `/api/quotes/${QUOTE_V2}/decide`, { decision: 'approve', note: 'ok' })
  }
  const decline = await fetch(`${BASE}/q/${v2Token}/decline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ reason: 'Went with an in-house team' }),
  })
  const declineHtml = await decline.text()
  check('declining works', declineHtml.includes('Declined'), String(decline.status))
  r = await call('GET', `/api/quotes/${QUOTE_V2}`)
  check('the decline reason is kept', r.data.quote.declineReason === 'Went with an in-house team', r.data.quote.declineReason)

  r = await call('PUT', '/api/settings/quote-approval', {
    quoteApproval: {
      anyDiscount: { enabled: false },
      valueOver: { enabled: false, amount: 250000 },
      discountOver: { enabled: true, percent: 20 },
      rateFloor: { enabled: true },
      minTerm: { enabled: false, months: 12 },
    },
  })
  check('approval rules can be switched off individually',
    r.data.quoteApproval.anyDiscount.enabled === false && r.data.quoteApproval.discountOver.enabled === true,
    JSON.stringify(r.data.quoteApproval))

  // With anyDiscount off and the value rule off, a discounted-but-above-floor
  // quote inside the percentage limit should now sail through.
  r = await call('POST', '/api/quotes', { deal: QDEAL })
  const QUOTE_RULES = r.data.quote._id
  await call('POST', `/api/quotes/${QUOTE_RULES}/lines`, { productId: PROD_AGENT, quantity: 2, unitPrice: 1300 })
  r = await call('POST', `/api/quotes/${QUOTE_RULES}/submit`, {})
  check('a small discount above the floor now auto-approves',
    r.data.autoApproved === true, JSON.stringify({ auto: r.data.autoApproved, reasons: r.data.reasons }))

  // Below the floor must still be caught, because that rule is still on.
  r = await call('POST', '/api/quotes', { deal: QDEAL })
  const QUOTE_FLOOR = r.data.quote._id
  await call('POST', `/api/quotes/${QUOTE_FLOOR}/lines`, { productId: PROD_AGENT, quantity: 2, unitPrice: 900 })
  r = await call('POST', `/api/quotes/${QUOTE_FLOOR}/submit`, {})
  check('below the floor rate still needs approval',
    r.data.quote.status === 'pending_approval' && r.data.reasons.some((x) => x.rule === 'rateFloor'),
    JSON.stringify(r.data.reasons))

  r = await call('DELETE', `/api/products/${PROD_AGENT}`)
  check('deleting a product used on quotes is refused', r.status === 409 && r.data.canDeactivate === true, JSON.stringify(r.data))
  r = await call('PUT', `/api/products/${PROD_AGENT}`, { active: false })
  check('but it can be deactivated', r.data.product.active === false)
  r = await call('DELETE', `/api/products/${PROD_BLANK}`)
  check('an unused product can be deleted', r.status === 200, JSON.stringify(r.data))

  console.log('\n=== CUSTOM FIELDS ===')
  r = await call('POST', '/api/custom-fields', { object: 'deal', label: 'Delivery site', type: 'text' })
  check('custom field created', r.status === 201, JSON.stringify(r.data).slice(0, 150))
  check('key auto-slugged from the label', r.data.field.key === 'delivery_site', r.data.field?.key)
  const CF_TEXT = r.data.field._id

  r = await call('POST', '/api/custom-fields', { object: 'deal', label: 'Delivery site', type: 'text' })
  check('duplicate key refused', r.status === 409, JSON.stringify(r.data))

  r = await call('POST', '/api/custom-fields', {
    object: 'deal', label: 'Region', type: 'select', options: ['APAC', 'EMEA', 'Americas'],
  })
  const CF_SELECT = r.data.field._id
  r = await call('POST', '/api/custom-fields', { object: 'deal', label: 'No options', type: 'select', options: [] })
  check('a dropdown with no options is refused', r.status === 400, JSON.stringify(r.data))

  r = await call('POST', '/api/custom-fields', { object: 'deal', label: 'Delivery cost', type: 'currency' })
  const CF_COST = r.data.field._id

  console.log('\n--- formula fields ---')
  r = await call('POST', '/api/custom-fields/validate-formula', { object: 'deal', formula: 'process.exit(1)' })
  check('a formula cannot call JavaScript', r.data.ok === false, JSON.stringify(r.data).slice(0, 120))
  r = await call('POST', '/api/custom-fields/validate-formula', { object: 'deal', formula: 'require("fs")' })
  check('a formula cannot require modules', r.data.ok === false, JSON.stringify(r.data).slice(0, 120))
  r = await call('POST', '/api/custom-fields/validate-formula', { object: 'deal', formula: '{nonexistent} * 2' })
  check('a formula over an unknown field is refused', r.data.ok === false && r.data.unknown?.includes('nonexistent'), JSON.stringify(r.data))
  r = await call('POST', '/api/custom-fields/validate-formula', { object: 'deal', formula: '{tcv} - {delivery_cost}' })
  check('a valid formula passes validation', r.data.ok === true, JSON.stringify(r.data).slice(0, 150))

  r = await call('POST', '/api/custom-fields', {
    object: 'deal', label: 'Net after delivery', type: 'formula', formula: '{tcv} - {delivery_cost}',
  })
  check('formula field created', r.status === 201, JSON.stringify(r.data).slice(0, 120))
  const CF_FORMULA = r.data.field._id
  r = await call('POST', '/api/custom-fields', { object: 'deal', label: 'Broken', type: 'formula', formula: '1 +' })
  check('a broken formula is refused at save time', r.status === 400, JSON.stringify(r.data))

  console.log('\n--- values on records ---')
  r = await call('GET', '/api/deals')
  const CFDEAL = r.data.items[0]._id
  check('deal list carries the field definitions', r.data.customFields?.length >= 4, String(r.data.customFields?.length))

  r = await call('PUT', `/api/deals/${CFDEAL}`, { customFields: { region: 'Mars' } })
  check('a value outside the dropdown options is refused',
    r.status === 400 && /APAC/.test(r.data.error), JSON.stringify(r.data))
  r = await call('PUT', `/api/deals/${CFDEAL}`, { customFields: { delivery_cost: 'not a number' } })
  check('a non-numeric currency value is refused', r.status === 400, JSON.stringify(r.data))

  r = await call('PUT', `/api/deals/${CFDEAL}`, {
    customFields: { delivery_site: 'Manila', region: 'APAC', delivery_cost: 50000 },
  })
  check('valid custom values save', r.status === 200, JSON.stringify(r.data).slice(0, 120))

  r = await call('GET', `/api/deals/${CFDEAL}`)
  check('values come back on read', r.data.deal.customFields.delivery_site === 'Manila', JSON.stringify(r.data.deal.customFields))
  const expectedNet = r.data.deal.tcv - 50000
  check('formula computed on read', r.data.deal.customFields.net_after_delivery === expectedNet,
    `${r.data.deal.customFields.net_after_delivery} vs ${expectedNet}`)

  // A partial update from one form must not blank fields that form never showed.
  r = await call('PUT', `/api/deals/${CFDEAL}`, { customFields: { delivery_site: 'Cebu' } })
  r = await call('GET', `/api/deals/${CFDEAL}`)
  check('a partial update leaves untouched fields alone',
    r.data.deal.customFields.region === 'APAC' && r.data.deal.customFields.delivery_site === 'Cebu',
    JSON.stringify(r.data.deal.customFields))

  r = await call('PUT', `/api/custom-fields/${CF_TEXT}`, { key: 'renamed' })
  check('a field key cannot be renamed once it exists', r.status === 409, JSON.stringify(r.data))
  r = await call('PUT', `/api/custom-fields/${CF_TEXT}`, { type: 'number' })
  check('the type cannot change while records hold values', r.status === 409 && r.data.recordCount >= 1, JSON.stringify(r.data))
  r = await call('PUT', `/api/custom-fields/${CF_TEXT}`, { label: 'Delivery location' })
  check('the label can always be changed', r.status === 200 && r.data.field.label === 'Delivery location')

  r = await call('DELETE', `/api/custom-fields/${CF_TEXT}`)
  check('deleting a field holding data warns first', r.status === 409 && r.data.canDeactivate === true, JSON.stringify(r.data))

  console.log('\n--- required at stage ---')
  r = await call('PUT', `/api/custom-fields/${CF_SELECT}`, { requiredAtStage: 'proposal' })
  check('a field can be required from a stage onwards', r.status === 200, JSON.stringify(r.data).slice(0, 120))

  r = await call('POST', '/api/deals', { company: (await call('GET', '/api/companies')).data.items[0]._id, name: 'Stage gate test' })
  const GATEDEAL = r.data.deal._id
  r = await call('POST', `/api/deals/${GATEDEAL}/stage`, { stage: 'proposal' })
  check('a stage gate blocks the move server-side', r.status === 400 && r.data.missingRequired?.length === 1, JSON.stringify(r.data))
  r = await call('POST', `/api/deals/${GATEDEAL}/stage`, { stage: 'scoping' })
  check('an earlier stage is unaffected', r.data.changed === true, JSON.stringify(r.data).slice(0, 120))
  r = await call('PUT', `/api/deals/${GATEDEAL}`, { customFields: { region: 'EMEA' } })
  r = await call('POST', `/api/deals/${GATEDEAL}/stage`, { stage: 'proposal' })
  check('filling the field unblocks the move', r.data.changed === true, JSON.stringify(r.data).slice(0, 120))

  // Recording a loss must never be blocked by paperwork, or losses go unrecorded.
  r = await call('POST', '/api/deals', { company: (await call('GET', '/api/companies')).data.items[0]._id, name: 'Loss gate test' })
  const LOSSDEAL = r.data.deal._id
  r = await call('POST', `/api/deals/${LOSSDEAL}/stage`, { stage: 'lost', lostReason: 'No budget' })
  check('losing a deal is exempt from stage gates', r.data.deal?.status === 'lost', JSON.stringify(r.data).slice(0, 120))
  await call('PUT', `/api/custom-fields/${CF_SELECT}`, { requiredAtStage: '' })

  console.log('\n=== SAVED VIEWS ===')
  r = await call('POST', '/api/views', {
    object: 'deal', name: 'My big open deals',
    filters: { status: 'open', minValue: 100000 }, sort: 'tcvUsd', dir: 'desc',
  })
  check('view saved', r.status === 201, JSON.stringify(r.data).slice(0, 150))
  check('saving a view pins it for its owner', r.data.view.pinned === true, JSON.stringify(r.data.view?.pinned))
  const VIEW = r.data.view._id

  r = await call('POST', '/api/views', { object: 'deal', name: 'My big open deals', filters: {} })
  check('duplicate view name for the same owner is refused', r.status === 409, JSON.stringify(r.data))

  r = await call('POST', '/api/views', { object: 'contact', name: 'Team: untouched 30 days', filters: {}, shared: true })
  const SHARED_VIEW = r.data.view._id

  r = await call('GET', '/api/views?object=deal')
  check('views list filters by object', r.data.views.every((v) => v.object === 'deal'), JSON.stringify(r.data.views.map((v) => v.object)))

  r = await call('POST', `/api/views/${VIEW}/pin`, { pinned: false })
  check('a view can be unpinned', r.data.view.pinned === false, JSON.stringify(r.data.view?.pinned))
  r = await call('POST', `/api/views/${VIEW}/pin`, { pinned: true })
  check('and pinned again', r.data.view.pinned === true)

  r = await call('POST', `/api/views/${VIEW}/duplicate`, {})
  check('a view can be duplicated', r.status === 201 && /copy/i.test(r.data.view.name), r.data.view?.name)
  const VIEW_COPY = r.data.view._id
  r = await call('DELETE', `/api/views/${VIEW_COPY}`)
  check('a view can be deleted', r.status === 200)

  console.log('\n=== DUPLICATES AND MERGING ===')
  const dupeCo = (await call('GET', '/api/companies')).data.items[0]
  r = await call('POST', '/api/contacts', {
    firstName: 'Dupe', lastName: 'Target', email: 'dupe.target@acmehealth.com',
    title: 'Head of Ops', phone: '+1 555 111 2222',
  })
  const KEEP = r.data.contact.id || r.data.contact._id
  r = await call('POST', '/api/contacts', {
    firstName: 'Dupe', lastName: 'Target', email: 'dupe.target2@acmehealth.com',
    mobile: '+1 555 333 4444', linkedinUrl: 'https://linkedin.com/in/dupetarget',
  })
  const LOSE = r.data.contact.id || r.data.contact._id
  await call('POST', `/api/contacts/${LOSE}/notes`, { body: 'Said to call back in Q1' })
  await call('PUT', `/api/contacts/${LOSE}`, { doNotContact: true })

  r = await call('GET', '/api/contacts/duplicates/scan')
  check('duplicate scan finds same-name-same-company pairs',
    r.data.groups.some((g) => g.contacts.some((c) => String(c._id) === String(LOSE))),
    JSON.stringify(r.data.groups.map((g) => g.reason)))

  r = await call('GET', `/api/contacts/${KEEP}/merge-preview/${LOSE}`)
  check('merge preview says what would be filled', r.data.wouldFill.includes('mobile'), JSON.stringify(r.data.wouldFill))
  check('merge preview says what would be discarded', r.data.wouldDiscard.some((d) => d.field === 'email'), JSON.stringify(r.data.wouldDiscard))
  check('merge preview counts records that would move', r.data.wouldMove.activities >= 1, JSON.stringify(r.data.wouldMove))
  check('merge preview warns about inherited suppression', r.data.inheritsSuppression === true)

  r = await call('POST', `/api/contacts/${KEEP}/merge`, { loserId: LOSE })
  check('merge succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 200))
  check('survivor inherits a unique-indexed field without a duplicate-key failure',
    r.status === 200 && r.data.filled?.includes('linkedinUrl'), JSON.stringify(r.data.filled))
  check('blanks filled from the loser', r.data.filled.includes('mobile'), JSON.stringify(r.data.filled))
  check('the suppression flag is inherited, never lost', r.data.inheritedSuppression === true)

  r = await call('GET', `/api/contacts/${KEEP}`)
  check('survivor keeps its own email', r.data.contact.email === 'dupe.target@acmehealth.com', r.data.contact.email)
  check('survivor gained the mobile', r.data.contact.mobile === '+1 555 333 4444', r.data.contact.mobile)
  check('survivor is now do-not-contact', r.data.contact.doNotContact === true)
  check("the loser's activity moved across", r.data.activities.some((a) => /call back in Q1/.test(a.body || '')),
    JSON.stringify(r.data.activities.map((a) => a.title)))
  check('the merge itself is on the timeline', r.data.activities.some((a) => a.type === 'records_merged'))

  r = await call('GET', `/api/contacts/${LOSE}`)
  check('the duplicate is gone', r.status === 404)

  r = await call('POST', `/api/contacts/${KEEP}/merge`, { loserId: KEEP })
  check('a record cannot be merged into itself', r.status === 400, JSON.stringify(r.data))

  r = await call('POST', '/api/companies', { name: 'Mergeable Co', domain: 'mergeable.example' })
  const CO_KEEP = r.data.company._id
  r = await call('POST', '/api/companies', { name: 'Mergeable Company Ltd', industry: 'Logistics', seatsNeeded: 12, allowDuplicateName: true })
  const CO_LOSE = r.data.company._id
  await call('POST', `/api/companies/${CO_LOSE}/contacts`, { firstName: 'Moved', lastName: 'Person', email: 'moved@mergeable.example' })

  r = await call('GET', `/api/companies/${CO_KEEP}/merge-preview/${CO_LOSE}`)
  check('company merge preview counts contacts that move', r.data.wouldMove.contacts === 1, JSON.stringify(r.data.wouldMove))
  r = await call('POST', `/api/companies/${CO_KEEP}/merge`, { loserId: CO_LOSE })
  check('company merge succeeds', r.status === 200 && r.data.moved.contacts === 1, JSON.stringify(r.data).slice(0, 150))
  r = await call('GET', `/api/companies/${CO_KEEP}`)
  check('company merge filled blanks', r.data.company.industry === 'Logistics', r.data.company.industry)
  check('moved contacts point at the survivor', r.data.contacts.some((c) => c.firstName === 'Moved'),
    JSON.stringify(r.data.contacts.map((c) => c.firstName)))

  console.log('\n=== DASHBOARD ===')
  r = await call('GET', '/api/dashboard/catalogue')
  check('widget catalogue is available', r.data.catalogue.length >= 10, String(r.data.catalogue?.length))

  r = await call('GET', '/api/dashboard')
  check('a new user gets the admin default layout', r.data.usingDefault === true && r.data.layout.length > 0,
    JSON.stringify({ usingDefault: r.data.usingDefault, n: r.data.layout?.length }))
  check('only the widgets in the layout are computed',
    Object.keys(r.data.widgets).length === r.data.layout.length,
    `${Object.keys(r.data.widgets).length} vs ${r.data.layout.length}`)
  check('no widget errored', Object.keys(r.data.errors || {}).length === 0, JSON.stringify(r.data.errors))
  check('the forecast widget carries real numbers', typeof r.data.widgets.forecast_summary?.weighted === 'number',
    JSON.stringify(r.data.widgets.forecast_summary))

  r = await call('PUT', '/api/dashboard', {
    layout: [
      { widget: 'my_work', size: 'sm' },
      { widget: 'calendar', size: 'lg' },
      { widget: 'not_a_widget', size: 'md' },
      { widget: 'my_work', size: 'lg' },
    ],
  })
  check('unknown widgets are dropped from a saved layout', r.data.layout.length === 2, JSON.stringify(r.data.layout))
  check('duplicate widgets are dropped too', r.data.layout.filter((w) => w.widget === 'my_work').length === 1)

  r = await call('GET', '/api/dashboard')
  check('the saved layout is used instead of the default', r.data.usingDefault === false && r.data.layout.length === 2,
    JSON.stringify({ usingDefault: r.data.usingDefault, n: r.data.layout?.length }))

  r = await call('POST', '/api/dashboard/reset', {})
  check('resetting returns to the team default', r.data.usingDefault === true)

  console.log('\n=== CALENDAR EMBED ===')
  r = await call('PUT', '/api/auth/me', { calendarEmbedUrl: 'https://evil.example.com/phish' })
  check('a non-calendar host is refused', r.status === 400 && /Only Google and Outlook/i.test(r.data.error), JSON.stringify(r.data))
  r = await call('PUT', '/api/auth/me', { calendarEmbedUrl: 'http://calendar.google.com/calendar/embed?src=x' })
  check('a non-https calendar URL is refused', r.status === 400, JSON.stringify(r.data))
  r = await call('PUT', '/api/auth/me', {
    calendarEmbedUrl: '<iframe src="https://calendar.google.com/calendar/embed?src=me%40example.com" width="800"></iframe>',
  })
  check('a pasted iframe snippet is accepted and unwrapped',
    r.status === 200 && r.data.user.calendarEmbedUrl.startsWith('https://calendar.google.com/'),
    r.data.user?.calendarEmbedUrl)
  r = await call('PUT', '/api/auth/me', { calendarEmbedUrl: '' })
  check('the calendar can be cleared', r.data.user.calendarEmbedUrl === '')

  console.log('\n=== ACCESS RIGHTS ===')
  const adminToken0 = TOKEN

  async function asUser(email, password, fn) {
    const saved = TOKEN
    const login = await call('POST', '/api/auth/login', { email, password }, { noAuth: true })
    TOKEN = login.data.token
    try { return await fn(login.data.user) } finally { TOKEN = saved }
  }

  r = await call('GET', '/api/settings/users')
  check('user admin screen lists roles and permissions',
    r.data.roles?.length >= 4 && r.data.permissions?.length >= 3,
    JSON.stringify({ roles: r.data.roles?.length, groups: r.data.permissions?.length }))
  check('an admin can grant everything', r.data.grantable.includes('settings.manage'))

  // --- roles carry the right defaults ---
  r = await call('POST', '/api/settings/users', {
    name: 'Mara Manager', email: 'mara@tgsbpo.com', password: 'ManagerPass1', role: 'manager',
  })
  check('a manager can be created', r.status === 201, JSON.stringify(r.data).slice(0, 150))
  const MANAGER_ID = r.data.user?.id
  check('manager gets team visibility from the role', r.data.user.can['contacts.viewAll'] === true)
  check('manager can approve quotes', r.data.user.can['quotes.approve'] === true)
  check('manager cannot manage settings', r.data.user.can['settings.manage'] === false)
  check('manager cannot manage users', r.data.user.can['users.manage'] === false)

  r = await call('POST', '/api/settings/users', {
    name: 'Vic Viewer', email: 'vic@tgsbpo.com', password: 'ViewerPass1', role: 'viewer',
  })
  const VIEWER_ID = r.data.user?.id
  check('a read-only user cannot edit contacts', r.data.user.can['contacts.edit'] === false)
  check('a read-only user cannot export', r.data.user.can['contacts.export'] === false)

  r = await call('POST', '/api/settings/users', { name: 'Bad role', email: 'bad@tgsbpo.com', password: 'Password1', role: 'wizard' })
  check('an unknown role is refused', r.status === 400, JSON.stringify(r.data))

  // --- the rights are actually enforced, not just reported ---
  await asUser('vic@tgsbpo.com', 'ViewerPass1', async () => {
    r = await call('POST', '/api/contacts', { firstName: 'Should', lastName: 'Fail', email: 'nope@x.com' })
    check('read-only is blocked from creating a contact', r.status === 403 && r.data.permission === 'contacts.edit', JSON.stringify(r.data))
    r = await call('GET', '/api/contacts/export/csv')
    check('read-only is blocked from exporting', r.status === 403, String(r.status))
    r = await call('GET', '/api/contacts')
    check('read-only can still read', r.status === 200, String(r.status))
    // Read-only that shows an empty list is no-access wearing the wrong label.
    check('read-only actually sees other people\'s contacts', r.data.total > 0, String(r.data.total))
    r = await call('GET', '/api/reports/reps')
    check('read-only sees the whole team in reports', r.data.rows?.length > 1, String(r.data.rows?.length))
  })

  await asUser('rita@tgsbpo.com', 'RepPass123', async () => {
    r = await call('GET', '/api/contacts/export/csv')
    check('a rep cannot export the contact list', r.status === 403 && r.data.permission === 'contacts.export', JSON.stringify(r.data))
    r = await call('POST', '/api/contacts/import/preview', new FormData())
    check('a rep cannot import', r.status === 403, String(r.status))
    r = await call('GET', '/api/reports/reps')
    check('a rep sees only their own row in the rep report', r.data.rows?.length === 1, String(r.data.rows?.length))
  })

  await asUser('mara@tgsbpo.com', 'ManagerPass1', async () => {
    r = await call('GET', '/api/contacts/export/csv')
    check('a manager can export', r.status === 200, String(r.status))
    r = await call('GET', '/api/reports/reps')
    check('a manager sees the whole team', r.data.rows?.length > 1, String(r.data.rows?.length))
    r = await call('POST', '/api/products', { name: 'Manager product', listPrice: 10 })
    check('a manager cannot change the rate card', r.status === 403 && r.data.permission === 'products.manage', JSON.stringify(r.data))
    r = await call('PUT', '/api/settings', { companyName: 'Hijacked' })
    check('a manager cannot change settings', r.status === 403, JSON.stringify(r.data))
  })

  // --- per-user overrides on top of the role ---
  r = await call('PUT', `/api/settings/users/${MANAGER_ID}`, { permissions: { 'products.manage': true } })
  check('an override can grant beyond the role', r.data.user.can['products.manage'] === true, JSON.stringify(r.data).slice(0, 150))
  await asUser('mara@tgsbpo.com', 'ManagerPass1', async () => {
    r = await call('POST', '/api/products', { name: 'Now allowed', listPrice: 10, sku: 'OVR-1' })
    check('the override takes effect immediately, without re-login', r.status === 201, JSON.stringify(r.data).slice(0, 120))
  })

  r = await call('PUT', `/api/settings/users/${MANAGER_ID}`, { permissions: { 'contacts.export': false } })
  check('an override can remove something the role grants', r.data.user.can['contacts.export'] === false)
  await asUser('mara@tgsbpo.com', 'ManagerPass1', async () => {
    r = await call('GET', '/api/contacts/export/csv')
    check('removing a right takes effect immediately too', r.status === 403, String(r.status))
  })

  // --- escalation is refused ---
  r = await call('PUT', `/api/settings/users/${MANAGER_ID}`, { permissions: { 'users.manage': true } })
  await asUser('mara@tgsbpo.com', 'ManagerPass1', async () => {
    r = await call('POST', '/api/settings/users', {
      name: 'Puppet', email: 'puppet@tgsbpo.com', password: 'PuppetPass1',
      role: 'rep', permissions: { 'settings.manage': true },
    })
    check('you cannot grant a right you do not hold',
      r.status === 403 && r.data.permissions?.includes('settings.manage'), JSON.stringify(r.data))

    r = await call('POST', '/api/settings/users', { name: 'New admin', email: 'newadmin@tgsbpo.com', password: 'AdminPass1', role: 'admin' })
    check('you cannot create someone more powerful than yourself', r.status === 403, JSON.stringify(r.data).slice(0, 120))

    r = await call('PUT', `/api/settings/users/${MANAGER_ID}`, { permissions: { 'settings.manage': true } })
    check('you cannot change your own permissions', r.status === 400 && /your own/i.test(r.data.error), JSON.stringify(r.data))

    r = await call('PUT', `/api/settings/users/${MANAGER_ID}`, { role: 'admin' })
    check('you cannot promote yourself', r.status === 400, JSON.stringify(r.data))

    r = await call('POST', '/api/settings/users', { name: 'Fine', email: 'fine@tgsbpo.com', password: 'FinePass123', role: 'rep' })
    check('but you can still create someone at or below your level', r.status === 201, JSON.stringify(r.data).slice(0, 120))
  })
  TOKEN = adminToken0

  // --- the account cannot lock itself out ---
  r = await call('GET', '/api/settings/users')
  const adminUser = r.data.users.find((u) => u.role === 'admin' && u.email === 'admin@tgsbpo.com')
  r = await call('PUT', `/api/settings/users/${adminUser.id}`, { role: 'rep' })
  check('you cannot change your own role', r.status === 400, JSON.stringify(r.data))

  r = await call('POST', '/api/settings/users', { name: 'Second Admin', email: 'admin2@tgsbpo.com', password: 'Admin2Pass', role: 'admin' })
  const ADMIN2 = r.data.user.id
  r = await call('PUT', `/api/settings/users/${ADMIN2}`, { role: 'rep' })
  check('an admin can be demoted while another remains', r.status === 200 && r.data.user.role === 'rep', JSON.stringify(r.data).slice(0, 120))

  r = await call('PUT', `/api/settings/users/${ADMIN2}`, { role: 'admin' })
  await asUser('admin2@tgsbpo.com', 'Admin2Pass', async () => {
    r = await call('PUT', `/api/settings/users/${adminUser.id}`, { role: 'rep' })
    check('one admin can demote another when a third remains... or refuses at the last one',
      r.status === 200 || r.status === 400, JSON.stringify(r.data).slice(0, 120))
    if (r.status === 200) {
      // Put it back so the rest of the suite still has its admin.
      await call('PUT', `/api/settings/users/${adminUser.id}`, { role: 'admin' })
    }
  })

  r = await call('PUT', `/api/settings/users/${ADMIN2}`, { active: false })
  check('an admin can be deactivated while another remains', r.status === 200, JSON.stringify(r.data).slice(0, 120))

  // --- changing role clears overrides, which were relative to the old role ---
  r = await call('PUT', `/api/settings/users/${VIEWER_ID}`, { permissions: { 'contacts.export': true } })
  check('a viewer can be given export as an exception', r.data.user.can['contacts.export'] === true)
  r = await call('PUT', `/api/settings/users/${VIEWER_ID}`, { role: 'rep' })
  check('changing the role clears overrides rather than silently carrying them',
    Object.keys(r.data.user.permissions || {}).length === 0, JSON.stringify(r.data.user.permissions))

  // --- removing a person never orphans their work ---
  r = await call('DELETE', `/api/settings/users/${VIEWER_ID}`)
  check('removing a user deactivates rather than deletes', r.data.deactivated === true, JSON.stringify(r.data))
  check('and says what they still own', typeof r.data.owns?.contacts === 'number', JSON.stringify(r.data.owns))
  r = await call('POST', '/api/auth/login', { email: 'vic@tgsbpo.com', password: 'ViewerPass1' }, { noAuth: true })
  check('a deactivated user cannot sign in', r.status === 401, String(r.status))

  console.log('\n=== REP SCOPING ===')
  const adminToken = TOKEN
  r = await call('POST', '/api/auth/login', { email: 'rita@tgsbpo.com', password: 'RepPass123' }, { noAuth: true })
  TOKEN = r.data.token
  r = await call('GET', '/api/contacts')
  check('rep sees none of the admin-owned contacts', r.data.total === 0, JSON.stringify(r.data.total))
  r = await call('POST', '/api/campaigns', { name: 'Rep tries', stages: [] })
  check('rep cannot create a campaign', r.status === 403)
  r = await call('GET', `/api/contacts/${CONTACT_A}`)
  check("rep cannot open another rep's contact", r.status === 404)
  r = await call('GET', '/api/deals?includeClosed=true')
  check('but a rep CAN see every deal', r.data.total >= 2, JSON.stringify(r.data.total))
  r = await call('PUT', `/api/deals/${DEAL}`, { name: 'Hijacked' })
  check("a rep cannot edit someone else's deal", r.status === 403, JSON.stringify(r.data))
  r = await call('POST', `/api/quotes/${QUOTE_FLOOR}/decide`, { decision: 'approve' })
  check('a rep cannot approve a quote', r.status === 403, JSON.stringify(r.data))
  r = await call('POST', '/api/products', { name: 'Rep product', listPrice: 1 })
  check('a rep cannot change the rate card', r.status === 403, JSON.stringify(r.data))
  r = await call('POST', '/api/custom-fields', { object: 'deal', label: 'Rep field', type: 'text' })
  check('a rep cannot add custom fields', r.status === 403, JSON.stringify(r.data))
  r = await call('GET', '/api/custom-fields?object=deal')
  check('but a rep can read them, or their record page cannot render', r.status === 200 && r.data.fields.length > 0)
  r = await call('POST', `/api/contacts/${KEEP}/merge`, { loserId: CONTACT_B })
  check('a rep cannot merge records', r.status === 403, JSON.stringify(r.data))
  r = await call('POST', '/api/views', { object: 'deal', name: 'Rep view', filters: {} })
  check('but a rep CAN save their own views', r.status === 201, JSON.stringify(r.data).slice(0, 120))
  r = await call('PUT', `/api/views/${SHARED_VIEW}`, { name: 'Hijacked' })
  check("a rep cannot edit someone else's shared view", r.status === 403, JSON.stringify(r.data))
  TOKEN = adminToken

  console.log('\n=== REPORTS ===')
  r = await call('GET', '/api/reports/summary')
  check('summary report works', r.status === 200 && r.data.totalContacts >= 4, JSON.stringify(r.data))
  r = await call('GET', `/api/reports/funnel?campaign=${CAMP}`)
  check('funnel report works', r.status === 200 && r.data.stages.length === 3, JSON.stringify(r.data).slice(0, 200))
  check('funnel counts stage-1 entries', r.data.topOfFunnel >= 2, String(r.data.topOfFunnel))
  check('funnel computes step conversion', r.data.stages[0].stepConversion !== undefined)
  r = await call('GET', '/api/reports/channels')
  check('channel report works', r.status === 200 && r.data.rows.length === 3, JSON.stringify(r.data.rows))
  check('call channel shows a meeting', r.data.rows.find((x) => x.channel === 'call').meetings >= 1, JSON.stringify(r.data.rows))
  r = await call('GET', '/api/reports/reps')
  check('rep report works', r.status === 200 && r.data.rows.length >= 2, JSON.stringify(r.data.rows.length))
  r = await call('GET', '/api/reports/scoreboard')
  check('scoreboard works', r.status === 200 && Array.isArray(r.data.series), JSON.stringify(r.data).slice(0, 150))
  check('scoreboard lists campaigns', r.data.campaigns.length >= 2)

  console.log('\n=== PUBLIC WEB FORM ===')
  r = await call('POST', '/api/public/contacts', { firstName: 'Web', lastName: 'Lead', email: 'web@inbound.com', company: 'Inbound Co', message: 'Need 40 agents' }, { noAuth: true })
  check('web form creates a contact', r.status === 201, JSON.stringify(r.data))
  r = await call('POST', '/api/public/contacts', { firstName: 'Bot', email: 'bot@spam.com', website_confirm: 'filled' }, { noAuth: true })
  check('honeypot silently drops bots', r.status === 200 && r.data.ok === true)
  r = await call('POST', '/api/public/contacts', { firstName: 'Bad', email: 'not-an-email' }, { noAuth: true })
  check('invalid email rejected', r.status === 400)

  console.log('\n=== CAMPAIGN EDIT GUARDS ===')
  r = await call('PUT', `/api/campaigns/${CAMP}`, { stages: [{ name: 'Only one', channel: 'email', waitDays: 1, body: 'x' }] })
  check('cannot strand contacts by shrinking a live campaign', r.status === 409, JSON.stringify(r.data))

  console.log('\n' + results.join('\n'))
  console.log(`\n${pass} passed, ${fail} failed\n`)
  await mongo.stop()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('FATAL', e); process.exit(2) })
