import { html } from './html.js'
import { config, votingState } from '../config.js'

const nf = new Intl.NumberFormat('en-US')
const num = (value) => nf.format(value ?? 0)
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`

const initial = (actor) => (actor.displayName ?? actor.handle ?? actor.did).replace(/^@/, '').charAt(0).toUpperCase()

const avatar = (actor, size = 'md') =>
  actor.avatar
    ? html`<img class="avatar ${size}" src="${actor.avatar}" alt="" loading="lazy" />`
    : html`<span class="avatar ${size} placeholder" aria-hidden="true">${initial(actor)}</span>`

const displayName = (actor) => actor.displayName || actor.handle || actor.did

const handleOf = (actor) => (actor.handle ? `@${actor.handle}` : actor.did)

export const voteButton = ({ did, voted, disabled, viewer }) => {
  if (votingState() !== 'open') return html`<span class="vote-static">${voted ? 'voted' : ''}</span>`
  if (!viewer) return html`<a class="btn btn-vote" href="/login?next=${encodeURIComponent('/vote')}">Vote</a>`
  return html`<button
    class="btn btn-vote ${voted ? 'voted' : ''}"
    data-vote="${did}"
    aria-pressed="${voted ? 'true' : 'false'}"
    ${disabled && !voted ? html`disabled title="You have used all your votes"` : ''}
  >
    <span class="vote-label">${voted ? 'Voted' : 'Vote'}</span>
  </button>`
}

const row = ({ entry, actor, viewer, voted, outOfVotes }) => html`<li class="row" data-did="${entry.did}">
  <span class="rank ${entry.rank <= config.listSize ? 'in' : 'out'}">${entry.rank}</span>
  <a class="who" href="/profile/${entry.did}">
    ${avatar(actor)}
    <span class="names">
      <span class="name">${displayName(actor)}</span>
      <span class="handle">${handleOf(actor)}</span>
    </span>
  </a>
  <span class="tally"><b data-count="${entry.did}">${num(entry.votes)}</b><small>${entry.votes === 1 ? 'vote' : 'votes'}</small></span>
  ${voteButton({ did: entry.did, voted, disabled: outOfVotes, viewer })}
