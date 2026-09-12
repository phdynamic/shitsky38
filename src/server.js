import express from 'express'
import process from 'node:process'
import { config, votingState } from './config.js'
import { sweepOauthState } from './db.js'
import { viewerMiddleware } from './session.js'
import { authRouter } from './routes/auth.js'
import { apiRouter } from './routes/api.js'
import { pagesRouter } from './routes/pages.js'
import { layout } from './views/layout.js'
import { errorPage, notFoundPage } from './views/pages.js'
import { startJetstream } from './jetstream.js'

const app = express()
app.disable('x-powered-by')
if (!config.isDev) app.set('trust proxy', 1)

app.use(express.json({ limit: '16kb' }))
app.use(express.urlencoded({ extended: false, limit: '16kb' }))
app.use(express.static('public', { maxAge: config.isDev ? 0 : '1h' }))
app.use(viewerMiddleware)

// Cheap liveness probe for the platform's health check.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, voting: votingState(), uptime: Math.round(process.uptime()) })
})

app.use('/api', apiRouter)
app.use(authRouter)
app.use(pagesRouter)

app.use((req, res) => {
  res.status(404).type('html').send(layout({ title: 'Not found', viewer: null, path: req.path, body: notFoundPage() }).toString())
})

app.use((err, _req, res, _next) => {
  console.error('[server]', err)
  res
    .status(500)
    .type('html')
    .send(layout({ title: 'Error', viewer: null, body: errorPage('An unexpected error happened. Try again.') }).toString())
})

const server = app.listen(config.port, () => {
  console.log(`${config.siteName} listening on ${config.publicUrl} (voting ${votingState()})`)
  if (config.isDev) console.log('dev mode: using the atproto localhost OAuth client — no keys needed')
})

const stopJetstream = startJetstream()
const sweeper = setInterval(sweepOauthState, 15 * 60 * 1000)
sweeper.unref()

const shutdown = () => {
  console.log('\nshutting down')
  stopJetstream()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5_000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
