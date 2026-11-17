/**
 * Group lifecycle regression tests, no credentials/network/Firebase emulator.
 * Run: node tools/group-lifecycle-guard.cjs
 * Real groupLifecycle factory + optimistic, versioned document/query model.
 * Interleavings explicitly invalidate read versions and retry the callback.
 * This verifies transaction logic, NOT Firestore lock timing or service limits.
 */
const assert = require('node:assert/strict')
const { createGroupLifecycle } = require('../functions/groupLifecycle')
const clone = value => value === undefined ? undefined : structuredClone(value)
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code } }
function getPhaseSequence(config = {}) {
  const individual = config.individualPhaseActive ?? true
  const group = config.groupPhaseActive ?? true
  const sequence = ['waiting']
  if (individual && group) sequence.push(...(config.phaseOrder === 'group_first' ? ['group', 'individual'] : ['individual', 'group']))
  else if (individual) sequence.push('individual')
  else if (group) sequence.push('group')
  return [...sequence, 'survey', 'done']
}
function createModel() {
  const records = new Map(), versions = new Map(), collectionVersions = new Map()
  let version = 0, stampCount = 0, autoId = 0
  const stats = { transactions: 0, attempts: 0, retries: 0, documentReads: 0, queryReads: 0 }
  const hooks = { beforeCommit: null, afterQuery: null }
  const parentPath = value => value.slice(0, value.lastIndexOf('/'))
  function put(path, value) {
    if (value === undefined) records.delete(path)
    else records.set(path, clone(value))
    versions.set(path, ++version)
    collectionVersions.set(parentPath(path), version)
  }
  function snapshot(ref, state = records) {
    const data = clone(state.get(ref.path))
    return { id: ref.id, ref, exists: data !== undefined, data: () => clone(data), get: key => key.split('.').reduce((a,k) => a?.[k], data) }
  }
  function field(data, key) { return key.split('.').reduce((a,k) => a?.[k], data) }
  function matching(query, state) {
    let snaps = [...state.keys()].filter(p => parentPath(p) === query.path).map(p => snapshot(doc(p), state))
    for (const [key, op, value] of query.filters) snaps = snaps.filter(s => {
      const actual = key === '__name__' ? s.id : field(s.data(), key)
      if (op === '==') return actual === value
      if (op === '!=') return actual !== undefined && actual !== value
      if (op === 'in') return value.includes(actual)
      if (op === 'array-contains') return Array.isArray(actual) && actual.includes(value)
      throw new Error('Unsupported mock query operator: ' + op)
    })
    for (const [key, direction] of query.orders) snaps.sort((a,b) => {
      const av = a.get(key), bv = b.get(key)
      return (av < bv ? -1 : av > bv ? 1 : 0) * (direction === 'desc' ? -1 : 1)
    })
    if (query.maximum != null) snaps = snaps.slice(0, query.maximum)
    return { docs: snaps, size: snaps.length, empty: snaps.length === 0, forEach: fn => snaps.forEach(fn) }
  }
  function query(path, filters = [], orders = [], maximum = null) {
    return {
      kind: 'query', path, filters, orders, maximum,
      doc: id => doc(path + '/' + (id || 'synthetic-auto-' + (++autoId))),
      where: (key,op,value) => query(path,[...filters,[key,op,value]],orders,maximum),
      orderBy: (key,direction='asc') => query(path,filters,[...orders,[key,direction]],maximum),
      limit: n => query(path,filters,orders,n),
      async get() { const result=matching(this,records);if(hooks.afterQuery){const hook=hooks.afterQuery;hooks.afterQuery=null;await hook(this,result)}return result },
    }
  }
  function doc(path) {
    return {
      kind: 'document', path, id: path.split('/').pop(), collection: name => query(path+'/'+name),
      get: async () => snapshot(doc(path)),
      set: async (value,options) => apply([['set',doc(path),value,options]]),
      update: async value => apply([['update',doc(path),value]]),
      delete: async () => apply([['delete',doc(path)]]),
    }
  }
  function patch(current, changes) {
    const result=clone(current || {})
    for (const [key,value] of Object.entries(changes)) {
      const parts=key.split('.');let cursor=result
      for(const part of parts.slice(0,-1))cursor=cursor[part]??=( {})
      cursor[parts.at(-1)]=clone(value)
    }
    return result
  }
  function apply(operations) {
    const staged = new Map()
    for (const [type,ref,value,options] of operations) {
      const old=staged.has(ref.path)?staged.get(ref.path):records.get(ref.path)
      if(type==='update'){assert(old!==undefined,'Update of missing document '+ref.path);staged.set(ref.path,patch(old,value))}
      else if(type==='create'){assert(old===undefined,'Create of existing document '+ref.path);staged.set(ref.path,clone(value))}
      else if(type==='delete')staged.set(ref.path,undefined)
      else staged.set(ref.path,options?.merge?patch(old,value):clone(value))
    }
    for(const [path,value]of staged)put(path,value)
  }
  function writer(operations) { return Object.fromEntries(['set','update','create','delete'].map(type => [type,(...args)=>{operations.push([type,...args]);return undefined}])) }
  const db = {
    collection: path => query(path), doc,
    getAll: async (...refs) => refs.map(ref => snapshot(ref)),
    batch() {const ops=[];return {...writer(ops),commit:async()=>apply(ops)}},
    async runTransaction(fn, options = {}) {
      stats.transactions++
      for(let attempt=0;attempt<(options.maxAttempts || 20);attempt++) {
        stats.attempts++
        const initial=new Map(records), initialVersions=new Map(versions), initialCollections=new Map(collectionVersions)
        const reads=new Map(), queries=new Map(), operations=[]
        const tx={...writer(operations), async get(ref) {
          assert.equal(operations.length,0,'Firestore forbids transaction reads after writes')
          if(ref.kind==='query') {
            stats.queryReads++;queries.set(ref.path,initialCollections.get(ref.path)||0)
            const result=matching(ref,initial)
            for(const snap of result.docs)reads.set(snap.ref.path,initialVersions.get(snap.ref.path)||0)
            return result
          }
          stats.documentReads++;reads.set(ref.path,initialVersions.get(ref.path)||0)
          return snapshot(ref,initial)
        }}
        tx.getAll=async(...refs)=>Promise.all(refs.map(ref=>tx.get(ref)))
        const result=await fn(tx)
        if(hooks.beforeCommit){const hook=hooks.beforeCommit;hooks.beforeCommit=null;await hook({reads,queries,operations,attempt})}
        const conflict=[...reads].some(([p,v])=>(versions.get(p)||0)!==v)||[...queries].some(([p,v])=>(collectionVersions.get(p)||0)!==v)
        if(conflict){stats.retries++;continue}
        apply(operations);return result
      }
      const error=new Error('Mock transaction exhausted conflict retries');error.code='aborted';throw error
    },
  }
  const sessionRef=doc('sessions/synthetic-lifecycle-test')
  put(sessionRef.path,{code:'SYNTHETIC',status:'waiting',instructorId:'instructor',joinCount:0,phaseConfig:{individualPhaseActive:true,groupPhaseActive:true,phaseOrder:'individual_first',groupSize:3}})
  const lifecycle=createGroupLifecycle({db,stamp:()=>({syntheticStamp:++stampCount}),HttpsError,getPhaseSequence})
  const p=n=>sessionRef.path+'/participants/u'+n, g=n=>sessionRef.path+'/groups/g'+n
  const read=path=>clone(records.get(path))
  const update=(path,change)=>put(path,patch(read(path),change))
  return {db,sessionRef,lifecycle,stats,hooks,p,g,read,update,put,records,
    join:n=>lifecycle.assignToGroup(sessionRef,'u'+n,'Synthetic Student '+n,'synthetic-'+n+'@example.invalid'),
    remove:n=>lifecycle.detachParticipant(sessionRef,'u'+n),
    reconcile:n=>lifecycle.reconcileGroup(sessionRef,'g'+n),
  }
}
const tests=[]
function test(name,body){tests.push({name,body})}
async function joinMany(m,count,start=1){for(let i=start;i<start+count;i++)await m.join(i)}
function states(m,ids,expected){for(const id of ids)assert.equal(m.read(m.p(id))?.status,expected,'u'+id+' status')}
function uniqueRoster(m,n){const group=m.read(m.g(n));assert.equal(new Set(group.members).size,group.members.length);const labels=group.members.map(id=>group.memberLabels[id]);assert.equal(new Set(labels).size,labels.length);assert(labels.every(Boolean))}
function finishIndividual(m,ids){for(const id of ids)m.update(m.p(id),{individualComplete:true,status:'waiting_for_group'})}

