/**
 * The one record shape every temporary Session shares: a chat created by the
 * browser, a fork made from one, or a subagent announced under one.
 *
 * The registry, the ownership journal, healing and the browser listing all
 * describe a Session with these fields, so a reader never has to know which
 * path produced a record. Host paths (`dir`, `cwd`) stay on this side of the
 * wire; the browser view is projected from the same record.
 *
 * @module dsh-temp-session-plugin/records
 */

/**
 * Every recorded Session kind. `side` is a fork the user upgraded, `fork` is
 * an automatic fork, and `subagent` is a child Session announced by the Host.
 */
export const RECORD_KINDS = Object.freeze(['main', 'side', 'fork', 'subagent'])

const KINDS = new Set(RECORD_KINDS)

/** A Session id, a direct parent id, or no value at all. */
function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A non-negative safe-integer clock reading. */
function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Build one validated record.
 *
 * Internal callers depend on this shape, so an invalid field is a programming
 * error and throws. A record read from disk goes through {@link readRecord}.
 * A missing or invalid clock is replaced by `now`, the bootstrap every record
 * without an activity clock gets, so an unclocked record can never expire
 * before one full window.
 * @param {object} fields - the record fields, already resolved from a header.
 * @param {number} now - current wall clock, used for missing clocks.
 * @returns {object} the frozen field set a registry entry carries.
 * @throws {TypeError} when a required field is invalid.
 */
export function recordFields(fields, now) {
  if (fields === null || typeof fields !== 'object') throw new TypeError('a temporary-session record must be an object')
  const { sessionId, kind, title = '', dir, cwd = null, createdAt, lastActivityAt, activitySince, pendingDelete = false } = fields
  if (!isId(sessionId)) throw new TypeError('a temporary-session record needs a Session id')
  if (!KINDS.has(kind)) throw new TypeError(`unknown temporary-session kind "${String(kind)}"`)
  if (typeof dir !== 'string' || dir === '') throw new TypeError('a temporary-session record needs its storage directory')
  if (cwd !== null && typeof cwd !== 'string') throw new TypeError('a temporary-session record cwd must be a string or null')
  const parentSessionId = fields.parentSessionId ?? null
  if (parentSessionId !== null && !isId(parentSessionId)) throw new TypeError('a temporary-session record parent must be a Session id or null')
  if (typeof title !== 'string') throw new TypeError('a temporary-session record title must be a string')
  if (typeof pendingDelete !== 'boolean') throw new TypeError('a temporary-session record pending flag must be a boolean')
  return {
    sessionId,
    kind,
    parentSessionId,
    title,
    dir,
    cwd,
    createdAt: isTimestamp(createdAt) ? createdAt : now,
    lastActivityAt: isTimestamp(lastActivityAt) ? lastActivityAt : now,
    activitySince: isTimestamp(activitySince) ? activitySince : now,
    pendingDelete,
  }
}

/**
 * Read one record from stored bytes. A stored record is untrusted input: an
 * unusable one is dropped with a warning by the caller instead of failing the
 * whole boot. Only the member key may supply a missing id.
 * @param {unknown} value - the member value from the registry.
 * @param {string} key - the member key, used when the value has no id.
 * @param {number} now - current wall clock for missing clocks.
 * @returns {object | undefined} the validated record.
 */
export function readRecord(value, key, now) {
  if (value === null || typeof value !== 'object') return undefined
  const source = isId(value.sessionId) ? value : { ...value, sessionId: key }
  try {
    return recordFields(source, now)
  } catch {
    return undefined
  }
}

/**
 * The browser-facing projection of one record. Host paths never cross the
 * wire, so the projection carries identity, kind and pending state only.
 * @param {object} record - validated record.
 * @returns {{ sessionId: string, createdAt: number, kind: string, pendingDelete: boolean }} view.
 */
export function recordView(record) {
  return {
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    kind: record.kind,
    pendingDelete: record.pendingDelete === true,
  }
}

/**
 * The kind a stored or live Session header implies. A subagent is an
 * announced child; a seeded session is a fork; anything else is a chat.
 * @param {object | undefined} header - the Session header.
 * @returns {'fork' | 'main' | 'subagent'} the derived kind.
 */
export function kindOfHeader(header) {
  if (header?.origin === 'subagent') return 'subagent'
  if (header?.isSeeded === true) return 'fork'
  return 'main'
}
