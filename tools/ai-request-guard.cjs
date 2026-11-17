const assert = require('node:assert/strict')
const { withAIRequest } = require('../functions/aiRequest')

const store = new Map()
const ref = path => ({
  path,
  collection: name => ref(path + '/' + name),
  doc: id => ref(path + '/' + id),
  get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
  add: async value => store.set(path + '/' + store.size, value),
})
let queue = Promise.resolve()
const db = {
  collection: ref,
  runTransaction: callback => {
    const result = queue.then(() => callback({ get: r => r.get(), set: (r, v) => store.set(r.path, v), delete: r => store.delete(r.path) }))
    queue = result.catch(() => {})
    return result
  },
  batch: () => {
    const writes = []
    return { set: (r, v) => writes.push([r.path, v]), commit: async () => writes.forEach(([key, value]) => store.set(key, value)) }
  },
}
const request = { sessionId: 'test', requestId: 'request-1', uid: 'student', scope: 'group', scopeId: 'g0', userMessage: 'Please refine the idea.' }
store.set('sessions/test/aiMessages/request-1', { authorId: 'student', scope: 'group', scopeId: 'g0', text: request.userMessage })
async function main() {
  let generations = 0
  let release
  const provider = async () => { generations++; await new Promise(resolve => { release = resolve }); return { text: 'Use washable sensors.' } }
  const first = withAIRequest(db, request, provider)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  const concurrent = await Promise.allSettled(Array.from({ length: 50 }, () => withAIRequest(db, request, provider)))
  assert(concurrent.every(r => r.status === 'rejected' && r.reason.code === 'resource-exhausted'))
  release()
  assert.deepEqual(await first, { text: 'Use washable sensors.' })
  const retries = await Promise.all(Array.from({ length: 50 }, () => withAIRequest(db, request, provider)))
  assert(retries.every(r => r.text === 'Use washable sensors.'))
  assert.equal(generations, 1)
  assert.equal([...store.keys()].filter(key => key.includes('/reply_')).length, 1)
  await assert.rejects(withAIRequest(db, { ...request, uid: 'intruder' }, provider), e => e.code === 'permission-denied')
  await assert.rejects(withAIRequest(db, { ...request, userMessage: 'Changed prompt' }, provider), e => e.code === 'permission-denied')
  const retryRequest = { ...request, requestId: 'request-2' }
  store.set('sessions/test/aiMessages/request-2', store.get('sessions/test/aiMessages/request-1'))
  await assert.rejects(withAIRequest(db, retryRequest, async () => { throw Error('Provider temporarily unavailable') }))
  assert(!store.has('sessions/test/aiRequests/request-2'))
  assert.deepEqual(await withAIRequest(db, retryRequest, async () => ({ text: 'Recovered' })), { text: 'Recovered' })
  console.log('PASS 50 concurrent requests and 50 retries generate one reply; failed generation recovers; request ownership enforced')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
