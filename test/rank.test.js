// Competition ranking and the cut. Run with: LIST_SIZE=4 node test/rank.test.js
import assert from 'node:assert/strict'
import * as store from '../src/db.js'
import { config } from '../src/config.js'

const t = (n) => new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString()
const give = (subject, n, startMinute = 0) => {
  for (let i = 0; i < n; i++) {
    store.upsertVote({
      voterDid: `did:plc:v${i}`,
      subjectDid: subject,
      rkey: subject,
      createdAt: t(startMinute + i),
    })
  }
}

give('did:plc:A', 10, 0)
give('did:plc:B', 8, 5)
give('did:plc:C', 8, 10)
give('did:plc:D', 5, 15)
give('did:plc:E', 5, 20)
give('did:plc:F', 5, 25)
give('did:plc:G', 1, 30)

const board = store.leaderboard({ limit: 20 })
assert.deepEqual(
  board.map((r) => [r.did.slice(-1), r.votes, r.rank]),
  [['A', 10, 1], ['B', 8, 2], ['C', 8, 2], ['D', 5, 4], ['E', 5, 4], ['F', 5, 4], ['G', 1, 7]],
)
console.log('✓ equal totals share a rank, the next total skips ahead (1,2,2,4,4,4,7)')

assert.equal(store.standing('did:plc:C').rank, 2)
assert.equal(store.standing('did:plc:G').rank, 7)
console.log('✓ a profile page reports the same shared rank')

if (config.listSize === 4) {
  const top = store.topList()
  assert.deepEqual(top.map((r) => r.did.slice(-1)), ['A', 'B', 'C', 'D', 'E', 'F'])
  console.log(`✓ a tie on the cut keeps everyone in it — ${top.length} names for a list of ${config.listSize}`)

  const rest = store.leaderboard({ limit: 10, offset: top.length })
  assert.deepEqual(rest.map((r) => r.did.slice(-1)), ['G'])
  console.log('✓ the next page resumes after them, nothing duplicated or skipped')
} else {
  console.log(`(skipped the cut checks — run with LIST_SIZE=4, this run had ${config.listSize})`)
}

console.log('\nall ranking rules hold')
