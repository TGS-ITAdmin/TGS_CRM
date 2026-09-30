const express = require('express')
const {
  Deal, Quote, Task, OutboxMessage, Contact, Activity, User, Settings,
} = require('../db')
const { requireAuth, requirePermission, assignedScope } = require('../middleware/auth')
const { getSettings } = require('../lib/money')
const { stageList } = require('../lib/deals')
const { startOfDay } = require('../lib/time')

const router = express.Router()
router.use(requireAuth)

/* Per-user dashboards.
 *
 * Only the widgets in a user's layout are computed. A library of twelve
 * widgets where every page load runs all twelve is how a dashboard becomes
 * the slowest screen in the product.
 */

const CATALOGUE = [
  { key: 'my_work', name: 'My work', description: 'Overdue, due today, drafts awaiting approval, done today', defaultSize: 'md' },
  { key: 'forecast_summary', name: 'Forecast', description: 'Commit, best case and weighted for the next three months', defaultSize: 'md' },
  { key: 'pipeline_by_stage', name: 'Pipeline by stage', description: 'Open value and weighted value in each stage', defaultSize: 'lg' },
  { key: 'my_deals', name: 'My deals', description: 'Your open deals, closing soonest first', defaultSize: 'md' },
  { key: 'stale_deals', name: 'Going quiet', description: 'Open deals with no activity for two weeks or more', defaultSize: 'md' },
  { key: 'quotes_pending', name: 'Quotes', description: 'Waiting on an approver, and waiting on a client', defaultSize: 'md' },
  { key: 'recent_wins', name: 'Recent wins', description: 'Deals closed won in the last 30 days', defaultSize: 'md' },
  { key: 'channel_performance', name: 'Channel performance', description: 'LinkedIn, email and calls compared', defaultSize: 'md' },
  { key: 'leaderboard', name: 'Team leaderboard', description: 'Meetings booked and deals won per rep', defaultSize: 'md' },
  { key: 'activity_trend', name: 'Activity trend', description: 'Touches logged each week', defaultSize: 'lg' },
  { key: 'my_contacts', name: 'Neglected contacts', description: 'Your contacts with no activity for a month', defaultSize: 'md' },
  { key: 'calendar', name: 'My calendar', description: 'Your Google or Outlook calendar, embedded read-only', defaultSize: 'lg' },
]

