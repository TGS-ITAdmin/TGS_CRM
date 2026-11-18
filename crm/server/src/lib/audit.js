/* Admin activity log with undo.
 *
 * Every change a signed-in person makes (create, edit, delete — including
 * imports and bulk actions) is recorded as one "operation" per request, with
 * one "change" per record touched: the record's state before and after. That
 * is enough to show who changed what, and to put it back.
 *
 * How it hooks in: a Mongoose plugin on each data model watches saves,
 * updates, inserts and deletes. It only records while a signed-in request is
 * running (set up by requireAuth), so background automation — the scheduler
 * moving stages — is not logged; those events are on each contact's timeline.
 *
 * Safety: recording never blocks or breaks the request. Every audit write is
 * wrapped; a failure is logged to the console and the user's action stands.
 * The log lives in its own two collections and changes nothing else. */

const { AsyncLocalStorage } = require('async_hooks')
const mongoose = require('mongoose')

const { Schema } = mongoose
const als = new AsyncLocalStorage()

const RETAIN_SECONDS = 365 * 24 * 3600 // log kept one year (TTL index)
const UNDO_DAYS = 30 // undo offered for 30 days
const IGNORE = new Set(['updatedAt', '__v'])
// Never stored in the log, and never touched by undo.
const SENSITIVE = /pass(word)?|secret|token|hash|apikey/i
// Recorded (so undo is complete) but not listed in the change details.
const QUIET_MODELS = new Set(['Activity'])
// Fields the app updates on its own; a change to only these is not counted.
const BOOKKEEPING = new Set(['lastActivityAt'])
// Which record names an action, by the first part of its URL.
const PRIMARY_MODEL = {
  contacts: 'Contact', companies: 'Company', deals: 'Deal', quotes: 'Quote', campaigns: 'Campaign',
  products: 'Product', 'custom-fields': 'CustomField', views: 'SavedView', work: 'Contact',
}

const auditOpSchema = new Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    userName: { type: String, default: '' },
    method: String,
    path: String,
    status: Number,
    kind: { type: String, enum: ['change', 'undo'], default: 'change' },
    headline: { type: String, default: '' },
    label: { type: String, default: '' },
    counts: { type: Object, default: {} },
    models: { type: [String], default: [], index: true },
    changeCount: { type: Number, default: 0 },
    undoable: { type: Boolean, default: true },
    notUndoableReason: { type: String, default: '' },
    undoneAt: { type: Date, default: null },
    undoneBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    undoneByName: { type: String, default: '' },
    undoOp: { type: Schema.Types.ObjectId, default: null },
    undoOf: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: 'audit_ops' }
)
auditOpSchema.index({ at: 1 }, { expireAfterSeconds: RETAIN_SECONDS, name: 'audit_ops_ttl' })

const auditChangeSchema = new Schema(
  {
    op: { type: Schema.Types.ObjectId, index: true },
    at: { type: Date, default: Date.now },
    seq: Number,
    model: String,
    entityId: Schema.Types.Mixed,
    action: { type: String, enum: ['create', 'update', 'delete'] },
    label: String,
    fields: [String],
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
  },
  { collection: 'audit_changes', minimize: false }
)
auditChangeSchema.index({ model: 1, entityId: 1, at: -1 })
auditChangeSchema.index({ at: 1 }, { expireAfterSeconds: RETAIN_SECONDS, name: 'audit_changes_ttl' })

const AuditOp = mongoose.models.AuditOp || mongoose.model('AuditOp', auditOpSchema)
const AuditChange = mongoose.models.AuditChange || mongoose.model('AuditChange', auditChangeSchema)

/* ---- Snapshot helpers ---- */

function isPlain(v) {
  return v && typeof v === 'object' && (v.constructor === Object || Object.getPrototypeOf(v) === null)
}

// Deep copy that drops sensitive keys; ObjectIds and Dates kept as-is.
function clean(v) {
  if (Array.isArray(v)) return v.map(clean)
  if (isPlain(v)) {
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (SENSITIVE.test(k)) continue
      out[k] = clean(x)
    }
    return out
  }
  return v
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function diffFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  return [...keys].filter((k) => !IGNORE.has(k) && k !== '_id' && !SENSITIVE.test(k) && !same(before?.[k], after?.[k]))
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]]))

