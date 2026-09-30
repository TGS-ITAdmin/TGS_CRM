import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { useAuth } from './contexts/AuthContext.jsx'
import { useReminders } from './components/useReminders.js'
import { Initials, Loading } from './components/ui.jsx'

import Login from './pages/Login.jsx'
import MyDay from './pages/MyDay.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Duplicates from './pages/Duplicates.jsx'
import Contacts from './pages/Contacts.jsx'
import Companies from './pages/Companies.jsx'
import Deals from './pages/Deals.jsx'
import Quotes from './pages/Quotes.jsx'
import QuoteDetail from './pages/QuoteDetail.jsx'
import Products from './pages/Products.jsx'
import DealDetail from './pages/DealDetail.jsx'
import CompanyDetail from './pages/CompanyDetail.jsx'
import ContactDetail from './pages/ContactDetail.jsx'
import ImportContacts from './pages/ImportContacts.jsx'
import Campaigns from './pages/Campaigns.jsx'
import CampaignEditor from './pages/CampaignEditor.jsx'
import Board from './pages/Board.jsx'
import Outbox from './pages/Outbox.jsx'
import CallList from './pages/CallList.jsx'
import Reports from './pages/Reports.jsx'
import Settings from './pages/Settings.jsx'

const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', rep: 'Rep', viewer: 'Read-only' }

const NAV = [
  { group: 'Work' },
  { to: '/', label: 'My Day', icon: '◎', end: true, badge: 'work' },
  { to: '/dashboard', label: 'Dashboard', icon: '▦' },
  { to: '/outbox', label: 'Ready to Send', icon: '✉', badge: 'outbox' },
  { to: '/calls', label: 'Call List', icon: '☎' },
  { group: 'Pipeline' },
  { to: '/deals', label: 'Deals', icon: '💼' },
  { to: '/quotes', label: 'Quotes', icon: '📄', badge: 'quotes' },
  { to: '/contacts', label: 'Contacts', icon: '☰' },
  { to: '/companies', label: 'Companies', icon: '🏢' },
  { to: '/duplicates', label: 'Duplicates', icon: '⧉', needs: 'records.merge' },
  { to: '/campaigns', label: 'Campaigns', icon: '⚑' },
  { to: '/products', label: 'Rate card', icon: '🏷' },
  { to: '/board', label: 'Outreach board', icon: '▦' },
  { group: 'Insight' },
  { to: '/reports', label: 'Reports', icon: '◔' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
]

function Sidebar({ counts }) {
  const { user, logout, can } = useAuth()
  const workBadge = counts.overdue + counts.dueToday
  const badgeFor = (key) => {
    if (key === 'work') return workBadge ? { n: workBadge, hot: counts.overdue > 0 } : null
    if (key === 'outbox') return counts.awaitingApproval ? { n: counts.awaitingApproval, hot: false } : null
    if (key === 'quotes') return counts.quotesPendingApproval ? { n: counts.quotesPendingApproval, hot: true } : null
    return null
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">📣</span>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name truncate">TGS Outreach</div>
          <div className="brand-sub">CRM</div>
        </div>
      </div>

      <nav className="nav">
        {NAV.filter((item) => !item.needs || can(item.needs)).map((item, i) =>
          item.group ? (
            <div className="nav-group-label" key={`g${i}`}>{item.group}</div>
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              {(() => {
                const b = badgeFor(item.badge)
                return b ? <span className={`nav-badge${b.hot ? '' : ' quiet'}`}>{b.n}</span> : null
              })()}
            </NavLink>
          )
        )}
      </nav>

      <div className="sidebar-foot">
        <div className="user-chip">
          <Initials name={user.name} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="user-chip-name truncate">{user.name}</div>
            <div className="user-chip-role">{ROLE_LABELS[user.role] || user.role}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout} title="Sign out">⏻</button>
        </div>
      </div>
    </aside>
  )
}

export default function App() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const counts = useReminders(user)

  if (loading) return <Loading label="Starting up…" />

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
      </Routes>
    )
  }

  return (
    <div className="shell">
      <Sidebar counts={counts} />
      <div className="main">
        <ErrorBoundary resetKey={location.pathname}>
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/" element={<MyDay counts={counts} />} />
          <Route path="/outbox" element={<Outbox />} />
          <Route path="/calls" element={<CallList />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/contacts/import" element={<ImportContacts />} />
          <Route path="/contacts/:id" element={<ContactDetail />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<CompanyDetail />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/deals/:id" element={<DealDetail />} />
          <Route path="/quotes" element={<Quotes />} />
          <Route path="/quotes/:id" element={<QuoteDetail />} />
          <Route path="/products" element={<Products />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignEditor />} />
          <Route path="/board" element={<Board />} />
          <Route path="/board/:id" element={<Board />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </div>
  )
}
