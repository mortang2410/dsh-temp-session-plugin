/**
 * Temporary-session bookkeeping, independent of Cordis.
 *
 * A temporary session is an ordinary DSH Session created by the browser. The
 * Host records its id and the exact per-session storage directory in the
 * registry index, and the ownership journal records why the Session is
 * temporary. The whole directory is removed when the Host exits (or on the next
 * boot, when a hard kill left it behind). This module owns that registry, the
 * ownership journal's use, the validated exit snapshot, and every filesystem
 * deletion so it can be tested without booting a Harness.
 *
 * @module dsh-temp-session-plugin/core
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  appendJournalEvent,
  appendJournalEventSync,
  readJournalFile,
  readJournalMarker,
  replayJournal,
  rewriteJournal,
  writeJournalMarker,
} from './journal.js'
import { Publisher } from './publisher.js'
import { kindOfHeader, readRecord, recordFields, recordView } from './records.js'

/** Registry schema version. A different version is refused, never overwritten. */
export const STATE_VERSION = 1

/**
 * `kind` of a record the plugin created for a subagent child of a recorded
 * temporary Session. Browser-adopted chats carry `main`, `side` or `fork`.
 */
export const SUBAGENT_KIND = 'subagent'

/** Boundary note added to a forked, temporary side conversation. */
const SIDE_INSTRUCTIONS = `This is a temporary side conversation forked from the main conversation.
Treat the inherited history as reference only. Do not continue the main task, its goals, plans, approvals, or tool calls. Answer the new side question independently. Do not use subagents. Change files or workspace state only when the user explicitly asks for that change in this side conversation.`

/**
 * Resolve this plugin's private state location under the Harness home.
 * @param {NodeJS.ProcessEnv} [env] - process environment (DSH_HOME is set by dsh).
 * @param {(path: string) => string} [dshHomePath] - the Host's home-path
 *   service, when mounted; it knows the home the launcher actually used.
 * @returns {{ dir: string, file: string, journal: string, marker: string, lock: string }}
 *   registry directory, registry file, ownership journal, migration marker and writer lock.
 */
export function statePaths(env = process.env, dshHomePath) {
  const dir = typeof dshHomePath === 'function'
    ? dshHomePath('temp-session')
    : join(
      env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh'),
      'temp-session',
    )
  return {
    dir,
    file: join(dir, 'records.json'),
    journal: join(dir, 'ownership.jsonl'),
    marker: join(dir, 'journal.meta.json'),
    lock: join(dir, 'records.lock'),
  }
}

/**
 * Decide whether a recorded path is the per-session storage directory of the
 * named Session. Deletion never trusts a path that is merely stored on disk:
 * the final segment must carry the Session id, the path must be nested, and it
 * must not be the filesystem root. JSONL stores one directory per Session, so
 * this rejects both a shared project directory and `/`.
 * @param {unknown} dir - recorded absolute directory.
 * @param {unknown} sessionId - Session identity the record belongs to.
 * @returns {boolean} whether deletion may target this path.
 */
export function isSafeSessionDir(dir, sessionId) {
  if (typeof dir !== 'string' || typeof sessionId !== 'string') return false
  const id = sessionId.trim()
  if (id === '' || !isAbsolute(dir)) return false
  const absolute = resolve(dir)
  if (absolute === sep) return false
  const segments = absolute.split(sep).filter(Boolean)
  if (segments.length < 3) return false
  const leaf = basename(absolute)
  return leaf === id || leaf.includes(id)
}

