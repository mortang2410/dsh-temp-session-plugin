/**
 * Temporary-session bookkeeping, independent of Cordis.
 *
 * A temporary session is an ordinary DSH Session created by the browser. The
 * Host records its id and the exact per-session storage directory, and the
 * whole directory is removed when the Host exits (or on the next boot, when a
 * hard kill left it behind). This module owns that registry plus every
 * filesystem deletion so it can be tested without booting a Harness.
 *
 * @module dsh-temp-session-plugin/core
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Registry schema version. A different version starts an empty registry. */
export const STATE_VERSION = 1

/**
 * `kind` of a record the plugin created for a subagent child of a recorded
 * temporary Session. Browser-adopted chats carry `main` or `side`, so readers
 * and cleanup can tell the two apart.
 */
export const SUBAGENT_KIND = 'subagent'

/** Boundary note added to a forked, temporary side conversation. */
const SIDE_INSTRUCTIONS = `This is a temporary side conversation forked from the main conversation.
Treat the inherited history as reference only. Do not continue the main task, its goals, plans, approvals, or tool calls. Answer the new side question independently. Do not use subagents. Change files or workspace state only when the user explicitly asks for that change in this side conversation.`

/**
 * Resolve this plugin's private registry location under the Harness home.
 * @param {NodeJS.ProcessEnv} [env] - process environment (DSH_HOME is set by dsh).
 * @param {(path: string) => string} [dshHomePath] - the Host's home-path
 *   service, when mounted; it knows the home the launcher actually used.
 * @returns {{ dir: string, file: string }} registry directory and file.
 */
