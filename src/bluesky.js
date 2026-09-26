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
const json = async (url, { timeout = 5_000, attempts = 2, signal } = {}) => {
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        // Give up on our own deadline, or as soon as whoever asked has stopped caring.
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout),
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
      if (signal?.aborted || attempt === attempts || !retryable(err)) throw err
      console.warn(`[bluesky] ${err.name === 'TimeoutError' ? 'timed out' : err.message} — retrying ${url}`)
    }
  }
  throw last
}

const xrpc = (base, nsid, params = {}, options) => {
  const url = new URL(`${base}/xrpc/${nsid}`)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v))
    else url.searchParams.set(key, String(value))
  }
  return json(url.toString(), options)
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

export const searchActors = async (q, limit = 12, { signal } = {}) => {
  const query = q?.trim()
  if (!query) return []

  const key = `${query.toLowerCase()}:${limit}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.actors

  const data = await xrpc(config.appviewUrl, 'app.bsky.actor.searchActors', { q: query, limit }, { signal })
  const actors = (data.actors ?? []).map(normalize)
  for (const actor of actors) upsertActor(actor)

  searchCache.set(key, { at: Date.now(), actors })
  if (searchCache.size > 500) {
    for (const [k, v] of searchCache) if (Date.now() - v.at > SEARCH_TTL_MS) searchCache.delete(k)
  }
  return actors
}

const HANDLE_TTL_MS = 5 * 60 * 1000
const handleCache = new Map()

export const resolveHandle = async (handle, { signal } = {}) => {
  const clean = handle.trim().replace(/^@/, '')
  if (clean.startsWith('did:')) return clean

  // Typing a handle fires one of these per keystroke, and a miss is worth remembering as much
  // as a hit — most of what gets typed is a prefix of something that does not exist yet.
  const hit = handleCache.get(clean)
  if (hit && Date.now() - hit.at < HANDLE_TTL_MS) {
    if (hit.did) return hit.did
    throw Object.assign(new Error(`No account for ${clean}`), { status: 400, cached: true })
  }

  try {
    const data = await xrpc(config.appviewUrl, 'com.atproto.identity.resolveHandle', { handle: clean }, { signal })
    handleCache.set(clean, { at: Date.now(), did: data.did })
    return data.did
  } catch (err) {
    if (err.status >= 400 && err.status < 500) handleCache.set(clean, { at: Date.now(), did: null })
    throw err
  }
}

/**
 * What someone might mean by what they typed. Bluesky's actor search does not reliably return
 * the exact account for a bare name — "jcsalterego" does not surface jcsalterego.bsky.social —
 * so a bare name is also tried as a handle on the default domain.
 */
export const handleCandidates = (query) => {
  const clean = query.trim().replace(/^@/, '')
  if (!clean) return []
  if (clean.startsWith('did:')) return [clean]
  const candidates = []
  if (clean.includes('.')) candidates.push(clean)
  // One DNS label: up to 63 characters, no leading or trailing hyphen. Bluesky's own signups are
  // shorter than that, but older accounts predate the current rules and a candidate that does not
  // resolve costs one lookup, cached.
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(clean)) candidates.push(`${clean}.bsky.social`)
  return candidates
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

const POST_WEB_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*bsky\.app\/profile\/([^/?#]+)\/post\/([A-Za-z0-9.\-_~]+)/i
const POST_AT_URI = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9.\-_~]+)$/

/**
 * People paste what the Bluesky app gives them, which is a web link, not an AT-URI. Accept both
 * and hand back the AT-URI the API wants, or null when it is neither.
 */
export const toPostUri = async (input) => {
  const value = String(input ?? '').trim()
  if (!value) return null

  const match = POST_AT_URI.exec(value) ?? POST_WEB_URL.exec(value)
  if (!match) return null

  const [, actor, rkey] = match
  const subject = decodeURIComponent(actor)
  try {
    const did = subject.startsWith('did:') ? subject : await resolveHandle(subject)
    return `at://${did}/app.bsky.feed.post/${rkey}`
  } catch {
    return null
  }
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
