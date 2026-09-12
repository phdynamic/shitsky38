import crypto from 'node:crypto'
import { config } from './config.js'
import { cookieSecret } from './secrets.js'

const COOKIE_NAME = 's38'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const b64url = (buf) => Buffer.from(buf).toString('base64url')

const sign = (payload) => {
  const body = b64url(JSON.stringify(payload))
  const mac = crypto.createHmac('sha256', cookieSecret).update(body).digest('base64url')
  return `${body}.${mac}`
}

const verify = (value) => {
  if (typeof value !== 'string' || !value.includes('.')) return null
  const [body, mac] = value.split('.')
  const expected = crypto.createHmac('sha256', cookieSecret).update(body).digest('base64url')
  const a = Buffer.from(mac ?? '')
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload?.did || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=')
        if (eq < 0) return [part, '']
        return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))]
      }),
  )

export const login = (res, did) => {
  res.cookie(COOKIE_NAME, sign({ did, exp: Date.now() + MAX_AGE_MS }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: !config.isDev,
    maxAge: MAX_AGE_MS,
    path: '/',
  })
}

export const logout = (res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' })
}

/** Puts `req.viewerDid` on every request (null when signed out). */
export const viewerMiddleware = (req, _res, next) => {
  const cookies = parseCookies(req.headers.cookie)
  req.viewerDid = verify(cookies[COOKIE_NAME])?.did ?? null
  next()
}

export const requireViewer = (req, res, next) => {
  if (!req.viewerDid) {
    res.status(401).json({ error: 'not_signed_in', message: 'Sign in with Bluesky to vote.' })
    return
  }
  next()
}
