import { useState, useEffect } from 'react'
import { collection, doc, query, where, onSnapshot, httpsCallable, db, functions } from './db'
export function useGroupRoster(sessionId, groupId) {
  const [members, setMembers] = useState([])
  useEffect(() => {
    setMembers([])
    if (!sessionId || !groupId) return
    let active = true
    let retry
    let expected = null
    let records = new Map()
    // A projection can arrive one member at a time. Never let a partial roster
    // satisfy "everyone submitted" and advance the group prematurely.
    const publish = () => {
      if (!active) return
      setMembers(expected?.length && expected.every(uid => records.has(uid))
        ? expected.map(uid => records.get(uid)) : [])
    }
    async function ensure() {
      try { await httpsCallable(functions, 'ensureGroupRoster')({ sessionId }) }
      catch (e) { if (active) retry = setTimeout(ensure, 5000) }
    }
    ensure()
    const stopGroup = onSnapshot(doc(db, 'sessions', sessionId, 'groups', groupId), snap => {
      expected = snap.data()?.members || []
      publish()
    }, err => console.error('Group membership unavailable:', err))
    const stop = onSnapshot(query(collection(db, 'sessions', sessionId, 'participantPublic'), where('groupId', '==', groupId)),
      snap => {
        records = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]))
        publish()
      }, err => console.error('Group progress unavailable:', err))
    return () => { active = false; clearTimeout(retry); stop(); stopGroup() }
  }, [sessionId, groupId])
  return members
}
