const functions = require('firebase-functions/v1').region('europe-west1')
const admin = require('firebase-admin')
const db = admin.firestore()
// Explicit allow-list: never copy identity, demographics, consent or answers.
function publicParticipant(p) {
  return {
    groupId: p.groupId || '', anonymousLabel: p.anonymousLabel || '',
    status: p.status || 'waiting', individualComplete: !!p.individualComplete,
    votesSubmitted: !!p.votesSubmitted, votedFor: [...new Set(p.votedFor || [])].slice(0, 3),
    groupStage: p.groupStage || '', removed: !!p.removed,
  }
}
async function syncParticipant(ref) {
  // Read current state inside a transaction: delayed/out-of-order events cannot
  // overwrite the public ballot with an older event snapshot.
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const target = ref.parent.parent.collection('participantPublic').doc(ref.id)
    if (!snap.exists) tx.delete(target)
    else tx.set(target, publicParticipant(snap.data()))
  })
}
exports.publicParticipant = publicParticipant
exports.syncParticipantPublic = functions.firestore
  .document('sessions/{sessionId}/participants/{participantId}')
  .onWrite((change) => syncParticipant(change.after.ref))
// Backfills existing groups on entry without exposing private source documents.
exports.ensureGroupRoster = functions.https.onCall(async ({ sessionId }, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')
  if (typeof sessionId !== 'string' || !sessionId || sessionId.includes('/')) throw new functions.https.HttpsError('invalid-argument', 'Invalid session.')
  const session = db.collection('sessions').doc(sessionId)
  const me = await session.collection('participants').doc(context.auth.uid).get()
  if (!me.exists || !me.data().groupId) throw new functions.https.HttpsError('permission-denied', 'No group membership.')
  const group = await session.collection('groups').doc(me.data().groupId).get()
  await Promise.all((group.data()?.members || []).map(uid => syncParticipant(session.collection('participants').doc(uid))))
  return { ok: true }
})
exports.serverClock = functions.https.onCall((data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')
  return { now: Date.now() }
})
