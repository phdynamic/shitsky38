// Generates the ES256 keys a production (non-loopback) deployment needs for
// private_key_jwt client authentication. Paste the output into .env.
//
//   npm run keygen
import { JoseKey } from '@atproto/jwk-jose'

const count = Number(process.argv[2] ?? 3)

for (let i = 1; i <= count; i++) {
  const key = await JoseKey.generate(['ES256'], `key${i}`)
  // fromImportable() reads a JWK JSON string back, so that is what we print.
  console.log(`PRIVATE_KEY_${i}=${JSON.stringify(key.privateJwk)}`)
}
