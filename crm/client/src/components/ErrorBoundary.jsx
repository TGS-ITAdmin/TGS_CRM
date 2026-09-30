import { Component } from 'react'

/* One bad render used to blank the entire app — a rep mid-call would just see
 * white. This keeps the shell and the navigation alive, shows what broke, and
 * lets them carry on somewhere else. */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[crm] render error', error, info?.componentStack)
  }

  componentDidUpdate(prev) {
    // Recover automatically when the route changes, so a broken page does not
    // stay broken after navigating away from it.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="page narrow">
        <div className="card">
          <div className="card-head"><h2>This screen hit an error</h2></div>
          <div className="card-body">
            <p className="small muted">
              Nothing was lost — your data is safe on the server. Move to another screen and
              carry on, and send this message over so it can be fixed.
            </p>
            <div className="script-box" style={{ marginTop: 12 }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
                Try again
              </button>
              <button className="btn" onClick={() => { window.location.href = '/' }}>
                Back to My Day
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
