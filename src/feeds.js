import { config, votingState } from './config.js'
import * as store from './db.js'
import { FEED_META, LIVE_KEY, feedKeys } from './feedmeta.js'

export { FEED_META, feedKeys, feedUri, webUrl, keyForUri } from './feedmeta.js'

/** Who is in each feed. The record in the repo names it; this decides its contents. */
const ROSTERS = {
  shitsky38: () => store.topList().map((row) => row.did),
  'deep-cuts': () =>
    store
      .deepCutsPool({ minVotes: config.deepCutsMinVotes, maxFollowers: config.deepCutsMaxFollowers })
      .map((row) => row.did),
}

export const FEEDS = Object.fromEntries(
  feedKeys.map((key) => [key, { ...FEED_META[key], rkey: key, members: ROSTERS[key] }]),
)

/**
 * Recompute both rosters from the tally.
 *
 * Votes cast after the deadline never count, so the top 38 settles on its own once the poll
 * closes. Deep Cuts would not: follower counts keep moving, and somebody crossing the threshold
 * in November should not fall out of a list they qualified for in October. So once voting is
 * closed the rosters are left exactly as they were.
 */
export const refreshMembership = ({ force = false } = {}) => {
  const closed = votingState() === 'closed'
  const changes = {}
  for (const key of feedKeys) {
    const existing = store.feedMembers(key)
    if (closed && existing.length > 0 && !force) {
      changes[key] = { frozen: true, count: existing.length }
      continue
    }
    const next = ROSTERS[key]()
    const before = new Set(existing)
    const after = new Set(next)
    store.setFeedMembers(key, next)
    changes[key] = {
      count: next.length,
      added: next.filter((did) => !before.has(did)).length,
      removed: existing.filter((did) => !after.has(did)).length,
    }
  }
  return changes
}

/** The feeds that exist on the network right now, for the buttons on the front page. */
export const liveFeeds = () => {
  const live = new Set((store.getKv(LIVE_KEY) ?? '').split(','))
  // Ordered by how the feeds are declared, not by however they were stored — the main board
  // should always be the first card.
  return feedKeys.filter((key) => live.has(key)).map((key) => ({ key, ...FEED_META[key] }))
}
