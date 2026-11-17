const functionsV1 = require('firebase-functions/v1')
const functions = functionsV1.region('europe-west1')
const { HttpsError } = functionsV1.https
const admin = require('firebase-admin')
// Never move a participant BACKWARDS when a group advances together — see
// functions/phaseGuard.js for the bug this exists to prevent.
const { statusPhaseIndex, shouldSetStatus } = require('./phaseGuard')
// The carry-forward rule (owner 2026-09-28), vendored from
// src/utils/carryForward.js — tools/carry-forward-guard.mjs keeps the two
// copies identical.
const { topUpSelection, selectionPatch, patchChanges, carriedBy, isOwnPick, isLegacySubmission } = require('./carryForward')

const db = admin.firestore()
const { createGroupLifecycle } = require('./groupLifecycle')
const lifecycle = createGroupLifecycle({ db, stamp: () => admin.firestore.FieldValue.serverTimestamp(), HttpsError, getPhaseSequence })

/**
 * assignToGroup
 * Atomically places a newly-joined participant into exactly ONE group.
 *
 * Every join is serialized through the session's `joinCount` counter inside a
 * single transaction, so each participant receives a unique, sequential join
 * index and a deterministic group (g0, g1, …). This removes the race in the
 * old query-then-batch approach, where two people joining at the same moment
 * could both be placed into overlapping groups — i.e. one user ending up in
 * two groups of the same session. The member who fills a group flips every
 * member of that group into the first phase together.
 *
 * The join hot path uses bounded document reads:
 * the session doc (counter + config) and the single target group doc.
 */
async function assignToGroup(sessionRef, uid, name, email) {
  return lifecycle.assignToGroup(sessionRef, uid, name, email)
}

/**
 * removeParticipant
 * Instructor-only. Removes a participant from the session even after play has
 * started: detaches them from their group (so the group has one fewer member),
 * marks them `removed`, and — if the group is mid-experiment — queues a
 * backfill vacancy so the next late joiner can take that exact slot and jump
 * into the group's current phase. After detaching, reconciles the group in
 * case the removed member was the only one still blocking it from advancing.
 */
exports.removeParticipant = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new HttpsError('unauthenticated', 'Must be logged in.')
  const { sessionId, participantId } = data
  if (!sessionId || !participantId) {
    throw new HttpsError('invalid-argument', 'sessionId and participantId required.')
  }

  const sessionRef = db.collection('sessions').doc(sessionId)
  const sessionSnap = await sessionRef.get()
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'Session not found.')
  if (sessionSnap.data().instructorId !== context.auth.uid) {
    throw new HttpsError('permission-denied', 'Only the instructor can remove participants.')
  }

  await detachParticipant(sessionRef, participantId)
  return { ok: true }
})

/**
 * detachParticipant (internal — the caller authorizes)
 * Detaches one participant from their group within a session: marks them
 * `removed`, pulls them from the group's `members`/`memberLabels` (so the group
 * keeps playing with one fewer member, under the same parameters), and — if the
 * group is mid-experiment — queues a backfill vacancy so a later joiner can take
 * that exact slot. Then reconciles the group in case the removed member was the
 * only one still blocking it from advancing.
 *
 * Shared by removeParticipant (one session, instructor-driven) and
 * deleteRegisteredUser (every session, admin account deletion). With
 * `opts.activeOnly` the detach is skipped for participants who are already past
 * the group phase (survey/done) so account deletion never rewrites a finished
 * participant's record — only groups still in play shrink to n-1.
 *
 * Returns { groupId? , alreadyRemoved? , notFound? , skipped? }.
 */
async function detachParticipant(sessionRef, participantId, opts = {}) {
  return lifecycle.detachParticipant(sessionRef, participantId, opts)
}
exports.detachParticipant = detachParticipant

/**
 * reconcileGroupAfterRemoval
 * After a member is detached, the remaining members may already all be done —
 * in which case nothing else would trigger the group's advance. Mirror the
 * autoGroupParticipants / finishGroupVoting checks for the survivors.
 */
async function reconcileGroupAfterRemoval(sessionRef, groupId) {
  return lifecycle.reconcileGroup(sessionRef, groupId)
}

/**
 * joinSession
 * Validates a session code and registers the participant, then places them in
 * a group atomically (see assignToGroup). Called from the Registration page.
 */
