/**
 * Publishes the app.bsky.feed.generator records that make our two feeds findable on Bluesky.
 *
 * Run once, by hand:
 *
 *   npm run publish-feeds
 *
 * It asks for a Bluesky app password (Settings → Privacy and security → App passwords), uses it
 * to write two records, and forgets it. Nothing is stored and the site itself never gets this
 * level of access: it can still only write vote records. Revoke the app password afterwards.
 *
 * Safe to run again — the records have fixed rkeys, so a second run edits them in place. Re-run
 * after changing a feed's name, blurb or picture. Who appears *in* a feed is decided by the
 * running site, not by these records, so a roster change never needs this script.
 */
import { AtpAgent } from '@atproto/api'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import process from 'node:process'
import { config } from '../src/config.js'
import { FEED_META, feedKeys, feedUri } from '../src/feedmeta.js'

const die = (message) => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** Reads a secret without putting it on screen, and without it reaching the shell history. */
const askSecret = async (prompt) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const onKeypress = () => rl.output.write('\u001b[2K\u001b[200D' + prompt + '*'.repeat(rl.line.length))
  rl.input.on('keypress', onKeypress)
  try {
    return (await rl.question(prompt)).trim()
  } finally {
    rl.input.off('keypress', onKeypress)
    rl.close()
    process.stdout.write('\n')
  }
}

const ask = async (prompt, fallback = '') => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(prompt)).trim()
    return answer || fallback
  } finally {
    rl.close()
  }
}

const json = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

/** Log in at whichever PDS actually holds the repo, so this works off bsky.social too. */
const resolvePds = async (did) => {
  const doc = did.startsWith('did:plc:')
    ? await json(`https://plc.directory/${did}`)
    : await json(`https://${did.slice('did:web:'.length)}/.well-known/did.json`)
  const pds = (doc.service ?? []).find((s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')
  if (!pds?.serviceEndpoint) throw new Error(`no PDS listed for ${did}`)
  return pds.serviceEndpoint
}

const mimeOf = (path) => (path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg')

const main = async () => {
  if (!config.feedOwnerDid) die('No FEED_OWNER_DID or ADMIN_DIDS set — I do not know whose repo to write to.')
  if (!config.feedServiceDid.startsWith('did:web:')) die(`FEED_SERVICE_DID should be a did:web, got ${config.feedServiceDid}`)

  console.log(`\nPublishing ${feedKeys.length} feeds`)
  console.log(`  served by   ${config.feedServiceDid}  (${config.publicUrl})`)
  console.log(`  listed from ${config.feedOwnerDid}\n`)

  // Check the service is actually reachable first: a record pointing at a dead endpoint shows up
  // in the app as a feed that forever fails to load.
  try {
    const described = await json(`${config.publicUrl}/xrpc/app.bsky.feed.describeFeedGenerator`)
    if (described.did !== config.feedServiceDid) {
      die(`${config.publicUrl} says it is ${described.did}, not ${config.feedServiceDid}. Check PUBLIC_URL on the server.`)
    }
    console.log(`✓ ${config.publicUrl} is serving the feed endpoints`)
  } catch (err) {
    die(`${config.publicUrl} is not answering as a feed service (${err.message}).\n  Deploy first, then run this.`)
  }

  const handle = process.env.BSKY_HANDLE || (await ask('Your Bluesky handle: '))
  if (!handle) die('No handle given.')

  const { did } = await json(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
  ).catch(() => ({}))
  if (!did) die(`Could not resolve ${handle}.`)
  if (did !== config.feedOwnerDid) {
    die(`${handle} is ${did}, but the feeds are configured to belong to ${config.feedOwnerDid}.\n  Refusing to write to the wrong repo.`)
  }

  const password =
    process.env.BSKY_APP_PASSWORD ||
    (await askSecret('App password (not your main password): '))
  if (!password) die('No app password given.')
  if (/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(password) === false) {
    console.warn('  (that does not look like an app password — carrying on anyway)')
  }

  const service = await resolvePds(did)
  const agent = new AtpAgent({ service })
  try {
    await agent.login({ identifier: did, password })
  } catch (err) {
    die(`Sign-in failed: ${err.message}\n  App passwords are made at Settings → Privacy and security → App passwords.`)
  }
  console.log(`✓ signed in to ${service}\n`)

  for (const key of feedKeys) {
    const meta = FEED_META[key]
    let avatar
    try {
      const bytes = await readFile(meta.avatar)
      const uploaded = await agent.com.atproto.repo.uploadBlob(bytes, { encoding: mimeOf(meta.avatar) })
      avatar = uploaded.data.blob
    } catch (err) {
      console.warn(`  (no picture for ${key}: ${err.message} — publishing without one)`)
    }

    await agent.com.atproto.repo.putRecord({
      repo: did,
      collection: 'app.bsky.feed.generator',
      rkey: key,
      record: {
        $type: 'app.bsky.feed.generator',
        did: config.feedServiceDid,
        displayName: meta.displayName,
        description: meta.description,
        ...(avatar ? { avatar } : {}),
        createdAt: new Date().toISOString(),
      },
    })

    console.log(`✓ ${meta.displayName}`)
    console.log(`    ${feedUri(key)}`)
    console.log(`    https://bsky.app/profile/${handle}/feed/${key}\n`)
  }

  console.log('Done. The feeds may take a minute to appear in search.')
  console.log('You can revoke that app password now — the site does not need it.')
}

main().catch((err) => die(err.stack ?? err.message))
