import { Router } from 'express'
import { readFileSync, readdirSync } from 'node:fs'
import { config } from '../config.js'
import * as store from '../db.js'
import { getPosts, hydrate, resolveHandle } from '../bluesky.js'
import { syncBallotFromRepo, syncProfileFromRepo } from '../ballot.js'
import { layout } from '../views/layout.js'
import { faqPage, leaderboardPage, mePage, notFoundPage, profilePage, votePage } from '../views/pages.js'

export const pagesRouter = Router()

// How many past the cut to render up front, and to add on each press of Load more.
const PAGE_SIZE = 24

const viewerOf = async (req) => {
  if (!req.viewerDid) return null
  const actor = (await hydrate([req.viewerDid])).get(req.viewerDid)
  return { did: req.viewerDid, handle: actor?.handle ?? null, displayName: actor?.displayName ?? null }
}

const send = (res, page) => res.type('html').send(page.toString())

pagesRouter.get('/', async (req, res) => {
  // topList() can run past LIST_SIZE when the cut is tied. Those accounts are still on the list
  // and still carry their shared rank — the page just stops at LIST_SIZE rows and hands the
  // remainder to Load more, so the leaderboard never scrolls past the number in its own title.
  const entries = store.topList().slice(0, config.listSize)
  const viewer = await viewerOf(req)
  const ballot = req.viewerDid ? store.getBallot(req.viewerDid) : []
  const actors = await hydrate(entries.map((entry) => entry.did))
  const stats = store.totals()

  send(
    res,
    layout({
      viewer,
      path: '/',
      body: leaderboardPage({
        entries,
        actors,
        stats,
        viewer,
        ballot,
        hasMore: stats.nominees > entries.length,
        nextOffset: entries.length,
        pageSize: PAGE_SIZE,
      }),
    }),
  )
})

pagesRouter.get('/vote', async (req, res) => {
  const viewer = await viewerOf(req)
  const ballot = req.viewerDid ? store.getBallot(req.viewerDid) : []
  const actors = await hydrate(ballot.map((item) => item.subject_did))
  send(
    res,
    layout({
      title: 'Vote',
      viewer,
      path: '/vote',
      body: votePage({
        viewer,
        ballot,
        actors,
        withdrawn: store.optedOutAmong(ballot.map((item) => item.subject_did)),
        query: req.query.q ? String(req.query.q) : '',
      }),
    }),
  )
})

pagesRouter.get('/me', async (req, res) => {
  if (!req.viewerDid) return res.redirect(`/login?next=${encodeURIComponent('/me')}`)
  const viewer = await viewerOf(req)
  // Re-read the repo so a vote deleted in another client shows up here.
  await syncBallotFromRepo(req.viewerDid).catch(() => {})
  const ballot = store.getBallot(req.viewerDid)
  const actors = await hydrate(ballot.map((item) => item.subject_did))
  send(
    res,
    layout({
      title: 'My ballot',
      viewer,
      path: '/me',
      body: mePage({
        viewer,
        ballot,
        actors,
        withdrawn: store.optedOutAmong(ballot.map((item) => item.subject_did)),
        standingEntry: store.standing(req.viewerDid),
      }),
    }),
  )
})

pagesRouter.get('/profile/:actor', async (req, res) => {
  const param = String(req.params.actor)
  let did = param
  if (!param.startsWith('did:')) {
    try {
      did = await resolveHandle(param)
    } catch {
      return res.status(404).type('html').send(layout({ title: 'Not found', viewer: await viewerOf(req), body: notFoundPage() }).toString())
    }
  }

  const viewer = await viewerOf(req)
  const isSelf = viewer?.did === did
  if (isSelf) await syncProfileFromRepo(did).catch(() => {})

  const actor = (await hydrate([did])).get(did) ?? { did }
  const entry = store.standing(did)
  const nominee = store.getNomineeProfile(did)
  const pinned = nominee?.pinnedPost ? (await getPosts([nominee.pinnedPost])).get(nominee.pinnedPost) : null
  const ballot = req.viewerDid ? store.getBallot(req.viewerDid) : []

  send(
    res,
    layout({
      title: actor.displayName ?? actor.handle ?? 'Profile',
      viewer,
      path: '/profile',
      body: profilePage({
        actor,
        entry,
        viewer,
        voted: ballot.some((item) => item.subject_did === did),
        outOfVotes: ballot.length >= config.maxVotes,
        pinned,
        isSelf,
        nominee,
      }),
    }),
  )
})

pagesRouter.get('/faq', async (req, res) => {
  send(res, layout({ title: 'Questions', viewer: await viewerOf(req), path: '/faq', body: faqPage() }))
})

pagesRouter.get('/lexicons', (_req, res) => {
  const files = readdirSync('lexicons').filter((name) => name.endsWith('.json'))
  res.json(files.map((name) => JSON.parse(readFileSync(`lexicons/${name}`, 'utf8'))))
})