</li>`

/* ----------------------------------------------------------- leaderboard ---- */

export const leaderboardPage = ({ entries, rest, actors, stats, viewer, ballot, hasMore, nextOffset, pageSize }) => {
  const voted = new Set(ballot.map((b) => b.subject_did))
  const outOfVotes = ballot.length >= config.maxVotes

  return html`
    <section class="hero">
      <h1>The ${config.listSize} "best" shitposters on Bluesky</h1>
      <p class="lede">
        Voted by you. Everybody gets ${config.maxVotes} votes. The ${config.listSize} accounts with the
        most votes make the list. No merit involved. There are no prizes and bragging rights are probably
        of minimal value at best.
      </p>
      <dl class="stats">
        <div><dt>votes cast</dt><dd>${num(stats.votes)}</dd></div>
        <div><dt>voters</dt><dd>${num(stats.voters)}</dd></div>
        <div><dt>nominees</dt><dd>${num(stats.nominees)}</dd></div>
      </dl>
      ${viewer
        ? html`<p class="you-have">
            You have used <b>${ballot.length}</b> of <b>${config.maxVotes}</b> votes.
            <a href="/vote">Find someone to vote for →</a>
          </p>`
        : html`<p class="you-have">
            <a class="btn" href="/login">Sign in with Bluesky</a> to cast your ${config.maxVotes} votes
          </p>`}
    </section>

    <section class="find">
      <h2>Vote for anybody on Bluesky</h2>
      <p class="muted">
        Not just the accounts below — any account at all. Search a handle or a name, and press a vote
        again to take it back.
      </p>
      <form class="search" action="/vote" method="get" role="search">
        <input
          type="search"
          name="q"
          id="q"
          placeholder="Search any Bluesky account — e.g. dril"
          autocomplete="off"
        />
        <button class="btn" type="submit">Search</button>
      </form>
      <ul class="results" id="results"></ul>
    </section>

    ${entries.length === 0
      ? html`<section class="empty">
          <h2>Nobody has been nominated yet.</h2>
          <p>Be the first. <a href="/vote">Go find the worst poster you love.</a></p>
        </section>`
      : html`<ol class="board">
          ${entries.map((entry) =>
            row({
              entry,
              actor: actors.get(entry.did) ?? { did: entry.did },
              viewer,
              voted: voted.has(entry.did),
              outOfVotes,
            }),
          )}
        </ol>`}

    ${rest.length > 0
      ? html`<section class="rest">
          <h2>On the bubble</h2>
          <p class="muted">Below the cut — for now.</p>
          <ol class="board dim" id="rest-board">
            ${rest.map((entry) =>
              row({
                entry,
                actor: actors.get(entry.did) ?? { did: entry.did },
                viewer,
                voted: voted.has(entry.did),
                outOfVotes,
              }),
            )}
          </ol>
          ${hasMore
            ? html`<button
                class="btn btn-ghost load-more"
                id="load-more"
                data-offset="${nextOffset}"
                data-limit="${pageSize}"
              >
                Load ${pageSize} more
              </button>`
            : ''}
        </section>`
      : ''}
  `
}

/* ------------------------------------------------------------------ vote ---- */

export const votePage = ({ viewer, ballot, actors, query }) => html`
  <section class="hero narrow">
    <h1>Cast your votes</h1>
    <p class="lede">
      Search any Bluesky account and vote for the ${config.maxVotes} whose posting you would defend in court.
      Press a vote again to take it back.
    </p>
  </section>

  ${viewer
    ? html`<section class="ballot-status">
        <b>${ballot.length}</b> of <b>${config.maxVotes}</b> votes used
        <span class="pips">${Array.from({ length: config.maxVotes }, (_, i) => html`<span class="pip ${i < ballot.length ? 'on' : ''}"></span>`)}</span>
      </section>`
    : html`<section class="ballot-status signin">
        <a class="btn" href="/login?next=${encodeURIComponent('/vote')}">Sign in with Bluesky to vote</a>
      </section>`}

  <form class="search" action="/vote" method="get" role="search">
    <input
      type="search"
      name="q"
      id="q"
      value="${query ?? ''}"
      placeholder="Search by handle or name — e.g. dril"
      autocomplete="off"
      autofocus
    />
    <button class="btn" type="submit">Search</button>
  </form>

  <ul class="results" id="results"></ul>

  ${ballot.length > 0
    ? html`<section class="your-ballot">
        <h2>Your ballot</h2>
        <ul class="results">
          ${ballot.map((item) => {
            const actor = actors.get(item.subject_did) ?? { did: item.subject_did }
            return html`<li class="row" data-did="${item.subject_did}">
              <a class="who" href="/profile/${item.subject_did}">
                ${avatar(actor)}
                <span class="names">
                  <span class="name">${displayName(actor)}</span>
                  <span class="handle">${handleOf(actor)}</span>
                </span>
              </a>
              ${voteButton({ did: item.subject_did, voted: true, viewer })}
            </li>`
          })}
        </ul>
      </section>`
    : ''}
