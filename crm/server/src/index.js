require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })

const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')

const { connect } = require('./db')
const { reportConfig } = require('./lib/preflight')
const scheduler = require('./lib/scheduler')
const { requireAuth, requireAdmin } = require('./middleware/auth')

const app = express()
const PORT = process.env.PORT || 3002

app.set('trust proxy', 1)
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'tgs-outreach-crm', scheduler: scheduler.getLastRun() })
})

// Public: unsubscribe pages and the inbound web form. Mounted first so the
// SPA catch-all never swallows them.
app.use('/', require('./routes/public'))

app.use('/api/auth', require('./routes/auth'))
app.use('/api/settings', require('./routes/settings'))
app.use('/api/companies', require('./routes/companies'))
app.use('/api/contacts', require('./routes/contacts'))
app.use('/api/deals', require('./routes/deals'))
app.use('/api/products', require('./routes/products'))
app.use('/api/custom-fields', require('./routes/custom-fields'))
app.use('/api/views', require('./routes/views'))
app.use('/api/dashboard', require('./routes/dashboard'))
app.use('/api/quotes', require('./routes/quotes'))
app.use('/api/campaigns', require('./routes/campaigns'))
app.use('/api/work', require('./routes/work'))
app.use('/api/reports', require('./routes/reports'))

// Manual scheduler kick, for testing the stage engine without waiting.
app.post('/api/scheduler/run', requireAuth, requireAdmin, async (req, res) => {
  const result = await scheduler.tick('manual')
  res.json({ result })
})
app.get('/api/scheduler/status', requireAuth, (req, res) => {
  res.json({ lastRun: scheduler.getLastRun(), cron: process.env.SCHEDULER_CRON || '*/15 * * * *' })
})

app.use('/api', (req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }))

// Serve the built client in production.
const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')))
} else {
  app.get('/', (req, res) =>
    res.send(
      '<p>API is running. The client has not been built — run <code>npm run dev</code> from the crm folder and open the Vite dev server.</p>'
    )
  )
}

app.use((err, req, res, next) => {
  console.error('[error]', err.message)
  const status = err.status || 500
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server' : err.message })
})

/* Checked before the database is touched, so a misconfigured deploy fails
   immediately and loudly rather than serving traffic with a known secret. */
if (!reportConfig()) process.exit(1)

connect()
  .then(() => {
    scheduler.start()
    app.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`))
  })
  .catch((err) => {
    console.error('[server] could not start:', err.message)
    process.exit(1)
  })