function labelFor(model, d) {
  if (!d) return model
  switch (model) {
    case 'Contact': return [d.firstName, d.lastName].filter(Boolean).join(' ') || d.email || d.companyName || 'Contact'
    case 'User': return d.name || d.email || 'User'
    case 'Task': return d.title || 'Task'
    case 'Quote': return d.number || d.title || 'Quote'
    case 'Settings': return 'Settings'
    case 'OutboxMessage': return d.subject || 'Email'
    case 'Enrollment': return 'Campaign enrolment'
    case 'Suppression': return d.email || d.domain || d.linkedinUrl || 'Do-not-contact entry'
    case 'Activity': return d.title || 'Timeline entry'
    default: return d.name || d.label || d.title || model
  }
}

/* ---- Request context ---- */

// Called by requireAuth once the user is known. Reads (GET) are not logged.
function bindRequest(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
  if (als.getStore()) return
  const ctx = {
    user: req.user._id,
    userName: req.user.name || req.user.email || '',
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0],
    opPromise: null,
    seq: 0,
    buffer: [],
    counted: new Set(),
    created: new Set(),
    models: new Set(),
    labels: {},
    notUndoable: '',
    total: 0,
    skip: false,
  }
  req._auditCtx = ctx
  als.enterWith(ctx)
  res.on('finish', () => { finalize(ctx, res.statusCode).catch((e) => console.error('[audit] finalize', e.message)) })
}

/* File uploads (multer) call the next handler from a stream event, which
 * loses the request context. Placed after upload.single(), this restores it. */
function rebind(req, res, next) {
  if (req._auditCtx && !als.getStore()) return als.run(req._auditCtx, next)
  return next()
}

// Run `fn` without recording (used by undo, which records its own changes).
function withoutAudit(fn) {
  return als.run({ skip: true }, fn)
}

const active = () => {
  const ctx = als.getStore()
  return ctx && !ctx.skip ? ctx : null
}

async function flush(ctx) {
  if (!ctx.buffer.length) return
  const op = await ctx.opPromise
  const batch = ctx.buffer.splice(0, ctx.buffer.length).map((c) => ({ ...c, op: op._id }))
  try {
    await AuditChange.insertMany(batch, { ordered: false })
  } catch (e) {
    console.error('[audit] could not store changes:', e.message)
  }
}

async function record(change) {
  const ctx = active()
  if (!ctx) return
  try {
    if (!ctx.opPromise) {
      ctx.opPromise = AuditOp.create({
        user: ctx.user, userName: ctx.userName, method: ctx.method, path: ctx.path, at: new Date(),
      })
    }
    ctx.seq += 1
    ctx.total += 1
    const id = String(change.entityId)
    if (change.action === 'create') ctx.created.add(`${change.model}:${id}`)
    /* Counted once per record and action. A record created in this same
       action, or touched only in bookkeeping fields, is not "changed" too. */
    const bookkeeping = change.action === 'update' && (change.fields || []).every((f) => BOOKKEEPING.has(f))
    const createdHere = change.action === 'update' && ctx.created.has(`${change.model}:${id}`)
    if (!bookkeeping && !createdHere) ctx.counted.add(`${change.model}:${change.action}:${id}`)
    ctx.models.add(change.model)
    if (!QUIET_MODELS.has(change.model) && !ctx.labels[change.model] && !bookkeeping) ctx.labels[change.model] = change.label || ''
    // An email that went out cannot be called back.
    if (change.model === 'OutboxMessage' && change.after?.status === 'sent' && change.before?.status !== 'sent') {
      ctx.notUndoable = 'An email was sent in this action, and a sent email cannot be unsent.'
    }
    ctx.buffer.push({ ...change, seq: ctx.seq, at: new Date() })
    if (ctx.buffer.length >= 200) await flush(ctx)
  } catch (e) {
    console.error('[audit] record', e.message)
  }
}

/* ---- Headlines ---- */

