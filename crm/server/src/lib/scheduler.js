const cron = require('node-cron')
const { runDueEnrollments } = require('./engine')

/* The stage engine runs server-side on a schedule, not on page load, so
 * contacts advance whether or not anyone has the app open. */

let running = false
let lastRun = null

async function tick(reason = 'cron') {
  if (running) {
    console.log('[scheduler] previous run still in progress, skipping')
    return null
  }
  running = true
  const started = Date.now()
  try {
    let total = { examined: 0, advanced: 0, completed: 0, errors: [] }
    // Drain in batches so a large backlog is cleared in one pass.
    for (let i = 0; i < 20; i++) {
      const result = await runDueEnrollments({ limit: 500 })
      total.examined += result.examined
      total.advanced += result.advanced
      total.completed += result.completed
      total.errors.push(...result.errors)
      if (result.examined < 500) break
    }
    lastRun = { at: new Date(), reason, ms: Date.now() - started, ...total }
    if (total.examined) {
      console.log(
        `[scheduler] ${reason}: examined ${total.examined}, advanced ${total.advanced}, completed ${total.completed}` +
          (total.errors.length ? `, ${total.errors.length} errors` : '')
      )
    }
    return lastRun
  } catch (err) {
    console.error('[scheduler] run failed:', err.message)
    lastRun = { at: new Date(), reason, error: err.message }
    return lastRun
  } finally {
    running = false
  }
}

function start() {
  const expression = process.env.SCHEDULER_CRON || '*/15 * * * *'
  if (!cron.validate(expression)) {
    console.error(`[scheduler] invalid SCHEDULER_CRON "${expression}" — falling back to every 15 minutes`)
    cron.schedule('*/15 * * * *', () => tick('cron'))
  } else {
    cron.schedule(expression, () => tick('cron'))
    console.log(`[scheduler] stage engine scheduled: ${expression}`)
  }
  // Catch up on anything that fell due while the server was down.
  setTimeout(() => tick('startup'), 5000)
}

module.exports = { start, tick, getLastRun: () => lastRun }
