/* Admin activity log: list, details and undo. Admins only. */
const express = require('express')
const db = require('../db')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const { AuditOp, AuditChange, withoutAudit, clean, QUIET_MODELS, UNDO_DAYS } = require('../lib/audit')

const router = express.Router()
router.use(requireAuth, requireAdmin)

const MODELS = {
  User: db.User, Settings: db.Settings, Company: db.Company, Contact: db.Contact, Suppression: db.Suppression,
  Campaign: db.Campaign, Deal: db.Deal, Product: db.Product, Quote: db.Quote, CustomField: db.CustomField,
  SavedView: db.SavedView, Enrollment: db.Enrollment, Task: db.Task, OutboxMessage: db.OutboxMessage, Activity: db.Activity,
}
const MODEL_LABEL = {
  Contact: 'contact', Company: 'company', Deal: 'deal', Quote: 'quote', Campaign: 'campaign', Task: 'task',
  Enrollment: 'campaign enrolment', OutboxMessage: 'email draft', Settings: 'settings', User: 'user',
  Product: 'rate card item', CustomField: 'custom field', SavedView: 'saved view', Suppression: 'do-not-contact entry',
  Activity: 'timeline entry',
}
// Bookkeeping fields: recorded (undo stays exact) but not shown to admins.
const NOISE = new Set(['lastActivityAt'])
const shownFields = (c) => (c.fields || []).filter((f) => !NOISE.has(f))
const worthShowing = (c) => !QUIET_MODELS.has(c.model) && (c.action !== 'update' || shownFields(c).length > 0)
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const undoDeadline = (op) => new Date(new Date(op.at).getTime() + UNDO_DAYS * 86400000)

function undoState(op) {
  if (op.kind === 'undo') return { canUndo: false, why: 'This entry is an undo.' }
  if (op.undoneAt) return { canUndo: false, why: `Undone by ${op.undoneByName || 'an admin'}` }
  if (!op.undoable) return { canUndo: false, why: op.notUndoableReason || 'This action cannot be undone.' }
  if (undoDeadline(op) < new Date()) return { canUndo: false, why: `Undo is available for ${UNDO_DAYS} days only.` }
  return { canUndo: true, until: undoDeadline(op) }
}

/* ---- List ---- */
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50))
  const filter = { changeCount: { $gt: 0 } }
  if (/^[0-9a-f]{24}$/i.test(String(req.query.user || ''))) filter.user = req.query.user
  if (MODELS[req.query.model]) filter.models = req.query.model
  const days = parseInt(req.query.days, 10)
  if (days > 0) filter.at = { $gte: new Date(Date.now() - days * 86400000) }
  const q = String(req.query.q || '').trim()
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i')
    filter.$or = [{ headline: rx }, { label: rx }, { userName: rx }]
  }
  const [items, total] = await Promise.all([
    AuditOp.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditOp.countDocuments(filter),
  ])
  res.json({ items: items.map((op) => ({ ...op, ...undoState(op) })), total, page, pages: Math.ceil(total / limit) })
})

/* ---- One entry with its changes ---- */
router.get('/:id', async (req, res) => {
  const op = await AuditOp.findById(req.params.id).lean()
  if (!op) return res.status(404).json({ error: 'Not found' })
  const changes = await AuditChange.find({ op: op._id }).sort({ seq: 1 }).limit(500).lean()
  const shown = changes.filter(worthShowing)
  res.json({
    op: { ...op, ...undoState(op) },
    changes: shown.map((c) => ({ ...c, fields: shownFields(c), modelLabel: MODEL_LABEL[c.model] || c.model })),
    timelineEntries: changes.filter((c) => QUIET_MODELS.has(c.model)).length,
    more: Math.max(0, op.changeCount - changes.length),
  })
})

/* Later actions (not undone, not undos) that touched any record this entry
 * touched. Undo is blocked while any exist, and they are listed instead. */
async function laterConflicts(op, changes) {
  const byModel = new Map()
  for (const c of changes) {
    if (QUIET_MODELS.has(c.model)) continue
    if (!byModel.has(c.model)) byModel.set(c.model, [])
    byModel.get(c.model).push(c.entityId)
  }
  const later = []
  for (const [model, ids] of byModel) {
    for (let i = 0; i < ids.length; i += 1000) {
      later.push(...await AuditChange.find({
        model, entityId: { $in: ids.slice(i, i + 1000) }, op: { $ne: op._id }, at: { $gt: op.at },
      }).select('op model label').lean())
    }
  }
  if (!later.length) return []
  const ops = await AuditOp.find({ _id: { $in: [...new Set(later.map((c) => String(c.op)))] }, undoneAt: null, kind: 'change' })
    .sort({ at: -1 }).lean()
  return ops.map((o) => ({
    _id: o._id, at: o.at, userName: o.userName, headline: o.headline, label: o.label,
    records: [...new Set(later.filter((c) => String(c.op) === String(o._id)).map((c) => c.label))].slice(0, 5),
  }))
}

function planText(c) {
  const what = `${MODEL_LABEL[c.model] || c.model} “${c.label || ''}”`
  if (c.action === 'create') return `Remove ${what} (it was created by this action)`
  if (c.action === 'delete') return `Restore deleted ${what}`
  return `Put back ${shownFields(c).join(', ')} on ${what}`
}

