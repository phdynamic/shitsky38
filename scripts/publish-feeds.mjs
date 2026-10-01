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

/**
 * Reads a secret without putting it on screen, and without it reaching the shell history.
 *
 * Raw mode is what actually stops the terminal echoing, so the characters are never drawn and
 * never have to be erased. readline's own masking depends on its line buffer being current when
 * the keypress fires, and the failure mode there is the password sitting in the clear on
 * somebody's screen.
 */
const askSecret = (prompt) =>
  new Promise((resolve) => {
    const input = process.stdin

    // Piped in rather than typed: there is no terminal echo to suppress.
    if (!input.isTTY) {
      const rl = createInterface({ input, terminal: false })
      // close fires without a line when stdin is empty or already at EOF — resolving empty lets
      // the caller say so and exit, rather than waiting on input that is never coming.
      rl.once('close', () => resolve(''))
      rl.once('line', (line) => {
        rl.close()
        resolve(line.trim())
      })
      return
    }

    process.stdout.write(prompt)
    // Raw mode goes on last: resuming the stream is what can put the terminal back into cooked
    // mode, and cooked mode is the one that echoes.
    input.resume()
    input.setEncoding('utf8')
    input.setRawMode(true)

    let typed = ''
    const done = (value) => {
      input.setRawMode(false)
      input.pause()
      input.off('data', onData)
      process.stdout.write('\n')
      resolve(value)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return done(typed.trim())
        if (char === '\u0003') {
          input.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
        else if (char >= ' ') typed += char
      }
    }
    input.on('data', onData)
  })

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

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1']

/**
 * Which deployment these records should point at.
 *
 * Deliberately *not* just `config.publicUrl`: this script is run from a working copy, whose .env
 * points at a development server. Publishing from there would write two records naming
 * did:web:127.0.0.1 — records that look fine locally and are permanently broken for everybody
 * else. So a loopback target is refused outright and has to be named explicitly.
 */
const resolveTarget = () => {
  const given = process.argv[2] || process.env.SITE_URL || ''
  const raw = given || config.publicUrl
  let url
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    die(`Not a URL: ${JSON.stringify(raw)}`)
  }
  if (LOOPBACK.includes(url.hostname)) {
    die(
      `${url.origin} is a local address, and a feed has to be reachable from Bluesky.\n` +
        `  Your .env points at the dev server, which is the right setting for development and the\n` +
        `  wrong one here. Name the live site instead:\n\n` +
        `      npm run publish-feeds https://shitsky38.com\n`,
    )
  }
  // FEED_SERVICE_DID still wins if it is set, for a service hosted somewhere other than the site.
  return { origin: url.origin, did: process.env.FEED_SERVICE_DID || `did:web:${url.hostname}` }
}

const main = async () => {
  if (!config.feedOwnerDid) die('No FEED_OWNER_DID or ADMIN_DIDS set — I do not know whose repo to write to.')

  const target = resolveTarget()
  if (!target.did.startsWith('did:web:')) die(`FEED_SERVICE_DID should be a did:web, got ${target.did}`)

  console.log(`\nPublishing ${feedKeys.length} feeds`)
  console.log(`  served by   ${target.did}  (${target.origin})`)
  console.log(`  listed from ${config.feedOwnerDid}\n`)

  // Check the service is actually reachable first: a record pointing at a dead endpoint shows up
  // in the app as a feed that forever fails to load.
  try {
    const described = await json(`${target.origin}/xrpc/app.bsky.feed.describeFeedGenerator`)
    if (described.did !== target.did) {
      die(`${target.origin} says it is ${described.did}, not ${target.did}. Check PUBLIC_URL on the server.`)
    }
    console.log(`✓ ${target.origin} is serving the feed endpoints`)
  } catch (err) {
    die(`${target.origin} is not answering as a feed service (${err.message}).\n  Deploy first, then run this.`)
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
        did: target.did,
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
