import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, setToken, clearToken, getToken } from '../api'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [boot, setBoot] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadBootstrap = useCallback(async () => {
    try {
      const data = await api.bootstrap()
      setBoot(data)
      return data
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function init() {
      if (!getToken()) {
        setLoading(false)
        return
      }
      try {
        const { user } = await api.me()
        if (cancelled) return
        setUser(user)
        await loadBootstrap()
      } catch {
        clearToken()
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    init()
    return () => { cancelled = true }
  }, [loadBootstrap])

  const login = async (email, password) => {
    const { token, user } = await api.login(email, password)
    setToken(token)
    setUser(user)
    await loadBootstrap()
    return user
  }

  const logout = () => {
    clearToken()
    setUser(null)
    setBoot(null)
  }

  const refreshUser = async () => {
    const { user } = await api.me()
    setUser(user)
    return user
  }

  const isAdmin = user?.role === 'admin'
  /* The server already resolved role + overrides into a flat answer, so the
     client never re-derives it and never disagrees with what the API will do.
     This hides buttons; it does not secure anything — every route is guarded. */
  const rights = user?.can || boot?.can || {}
  const can = (key) => !!rights[key]
  const statuses = boot?.settings?.contactStatuses || []
  const statusMap = new Map(statuses.map((s) => [s.value, s]))
  const dealStages = boot?.dealStages || []
  const stageMap = new Map(dealStages.map((s) => [s.key, s]))
  const currencies = boot?.currencies || []
  const reportingCurrency = boot?.settings?.reportingCurrency || 'USD'

  return (
    <AuthContext.Provider
      value={{
        user, boot, loading, isAdmin, can, rights, login, logout, refreshUser,
        reloadBootstrap: loadBootstrap,
        statuses, statusMap,
        dealStages, stageMap, currencies, reportingCurrency,
        forecastCategories: boot?.forecastCategories || [],
        quoteApproval: boot?.quoteApproval || {},
        customFieldsFor: (object) => boot?.customFields?.[object] || [],
        brandColor: boot?.settings?.brandColor || '#2563eb',
        pricingModels: boot?.pricingModels || [],
        lostReasons: boot?.settings?.lostReasons || [],
        users: boot?.users || [],
        callOutcomes: boot?.callOutcomes || [],
        mergeFields: boot?.mergeFields || [],
        smtp: boot?.smtp || {},
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