const ROUTE_TEXT = [
  [/^POST \/api\/contacts\/import$/, 'Imported contacts'],
  [/^POST \/api\/contacts\/bulk$/, 'Bulk change to contacts'],
  [/^POST \/api\/contacts\/merge/, 'Merged duplicate contacts'],
  [/^POST \/api\/contacts\/[^/]+\/(notes|activities)$/, 'Logged a note or reply'],
  [/^POST \/api\/contacts\/[^/]+\/enrollments\/[^/]+\/pause$/, 'Paused a campaign for a contact'],
  [/^POST \/api\/contacts\/[^/]+\/enrollments\/[^/]+\/resume$/, 'Resumed a campaign for a contact'],
  [/^POST \/api\/contacts$/, 'Created a contact'],
  [/^(PUT|PATCH) \/api\/contacts\/[^/]+$/, 'Edited a contact'],
  [/^DELETE \/api\/contacts\/[^/]+$/, 'Deleted a contact'],
  [/^POST \/api\/companies\/bulk-delete$/, 'Deleted companies'],
  [/^POST \/api\/companies\/[^/]+\/unlock$/, 'Cleared a company lock'],
  [/^POST \/api\/companies$/, 'Created a company'],
  [/^(PUT|PATCH) \/api\/companies\/[^/]+$/, 'Edited a company'],
  [/^DELETE \/api\/companies\/[^/]+$/, 'Deleted a company'],
  [/^POST \/api\/campaigns\/move$/, 'Moved contacts to another campaign'],
  [/^POST \/api\/campaigns\/[^/]+\/enroll$/, 'Added contacts to a campaign'],
  [/^POST \/api\/campaigns\/enrollments\/[^/]+\/skip-step$/, 'Skipped a campaign step'],
  [/^POST \/api\/campaigns\/enrollments\/[^/]+\/(\w+)$/, 'Changed a campaign enrolment'],
  [/^POST \/api\/campaigns$/, 'Created a campaign'],
  [/^(PUT|PATCH) \/api\/campaigns\/[^/]+$/, 'Edited a campaign'],
  [/^DELETE \/api\/campaigns\/[^/]+$/, 'Deleted a campaign'],
  [/^POST \/api\/work\/tasks\/[^/]+\/complete$/, 'Completed a task'],
  [/^POST \/api\/work\/tasks\/[^/]+\/snooze$/, 'Snoozed a task'],
  [/^POST \/api\/work\/tasks\/[^/]+\/skip$/, 'Skipped a task'],
  [/^POST \/api\/work\/tasks\/[^/]+\/skip-step$/, 'Skipped a campaign step'],
  [/^POST \/api\/work\/(tasks|outbox)\/[^/]+\/claim$/, 'Claimed work from a shared queue'],
  [/^POST \/api\/work\/(tasks|outbox)\/[^/]+\/release$/, 'Put work back in a shared queue'],
  [/^POST \/api\/work\/outbox/, 'Sent or changed emails'],
  [/^POST \/api\/work\/waiting-replies/, 'Marked "no reply yet"'],
  [/^POST \/api\/deals$/, 'Created a deal'],
  [/^(PUT|PATCH|POST) \/api\/deals\/[^/]+/, 'Changed a deal'],
  [/^DELETE \/api\/deals\/[^/]+$/, 'Deleted a deal'],
  [/^(POST|PUT|PATCH) \/api\/quotes/, 'Changed a quote'],
  [/^DELETE \/api\/quotes/, 'Deleted a quote'],
  [/^\w+ \/api\/settings\/users/, 'Changed a user'],
  [/^\w+ \/api\/settings\/rules\/compliance-signoff$/, 'Changed the compliance sign-off'],
  [/^\w+ \/api\/settings\/rules$/, 'Changed outreach rules'],
  [/^\w+ \/api\/settings\/status-orphans/, 'Moved contacts off old statuses'],
  [/^\w+ \/api\/settings\/suppression/, 'Changed the do-not-contact list'],
  [/^\w+ \/api\/settings/, 'Changed settings'],
  [/^\w+ \/api\/products/, 'Changed the rate card'],
  [/^\w+ \/api\/custom-fields/, 'Changed custom fields'],
  [/^\w+ \/api\/views/, 'Changed a saved view'],
]

function headlineFor(method, path) {
  const key = `${method} ${path}`
  const hit = ROUTE_TEXT.find(([rx]) => rx.test(key))
  if (hit) return hit[1]
  const verb = { POST: 'Changed', PUT: 'Edited', PATCH: 'Edited', DELETE: 'Deleted' }[method] || 'Changed'
  return `${verb} ${path.replace(/^\/api\//, '').split('/')[0] || 'data'}`
}

