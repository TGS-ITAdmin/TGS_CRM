import { getToken } from '../api'

/* Authenticated download. A plain <a href> cannot carry the bearer token, so
 * the file is fetched, turned into a blob and handed to the browser. */
export async function downloadFile(url, filename) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } })
  if (!res.ok) {
    let message = `Download failed (${res.status})`
    try {
      const data = await res.json()
      if (data?.error) message = data.error
    } catch { /* a non-JSON error body tells us nothing useful */ }
    throw new Error(message)
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