test('1,000 arrivals form independent trios; 1,000 duplicate rejoins preserve records',async m=>{
 for(let n=1;n<=1000;n++){
  await m.join(n);assert.equal(m.read(m.p(n)).groupId,'g'+Math.floor((n-1)/3));assert.equal(m.read(m.sessionRef.path).joinCount,n)
  const start=n-(n-1)%3;states(m,Array.from({length:n-start+1},(_,i)=>start+i),n%3===0?'individual':'waiting')
 }
 const groups=JSON.stringify([...m.records].filter(([p])=>p.includes('/groups/')))
 m.update(m.p(1),{status:'done',surveyAnswers:{q:5},surveyCompletedAt:{seconds:1}})
 for(let n=1;n<=1000;n++)await m.join(n)
 assert.equal(m.read(m.sessionRef.path).joinCount,1000);assert.equal(JSON.stringify([...m.records].filter(([p])=>p.includes('/groups/'))),groups);states(m,[1],'done');states(m,[1000],'waiting')
})
test('12 concurrent arrivals plus duplicate requests retry without overlapping groups',async m=>{
 await Promise.all([...Array.from({length:12},(_,i)=>m.join(i+1)),m.join(1),m.join(2),m.join(3)])
 assert.equal(m.read(m.sessionRef.path).joinCount,12)
 const all=[];for(let g=0;g<4;g++){uniqueRoster(m,g);const group=m.read(m.g(g));assert.equal(group.members.length,3);all.push(...group.members)}
 assert.equal(new Set(all).size,12);states(m,Array.from({length:12},(_,i)=>i+1),'individual');assert(m.stats.retries>0)
})
test('Waiting removal fills its vacancy and the following trio remains intact',async m=>{
 await joinMany(m,2);await m.remove(1);await joinMany(m,5,3)
 states(m,[1],'removed');states(m,[2,3,4,5,6,7],'individual');uniqueRoster(m,0);uniqueRoster(m,1)
 assert.equal(m.read(m.p(2)).groupId,m.read(m.p(4)).groupId);assert.equal(m.read(m.p(5)).groupId,m.read(m.p(7)).groupId)
})
test('Two waiting removals refill with unique aliases',async m=>{
 await joinMany(m,2);await m.remove(1);await m.remove(2);await joinMany(m,3,3)
 uniqueRoster(m,0);states(m,[3,4,5],'individual')
})
test('Instructor starts two-person group; later students form a new trio',async m=>{
 await joinMany(m,2);await m.lifecycle.startWaitingGroups(m.sessionRef,'instructor');states(m,[1,2],'individual')
 await joinMany(m,3,3);assert.equal(m.read(m.g(0)).members.length,2);states(m,[3,4,5],'individual');assert.notEqual(m.read(m.p(3)).groupId,'g0')
})
test('Completed partial group and finished members are never reopened by new joins',async m=>{
 await joinMany(m,2);await m.lifecycle.startWaitingGroups(m.sessionRef,'instructor')
 m.update(m.g(0),{status:'done'});m.update(m.p(1),{status:'done',surveyAnswers:{q:1}});m.update(m.p(2),{status:'survey'})
 await joinMany(m,3,3);states(m,[1],'done');states(m,[2],'survey');assert.equal(m.read(m.g(0)).status,'done');states(m,[3,4,5],'individual')
})
test('All active members removed: first replacement resumes working immediately',async m=>{
 await joinMany(m,3);for(let n=1;n<=3;n++)await m.remove(n);await m.join(4);states(m,[4],'individual');assert.equal(m.read(m.p(4)).groupId,'g0')
})
test('Stale vacancy phase follows the current working phase',async m=>{
 await joinMany(m,3);await m.remove(1);for(const n of [2,3])m.update(m.p(n),{status:'group',individualComplete:true})
 await m.join(4);states(m,[4],'group');uniqueRoster(m,0)
})
test('Stale invalid alias cannot duplicate an existing member label',async m=>{
 await joinMany(m,3);await m.remove(1);const queue=m.read(m.sessionRef.path).backfillQueue;assert(queue?.length);queue[0].label='p2';m.update(m.sessionRef.path,{backfillQueue:queue});await m.join(4);uniqueRoster(m,0)
})
test('Completed or deleted vacancy targets are discarded',async m=>{
 await joinMany(m,3);await m.remove(1);m.update(m.g(0),{status:'done'});await m.join(4);assert.notEqual(m.read(m.p(4)).groupId,'g0');assert.equal(m.read(m.g(0)).status,'done')
 m.update(m.sessionRef.path,{backfillQueue:[{groupId:'deleted',label:'p1',phase:'individual'}]});await m.join(5);assert.equal(m.read(m.p(4)).groupId,m.read(m.p(5)).groupId)
})
test('Group target size remains fixed after session setting changes',async m=>{
 await joinMany(m,2);const config=m.read(m.sessionRef.path).phaseConfig;m.update(m.sessionRef.path,{phaseConfig:{...config,groupSize:2}});await m.join(3);states(m,[1,2,3],'individual');assert.equal(m.read(m.g(0)).members.length,3)
})
test('Incomplete individual roster waits; final submission advances whole group',async m=>{
 await joinMany(m,3);m.update(m.p(1),{individualComplete:true});await m.reconcile(0);states(m,[1],'waiting_for_group');states(m,[2,3],'individual')
 finishIndividual(m,[2,3]);await m.reconcile(0);states(m,[1,2,3],'group')
})
test('Late group advances independently while global session is already survey',async m=>{
 m.update(m.sessionRef.path,{status:'survey'});await joinMany(m,3);finishIndividual(m,[1,2,3]);await m.reconcile(0);states(m,[1,2,3],'group');assert.equal(m.read(m.sessionRef.path).status,'survey')
})
test('Group-first members finish individual work independently into survey',async m=>{
 const pc=m.read(m.sessionRef.path).phaseConfig;m.update(m.sessionRef.path,{phaseConfig:{...pc,phaseOrder:'group_first'}});await joinMany(m,3)
 for(const n of [1,2,3])m.update(m.p(n),{status:'group',votesSubmitted:true,votedFor:['idea-current']})
 await m.reconcile(0);states(m,[1,2,3],'individual')
 m.update(m.p(1),{individualComplete:true});await m.reconcile(0);states(m,[1],'survey');states(m,[2,3],'individual')
})
test('Late individualComplete signal cannot demote done or resurrect removed participant',async m=>{
 await joinMany(m,3);m.update(m.p(1),{status:'done',individualComplete:true,surveyAnswers:{q:4}});await m.reconcile(0);states(m,[1],'done')
 await m.remove(2);m.update(m.p(2),{individualComplete:true});await m.reconcile(0);states(m,[2],'removed');assert.equal(m.read(m.p(2)).groupId,null)
})
test('Vote finalization uses current ballots and never demotes completed members',async m=>{
 await joinMany(m,3);for(const n of [1,2,3])m.update(m.p(n),{status:'group',individualComplete:true,votesSubmitted:true,votedFor:['current-idea']})
 m.update(m.p(1),{status:'done',surveyAnswers:{q:4}});await m.reconcile(0)
 assert.deepEqual(m.read(m.g(0)).finalIdeas,['current-idea']);states(m,[1],'done');states(m,[2,3],'survey');assert.equal(m.read(m.g(0)).status,'done')
})
test('Incomplete current ballot prevents premature finalization',async m=>{
 await joinMany(m,3);for(const n of [1,2,3])m.update(m.p(n),{status:'group',individualComplete:true,votesSubmitted:n!==3,votedFor:['idea-'+n]});await m.reconcile(0)
 assert.notEqual(m.read(m.g(0)).status,'done');states(m,[1,2,3],'group')
})
test('Closed session rejects joining and ignores delayed group reconciliation',async m=>{
 await joinMany(m,3);finishIndividual(m,[1,2,3]);m.update(m.sessionRef.path,{status:'done'});await assert.rejects(()=>m.join(4));const before=JSON.stringify([...m.records]);await m.reconcile(0);await m.lifecycle.maybeAdvanceSession(m.sessionRef);assert.equal(JSON.stringify([...m.records]),before)
})
test('Join racing close retries and never writes the new participant',async m=>{
 m.hooks.beforeCommit=async()=>m.update(m.sessionRef.path,{status:'done'});await assert.rejects(()=>m.join(1));assert.equal(m.read(m.p(1)),undefined);assert.equal(m.read(m.sessionRef.path).status,'done');assert(m.stats.retries>0)
})
test('Individual reconciliation racing removal retries using the updated roster',async m=>{
 await joinMany(m,3);finishIndividual(m,[1,2,3]);m.hooks.beforeCommit=async()=>{await m.remove(3)};await m.reconcile(0);states(m,[3],'removed');states(m,[1,2],'group');assert(m.stats.retries>0)
})
test('Straggler start racing a second arrival starts both current members',async m=>{
 await m.join(1);m.hooks.beforeCommit=async()=>{await m.join(2)};await m.lifecycle.startWaitingGroups(m.sessionRef,'instructor');states(m,[1,2],'individual');assert(m.stats.retries>0)
 await joinMany(m,3,3);states(m,[3,4,5],'individual');assert.notEqual(m.read(m.p(3)).groupId,'g0')
})
test('Straggler start racing removal never restores the removed participant',async m=>{
 await joinMany(m,2);m.hooks.beforeCommit=async()=>{await m.remove(1)};await m.lifecycle.startWaitingGroups(m.sessionRef,'instructor');states(m,[1],'removed');states(m,[2],'individual');assert(m.stats.retries>0)
})
test('Straggler start racing close cannot reopen session',async m=>{
 await joinMany(m,2);m.hooks.beforeCommit=async()=>m.update(m.sessionRef.path,{status:'done'});try{await m.lifecycle.startWaitingGroups(m.sessionRef,'instructor')}catch(e){assert(['failed-precondition','not-found'].includes(e.code))}
 assert.equal(m.read(m.sessionRef.path).status,'done');states(m,[1,2],'waiting');assert(m.stats.retries>0)
})
test('Aggregate phase update racing close preserves terminal session',async m=>{
 await joinMany(m,3);for(const n of [1,2,3])m.update(m.p(n),{status:'survey'});m.hooks.beforeCommit=async()=>m.update(m.sessionRef.path,{status:'done'});await m.lifecycle.maybeAdvanceSession(m.sessionRef);assert.equal(m.read(m.sessionRef.path).status,'done');assert(m.stats.retries>0)
})
test('Vote finalization racing a new backfill does not omit the new member',async m=>{
 await joinMany(m,3);for(const n of [1,2,3])m.update(m.p(n),{status:'group',individualComplete:true,votesSubmitted:n!==1,votedFor:['current']})
 // Persist the result of removing u1, before asynchronous reconciliation.
 m.update(m.p(1),{status:'removed',removed:true,groupId:null});const g=m.read(m.g(0));delete g.memberLabels.u1;m.update(m.g(0),{members:['u2','u3'],memberLabels:g.memberLabels,full:false});m.update(m.sessionRef.path,{backfillQueue:[{groupId:'g0',label:'p1',phase:'group'}]})
 m.hooks.beforeCommit=async()=>{await m.join(4)};await m.reconcile(0);assert.notEqual(m.read(m.g(0)).status,'done');states(m,[4],'group');assert(m.stats.retries>0)
})
test('Non-instructor cannot start waiting groups or advance session',async m=>{
 await m.join(1);await assert.rejects(()=>m.lifecycle.startWaitingGroups(m.sessionRef,'intruder'));await assert.rejects(()=>m.lifecycle.advanceSession(m.sessionRef,'intruder','waiting'));states(m,[1],'waiting')
})
test('Expected phase prevents duplicate force advance',async m=>{
 await m.join(1);await m.lifecycle.advanceSession(m.sessionRef,'instructor','waiting');assert.equal(m.read(m.sessionRef.path).status,'individual')
 try{await m.lifecycle.advanceSession(m.sessionRef,'instructor','waiting')}catch(e){assert(['failed-precondition','aborted'].includes(e.code))}
 assert.equal(m.read(m.sessionRef.path).status,'individual')
})
test('Force advance racing removal preserves removed status',async m=>{
 await joinMany(m,2);m.hooks.beforeCommit=async()=>{await m.remove(1)};await m.lifecycle.advanceSession(m.sessionRef,'instructor','waiting');states(m,[1],'removed');states(m,[2],'individual');assert(m.stats.retries>0)
})
test('Individual-only sessions start immediately and complete independently',async m=>{
 const pc=m.read(m.sessionRef.path).phaseConfig;m.update(m.sessionRef.path,{phaseConfig:{...pc,groupPhaseActive:false}});await joinMany(m,4);states(m,[1,2,3,4],'individual');m.update(m.p(1),{individualComplete:true});await m.reconcile(0);states(m,[1],'survey');states(m,[2,3,4],'individual')
})

