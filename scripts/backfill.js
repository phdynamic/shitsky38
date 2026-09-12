// Re-reads ballots straight out of repos, for when the firehose consumer was down.
//
//   node scripts/backfill.js                 # every voter we have ever seen
//   node scripts/backfill.js alice.bsky.social did:plc:xyz
import { db } from '../src/db.js'
import { resolveHandle } from '../src/bluesky.js'
import { syncBallotFromRepo, syncProfileFromRepo } from '../src/ballot.js'

const args = process.argv.slice(2)

const dids = args.length
  ? await Promise.all(args.map((arg) => (arg.startsWith('did:') ? arg : resolveHandle(arg))))
  : db.prepare('SELECT DISTINCT voter_did FROM vote').all().map((row) => row.voter_did)

console.log(`backfilling ${dids.length} repo(s)`)

let ok = 0
for (const did of dids) {
  try {
    const [votes] = await Promise.all([syncBallotFromRepo(did), syncProfileFromRepo(did)])
    console.log(`  ${did}: ${votes} vote(s)`)
    ok++
  } catch (err) {
    console.warn(`  ${did}: ${err.message}`)
  }
}
console.log(`done — ${ok}/${dids.length} repos read`)
