/**
 * The ownership journal: an append-only JSONL file that records why a
 * Session is temporary, independent of the mutable registry index.
 *
 * A root is `reserved` before the Host creates its transcript and promoted to
 * `owned` only after the stored header matches. Every descendant is `owned` at
 * its announcement, a discard or expiry marks the whole tree `pending`, and a
 * `deleted` event precedes every folder removal. The first run of this code
 * writes one `migration` event (with the pre-existing stored-session snapshot)
 * and a `migrationComplete` event, and only then the `journal.meta.json`
 * marker.
 *
 * Every line is validated before replay. A complete line that is not a known,
 * well-formed event, or an event out of per-id order, degrades the journal, and
 * a degraded journal authorises nothing.
 *
 * @module dsh-temp-session-plugin/journal
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RECORD_KINDS } from './records.js'

/** Marker schema version for the first-migration record. */
export const JOURNAL_MARKER_VERSION = 1

const EVENT_TYPES = new Set(['reserved', 'reservationDropped', 'owned', 'pending', 'deleted', 'migration', 'migrationComplete'])
const PENDING_REASONS = new Set(['discard', 'expiry'])
const KINDS = new Set(RECORD_KINDS)

/** A Session id or a parent id; never empty and never unbounded. */
function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A non-negative safe-integer clock reading. */
function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/** A string field that may legitimately be absent. */
function isOptionalText(value) {
  return value === null || value === undefined || typeof value === 'string'
}

/** A direct parent: a Session id or nothing. */
function parentOf(value) {
  if (value === undefined || value === null) return null
  return isId(value) ? value : undefined
}

