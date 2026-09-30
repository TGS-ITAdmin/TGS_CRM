import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

/* Polls the work queue so the sidebar badges stay live, and raises a browser
 * notification the first time a task becomes due. Notifications are opt-in
 * per user and per browser — the queue itself is always the source of truth,
 * so nothing is missed if permission is denied. */

const POLL_MS = 60_000

export function useReminders(user) {
  const [counts, setCounts] = useState({ overdue: 0, dueToday: 0, awaitingApproval: 0, completedToday: 0 })
  const seen = useRef(new Set())
  const primed = useRef(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function poll() {
      try {
        const data = await api.myDay()
        if (cancelled) return
        setCounts(data.counts)

        if (user.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
          const due = [...data.overdue, ...data.today]
          const fresh = due.filter((t) => !seen.current.has(t._id))
          for (const t of due) seen.current.add(t._id)

          // Skip the first pass — otherwise opening the app fires a notification
          // for every task already sitting in the queue.
          if (primed.current && fresh.length) {
            const first = fresh[0]
            const body =
              fresh.length === 1
                ? first.title
                : `${fresh.length} contacts are due to move to their next stage.`
            new Notification('TGS CRM — work is due', { body, tag: 'crm-due', renotify: false })
          }
          primed.current = true
        }
      } catch {
        // Network blips shouldn't spam the console on a 60s loop.
      }
    }

    poll()
    const id = setInterval(poll, POLL_MS)
    const onFocus = () => poll()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [user])

  return counts
}

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

export const notificationPermission = () =>
  'Notification' in window ? Notification.permission : 'unsupported'
