/**
 * Temporary-session bookkeeping, independent of Cordis.
 *
 * A temporary session is an ordinary DSH Session created by the browser. The
 * Host records its id and the exact per-session storage directory in the
 * registry index, and the ownership journal records why the Session is
 * temporary. A confirmed member's directory is removed by plugin unload, at
 * process exit from the validated snapshot, or by the next boot after a hard
 * kill. This module owns that registry, the ownership journal's use, the
 * validated exit snapshot, and every filesystem deletion so it can be tested
 * without booting a Harness.
 *
 * @module dsh-temp-session-plugin/core
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
import { RECORD_KINDS, kindOfHeader, readRecord, recordFields, recordView } from './records.js'
import { RecoveryStore, inspectFragment, inspectRegistry } from './healing.js'
import { validateModelProposal } from './model-sanity.js'

/** Registry schema version. A different version is refused, never overwritten. */
export const STATE_VERSION = 1

/**
 * `kind` of a record the plugin created for a subagent child of a recorded
 * temporary Session. Browser-adopted chats carry `main`, `side` or `fork`.
 */
export const SUBAGENT_KIND = 'subagent'

/** First delay before retrying a protected observed append. */
const RETRY_DELAY_MS = 25

/** Longest delay between automatic retries of a protected observation. */
const RETRY_MAX_DELAY_MS = 30000

/** Longest wait for one Agent or owned job to settle before a stop is retried. */
const STOP_WAIT_MS = 100

/** Job lifecycles that still count as owned work. */
const LIVE_JOB_STATUSES = new Set(['running', 'stopping'])

/** A temporary tree expires after this much inactivity. */
const EXPIRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** How often a live instance checks for expired trees. */
const EXPIRY_SWEEP_MS = 60 * 60 * 1000

/** Activity persistence is coalesced to at most one write per minute. */
const ACTIVITY_SAVE_MS = 60 * 1000

/** Session events that count as real activity for expiry. */
const ACTIVITY_EVENT_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message',
  'tool/call', 'tool/result', 'session/title', 'goal/change',
])

/** Whether one Session event is real activity rather than teardown noise. */
function isActivityEvent(event) {
  if (!ACTIVITY_EVENT_TYPES.has(event?.type)) return false
  // A cancellation closes the live turn with an aborted reason. That closer is
  // teardown, not work; every event without an aborted reason records work.
  return event.data?.reason?.kind !== 'aborted'
}

/** Boundary note added to a forked, temporary side conversation. */
const SIDE_INSTRUCTIONS = `This is a temporary side conversation forked from the main conversation.
Treat the inherited history as reference only. Do not continue the main task, its goals, plans, approvals, or tool calls. Answer the new side question independently. Do not use subagents. Change files or workspace state only when the user explicitly asks for that change in this side conversation.`

