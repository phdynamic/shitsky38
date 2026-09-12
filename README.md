# Shitsky38

The 38 best shitposters on Bluesky, voted by you — a community leaderboard in the shape of
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
* ties break toward whoever got their first vote earliest.

## Running it

Needs **Node 24** (or 22.5+ with `--experimental-sqlite` — the database is `node:sqlite`, so there
is no native module to build).

```bash
npm install
cp .env.example .env
npm run dev
```

Then open <http://127.0.0.1:3000> — **not** `localhost:3000`. atproto's development OAuth client
requires the redirect to be a loopback *IP*, and the cookie follows the same origin.

In dev there are no keys to manage: the client id is atproto's special `http://localhost` form with
the metadata passed as query parameters.

## Deploying to shitsky38.com

1. Point `shitsky38.com` at the app and terminate TLS in front of it.
2. `npm run keygen` and paste the three `PRIVATE_KEY_n` lines into `.env`.
3. Set `PUBLIC_URL=https://shitsky38.com` and a long random `COOKIE_SECRET`.
4. Start it. The OAuth client metadata is served from `/client-metadata.json` and the public keys
   from `/jwks.json` — both must be reachable from the public internet, since every PDS fetches
   them during sign-in.

A non-loopback `PUBLIC_URL` refuses to boot without keys, a cookie secret, and https.

### Endpoints

| Path | What |
| --- | --- |
| `/` | leaderboard — top 38 plus the bubble |
| `/vote` | search any account, spend your 10 votes |
| `/me` | your ballot, re-read from your repo on every visit |
| `/profile/:didOrHandle` | one nominee: standing, voters, pinned post, self-controls |
| `/faq` | the rules |
| `/api/leaderboard` | the standings as JSON |
| `/lexicons` | the record schemas |

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
  routes/       auth.js · api.js · pages.js
  views/        html.js (escaping template tag) · layout.js · pages.js
public/         styles.css · app.js · favicon.svg
scripts/        keygen.js · backfill.js
```

`node scripts/backfill.js [handle|did ...]` re-reads ballots straight from repos if the firehose
consumer was ever down.

## Not affiliated with Bluesky

It's a joke list. Anyone voted onto it can take themselves off from their own entry page.
