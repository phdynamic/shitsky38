// Once voting closes the rosters stop moving, even though follower counts do not.
// Run with: LIST_SIZE=3 VOTING_CLOSES_AT=2026-09-02 node test/feedfreeze.test.js
import assert from 'node:assert/strict'
import * as store from '../src/db.js'
import { votingState } from '../src/config.js'
import { refreshMembership } from '../src/feeds.js'

assert.equal(votingState(), 'closed', 'run this suite with VOTING_CLOSES_AT in the past')

const t = (n) => new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString()
const give = (subject, n, startMinute = 0) => {
  for (let i = 0; i < n; i++) {
    store.upsertVote({ voterDid: `did:plc:v${i}`, subjectDid: subject, rkey: subject, createdAt: t(startMinute + i) })
  }
}

give('did:plc:A', 20, 0)
give('did:plc:B', 18, 5)
give('did:plc:C', 16, 10)
give('did:plc:D', 4, 15)
store.upsertActor({ did: 'did:plc:D', handle: 'd.test', followers: 900 })

// First pass after the close still has to build the rosters, or a restart would serve nothing.
refreshMembership()
assert.deepEqual(store.feedMembers('deep-cuts'), ['did:plc:D'])
console.log('✓ a first run after the close still builds the rosters')

// D gets popular. On an open poll that would drop them; after the close it must not.
store.upsertActor({ did: 'did:plc:D', handle: 'd.test', followers: 250_000 })
const changes = refreshMembership()
assert.equal(changes['deep-cuts'].frozen, true)
assert.deepEqual(store.feedMembers('deep-cuts'), ['did:plc:D'])
console.log('✓ crossing the follower line after the close does not remove you')

// And a late vote cannot add anybody.
give('did:plc:E', 9, 40)
store.upsertActor({ did: 'did:plc:E', handle: 'e.test', followers: 10 })
refreshMembership()
assert.deepEqual(store.feedMembers('deep-cuts'), ['did:plc:D'])
console.log('✓ nobody joins a closed list')

// Unless the owner deliberately rebuilds it.
const forced = refreshMembership({ force: true })
assert.ok(!store.feedMembers('deep-cuts').includes('did:plc:D'), 'D is too big now')
assert.equal(forced['deep-cuts'].frozen, undefined)
console.log('✓ a forced rebuild still recomputes from scratch')

console.log('\nthe rosters freeze when the poll does')
