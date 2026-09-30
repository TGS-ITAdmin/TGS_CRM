const express = require('express')
const bcrypt = require('bcryptjs')
const rateLimit = require('express-rate-limit')
const { User } = require('../db')
const { signToken, requireAuth } = require('../middleware/auth')
const { normalizeCalendarUrl } = require('../lib/calendar')

const router = express.Router()

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
})

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

  const user = await User.findOne({ email: String(email).toLowerCase().trim() })
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid email or password' })

  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' })

  user.lastLoginAt = new Date()
  await user.save()
  res.json({ token: signToken(user), user: user.toSafeJSON() })
})

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user.toSafeJSON() })
})

router.put('/me', requireAuth, async (req, res) => {
  const { name, timezone, notificationsEnabled, calendarEmbedUrl } = req.body || {}
  if (name !== undefined) req.user.name = String(name).trim()
  if (timezone !== undefined) req.user.timezone = String(timezone).trim()
  if (notificationsEnabled !== undefined) req.user.notificationsEnabled = !!notificationsEnabled

  if (calendarEmbedUrl !== undefined) {
    const result = normalizeCalendarUrl(calendarEmbedUrl)
    if (!result.ok) return res.status(400).json({ error: result.error })
    req.user.calendarEmbedUrl = result.url
  }

  await req.user.save()
  res.json({ user: req.user.toSafeJSON() })
})

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' })
  }
  const ok = await bcrypt.compare(currentPassword || '', req.user.passwordHash)
  if (!ok) return res.status(400).json({ error: 'Current password is incorrect' })

  req.user.passwordHash = await bcrypt.hash(newPassword, 10)
  req.user.mustChangePassword = false
  await req.user.save()
  res.json({ ok: true })
})

module.exports = router
