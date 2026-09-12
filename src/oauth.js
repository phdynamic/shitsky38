import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { JoseKey } from '@atproto/jwk-jose'
import { config, redirectUri, SCOPE } from './config.js'
import { sessionStore, stateStore } from './db.js'

const devClientId = () => {
  // atproto's development client: the literal `http://localhost` origin, with the metadata
  // carried in query parameters. The redirect must be a loopback IP, not the name `localhost`.
  const params = new URLSearchParams({ redirect_uri: redirectUri, scope: SCOPE })
  return `http://localhost?${params.toString()}`
}

const clientMetadata = config.isDev
  ? {
      client_id: devClientId(),
      client_name: config.siteName,
      redirect_uris: [redirectUri],
      scope: SCOPE,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
    }
  : {
      client_id: `${config.publicUrl}/client-metadata.json`,
      client_name: config.siteName,
      client_uri: config.publicUrl,
      logo_uri: `${config.publicUrl}/logo.png`,
      tos_uri: `${config.publicUrl}/faq`,
      policy_uri: `${config.publicUrl}/faq`,
      redirect_uris: [redirectUri],
      scope: SCOPE,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      dpop_bound_access_tokens: true,
      jwks_uri: `${config.publicUrl}/jwks.json`,
    }

const keyset = config.isDev
  ? undefined
  : await Promise.all(config.privateKeys.map((pem, i) => JoseKey.fromImportable(pem, `key${i + 1}`)))

// Serialises token refreshes per subject. Enough for a single instance; swap for a shared
// lock (Redis, Postgres advisory locks) the day this runs on more than one process.
const locks = new Map()
const requestLock = (name, fn) => {
  const previous = locks.get(name) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  locks.set(
    name,
    next.then(
      () => {
        if (locks.get(name) === next) locks.delete(name)
      },
      () => {
        if (locks.get(name) === next) locks.delete(name)
      },
    ),
  )
  return next
}

export const oauthClient = new NodeOAuthClient({
  clientMetadata,
  keyset,
  stateStore,
  sessionStore,
  requestLock,
})
