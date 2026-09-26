// Whatever somebody pastes into the pinned-post field. Run with: npm test
import assert from 'node:assert/strict'
import { toPostUri } from '../src/bluesky.js'

const EXPECTED = 'at://did:plc:payitpphkpx3e6hz7rmazzap/app.bsky.feed.post/3mpmkblzkd224'

for (const input of [
  'https://bsky.app/profile/sj.gg/post/3mpmkblzkd224',
  'http://bsky.app/profile/sj.gg/post/3mpmkblzkd224',
  'https://bsky.app/profile/sj.gg/post/3mpmkblzkd224?ref=share',
  'at://sj.gg/app.bsky.feed.post/3mpmkblzkd224',
  EXPECTED,
  `  ${EXPECTED}  `,
]) {
  assert.equal(await toPostUri(input), EXPECTED, `should accept: ${input}`)
}
console.log('✓ post links, at-uris and handles all resolve to the same record')

for (const input of ['https://bsky.app/profile/sj.gg', 'https://example.com/hello', 'asdf', '', null, undefined]) {
  assert.equal(await toPostUri(input), null, `should reject: ${JSON.stringify(input)}`)
}
console.log('✓ anything that is not a post is rejected rather than stored')

console.log('\npinned post parsing holds')