/* ---- Undo (dry run first: { dryRun: true }) ---- */
router.post('/:id/undo', async (req, res) => {
  const op = await AuditOp.findById(req.params.id)
  if (!op) return res.status(404).json({ error: 'Not found' })
  const state = undoState(op.toObject())
  if (!state.canUndo) return res.status(400).json({ error: state.why })

  const changes = await AuditChange.find({ op: op._id }).sort({ seq: -1 }).lean()
  const conflicts = await laterConflicts(op, changes)
  const visible = changes.filter(worthShowing)
  const plan = visible.slice(0, 50).map(planText)
  if (visible.length > 50) plan.push(`…and ${visible.length - 50} more records`)
  const quiet = changes.length - visible.length
  if (quiet) plan.push(`${quiet} timeline entr${quiet === 1 ? 'y' : 'ies'} from this action ${changes.some((c) => QUIET_MODELS.has(c.model) && c.action === 'create') ? 'removed' : 'put back'}`)

  if (conflicts.length) {
    return res.status(409).json({
      error: 'Later changes touched the same records. Undo those first (newest first), then try again.',
      conflicts, plan,
    })
  }
  if (req.body?.dryRun) return res.json({ ok: true, plan })

  /* Apply in reverse order, straight on the collections so the exact stored
   * values (ids, dates) come back. These writes are recorded below as one
   * "undo" entry rather than by the recorder. */
  const undoChanges = []
  const removed = { Contact: [], Enrollment: [] }
  await withoutAudit(async () => {
    for (const c of changes) {
      const M = MODELS[c.model]
      if (!M) continue
      const coll = M.collection
      const _id = c.entityId
      if (c.action === 'create') {
        const cur = await coll.findOne({ _id })
        if (!cur) continue
        await coll.deleteOne({ _id })
        if (removed[c.model]) removed[c.model].push(_id)
        undoChanges.push({ model: c.model, entityId: _id, action: 'delete', label: c.label, before: clean(cur) })
      } else if (c.action === 'update') {
        const cur = await coll.findOne({ _id })
        if (!cur) continue
        const $set = {}
        const $unset = {}
        for (const f of c.fields || []) {
          if (c.before && Object.prototype.hasOwnProperty.call(c.before, f)) $set[f] = c.before[f]
          else $unset[f] = ''
        }
        const update = {}
        if (Object.keys($set).length) update.$set = $set
        if (Object.keys($unset).length) update.$unset = $unset
        if (!Object.keys(update).length) continue
        await coll.updateOne({ _id }, update)
        const fields = c.fields || []
        undoChanges.push({
          model: c.model, entityId: _id, action: 'update', label: c.label, fields,
          before: Object.fromEntries(fields.filter((f) => f in cur).map((f) => [f, clean(cur[f])])),
          after: c.before || {},
        })
      } else if (c.action === 'delete') {
        if (!c.before || await coll.findOne({ _id })) continue
        await coll.insertOne(c.before)
        undoChanges.push({ model: c.model, entityId: _id, action: 'create', label: c.label, after: c.before })
      }
    }

    // Work the scheduler created for records this undo removed is retired too.
    if (removed.Contact.length || removed.Enrollment.length) {
      const or = []
      if (removed.Contact.length) or.push({ contact: { $in: removed.Contact } })
      if (removed.Enrollment.length) or.push({ enrollment: { $in: removed.Enrollment } })
      await db.Task.collection.updateMany({ $or: or, status: 'pending' }, { $set: { status: 'cancelled', notes: 'Removed by undo' } })
      await db.OutboxMessage.collection.updateMany({ $or: or, status: 'queued' }, { $set: { status: 'cancelled', error: 'Removed by undo' } })
      if (removed.Contact.length) {
        await db.Enrollment.collection.updateMany(
          { contact: { $in: removed.Contact }, status: { $in: ['active', 'paused'] } },
          { $set: { status: 'exited', exitReason: 'Contact removed by undo', dueAt: null, exitedAt: new Date() } }
        )
      }
    }
  })

  // Counted once per record; bookkeeping-only and timeline changes left out.
  const counted = new Set(undoChanges
    .filter((c) => !QUIET_MODELS.has(c.model) && (c.action !== 'update' || shownFields(c).length > 0))
    .map((c) => `${c.model}:${c.action}:${c.entityId}`))
  const counts = {}
  for (const k of counted) {
    const [model, action] = k.split(':')
    counts[`${model}:${action}`] = (counts[`${model}:${action}`] || 0) + 1
  }
  const undoOp = await AuditOp.create({
    user: req.user._id, userName: req.user.name || req.user.email || '', method: 'POST', path: req.originalUrl,
    kind: 'undo', headline: `Undid: ${op.headline}`, label: op.label, counts,
    models: [...new Set(undoChanges.map((c) => c.model))], changeCount: undoChanges.length,
    undoable: false, notUndoableReason: 'An undo cannot itself be undone.', undoOf: op._id, status: 200,
  })
  for (let i = 0; i < undoChanges.length; i += 500) {
    await AuditChange.insertMany(undoChanges.slice(i, i + 500).map((c, k) => ({ ...c, op: undoOp._id, seq: i + k + 1, at: new Date() })), { ordered: false })
      .catch((e) => console.error('[audit] undo changes', e.message))
  }
  op.undoneAt = new Date()
  op.undoneBy = req.user._id
  op.undoneByName = req.user.name || req.user.email || ''
  op.undoOp = undoOp._id
  await op.save()

  res.json({ ok: true, reverted: counted.size, plan })
})

module.exports = router
