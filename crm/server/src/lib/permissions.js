/* Access rights.
 *
 * A role is a preset, not a cage: it sets sensible defaults, and any single
 * permission can be overridden per user. That way a team lead who should also
 * be able to approve quotes does not have to become a full admin.
 *
 * Two rules keep this from becoming a way to escalate:
 *   - You can never grant a permission you do not hold yourself.
 *   - You can never change your own role or permissions.
 * Admins hold everything, so they can grant anything — and the last admin
 * cannot be demoted or deactivated, or the account would lock itself out.
 */

const PERMISSIONS = [
  {
    group: 'Contacts and companies',
    items: [
      { key: 'contacts.viewAll', label: 'See everyone\'s contacts', description: 'Without this, a person only sees contacts assigned to them.' },
      { key: 'contacts.edit', label: 'Create and edit contacts', description: 'Add contacts and companies, and change their details.' },
      { key: 'contacts.import', label: 'Import from CSV', description: 'Bulk-load contact lists.' },
      { key: 'contacts.export', label: 'Export to CSV', description: 'Download contact data. Worth withholding from people who should not be able to walk out with the list.' },
      { key: 'contacts.delete', label: 'Delete contacts and companies', description: 'Permanent, including their whole timeline.' },
      { key: 'records.merge', label: 'Merge duplicates', description: 'Combine two records into one. Cannot be undone.' },
    ],
  },
  {
    group: 'Deals and quotes',
    items: [
      { key: 'deals.viewAll', label: 'See the whole pipeline', description: 'Without this, a person only sees deals they own.' },
      { key: 'deals.editAny', label: 'Edit anyone\'s deal', description: 'Otherwise a person can only change deals they own.' },
      { key: 'deals.delete', label: 'Delete deals', description: 'Permanent.' },
      { key: 'quotes.approve', label: 'Approve quotes', description: 'Clear quotes that breached a discount, floor-price or value rule. The point of the rule is that the person who built the quote cannot wave it through.' },
      { key: 'products.manage', label: 'Edit the rate card', description: 'List prices, floor prices and costs — the controls that protect margin.' },
    ],
  },
  {
    group: 'Outreach',
    items: [
      { key: 'campaigns.manage', label: 'Build campaigns', description: 'Create and edit campaigns, stages and message templates.' },
      { key: 'suppression.manage', label: 'Manage the do-not-contact list', description: 'Add and remove suppression entries.' },
    ],
  },
  {
    group: 'Insight and administration',
    items: [
      { key: 'reports.viewTeam', label: 'See team-wide reports', description: 'Without this, reports show only that person\'s own numbers.' },
      { key: 'settings.manage', label: 'Manage settings', description: 'Company details, compliance, pipeline stages, currencies, custom fields and quote rules.' },
      { key: 'users.manage', label: 'Manage users', description: 'Add people and set what they can do. Nobody can grant a right they do not hold themselves.' },
    ],
  },
]

const ALL_KEYS = PERMISSIONS.flatMap((g) => g.items.map((i) => i.key))
const PERMISSION_INDEX = new Map(
  PERMISSIONS.flatMap((g) => g.items.map((i) => [i.key, { ...i, group: g.group }]))
)

/* Role presets. Admin is deliberately absent — an admin holds everything by
   definition, and making that a list invites someone to edit a hole into it. */
const ROLE_PRESETS = {
  manager: {
    label: 'Manager',
    description: 'Runs a team: sees everything, approves quotes, builds campaigns. Cannot change settings or users.',
    permissions: [
      'contacts.viewAll', 'contacts.edit', 'contacts.import', 'contacts.export',
      'contacts.delete', 'records.merge',
      'deals.viewAll', 'deals.editAny', 'quotes.approve',
      'campaigns.manage', 'suppression.manage', 'reports.viewTeam',
    ],
  },
  rep: {
    label: 'Rep',
    description: 'Works their own book. Sees the shared pipeline but edits only their own deals.',
    permissions: ['contacts.edit', 'deals.viewAll'],
  },
  viewer: {
    label: 'Read-only',
    description: 'Sees everything, changes nothing. Useful for a trainee, an auditor, or someone working their notice.',
    /* Read-only has to include the *viewing* rights or it is not read-only,
       it is no-access: without contacts.viewAll the contact list renders
       empty, which looks like a broken account rather than a deliberate one. */
    permissions: ['contacts.viewAll', 'deals.viewAll', 'reports.viewTeam'],
  },
}

const ROLES = ['admin', ...Object.keys(ROLE_PRESETS)]

function roleDefaults(role) {
  if (role === 'admin') return new Set(ALL_KEYS)
  return new Set(ROLE_PRESETS[role]?.permissions || [])
}

/* Does this user hold this right?
 * An admin always does — the escape hatch must not be closable. */
function can(user, key) {
  if (!user || !user.active) return false
  if (user.role === 'admin') return true

  const override = user.permissions ? user.permissions[key] : undefined
  if (override === true) return true
  if (override === false) return false
  return roleDefaults(user.role).has(key)
}

/* The full picture for one user, with where each answer came from — so the
 * admin screen can show "on because of the role" separately from "turned on
 * for this person". */
function effectivePermissions(user) {
  const defaults = roleDefaults(user?.role)
  const overrides = (user && user.permissions) || {}
  const out = {}
  for (const key of ALL_KEYS) {
    const fromRole = user?.role === 'admin' ? true : defaults.has(key)
    const override = overrides[key]
    out[key] = {
      granted: user?.role === 'admin' ? true : override === undefined ? fromRole : override,
      fromRole,
      overridden: user?.role !== 'admin' && override !== undefined && override !== fromRole,
      locked: user?.role === 'admin',
    }
  }
  return out
}

// Flat map for the client: { 'contacts.export': true, ... }
function permissionMap(user) {
  const out = {}
  for (const key of ALL_KEYS) out[key] = can(user, key)
  return out
}

/* Keeps only real keys, and drops overrides that match the role default —
   storing "same as the role" would freeze a user's rights the next time the
   role preset changes. */
function sanitizeOverrides(role, submitted) {
  const defaults = roleDefaults(role)
  const out = {}
  for (const [key, value] of Object.entries(submitted || {})) {
    if (!PERMISSION_INDEX.has(key)) continue
    const wanted = !!value
    if (wanted === defaults.has(key)) continue
    out[key] = wanted
  }
  return out
}

/* Which of these rights the granter cannot hand out, because they do not hold
   them. Privilege escalation is the failure mode a permissions system exists
   to prevent, so it is checked on the server every time. */
function ungrantable(granter, role, overrides) {
  if (granter.role === 'admin') return []
  const wanted = new Set([...roleDefaults(role)])
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value) wanted.add(key)
    else wanted.delete(key)
  }
  return [...wanted].filter((key) => !can(granter, key))
}

function describe(key) {
  return PERMISSION_INDEX.get(key) || { key, label: key, description: '' }
}

module.exports = {
  PERMISSIONS, ALL_KEYS, ROLES, ROLE_PRESETS,
  can, effectivePermissions, permissionMap,
  roleDefaults, sanitizeOverrides, ungrantable, describe,
}
