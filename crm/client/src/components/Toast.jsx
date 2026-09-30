import { createContext, useCallback, useContext, useState } from 'react'

const ToastContext = createContext(null)
export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const push = useCallback((message, kind = 'info', title = '') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, message, kind, title }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000)
  }, [])

  const value = {
    toast: push,
    success: (m, t) => push(m, 'success', t),
    error: (m, t) => push(m, 'error', t || 'Something went wrong'),
  }

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role="status">
            {t.title && <div className="toast-title">{t.title}</div>}
            <div>{t.message}</div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