/** A folder this journal may name; safe-path validation happens before deletion. */
function isFolder(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * Validate one parsed journal line and normalize its fields.
 * @param {unknown} value - parsed JSON value.
 * @returns {object | undefined} the normalized event, or undefined when it is
 *   not a known event of the expected shape.
 */
export function validateJournalEvent(value) {
  if (value === null || typeof value !== 'object' || !EVENT_TYPES.has(value.type)) return undefined
  if (!isTimestamp(value.at)) return undefined
  switch (value.type) {
    case 'reserved': {
      if (!isId(value.sessionId) || !isOptionalText(value.workspaceId) || !isOptionalText(value.cwd)) return undefined
      return {
        type: 'reserved',
        sessionId: value.sessionId,
        workspaceId: value.workspaceId ?? null,
        cwd: value.cwd ?? null,
        at: value.at,
      }
    }
    case 'reservationDropped': {
      if (!isId(value.sessionId)) return undefined
      return { type: 'reservationDropped', sessionId: value.sessionId, at: value.at }
    }
    case 'owned':
    case 'deleted': {
      const parentSessionId = parentOf(value.parentSessionId)
      if (parentSessionId === undefined || !isId(value.sessionId) || !KINDS.has(value.kind)) return undefined
      if (!isFolder(value.dir) || !isOptionalText(value.cwd)) return undefined
      return {
        type: value.type,
        sessionId: value.sessionId,
        kind: value.kind,
        parentSessionId,
        dir: value.dir,
        cwd: value.cwd ?? null,
        at: value.at,
      }
    }
    case 'pending': {
      if (!Array.isArray(value.sessionIds) || value.sessionIds.length === 0) return undefined
      if (!value.sessionIds.every(isId) || !PENDING_REASONS.has(value.reason)) return undefined
      return { type: 'pending', sessionIds: [...value.sessionIds], reason: value.reason, at: value.at }
    }
    case 'migration': {
      if (!Array.isArray(value.ids) || !value.ids.every(isId)) return undefined
      if (!Array.isArray(value.preexisting) || !value.preexisting.every(isId)) return undefined
      return { type: 'migration', ids: [...value.ids], preexisting: [...value.preexisting], at: value.at }
    }
    default: {
      return { type: 'migrationComplete', at: value.at }
    }
  }
}

/**
 * Replay journal text into per-id state.
 *
 * A final line without its newline was torn by a crash and is dropped; a
 * complete line that fails validation, or an event that names an id before its
 * `owned` event, degrades the journal. Folding keeps the `owned` identity when
 * a later `pending` or `deleted` event arrives, so a crash after
 * `owned -> pending -> deleted` still replays the validated target.
 * @param {string} text - journal file contents.
 * @returns {{
 *   events: object[], torn: boolean, degraded: boolean,
 *   entries: object, reservations: object,
 *   migration: object | undefined, migrationComplete: number | undefined,
 * }} the validated events and the folded state.
 */
export function replayJournal(text) {
  const lines = typeof text === 'string' ? text.split('\n') : []
  let torn = false
  const tail = lines[lines.length - 1]
  if (tail === '') {
    lines.pop()
  } else if (tail !== undefined) {
    // No trailing newline: the crash tore the final line, so it is not evidence.
    torn = true
    lines.pop()
  }
  const events = []
  let invalid = 0
  for (const line of lines) {
    if (line === '') {
      invalid += 1
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      invalid += 1
      continue
    }
    const event = validateJournalEvent(parsed)
    if (event === undefined) invalid += 1
    else events.push(event)
  }
  const entries = {}
  const reservations = {}
  let migration
  let migrationComplete
  let orderFault = false
  for (const event of events) {
    switch (event.type) {
      case 'reserved': {
        reservations[event.sessionId] = {
          sessionId: event.sessionId,
          workspaceId: event.workspaceId,
          cwd: event.cwd,
          at: event.at,
          dropped: reservations[event.sessionId]?.dropped === true,
        }
        break
      }
      case 'reservationDropped': {
        const reservation = reservations[event.sessionId]
        if (reservation === undefined) orderFault = true
        else reservation.dropped = true
        break
      }
      case 'owned': {
        entries[event.sessionId] = {
          sessionId: event.sessionId,
          kind: event.kind,
          parentSessionId: event.parentSessionId,
          dir: event.dir,
          cwd: event.cwd,
          ownedAt: event.at,
          pending: entries[event.sessionId]?.pending === true,
          pendingReason: entries[event.sessionId]?.pendingReason ?? null,
          deleted: entries[event.sessionId]?.deleted === true,
          deletedAt: entries[event.sessionId]?.deletedAt ?? null,
          deletedDir: entries[event.sessionId]?.deletedDir ?? null,
          deletedCwd: entries[event.sessionId]?.deletedCwd ?? null,
        }
        break
      }
      case 'pending': {
        for (const sessionId of event.sessionIds) {
          const entry = entries[sessionId]
          if (entry === undefined) {
            orderFault = true
            continue
          }
          entry.pending = true
          entry.pendingReason = event.reason
        }
        break
      }
      case 'deleted': {
        const entry = entries[event.sessionId]
        if (entry === undefined) {
          orderFault = true
          break
        }
        entry.deleted = true
        entry.deletedAt = event.at
        entry.deletedDir = event.dir
        entry.deletedCwd = event.cwd
        break
      }
      case 'migration': {
        if (migration !== undefined) orderFault = true
        else migration = { ids: event.ids, preexisting: event.preexisting, at: event.at }
        break
      }
      default: {
        if (migrationComplete !== undefined) orderFault = true
        else migrationComplete = event.at
        break
      }
    }
  }
  return {
    events,
    torn,
    degraded: invalid > 0 || orderFault,
    entries,
    reservations,
    migration,
    migrationComplete,
  }
}

/**
 * Read journal text. A missing file is a clean install, not an error.
 * @param {string} file - journal path.
 * @returns {Promise<{ text: string, exists: boolean } | { error: Error }>} contents or the read failure.
 */
export async function readJournalFile(file) {
  try {
    return { text: await readFile(file, 'utf8'), exists: true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', exists: false }
    return { error }
  }
}

/** Make one directory entry durable after a create or rename. */
function syncDirectory(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
    return true
  } catch {
    // Directory fsync is required for a new journal file; the caller decides
    // whether the operation fails closed.
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A close failure cannot change what the write already did.
      }
    }
  }
}

