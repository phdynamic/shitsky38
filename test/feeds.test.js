// The two feeds: who is in them, and what the skeleton serves.
// Run with: LIST_SIZE=3 DEEP_CUTS_MAX_FOLLOWERS=5000 DEEP_CUTS_MIN_VOTES=2 node test/feeds.test.js
import assert from 'node:assert/strict'
import * as store from '../src/db.js'
import { config } from '../src/config.js'
import { FEEDS, feedUri, keyForUri, refreshMembership } from '../src/feeds.js'

const t = (n) => new Date(Date.UTC(2026, 8, 1, 0, n)).toISOString()
const give = (subject, n, startMinute = 0) => {
  for (let i = 0; i < n; i++) {
    store.upsertVote({ voterDid: `did:plc:v${i}`, subjectDid: subject, rkey: subject, createdAt: t(startMinute + i) })
  }
}
const actor = (did, followers) => store.upsertActor({ did, handle: `${did.slice(-1)}.test`, followers })

// A board of three, then a tail of accounts that differ only in followers and votes.
give('did:plc:A', 20, 0)
give('did:plc:B', 18, 5)
give('did:plc:C', 16, 10)
give('did:plc:D', 4, 15) // outside the cut, small       -> deep cuts
give('did:plc:E', 4, 20) // outside the cut, big         -> no
give('did:plc:F', 1, 25) // outside the cut, one vote    -> no
give('did:plc:G', 3, 30) // outside the cut, no profile  -> no
for (const [did, followers] of [
  ['did:plc:A', 90_000], ['did:plc:B', 100], ['did:plc:C', 40_000],
  ['did:plc:D', 900], ['did:plc:E', 80_000], ['did:plc:F', 50],
]) actor(did, followers)

assert.equal(config.listSize, 3, 'run this suite with LIST_SIZE=3')

const changed = refreshMembership()
assert.deepEqual(store.feedMembers('shitsky38'), ['did:plc:A', 'did:plc:B', 'did:plc:C'])
console.log('✓ the Shitsky38 feed is exactly the accounts inside the cut')

assert.deepEqual(store.feedMembers('deep-cuts'), ['did:plc:D'])
console.log('✓ Deep Cuts takes the small, multi-vote account and leaves the rest')
assert.equal(changed['deep-cuts'].added, 1)

// B is tiny but placed second, so it belongs to the board and not to Deep Cuts.
assert.ok(!store.feedMembers('deep-cuts').includes('did:plc:B'))
console.log('✓ a lightly-followed account inside the cut is not also a deep cut')

// G has enough votes and is outside the cut, but we have never seen its follower count.
assert.ok(!store.feedMembers('deep-cuts').includes('did:plc:G'))
console.log('✓ an account with no known follower count is left out rather than guessed at')

// G has votes but no follower count, so it is exactly what the fill-in pass is for. E has one
// already and must not be refetched.
const missing = store.nomineesMissingFollowers(100)
assert.ok(missing.includes('did:plc:G'), 'G has no follower count and should be queued')
assert.ok(!missing.includes('did:plc:E'), 'E already has one')
console.log('✓ nominees with no follower count are queued for a fetch that ignores the cache')

/* ------------------------------------------------------------- skeleton ---- */

const post = (did, rkey, { minute = 0, isReply = false, future = false } = {}) => {
  const createdAt = future ? new Date(Date.now() + 86_400_000).toISOString() : t(minute)
  store.upsertFeedPost({ uri: `at://${did}/app.bsky.feed.post/${rkey}`, did, cid: `cid-${rkey}`, isReply, createdAt })
}

post('did:plc:A', 'a1', { minute: 1 })
post('did:plc:A', 'a2', { minute: 3 })
post('did:plc:B', 'b1', { minute: 2 })
post('did:plc:B', 'b2', { minute: 4, isReply: true })
post('did:plc:C', 'c1', { minute: 5, future: true })
post('did:plc:D', 'd1', { minute: 6 })
post('did:plc:Z', 'z1', { minute: 9 }) // not in any feed

const uris = (key, opts) => store.feedSkeleton(key, opts).map((r) => r.uri.split('/').pop())

assert.deepEqual(uris('shitsky38'), ['a2', 'b1', 'a1'])
console.log('✓ newest first, replies left out, and a post from outside the roster never appears')

assert.ok(!uris('shitsky38').includes('c1'))
console.log('✓ a post dated in the future cannot park itself at the top')

assert.deepEqual(uris('deep-cuts'), ['d1'])
console.log('✓ each feed serves only its own members')

// Paging: two pages of one must equal one page of two, with nothing repeated or skipped.
const first = store.feedSkeleton('shitsky38', { limit: 1 })
const second = store.feedSkeleton('shitsky38', {
  limit: 1,
  cursorTime: first[0].created_at,
  cursorUri: first[0].uri,
})
assert.deepEqual([first[0].uri, second[0].uri].map((u) => u.split('/').pop()), ['a2', 'b1'])
console.log('✓ the cursor resumes exactly where the previous page stopped')

store.upsertNomineeProfile('did:plc:A', { optOut: true })
assert.deepEqual(uris('shitsky38'), ['b1'])
console.log('✓ withdrawing takes your posts out of the feed, not just off the board')
store.upsertNomineeProfile('did:plc:A', { optOut: false })

/* ----------------------------------------------------------------- uris ---- */

assert.equal(keyForUri(feedUri('shitsky38')), 'shitsky38')
assert.equal(keyForUri(feedUri('deep-cuts')), 'deep-cuts')
assert.equal(keyForUri(`at://${config.feedOwnerDid}/app.bsky.feed.generator/nope`), null)
assert.equal(keyForUri('at://did:plc:someoneelse/app.bsky.feed.generator/shitsky38'), null)
assert.equal(keyForUri('rubbish'), null)
console.log('✓ we answer for our own two feeds and nothing else')

/* ----------------------------------------------------------- the pruner ---- */

store.upsertFeedPost({
  uri: 'at://did:plc:A/app.bsky.feed.post/ancient',
  did: 'did:plc:A',
  createdAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
})
const dropped = store.pruneFeedPosts(45)
assert.ok(dropped >= 2, `expected the ancient post and the stray to go, dropped ${dropped}`)
assert.ok(!uris('shitsky38').includes('ancient'))
assert.equal(store.feedPostCount('shitsky38'), 3)
console.log('✓ pruning drops what is too old and what belongs to nobody')
assert.equal(store.feedPostCount('deep-cuts'), 1)
console.log('✓ the count the owner sees is what the feed would actually serve')

assert.deepEqual(Object.keys(FEEDS), ['shitsky38', 'deep-cuts'])
console.log('\nboth feeds behave')
