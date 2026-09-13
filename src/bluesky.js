import { config } from './config.js'
import { getActors, upsertActor } from './db.js'

const PROFILE_TTL_MS = 6 * 60 * 60 * 1000
const USER_AGENT = `${config.siteName} (+${config.publicUrl})`

// undici reports every network-level failure as `TypeError: fetch failed`, with the real cause
// nested — sometimes as an AggregateError — so the name is the reliable signal, not cause.code.
const retryable = (err) =>
  err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError' || err.status >= 500

/**
 * The path out to the AppView stalls in bursts — requests that normally answer in 200ms hang
 * until they time out, while the same endpoint is healthy from elsewhere. A short timeout with
 * one retry turns most of those stalls into a slightly slow answer instead of a failure, and
 * costs no more in the worst case than the single long attempt it replaces.
 */
const json = async (url, { timeout = 5_000, attempts = 2 } = {}) => {
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`${res.status} ${res.statusText} for ${url}: ${body.slice(0, 200)}`)
        err.status = res.status
        throw err
      }
      return await res.json()
    } catch (err) {
      last = err
      if (attempt === attempts || !retryable(err)) throw err
      console.warn(`[bluesky] ${err.name === 'TimeoutError' ? 'timed out' : err.message} — retrying ${url}`)
    }
  }
  throw last
}

const xrpc = (base, nsid, params = {}) => {
  const url = new URL(`${base}/xrpc/${nsid}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v))
    else url.searchParams.set(key, String(value))
  }
  return json(url.toString())
}

const chunk = (items, size) => {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const normalize = (profile) => ({
  did: profile.did,
  handle: profile.handle,
  displayName: profile.displayName ?? null,
  avatar: profile.avatar ?? null,
  description: profile.description ?? null,
})

const SEARCH_TTL_MS = 60_000
const searchCache = new Map()

export const searchActors = async (q, limit = 12) => {
  const query = q?.trim()
  if (!query) return []

  const key = `${query.toLowerCase()}:${limit}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.actors

  const data = await xrpc(config.appviewUrl, 'app.bsky.actor.searchActors', { q: query, limit })
  const actors = (data.actors ?? []).map(normalize)
  for (const actor of actors) upsertActor(actor)

  searchCache.set(key, { at: Date.now(), actors })
  if (searchCache.size > 500) {
    for (const [k, v] of searchCache) if (Date.now() - v.at > SEARCH_TTL_MS) searchCache.delete(k)
  }
  return actors
}

export const resolveHandle = async (handle) => {
  const clean = handle.trim().replace(/^@/, '')
  if (clean.startsWith('did:')) return clean
  const data = await xrpc(config.appviewUrl, 'com.atproto.identity.resolveHandle', { handle: clean })
  return data.did
}

/** Profiles for a set of DIDs, served from cache and refreshed in the background of the request. */
export const hydrate = async (dids) => {
  const unique = [...new Set(dids.filter(Boolean))]
  const cached = getActors(unique)
  const now = Date.now()
  const stale = unique.filter((did) => {
    const hit = cached.get(did)
    return !hit || now - new Date(hit.fetchedAt).getTime() > PROFILE_TTL_MS
  })

  for (const group of chunk(stale, 25)) {
    try {
      const data = await xrpc(config.appviewUrl, 'app.bsky.actor.getProfiles', { actors: group })
      for (const profile of data.profiles ?? []) {
        const actor = normalize(profile)
        upsertActor(actor)
        cached.set(actor.did, actor)
      }
    } catch (err) {
      // A takendown or deactivated account shouldn't blank out the whole leaderboard.
      console.warn('[bluesky] getProfiles failed:', err.message)
    }
  }

  for (const did of unique) {
    if (!cached.has(did)) cached.set(did, { did, handle: null, displayName: null, avatar: null, description: null })
  }
  return cached
}

export const getPosts = async (uris) => {
  const wanted = [...new Set(uris.filter(Boolean))].slice(0, 25)
  if (wanted.length === 0) return new Map()
  try {
    const data = await xrpc(config.appviewUrl, 'app.bsky.feed.getPosts', { uris: wanted })
    return new Map((data.posts ?? []).map((post) => [post.uri, post]))
  } catch (err) {
    console.warn('[bluesky] getPosts failed:', err.message)
    return new Map()
  }
}

/** Where does this DID keep its repo? */
export const resolvePds = async (did) => {
  let doc
  if (did.startsWith('did:plc:')) {
    doc = await json(`https://plc.directory/${encodeURIComponent(did)}`)
  } else if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length)).replaceAll(':', '/')
    doc = await json(`https://${host}/.well-known/did.json`)
  } else {
    throw new Error(`Unsupported DID method: ${did}`)
  }
  const service = (doc.service ?? []).find((s) => s.id === '#atproto_pds' || s.id.endsWith('#atproto_pds'))
  if (!service?.serviceEndpoint) throw new Error(`No PDS in DID document for ${did}`)
  return String(service.serviceEndpoint).replace(/\/$/, '')
}

/** Read a whole collection straight from someone's repo — no auth needed, repos are public. */
export const listRecords = async (did, collection, { pds } = {}) => {
  const host = pds ?? (await resolvePds(did))
  const records = []
  let cursor
  do {
    const page = await xrpc(host, 'com.atproto.repo.listRecords', {
      repo: did,
      collection,
      limit: 100,
      cursor,
    })
    records.push(...(page.records ?? []))
    cursor = page.cursor
  } while (cursor && records.length < 1000)
  return records
}

export const rkeyOf = (uri) => uri.split('/').pop()
