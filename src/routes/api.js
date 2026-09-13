import { Router } from 'express'
import { config, votingState } from '../config.js'
import * as store from '../db.js'
import { hydrate, resolveHandle, searchActors } from '../bluesky.js'
import { AppError, setOptOut, setPinnedPost, toggleVote } from '../ballot.js'
import { requireViewer } from '../session.js'

export const apiRouter = Router()

const upstream = (err) =>
  err.name === 'TimeoutError' || err.name === 'AbortError' || err.status >= 500

const fail = (res, err) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message })
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
  try {
    let actors = await searchActors(q, 15)
    // A handle typed in full should come first even if search ranking disagrees.
    if (q.includes('.') || q.startsWith('did:')) {
      try {
        const did = await resolveHandle(q)
        if (did && !actors.some((a) => a.did === did)) {
          const exact = (await hydrate([did])).get(did)
          if (exact) actors = [exact, ...actors]
        }
      } catch {
        /* not a handle, no problem */
      }
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
    if (Object.hasOwn(req.body ?? {}, 'pinnedPost')) await setPinnedPost(req.viewerDid, req.body.pinnedPost || null)
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
