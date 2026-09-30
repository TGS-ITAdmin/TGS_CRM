const crypto = require('crypto')

/* Configuration checks that run before the server accepts a request.
 *
 * The failure mode these exist to prevent is silent: an app that boots
 * perfectly, serves traffic, and signs its auth tokens with a secret written
 * in a public repository. Anyone who reads the source can then mint an admin
 * token. Refusing to start is the only safe response to that.
 */

const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'dev-secret-change-me',
  'changeme', 'change-me', 'secret', 'password', 'jwt-secret', 'test',
])

const MIN_SECRET_LENGTH = 32

function generateSecretHint() {
  return "node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
}

function checkConfig(env = process.env) {
  const problems = []
  const warnings = []
  // The test harness supplies its own throwaway secret and never faces the
  // internet, so it is exempt from the length rule.
  const isTest = env.NODE_ENV === 'test'

  const secret = String(env.JWT_SECRET || '')
  if (!isTest) {
    if (!secret) {
      problems.push(
        'JWT_SECRET is not set. Every login token is signed with it, so without one ' +
        'the server cannot tell a real session from a forged one.'
      )
    } else if (PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
      problems.push(
        `JWT_SECRET is still the placeholder value. It is in the repository, so anyone ` +
        'who can read the code could sign themselves an admin token.'
      )
    } else if (secret.length < MIN_SECRET_LENGTH) {
      problems.push(
        `JWT_SECRET is only ${secret.length} characters. Use at least ${MIN_SECRET_LENGTH} — ` +
        'a short secret is worth brute-forcing.'
      )
    }
  }

  if (problems.length) {
    problems.push(`Generate one with:  ${generateSecretHint()}`)
  }

  if (!env.MONGODB_URI) {
    warnings.push(
      'MONGODB_URI is not set, so the server will try a MongoDB on this machine. ' +
      'On a hosting platform that is almost certainly not what you want.'
    )
  }
  if (!env.APP_BASE_URL) {
    warnings.push(
      'APP_BASE_URL is not set. Unsubscribe links and public quote links are built from it, ' +
      'so clients will not be able to open anything you send them.'
    )
  }

  return { problems, warnings, ok: problems.length === 0 }
}

/* Prints the result and returns whether the process may continue. */
function reportConfig(result = checkConfig()) {
  for (const w of result.warnings) console.warn(`[config] warning: ${w}`)
  if (result.ok) return true

  console.error('\n[config] The server will not start until these are fixed:\n')
  for (const p of result.problems) console.error(`  • ${p}`)
  console.error('')
  return false
}

/* A seeded admin with a password written in the repository is a published
 * credential. When none is supplied, mint a random one and print it once. */
function resolveSeedPassword(env = process.env) {
  if (env.SEED_ADMIN_PASSWORD) return { password: env.SEED_ADMIN_PASSWORD, generated: false }
  return { password: crypto.randomBytes(12).toString('base64url'), generated: true }
}

module.exports = { checkConfig, reportConfig, resolveSeedPassword, MIN_SECRET_LENGTH, generateSecretHint }
