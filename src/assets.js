import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Static assets are cached by the browser at a fixed URL, so a deploy that changes only CSS is
// invisible until that cache expires. Fingerprint each file once at boot and let the URL change
// when the bytes do.
const versions = new Map()

const fingerprint = (path) => {
  try {
    return createHash('sha256').update(readFileSync(`public${path}`)).digest('hex').slice(0, 10)
  } catch {
    return 'dev'
  }
}

export const asset = (path) => {
  if (!versions.has(path)) versions.set(path, fingerprint(path))
  return `${path}?v=${versions.get(path)}`
}