/**
 * Resolve this plugin's private state location under the Harness home.
 * @param {NodeJS.ProcessEnv} [env] - process environment (DSH_HOME is set by dsh).
 * @param {(path: string) => string} [dshHomePath] - the Host's home-path
 *   service, when mounted; it knows the home the launcher actually used.
 * @returns {object} registry directory, registry file, ownership journal,
 *   migration marker, writer lock, unresolved backlog, preserved originals and recovery log.
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
    unresolved: join(dir, 'records.unresolved.jsonl'),
    preserved: join(dir, 'preserved'),
    recoveryLog: join(dir, 'recovery.log'),
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
   * @param {object} [deps.jobs] - owned background-job registry (`ctx.jobs`), optional.
   * @param {object} [deps.workspaceRegistry] - workspace archive set, optional.
   * @param {(message: string) => void} [deps.trace] - ordered stop-path trace sink.
   * @param {{ warn: (message: string) => void, info?: (message: string) => void }} deps.logger - Host logger.
   * @param {{ dir: string, file: string, journal: string, marker: string, lock: string }} deps.paths - state location.
   */
  constructor(deps) {
    this.deps = deps
    this.paths = deps.paths
    this.state = emptyState()
    this.loaded = false
    this.loadPromise = undefined
    this.loadFailed = false
    this.loadError = undefined
    // The registry file exists but could not be read, parsed or versioned; never overwrite it.
    this.registryDegraded = false
    // The exact bytes and span scan that produced the current registry state.
    this.registryContext = undefined
    // The full registry read result, including its context. Later settlement
    // passes must see the member scan and blocked identities, not just bytes.
    this.registryRead = undefined
    // Bytes last read or published for this registry. A sweep compares current
    // bytes with this authority before trusting a fresh read.
    this.registryAuthority = undefined
    // The application could not read the registry file at all. This is not
    // evidence that it is absent; no destructive pass may run.
    this.registryUnreadable = false
    // Fresh bytes required settlement but the stored listing was unavailable.
    // Keep the evidence gated until a later complete listing settles it.
    this.settlementPending = false
    // A foreign version is never interpreted and never healed.
    this.registryUnsupported = false
    // Top-level framing is ambiguous (for example duplicate `sessions` maps).
    // The original is never interpreted, healed, published over or deleted from.
    this.registryAmbiguous = false
    // Recovery evidence that has not yet been published.
    this.registryUnresolved = []
    this.registrySources = []
    this.registryRecovered = false
    // Journal-owned ids whose registry row disagrees with the journal or header.
    // They stay out of the state and the exit snapshot, and healing defers.
    this.registryDisputed = new Set()
    // Recovery-log lines produced before the journal is validated. They are
    // dropped when the journal is degraded, so a degraded boot writes nothing.
    this.pendingRecoveryLog = []
    // The ownership journal is unreadable or invalid; delete nothing and write nothing.
    this.journalDegraded = false
    // A signal or process exit has closed admission for new temporary writes.
    this.admissionClosed = false
    this.queue = Promise.resolve()
    // Announcements observed before their journal and registry work finished.
    // Kept in order so a failed journal append can be retried without a restart.
    this.pending = []
    // Ids already logged during this boot, so a quarantine or unresolved child
    // is reported once rather than on every fixed-point pass.
    this.logged = new Set()
    // Observed children whose journal append failed; their identity and parent
    // anchor stay here until a later pass writes the event.
    this.retryQueue = new Set()
    // Pending members whose stop has been confirmed in this instance. A member
    // that is pending but not here still has work to stop and is retried.
    this.stopped = new Set()
    // Side chats prepared and natively titled by this live instance. A failed
    // index save or reload leaves these empty so register can finish the work.
    this.sidePrepared = new Set()
    this.sideTitled = new Map()
    this.retryTimer = undefined
    this.retryDelayMs = RETRY_DELAY_MS
    // Optional advisory model pass over the unresolved backlog. It never gates
    // startup and never changes the registry or a deletion decision.
    this.modelSanity = deps.modelSanity
    this.modelPass = undefined
    this.expiryTimer = undefined
    this.activityTimer = undefined
    this.activitySaveAt = 0
    this.expiryInFlight = false
    this.expiryQueued = false
    // Real events observed before the serialized activity task runs. The expiry
    // pre-commit recheck reads this map, so an event delivered while the sweep
    // is awaiting a busy probe still aborts the mark.
    this.observedActivity = new Map()
    // The stored snapshots behind the last successful list, keyed by Session id.
    // A snapshot with a numeric sizeBytes is a materialized artifact; a snapshot
    // without one is a backend pending creation.
    this.storedSnapshots = new Map()
    // Ids observed with a real artifact during this instance. A later pending
    // snapshot for one of these means the artifact disappeared unexpectedly.
    this.materializedIds = new Set()
    this.expiryWarned = new Set()
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now()
    // Injected seam for a degraded reconciliation pass. Real detection is
    // owned by the degraded-mode ticket; this flag only suppresses registry
    // writes and deletion while journal observations still proceed.
    this.reconciliationDegraded = deps.degraded === true
    // Startup has completed the full boot sequence.
    this.ready = false
    this.startPromise = undefined
    this.journal = replayJournal('')
    // The valid journal bytes this instance has replayed; appends extend it.
    this.journalSource = ''
    this.marker = undefined
    // Stored headers from the last load, for record/header agreement checks.
    this.storedHeaders = undefined
    this.bootStoredHeaders = undefined
    this.storedListingComplete = false
    // A failed listing leaves complete registry rows unvalidated; defer writes
    // and deletion until a later listing succeeds.
    this.listingUncertain = false
    // The first migration has not completed; no durable ownership write is safe.
    this.migrationIncomplete = true
    // A boot whose registry was unreadable skipped startup stages. A later
    // readable reap resumes reservations and migration before reconciliation.
    this.startupStagesPending = false
    // Migration corrected a legacy field in memory and needs a registry publish.
    this.registryChanged = false
    this.sequence = 0
    this.publisher = new Publisher({ file: this.paths.file, lockFile: this.paths.lock, logger: deps.logger })
    this.recovery = new RecoveryStore({ paths: this.paths, logger: deps.logger })
    this.snapshot = Object.freeze({ degraded: false, sessions: Object.freeze([]) })
  }

  /** Run one mutation after every mutation already queued. */
  enqueue(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Stop a pending automatic retry. */
  clearRetryTimer() {
    if (this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  /**
   * Schedule one bounded automatic retry while protected observations remain.
   * The delay grows after each failed attempt and one timer is live at a time.
   * @returns {void}
   */
  scheduleRetry() {
    if (this.retryTimer !== undefined
      || !this.needsRetry()
      || this.admissionClosed
      || this.journalDegraded
      || this.loadFailed) return
    const delay = this.retryDelayMs
    const timer = setTimeout(() => {
      if (this.retryTimer !== timer) return
      this.retryTimer = undefined
      if (!this.needsRetry()
        || this.admissionClosed
        || this.loadFailed
        || this.journalDegraded) {
        this.retryDelayMs = RETRY_DELAY_MS
        return
      }
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_DELAY_MS)
      this.retryObserved().catch((error) => {
        this.warn(`could not retry temporary-session cleanup: ${String(error)}`)
        this.scheduleRetry()
      })
    }, delay)
    this.retryTimer = timer
    timer.unref?.()
  }

  /**
   * Whether a protected observation or a pending tree still needs a pass. A
   * pending tree is reconciled even after every member is confirmed, because
   * an Agent or owned job can start work again while the folder waits.
   */
  needsRetry() {
    return this.retryQueue.size > 0 || this.hasPendingStops()
  }

  /** Whether any record is still pending deletion. */
  hasPendingStops() {
    for (const record of Object.values(this.state.sessions)) {
      if (record?.pendingDelete === true) return true
    }
    return false
  }

  /** Report a condition a human may need to read later. */
  warn(message) {
    this.deps.logger?.warn?.(message)
  }

  /** Buffer one recovery-log line until the ownership journal is validated. */
  logRecovery(event, details = {}) {
    this.pendingRecoveryLog.push({ event, details })
  }

  /** Emit buffered recovery-log lines after a healthy journal replay. */
  flushRecoveryLog() {
    const entries = this.pendingRecoveryLog
    this.pendingRecoveryLog = []
    for (const entry of entries) this.recovery.log(entry.event, entry.details)
  }

  /** Emit one ordered stop-path step for the logger or a probe. */
  trace(message) {
    try {
      if (typeof this.deps.trace === 'function') this.deps.trace(message)
      else this.deps.logger?.info?.(message)
    } catch {
      // A trace sink must never break the stop it observes.
    }
  }

  /** Close admission for new temporary writes before process cleanup. */
  closeAdmission() {
    this.admissionClosed = true
    this.clearRetryTimer()
    this.clearExpiryTimers()
    this.modelSanity?.abort?.()
  }

  /** Stop the expiry and activity timers when the plugin instance unloads. */
  clearExpiryTimers() {
    if (this.expiryTimer !== undefined) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = undefined
    }
    if (this.activityTimer !== undefined) {
      clearTimeout(this.activityTimer)
      this.activityTimer = undefined
    }
  }

  /** Start the hourly expiry sweep once per loaded instance. */
  startExpiryTimer() {
    if (this.expiryTimer !== undefined || this.admissionClosed) return
    this.expiryTimer = setInterval(() => {
      this.sweepExpiry().catch(error => {
        this.warn(`temporary-session expiry sweep failed: ${String(error)}`)
      })
    }, EXPIRY_SWEEP_MS)
    this.expiryTimer.unref?.()
  }

  /**
   * Record real activity from a Session event. Activity is only a hint for the
   * expiry clock; it never authorises a deletion. A missing record is ignored.
   * @param {object} session - Session carrying the event.
   * @param {object} event - canonical Session event.
   * @returns {Promise<void>} settles after the coalesced save decision.
   */
  noteActivity(session, event) {
    const sessionId = session?.header?.id ?? session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return Promise.resolve()
    if (!isActivityEvent(event)) return Promise.resolve()
    const at = Number.isSafeInteger(event?.time) ? event.time : this.now()
    // Publish the observation synchronously so a sweep already waiting on a
    // busy probe sees it in its pre-commit recheck, even though the serialized
    // registry update below runs after that sweep.
    const observed = this.observedActivity.get(sessionId) ?? 0
    if (at > observed) this.observedActivity.set(sessionId, at)
    return this.enqueue(async () => {
      await this.load()
      if (this.loadFailed
        || this.journalDegraded
        || this.registryUnsupported
        || this.registryAmbiguous
        || this.reconciliationDegraded) return
      const record = this.state.sessions[sessionId]
      if (record === undefined) {
        this.observedActivity.delete(sessionId)
        return
      }
      const latest = Math.max(at, this.observedActivity.get(sessionId) ?? 0)
      const previous = Math.max(record.lastActivityAt ?? 0, record.activitySince ?? 0)
      if (latest <= previous) {
        this.observedActivity.delete(sessionId)
        return
      }
      record.lastActivityAt = latest
      this.observedActivity.delete(sessionId)
      this.refreshSnapshot()
      await this.persistActivity()
    })
  }

  /** Save activity at most once per minute; retain the in-memory clock meanwhile. */
  async persistActivity() {
    const now = this.now()
    const due = this.activitySaveAt + ACTIVITY_SAVE_MS
    if (this.activitySaveAt !== 0 && now < due) {
      if (this.activityTimer === undefined) {
        this.activityTimer = setTimeout(() => {
          this.activityTimer = undefined
          this.enqueue(async () => {
            await this.load()
            await this.persistActivity()
          }).catch(error => this.warn(`could not save temporary-session activity: ${String(error)}`))
        }, Math.max(1, due - now))
        this.activityTimer.unref?.()
      }
      return
    }
    this.activitySaveAt = now
    try {
      await this.save()
    } catch (error) {
      this.warn(`could not save temporary-session activity: ${String(error)}`)
    }
  }

  /** Log one expiry skip once per Session instead of on every hourly sweep. */
  warnExpiryOnce(key, message) {
    if (this.expiryWarned.has(key)) return
    this.expiryWarned.add(key)
    this.warn(message)
  }

  /**
   * Classify one record's stored artifact for the expiry clock.
   *
   * The real JSONL listing includes a numeric `sizeBytes` for every materialized
   * artifact, including a selected historical generation, and omits it for a
   * created-but-unmaterialized Session. A pending Session that was materialized
   * before and is now missing is not trustworthy deletion evidence, so the tree
   * is skipped. A direct filesystem check covers a listing that predates a live
   * registration or a fake backend that omits `sizeBytes`.
   * @param {object} record - one validated registry record.
   * @returns {{ materialized: boolean, skip?: boolean }} artifact class.
   */
  expiryArtifact(record) {
    const sessionId = record.sessionId
    const snapshot = this.storedSnapshots.get(sessionId)
    if (snapshot !== undefined && typeof snapshot.sizeBytes === 'number') {
      this.materializedIds.add(sessionId)
      return { materialized: true }
    }
    const header = this.headerFor(record)
    const storage = header === undefined ? undefined : this.resolveStorage(header)
    if (storage !== undefined) {
      try {
        statSync(storage.artifact)
        this.materializedIds.add(sessionId)
        return { materialized: true }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.warnExpiryOnce(`io:${sessionId}`, `skipping expired temporary session "${sessionId}": its artifact could not be read (${String(error)})`)
          return { materialized: false, skip: true }
        }
      }
      try {
        const historical = readdirSync(storage.dir).some(name => name.startsWith('session.') && name !== basename(storage.artifact))
        if (historical) {
          this.materializedIds.add(sessionId)
          return { materialized: true }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.warnExpiryOnce(`dir:${sessionId}`, `skipping expired temporary session "${sessionId}": its artifact directory could not be read (${String(error)})`)
          return { materialized: false, skip: true }
        }
      }
    }
    if (this.materializedIds.has(sessionId)
      || (snapshot === undefined && (record.lastActivityAt ?? 0) > (record.createdAt ?? 0))) {
      this.warnExpiryOnce(`missing:${sessionId}`, `skipping expired temporary session "${sessionId}": its previously materialized artifact is missing`)
      return { materialized: false, skip: true }
    }
    // A snapshot without `sizeBytes` is an affirmative listing of a backend
    // pending creation. A pending creation that was materialized before is
    // caught by `materializedIds`; an activity clock here is not an artifact.
    // A snapshot that is absent entirely and has no artifact on disk is only
    // trusted as unmaterialized when the record never moved past creation.
    return { materialized: false }
  }

  /**
   * The newest activity clock in one tree. A materialized record without a
   * clock is stamped now and saved, so it receives one full expiry window. An
   * unmaterialized backend creation uses its creation time instead; file mtimes
   * never participate.
   * @param {object[]} members - tree records.
   * @param {number} now - sweep clock.
   * @returns {{ clock: number, changed: boolean, skip: boolean }} tree clock.
   */
  treeActivity(members, now) {
    let clock = 0
    let changed = false
    for (const record of members) {
      const artifact = this.expiryArtifact(record)
      if (artifact.skip) return { clock, changed, skip: true }
      let value = artifact.materialized
        ? Math.max(record.lastActivityAt ?? 0, record.activitySince ?? 0, this.observedActivity.get(record.sessionId) ?? 0)
        : Math.max(record.createdAt ?? 0, this.observedActivity.get(record.sessionId) ?? 0)
      if (!Number.isSafeInteger(value) || value <= 0) {
        record.lastActivityAt = now
        record.activitySince = now
        value = now
        changed = true
      }
      if (value > clock) clock = value
    }
    return { clock, changed, skip: false }
  }

  /**
   * Group non-pending records into trees by their direct parent. A record whose
   * parent is not recorded is a root; a pending tree is terminal and skipped.
   * @returns {object[][]} tree member lists.
   */
  expiryTrees() {
    const records = Object.values(this.state.sessions).filter(record => record !== null && typeof record === 'object')
    const byId = new Map(records.map(record => [record.sessionId, record]))
    const children = new Map()
    for (const record of records) {
      const parent = typeof record.parentSessionId === 'string' && byId.has(record.parentSessionId)
        ? record.parentSessionId
        : undefined
      if (parent === undefined) continue
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(record)
    }
    const trees = []
    const seen = new Set()
    const visit = (record, members) => {
      if (record === undefined || seen.has(record.sessionId)) return
      seen.add(record.sessionId)
      members.push(record)
      for (const child of children.get(record.sessionId) ?? []) visit(child, members)
    }
    for (const record of records) {
      if (typeof record.parentSessionId === 'string' && byId.has(record.parentSessionId)) continue
      const members = []
      visit(record, members)
      if (members.some(member => member.pendingDelete === true)) continue
      trees.push(members)
    }
    return trees
  }

  /** Whether any member of a tree has live work that forbids expiry. */
  async expiryBusy(members) {
    for (const record of members) {
      const sessionId = record.sessionId
      const agent = this.deps.agents?.get?.(sessionId)
      if (agent !== undefined && agent !== null) {
        if (agent.status === 'running') return true
        if (agent.activeStream === true || agent.streaming === true || agent.activeTool !== undefined) return true
        if (await this.confirmIdle(agent, sessionId) === false) return true
      }
      const session = this.deps.sessions.get(sessionId)
      if (session !== undefined && (session.activeStream === true || session.streaming === true || session.activeTool !== undefined)) return true
      try {
        if (this.ownedJobs(sessionId).length > 0) return true
      } catch {
        return true
      }
    }
    return false
  }

  /**
   * Run one serialized expiry transaction. The whole tree is rechecked just
   * before the durable pending append; an event observed in that window aborts
   * the mark.
   * @param {number} [now] - injected clock for tests and the sweep timer.
   * @returns {Promise<boolean>} whether a tree was marked.
   */
  sweepExpiry(now = this.now()) {
    if (this.expiryInFlight) {
      this.expiryQueued = true
      return Promise.resolve(false)
    }
    this.expiryInFlight = true
    const run = this.enqueue(async () => {
      await this.load()
      if (this.loadFailed
        || this.journalDegraded
        || this.registryUnsupported
        || this.registryAmbiguous
        || this.registryDegraded
        || this.listingUncertain
        || this.migrationIncomplete
        || this.reconciliationDegraded
        || this.admissionClosed) return false
      // Re-read the stored-session listing at the start of every sweep. A
      // backend pending creation is only visible here while it is unmaterialized;
      // a listing failure is an I/O skip, not evidence that the tree is idle.
      if (await this.listStored() === undefined) return false
      let marked = false
      for (const members of this.expiryTrees()) {
        const activity = this.treeActivity(members, now)
        if (activity.skip) continue
        if (activity.changed) {
          this.activitySaveAt = now
          await this.save()
        }
        if (now - activity.clock < EXPIRY_WINDOW_MS) continue
        if (await this.expiryBusy(members)) continue
        // Yield once so an event delivered by the Host can be observed before
        // the durable pending append. The same tree must still be unchanged.
        await Promise.resolve()
        const ids = members.map(record => record.sessionId)
        const current = ids.map(id => this.state.sessions[id])
        if (current.some((record, index) => record === undefined || record !== members[index])) continue
        // Recompute the same tree clock after the yield. For a materialized
        // artifact a new record clock wins; for a backend pending creation only
        // a synchronously observed event can move the clock.
        const recheck = this.treeActivity(current, now)
        if (recheck.skip || recheck.clock > activity.clock) continue
        // Work can start while the busy probe above is awaiting whenIdle() or
        // while the microtask yield runs. Recheck work as well as the clock
        // immediately before the durable pending append.
        if (await this.expiryBusy(current)) continue
        const finalActivity = this.treeActivity(current, now)
        if (finalActivity.skip || finalActivity.clock > activity.clock) continue
        try {
          await this.appendEvent({
            type: 'pending',
            sessionIds: ids,
            reason: 'expiry',
            at: now,
          })
        } catch (error) {
          this.warn(`could not mark expired temporary sessions: ${String(error)}`)
          continue
        }
        this.markMembers(members)
        try {
          await this.save()
        } catch (error) {
          this.warn(`could not save expired temporary sessions: ${String(error)}`)
        }
        this.refreshSnapshot()
        await this.stopMembers(members)
        marked = true
      }
      return marked
    })
    return run.finally(() => {
      this.expiryInFlight = false
      if (this.expiryQueued) {
        this.expiryQueued = false
        this.sweepExpiry(this.now()).catch(error => this.warn(`temporary-session expiry sweep failed: ${String(error)}`))
      }
    })
  }


  /**
   * Read the registry once and reconcile it with the ownership journal.
   *
   * The order is the one the exit snapshot depends on: read the registry and
   * the stored headers, validate and replay the journal, resolve the
   * reservations replay exposes, run or resume the first migration, rebuild
   * every journal-owned record the index lost, reconcile stored and observed
   * children to a fixed point, then publish the in-memory snapshot.
   */
  load() {
    if (this.loaded) return Promise.resolve(this.state)
    if (this.loadFailed) return Promise.resolve(this.state)
    if (this.loadPromise !== undefined) return this.loadPromise
    this.loadPromise = this.loadOnce().catch((error) => {
      // The partially read state is not writable; `migrationIncomplete` and the
      // degraded flags gate every mutation. Do not retry a failed boot inside
      // the same instance, where a half-applied pass could be observed.
      this.loadFailed = true
      this.loadError = error
      this.loadPromise = undefined
      // The partial boot is not deletion evidence. Keep exit cleanup empty
      // until a fresh instance completes the read.
      this.snapshot = Object.freeze({ degraded: true, sessions: Object.freeze([]) })
      throw error
    })
    return this.loadPromise
  }

  /**
   * Run the one boot read and reconciliation. Concurrent callers share
   * `loadPromise`, so an announcement that arrives during the stored listing is
   * drained after replay rather than being told the boot is already complete.
   * @returns {Promise<object>} the loaded registry state.
   */
  async loadOnce() {
    const now = Date.now()
    const stored = await this.listStored()
    this.storedHeaders = stored
    this.bootStoredHeaders = stored
    this.storedListingComplete = stored !== undefined
    this.listingUncertain = stored === undefined
    this.registryDisputed = new Set()
    this.registryAmbiguous = false
    this.pendingRecoveryLog = []
    const registry = await this.readRegistry(stored, now)
    this.state = registry.state
    this.registryDegraded = registry.damaged
    this.registryContext = registry.context
    this.registryRead = registry
    this.registryAuthority = registry.context?.bytes ?? Buffer.alloc(0)
    this.registryUnreadable = registry.unreadable === true
    this.registryUnsupported = registry.unsupported === true
    this.registryAmbiguous = registry.context?.inspection?.ambiguous === true
    this.registryUnresolved = [...(registry.unresolved ?? [])]
    this.registrySources = [...(registry.sources ?? [])]
    this.registryRecovered = false
    if (this.registryContext !== undefined) {
      this.registryContext.damaged = registry.damaged
      this.registryContext.missing = registry.missing === true
    }
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
    if (this.journal.torn && !this.journalDegraded && file.exists === true) {
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
    // Registry diagnostics may mention untrusted bytes, and a degraded journal
    // must write nothing. Emit them only after the journal is proven healthy.
    if (this.journalDegraded || this.registryUnsupported || this.registryAmbiguous) {
      this.pendingRecoveryLog = []
    } else {
      this.flushRecoveryLog()
    }
    if (this.registryUnreadable) {
      // The journal is usable, but the registry-backed startup stages were
      // skipped. A later readable reap must run them before readiness.
      this.startupStagesPending = true
      this.migrationIncomplete = this.marker === undefined && this.journal.migrationComplete === undefined
    }
    this.publisher.setDegraded(this.journalDegraded || this.registryDegraded)
    let healed = false
    if (!this.journalDegraded && !this.registryUnsupported && !this.registryAmbiguous && !this.registryUnreadable) {
      try {
        // The spec order is replay, reservations, heal/import, reconcile, then
        // drain announcements that arrived while the listing was being taken.
        await this.resolveReservations(stored)
        await this.migrate(registry, stored)
        this.migrationIncomplete = this.marker === undefined && this.journal.migrationComplete === undefined
        // A readable boot can still leave the first migration unresolved, for
        // example because a missing source needs a preserved slot. Retry that
        // startup stage on the next readable reap instead of stranding it.
        if (this.migrationIncomplete) this.startupStagesPending = true
        const settled = this.settleRegistry(registry, stored)
        if (registry.damaged) this.registryDegraded = true
        healed = this.healFromJournal(stored) || settled
        const reconciled = await this.reconcileFixedPoint(stored)
        healed = this.healFromJournal(stored) || healed
        if (registry.damaged && Object.keys(this.state.sessions).length > 0) {
          this.registryRecovered = true
        }
        if (this.registryRecovered) healed = true
        if (this.registryDegraded && this.registryRecovered) {
          const repaired = this.repairRegistry(registry)
          if (repaired) healed = false
        }
        if ((healed || this.registryChanged || reconciled.adopted || reconciled.observed)
          && !this.registryDegraded
          && !this.reconciliationDegraded) await this.save()
      } catch (error) {
        // A load that failed after replay leaves ownership uncertain; keep every
        // durable write refused until a fresh load completes the migration.
        this.migrationIncomplete = true
        throw error
      }
    }
    this.loaded = true
    this.refreshSnapshot()
    if (!this.journalDegraded && !this.registryUnsupported && !this.registryAmbiguous && !this.registryUnreadable) await this.resumePendingStops()
    return this.state
  }

  /**
   * Complete the boot sequence and publish readiness. The session-created
   * listener is installed by the Host before this runs; any announcement it
   * receives is in the observed queue and is drained before the ready promise
   * settles. Re-running start returns the same promise.
   * @returns {Promise<object>} the loaded registry state.
   */
  start() {
    if (this.ready) return Promise.resolve(this.state)
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.reap().then(() => {
      this.ready = true
      this.startExpiryTimer()
      this.startModelSanity()
      this.sweepExpiry().catch(error => {
        this.warn(`temporary-session startup expiry sweep failed: ${String(error)}`)
      })
      return this.state
    }, (error) => {
      this.startPromise = undefined
      throw error
    })
    return this.startPromise
  }

  /**
   * Validate one model proposal against this boot's trusted context. The
   * worker passes the exact backlog bytes and sanitized answer; the model
   * never supplies the map key, membership, header, journal ownership or
   * storage path.
   * @param {{ bytes: Buffer }} entry - one backlog entry.
   * @param {object} answer - sanitized model answer.
   * @returns {{ accepted: boolean, reason: string }} verdict.
   */
  validateModelFragment(entry, answer) {
    const bytes = Buffer.from(entry.bytes ?? [])
    const fragment = inspectFragment(bytes)
    const sessionId = fragment.key
    const entryState = typeof sessionId === 'string' ? this.journal?.entries?.[sessionId] : undefined
    const header = typeof sessionId === 'string'
      ? (this.storedHeaders?.get(sessionId) ?? this.deps.sessions?.get?.(sessionId)?.header)
      : undefined
    const storage = header === undefined ? undefined : this.resolveStorage(header)
    return validateModelProposal(bytes, answer, {
      members: new Set(this.registrySources),
      journalEntry: entryState,
      header,
      storageDir: storage?.dir,
    })
  }

  /**
   * Start the advisory model pass after the deterministic boot sequence. The
   * pass is deliberately not awaited: a slow or unavailable gateway cannot
   * delay readiness, and its findings only reach the private recovery log.
   * @returns {Promise<object | undefined>} the pass result when a worker exists.
   */
  startModelSanity() {
    if (this.modelSanity === undefined
      || this.admissionClosed
      || this.journalDegraded
      || this.registryUnsupported
      || this.registryAmbiguous
      || this.registryUnreadable) return Promise.resolve(undefined)
    if (this.modelPass !== undefined) return this.modelPass
    this.modelPass = Promise.resolve()
      .then(() => this.modelSanity.start())
      .catch(error => {
        this.warn(`temporary-session model sanity pass failed: ${String(error)}`)
        return undefined
      })
      .finally(() => { this.modelPass = undefined })
    return this.modelPass
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
      const byId = new Map()
      for (const snapshot of snapshots) {
        const id = snapshot?.header?.id
        if (typeof id !== 'string') continue
        headers.set(id, snapshot.header)
        byId.set(id, snapshot)
      }
      this.storedSnapshots = byId
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
   * Read the registry index with exact spans. The journal is not available yet,
   * so this pass only proves that a member is complete, belongs to the
   * top-level `sessions` map and agrees with a stored header. Journal
   * ownership and first-migration admission are settled after replay.
   * @param {Map<string, object> | undefined} stored - stored headers, when available.
   * @param {number} now - current wall clock for records without a clock.
   * @returns {Promise<object>} recovered state and unresolved evidence.
   */
  async readRegistry(stored, now) {
    let bytes
    try {
      bytes = await readFile(this.paths.file)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warn(`could not read the temporary-session registry: ${String(error)}`)
        return {
          state: emptyState(),
          damaged: true,
          missing: false,
          unreadable: true,
          unsupported: false,
          context: undefined,
        }
      }
      return {
        state: emptyState(),
        damaged: false,
        missing: true,
        unreadable: false,
        unsupported: false,
        context: undefined,
      }
    }
    const inspection = inspectRegistry(bytes)
    const context = { bytes, inspection, keyOnly: new Set(), blocked: new Map() }
    if (inspection.ambiguous) {
      this.registryAmbiguous = true
      this.registryUnsupported = false
      this.warn('ignoring a temporary-session registry with ambiguous top-level framing')
      return {
        state: emptyState(),
        damaged: true,
        missing: false,
        unsupported: false,
        context,
        sources: [],
        unresolved: [],
      }
    }
    this.registryAmbiguous = false
    if (!inspection.supported) {
      const unsupported = inspection.versionPresent === true
      this.registryUnsupported = unsupported
      if (unsupported && !this.registryDegraded) {
        this.warn(`ignoring unsupported temporary-session registry at ${this.paths.file}`)
      } else if (!this.registryDegraded) {
        this.warn('ignoring unparsable temporary-session registry')
      }
      return {
        state: emptyState(),
        damaged: true,
        missing: false,
        unsupported,
        context,
        sources: [],
        unresolved: [],
      }
    }
    this.registryUnsupported = false
    const sessions = {}
    const unresolved = [...inspection.unresolved]
    const sources = new Set()
    for (const member of inspection.members) {
      if (typeof member.key === 'string' && member.key !== '') sources.add(member.key)
      if (member.invalid !== undefined) {
        this.warn(`quarantining a temporary-session registry member at byte ${member.offset}: ${member.invalid}`)
        this.logRecovery('quarantined', { offset: member.offset, reason: member.invalid })
        unresolved.push({ offset: member.offset, reason: member.invalid, bytes: member.bytes })
        if (member.invalid === 'truncated-member') {
          const key = member.key
          const ids = Array.isArray(member.partialSessionIds) ? member.partialSessionIds : []
          if (member.partialBlocked === true) {
            if (typeof key === 'string' && key !== '') context.blocked.set(key, 'truncated-member')
            for (const id of ids) {
              if (typeof id === 'string' && id !== '') context.blocked.set(id, 'truncated-member')
            }
          } else if (member.sessionIdPresent !== true) {
            if (typeof key === 'string' && key !== '') context.blocked.set(key, 'truncated-member')
            for (const id of ids) {
              if (typeof id === 'string' && id !== '') context.blocked.set(id, 'key-mismatch')
            }
          } else if (member.sessionId !== key) {
            if (typeof key === 'string' && key !== '') context.blocked.set(key, 'key-mismatch')
            if (typeof member.sessionId === 'string' && member.sessionId !== '') {
              context.blocked.set(member.sessionId, 'key-mismatch')
            }
          }
        } else if (typeof member.key === 'string' && member.key !== '') {
          context.blocked.set(member.key, member.invalid)
        }
        // A key that names another Session is a detectable disagreement for
        // both ids. Do not let the named journal-owned id be rebuilt as though
        // the row had never existed.
        if (member.invalid === 'key-mismatch'
          && typeof member.sessionId === 'string'
          && member.sessionId !== '') {
          context.blocked.set(member.sessionId, member.invalid)
        }
        continue
      }
      if (stored === undefined) {
        const raw = readRecord(member.value, member.key, now)
        if (raw === undefined) {
          unresolved.push({ offset: member.offset, reason: 'unusable-record', bytes: member.bytes })
          continue
        }
        sessions[member.key] = raw
        if (member.sessionIdPresent !== true) context.keyOnly.add(member.key)
        continue
      }
      const recovered = this.registryRecordFromMember(member, stored, now)
      if (recovered.record === undefined) {
        this.warn(`quarantining a temporary-session registry member at byte ${member.offset}: ${recovered.reason}`)
        this.logRecovery('quarantined', { offset: member.offset, reason: recovered.reason })
        unresolved.push({ offset: member.offset, reason: recovered.reason, bytes: member.bytes })
        context.blocked.set(member.key, recovered.reason)
        continue
      }
      sessions[member.key] = recovered.record
      if (member.sessionIdPresent !== true) context.keyOnly.add(member.key)
    }
    const damaged = !inspection.complete || unresolved.length > 0
    return {
      state: { version: STATE_VERSION, sessions },
      damaged,
      missing: false,
      unsupported: false,
      context,
      sources: [...sources],
      unresolved,
    }
  }

  /**
   * Read the current registry bytes before a destructive sweep. A file that
   * changed after boot may be unsupported or damaged; the fresh read lets the
   * sweep fail closed or run the healing transaction without trusting stale
   * bytes. The state already loaded is retained; only authority and evidence
   * change here.
   * @param {Map<string, object> | undefined} stored - stored headers for the sweep.
   * @returns {Promise<object>} the fresh registry read.
   */
  async refreshRegistryRead(stored) {
    const current = await this.readRegistry(stored, Date.now())
    const previous = this.registryAuthority
    const bytes = current.context?.bytes
    const changed = previous !== undefined
      && (bytes === undefined || !bytes.equals(previous))
    this.registryRead = current
    this.registryContext = current.context
    this.registryUnresolved = [...(current.unresolved ?? [])]
    this.registrySources = [...(current.sources ?? [])]
    this.registryDegraded = current.damaged
    this.registryUnreadable = current.unreadable === true
    this.registryUnsupported = current.unsupported === true
    this.registryAmbiguous = current.context?.inspection?.ambiguous === true
    this.registryAuthority = bytes ?? Buffer.alloc(0)
    current.changed = changed
    if (changed && current.context?.inspection?.supported === false) {
      // A file that changed into unreadable bytes after a successful read is
      // evidence to preserve, not a repair target for this sweep.
      this.registryUnsupported = true
    }
    if (this.registryContext !== undefined) {
      this.registryContext.damaged = current.damaged
      this.registryContext.missing = current.missing === true
    }
    return current
  }

  /**
   * Cross-check one complete member against the stored header. The source
   * folder, parent, kind and clocks are never trusted on their own.
   * @param {object} member - scanned member with exact key and value.
   * @param {Map<string, object>} stored - stored headers.
   * @param {number} now - bootstrap clock.
   * @returns {{ record?: object, reason?: string }} the validated record or quarantine reason.
   */
  registryRecordFromMember(member, stored, now) {
    const key = member.key
    if (typeof key !== 'string' || key === '' || key.length > 200) return { reason: 'invalid-key' }
    const value = member.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { reason: 'not-object' }
    if (member.sessionIdPresent === true && member.sessionId !== key) return { reason: 'key-mismatch' }
    const header = stored.get(key) ?? this.deps.sessions.get(key)?.header
    if (header === undefined) return { reason: 'no-header' }
    const storage = this.resolveStorage(header)
    if (storage === undefined) return { reason: 'no-locator' }
    if (value.dir !== undefined && value.dir !== storage.dir) return { reason: 'dir-mismatch' }
    if (value.cwd !== undefined && value.cwd !== (header.cwd ?? null)) return { reason: 'cwd-mismatch' }
    const headerKind = kindOfHeader(header)
    let kind = headerKind
    if (value.kind !== undefined) {
      if (typeof value.kind !== 'string' || !RECORD_KINDS.includes(value.kind)) return { reason: 'kind-invalid' }
      const sideAgrees = value.kind === 'side'
        && header.isSeeded === true
        && typeof header.parentSession === 'string'
      if (value.kind !== headerKind && !sideAgrees) return { reason: 'kind-mismatch' }
      kind = value.kind
    }
    const directParent = header.parentSession ?? null
    let parentSessionId = directParent
    if (value.parentSessionId !== undefined) {
      if (value.parentSessionId === null) {
        // An explicit null is a surviving value, not an absent field. It only
        // agrees when the header also has no parent.
        if (directParent !== null) return { reason: 'parent-mismatch' }
      } else {
        if (typeof value.parentSessionId !== 'string') return { reason: 'parent-invalid' }
        if (value.parentSessionId !== directParent) {
          if (!this.legacyParentAgrees(value, header, stored)) return { reason: 'parent-mismatch' }
          parentSessionId = directParent
        }
      }
    }
    if (value.createdAt !== undefined && value.createdAt !== header.createdAt) {
      this.registryChanged = true
    }
    let pendingDelete = false
    if (value.pendingDelete !== undefined) {
      if (typeof value.pendingDelete !== 'boolean') return { reason: 'pending-invalid' }
      pendingDelete = value.pendingDelete
    } else {
      this.logRecovery('pending-absent', { field: 'pendingDelete' })
    }
    try {
      return {
        record: recordFields({
          sessionId: key,
          kind,
          parentSessionId,
          title: typeof value.title === 'string' ? value.title : '',
          dir: storage.dir,
          cwd: header.cwd ?? null,
          createdAt: header.createdAt,
          lastActivityAt: value.lastActivityAt,
          activitySince: value.activitySince,
          pendingDelete,
        }, now),
      }
    } catch {
      return { reason: 'unusable-record' }
    }
  }

  /**
   * Filter recovered rows through the replayed journal and rebuild every
   * journal-owned id the damaged bytes did not yield. A row whose id has no
   * journal entry after migration, or whose fields disagree with the journal
   * or header, is quarantined and recorded as unresolved evidence.
   * @param {object} registry - registry read context.
   * @param {Map<string, object> | undefined} stored - stored headers.
   * @returns {boolean} whether the in-memory registry changed.
   */
  settleRegistry(registry, stored) {
    if (registry === undefined
      || registry.unsupported === true
      || this.registryAmbiguous
      || this.journalDegraded
      || this.migrationIncomplete) return false
    if (stored === undefined) {
      // Without the stored listing, validate every complete row against the
      // live header and journal, then defer publication and deletion. A row
      // whose header is unavailable is uncertain, not a proven disagreement.
      this.listingUncertain = true
      const next = { ...this.state.sessions }
      const quarantined = new Set()
      let changed = this.settleFreshRecords(registry, stored, quarantined)
      for (const sessionId of quarantined) delete next[sessionId]
      for (const [sessionId, reason] of registry.context?.blocked ?? []) {
        if (this.journal.entries[sessionId] === undefined || quarantined.has(sessionId)) continue
        // A journal tombstone resolves the row even when its stored header is
        // gone. Disputing it here would make the next boot permanently degraded.
        if (this.journal.entries[sessionId]?.deleted === true) continue
        if (next[sessionId] !== undefined) {
          delete next[sessionId]
          changed = true
        }
        this.registryDisputed.add(sessionId)
        this.quarantineRegistryRecord(registry, sessionId, reason)
        quarantined.add(sessionId)
        changed = true
      }
      for (const [sessionId, record] of Object.entries(this.state.sessions)) {
        if (quarantined.has(sessionId)) continue
        const entry = this.journal.entries[sessionId]
        if (entry === undefined || entry.deleted === true) {
          delete next[sessionId]
          changed = true
          continue
        }
        const header = this.deps.sessions.get(sessionId)?.header
        const storage = header === undefined ? undefined : this.resolveStorage(header)
        if (header === undefined || storage === undefined) {
          this.listingUncertain = true
          continue
        }
        if (!this.registryEntryAgreesWithHeader(entry, header, storage)) {
          delete next[sessionId]
          this.registryDisputed.add(sessionId)
          this.quarantineRegistryRecord(registry, sessionId, 'journal-header-mismatch')
          changed = true
          continue
        }
        const headerKind = kindOfHeader(header)
        const sideUpgrade = record.kind !== entry.kind
          && entry.kind === 'side'
          && record.kind === headerKind
          && header.isSeeded === true
          && typeof header.parentSession === 'string'
        // A pre-journal subagent row may name a recorded ancestor instead of the
        // direct parent. Without the stored ancestry this cannot be proven, so
        // defer it rather than turn an old collapsed link into a dispute.
        const collapsedParent = record.kind === entry.kind
          && record.kind === 'subagent'
          && record.parentSessionId !== entry.parentSessionId
          && record.dir === entry.dir
          && record.cwd === entry.cwd
          && !(record.pendingDelete === true && entry.pending !== true)
        const disagrees = record.kind !== entry.kind
          || record.parentSessionId !== entry.parentSessionId
          || record.dir !== entry.dir
          || record.cwd !== entry.cwd
          || (record.pendingDelete === true && entry.pending !== true)
        if (disagrees && !sideUpgrade) {
          if (collapsedParent) {
            this.listingUncertain = true
            continue
          }
          delete next[sessionId]
          this.registryDisputed.add(sessionId)
          this.quarantineRegistryRecord(registry, sessionId, 'journal-record-mismatch')
          changed = true
          continue
        }
        if (sideUpgrade && record.kind !== 'side') {
          record.kind = 'side'
          changed = true
        }
        if (entry.pending === true && record.pendingDelete !== true) {
          record.pendingDelete = true
          changed = true
        }
      }
      for (const entry of Object.values(this.journal.entries)) {
        if (entry.deleted === true || quarantined.has(entry.sessionId)) continue
        const partial = registry.context?.inspection?.members?.find(candidate => (
          candidate.key === entry.sessionId && candidate.invalid === 'truncated-member'
        ))
        if (partial === undefined) continue
        const header = this.deps.sessions.get(entry.sessionId)?.header
        const storage = header === undefined ? undefined : this.resolveStorage(header)
        if (header === undefined || storage === undefined) {
          this.listingUncertain = true
          continue
        }
        const disagreement = this.registryEntryAgreesWithHeader(entry, header, storage)
          ? this.partialMemberDisagreement(partial, entry, header, storage)
          : 'journal-header-mismatch'
        if (disagreement === undefined) continue
        delete next[entry.sessionId]
        this.registryDisputed.add(entry.sessionId)
        this.quarantineRegistryRecord(registry, entry.sessionId, disagreement)
        changed = true
      }
      if (changed) {
        this.state = { version: STATE_VERSION, sessions: next }
        if (registry.damaged === true) this.registryRecovered = true
      }
      return changed
    }
    const next = {}
    const quarantined = new Set()
    let changed = this.settleFreshRecords(registry, stored, quarantined)
    for (const [sessionId, reason] of registry.context?.blocked ?? []) {
      if (this.journal.entries[sessionId] === undefined || quarantined.has(sessionId)) continue
      // A journal tombstone resolves the row even when its stored header is
      // gone. Disputing it here would make the next boot permanently degraded.
      if (this.journal.entries[sessionId]?.deleted === true) continue
      this.registryDisputed.add(sessionId)
      this.quarantineRegistryRecord(registry, sessionId, reason)
      quarantined.add(sessionId)
      changed = true
    }
    // A fresh scan can contain a conflicting partial row for an id that is
    // already in memory. Validate that current evidence before accepting the
    // older in-memory record; otherwise a changed file is silently ignored.
    for (const entry of Object.values(this.journal.entries)) {
      if (entry.deleted === true || quarantined.has(entry.sessionId)) continue
      const partial = registry.context?.inspection?.members?.find(candidate => (
        candidate.key === entry.sessionId && candidate.invalid === 'truncated-member'
      ))
      if (partial === undefined) continue
      const header = stored.get(entry.sessionId) ?? this.deps.sessions.get(entry.sessionId)?.header
      const storage = header === undefined ? undefined : this.resolveStorage(header)
      if (header === undefined || storage === undefined) continue
      const disagreement = this.registryEntryAgreesWithHeader(entry, header, storage)
        ? this.partialMemberDisagreement(partial, entry, header, storage)
        : 'journal-header-mismatch'
      if (disagreement === undefined) continue
      this.registryDisputed.add(entry.sessionId)
      this.quarantineRegistryRecord(registry, entry.sessionId, disagreement)
      quarantined.add(entry.sessionId)
      changed = true
    }
    for (const [sessionId, record] of Object.entries(this.state.sessions)) {
      if (quarantined.has(sessionId)) continue
      const entry = this.journal.entries[sessionId]
      if (entry === undefined) {
        this.quarantineRegistryRecord(registry, sessionId, 'no-journal-entry')
        quarantined.add(sessionId)
        changed = true
        continue
      }
      if (entry.deleted === true) {
        this.quarantineRegistryRecord(registry, sessionId, 'journal-deleted')
        quarantined.add(sessionId)
        changed = true
        continue
      }
      const header = stored.get(sessionId) ?? this.deps.sessions.get(sessionId)?.header
      if (header === undefined) {
        this.quarantineRegistryRecord(registry, sessionId, 'no-header')
        quarantined.add(sessionId)
        changed = true
        continue
      }
      const storage = this.resolveStorage(header)
      if (!this.registryEntryAgreesWithHeader(entry, header, storage)) {
        this.registryDisputed.add(sessionId)
        this.quarantineRegistryRecord(registry, sessionId, 'journal-header-mismatch')
        quarantined.add(sessionId)
        changed = true
        continue
      }
      const keyOnly = registry.context?.keyOnly?.has(sessionId) === true
      const headerKind = kindOfHeader(header)
      const sideUpgrade = record.kind !== entry.kind
        && entry.kind === 'side'
        && record.kind === headerKind
        && header.isSeeded === true
        && typeof header.parentSession === 'string'
      if (sideUpgrade) {
        // The side upgrade journals first and publishes the index second. A
        // crash in that interval is repaired from the journal, keeping title.
        record.kind = 'side'
        changed = true
      }
      const disagrees = record.kind !== entry.kind
        || record.parentSessionId !== entry.parentSessionId
        || record.dir !== entry.dir
        || record.cwd !== entry.cwd
        || (record.pendingDelete === true && entry.pending !== true)
      // The old recorder collapsed a subagent onto its nearest recorded
      // ancestor. With the stored ancestry available, keep that provable link
      // so healFromJournal can migrate it to the direct parent below.
      const collapsedParent = record.kind === entry.kind
        && record.kind === 'subagent'
        && record.parentSessionId !== entry.parentSessionId
        && record.dir === entry.dir
        && record.cwd === entry.cwd
        && !(record.pendingDelete === true && entry.pending !== true)
        && this.legacyParentAgrees(record, header, stored)
      if ((disagrees && !collapsedParent) || keyOnly) {
        if (disagrees && !collapsedParent) {
          this.registryDisputed.add(sessionId)
          this.quarantineRegistryRecord(registry, sessionId, 'journal-record-mismatch')
          quarantined.add(sessionId)
          changed = true
          continue
        }
        const rebuilt = this.journalRecord(entry, header, storage, record.title)
        if (rebuilt === undefined) {
          this.quarantineRegistryRecord(registry, sessionId, 'unusable-journal-record')
          quarantined.add(sessionId)
        } else {
          next[sessionId] = rebuilt
        }
        changed = true
        continue
      }
      if (entry.pending === true && record.pendingDelete !== true) {
        record.pendingDelete = true
        changed = true
      }
      next[sessionId] = record
    }
    for (const entry of Object.values(this.journal.entries)) {
      if (entry.deleted === true || next[entry.sessionId] !== undefined || quarantined.has(entry.sessionId)) continue
      const header = stored.get(entry.sessionId) ?? this.deps.sessions.get(entry.sessionId)?.header
      if (header === undefined) continue
      const storage = this.resolveStorage(header)
      if (!this.registryEntryAgreesWithHeader(entry, header, storage)) {
        this.quarantineRegistryRecord(registry, entry.sessionId, 'journal-header-mismatch')
        quarantined.add(entry.sessionId)
        changed = true
        continue
      }
      const partial = registry.context?.inspection?.members?.find(candidate => (
        candidate.key === entry.sessionId && candidate.invalid === 'truncated-member'
      ))
      const partialDisagreement = partial === undefined
        ? undefined
        : this.partialMemberDisagreement(partial, entry, header, storage)
      if (partialDisagreement !== undefined) {
        this.registryDisputed.add(entry.sessionId)
        this.quarantineRegistryRecord(registry, entry.sessionId, partialDisagreement)
        quarantined.add(entry.sessionId)
        changed = true
        continue
      }
      const rebuilt = this.journalRecord(entry, header, storage)
      if (rebuilt === undefined) continue
      next[entry.sessionId] = rebuilt
      this.recovery.log('adopted', { id: entry.sessionId, reason: 'journal-only' })
      this.warn(`rebuilt the temporary-session record for "${entry.sessionId}" from the ownership journal`)
      changed = true
    }
    if (changed) {
      this.state = { version: STATE_VERSION, sessions: next }
      if (registry.damaged === true) this.registryRecovered = true
    }
    return changed
  }

  /**
   * Whether one journal identity agrees with the stored header it claims.
   * @param {object} entry - replayed journal entry.
   * @param {object} header - stored or live header.
   * @param {{ dir: string } | undefined} storage - locator result.
   * @returns {boolean} whether the identity, target and parent agree.
   */
  registryEntryAgreesWithHeader(entry, header, storage) {
    if (header?.id !== entry.sessionId) return false
    if ((header.cwd ?? null) !== entry.cwd) return false
    if ((header.parentSession ?? null) !== entry.parentSessionId) return false
    if (storage === undefined || entry.dir !== storage.dir) return false
    const headerKind = kindOfHeader(header)
    return entry.kind === headerKind
      || (entry.kind === 'side' && header.isSeeded === true && typeof header.parentSession === 'string')
  }

  /**
   * Compare every complete authority field in a truncated member with the
   * journal and stored header. A field that cannot be compared safely blocks
   * the id instead of allowing a journal-only rebuild.
   * @param {object} member - scanned truncated member.
   * @param {object} entry - replayed journal identity.
   * @param {object} header - stored or live header.
   * @param {{ dir: string }} storage - locator result.
   * @returns {string | undefined} fixed disagreement reason, or undefined.
   */
  partialMemberDisagreement(member, entry, header, storage) {
    if (member.partialBlocked === true) return 'truncated-member'
    const fields = member.partialFields
    if (fields === null || typeof fields !== 'object') return 'truncated-member'
    const has = name => Object.prototype.hasOwnProperty.call(fields, name)
    if (has('dir') && (typeof fields.dir !== 'string' || fields.dir !== storage.dir)) {
      return 'dir-mismatch'
    }
    if (has('cwd') && (fields.cwd ?? null) !== (header.cwd ?? null)) return 'cwd-mismatch'
    if (has('kind')) {
      const headerKind = kindOfHeader(header)
      const journalKind = entry.kind
      const journalFirstSideUpgrade = journalKind === 'side'
        && headerKind === 'fork'
        && header.isSeeded === true
        && typeof header.parentSession === 'string'
        && fields.kind === headerKind
      if (typeof fields.kind !== 'string'
        || !RECORD_KINDS.includes(fields.kind)
        || (fields.kind !== journalKind && !journalFirstSideUpgrade)) return 'kind-mismatch'
    }
    if (has('parentSessionId')) {
      const directParent = header.parentSession ?? null
      if (fields.parentSessionId === null) {
        if (directParent !== null) return 'parent-mismatch'
      } else if (typeof fields.parentSessionId !== 'string' || fields.parentSessionId !== directParent) {
        return 'parent-mismatch'
      }
    }
    if (has('pendingDelete')) {
      if (typeof fields.pendingDelete !== 'boolean'
        || (fields.pendingDelete === true && entry.pending !== true)) return 'pending-mismatch'
    }
    return undefined
  }

  /**
   * Compare a complete fresh member's authority fields with the journal and
   * header. The older in-memory row is not allowed to hide a changed complete
   * row, especially a pending flag the journal never recorded.
   * @param {object} entry - replayed journal identity.
   * @param {object} record - record recovered from current registry bytes.
   * @param {object} header - stored or live header.
   * @param {Map<string, object> | undefined} stored - stored headers, when available.
   * @returns {string | undefined} fixed disagreement reason, or undefined.
   */
  freshRecordDisagreement(entry, record, header, stored) {
    if (record === null || typeof record !== 'object') return 'fresh-record-unusable'
    const headerKind = kindOfHeader(header)
    const sideUpgrade = entry.kind === 'side'
      && record.kind === headerKind
      && header.isSeeded === true
      && typeof header.parentSession === 'string'
    const disagrees = record.kind !== entry.kind
      || record.parentSessionId !== entry.parentSessionId
      || record.dir !== entry.dir
      || record.cwd !== entry.cwd
      || (record.pendingDelete === true && entry.pending !== true)
    if (!disagrees) return undefined
    const collapsedParent = record.kind === entry.kind
      && record.kind === 'subagent'
      && record.parentSessionId !== entry.parentSessionId
      && record.dir === entry.dir
      && record.cwd === entry.cwd
      && !(record.pendingDelete === true && entry.pending !== true)
      && (stored === undefined || this.legacyParentAgrees(record, header, stored))
    if (collapsedParent) return undefined
    if (sideUpgrade
      && record.parentSessionId === entry.parentSessionId
      && record.dir === entry.dir
      && record.cwd === entry.cwd
      && !(record.pendingDelete === true && entry.pending !== true)) return undefined
    return 'journal-record-mismatch'
  }

  /**
   * Quarantine fresh complete rows that disagree with the ownership journal or
   * header before an older in-memory state can be accepted. A matching current
   * row is left alone; the existing state loop handles journal-first upgrades.
   * @param {object} registry - registry read context.
   * @param {Map<string, object> | undefined} stored - stored headers.
   * @param {Set<string>} quarantined - ids already rejected in this pass.
   * @returns {boolean} whether a fresh row was quarantined.
   */
  settleFreshRecords(registry, stored, quarantined) {
    const sessions = registry?.state?.sessions
    if (sessions === null || typeof sessions !== 'object') return false
    let changed = false
    for (const entry of Object.values(this.journal.entries)) {
      if (entry.deleted === true) continue
      const record = sessions[entry.sessionId]
      if (record === undefined) continue
      const header = stored?.get(entry.sessionId) ?? this.deps.sessions.get(entry.sessionId)?.header
      const storage = header === undefined ? undefined : this.resolveStorage(header)
      if (header === undefined || storage === undefined) continue
      const disagreement = this.registryEntryAgreesWithHeader(entry, header, storage)
        ? this.freshRecordDisagreement(entry, record, header, stored)
        : 'journal-header-mismatch'
      if (disagreement === undefined) continue
      this.registryDisputed.add(entry.sessionId)
      this.quarantineRegistryRecord(registry, entry.sessionId, disagreement)
      quarantined.add(entry.sessionId)
      changed = true
    }
    return changed
  }

  /**
   * Build one validated record from a journal identity and its stored header.
   * @param {object} entry - replayed journal entry.
   * @param {object} header - stored or live header.
   * @param {{ dir: string }} storage - locator result.
   * @param {string} [title] - a title already recovered from the registry.
   * @returns {object | undefined} the record.
   */
  journalRecord(entry, header, storage, title = '') {
    const now = Date.now()
    try {
      return recordFields({
        sessionId: entry.sessionId,
        kind: entry.kind,
        parentSessionId: entry.parentSessionId,
        title,
        dir: storage.dir,
        cwd: entry.cwd,
        createdAt: header.createdAt,
        lastActivityAt: now,
        activitySince: now,
        pendingDelete: entry.pending === true,
      }, now)
    } catch {
      return undefined
    }
  }

  /**
   * Record one quarantined row as unresolved evidence and mark the registry
   * damaged. The raw member bytes stay in the backlog when a member exists.
   * @param {object} registry - registry read context.
   * @param {string} sessionId - quarantined id.
   * @param {string} reason - fixed decision code.
   * @returns {void}
   */
  quarantineRegistryRecord(registry, sessionId, reason) {
    const member = registry.context?.inspection?.members?.find(candidate => candidate.key === sessionId)
    if (member !== undefined) {
      this.registryUnresolved.push({ offset: member.offset, reason, bytes: member.bytes })
    }
    registry.damaged = true
    if (registry.context !== undefined) registry.context.damaged = true
    this.registryRecovered = true
    this.recovery.log('quarantined', { offset: member?.offset, reason })
    this.warn(`quarantining a temporary-session registry member at byte ${member?.offset ?? 'unknown'}: ${reason}`)
  }

  /**
   * Publish a recovered registry through the shared publisher after preserving
   * the original and writing unresolved fragments. Order is the contract:
   * preserve, backlog, publish, then retire only when no fragment remains.
   * @param {object} registry - registry read context.
   * @returns {boolean} whether a recovered registry was published.
   */
  repairRegistry(registry) {
    const context = registry?.context ?? registry
    if (context === undefined
      || registry.unsupported === true
      || this.registryAmbiguous
      || this.registryUnreadable
      || registry.missing === true
      || (registry.damaged !== true && context.damaged !== true)
      || this.journalDegraded
      || this.reconciliationDegraded
      || this.migrationIncomplete
      || this.listingUncertain) return false
    const original = context.bytes
    if (!Buffer.isBuffer(original)) return false
    let preserved
    try {
      preserved = this.recovery.preserve(original)
    } catch {
      this.warn('temporary-session registry healing deferred: the damaged original could not be preserved')
      return false
    }
    if (preserved.status === 'full' || preserved.status === 'failed') {
      this.warn('temporary-session registry healing deferred: the preserved-original budget is full')
      return false
    }
    let backlog
    try {
      backlog = this.recovery.appendUnresolved(preserved.hash, this.registryUnresolved)
    } catch {
      this.warn('temporary-session registry healing deferred: the unresolved backlog could not be written')
      return false
    }
    if (backlog.error !== undefined) {
      this.warn('temporary-session registry healing deferred: the unresolved backlog could not be written')
      return false
    }
    if (this.registryDisputed.size > 0) {
      // The original stays in place so the same disagreement is re-evaluated on
      // the next boot. Publishing a registry without the disputed id would make
      // the next boot see a journal-only row and authorize deletion.
      this.registryDegraded = true
      this.publisher.setDegraded(true)
      this.recovery.log('publish-deferred', { reason: 'disputed', count: this.registryDisputed.size })
      this.warn('temporary-session registry healing deferred: a registry row disagrees with the journal or header')
      return false
    }
    const hadUnresolved = this.registryUnresolved.length > 0
    this.publisher.setDegraded(false)
    this.publisher.mutate()
    let published = false
    try {
      published = this.publisher.publish(encodeState(this.state))
    } catch (error) {
      this.warn(`could not publish the recovered temporary-session registry: ${String(error)}`)
    }
    if (!published) {
      this.publisher.setDegraded(true)
      this.recovery.log('publish-deferred', { reason: 'publisher-unavailable' })
      return false
    }
    this.registryDegraded = false
    this.registryRecovered = false
    this.registryUnresolved = []
    this.registryDisputed.clear()
    // The published bytes are now the authority. Do not let a later sweep
    // repair from this boot's stale scan or overwrite a newer registry file.
    this.registryRead = undefined
    this.registryContext = undefined
    this.registryAuthority = Buffer.from(encodeState(this.state))
    this.publisher.setDegraded(this.journalDegraded || this.reconciliationDegraded)
    this.refreshSnapshot()
    this.recovery.log('published', { count: Object.keys(this.state.sessions).length })
    if (!hadUnresolved) {
      try {
        this.recovery.retire(preserved.file)
      } catch {
        // The publish is already durable; a preserved leftover is extra evidence.
      }
    } else {
      this.recovery.log('preserved-kept', { reason: 'unresolved' })
    }
    return true
  }

  /**
   * Retry registry healing at a sweep boundary. A failed publish or a full
   * evidence budget leaves the original bytes and the degraded gate in place.
   * @returns {boolean} whether healing completed.
   */
  retryRegistryHealing() {
    if (!this.registryDegraded
      || this.registryUnsupported
      || this.registryAmbiguous
      || this.registryUnreadable
      || this.journalDegraded
      || this.migrationIncomplete
      || !this.storedListingComplete
      || this.listingUncertain
      || this.registryContext === undefined
      || this.registryRead === undefined) return false
    if (this.registryContext.damaged !== true) return false
    this.settleRegistry(this.registryRead, this.storedHeaders)
    this.healFromJournal(this.storedHeaders)
    const healed = this.repairRegistry(this.registryContext)
    if (!healed) return false
    this.warn('recovered the temporary-session registry from its preserved evidence')
    return true
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
    if (registry.unsupported === true) return
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
      if (registry.damaged && (registry.sources?.length ?? 0) === 0) {
        this.warn('first ownership migration deferred: the registry cannot list its sources')
        return
      }
      if (stored === undefined) {
        this.warn('first ownership migration deferred: the stored session list is unavailable')
        return
      }
      if (registry.damaged) {
        const preserved = this.preserveMigrationOriginal(registry)
        if (!preserved) return
      }
      await this.appendEvent({
        type: 'migration',
        ids: registry.sources ?? Object.keys(registry.state.sessions),
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
    if (registry.damaged && registry.preserved === undefined) {
      if (!this.preserveMigrationOriginal(registry)) return
    }
    for (const sessionId of migration.ids) {
      const outcome = await this.importMigrationSource(sessionId, stored, registry)
      if (outcome === 'unresolved' && !this.recordMigrationUnresolved(registry, sessionId)) return
    }
    await this.appendEvent({ type: 'migrationComplete', at: Date.now() })
    const completedAt = this.journal.migrationComplete
    if (completedAt === undefined) return
    this.writeMarker(this.journal.migration?.at ?? completedAt, completedAt)
  }

  /**
   * Preserve a damaged registry before the migration starts writing journal
   * events. The preserved file is reused by the repair transaction later.
   * @param {object} registry - registry read context.
   * @returns {boolean} whether a preserved original exists.
   */
  preserveMigrationOriginal(registry) {
    const bytes = registry.context?.bytes
    if (!Buffer.isBuffer(bytes)) return false
    const preserved = this.recovery.preserve(bytes)
    if (preserved.status === 'full' || preserved.status === 'failed') {
      this.warn('first ownership migration deferred: the damaged registry cannot be preserved')
      return false
    }
    registry.preserved = preserved
    return true
  }

  /**
   * Record one migration source that cannot be imported. It is appended before
   * `migrationComplete`, so the cutoff is never claimed over an unrecorded id.
   * @param {object} registry - registry read context.
   * @param {string} sessionId - unresolved source id.
   * @returns {boolean} whether the evidence was appended or already present.
   */
  recordMigrationUnresolved(registry, sessionId) {
    if (!this.preserveMigrationOriginal(registry)) return false
    const member = registry.context?.inspection?.members?.find(candidate => candidate.key === sessionId)
    const fragments = member === undefined
      ? [{ offset: 0, reason: 'unusable-source', bytes: Buffer.alloc(0) }]
      : [{ offset: member.offset, reason: 'unusable-source', bytes: member.bytes }]
    const appended = this.recovery.appendUnresolved(registry.preserved.hash, fragments)
    if (appended.error !== undefined || appended.full === true) {
      this.warn(`first ownership migration deferred: the unresolved source "${sessionId}" could not be recorded`)
      return false
    }
    this.registryRecovered = true
    return true
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
    const kindAgrees = record.kind === undefined
      || record.kind === headerKind
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
   * @returns {Promise<'owned' | 'unresolved'>} the import outcome.
   */
  async importMigrationSource(sessionId, stored, registry) {
    if (this.journal.entries[sessionId] === undefined) {
      const header = stored.get(sessionId)
      const storage = header === undefined ? undefined : this.resolveStorage(header)
      if (header === undefined || storage === undefined) {
        this.warn(`first ownership migration could not import "${sessionId}": no usable stored header`)
        return 'unresolved'
      }
      const legacy = registry.state.sessions[sessionId]
      if (!this.legacyRecordAgrees(legacy, header, storage, stored)) {
        this.warn(`first ownership migration quarantined "${sessionId}": its record disagrees with its stored header`)
        return 'unresolved'
      }
      const kind = this.legacyJournalKind(legacy, header)
      const parentSessionId = header.parentSession ?? null
      const member = registry.context?.inspection?.members?.find(candidate => candidate.key === sessionId)
      const source = member?.value
      const sourceNeedsRepair = source !== null
        && typeof source === 'object'
        && (source.kind === undefined
          || source.parentSessionId !== parentSessionId
          || source.dir === undefined)
      // The old recorder collapsed a subagent to an ancestor; the header's
      // direct parent is authoritative, so persist the corrected link.
      if (legacy.parentSessionId !== parentSessionId || sourceNeedsRepair) {
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
    return 'owned'
  }

  /**
   * Adopt every stored child whose direct parent is already journal-owned.
   * The pass is a fixed point, so a child listed before its parent is adopted
   * after the parent in the next pass. All descendant kinds are covered; a
   * seeded descendant that predates the migration cutoff is quarantined, and a
   * journal-deleted parent only authorises deletion of a subagent orphan.
   * @param {Map<string, object> | undefined} stored - stored headers.
   * @returns {Promise<boolean>} whether this pass appended a journal event.
   */
  async adoptStoredChildren(stored) {
    if (stored === undefined || this.journalDegraded) return false
    if (this.migrationIncomplete) {
      // The cutoff is not available yet, so no seeded child is adopted or
      // deleted. Report each candidate once for the boot log.
      for (const [sessionId, header] of stored) {
        if (header?.isSeeded !== true || this.journal.entries[sessionId] !== undefined) continue
        if (typeof header.parentSession !== 'string' || header.parentSession === '') continue
        this.logCutoff(sessionId, 'migration-incomplete')
      }
      return false
    }
    let adopted = false
    let changed = true
    while (changed) {
      changed = false
      for (const [sessionId, header] of stored) {
        if (await this.reconcileStoredChild(sessionId, header)) {
          adopted = true
          changed = true
        }
      }
    }
    // An unrecorded child whose direct parent has no journal anchor is left
    // alone. Log it once, after the fixed point, so an earlier pass that adopts
    // the parent does not produce a false orphan message.
    for (const [sessionId, header] of stored) {
      if (header === null || typeof header !== 'object') continue
      if (typeof header.parentSession !== 'string' || header.parentSession === '') continue
      if (this.journal.entries[sessionId] !== undefined) continue
      if (this.journal.entries[header.parentSession] !== undefined) continue
      this.logOnce(`unproven:${sessionId}`, `left "${sessionId}" unrecorded: its parent has no journal anchor`)
    }
    return adopted
  }

  /**
   * Run stored and observed reconciliation as one fixed point. An observed
   * parent may make a stored child adoptable, and a stored parent may make an
   * observed child adoptable, so alternating one pass of each is required.
   * @param {Map<string, object> | undefined} stored - stored headers.
   * @returns {Promise<{ adopted: boolean, observed: boolean }>} changes seen.
   */
  async reconcileFixedPoint(stored) {
    let adopted = false
    let observed = false
    let changed = true
    while (changed) {
      changed = false
      const storedChanged = this.reconciliationDegraded
        ? false
        : await this.adoptStoredChildren(stored)
      const observedChanged = await this.drainObserved({ persist: false })
      if (storedChanged) {
        adopted = true
        changed = true
      }
      if (observedChanged) {
        observed = true
        changed = true
      }
    }
    await this.dropUnprovenObservations(stored)
    return { adopted, observed }
  }
  /**
   * Reconcile one stored header. Returns true only when this pass wrote an
   * event or removed a proven orphan, so the caller can repeat to a fixed point.
   * @param {string} sessionId - stored child id.
   * @param {object} header - stored header.
   * @returns {Promise<boolean>} whether the pass changed the journal.
   */
  async reconcileStoredChild(sessionId, header) {
    if (header === null || typeof header !== 'object' || typeof sessionId !== 'string') return false
    // A disputed row means the registry is not trustworthy evidence for any
    // adoption or orphan deletion until healing succeeds on a later pass.
    if (this.registryDisputed.size > 0) return false
    if (typeof header.parentSession !== 'string' || header.parentSession === '') return false
    const parentId = header.parentSession
    const parent = this.journal.entries[parentId]
    if (parent === undefined) return false
    const storage = this.resolveStorage(header)
    if (storage === undefined || !isSafeSessionDir(storage.dir, sessionId)) return false
    const existing = this.journal.entries[sessionId]
    if (parent.deleted === true) {
      const childKind = kindOfHeader(header)
      if (childKind === 'subagent') {
        if (existing !== undefined && existing.kind !== 'subagent') {
          this.logOnce(`deleted-parent:${sessionId}`, `left "${sessionId}" under its journal-deleted parent: its journal identity is not a subagent orphan`)
          return false
        }
        return this.deleteOrphanedChild(sessionId, parentId, header, storage, existing)
      }
      if (existing !== undefined) {
        if (existing.deleted === true) return false
        const kindAgrees = existing.kind === childKind
          || (existing.kind === 'side' && header.isSeeded === true && typeof header.parentSession === 'string')
        if (!kindAgrees
          || existing.parentSessionId !== parentId
          || existing.dir !== storage.dir
          || existing.cwd !== (header.cwd ?? null)) {
          this.logOnce(`deleted-parent:${sessionId}`, `left "${sessionId}" under its journal-deleted parent: its journal identity disagrees with its stored header`)
          return false
        }
        if (parent.pending === true && existing.pending !== true) {
          await this.appendEvent({
            type: 'pending',
            sessionIds: [sessionId],
            reason: parent.pendingReason ?? 'discard',
            at: Date.now(),
          })
          return true
        }
        return false
      }
      const cutoff = this.quarantineReason(header, sessionId)
      if (cutoff !== undefined) {
        this.logCutoff(sessionId, cutoff)
        return false
      }
      await this.appendOwnedChild({ sessionId, kind: childKind, parentId, header, storage, parent })
      this.recovery.log('adopted', { id: sessionId, reason: 'stored-child' })
      this.warn(`adopted stored ${childKind} "${sessionId}" under its journal-deleted parent`)
      return true
    }
    if (existing !== undefined) {
      // A crash between the adopted `owned` event and its inherited `pending`
      // event must not leave an ended parent's child running.
      if (existing.deleted !== true && parent.pending === true && existing.pending !== true) {
        await this.appendEvent({
          type: 'pending',
          sessionIds: [sessionId],
          reason: parent.pendingReason ?? 'discard',
          at: Date.now(),
        })
        return true
      }
      return false
    }
    const cutoff = this.quarantineReason(header, sessionId)
    if (cutoff !== undefined) {
      this.logCutoff(sessionId, cutoff)
      return false
    }
    await this.appendOwnedChild({ sessionId, kind: kindOfHeader(header), parentId, header, storage, parent })
    this.recovery.log('adopted', { id: sessionId, reason: 'stored-child' })
    this.warn(`adopted stored descendant "${sessionId}" under its journal-owned parent`)
    return true
  }

  /**
   * Append the durable identity of a stored child and the pending state it
   * inherits from its journal-owned parent.
   * @param {{ sessionId: string, kind: string, parentId: string, header: object, storage: { dir: string }, parent: object }} child - owned child facts.
   * @returns {Promise<void>}
   */
  async appendOwnedChild({ sessionId, kind, parentId, header, storage, parent }) {
    await this.appendEvent({
      type: 'owned',
      sessionId,
      kind,
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
  }

  /**
   * Log one migration-cutoff decision with its reason.
   * @param {string} sessionId - candidate id.
   * @param {string} cutoff - reason from {@link quarantineReason}.
   * @returns {void}
   */
  logCutoff(sessionId, cutoff) {
    const reason = cutoff === 'migration-incomplete' ? 'migration-incomplete' : 'pre-migration'
    if (cutoff === 'migration-incomplete') {
      if (this.logOnce(`migration-incomplete:${sessionId}`, `not adopting "${sessionId}": the first ownership migration is incomplete`)) {
        this.recovery.log('cutoff', { id: sessionId, reason })
      }
    } else if (this.logOnce(`quarantine:${sessionId}`, `quarantined "${sessionId}": ${cutoff}`)) {
      this.recovery.log('cutoff', { id: sessionId, reason })
    }
  }

  /**
   * The migration cutoff reason an unrecorded child must be quarantined, or
   * undefined when it may be adopted. Only seeded descendants are subject to
   * the pre-ban ambiguity; a subagent is proven temporary by its origin.
   * @param {object} header - stored or live Session header.
   * @param {string} sessionId - child id.
   * @returns {string | undefined} quarantine reason.
   */
  quarantineReason(header, sessionId) {
    if (header?.isSeeded !== true) return undefined
    if (this.migrationIncomplete) return 'migration-incomplete'
    // A valid marker proves completion when the final journal line was torn
    // away; the journal's migration event still supplies the snapshot.
    if (this.journal.migrationComplete === undefined && this.marker?.completedAt === undefined) {
      return 'migration-incomplete'
    }
    const migration = this.journal.migration
    const at = migration?.at ?? this.marker?.migrationAt
    if (!Number.isSafeInteger(at)) return 'the migration time is unavailable'
    if (migration?.preexisting?.includes(sessionId) === true) return 'it is in the pre-existing snapshot'
    if (!Number.isSafeInteger(header.createdAt)) return 'its creation time is invalid'
    if (header.createdAt <= at) return 'it was created at or before the migration cutoff'
    return undefined
  }

  /**
   * Log one reconciliation decision at most once in this boot.
   * @param {string} key - stable decision key.
   * @param {string} message - warning text.
   * @returns {void}
   */
  logOnce(key, message) {
    if (this.logged.has(key)) return false
    this.logged.add(key)
    this.warn(message)
    return true
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
    if (this.registryDisputed.size > 0) return false
    if (kindOfHeader(header) !== 'subagent') {
      this.warn(`not deleting "${sessionId}": its stored header is not a subagent`)
      return false
    }
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
        if (this.hasLiveOwner(sessionId)) {
          this.warn(`not deleting stored subagent "${sessionId}": its Session or Agent is still live`)
          return false
        }
        if (!existsSync(storage.dir)) {
          const hadRecord = this.state.sessions[sessionId] !== undefined
          delete this.state.sessions[sessionId]
          return hadRecord
        }
        this.removeOrphanDir(storage.dir, sessionId)
        if (!existsSync(storage.dir)) delete this.state.sessions[sessionId]
        return !existsSync(storage.dir)
      }
      if (this.hasLiveOwner(sessionId)) {
        this.warn(`deferring deletion of stored subagent "${sessionId}": its Session or Agent is still live`)
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
      if (this.hasLiveOwner(sessionId)) {
        // The owned identity above is durable, so a later pass can finish the
        // deletion once this Session or Agent is no longer live.
        this.warn(`deferring deletion of stored subagent "${sessionId}": its Session or Agent is still live`)
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
    if (this.hasLiveOwner(sessionId)) {
      // The Session or Agent became live while the `deleted` append was
      // awaiting. Keep the transcript; the already-deleted path retries later.
      this.warn(`not removing stored subagent "${sessionId}": its Session or Agent became live during deletion`)
      return true
    }
    this.removeOrphanDir(storage.dir, sessionId)
    if (!existsSync(storage.dir)) {
      delete this.state.sessions[sessionId]
      this.warn(`deleted stored subagent "${sessionId}" whose journal parent is deleted`)
      return true
    }
    return false
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
    if (this.listingUncertain) {
      this.warn('deferring journal-only recovery: the stored-session listing is unavailable')
      return false
    }
    let healed = false
    const now = Date.now()
    for (const entry of Object.values(this.journal.entries)) {
      if (entry.deleted === true) continue
      // A registry row that disagrees with the journal or header stays
      // quarantined. Rebuilding it would turn a detectable disagreement into a
      // journal-only deletion target on this or the next boot.
      if (this.registryDisputed.has(entry.sessionId)) continue
      const live = this.deps.sessions.get(entry.sessionId)
      const header = stored?.get(entry.sessionId) ?? live?.header
      const storage = header === undefined ? undefined : this.resolveStorage(header)
      if (header !== undefined && !this.registryEntryAgreesWithHeader(entry, header, storage)) {
        this.warn(`not rebuilding "${entry.sessionId}" from the ownership journal: its identity disagrees with its stored header`)
        continue
      }
      const existing = this.state.sessions[entry.sessionId]
      if (existing === undefined) {
        if (header === undefined || storage === undefined) continue
        try {
          this.state.sessions[entry.sessionId] = recordFields({
            sessionId: entry.sessionId,
            kind: entry.kind,
            parentSessionId: entry.parentSessionId,
            dir: storage.dir,
            cwd: entry.cwd,
            createdAt: header.createdAt,
            lastActivityAt: now,
            activitySince: now,
            pendingDelete: entry.pending === true,
          }, now)
          healed = true
          this.recovery.log('adopted', { id: entry.sessionId, reason: 'journal-only' })
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
      if (existing.kind !== entry.kind) {
        // A side-chat upgrade journals first and publishes the index second.
        // Reconcile a crash in that interval from the durable ownership event.
        existing.kind = entry.kind
        healed = true
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
    if (this.loadFailed || this.journalDegraded || this.registryDegraded || this.registryAmbiguous || this.registryUnreadable || this.reconciliationDegraded || this.listingUncertain) return false
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
    if (published) {
      this.registryDegraded = false
      this.registryAuthority = Buffer.from(text)
    }
    return published
  }

  /**
   * Publish the in-memory registry without awaiting. The unload path calls this
   * before its queued work: a queued write can be blocked behind a save that
   * never finishes, and a record that exists only in memory would otherwise be
   * lost with this instance. It refuses while the boot is incomplete or any
   * ownership evidence is degraded, and associates only pending observations
   * whose journal entry already exists. It never overwrites a damaged registry.
   * @returns {boolean} whether this write became the published registry.
   */
  flushRegistrySync() {
    if (!this.loaded
      || this.loadFailed
      || this.migrationIncomplete
      || this.registryDegraded
      || this.registryAmbiguous
      || this.journalDegraded
      || this.reconciliationDegraded
      || this.listingUncertain) return false
    for (const session of this.pending) {
      const sessionId = session?.header?.id
      const entry = typeof sessionId === 'string' ? this.journal.entries[sessionId] : undefined
      if (entry === undefined || entry.deleted === true) continue
      this.associateDescendant(session)
    }
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
   * Every queued observation, disputed row and resolvable ancestor. A dispute
   * can keep an observation unjournaled until a later boot, so exit cleanup
   * must not remove the parent it still names.
   * @returns {Set<string>} ids protected from the exit snapshot.
   */
  protectedSnapshotIds() {
    const headers = new Map(this.storedHeaders ?? [])
    for (const observation of this.pending) {
      const header = observation?.header
      if (typeof header?.id === 'string' && header.id !== '') headers.set(header.id, header)
    }
    const kept = new Set()
    for (const observation of this.pending) {
      const sessionId = observation?.header?.id
      if (typeof sessionId === 'string') this.addAncestorChain(kept, sessionId, headers, this.storedHeaders)
    }
    for (const sessionId of this.registryDisputed) {
      this.addAncestorChain(kept, sessionId, headers, this.storedHeaders)
    }
    return kept
  }

  /**
   * Rebuild the immutable in-memory snapshot. Only a record the ownership
   * journal owns is deletion evidence; a journal-degraded instance deletes
   * nothing.
   */
  refreshSnapshot() {
    // The injected degraded seam keeps the last validated snapshot. Journal
    // observations may still be written; the next healthy pass heals them.
    if (this.reconciliationDegraded) return
    if (this.migrationIncomplete
      || this.settlementPending
      || this.listingUncertain
      || this.registryUnreadable) {
      this.snapshot = Object.freeze({ degraded: true, sessions: Object.freeze([]) })
      return
    }
    const sessions = []
    if (!this.journalDegraded && !this.registryAmbiguous) {
      const protectedIds = this.protectedSnapshotIds()
      for (const record of Object.values(this.state.sessions)) {
        const entry = this.journal.entries[record.sessionId]
        if (entry === undefined || entry.deleted === true) continue
        // A disputed child or queued observation may become resolvable on the
        // next boot. Keep every record on its parent chain out of this snapshot.
        if (protectedIds.has(record.sessionId)) continue
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
    this.snapshot = Object.freeze({ degraded: this.journalDegraded || this.registryAmbiguous, sessions: Object.freeze(sessions) })
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
    if (this.registryAmbiguous) {
      throw new Error(`the temporary-session registry framing is ambiguous; refusing to ${action}`)
    }
    if (this.registryDegraded) {
      throw new Error(`the temporary-session registry is damaged; refusing to ${action}`)
    }
    if (this.reconciliationDegraded) {
      throw new Error(`temporary-session reconciliation is degraded; refusing to ${action}`)
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
      if (existing !== undefined) {
        if (request.kind === 'side' && existing.kind === 'fork') {
          return this.upgradeSideChat(existing, request)
        }
        if (existing.kind === 'side') {
          const requestedTitle = typeof request.title === 'string' && request.title !== ''
            ? request.title
            : existing.title
          const needsPreparation = !this.sidePrepared.has(existing.sessionId)
          const needsTitle = requestedTitle !== ''
            && this.deps.sessionController !== undefined
            && this.sideTitled.get(existing.sessionId) !== requestedTitle
          if (needsPreparation || needsTitle) {
            return this.completeSideChat(existing, request, true)
          }
        }
        return recordView(existing)
      }
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
      if (kind === 'side') {
        if (this.prepareSideChat(sessionId)) this.sidePrepared.add(sessionId)
      }
      const controller = this.deps.sessionController
      if (controller !== undefined && title !== '') {
        try {
          await controller.rename({ sessionId, title })
          this.sideTitled.set(sessionId, title)
        } catch (error) {
          this.warn(`could not title temporary session "${sessionId}": ${String(error)}`)
        }
      }
      return recordView(record)
    })
  }

  /**
   * Upgrade an automatic fork record into a side chat in place. The record
   * already has an `owned` entry; a second one carries the side presentation
   * and keeps the true parent, storage target and pending state. The ownership
   * event is appended once per upgrade; preparation and title publication are
   * idempotent and can finish on a later register after a failed save.
   * @param {object} record - the recorded automatic fork.
   * @param {{ title?: string }} request - side-chat presentation.
   * @returns {Promise<object>} the updated record view.
   */
  async upgradeSideChat(record, request) {
    const now = Date.now()
    if (typeof request.title === 'string' && request.title !== '' && request.title !== record.title) {
      // Persist the requested title before the ownership change. A crash after
      // the journal append can then heal the side kind without losing the title.
      // Restore the old in-memory title when this save fails, because a retry
      // must not mistake the failed mutation for already-persisted state.
      const previousTitle = record.title
      record.title = request.title
      try {
        await this.save()
      } catch (error) {
        record.title = previousTitle
        throw error
      }
    }
    await this.appendEvent({
      type: 'owned',
      sessionId: record.sessionId,
      kind: 'side',
      parentSessionId: record.parentSessionId,
      dir: record.dir,
      cwd: record.cwd,
      at: now,
    })
    record.kind = 'side'
    this.refreshSnapshot()
    await this.save()
    return this.completeSideChat(record, request, false)
  }

  /**
   * Finish the work that follows the durable side kind and title. Keeping this
   * idempotent lets a retry finish after a failed index save, while the live
   * instance's prepared set still applies the boundary and native title once.
   * @param {object} record - the side record.
   * @param {{ title?: string }} request - the requested title, if any.
   * @param {boolean} persist - whether the index still needs this record saved.
   * @returns {Promise<object>} the updated record view.
   */
  async completeSideChat(record, request, persist) {
    const requestedTitle = typeof request.title === 'string' && request.title !== ''
      ? request.title
      : record.title
    if (requestedTitle !== record.title) {
      record.title = requestedTitle
      persist = true
    }
    if (persist) await this.save()
    if (!this.sidePrepared.has(record.sessionId)) {
      if (this.prepareSideChat(record.sessionId)) this.sidePrepared.add(record.sessionId)
    }
    if (record.title !== ''
      && this.deps.sessionController !== undefined
      && this.sideTitled.get(record.sessionId) !== record.title) {
      try {
        await this.deps.sessionController.rename({ sessionId: record.sessionId, title: record.title })
        this.sideTitled.set(record.sessionId, record.title)
      } catch (error) {
        this.warn(`could not title temporary side chat "${record.sessionId}": ${String(error)}`)
      }
    }
    return recordView(record)
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
   * Observe one announced Session. The Session is queued before any await, so
   * an announcement that arrives while the stored listing is being taken is
   * still visible to the boot pass. When its parent is already journal-owned,
   * `drainObserved` appends the `owned` (and inherited `pending`) events before
   * the registry write. A failed append stays queued for the next pass.
   * @param {object} session - the Session the Host just announced.
   * @returns {Promise<void>} settles after the queue pass.
   */
  recordDescendant(session) {
    if (typeof session?.header?.id !== 'string' || session.header.id === '') return Promise.resolve()
    if (!this.pending.includes(session)) this.pending.push(session)
    return this.enqueue(async () => {
      await this.load()
      if (this.loadFailed) return
      const changed = await this.drainObserved()
      // A descendant observed after the tree's final stop scan is pending now;
      // re-issue the stop so it cannot wait for an arbitrary restart.
      if (changed && Object.values(this.state.sessions).some(record => record?.pendingDelete === true)) {
        await this.resumePendingStops()
      }
    })
  }

  /**
   * Drain the observed-announcement queue to a fixed point. The journal is the
   * first durable write: a child is never added to the registry before its
   * ownership event exists. A journal-append failure keeps the observation and
   * removes nothing; a later `reap`, `load`, or explicit retry can finish it.
   * @param {{ persist?: boolean }} [options] - persist the registry after additions.
   * @returns {Promise<boolean>} whether a record or journal event was produced.
   */
  async drainObserved(options = {}) {
    const persist = options.persist !== false
    if (this.loadFailed
      || this.journalDegraded
      || this.registryUnsupported
      || this.registryAmbiguous
      || this.registryDisputed.size > 0) return false
    let changed = false
    let grew = true
    while (grew) {
      grew = false
      for (const session of [...this.pending]) {
        if (await this.consumeObservation(session) === 'changed') {
          changed = true
          grew = true
        }
      }
    }
    if (changed) {
      this.refreshSnapshot()
      if (persist && !this.registryDegraded && !this.reconciliationDegraded && !this.journalDegraded) await this.save()
    }
    return changed
  }

  /**
   * Drop observations that remain unproven after stored and observed
   * reconciliation reached a fixed point. This runs outside `drainObserved`
   * because a stored parent may become journal-owned only in the next
   * alternating pass; dropping its observed child earlier loses the tree.
   * The protected retry queue and an incomplete migration are never dropped.
   * A disputed registry or unsupported version keeps them too: the next healthy
   * pass can still prove the observation, while dropping it here loses the tree.
   * A failed or unavailable listing also keeps them: a stored parent may be
   * present but invisible to this pass. When a successful listing omits the
   * parent, a direct stat must confirm absence before its child is dropped.
   * @param {Map<string, object> | undefined} stored - stored headers, if readable.
   * @returns {Promise<void>}
   */
  async dropUnprovenObservations(stored) {
    if (stored === undefined
      || this.journalDegraded
      || this.registryUnsupported
      || this.registryAmbiguous
      || this.registryDisputed.size > 0
      || this.migrationIncomplete
      || this.reconciliationDegraded) return
    for (const session of [...this.pending]) {
      const sessionId = session?.header?.id
      if (typeof sessionId !== 'string' || this.retryQueue.has(sessionId)) continue
      if (this.hasRetryingAncestor(session)) continue
      const parentId = session.header.parentSession
      if (typeof parentId === 'string'
        && parentId !== ''
        && !stored.has(parentId)
        && this.deps.sessions.get(parentId) === undefined) {
        let parentHeader
        try {
          parentHeader = await this.storedHeader(parentId)
        } catch (error) {
          this.logOnce(`unproven-parent:${sessionId}`, `kept announced Session "${sessionId}" for retry: its parent header could not be read (${String(error)})`)
          continue
        }
        if (parentHeader !== undefined) {
          this.logOnce(`unproven-parent:${sessionId}`, `kept announced Session "${sessionId}" for reconciliation: its parent is absent from the listing but present in the store`)
          continue
        }
      }
      this.logOnce(`unproven:${sessionId}`, `left announced Session "${sessionId}" unrecorded: its parent has no journal anchor`)
      this.removeObservation(session)
    }
  }

  /**
   * Whether an observation has an ancestor whose journal append is waiting in
   * the protected retry queue. Its own parent may become journal-owned only
   * after that retry, so dropping it now would lose an adoptable child.
   * @param {object} session - announced Session.
   * @returns {boolean} whether an ancestor observation is retrying.
   */
  hasRetryingAncestor(session) {
    const seen = new Set()
    let parentId = session?.header?.parentSession
    while (typeof parentId === 'string' && !seen.has(parentId)) {
      seen.add(parentId)
      if (this.retryQueue.has(parentId)) return true
      const parent = this.pending.find(item => item?.header?.id === parentId)
      if (parent === undefined) return false
      parentId = parent.header?.parentSession
    }
    return false
  }

  /**
   * Process one observed announcement. Returns 'changed' when a durable event
   * was written, 'kept' when the fixed point or retry queue must retain it, and
   * 'removed' when it is terminal.
   * @param {object} session - announced Session.
   * @returns {Promise<'changed' | 'kept' | 'removed'>} outcome.
   */
  async consumeObservation(session) {
    const header = session?.header
    const sessionId = header?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      this.removeObservation(session)
      return 'removed'
    }
    const existing = this.journal.entries[sessionId]
    if (existing !== undefined) return this.repairObserved(session, existing, sessionId)
    const parentId = header.parentSession
    if (typeof parentId !== 'string' || parentId === '') {
      // A root Session is not a descendant; only a malformed subagent is worth
      // reporting. Roots are registered through the browser's reserve path.
      if (kindOfHeader(header) === 'subagent') {
        this.logOnce(`unparented:${sessionId}`, `left announced Session "${sessionId}" unrecorded: it has no direct parent`)
      }
      this.removeObservation(session)
      return 'removed'
    }
    const parent = this.observedParent(header)
    if (parent === undefined) return 'kept'
    if (parent.deleted === true) {
      if (kindOfHeader(header) === 'subagent') {
        return this.deleteObservedOrphan(session, header, parentId)
      }
      if (this.migrationIncomplete) {
        this.logCutoff(sessionId, 'migration-incomplete')
        return 'kept'
      }
      const cutoff = this.quarantineReason(header, sessionId)
      if (cutoff !== undefined) {
        this.logCutoff(sessionId, cutoff)
        this.removeObservation(session)
        return 'removed'
      }
      return this.adoptObservedUnderDeletedParent(session, header, parentId, parent)
    }
    if (this.migrationIncomplete) {
      this.logCutoff(sessionId, 'migration-incomplete')
      return 'kept'
    }
    const cutoff = this.quarantineReason(header, sessionId)
    if (cutoff !== undefined) {
      this.logCutoff(sessionId, cutoff)
      this.removeObservation(session)
      return 'removed'
    }
    const storage = this.resolveStorage(header)
    if (storage === undefined || !isSafeSessionDir(storage.dir, sessionId)) {
      this.logOnce(`storage:${sessionId}`, `left announced Session "${sessionId}" unrecorded: its JSONL storage location is unavailable`)
      this.removeObservation(session)
      return 'removed'
    }
    if (!await this.appendObserved(header, sessionId, parentId, parent, storage)) return 'kept'
    this.associateDescendant(session)
    this.removeObservation(session)
    return 'changed'
  }

  /**
   * Repair an observation whose `owned` event already exists: a missing
   * inherited `pending` event is appended before the registry association.
   * @param {object} session - announced Session.
   * @param {object} existing - folded journal entry.
   * @param {string} sessionId - child id.
   * @returns {Promise<'changed' | 'kept' | 'removed'>} outcome.
   */
  async repairObserved(session, existing, sessionId) {
    if (existing.deleted === true) {
      this.removeObservation(session)
      return 'removed'
    }
    const parent = this.observedParent(session.header)
    if (parent?.deleted === true) {
      if (kindOfHeader(session.header) === 'subagent') {
        return this.deleteObservedOrphan(session, session.header, session.header.parentSession, existing)
      }
      if (this.migrationIncomplete) {
        this.logCutoff(sessionId, 'migration-incomplete')
        return 'kept'
      }
      let changed = false
      let pendingNow = existing.pending === true
      if (parent.pending === true && !pendingNow) {
        try {
          await this.appendEvent({
            type: 'pending',
            sessionIds: [sessionId],
            reason: parent.pendingReason ?? 'discard',
            at: Date.now(),
          })
          pendingNow = true
          changed = true
        } catch (error) {
          this.keepForRetry(sessionId, 'pending', error)
          return 'kept'
        }
      }
      if (this.state.sessions[sessionId] === undefined) {
        if (this.associateDescendant(session)) changed = true
      } else if (pendingNow && this.state.sessions[sessionId].pendingDelete !== true) {
        this.state.sessions[sessionId].pendingDelete = true
        changed = true
      }
      this.removeObservation(session)
      return changed ? 'changed' : 'removed'
    }
    let changed = false
    let pendingNow = existing.pending === true
    if (parent?.pending === true && !pendingNow) {
      try {
        await this.appendEvent({
          type: 'pending',
          sessionIds: [sessionId],
          reason: parent.pendingReason ?? 'discard',
          at: Date.now(),
        })
        pendingNow = true
        changed = true
      } catch (error) {
        this.keepForRetry(sessionId, 'pending', error)
        return 'kept'
      }
    }
    if (this.state.sessions[sessionId] === undefined) {
      if (this.associateDescendant(session)) changed = true
    } else if (pendingNow && this.state.sessions[sessionId].pendingDelete !== true) {
      this.state.sessions[sessionId].pendingDelete = true
      changed = true
    }
    this.removeObservation(session)
    return changed ? 'changed' : 'removed'
  }

  /**
   * Delete a subagent observed under a journal-deleted parent. A non-subagent
   * is left in place; a live owner keeps the observation for a later pass.
   * @param {object} session - announced Session.
   * @param {object} header - announced header.
   * @param {string} parentId - true direct parent.
   * @param {object | undefined} existing - folded journal entry, when already owned.
   * @returns {Promise<'changed' | 'kept' | 'removed'>} outcome.
   */
  async deleteObservedOrphan(session, header, parentId, existing = undefined) {
    const sessionId = header.id
    if (kindOfHeader(header) !== 'subagent') {
      this.logOnce(`deleted-parent:${sessionId}`, `left "${sessionId}" under its journal-deleted parent: only a subagent orphan is deleted`)
      this.removeObservation(session)
      return 'removed'
    }
    const storage = this.resolveStorage(header)
    if (storage === undefined || !isSafeSessionDir(storage.dir, sessionId)) {
      this.logOnce(`storage:${sessionId}`, `left announced Session "${sessionId}" unrecorded: its JSONL storage location is unavailable`)
      this.removeObservation(session)
      return 'removed'
    }
    let removed = false
    try {
      removed = await this.deleteOrphanedChild(sessionId, parentId, header, storage, existing)
    } catch (error) {
      this.keepForRetry(sessionId, 'deletion', error)
      return 'kept'
    }
    const entry = this.journal.entries[sessionId]
    if (entry?.deleted === true && !existsSync(storage.dir)) {
      this.retryQueue.delete(sessionId)
      this.removeObservation(session)
      return 'changed'
    }
    // An owned record whose delete was deferred by a live owner is not a
    // finished orphan. Keep the observation and its anchor for a later sweep.
    if (!removed || entry?.deleted !== true) {
      this.retryQueue.add(sessionId)
      this.scheduleRetry()
      return 'kept'
    }
    this.retryQueue.delete(sessionId)
    this.removeObservation(session)
    return 'changed'
  }

  /**
   * Adopt an announced non-subagent under a journal-deleted direct parent. The
   * child is journaled with its true parent and inherited pending state; the
   * deleted parent only authorises deleting a subagent orphan.
   * @param {object} session - announced Session.
   * @param {object} header - announced header.
   * @param {string} parentId - true direct parent.
   * @param {object} parent - journal entry proving the anchor.
   * @returns {Promise<'changed' | 'kept' | 'removed'>} outcome.
   */
  async adoptObservedUnderDeletedParent(session, header, parentId, parent) {
    const sessionId = header.id
    const storage = this.resolveStorage(header)
    if (storage === undefined || !isSafeSessionDir(storage.dir, sessionId)) {
      this.logOnce(`storage:${sessionId}`, `left announced Session "${sessionId}" unrecorded: its JSONL storage location is unavailable`)
      this.removeObservation(session)
      return 'removed'
    }
    if (!await this.appendObserved(header, sessionId, parentId, parent, storage)) return 'kept'
    this.associateDescendant(session)
    this.removeObservation(session)
    return 'changed'
  }

  /**
   * Append one observed child's ownership, with inherited pending state.
   * @param {object} header - announced header.
   * @param {string} sessionId - child id.
   * @param {string} parentId - true direct parent.
   * @param {object} parent - journal entry proving the anchor.
   * @param {{ dir: string }} storage - validated locator result.
   * @returns {Promise<boolean>} whether both required events were written.
   */
  async appendObserved(header, sessionId, parentId, parent, storage) {
    try {
      await this.appendEvent({
        type: 'owned',
        sessionId,
        kind: kindOfHeader(header),
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
      this.retryQueue.delete(sessionId)
      return true
    } catch (error) {
      this.keepForRetry(sessionId, 'ownership', error)
      return false
    }
  }

  /**
   * Keep one observation in the protected retry queue and log it once.
   * @param {string} sessionId - child id.
   * @param {string} event - event purpose.
   * @param {unknown} error - append failure.
   * @returns {void}
   */
  keepForRetry(sessionId, event, error) {
    this.retryQueue.add(sessionId)
    this.logOnce(`append:${sessionId}`, `keeping observed child "${sessionId}" for retry: its ${event} event could not be written (${String(error)})`)
    this.scheduleRetry()
  }

  /**
   * The journal entry that anchors an observed child. The direct parent is
   * preferred; an unannounced subagent parent may be crossed when the live
   * chain reaches a recorded ancestor. The event still names the true parent.
   * @param {object} header - announced header.
   * @returns {object | undefined} anchor entry.
   */
  observedParent(header) {
    const direct = this.journal.entries[header.parentSession]
    if (direct !== undefined) return direct
    const ancestorId = this.recordedAncestor(header)
    return ancestorId === undefined ? undefined : this.journal.entries[ancestorId]
  }

  /**
   * Retry the protected observed queue now. `keepForRetry` also schedules this
   * automatically with a bounded backoff; an explicit call remains safe for
   * recovery code and tests.
   * @returns {Promise<boolean>} whether anything was adopted.
   */
  retryObserved() {
    this.clearRetryTimer()
    return this.enqueue(async () => {
      if (this.admissionClosed) return false
      await this.load()
      if (this.loadFailed
        || this.journalDegraded
        || this.registryUnsupported
        || this.registryAmbiguous
        || this.registryDisputed.size > 0) return false
      try {
        const stored = this.storedListingComplete
          ? new Map(this.bootStoredHeaders ?? [])
          : undefined
        if (stored !== undefined) {
          for (const [sessionId, header] of this.storedHeaders ?? []) stored.set(sessionId, header)
        }
        const reconciled = await this.reconcileFixedPoint(stored)
        const healed = this.healFromJournal(stored)
        if (healed || reconciled.adopted || reconciled.observed) this.refreshSnapshot()
        if ((healed || reconciled.adopted || reconciled.observed)
          && !this.registryDegraded
          && !this.reconciliationDegraded) await this.save()
        await this.resumePendingStops({ retry: true })
        return reconciled.adopted || reconciled.observed || healed
      } finally {
        if (!this.needsRetry()) {
          this.retryDelayMs = RETRY_DELAY_MS
        } else if (!this.loadFailed && !this.journalDegraded && !this.admissionClosed) {
          this.scheduleRetry()
        }
      }
    })
  }

  /**
   * Remove one observation from the queue by identity, not by index, and clear
   * any protected retry marker for it.
   * @param {object} session - announced Session.
   * @returns {void}
   */
  removeObservation(session) {
    const index = this.pending.indexOf(session)
    if (index >= 0) this.pending.splice(index, 1)
    const sessionId = session?.header?.id
    if (typeof sessionId === 'string') this.retryQueue.delete(sessionId)
  }

  /**
   * Add the in-memory record for one announced descendant when its live
   * ancestor chain reaches a recorded id. Synchronous; the caller decides
   * whether to save. The record carries the true direct parent and every
   * descendant kind, including a fork or side chat.
   * @param {object} session - the Session the Host announced.
   * @returns {boolean} whether a record was added.
   */
  associateDescendant(session) {
    const header = session?.header
    if (typeof header?.id !== 'string' || typeof header.parentSession !== 'string') return false
    if (this.state.sessions[header.id] !== undefined) return false
    const existing = this.journal.entries[header.id]
    if (existing === undefined && this.quarantineReason(header, header.id) !== undefined) return false
    let ancestorId = this.recordedAncestor(header)
    if (ancestorId === undefined
      && existing !== undefined
      && existing.deleted !== true
      && existing.kind !== SUBAGENT_KIND
      && existing.parentSessionId === header.parentSession
      && this.journal.entries[header.parentSession]?.deleted === true) {
      // The child was already journaled under a parent that has since been
      // deleted. Its own owned identity is sufficient; do not skip the record
      // merely because the deleted parent is not a live or recorded anchor.
      ancestorId = header.parentSession
    }
    if (ancestorId === undefined) return false
    const storage = this.resolveStorage(header)
    if (storage === undefined) {
      this.warn(`could not record descendant "${header.id}": the JSONL session store is unavailable`)
      return false
    }
    const now = Date.now()
    const parentSessionId = header.parentSession
    const pendingDelete = this.journal.entries[parentSessionId]?.pending === true
      || this.journal.entries[ancestorId]?.pending === true
    try {
      this.state.sessions[header.id] = recordFields({
        sessionId: header.id,
        kind: kindOfHeader(header),
        parentSessionId,
        dir: storage.dir,
        cwd: header.cwd ?? null,
        createdAt: header.createdAt,
        lastActivityAt: now,
        activitySince: now,
        pendingDelete,
      }, now)
    } catch (error) {
      this.warn(`could not record descendant "${header.id}": ${String(error)}`)
      return false
    }
    this.recovery.log('adopted', { id: header.id, reason: 'observed-child' })
    this.refreshSnapshot()
    return true
  }

  /**
   * The nearest recorded ancestor of a Session. Parent links are read from live
   * Sessions; an ancestor that is neither recorded nor live ends the walk with
   * no answer. A live, unrecorded non-subagent is a boundary: its own children
   * belong to it, not to the chat above it. A recorded parent, including a
   * recorded fork, is returned directly. The record still stores the announced
   * Session's true direct parent.
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
   * Whether a pending chat still has unsettled work in its own tree. A chat
   * whose own stop is confirmed remains stopping while a descendant record is
   * pending and not confirmed. `scope` limits descendants to members of the
   * tree that was just discarded; the public list has no scope.
   * @param {object} record - pending chat record.
   * @param {Set<string>} [scope] - ids that belong to the discarded tree.
   * @returns {boolean} whether the chat's work is still stopping.
   */
  hasUnsettledStop(record, scope = undefined) {
    if (record?.pendingDelete !== true) return false
    if (!this.stopped.has(record.sessionId) || this.hasLiveStopWork(record)) return true
    return this.descendantRecords(record.sessionId).some((child) =>
      child.pendingDelete === true
      && (!this.stopped.has(child.sessionId) || this.hasLiveStopWork(child))
      && (scope === undefined || scope.has(child.sessionId)))
  }

  /**
   * Whether a member that a previous pass confirmed now holds live work again.
   * A public list is a read, so it cannot wait for the next retry timer: an
   * Agent that started running, queued input, or an owned job must keep the
   * member in the stopping state immediately and drops the stale confirmation.
   * A job list that cannot be read is not evidence of absence.
   * @param {object} record - pending member.
   * @returns {boolean} whether live work is visible now.
   */
  hasLiveStopWork(record) {
    const agent = this.deps.agents?.get?.(record.sessionId)
    let live = agent !== undefined && agent !== null
      && (agent.status !== 'idle' || this.hasQueuedWork(agent))
    if (!live) {
      try {
        live = this.ownedJobsInChain(record.sessionId).length > 0
      } catch {
        live = true
      }
    }
    if (live) this.stopped.delete(record.sessionId)
    return live
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
  async list() {
    // A list call before startup finishes waits for the same ready promise the
    // Host publishes; it never exposes a half-reconciled registry. A test or
    // caller that already loaded the registry directly does not force a second
    // destructive boot pass.
    if (this.startPromise !== undefined) await this.startPromise
    else if (!this.loaded) await this.start()
    else await this.load()
    return this.enqueue(async () => {
      await this.load()
      this.sequence += 1
      const records = Object.values(this.state.sessions)
      // hasUnsettledStop revalidates live work, so a wake or owned job that
      // started after the last sweep cannot be reported as settled here.
      const stopping = records
        .filter(record => record.kind !== SUBAGENT_KIND && this.hasUnsettledStop(record))
        .map(record => ({ sessionId: record.sessionId, kind: record.kind }))
      return {
        // Ended side chats stay listed (with pendingDelete) so a page reload
        // can keep hiding them until the Host deletes their logs. The browser
        // derives its active count from pendingDelete.
        epoch: this.publisher.epoch,
        sequence: this.sequence,
        degraded: this.journalDegraded || this.registryDegraded || this.reconciliationDegraded,
        stopping,
        stoppingCount: stopping.length,
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
   * @returns {boolean} whether preparation was applied to a live Agent.
   */
  prepareSideChat(sessionId) {
    const agent = this.deps.agents?.get?.(sessionId)
    if (agent === undefined || agent === null) return false
    let prepared = true
    try {
      const goal = this.deps.goals?.get?.(agent)
      if (goal !== undefined && goal !== null && typeof this.deps.goals?.clear === 'function') {
        this.deps.goals.clear(agent, { id: goal.id, revision: goal.revision })
      }
    } catch (error) {
      prepared = false
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
      prepared = false
      this.warn(`could not add the side-chat instruction for "${sessionId}": ${String(error)}`)
    }
    return prepared
  }

  /**
   * Mark one temporary Session and its whole tree for deletion. The Host
   * journals the tree's `pending` event before it archives, cancels, or stops
   * anything; the browser calls this before hiding the chat. A confirmed
   * member folder can be removed by plugin unload, process exit, or the next
   * boot's resumed stop, never by this call. The tree's `pending` event is
   * durable before any state changes.
   * @param {{ sessionId: string }} request - Session to end.
   * @returns {Promise<{ discarded: true, stopping: object[], stoppingCount: number }>} acknowledgement.
   */
  discard(request) {
    return this.enqueue(async () => {
      await this.load()
      this.assertWritable('discard a temporary session')
      const sessionId = request?.sessionId
      const record = this.chatRecord(sessionId)
      if (record === undefined) throw new Error('this Session is not a recorded temporary session')
      const tree = [record, ...this.descendantRecords(sessionId)]
      // One event carries every journal-owned member, so no partial prefix can
      // exist. A record whose journal append failed is not deletion evidence.
      const owned = tree.filter(item => this.journal.entries[item.sessionId] !== undefined)
      if (!owned.includes(record)) {
        throw new Error('cannot discard a temporary session the ownership journal does not own')
      }
      if (owned.length !== tree.length) {
        this.warn(`discarding "${sessionId}" without ${String(tree.length - owned.length)} unowned member(s)`)
      }
      await this.appendEvent({
        type: 'pending',
        sessionIds: owned.map(item => item.sessionId),
        reason: 'discard',
        at: Date.now(),
      })
      this.markMembers(owned)
      try {
        await this.save()
      } catch (error) {
        // The pending event is durable; a failed index write is repaired from
        // the journal at the next start and must not leave work running now.
        this.warn(`could not save the pending tree for "${sessionId}": ${String(error)}`)
      }
      this.refreshSnapshot()
      await this.stopMembers(owned)
      const ownedIds = new Set(owned.map(item => item.sessionId))
      const stopping = owned
        .filter(item => item.kind !== SUBAGENT_KIND && this.hasUnsettledStop(item, ownedIds))
        .map(item => ({ sessionId: item.sessionId, kind: item.kind }))
      return { discarded: true, stopping, stoppingCount: stopping.length }
    })
  }

  /**
   * Mark every member pending and stopping after the durable tree event. The
   * caller saves the registry before any stop request is issued.
   * @param {object[]} members - journal-owned tree records.
   * @returns {void}
   */
  markMembers(members) {
    for (const record of members) {
      record.pendingDelete = true
      this.stopped.delete(record.sessionId)
      this.trace(`mark ${record.sessionId}`)
    }
  }

  /**
   * Run the one stop path over records already marked pending: archive each
   * chat with its own activity stop, cancel each live Agent, stop and await
   * every owned job, then confirm settlement. A confirmed member stays pending
   * for the deletion boundary; an unconfirmed one is retried.
   * @param {object[]} members - records to stop.
   * @param {{ retry?: boolean }} [options] - whether this pass is a retry.
   * @returns {Promise<void>}
   */
  async stopMembers(members, options = {}) {
    const active = members.filter(record => record?.pendingDelete === true
      && !this.stopped.has(record.sessionId))
    if (active.length === 0) return
    const failed = new Set()
    await this.archiveMembers(active, failed)
    this.cancelMembers(active, failed)
    for (const record of active) {
      // Archiving or cancelling one member can fail; its owned out-of-process
      // work is still stopped rather than left running behind the failure.
      if (!await this.stopOwnedJobs(record.sessionId)) failed.add(record.sessionId)
    }
    for (const record of active) {
      if (failed.has(record.sessionId)) continue
      if (await this.confirmStopped(record, { retry: options.retry === true })) {
        this.stopped.add(record.sessionId)
      }
    }
    if (this.hasPendingStops()) this.scheduleRetry()
  }

  /**
   * Archive every chat in a stopping tree with its own activity stop.
   * @param {object[]} members - active pending members.
   * @param {Set<string>} failed - members whose stop has failed.
   * @returns {Promise<void>}
   */
  async archiveMembers(members, failed) {
    const registry = this.deps.workspaceRegistry
    if (typeof registry?.archiveSession !== 'function') return
    for (const record of members) {
      if (record.kind === SUBAGENT_KIND) continue
      try {
        await registry.archiveSession(record.sessionId, { stopActivity: true })
        this.trace(`archive ${record.sessionId}`)
      } catch (error) {
        failed.add(record.sessionId)
        this.warn(`could not archive "${record.sessionId}" for its stop: ${String(error)}`)
      }
    }
  }

  /**
   * Cancel every live Agent, or the Host Session command when a chat outlives
   * its Agent. A subagent with no Agent is covered by its job chain, including
   * a background job registered to its parent.
   * @param {object[]} members - active pending members.
   * @param {Set<string>} failed - members whose stop has failed.
   * @returns {void}
   */
  cancelMembers(members, failed) {
    for (const record of members) {
      const agent = this.deps.agents?.get?.(record.sessionId)
      if (agent === undefined || agent === null) {
        this.cancelWithoutAgent(record, failed)
        continue
      }
      if (typeof agent.cancel === 'function') {
        try {
          agent.cancel({ kind: record.kind === SUBAGENT_KIND ? 'parent' : 'user' })
          if (record.kind === SUBAGENT_KIND) this.trace(`cancel ${record.sessionId}`)
          continue
        } catch (error) {
          failed.add(record.sessionId)
          this.warn(`could not cancel "${record.sessionId}": ${String(error)}`)
          continue
        }
      }
      if (record.kind !== SUBAGENT_KIND) {
        this.cancelSessionCommand(record, failed)
        continue
      }
      failed.add(record.sessionId)
      this.warn(`could not cancel "${record.sessionId}": its live Agent has no cancel path`)
    }
  }

  /**
   * Cancel a chat that has a live Session but no Agent, when the Host command
   * exists. A subagent without either has no local turn left to cancel.
   * @param {object} record - pending member.
   * @param {Set<string>} failed - members whose stop has failed.
   * @returns {void}
   */
  cancelWithoutAgent(record, failed) {
    if (record.kind === SUBAGENT_KIND) return
    if (this.deps.sessions.get(record.sessionId) === undefined) return
    this.cancelSessionCommand(record, failed)
  }

  /**
   * Issue the Host session cancel command for a chat, recording a throw as a
   * stop failure so the member is retried.
   * @param {object} record - pending chat.
   * @param {Set<string>} failed - members whose stop has failed.
   * @returns {void}
   */
  cancelSessionCommand(record, failed) {
    if (typeof this.deps.sessionController?.cancel !== 'function') {
      failed.add(record.sessionId)
      this.warn(`could not cancel "${record.sessionId}": its live Agent has no cancel path`)
      return
    }
    try {
      this.deps.sessionController.cancel({ sessionId: record.sessionId })
    } catch (error) {
      failed.add(record.sessionId)
      this.warn(`could not cancel temporary session "${record.sessionId}": ${String(error)}`)
    }
  }

  /**
   * Kill and await every running or stopping job owned by one Session. A list
   * failure, a throwing kill or a wait that does not reach a terminal status
   * leaves the member unconfirmed.
   * @param {string} sessionId - owning Session id.
   * @returns {Promise<boolean>} whether every owned job settled.
   */
  async stopOwnedJobs(sessionId) {
    let jobs
    try {
      jobs = this.ownedJobs(sessionId)
    } catch (error) {
      this.warn(`could not list jobs for "${sessionId}": ${String(error)}`)
      return false
    }
    let settled = true
    for (const job of jobs) {
      try {
        this.deps.jobs.kill(job.id, sessionId, 'temporary session stopped')
      } catch (error) {
        settled = false
        this.warn(`could not stop job "${job.id}" for "${sessionId}": ${String(error)}`)
        continue
      }
      let view
      try {
        view = await this.deps.jobs.wait(job.id, STOP_WAIT_MS, sessionId)
      } catch (error) {
        settled = false
        this.warn(`could not await job "${job.id}" for "${sessionId}": ${String(error)}`)
        continue
      }
      if (view === undefined || LIVE_JOB_STATUSES.has(view.status)) {
        settled = false
        this.warn(`job "${job.id}" for "${sessionId}" did not settle`)
        continue
      }
      this.trace(`job ${job.id} settled`)
    }
    return settled
  }

  /**
   * Every running or stopping job the named Session owns. A list that does not
   * return an array is not evidence of absence.
   * @param {string} sessionId - owning Session id.
   * @returns {object[]} live job views.
   */
  ownedJobs(sessionId) {
    if (typeof this.deps.jobs?.list !== 'function') return []
    const jobs = this.deps.jobs.list(sessionId)
    if (!Array.isArray(jobs)) throw new Error('the job registry did not return a list')
    return jobs.filter(job => job?.owner === sessionId && LIVE_JOB_STATUSES.has(job.status))
  }

  /**
   * Every live job owned by one member or a pending ancestor. A background
   * one-shot subagent job is registered to its parent Agent, so a child's own
   * job list cannot prove that the child's work stopped. A temporary side chat
   * points at an ordinary source chat, whose unrelated jobs are not its work.
   * @param {string} sessionId - member to inspect.
   * @returns {object[]} live job views for the member and its pending ancestors.
   */
  ownedJobsInChain(sessionId) {
    const jobs = []
    const seen = new Set()
    let current = sessionId
    while (typeof current === 'string' && current !== '' && !seen.has(current)) {
      if (current !== sessionId && this.state.sessions[current]?.pendingDelete !== true) break
      seen.add(current)
      jobs.push(...this.ownedJobs(current))
      current = this.state.sessions[current]?.parentSessionId
    }
    return jobs
  }

  /**
   * Whether live owned work in a member's chain still blocks confirmation and
   * deletion. An unreadable list is not evidence of absence and blocks the same
   * way a live job does.
   * @param {string} sessionId - candidate Session id.
   * @returns {boolean} whether deletion must wait.
   */
  hasLiveOwnedJobs(sessionId) {
    try {
      if (this.ownedJobsInChain(sessionId).length === 0) return false
      this.warn(`keeping "${sessionId}": an owned job is still live`)
      return true
    } catch (error) {
      this.warn(`keeping "${sessionId}": its jobs could not be listed (${String(error)})`)
      return true
    }
  }

  /**
   * Confirm one pending member stopped: it and its pending ancestors own no
   * live job, and either it has no Agent or has an idle Agent with no queued
   * work whose `whenIdle()` settles within the bounded wait. A failed job
   * listing is not confirmation.
   * @param {object} record - pending member.
   * @param {{ retry?: boolean }} [options] - whether this pass is a retry.
   * @returns {Promise<boolean>} whether the member is confirmed stopped.
   */
  async confirmStopped(record, options = {}) {
    if (this.hasLiveOwnedJobs(record.sessionId)) return false
    const agent = this.deps.agents?.get?.(record.sessionId)
    if (agent !== undefined && agent !== null) {
      if (!await this.confirmIdle(agent, record.sessionId)) return false
      // A job can start while whenIdle() is awaited, so the job check must
      // follow the wait as well as precede it.
      if (this.hasLiveOwnedJobs(record.sessionId)) return false
      if (options.trace !== false) {
        this.trace(record.kind === SUBAGENT_KIND
          ? `confirmed ${record.sessionId}`
          : `idle ${record.sessionId}`)
      }
    } else if (options.trace !== false) {
      this.trace(options.retry === true
        ? `retry confirmed ${record.sessionId}`
        : `confirmed ${record.sessionId}`)
    }
    return true
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
   * live work remains in its owner chain. The `deleted` event is durable before
   * the removal; a failed append leaves the folder untouched.
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
    // This is the final synchronous turn before removal. A job that appeared
    // during the durable append or the idle wait must still block deletion.
    if (this.hasLiveOwnedJobs(record.sessionId)) return false
    try {
      // The final liveness check and the removal are one synchronous turn, so
      // a same-process Session cannot become live between them.
      rmSync(target, { recursive: true, force: true })
      if (existsSync(target)) {
        this.warn(`could not delete temporary session "${record.sessionId}": its folder is still present`)
        return false
      }
      return true
    } catch (error) {
      this.warn(`could not delete temporary session "${record.sessionId}": ${String(error)}`)
      return false
    }
  }

  /**
   * Promotion is disabled. The endpoint remains so an older browser or a
   * stale call receives a specific refusal instead of an unknown method.
   * @param {{ sessionId: string, title?: string }} request - Session to keep.
   * @returns {Promise<never>} rejects with the removal notice.
   */
  promote(request) { // eslint-disable-line no-unused-vars
    return Promise.reject(new Error('promotion is disabled'))
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
    if (this.registryDisputed.size > 0) return 0
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
      if (this.hasLiveOwnedJobs(sessionId)) continue
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
      // Capture the queue before load's own drain can adopt and remove it, so
      // the cleanup pass still keeps the anchor that brought the child in.
      const observedAtBoot = [...this.pending]
      await this.load()
      // A later load returns the partial state instead of throwing again. Do
      // not publish readiness or delete from a boot that never completed.
      if (this.loadFailed) throw this.loadError ?? new Error('temporary-session boot failed')
      await this.reapNow(observedAtBoot)
      this.ready = true
    })
  }

  /**
   * The boot cleanup body, already serialized by {@link reap}. Reconciliation
   * and the observed queue are drained before any record is dropped. A degraded
   * pass keeps the validated snapshot, writes no registry and deletes nothing;
   * the next healthy pass heals the journal observations.
   * @param {object[]} [observedAtBoot] - observations present before load drained them.
   * @returns {Promise<void>}
   */
  async reapNow(observedAtBoot = []) {
    if (this.loadFailed) {
      this.warn('skipping boot cleanup: the registry load did not complete')
      return
    }
    if (this.journalDegraded) {
      this.warn('skipping boot cleanup: the ownership journal is degraded')
      return
    }
    if (this.registryUnsupported) {
      this.warn('skipping boot cleanup: the temporary-session registry version is unsupported')
      this.snapshot = Object.freeze({ degraded: true, sessions: Object.freeze([]) })
      return
    }
    if (this.registryAmbiguous) {
      this.warn('skipping boot cleanup: the temporary-session registry framing is ambiguous')
      this.snapshot = Object.freeze({ degraded: true, sessions: Object.freeze([]) })
      return
    }
    if (this.registryDisputed.size > 0) {
      this.warn('skipping boot cleanup: a temporary-session registry row disagrees with the journal or header')
      this.refreshSnapshot()
      return
    }
    // Keep the boot listing separate: the fresh listing can omit an id that
    // the boot listing saw, and omission is not absence.
    const bootHeaders = this.storedHeaders
    const storedHeaders = new Map()
    const settlementDeferred = this.listingUncertain
    let listingComplete = false
    try {
      const snapshots = await this.deps.sessionPersistence.list()
      const byId = new Map()
      for (const snapshot of snapshots) {
        const id = snapshot?.header?.id
        if (typeof id !== 'string') continue
        storedHeaders.set(id, snapshot.header)
        byId.set(id, snapshot)
      }
      this.storedSnapshots = byId
      this.storedHeaders = storedHeaders
      this.storedListingComplete = true
      this.listingUncertain = false
      listingComplete = true
    } catch (error) {
      this.storedListingComplete = false
      this.listingUncertain = true
      this.warn(`could not list stored sessions during temporary-session cleanup: ${String(error)}`)
    }
    // A Session announced while the listing was being taken is in the observed
    // queue but not in that listing. Drain it before the cleanup decision.
    // A healthy later pass retries stored reconciliation too, so clearing a
    // degraded seam adopts a child that was present only in the stored list.
    // Reconcile against both listings: an omission is not absence.
    const reconcileHeaders = listingComplete ? new Map(bootHeaders ?? []) : undefined
    if (reconcileHeaders !== undefined) {
      for (const [sessionId, header] of storedHeaders) reconcileHeaders.set(sessionId, header)
    }
    // The registry may have changed after boot. Read its current bytes before
    // any adoption or deletion: an unsupported or ambiguous replacement must
    // fail closed, and fresh damage must heal without trusting stale evidence.
    const current = await this.refreshRegistryRead(reconcileHeaders)
    if (this.registryUnsupported
      || this.registryUnreadable
      || this.registryAmbiguous
      || (current.changed === true && current.context?.inspection?.supported === false)) {
      this.refreshSnapshot()
      this.warn('skipping boot cleanup: the current temporary-session registry is no longer usable')
      return
    }
    // A boot whose registry was unreadable skipped reservation resolution and
    // migration. Resume those durable stages on the first readable sweep,
    // before settlement or reconciliation can act on half-started state.
    if (this.startupStagesPending && listingComplete && this.registryRead !== undefined) {
      await this.resolveReservations(reconcileHeaders)
      await this.migrate(this.registryRead, reconcileHeaders)
      this.migrationIncomplete = this.marker === undefined && this.journal.migrationComplete === undefined
      if (!this.migrationIncomplete) this.startupStagesPending = false
    }
    // A boot whose stored listing failed could not validate its complete rows.
    // Settle the retained evidence before reconciliation can adopt or delete a
    // child, so a disagreement is quarantined before destructive work starts.
    // A newly damaged or changed current file needs the same settlement. A
    // healthy boot already settled at load, and settling again would treat an
    // in-memory observation that was never persisted as a damaged row.
    const changedNeedsSettlement = current.changed === true
      && current.missing !== true
      && current.context !== undefined
    const settlementRequired = settlementDeferred || current.damaged === true || changedNeedsSettlement
    const settlementNeeded = settlementRequired || this.settlementPending
    const canSettle = listingComplete && this.registryRead !== undefined
    const unsettledEvidence = changedNeedsSettlement
      || current.damaged === true
      || this.settlementPending
    if (unsettledEvidence && !canSettle) {
      this.settlementPending = true
      this.registryDegraded = true
      this.refreshSnapshot()
      this.warn('skipping boot cleanup: changed registry evidence could not be settled safely')
      return
    }
    if (this.migrationIncomplete) {
      // Migration can still change which stored ids are authoritative. Never
      // reconcile, heal or remove while that startup stage is unfinished, and
      // retain the settlement gate for the first pass that completes it.
      this.settlementPending = true
      this.registryDegraded = true
      this.refreshSnapshot()
      this.warn('skipping boot cleanup: the first ownership migration is incomplete')
      return
    }
    const settled = canSettle && settlementNeeded
      ? this.settleRegistry(this.registryRead, reconcileHeaders)
      : false
    if (canSettle && settlementNeeded) this.settlementPending = false
    if (this.registryRead?.damaged === true) this.registryDegraded = true
    const reconciled = await this.reconcileFixedPoint(reconcileHeaders)
    const healed = this.healFromJournal(reconcileHeaders)
    let changed = reconciled.adopted || reconciled.observed || settled || healed
    // Degraded reconciliation is a write-free, delete-free pass. The journal may
    // already hold observed descendants; the next healthy pass adopts them.
    if (this.reconciliationDegraded) {
      this.warn('degraded reconciliation: keeping the snapshot, writing no registry and deleting nothing')
      return
    }
    if (this.registryDegraded && this.retryRegistryHealing()) {
      changed = true
    }
    if (this.registryDegraded) {
      this.refreshSnapshot()
      this.warn('registry degraded: keeping every folder and skipping boot cleanup')
      return
    }
    // Finish tombstones first: a kill after the durable `deleted` event leaves
    // the folder for this pass, even when its stored header is already gone.
    await this.finishJournalDeletes(storedHeaders)
    await this.resumePendingStops()
    const kept = this.collectKeptSessions(storedHeaders, observedAtBoot, bootHeaders)
    changed = await this.deleteReapedSessions(storedHeaders, kept) || changed
    this.refreshSnapshot()
    if (changed) await this.save()
    if (listingComplete) await this.pruneJournal(storedHeaders, bootHeaders)
  }

  /**
   * Collect every record that must survive this reap. A live chat keeps its
   * descendants, a queued announcement keeps its parent chain, and an
   * unrecorded stored or observed child keeps every recorded ancestor.
   * @param {Map<string, object>} storedHeaders - stored headers from this reap.
   * @param {object[]} observedAtBoot - announcements present before load drained them.
   * @param {Map<string, object>} [bootHeaders] - stored headers read at load.
   * @returns {Set<string>} ids that must not be deleted in this pass.
   */
  collectKeptSessions(storedHeaders, observedAtBoot, bootHeaders = this.storedHeaders) {
    // Collected before anything is deleted, so a removed parent cannot break the chain for its children.
    const kept = new Set()
    for (const [sessionId, record] of Object.entries(this.state.sessions)) {
      if (record === null || typeof record !== 'object' || !this.hasLiveOwner(sessionId)) continue
      for (const child of this.descendantRecords(sessionId)) kept.add(child.sessionId)
    }
    // An announcement can arrive before its queued recorder runs. Keep the
    // observed session and its parent chain through the queue handoff.
    for (const observation of [...observedAtBoot, ...this.pending]) {
      this.addAncestorChain(kept, observation?.header?.id, storedHeaders, bootHeaders)
    }
    // A recorded parent is never dropped while an unrecorded stored or observed
    // child still names it as parent. The next start can finish the tree. When
    // this pass's listing failed, the boot listing is still evidence, not absence.
    // A successful listing can still omit an id that this boot's listing saw;
    // omission is not absence. Keep anchors from both listings.
    const anchorHeaders = new Map(bootHeaders ?? [])
    for (const [sessionId, header] of storedHeaders) anchorHeaders.set(sessionId, header)
    for (const header of anchorHeaders.values()) {
      if (typeof header?.parentSession !== 'string') continue
      if (this.journal.entries[header.id] !== undefined) continue
      this.addAncestorChain(kept, header.parentSession, storedHeaders, bootHeaders)
    }
    return kept
  }

  /**
   * Add an id and every resolvable ancestor to the kept set. The current
   * listing wins over the boot listing; a live Session closes the chain.
   * @param {Set<string>} kept - ids that must survive.
   * @param {string | undefined} startId - first id to keep.
   * @param {Map<string, object>} storedHeaders - current stored headers.
   * @param {Map<string, object> | undefined} bootHeaders - stored headers at load.
   * @returns {void}
   */
  addAncestorChain(kept, startId, storedHeaders, bootHeaders) {
    const seen = new Set()
    let cursor = startId
    while (typeof cursor === 'string' && !seen.has(cursor)) {
      seen.add(cursor)
      kept.add(cursor)
      const header = storedHeaders.get(cursor)
        ?? bootHeaders?.get(cursor)
        ?? this.deps.sessions.get(cursor)?.header
      cursor = header?.parentSession
    }
  }

  /**
   * Delete every recorded Session this reap did not keep. A malformed row is
   * dropped; a tombstone whose folder is already absent is cleared; every real
   * removal still goes through {@link deletionTarget} and {@link removeStorage}.
   * @param {Map<string, object>} storedHeaders - stored headers from this reap.
   * @param {Set<string>} kept - ids that must survive.
   * @returns {Promise<boolean>} whether the registry changed.
   */
  async deleteReapedSessions(storedHeaders, kept) {
    let changed = false
    for (const [sessionId, record] of Object.entries(this.state.sessions)) {
      if (record === null || typeof record !== 'object') {
        delete this.state.sessions[sessionId]
        changed = true
        continue
      }
      if (this.deps.sessions.get(sessionId) !== undefined || kept.has(sessionId)) continue
      if (record.pendingDelete === true && !this.stopped.has(sessionId)) {
        this.warn(`keeping "${sessionId}": its stop is not confirmed`)
        continue
      }
      if (this.hasLiveOwnedJobs(sessionId)) continue
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
    return changed
  }

  /**
   * Resume cancellation for pending records restored from the journal. The
   * record and folder stay until a later pass observes the Agent absent or
   * confirmed idle; this pass only re-issues the stop.
   * @returns {Promise<void>}
   */
  async resumePendingStops(options = {}) {
    for (const record of Object.values(this.state.sessions)) {
      if (record?.pendingDelete !== true || !this.stopped.has(record.sessionId)) continue
      let jobs
      try {
        jobs = this.ownedJobs(record.sessionId)
      } catch {
        this.stopped.delete(record.sessionId)
        continue
      }
      const agent = this.deps.agents?.get?.(record.sessionId)
      const renewed = jobs.length > 0
        || (agent !== undefined && agent !== null
          && (agent.status !== 'idle' || this.hasQueuedWork(agent)))
      if (renewed) this.stopped.delete(record.sessionId)
    }
    const records = Object.values(this.state.sessions).filter(record => record?.pendingDelete === true
      && !this.stopped.has(record.sessionId))
    if (records.length === 0) return
    await this.stopMembers(records, options)
  }

  /**
   * Compact the ownership journal after replay, the observed-queue handoff and
   * reap. An entry is retained while a registry record, a stored child, a
   * queued observation, a pending/deleted state or its own folder needs it; a
   * reservation is retained until promoted or dropped. A no-longer-needed
   * entry gets the 30-day age bound, and the migration events are never pruned.
   * @param {Map<string, object>} storedHeaders - stored headers from this reap.
   * @param {Map<string, object>} [bootHeaders] - stored headers read at load.
   * @returns {Promise<void>}
   */
  async pruneJournal(storedHeaders, bootHeaders = this.storedHeaders) {
    if (this.journalDegraded) return
    // A healthy listing can omit an id the boot listing saw. Retain anchors
    // from both so a later boot can still reconcile that child.
    const knownHeaders = new Map(bootHeaders ?? [])
    for (const [sessionId, header] of storedHeaders) knownHeaders.set(sessionId, header)
    const keep = new Set()
    const addAncestors = (id) => {
      const seen = new Set()
      let cursor = id
      while (typeof cursor === 'string' && !seen.has(cursor)) {
        seen.add(cursor)
        keep.add(cursor)
        const header = knownHeaders.get(cursor) ?? this.deps.sessions.get(cursor)?.header
        cursor = header?.parentSession
      }
    }
    for (const record of Object.values(this.state.sessions)) addAncestors(record.sessionId)
    for (const observation of this.pending) addAncestors(observation?.header?.id)
    for (const header of knownHeaders.values()) {
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
    if (this.hasQueuedWork(agent)) return false
    if (typeof agent.whenIdle === 'function') {
      let timer
      let settled
      try {
        settled = await Promise.race([
          Promise.resolve().then(() => agent.whenIdle()).then(() => true, () => false),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), STOP_WAIT_MS)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (!settled) return false
    }
    const current = sessionId === undefined ? agent : this.deps.agents?.get?.(sessionId)
    if (current === undefined) return true
    return current === agent && current.status === 'idle' && !this.hasQueuedWork(current)
  }

  /**
   * Whether an Agent still holds input that would wake it after cancellation.
   * @param {object} agent - live Agent.
   * @returns {boolean} whether a queued turn or step remains.
   */
  hasQueuedWork(agent) {
    return (Array.isArray(agent.inbox?.nextTurn) && agent.inbox.nextTurn.length > 0)
      || (Array.isArray(agent.inbox?.nextStep) && agent.inbox.nextStep.length > 0)
  }

  /**
   * On plugin unload, publish the registry synchronously, then delete the storage of Sessions
   * already ended by the user. A pending member with a running Agent, an unsettled job, or a
   * failed stop stays recorded for the next boot; a live but idle Session has no work left and
   * may be removed only after `whenIdle()` settles within the bounded check.
   */
  cleanupPending() {
    this.flushRegistrySync()
    return this.enqueue(async () => {
      await this.load()
      if (this.loadFailed || this.journalDegraded || this.registryDegraded || this.registryAmbiguous || this.reconciliationDegraded || this.migrationIncomplete) {
        this.warn('skipping unload cleanup: the ownership evidence is degraded')
        return
      }
      await this.resumePendingStops()
      for (const record of Object.values(this.state.sessions)) {
        if (record?.pendingDelete !== true) continue
        // The stop pass owns failure reporting. A member whose archive, cancel
        // or job stop failed is not deletion evidence even if it now has no
        // live Agent of its own.
        if (!this.stopped.has(record.sessionId)) {
          this.warn(`keeping "${record.sessionId}" on unload: its stop is not confirmed`)
          continue
        }
        if (!(await this.confirmStopped(record, { trace: false }))) {
          this.warn(`keeping "${record.sessionId}" on unload: its stop is not confirmed`)
          continue
        }
        this.stopped.add(record.sessionId)
        await this.removeStorage(
          record,
          true,
          () => this.confirmStopped(record, { trace: false }),
          () => {
            const current = this.deps.agents?.get?.(record.sessionId)
            return current === undefined
              || (current.status === 'idle' && !this.hasQueuedWork(current))
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
