const jwt = require('jsonwebtoken')
const { User } = require('../db')
const { can, describe } = require('../lib/permissions')

/* No fallback. lib/preflight refuses to start the server without a real
   secret, so a missing one here would mean the check was bypassed — and
   signing tokens with a guessable default is worse than crashing. */
const SECRET = () => {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set')
  return secret
}

function signToken(user) {
  return jwt.sign({ id: user._id.toString() }, SECRET(), { expiresIn: '30d' })
}

/* "View as": a short session that acts as `user`, started by an admin. The
 * admin is re-checked on every request, so it ends the moment they lose
 * admin rights or are deactivated. */
function signViewAsToken(user, admin) {
  return jwt.sign({ id: user._id.toString(), imp: admin._id.toString() }, SECRET(), { expiresIn: '8h' })
}

/* The user is loaded fresh on every request rather than trusted from the
 * token. It costs one indexed lookup and means a rights change takes effect
 * immediately — nobody keeps a permission because they have not logged out. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Not authenticated' })
  try {
    const payload = jwt.verify(token, SECRET())
    const user = await User.findById(payload.id)
    if (!user || !user.active) return res.status(401).json({ error: 'Account inactive' })
    if (payload.imp) {
      const admin = await User.findById(payload.imp)
      if (!admin || !admin.active || admin.role !== 'admin') {
        return res.status(401).json({ error: 'The "view as" session has ended. Sign in again.' })
      }
      req.impersonator = admin
    }
    req.user = user
    req.can = (key) => can(user, key)
    // Admin activity log: changes made during this request are recorded.
    require('../lib/audit').bindRequest(req, res)
    next()
  } catch {
    res.status(401).json({ error: 'Session expired' })
  }
}

/* Guard a route on one right. The message names the right in the words the
 * admin screen uses, so "ask someone to give me X" is an actionable sentence. */
function requirePermission(key) {
  return (req, res, next) => {
    if (can(req.user, key)) return next()
    const meta = describe(key)
    res.status(403).json({
      error: `You do not have permission to ${meta.label.toLowerCase()}. An admin can grant it under Settings → Users.`,
      permission: key,
    })
  }
}

// Kept for the few places that genuinely mean "the whole account", such as
// deleting a user. Everything else names the right it actually needs.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next()
  res.status(403).json({ error: 'Admin access required' })
}

/* Narrows a query to what this person may see.
 * Spread into a Mongoose filter: { ...ownerScope(req), status: 'new' } */
function ownerScope(req, field = 'owner', permission = 'contacts.viewAll') {
  if (can(req.user, permission)) return {}
  return { [field]: req.user._id }
}

function assignedScope(req, field = 'assignedTo') {
  // Work queues are always personal: seeing everyone's tasks is a different
  // question from seeing everyone's contacts, and nobody wants the former.
  if (can(req.user, 'contacts.viewAll') && req.query?.assignedTo === 'all') return {}
  return { [field]: req.user._id }
}

/* Shared-queue work open to this person: steps given to their role that
 * nobody has claimed yet. */
function claimableScope(req) {
  return { assignedTo: null, assignRole: req.user.role }
}

/* Like ownerScope, plus contacts this person holds open work for — so
 * someone who claimed a call from the Coldcaller queue can open and update
 * that contact without becoming its owner. Access ends with the work. */
async function contactAccessScope(req) {
  const base = ownerScope(req)
  if (!Object.keys(base).length) return base
  const { Task, OutboxMessage } = require('../db')
  const [t, o] = await Promise.all([
    Task.distinct('contact', { assignedTo: req.user._id, status: 'pending' }),
    OutboxMessage.distinct('contact', { assignedTo: req.user._id, status: 'queued' }),
  ])
  const ids = [...t, ...o]
  if (!ids.length) return base
  return { $or: [base, { _id: { $in: ids } }] }
}

module.exports = {
  signToken, signViewAsToken, requireAuth, requirePermission, requireAdmin,
  ownerScope, assignedScope, claimableScope, contactAccessScope, can,
}
