// Thin bootstrap: check the runtime before anything imports node:sqlite, which would
// otherwise throw an unhelpful error on older Node builds.
import process from 'node:process'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Shitsky38 needs Node 22.5 or newer (for node:sqlite). You are on ${process.versions.node}.`)
  process.exit(1)
}
if (major === 22 || (major === 23 && minor < 4)) {
  const flags = process.execArgv.join(' ')
  if (!flags.includes('experimental-sqlite')) {
    console.error(
      `Node ${process.versions.node} needs the --experimental-sqlite flag. Either run:\n` +
        '  node --experimental-sqlite src/index.js\n' +
        'or upgrade to Node 24, where node:sqlite needs no flag.',
    )
    process.exit(1)
  }
}

// Fail fast on bad configuration, before anything opens a socket.
const { assertConfig } = await import('./config.js')
assertConfig()

await import('./server.js')
