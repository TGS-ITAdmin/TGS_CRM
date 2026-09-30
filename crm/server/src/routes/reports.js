const express = require('express')
const mongoose = require('mongoose')
const {
  Activity, Enrollment, Campaign, Contact, Deal, Task, OutboxMessage, User, Settings, CALL_OUTCOMES,
} = require('../db')
const { stageList } = require('../lib/deals')
const { getSettings } = require('../lib/money')
const { requireAuth, ownerScope } = require('../middleware/auth')
const { startOfDay } = require('../lib/time')

const router = express.Router()
router.use(requireAuth)

const oid = (v) => new mongoose.Types.ObjectId(String(v))
const TOUCH_TYPES = ['email_sent', 'linkedin_action', 'call_logged']
const POSITIVE_CALL = new Set(
  CALL_OUTCOMES.filter((o) => o.positive).map((o) => o.value)
)

function range(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date()
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 30 * 86400000)
  to.setHours(23, 59, 59, 999)
  return { from, to }
}

// Reps only ever see their own numbers. Returns null when unrestricted.
async function visibleContactIds(req) {
  if (req.can('reports.viewTeam')) return null
  return Contact.find(ownerScope(req)).distinct('_id')
}

function withContactScope(match, contactIds) {
  return contactIds ? { ...match, contact: { $in: contactIds } } : match
}

