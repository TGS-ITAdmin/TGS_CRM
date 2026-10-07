import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../contexts/AuthContext.jsx'
import { useToast } from '../components/Toast.jsx'
import { Confirm, Empty, Field, Loading, Modal } from '../components/ui.jsx'
import { dateTime, TIMEZONES } from '../components/format.js'
import { notificationPermission, requestNotificationPermission } from '../components/useReminders.js'

export default function Settings() {
  const { can } = useAuth()
  /* Each entry asks for the right it actually needs, so a manager who can run
     users but not settings sees exactly one of them. */
  const settingsAdmin = can('settings.manage')

  /* Grouped down the side rather than a strip of tabs: eleven tabs across the
     top needed horizontal scrolling, which made half of them unreachable
     without knowing they were there. */
  const groups = [
    {
      label: 'You',
      items: [
        { key: 'profile', label: 'My profile', hint: 'Name, timezone, calendar, notifications' },
        { key: 'email', label: 'Email sending', hint: 'Your mailbox and the shared one' },
      ],
    },
    {
      label: 'Sales process',
      items: [
        ...(settingsAdmin ? [{ key: 'pipeline', label: 'Pipeline', hint: 'Deal stages and win probability' }] : []),
        ...(settingsAdmin ? [{ key: 'currencies', label: 'Currencies', hint: 'Rates and reporting currency' }] : []),
        ...(settingsAdmin ? [{ key: 'quotes', label: 'Quote approvals', hint: 'When a quote needs sign-off' }] : []),
      ],
    },
    {
      label: 'Your data',
      items: [
        ...(settingsAdmin ? [{ key: 'fields', label: 'Custom fields', hint: 'Add fields to any record' }] : []),
        ...(settingsAdmin ? [{ key: 'statuses', label: 'Contact statuses', hint: 'The lifecycle list' }] : []),
        { key: 'dnc', label: 'Do Not Contact', hint: 'Suppression list' },
      ],
    },
    {
      label: 'Team',
      items: [
        ...(can('users.manage') ? [{ key: 'users', label: 'Users & access', hint: 'Who can do what' }] : []),
      ],
    },
    {
      label: 'Company',
      items: [
        ...(settingsAdmin ? [{ key: 'company', label: 'Company & compliance', hint: 'Address, opt-out, branding' }] : []),
        ...(settingsAdmin ? [{ key: 'system', label: 'System', hint: 'Stage engine and the public form' }] : []),
      ],
    },
  ].filter((g) => g.items.length > 0)

  const [tab, setTab] = useState('profile')
  const current = groups.flatMap((g) => g.items).find((i) => i.key === tab)

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Settings</h1>
          <div className="topbar-sub">{current?.hint || 'Your profile, email delivery, compliance and team'}</div>
        </div>
      </div>
      <div className="page">
        <div className="settings-layout">
          <nav className="settings-nav">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="nav-group-label">{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    className={`nav-item${tab === item.key ? ' active' : ''}`}
                    style={{ width: '100%', border: 0, background: 'none', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => setTab(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div style={{ minWidth: 0 }}>
            {tab === 'profile' && <Profile />}
            {tab === 'email' && <EmailSettings />}
            {tab === 'pipeline' && <PipelineStages />}
            {tab === 'currencies' && <Currencies />}
            {tab === 'quotes' && <QuoteApproval />}
            {tab === 'fields' && <CustomFields />}
            {tab === 'statuses' && <Statuses />}
            {tab === 'dnc' && <DncList />}
            {tab === 'users' && <Users />}
            {tab === 'company' && <Company />}
            {tab === 'system' && <System />}
          </div>
        </div>
      </div>
    </>
  )
}

/* ---------------- Profile ---------------- */

function Profile() {
  const { user, refreshUser } = useAuth()
  const toast = useToast()
  const [form, setForm] = useState({
    name: user.name, timezone: user.timezone, notificationsEnabled: user.notificationsEnabled,
    calendarEmbedUrl: user.calendarEmbedUrl || '',
  })
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [notif, setNotif] = useState(notificationPermission())
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await api.updateMe(form)
      await refreshUser()
      toast.success('Profile saved')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function changePassword() {
    if (pw.newPassword !== pw.confirm) return toast.error('The two new passwords do not match')
    setBusy(true)
    try {
      await api.changePassword({ currentPassword: pw.currentPassword, newPassword: pw.newPassword })
      setPw({ currentPassword: '', newPassword: '', confirm: '' })
      toast.success('Password changed')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      {user.mustChangePassword && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>You are still on the password you were given. Change it below.</div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Profile</h2></div>
        <div className="card-body">
          <Field label="Name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email"><input className="input" value={user.email} disabled /></Field>
          <Field label="Your timezone" hint="Dates across the app are shown in this zone. The call list compares it against each contact's local time.">
            <select className="select" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
          <Field
            label="My calendar link"
            hint="Paste the embed link from Google Calendar (Settings → Integrate calendar) or a published Outlook calendar. Pasting the whole <iframe> snippet works too. It is read-only — the CRM never reads your events."
          >
            <input className="input" value={form.calendarEmbedUrl}
              placeholder="https://calendar.google.com/calendar/embed?src=…"
              onChange={(e) => setForm({ ...form, calendarEmbedUrl: e.target.value })} />
          </Field>

          <label className="row small" style={{ marginBottom: 12 }}>
            <input type="checkbox" className="checkbox" checked={form.notificationsEnabled}
              onChange={(e) => setForm({ ...form, notificationsEnabled: e.target.checked })} />
            Show browser notifications when work becomes due
          </label>
          {form.notificationsEnabled && notif !== 'granted' && (
            <div className="banner banner-info">
              <span>🔔</span>
              <div style={{ flex: 1 }}>
                {notif === 'denied'
                  ? 'Your browser is blocking notifications for this site. Allow them in your browser settings to receive them.'
                  : 'Your browser has not been asked for permission yet.'}
              </div>
              {notif === 'default' && (
                <button className="btn btn-sm" onClick={async () => setNotif(await requestNotificationPermission())}>
                  Allow
                </button>
              )}
            </div>
          )}
          <button className="btn btn-primary" onClick={save} disabled={busy}>Save profile</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Change password</h2></div>
        <div className="card-body">
          <Field label="Current password">
            <input className="input" type="password" value={pw.currentPassword} autoComplete="current-password"
              onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          </Field>
          <div className="grid grid-2">
            <Field label="New password" hint="At least 8 characters.">
              <input className="input" type="password" value={pw.newPassword} autoComplete="new-password"
                onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
            </Field>
            <Field label="Confirm new password">
              <input className="input" type="password" value={pw.confirm} autoComplete="new-password"
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </Field>
          </div>
          <button className="btn" onClick={changePassword}
            disabled={busy || !pw.currentPassword || pw.newPassword.length < 8}>
            Change password
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Email / SMTP ---------------- */

function SmtpForm({ value, onChange }) {
  const set = (k) => (e) =>
    onChange({ ...value, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  return (
    <>
      <div className="grid grid-2">
        <Field label="SMTP host"><input className="input" value={value.host || ''} onChange={set('host')} placeholder="smtp.gmail.com" /></Field>
        <Field label="Port"><input className="input" type="number" value={value.port || 587} onChange={set('port')} /></Field>
        <Field label="Username"><input className="input" value={value.user || ''} onChange={set('user')} placeholder="you@yourcompany.com" /></Field>
        <Field label="Password" hint={value.hasPassword ? 'A password is already saved. Leave blank to keep it.' : 'For Google Workspace use an App Password, not your login password.'}>
          <input className="input" type="password" value={value.pass || ''} onChange={set('pass')} placeholder={value.hasPassword ? '••••••••' : ''} />
        </Field>
        <Field label="From name"><input className="input" value={value.fromName || ''} onChange={set('fromName')} placeholder="Jane at TGS BPO" /></Field>
        <Field label="From address" hint="Leave blank to use the username."><input className="input" value={value.fromEmail || ''} onChange={set('fromEmail')} /></Field>
      </div>
      <label className="row small" style={{ marginBottom: 12 }}>
        <input type="checkbox" className="checkbox" checked={!!value.secure} onChange={set('secure')} />
        Use TLS on connect (port 465). Leave off for STARTTLS on port 587.
      </label>
    </>
  )
}

function EmailSettings() {
  const { user, can, reloadBootstrap } = useAuth()
  const isAdmin = can('settings.manage')
  const toast = useToast()
  const [mine, setMine] = useState({ ...(user.smtp || {}), pass: '' })
  const [shared, setShared] = useState({ port: 587, pass: '' })
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.smtpStatus().then(setStatus).catch(() => {}) }, [])

  async function save(scope) {
    setBusy(true)
    try {
      if (scope === 'mine') await api.saveMySmtp(mine)
      else await api.saveSharedSmtp(shared)
      setStatus(await api.smtpStatus())
      await reloadBootstrap()
      toast.success('Saved')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function test(scope) {
    setBusy(true)
    try {
      const res = await api.testSmtp(scope)
      toast.success(res.message)
    } catch (err) {
      toast.error(err.message, 'Could not connect')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      {status?.complianceBlocked && (
        <div className="banner banner-danger">
          <span>⛔</span>
          <div><strong>Sending is blocked.</strong> {status.complianceBlocked}</div>
        </div>
      )}
      {status && !status.configured && !status.complianceBlocked && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            No mail server is connected. Drafts still queue in Ready to Send and show exactly what would go
            out — they just cannot actually be delivered yet.
          </div>
        </div>
      )}
      {status?.configured && (
        <div className="banner banner-ok">
          <span>✓</span>
          <div>Sending as <strong>{status.from}</strong> ({status.source === 'user' ? 'your own mailbox' : 'the shared company mailbox'}).</div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>My mailbox</h2></div>
        <div className="card-body">
          <p className="small muted">
            Sending from your own inbox gives the best deliverability and means replies come straight back to
            you. This overrides the shared company mailbox for anything you send.
          </p>
          <SmtpForm value={mine} onChange={setMine} />
          <div className="row">
            <button className="btn btn-primary" onClick={() => save('mine')} disabled={busy}>Save</button>
            <button className="btn" onClick={() => test('mine')} disabled={busy}>Test connection</button>
          </div>
        </div>
      </div>

      {isAdmin && (
        <div className="card">
          <div className="card-head"><h2>Shared company mailbox</h2></div>
          <div className="card-body">
            <p className="small muted">
              A fallback used by anyone who has not set up their own. Everything sends from one address, so
              the whole team shares its sender reputation — fine to start with, worth moving off later.
            </p>
            <SmtpForm value={shared} onChange={setShared} />
            <div className="row">
              <button className="btn btn-primary" onClick={() => save('shared')} disabled={busy}>Save</button>
              <button className="btn" onClick={() => test('shared')} disabled={busy}>Test connection</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- Company & compliance ---------------- */

function Company() {
  const { reloadBootstrap } = useAuth()
  const toast = useToast()
  const [settings, setSettings] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.getSettings().then((d) => setSettings(d.settings)).catch(() => {}) }, [])
  if (!settings) return <Loading />

  const set = (k) => (e) =>
    setSettings({ ...settings, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  async function save() {
    setBusy(true)
    try {
      await api.saveSettings({
        companyName: settings.companyName,
        physicalAddress: settings.physicalAddress,
        unsubscribeText: settings.unsubscribeText,
        appBaseUrl: settings.appBaseUrl,
        publicFormEnabled: settings.publicFormEnabled,
      })
      await reloadBootstrap()
      toast.success('Settings saved')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const ready = settings.physicalAddress?.trim() && settings.appBaseUrl?.trim()

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className={`banner ${ready ? 'banner-ok' : 'banner-danger'}`}>
        <span>{ready ? '✓' : '⛔'}</span>
        <div>
          {ready
            ? 'Compliance details are complete. Every outgoing email carries your address and a working unsubscribe link.'
            : 'Until both a postal address and an app base URL are set, all email sending is refused. This is deliberate — cold email without a valid address and a working opt-out is unlawful in most markets and gets domains blacklisted.'}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Company</h2></div>
        <div className="card-body">
          <Field label="Company name" hint="Appears in the email footer and on the unsubscribe page.">
            <input className="input" value={settings.companyName} onChange={set('companyName')} />
          </Field>
          <Field label="Physical postal address" hint="Required by CAN-SPAM and equivalent rules. A real, verifiable address — not a PO box you don't own.">
            <textarea className="textarea" style={{ minHeight: 70 }} value={settings.physicalAddress}
              onChange={set('physicalAddress')} placeholder="Unit 5, 12 Example Street, Makati City, 1229, Philippines" />
          </Field>
          <Field label="App base URL" hint="Where this CRM is reachable from the public internet. Unsubscribe links are built from it, so a wrong value means dead opt-out links.">
            <input className="input" value={settings.appBaseUrl} onChange={set('appBaseUrl')}
              placeholder="https://crm.tgsbpo.com" />
          </Field>
          <Field label="Unsubscribe wording">
            <input className="input" value={settings.unsubscribeText} onChange={set('unsubscribeText')} />
          </Field>
          <label className="row small" style={{ marginBottom: 12 }}>
            <input type="checkbox" className="checkbox" checked={settings.publicFormEnabled} onChange={set('publicFormEnabled')} />
            Accept inbound contacts from the public web form
          </label>
          <button className="btn btn-primary" onClick={save} disabled={busy}>Save</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Email footer preview</h2></div>
        <div className="card-body">
          <div className="script-box">
            {`[your message]

---
${settings.companyName || '[company name]'}
${settings.physicalAddress || '[postal address — required]'}

${settings.unsubscribeText || 'Opt out:'} ${(settings.appBaseUrl || '[app base url]').replace(/\/+$/, '')}/u/[unique-token]`}
          </div>
          <div className="hint">Appended automatically at send time. It cannot be edited out of a template.</div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Contact statuses ---------------- */

function Statuses() {
  const { reloadBootstrap } = useAuth()
  const toast = useToast()
  const [settings, setSettings] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.getSettings().then((d) => setSettings(d.settings)).catch(() => {}) }, [])
  if (!settings) return <Loading />

  const list = settings.contactStatuses
  const patch = (i, key, value) =>
    setSettings({
      ...settings,
      contactStatuses: list.map((s, j) => (j === i ? { ...s, [key]: value } : s)),
    })

  return (
    <div className="card">
      <div className="card-head"><h2 style={{ flex: 1 }}>Contact statuses</h2></div>
      <div className="card-body">
        <p className="small muted">
          Renaming a status is safe — contacts store the value, and the label is what you see. Changing the{' '}
          <em>value</em> of a status already in use orphans those contacts, so only do it before you have data.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Label</th><th>Value</th><th style={{ width: 70 }}>Colour</th><th /></tr></thead>
            <tbody>
              {list.map((s, i) => (
                <tr key={i}>
                  <td><input className="input" value={s.label} onChange={(e) => patch(i, 'label', e.target.value)} /></td>
                  <td><input className="input mono" value={s.value} onChange={(e) => patch(i, 'value', e.target.value)} /></td>
                  <td><input type="color" value={s.color} style={{ width: 44, height: 30, border: 0, background: 'none' }}
                    onChange={(e) => patch(i, 'color', e.target.value)} /></td>
                  <td className="right">
                    <button className="btn btn-ghost btn-sm" disabled={list.length <= 1}
                      onClick={() => setSettings({ ...settings, contactStatuses: list.filter((_, j) => j !== i) })}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-sm"
            onClick={() => setSettings({
              ...settings,
              contactStatuses: [...list, { value: `status_${list.length}`, label: 'New status', color: '#64748b', funnelOrder: list.length }],
            })}>
            + Add status
          </button>
          <div className="spacer" />
          <button className="btn btn-primary" disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await api.saveSettings({ contactStatuses: settings.contactStatuses })
                await reloadBootstrap()
                toast.success('Statuses saved')
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            Save statuses
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Do Not Contact ---------------- */

function DncList() {
  const { can } = useAuth()
  const isAdmin = can('suppression.manage')
  const toast = useToast()
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)

  async function load(query = '') {
    try { setData(await api.listSuppressions(query)) } catch (err) { toast.error(err.message) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="banner banner-info">
        <span>ℹ</span>
        <div>
          Every entry here is checked twice — when a draft is queued and again the moment before it is sent.
          Unsubscribes land here automatically. Adding an entry also flags any matching contacts and cancels
          their pending work.
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>Do-not-contact list</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Add</button>
        </div>
        <div className="card-body tight">
          <div className="row" style={{ padding: '8px 0' }}>
            <input className="input" style={{ maxWidth: 280 }} placeholder="Search email, domain or LinkedIn URL"
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load(q)} />
            <button className="btn btn-sm" onClick={() => load(q)}>Search</button>
          </div>
        </div>
        {!data ? <Loading /> : data.items.length === 0 ? (
          <Empty icon="🛡" title="Nothing suppressed yet">
            Unsubscribes and manual blocks appear here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Entry</th><th>Reason</th><th>Added</th><th>By</th>{isAdmin && <th />}</tr></thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s._id}>
                    <td className="mono small">{s.email || (s.domain && `@${s.domain}`) || s.linkedinUrl}</td>
                    <td className="small">{s.reason}{s.note ? ` — ${s.note}` : ''}</td>
                    <td className="small faint nowrap">{dateTime(s.createdAt)}</td>
                    <td className="small faint">{s.addedBy?.name || 'automatic'}</td>
                    {isAdmin && (
                      <td className="right">
                        <button className="btn btn-ghost btn-sm" onClick={() => setRemoving(s)}>Remove</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <AddSuppression onClose={() => setAdding(false)} onAdded={() => { setAdding(false); load(q) }} />}
      {removing && (
        <Confirm
          danger title="Remove from the do-not-contact list"
          confirmLabel="Remove entry"
          message={`This allows email to ${removing.email || removing.domain || removing.linkedinUrl} again. If they unsubscribed, removing this without their explicit request is a compliance breach — and the contact record stays flagged separately.`}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await api.removeSuppression(removing._id)
              toast.success('Removed')
              setRemoving(null)
              load(q)
            } catch (err) { toast.error(err.message) }
          }}
        />
      )}
    </div>
  )
}

function AddSuppression({ onClose, onAdded }) {
  const toast = useToast()
  const [form, setForm] = useState({ email: '', domain: '', linkedinUrl: '', note: '' })
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      title="Add to do-not-contact" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || (!form.email && !form.domain && !form.linkedinUrl)}
            onClick={async () => {
              setBusy(true)
              try {
                const res = await api.addSuppression(form)
                toast.success(res.contactsFlagged ? `Added — ${res.contactsFlagged} matching contact(s) flagged` : 'Added')
                onAdded()
              } catch (err) { toast.error(err.message) } finally { setBusy(false) }
            }}>
            Add
          </button>
        </>
      }
    >
      <Field label="Email address"><input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      <Field label="Or a whole domain" hint="Blocks every address at that domain — useful for competitors and companies that asked to be left alone entirely.">
        <input className="input" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="example.com" />
      </Field>
      <Field label="Or a LinkedIn URL"><input className="input" value={form.linkedinUrl} onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })} /></Field>
      <Field label="Note"><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why?" /></Field>
    </Modal>
  )
}

/* ---------------- Users ---------------- */

function Users() {
  const toast = useToast()
  const { reloadBootstrap, user: me } = useAuth()
  const [data, setData] = useState(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)

  const load = async () => {
    try { setData(await api.listUsers()) } catch (err) { toast.error(err.message) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Loading />

  const { users, roles, permissions, grantable, campaigns = [], grantableCampaigns = null } = data
  const roleLabel = (value) => roles.find((r) => r.value === value)?.label || value
  const activeAdmins = users.filter((u) => u.role === 'admin' && u.active).length

  // How many rights differ from this person's role preset.
  const overrideCount = (u) => Object.keys(u.permissions || {}).length

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="banner banner-info">
        <span>ℹ</span>
        <div>
          A role is a starting point, not a cage — you can switch any single right on or off for
          one person. Changes take effect on their next request; nobody has to sign out and back in.
        </div>
      </div>

      {activeAdmins === 1 && (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            There is only one admin. If that account is lost, nobody can manage users, settings or
            approve quotes. Make a second person an admin.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>People</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Add user</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Name</th><th>Role</th><th>Access</th><th>Timezone</th><th>Last login</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td>
                    <span className="strong">{u.name}</span>
                    {!u.active && <span className="tag" style={{ marginLeft: 6 }}>deactivated</span>}
                    {u.id === me.id && <span className="tag" style={{ marginLeft: 6 }}>you</span>}
                    <div className="small faint">{u.email}</div>
                  </td>
                  <td><span className="pill">{roleLabel(u.role)}</span></td>
                  <td className="small">
                    {u.role === 'admin' ? (
                      <span className="faint">Everything</span>
                    ) : overrideCount(u) === 0 ? (
                      <span className="faint">Role defaults</span>
                    ) : (
                      <span style={{ color: 'var(--accent)' }}>
                        {overrideCount(u)} change{overrideCount(u) === 1 ? '' : 's'} from the role
                      </span>
                    )}
                  </td>
                  <td className="small faint">{u.timezone}</td>
                  <td className="small faint nowrap">{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'never'}</td>
                  <td className="right nowrap">
                    <button className="btn btn-sm" onClick={() => setEditing(u)}>Edit access</button>
                    {u.active && u.id !== me.id && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setRemoving(u)}>✕</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>What each role can do</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Right</th>
                {roles.map((r) => <th key={r.value} className="center">{r.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {permissions.map((group) => (
                <Fragment key={group.group}>
                  <tr>
                    <td colSpan={roles.length + 1} style={{ background: 'var(--surface-2)', fontWeight: 640, fontSize: 12 }}>
                      {group.group}
                    </td>
                  </tr>
                  {group.items.map((item) => (
                    <tr key={item.key}>
                      <td>
                        <span className="strong">{item.label}</span>
                        <div className="small faint">{item.description}</div>
                      </td>
                      {roles.map((r) => (
                        <td key={r.value} className="center">
                          {r.permissions.includes(item.key)
                            ? <span style={{ color: 'var(--ok)' }}>✓</span>
                            : <span className="faint">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(adding || editing) && (
        <UserModal
          user={editing} roles={roles} permissions={permissions} grantable={grantable} me={me}
          campaigns={campaigns} grantableCampaigns={grantableCampaigns}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={async () => { setAdding(false); setEditing(null); await load(); await reloadBootstrap() }}
        />
      )}

      {removing && (
        <Confirm
          danger title={`Deactivate ${removing.name}`} confirmLabel="Deactivate"
          message="They can no longer sign in. The account is kept rather than deleted, so the contacts, deals and history they own stay attached to a name instead of becoming orphaned."
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              const res = await api.removeUser(removing.id)
              toast.success(res.note || 'Deactivated')
              setRemoving(null)
              load()
            } catch (err) { toast.error(err.message) }
          }}
        />
      )}
    </div>
  )
}

/* Sits under the "Add and move contacts in campaigns" right: all campaigns,
 * or only the ones ticked. A granter who is limited themselves only sees
 * (and can only hand out) their own campaigns. */
function CampaignAccess({ campaigns, grantableCampaigns, mode, setMode, allowed, setAllowed, disabled }) {
  const restrictedGranter = Array.isArray(grantableCampaigns)
  const visible = restrictedGranter
    ? campaigns.filter((c) => grantableCampaigns.includes(c.id))
    : campaigns

  function toggleCampaign(id) {
    setAllowed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div style={{
      margin: '8px 0 4px 26px', padding: '10px 12px',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)',
    }}>
      <div className="small strong" style={{ marginBottom: 6 }}>Which campaigns?</div>
      <label className="row small" style={{ gap: 8, marginBottom: 4, opacity: restrictedGranter ? 0.5 : 1 }}>
        <input type="radio" name="campaign-scope" checked={mode === 'all'}
          disabled={disabled || restrictedGranter} onChange={() => setMode('all')} />
        All campaigns, including ones created later
      </label>
      <label className="row small" style={{ gap: 8 }}>
        <input type="radio" name="campaign-scope" checked={mode === 'some'}
          disabled={disabled} onChange={() => setMode('some')} />
        Only the campaigns ticked below
      </label>
      {restrictedGranter && (
        <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>
          You are limited to specific campaigns yourself, so you can only hand out those.
        </div>
      )}

      {mode === 'some' && (
        visible.length === 0 ? (
          <div className="small muted" style={{ marginTop: 8 }}>No campaigns exist yet.</div>
        ) : (
          <div style={{ marginTop: 8, maxHeight: 200, overflowY: 'auto', paddingLeft: 4 }}>
            {visible.map((c) => (
              <label key={c.id} className="row small" style={{ gap: 8, padding: '3px 0', cursor: 'pointer' }}>
                <input type="checkbox" className="checkbox" checked={allowed.has(c.id)}
                  disabled={disabled} onChange={() => toggleCampaign(c.id)} />
                <span>{c.name}</span>
                {!c.active && <span className="small faint">(paused)</span>}
              </label>
            ))}
          </div>
        )
      )}
    </div>
  )
}

function UserModal({ user, roles, permissions, grantable, me, campaigns = [], grantableCampaigns = null, onClose, onSaved }) {
  const toast = useToast()
  const isSelf = user && user.id === me.id
  const [form, setForm] = useState({
    name: user?.name || '', email: user?.email || '', password: '',
    role: user?.role || 'rep', timezone: user?.timezone || 'Asia/Manila',
    active: user ? user.active : true,
  })
  // Overrides are held as a sparse map, exactly as the server stores them.
  const [overrides, setOverrides] = useState({ ...(user?.permissions || {}) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Campaign limit for 'campaigns.enroll'. An empty stored list means "all".
  const restrictedGranter = Array.isArray(grantableCampaigns)
  const [campaignMode, setCampaignMode] = useState(
    (user?.allowedCampaigns || []).length || restrictedGranter ? 'some' : 'all'
  )
  const [allowedCampaigns, setAllowedCampaigns] = useState(new Set(user?.allowedCampaigns || []))

  const rolePreset = roles.find((r) => r.value === form.role)
  const grantableSet = new Set(grantable)
  const isAdminRole = form.role === 'admin'

  // Switching role makes overrides meaningless — they were relative to the old
  // preset — so clear them, which is what the server does too.
  function setRole(role) {
    setForm((f) => ({ ...f, role }))
    setOverrides({})
  }

  const effective = (key) => {
    if (isAdminRole) return true
    if (key in overrides) return overrides[key]
    return rolePreset?.permissions.includes(key) ?? false
  }

  function toggle(key) {
    const fromRole = rolePreset?.permissions.includes(key) ?? false
    const next = !effective(key)
    setOverrides((o) => {
      const copy = { ...o }
      if (next === fromRole) delete copy[key]
      else copy[key] = next
      return copy
    })
  }

  // Only sent when the right is on: there is nothing to limit otherwise.
  const sendsCampaigns = !isAdminRole && effective('campaigns.enroll')
  const campaignPayload = campaignMode === 'all' ? [] : [...allowedCampaigns]

  async function save() {
    if (sendsCampaigns && campaignMode === 'some' && allowedCampaigns.size === 0) {
      setError('Tick at least one campaign, or choose "All campaigns".')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (user) {
        const body = { name: form.name, timezone: form.timezone, active: form.active }
        if (form.password) body.password = form.password
        if (!isSelf) {
          body.role = form.role
          body.permissions = overrides
          if (sendsCampaigns) body.allowedCampaigns = campaignPayload
        }
        await api.updateUser(user.id, body)
      } else {
        await api.createUser({
          ...form,
          permissions: overrides,
          ...(sendsCampaigns ? { allowedCampaigns: campaignPayload } : {}),
        })
      }
      toast.success(user ? 'Access updated' : 'User added')
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally { setBusy(false) }
  }

  const changedCount = Object.keys(overrides).length

  return (
    <Modal
      title={user ? `Access for ${user.name}` : 'Add a user'} width="wide" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary"
            disabled={busy || !form.name || (!user && (!form.email || form.password.length < 8))}
            onClick={save}>
            {busy ? 'Saving…' : user ? 'Save access' : 'Add user'}
          </button>
        </>
      }
    >
      {error && <div className="banner banner-danger">{error}</div>}

      <div className="grid grid-2">
        <Field label="Name"><input className="input" value={form.name} autoFocus
          onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email">
          <input className="input" type="email" value={form.email} disabled={!!user}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label={user ? 'Set a new password' : 'Password'}
          hint={user ? 'Leave blank to keep their current one.' : 'At least 8 characters. They are asked to change it on first sign-in.'}>
          <input className="input" type="password" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Timezone">
          <select className="select" value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </Field>
      </div>

      {isSelf ? (
        <div className="banner banner-warn">
          <span>⚠</span>
          <div>
            This is your own account, so you cannot change your own role or rights. Ask another
            admin — it is what stops a permissions system being walked around from the inside.
          </div>
        </div>
      ) : (
        <>
          <div className="divider" />
          <Field label="Role" hint={rolePreset?.description}>
            <select className="select" value={form.role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.value} value={r.value}
                  disabled={r.value === 'admin' && !grantableSet.has('users.manage')}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>

          {isAdminRole ? (
            <div className="banner banner-warn">
              <span>⚠</span>
              <div>
                An admin can do everything, including changing anyone else's access. There is no
                way to take a single right away from an admin — that is what makes it the escape
                hatch if something is misconfigured.
              </div>
            </div>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <h3 style={{ flex: 1 }}>Individual rights</h3>
                {changedCount > 0 && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setOverrides({})}>
                    Reset to the {rolePreset?.label} defaults
                  </button>
                )}
              </div>
              {changedCount > 0 && (
                <div className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
                  {changedCount} right{changedCount === 1 ? '' : 's'} differ from the role.
                </div>
              )}

              {permissions.map((group) => (
                <div key={group.group} style={{ marginBottom: 14 }}>
                  <div className="nav-group-label" style={{ padding: '4px 0 2px' }}>{group.group}</div>
                  {group.items.map((item) => {
                    const fromRole = rolePreset?.permissions.includes(item.key) ?? false
                    const on = effective(item.key)
                    const changed = item.key in overrides
                    const canGrant = grantableSet.has(item.key)
                    return (
                      <div key={item.key} style={{
                        padding: '8px 0',
                        borderBottom: '1px solid var(--border)',
                        opacity: canGrant ? 1 : 0.5,
                      }}>
                        <label className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: canGrant ? 'pointer' : 'not-allowed' }}>
                          <input type="checkbox" className="checkbox" checked={on} disabled={!canGrant}
                            style={{ marginTop: 2 }} onChange={() => toggle(item.key)} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="row" style={{ gap: 6 }}>
                              <span className="strong">{item.label}</span>
                              {changed && (
                                <span className="tag" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                                  {on ? 'added' : 'removed'}
                                </span>
                              )}
                              {!changed && fromRole && <span className="small faint">from the role</span>}
                            </div>
                            <div className="small muted">{item.description}</div>
                            {!canGrant && (
                              <div className="small" style={{ color: 'var(--warn)' }}>
                                You do not hold this right, so you cannot give it to anyone.
                              </div>
                            )}
                          </div>
                        </label>
                        {item.key === 'campaigns.enroll' && on && (
                          <CampaignAccess
                            campaigns={campaigns} grantableCampaigns={grantableCampaigns}
                            mode={campaignMode} setMode={setCampaignMode}
                            allowed={allowedCampaigns} setAllowed={setAllowedCampaigns}
                            disabled={!canGrant}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </>
          )}
        </>
      )}

      {user && !isSelf && (
        <label className="row small" style={{ marginTop: 10 }}>
          <input type="checkbox" className="checkbox" checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Active — a deactivated account cannot sign in, but keeps everything it owns
        </label>
      )}
    </Modal>
  )
}

/* ---------------- System ---------------- */

function System() {
  const toast = useToast()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try { setStatus(await api.schedulerStatus()) } catch (err) { toast.error(err.message) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head"><h2>Stage engine</h2></div>
        <div className="card-body">
          <p className="small muted">
            Runs on the server, not in the browser, so contacts advance whether or not anyone has the app open.
            Each run moves every contact whose due date has passed into its next stage, generating the task or
            draft for that stage.
          </p>
          {!status ? <Loading /> : (
            <>
              <div className="small" style={{ marginBottom: 10 }}>
                <div>Schedule: <code className="kbd">{status.cron}</code></div>
                {status.lastRun ? (
                  <div style={{ marginTop: 6 }}>
                    Last run {dateTime(status.lastRun.at)} ({status.lastRun.reason}) —
                    examined {status.lastRun.examined ?? 0}, advanced {status.lastRun.advanced ?? 0},
                    completed {status.lastRun.completed ?? 0}
                    {status.lastRun.error && <span style={{ color: 'var(--danger)' }}> · {status.lastRun.error}</span>}
                  </div>
                ) : (
                  <div className="faint" style={{ marginTop: 6 }}>Has not run yet since the server started.</div>
                )}
              </div>
              <div className="row">
                <button className="btn" disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      const { result } = await api.runScheduler()
                      toast.success(`Advanced ${result.advanced}, completed ${result.completed}`)
                      load()
                    } catch (err) { toast.error(err.message) } finally { setBusy(false) }
                  }}>
                  Run now
                </button>
                <button className="btn btn-ghost" onClick={load}>Refresh</button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Public web form</h2></div>
        <div className="card-body">
          <p className="small muted">
            Post inbound enquiries to this endpoint and they become contacts, round-robin assigned across active
            users. It has a honeypot field and is rate limited to 30 submissions per hour per IP.
          </p>
          <div className="script-box">{`POST {your-app-url}/api/public/contacts
Content-Type: application/json

{
  "firstName": "Jane",
  "lastName": "Cruz",
  "email": "jane@example.com",
  "company": "Example Co",
  "phone": "+63 900 000 0000",
  "seatsNeeded": 25,
  "targetRoles": "Customer support",
  "message": "Tell us what you need",
  "website_confirm": ""   // honeypot — must stay empty
}`}</div>
          <div className="hint">
            Set <code className="kbd">PUBLIC_FORM_TOKEN</code> in the server environment to require a shared
            secret in the request body. Turn the whole endpoint off under Company &amp; compliance.
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Pipeline stages ---------------- */

function PipelineStages() {
  const { reloadBootstrap, dealStages } = useAuth()
  const toast = useToast()
  const [stages, setStages] = useState(dealStages)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const patch = (i, key, value) =>
    setStages(stages.map((s, j) => (j === i ? { ...s, [key]: value } : s)))

  function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= stages.length) return
    const next = [...stages]
    ;[next[i], next[j]] = [next[j], next[i]]
    setStages(next)
  }

  const openCount = stages.filter((s) => s.type === 'open').length
  const wonCount = stages.filter((s) => s.type === 'won').length
  const lostCount = stages.filter((s) => s.type === 'lost').length

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="banner banner-info">
        <span>ℹ</span>
        <div>
          Probability drives the weighted forecast, so it is worth being honest rather than optimistic.
          Won and Lost are stages, not a separate field — a deal is in exactly one place at a time.
        </div>
      </div>
      {error && <div className="banner banner-danger">{error}</div>}

      <div className="card">
        <div className="card-head"><h2 style={{ flex: 1 }}>Deal stages</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th style={{ width: 40 }}>#</th><th>Name</th><th style={{ width: 150 }}>Key</th>
                <th style={{ width: 120 }}>Type</th><th style={{ width: 110 }}>Win %</th>
                <th style={{ width: 70 }}>Colour</th><th style={{ width: 110 }} /></tr>
            </thead>
            <tbody>
              {stages.map((s, i) => (
                <tr key={i}>
                  <td className="faint">{i + 1}</td>
                  <td><input className="input" value={s.name} onChange={(e) => patch(i, 'name', e.target.value)} /></td>
                  <td><input className="input mono" value={s.key} onChange={(e) => patch(i, 'key', e.target.value)} /></td>
                  <td>
                    <select className="select" value={s.type} onChange={(e) => patch(i, 'type', e.target.value)}>
                      <option value="open">Open</option>
                      <option value="won">Won</option>
                      <option value="lost">Lost</option>
                    </select>
                  </td>
                  <td>
                    <input className="input" type="number" min="0" max="100" value={s.probability}
                      onChange={(e) => patch(i, 'probability', Number(e.target.value))} />
                  </td>
                  <td>
                    <input type="color" value={s.color || '#64748b'} style={{ width: 44, height: 30, border: 0, background: 'none' }}
                      onChange={(e) => patch(i, 'color', e.target.value)} />
                  </td>
                  <td className="right nowrap">
                    <button className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button className="btn btn-ghost btn-sm" disabled={i === stages.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button className="btn btn-ghost btn-sm" disabled={stages.length <= 3}
                      onClick={() => setStages(stages.filter((_, j) => j !== i))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body">
          <div className="row">
            <button className="btn btn-sm"
              onClick={() => setStages([...stages, {
                key: `stage_${stages.length}`, name: 'New stage', probability: 50, type: 'open', color: '#64748b',
              }])}>
              + Add stage
            </button>
            <span className="small faint">
              {openCount} open · {wonCount} won · {lostCount} lost
            </span>
            <div className="spacer" />
            <button className="btn btn-primary" disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await api.saveDealStages(stages)
                  await reloadBootstrap()
                  toast.success('Pipeline saved')
                } catch (err) {
                  setError(err.message)
                } finally { setBusy(false) }
              }}>
              {busy ? 'Saving…' : 'Save pipeline'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            Renaming a stage is safe. Changing its <em>key</em>, or removing a stage deals are sitting in,
            is refused until you move those deals — otherwise they would land somewhere the board cannot draw.
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Currencies ---------------- */

function Currencies() {
  const { reloadBootstrap, currencies: initial, reportingCurrency: initialReporting } = useAuth()
  const toast = useToast()
  const [list, setList] = useState(initial)
  const [reporting, setReporting] = useState(initialReporting)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const patch = (i, key, value) => setList(list.map((c, j) => (j === i ? { ...c, [key]: value } : c)))

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="banner banner-warn">
        <span>⚠</span>
        <div>
          These rates are maintained by hand — there is no live feed. A rate is stamped onto each deal when
          it is saved, so updating this table changes future deals and leaves historical numbers alone.
          That is deliberate: last quarter's reported figures should not move because the peso did.
        </div>
      </div>
      {error && <div className="banner banner-danger">{error}</div>}

      <div className="card">
        <div className="card-head"><h2 style={{ flex: 1 }}>Currencies</h2></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th style={{ width: 110 }}>Code</th><th style={{ width: 90 }}>Symbol</th>
                <th>Value of 1 unit in {reporting}</th><th style={{ width: 130 }}>Reporting</th><th style={{ width: 60 }} /></tr>
            </thead>
            <tbody>
              {list.map((c, i) => (
                <tr key={i}>
                  <td><input className="input mono" value={c.code} maxLength={3}
                    onChange={(e) => patch(i, 'code', e.target.value.toUpperCase())} /></td>
                  <td><input className="input" value={c.symbol || ''} maxLength={4}
                    onChange={(e) => patch(i, 'symbol', e.target.value)} /></td>
                  <td>
                    <input className="input" type="number" step="0.0001" min="0" value={c.rate}
                      disabled={c.code === reporting}
                      onChange={(e) => patch(i, 'rate', Number(e.target.value))} />
                    {c.code === reporting && (
                      <div className="small faint" style={{ marginTop: 3 }}>
                        Always 1 — every other rate is expressed against it.
                      </div>
                    )}
                  </td>
                  <td>
                    <label className="row small">
                      <input type="radio" name="reporting" className="checkbox" checked={c.code === reporting}
                        onChange={() => {
                          setReporting(c.code)
                          setList(list.map((x) => (x.code === c.code ? { ...x, rate: 1 } : x)))
                        }} />
                      Report in this
                    </label>
                  </td>
                  <td className="right">
                    <button className="btn btn-ghost btn-sm" disabled={c.code === reporting || list.length <= 1}
                      onClick={() => setList(list.filter((_, j) => j !== i))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body">
          <div className="row">
            <button className="btn btn-sm"
              onClick={() => setList([...list, { code: '', symbol: '', rate: 1 }])}>
              + Add currency
            </button>
            <div className="spacer" />
            <button className="btn btn-primary" disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await api.saveCurrencies(list, reporting)
                  await reloadBootstrap()
                  toast.success('Currencies saved')
                } catch (err) {
                  setError(err.message)
                } finally { setBusy(false) }
              }}>
              {busy ? 'Saving…' : 'Save currencies'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- Quote approval rules ---------------- */

function QuoteApproval() {
  const { reloadBootstrap, reportingCurrency } = useAuth()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.getQuoteApproval().then(setData).catch(() => {}) }, [])
  if (!data) return <Loading />

  const rules = data.quoteApproval || {}
  const patch = (key, value) =>
    setData({ ...data, quoteApproval: { ...rules, [key]: { ...(rules[key] || {}), ...value } } })

  const activeCount = Object.values(rules).filter((r) => r?.enabled).length
  // With "any discount" on, the percentage threshold can never add anything.
  const percentRedundant = rules.anyDiscount?.enabled && rules.discountOver?.enabled

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="banner banner-info">
        <span>ℹ</span>
        <div>
          A quote that breaks none of these is approved the moment a rep submits it — no admin
          needed. A quote that breaks any of them cannot be shared with a client until you clear it,
          and its public link stays dead until then.
        </div>
      </div>

      {data.pendingApprovalCount > 0 && (
        <div className="banner banner-warn">
          <span>⏳</span>
          <div style={{ flex: 1 }}>
            {data.pendingApprovalCount} quote{data.pendingApprovalCount === 1 ? ' is' : 's are'} waiting
            on you right now.
          </div>
          <Link className="btn btn-sm" to="/quotes?status=pending_approval">Review them</Link>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>When does a quote need your sign-off?</h2>
          <span className="small faint">{activeCount} of 5 rules on</span>
        </div>
        <div className="card-body">
          <RuleRow
            enabled={!!rules.anyDiscount?.enabled}
            onToggle={(v) => patch('anyDiscount', { enabled: v })}
            title="Any discount at all"
            description="Any line priced below its list price needs approval, however small the cut."
          />

          <RuleRow
            enabled={!!rules.discountOver?.enabled}
            onToggle={(v) => patch('discountOver', { enabled: v })}
            title="Discount above a percentage"
            description={percentRedundant
              ? 'With "any discount" switched on above, this can never add anything — every discounted quote already needs you.'
              : 'Small discounts pass; anything deeper than this comes to you.'}
            warn={percentRedundant}
          >
            <div className="row">
              <input className="input" type="number" min="0" max="100" style={{ maxWidth: 110 }}
                value={rules.discountOver?.percent ?? 15}
                onChange={(e) => patch('discountOver', { percent: Number(e.target.value) })} />
              <span className="small faint">% off list</span>
            </div>
          </RuleRow>

          <RuleRow
            enabled={!!rules.rateFloor?.enabled}
            onToggle={(v) => patch('rateFloor', { enabled: v })}
            title="Priced below the floor rate"
            description="Uses each product's floor price from the rate card. This is the rule that actually protects margin — a 5% cut off a thin rate can hurt more than 20% off a fat one."
          >
            <Link className="small" to="/products">Set floor prices on the rate card →</Link>
          </RuleRow>

          <RuleRow
            enabled={!!rules.valueOver?.enabled}
            onToggle={(v) => patch('valueOver', { enabled: v })}
            title="Contract value above a threshold"
            description={`Total contract value, converted to ${reportingCurrency}.`}
          >
            <div className="row">
              <span className="small faint">{reportingCurrency}</span>
              <input className="input" type="number" min="0" style={{ maxWidth: 170 }}
                value={rules.valueOver?.amount ?? 250000}
                onChange={(e) => patch('valueOver', { amount: Number(e.target.value) })} />
            </div>
          </RuleRow>

          <RuleRow
            enabled={!!rules.minTerm?.enabled}
            onToggle={(v) => patch('minTerm', { enabled: v })}
            title="Term shorter than a minimum"
            description="Short contracts often do not recover the setup and recruitment cost."
            last
          >
            <div className="row">
              <input className="input" type="number" min="0" style={{ maxWidth: 110 }}
                value={rules.minTerm?.months ?? 12}
                onChange={(e) => patch('minTerm', { months: Number(e.target.value) })} />
              <span className="small faint">months</span>
            </div>
          </RuleRow>

          {activeCount === 0 && (
            <div className="banner banner-warn" style={{ marginTop: 14 }}>
              <span>⚠</span>
              <div>
                Every rule is off, so every quote will approve itself. That is a valid choice for a
                small team, but nothing will stop a rep discounting away your margin.
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Quote defaults</h2></div>
        <div className="card-body">
          <div className="grid grid-2">
            <Field label="Valid for" hint="How long a new quote stays live before it expires.">
              <div className="row">
                <input className="input" type="number" min="1" style={{ maxWidth: 110 }}
                  value={data.quoteValidDays ?? 30}
                  onChange={(e) => setData({ ...data, quoteValidDays: Number(e.target.value) })} />
                <span className="small faint">days</span>
              </div>
            </Field>
            <Field label="Quote number prefix" hint="Numbers run Q-2026-0001, Q-2026-0002 and so on.">
              <input className="input mono" style={{ maxWidth: 120 }} value={data.quoteNumberPrefix || 'Q'}
                onChange={(e) => setData({ ...data, quoteNumberPrefix: e.target.value })} />
            </Field>
          </div>
          <Field label="Default terms" hint="Copied onto every new quote. A rep can edit them per quote.">
            <textarea className="textarea" value={data.quoteTerms || ''}
              onChange={(e) => setData({ ...data, quoteTerms: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="row">
        <div className="spacer" />
        <button className="btn btn-primary" disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.saveQuoteApproval({
                quoteApproval: data.quoteApproval,
                quoteValidDays: data.quoteValidDays,
                quoteTerms: data.quoteTerms,
                quoteNumberPrefix: data.quoteNumberPrefix,
              })
              await reloadBootstrap()
              toast.success('Approval rules saved')
            } catch (err) {
              toast.error(err.message)
            } finally { setBusy(false) }
          }}>
          {busy ? 'Saving…' : 'Save rules'}
        </button>
      </div>
    </div>
  )
}

function RuleRow({ enabled, onToggle, title, description, warn, children, last }) {
  return (
    <div style={{
      padding: '14px 0',
      borderBottom: last ? 'none' : '1px solid var(--border)',
      opacity: enabled ? 1 : 0.6,
    }}>
      <label className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" className="checkbox" checked={enabled} style={{ marginTop: 2 }}
          onChange={(e) => onToggle(e.target.checked)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="strong">{title}</div>
          <div className="small" style={{ color: warn ? 'var(--warn)' : 'var(--text-muted)', marginTop: 2 }}>
            {description}
          </div>
        </div>
      </label>
      {enabled && children && <div style={{ marginTop: 8, marginLeft: 25 }}>{children}</div>}
    </div>
  )
}

/* ---------------- Custom fields ---------------- */

const FIELD_TYPE_LABELS = {
  text: 'Text', textarea: 'Long text', number: 'Number', currency: 'Currency',
  date: 'Date', select: 'Dropdown', multiselect: 'Multi-select',
  checkbox: 'Checkbox', url: 'Link', formula: 'Calculated',
}

const OBJECT_LABELS = { contact: 'Contacts', company: 'Companies', deal: 'Deals' }

function CustomFields() {
  const { reloadBootstrap } = useAuth()
  const toast = useToast()
  const [object, setObject] = useState('deal')
  const [fields, setFields] = useState(null)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const load = async () => {
    try {
      const { fields } = await api.listCustomFields({ object, active: 'all' })
      setFields(fields)
    } catch (err) { toast.error(err.message) }
  }
  useEffect(() => { setFields(null); load() }, [object]) // eslint-disable-line react-hooks/exhaustive-deps

  async function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= fields.length) return
    const next = [...fields]
    ;[next[i], next[j]] = [next[j], next[i]]
    setFields(next)
    try {
      await api.reorderCustomFields(object, next.map((f) => f._id))
      await reloadBootstrap()
    } catch (err) { toast.error(err.message) }
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="banner banner-info">
        <span>ℹ</span>
        <div>
          Fields you add appear on the record form, the detail page and the CSV export. A
          <strong> calculated</strong> field does arithmetic over other number fields and is worked out
          fresh on every read, so changing the formula updates every record at once.
        </div>
      </div>

      <div className="tabs">
        {Object.entries(OBJECT_LABELS).map(([k, v]) => (
          <button key={k} className={`tab${object === k ? ' active' : ''}`} onClick={() => setObject(k)}>{v}</button>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h2 style={{ flex: 1 }}>Fields on {OBJECT_LABELS[object].toLowerCase()}</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ Add field</button>
        </div>
        {!fields ? <Loading /> : fields.length === 0 ? (
          <Empty icon="⊞" title="No custom fields yet">
            Add one for anything you track that the built-in fields do not cover.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Label</th><th>Key</th><th>Type</th><th>Rules</th><th className="right" /></tr>
              </thead>
              <tbody>
                {fields.map((f, i) => (
                  <tr key={f._id} style={{ opacity: f.active ? 1 : 0.5 }}>
                    <td>
                      <span className="strong">{f.label}</span>
                      {!f.active && <span className="tag" style={{ marginLeft: 6 }}>inactive</span>}
                      {f.helpText && <div className="small faint truncate" style={{ maxWidth: 240 }}>{f.helpText}</div>}
                    </td>
                    <td className="small mono faint">{f.key}</td>
                    <td className="small">
                      {FIELD_TYPE_LABELS[f.type] || f.type}
                      {f.type === 'formula' && <div className="small faint mono truncate" style={{ maxWidth: 180 }}>{f.formula}</div>}
                      {['select', 'multiselect'].includes(f.type) && (
                        <div className="small faint truncate" style={{ maxWidth: 180 }}>{f.options.join(', ')}</div>
                      )}
                    </td>
                    <td className="small">
                      {f.required && <span className="tag">required</span>}
                      {f.requiredAtStage && <span className="tag" style={{ marginLeft: 4 }}>from {f.requiredAtStage}</span>}
                      {!f.required && !f.requiredAtStage && <span className="faint">—</span>}
                    </td>
                    <td className="right nowrap">
                      <button className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button className="btn btn-ghost btn-sm" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>↓</button>
                      <button className="btn btn-sm" onClick={() => setEditing(f)}>Edit</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(f)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(creating || editing) && (
        <FieldModal
          object={object} field={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={async () => { setCreating(false); setEditing(null); await load(); await reloadBootstrap() }}
        />
      )}

      {deleting && (
        <Confirm
          danger title={`Delete "${deleting.label}"`} confirmLabel="Delete field"
          message="If records hold data in this field you will be offered deactivation instead, which hides it everywhere while keeping the data."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteCustomField(deleting._id)
              toast.success('Field deleted')
            } catch (err) {
              if (err.payload?.canDeactivate) {
                await api.updateCustomField(deleting._id, { active: false })
                toast.success(`Deactivated instead — ${err.payload.recordCount} records hold data in it`)
              } else {
                toast.error(err.message)
                return
              }
            }
            setDeleting(null)
            await load()
            await reloadBootstrap()
          }}
        />
      )}
    </div>
  )
}

function FieldModal({ object, field, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({
    label: '', type: 'text', options: [], helpText: '', formula: '',
    required: false, requiredAtStage: '', showInTable: false, active: true,
    ...(field || {}),
  })
  const [optionText, setOptionText] = useState((field?.options || []).join('\n'))
  const [reference, setReference] = useState(null)
  const [formulaCheck, setFormulaCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.referenceableFields(object).then(setReference).catch(() => {})
  }, [object])

  useEffect(() => {
    if (form.type !== 'formula' || !form.formula.trim()) { setFormulaCheck(null); return }
    const t = setTimeout(async () => {
      try { setFormulaCheck(await api.validateFormula(object, form.formula)) } catch { /* transient */ }
    }, 400)
    return () => clearTimeout(t)
  }, [form.formula, form.type, object])

  const needsOptions = ['select', 'multiselect'].includes(form.type)

  async function save() {
    setBusy(true)
    setError('')
    try {
      const body = {
        ...form, object,
        options: needsOptions ? optionText.split('\n').map((x) => x.trim()).filter(Boolean) : [],
      }
      if (field) await api.updateCustomField(field._id, body)
      else await api.createCustomField(body)
      toast.success(field ? 'Field updated' : 'Field added')
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally { setBusy(false) }
  }

  return (
    <Modal
      title={field ? `Edit "${field.label}"` : `New field on ${OBJECT_LABELS[object].toLowerCase()}`}
      width="wide" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary"
            disabled={busy || !form.label.trim() || (form.type === 'formula' && formulaCheck && !formulaCheck.ok)}
            onClick={save}>
            {busy ? 'Saving…' : field ? 'Save' : 'Add field'}
          </button>
        </>
      }
    >
      {error && <div className="banner banner-danger">{error}</div>}

      <div className="grid grid-2">
        <Field label="Label" hint="What people see on the form.">
          <input className="input" value={form.label} autoFocus
            onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <Field label="Type" hint={field ? 'Cannot change once records hold data in it.' : 'Pick carefully — this is hard to change later.'}>
          <select className="select" value={form.type} disabled={!!field}
            onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {Object.entries(FIELD_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>

      {field && (
        <div className="hint" style={{ marginTop: -8, marginBottom: 12 }}>
          Stored under the key <code className="kbd">{field.key}</code>. Keys never change — every value
          already saved lives under it.
        </div>
      )}

      {needsOptions && (
        <Field label="Options" hint="One per line.">
          <textarea className="textarea" value={optionText} onChange={(e) => setOptionText(e.target.value)}
            placeholder={'APAC\nEMEA\nAmericas'} />
        </Field>
      )}

      {form.type === 'formula' && (
        <>
          <Field label="Formula" hint="Arithmetic over number fields. Reference one as {field_key}.">
            <input className="input mono" value={form.formula}
              placeholder="round(({tcv} - {delivery_cost}) / {tcv} * 100, 1)"
              onChange={(e) => setForm({ ...form, formula: e.target.value })} />
          </Field>
          {formulaCheck && (
            <div className={`banner ${formulaCheck.ok ? 'banner-ok' : 'banner-danger'}`}>
              <span>{formulaCheck.ok ? '✓' : '✕'}</span>
              <div>
                {formulaCheck.ok ? (
                  <>
                    Valid.
                    {formulaCheck.preview && (
                      <> On your most recent record it comes to{' '}
                        <strong>
                          {formulaCheck.preview.value === null ? 'nothing yet — a referenced field is empty'
                            : formulaCheck.preview.value.toLocaleString()}
                        </strong>.
                      </>
                    )}
                  </>
                ) : formulaCheck.error}
              </div>
            </div>
          )}
          {reference && (
            <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 13 }}>
              <div className="card-body tight">
                <div className="small muted" style={{ padding: '8px 0 4px' }}>
                  <strong>Fields you can reference</strong> — click to insert
                </div>
                <div className="row wrap" style={{ gap: 4, paddingBottom: 8 }}>
                  {reference.fields.map((f) => (
                    <button key={f.key} type="button" className="tag" style={{ cursor: 'pointer' }}
                      onClick={() => setForm((x) => ({ ...x, formula: `${x.formula}{${f.key}}` }))}>
                      {`{${f.key}}`}{f.source === 'custom' ? ` · ${f.label}` : ''}
                    </button>
                  ))}
                </div>
                <div className="small faint" style={{ paddingBottom: 8 }}>
                  Functions: {reference.functions.join(', ')}. A calculation over an empty field shows as
                  “—” rather than guessing zero.
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <Field label="Help text" hint="Optional. Shown under the input.">
        <input className="input" value={form.helpText} onChange={(e) => setForm({ ...form, helpText: e.target.value })} />
      </Field>

      {form.type !== 'formula' && (
        <>
          <label className="row small" style={{ marginBottom: 8 }}>
            <input type="checkbox" className="checkbox" checked={form.required}
              onChange={(e) => setForm({ ...form, required: e.target.checked })} />
            Always required
          </label>

          {object === 'deal' && reference?.stages?.length > 0 && (
            <Field label="Or require it from a stage onwards"
              hint="The deal cannot move to that stage, or past it, until this is filled. Marking a deal lost is always exempt.">
              <select className="select" value={form.requiredAtStage}
                onChange={(e) => setForm({ ...form, requiredAtStage: e.target.value })}>
                <option value="">Not stage-gated</option>
                {reference.stages.filter((s) => s.type === 'open').map((s) => (
                  <option key={s.key} value={s.key}>{s.name}</option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}

      {field && (
        <label className="row small">
          <input type="checkbox" className="checkbox" checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          Active — inactive fields disappear from forms but keep their data
        </label>
      )}
    </Modal>
  )
}
