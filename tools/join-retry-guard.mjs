import assert from 'node:assert/strict'
import { retrySessionJoin } from '../src/utils/retrySessionJoin.js'
let calls=0,time=0,retries=0
const payload={code:'QA'}
const opts={now:()=>time,random:()=>0.5,sleep:async ms=>{time+=ms},onRetry:()=>retries++}
const result=await retrySessionJoin(async data=>{assert.equal(data,payload);calls++;if(calls<4)throw Object.assign(new Error('Busy'),{code:'functions/resource-exhausted'});return {sessionId:'qa'}},payload,opts)
assert.equal(calls,4);assert.equal(retries,3);assert.equal(result.sessionId,'qa');assert.equal(time,3500)
for(const code of ['functions/permission-denied','functions/unauthenticated','functions/not-found','functions/failed-precondition','functions/invalid-argument']){
 calls=0;await assert.rejects(()=>retrySessionJoin(async()=>{calls++;throw Object.assign(new Error(code),{code})},payload,opts));assert.equal(calls,1)
}
calls=0;time=0;await assert.rejects(()=>retrySessionJoin(async()=>{calls++;throw Object.assign(new Error('Busy'),{code:'functions/unavailable'})},payload,{...opts,timeoutMs:1000}));assert.equal(time,1000);assert.equal(calls,2)
calls=0;time=0;await assert.rejects(()=>retrySessionJoin(async()=>{calls++;throw Object.assign(new Error('Busy'),{code:'functions/internal'})},payload,{...opts,maxAttempts:3}));assert.equal(calls,3)
calls=0;const ok=await retrySessionJoin(async()=>{calls++;return 'ok'},payload,opts);assert.equal(ok,'ok');assert.equal(calls,1)
console.log('PASS retry: transient recovery, identical payload, bounded deadline/attempts, immediate success, five permanent errors never retried')