/**
 * deleteSessionDeep
 * Deletes a session AND its subcollections. `deleteDoc` on the session document
 * removes only that document — Firestore does not cascade — so the old client
 * delete left every participant record (real names, e-mails, student ids,
 * demographics, survey answers), every idea, group, chat message and AI message
 * behind in the database, permanently: with the parent gone, `isSessionInstructor`
 * can no longer resolve, so the data is unreachable from the app and cannot be
 * exported or purged. The confirm dialog meanwhile promised it was all deleted.
 */
exports.deleteSessionDeep = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new HttpsError('unauthenticated', 'Must be logged in.')
    const { sessionId } = data || {}
    if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId is required.')

    const sessionRef = db.collection('sessions').doc(sessionId)
    const snap = await sessionRef.get()
    if (!snap.exists) return { success: true, alreadyGone: true }
    const isInstructor = snap.data().instructorId === context.auth.uid
    const isAdminUser = context.auth.token.email === 'admin@admin.com'
    if (!isInstructor && !isAdminUser) {
      throw new HttpsError('permission-denied', 'Only the instructor can delete this session.')
    }

    // recursiveDelete walks every subcollection at any depth, so this covers
    // participants, ideas, aiMessages, groups AND groups/*/messages.
    await db.recursiveDelete(sessionRef)
    return { success: true }
  })

// Bound concurrent writers to the enrollment counter. Excess HTTP requests
// queue at the service instead of overwhelming one Firestore document with
// competing transactions; membership remains atomic and retries idempotent.
exports.joinSession = functions.runWith({ timeoutSeconds: 120, minInstances: 2, maxInstances: 16 }).https.onCall(async (data, context) => {
  if (!context.auth) throw new HttpsError('unauthenticated', 'Must be logged in.')

  const { code } = data
  if (!code) throw new HttpsError('invalid-argument', 'Session code required.')

  const snap = await db.collection('sessions')
    .where('code', '==', code.trim().toUpperCase())
    .where('status', '!=', 'done')
    .limit(1)
    .get()

  if (snap.empty) throw new HttpsError('not-found', 'Session not found.')

  const sessionId = snap.docs[0].id
  const sessionRef = db.collection('sessions').doc(sessionId)
  const uid = context.auth.uid
  // The Admin SDK rejects `undefined`, which would fail the whole join
  // transaction with an opaque 'internal' error for any account without an
  // e-mail or display-name claim (anonymous auth, some OIDC providers).
  const name = context.auth.token.name || context.auth.token.email || 'Participant'
  const email = context.auth.token.email || null

  const status = await assignToGroup(sessionRef, uid, name, email)

  return { sessionId, status }
})


/**
 * advancePhase
 * Moves the session to the next phase in its sequence.
 * Only the instructor (session owner) can call this.
 * Also updates participant statuses accordingly.
 */
exports.advancePhase = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new HttpsError('unauthenticated', 'Must be logged in.')
  const { sessionId } = data || {}
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required.')
  const sessionRef = db.collection('sessions').doc(sessionId)
  const snap = await sessionRef.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Session not found.')
  const session = snap.data()
  if (session.instructorId !== context.auth.uid) throw new HttpsError('permission-denied', 'Only the instructor can advance phases.')
  const sequence = getPhaseSequence(session.phaseConfig)
  const next = sequence[sequence.indexOf(session.status) + 1]
  if (next === 'group') {
    const rows = await sessionRef.collection('participants').get()
    const entering = rows.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => shouldSetStatus(p, 'group', sequence))
    try { await topUpCarriedIdeas(sessionRef, entering, session.phaseConfig) }
    catch (err) { console.error('topUpCarriedIdeas failed:', err) }
  }
  // Recheck owner, closure, phase and every current member in the transaction.
  return lifecycle.advanceSession(sessionRef, context.auth.uid, session.status)
})

exports.reconcileGroup = (sessionRef, groupId) => lifecycle.reconcileGroup(sessionRef, groupId)

exports.ensureGroupProgress = functionsV1.runWith({ timeoutSeconds: 120, maxInstances: 16 }).region('europe-west1').https.onCall(async (data, context) => {
  if (!context.auth) throw new HttpsError('unauthenticated', 'Sign in first.')
  const sessionId = data?.sessionId
  if (typeof sessionId !== 'string' || !sessionId || sessionId.includes('/')) throw new HttpsError('invalid-argument', 'Invalid session.')
  const sessionRef = db.collection('sessions').doc(sessionId)
  const participant = await sessionRef.collection('participants').doc(context.auth.uid).get()
  if (!participant.exists || !participant.data().groupId || participant.data().removed) throw new HttpsError('permission-denied', 'No active group membership.')
  // Participant-change events maintain the aggregate session phase. The
  // synchronous recovery only needs this group's transaction, so hundreds of
  // callers do not wait on a scan of the entire classroom.
  await lifecycle.reconcileGroup(sessionRef, participant.data().groupId, { updateSession: false })
  return { ok: true }
})
exports.startWaitingGroups = (sessionRef, instructorUid) => lifecycle.startWaitingGroups(sessionRef, instructorUid)


