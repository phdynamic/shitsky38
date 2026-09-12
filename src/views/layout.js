import { html, raw } from './html.js'
import { config, votingState } from '../config.js'

const navItems = [
  ['/', 'Leaderboard'],
  ['/vote', 'Vote'],
  ['/me', 'My ballot'],
  ['/faq', 'Questions'],
]

const countdown = () => {
  const state = votingState()
  if (state === 'before') {
    return html`Voting opens <time datetime="${config.votingOpensAt.toISOString()}">${config.votingOpensAt.toDateString()}</time>`
  }
  if (state === 'closed') {
    return html`Voting closed. The list is the list.`
  }
  return html`Voting closes <time datetime="${config.votingClosesAt.toISOString()}">${config.votingClosesAt.toDateString()}</time>`
}

export const layout = ({ title, viewer, path = '/', body, head = '' }) => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title ? `${title} · ${config.siteName}` : config.siteName}</title>
    <meta name="description" content="The ${config.listSize} best shitposters on Bluesky, voted by you. Votes are public records in your own account." />
    <link rel="stylesheet" href="/styles.css" />
    <link rel="icon" href="/favicon.svg" />
    ${raw(head)}
  </head>
  <body data-signed-in="${viewer ? 'true' : 'false'}">
    <header class="topbar">
      <a class="wordmark" href="/">
        <span class="wordmark-shit">Shitsky</span><span class="wordmark-num">38</span>
      </a>
      <nav>
        ${navItems.map(
          ([href, label]) => html`<a href="${href}" class="${path === href ? 'active' : ''}">${label}</a>`,
        )}
      </nav>
      <div class="account">
        ${viewer
          ? html`<a class="handle" href="/profile/${viewer.did}">@${viewer.handle ?? 'you'}</a>
              <form method="post" action="/logout"><button class="linkish" type="submit">Sign out</button></form>`
          : html`<a class="btn btn-small" href="/login">Sign in</a>`}
      </div>
    </header>

    <div class="window-banner ${votingState()}">${countdown()}</div>

    <main>${body}</main>

    <footer>
      <p>
        <strong>${config.siteName}</strong> is a silly community list. It is not affiliated with Bluesky.
        Every vote is a public record in the voter's own account — you can take yours with you, or delete it.
      </p>
      <p class="muted">
        <a href="/faq">How it works</a> ·
        <a href="/lexicons">Lexicons</a> ·
        <a href="https://bsky.app">Bluesky</a>
      </p>
      <p class="credit">
        Made by
        <a href="https://bsky.app/profile/professorkiosk.wtf" rel="noopener">Professor Kiosk (@professorkiosk.wtf)</a>.
        If you would like to support the effort,
        <a class="kofi" href="https://ko-fi.com/professorkiosk" rel="noopener">buy me a coffee on Ko-fi ☕</a>.
      </p>
    </footer>
    <script src="/app.js" type="module"></script>
  </body>
</html>`
