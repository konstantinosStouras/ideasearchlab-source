const { HttpsError } = require('firebase-functions/v1').https

async function withAIRequest(db, request, generate) {
  const { sessionId, requestId, uid, scope, scopeId, userMessage } = request
  const session = db.collection('sessions').doc(sessionId)
  const messages = session.collection('aiMessages')
  if (!requestId) {
    const reply = await generate()
    await messages.add(reply)
    return { text: reply.text }
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Invalid request identifier.')
  }
  const prompt = await messages.doc(requestId).get()
  const data = prompt.data()
  if (!prompt.exists || data.authorId !== uid || data.scope !== scope || data.scopeId !== scopeId || data.text !== userMessage) {
    throw new HttpsError('permission-denied', 'The request must match your saved message.')
  }
  const ref = session.collection('aiRequests').doc(requestId)
  const lease = require('node:crypto').randomUUID()
  const cached = await db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const existing = snap.data()
    if (existing && existing.uid !== uid) throw new HttpsError('permission-denied', 'Request owner mismatch.')
    if (existing?.status === 'done') return existing.text
    if (existing?.leaseUntil > Date.now()) throw new HttpsError('resource-exhausted', 'This reply is still being generated.')
    tx.set(ref, { uid, status: 'pending', lease, leaseUntil: Date.now() + 150000 })
    return null
  })
  if (cached !== null) return { text: cached }
  try {
    const reply = await generate()
    const batch = db.batch()
    batch.set(messages.doc('reply_' + requestId), { ...reply, requesterId: uid, userMessageId: requestId, requestId })
    batch.set(ref, { uid, status: 'done', text: reply.text })
    await batch.commit()
    return { text: reply.text }
  } catch (error) {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if (snap.data()?.lease === lease) tx.delete(ref)
    })
    throw error
  }
}

module.exports = { withAIRequest }
