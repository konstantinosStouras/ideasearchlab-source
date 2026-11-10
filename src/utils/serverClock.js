import { httpsCallable, functions } from './db'
let anchor = null
let pending = null
export function serverNow() {
  return anchor ? anchor.server + (performance.now() - anchor.local) : null
}
export function syncServerClock() {
  if (pending) return pending
  const start = performance.now()
  pending = httpsCallable(functions, 'serverClock')({}).then(({ data }) => {
    const end = performance.now()
    if (!Number.isFinite(data.now)) throw new Error('Invalid server clock')
    anchor = { server: data.now + (end - start) / 2, local: end }
  }).finally(() => { pending = null })
  return pending
}
