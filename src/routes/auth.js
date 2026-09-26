import { Router } from 'express'
import { oauthClient } from '../oauth.js'
import { config } from '../config.js'
import { login, logout } from '../session.js'
import { layout } from '../views/layout.js'
import { errorPage, loginPage } from '../views/pages.js'
import { syncBallotFromRepo, syncProfileFromRepo } from '../ballot.js'
import { handleCandidates, resolveHandle } from '../bluesky.js'

export const authRouter = Router()

// Only ever bounce back to our own paths.
const safeNext = (value) => (typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : '/')

authRouter.get('/client-metadata.json', (_req, res) => res.json(oauthClient.clientMetadata))
authRouter.get('/jwks.json', (_req, res) => res.json(oauthClient.jwks))

authRouter.get('/login', (req, res) => {
  if (req.viewerDid) return res.redirect(safeNext(req.query.next))
  res.type('html').send(
    layout({
      title: 'Sign in',
      path: '/login',
      viewer: null,
      body: loginPage({ error: req.query.error, next: safeNext(req.query.next) }),
    }).toString(),
  )
})

authRouter.post('/login', async (req, res) => {
  const handle = String(req.body?.handle ?? '').trim().replace(/^@/, '')
  const next = safeNext(req.body?.next)
  if (!handle) return res.redirect(`/login?error=${encodeURIComponent('Enter your handle.')}`)

  try {
    const ac = new AbortController()
    // Abort only if the *client* goes away. Listening on req would fire the moment the POST
    // body finished streaming, which cancels our own in-flight OAuth request.
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })

    // Resolve the handle ourselves over HTTPS. The client's own resolver reaches for a DNS TXT
    // record first, which plenty of networks (and containers) will not answer. People also type
    // the bare name in front of .bsky.social, so try that too rather than failing the sign-in.
    let subject = handle
    for (const candidate of handleCandidates(handle)) {
      try {
        subject = await resolveHandle(candidate)
        break
      } catch {
        /* try the next shape, then let the OAuth client attempt its own resolution */
      }
    }

    const url = await oauthClient.authorize(subject, { state: next, signal: ac.signal })
    res.redirect(url.toString())
  } catch (err) {
    const typo = /resolve identity|resolve handle/i.test(err.message)
    console[typo ? 'log' : 'warn'](`[auth] ${typo ? 'handle not found' : 'authorize failed'}: ${err.message}`)
    const message = handle.includes('@')
      ? 'That looks like an email address. Sign in with your Bluesky handle, like you.bsky.social.'
      : /resolve|handle|identity/i.test(err.message)
        ? `We could not find an account for "${handle}". Check the spelling, or try the full handle.`
        : /scope|permission/i.test(err.message)
          ? 'Your server did not accept the permissions this site asks for. Please let us know which server you are on.'
          : 'Bluesky did not answer just now. Try again in a moment.'
    res.redirect(`/login?error=${encodeURIComponent(message)}`)
  }
})

authRouter.get('/oauth/callback', async (req, res) => {
  try {
    const params = new URLSearchParams(req.originalUrl.split('?')[1] ?? '')
    const { session, state } = await oauthClient.callback(params)

    login(res, session.did)

    // Their repo is the source of truth; pull what is already there before showing them anything.
    await Promise.allSettled([syncBallotFromRepo(session.did), syncProfileFromRepo(session.did)])

    res.redirect(safeNext(state))
  } catch (err) {
    const expected = /rejected the request|Unknown authorization session|request has expired|was aborted/i.test(
      err.message,
    )
    console[expected ? 'log' : 'warn'](`[auth] sign-in ${expected ? 'not completed' : 'callback failed'}: ${err.message}`)
    res
      .status(400)
      .type('html')
      .send(
        layout({
          title: 'Sign-in failed',
          viewer: null,
          body: errorPage(`Sign-in did not complete: ${err.message}`),
        }).toString(),
      )
  }
})

authRouter.post('/logout', (req, res) => {
  const did = req.viewerDid
  logout(res)
  if (did) {
    // Revoke the tokens too, but never block the redirect on it.
    oauthClient
      .restore(did)
      .then((session) => session.signOut())
      .catch(() => {})
  }
  res.redirect('/')
})

export const siteName = config.siteName