async function finalize(ctx, status) {
  if (!ctx.opPromise) return
  await flush(ctx)
  const op = await ctx.opPromise
  const counts = {}
  for (const k of ctx.counted) {
    const [model, action] = k.split(':')
    counts[`${model}:${action}`] = (counts[`${model}:${action}`] || 0) + 1
  }
  const segment = ctx.path.replace(/^\/api\//, '').split('/')[0]
  const primary = /^\/api\/settings\/users/.test(ctx.path) ? 'User' : PRIMARY_MODEL[segment]
  const label = ctx.labels[primary] || Object.values(ctx.labels).find(Boolean) || ''
  await AuditOp.updateOne({ _id: op._id }, {
    $set: {
      status,
      headline: headlineFor(ctx.method, ctx.path),
      label,
      counts,
      models: [...ctx.models],
      changeCount: ctx.total,
      undoable: !ctx.notUndoable,
      notUndoableReason: ctx.notUndoable,
    },
  })
}

/* ---- The plugin ---- */

function auditPlugin(schema, { model }) {
  const toPlain = (doc) => clean(doc.toObject({ depopulate: true, virtuals: false, getters: false }))

  schema.pre('save', async function () {
    if (!active()) return
    try {
      if (this.isNew) { this.$locals.auditNew = true; return }
      this.$locals.auditBefore = await this.constructor.findById(this._id).lean()
    } catch (e) { console.error('[audit] pre-save', e.message) }
  })
  schema.post('save', async function (doc) {
    if (!active()) return
    try {
      const after = toPlain(doc)
      if (doc.$locals.auditNew) {
        doc.$locals.auditNew = false
        return record({ model, action: 'create', entityId: doc._id, label: labelFor(model, after), after })
      }
      const before = clean(doc.$locals.auditBefore)
      if (!before) return
      const fields = diffFields(before, after)
      if (!fields.length) return
      return record({
        model, action: 'update', entityId: doc._id, label: labelFor(model, after),
        fields, before: pick(before, fields), after: pick(after, fields),
      })
    } catch (e) { console.error('[audit] post-save', e.message) }
  })

  schema.post('insertMany', async function (docs) {
    if (!active()) return
    try {
      for (const d of docs || []) {
        const after = toPlain(d)
        await record({ model, action: 'create', entityId: d._id, label: labelFor(model, after), after })
      }
    } catch (e) { console.error('[audit] insertMany', e.message) }
  })

  const single = (q) => ['updateOne', 'findOneAndUpdate', 'deleteOne', 'findOneAndDelete', 'replaceOne'].includes(q.op)

  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'], { document: false, query: true }, async function () {
    if (!active()) return
    try {
      const q = this.model.find(this.getFilter()).lean()
      this._auditBefore = await (single(this) ? q.limit(1) : q)
    } catch (e) { console.error('[audit] pre-update', e.message) }
  })
  schema.post(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'], { document: false, query: true }, async function () {
    if (!active() || !this._auditBefore) return
    try {
      const before = this._auditBefore
      if (!before.length) {
        // An upsert that created the record.
        if (this.getOptions().upsert) {
          const created = await this.model.findOne(this.getFilter()).lean()
          if (created) await record({ model, action: 'create', entityId: created._id, label: labelFor(model, created), after: clean(created) })
        }
        return
      }
      const after = await this.model.find({ _id: { $in: before.map((d) => d._id) } }).lean()
      const byId = new Map(after.map((d) => [String(d._id), d]))
      for (const b of before) {
        const a = byId.get(String(b._id))
        if (!a) continue
        const cb = clean(b); const ca = clean(a)
        const fields = diffFields(cb, ca)
        if (!fields.length) continue
        await record({
          model, action: 'update', entityId: b._id, label: labelFor(model, ca),
          fields, before: pick(cb, fields), after: pick(ca, fields),
        })
      }
    } catch (e) { console.error('[audit] post-update', e.message) }
  })

  schema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], { document: false, query: true }, async function () {
    if (!active()) return
    try {
      const q = this.model.find(this.getFilter()).lean()
      this._auditBefore = await (single(this) ? q.limit(1) : q)
    } catch (e) { console.error('[audit] pre-delete', e.message) }
  })
  schema.post(['deleteOne', 'deleteMany', 'findOneAndDelete'], { document: false, query: true }, async function () {
    if (!active() || !this._auditBefore) return
    try {
      for (const b of this._auditBefore) {
        const cb = clean(b)
        await record({ model, action: 'delete', entityId: b._id, label: labelFor(model, cb), before: cb })
      }
    } catch (e) { console.error('[audit] post-delete', e.message) }
  })

  // doc.deleteOne() — document middleware.
  schema.pre('deleteOne', { document: true, query: false }, function () {
    if (!active()) return
    try { this.$locals.auditDeleted = toPlain(this) } catch (e) { console.error('[audit] pre-doc-delete', e.message) }
  })
  schema.post('deleteOne', { document: true, query: false }, async function () {
    if (!active() || !this.$locals.auditDeleted) return
    const cb = this.$locals.auditDeleted
    await record({ model, action: 'delete', entityId: this._id, label: labelFor(model, cb), before: cb })
  })
}

module.exports = {
  AuditOp,
  AuditChange,
  auditPlugin,
  bindRequest,
  rebind,
  withoutAudit,
  labelFor,
  clean,
  same,
  QUIET_MODELS,
  UNDO_DAYS,
}
