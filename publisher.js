/**
 * The one process-shared registry publisher.
 *
 * A plugin reload can leave two module instances alive, and the unload path
 * writes synchronously while a queued save may still be staging its bytes. One
 * publisher, held on `globalThis` and guarded by `records.lock`, keeps those
 * writers ordered: it owns an epoch, the current mutation generation and the
 * last published generation. A write captures a ticket (its epoch and the
 * generation it started from), stages a unique file, and in one synchronous
 * section checks its epoch and generation against the shared current values
 * before renaming.
 *
 * @module dsh-temp-session-plugin/publisher
 */

import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Process-shared publisher state, keyed by the registry file it publishes. */
const PUBLISHERS = Symbol.for('dsh.temp-session.publishers')

/** The shared state for one registry file, created on first use. */
function sharedFor(file) {
  if (globalThis[PUBLISHERS] === undefined) globalThis[PUBLISHERS] = new Map()
  let shared = globalThis[PUBLISHERS].get(file)
  if (shared === undefined) {
    shared = { epoch: 0, generation: 0, published: 0, degraded: false }
    globalThis[PUBLISHERS].set(file, shared)
  }
  return shared
}

/** Whether a pid is alive; a permission error still means the process exists. */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Make one directory entry durable; a failure is reported to the caller. */
function syncDirectory(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The rename already happened; close cannot undo it.
      }
    }
  }
}

/**
 * Publisher for one registry file. Constructing it increments the shared epoch
 * and fences every earlier instance in this process.
 */
export class Publisher {
  /**
   * @param {object} options - registry location and diagnostics.
   * @param {string} options.file - registry file this publisher writes.
   * @param {string} options.lockFile - `records.lock` beside the registry.
   * @param {{ warn: (message: string) => void }} [options.logger] - Host logger.
   */
  constructor({ file, lockFile, logger }) {
    this.file = file
    this.lockFile = lockFile
    this.logger = logger
    this.counter = 0
    this.lockWarned = false
    this.shared = sharedFor(file)
    this.shared.epoch += 1
    this.epoch = this.shared.epoch
  }

  /** The current mutation generation, shared by every instance. */
  get generation() {
    return this.shared.generation
  }

  /** The generation the durable file currently holds. */
  get published() {
    return this.shared.published
  }

  /** Whether every publish must be refused. */
  get degraded() {
    return this.shared.degraded === true
  }

  /**
   * Degrade or clear every write. The journal and registry health own this
   * flag, so a write during a broken journal can never publish.
   * @param {boolean} value - degraded state.
   * @returns {void}
   */
  setDegraded(value) {
    this.shared.degraded = value === true
  }

  /** Record one trusted mutation. Every captured generation before it is stale. */
  mutate() {
    this.shared.generation += 1
  }

  /**
   * Claim the writer lock, stealing a stale one. A live foreign pid keeps the
   * lock and refuses the write. The missing-lock path is an exclusive create,
   * so two simultaneous starters cannot both win; the stale path moves the old
   * lock aside atomically before retrying.
   * @returns {boolean} whether this process may write.
   */
  holdsLock() {
    mkdirSync(dirname(this.lockFile), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (this.acquireLock()) return true
      let text
      try {
        text = readFileSync(this.lockFile, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        return false
      }
      const pid = Number.parseInt(text.trim(), 10)
      if (pid === process.pid) return true
      if (Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) {
        if (!this.lockWarned) {
          this.lockWarned = true
          this.logger?.warn?.(`another process (pid ${String(pid)}) holds the temporary-session registry lock`)
        }
        return false
      }
      this.counter += 1
      const stolen = `${this.lockFile}.stale.${process.pid}.${this.counter}`
      try {
        renameSync(this.lockFile, stolen)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        return false
      }
      let movedText
      try {
        movedText = readFileSync(stolen, 'utf8')
      } catch {
        movedText = ''
      }
      const movedPid = Number.parseInt(movedText.trim(), 10)
      const sameLock = movedPid === pid || (Number.isNaN(movedPid) && Number.isNaN(pid))
      if (!sameLock) {
        // A newer lock appeared between the read and the rename. Put it back
        // and let its owner keep the claim.
        try {
          linkSync(stolen, this.lockFile)
        } catch (error) {
          if (error?.code !== 'EEXIST') {
            this.logger?.warn?.(`could not restore a stolen temporary-session registry lock: ${String(error)}`)
          }
        }
        try {
          unlinkSync(stolen)
        } catch {
          // The restored link already owns the lock bytes.
        }
        return false
      }
      try {
        unlinkSync(stolen)
      } catch {
        // The stale lock is no longer needed.
      }
    }
    return false
  }

  /** Publish this process's pid into the lock path atomically via a hard link. */
  acquireLock() {
    this.counter += 1
    const temp = `${this.lockFile}.claim.${process.pid}.${this.counter}`
    try {
      // The temp file already carries the pid, so no contender can observe an
      // empty lock between creation and the pid write. link() is the exclusive
      // publish: it fails with EEXIST when a lock already exists.
      writeFileSync(temp, `${process.pid}\n`, { mode: 0o600 })
      linkSync(temp, this.lockFile)
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        this.logger?.warn?.(`could not claim the temporary-session registry lock: ${String(error)}`)
      }
      return false
    } finally {
      try {
        unlinkSync(temp)
      } catch {
        // The published link, when it exists, owns the lock bytes.
      }
    }
  }

  /**
   * Start one write: capture the epoch and mutation generation and allocate a
   * globally unique staging path. Nothing has been written yet.
   * @returns {{ epoch: number, generation: number, staging: string } | undefined}
   *   the ticket, or undefined when this write must not happen.
   */
  begin() {
    if (this.degraded || this.shared.epoch !== this.epoch) return undefined
    if (!this.holdsLock()) return undefined
    this.counter += 1
    return {
      epoch: this.epoch,
      generation: this.shared.generation,
      staging: `${this.file}.${process.pid}.${this.epoch}.${this.shared.generation}.${this.counter}.tmp`,
    }
  }

  /**
   * Finish one write. The epoch and generation check and the rename are one
   * synchronous section, so no await can interleave a newer publish here.
   * @param {{ epoch: number, generation: number, staging: string }} ticket - from {@link begin}.
   * @returns {boolean} whether this write became the published registry.
   * @throws the rename or fsync failure itself.
   */
  commit(ticket) {
    if (this.shared.epoch !== ticket.epoch
      || this.degraded
      || this.shared.generation !== ticket.generation) {
      this.discardStaging(ticket)
      return false
    }
    try {
      renameSync(ticket.staging, this.file)
    } catch (error) {
      this.discardStaging(ticket)
      throw error
    }
    if (!syncDirectory(dirname(this.file))) {
      throw new Error('could not fsync the temporary-session registry directory')
    }
    this.shared.published = ticket.generation
    return true
  }

  /**
   * Write one registry body: begin, stage the bytes, commit.
   * @param {string} text - encoded registry.
   * @returns {boolean} whether this write became the published registry.
   * @throws the write failure itself.
   */
  publish(text) {
    const ticket = this.begin()
    if (ticket === undefined) return false
    try {
      writeFileSync(ticket.staging, text, { mode: 0o600 })
    } catch (error) {
      this.discardStaging(ticket)
      throw error
    }
    return this.commit(ticket)
  }

  /** Remove a staging file this write will not publish. */
  discardStaging(ticket) {
    if (!existsSync(ticket.staging)) return
    try {
      unlinkSync(ticket.staging)
    } catch (error) {
      this.logger?.warn?.(`could not remove a stale temporary-session staging file: ${String(error)}`)
    }
  }
}
