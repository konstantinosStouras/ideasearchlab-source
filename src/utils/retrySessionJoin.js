// Joining is idempotent on the server (one membership per authenticated UID).
// A classroom burst may be rejected by the platform before the callable runs.
// Retry only transient failures, with jitter so students do not retry together.
export async function retryCallable(join, payload, options = {}) {
  const { onRetry = () => {}, timeoutMs = 240000, maxAttempts = 40,
    now = () => performance.now(), random = Math.random,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options
  const deadline = now() + timeoutMs
  for (let attempt = 1; ; attempt++) {
    try { return await join(payload) }
    catch (error) {
      const code = String(error?.code || '').replace(/^functions\//, '')
      const transient = ['resource-exhausted', 'unavailable', 'deadline-exceeded', 'aborted', 'internal', 'unknown'].includes(code)
      const remaining = deadline - now()
      if (!transient || attempt >= maxAttempts || remaining <= 0) throw error
      onRetry(attempt)
      const delay = Math.min(remaining, Math.min(8000, 500 * 2 ** Math.min(attempt - 1, 4)) * (0.5 + random()))
      await sleep(delay)
      if (now() >= deadline) throw error
    }
  }
}

export const retrySessionJoin = retryCallable
