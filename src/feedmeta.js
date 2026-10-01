import { config } from './config.js'

/**
 * What a feed is called and what it looks like — the parts that live in a record in the owner's
 * repo. Kept apart from the roster logic so the publishing script can read it without opening
 * the database, and so changing a blurb is obviously not the same as changing who is in a feed.
 */
export const FEED_META = {
  shitsky38: {
    displayName: 'Shitsky38',
    // `description` is what Bluesky shows, so it carries the address. `blurb` is for the card on
    // the site itself, where pointing people back at the page they are reading would be silly.
    description:
      'The 38 "best" shitposters on Bluesky, as voted by everybody. No merit involved. The full board and the ballot are at shitsky38.com',
    blurb: 'Everybody currently inside the cut. It follows the vote, so the feed changes as the board does.',
    avatar: 'public/logo.png',
  },
  'deep-cuts': {
    displayName: 'Shitsky38: Deep Cuts',
    description: `Nominated for Shitsky38 but short of the cut, and under ${config.deepCutsMaxFollowers.toLocaleString('en-US')} followers. The good stuff from further down the ballot. shitsky38.com`,
    blurb: `Nominated, short of the cut, and under ${config.deepCutsMaxFollowers.toLocaleString('en-US')} followers. The ones you probably haven't found yet.`,
    avatar: 'public/feed-deep-cuts.png',
  },
}

export const feedKeys = Object.keys(FEED_META)

/** at://<owner>/app.bsky.feed.generator/<rkey> — the name a client asks for a feed by. */
export const feedUri = (key) => `at://${config.feedOwnerDid}/app.bsky.feed.generator/${key}`

export const webUrl = (key, handle) =>
  `https://bsky.app/profile/${handle || config.feedOwnerDid}/feed/${key}`

/** The key a getFeedSkeleton request is asking for, or null when it is not one of ours. */
export const keyForUri = (uri) => {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.generator\/([^/]+)$/.exec(String(uri ?? ''))
  if (!match) return null
  const [, owner, rkey] = match
  if (owner !== config.feedOwnerDid) return null
  return Object.hasOwn(FEED_META, rkey) ? rkey : null
}

/**
 * Which feeds are actually published and resolving on the network. The buttons on the front page
 * are drawn from this, so they appear by themselves once the records exist and quietly disappear
 * again if a feed is ever deleted — rather than linking somewhere that 404s.
 */
export const LIVE_KEY = 'feeds_live'
