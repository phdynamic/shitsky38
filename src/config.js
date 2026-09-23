import process from 'node:process'
import { existsSync } from 'node:fs'

// Node 21.7+ can read .env without a dependency.
if (existsSync('.env')) process.loadEnvFile('.env')

const env = (key, fallback) => {
  const value = process.env[key]
  return value === undefined || value === '' ? fallback : value
}

const num = (key, fallback) => {
  const value = Number(env(key, fallback))
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

const date = (key, fallback) => {
  const value = new Date(env(key, fallback))
  if (Number.isNaN(value.getTime())) throw new Error(`${key} must be an ISO datetime`)
  return value
}

export const VOTE_NSID = 'com.shitsky38.vote'
export const PROFILE_NSID = 'com.shitsky38.profile'

// Ask for permission to write our own two record types and nothing else. `transition:generic`,
// the old default, is the App Password level: every record type, blob uploads, preferences.
// Actions default to create/update/delete; the profile record is never deleted, so it says so.
// Override with SCOPE if a server turns out not to understand fine-grained permissions yet.
const DEFAULT_SCOPE = [
  'atproto',
  `repo:${VOTE_NSID}`,
  `repo:${PROFILE_NSID}?action=create&action=update`,
].join(' ')

export const SCOPE = (process.env.SCOPE || DEFAULT_SCOPE).trim()

// A deploy platform hands you a bare hostname, so that is what people paste. Accept it, and
// say plainly what went wrong when the value is not a URL at all.
const parsePublicUrl = (value) => {
  const trimmed = String(value).trim()
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${JSON.stringify(trimmed)}`)
  }
  if (!hasScheme) console.warn(`[config] PUBLIC_URL had no scheme — reading it as ${parsed.origin}`)
  return parsed
}

const publicUrl = parsePublicUrl(env('PUBLIC_URL', 'http://127.0.0.1:3000'))

// atproto has a development mode for clients served from loopback: the client_id is the
// literal string `http://localhost` with the metadata passed as query parameters, and no
// signing keyset is needed. Anything else is a real confidential client.
const isLoopback = ['127.0.0.1', '[::1]', '::1', 'localhost'].includes(publicUrl.hostname)

export const config = {
  port: num('PORT', publicUrl.port || 3000),
  publicUrl: publicUrl.origin,
  isDev: isLoopback,
  cookieSecret: env('COOKIE_SECRET', isLoopback ? 'dev-only-insecure-secret' : ''),
  siteName: env('SITE_NAME', 'Shitsky38'),
  listSize: num('LIST_SIZE', 38),
  maxVotes: num('MAX_VOTES', 10),
  votingOpensAt: date('VOTING_OPENS_AT', '2026-09-01T00:00:00.000Z'),
  votingClosesAt: date('VOTING_CLOSES_AT', '2026-12-31T23:59:59.000Z'),
  dbPath: env('DB_PATH', './data/shitsky38.sqlite'),
  appviewUrl: env('APPVIEW_URL', 'https://public.api.bsky.app').replace(/\/$/, ''),
  jetstreamUrl: env('JETSTREAM_URL', 'wss://jetstream2.us-east.bsky.network/subscribe'),
  jetstreamEnabled: env('JETSTREAM_ENABLED', '1') !== '0',
  // DIDs allowed into the audit view. A DID rather than a handle, because a handle can move.
  adminDids: env('ADMIN_DIDS', 'did:plc:plpviiolyyfxmopm6cqloy2b')
    .split(',')
    .map((did) => did.trim())
    .filter(Boolean),
  privateKeys: ['PRIVATE_KEY_1', 'PRIVATE_KEY_2', 'PRIVATE_KEY_3']
    .map((key) => env(key, ''))
    .filter(Boolean)
    // PEMs are easier to carry through env vars with escaped newlines.
    .map((key) => key.replace(/\\n/g, '\n')),
}

export const redirectUri = `${config.publicUrl}/oauth/callback`

export const isAdmin = (did) => Boolean(did) && config.adminDids.includes(did)

export const votingState = (now = new Date()) => {
  if (now < config.votingOpensAt) return 'before'
  if (now > config.votingClosesAt) return 'closed'
  return 'open'
}

export const assertConfig = () => {
  if (!config.isDev && publicUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must be https outside of local development')
  }
  // COOKIE_SECRET and PRIVATE_KEY_n are optional: see src/secrets.js, which mints and stores
  // them alongside the data when they are not supplied.
  if (config.votingClosesAt <= config.votingOpensAt) {
    throw new Error('VOTING_CLOSES_AT must be after VOTING_OPENS_AT')
  }
}
