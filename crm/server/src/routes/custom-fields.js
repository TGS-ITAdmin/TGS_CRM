const express = require('express')
const {
  CustomField, Contact, Company, Deal,
  CUSTOM_FIELD_OBJECTS, CUSTOM_FIELD_TYPES,
} = require('../db')
const { requireAuth, requirePermission } = require('../middleware/auth')
const { compile, FUNCTION_NAMES } = require('../lib/formula')
const { invalidate, referenceableFields, BUILTIN_NUMERIC } = require('../lib/custom-fields')
const { stageList } = require('../lib/deals')
const { getSettings } = require('../lib/money')

const router = express.Router()
router.use(requireAuth)

const MODELS = { contact: Contact, company: Company, deal: Deal }

// Keys must be stable identifiers: they are object keys in stored documents.
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field'
}

/* Everyone reads the definitions — a rep's record page needs them to render.
 * Only an admin changes them. */
router.get('/', async (req, res) => {
  const filter = {}
  if (req.query.object) filter.object = req.query.object
  if (req.query.active !== 'all') filter.active = true
  const fields = await CustomField.find(filter).sort({ object: 1, order: 1 }).lean()
  res.json({
    fields,
    objects: CUSTOM_FIELD_OBJECTS,
    types: CUSTOM_FIELD_TYPES,
    functions: FUNCTION_NAMES,
  })
})

/* What a formula on this object may reference, so the editor can list them
 * instead of leaving an admin guessing at key names. */
router.get('/referenceable/:object', async (req, res) => {
  if (!CUSTOM_FIELD_OBJECTS.includes(req.params.object)) {
    return res.status(400).json({ error: 'Unknown object' })
  }
  const settings = await getSettings()
  res.json({
    fields: await referenceableFields(req.params.object),
    builtins: BUILTIN_NUMERIC[req.params.object] || [],
    functions: FUNCTION_NAMES,
    stages: req.params.object === 'deal' ? stageList(settings) : [],
  })
})

/* Check a formula without saving it. */
router.post('/validate-formula', requirePermission('settings.manage'), async (req, res) => {
  const object = req.body?.object
  if (!CUSTOM_FIELD_OBJECTS.includes(object)) {
    return res.status(400).json({ error: 'Unknown object' })
  }
  const compiled = compile(req.body?.formula || '')
  if (!compiled.ok) return res.json({ ok: false, error: compiled.error })

  const known = new Set((await referenceableFields(object)).map((f) => f.key))
  const unknown = compiled.fields.filter((f) => !known.has(f))
  if (unknown.length) {
    return res.json({
      ok: false,
      error: `${unknown.map((f) => `{${f}}`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a number field on this object. A formula can only do arithmetic over numbers.`,
      unknown,
    })
  }

  // Run it against a real record so the admin sees an actual result.
  const Model = MODELS[object]
  const sample = await Model.findOne().sort({ updatedAt: -1 }).lean()
  let preview = null
  if (sample) {
    const scope = {}
    for (const key of BUILTIN_NUMERIC[object] || []) {
      if (sample[key] != null) scope[key] = sample[key]
    }
    Object.assign(scope, sample.customFields || {})
    preview = { value: compiled.evaluate(scope), scope }
  }
  res.json({ ok: true, fields: compiled.fields, preview })
})

router.post('/', requirePermission('settings.manage'), async (req, res) => {
  const body = req.body || {}
  if (!CUSTOM_FIELD_OBJECTS.includes(body.object)) {
    return res.status(400).json({ error: 'Pick a valid object' })
  }
  if (!body.label || !String(body.label).trim()) {
    return res.status(400).json({ error: 'A label is required' })
  }
  if (!CUSTOM_FIELD_TYPES.includes(body.type || 'text')) {
    return res.status(400).json({ error: 'Unknown field type' })
  }

  const key = (body.key ? String(body.key).toLowerCase() : slugify(body.label)).trim()
  if (!KEY_RE.test(key)) {
    return res.status(400).json({
      error: 'The key must start with a letter and contain only lowercase letters, numbers and underscores',
    })
  }
  const clash = await CustomField.findOne({ object: body.object, key }).lean()
  if (clash) return res.status(409).json({ error: `A field with the key "${key}" already exists on ${body.object}` })

  if (body.type === 'formula') {
    const compiled = compile(body.formula || '')
    if (!compiled.ok) return res.status(400).json({ error: `Formula problem: ${compiled.error}` })
  }
  if (['select', 'multiselect'].includes(body.type) && !(body.options || []).length) {
    return res.status(400).json({ error: 'A dropdown needs at least one option' })
  }
  if (body.requiredAtStage && body.object !== 'deal') {
    return res.status(400).json({ error: 'Stage requirements only apply to deals' })
  }

  const count = await CustomField.countDocuments({ object: body.object })
  const field = await CustomField.create({
    object: body.object,
    key,
    label: String(body.label).trim(),
    type: body.type || 'text',
    options: (body.options || []).map(String).filter(Boolean),
    helpText: body.helpText || '',
    formula: body.type === 'formula' ? body.formula : '',
    required: !!body.required,
    requiredAtStage: body.object === 'deal' ? (body.requiredAtStage || '') : '',
    showInTable: !!body.showInTable,
    order: count,
    createdBy: req.user._id,
  })
  invalidate(body.object)
  res.status(201).json({ field })
})

