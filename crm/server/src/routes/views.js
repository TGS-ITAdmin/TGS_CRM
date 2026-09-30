const express = require('express')
const { SavedView, SAVED_VIEW_OBJECTS } = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

/* Saved views.
 *
 * Sharing and pinning are separate on purpose: sharing makes a view available
 * to the team, pinning puts it in *your* tab strip. One person tidying up
 * their own tabs should never rearrange everyone else's.
 */

function visibleFilter(req) {
  return { $or: [{ owner: req.user._id }, { shared: true }] }
}

function canEdit(req, view) {
  return req.can('settings.manage') || String(view.owner) === String(req.user._id)
}

function decorate(view, req) {
  return {
    ...view,
    mine: String(view.owner?._id || view.owner) === String(req.user._id),
    pinned: (view.pinnedBy || []).some((id) => String(id) === String(req.user._id)),
    canEdit: canEdit(req, view),
  }
}

router.get('/', async (req, res) => {
  const filter = visibleFilter(req)
  if (req.query.object) filter.object = req.query.object

  const views = await SavedView.find(filter)
    .sort({ order: 1, name: 1 })
    .populate('owner', 'name')
    .lean()
  res.json({ views: views.map((v) => decorate(v, req)), objects: SAVED_VIEW_OBJECTS })
})

router.post('/', async (req, res) => {
  const body = req.body || {}
  if (!SAVED_VIEW_OBJECTS.includes(body.object)) {
    return res.status(400).json({ error: 'Pick a valid object' })
  }
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'Give the view a name' })
  }

  const name = String(body.name).trim().slice(0, 80)
  const clash = await SavedView.findOne({ object: body.object, name, owner: req.user._id }).lean()
  if (clash) return res.status(409).json({ error: `You already have a view called "${name}"` })

  const count = await SavedView.countDocuments({ object: body.object, owner: req.user._id })
  const view = await SavedView.create({
    object: body.object,
    name,
    description: body.description || '',
    filters: body.filters || {},
    columns: body.columns || [],
    sort: body.sort || '',
    dir: body.dir || 'desc',
    owner: req.user._id,
    shared: !!body.shared,
    // Saving a view almost always means wanting it to hand, so pin it for the
    // person who made it.
    pinnedBy: [req.user._id],
    order: count,
  })
  res.status(201).json({ view: decorate(view.toObject(), req) })
})

router.put('/:id', async (req, res) => {
  const view = await SavedView.findById(req.params.id)
  if (!view) return res.status(404).json({ error: 'View not found' })
  if (!canEdit(req, view)) {
    return res.status(403).json({ error: "This view belongs to someone else. Duplicate it if you want your own version." })
  }

  const body = req.body || {}
  for (const key of ['name', 'description', 'sort', 'dir']) {
    if (body[key] !== undefined) view[key] = body[key]
  }
  if (body.filters !== undefined) view.filters = body.filters
  if (body.columns !== undefined) view.columns = body.columns
  if (body.shared !== undefined) view.shared = !!body.shared
  await view.save()
  res.json({ view: decorate(view.toObject(), req) })
})

/* Copy someone else's view into your own, so you can change it without
 * touching theirs. */
router.post('/:id/duplicate', async (req, res) => {
  const source = await SavedView.findOne({ _id: req.params.id, ...visibleFilter(req) }).lean()
  if (!source) return res.status(404).json({ error: 'View not found' })

  const count = await SavedView.countDocuments({ object: source.object, owner: req.user._id })
  const copy = await SavedView.create({
    object: source.object,
    name: `${source.name} (copy)`.slice(0, 80),
    description: source.description,
    filters: source.filters,
    columns: source.columns,
    sort: source.sort,
    dir: source.dir,
    owner: req.user._id,
    shared: false,
    pinnedBy: [req.user._id],
    order: count,
  })
  res.status(201).json({ view: decorate(copy.toObject(), req) })
})

router.post('/:id/pin', async (req, res) => {
  const view = await SavedView.findOne({ _id: req.params.id, ...visibleFilter(req) })
  if (!view) return res.status(404).json({ error: 'View not found' })

  const pin = req.body?.pinned !== false
  const op = pin ? { $addToSet: { pinnedBy: req.user._id } } : { $pull: { pinnedBy: req.user._id } }
  await SavedView.updateOne({ _id: view._id }, op)
  const fresh = await SavedView.findById(view._id).lean()
  res.json({ view: decorate(fresh, req) })
})

router.post('/reorder', async (req, res) => {
  const { object, ids } = req.body || {}
  if (!SAVED_VIEW_OBJECTS.includes(object) || !Array.isArray(ids)) {
    return res.status(400).json({ error: 'Send an object and an ordered list of view ids' })
  }
  // Only reorder views the caller may edit; ignore the rest silently rather
  // than failing the whole drag.
  const editable = await SavedView.find({ _id: { $in: ids }, owner: req.user._id }).select('_id').lean()
  const allowed = new Set(editable.map((v) => String(v._id)))
  await Promise.all(
    ids.filter((id) => allowed.has(String(id)))
      .map((id, i) => SavedView.updateOne({ _id: id }, { $set: { order: i } }))
  )
  res.json({ ok: true })
})

router.delete('/:id', async (req, res) => {
  const view = await SavedView.findById(req.params.id)
  if (!view) return res.status(404).json({ error: 'View not found' })
  if (!canEdit(req, view)) {
    return res.status(403).json({ error: 'This view belongs to someone else' })
  }
  if (view.shared && (view.pinnedBy || []).length > 1) {
    const others = view.pinnedBy.filter((id) => String(id) !== String(req.user._id)).length
    if (others > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        error: `${others} other ${others === 1 ? 'person has' : 'people have'} this view pinned. Deleting it removes it from their tabs too.`,
        pinnedByOthers: others,
      })
    }
  }
  await SavedView.deleteOne({ _id: view._id })
  res.json({ ok: true })
})

module.exports = router