export function statePaths(env = process.env, dshHomePath) {
  const dir = typeof dshHomePath === 'function'
    ? dshHomePath('temp-session')
    : join(
      env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh'),
      'temp-session',
    )
  return { dir, file: join(dir, 'records.json') }
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
 * Owns the temporary-session registry and its cleanup rules.
 *
 * Mutations are serialized through one promise chain, so two browser calls
 * cannot interleave a read-modify-write of the registry file.
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
   * @param {{ dir: string, file: string }} deps.paths - registry location.
   */
  constructor(deps) {
    this.deps = deps
    this.paths = deps.paths
    this.state = emptyState()
    this.loaded = false
    this.queue = Promise.resolve()
  }

  /** Run one mutation after every mutation already queued. */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Read the registry once; a missing or unreadable file starts empty. */
  async load() {
    if (this.loaded) return this.state
    this.loaded = true
    try {
      const text = await readFile(this.paths.file, 'utf8')
      const parsed = JSON.parse(text)
      if (parsed !== null
        && typeof parsed === 'object'
        && parsed.version === STATE_VERSION
        && parsed.sessions !== null
        && typeof parsed.sessions === 'object') {
        this.state = { version: STATE_VERSION, sessions: { ...parsed.sessions } }
      } else {
        this.deps.logger.warn(`ignoring unsupported temporary-session registry at ${this.paths.file}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.deps.logger.warn(`could not read temporary-session registry: ${String(error)}`)
      }
    }
    return this.state
  }

  /** Persist the registry atomically. */
  async save() {
    await mkdir(this.paths.dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.paths.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, encodeState(this.state), { mode: 0o600 })
    await rename(temporary, this.paths.file)
  }

  /**
   * Resolve the per-session directory the JSONL backend stores this Session in.
   * The backend exposes its refusal-diagnostics locator at runtime; a backend
   * without it keeps the feature unavailable instead of guessing a path.
   * @param {object} header - the live Session header.
   * @returns {string | undefined} absolute per-session directory.
   */
  dirOf(header) {
    return this.resolveStorage(header)?.dir
  }

  /**
   * The directory and the log artifact the Host would use for this Session.
   * The artifact path matters on its own: a backend creates the directory before it links the
   * log, so a directory says nothing about whether a transcript was published.
   * @param {object} header - the live Session header.
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
      this.deps.logger.warn(`could not locate temporary-session storage: ${String(error)}`)
    }
    return undefined
  }

  /** Public view of one record: no Host paths cross the wire. */
  static view(record) {
    return {
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      kind: record.kind === 'side' ? 'side' : 'main',
      pendingDelete: record.pendingDelete === true,
    }
  }

  /**
   * Record a Session as temporary and pin its display title.
   *
   * A main-area temporary session is a fresh, unused Session. A side chat is a
   * fork: it inherits history, so only the child-owned tail after the fork cut
   * must stay unused. Neither an arbitrary existing history nor a subagent can
   * be adopted.
   * @param {{ sessionId: string, title?: string, kind?: 'main' | 'side' }} request - Session to adopt.
   * @returns {Promise<{ sessionId: string, createdAt: number, kind: string, pendingDelete: boolean }>} the record view.
   */
  register(request) {
    return this.enqueue(async () => {
      await this.load()
      const sessionId = request?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) {
        throw new Error('temporary session registration requires a Session id')
      }
      const existing = this.state.sessions[sessionId]
      if (existing?.kind === SUBAGENT_KIND) throw new Error('a subagent Session cannot become temporary')
      if (existing !== undefined) return TemporarySessions.view(existing)
      const session = this.deps.sessions.get(sessionId)
      if (session === undefined) throw new Error('the Session is not live; open it before registering')
      const header = session.header
      const kind = request.kind === 'side' ? 'side' : 'main'
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
      const title = typeof request.title === 'string' ? request.title : ''
      // Resolve the storage directory before anything is written. The locator computes the path
      // from the header, so a backend that can answer now never needs a flush first, and a
      // backend that can only answer after the log exists would have to persist the very
      // transcript this record exists to gate.
      const storage = this.resolveStorage(header)
      if (storage === undefined) {
        throw new Error('temporary sessions need the JSONL session store (its locator is unavailable)')
      }
      const record = {
        sessionId,
        dir: storage.dir,
        cwd: header.cwd ?? null,
        createdAt: Date.now(),
        title,
        kind,
        pendingDelete: false,
      }
      // Publish the record before the log is materialized: this file is the only signal an
      // outside reader has, and the flush below persists the Session's current content.
      this.state.sessions[sessionId] = record
      await this.save()
      try {
        await this.deps.sessions.flush(session)
      } catch (error) {
        // The backend links the artifact before it syncs the directory, so a failed flush can
        // still leave the log on disk. Keep the record in that case: the Session was asked to be
        // temporary and its transcript is materialized, and a rollback would expose exactly that
        // transcript to every reader that gates on this file. Roll back only when nothing landed.
        if (!existsSync(storage.artifact)) {
          delete this.state.sessions[sessionId]
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
          this.deps.logger.warn(`could not title temporary session "${sessionId}": ${String(error)}`)
        }
      }
      return TemporarySessions.view(record)
    })
  }

  /**
   * Record a subagent child of a recorded temporary Session. The Host announces
   * every new Session, so this runs for all of them and records only a subagent
   * whose live ancestor chain reaches a recorded id. No unused-history rule
   * applies: a child has turns by definition. A chain that breaks (an ancestor
   * that is neither recorded nor live) records nothing, because a guessed link
   * would let a later cleanup delete a transcript it does not own.
   * @param {object} session - the Session the Host just announced.
   * @returns {Promise<void>} settles after the registry write.
   */
  recordDescendant(session) {
    return this.enqueue(async () => {
      await this.load()
      const header = session.header
      if (header?.origin !== 'subagent' || typeof header.id !== 'string') return
      if (this.state.sessions[header.id] !== undefined) return
      const parentId = this.recordedAncestor(header)
      if (parentId === undefined) return
      const storage = this.resolveStorage(header)
      if (storage === undefined) {
        this.deps.logger.warn(`could not record subagent "${header.id}": the JSONL session store is unavailable`)
        return
      }
      const record = {
        sessionId: header.id,
        dir: storage.dir,
        cwd: header.cwd ?? null,
        createdAt: Date.now(),
        title: '',
        kind: SUBAGENT_KIND,
        parentSessionId: parentId,
        pendingDelete: this.state.sessions[parentId].pendingDelete === true,
      }
      this.state.sessions[header.id] = record
      try {
        await this.save()
      } catch (error) {
        delete this.state.sessions[header.id]
        throw error
      }
    })
  }

  /**
   * The nearest recorded ancestor of a Session. Parent links are read from live
   * Sessions; an ancestor that is neither recorded nor live ends the walk with
   * no answer.
   * @param {object} header - the Session header whose ancestors are walked.
   * @returns {string | undefined} recorded ancestor id.
   */
  recordedAncestor(header) {
    const seen = new Set()
    let parentId = header.parentSession
    while (typeof parentId === 'string' && !seen.has(parentId)) {
      if (this.state.sessions[parentId]?.sessionId !== undefined) return parentId
      seen.add(parentId)
      const live = this.deps.sessions.get(parentId)
      if (live === undefined) return undefined
      parentId = live.header?.parentSession
    }
    return undefined
  }

  /**
   * The subagent records that descend from a Session, through any depth of
   * recorded parent links. Computed from the registry alone.
   * @param {string} sessionId - the ancestor Session id.
   * @returns {object[]} descendant records.
   */
  descendantRecords(sessionId) {
    const ids = new Set([sessionId])
    const found = []
    let grew = true
    while (grew) {
      grew = false
      for (const record of Object.values(this.state.sessions)) {
        if (record?.kind !== SUBAGENT_KIND || ids.has(record.sessionId)) continue
        if (!ids.has(record.parentSessionId)) continue
        ids.add(record.sessionId)
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

  /** List every recorded temporary Session, including ones already ended. */
  list() {
    return this.enqueue(async () => {
      await this.load()
      return {
        // Ended side chats stay listed (with pendingDelete) so a page reload
        // can keep hiding them until the Host deletes their logs. The browser
        // derives its active count from pendingDelete.
        sessions: Object.values(this.state.sessions)
          .filter(record => record?.sessionId !== undefined && record.kind !== SUBAGENT_KIND)
          .map(record => TemporarySessions.view(record)),
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
      this.deps.logger.warn(`could not clear the inherited goal for side chat "${sessionId}": ${String(error)}`)
    }
    try {
      agent.ctx?.systemPrompt?.section?.({
        name: 'dsh-temp-session-side',
        order: 10000,
        text: SIDE_INSTRUCTIONS,
        interpolate: false,
      })
    } catch (error) {
      this.deps.logger.warn(`could not add the side-chat instruction for "${sessionId}": ${String(error)}`)
    }
  }

  /**
   * Mark one temporary Session for deletion. The browser hides an ended
   * Session through the shipped archive path before calling this; the log is
   * removed when the Host exits (or at the next boot after a hard kill).
   * @param {{ sessionId: string }} request - Session to end.
   * @returns {Promise<{ discarded: true }>} acknowledgement.
   */
  discard(request) {
    return this.enqueue(async () => {
      await this.load()
      const sessionId = request?.sessionId
      const record = this.chatRecord(sessionId)
      if (record === undefined) throw new Error('this Session is not a recorded temporary session')
      // A discarded chat takes its subagent children with it: they are deleted by the same cleanup.
      const children = this.descendantRecords(sessionId)
      record.pendingDelete = true
      record.discardedAt = Date.now()
      for (const child of children) child.pendingDelete = true
      await this.save()
      for (const id of [sessionId, ...children.map(child => child.sessionId)]) {
        const agent = this.deps.agents?.get?.(id)
        if (agent?.status === 'running' && this.deps.sessionController !== undefined) {
          try {
            this.deps.sessionController.cancel({ sessionId: id })
          } catch (error) {
            this.deps.logger.warn(`could not cancel temporary session "${id}": ${String(error)}`)
          }
        }
      }
      return { discarded: true }
    })
  }

  /**
   * Delete one record's storage directory when it no longer has a live Agent.
   * @param {object} record - registry record.
   * @returns {Promise<boolean>} whether the record may be dropped.
   */
  async removeStorage(record) {
    if (!isSafeSessionDir(record.dir, record.sessionId)) {
      this.deps.logger.warn(`refusing to delete unsafe temporary-session path for "${record.sessionId}"`)
      return true
    }
    try {
      await rm(record.dir, { recursive: true, force: true })
      return true
    } catch (error) {
      this.deps.logger.warn(`could not delete temporary session "${record.sessionId}": ${String(error)}`)
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
      const sessionId = request?.sessionId
      const record = this.chatRecord(sessionId)
      if (record === undefined) throw new Error('this Session is not a recorded temporary session')
      // The kept chat's subagent logs must survive every later exit, so their records go too.
      for (const child of this.descendantRecords(sessionId)) delete this.state.sessions[child.sessionId]
      delete this.state.sessions[sessionId]
      await this.save()
      const title = typeof request.title === 'string' ? request.title : ''
      if (title !== '' && this.deps.sessionController !== undefined) {
        try {
          await this.deps.sessionController.rename({ sessionId, title })
        } catch (error) {
          this.deps.logger.warn(`could not title promoted session "${sessionId}": ${String(error)}`)
        }
      }
      return { promoted: true }
    })
  }

  /**
   * Boot-time cleanup: restore the archive set and delete every recorded
   * Session that no longer has a live Agent. Live Sessions (for example during
   * a live profile reload) are kept for the next boot or process exit.
   */
  reap() {
    return this.enqueue(async () => {
      await this.load()
      const storedHeaders = new Map()
      try {
        const snapshots = await this.deps.sessionPersistence.list()
        for (const snapshot of snapshots) storedHeaders.set(snapshot.header.id, snapshot.header)
      } catch (error) {
        this.deps.logger.warn(`could not list stored sessions during temporary-session cleanup: ${String(error)}`)
      }
      let changed = false
      for (const [sessionId, record] of Object.entries(this.state.sessions)) {
        if (record === null || typeof record !== 'object') {
          delete this.state.sessions[sessionId]
          changed = true
          continue
        }
        if (this.deps.sessions.get(sessionId) !== undefined) continue
        try {
          await this.deps.workspaceRegistry?.unarchiveSession?.(sessionId)
        } catch (error) {
          this.deps.logger.warn(`could not clear archived state for "${sessionId}": ${String(error)}`)
        }
        if (record.dir === undefined && storedHeaders.has(sessionId)) {
          record.dir = this.dirOf(storedHeaders.get(sessionId))
        }
        if (!(await this.removeStorage(record))) continue
        delete this.state.sessions[sessionId]
        changed = true
      }
      if (changed) await this.save()
    })
  }

  /** On plugin unload, delete the storage of Sessions already ended by the user. */
  cleanupPending() {
    return this.enqueue(async () => {
      await this.load()
      for (const record of Object.values(this.state.sessions)) {
        if (record?.pendingDelete !== true) continue
        await this.removeStorage(record)
      }
    })
  }
}

/**
 * Synchronously delete every recorded temporary Session. Runs from process
 * `exit`/signal handlers, where asynchronous work can no longer finish.
 * Records stay behind as tombstones, so the next boot still clears the archive
 * set; the next boot's reap drops them.
 * @param {string} stateFile - registry file path.
 * @param {{ warn?: (message: string) => void }} [logger] - optional logger.
 * @returns {number} directories removed.
 */
export function cleanupAllSync(stateFile, logger) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return 0
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null || typeof parsed.sessions !== 'object') return 0
  let removed = 0
  for (const record of Object.values(parsed.sessions)) {
    if (record === null || typeof record !== 'object') continue
    if (!isSafeSessionDir(record.dir, record.sessionId)) continue
    if (!existsSync(record.dir)) continue
    try {
      rmSync(record.dir, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      logger?.warn?.(`could not delete temporary session "${String(record.sessionId)}" at exit: ${String(error)}`)
    }
  }
  return removed
}

/** Process-level cleanup installation guard (one handler set per process). */
const PROCESS_CLEANUP = Symbol.for('dsh.temp-session.process-cleanup')

/**
 * Install synchronous cleanup for normal exit, SIGTERM, and SIGINT. Signal
 * handling re-raises the original signal after deleting, so the Host keeps
 * whatever termination behavior it had without this plugin. Installation is
 * idempotent and intentionally never uninstalled: even an uninstalled plugin
 * must not leave temporary logs behind on the next quit.
 * @param {string} stateFile - registry file path.
 * @param {{ warn?: (message: string) => void }} [logger] - optional logger.
 * @returns {() => void} a no-op disposer.
 */
export function installProcessCleanup(stateFile, logger) {
  if (globalThis[PROCESS_CLEANUP] === true) return () => undefined
  const cleanup = () => {
    try {
      cleanupAllSync(stateFile, logger)
    } catch (error) {
      logger?.warn?.(`temporary-session exit cleanup failed: ${String(error)}`)
    }
  }
  const onSignal = (signal) => {
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
  return () => undefined
}