const CATALOGUE_KEYS = new Set(CATALOGUE.map((c) => c.key))
const SIZES = ['sm', 'md', 'lg']

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/* Each builder gets the same context and returns whatever its widget needs. */
const BUILDERS = {
  async my_work({ req }) {
    const tz = req.user.timezone || 'UTC'
    const dayStart = startOfDay(tz)
    const scope = assignedScope(req)
    const [overdue, dueToday, drafts, doneToday, quotesPending] = await Promise.all([
      Task.countDocuments({ ...scope, status: 'pending', dueAt: { $lt: dayStart } }),
      Task.countDocuments({ ...scope, status: 'pending', dueAt: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 86400000) } }),
      OutboxMessage.countDocuments({ ...scope, status: 'queued' }),
      Task.countDocuments({ ...scope, status: 'done', completedAt: { $gte: dayStart } }),
      req.can('quotes.approve')
        ? Quote.countDocuments({ status: 'pending_approval' })
        : Quote.countDocuments({ status: 'pending_approval', owner: req.user._id }),
    ])
    return { overdue, dueToday, drafts, doneToday, quotesPending }
  },

  async forecast_summary({ settings }) {
    const start = new Date()
    start.setDate(1)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setMonth(end.getMonth() + 3)

    const deals = await Deal.find({ status: 'open', expectedCloseDate: { $gte: start, $lt: end } })
      .select('tcvUsd probability forecastCategory').lean()
    const won = await Deal.aggregate([
      { $match: { status: 'won', wonAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$tcvUsd' }, n: { $sum: 1 } } },
    ])

    let commit = 0, bestCase = 0, weighted = 0, pipeline = 0
    for (const d of deals) {
      if (d.forecastCategory === 'commit') commit += d.tcvUsd || 0
      else if (d.forecastCategory === 'best_case') bestCase += d.tcvUsd || 0
      else if (d.forecastCategory !== 'omitted') pipeline += d.tcvUsd || 0
      if (d.forecastCategory !== 'omitted') weighted += (d.tcvUsd || 0) * ((d.probability || 0) / 100)
    }
    const undated = await Deal.countDocuments({ status: 'open', expectedCloseDate: null })
    /* The window runs in whole calendar months, which is how a forecast period
       works — but "next 3 months" then reads as "from today" and a deal just
       past the edge looks like a bug. Name the window instead. */
    const beyond = await Deal.countDocuments({ status: 'open', expectedCloseDate: { $gte: end } })

    return {
      currency: settings.reportingCurrency || 'USD',
      months: 3, count: deals.length, undated, beyond,
      windowStart: start, windowEnd: end,
      commit: r2(commit), bestCase: r2(bestCase), weighted: r2(weighted), pipeline: r2(pipeline),
      won: r2(won[0]?.total), wonCount: won[0]?.n || 0,
    }
  },

  async pipeline_by_stage({ settings }) {
    const stages = stageList(settings).filter((s) => s.type === 'open')
    const rows = await Deal.aggregate([
      { $match: { status: 'open' } },
      {
        $group: {
          _id: '$stage', count: { $sum: 1 }, tcvUsd: { $sum: '$tcvUsd' },
          weightedUsd: {
            $sum: {
              $cond: [
                { $ne: ['$forecastCategory', 'omitted'] },
                { $multiply: ['$tcvUsd', { $divide: ['$probability', 100] }] }, 0,
              ],
            },
          },
        },
      },
    ])
    const by = new Map(rows.map((x) => [x._id, x]))
    return {
      currency: settings.reportingCurrency || 'USD',
      stages: stages.map((s) => ({
        key: s.key, name: s.name, color: s.color, probability: s.probability,
        count: by.get(s.key)?.count || 0,
        tcvUsd: r2(by.get(s.key)?.tcvUsd),
        weightedUsd: r2(by.get(s.key)?.weightedUsd),
      })),
    }
  },

  async my_deals({ req, settings }) {
    const deals = await Deal.find({ status: 'open', owner: req.user._id })
      .sort({ expectedCloseDate: 1 }).limit(8)
      .populate('company', 'name').lean()
    return {
      currency: settings.reportingCurrency || 'USD',
      deals: deals.map((d) => ({
        _id: d._id, name: d.name, company: d.company?.name, stage: d.stage,
        tcvUsd: d.tcvUsd, probability: d.probability,
        expectedCloseDate: d.expectedCloseDate, forecastCategory: d.forecastCategory,
      })),
      total: await Deal.countDocuments({ status: 'open', owner: req.user._id }),
    }
  },

  async stale_deals({ req, settings }) {
    const cutoff = new Date(Date.now() - 14 * 86400000)
    const filter = { status: 'open', lastActivityAt: { $lt: cutoff } }
    if (!req.can('deals.viewAll')) filter.owner = req.user._id
    const deals = await Deal.find(filter)
      .sort({ lastActivityAt: 1 }).limit(8)
      .populate('company', 'name').populate('owner', 'name').lean()
    return {
      currency: settings.reportingCurrency || 'USD',
      cutoffDays: 14,
      total: await Deal.countDocuments(filter),
      deals: deals.map((d) => ({
        _id: d._id, name: d.name, company: d.company?.name, owner: d.owner?.name,
        tcvUsd: d.tcvUsd, lastActivityAt: d.lastActivityAt, stage: d.stage,
      })),
    }
  },

  async quotes_pending({ req, settings }) {
    const mine = req.can('quotes.approve') ? {} : { owner: req.user._id }
    const [pending, awaitingClient, unopened] = await Promise.all([
      Quote.find({ ...mine, status: 'pending_approval' })
        .sort({ submittedAt: 1 }).limit(5).populate('company', 'name').lean(),
      Quote.countDocuments({ ...mine, status: 'sent' }),
      Quote.countDocuments({ ...mine, status: 'sent', firstViewedAt: null }),
    ])
    return {
      currency: settings.reportingCurrency || 'USD',
      pending: pending.map((q) => ({
        _id: q._id, number: q.number, company: q.company?.name,
        tcv: q.tcv, currency: q.currency, reasons: (q.approvalReasons || []).map((x) => x.label),
      })),
      pendingCount: pending.length,
      awaitingClient,
      unopened,
      canApprove: req.can('quotes.approve'),
    }
  },

  async recent_wins({ settings }) {
    const since = new Date(Date.now() - 30 * 86400000)
    const deals = await Deal.find({ status: 'won', wonAt: { $gte: since } })
      .sort({ wonAt: -1 }).limit(6)
      .populate('company', 'name').populate('owner', 'name').lean()
    const total = await Deal.aggregate([
      { $match: { status: 'won', wonAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$tcvUsd' }, mrr: { $sum: '$mrrUsd' }, n: { $sum: 1 } } },
    ])
    return {
      currency: settings.reportingCurrency || 'USD',
      deals: deals.map((d) => ({
        _id: d._id, name: d.name, company: d.company?.name, owner: d.owner?.name,
        tcvUsd: d.tcvUsd, wonAt: d.wonAt,
      })),
      totalUsd: r2(total[0]?.total), mrrUsd: r2(total[0]?.mrr), count: total[0]?.n || 0,
    }
  },

  async channel_performance() {
    const since = new Date(Date.now() - 30 * 86400000)
    const touches = await Activity.aggregate([
      { $match: { createdAt: { $gte: since }, type: { $in: ['email_sent', 'linkedin_action', 'call_logged'] } } },
      { $group: { _id: '$channel', n: { $sum: 1 }, contacts: { $addToSet: '$contact' } } },
      { $project: { n: 1, reach: { $size: '$contacts' } } },
    ])
    const replies = await Activity.aggregate([
      { $match: { createdAt: { $gte: since }, type: 'reply_logged' } },
      { $group: { _id: '$channel', n: { $sum: 1 } } },
    ])
    const replyBy = new Map(replies.map((x) => [x._id, x.n]))
    const positiveCalls = await Activity.countDocuments({
      createdAt: { $gte: since }, type: 'call_logged',
      outcome: { $in: ['connected', 'callback_requested', 'meeting_booked'] },
    })

    return {
      days: 30,
      rows: ['linkedin', 'email', 'call'].map((channel) => {
        const t = touches.find((x) => x._id === channel) || { n: 0, reach: 0 }
        const responses = channel === 'call' ? positiveCalls : (replyBy.get(channel) || 0)
        return {
          channel, touches: t.n, reach: t.reach, responses,
          rate: t.n ? Math.round((responses / t.n) * 1000) / 10 : null,
        }
      }),
    }
  },

  async leaderboard({ settings }) {
    const since = new Date(Date.now() - 30 * 86400000)
    const [users, meetings, wins] = await Promise.all([
      User.find({ active: true }).select('name').lean(),
      Activity.aggregate([
        {
          $match: {
            createdAt: { $gte: since },
            $or: [{ 'meta.to': 'meeting_booked' }, { outcome: 'meeting_booked' }],
          },
        },
        { $group: { _id: '$user', contacts: { $addToSet: '$contact' } } },
        { $project: { n: { $size: '$contacts' } } },
      ]),
      Deal.aggregate([
        { $match: { status: 'won', wonAt: { $gte: since } } },
        { $group: { _id: '$owner', n: { $sum: 1 }, value: { $sum: '$tcvUsd' } } },
      ]),
    ])
    const meetingBy = new Map(meetings.map((x) => [String(x._id), x.n]))
    const winBy = new Map(wins.map((x) => [String(x._id), x]))

    return {
      days: 30,
      currency: settings.reportingCurrency || 'USD',
      rows: users
        .map((u) => ({
          id: u._id, name: u.name,
          meetings: meetingBy.get(String(u._id)) || 0,
          wins: winBy.get(String(u._id))?.n || 0,
          wonUsd: r2(winBy.get(String(u._id))?.value),
        }))
        .sort((a, b) => b.wonUsd - a.wonUsd || b.meetings - a.meetings)
        .slice(0, 8),
    }
  },

  async activity_trend({ req }) {
    const since = new Date(Date.now() - 70 * 86400000)
    const match = { createdAt: { $gte: since }, type: { $in: ['email_sent', 'linkedin_action', 'call_logged'] } }
    if (!req.can('reports.viewTeam')) match.user = req.user._id

    const rows = await Activity.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateTrunc: { date: '$createdAt', unit: 'week', startOfWeek: 'monday' } },
          n: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    return { weeks: rows.map((x) => ({ bucket: x._id, touches: x.n })) }
  },

  async my_contacts({ req }) {
    const cutoff = new Date(Date.now() - 30 * 86400000)
    const filter = {
      owner: req.user._id,
      doNotContact: false,
      status: { $nin: ['customer', 'dnc'] },
      lastActivityAt: { $lt: cutoff },
    }
    const contacts = await Contact.find(filter)
      .sort({ lastActivityAt: 1 }).limit(8)
      .populate('company', 'name').lean({ virtuals: true })
    return {
      cutoffDays: 30,
      total: await Contact.countDocuments(filter),
      contacts: contacts.map((c) => ({
        _id: c._id, name: [c.firstName, c.lastName].filter(Boolean).join(' '),
        company: c.company?.name, status: c.status, lastActivityAt: c.lastActivityAt,
      })),
    }
  },

  async calendar({ req }) {
    return {
      embedUrl: req.user.calendarEmbedUrl || '',
      timezone: req.user.timezone || '',
    }
  },
}

router.get('/catalogue', async (req, res) => {
  const settings = await getSettings()
  res.json({
    catalogue: CATALOGUE,
    sizes: SIZES,
    defaultLayout: settings.defaultDashboard || [],
  })
})

router.get('/', async (req, res) => {
  /* The dashboard is the landing page for most people, so it degrades rather
     than fails: a settings read that hiccups still renders the widgets, and a
     widget that throws reports itself without blanking the rest. */
  let settings = {}
  try {
    settings = await getSettings()
  } catch (err) {
    console.error('[dashboard] settings unavailable:', err.message)
  }

  const stored = (req.user.dashboard || []).filter((w) => CATALOGUE_KEYS.has(w.widget))
  // An empty layout means "whatever the admin set", so a new joiner gets a
  // usable screen without configuring anything first.
  const layout = stored.length ? stored : (settings.defaultDashboard || []).filter((w) => CATALOGUE_KEYS.has(w.widget))

  const widgets = {}
  const errors = {}
  await Promise.all(layout.map(async (item) => {
    const build = BUILDERS[item.widget]
    if (!build) return
    try {
      widgets[item.widget] = await build({ req, settings })
    } catch (err) {
      // One broken widget must not blank the whole dashboard.
      console.error(`[dashboard] widget "${item.widget}" failed:`, err.message)
      errors[item.widget] = err.message
    }
  }))

  res.json({
    layout,
    usingDefault: stored.length === 0,
    widgets,
    errors,
    catalogue: CATALOGUE,
  })
})

function sanitizeLayout(layout) {
  if (!Array.isArray(layout)) return null
  const seen = new Set()
  const out = []
  for (const item of layout) {
    const widget = String(item?.widget || '')
    if (!CATALOGUE_KEYS.has(widget) || seen.has(widget)) continue
    seen.add(widget)
    out.push({ widget, size: SIZES.includes(item.size) ? item.size : 'md' })
  }
  return out
}

router.put('/', async (req, res) => {
  const layout = sanitizeLayout(req.body?.layout)
  if (!layout) return res.status(400).json({ error: 'Send a layout array' })
  req.user.dashboard = layout
  await req.user.save()
  res.json({ layout })
})

/* Back to whatever the admin set as the team default. */
router.post('/reset', async (req, res) => {
  req.user.dashboard = []
  await req.user.save()
  const settings = await getSettings()
  res.json({ layout: settings.defaultDashboard || [], usingDefault: true })
})

router.put('/default', requirePermission('settings.manage'), async (req, res) => {
  const layout = sanitizeLayout(req.body?.layout)
  if (!layout) return res.status(400).json({ error: 'Send a layout array' })
  await Settings.updateOne({ key: 'global' }, { $set: { defaultDashboard: layout } })
  res.json({ defaultDashboard: layout })
})

module.exports = router
