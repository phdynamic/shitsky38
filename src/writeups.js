import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { allWriteups, getKv, setKv } from './db.js'

const PUBLISHED_KEY = 'writeups_published'
const hash = (text) => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12)

const readDraft = () => {
  try {
    return JSON.parse(readFileSync('content/writeups.json', 'utf8'))
  } catch {
    return null
  }
}

/**
 * The generated draft, with any hand edits laid over the top. An edit wins until the draft it was
 * based on changes, at which point the entry is flagged as needing another look rather than
 * silently reverting or silently hiding new text.
 */
export const loadWriteups = () => {
  const draft = readDraft()
  if (!draft) return null
  const edits = allWriteups()

  const entries = draft.entries.map((entry) => {
    const edit = edits.get(entry.did)
    const baseHash = hash(entry.note)
    return {
      ...entry,
      generated: { note: entry.note, line: entry.line },
      note: edit?.note ?? entry.note,
      line: edit?.line ?? entry.line,
      hidden: edit?.hidden ?? false,
      edited: Boolean(edit?.note || edit?.line),
      editedAt: edit?.updatedAt ?? null,
      // true when the draft moved on after this entry was edited by hand
      draftChanged: Boolean(edit && edit.baseHash && edit.baseHash !== baseHash),
      baseHash,
    }
  })

  return { ...draft, entries }
}

export const isPublished = () => getKv(PUBLISHED_KEY) === '1'
export const setPublished = (on) => setKv(PUBLISHED_KEY, on ? '1' : '0')

/** did -> note, for the entries that should be shown publicly. */
export const publishedNotes = () => {
  if (!isPublished()) return new Map()
  const doc = loadWriteups()
  if (!doc) return new Map()
  return new Map(doc.entries.filter((e) => !e.hidden && e.note).map((e) => [e.did, e.note]))
}
