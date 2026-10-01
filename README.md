# Shitsky38

The 38 "best" shitposters on Bluesky, voted by you — a community leaderboard in the shape of
[bsky38.com](https://bsky38.com), for a less prestigious honour.

Everybody gets 10 votes. Each vote is a **public record in the voter's own atproto repo**, not a row
in our database. Delete the record with any client and the leaderboard follows, because the
leaderboard is built by reading those records back off the firehose.

## How it works

```
you  ──sign in (atproto OAuth)──►  your PDS
 │                                    │
 └──vote──►  shitsky38  ──putRecord──►│   com.shitsky38.vote / <subject DID>
                  ▲                   │
                  └───Jetstream───────┘   every com.shitsky38.* record on the network
                        │
                   SQLite tally ──► leaderboard
```

* **`com.shitsky38.vote`** — one record per vote. The **record key is the subject's DID**, so a
  ballot physically cannot hold two votes for the same account (this is the trick bsky38 uses).
* **`com.shitsky38.profile`** — record key `self`. A nominee's own `optOut` flag and `pinnedPost`
  (their finest work, shown on their entry).

Both lexicons are in [`lexicons/`](lexicons) and served at `/lexicons`.

Counting rules, enforced in SQL so they hold even for records written outside this app:

* only the **first 10** vote records on a ballot count, ordered by each record's `createdAt`;
* votes created after `VOTING_CLOSES_AT` are ignored;
* accounts that opted out are dropped from the tally;
* equal totals share a rank, and the next total skips ahead by however many were tied
  (1, 2, 2, 4). A tie on the cut puts everyone in it on the list, so the list can run longer
  than `LIST_SIZE`; within a tie, rows are ordered by who reached that total first, which is
  presentation only and changes nobody's number.

## Running it

Needs **Node 24** (or 22.5+ with `--experimental-sqlite` — the database is `node:sqlite`, so there
is no native module to build).

```bash
npm install
cp .env.example .env
npm run dev
```

`npm test` checks the counting rules — vote tallying, the ballot cap, opt-out, the deadline, shared
ranks and tie ordering — plus what the pinned-post field accepts. Each suite runs against its own
throwaway database.

Then open <http://127.0.0.1:3000> — **not** `localhost:3000`. atproto's development OAuth client
requires the redirect to be a loopback *IP*, and the cookie follows the same origin.

In dev there are no keys to manage: the client id is atproto's special `http://localhost` form with
the metadata passed as query parameters.

## Deploying

The app needs one long-running process, a writable disk, and a stable public https origin. It does
**not** run on static hosting (GitHub Pages) or on plain serverless: the OAuth client signs a
`private_key_jwt` server-side, the Jetstream consumer holds a WebSocket open, and SQLite is a file.

Run **one** instance. The token-refresh lock is in-process and the database is local to the disk.

### Railway

1. Push this repo to GitHub, then in Railway: **New Project → Deploy from GitHub repo**.
   `railway.json` sets the builder, the start command, and the `/healthz` check; `.nvmrc` pins Node 24.
2. Add a **Volume** to the service, mounted at `/data`.
3. Set variables:

   | Variable | Value |
   | --- | --- |
   | `DB_PATH` | `/data/shitsky38.sqlite` |
   | `PUBLIC_URL` | `https://shitsky38.com` (or the `*.up.railway.app` domain, while testing) |
   | `VOTING_CLOSES_AT` | when it ends, ISO 8601 |

   Leave `PORT` alone — Railway injects it. `COOKIE_SECRET` and `PRIVATE_KEY_n` can stay empty:
   on first boot the app mints them and stores them on the volume. Set them explicitly (via
   `npm run keygen`) if you would rather the deploy be stateless in that respect.
4. Add `shitsky38.com` under **Settings → Networking → Custom Domain**, point DNS at the CNAME
   Railway gives you, **then set `PUBLIC_URL` to `https://shitsky38.com` and redeploy**. Railway
   drops the generated `*.up.railway.app` domain when a custom one is attached, so a `PUBLIC_URL`
   still pointing at it leaves the site up and sign-in broken for everyone: each PDS reads the
   metadata, is told the client lives at the old URL, and gets a 404.

`PUBLIC_URL` is not cosmetic — it *is* the OAuth `client_id`, because the client id is the URL the
metadata is served from. Changing it changes the client's identity, so every existing session has to
sign in again. Pick the final domain before telling people about it.

Once it is up, check `https://your-domain/client-metadata.json` and `/jwks.json` load from the public
internet. Every PDS fetches both during sign-in, so if they 404, nobody can log in. The app checks
this itself ten seconds after boot and prints either

```
[selfcheck] client metadata reachable at https://shitsky38.com/client-metadata.json
```

or a `SIGN-IN IS BROKEN` line naming what is wrong.

### Endpoints

| Path | What |
| --- | --- |
| `/` | leaderboard — top 38 plus the bubble |
| `/vote` | search any account, spend your 10 votes |
| `/me` | your ballot, re-read from your repo on every visit |
| `/profile/:didOrHandle` | one nominee: standing, voters, pinned post, self-controls |
| `/faq` | the rules |
| `/admin` | audit view: who voted for an account, and who it voted for. 404s for everyone but `ADMIN_DIDS` |
| `/admin/writeups` | edit the piece on each account inside the cut, and publish them to the leaderboard. Same gate |
| `/api/leaderboard` | the standings as JSON |
| `/lexicons` | the record schemas |
| `/.well-known/did.json` | the feed service's `did:web` document |
| `/xrpc/app.bsky.feed.describeFeedGenerator` | which feeds this service serves |
| `/xrpc/app.bsky.feed.getFeedSkeleton` | the post URIs for one of them |

## Layout

```
src/
  index.js      runtime checks, then boots server.js
  server.js     express wiring
  config.js     env + voting window + dev/prod client shape
  oauth.js      NodeOAuthClient (dev: localhost client, prod: private_key_jwt)
  db.js         node:sqlite schema, the tally queries, OAuth state/session stores
  ballot.js     casting, taking back, opting out — all of it writes to the repo first
  bluesky.js    AppView reads, profile cache, PDS resolution, listRecords
  jetstream.js  firehose consumer for com.shitsky38.*
  feedmeta.js   each feed's name, blurb and picture — no database, so scripts can read it
  feeds.js      who is in each feed, recomputed from the tally
  feedingest.js a second firehose subscription, filtered to those accounts, plus the backfill
  secrets.js    cookie secret + OAuth keyset: env first, else minted and stored
  routes/       auth.js · api.js · pages.js · admin.js · feeds.js
  views/        html.js (escaping template tag) · layout.js · pages.js
public/         styles.css · app.js · favicon.svg · logo.png
scripts/        keygen.js · backfill.js · publish-feeds.mjs
```

### The annotations

`content/writeups.json` is the generated draft. Anything edited at `/admin/writeups` is stored in
the database instead and wins over the draft, so regenerating the file never overwrites your
wording — an edited entry whose draft has since changed is flagged for another look, and **Revert
to draft** drops the edit. Publishing is a switch on the same page: until it is on, only `ADMIN_DIDS`
can see any of it; once on, each of the top entries on the front page carries its piece.

`node scripts/backfill.js [handle|did ...]` re-reads ballots straight from repos if the firehose
consumer was ever down.

### The feeds

Two Bluesky custom feeds, served by this same app:

- **Shitsky38** — everyone currently inside the cut.
- **Shitsky38: Deep Cuts** — nominated, short of the cut, under `DEEP_CUTS_MAX_FOLLOWERS`
  followers, with at least `DEEP_CUTS_MIN_VOTES` votes. A single vote can be the account's own,
  which is why the floor is two.

The service identifies itself as `did:web:<host>`, which resolves from `/.well-known/did.json`
right here — no PLC operation, no key to rotate. A second Jetstream subscription, filtered to the
accounts in the two rosters, keeps `feed_post` current; a one-off backfill of each new member's
recent posts means a feed is never empty on its first day. Replies are stored but not served, so
that policy can change without refetching anything. Posts dated in the future are ignored, and
withdrawing from the list takes your posts out of the feeds as well as off the board.

No account may supply more than `MAX_POSTS_PER_DAY` posts to a feed on any given day — its newest
that day, the rest left out. A self-described bot posting a steady 34 times a day was otherwise one
post in seven of Deep Cuts, while ordinary members post a median of 4 a day and 13 at the 90th
percentile, so the default of 10 clips only unusually busy days. The cap applies when the feed is
read, not when posts are stored, so changing it takes effect at once and nothing has to be refetched.

Rosters are recomputed every ten minutes — **until voting closes, after which they freeze.** The
top 38 would settle anyway, because late votes never count; Deep Cuts would not, since follower
counts keep moving, and nobody should drop off a list they qualified for.

Publishing is manual and deliberate, because writing an `app.bsky.feed.generator` record needs a
permission the site does not have and should not ask voters for:

```
npm run publish-feeds https://shitsky38.com
```

Name the live site. Left out, it falls back to `PUBLIC_URL`, which in a working copy is the dev
server — and records naming `did:web:127.0.0.1` look fine locally while being permanently broken
for everyone else, so a loopback target is refused outright.

It asks for a Bluesky app password, writes the two records, and forgets it — revoke the password
afterwards. Re-run it only to change a feed's name, blurb or picture. Until the records exist the
site advertises nothing: it checks what is actually published and only then draws the buttons.

## Not affiliated with Bluesky

It's a joke list. Anyone voted onto it can take themselves off from their own entry page.
