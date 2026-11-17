// Group membership and phase changes share the same transactional read set.
// Event snapshots and pre-transaction queries locate work; they never decide
// which current participants should move or which submitted ballot is tallied.
const { statusPhaseIndex, shouldSetStatus, isFinishedParticipant } = require('./phaseGuard')

function createGroupLifecycle({ db, stamp, HttpsError, getPhaseSequence }) {
  const options = { maxAttempts: 20 }
  const readMany = (tx, refs) => tx.getAll ? tx.getAll(...refs) : Promise.all(refs.map(ref => tx.get(ref)))
  const active = p => p && !p.removed && p.status !== 'removed'
  const working = p => active(p) && !isFinishedParticipant(p) && p.status !== 'survey'
  const normalized = s => s === 'waiting_for_group' ? 'individual' : s === 'voting' ? 'group' : s
  function groupSize(session) {
    const n = Number(session.assignmentGroupSize ?? session.phaseConfig?.groupSize)
    return session.assignmentGroupSize != null ? Math.max(1, Math.floor(n) || 3)
      : session.phaseConfig?.groupPhaseActive === false ? 1
      : Number.isFinite(n) ? Math.max(1, Math.floor(n) || 3) : 3
  }
  function requireOpen(snap) {
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found.')
    if (snap.data().status === 'done') throw new HttpsError('failed-precondition', 'This session is closed.')
    return snap.data()
  }
  function requireInstructor(session, uid) {
    if (session.instructorId !== uid) throw new HttpsError('permission-denied', 'Only the instructor can do this.')
  }
  async function readGroup(tx, sessionRef, id) {
    const ref = sessionRef.collection('groups').doc(id)
    const snap = await tx.get(ref)
    const data = snap.exists ? snap.data() : null
    const ids = data?.members || []
    const records = ids.length ? await readMany(tx, ids.map(uid => sessionRef.collection('participants').doc(uid))) : []
    const members = records.filter(s => s.exists).map(s => ({ ...s.data(), id: s.id, ref: s.ref }))
    const valid = members.length === ids.length && new Set(ids).size === ids.length && members.every(p => active(p) && p.groupId === id)
    return { ref, data, ids, members, valid }
  }
  function tally(members) {
    const counts = {}
    // Preserve the former participant-query ordering for tied ballots.
    members.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).filter(p => p.votesSubmitted && active(p)).forEach(p => {
      for (const id of p.votedFor || []) counts[id] = (counts[id] || 0) + 1
    })
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
  }

  async function assignToGroup(sessionRef, uid, name, email) {
    return db.runTransaction(async tx => {
      const pRef = sessionRef.collection('participants').doc(uid)
      const [sessionSnap, existing] = await readMany(tx, [sessionRef, pRef])
      const session = requireOpen(sessionSnap)
      if (existing.exists) {
        tx.update(pRef, { name, email, uid })
        return existing.data().status
      }
      const size = groupSize(session)
      const sequence = getPhaseSequence(session.phaseConfig)
      const first = sequence[1] || 'survey'
      const count = session.joinCount || 0
      let cursor = Number.isInteger(session.groupJoinCursor) ? session.groupJoinCursor : Math.floor(count / size)
      const legacyCursor = session.groupJoinCursor == null
      const queue = Array.isArray(session.backfillQueue) ? [...session.backfillQueue] : []
      const cache = new Map()
      async function read(id) {
        if (!cache.has(id)) cache.set(id, await readGroup(tx, sessionRef, id))
        return cache.get(id)
      }
      let target, backfilled = false, phase = 'waiting', requestedLabel
      while (queue.length && !target) {
        const slot = queue.shift()
        if (!slot || typeof slot.groupId !== 'string' || !slot.groupId || slot.groupId.includes('/')) continue
        const g = await read(slot.groupId)
        if (!g.data || g.data.status !== 'active' || g.data.full || !g.valid || g.ids.length >= (g.data.targetSize || size)) continue
        const live = g.members.filter(working)
        if (g.members.length && !live.length) continue
        // An empty working group resumes the saved working phase. Empty.every()
        // must not classify it as a waiting group and strand its replacement.
        const currentPhase = live.length
          ? live.map(p => normalized(p.status)).sort((a, b) => sequence.indexOf(a) - sequence.indexOf(b))[0]
          : slot.phase
        if (!['waiting', 'individual', 'group'].includes(currentPhase) || !sequence.includes(currentPhase)) continue
        // A waiting vacancy becomes sealed if the instructor starts the group.
        if (slot.phase === 'waiting' && currentPhase !== 'waiting') continue
        target = g; backfilled = true; phase = currentPhase; requestedLabel = slot.label
      }
      if (!target) {
        while (!target) {
          const g = await read('g' + cursor)
          const missingLegacyPartial = !g.data && legacyCursor && cursor === Math.floor(count / size) && count % size !== 0
          if (!missingLegacyPartial && (!g.data || (
            g.data.status === 'active' && !g.data.full && !g.data.startedAt && g.valid &&
            g.ids.length < (g.data.targetSize || size) && g.members.every(p => p.status === 'waiting' && !isFinishedParticipant(p))
          ))) target = g
          else cursor++
        }
      }
      const targetSize = target.data?.targetSize || size
      const prevLabels = target.data?.memberLabels || {}
      const used = new Set(target.members.flatMap(p => [p.anonymousLabel, prevLabels[p.id]]).filter(Boolean))
      const labels = Array.from({ length: targetSize }, (_, i) => 'p' + (i + 1))
      const label = labels.includes(requestedLabel) && !used.has(requestedLabel) ? requestedLabel : labels.find(l => !used.has(l))
      if (!label) throw new HttpsError('failed-precondition', 'Group labels are inconsistent.')
      const members = [...target.ids, uid]
      const full = members.length >= targetSize
      const starting = phase === 'waiting' && full
      const status = starting ? first : phase
      tx.set(pRef, { name, email, uid, joinedAt: stamp(), status, individualComplete: false,
        groupId: target.ref.id, anonymousLabel: label, ...(backfilled ? { backfilled: true } : {}) })
      tx.set(target.ref, { members, memberLabels: { ...prevLabels, [uid]: label }, full,
        status: 'active', targetSize,
        ...(!target.data ? { createdAt: stamp(), finalIdeas: [] } : {}),
        ...(starting ? { startedAt: stamp() } : {}) }, { merge: true })
      const update = { assignmentGroupSize: size, backfillQueue: queue }
      if (!backfilled) {
        update.joinCount = count + 1
        update.groupJoinCursor = full ? cursor + 1 : cursor
      }
      if (starting) {
        for (const member of target.members) {
          if (member.status === 'waiting' && shouldSetStatus(member, first, sequence)) tx.update(member.ref, { status: first })
        }
        if (session.status === 'waiting') Object.assign(update, { status: first, phaseStartedAt: stamp() })
      }
      tx.update(sessionRef, update)
      return status
    }, options)
  }

  async function maybeAdvanceSession(sessionRef, statusHint) {
    return db.runTransaction(async tx => {
      const ss = await tx.get(sessionRef)
      if (!ss.exists || ss.data().status === 'done') return
      const session = ss.data(), sequence = getPhaseSequence(session.phaseConfig)
      const current = sequence.indexOf(session.status)
      if (current < 0 || current >= sequence.length - 2) return
      const hinted = statusPhaseIndex(statusHint, sequence)
      // Joining a later group or entering an intra-phase waiting state cannot
      // advance an already later global phase. Avoid locking the whole class.
      if (statusHint !== 'removed' && hinted >= 0 && hinted <= current) return
      // Admin SDK transactions support query reads. Holding the session read
      // also makes a concurrent join or instructor closure retry this decision.
      const rows = await tx.get(sessionRef.collection('participants'))
      const members = rows.docs.map(d => d.data()).filter(active)
      if (!members.length) return
      for (let i = sequence.length - 2; i > current; i--) {
        if (members.every(p => isFinishedParticipant(p) || statusPhaseIndex(p.status, sequence) >= i)) {
          tx.update(sessionRef, { status: sequence[i], phaseStartedAt: stamp() })
          break
        }
      }
    }, options)
  }

  async function reconcileGroup(sessionRef, groupId, { updateSession = true } = {}) {
    if (!groupId) return
    await db.runTransaction(async tx => {
      const ss = await tx.get(sessionRef)
      if (!ss.exists || ss.data().status === 'done') return
      const session = ss.data(), sequence = getPhaseSequence(session.phaseConfig)
      const g = await readGroup(tx, sessionRef, groupId)
      if (!g.data || !g.valid || !g.members.length) return
      const individualIndex = sequence.indexOf('individual'), groupIndex = sequence.indexOf('group')
      const patches = new Map()
      const move = (p, status) => { if (shouldSetStatus(p, status, sequence)) patches.set(p.id, status) }
      if (individualIndex >= 0 && (groupIndex < 0 || individualIndex > groupIndex)) {
        for (const p of g.members) if (normalized(p.status) === 'individual' && p.individualComplete) move(p, 'survey')
      } else if (individualIndex >= 0 && g.data.status === 'active') {
        const allDone = g.members.every(p => p.individualComplete || isFinishedParticipant(p) || statusPhaseIndex(p.status, sequence) >= groupIndex)
        if (allDone) g.members.forEach(p => move(p, 'group'))
        else for (const p of g.members) {
          if (p.status === 'individual' && p.individualComplete && !isFinishedParticipant(p)) patches.set(p.id, 'waiting_for_group')
        }
      }
      const allVoted = groupIndex >= 0 && g.data.status === 'active' && g.members.every(p => p.votesSubmitted && statusPhaseIndex(p.status, sequence) >= groupIndex)
      if (allVoted) {
        tx.update(g.ref, { status: 'done', finalIdeas: tally(g.members), votingCompletedAt: stamp() })
        g.members.forEach(p => move(p, sequence[groupIndex + 1]))
      }
      for (const p of g.members) if (patches.has(p.id)) tx.update(p.ref, { status: patches.get(p.id) })
    }, options)
    if (updateSession) await maybeAdvanceSession(sessionRef)
  }

  async function detachParticipant(sessionRef, uid, opts = {}) {
    const result = await db.runTransaction(async tx => {
      const ss = await tx.get(sessionRef)
      if (!ss.exists) return { notFound: true }
      const session = ss.data(), pRef = sessionRef.collection('participants').doc(uid), ps = await tx.get(pRef)
      if (!ps.exists) return { notFound: true }
      const p = ps.data()
      if (p.removed) return { alreadyRemoved: true }
      if (opts.activeOnly && (session.status === 'done' || !working(p))) return { skipped: true }
      const groupId = p.groupId || null, g = groupId ? await readGroup(tx, sessionRef, groupId) : null
      tx.update(pRef, { removed: true, removedAt: stamp(), status: 'removed', groupId: null, removedFromGroupId: groupId })
      if (g?.data) {
        const members = g.ids.filter(id => id !== uid), labels = { ...(g.data.memberLabels || {}) }
        delete labels[uid]
        tx.update(g.ref, { members, memberLabels: labels, full: members.length >= (g.data.targetSize || groupSize(session)) })
        const phase = normalized(p.status)
        if (session.status !== 'done' && working(p) && ['waiting', 'individual', 'group'].includes(phase) && g.data.status === 'active') {
          const queue = Array.isArray(session.backfillQueue) ? [...session.backfillQueue] : []
          queue.push({ groupId, label: p.anonymousLabel || null, phase })
          tx.update(sessionRef, { backfillQueue: queue })
        }
      }
      return { groupId }
    }, options)
    if (result.groupId) await reconcileGroup(sessionRef, result.groupId)
    return result
  }

  async function startWaitingGroups(sessionRef, instructorUid) {
    const session = requireOpen(await sessionRef.get())
    requireInstructor(session, instructorUid)
    const groups = await sessionRef.collection('groups').get()
    let handled = 0
    for (const doc of groups.docs) {
      handled += await db.runTransaction(async tx => {
        const s = requireOpen(await tx.get(sessionRef))
        requireInstructor(s, instructorUid)
        const g = await readGroup(tx, sessionRef, doc.id)
        if (!g.data || g.data.status !== 'active' || !g.valid) return 0
        const sequence = getPhaseSequence(s.phaseConfig), first = sequence[1]
        const waiting = g.members.filter(p => p.status === 'waiting' && !isFinishedParticipant(p))
        if (!waiting.length) return 0
        // A join/removal changes this group's roster, so a concurrent start
        // retries and includes every current waiting member, never a stale list.
        for (const p of waiting) tx.update(p.ref, { status: first })
        tx.update(g.ref, { full: true, startedAt: stamp(), targetSize: g.data.targetSize || groupSize(s) })
        const update = { backfillQueue: (s.backfillQueue || []).filter(slot => !(slot.groupId === doc.id && slot.phase === 'waiting')) }
        if (s.status === 'waiting') Object.assign(update, { status: first, phaseStartedAt: stamp() })
        tx.update(sessionRef, update)
        return waiting.length
      }, options)
    }
    return { handled }
  }

  async function advanceSession(sessionRef, instructorUid, expectedStatus) {
    return db.runTransaction(async tx => {
      const session = requireOpen(await tx.get(sessionRef))
      requireInstructor(session, instructorUid)
      if (expectedStatus && session.status !== expectedStatus) throw new HttpsError('failed-precondition', 'The session advanced while this request was being prepared. Refresh and try again.')
      const sequence = getPhaseSequence(session.phaseConfig), index = sequence.indexOf(session.status)
      if (index < 0 || index >= sequence.length - 1) throw new HttpsError('failed-precondition', 'Session is already at the final phase.')
      const nextPhase = sequence[index + 1]
      const [ps, gs] = await Promise.all([tx.get(sessionRef.collection('participants')), tx.get(sessionRef.collection('groups'))])
      const members = ps.docs.map(d => ({ ...d.data(), id: d.id, ref: d.ref }))
      for (const p of members) if (shouldSetStatus(p, nextPhase, sequence)) tx.update(p.ref, { status: nextPhase })
      for (const g of gs.docs) {
        if (g.data().status !== 'active') continue
        const own = members.filter(p => p.groupId === g.id && active(p))
        if (session.status === 'group') tx.update(g.ref, { status: 'done', finalIdeas: tally(own), votingCompletedAt: stamp() })
        else if (own.some(p => p.status === 'waiting')) tx.update(g.ref, { full: true, startedAt: stamp(), targetSize: g.data().targetSize || groupSize(session) })
      }
      tx.update(sessionRef, { status: nextPhase, phaseStartedAt: stamp(), backfillQueue: (session.backfillQueue || []).filter(slot => slot.phase !== 'waiting') })
      return { nextPhase }
    }, options)
  }
  return { assignToGroup, detachParticipant, reconcileGroup, maybeAdvanceSession, startWaitingGroups, advanceSession }
}
module.exports = { createGroupLifecycle }