/** Serialize one value as pretty JSON with a trailing newline. */
function encodeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`
}

/** Empty registry value. */
function emptyState() {
  return { version: STATE_VERSION, sessions: {} }
}

/**
 * Parse registry text with the rules load() and the write guard share.
 * @param {string} text - registry file contents.
 * @returns {{ version: number, sessions: object } | undefined} the registry, or
 *   undefined when the version or the sessions object does not match.
 * @throws {SyntaxError} when the text is not JSON.
 */
function parseState(text) {
  const parsed = JSON.parse(text)
  if (parsed !== null
    && typeof parsed === 'object'
    && parsed.version === STATE_VERSION
    && parsed.sessions !== null
    && typeof parsed.sessions === 'object') {
    return { version: STATE_VERSION, sessions: { ...parsed.sessions } }
  }
  return undefined
}

/** Whether one recorded Session storage directory exists. */
function recordFolderExists(record) {
  return isSafeSessionDir(record.dir, record.sessionId) && existsSync(record.dir)
}

/**
 * Delete one record's storage directory synchronously, when it is safe and
 * present. Runs from exit handlers, where no asynchronous work can finish.
 * @param {object} record - registry or snapshot record.
 * @param {{ warn?: (message: string) => void }} [logger] - optional logger.
 * @returns {boolean} whether a directory was removed.
 */
function deleteRecordSync(record, logger) {
  if (!recordFolderExists(record)) return false
  try {
    rmSync(record.dir, { recursive: true, force: true })
    return true
  } catch (error) {
    logger?.warn?.(`could not delete temporary session "${String(record.sessionId)}" at exit: ${String(error)}`)
    return false
  }
}

/**
 * Owns the temporary-session registry and its cleanup rules.
 *
 * Mutations are serialized through one promise chain, so two browser calls
 * cannot interleave a read-modify-write of the registry file. Every mutation
 * also updates one immutable validated snapshot, which is the only source the
 * exit handler deletes from.
 */
export class TemporarySessions {
  /**
   * @param {object} deps - Host services and the registry location.
   * @param {object} deps.sessions - live Session store (`ctx.sessions`).
   * @param {object} deps.sessionPersistence - persistence service (`ctx.sessionPersistence`).
   * @param {object} [deps.sessionController] - Host session commands (`ctx.sessionController`).
   * @param {object} [deps.agents] - live Agent registry (`ctx.agents`), optional.
   * @param {object} [deps.workspaceRegistry] - workspace archive set, optional.
   * @param {{ warn: (message: string) => void, info?: (message: string) => void }} deps.logger - Host logger.
   * @param {{ dir: string, file: string, journal: string, marker: string, lock: string }} deps.paths - state location.
   */
  constructor(deps) {
    this.deps = deps
    this.paths = deps.paths
    this.state = emptyState()
    this.loaded = false
    // The registry file exists but could not be read, parsed or versioned; never overwrite it.
    this.registryDegraded = false
    // The ownership journal is unreadable or invalid; delete nothing and write nothing.
    this.journalDegraded = false
    // A signal or process exit has closed admission for new temporary writes.
    this.admissionClosed = false
    this.queue = Promise.resolve()
    // Announced subagents whose queued registry write has not associated them yet.
    this.pending = []
    this.journal = replayJournal('')
    // The valid journal bytes this instance has replayed; appends extend it.
    this.journalSource = ''
    this.marker = undefined
    // Stored headers from the last load, for record/header agreement checks.
    this.storedHeaders = undefined
    // The first migration has not completed; no durable ownership write is safe.
    this.migrationIncomplete = true
    // Migration corrected a legacy field in memory and needs a registry publish.
    this.registryChanged = false
    this.sequence = 0
    this.publisher = new Publisher({ file: this.paths.file, lockFile: this.paths.lock, logger: deps.logger })
    this.snapshot = Object.freeze({ degraded: false, sessions: Object.freeze([]) })
  }

  /** Run one mutation after every mutation already queued. */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Report a condition a human may need to read later. */
  warn(message) {
    this.deps.logger?.warn?.(message)
  }

  /** Close admission for new temporary writes before process cleanup. */
  closeAdmission() {
    this.admissionClosed = true
  }

  /**
   * Read the registry once and reconcile it with the ownership journal.
   *
   * The order is the one the exit snapshot depends on: read the registry and
   * the stored headers, validate and replay the journal, run or resume the
   * first migration, resolve the reservations replay exposes, rebuild every
   * journal-owned record the index lost, then publish the in-memory snapshot.
   */
  async load() {
    if (this.loaded) return this.state
    this.loaded = true
    const now = Date.now()
    const stored = await this.listStored()
    this.storedHeaders = stored
    const registry = await this.readRegistry(stored, now)
    this.state = registry.state
    this.registryDegraded = registry.damaged
    const marker = readJournalMarker(this.paths.marker)
    this.marker = marker.state === 'valid' ? marker.marker : undefined
    const file = await readJournalFile(this.paths.journal)
    this.journal = file.error === undefined ? replayJournal(file.text) : replayJournal('')
    this.journalSource = this.journal.events.map(event => `${JSON.stringify(event)}\n`).join('')
    const faults = this.journalFaults(file, this.journal, marker)
    this.journalDegraded = faults.length > 0
    for (const fault of faults) this.warn(fault)
    // A torn tail is not evidence. Drop it from the file before the next append,
    // which would otherwise make it a complete invalid line.
    if (this.journal.torn && !this.journal.degraded && file.exists === true) {
      try {
        rewriteJournal(this.paths.journal, this.journalSource)
        // The file now holds only the valid events; fold them again so the torn
        // flag does not outlive the repair.
        this.journal = replayJournal(this.journalSource)
      } catch (error) {
        // The on-disk journal still carries bytes a later append would turn into
        // a complete invalid line. Do not let this instance write against it.
        this.journalDegraded = true
        this.warn(`could not drop the torn ownership-journal line; the journal is degraded: ${String(error)}`)
      }
    }
    this.publisher.setDegraded(this.journalDegraded || this.registryDegraded)
    let healed = false
    if (!this.journalDegraded) {
      try {
        await this.migrate(registry, stored)
        this.migrationIncomplete = this.marker === undefined && this.journal.migrationComplete === undefined
        await this.adoptStoredChildren(stored)
        await this.resolveReservations(stored)
        healed = this.healFromJournal(stored)
        if ((healed || this.registryChanged) && !this.registryDegraded) await this.save()
      } catch (error) {
        // A load that failed after replay leaves ownership uncertain; keep every
        // durable write refused until a fresh load completes the migration.
        this.migrationIncomplete = true
        throw error
      }
    }
    this.refreshSnapshot()
    return this.state
  }

  /**
   * Decide whether the replayed journal and its marker are usable evidence. Any
   * fault here means the journal authorises nothing: no write, no deletion.
   * @param {{ exists?: boolean, error?: Error }} file - journal read result.
   * @param {object} replay - replayed journal state.
   * @param {{ state: string }} marker - migration marker status.
   * @returns {string[]} one reason per fault; empty when the journal is healthy.
   */
  journalFaults(file, replay, marker) {
    const faults = []
    if (file.error !== undefined) faults.push(`could not read the ownership journal: ${String(file.error)}`)
    if (replay.torn) this.warn('dropped a torn final ownership-journal line')
    if (replay.degraded) faults.push('the ownership journal holds an invalid event; deleting nothing')
    if (file.exists === false && marker.state === 'valid') faults.push('the migration marker exists without its ownership journal')
    if (marker.state === 'damaged') faults.push('the migration marker is damaged')
    if (marker.state === 'valid' && replay.migration === undefined) faults.push('the migration marker exists without its journal migration events')
    if (marker.state === 'missing' && replay.events.length > 0 && replay.migration === undefined) {
      faults.push('the ownership journal has no migration event')
    }
    return faults
  }

  /** Read the stored-session snapshot once; undefined when the listing fails. */
  async listStored() {
    try {
      const snapshots = await this.deps.sessionPersistence.list()
      const headers = new Map()
      for (const snapshot of snapshots) headers.set(snapshot.header.id, snapshot.header)
      return headers
    } catch (error) {
      this.warn(`could not list stored sessions: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Read one stored Session header directly. The listing silently skips a
   * corrupt header, so this is the only affirmative signal about one id.
   * @param {string} sessionId - Session id.
   * @returns {Promise<object | undefined>} the stored header, or undefined when
   *   the store has no such Session.
   * @throws {Error} when the store cannot answer (corruption, unavailability).
   */
  async storedHeader(sessionId) {
    const stat = this.deps.sessionPersistence?.stat
    if (typeof stat !== 'function') throw new Error('the session store cannot stat a Session')
    const snapshot = await stat.call(this.deps.sessionPersistence, sessionId)
    return snapshot?.header
  }

  /**
   * Read and validate the registry index.
   * @param {Map<string, object> | undefined} stored - stored headers, when available.
   * @param {number} now - current wall clock for records without a clock.
   * @returns {Promise<{ state: object, damaged: boolean, missing: boolean }>} registry state and health.
   */
  async readRegistry(stored, now) {
    let text
    try {
      text = await readFile(this.paths.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warn(`could not read the temporary-session registry: ${String(error)}`)
        return { state: emptyState(), damaged: true, missing: true }
      }
      return { state: emptyState(), damaged: false, missing: true }
    }
    let parsed
    try {
      parsed = parseState(text)
    } catch (error) {
      this.warn(`ignoring unparsable temporary-session registry: ${String(error)}`)
    }
    if (parsed === undefined) {
      if (!this.registryDegraded) this.warn(`ignoring unsupported temporary-session registry at ${this.paths.file}`)
      return { state: emptyState(), damaged: true, missing: false }
    }
    const sessions = {}
    for (const [key, value] of Object.entries(parsed.sessions)) {
      const filled = this.fillFromStored(value, key, stored)
      if (filled === null || typeof filled !== 'object') {
        this.warn(`ignoring unusable temporary-session record "${key}"`)
        continue
      }
      if (filled.sessionId !== undefined && filled.sessionId !== key) {
        this.warn(`quarantining temporary-session record "${key}": it names another Session`)
        continue
      }
      const record = readRecord(filled, key, now)
      if (record === undefined) {
        this.warn(`ignoring unusable temporary-session record "${key}"`)
        continue
      }
      sessions[key] = record
    }
    return { state: { version: STATE_VERSION, sessions }, damaged: false, missing: false }
  }

  /**
   * Fill fields a legacy record predates from its stored header: the storage
   * directory and the direct parent.
   * @param {object} value - stored member value.
   * @param {string} key - member key.
   * @param {Map<string, object> | undefined} stored - stored headers.
   * @returns {unknown} the value to validate.
   */
  fillFromStored(value, key, stored) {
    if (value === null || typeof value !== 'object') return value
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : key
    const header = stored?.get(sessionId)
    if (header === undefined) return value
    const filled = { ...value }
    if (filled.dir === undefined) filled.dir = this.dirOf(header)
    if (filled.parentSessionId === undefined && typeof header.parentSession === 'string') {
      filled.parentSessionId = header.parentSession
    }
    return filled
  }

  /**
   * Run the first migration of a pre-journal registry, or resume an interrupted
   * one, then write the completion marker. A migration that cannot take its
   * pre-existing stored-session snapshot stays incomplete: no cutoff decision is
   * made on partial evidence.
   * @param {{ state: object, damaged: boolean, missing: boolean }} registry - read registry.
   * @param {Map<string, object> | undefined} stored - stored headers, when available.
   * @returns {Promise<void>}
   */
  async migrate(registry, stored) {
    if (this.marker !== undefined) return
    if (this.journal.migrationComplete !== undefined) {
      // A crash before the marker leaves the journal complete: the marker is
      // written from the replayed times, and no new cutoff is assigned.
      const migration = this.journal.migration
      if (migration === undefined) return
      this.writeMarker(migration.at, this.journal.migrationComplete)
      return
    }
    if (this.journal.migration === undefined) {
      if (registry.damaged) {
        this.warn('first ownership migration deferred: the registry cannot list its sources')
        return
      }
      if (stored === undefined) {
        this.warn('first ownership migration deferred: the stored session list is unavailable')
        return
      }
      await this.appendEvent({
        type: 'migration',
        ids: Object.keys(registry.state.sessions),
        preexisting: [...stored.keys()],
        at: Date.now(),
      })
    }
    const migration = this.journal.migration
    if (migration === undefined) return
    if (stored === undefined) {
      this.warn('first ownership migration deferred: the stored session list is unavailable')
      return
    }
    for (const sessionId of migration.ids) {
      await this.importMigrationSource(sessionId, stored, registry)
    }
    await this.appendEvent({ type: 'migrationComplete', at: Date.now() })
    const completedAt = this.journal.migrationComplete
    if (completedAt === undefined) return
    this.writeMarker(this.journal.migration?.at ?? completedAt, completedAt)
  }

  /**
   * Write the first-migration marker after the journal records completion.
   * @param {number} migrationAt - the migration cutoff already in the journal.
   * @param {number} completedAt - the completion time already in the journal.
   * @returns {void}
   */
  writeMarker(migrationAt, completedAt) {
    try {
      writeJournalMarker(this.paths, { migrationAt, completedAt })
      this.marker = { version: 1, migrationAt, completedAt }
    } catch (error) {
      this.warn(`could not write the first-migration marker: ${String(error)}`)
    }
  }

  /**
   * Whether a legacy row names the header's direct parent or one of its stored
   * ancestors. The old recorder collapsed a subagent to its nearest recorded
   * ancestor, so an ancestor link is migrated to the true direct parent.
   * @param {object} record - legacy registry record.
   * @param {object} header - stored Session header.
   * @param {Map<string, object>} stored - stored headers.
   * @returns {boolean} whether the parent is direct or a provable ancestor link.
   */
  legacyParentAgrees(record, header, stored) {
    const direct = header.parentSession ?? null
    if (record.parentSessionId === direct) return true
    if (typeof record.parentSessionId !== 'string') return false
    if (!(stored instanceof Map)) return false
    let cursor = header.parentSession
    const seen = new Set()
    while (typeof cursor === 'string' && !seen.has(cursor)) {
      if (cursor === record.parentSessionId) return true
      seen.add(cursor)
      cursor = stored.get(cursor)?.parentSession
    }
    return false
  }

  /** The journal kind a valid legacy row keeps; a side presentation survives a seeded header. */
  legacyJournalKind(record, header) {
    return record.kind === 'side' && header.isSeeded === true && typeof header.parentSession === 'string'
      ? 'side'
      : kindOfHeader(header)
  }

  /**
   * Whether a legacy registry row agrees with its stored header: the derived
   * kind, a direct or collapsed parent, the cwd and the locator-derived folder.
   * @param {object} record - legacy registry record.
   * @param {object} header - stored Session header.
   * @param {{ dir: string }} storage - locator result.
   * @param {Map<string, object>} stored - stored headers.
   * @returns {boolean} whether every derived field agrees.
   */
  legacyRecordAgrees(record, header, storage, stored) {
    if (record === undefined || record === null || typeof record !== 'object') return false
    const headerKind = kindOfHeader(header)
    const kindAgrees = record.kind === headerKind
      || (record.kind === 'side' && header.isSeeded === true && typeof header.parentSession === 'string')
    return kindAgrees
      && this.legacyParentAgrees(record, header, stored)
      && record.cwd === (header.cwd ?? null)
      && record.dir === storage.dir
  }

  /**
   * Import one migration source id into the journal, idempotently: an id the
   * journal already owns is not written twice, and its pending state is carried
   * over once. A source with no usable stored header, or whose record disagrees
   * with that header, is left unresolved.
   * @param {string} sessionId - source id from the migration event.
   * @param {Map<string, object>} stored - stored headers.
   * @param {{ state: object }} registry - the registry read at this boot.
   * @returns {Promise<void>}
   */
  async importMigrationSource(sessionId, stored, registry) {
    if (this.journal.entries[sessionId] === undefined) {
      const header = stored.get(sessionId)
      const storage = header === undefined ? undefined : this.resolveStorage(header)
      if (header === undefined || storage === undefined) {
        this.warn(`first ownership migration could not import "${sessionId}": no usable stored header`)
        return
      }
      const legacy = registry.state.sessions[sessionId]
      if (!this.legacyRecordAgrees(legacy, header, storage, stored)) {
        this.warn(`first ownership migration quarantined "${sessionId}": its record disagrees with its stored header`)
        return
      }
      const kind = this.legacyJournalKind(legacy, header)
      const parentSessionId = header.parentSession ?? null
      // The old recorder collapsed a subagent to an ancestor; the header's
      // direct parent is authoritative, so persist the corrected link.
      if (legacy.parentSessionId !== parentSessionId) {
        legacy.parentSessionId = parentSessionId
        this.registryChanged = true
      }
      await this.appendEvent({
        type: 'owned',
        sessionId,
        kind,
        parentSessionId,
        dir: storage.dir,
        cwd: header.cwd ?? null,
        at: Date.now(),
      })
    }
    const entry = this.journal.entries[sessionId]
    const wasPending = registry.state.sessions[sessionId]?.pendingDelete === true || entry?.pending === true
    if (wasPending && entry?.pending !== true) {
      await this.appendEvent({ type: 'pending', sessionIds: [sessionId], reason: 'discard', at: Date.now() })
    }
  }

  /**
   * Adopt stored subagent children of a journal-owned parent. This recovers an
   * announcement that was observed while the first migration was incomplete,
   * and it is the boot pass ticket 03 extends to a fixed point.
   * @param {Map<string, object> | undefined} stored - stored headers.
   * @returns {Promise<void>}
   */
  async adoptStoredChildren(stored) {
    if (stored === undefined || this.migrationIncomplete) return
    let changed = true
    while (changed) {
      changed = false
      for (const [sessionId, header] of stored) {
        if (header?.origin !== 'subagent') continue
        const parentId = header.parentSession
        const parent = this.journal.entries[parentId]
        if (parent === undefined) continue
        const storage = this.resolveStorage(header)
        if (storage === undefined || !isSafeSessionDir(storage.dir, sessionId)) continue
        const existing = this.journal.entries[sessionId]
        if (parent.deleted === true) {
          if (await this.deleteOrphanedChild(sessionId, parentId, header, storage, existing)) changed = true
          continue
        }
        if (existing !== undefined) {
          // A crash between the adopted `owned` event and its inherited `pending`
          // event must not leave an ended parent's child running. A later pass
          // revisits this child when its parent becomes pending.
          if (existing.deleted !== true && parent.pending === true && existing.pending !== true) {
            await this.appendEvent({
              type: 'pending',
              sessionIds: [sessionId],
              reason: parent.pendingReason ?? 'discard',
              at: Date.now(),
            })
            changed = true
          }
          continue
        }
        await this.appendEvent({
          type: 'owned',
          sessionId,
          kind: 'subagent',
          parentSessionId: parentId,
          dir: storage.dir,
          cwd: header.cwd ?? null,
          at: Date.now(),
        })
        if (parent.pending === true) {
          await this.appendEvent({
            type: 'pending',
            sessionIds: [sessionId],
            reason: parent.pendingReason ?? 'discard',
            at: Date.now(),
          })
        }
        this.warn(`adopted stored subagent "${sessionId}" under its journal-owned parent`)
        changed = true
      }
    }
  }

  /**
   * Delete a stored subagent whose direct journal parent is already deleted.
   * The child gets its own validated `owned` and `deleted` events before the
   * folder is removed, so a crash at either boundary remains replayable.
   * @param {string} sessionId - the stored child.
   * @param {string} parentId - the journal-deleted direct parent.
   * @param {object} header - the stored child header.
   * @param {{ dir: string }} storage - the validated locator result.
   * @param {object | undefined} existing - the child's journal entry, if any.
   * @returns {Promise<boolean>} whether this pass recorded or removed the child.
   */
  async deleteOrphanedChild(sessionId, parentId, header, storage, existing) {
    if (existing !== undefined) {
      const agrees = existing.kind === 'subagent'
        && existing.parentSessionId === parentId
        && existing.dir === storage.dir
        && existing.cwd === (header.cwd ?? null)
      if (!agrees) {
        this.warn(`not deleting stored subagent "${sessionId}": its journal identity disagrees with its stored header`)
        return false
      }
      if (existing.deleted === true) {
        if (this.deps.sessions.get(sessionId) !== undefined) {
          this.warn(`not deleting stored subagent "${sessionId}": its Session is still live`)
          return false
        }
        if (!existsSync(storage.dir)) return false
        this.removeOrphanDir(storage.dir, sessionId)
        return !existsSync(storage.dir)
      }
      if (this.deps.sessions.get(sessionId) !== undefined) {
        this.warn(`deferring deletion of stored subagent "${sessionId}": its Session is still live`)
        return false
      }
    } else {
      await this.appendEvent({
        type: 'owned',
        sessionId,
        kind: 'subagent',
        parentSessionId: parentId,
        dir: storage.dir,
        cwd: header.cwd ?? null,
        at: Date.now(),
      })
      if (this.deps.sessions.get(sessionId) !== undefined) {
        // The owned identity above is durable, so a later pass can finish the
        // deletion once this Session is no longer live.
        this.warn(`deferring deletion of stored subagent "${sessionId}": its Session is still live`)
        return true
      }
    }
    await this.appendEvent({
      type: 'deleted',
      sessionId,
      kind: 'subagent',
      parentSessionId: parentId,
      dir: storage.dir,
      cwd: header.cwd ?? null,
      at: Date.now(),
    })
    if (this.deps.sessions.get(sessionId) !== undefined) {
      // The Session became live while the `deleted` append was awaiting. Keep
      // the transcript; the already-deleted path retries after it is absent.
      this.warn(`not removing stored subagent "${sessionId}": its Session became live during deletion`)
      return true
    }
    this.removeOrphanDir(storage.dir, sessionId)
    this.warn(`deleted stored subagent "${sessionId}" whose journal parent is deleted`)
    return true
  }

  /**
   * Remove one validated orphan folder, logging a failure instead of throwing.
   * The removal is synchronous so no Session can become live between the caller's
   * final liveness check and the removal of its transcript.
   * @param {string} dir - validated session directory.
   * @param {string} sessionId - child identity.
   * @returns {boolean} whether the directory is now absent.
   */
  removeOrphanDir(dir, sessionId) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return !existsSync(dir)
    } catch (error) {
      this.warn(`could not delete stored subagent "${sessionId}": ${String(error)}`)
      return false
    }
  }

  /**
   * Rebuild every journal-owned record the index no longer holds, and migrate a
   * legacy record's collapsed parent to its stored header's direct parent.
   * @param {Map<string, object> | undefined} stored - stored headers, when available.
   * @returns {boolean} whether the registry changed.
   */
  healFromJournal(stored) {
    let healed = false
    const now = Date.now()
    for (const entry of Object.values(this.journal.entries)) {
      if (entry.deleted === true) continue
      const live = this.deps.sessions.get(entry.sessionId)
      const header = stored?.get(entry.sessionId) ?? live?.header
      const existing = this.state.sessions[entry.sessionId]
      if (existing === undefined) {
        if (header === undefined) continue
        const storage = this.resolveStorage(header)
        if (storage === undefined) continue
        try {
          this.state.sessions[entry.sessionId] = recordFields({
            sessionId: entry.sessionId,
            kind: entry.kind,
            parentSessionId: entry.parentSessionId ?? header.parentSession ?? null,
            dir: storage.dir,
            cwd: header.cwd ?? null,
            createdAt: header.createdAt,
            lastActivityAt: now,
            activitySince: now,
            pendingDelete: entry.pending === true,
          }, now)
          healed = true
          this.warn(`rebuilt the temporary-session record for "${entry.sessionId}" from the ownership journal`)
        } catch (error) {
          this.warn(`could not rebuild the temporary-session record for "${entry.sessionId}": ${String(error)}`)
        }
        continue
      }
      if (header !== undefined) {
        const directParent = header.parentSession ?? null
        const parentNeedsRepair = existing.parentSessionId !== directParent
          && entry.parentSessionId === directParent
          && (existing.parentSessionId === null || this.legacyParentAgrees(existing, header, stored))
        if (parentNeedsRepair) {
          existing.parentSessionId = directParent
          healed = true
        }
      }
      if (entry.pending === true && existing.pendingDelete !== true) {
        existing.pendingDelete = true
        healed = true
      }
    }
    return healed
  }

  /**
   * Resolve every reservation the replayed journal still exposes. A stored
   * header promotes it; only a live miss, a successful listing that omits it and
   * a direct artifact check that finds nothing drop it.
   * @param {Map<string, object> | undefined} stored - stored headers, when available.
   * @returns {Promise<void>}
   */
  async resolveReservations(stored) {
    for (const reservation of Object.values(this.journal.reservations)) {
      if (reservation.dropped === true) continue
      if (this.journal.entries[reservation.sessionId] !== undefined) continue
      await this.resolveReservation(reservation, stored)
    }
  }

  /**
   * Resolve one reservation from the evidence available now.
   * @param {object} reservation - the replayed reservation.
   * @param {Map<string, object> | undefined} stored - stored headers, when available.
   * @returns {Promise<'promoted' | 'retained' | 'dropped'>} the outcome.
   */
  async resolveReservation(reservation, stored) {
    const sessionId = reservation.sessionId
    let header
    try {
      header = await this.storedHeader(sessionId)
    } catch (error) {
      this.warn(`retaining the reservation for "${sessionId}": its stored header could not be read (${String(error)})`)
      return 'retained'
    }
    if (header !== undefined) return this.promoteReservation(reservation, header)
    if (stored === undefined) {
      this.warn(`retaining the reservation for "${sessionId}": no affirmative absence is available`)
      return 'retained'
    }
    if (stored.has(sessionId)) return this.promoteReservation(reservation, stored.get(sessionId))
    if (this.deps.sessions.get(sessionId) !== undefined) {
      this.warn(`retaining the reservation for "${sessionId}": the live store still has it`)
      return 'retained'
    }
    const storage = this.resolveStorage({ id: sessionId, cwd: reservation.cwd ?? undefined })
    if (storage === undefined) {
      this.warn(`retaining the reservation for "${sessionId}": its storage location is unknown`)
      return 'retained'
    }
    if (existsSync(storage.artifact)) {
      this.warn(`retaining the reservation for "${sessionId}": its storage artifact exists`)
      return 'retained'
    }
    await this.appendEvent({ type: 'reservationDropped', sessionId, at: Date.now() })
    this.warn(`dropped the reservation for "${sessionId}": the live store, the stored listing and the artifact all report absence`)
    return 'dropped'
  }

  /**
   * Whether a stored header proves the reservation: the same id, the same cwd
   * and a creation time at or after the reservation.
   * @param {object} reservation - the replayed reservation.
   * @param {object} header - the stored header.
   * @returns {boolean} whether it matches.
   */
  reservationMatches(reservation, header) {
    if (header?.id !== reservation.sessionId) return false
    if ((header.cwd ?? null) !== (reservation.cwd ?? null)) return false
    return Number.isSafeInteger(header.createdAt) && header.createdAt >= reservation.at
  }

  /**
   * Promote one reservation to `owned` once its stored header matches.
   * @param {object} reservation - the replayed reservation.
   * @param {object} header - the matching-ish stored header.
   * @returns {Promise<'promoted' | 'retained'>} the outcome.
   */
  async promoteReservation(reservation, header) {
    const sessionId = reservation.sessionId
    if (header.origin === 'subagent' || header.isSeeded === true) {
      this.warn(`retaining the reservation for "${sessionId}": its stored header is not a new root Session`)
      return 'retained'
    }
    if (!this.reservationMatches(reservation, header)) {
      this.warn(`retaining the reservation for "${sessionId}": its stored header does not match the reservation`)
      return 'retained'
    }
    const storage = this.resolveStorage(header)
    if (storage === undefined) {
      this.warn(`retaining the reservation for "${sessionId}": its storage location is unknown`)
      return 'retained'
    }
    await this.appendEvent({
      type: 'owned',
      sessionId,
      kind: 'main',
      parentSessionId: header.parentSession ?? null,
      dir: storage.dir,
      cwd: header.cwd ?? null,
      at: Date.now(),
    })
    return 'promoted'
  }

  /**
   * Whether the file this publisher is about to replace is still the registry
   * it expects. A damaged, foreign-version or unreadable file is never
   * overwritten: that is the difference between a repairable index and a lost
   * one.
   * @param {string} text - current registry text.
   * @returns {boolean} whether a write may proceed.
   */
  registryAcrossWrite(text) {
    let parsed
    try {
      parsed = parseState(text)
    } catch {
      parsed = undefined
    }
    if (parsed !== undefined) return true
    this.registryDegraded = true
    this.publisher.setDegraded(true)
    this.warn('refusing to overwrite a damaged or unsupported temporary-session registry')
    return false
  }

  /** Async form of {@link registryAcrossWrite}. */
  async registryWritable() {
    let text
    try {
      text = await readFile(this.paths.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warn(`could not verify the temporary-session registry before writing: ${String(error)}`)
        return false
      }
      return true
    }
    return this.registryAcrossWrite(text)
  }

  /** Synchronous form of {@link registryWritable}, for the unload path. */
  registryWritableSync() {
    let text
    try {
      text = readFileSync(this.paths.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warn(`could not verify the temporary-session registry before writing: ${String(error)}`)
        return false
      }
      return true
    }
    return this.registryAcrossWrite(text)
  }

  /**
   * Persist the registry through the shared publisher. The write captures its
   * generation before it awaits anything, so a newer synchronous publish that
   * lands in between wins and this write is discarded.
   * @returns {Promise<boolean>} whether this write became the published registry.
   * @throws the filesystem failure itself.
   */
  async save() {
    if (this.journalDegraded || this.registryDegraded) return false
    const ticket = this.publisher.begin()
    if (ticket === undefined) return false
    const text = encodeState(this.state)
    try {
      await mkdir(this.paths.dir, { recursive: true, mode: 0o700 })
      if (!await this.registryWritable()) {
        this.publisher.discardStaging(ticket)
        return false
      }
      await writeFile(ticket.staging, text, { mode: 0o600 })
    } catch (error) {
      this.publisher.discardStaging(ticket)
      throw error
    }
    const published = this.publisher.commit(ticket)
    if (published) this.registryDegraded = false
    return published
  }

  /**
   * Publish the in-memory registry without awaiting. The unload path calls this
   * before its queued work: a queued write can be blocked behind a save that
   * never finishes, and a record that exists only in memory would otherwise be
   * lost with this instance. It never overwrites a damaged registry file.
   * @returns {boolean} whether this write became the published registry.
   */
  flushRegistrySync() {
    if (!this.loaded || this.registryDegraded || this.journalDegraded) return false
    for (const session of this.pending) this.associateDescendant(session)
    if (!this.registryWritableSync()) return false
    try {
      return this.publisher.publish(encodeState(this.state))
    } catch (error) {
      this.warn(`could not publish temporary-session registry: ${String(error)}`)
      return false
    }
  }

  /**
   * The immutable validated snapshot the exit handler and the unload path read.
   * It is separate from the durable published registry: it can contain a record
   * whose registry save failed, and it is rebuilt as one frozen generation on
   * every trusted mutation.
   * @returns {{ degraded: boolean, sessions: readonly object[] }} the snapshot.
   */
  exitSnapshot() {
    return this.snapshot
  }

  /** The stored or live header for a recorded Session, when one is available. */
  headerFor(record) {
    return this.storedHeaders?.get(record.sessionId) ?? this.deps.sessions.get(record.sessionId)?.header
  }

  /**
   * Whether a record agrees with the stored header: the derived kind, the true
   * direct parent, the cwd and the locator-derived folder.
   * @param {object} record - registry record.
   * @param {object} header - stored or live Session header.
   * @returns {boolean} whether every derived field agrees.
   */
  recordAgreesWithHeader(record, header) {
    const storage = this.resolveStorage(header)
    const headerKind = kindOfHeader(header)
    const kindAgrees = record.kind === headerKind
      || (record.kind === 'side' && header.isSeeded === true && typeof header.parentSession === 'string')
    return kindAgrees
      && record.parentSessionId === (header.parentSession ?? null)
      && record.cwd === (header.cwd ?? null)
      && storage !== undefined
      && record.dir === storage.dir
  }

  /**
   * Rebuild the immutable in-memory snapshot. Only a record the ownership
   * journal owns is deletion evidence; a journal-degraded instance deletes
   * nothing.
   */
  refreshSnapshot() {
    const sessions = []
    if (!this.journalDegraded) {
      for (const record of Object.values(this.state.sessions)) {
        const entry = this.journal.entries[record.sessionId]
        if (entry === undefined || entry.deleted === true) continue
        // The journal owns the identity and the target. A registry row that
        // disagrees with it is quarantined, never deleted.
        const agrees = record.kind === entry.kind
          && record.parentSessionId === entry.parentSessionId
          && record.cwd === entry.cwd
          && record.dir === entry.dir
        if (!agrees) {
          this.warn(`keeping "${record.sessionId}" out of the exit snapshot: its record disagrees with the ownership journal`)
          continue
        }
        const header = this.headerFor(record)
        if (header === undefined) {
          this.warn(`keeping "${record.sessionId}" out of the exit snapshot: no stored header confirms it`)
          continue
        }
        if (!this.recordAgreesWithHeader(record, header)) {
          this.warn(`keeping "${record.sessionId}" out of the exit snapshot: its record disagrees with its stored header`)
          continue
        }
        if (!isSafeSessionDir(record.dir, record.sessionId)) continue
        sessions.push(Object.freeze({ ...record }))
      }
    }
    this.snapshot = Object.freeze({ degraded: this.journalDegraded, sessions: Object.freeze(sessions) })
  }

  /**
   * Append one ownership-journal event and fold it into the replayed state.
   * @param {object} event - journal event.
   * @returns {Promise<object>} the appended event.
   */
  async appendEvent(event) {
    const appended = await appendJournalEvent(this.paths.journal, event)
    this.journalSource += appended.line
    this.journal = replayJournal(this.journalSource)
    if (this.journal.degraded) {
      this.journalDegraded = true
      this.publisher.setDegraded(true)
    }
    this.publisher.mutate()
    this.refreshSnapshot()
    return appended.event
  }

  /** Refuse a mutation that would need a journal or registry write. */
  assertWritable(action) {
    if (this.admissionClosed) {
      throw new Error(`temporary-session admission is closed; refusing to ${action}`)
    }
    if (this.journalDegraded) {
      throw new Error(`the temporary-session ownership journal is degraded; refusing to ${action}`)
    }
    if (this.registryDegraded) {
      throw new Error(`the temporary-session registry is damaged; refusing to ${action}`)
    }
    if (this.migrationIncomplete) {
      throw new Error(`the first ownership migration is incomplete; refusing to ${action}`)
    }
  }

  /**
   * Reserve a new temporary root before the Host creates its transcript. The
   * caller passes the returned id to the Host's `sessions.create`, so the
   * journal holds the reservation before any bytes exist.
   * @param {{ workspaceId?: string, cwd?: string, sessionId?: string }} [request] - create target.
   * @returns {Promise<{ sessionId: string, workspaceId: string | null, cwd: string | null, at: number }>} the reservation.
   */
  reserve(request) {
    return this.enqueue(async () => {
      await this.load()
      this.assertWritable('reserve a temporary root')
      const workspaceId = typeof request?.workspaceId === 'string' && request.workspaceId !== '' ? request.workspaceId : null
      const cwd = typeof request?.cwd === 'string' && request.cwd !== '' ? request.cwd : null
      const sessionId = request?.sessionId ?? `session-${randomUUID()}`
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) {
        throw new Error('a reserved temporary Session needs a Session id')
      }
      if (this.deps.sessions.get(sessionId) !== undefined) {
        throw new Error('a Session with the reserved id is already live; refusing to touch it')
      }
      let existing
      try {
        existing = await this.storedHeader(sessionId)
      } catch (error) {
        throw new Error(`cannot reserve "${sessionId}": its stored Session state is uncertain (${String(error)})`)
      }
      if (existing !== undefined) throw new Error('a stored Session already has the reserved id; refusing to touch it')
      const at = Date.now()
      await this.appendEvent({ type: 'reserved', sessionId, workspaceId, cwd, at })
      return { sessionId, workspaceId, cwd, at }
    })
  }

  /**
   * Resolve the per-session directory the JSONL backend stores this Session in.
   * The backend exposes its refusal-diagnostics locator at runtime; a backend
   * without it keeps the feature unavailable instead of guessing a path.
   * @param {object} header - the live or stored Session header.
   * @returns {string | undefined} absolute per-session directory.
   */
  dirOf(header) {
    return this.resolveStorage(header)?.dir
  }

  /**
   * The directory and the log artifact the Host would use for this Session.
   * The artifact path matters on its own: a backend creates the directory before it links the
   * log, so a directory says nothing about whether a transcript was published.
   * @param {object} header - the live or stored Session header.
   * @returns {{dir: string, artifact: string} | undefined} absolute paths.
   */
  resolveStorage(header) {
    const locate = this.deps.sessionPersistence?.locate
    if (typeof locate !== 'function') return undefined
    try {
      const location = locate.call(this.deps.sessionPersistence, header)
      if (location !== null
        && typeof location === 'object'
        && location.kind === 'jsonl'
        && typeof location.path === 'string') {
        return { dir: dirname(location.path), artifact: location.path }
      }
    } catch (error) {
      this.warn(`could not locate temporary-session storage: ${String(error)}`)
    }
    return undefined
  }

  /**
   * Record a Session as temporary and pin its display title.
   *
   * A main-area temporary session is a fresh, unused Session. A side chat is a
   * fork: it inherits history, so only the child-owned tail after the fork cut
   * must stay unused. Neither an arbitrary existing history nor a subagent can
   * be adopted. The `owned` journal event and its fsync land before the
   * transcript is flushed, and a failed append refuses registration.
   * @param {{ sessionId: string, title?: string, kind?: 'main' | 'side' }} request - Session to adopt.
   * @returns {Promise<{ sessionId: string, createdAt: number, kind: string, pendingDelete: boolean }>} the record view.
   */
  register(request) {
    return this.enqueue(async () => {
      await this.load()
      this.assertWritable('register a temporary session')
      const sessionId = request?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) {
        throw new Error('temporary session registration requires a Session id')
      }
      const existing = this.state.sessions[sessionId]
      if (existing?.kind === SUBAGENT_KIND) throw new Error('a subagent Session cannot become temporary')
      if (existing !== undefined) return recordView(existing)
      const session = this.deps.sessions.get(sessionId)
      if (session === undefined) throw new Error('the Session is not live; open it before registering')
      const header = session.header
      const kind = request.kind === 'side' ? 'side' : 'main'
      this.assertRegistrable(session)
      const title = typeof request.title === 'string' ? request.title : ''
      // Resolve the storage directory before anything is written. The locator computes the path
      // from the header, so a backend that can answer now never needs a flush first, and a
      // backend that can only answer after the log exists would have to persist the very
      // transcript this record exists to gate.
      const storage = this.resolveStorage(header)
      if (storage === undefined) {
        throw new Error('temporary sessions need the JSONL session store (its locator is unavailable)')
      }
      // A root created through the reserved path is promoted only against its
      // stored header: a reservation alone never authorises anything.
      const reservation = this.outstandingReservation(sessionId)
      let resolvedHeader = header
      if (reservation !== undefined) {
        let stored
        try {
          stored = await this.storedHeader(sessionId)
        } catch (error) {
          throw new Error(`cannot promote the reservation for "${sessionId}": its stored header is uncertain (${String(error)})`)
        }
        if (stored === undefined) throw new Error('the reserved Session has no stored header yet')
        if (!this.reservationMatches(reservation, stored)) {
          this.warn(`quarantining the reservation for "${sessionId}": its stored header does not match`)
          throw new Error('the stored Session does not match its reservation')
        }
        resolvedHeader = stored
      }
      const resolvedStorage = this.resolveStorage(resolvedHeader)
      if (resolvedStorage === undefined) {
        throw new Error('temporary sessions need the JSONL session store (its locator is unavailable)')
      }
      const now = Date.now()
      const record = recordFields({
        sessionId,
        kind,
        parentSessionId: resolvedHeader.parentSession ?? null,
        dir: resolvedStorage.dir,
        cwd: resolvedHeader.cwd ?? null,
        createdAt: resolvedHeader.createdAt,
        lastActivityAt: now,
        activitySince: now,
        pendingDelete: false,
        title,
      }, now)
      // The journal owns this Session before its transcript can be indexed.
      await this.appendEvent({
        type: 'owned',
        sessionId,
        kind: record.kind,
        parentSessionId: record.parentSessionId,
        dir: record.dir,
        cwd: record.cwd,
        at: now,
      })
      // Publish the record before the log is materialized: this file is the only signal an
      // outside reader has, and the flush below persists the Session's current content.
      this.state.sessions[sessionId] = record
      this.refreshSnapshot()
      await this.save()
      try {
        await this.deps.sessions.flush(session)
      } catch (error) {
        // The backend links the artifact before it syncs the directory, so a failed flush can
        // still leave the log on disk. Keep the record in that case: the Session was asked to be
        // temporary and its transcript is materialized, and a rollback would expose exactly that
        // transcript to every reader that gates on this file. Roll back only when nothing landed.
        if (!existsSync(resolvedStorage.artifact)) {
          delete this.state.sessions[sessionId]
          this.refreshSnapshot()
          await this.save()
        }
        throw error
      }
      if (kind === 'side') this.prepareSideChat(sessionId)
      const controller = this.deps.sessionController
      if (controller !== undefined && title !== '') {
        try {
          await controller.rename({ sessionId, title })
        } catch (error) {
          this.warn(`could not title temporary session "${sessionId}": ${String(error)}`)
        }
      }
      return recordView(record)
    })
  }

  /**
   * Refuse a Session that may not become temporary: a subagent, a seeded chat
   * without its source, or one that has already been used.
   * @param {object} session - the live Session.
   * @returns {void}
   * @throws {Error} when the Session may not become temporary.
   */
  assertRegistrable(session) {
    const header = session.header
    if (header.origin === 'subagent') throw new Error('a subagent Session cannot become temporary')
    if (header.isSeeded === true && header.parentSession === undefined) {
      throw new Error('a seeded temporary Session must name its source Session')
    }
    // For a fork, only events after the inherited cut belong to this chat.
    // A fresh Session may already carry setup-only records (delegation
    // policy, prompt wiring), so "empty" means no turn and no human message.
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    const inherited = header.isSeeded === true && Number.isSafeInteger(session.inheritedEventCount)
      ? session.inheritedEventCount
      : 0
    const own = inherited > 0 ? events.slice(inherited) : events
    const used = own.some(event => event.type === 'turn/start'
      || (event.type === 'user/message' && event.data?.source?.kind === 'user'))
    if (used) throw new Error('only an unused Session can become temporary')
  }

  /**
   * The reservation a Journal still exposes for this Session, if any.
   * @param {string} sessionId - Session id.
   * @returns {object | undefined} the outstanding reservation.
   */
  outstandingReservation(sessionId) {
    const reservation = this.journal.reservations[sessionId]
    if (reservation === undefined || reservation.dropped === true) return undefined
    if (this.journal.entries[sessionId] !== undefined) return undefined
    return reservation
  }

  /**
   * Record a subagent child of a recorded temporary Session. The Host announces
   * every new Session, so this runs for all of them and records only a subagent
   * whose live ancestor chain reaches a recorded id. The record carries the
   * child's true direct parent, and the `owned` event lands before the registry
   * write.
   * @param {object} session - the Session the Host just announced.
   * @returns {Promise<void>} settles after the registry write.
   */
  recordDescendant(session) {
    // Pending before the queue wait, so exit cleanup sees the child while its write is queued.
    this.pending.push(session)
    return this.enqueue(async () => {
      await this.load()
      if (this.migrationIncomplete) {
        this.pending.splice(this.pending.indexOf(session), 1)
        this.warn(`not recording "${session?.header?.id ?? 'a child'}": the first ownership migration is incomplete`)
        return
      }
      const recorded = this.associateDescendant(session)
      this.pending.splice(this.pending.indexOf(session), 1)
      // A failed save keeps the record in memory: exit cleanup deletes it, unload publishes it, and the next save persists it.
      // A damaged registry still admits the journal observation; only the registry publish is refused.
      if (recorded && !this.journalDegraded) {
        const record = this.state.sessions[session.header.id]
        await this.appendEvent({
          type: 'owned',
          sessionId: record.sessionId,
          kind: record.kind,
          parentSessionId: record.parentSessionId,
          dir: record.dir,
          cwd: record.cwd,
          at: Date.now(),
        })
        if (record.pendingDelete === true) {
          await this.appendEvent({
            type: 'pending',
            sessionIds: [record.sessionId],
            reason: 'discard',
            at: Date.now(),
          })
        }
        await this.save()
      }
      this.refreshSnapshot()
    })
  }

  /**
   * Add the in-memory record for one announced subagent when its live ancestor chain
   * reaches a recorded id. Synchronous; the caller decides whether to save.
   * @param {object} session - the Session the Host announced.
   * @returns {boolean} whether a record was added.
   */
  associateDescendant(session) {
    const header = session?.header
    if (header?.origin !== 'subagent' || typeof header.id !== 'string') return false
    if (this.state.sessions[header.id] !== undefined) return false
    const ancestorId = this.recordedAncestor(header)
    if (ancestorId === undefined) return false
    const storage = this.resolveStorage(header)
    if (storage === undefined) {
      this.warn(`could not record subagent "${header.id}": the JSONL session store is unavailable`)
      return false
    }
    const now = Date.now()
    const parentSessionId = typeof header.parentSession === 'string' ? header.parentSession : ancestorId
    const pendingDelete = this.journal.entries[parentSessionId]?.pending === true
      || this.journal.entries[ancestorId]?.pending === true
    try {
      this.state.sessions[header.id] = recordFields({
        sessionId: header.id,
        kind: SUBAGENT_KIND,
        parentSessionId,
        dir: storage.dir,
        cwd: header.cwd ?? null,
        createdAt: header.createdAt,
        lastActivityAt: now,
        activitySince: now,
        pendingDelete,
      }, now)
    } catch (error) {
      this.warn(`could not record subagent "${header.id}": ${String(error)}`)
      return false
    }
    this.refreshSnapshot()
    return true
  }

  /**
   * The nearest recorded ancestor of a Session. Parent links are read from live
   * Sessions; an ancestor that is neither recorded nor live ends the walk with
   * no answer. So does a live ancestor that is not a subagent: an ordinary fork
   * is a boundary, and its subagents belong to the fork, not to the chat above it.
   * The record still stores the announced Session's true direct parent.
   * @param {object} header - the Session header whose ancestors are walked.
   * @returns {string | undefined} recorded ancestor id.
   */
  recordedAncestor(header) {
    const seen = new Set()
    let parentId = header.parentSession
    while (typeof parentId === 'string' && !seen.has(parentId)) {
      const entry = this.journal.entries[parentId]
      if (entry !== undefined && entry.deleted !== true) return parentId
      seen.add(parentId)
      const live = this.deps.sessions.get(parentId)
      if (live === undefined || live.header?.origin !== 'subagent') return undefined
      parentId = live.header?.parentSession
    }
    return undefined
  }

  /**
   * Every recorded descendant of a Session, through direct parent links at any
   * depth and across every kind. Computed from the registry index alone.
   * @param {string} sessionId - the ancestor Session id.
   * @returns {object[]} descendant records.
   */
  descendantRecords(sessionId) {
    const found = []
    const seen = new Set([sessionId])
    let grew = true
    while (grew) {
      grew = false
      for (const record of Object.values(this.state.sessions)) {
        if (seen.has(record.sessionId)) continue
        if (!seen.has(record.parentSessionId)) continue
        seen.add(record.sessionId)
        found.push(record)
        grew = true
      }
    }
    return found
  }

  /**
   * The chat record for a browser-facing id. Subagent records are not chats, so
   * the adopt, discard, and promote paths never see them.
   * @param {unknown} sessionId - requested Session id.
   * @returns {object | undefined} the chat record.
   */
  chatRecord(sessionId) {
    const record = typeof sessionId === 'string' ? this.state.sessions[sessionId] : undefined
    return record?.kind === SUBAGENT_KIND ? undefined : record
  }

  /**
   * List every recorded temporary chat with the publisher epoch, a per-response
   * sequence, the degraded flag and the stopping entries.
   * @returns {Promise<object>} the browser-facing listing.
   */
  list() {
    return this.enqueue(async () => {
      await this.load()
      this.sequence += 1
      const records = Object.values(this.state.sessions)
      return {
        // Ended side chats stay listed (with pendingDelete) so a page reload
        // can keep hiding them until the Host deletes their logs. The browser
        // derives its active count from pendingDelete.
        epoch: this.publisher.epoch,
        sequence: this.sequence,
        degraded: this.journalDegraded || this.registryDegraded,
        stopping: records
          .filter(record => record.pendingDelete === true && record.kind !== SUBAGENT_KIND)
          .map(record => ({ sessionId: record.sessionId, kind: record.kind })),
        sessions: records
          .filter(record => record.kind !== SUBAGENT_KIND)
          .map(record => recordView(record)),
      }
    })
  }

  /**
   * Detach a forked side chat from the main goal and add its boundary note.
   * Failures here never block registration: the side chat still works with the
   * inherited context, just without the extra guidance.
   * @param {string} sessionId - the registered side Session.
   */
  prepareSideChat(sessionId) {
    const agent = this.deps.agents?.get?.(sessionId)
    if (agent === undefined || agent === null) return
    try {
      const goal = this.deps.goals?.get?.(agent)
      if (goal !== undefined && goal !== null && typeof this.deps.goals?.clear === 'function') {
        this.deps.goals.clear(agent, { id: goal.id, revision: goal.revision })
      }
    } catch (error) {
      this.warn(`could not clear the inherited goal for side chat "${sessionId}": ${String(error)}`)
    }
    try {
      agent.ctx?.systemPrompt?.section?.({
        name: 'dsh-temp-session-side',
        order: 10000,
        text: SIDE_INSTRUCTIONS,
        interpolate: false,
      })
    } catch (error) {
      this.warn(`could not add the side-chat instruction for "${sessionId}": ${String(error)}`)
    }
  }

  /**
   * Mark one temporary Session and its whole tree for deletion. The browser
   * hides an ended Session through the shipped archive path before calling
   * this; the log is removed when the Host exits (or at the next boot after a
   * hard kill). The tree's `pending` event is durable before any state changes.
   * @param {{ sessionId: string }} request - Session to end.
   * @returns {Promise<{ discarded: true }>} acknowledgement.
   */
  discard(request) {
    return this.enqueue(async () => {
      await this.load()
      this.assertWritable('discard a temporary session')
      const sessionId = request?.sessionId
      const record = this.chatRecord(sessionId)
      if (record === undefined) throw new Error('this Session is not a recorded temporary session')
      const tree = [record, ...this.descendantRecords(sessionId)]
      // One event carries the whole tree, so no partial prefix can exist. A record
      // whose journal append failed is not deletion evidence, so it is not named.
      const owned = tree.filter(item => this.journal.entries[item.sessionId] !== undefined)
      if (owned.length > 0) {
        await this.appendEvent({
          type: 'pending',
          sessionIds: owned.map(item => item.sessionId),
          reason: 'discard',
          at: Date.now(),
        })
      }
      for (const item of tree) item.pendingDelete = true
      await this.save()
      this.refreshSnapshot()
      const agent = this.deps.agents?.get?.(sessionId)
      if (agent?.status === 'running' && this.deps.sessionController !== undefined) {
        try {
          this.deps.sessionController.cancel({ sessionId })
        } catch (error) {
          this.warn(`could not cancel temporary session "${sessionId}": ${String(error)}`)
        }
      }
      return { discarded: true }
    })
  }

  /**
   * The folder this record may delete, or undefined when deletion is not
   * authorised. The ownership journal is the fact: a degraded journal, a
   * registry row with no owned event, or a target that disagrees with the
   * journal is never deletion evidence.
   * @param {object} record - registry record.
   * @returns {string | undefined} the validated target.
   */
  deletionTarget(record) {
    if (this.journalDegraded) {
      this.warn(`refusing to delete "${record.sessionId}": the ownership journal is degraded`)
      return undefined
    }
    const entry = this.journal.entries[record.sessionId]
    if (entry === undefined) {
      this.warn(`refusing to delete "${record.sessionId}": the ownership journal has no owned entry`)
      return undefined
    }
    if (entry.deleted === true && entry.deletedDir !== entry.dir) {
      this.warn(`refusing to delete "${record.sessionId}": its deleted target disagrees with its owned target`)
      return undefined
    }
    const target = entry.deleted === true ? entry.deletedDir : entry.dir
    if (typeof target !== 'string' || target !== record.dir) {
      this.warn(`refusing to delete "${record.sessionId}": its record target disagrees with the ownership journal`)
      return undefined
    }
    const header = this.headerFor(record)
    if (header === undefined) {
      this.warn(`refusing to delete "${record.sessionId}": no stored header confirms it`)
      return undefined
    }
    if (!this.recordAgreesWithHeader(record, header)) {
      this.warn(`refusing to delete "${record.sessionId}": its record disagrees with its stored header`)
      return undefined
    }
    if (!isSafeSessionDir(target, record.sessionId)) {
      this.warn(`refusing to delete unsafe temporary-session path for "${record.sessionId}"`)
      return undefined
    }
    return target
  }

  /**
   * Whether a Session or Agent is live for an id. An ordinary reap removal
   * requires both to be absent; unload uses its confirmed-idle exception.
   * @param {string} sessionId - Session id.
   * @returns {boolean} whether a live Session or Agent exists.
   */
  hasLiveOwner(sessionId) {
    return this.deps.sessions.get(sessionId) !== undefined
      || this.deps.agents?.get?.(sessionId) !== undefined
  }

  /**
   * Delete one record's storage directory when it is journal-authorised and no
   * longer has a live Agent. The `deleted` event is durable before the removal;
   * a failed append leaves the folder untouched.
   * @param {object} record - registry record.
   * @param {boolean} [liveConfirmed] - the caller already confirmed a live Session idle.
   * @param {(() => Promise<boolean> | boolean) | undefined} [confirmAfterAppend] - recheck
   *   the caller's deletion condition after the durable append.
   * @param {(() => boolean) | undefined} [confirmBeforeRemove] - final synchronous
   *   check immediately before removal.
   * @returns {Promise<boolean>} whether the record may be dropped.
   */
  async removeStorage(record, liveConfirmed = false, confirmAfterAppend = undefined, confirmBeforeRemove = undefined) {
    const target = this.deletionTarget(record)
    if (target === undefined) return false
    const entry = this.journal.entries[record.sessionId]
    if (entry?.deleted !== true) {
      try {
        await this.appendEvent({
          type: 'deleted',
          sessionId: record.sessionId,
          kind: record.kind,
          parentSessionId: record.parentSessionId,
          dir: record.dir,
          cwd: record.cwd,
          at: Date.now(),
        })
      } catch (error) {
        this.warn(`not deleting temporary session "${record.sessionId}": its deleted event could not be written (${String(error)})`)
        return false
      }
    }
    if (!liveConfirmed && this.hasLiveOwner(record.sessionId)) {
      this.warn(`not deleting temporary session "${record.sessionId}": its Session or Agent became live during deletion`)
      return false
    }
    if (typeof confirmAfterAppend === 'function') {
      let confirmed
      try {
        confirmed = await confirmAfterAppend()
      } catch (error) {
        this.warn(`not deleting temporary session "${record.sessionId}": its post-append check failed (${String(error)})`)
        return false
      }
      if (!confirmed) {
        this.warn(`not deleting temporary session "${record.sessionId}": its Agent is not confirmed idle after the deleted append`)
        return false
      }
    }
    if (typeof confirmBeforeRemove === 'function' && !confirmBeforeRemove()) {
      this.warn(`not deleting temporary session "${record.sessionId}": its Agent changed before removal`)
      return false
    }
    try {
      // The final liveness check and the removal are one synchronous turn, so
      // a same-process Session cannot become live between them.
      rmSync(target, { recursive: true, force: true })
      return true
    } catch (error) {
      this.warn(`could not delete temporary session "${record.sessionId}": ${String(error)}`)
      return false
    }
  }

  /**
   * Promote a temporary Session to a normal one: drop its record so exit and
   * boot cleanup never delete its log. The caller also renames it to a lasting
   * title when it supplies one.
   * @param {{ sessionId: string, title?: string }} request - Session to keep.
   * @returns {Promise<{ promoted: true }>} acknowledgement.
   */
  promote(request) {
    return this.enqueue(async () => {
      await this.load()
      this.assertWritable('promote a temporary session')
      const sessionId = request?.sessionId
      const record = this.chatRecord(sessionId)
      if (record === undefined) throw new Error('this Session is not a recorded temporary session')
      // The kept chat's subagent logs must survive every later exit, so their records go too.
      for (const child of this.descendantRecords(sessionId)) delete this.state.sessions[child.sessionId]
      delete this.state.sessions[sessionId]
      this.refreshSnapshot()
      await this.save()
      const title = typeof request.title === 'string' ? request.title : ''
      if (title !== '' && this.deps.sessionController !== undefined) {
        try {
          await this.deps.sessionController.rename({ sessionId, title })
        } catch (error) {
          this.warn(`could not title promoted session "${sessionId}": ${String(error)}`)
        }
      }
      return { promoted: true }
    })
  }

  /**
   * Finish deletions whose `deleted` event survived a crash. The journal target
   * is the only evidence when the stored header is gone; it must agree with the
   * `owned` event and, when a header is present, with that header. A listing
   * that omits an id is not proof of absence, so every absent id gets a direct
   * stat; an unreadable stat retains the folder. Deletion is synchronous after
   * the final liveness check.
   * @param {Map<string, object>} storedHeaders - stored headers from this boot.
   * @returns {Promise<number>} folders removed.
   */
  async finishJournalDeletes(storedHeaders) {
    let removed = 0
    for (const [sessionId, entry] of Object.entries(this.journal.entries)) {
      if (entry.deleted !== true) continue
      if (this.hasLiveOwner(sessionId)) {
        this.warn(`not finishing deletion of "${sessionId}": its Session or Agent is still live`)
        continue
      }
      if (entry.deletedDir !== entry.dir || entry.deletedCwd !== entry.cwd) {
        this.warn(`not finishing deletion of "${sessionId}": its deleted event disagrees with its owned event`)
        continue
      }
      if (!isSafeSessionDir(entry.deletedDir, sessionId)) {
        this.warn(`not finishing deletion of "${sessionId}": its journal target is unsafe`)
        continue
      }
      let header = storedHeaders.get(sessionId)
      if (header === undefined) {
        try {
          header = await this.storedHeader(sessionId)
        } catch (error) {
          this.warn(`not finishing deletion of "${sessionId}": its stored header is uncertain (${String(error)})`)
          continue
        }
      }
      if (header !== undefined && !this.journalTargetAgreesWithHeader(entry, header)) {
        this.warn(`not finishing deletion of "${sessionId}": its journal target disagrees with its stored header`)
        continue
      }
      if (this.hasLiveOwner(sessionId)) {
        this.warn(`not finishing deletion of "${sessionId}": its Session or Agent became live during its header check`)
        continue
      }
      if (!existsSync(entry.deletedDir)) continue
      try {
        rmSync(entry.deletedDir, { recursive: true, force: true })
      } catch (error) {
        this.warn(`could not finish deletion of "${sessionId}": ${String(error)}`)
        continue
      }
      if (existsSync(entry.deletedDir)) {
        this.warn(`could not finish deletion of "${sessionId}": its folder is still present`)
        continue
      }
      removed += 1
      this.warn(`finished deletion of "${sessionId}" from its ownership journal`)
    }
    return removed
  }

  /**
   * Whether a journal-owned target agrees with its stored header.
   * @param {object} entry - replayed journal entry.
   * @param {object} header - stored Session header.
   * @returns {boolean} whether the identity and target agree.
   */
  journalTargetAgreesWithHeader(entry, header) {
    if (header?.id !== entry.sessionId) return false
    if ((header.cwd ?? null) !== entry.cwd) return false
    if ((header.parentSession ?? null) !== entry.parentSessionId) return false
    const headerKind = kindOfHeader(header)
    const kindAgrees = entry.kind === headerKind
      || (entry.kind === 'side' && header.isSeeded === true && typeof header.parentSession === 'string')
    if (!kindAgrees) return false
    const storage = this.resolveStorage(header)
    return storage !== undefined && storage.dir === entry.dir
  }

  /**
   * Boot-time cleanup: restore the archive set and delete every recorded
   * Session that no longer has a live Agent. Live Sessions (for example during
   * a live profile reload) are kept for the next boot or process exit, and so
   * is a descendant record under a live chat.
   */
  reap() {
    return this.enqueue(async () => {
      await this.load()
      if (this.journalDegraded) {
        this.warn('skipping boot cleanup: the ownership journal is degraded')
        return
      }
      const storedHeaders = new Map()
      let listingComplete = false
      try {
        const snapshots = await this.deps.sessionPersistence.list()
        for (const snapshot of snapshots) storedHeaders.set(snapshot.header.id, snapshot.header)
        this.storedHeaders = storedHeaders
        listingComplete = true
      } catch (error) {
        this.warn(`could not list stored sessions during temporary-session cleanup: ${String(error)}`)
      }
      // Finish tombstones first: a kill after the durable `deleted` event leaves
      // the folder for this pass, even when its stored header is already gone.
      await this.finishJournalDeletes(storedHeaders)
      await this.resumePendingStops()
      // Collected before anything is deleted, so a removed parent cannot break the chain for its children.
      const kept = new Set()
      for (const [sessionId, record] of Object.entries(this.state.sessions)) {
        if (record?.kind === SUBAGENT_KIND || this.deps.sessions.get(sessionId) === undefined) continue
        for (const child of this.descendantRecords(sessionId)) kept.add(child.sessionId)
      }
      // An announcement can arrive before its queued recorder runs. Keep the
      // observed session and its parent chain through the queue handoff.
      for (const observation of this.pending) {
        let cursor = observation?.header?.id
        const seen = new Set()
        while (typeof cursor === 'string' && !seen.has(cursor)) {
          seen.add(cursor)
          kept.add(cursor)
          const header = storedHeaders.get(cursor) ?? this.deps.sessions.get(cursor)?.header
          cursor = header?.parentSession
        }
      }
      let changed = false
      for (const [sessionId, record] of Object.entries(this.state.sessions)) {
        if (record === null || typeof record !== 'object') {
          delete this.state.sessions[sessionId]
          changed = true
          continue
        }
        if (this.deps.sessions.get(sessionId) !== undefined || kept.has(sessionId)) continue
        const entry = this.journal.entries[sessionId]
        if (entry?.deleted === true && entry.deletedDir === entry.dir && !existsSync(entry.dir)) {
          delete this.state.sessions[sessionId]
          changed = true
          continue
        }
        if (record.dir === undefined && storedHeaders.has(sessionId)) {
          record.dir = this.dirOf(storedHeaders.get(sessionId))
        }
        // Authorise before clearing archive state: an unauthorised record must
        // stay recorded and untouched.
        if (this.deletionTarget(record) === undefined) continue
        try {
          await this.deps.workspaceRegistry?.unarchiveSession?.(sessionId)
        } catch (error) {
          this.warn(`could not clear archived state for "${sessionId}": ${String(error)}`)
        }
        if (!(await this.removeStorage(record))) continue
        delete this.state.sessions[sessionId]
        changed = true
      }
      this.refreshSnapshot()
      if (changed) await this.save()
      if (listingComplete) await this.pruneJournal(storedHeaders)
    })
  }

  /**
   * Resume cancellation for pending records restored from the journal. The
   * record and folder stay until a later pass observes the Agent absent or
   * confirmed idle; this pass only re-issues the stop.
   * @returns {Promise<void>}
   */
  async resumePendingStops() {
    for (const record of Object.values(this.state.sessions)) {
      if (record?.pendingDelete !== true) continue
      if (this.deps.sessions.get(record.sessionId) === undefined) continue
      const agent = this.deps.agents?.get?.(record.sessionId)
      let issued = false
      if (agent !== undefined && typeof agent.cancel === 'function') {
        try {
          agent.cancel({ kind: record.kind === SUBAGENT_KIND ? 'parent' : 'user' })
          issued = true
        } catch (error) {
          this.warn(`could not resume the stop for "${record.sessionId}": ${String(error)}`)
        }
      }
      if (!issued && typeof this.deps.sessionController?.cancel === 'function') {
        try {
          this.deps.sessionController.cancel({ sessionId: record.sessionId })
          issued = true
        } catch (error) {
          this.warn(`could not resume the stop for "${record.sessionId}": ${String(error)}`)
        }
      }
      if (!issued) this.warn(`pending "${record.sessionId}" has a live Session but no cancel path`)
    }
  }

  /**
   * Compact the ownership journal after replay, the observed-queue handoff and
   * reap. An entry is retained while a registry record, a stored child, a
   * queued observation, a pending/deleted state or its own folder needs it; a
   * reservation is retained until promoted or dropped. A no-longer-needed
   * entry gets the 30-day age bound, and the migration events are never pruned.
   * @param {Map<string, object>} storedHeaders - stored headers from this boot.
   * @returns {Promise<void>}
   */
  async pruneJournal(storedHeaders) {
    if (this.journalDegraded) return
    const keep = new Set()
    const addAncestors = (id) => {
      const seen = new Set()
      let cursor = id
      while (typeof cursor === 'string' && !seen.has(cursor)) {
        seen.add(cursor)
        keep.add(cursor)
        const header = storedHeaders.get(cursor) ?? this.deps.sessions.get(cursor)?.header
        cursor = header?.parentSession
      }
    }
    for (const record of Object.values(this.state.sessions)) addAncestors(record.sessionId)
    for (const observation of this.pending) addAncestors(observation?.header?.id)
    for (const header of storedHeaders.values()) {
      if (typeof header.parentSession === 'string' && this.journal.entries[header.parentSession] !== undefined) {
        keep.add(header.parentSession)
      }
    }
    for (const [sessionId, entry] of Object.entries(this.journal.entries)) {
      if (typeof entry.dir === 'string' && existsSync(entry.dir)) keep.add(sessionId)
      if (entry.pending === true && entry.deleted !== true) keep.add(sessionId)
      if (entry.deleted === true) {
        if (typeof entry.deletedDir === 'string' && existsSync(entry.deletedDir)) keep.add(sessionId)
        if (Object.values(this.state.sessions).some(record => record.parentSessionId === sessionId)) keep.add(sessionId)
      }
    }
    // A retained child keeps its journal parent as the orphan anchor.
    let grew = true
    while (grew) {
      grew = false
      for (const [sessionId, entry] of Object.entries(this.journal.entries)) {
        if (!keep.has(sessionId)) continue
        const parentId = entry.parentSessionId
        if (typeof parentId !== 'string' || this.journal.entries[parentId] === undefined) continue
        if (!keep.has(parentId)) {
          keep.add(parentId)
          grew = true
        }
      }
    }
    const reservationIds = new Set()
    for (const [sessionId, reservation] of Object.entries(this.journal.reservations)) {
      if (reservation.dropped !== true && this.journal.entries[sessionId] === undefined) reservationIds.add(sessionId)
    }
    const now = Date.now()
    const withinAge = (entry) => {
      const latest = Math.max(entry.ownedAt ?? 0, entry.deletedAt ?? 0)
      return latest > 0 && now - latest < 30 * 24 * 60 * 60 * 1000
    }
    const retained = (sessionId) => {
      if (keep.has(sessionId)) return true
      const entry = this.journal.entries[sessionId]
      return entry !== undefined && withinAge(entry)
    }
    const events = []
    for (const event of this.journal.events) {
      switch (event.type) {
        case 'migration':
        case 'migrationComplete':
          events.push(event)
          break
        case 'reserved':
          if (reservationIds.has(event.sessionId)) events.push(event)
          break
        case 'reservationDropped':
          break
        case 'owned':
        case 'deleted':
          if (retained(event.sessionId)) events.push(event)
          break
        case 'pending': {
          const sessionIds = event.sessionIds.filter(sessionId => this.journal.entries[sessionId]?.pending === true && retained(sessionId))
          if (sessionIds.length > 0) events.push({ ...event, sessionIds })
          break
        }
        default:
          break
      }
    }
    const text = events.map(event => `${JSON.stringify(event)}\n`).join('')
    if (text === this.journalSource) return
    try {
      rewriteJournal(this.paths.journal, text)
      this.journalSource = text
      this.journal = replayJournal(text)
    } catch (error) {
      this.warn(`could not compact the ownership journal: ${String(error)}`)
    }
  }

  /**
   * Whether an Agent is confirmed idle: absent, or idle with a bounded
   * `whenIdle()` settlement. The current Agent is re-read after settlement so
   * a wake cannot be mistaken for the idle state observed before the wait.
   * @param {object | undefined} agent - live Agent, when one exists.
   * @param {string | undefined} [sessionId] - id used to re-read the Agent.
   * @returns {Promise<boolean>} whether deletion may proceed.
   */
  async confirmIdle(agent, sessionId = undefined) {
    if (agent === undefined) return true
    if (agent.status !== 'idle') return false
    if (typeof agent.whenIdle === 'function') {
      let timer
      let settled
      try {
        settled = await Promise.race([
          Promise.resolve().then(() => agent.whenIdle()).then(() => true, () => false),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 100)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (!settled) return false
    }
    const current = sessionId === undefined ? agent : this.deps.agents?.get?.(sessionId)
    if (current === undefined) return true
    return current === agent && current.status === 'idle'
  }

  /**
   * On plugin unload, publish the registry synchronously, then delete the storage of Sessions
   * already ended by the user. A pending member with a running Agent stays recorded for the next
   * boot; a live but idle Session has no work left and may be removed only after `whenIdle()`
   * settles within the bounded check.
   */
  cleanupPending() {
    this.flushRegistrySync()
    return this.enqueue(async () => {
      await this.load()
      if (this.journalDegraded) {
        this.warn('skipping unload cleanup: the ownership journal is degraded')
        return
      }
      for (const record of Object.values(this.state.sessions)) {
        if (record?.pendingDelete !== true) continue
        const agent = this.deps.agents?.get?.(record.sessionId)
        if (!(await this.confirmIdle(agent, record.sessionId))) {
          this.warn(`keeping "${record.sessionId}" on unload: its Agent is not confirmed idle`)
          continue
        }
        await this.removeStorage(
          record,
          true,
          () => this.confirmIdle(this.deps.agents?.get?.(record.sessionId), record.sessionId),
          () => {
            const current = this.deps.agents?.get?.(record.sessionId)
            return current === undefined || (current === agent && current.status === 'idle')
          },
        )
      }
    })
  }
}

/**
 * Synchronously delete every Session in a validated immutable snapshot. This is
 * the only exit deletion path: it never reads the registry or journal for its
 * delete set, and a degraded snapshot deletes nothing. When a journal path is
 * supplied, every `deleted` event is appended and fsynced before any folder is
 * removed; one failed append removes nothing.
 * @param {{ degraded?: boolean, sessions?: readonly object[] }} snapshot - validated snapshot.
 * @param {{ warn?: (message: string) => void }} [logger] - optional logger.
 * @param {string} [journal] - ownership journal to tombstone before removal.
 * @returns {number} directories removed.
 */
export function cleanupSnapshotSync(snapshot, logger, journal) {
  if (snapshot === null || typeof snapshot !== 'object' || snapshot.degraded === true) return 0
  const seen = new Set()
  const records = []
  for (const record of snapshot.sessions ?? []) {
    if (record === null || typeof record !== 'object') continue
    if (!isSafeSessionDir(record.dir, record.sessionId) || seen.has(record.sessionId)) continue
    seen.add(record.sessionId)
    records.push(record)
  }
  if (typeof journal === 'string' && journal !== '') {
    try {
      for (const record of records) {
        appendJournalEventSync(journal, {
          type: 'deleted',
          sessionId: record.sessionId,
          kind: record.kind,
          parentSessionId: record.parentSessionId ?? null,
          dir: record.dir,
          cwd: record.cwd ?? null,
          at: Date.now(),
        })
      }
    } catch (error) {
      logger?.warn?.(`temporary-session exit cleanup could not write its deleted events; deleting nothing: ${String(error)}`)
      return 0
    }
  }
  let removed = 0
  for (const record of records) {
    if (deleteRecordSync(record, logger)) removed += 1
  }
  return removed
}

/** Process-level cleanup installation guard (one handler set per process). */
const PROCESS_CLEANUP = Symbol.for('dsh.temp-session.process-cleanup')

/**
 * The validated snapshot provider of the latest install, kept on `globalThis`.
 * It outlives an unload on purpose: an unloaded plugin must still delete the
 * Sessions it validated.
 */
const EXIT_SNAPSHOT = Symbol.for('dsh.temp-session.exit-snapshot')

/**
 * Install the process exit and signal handlers once. The handlers read the
 * shared binding at exit, not a closure from the first install, because a live
 * reload can import a new module while the old handlers are still installed.
 */
function ensureExitHandlers() {
  if (globalThis[PROCESS_CLEANUP] === true) return
  const cleanup = () => {
    const bound = globalThis[EXIT_SNAPSHOT]
    if (bound === undefined) return
    try {
      bound.closeAdmission?.()
      cleanupSnapshotSync(bound.snapshot(), bound.logger, bound.journal)
    } catch (error) {
      bound.logger?.warn?.(`temporary-session exit cleanup failed: ${String(error)}`)
    }
  }
  const onSignal = (signal) => {
    globalThis[EXIT_SNAPSHOT]?.closeAdmission?.()
    cleanup()
    process.off(signal, onSignal)
    try {
      // Re-raise: with no remaining listener the platform's default action
      // terminates the process, exactly as it would without this plugin.
      process.kill(process.pid, signal)
    } catch {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
  }
  process.on('exit', cleanup)
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  globalThis[PROCESS_CLEANUP] = true
}

/**
 * Install the validated-snapshot exit cleanup. The handler reads the newest
 * immutable snapshot and never parses the registry or journal for its delete
 * set; it appends a durable `deleted` event before each removal. The binding
 * survives an unload, so an unloaded plugin still deletes what it validated.
 * @param {() => { degraded?: boolean, sessions?: readonly object[] }} snapshotProvider - current snapshot.
 * @param {{ warn?: (message: string) => void }} [logger] - Host logger.
 * @param {string} [journal] - ownership journal for tombstone events.
 * @param {() => void} [closeAdmission] - closes new temporary writes before cleanup.
 * @returns {void}
 */
export function installExitCleanup(snapshotProvider, logger, journal, closeAdmission) {
  globalThis[EXIT_SNAPSHOT] = { snapshot: snapshotProvider, logger, journal, closeAdmission }
  ensureExitHandlers()
}
