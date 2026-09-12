import { PROFILE_NSID, VOTE_NSID, config } from './config.js'
import * as store from './db.js'

const CURSOR_KEY = 'jetstream_cursor'
const CURSOR_SAVE_MS = 5_000
// Rewind a little on reconnect; replaying a few seconds is harmless because every write is an upsert.
const CURSOR_REWIND_US = 5_000_000

const isDid = (value) => typeof value === 'string' && value.startsWith('did:')
const rkeyOf = (uri) => String(uri).split('/').pop()

const handleEvent = (event) => {
  if (event.kind !== 'commit' || !event.commit) return
  const { commit, did } = event
  const { collection, operation, rkey, record } = commit

  if (collection === VOTE_NSID) {
    if (operation === 'delete') {
      store.deleteVoteByRkey(did, rkey)
      return
    }
    const subjectDid = isDid(record?.subject) ? record.subject : rkey
    if (!isDid(subjectDid)) return
    store.upsertVote({
      voterDid: did,
      subjectDid,
      rkey,
      createdAt: record?.createdAt ?? new Date().toISOString(),
    })
    return
  }

  if (collection === PROFILE_NSID && rkey === 'self') {
    if (operation === 'delete') store.deleteNomineeProfile(did)
    else store.upsertNomineeProfile(did, { optOut: Boolean(record?.optOut), pinnedPost: record?.pinnedPost ?? null })
  }
}

/**
 * Follows every com.shitsky38.* record written anywhere on the network, so a ballot cast with
 * some other client — or straight from a PDS — still lands on the leaderboard.
 */
export const startJetstream = () => {
  if (!config.jetstreamEnabled) {
    console.log('[jetstream] disabled')
    return () => {}
  }
  if (typeof WebSocket === 'undefined') {
    console.warn('[jetstream] no global WebSocket in this Node build; firehose ingest is off')
    return () => {}
  }

  let socket = null
  let stopped = false
  let backoff = 1_000
  let pendingCursor = null
  let lastSaved = 0

  const saveCursor = (force = false) => {
    if (pendingCursor === null) return
    const now = Date.now()
    if (!force && now - lastSaved < CURSOR_SAVE_MS) return
    store.setKv(CURSOR_KEY, String(pendingCursor))
    lastSaved = now
  }

  const connect = () => {
    if (stopped) return
    const url = new URL(config.jetstreamUrl)
    url.searchParams.append('wantedCollections', VOTE_NSID)
    url.searchParams.append('wantedCollections', PROFILE_NSID)
    const saved = store.getKv(CURSOR_KEY)
    if (saved) url.searchParams.set('cursor', String(Math.max(0, Number(saved) - CURSOR_REWIND_US)))

    socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      backoff = 1_000
      console.log(`[jetstream] connected${saved ? ` from cursor ${saved}` : ''}`)
    })

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data)
        handleEvent(payload)
        if (payload.time_us) {
          pendingCursor = payload.time_us
          saveCursor()
        }
      } catch (err) {
        console.warn('[jetstream] bad frame:', err.message)
      }
    })

    socket.addEventListener('error', () => {
      /* the close handler does the reconnecting */
    })

    socket.addEventListener('close', () => {
      saveCursor(true)
      if (stopped) return
      console.warn(`[jetstream] disconnected, retrying in ${backoff}ms`)
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 60_000)
    })
  }

  connect()

  return () => {
    stopped = true
    saveCursor(true)
    socket?.close()
  }
}
