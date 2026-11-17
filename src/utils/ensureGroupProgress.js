import { functions, httpsCallable } from './db'
import { retryCallable } from './retrySessionJoin'

export function ensureGroupProgress(sessionId) {
  const advance = httpsCallable(functions, 'ensureGroupProgress', { timeout: 125000 })
  return retryCallable(advance, { sessionId }).catch(error => {
    console.warn('Group progression will retry through the saved submission event:', error.message)
  })
}
