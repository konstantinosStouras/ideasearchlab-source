import { useState, useEffect } from 'react'
import { doc, onSnapshot, getDoc, db } from '../utils/db'
// Read the authoritative tally, never invent a result while the backend is finishing.
export default function GroupResults({ sessionId, groupId }) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    setResult(null)
    if (!sessionId || !groupId) return
    let active = true
    const stop = onSnapshot(doc(db, 'sessions', sessionId, 'groups', groupId), async snap => {
      const group = snap.data()
      if (!group || group.status !== 'done') return
      try {
        const docs = await Promise.all((group.finalIdeas || []).map(id => getDoc(doc(db, 'sessions', sessionId, 'ideas', id))))
        if (active) setResult(docs.filter(d => d.exists()).map(d => ({ id: d.id, ...d.data() })))
      } catch { /* the survey remains available even if the result read fails */ }
    })
    return () => { active = false; stop() }
  }, [sessionId, groupId])
  if (!groupId) return null
  return <section aria-label="Your group's selected ideas" style={{ marginBottom: 24 }}>
    <h2>Your group's selected ideas</h2>
    {result === null ? <p>Your group's result is being saved. You can complete the survey now.</p>
      : result.length ? result.map(idea => <article key={idea.id} style={{ marginTop: 12 }}>
        <h3>{idea.title || idea.text}</h3><p>{idea.description}</p>
      </article>) : <p>No ideas were selected by your group.</p>}
  </section>
}
