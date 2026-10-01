import { config } from './config.js'
import * as store from './db.js'
import { authorFeed, hydrate } from './bluesky.js'
import { feedKeys, feedUri, refreshMembership } from './feeds.js'
import { LIVE_KEY } from './feedmeta.js'

const CURSOR_KEY = 'feed_jetstream_cursor'
const BACKFILLED_KEY = (did) => `feed_backfilled:${did}`
const CURSOR_SAVE_MS = 5_000
const CURSOR_REWIND_US = 5_000_000
const KEEP_DAYS = 45
// Jetstream takes its filters in the query string and refuses a URL much past 16KB, which works
// out at roughly 300 DIDs. Both feeds together are a fraction of that, but a roster that somehow
// grew past it would otherwise fail by dropping the whole connection.
const MAX_WATCHED = 280

const MEMBERSHIP_MS = 10 * 60 * 1000
const PRUNE_MS = 60 * 60 * 1000

const isPostRecord = (collection) => collection === 'app.bsky.feed.post'

/** Posts land here whether they came from the firehose or the backfill. */
const record = (did, post) => {
  if (!post.uri || !post.createdAt) return
  store.upsertFeedPost({
    uri: post.uri,
    did,
    cid: post.cid ?? null,
    isReply: post.isReply,
    createdAt: post.createdAt,
  })
}

/**
 * A fresh firehose subscription only ever sees the future, so a new feed would open empty and
 * stay thin for days. One page of each member's own posts fixes that. Done once per account —
 * after that the firehose keeps up on its own.
 */
const backfill = async (dids) => {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()
  let filled = 0
  for (const did of dids) {
    if (store.getKv(BACKFILLED_KEY(did))) continue
    try {
      const { posts } = await authorFeed(did, { limit: 100 })
      for (const post of posts) {
        if (post.createdAt < cutoff) continue
        record(did, post)
      }
      store.setKv(BACKFILLED_KEY(did), new Date().toISOString())
      filled++
    } catch (err) {
      // Leave the marker unset so the next sweep tries again.
      console.warn(`[feeds] backfill failed for ${did}: ${err.message}`)
    }
  }
  if (filled) console.log(`[feeds] backfilled ${filled} account${filled === 1 ? '' : 's'}`)
}

export const startFeedIngest = () => {
  if (!config.feedsEnabled) {
    console.log('[feeds] disabled')
    return () => {}
  }
  if (!config.feedOwnerDid) {
    console.warn('[feeds] no FEED_OWNER_DID and no ADMIN_DIDS — feeds are off')
    return () => {}
  }

  let socket = null
  let stopped = false
  let backoff = 1_000
  let watching = []
  let pendingCursor = null
  let lastSaved = 0

  const saveCursor = (force = false) => {
    if (pendingCursor === null) return
    const now = Date.now()
    if (!force && now - lastSaved < CURSOR_SAVE_MS) return
    store.setKv(CURSOR_KEY, String(pendingCursor))
    lastSaved = now
  }

  const connect = (dids) => {
    if (stopped || dids.length === 0) return
    watching = dids
    const url = new URL(config.jetstreamUrl)
    url.searchParams.append('wantedCollections', 'app.bsky.feed.post')
    for (const did of dids) url.searchParams.append('wantedDids', did)
    const saved = store.getKv(CURSOR_KEY)
    if (saved) url.searchParams.set('cursor', String(Math.max(0, Number(saved) - CURSOR_REWIND_US)))

    const ws = new WebSocket(url)
    socket = ws

    ws.addEventListener('open', () => {
      backoff = 1_000
      console.log(`[feeds] firehose watching ${dids.length} accounts`)
    })

    ws.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload.time_us) {
          pendingCursor = payload.time_us
          saveCursor()
        }
        if (payload.kind !== 'commit' || !payload.commit) return
        const { commit, did } = payload
        if (!isPostRecord(commit.collection)) return
        const uri = `at://${did}/app.bsky.feed.post/${commit.rkey}`
        if (commit.operation === 'delete') {
          store.deleteFeedPost(uri)
          return
        }
        record(did, {
          uri,
          cid: commit.cid ?? null,
          createdAt: commit.record?.createdAt ?? new Date().toISOString(),
          isReply: Boolean(commit.record?.reply),
        })
      } catch (err) {
        console.warn('[feeds] bad frame:', err.message)
      }
    })

    ws.addEventListener('error', () => {})

    // Checks this socket's own flag, not whatever `socket` points at by the time the event
    // lands — after a deliberate swap that is already the replacement.
    ws.addEventListener('close', () => {
      saveCursor(true)
      if (stopped || ws.deliberate) return
      console.warn(`[feeds] firehose dropped, retrying in ${backoff}ms`)
      setTimeout(() => connect(watching), backoff)
      backoff = Math.min(backoff * 2, 60_000)
    })
  }

  const resubscribe = (dids) => {
    const next = dids.slice(0, MAX_WATCHED)
    if (next.length === watching.length && next.every((did, i) => did === watching[i])) return false
    if (socket) {
      socket.deliberate = true
      socket.close()
    }
    connect(next)
    return true
  }

