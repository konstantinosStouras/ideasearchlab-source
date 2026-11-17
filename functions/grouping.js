const functionsV1 = require('firebase-functions/v1')
const functions = functionsV1.region('europe-west1')
const { HttpsError } = functionsV1.https
const admin = require('firebase-admin')
const { reconcileGroup, startWaitingGroups } = require('./session')
const db = admin.firestore()

// Events locate a group. Transactions decide from the current roster and
// current completion flags, never from a delayed event's participant snapshot.
exports.autoGroupParticipants = functionsV1.runWith({ failurePolicy: true }).region('europe-west1').firestore
  .document('sessions/{sessionId}/participants/{participantId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data(), after = change.after.data()
    if (before.individualComplete === after.individualComplete || !after.individualComplete || !after.groupId) return
    return reconcileGroup(db.collection('sessions').doc(context.params.sessionId), after.groupId)
  })

exports.handleStragglers = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new HttpsError('unauthenticated', 'Must be logged in.')
  const { sessionId } = data || {}
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required.')
  return startWaitingGroups(db.collection('sessions').doc(sessionId), context.auth.uid)
})
