import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from './config.js'

const file = resolve(config.dbPath)

let database
try {
  mkdirSync(dirname(file), { recursive: true })
  database = new DatabaseSync(file)
} catch (err) {
  // The usual cause on a platform is a volume that is not mounted where DB_PATH expects it,
  // which otherwise surfaces as an unexplained crash loop.
  throw new Error(
    `Cannot open the database at ${file} (${err.code ?? err.message}). ` +
      `Mount a writable volume at ${dirname(file)}, or point DB_PATH somewhere writable.`,
  )
}

export const db = database
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 5000')

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_state (
    key        TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_session (
    sub        TEXT PRIMARY KEY,
    session    TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- One row per (voter, subject), mirroring one record per subject in the voter's repo.
  CREATE TABLE IF NOT EXISTS vote (
    voter_did   TEXT NOT NULL,
    subject_did TEXT NOT NULL,
    rkey        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    indexed_at  TEXT NOT NULL,
    PRIMARY KEY (voter_did, subject_did)
  );
  CREATE INDEX IF NOT EXISTS vote_subject_idx ON vote (subject_did);

  -- Cache of app.bsky.actor profiles so the leaderboard renders without hammering the AppView.
  CREATE TABLE IF NOT EXISTS actor (
    did          TEXT PRIMARY KEY,
    handle       TEXT,
    display_name TEXT,
    avatar       TEXT,
    description  TEXT,
    fetched_at   TEXT NOT NULL
  );

  -- Mirror of com.shitsky38.profile records: a nominee's own opt-out / pinned post.
  CREATE TABLE IF NOT EXISTS nominee_profile (
    did         TEXT PRIMARY KEY,
    opted_out   INTEGER NOT NULL DEFAULT 0,
    pinned_post TEXT,
    updated_at  TEXT NOT NULL
  );

  -- The generated text lives in content/writeups.json; anything edited by hand lives here and
  -- wins, so regenerating the draft never overwrites the owner's wording.
  CREATE TABLE IF NOT EXISTS writeup (
    did        TEXT PRIMARY KEY,
    note       TEXT,
    line       TEXT,
    hidden     INTEGER NOT NULL DEFAULT 0,
    base_hash  TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );

  -- Posts by the accounts in a feed, filled from the firehose and topped up by a backfill.
  -- Replies are stored but not served, so the policy can change without refetching a year of
  -- posts. is_reply means the record has a reply field; a quote post is not a reply.
  CREATE TABLE IF NOT EXISTS feed_post (
    uri        TEXT PRIMARY KEY,
    did        TEXT NOT NULL,
    cid        TEXT,
    is_reply   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feed_post_did_idx ON feed_post (did);
  CREATE INDEX IF NOT EXISTS feed_post_time_idx ON feed_post (created_at DESC, uri DESC);

  -- Who is currently in each feed. Recomputed from the tally on a timer, so a feed follows the
  -- vote without anything being republished to the network.
  CREATE TABLE IF NOT EXISTS feed_member (
    feed     TEXT NOT NULL,
    did      TEXT NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (feed, did)
  );
`)

// Added after the first release: follower counts decide who belongs in the Deep Cuts feed.
const actorColumns = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all('actor').map((r) => r.name))
if (!actorColumns.has('followers')) db.exec('ALTER TABLE actor ADD COLUMN followers INTEGER')

// Only the first MAX_VOTES records on a ballot count, ordered by the record's own createdAt,
// and only records created before voting closed. That way the tally is honest even for votes
// written straight to a repo without going through this app.
const ELIGIBLE = `
  WITH eligible AS (
    SELECT ranked.voter_did, ranked.subject_did, ranked.created_at
    FROM (
      SELECT voter_did, subject_did, created_at,
             ROW_NUMBER() OVER (
               PARTITION BY voter_did ORDER BY created_at ASC, subject_did ASC
             ) AS n
      FROM vote
      WHERE created_at <= :closes
    ) AS ranked
    LEFT JOIN nominee_profile p ON p.did = ranked.subject_did
    WHERE ranked.n <= :max_votes AND COALESCE(p.opted_out, 0) = 0
  ),
  tally AS (
    -- reached_at is when this account's most recent counted vote arrived: the moment it reached
    -- the total it now has. That, not the date of its first vote ever, is what orders a tie.
    SELECT subject_did AS did,
           COUNT(*) AS votes,
           MIN(created_at) AS first_vote,
           MAX(created_at) AS reached_at
    FROM eligible
    GROUP BY subject_did
  )
`

const bounds = () => ({
  closes: config.votingClosesAt.toISOString(),
  max_votes: config.maxVotes,
})

const stmt = (sql) => {
  let prepared
  return () => (prepared ??= db.prepare(sql))
}

/* ---------------------------------------------------------------- oauth ---- */

const setState = stmt('INSERT OR REPLACE INTO oauth_state (key, state, created_at) VALUES (?, ?, ?)')
const getState = stmt('SELECT state FROM oauth_state WHERE key = ?')
const delState = stmt('DELETE FROM oauth_state WHERE key = ?')
const sweepState = stmt("DELETE FROM oauth_state WHERE created_at < ?")

export const stateStore = {
  async set(key, value) {
    setState().run(key, JSON.stringify(value), new Date().toISOString())
  },
  async get(key) {
    const row = getState().get(key)
    return row ? JSON.parse(row.state) : undefined
  },
  async del(key) {
    delState().run(key)
  },
}

export const sweepOauthState = () => {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  sweepState().run(cutoff)
}

const setSession = stmt('INSERT OR REPLACE INTO oauth_session (sub, session, updated_at) VALUES (?, ?, ?)')
const getSession = stmt('SELECT session FROM oauth_session WHERE sub = ?')
const delSession = stmt('DELETE FROM oauth_session WHERE sub = ?')

export const sessionStore = {
  async set(sub, value) {
    setSession().run(sub, JSON.stringify(value), new Date().toISOString())
  },
  async get(sub) {
    const row = getSession().get(sub)
    return row ? JSON.parse(row.session) : undefined
  },
  async del(sub) {
    delSession().run(sub)
  },
}

/* ---------------------------------------------------------------- votes ---- */

const upsertVoteStmt = stmt(`
  INSERT INTO vote (voter_did, subject_did, rkey, created_at, indexed_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (voter_did, subject_did) DO UPDATE SET
    rkey = excluded.rkey,
    created_at = excluded.created_at,
    indexed_at = excluded.indexed_at
`)
const deleteVoteStmt = stmt('DELETE FROM vote WHERE voter_did = ? AND subject_did = ?')
const deleteByRkeyStmt = stmt('DELETE FROM vote WHERE voter_did = ? AND rkey = ?')
const ballotStmt = stmt('SELECT subject_did, rkey, created_at FROM vote WHERE voter_did = ? ORDER BY created_at ASC')
const hasVoteStmt = stmt('SELECT 1 AS ok FROM vote WHERE voter_did = ? AND subject_did = ?')

export const upsertVote = ({ voterDid, subjectDid, rkey, createdAt }) => {
  upsertVoteStmt().run(voterDid, subjectDid, rkey, createdAt, new Date().toISOString())
}

export const deleteVote = (voterDid, subjectDid) => deleteVoteStmt().run(voterDid, subjectDid).changes

export const deleteVoteByRkey = (voterDid, rkey) => deleteByRkeyStmt().run(voterDid, rkey).changes

export const getBallot = (voterDid) => ballotStmt().all(voterDid)

export const hasVote = (voterDid, subjectDid) => Boolean(hasVoteStmt().get(voterDid, subjectDid))

export const replaceBallot = (voterDid, votes) => {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM vote WHERE voter_did = ?').run(voterDid)
    for (const vote of votes) {
      upsertVoteStmt().run(voterDid, vote.subjectDid, vote.rkey, vote.createdAt, new Date().toISOString())
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/* ---------------------------------------------------------- leaderboard ---- */

// Standard competition ranking: equal totals share a rank, and the next lower total skips
// ahead by however many were tied — 1, 2, 2, 4. Rows are still ordered within a tie by who
// reached that total first, which is presentation only and never changes the number shown.
const RANKED = `
  ranked AS (
    SELECT did, votes, first_vote, reached_at, RANK() OVER (ORDER BY votes DESC) AS rank
    FROM tally
  )
`

const leaderboardStmt = stmt(`
  ${ELIGIBLE},
  ${RANKED}
  SELECT * FROM ranked
  ORDER BY votes DESC, reached_at ASC, did ASC
  LIMIT :limit OFFSET :offset
`)

// The list is everyone ranked inside the cut. A tie at the boundary makes it longer than
// LIST_SIZE rather than dropping somebody who polled exactly as well as the account above them.
const topListStmt = stmt(`
  ${ELIGIBLE},
  ${RANKED}
  SELECT * FROM ranked
  WHERE rank <= :list_size
  ORDER BY votes DESC, reached_at ASC, did ASC
`)

const standingStmt = stmt(`
  ${ELIGIBLE},
  ${RANKED}
  SELECT * FROM ranked WHERE did = :did
`)

const totalsStmt = stmt(`
  ${ELIGIBLE}
  SELECT (SELECT COUNT(*) FROM eligible)                       AS votes,
         (SELECT COUNT(DISTINCT voter_did) FROM eligible)      AS voters,
         (SELECT COUNT(*) FROM tally)                          AS nominees
`)

export const leaderboard = ({ limit = config.listSize, offset = 0 } = {}) =>
  leaderboardStmt().all({ ...bounds(), limit, offset })

/** Everyone ranked within the cut — longer than LIST_SIZE when the boundary is tied. */
export const topList = () => topListStmt().all({ ...bounds(), list_size: config.listSize })

export const standing = (did) => standingStmt().get({ ...bounds(), did }) ?? null

export const totals = () => totalsStmt().get(bounds()) ?? { votes: 0, voters: 0, nominees: 0 }

/* --------------------------------------------------------------- actors ---- */

const upsertActorStmt = stmt(`
  INSERT INTO actor (did, handle, display_name, avatar, description, followers, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (did) DO UPDATE SET
    handle = excluded.handle,
    display_name = excluded.display_name,
    avatar = excluded.avatar,
    description = excluded.description,
    -- A profile fetch that came back without a count must not erase the one we have.
    followers = COALESCE(excluded.followers, actor.followers),
    fetched_at = excluded.fetched_at
`)

export const upsertActor = (actor) => {
  upsertActorStmt().run(
    actor.did,
    actor.handle ?? null,
    actor.displayName ?? null,
    actor.avatar ?? null,
    actor.description ?? null,
    Number.isFinite(actor.followers) ? actor.followers : null,
    new Date().toISOString(),
  )
}

export const getActors = (dids) => {
  if (dids.length === 0) return new Map()
  const holes = dids.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT * FROM actor WHERE did IN (${holes})`).all(...dids)
  return new Map(
    rows.map((row) => [
      row.did,
      {
        did: row.did,
        handle: row.handle,
        displayName: row.display_name,
        avatar: row.avatar,
        description: row.description,
        followers: row.followers,
        fetchedAt: row.fetched_at,
      },
    ]),
  )
}

/* ------------------------------------------------------ nominee profile ---- */

const upsertProfileStmt = stmt(`
  INSERT INTO nominee_profile (did, opted_out, pinned_post, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (did) DO UPDATE SET
    opted_out = excluded.opted_out,
    pinned_post = excluded.pinned_post,
    updated_at = excluded.updated_at
`)
const getProfileStmt = stmt('SELECT * FROM nominee_profile WHERE did = ?')
const delProfileStmt = stmt('DELETE FROM nominee_profile WHERE did = ?')

export const upsertNomineeProfile = (did, { optOut = false, pinnedPost = null } = {}) => {
  upsertProfileStmt().run(did, optOut ? 1 : 0, pinnedPost, new Date().toISOString())
}

export const getNomineeProfile = (did) => {
  const row = getProfileStmt().get(did)
  return row ? { did: row.did, optOut: Boolean(row.opted_out), pinnedPost: row.pinned_post } : null
}

export const deleteNomineeProfile = (did) => delProfileStmt().run(did).changes

/** Of these accounts, which have withdrawn. Used to flag dead votes on a ballot. */
/* ---------------------------------------------------------------- audit ---- */

// Every vote row in either direction, each marked with whether it counts toward the board:
// inside the voter's first MAX_VOTES, before the deadline, and not aimed at somebody who withdrew.
const AUDIT = `
  WITH ordered AS (
    SELECT v.voter_did, v.subject_did, v.created_at,
           ROW_NUMBER() OVER (
             PARTITION BY v.voter_did ORDER BY v.created_at ASC, v.subject_did ASC
           ) AS n,
           COALESCE(p.opted_out, 0) AS subject_out
    FROM vote v
    LEFT JOIN nominee_profile p ON p.did = v.subject_did
  ),
  marked AS (
    SELECT voter_did, subject_did, created_at,
           CASE WHEN n <= :max_votes AND created_at <= :closes AND subject_out = 0
                THEN 1 ELSE 0 END AS counted
    FROM ordered
  )
`

const votersForStmt = stmt(`
  ${AUDIT}
  SELECT voter_did AS did, created_at, counted FROM marked
  WHERE subject_did = :did
  ORDER BY created_at ASC
`)

const ballotOfStmt = stmt(`
  ${AUDIT}
  SELECT subject_did AS did, created_at, counted FROM marked
  WHERE voter_did = :did
  ORDER BY created_at ASC
`)

/** Who voted for this account. */
export const votersFor = (did) => votersForStmt().all({ ...bounds(), did })

/** Who this account voted for. */
export const ballotOf = (did) => ballotOfStmt().all({ ...bounds(), did })

export const optedOutAmong = (dids) => {
  if (dids.length === 0) return new Set()
  const holes = dids.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT did FROM nominee_profile WHERE opted_out = 1 AND did IN (${holes})`)
    .all(...dids)
  return new Set(rows.map((row) => row.did))
}

/* --------------------------------------------------------------- writeups ---- */

const upsertWriteupStmt = stmt(`
  INSERT INTO writeup (did, note, line, hidden, base_hash, updated_at)
  VALUES (:did, :note, :line, :hidden, :base_hash, :updated_at)
  ON CONFLICT (did) DO UPDATE SET
    note = excluded.note,
    line = excluded.line,
    hidden = excluded.hidden,
    base_hash = excluded.base_hash,
    updated_at = excluded.updated_at
`)
const allWriteupsStmt = stmt('SELECT * FROM writeup')

export const upsertWriteup = ({ did, note, line, hidden = false, baseHash = null }) => {
  upsertWriteupStmt().run({
    did,
    note: note ?? null,
    line: line ?? null,
    hidden: hidden ? 1 : 0,
    base_hash: baseHash,
    updated_at: new Date().toISOString(),
  })
}

export const allWriteups = () =>
  new Map(
    allWriteupsStmt()
      .all()
      .map((row) => [
        row.did,
        {
          did: row.did,
          note: row.note,
          line: row.line,
          hidden: Boolean(row.hidden),
          baseHash: row.base_hash,
          updatedAt: row.updated_at,
        },
      ]),
  )

/* ------------------------------------------------------------------- kv ---- */

const setKvStmt = stmt('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)')
const getKvStmt = stmt('SELECT v FROM kv WHERE k = ?')

/** Drop kv rows by prefix — used to retire a superseded backfill marker. */
export const clearKvPrefix = (prefix) =>
  db.prepare('DELETE FROM kv WHERE k LIKE ?').run(`${prefix}%`).changes

export const setKv = (key, value) => setKvStmt().run(key, String(value))
export const getKv = (key) => getKvStmt().get(key)?.v ?? null

/* ---------------------------------------------------------------- feeds ---- */

const upsertFeedPostStmt = stmt(`
  INSERT INTO feed_post (uri, did, cid, is_reply, created_at, indexed_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (uri) DO UPDATE SET
    cid = excluded.cid,
    is_reply = excluded.is_reply,
    created_at = excluded.created_at
`)
const deleteFeedPostStmt = stmt('DELETE FROM feed_post WHERE uri = ?')

export const upsertFeedPost = ({ uri, did, cid = null, isReply = false, createdAt }) => {
  upsertFeedPostStmt().run(uri, did, cid, isReply ? 1 : 0, createdAt, new Date().toISOString())
}

export const deleteFeedPost = (uri) => deleteFeedPostStmt().run(uri).changes

/** Replace a feed's roster in one transaction, so a reader never sees it half-built. */
export const setFeedMembers = (feed, dids) => {
  const now = new Date().toISOString()
  const insert = db.prepare(
    'INSERT INTO feed_member (feed, did, added_at) VALUES (?, ?, ?) ON CONFLICT (feed, did) DO NOTHING',
  )
  db.exec('BEGIN')
  try {
    if (dids.length === 0) {
      db.prepare('DELETE FROM feed_member WHERE feed = ?').run(feed)
    } else {
      const holes = dids.map(() => '?').join(', ')
      db.prepare(`DELETE FROM feed_member WHERE feed = ? AND did NOT IN (${holes})`).run(feed, ...dids)
      for (const did of dids) insert.run(feed, did, now)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export const feedMembers = (feed) =>
  db.prepare('SELECT did FROM feed_member WHERE feed = ? ORDER BY did').all(feed).map((r) => r.did)

/** Every account we need posts for, across all feeds — the firehose subscription list. */
export const allFeedMemberDids = () =>
  db.prepare('SELECT DISTINCT did FROM feed_member ORDER BY did').all().map((r) => r.did)

// A post's createdAt is whatever its author's client wrote, so it can be in the future. Ignoring
// those keeps somebody from parking themselves at the top of the feed forever.
const skeletonStmt = stmt(`
  SELECT p.uri, p.created_at
  FROM feed_post p
  JOIN feed_member m ON m.did = p.did AND m.feed = :feed
  LEFT JOIN nominee_profile np ON np.did = p.did
  WHERE COALESCE(np.opted_out, 0) = 0
    AND p.is_reply = 0
    AND p.created_at <= :now
    AND (
      :cursor_time IS NULL
      OR p.created_at < :cursor_time
      OR (p.created_at = :cursor_time AND p.uri < :cursor_uri)
    )
  ORDER BY p.created_at DESC, p.uri DESC
  LIMIT :limit
`)

export const feedSkeleton = (feed, { limit = 50, cursorTime = null, cursorUri = null } = {}) =>
  skeletonStmt().all({
    feed,
    now: new Date().toISOString(),
    limit,
    cursor_time: cursorTime,
    cursor_uri: cursorUri,
  })

// Counts what the feed would actually serve, so the admin page cannot report posts that no
// reader can reach: same filters as the skeleton.
export const feedPostCount = (feed) =>
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM feed_post p
       JOIN feed_member m ON m.did = p.did AND m.feed = ?
       LEFT JOIN nominee_profile np ON np.did = p.did
       WHERE p.is_reply = 0 AND COALESCE(np.opted_out, 0) = 0 AND p.created_at <= ?`,
    )
    .get(feed, new Date().toISOString()).c

/** Drop posts nobody can reach any more: not in a feed, or older than the window we serve. */
export const pruneFeedPosts = (keepDays = 45) => {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString()
  const byAge = db.prepare('DELETE FROM feed_post WHERE created_at < ?').run(cutoff).changes
  const byMember = db
    .prepare('DELETE FROM feed_post WHERE did NOT IN (SELECT did FROM feed_member)')
    .run().changes
  return byAge + byMember
}

/**
 * The Deep Cuts pool: nominated, outside the cut, lightly followed, and with more than one vote
 * behind them — a single vote can be the account's own. Follower counts come from the profile
 * cache, so an account we have never hydrated is left out rather than guessed at.
 */
const deepCutsStmt = stmt(`
  ${ELIGIBLE},
  ${RANKED}
  SELECT r.did, r.votes, a.followers
  FROM ranked r
  JOIN actor a ON a.did = r.did
  WHERE r.rank > :list_size
    AND r.votes >= :min_votes
    AND a.followers IS NOT NULL
    AND a.followers < :max_followers
  ORDER BY r.votes DESC, r.reached_at ASC, r.did ASC
`)

export const deepCutsPool = ({ minVotes, maxFollowers }) =>
  deepCutsStmt().all({
    ...bounds(),
    list_size: config.listSize,
    min_votes: minVotes,
    max_followers: maxFollowers,
  })

/**
 * Nominees we have no follower count for. After the column was added every cached profile had
 * one, and the profile cache's own freshness window would have kept them that way for hours —
 * leaving Deep Cuts correctly, but uselessly, empty. These get refetched regardless of the TTL.
 */
export const nomineesMissingFollowers = (limit = 100) =>
  db
    .prepare(
      `${ELIGIBLE}
       SELECT t.did FROM tally t
       LEFT JOIN actor a ON a.did = t.did
       WHERE a.followers IS NULL
       ORDER BY t.votes DESC
       LIMIT :limit`,
    )
    .all({ ...bounds(), limit })
    .map((r) => r.did)

/** Everyone with at least one counted vote — the accounts worth keeping follower counts for. */
export const nomineeDids = () =>
  db
    .prepare(`${ELIGIBLE} SELECT did FROM tally ORDER BY votes DESC`)
    .all(bounds())
    .map((r) => r.did)
