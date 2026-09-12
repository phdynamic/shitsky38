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

  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`)

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
    SELECT subject_did AS did, COUNT(*) AS votes, MIN(created_at) AS first_vote
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
    SELECT did, votes, first_vote, RANK() OVER (ORDER BY votes DESC) AS rank
    FROM tally
  )
`

const leaderboardStmt = stmt(`
  ${ELIGIBLE},
  ${RANKED}
  SELECT * FROM ranked
  ORDER BY votes DESC, first_vote ASC
  LIMIT :limit OFFSET :offset
`)

// The list is everyone ranked inside the cut. A tie at the boundary makes it longer than
// LIST_SIZE rather than dropping somebody who polled exactly as well as the account above them.
const topListStmt = stmt(`
  ${ELIGIBLE},
  ${RANKED}
  SELECT * FROM ranked
  WHERE rank <= :list_size
  ORDER BY votes DESC, first_vote ASC
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
  INSERT INTO actor (did, handle, display_name, avatar, description, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (did) DO UPDATE SET
    handle = excluded.handle,
    display_name = excluded.display_name,
    avatar = excluded.avatar,
    description = excluded.description,
    fetched_at = excluded.fetched_at
`)

export const upsertActor = (actor) => {
  upsertActorStmt().run(
    actor.did,
    actor.handle ?? null,
    actor.displayName ?? null,
    actor.avatar ?? null,
    actor.description ?? null,
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

/* ------------------------------------------------------------------- kv ---- */

const setKvStmt = stmt('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)')
const getKvStmt = stmt('SELECT v FROM kv WHERE k = ?')

export const setKv = (key, value) => setKvStmt().run(key, String(value))
export const getKv = (key) => getKvStmt().get(key)?.v ?? null
