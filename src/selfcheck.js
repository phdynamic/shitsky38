import { config } from './config.js'
import { oauthClient } from './oauth.js'

/**
 * Every PDS fetches our client metadata by URL during sign-in, and that URL comes from
 * PUBLIC_URL. If the two ever drift — a custom domain attached without updating the variable,
 * say — sign-in breaks for everyone while the site itself looks perfectly healthy. Check it
 * once at boot and say so loudly, rather than waiting for the first person to fail to log in.
 */
export const checkClientMetadata = async ({ delayMs = 10_000 } = {}) => {
  if (config.isDev) return { skipped: true }

  const url = oauthClient.clientMetadata.client_id
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))

  const complain = (reason) => {
    console.error(
      `[selfcheck] SIGN-IN IS BROKEN: ${reason}\n` +
        `            Every PDS must be able to fetch ${url}\n` +
        `            Set PUBLIC_URL to the domain this app is actually served from, and redeploy.`,
    )
    return { ok: false, reason }
  }

  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return complain(`${url} returned ${res.status}`)

    const doc = await res.json()
    if (doc.client_id !== url) {
      return complain(`${url} serves a document claiming client_id ${doc.client_id}`)
    }

    console.log(`[selfcheck] client metadata reachable at ${url}`)
    return { ok: true }
  } catch (err) {
    return complain(`could not fetch ${url} (${err.message})`)
  }
}