/* ==================================================================== */
/* 1. Funnel — how many contacts entered each stage, and what % moved on    */
/* ==================================================================== */
router.get('/funnel', async (req, res) => {
  const campaignId = req.query.campaign
  if (!campaignId) return res.status(400).json({ error: 'Pick a campaign' })

  const campaign = await Campaign.findById(campaignId).lean()
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

  const { from, to } = range(req)
  const contactIds = await visibleContactIds(req)

  const match = { campaign: oid(campaignId), createdAt: { $gte: from, $lte: to } }
  if (contactIds) match.contact = { $in: contactIds }

  /* history holds one entry per stage each enrollment has ever entered, so
   * this measures "reached this stage", not "is sitting here now".
   *
   * Step conversion is a true cohort measure: of the enrollments that reached
   * stage i, how many went on to reach stage i+1. Counting entries at i+1 and
   * dividing would be wrong — a contact moved straight from stage 1 to stage 3
   * would inflate stage 2's conversion and could push it past 100%. */
  const cohort = await Enrollment.aggregate([
    { $match: match },
    { $project: { stages: { $setUnion: ['$history.stageIndex', []] } } },
    {
      $project: {
        pairs: {
          $map: {
            input: '$stages',
            as: 's',
            in: {
              stage: '$$s',
              advanced: { $in: [{ $add: ['$$s', 1] }, '$stages'] },
            },
          },
        },
      },
    },
    { $unwind: '$pairs' },
    {
      $group: {
        _id: '$pairs.stage',
        entered: { $sum: 1 },
        advanced: { $sum: { $cond: ['$pairs.advanced', 1, 0] } },
      },
    },
  ])
  const enteredBy = new Map(cohort.map((e) => [e._id, e.entered]))
  const advancedBy = new Map(cohort.map((e) => [e._id, e.advanced]))

  const current = await Enrollment.aggregate([
    { $match: { ...match, status: 'active' } },
    { $group: { _id: '$currentStageIndex', n: { $sum: 1 } } },
  ])
  const currentBy = new Map(current.map((e) => [e._id, e.n]))

  const totals = await Enrollment.aggregate([
    { $match: match },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ])
  const statusTotals = Object.fromEntries(totals.map((t) => [t._id, t.n]))

  const topOfFunnel = enteredBy.get(0) || 0
  const stages = campaign.stages.map((stage, i) => {
    const n = enteredBy.get(i) || 0
    const advanced = advancedBy.get(i) || 0
    const isLast = i === campaign.stages.length - 1
    return {
      index: i,
      name: stage.name,
      channel: stage.channel,
      waitDays: stage.waitDays,
      entered: n,
      currentlyHere: currentBy.get(i) || 0,
      // Of the enrollments that reached this stage, how many reached the next.
      advancedToNext: advanced,
      stepConversion: isLast || n === 0 ? null : Math.round((advanced / n) * 1000) / 10,
      // Share of everyone who ever started the campaign.
      shareOfStart: topOfFunnel > 0 ? Math.round((n / topOfFunnel) * 1000) / 10 : null,
      dropOff: isLast ? 0 : n - advanced,
      // Contacts that arrived here without passing through the previous stage —
      // moved by hand on the board, or enrolled mid-sequence.
      enteredOutOfSequence: i === 0 ? 0 : Math.max(0, n - (advancedBy.get(i - 1) || 0)),
    }
  })

  // Outcomes for contacts that touched this campaign, by current contact status.
  const enrolledContactIds = await Enrollment.find(match).distinct('contact')
  const byStatus = await Contact.aggregate([
    { $match: { _id: { $in: enrolledContactIds } } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ])
  const settings = await Settings.findOne({ key: 'global' }).lean()
  const labels = new Map((settings?.contactStatuses || []).map((s) => [s.value, s]))

  res.json({
    campaign: { id: campaign._id, name: campaign.name },
    range: { from, to },
    topOfFunnel,
    stages,
    statusTotals,
    outcomes: byStatus.map((s) => ({
      status: s._id,
      label: labels.get(s._id)?.label || s._id,
      color: labels.get(s._id)?.color || '#64748b',
      n: s.n,
    })),
  })
})

/* ==================================================================== */
/* 2. Channel comparison — LinkedIn vs email vs cold call                */
/* ==================================================================== */
router.get('/channels', async (req, res) => {
  const { from, to } = range(req)
  const contactIds = await visibleContactIds(req)
  const campaignFilter = req.query.campaign ? { campaign: oid(req.query.campaign) } : {}

  const baseMatch = withContactScope(
    { createdAt: { $gte: from, $lte: to }, ...campaignFilter },
    contactIds
  )

  const touches = await Activity.aggregate([
    { $match: { ...baseMatch, type: { $in: TOUCH_TYPES } } },
    {
      $group: {
        _id: '$channel',
        touches: { $sum: 1 },
        contacts: { $addToSet: '$contact' },
        positiveCalls: {
          $sum: { $cond: [{ $in: ['$outcome', [...POSITIVE_CALL]] }, 1, 0] },
        },
      },
    },
    { $project: { touches: 1, positiveCalls: 1, contactsTouched: { $size: '$contacts' } } },
  ])

  const replies = await Activity.aggregate([
    { $match: { ...baseMatch, type: 'reply_logged' } },
    { $group: { _id: '$channel', replies: { $sum: 1 }, contacts: { $addToSet: '$contact' } } },
    { $project: { replies: 1, contactsReplied: { $size: '$contacts' } } },
  ])
  const repliesBy = new Map(replies.map((r) => [r._id || '', r]))

  const failures = await Activity.aggregate([
    { $match: { ...baseMatch, type: { $in: ['email_failed', 'email_suppressed'] } } },
    { $group: { _id: '$type', n: { $sum: 1 } } },
  ])

  /* Meetings are attributed last-touch: find every move into meeting_booked,
   * then look at the most recent touch on that contact beforehand. Bounded by
   * the number of meetings, which is always small. */
  const bookings = await Activity.find({
    ...withContactScope({ createdAt: { $gte: from, $lte: to } }, contactIds),
    type: { $in: ['status_change', 'call_logged'] },
    $or: [{ 'meta.to': 'meeting_booked' }, { outcome: 'meeting_booked' }],
  })
    .select('contact createdAt channel outcome')
    .lean()

  const meetingsBy = { linkedin: 0, email: 0, call: 0, unattributed: 0 }
  const seenContact = new Set()
  for (const b of bookings) {
    const key = String(b.contact)
    if (seenContact.has(key)) continue
    seenContact.add(key)
    if (b.outcome === 'meeting_booked' && b.channel) {
      meetingsBy[b.channel] = (meetingsBy[b.channel] || 0) + 1
      continue
    }
    const lastTouch = await Activity.findOne({
      contact: b.contact,
      type: { $in: TOUCH_TYPES },
      createdAt: { $lte: b.createdAt },
    })
      .sort({ createdAt: -1 })
      .select('channel')
      .lean()
    if (lastTouch && lastTouch.channel) meetingsBy[lastTouch.channel] += 1
    else meetingsBy.unattributed += 1
  }

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

  const rows = ['linkedin', 'email', 'call'].map((channel) => {
    const t = touches.find((x) => x._id === channel) || {
      touches: 0, contactsTouched: 0, positiveCalls: 0,
    }
    const r = repliesBy.get(channel) || { replies: 0, contactsReplied: 0 }
    // A cold call has no "reply" — a positive disposition is the equivalent.
    const responses = channel === 'call' ? t.positiveCalls : r.replies
    return {
      channel,
      touches: t.touches,
      contactsTouched: t.contactsTouched,
      responses,
      responseRate: pct(responses, t.touches),
      meetings: meetingsBy[channel] || 0,
      meetingRate: pct(meetingsBy[channel] || 0, t.contactsTouched),
      touchesPerMeeting: meetingsBy[channel] ? Math.round((t.touches / meetingsBy[channel]) * 10) / 10 : null,
    }
  })

  res.json({
    range: { from, to },
    rows,
    unattributedMeetings: meetingsBy.unattributed,
    emailIssues: Object.fromEntries(failures.map((f) => [f._id, f.n])),
    note:
      'Calls count a Connected / Callback / Meeting disposition as a response; LinkedIn and email count a logged reply. Meetings are attributed to the last touch before the booking.',
  })
})

/* ==================================================================== */
/* 3. Rep activity and performance                                       */
/* ==================================================================== */
router.get('/reps', async (req, res) => {
  if (!req.can('reports.viewTeam')) {
    // Without team visibility you still get your own row — a rep should be
    // able to see their own numbers without being able to see everyone's.
    req.query.user = req.user._id.toString()
  }
  const { from, to } = range(req)
  const userFilter = req.query.user ? { user: oid(req.query.user) } : {}

  const users = await User.find(
    req.query.user ? { _id: req.query.user } : { active: true }
  ).select('name email role timezone').lean()

  const activity = await Activity.aggregate([
    { $match: { createdAt: { $gte: from, $lte: to }, type: { $in: TOUCH_TYPES }, ...userFilter } },
    {
      $group: {
        _id: { user: '$user', channel: '$channel' },
        n: { $sum: 1 },
        contacts: { $addToSet: '$contact' },
      },
    },
  ])

  const meetings = await Activity.aggregate([
    {
      $match: {
        createdAt: { $gte: from, $lte: to },
        ...userFilter,
        $or: [{ 'meta.to': 'meeting_booked' }, { outcome: 'meeting_booked' }],
      },
    },
    { $group: { _id: '$user', contacts: { $addToSet: '$contact' } } },
    { $project: { n: { $size: '$contacts' } } },
  ])
  const meetingsBy = new Map(meetings.map((m) => [String(m._id), m.n]))

  // Same definition of overdue as the work queue: due before today began.
  const dayStart = startOfDay(req.user.timezone || 'UTC')
  const [overdue, completed, owned] = await Promise.all([
    Task.aggregate([
      { $match: { status: 'pending', dueAt: { $lt: dayStart } } },
      { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
    ]),
    Task.aggregate([
      { $match: { status: 'done', completedAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$completedBy', n: { $sum: 1 } } },
    ]),
    Contact.aggregate([{ $group: { _id: '$owner', n: { $sum: 1 } } }]),
  ])

  // Won and lost are deal outcomes. Reading them off a contact status would
  // be reading a field that no longer exists.
  const dealOutcomes = await Deal.aggregate([
    {
      $match: {
        status: { $in: ['won', 'lost'] },
        $or: [{ wonAt: { $gte: from, $lte: to } }, { lostAt: { $gte: from, $lte: to } }],
        ...(req.query.user ? { owner: oid(req.query.user) } : {}),
      },
    },
    {
      $group: {
        _id: { owner: '$owner', status: '$status' },
        n: { $sum: 1 },
        tcvUsd: { $sum: '$tcvUsd' },
      },
    },
  ])
  const wonBy = new Map()
  const lostBy = new Map()
  const wonValueBy = new Map()
  for (const r of dealOutcomes) {
    const key = String(r._id.owner)
    if (r._id.status === 'won') {
      wonBy.set(key, r.n)
      wonValueBy.set(key, Math.round(r.tcvUsd * 100) / 100)
    } else lostBy.set(key, r.n)
  }

  const openByOwner = new Map(
    (await Deal.aggregate([
      { $match: { status: 'open' } },
      { $group: { _id: '$owner', n: { $sum: 1 }, tcvUsd: { $sum: '$tcvUsd' } } },
    ])).map((r) => [String(r._id), r])
  )

  const map = (rows, key = '_id') => new Map(rows.map((r) => [String(r[key]), r.n]))
  const overdueBy = map(overdue)
  const completedBy = map(completed)
  const ownedBy = map(owned)

  const rows = users.map((u) => {
    const key = String(u._id)
    const byChannel = { linkedin: 0, email: 0, call: 0 }
    let touched = new Set()
    for (const a of activity) {
      if (String(a._id.user) !== key) continue
      if (a._id.channel in byChannel) byChannel[a._id.channel] = a.n
      for (const l of a.contacts) touched.add(String(l))
    }
    const totalTouches = byChannel.linkedin + byChannel.email + byChannel.call
    const booked = meetingsBy.get(key) || 0
    return {
      user: { id: u._id, name: u.name, email: u.email, role: u.role, timezone: u.timezone },
      touches: totalTouches,
      byChannel,
      contactsTouched: touched.size,
      tasksCompleted: completedBy.get(key) || 0,
      tasksOverdue: overdueBy.get(key) || 0,
      meetingsBooked: booked,
      contactsOwned: ownedBy.get(key) || 0,
      dealsWon: wonBy.get(key) || 0,
      dealsLost: lostBy.get(key) || 0,
      wonValueUsd: wonValueBy.get(key) || 0,
      openDeals: openByOwner.get(key)?.n || 0,
      openPipelineUsd: Math.round((openByOwner.get(key)?.tcvUsd || 0) * 100) / 100,
      winRate: (wonBy.get(key) || 0) + (lostBy.get(key) || 0)
        ? Math.round(((wonBy.get(key) || 0) / ((wonBy.get(key) || 0) + (lostBy.get(key) || 0))) * 1000) / 10
        : null,
      touchesPerMeeting: booked ? Math.round((totalTouches / booked) * 10) / 10 : null,
      conversionRate: touched.size ? Math.round((booked / touched.size) * 1000) / 10 : null,
    }
  })

  rows.sort((a, b) => b.meetingsBooked - a.meetingsBooked || b.touches - a.touches)
  res.json({ range: { from, to }, rows })
})

/* ==================================================================== */
/* 4. Campaign scoreboard over time                                      */
/* ==================================================================== */
router.get('/scoreboard', async (req, res) => {
  const { from, to } = range(req)
  const unit = req.query.unit === 'day' ? 'day' : 'week'
  const contactIds = await visibleContactIds(req)
  const campaignFilter = req.query.campaign ? { campaign: oid(req.query.campaign) } : {}

  const match = withContactScope(
    { createdAt: { $gte: from, $lte: to }, ...campaignFilter },
    contactIds
  )

  const series = await Activity.aggregate([
    {
      $match: {
        ...match,
        type: {
          $in: [...TOUCH_TYPES, 'reply_logged', 'campaign_enrolled', 'status_change'],
        },
      },
    },
    {
      $group: {
        _id: {
          bucket: { $dateTrunc: { date: '$createdAt', unit, startOfWeek: 'monday' } },
          type: '$type',
        },
        n: { $sum: 1 },
        booked: { $sum: { $cond: [{ $eq: ['$meta.to', 'meeting_booked'] }, 1, 0] } },
        won: { $sum: { $cond: [{ $eq: ['$meta.to', 'won'] }, 1, 0] } },
      },
    },
    { $sort: { '_id.bucket': 1 } },
  ])

  const buckets = new Map()
  for (const row of series) {
    const key = row._id.bucket.toISOString()
    const b = buckets.get(key) || {
      bucket: row._id.bucket, added: 0, touches: 0, replies: 0, meetings: 0, won: 0,
    }
    if (row._id.type === 'campaign_enrolled') b.added += row.n
    else if (row._id.type === 'reply_logged') b.replies += row.n
    else if (row._id.type === 'status_change') {
      b.meetings += row.booked
      b.won += row.won
    } else b.touches += row.n
    buckets.set(key, b)
  }

  const perCampaign = await Enrollment.aggregate([
    { $match: withContactScope({ createdAt: { $gte: from, $lte: to } }, contactIds) },
    { $group: { _id: { campaign: '$campaign', status: '$status' }, n: { $sum: 1 } } },
  ])
  const campaigns = await Campaign.find().select('name stages active').lean()
  const campMap = new Map(campaigns.map((c) => [String(c._id), c]))
  const totals = new Map()
  for (const row of perCampaign) {
    const key = String(row._id.campaign)
    const entry = totals.get(key) || {
      id: key,
      name: campMap.get(key)?.name || '(deleted)',
      active: campMap.get(key)?.active ?? false,
      stageCount: campMap.get(key)?.stages?.length || 0,
      enrolled: 0, running: 0, completed: 0, exited: 0,
    }
    entry[row._id.status === 'active' ? 'running' : row._id.status] = row.n
    entry.enrolled += row.n
    totals.set(key, entry)
  }

  const [queued, sentCount] = await Promise.all([
    OutboxMessage.countDocuments({ status: 'queued' }),
    OutboxMessage.countDocuments({ status: 'sent', sentAt: { $gte: from, $lte: to } }),
  ])

  res.json({
    range: { from, to },
    unit,
    series: [...buckets.values()].sort((a, b) => a.bucket - b.bucket),
    campaigns: [...totals.values()].sort((a, b) => b.enrolled - a.enrolled),
    emails: { queued, sent: sentCount },
  })
})

/* ==================================================================== */
/* 5. Pipeline — where the money is, and where deals die                */
/* ==================================================================== */
router.get('/pipeline', async (req, res) => {
  const { from, to } = range(req)
  const settings = await getSettings()
  const stages = stageList(settings)
  const openStages = stages.filter((s) => s.type === 'open')

  const scope = {}
  if (req.query.owner) scope.owner = oid(req.query.owner)

  const [open, closed] = await Promise.all([
    Deal.find({ ...scope, status: 'open' }).select('stage probability tcvUsd mrrUsd stageEnteredAt forecastCategory createdAt').lean(),
    Deal.find({
      ...scope,
      status: { $in: ['won', 'lost'] },
      $or: [{ wonAt: { $gte: from, $lte: to } }, { lostAt: { $gte: from, $lte: to } }],
    }).select('status tcvUsd mrrUsd lostReason createdAt wonAt lostAt stageHistory').lean(),
  ])

  const now = Date.now()
  const byStage = new Map(openStages.map((s) => [s.key, {
    key: s.key, name: s.name, probability: s.probability, color: s.color,
    count: 0, tcvUsd: 0, mrrUsd: 0, weightedUsd: 0, ageDays: [],
  }]))
  for (const d of open) {
    const row = byStage.get(d.stage)
    if (!row) continue
    row.count++
    row.tcvUsd += d.tcvUsd || 0
    row.mrrUsd += d.mrrUsd || 0
    if (d.forecastCategory !== 'omitted') {
      row.weightedUsd += (d.tcvUsd || 0) * ((d.probability || 0) / 100)
    }
    row.ageDays.push(Math.max(0, Math.round((now - new Date(d.stageEnteredAt).getTime()) / 86400000)))
  }

  const stageRows = [...byStage.values()].map((r) => {
    const ages = r.ageDays.sort((a, b) => a - b)
    return {
      key: r.key, name: r.name, probability: r.probability, color: r.color,
      count: r.count,
      tcvUsd: Math.round(r.tcvUsd * 100) / 100,
      mrrUsd: Math.round(r.mrrUsd * 100) / 100,
      weightedUsd: Math.round(r.weightedUsd * 100) / 100,
      avgDealUsd: r.count ? Math.round((r.tcvUsd / r.count) * 100) / 100 : 0,
      // Median, not mean: one deal parked for a year should not make a healthy
      // stage look stale.
      medianAgeDays: ages.length ? ages[Math.floor(ages.length / 2)] : null,
      stalest: ages.length ? ages[ages.length - 1] : null,
    }
  })

  /* Stage conversion, cohort-style from stageHistory: of the deals that ever
   * reached this stage, how many went on to be won. Counting what sits in each
   * stage now would flatter a pipeline that has simply stopped moving. */
  const allDeals = await Deal.find(scope).select('stageHistory status createdAt wonAt lostAt tcvUsd').lean()
  const reached = new Map(openStages.map((s) => [s.key, { reached: 0, won: 0 }]))
  for (const d of allDeals) {
    const seen = new Set((d.stageHistory || []).map((h) => h.stage))
    for (const key of seen) {
      const row = reached.get(key)
      if (!row) continue
      row.reached++
      if (d.status === 'won') row.won++
    }
  }
  const conversion = openStages.map((s) => {
    const r = reached.get(s.key) || { reached: 0, won: 0 }
    return {
      key: s.key, name: s.name, reached: r.reached, won: r.won,
      winRate: r.reached ? Math.round((r.won / r.reached) * 1000) / 10 : null,
    }
  })

  const won = closed.filter((d) => d.status === 'won')
  const lost = closed.filter((d) => d.status === 'lost')
  const cycleDays = won
    .map((d) => Math.round((new Date(d.wonAt) - new Date(d.createdAt)) / 86400000))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)

  const lossReasons = {}
  for (const d of lost) {
    const key = d.lostReason || 'Not recorded'
    lossReasons[key] = (lossReasons[key] || 0) + 1
  }

  res.json({
    range: { from, to },
    reportingCurrency: settings.reportingCurrency || 'USD',
    stages: stageRows,
    conversion,
    totals: {
      openCount: open.length,
      openTcvUsd: Math.round(stageRows.reduce((s, r) => s + r.tcvUsd, 0) * 100) / 100,
      weightedUsd: Math.round(stageRows.reduce((s, r) => s + r.weightedUsd, 0) * 100) / 100,
      openMrrUsd: Math.round(stageRows.reduce((s, r) => s + r.mrrUsd, 0) * 100) / 100,
    },
    closed: {
      wonCount: won.length,
      lostCount: lost.length,
      wonTcvUsd: Math.round(won.reduce((s, d) => s + (d.tcvUsd || 0), 0) * 100) / 100,
      wonMrrUsd: Math.round(won.reduce((s, d) => s + (d.mrrUsd || 0), 0) * 100) / 100,
      lostTcvUsd: Math.round(lost.reduce((s, d) => s + (d.tcvUsd || 0), 0) * 100) / 100,
      winRate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 1000) / 10 : null,
      avgWonUsd: won.length ? Math.round((won.reduce((s, d) => s + (d.tcvUsd || 0), 0) / won.length) * 100) / 100 : 0,
      medianCycleDays: cycleDays.length ? cycleDays[Math.floor(cycleDays.length / 2)] : null,
      lossReasons: Object.entries(lossReasons).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    },
  })
})

/* ==================================================================== */
/* 6. Forecast — weighted maths and what reps actually commit to        */
/* ==================================================================== */
router.get('/forecast', async (req, res) => {
  const settings = await getSettings()
  const months = Math.min(12, Math.max(1, parseInt(req.query.months, 10) || 6))
  const scope = {}
  if (req.query.owner) scope.owner = oid(req.query.owner)

  const start = new Date()
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setMonth(end.getMonth() + months)

  const [open, wonInRange] = await Promise.all([
    Deal.find({ ...scope, status: 'open', expectedCloseDate: { $gte: start, $lt: end } })
      .select('expectedCloseDate tcvUsd mrrUsd probability forecastCategory owner name company stage')
      .populate('company', 'name').populate('owner', 'name').lean(),
    Deal.find({ ...scope, status: 'won', wonAt: { $gte: start, $lt: end } })
      .select('wonAt tcvUsd mrrUsd').lean(),
  ])

  const buckets = []
  for (let i = 0; i < months; i++) {
    const monthStart = new Date(start)
    monthStart.setMonth(monthStart.getMonth() + i)
    buckets.push({
      month: monthStart.toISOString().slice(0, 7),
      monthStart,
      count: 0, tcvUsd: 0, mrrUsd: 0, weightedUsd: 0,
      commitUsd: 0, bestCaseUsd: 0, pipelineUsd: 0, omittedUsd: 0,
      wonUsd: 0,
    })
  }
  const indexOf = (date) => {
    const d = new Date(date)
    return (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth())
  }

  for (const d of open) {
    const i = indexOf(d.expectedCloseDate)
    if (i < 0 || i >= buckets.length) continue
    const b = buckets[i]
    b.count++
    b.tcvUsd += d.tcvUsd || 0
    b.mrrUsd += d.mrrUsd || 0
    if (d.forecastCategory !== 'omitted') {
      b.weightedUsd += (d.tcvUsd || 0) * ((d.probability || 0) / 100)
    }
    if (d.forecastCategory === 'commit') b.commitUsd += d.tcvUsd || 0
    else if (d.forecastCategory === 'best_case') b.bestCaseUsd += d.tcvUsd || 0
    else if (d.forecastCategory === 'omitted') b.omittedUsd += d.tcvUsd || 0
    else b.pipelineUsd += d.tcvUsd || 0
  }
  for (const d of wonInRange) {
    const i = indexOf(d.wonAt)
    if (i >= 0 && i < buckets.length) buckets[i].wonUsd += d.tcvUsd || 0
  }

  const r2 = (n) => Math.round(n * 100) / 100
  for (const b of buckets) {
    b.tcvUsd = r2(b.tcvUsd); b.mrrUsd = r2(b.mrrUsd); b.weightedUsd = r2(b.weightedUsd)
    b.commitUsd = r2(b.commitUsd); b.bestCaseUsd = r2(b.bestCaseUsd)
    b.pipelineUsd = r2(b.pipelineUsd); b.omittedUsd = r2(b.omittedUsd); b.wonUsd = r2(b.wonUsd)
  }

  // Deals with no close date are invisible to a forecast — say how many.
  const undated = await Deal.countDocuments({ ...scope, status: 'open', expectedCloseDate: null })
  const overdue = await Deal.countDocuments({
    ...scope, status: 'open', expectedCloseDate: { $ne: null, $lt: start },
  })

  res.json({
    reportingCurrency: settings.reportingCurrency || 'USD',
    months, start, end, buckets,
    undated,
    overdue,
    note:
      'Weighted = value x stage probability, excluding Omitted. Commit / Best case are what reps say they will land, which is a different claim from the statistical weighting — read them together, not instead of each other.',
  })
})

/* ---- Small headline numbers for the dashboard strip ---- */
router.get('/summary', async (req, res) => {
  const { from, to } = range(req)
  const contactIds = await visibleContactIds(req)
  const contactFilter = contactIds ? { _id: { $in: contactIds } } : {}

  const dealScope = req.can('reports.viewTeam') ? {} : { owner: req.user._id }
  const [totalContacts, newContacts, activeEnrollments, touches, meetings, dnc, openDeals, wonDeals] = await Promise.all([
    Contact.countDocuments(contactFilter),
    Contact.countDocuments({ ...contactFilter, createdAt: { $gte: from, $lte: to } }),
    Enrollment.countDocuments(
      contactIds ? { status: 'active', contact: { $in: contactIds } } : { status: 'active' }
    ),
    Activity.countDocuments(
      withContactScope({ type: { $in: TOUCH_TYPES }, createdAt: { $gte: from, $lte: to } }, contactIds)
    ),
    Activity.countDocuments(
      withContactScope(
        {
          createdAt: { $gte: from, $lte: to },
          $or: [{ 'meta.to': 'meeting_booked' }, { outcome: 'meeting_booked' }],
        },
        contactIds
      )
    ),
    Contact.countDocuments({ ...contactFilter, doNotContact: true }),
    Deal.aggregate([
      { $match: { ...dealScope, status: 'open' } },
      {
        $group: {
          _id: null, count: { $sum: 1 }, tcvUsd: { $sum: '$tcvUsd' }, mrrUsd: { $sum: '$mrrUsd' },
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
    ]),
    Deal.aggregate([
      { $match: { ...dealScope, status: 'won', wonAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, count: { $sum: 1 }, tcvUsd: { $sum: '$tcvUsd' }, mrrUsd: { $sum: '$mrrUsd' } } },
    ]),
  ])

  const settings = await getSettings()
  const r2 = (n) => Math.round((n || 0) * 100) / 100

  res.json({
    range: { from, to },
    reportingCurrency: settings.reportingCurrency || 'USD',
    totalContacts, newContacts, activeEnrollments, touches, meetings, doNotContact: dnc,
    pipeline: {
      openCount: openDeals[0]?.count || 0,
      tcvUsd: r2(openDeals[0]?.tcvUsd),
      mrrUsd: r2(openDeals[0]?.mrrUsd),
      weightedUsd: r2(openDeals[0]?.weightedUsd),
    },
    won: {
      count: wonDeals[0]?.count || 0,
      tcvUsd: r2(wonDeals[0]?.tcvUsd),
      mrrUsd: r2(wonDeals[0]?.mrrUsd),
    },
  })
})

module.exports = router
