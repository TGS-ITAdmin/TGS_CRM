import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext.jsx'
import { Field } from '../components/ui.jsx'

export default function Login() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await login(email.trim(), password)
    } catch (err) {
      setError(err.message || 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="row" style={{ marginBottom: 18, justifyContent: 'center' }}>
          <span className="brand-mark" style={{ width: 34, height: 34, flexBasis: 34, fontSize: 15 }}>📣</span>
          <div>
            <div className="brand-name" style={{ fontSize: 16 }}>TGS Outreach CRM</div>
            <div className="brand-sub">LinkedIn · Email · Cold calling</div>
          </div>
        </div>

        <form className="card" onSubmit={submit}>
          <div className="card-body">
            <h1 style={{ marginBottom: 4 }}>Sign in</h1>
            <p className="small muted" style={{ marginBottom: 16 }}>
              Use the account your admin set up for you.
            </p>

            {error && <div className="banner banner-danger">{error}</div>}

            <Field label="Email">
              <input
                className="input" type="email" value={email} autoComplete="username"
                onChange={(e) => setEmail(e.target.value)} required autoFocus
              />
            </Field>
            <Field label="Password">
              <input
                className="input" type="password" value={password} autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)} required
              />
            </Field>

            <button className="btn btn-primary btn-block btn-lg" disabled={busy} type="submit">
              {busy ? <><span className="spinner" /> Signing in…</> : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
