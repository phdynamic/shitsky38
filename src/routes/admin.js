import { Router } from 'express'
import { config, isAdmin } from '../config.js'
import * as store from '../db.js'
import { hydrate, resolveHandle } from '../bluesky.js'
import { layout } from '../views/layout.js'
import { adminPage, notFoundPage, writeupsPage } from '../views/pages.js'
import { isPublished, loadWriteups, setPublished } from '../writeups.js'
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

adminRouter.get('/admin/writeups', async (req, res) => {
  const viewer = await viewerOf(req)
  const doc = loadWriteups()
  if (!doc) {
    return res
      .status(404)
      .type('html')
      .send(layout({ title: 'Not found', viewer, path: '/admin', body: notFoundPage() }).toString())
  }

  // Order by the board as it stands today, and say so when it has moved on.
  const board = new Map(store.topList().slice(0, config.listSize).map((row) => [row.did, row]))
  const entries = doc.entries
    .map((entry) => ({ ...entry, ...(board.get(entry.did) ?? {}) }))
    .sort((a, b) => a.rank - b.rank || a.handle.localeCompare(b.handle))
  const stale = [
    ...doc.entries.filter((entry) => !board.has(entry.did)),
    ...[...board.keys()].filter((did) => !doc.entries.some((entry) => entry.did === did)),
  ]

  const actors = await hydrate(entries.map((entry) => entry.did))
  res.type('html').send(
    layout({
      title: 'The board, annotated',
      viewer,
      path: '/admin',
      body: writeupsPage({ doc, entries, actors, stale, published: isPublished() }),
    }).toString(),
  )
})

adminRouter.post('/admin/writeups', (req, res) => {
  const { did, note, line, hidden, revert } = req.body ?? {}
  if (typeof did !== 'string' || !did.startsWith('did:')) {
    return res.status(400).json({ error: 'bad_did', message: 'Which entry?' })
  }

  const doc = loadWriteups()
  const entry = doc?.entries.find((e) => e.did === did)
  if (!entry) return res.status(404).json({ error: 'unknown', message: 'That entry is not in the draft.' })

  if (revert) {
    // Drop the hand-written version and fall back to the generated draft.
    store.upsertWriteup({ did, note: null, line: null, hidden: false, baseHash: null })
    return res.json({ ok: true, note: entry.generated.note, line: entry.generated.line, edited: false })
  }

  const nextNote = typeof note === 'string' ? note.trim().slice(0, 4000) : entry.note
  const nextLine = typeof line === 'string' ? line.trim().slice(0, 600) : entry.line
  const nextHidden = typeof hidden === 'boolean' ? hidden : entry.hidden
  const isEdit = nextNote !== entry.generated.note || nextLine !== entry.generated.line

  store.upsertWriteup({
    did,
    note: isEdit ? nextNote : null,
    line: isEdit ? nextLine : null,
    hidden: nextHidden,
    baseHash: isEdit ? entry.baseHash : null,
  })
  res.json({ ok: true, edited: isEdit, hidden: nextHidden })
})

adminRouter.post('/admin/writeups/publish', (req, res) => {
  setPublished(Boolean(req.body?.publish))
  res.json({ ok: true, published: isPublished() })
})
