/* Formula fields.
 *
 * A tiny arithmetic parser rather than `eval` or `new Function`. Admins type
 * these into a settings box, so anything that executes arbitrary JavaScript
 * would hand whoever reaches that box the whole server process.
 *
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := '-'? primary
 *   primary := number | '{' field '}' | func '(' args ')' | '(' expr ')'
 *
 * Functions: round(x[, dp]), abs(x), min(a, b, …), max(a, b, …), coalesce(a, b, …)
 *
 * Anything that cannot be computed — a missing field, a non-numeric value, a
 * division by zero — evaluates to null rather than NaN or Infinity, so the UI
 * can honestly show "—" instead of a number nobody should trust.
 */

const FUNCTIONS = {
  round: (args) => {
    const [x, dp = 0] = args
    if (x == null) return null
    const f = 10 ** Math.max(0, Math.min(10, Math.trunc(dp ?? 0)))
    return Math.round(x * f) / f
  },
  abs: ([x]) => (x == null ? null : Math.abs(x)),
  min: (args) => {
    const vals = args.filter((v) => v != null)
    return vals.length ? Math.min(...vals) : null
  },
  max: (args) => {
    const vals = args.filter((v) => v != null)
    return vals.length ? Math.max(...vals) : null
  },
  // First value that is actually there — the usual way to give a formula a
  // sane default when a field has not been filled in yet.
  coalesce: (args) => {
    for (const v of args) if (v != null) return v
    return null
  },
}

const FUNCTION_NAMES = Object.keys(FUNCTIONS)

function tokenize(src) {
  const tokens = []
  let i = 0
  const text = String(src || '')

  while (i < text.length) {
    const ch = text[i]

    if (/\s/.test(ch)) { i++; continue }

    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < text.length && /[0-9.]/.test(text[j])) j++
      const raw = text.slice(i, j)
      if ((raw.match(/\./g) || []).length > 1) {
        throw new Error(`"${raw}" is not a number`)
      }
      tokens.push({ type: 'number', value: Number(raw) })
      i = j
      continue
    }

    if (ch === '{') {
      const end = text.indexOf('}', i)
      if (end === -1) throw new Error('A field reference is missing its closing }')
      const key = text.slice(i + 1, end).trim()
      if (!key) throw new Error('Empty field reference {}')
      if (!/^[a-zA-Z0-9_]+$/.test(key)) {
        throw new Error(`"${key}" is not a valid field name — letters, numbers and underscores only`)
      }
      tokens.push({ type: 'field', value: key })
      i = end + 1
      continue
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = i
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++
      const name = text.slice(i, j).toLowerCase()
      if (!FUNCTION_NAMES.includes(name)) {
        throw new Error(
          `"${text.slice(i, j)}" is not something a formula understands. ` +
          `Reference a field as {field_name}, or use one of: ${FUNCTION_NAMES.join(', ')}.`
        )
      }
      tokens.push({ type: 'func', value: name })
      i = j
      continue
    }

    if ('+-*/%(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }

    throw new Error(`"${ch}" cannot be used in a formula`)
  }

  return tokens
}

function parse(tokens) {
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (value) => {
    const t = tokens[pos]
    if (!t || (value !== undefined && t.value !== value)) {
      throw new Error(value ? `Expected "${value}"` : 'Unexpected end of formula')
    }
    pos++
    return t
  }

  function parseExpr() {
    let left = parseTerm()
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = eat().value
      left = { kind: 'binary', op, left, right: parseTerm() }
    }
    return left
  }

  function parseTerm() {
    let left = parseUnary()
    while (peek() && peek().type === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const op = eat().value
      left = { kind: 'binary', op, left, right: parseUnary() }
    }
    return left
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && peek().value === '-') {
      eat('-')
      return { kind: 'negate', value: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary() {
    const t = peek()
    if (!t) throw new Error('The formula ends unexpectedly')

    if (t.type === 'number') { eat(); return { kind: 'number', value: t.value } }
    if (t.type === 'field') { eat(); return { kind: 'field', key: t.value } }

    if (t.type === 'func') {
      eat()
      eat('(')
      const args = []
      if (peek() && peek().value !== ')') {
        args.push(parseExpr())
        while (peek() && peek().value === ',') { eat(','); args.push(parseExpr()) }
      }
      eat(')')
      return { kind: 'call', name: t.value, args }
    }

    if (t.type === 'op' && t.value === '(') {
      eat('(')
      const inner = parseExpr()
      eat(')')
      return inner
    }

    throw new Error(`Unexpected "${t.value}" in the formula`)
  }

  const ast = parseExpr()
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}" after the end of the formula`)
  return ast
}

function evaluate(node, scope) {
  switch (node.kind) {
    case 'number':
      return node.value

    case 'field': {
      const raw = scope[node.key]
      if (raw === undefined || raw === null || raw === '') return null
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }

    case 'negate': {
      const v = evaluate(node.value, scope)
      return v == null ? null : -v
    }

    case 'binary': {
      const a = evaluate(node.left, scope)
      const b = evaluate(node.right, scope)
      // A formula over a field nobody has filled in is unknown, not zero.
      if (a == null || b == null) return null
      switch (node.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        // Dividing by zero gives Infinity, which would render as a number and
        // be believed. Unknown is the honest answer.
        case '/': return b === 0 ? null : a / b
        case '%': return b === 0 ? null : a % b
        default: return null
      }
    }

    case 'call': {
      const args = node.args.map((a) => evaluate(a, scope))
      const fn = FUNCTIONS[node.name]
      return fn ? fn(args) : null
    }

    default:
      return null
  }
}

function fieldsUsed(node, acc = new Set()) {
  if (!node || typeof node !== 'object') return acc
  if (node.kind === 'field') acc.add(node.key)
  for (const child of [node.left, node.right, node.value, ...(node.args || [])]) {
    if (child) fieldsUsed(child, acc)
  }
  return acc
}

/* Parses once and returns a reusable evaluator. Never throws at run time —
 * a broken formula surfaces as `error` at compile time so an admin sees it
 * while typing, not as a crash on somebody's record page. */
function compile(source) {
  try {
    const ast = parse(tokenize(source))
    return {
      ok: true,
      fields: [...fieldsUsed(ast)],
      evaluate: (scope) => {
        try {
          const result = evaluate(ast, scope || {})
          return Number.isFinite(result) ? result : null
        } catch {
          return null
        }
      },
    }
  } catch (err) {
    return { ok: false, error: err.message, fields: [], evaluate: () => null }
  }
}

module.exports = { compile, tokenize, parse, evaluate, FUNCTION_NAMES }