`

/* --------------------------------------------------------------- profile ---- */

export const profilePage = ({ actor, entry, viewer, voted, outOfVotes, voters, voterActors, pinned, isSelf, nominee }) => html`
  <section class="profile">
    ${avatar(actor, 'lg')}
    <div class="profile-meta">
      <h1>${displayName(actor)}</h1>
      <p class="handle">
        <a href="https://bsky.app/profile/${actor.handle ?? actor.did}" rel="noopener">${handleOf(actor)}</a>
      </p>
      ${actor.description ? html`<p class="bio">${actor.description}</p>` : ''}
      <p class="standing">
        ${nominee?.optOut
          ? html`<span class="opted-out">Withdrew from the list</span>`
          : entry
            ? html`<b>#${entry.rank}</b> with ${plural(entry.votes, 'vote', 'votes')}`
            : html`<span class="muted">No votes yet.</span>`}
      </p>
      ${voteButton({ did: actor.did, voted, disabled: outOfVotes, viewer })}
    </div>
  </section>

  ${pinned
    ? html`<section class="pinned">
        <h2>Exhibit A</h2>
        <blockquote>
          <p>${pinned.record?.text ?? ''}</p>
          <cite><a href="https://bsky.app/profile/${actor.handle ?? actor.did}/post/${String(pinned.uri).split('/').pop()}">on Bluesky</a></cite>
        </blockquote>
      </section>`
    : ''}

  ${isSelf ? selfControls({ nominee }) : ''}

  <section class="voters">
    <h2>Voted for by</h2>
    ${voters.length === 0
      ? html`<p class="muted">Nobody yet.</p>`
      : html`<ul class="voter-list">
          ${voters.map((voter) => {
            const va = voterActors.get(voter.voter_did) ?? { did: voter.voter_did }
            return html`<li>
              <a href="/profile/${voter.voter_did}">${avatar(va, 'sm')}<span>${displayName(va)}</span></a>
            </li>`
          })}
        </ul>`}
  </section>
`

const selfControls = ({ nominee }) => html`<section class="self-controls">
  <h2>This is you</h2>
  <div class="control-row">
    <div>
      <b>Pin your finest work</b>
      <p class="muted">An AT-URI of one of your posts, shown on your entry.</p>
      <form id="pin-form" class="inline-form">
        <input type="text" name="pinnedPost" value="${nominee?.pinnedPost ?? ''}" placeholder="at://did:plc:…/app.bsky.feed.post/…" />
        <button class="btn btn-small" type="submit">Save</button>
      </form>
    </div>
    <div>
      <b>${nominee?.optOut ? 'You have withdrawn' : 'Want out?'}</b>
      <p class="muted">
        ${nominee?.optOut
          ? 'Your votes are kept but not counted, and you are hidden from the leaderboard.'
          : 'Remove yourself from the leaderboard. You can come back while voting is open.'}
      </p>
      <button class="btn btn-small ${nominee?.optOut ? '' : 'danger'}" id="optout" data-optout="${nominee?.optOut ? 'false' : 'true'}">
        ${nominee?.optOut ? 'Rejoin the list' : 'Withdraw'}
      </button>
    </div>
  </div>
</section>`

/* ------------------------------------------------------------------- me ---- */

export const mePage = ({ viewer, ballot, actors, standingEntry }) => html`
  <section class="hero narrow">
    <h1>Your ballot</h1>
    <p class="lede">
      These are records in <b>your</b> account, at <code>${'com.shitsky38.vote'}</code>. Delete them here or with any
      atproto client; either way the leaderboard follows.
    </p>
  </section>

  <section class="ballot-status">
    <b>${ballot.length}</b> of <b>${config.maxVotes}</b> votes used
    <span class="pips">${Array.from({ length: config.maxVotes }, (_, i) => html`<span class="pip ${i < ballot.length ? 'on' : ''}"></span>`)}</span>
  </section>

  ${standingEntry
    ? html`<p class="you-have">You are currently <b>#${standingEntry.rank}</b> with ${plural(standingEntry.votes, 'vote', 'votes')}. <a href="/profile/${viewer.did}">Your entry →</a></p>`
    : html`<p class="you-have muted">You have no votes yet. <a href="/profile/${viewer.did}">Your entry →</a></p>`}

  ${ballot.length === 0
    ? html`<section class="empty"><h2>Empty ballot.</h2><p><a href="/vote">Go vote for somebody.</a></p></section>`
    : html`<ul class="results">
        ${ballot.map((item) => {
          const actor = actors.get(item.subject_did) ?? { did: item.subject_did }
          return html`<li class="row" data-did="${item.subject_did}">
            <a class="who" href="/profile/${item.subject_did}">
              ${avatar(actor)}
              <span class="names">
                <span class="name">${displayName(actor)}</span>
                <span class="handle">${handleOf(actor)}</span>
              </span>
            </a>
            <span class="muted small">${new Date(item.created_at).toLocaleDateString()}</span>
            ${voteButton({ did: item.subject_did, voted: true, viewer })}
          </li>`
        })}
      </ul>`}