test('Group-first vacancy uses the earliest current working phase in sequence order',async m=>{
 const pc=m.read(m.sessionRef.path).phaseConfig;m.update(m.sessionRef.path,{phaseConfig:{...pc,phaseOrder:'group_first'}});await joinMany(m,3);await m.remove(1)
 m.update(m.p(2),{status:'individual',votesSubmitted:true});m.update(m.p(3),{status:'group',votesSubmitted:false});await m.join(4);states(m,[4],'group')
})
test('Aggregate query racing a new waiting arrival retries without falsely advancing session',async m=>{
 await joinMany(m,3);for(const n of [1,2,3])m.update(m.p(n),{status:'group',individualComplete:true})
 m.hooks.beforeCommit=async()=>{await m.join(4)};await m.lifecycle.maybeAdvanceSession(m.sessionRef)
 assert.equal(m.read(m.sessionRef.path).status,'individual');states(m,[4],'waiting');assert(m.stats.retries>0)
})
test('Ballot changed after reconciliation read is re-read before finalization',async m=>{
 await joinMany(m,3);for(const n of [1,2,3])m.update(m.p(n),{status:'group',individualComplete:true,votesSubmitted:true,votedFor:['old-idea']})
 m.hooks.beforeCommit=async()=>m.update(m.p(3),{votesSubmitted:false,votedFor:['new-idea']});await m.reconcile(0)
 assert.notEqual(m.read(m.g(0)).status,'done');states(m,[1,2,3],'group');assert(m.stats.retries>0)
 m.update(m.p(3),{votesSubmitted:true});await m.reconcile(0);assert(m.read(m.g(0)).finalIdeas.includes('new-idea'))
})
test('Force advance racing a group-filling join rejects stale expected phase',async m=>{
 await joinMany(m,2);m.hooks.beforeCommit=async()=>{await m.join(3)}
 await assert.rejects(()=>m.lifecycle.advanceSession(m.sessionRef,'instructor','waiting'))
 assert.equal(m.read(m.sessionRef.path).status,'individual');states(m,[1,2,3],'individual');assert(m.stats.retries>0)
})
test('Account-deletion activeOnly detachment preserves completed gameplay records',async m=>{
 await joinMany(m,3);m.update(m.p(1),{status:'done',surveyAnswers:{q:5}});const before=m.read(m.p(1));const result=await m.lifecycle.detachParticipant(m.sessionRef,'u1',{activeOnly:true})
 assert(result.skipped);assert.deepEqual(m.read(m.p(1)),before);assert(m.read(m.g(0)).members.includes('u1'))
})

;(async()=>{
 let failed=0;const summary=[]
 for(const {name,body}of tests){const model=createModel();try{await body(model);console.log('PASS '+name);summary.push({name,passed:true,...model.stats})}catch(error){failed++;console.error('FAIL '+name+'\n'+error.stack);summary.push({name,passed:false,error:error.message,...model.stats})}}
 console.log(JSON.stringify({scope:'Actual groupLifecycle factory with optimistic in-memory transactions; not real Firebase concurrency.',passed:tests.length-failed,failed,assertionScenarios:tests.length,transactionRetries:summary.reduce((sum,r)=>sum+r.retries,0)},null,2))
 if(process.env.GROUP_LIFECYCLE_REPORT)require('node:fs').writeFileSync(process.env.GROUP_LIFECYCLE_REPORT,JSON.stringify(summary,null,2))
 process.exitCode=failed?1:0
})().catch(error=>{console.error(error);process.exitCode=2})