/**
 * topUpCarriedIdeas
 *
 * A participant who never reached Finish & Submit (the instructor force-
 * advanced the session) has only the ideas they had ticked so far flagged
 * `selected`. The rule says they still send `ideasCarriedToGroup` ideas when
 * they wrote that many: fill the selection up to the cap from their other
 * ideas and tag those `selectedBy: 'computer'`. The module's deterministic
 * pick, so this set is exactly the one every group member's page derives for
 * them from the same documents (and the one their own client would write
 * back) — a random draw here would change the group's list under its members.
 * A participant who already submitted normally has a full selection, so the
 * transaction changes nothing; one whose selection is SHORT anyway (their
 * ideas batch was refused, or the cap was raised after they submitted) is
 * topped up like anyone else entering the group phase — the rule is about
 * what the group receives. Only a selection submitted under the OLD rule (an
 * untagged carried idea) is left exactly as submitted (`isLegacySubmission`).
 *
 * One session-wide read of the individual-stage ideas finds each entering
 * participant's ideas; then ONE TRANSACTION PER PARTICIPANT re-reads every
 * one of their ideas, decides from those fresh documents and writes the
 * changes. A transaction commits only if none of the documents it READ
 * changed meanwhile, whether or not it wrote them: a pick the participant
 * makes on ANY of their ideas while this runs (their clock expiring as the
 * instructor presses Advance, a last-instant Select) makes it retry from the
 * new documents and decide again, so the cap is never exceeded and two
 * writers never leave two sets. Non-fatal per participant: a participant
 * whose transaction still fails is skipped, and their own client heals the
 * documents when they reach the group page.
 */
async function topUpCarriedIdeas(sessionRef, participants, phaseConfig) {
  const ideasCarried = (phaseConfig && phaseConfig.ideasCarriedToGroup) || 3
  const snap = await sessionRef.collection('ideas').where('phase', '==', 'individual').get()
  const refsByAuthor = {}
  snap.docs.forEach(d => {
    const authorId = d.get('authorId')
    if (!authorId) return
    ;(refsByAuthor[authorId] = refsByAuthor[authorId] || []).push(d.ref)
  })
  let written = 0
  for (const p of participants) {
    const refs = refsByAuthor[p.id] || []
    if (!refs.length) continue
    try {
      written += await db.runTransaction(async tx => {
        const liveSession = await tx.get(sessionRef)
        const liveParticipant = await tx.get(sessionRef.collection('participants').doc(p.id))
        if (!liveSession.exists || liveSession.data().status === 'done' || !liveParticipant.exists) return 0
        const current = liveParticipant.data()
        if (!shouldSetStatus(current, 'group', getPhaseSequence(liveSession.data().phaseConfig))) return 0
        const snaps = await Promise.all(refs.map(r => tx.get(r)))
        const mine = snaps.filter(sn => sn.exists).map(sn => ({ id: sn.id, ...sn.data() }))
          .filter(i => i.phase === 'individual' && i.authorId === p.id)
        if (isLegacySubmission(current, mine)) return 0
        const decision = topUpSelection({
          ideas: mine,
          selectedIds: mine.filter(isOwnPick).map(i => i.id),
          priorComputer: mine.filter(i => carriedBy(i) === 'computer').map(i => i.id),
          ideasCarried,
        })
        let n = 0
        mine.forEach(idea => {
          const patch = selectionPatch(idea.id, decision)
          if (!patchChanges(idea, patch)) return
          tx.update(sessionRef.collection('ideas').doc(idea.id), patch)
          n++
        })
        return n
      })
    } catch (err) {
      console.warn(`topUpCarriedIdeas: skipped ${p.id} (${err.code || err.message})`)
    }
  }
  return written
}

/**
 * tallyGroupVotes
 * Reads each participant's votedFor array, counts votes per idea,
 * and stores the top 3 ideas on each group document as finalIdeas.
 * Called when advancing from group phase to survey.
 */