router.put('/:id', requirePermission('settings.manage'), async (req, res) => {
  const field = await CustomField.findById(req.params.id)
  if (!field) return res.status(404).json({ error: 'Field not found' })
  const body = req.body || {}

  /* The key is the object key values are stored under. Changing it would
     orphan every value already saved, silently, with no way back. */
  if (body.key && body.key !== field.key) {
    return res.status(409).json({
      error: 'A field key cannot be changed once it exists — every value already saved is stored under it. Change the label instead, or create a new field.',
    })
  }
  /* Changing the type is the same problem in a different shape: existing
     values would no longer match what the field claims to hold. */
  if (body.type && body.type !== field.type) {
    const anyValues = await MODELS[field.object].countDocuments({
      [`customFields.${field.key}`]: { $exists: true },
    })
    if (anyValues > 0) {
      return res.status(409).json({
        error: `${anyValues} record${anyValues === 1 ? ' already has' : 's already have'} a value in this field, so its type cannot change. Create a new field and migrate if you need a different type.`,
        recordCount: anyValues,
      })
    }
    field.type = body.type
  }

  for (const key of ['label', 'helpText', 'order']) {
    if (body[key] !== undefined) field[key] = body[key]
  }
  for (const key of ['required', 'showInTable', 'active']) {
    if (body[key] !== undefined) field[key] = !!body[key]
  }
  if (body.options !== undefined) field.options = (body.options || []).map(String).filter(Boolean)
  if (body.requiredAtStage !== undefined) {
    field.requiredAtStage = field.object === 'deal' ? (body.requiredAtStage || '') : ''
  }
  if (body.formula !== undefined && field.type === 'formula') {
    const compiled = compile(body.formula)
    if (!compiled.ok) return res.status(400).json({ error: `Formula problem: ${compiled.error}` })
    field.formula = body.formula
  }

  await field.save()
  invalidate(field.object)
  res.json({ field })
})

router.post('/reorder', requirePermission('settings.manage'), async (req, res) => {
  const { object, ids } = req.body || {}
  if (!CUSTOM_FIELD_OBJECTS.includes(object) || !Array.isArray(ids)) {
    return res.status(400).json({ error: 'Send an object and an ordered list of field ids' })
  }
  await Promise.all(ids.map((id, i) => CustomField.updateOne({ _id: id, object }, { $set: { order: i } })))
  invalidate(object)
  res.json({ ok: true })
})

router.delete('/:id', requirePermission('settings.manage'), async (req, res) => {
  const field = await CustomField.findById(req.params.id)
  if (!field) return res.status(404).json({ error: 'Field not found' })

  const withValues = await MODELS[field.object].countDocuments({
    [`customFields.${field.key}`]: { $exists: true },
  })
  if (withValues > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `${withValues} record${withValues === 1 ? ' holds' : 's hold'} data in "${field.label}". Deactivating hides it everywhere while keeping the data; deleting throws it away.`,
      recordCount: withValues,
      canDeactivate: true,
    })
  }

  if (req.query.force === 'true' && withValues > 0) {
    // Actually remove the orphaned values rather than leaving them to rot in
    // documents where nothing can ever read them again.
    await MODELS[field.object].updateMany(
      { [`customFields.${field.key}`]: { $exists: true } },
      { $unset: { [`customFields.${field.key}`]: '' } }
    )
  }
  await CustomField.deleteOne({ _id: field._id })
  invalidate(field.object)
  res.json({ ok: true, valuesRemoved: req.query.force === 'true' ? withValues : 0 })
})

module.exports = router
