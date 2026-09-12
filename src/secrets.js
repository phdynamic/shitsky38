import crypto from 'node:crypto'
import { JoseKey } from '@atproto/jwk-jose'
import { config } from './config.js'
import { getKv, setKv } from './db.js'

// Secrets come from the environment when they are set. When they are not — the common case on a
// platform where you would rather click "add volume" than manage a keyset — we mint them once and
// keep them next to the data. Losing the volume means users sign in again, nothing worse.

export const cookieSecret = (() => {
  if (config.cookieSecret) return config.cookieSecret
  const stored = getKv('cookie_secret')
  if (stored) return stored
  const generated = crypto.randomBytes(32).toString('base64url')
  setKv('cookie_secret', generated)
  console.warn('[secrets] no COOKIE_SECRET set — generated one and stored it in the database')
  return generated
})()

export const loadKeyset = async () => {
  if (config.isDev) return undefined // the localhost dev client authenticates with no key at all

  if (config.privateKeys.length > 0) {
    return Promise.all(config.privateKeys.map((key, i) => JoseKey.fromImportable(key, `key${i + 1}`)))
  }

  const stored = getKv('oauth_keyset')
  if (stored) {
    const jwks = JSON.parse(stored)
    return Promise.all(jwks.map((jwk, i) => JoseKey.fromImportable(JSON.stringify(jwk), `key${i + 1}`)))
  }

  const key = await JoseKey.generate(['ES256'], 'key1')
  setKv('oauth_keyset', JSON.stringify([key.privateJwk]))
  console.warn('[secrets] no PRIVATE_KEY_n set — generated an ES256 keyset and stored it in the database')
  return [key]
}