async function tallyGroupVotes(sessionRef) {
  const groupsSnap = await sessionRef.collection('groups')
    .where('status', '==', 'active')
    .get()

  if (groupsSnap.empty) return

  const participantsSnap = await sessionRef.collection('participants').get()
  const participants = participantsSnap.docs.map(d => ({ id: d.id, ...d.data() }))

  const batch = db.batch()

  for (const groupDoc of groupsSnap.docs) {
    const groupMembers = participants.filter(p => p.groupId === groupDoc.id)

    // Tally votes from the members who actually CAST a ballot, mirroring
    // finishGroupVoting. Counting an unsubmitted ballot let a participant who
    // never pressed Submit Votes decide the group's final picks, while the same
    // workbook reports them as "not submitted".
    const voteMap = {}
    groupMembers.filter(m => m.votesSubmitted && !m.removed).forEach(m => {
      (m.votedFor || []).forEach(ideaId => {
        voteMap[ideaId] = (voteMap[ideaId] || 0) + 1
      })
    })

    const topIdeas = Object.entries(voteMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id)

    batch.update(groupDoc.ref, {
      status: 'done',
      finalIdeas: topIdeas,
      votingCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  }

  await batch.commit()
}


/**
 * Shared phase sequence logic (mirrors frontend utils/phaseSequence.js).
 * Must stay in sync with the frontend version.
 *
 * NOTE: 'voting' has been removed from the sequence. Voting now happens
 * inline during the group phase. The transition is group -> survey -> done.
 */
function getPhaseSequence(phaseConfig = {}) {
  const {
    individualPhaseActive = true,
    groupPhaseActive = true,
    phaseOrder = 'individual_first',
  } = phaseConfig

  const sequence = ['waiting']

  if (individualPhaseActive && groupPhaseActive) {
    if (phaseOrder === 'individual_first') {
      sequence.push('individual', 'group')
    } else {
      sequence.push('group', 'individual')
    }
  } else if (individualPhaseActive) {
    sequence.push('individual')
  } else if (groupPhaseActive) {
    sequence.push('group')
  }

  sequence.push('survey', 'done')
  return sequence
}


/**
 * finishGroupVoting
 * Called from onParticipantUpdated when a participant locks in their votes.
 * If every member of that participant's group has now submitted, tallies the
 * group's votes (top 3 -> finalIdeas), marks the group done, and moves its
 * members to the next phase in the sequence (survey for individual_first,
 * individual for group_first). Advances the session status once every
 * participant in the session has moved past the group phase.
 */
async function finishGroupVoting(sessionId, triggeringUid, after) {
  // The event identifies the group only. Current membership and ballots are
  // read transactionally, so delayed events cannot revive removed users.
  return lifecycle.reconcileGroup(db.collection('sessions').doc(sessionId), after.groupId)
}


/**
 * maybeAdvanceSession
 * Monotonically advances session.status to the furthest phase that EVERY active
 * (non-removed) participant has reached — capped at 'survey', never 'done'
 * (see the comment at the loop: sessions must not auto-close, because new
 * participants can always still join and play). Idempotent and safe to call on
 * any participant change. This is the self-healing backstop that keeps the
 * session phase in sync even when a per-group auto-advance was delayed or
 * dropped and the members moved themselves on client-side — so the session
 * still reaches 'survey' and never sticks on 'group'.
 */
async function maybeAdvanceSession(sessionRef, statusHint) {
  return lifecycle.maybeAdvanceSession(sessionRef, statusHint)
}

/**
 * onParticipantUpdated
 * Firestore trigger fired on every participant update. Two jobs:
 *  1. When a participant locks in their votes, try to finish their group's
 *     voting (tally finalIdeas, move members on).
 *  2. Whenever a participant's phase changes, re-evaluate the session's overall
 *     phase (maybeAdvanceSession) so the session self-heals to 'survey' even
 *     if a per-group trigger was missed and participants advanced themselves.
 *     Never to 'done' — sessions close only by instructor action.
 */
exports.onParticipantUpdated = functionsV1.runWith({ failurePolicy: true }).region('europe-west1').firestore
  .document('sessions/{sessionId}/participants/{participantId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data()
    const after = change.after.data()
    const { sessionId } = context.params
    const sessionRef = db.collection('sessions').doc(sessionId)

    // A participant just locked in their votes -> if the whole group has now
    // voted, move it on automatically (group -> survey, or -> individual when
    // the group phase comes first).
    if (!before.votesSubmitted && after.votesSubmitted) {
      await finishGroupVoting(sessionId, change.after.id, after)
    }

    // Any phase change -> keep the session-level status in sync (self-healing).
    if (before.status !== after.status) {
      await maybeAdvanceSession(sessionRef, after.status)
    }

    return null
  })
