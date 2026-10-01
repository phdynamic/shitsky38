import express from 'express'
import { config } from './../config.js'
import * as store from './../db.js'
import { FEED_META, feedKeys, feedUri, keyForUri } from './../feedmeta.js'

export const feedsRouter = express.Router()

// Bluesky asks our service for a feed by AT-URI and we answer with nothing but a list of post
// URIs — it hydrates them itself. So the service holds no post content, only an ordering.

/**
 * did:web resolves by fetching this document from the domain in the DID. It is the whole of our
 * identity on the network: no PLC operation, no key, nothing to rotate.
 */
feedsRouter.get('/.well-known/did.json', (_req, res) => {
  const expected = `did:web:${new URL(config.publicUrl).hostname}`
  if (config.feedServiceDid !== expected) return res.status(404).json({ error: 'NotFound' })
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: config.feedServiceDid,
    service: [
      {
        id: '#bsky_fg',
        type: 'BskyFeedGenerator',
        serviceEndpoint: config.publicUrl,
      },
    ],
  })
})

feedsRouter.get('/xrpc/app.bsky.feed.describeFeedGenerator', (_req, res) => {
  res.set('access-control-allow-origin', '*')
  res.json({
    did: config.feedServiceDid,
    feeds: feedKeys.map((key) => ({ uri: feedUri(key) })),
  })
})

// An ISO timestamp never contains a pipe, so this round-trips without escaping. Pairing the
// timestamp with the URI makes paging stable when several posts share a timestamp.
const encodeCursor = (row) => `${row.created_at}|${row.uri}`
const decodeCursor = (value) => {
  if (!value) return { cursorTime: null, cursorUri: null }
  const at = String(value).indexOf('|')
  if (at === -1) return null
  const cursorTime = String(value).slice(0, at)
  const cursorUri = String(value).slice(at + 1)
  if (!cursorTime || !cursorUri || Number.isNaN(Date.parse(cursorTime))) return null
  return { cursorTime, cursorUri }
}

feedsRouter.get('/xrpc/app.bsky.feed.getFeedSkeleton', (req, res) => {
  res.set('access-control-allow-origin', '*')
  res.set('cache-control', 'no-store')

  const key = keyForUri(req.query.feed)
  if (!key) {
    return res.status(400).json({
      error: 'UnknownFeed',
      message: 'This service does not serve that feed.',
    })
  }

  const cursor = decodeCursor(req.query.cursor)
  if (cursor === null) {
    return res.status(400).json({ error: 'InvalidRequest', message: 'Malformed cursor.' })
  }

  const asked = Number(req.query.limit)
  const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 100) : 50

  const rows = store.feedSkeleton(key, { limit, ...cursor })
  res.json({
    // Leaving the cursor off at the end is what tells a client it has reached the bottom.
    ...(rows.length === limit ? { cursor: encodeCursor(rows[rows.length - 1]) } : {}),
    feed: rows.map((row) => ({ post: row.uri })),
  })
})

/** What the owner needs to see on /admin: is each feed actually serving anything. */
export const feedStatus = () =>
  feedKeys.map((key) => ({
    key,
    uri: feedUri(key),
    displayName: FEED_META[key].displayName,
    members: store.feedMembers(key).length,
    posts: store.feedPostCount(key),
  }))