/**
 * Append one event and make it durable before returning. This synchronous form
 * is the one the process exit and signal handlers can use: no promise can
 * settle after those handlers begin.
 * @param {string} file - journal path.
 * @param {object} event - event to append; validated first.
 * @returns {{ line: string, event: object }} the serialized line.
 * @throws {TypeError} for an invalid event, and the write failure itself.
 */
export function appendJournalEventSync(file, event) {
  const normalized = validateJournalEvent(event)
  if (normalized === undefined) throw new TypeError('refusing to append an invalid ownership-journal event')
  const line = `${JSON.stringify(normalized)}\n`
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const created = !existsSync(file)
  let fd
  try {
    fd = openSync(file, 'a', 0o600)
    writeFileSync(fd, line, 'utf8')
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The fsync above already decided durability.
      }
    }
  }
  if (created && !syncDirectory(dirname(file))) {
    throw new Error('could not fsync the ownership-journal directory')
  }
  return { line, event: normalized }
}

/**
 * Append one event and make it durable before returning.
 * @param {string} file - journal path.
 * @param {object} event - event to append; validated first.
 * @returns {Promise<{ line: string, event: object }>} the serialized line.
 * @throws {TypeError} for an invalid event, and the write failure itself.
 */
export async function appendJournalEvent(file, event) {
  return appendJournalEventSync(file, event)
}

/**
 * Replace the journal with its own valid bytes, atomically and durably.
 *
 * Used to drop a torn final line before the next append: appending after a
 * torn tail would turn those bytes into a complete, invalid line and degrade
 * the journal on the next replay. The replacement is staged beside the journal,
 * fsynced, then renamed over it.
 * @param {string} file - journal path.
 * @param {string} text - the valid journal bytes.
 * @returns {void}
 */
export function rewriteJournal(file, text) {
  const staging = `${file}.${process.pid}.${Date.now()}.tmp`
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = openSync(staging, 'w', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The fsync above already decided durability.
      }
    }
  }
  renameSync(staging, file)
  if (!syncDirectory(dirname(file))) {
    throw new Error('could not fsync the ownership-journal directory after rewrite')
  }
}

/**
 * Read the completed-first-migration marker.
 * @param {string} file - marker path.
 * @returns {{ state: 'missing' | 'valid' | 'damaged', marker?: { version: number, migrationAt: number, completedAt: number } }} status.
 */
export function readJournalMarker(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'damaged' }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null
      && typeof parsed === 'object'
      && parsed.version === JOURNAL_MARKER_VERSION
      && isTimestamp(parsed.migrationAt)
      && isTimestamp(parsed.completedAt)) {
      return { state: 'valid', marker: { version: JOURNAL_MARKER_VERSION, migrationAt: parsed.migrationAt, completedAt: parsed.completedAt } }
    }
  } catch {
    // Falls through to damaged.
  }
  return { state: 'damaged' }
}

/**
 * Write and fsync the first-migration marker.
 *
 * The marker claims the migration is complete, so it is written only after the
 * journal's own `migrationComplete` line is durable; a journal without it is an
 * internal invariant violation and throws instead of writing a false claim.
 * @param {{ journal: string, marker: string }} paths - journal and marker paths.
 * @param {{ migrationAt: number, completedAt: number }} times - the migration's cutoff and completion.
 * @returns {void}
 * @throws {Error} when the journal does not end with its migration completion.
 */
export function writeJournalMarker(paths, { migrationAt, completedAt }) {
  const replay = replayJournal(readFileSync(paths.journal, 'utf8'))
  if (replay.migrationComplete === undefined) {
    throw new Error('refusing to write the migration marker before the journal records migrationComplete')
  }
  const staging = `${paths.marker}.${process.pid}.${Date.now()}.tmp`
  const body = `${JSON.stringify({ version: JOURNAL_MARKER_VERSION, migrationAt, completedAt }, null, 2)}\n`
  let fd
  try {
    fd = openSync(staging, 'w', 0o600)
    writeFileSync(fd, body, 'utf8')
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The fsync above already decided durability.
      }
    }
  }
  renameSync(staging, paths.marker)
  if (!syncDirectory(dirname(paths.marker))) {
    throw new Error('could not fsync the migration-marker directory')
  }
}