`

/* ---------------------------------------------------------------- login ---- */

export const loginPage = ({ error, next }) => html`
  <section class="hero narrow">
    <h1>Sign in with Bluesky</h1>
    <p class="lede">
      We use atproto OAuth. You type your handle, your own server asks whether you consent, and we never see
      your password.
    </p>
  </section>
  ${error ? html`<p class="error">${error}</p>` : ''}
  <form class="search" method="post" action="/login">
    <input type="hidden" name="next" value="${next ?? '/'}" />
    <input type="text" name="handle" placeholder="you.bsky.social" autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required />
    <button class="btn" type="submit">Continue</button>
  </form>
  <p class="muted narrow">
    We ask for permission to write one kind of record — your votes — into your repo. Nothing else.
  </p>
`

/* ------------------------------------------------------------------ faq ---- */

export const faqPage = () => {
  const items = [
    [
      'What is this?',
      html`A community-voted list of the ${config.listSize} "best" shitposters on Bluesky. It is fun and silly and
      means nothing. It is not run by Bluesky.`,
    ],
    [
      'How many votes do I get?',
      html`${config.maxVotes}. Press a vote again to take it back and get it returned to you.`,
    ],
    [
      'Where do my votes live?',
      html`In your own account. A vote is a record at <code>com.shitsky38.vote</code> in your repo — the same
      way a post, a like or a follow is a record. The record key is the DID of the account you voted for, so you
      can never accidentally vote twice for the same person.`,
    ],
    [
      'So my votes are public?',
      html`Yes. Anything in your repo is public, and there is no such thing as a private record on atproto today.
      Vote accordingly.`,
    ],
    [
      'Can I vote for myself?',
      html`You can. Everyone will be able to see that you did.`,
    ],
    [
      'Who can be nominated?',
      html`Anybody with a Bluesky account. There is no nomination round — voting for somebody is what puts them
      on the board.`,
    ],
    [
      'I do not want to be on this list.',
      html`Fair. Sign in, open your own entry, and press Withdraw. You come off the leaderboard immediately, and
      you can rejoin while voting is open.`,
    ],
    [
      'What happens when two accounts tie?',
      html`They share the rank. Three accounts on the same number of votes are all #12, and the next account
      down is #15. If the tie lands on the cut, everybody in it makes the list — so a tie year can run to 39 or
      40 names rather than dropping somebody who polled exactly as well as the account above them. Within a
      tie we list whoever reached that total first, which is ordering only and changes nobody's number.`,
    ],
    [
      'Can I stuff the ballot?',
      html`Only the first ${config.maxVotes} votes on any ballot count, ordered by when each vote record was
      created, so writing 400 vote records straight into your repo does not help you.`,
    ],
    [
      'When does it close?',
      html`<time datetime="${config.votingClosesAt.toISOString()}">${config.votingClosesAt.toUTCString()}</time>.
      Votes created after that are ignored, whatever their record says.`,
    ],
    [
      'Can I use a different app to vote?',
      html`Yes — write your own <code>com.shitsky38.vote</code> records however you like. We read them off the
      firehose. The lexicons are <a href="/lexicons">right here</a>.`,
    ],
  ]

  return html`
    <section class="hero narrow"><h1>Questions</h1></section>
    <div class="faq">
      ${items.map(([q, a]) => html`<details><summary>${q}</summary><div>${a}</div></details>`)}
    </div>
  `
}

export const notFoundPage = () => html`
  <section class="hero narrow">
    <h1>404</h1>
    <p class="lede">Nothing here. <a href="/">Back to the list.</a></p>
  </section>
`

export const errorPage = (message) => html`
  <section class="hero narrow">
    <h1>Something broke</h1>
    <p class="lede">${message}</p>
    <p><a href="/">Back to the list.</a></p>
  </section>
`
