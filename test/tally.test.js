// Counting rules. Run with: npm test
import assert from 'node:assert/strict'
import * as store from '../src/db.js'
import { config } from '../src/config.js'

const t = (n) => new Date(Date.UTC(2026, 8, n)).toISOString()
const did = (n) => `did:plc:${n}`
const voter = (n) => `did:plc:voter${n}`
const put = (v, s, d) => store.upsertVote({ voterDid: voter(v), subjectDid: did(s), rkey: did(s), createdAt: t(d) })

put(1, 'A', 1); put(2, 'A', 2); put(3, 'A', 3)
put(1, 'B', 1); put(2, 'B', 2)
put(1, 'C', 4)
assert.deepEqual(
  store.leaderboard({ limit: 9 }).map((r) => [r.did.slice(-1), r.votes, r.rank]),
  [['A', 3, 1], ['B', 2, 2], ['C', 1, 3]],
)
console.log('✓ ranking by vote count')

put(1, 'A', 5)
assert.equal(store.leaderboard({ limit: 1 })[0].votes, 3)
console.log('✓ one voter cannot double-vote a subject')

for (let i = 0; i < 15; i++) put('stuffer', `S${i}`, 10 + i)
assert.equal(store.leaderboard({ limit: 99 }).filter((r) => r.did.includes(':S')).length, config.maxVotes)
assert.equal(store.getBallot(voter('stuffer')).length, 15)
console.log(`✓ ballot cap: 15 records written, ${config.maxVotes} counted`)

store.upsertNomineeProfile(did('A'), { optOut: true })
assert.equal(store.standing(did('A')), null)
store.upsertNomineeProfile(did('A'), { optOut: false })
assert.equal(store.leaderboard({ limit: 1 })[0].did, did('A'))
console.log('✓ opt-out hides a nominee, rejoining restores them')

store.upsertVote({ voterDid: voter(9), subjectDid: did('B'), rkey: did('B'), createdAt: '2099-01-01T00:00:00.000Z' })
assert.equal(store.standing(did('B')).votes, 2)
console.log('✓ votes dated after close are ignored')

store.deleteVote(voter(1), did('A'))
assert.equal(store.standing(did('A')).votes, 2)
console.log('✓ taking a vote back lowers the count')

// Among equals, whoever reached the total first is listed first — what the FAQ promises.
put('x1', 'SLOW', 1); put('x2', 'SLOW', 2); put('x3', 'SLOW', 25)
put('y1', 'FAST', 5); put('y2', 'FAST', 6); put('y3', 'FAST', 7)
const tied = store.leaderboard({ limit: 99 }).filter((r) => [did('SLOW'), did('FAST')].includes(r.did))
assert.deepEqual(tied.map((r) => r.did), [did('FAST'), did('SLOW')])
assert.equal(tied[0].rank, tied[1].rank, 'tied accounts must share a rank')
console.log('✓ a tie lists whoever reached that total first, sharing the rank')

// Both directions of the audit view, with the counted flag.
assert.ok(store.votersFor(did('A')).length > 0)
assert.ok(store.ballotOf(voter(1)).length > 0)
console.log('✓ audit queries answer in both directions')

console.log('\nall tally rules hold')
