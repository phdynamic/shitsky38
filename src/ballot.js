import { Agent } from '@atproto/api'
import { oauthClient } from './oauth.js'
import { PROFILE_NSID, VOTE_NSID, config, votingState } from './config.js'
import * as store from './db.js'
import { listRecords, rkeyOf } from './bluesky.js'

export class AppError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const agentFor = async (did) => new Agent(await oauthClient.restore(did))

const assertOpen = () => {
  const state = votingState()
  if (state === 'before') throw new AppError(403, 'voting_not_open', 'Voting has not opened yet.')
  if (state === 'closed') throw new AppError(403, 'voting_closed', 'Voting is closed. The list is the list.')
}

const isDid = (value) => typeof value === 'string' && value.startsWith('did:') && value.length < 256

/* ----------------------------------------------------------------- votes ---- */

export const castVote = async (voterDid, subjectDid, note) => {
  assertOpen()
  if (!isDid(subjectDid)) throw new AppError(400, 'bad_subject', 'That is not a valid account.')

  const ballot = store.getBallot(voterDid)
  const already = ballot.some((row) => row.subject_did === subjectDid)
  if (!already && ballot.length >= config.maxVotes) {
    throw new AppError(409, 'out_of_votes', `You have used all ${config.maxVotes} of your votes. Take one back first.`)
  }

  const createdAt = new Date().toISOString()
  const record = {
    $type: VOTE_NSID,
    subject: subjectDid,
    createdAt,
    ...(note ? { note: String(note).slice(0, 1400) } : {}),
  }

  const agent = await agentFor(voterDid)
  // The record key is the subject's DID, so a ballot can never hold two votes for one account.
  await agent.com.atproto.repo.putRecord({
    repo: voterDid,
    collection: VOTE_NSID,
    rkey: subjectDid,
    record,
    validate: false,
  })

  store.upsertVote({ voterDid, subjectDid, rkey: subjectDid, createdAt })
  return { subjectDid, createdAt, votesUsed: store.getBallot(voterDid).length }
}

export const removeVote = async (voterDid, subjectDid) => {
  assertOpen()
  const agent = await agentFor(voterDid)
  try {
    await agent.com.atproto.repo.deleteRecord({
      repo: voterDid,
      collection: VOTE_NSID,
      rkey: subjectDid,
    })
  } catch (err) {
    // Already gone from the repo is a success as far as the ballot is concerned.
    if (err?.status !== 400 && !/not ?found/i.test(err?.message ?? '')) throw err
  }
  store.deleteVote(voterDid, subjectDid)
  return { subjectDid, votesUsed: store.getBallot(voterDid).length }
}

export const toggleVote = async (voterDid, subjectDid, note) =>
  store.hasVote(voterDid, subjectDid)
    ? { ...(await removeVote(voterDid, subjectDid)), voted: false }
    : { ...(await castVote(voterDid, subjectDid, note)), voted: true }

/** The repo is the source of truth — pull a voter's ballot back out of it. */
export const syncBallotFromRepo = async (did) => {
  const records = await listRecords(did, VOTE_NSID)
  const votes = records
    .map((rec) => ({
      subjectDid: isDid(rec.value?.subject) ? rec.value.subject : rkeyOf(rec.uri),
      rkey: rkeyOf(rec.uri),
      createdAt: rec.value?.createdAt ?? new Date().toISOString(),
    }))
    .filter((vote) => isDid(vote.subjectDid))
  store.replaceBallot(did, votes)
  return votes.length
}

/* --------------------------------------------------------------- profile ---- */

const readProfileRecord = async (agent, did) => {
  try {
    const res = await agent.com.atproto.repo.getRecord({ repo: did, collection: PROFILE_NSID, rkey: 'self' })
    return res.data.value ?? {}
  } catch {
    return {}
  }
}

const writeProfileRecord = async (did, patch) => {
  const agent = await agentFor(did)
  const current = await readProfileRecord(agent, did)
  const record = {
    $type: PROFILE_NSID,
    createdAt: current.createdAt ?? new Date().toISOString(),
    ...(current.pinnedPost ? { pinnedPost: current.pinnedPost } : {}),
    ...(current.optOut ? { optOut: true } : {}),
    ...patch,
  }
  if (record.optOut === false) delete record.optOut
  if (record.pinnedPost === null) delete record.pinnedPost

  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: PROFILE_NSID,
    rkey: 'self',
    record,
    validate: false,
  })
  store.upsertNomineeProfile(did, { optOut: Boolean(record.optOut), pinnedPost: record.pinnedPost ?? null })
  return record
}

export const setOptOut = (did, optOut) => writeProfileRecord(did, { optOut: Boolean(optOut) })

export const setPinnedPost = (did, atUri) =>
  writeProfileRecord(did, { pinnedPost: atUri ? String(atUri) : null })

export const syncProfileFromRepo = async (did) => {
  try {
    const records = await listRecords(did, PROFILE_NSID)
    const self = records.find((rec) => rkeyOf(rec.uri) === 'self')
    if (!self) {
      store.deleteNomineeProfile(did)
      return null
    }
    const profile = {
      optOut: Boolean(self.value?.optOut),
      pinnedPost: self.value?.pinnedPost ?? null,
    }
    store.upsertNomineeProfile(did, profile)
    return profile
  } catch {
    return null
  }
}