/**
 * Ask the AppView which of our feeds it can actually see. Until the owner runs the publishing
 * script there are no records to find, and the site should not advertise feeds that do not
 * exist yet.
 */
const checkPublished = async () => {
  try {
    const url = new URL(`${config.appviewUrl}/xrpc/app.bsky.feed.getFeedGenerators`)
    for (const key of feedKeys) url.searchParams.append('feeds', feedUri(key))
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return
    const data = await res.json()
    const live = (data.feeds ?? [])
      .filter((feed) => feed.uri)
      .map((feed) => feed.uri.split('/').pop())
      .filter((key) => feedKeys.includes(key))
    const previous = store.getKv(LIVE_KEY) ?? ''
    const next = live.sort().join(',')
    if (next !== previous) {
      store.setKv(LIVE_KEY, next)
      console.log(`[feeds] published: ${next || 'none yet — run npm run publish-feeds'}`)
    }
  } catch (err) {
    console.warn('[feeds] could not check which feeds are published:', err.message)
  }
}

  // Follower counts decide the Deep Cuts roster, so they have to be reasonably current before
  // membership is recomputed. hydrate() has its own six-hour TTL, so most sweeps fetch nothing.
  const sweep = async () => {
    try {
      const nominees = store.nomineeDids()
      if (nominees.length) await hydrate(nominees)
      // Anyone still without a count — new nominees, and everybody at all when this first
      // shipped — is fetched whatever the cache says, a batch at a time until none are left.
      const missing = store.nomineesMissingFollowers(100)
      if (missing.length) {
        await hydrate(missing, { force: true })
        console.log(`[feeds] filled in follower counts for ${missing.length} nominees`)
      }
      const changes = refreshMembership()
      const summary = feedKeys
        .map((key) => `${key}=${changes[key].frozen ? `${changes[key].count} (frozen)` : changes[key].count}`)
        .join(' ')
      const moved = feedKeys.some((key) => changes[key].added || changes[key].removed)
      const dids = store.allFeedMemberDids()
      const reconnected = resubscribe(dids)
      if (moved || reconnected) console.log(`[feeds] roster ${summary}`)
      await backfill(dids)
      await checkPublished()
    } catch (err) {
      console.warn('[feeds] sweep failed:', err.message)
    }
  }

  if (typeof WebSocket === 'undefined') {
    console.warn('[feeds] no global WebSocket in this Node build; posts will only arrive by backfill')
  }

  sweep()
  const membership = setInterval(sweep, MEMBERSHIP_MS)
  membership.unref()
  const pruner = setInterval(() => {
    const dropped = store.pruneFeedPosts(KEEP_DAYS)
    if (dropped) console.log(`[feeds] pruned ${dropped} posts`)
  }, PRUNE_MS)
  pruner.unref()

  return () => {
    stopped = true
    saveCursor(true)
    clearInterval(membership)
    clearInterval(pruner)
    socket?.close()
  }
}
