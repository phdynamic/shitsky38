import { Router } from 'express'
import { isAdmin } from '../config.js'
import * as store from '../db.js'
import { hydrate, resolveHandle } from '../bluesky.js'
import { layout } from '../views/layout.js'
import { adminPage, notFoundPage } from '../views/pages.js'
import { viewerOf } from './pages.js'

export const adminRouter = Router()

// Scoped to /admin deliberately: an unpathed router-level guard runs for every request that
// reaches this router, which would 404 the whole site for everyone who is not an admin.
// Not 403: anybody who is not an admin gets the same 404 as a page that does not exist, so the
// audit view is not advertised to people who cannot use it.
adminRouter.use('/admin', async (req, res, next) => {
  if (!isAdmin(req.viewerDid)) {
    res
      .status(404)
      .type('html')
      .send(layout({ title: 'Not found', viewer: await viewerOf(req), path: req.path, body: notFoundPage() }).toString())
    return
  }
  next()
})

adminRouter.get('/admin', async (req, res) => {
  const viewer = await viewerOf(req)
  const query = String(req.query.q ?? '').trim()

  if (!query) {
    return res
      .type('html')
      .send(layout({ title: 'Audit', viewer, path: '/admin', body: adminPage({ query: '' }) }).toString())
  }

  let did = query.replace(/^@/, '')
  if (!did.startsWith('did:')) {
    try {
      did = await resolveHandle(did)
    } catch {
      return res.type('html').send(
        layout({
          title: 'Audit',
          viewer,
          path: '/admin',
          body: adminPage({ query, error: `No account found for "${query}".` }),
        }).toString(),
      )
    }
  }

  const receivedRaw = store.votersFor(did)
  const castRaw = store.ballotOf(did)
  const actors = await hydrate([did, ...receivedRaw.map((r) => r.did), ...castRaw.map((r) => r.did)])

  res.type('html').send(
    layout({
      title: `Audit · ${actors.get(did)?.handle ?? did}`,
      viewer,
      path: '/admin',
      body: adminPage({
        query,
        subject: actors.get(did) ?? { did },
        nominee: store.getNomineeProfile(did),
        standing: store.standing(did),
        received: receivedRaw,
        cast: castRaw,
        actors,
      }),
    }).toString(),
  )
})
