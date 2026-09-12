import { getActors, getKv, setKv } from './db.js'
import { hydrate, resolveHandle } from './bluesky.js'

export const CREATOR_HANDLE = 'professorkiosk.wtf'
export const CREATOR_KOFI = 'https://ko-fi.com/professorkiosk'

const FALLBACK = { did: null, handle: CREATOR_HANDLE, displayName: 'Professor Kiosk', avatar: null }

// The footer avatar renders at 26px; the CDN's thumbnail variant of the same blob is a tenth
// the bytes. Falls back to whatever we were given if the URL is not the shape we expect.
const thumbnail = (url) => (url ? url.replace('/img/avatar/plain/', '/img/avatar_thumbnail/plain/') : null)

let cached = FALLBACK

// Warm from the profile cache so the very first render already has an avatar.
const warm = () => {
  const did = getKv('creator_did')
  if (!did) return
  const actor = getActors([did]).get(did)
  if (actor?.handle) {
    cached = {
      did,
      handle: actor.handle,
      displayName: actor.displayName || FALLBACK.displayName,
      avatar: thumbnail(actor.avatar),
    }
  }
}
warm()

export const creator = () => cached

/** Pull the creator's current profile. Their avatar is theirs to change. */
export const refreshCreator = async () => {
  try {
    const did = await resolveHandle(CREATOR_HANDLE)
    setKv('creator_did', did)
    const actor = (await hydrate([did])).get(did)
    if (actor?.handle) {
      cached = {
        did,
        handle: actor.handle,
        displayName: actor.displayName || FALLBACK.displayName,
        avatar: thumbnail(actor.avatar),
      }
    }
  } catch (err) {
    console.warn('[creator] could not refresh profile:', err.message)
  }
}
