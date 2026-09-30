const { CustomField } = require('../db')
const { compile } = require('./formula')

/* Custom fields.
 *
 * Values live in a `customFields` object on the record. Formula fields are
 * never stored — they are computed on read, so editing the formula updates
 * every record at once instead of leaving stale numbers behind.
 */

/* Built-in numbers a formula may reference alongside custom fields, so an
 * admin can write {tcv} - {cost} without us having to mirror core fields. */
const BUILTIN_NUMERIC = {
  deal: ['tcv', 'mrr', 'oneTimeTotal', 'tcvUsd', 'mrrUsd', 'amount', 'probability', 'termMonths', 'fxRate'],
  company: ['seatsNeeded'],
  contact: [],
}

/* Short-lived cache. Field definitions change when an admin edits them, which
 * is rare; every record read hitting the database for them is not free. */
const CACHE_MS = 5000
const cache = new Map()

async function getFields(object, { includeInactive = false } = {}) {
  const hit = cache.get(object)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return includeInactive ? hit.all : hit.active
  }
  const all = await CustomField.find({ object }).sort({ order: 1, createdAt: 1 }).lean()
  const active = all.filter((f) => f.active)
  cache.set(object, { at: Date.now(), all, active })
  return includeInactive ? all : active
}

function invalidate(object) {
  if (object) cache.delete(object)
  else cache.clear()
}

const isBlank = (v) => v === undefined || v === null || v === ''

/* Coerces one submitted value to the field's type.
 * Returns { value } or { error }. */
function coerce(field, raw) {
  if (isBlank(raw)) return { value: null }

  switch (field.type) {
    case 'number':
    case 'currency': {
      const n = Number(raw)
      if (!Number.isFinite(n)) return { error: `${field.label} must be a number` }
      return { value: n }
    }

    case 'checkbox':
      return { value: !!raw && raw !== 'false' }

    case 'date': {
      const d = new Date(raw)
      if (Number.isNaN(d.getTime())) return { error: `${field.label} must be a date` }
      return { value: d.toISOString() }
    }

    case 'select': {
      const v = String(raw)
      if (field.options.length && !field.options.includes(v)) {
        return { error: `${field.label} must be one of: ${field.options.join(', ')}` }
      }
      return { value: v }
    }

    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',').map((x) => x.trim())
      const clean = list.filter(Boolean).map(String)
      const bad = field.options.length ? clean.filter((v) => !field.options.includes(v)) : []
      if (bad.length) {
        return { error: `${field.label}: ${bad.join(', ')} ${bad.length === 1 ? 'is not' : 'are not'} an option` }
      }
      return { value: clean }
    }

    case 'url': {
      const v = String(raw).trim()
      // Only http(s). A javascript: URL rendered as a link is a live XSS.
      if (!/^https?:\/\//i.test(v)) {
        return { error: `${field.label} must start with http:// or https://` }
      }
      return { value: v }
    }

    case 'formula':
      // Computed on read; anything submitted for it is discarded.
      return { value: undefined }

    default:
      return { value: String(raw).slice(0, 5000) }
  }
}

/* Merges submitted values over the existing ones and validates them.
 * Only keys the caller actually sent are touched, so a partial update from
 * one form cannot blank a field that form never showed. */
async function applyValues(object, existing, submitted) {
  const fields = await getFields(object)
  const values = { ...(existing || {}) }
  const errors = []

  for (const field of fields) {
    if (!(field.key in (submitted || {}))) continue
    const { value, error } = coerce(field, submitted[field.key])
    if (error) { errors.push(error); continue }
    if (value === undefined) continue
    if (value === null) delete values[field.key]
    else values[field.key] = value
  }

  return { values, errors }
}

/* Which required fields are still empty. `stage` gates deal fields that are
 * only required from a particular pipeline stage onwards. */
async function missingRequired(object, record, { stage = null, stageOrder = null } = {}) {
  const fields = await getFields(object)
  const values = record?.customFields || {}
  const missing = []

  for (const field of fields) {
    if (field.type === 'formula') continue

    let applies = field.required
    if (field.requiredAtStage && stageOrder) {
      // Required from this stage onwards, not only exactly at it — otherwise
      // skipping a stage skips the requirement.
      const needAt = stageOrder.indexOf(field.requiredAtStage)
      const now = stageOrder.indexOf(stage)
      applies = needAt !== -1 && now !== -1 && now >= needAt
    }
    if (!applies) continue

    const v = values[field.key]
    const empty = isBlank(v) || (Array.isArray(v) && v.length === 0)
    if (empty) missing.push(field)
  }

  return missing
}

/* Computes every formula field for a record and returns them keyed by field
 * key. Never stored — recomputed on each read so an edited formula applies
 * everywhere at once. */
async function computeFormulas(object, record) {
  const fields = await getFields(object)
  const formulas = fields.filter((f) => f.type === 'formula' && f.formula)
  if (!formulas.length) return {}

  const scope = {}
  for (const key of BUILTIN_NUMERIC[object] || []) {
    if (record?.[key] !== undefined && record[key] !== null) scope[key] = record[key]
  }
  for (const [key, value] of Object.entries(record?.customFields || {})) {
    scope[key] = value
  }

  const out = {}
  for (const field of formulas) {
    const compiled = compile(field.formula)
    out[field.key] = compiled.ok ? compiled.evaluate(scope) : null
  }
  return out
}

/* Attaches computed values onto one record or an array of them. */
async function decorate(object, records) {
  const list = Array.isArray(records) ? records : [records]
  const fields = await getFields(object)
  if (!fields.some((f) => f.type === 'formula' && f.formula)) return records

  for (const record of list) {
    if (!record) continue
    const computed = await computeFormulas(object, record)
    record.customFields = { ...(record.customFields || {}), ...computed }
  }
  return records
}

/* Fields an admin may reference from a formula on this object. */
async function referenceableFields(object) {
  const fields = await getFields(object)
  return [
    ...(BUILTIN_NUMERIC[object] || []).map((key) => ({ key, label: key, source: 'built-in' })),
    ...fields
      .filter((f) => ['number', 'currency'].includes(f.type))
      .map((f) => ({ key: f.key, label: f.label, source: 'custom' })),
  ]
}

module.exports = {
  getFields, invalidate, coerce, applyValues, missingRequired,
  computeFormulas, decorate, referenceableFields, BUILTIN_NUMERIC,
}
