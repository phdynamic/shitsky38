import { Router } from 'express'
import { config, votingState } from '../config.js'
import * as store from '../db.js'
import { handleCandidates, hydrate, resolveHandle, searchActors, toPostUri } from '../bluesky.js'
import { AppError, setOptOut, setPinnedPost, toggleVote } from '../ballot.js'
import { requireViewer } from '../session.js'

export const apiRouter = Router()

const upstream = (err) =>
  err.name === 'TimeoutError' || err.name === 'AbortError' || err.status >= 500

// The PDS refusing to write because of the state of somebody's account is worth saying plainly.
const ACCOUNT_STATE = {
  AccountDeactivated: 'Your Bluesky account is deactivated, so votes cannot be written to it. Reactivate it in the Bluesky app and try again.',
  AccountTakedown: 'Your Bluesky account is suspended, so votes cannot be written to it.',
  AccountSuspended: 'Your Bluesky account is suspended, so votes cannot be written to it.',
}

const fail = (res, err) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message })
  if (ACCOUNT_STATE[err?.error]) {
    console.log(`[api] account not writable: ${err.error}`)
    return res.status(403).json({ error: err.error, message: ACCOUNT_STATE[err.error] })
  }
  if (upstream(err)) {
    // Bluesky's API not answering is a different thing from this app being broken, and the
    // person searching should be told which it is.
    console.warn('[api] upstream unavailable:', err.message)
    return res
      .status(503)
      .json({ error: 'upstream', message: 'Bluesky is not answering right now. Try again in a moment.' })
  }
  console.error('[api]', err)
  return res.status(500).json({ error: 'internal', message: 'Something went wrong on our end.' })
}

apiRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim()

  // Somebody typing a handle abandons a search per keystroke. Without this, every one of those
  // still runs to completion against Bluesky long after the browser stopped listening.
  const ac = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  try {
    let actors = await searchActors(q, 15, { signal: ac.signal })

    // An exact account comes first, whether it was typed as a full handle, a DID, or the bare
    // name in front of .bsky.social — search ranking misses that last one often enough to matter.
    const resolved = await Promise.allSettled(
      handleCandidates(q).map((candidate) => resolveHandle(candidate, { signal: ac.signal })),
    )
    const exactDids = resolved
      .filter((outcome) => outcome.status === 'fulfilled' && outcome.value)
      .map((outcome) => outcome.value)
      .filter((did) => !actors.some((actor) => actor.did === did))

    if (exactDids.length > 0) {
      const profiles = await hydrate(exactDids)
      const exact = exactDids.map((did) => profiles.get(did)).filter((actor) => actor?.handle)
      actors = [...exact, ...actors]
    }
    const ballot = req.viewerDid ? store.getBallot(req.viewerDid).map((b) => b.subject_did) : []
    res.json({
      actors: actors.map((actor) => ({
        did: actor.did,
        handle: actor.handle,
        displayName: actor.displayName,
        avatar: actor.avatar,
        voted: ballot.includes(actor.did),
        votes: store.standing(actor.did)?.votes ?? 0,
      })),
      votesUsed: ballot.length,
      maxVotes: config.maxVotes,
    })
  } catch (err) {
    if (ac.signal.aborted) return // the browser moved on; nothing to report
    fail(res, err)
  }
})

apiRouter.post('/vote', requireViewer, async (req, res) => {
  try {
    const subject = String(req.body?.did ?? '')
    const did = subject.startsWith('did:') ? subject : await resolveHandle(subject)
    const result = await toggleVote(req.viewerDid, did, req.body?.note)
    res.json({
      ...result,
      did,
      votes: store.standing(did)?.votes ?? 0,
      maxVotes: config.maxVotes,
    })
  } catch (err) {
    fail(res, err)
  }
})

apiRouter.post('/profile', requireViewer, async (req, res) => {
  try {
    if (votingState() === 'closed') throw new AppError(403, 'voting_closed', 'Voting is closed.')
    if (Object.hasOwn(req.body ?? {}, 'optOut')) await setOptOut(req.viewerDid, Boolean(req.body.optOut))
    if (Object.hasOwn(req.body ?? {}, 'pinnedPost')) {
      const raw = String(req.body.pinnedPost ?? '').trim()
      const uri = raw ? await toPostUri(raw) : null
      if (raw && !uri) {
        throw new AppError(
          400,
          'bad_post',
          'That does not look like a link to a Bluesky post. Paste the post\'s link, e.g. https://bsky.app/profile/you.bsky.social/post/abc123',
        )
      }
      await setPinnedPost(req.viewerDid, uri)
    }
    res.json({ ok: true, profile: store.getNomineeProfile(req.viewerDid) })
  } catch (err) {
    fail(res, err)
  }
})

apiRouter.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || config.listSize, 200)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const entries = store.leaderboard({ limit, offset })
    const actors = await hydrate(entries.map((entry) => entry.did))
    const totals = store.totals()
    const ballot = req.viewerDid ? store.getBallot(req.viewerDid).map((b) => b.subject_did) : []
    res.json({
      listSize: config.listSize,
      votingState: votingState(),
      closesAt: config.votingClosesAt.toISOString(),
      totals,
      votesUsed: ballot.length,
      maxVotes: config.maxVotes,
      hasMore: offset + entries.length < totals.nominees,
      nextOffset: offset + entries.length,
      entries: entries.map((entry) => ({
        rank: entry.rank,
        votes: entry.votes,
        did: entry.did,
        handle: actors.get(entry.did)?.handle ?? null,
        displayName: actors.get(entry.did)?.displayName ?? null,
        avatar: actors.get(entry.did)?.avatar ?? null,
        voted: ballot.includes(entry.did),
      })),
    })
  } catch (err) {
    fail(res, err)
  }
})
