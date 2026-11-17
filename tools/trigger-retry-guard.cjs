const assert = require('node:assert/strict')
process.env.GCLOUD_PROJECT = 'ideasearchlab'
const functions = require('../functions/index')

for (const name of ['autoGroupParticipants', 'onParticipantUpdated', 'syncParticipantPublic']) {
  assert.deepEqual(functions[name].__trigger.failurePolicy, { retry: {} }, `${name} must retry dropped events`)
}
for (const name of ['joinSession', 'advancePhase']) {
  assert.equal(functions[name].__trigger.failurePolicy, undefined, `${name} must retain callable behavior`)
}
console.log('PASS progression and roster events retry without changing callable configuration')
