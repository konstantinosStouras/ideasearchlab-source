import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot, httpsCallable, db, functions } from './db'
export function useGroupRoster(sessionId, groupId) {
  const [members, setMembers] = useState([])
  useEffect(() => {
    setMembers([])
    if (!sessionId || !groupId) return
    let active = true
    let retry
    async function ensure() {
      try { await httpsCallable(functions, 'ensureGroupRoster')({ sessionId }) }
      catch (e) { if (active) retry = setTimeout(ensure, 5000) }
    }
    ensure()
    const stop = onSnapshot(query(collection(db, 'sessions', sessionId, 'participantPublic'), where('groupId', '==', groupId)),
      snap => setMembers(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => console.error('Group progress unavailable:', err))
    return () => { active = false; clearTimeout(retry); stop() }
  }, [sessionId, groupId])
  return members
}
