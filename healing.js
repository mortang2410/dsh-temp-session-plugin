/**
 * Deterministic recovery primitives for the temporary-session registry.
 *
 * The registry is untrusted bytes. This module scans those bytes with explicit
 * spans instead of re-serializing a parsed object, so a member key, its decoded
 * string and its `sessions` membership can be checked before any record is
 * trusted. It also owns the private evidence artifacts: the unresolved backlog,
 * preserved originals and the bounded recovery log.
 *
 * @module dsh-temp-session-plugin/healing
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Maximum bytes the unresolved backlog may grow to. */
export const MAX_BACKLOG_BYTES = 8 * 1024 * 1024

/** Maximum bytes all preserved originals may occupy. */
export const MAX_PRESERVED_BYTES = 32 * 1024 * 1024

/** Maximum number of preserved originals kept. */
export const MAX_PRESERVED_FILES = 16

/** Rotate the recovery log before a line would cross this size. */
export const RECOVERY_LOG_BYTES = 1_000_000

/** Number of old recovery logs kept beside the current one. */
export const RECOVERY_LOG_BACKUPS = 5

/** Record field names the private recovery log may carry. */
export const RECOVERY_FIELD_NAMES = Object.freeze([
  'sessionId', 'dir', 'cwd', 'kind', 'parentSessionId', 'title',
  'createdAt', 'lastActivityAt', 'activitySince', 'pendingDelete',
])

const RECOVERY_FIELDS = new Set(RECOVERY_FIELD_NAMES)

/** Maximum nesting accepted from a registry value. */
const MAX_JSON_DEPTH = 64

/** Complete member fields that can authorize or veto recovery. */
const PARTIAL_AUTHORITY_FIELDS = new Set([
  'sessionId', 'dir', 'cwd', 'kind', 'parentSessionId', 'pendingDelete',
])

/** Make one directory entry durable. */
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
        // The rename or unlink already happened.
      }
    }
  }
}

/** Decode one JSON string as strict UTF-8; undefined when the bytes are invalid. */
function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return undefined
  }
}

/** Skip JSON whitespace. */
function skipWhitespace(buffer, cursor) {
  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) break
    cursor += 1
  }
  return cursor
}

/** Whether a byte starts a JSON value. */
function startsValue(byte) {
  return byte === 0x22
    || byte === 0x7b
    || byte === 0x5b
    || byte === 0x2d
    || (byte >= 0x30 && byte <= 0x39)
    || byte === 0x74
    || byte === 0x66
    || byte === 0x6e
}

/**
 * Scan one JSON string token starting at its opening quote.
 * @returns {{ ok: true, value: string, end: number } | { ok: false, offset: number }} token.
 */
function scanString(buffer, start) {
  if (buffer[start] !== 0x22) return { ok: false, offset: start }
  let cursor = start + 1
  while (cursor < buffer.length) {
    const byte = buffer[cursor]
    if (byte === 0x22) {
      const raw = decodeUtf8(buffer.subarray(start, cursor + 1))
      if (raw === undefined) return { ok: false, offset: start }
      try {
        return { ok: true, value: JSON.parse(raw), end: cursor + 1 }
      } catch {
        return { ok: false, offset: start }
      }
    }
    if (byte === 0x5c) {
      const escaped = buffer[cursor + 1]
      if (escaped === 0x22 || escaped === 0x5c || escaped === 0x2f
        || escaped === 0x62 || escaped === 0x66 || escaped === 0x6e
        || escaped === 0x72 || escaped === 0x74) {
        cursor += 2
        continue
      }
      if (escaped === 0x75) {
        for (let index = 2; index < 6; index += 1) {
          const hex = buffer[cursor + index]
          const isHex = (hex >= 0x30 && hex <= 0x39)
            || (hex >= 0x41 && hex <= 0x46)
            || (hex >= 0x61 && hex <= 0x66)
          if (!isHex) return { ok: false, offset: cursor }
        }
        cursor += 6
        continue
      }
      return { ok: false, offset: cursor }
    }
    if (byte < 0x20) return { ok: false, offset: cursor }
    cursor += 1
  }
  return { ok: false, offset: start }
}

/** Scan one JSON number token. */
function scanNumber(buffer, start) {
  let cursor = start
  if (buffer[cursor] === 0x2d) cursor += 1
  if (buffer[cursor] === 0x30) {
    cursor += 1
  } else if (buffer[cursor] >= 0x31 && buffer[cursor] <= 0x39) {
    cursor += 1
    while (buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39) cursor += 1
  } else {
    return { ok: false, offset: start }
  }
  if (buffer[cursor] === 0x2e) {
    cursor += 1
    if (!(buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39)) return { ok: false, offset: cursor }
    while (buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39) cursor += 1
  }
  if (buffer[cursor] === 0x65 || buffer[cursor] === 0x45) {
    cursor += 1
    if (buffer[cursor] === 0x2b || buffer[cursor] === 0x2d) cursor += 1
    if (!(buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39)) return { ok: false, offset: cursor }
    while (buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39) cursor += 1
  }
  const raw = buffer.subarray(start, cursor).toString('utf8')
  const value = Number(raw)
  if (!Number.isFinite(value)) return { ok: false, offset: start }
  return { ok: true, value, end: cursor }
}

/** Scan a full JSON object or array, preserving every key occurrence. */
function scanValue(buffer, start, depth) {
  if (depth > MAX_JSON_DEPTH) return { ok: false, offset: start }
  const cursor = skipWhitespace(buffer, start)
  const byte = buffer[cursor]
  if (byte === 0x22) {
    const token = scanString(buffer, cursor)
    if (!token.ok) return token
    return { ok: true, node: { type: 'string', value: token.value }, end: token.end }
  }
  if (byte === 0x31 || byte === 0x32 || byte === 0x33 || byte === 0x34
    || byte === 0x35 || byte === 0x36 || byte === 0x37 || byte === 0x38
    || byte === 0x39 || byte === 0x30 || byte === 0x2d) {
    const token = scanNumber(buffer, cursor)
    if (!token.ok) return token
    return { ok: true, node: { type: 'number', value: token.value }, end: token.end }
  }
  if (byte === 0x74) {
    if (buffer.subarray(cursor, cursor + 4).toString('utf8') !== 'true') return { ok: false, offset: cursor }
    return { ok: true, node: { type: 'boolean', value: true }, end: cursor + 4 }
  }
  if (byte === 0x66) {
    if (buffer.subarray(cursor, cursor + 5).toString('utf8') !== 'false') return { ok: false, offset: cursor }
    return { ok: true, node: { type: 'boolean', value: false }, end: cursor + 5 }
  }
  if (byte === 0x6e) {
    if (buffer.subarray(cursor, cursor + 4).toString('utf8') !== 'null') return { ok: false, offset: cursor }
    return { ok: true, node: { type: 'null', value: null }, end: cursor + 4 }
  }
  if (byte === 0x7b) return scanObject(buffer, cursor + 1, depth + 1)
  if (byte === 0x5b) return scanArray(buffer, cursor + 1, depth + 1)
  return { ok: false, offset: cursor }
}

/** Scan a complete JSON object after its opening brace. */
function scanObject(buffer, start, depth) {
  const entries = []
  let cursor = skipWhitespace(buffer, start)
  if (buffer[cursor] === 0x7d) return { ok: true, node: { type: 'object', entries }, end: cursor + 1 }
  while (cursor < buffer.length) {
    if (buffer[cursor] !== 0x22) return { ok: false, offset: cursor }
    const key = scanString(buffer, cursor)
    if (!key.ok) return key
    cursor = skipWhitespace(buffer, key.end)
    if (buffer[cursor] !== 0x3a) return { ok: false, offset: cursor }
    const value = scanValue(buffer, cursor + 1, depth)
    if (!value.ok) return value
    entries.push({ key: key.value, value: value.node })
    cursor = skipWhitespace(buffer, value.end)
    if (buffer[cursor] === 0x7d) return { ok: true, node: { type: 'object', entries }, end: cursor + 1 }
    if (buffer[cursor] !== 0x2c) return { ok: false, offset: cursor }
    cursor = skipWhitespace(buffer, cursor + 1)
  }
  return { ok: false, offset: start }
}

/** Scan a complete JSON array after its opening bracket. */
function scanArray(buffer, start, depth) {
  const items = []
  let cursor = skipWhitespace(buffer, start)
  if (buffer[cursor] === 0x5d) return { ok: true, node: { type: 'array', items }, end: cursor + 1 }
  while (cursor < buffer.length) {
    const value = scanValue(buffer, cursor, depth)
    if (!value.ok) return value
    items.push(value.node)
    cursor = skipWhitespace(buffer, value.end)
    if (buffer[cursor] === 0x5d) return { ok: true, node: { type: 'array', items }, end: cursor + 1 }
    if (buffer[cursor] !== 0x2c) return { ok: false, offset: cursor }
    cursor = skipWhitespace(buffer, cursor + 1)
  }
  return { ok: false, offset: start }
}

/** Convert one scanned node to the plain value the record validator consumes. */
function nodeValue(node) {
  if (node === null || node === undefined) return undefined
  if (node.type === 'object') {
    const value = {}
    for (const entry of node.entries) value[entry.key] = nodeValue(entry.value)
    return value
  }
  if (node.type === 'array') return node.items.map(nodeValue)
  return node.value
}

/** One unresolved byte range, kept as raw bytes for the private backlog. */
function fragment(buffer, start, end, reason) {
  const from = Math.max(0, Math.min(start, buffer.length))
  const to = Math.max(from, Math.min(end, buffer.length))
  return { offset: from, reason, bytes: Buffer.from(buffer.subarray(from, to)) }
}

/** Build one candidate member from its exact map key and complete value. */
function makeMember(buffer, key, keyStart, node, valueEnd) {
  const member = {
    key,
    offset: keyStart,
    end: valueEnd,
    bytes: Buffer.from(buffer.subarray(keyStart, valueEnd)),
    value: nodeValue(node),
    sessionIdPresent: false,
    sessionId: undefined,
    invalid: undefined,
    duplicate: false,
  }
  if (node.type !== 'object') {
    member.invalid = 'not-object'
    return member
  }
  const keys = new Map()
  for (const entry of node.entries) keys.set(entry.key, (keys.get(entry.key) ?? 0) + 1)
  const duplicates = [...keys.entries()].filter(([, count]) => count > 1).map(([name]) => name)
  if (duplicates.length > 0) {
    member.invalid = 'duplicate-field'
    return member
  }
  const sessionIdEntry = node.entries.find(entry => entry.key === 'sessionId')
  if (sessionIdEntry === undefined) return member
  member.sessionIdPresent = true
  if (sessionIdEntry.value.type !== 'string') {
    member.invalid = 'session-id-type'
    return member
  }
  member.sessionId = sessionIdEntry.value.value
  if (member.sessionId !== key) member.invalid = 'key-mismatch'
  return member
}

/**
 * Scan the complete fields at the start of a member whose value is truncated.
 * Only exact top-level `key:value` pairs become entries; the incomplete field
 * and everything after it are left uninspected. Complete authority fields and
 * the first incomplete field name are retained so callers can reject evidence
 * that cannot be compared safely.
 * @param {Buffer} buffer - registry bytes.
 * @param {number} start - byte at the member's opening brace.
 * @returns {{ entries: Array<{ key: string, value: object }>, incompleteKey: string | undefined, broken: boolean, complete: boolean, end: number }} fields.
 */
function scanMemberPrefix(buffer, start) {
  const entries = []
  let incompleteKey
  let broken = false
  let cursor = skipWhitespace(buffer, start)
  if (buffer[cursor] !== 0x7b) return { entries, incompleteKey, broken: true, complete: false, end: buffer.length }
  cursor = skipWhitespace(buffer, cursor + 1)
  if (buffer[cursor] === 0x7d) return { entries, incompleteKey, broken, complete: true, end: cursor + 1 }
  while (cursor < buffer.length) {
    if (buffer[cursor] !== 0x22) { broken = true; break }
    const key = scanString(buffer, cursor)
    if (!key.ok) { broken = true; break }
    cursor = skipWhitespace(buffer, key.end)
    if (buffer[cursor] !== 0x3a) { broken = true; break }
    const value = scanValue(buffer, cursor + 1, 1)
    if (!value.ok) { incompleteKey = key.value; break }
    entries.push({ key: key.value, value: value.node })
    cursor = skipWhitespace(buffer, value.end)
    if (cursor >= buffer.length) break
    if (buffer[cursor] === 0x7d) return { entries, incompleteKey, broken, complete: true, end: cursor + 1 }
    if (buffer[cursor] !== 0x2c) { broken = true; break }
    cursor = skipWhitespace(buffer, cursor + 1)
    if (cursor >= buffer.length) { broken = true; break }
  }
  return { entries, incompleteKey, broken, complete: false, end: buffer.length }
}

/**
 * Scan one `sessions` object, returning every complete member even when the
 * object or its container is truncated. An incomplete value stops the scan:
 * its raw bytes, including the member key, become one unresolved fragment.
 * Complete fields before the truncation stay available for identity checks.
 */
function scanSessions(buffer, start) {
  const members = []
  const unresolved = []
  let cursor = skipWhitespace(buffer, start + 1)
  if (buffer[cursor] === 0x7d) {
    return { members, unresolved, complete: true, end: cursor + 1 }
  }
  while (cursor < buffer.length) {
    if (buffer[cursor] !== 0x22) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-member'))
      return { members, unresolved, complete: false, end: buffer.length }
    }
    const key = scanString(buffer, cursor)
    if (!key.ok) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-key'))
      return { members, unresolved, complete: false, end: buffer.length }
    }
    const keyStart = cursor
    cursor = skipWhitespace(buffer, key.end)
    if (buffer[cursor] !== 0x3a) {
      unresolved.push(fragment(buffer, keyStart, buffer.length, 'malformed-member'))
      return { members, unresolved, complete: false, end: buffer.length }
    }
    const value = scanValue(buffer, cursor + 1, 1)
    if (!value.ok) {
      const bytes = Buffer.from(buffer.subarray(keyStart, buffer.length))
      const prefix = scanMemberPrefix(buffer, cursor + 1)
      const sessionIds = prefix.entries
        .filter(entry => entry.key === 'sessionId' && entry.value.type === 'string')
        .map(entry => entry.value.value)
      const singleId = prefix.entries.filter(entry => entry.key === 'sessionId').length === 1
        ? sessionIds[0]
        : undefined
      const fields = Object.create(null)
      const counts = new Map()
      for (const entry of prefix.entries) {
        fields[entry.key] = nodeValue(entry.value)
        counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
      }
      const duplicateFields = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name)
      const incompleteAuthority = prefix.incompleteKey !== undefined
        && PARTIAL_AUTHORITY_FIELDS.has(prefix.incompleteKey)
      members.push({
        key: key.value,
        offset: keyStart,
        end: buffer.length,
        bytes,
        value: undefined,
        sessionIdPresent: typeof singleId === 'string',
        sessionId: singleId,
        partialSessionIds: sessionIds,
        partialFields: fields,
        partialDuplicateFields: duplicateFields,
        partialIncompleteKey: prefix.incompleteKey,
        partialBlocked: prefix.broken === true || duplicateFields.length > 0 || incompleteAuthority,
        invalid: 'truncated-member',
        duplicate: false,
      })
      unresolved.push({ offset: keyStart, reason: 'truncated-member', bytes })
      return { members, unresolved, complete: false, end: buffer.length }
    }
    members.push(makeMember(buffer, key.value, keyStart, value.node, value.end))
    cursor = skipWhitespace(buffer, value.end)
    if (cursor >= buffer.length) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'truncated-sessions'))
      return { members, unresolved, complete: false, end: buffer.length }
    }
    if (buffer[cursor] === 0x7d) {
      return { members, unresolved, complete: true, end: cursor + 1 }
    }
    if (buffer[cursor] !== 0x2c) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-sessions'))
      return { members, unresolved, complete: false, end: buffer.length }
    }
    cursor = skipWhitespace(buffer, cursor + 1)
    if (cursor >= buffer.length) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'truncated-sessions'))
      return { members, unresolved, complete: false, end: buffer.length }
    }
    if (buffer[cursor] === 0x7d) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'trailing-comma'))
      return { members, unresolved, complete: false, end: buffer.length }
    }
  }
  unresolved.push(fragment(buffer, cursor, buffer.length, 'truncated-sessions'))
  return { members, unresolved, complete: false, end: buffer.length }
}

/**
 * Scan the raw bytes of one unresolved member fragment. This is the only
 * parser a model proposal is allowed to feed: it reports the exact map key and
 * the complete fields before the first truncation, without interpreting the
 * model's text.
 * @param {Buffer} buffer - fragment bytes, normally beginning with a JSON key.
 * @returns {{ ok: boolean, reason?: string, key?: string, keyStart?: number, entries?: Array<{ key: string, value: object }>, incompleteKey?: string }} fragment.
 */
export function inspectFragment(buffer) {
  let cursor = skipWhitespace(buffer, 0)
  let key
  let keyStart
  if (buffer[cursor] === 0x22) {
    keyStart = cursor
    const token = scanString(buffer, cursor)
    if (!token.ok) return { ok: false, reason: 'malformed-key' }
    key = token.value
    cursor = skipWhitespace(buffer, token.end)
    if (buffer[cursor] !== 0x3a) return { ok: false, reason: 'malformed-member' }
    cursor = skipWhitespace(buffer, cursor + 1)
  }
  if (buffer[cursor] !== 0x7b) return { ok: false, reason: 'not-an-object' }
  const prefix = scanMemberPrefix(buffer, cursor)
  if (prefix.broken) return { ok: false, reason: 'malformed-member' }
  return {
    ok: true,
    key,
    keyStart,
    entries: prefix.entries.map(entry => ({ key: entry.key, value: nodeValue(entry.value) })),
    incompleteKey: prefix.incompleteKey,
  }
}

/**
 * Inspect registry bytes as spans.
 *
 * Only a complete member object directly inside the top-level `sessions`
 * object becomes a candidate. A title, a nested value, a neighbour, an object
 * outside `sessions` or a substring never becomes a map key. A duplicate map
 * key or a key whose surviving `sessionId` disagrees is quarantined.
 *
 * @param {Buffer} buffer - exact registry bytes.
 * @returns {object} version, support, completeness, members and unresolved fragments.
 */
export function inspectRegistry(buffer) {
  const unresolved = []
  let cursor = skipWhitespace(buffer, 0)
  if (buffer[cursor] !== 0x7b) {
    return {
      supported: false,
      version: undefined,
      complete: false,
      ambiguous: false,
      members: [],
      unresolved: [fragment(buffer, cursor, buffer.length, 'not-an-object')],
    }
  }
  cursor += 1
  let version
  let versionPresent = false
  let versionType
  let versionCount = 0
  let sessionsSeen = 0
  let sessions
  let complete = false
  let ambiguous = false
  while (cursor < buffer.length) {
    cursor = skipWhitespace(buffer, cursor)
    if (buffer[cursor] === 0x7d) {
      complete = true
      cursor += 1
      break
    }
    if (buffer[cursor] !== 0x22) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-root'))
      break
    }
    const key = scanString(buffer, cursor)
    if (!key.ok) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-root'))
      break
    }
    cursor = skipWhitespace(buffer, key.end)
    if (buffer[cursor] !== 0x3a) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-root'))
      break
    }
    cursor = skipWhitespace(buffer, cursor + 1)
    if (key.value === 'version') {
      versionCount += 1
      versionPresent = true
      const value = scanValue(buffer, cursor, 1)
      if (!value.ok) {
        unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-version'))
        break
      }
      versionType = value.node.type
      version = nodeValue(value.node)
      cursor = value.end
    } else if (key.value === 'sessions') {
      sessionsSeen += 1
      if (sessionsSeen > 1) {
        ambiguous = true
        break
      }
      if (buffer[cursor] === 0x7b) {
        const scanned = scanSessions(buffer, cursor)
        sessions = scanned
        unresolved.push(...scanned.unresolved)
        cursor = scanned.end
        if (!scanned.complete) break
      } else {
        const value = scanValue(buffer, cursor, 1)
        if (!value.ok) {
          unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-sessions'))
          break
        }
        unresolved.push(fragment(buffer, cursor, value.end, 'sessions-not-object'))
        cursor = value.end
      }
    } else {
      const value = scanValue(buffer, cursor, 1)
      if (!value.ok) {
        unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-field'))
        break
      }
      cursor = value.end
    }
    cursor = skipWhitespace(buffer, cursor)
    if (cursor >= buffer.length) break
    if (buffer[cursor] === 0x7d) {
      complete = true
      cursor += 1
      break
    }
    if (buffer[cursor] !== 0x2c) {
      unresolved.push(fragment(buffer, cursor, buffer.length, 'malformed-root'))
      break
    }
    cursor += 1
  }
  if (complete) {
    const trailing = skipWhitespace(buffer, cursor)
    if (trailing < buffer.length) {
      complete = false
      unresolved.push(fragment(buffer, trailing, buffer.length, 'trailing-bytes'))
    }
  }
  if (!complete && unresolved.length === 0) {
    unresolved.push(fragment(buffer, buffer.length, buffer.length, 'truncated-root'))
  }
  if (versionCount > 1) ambiguous = true
  const supported = versionCount === 1
    && versionPresent
    && versionType === 'number'
    && Number.isSafeInteger(version)
    && version === 1
  const members = supported && !ambiguous ? (sessions?.members ?? []) : []
  if (supported && !ambiguous && sessions === undefined && complete) {
    unresolved.push(fragment(buffer, buffer.length, buffer.length, 'missing-sessions'))
  }
  if (supported && !ambiguous && sessions !== undefined && !sessions.complete) {
    // The parser already added a fragment when there were bytes to retain.
    if (!unresolved.some(item => item.reason === 'truncated-sessions')) {
      unresolved.push(fragment(buffer, buffer.length, buffer.length, 'truncated-sessions'))
    }
  }
  const counts = new Map()
  for (const member of members) counts.set(member.key, (counts.get(member.key) ?? 0) + 1)
  for (const member of members) {
    if ((counts.get(member.key) ?? 0) > 1) {
      member.duplicate = true
      member.invalid = 'duplicate-member'
      unresolved.push({ offset: member.offset, reason: 'duplicate-member', bytes: member.bytes })
    }
  }
  return {
    supported,
    version,
    versionPresent,
    versionType,
    complete,
    ambiguous,
    members,
    unresolved,
  }
}

/** SHA-256 of a byte sequence as lowercase hex. */
function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Read every line of an existing backlog without changing its bytes. */
function readBacklog(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/** Ensure a private file exists with the requested mode, then fsync it. */
function appendPrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const existed = existsSync(path)
  const fd = openSync(path, 'a', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (!existed && !syncDirectory(dirname(path))) {
    throw new Error(`could not fsync the private evidence directory for ${path}`)
  }
}

/** Append one private file atomically through a temporary sibling. */
function writePrivateTemp(path, bytes) {
  const temp = `${path}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return temp
}

/**
 * Files used by deterministic recovery. Every method is synchronous so the
 * ordering of preserve, backlog, publish and retire is observable.
 */
export class RecoveryStore {
  /**
   * @param {{ paths: object, logger?: object, now?: () => number }} options - private paths and logger.
   */
  constructor({
    paths,
    logger,
    now = Date.now,
    maxBacklogBytes = MAX_BACKLOG_BYTES,
    maxPreservedBytes = MAX_PRESERVED_BYTES,
    maxPreservedFiles = MAX_PRESERVED_FILES,
    logBytes = RECOVERY_LOG_BYTES,
    logBackups = RECOVERY_LOG_BACKUPS,
  }) {
    this.paths = paths
    this.logger = logger
    this.now = now
    this.backlog = paths.unresolved
    this.preservedDir = paths.preserved
    this.logFile = paths.recoveryLog
    this.maxBacklogBytes = maxBacklogBytes
    this.maxPreservedBytes = maxPreservedBytes
    this.maxPreservedFiles = maxPreservedFiles
    this.logBytes = logBytes
    this.logBackups = logBackups
  }

  /** Append one allowlisted diagnostic line; never accepts free-form text. */
  log(event, details = {}) {
    if (typeof event !== 'string' || event === '') return
    const safe = { at: this.now(), event }
    for (const key of ['id', 'offset', 'reason', 'field', 'count', 'version', 'state']) {
      const value = details[key]
      if (key === 'id' && (typeof value !== 'string' || value.length === 0 || value.length > 200)) continue
      if (key === 'field') {
        if (typeof value !== 'string' || !RECOVERY_FIELDS.has(value)) continue
      } else if (key === 'reason' || key === 'state') {
        if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) continue
      }
      if (key === 'offset' || key === 'count' || key === 'version') {
        if (!Number.isSafeInteger(value) || value < 0) continue
      }
      safe[key] = value
    }
    const line = `${JSON.stringify(safe)}\n`
    try {
      mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 })
      if (existsSync(this.logFile) && statSync(this.logFile).size + Buffer.byteLength(line) > this.logBytes) {
        this.rotateLog()
      }
      appendPrivate(this.logFile, line)
    } catch (error) {
      this.logger?.warn?.(`could not write the temporary-session recovery log: ${String(error)}`)
    }
  }

  /** Rotate at the byte bound, keeping five previous files and their bytes. */
  rotateLog() {
    for (let index = this.logBackups; index >= 1; index -= 1) {
      const from = index === 1 ? this.logFile : `${this.logFile}.${index - 1}`
      const to = `${this.logFile}.${index}`
      if (!existsSync(from)) continue
      try {
        renameSync(from, to)
      } catch {
        // A concurrent writer may own the log; the next append tries again.
      }
    }
  }

  /**
   * Preserve the damaged original under a content-addressed 0600 file. The
   * cap keeps every existing preserved copy; a new copy is refused rather than
   * replacing evidence.
   */
  preserve(bytes) {
    const hash = hashBytes(bytes)
    const file = join(this.preservedDir, `records.${hash}.json`)
    if (existsSync(file)) {
      chmodSync(file, 0o600)
      return { status: 'existing', file, hash }
    }
    try {
      mkdirSync(this.preservedDir, { recursive: true, mode: 0o700 })
      const names = readdirSync(this.preservedDir)
      let total = 0
      for (const name of names) {
        try {
          total += statSync(join(this.preservedDir, name)).size
        } catch {
          // A vanished file is not a reason to overwrite evidence.
        }
      }
      if (names.length >= this.maxPreservedFiles || total + bytes.length > this.maxPreservedBytes) {
        this.log('preserved-full', { reason: 'bounded' })
        return { status: 'full', file: undefined, hash }
      }
      const temp = writePrivateTemp(file, bytes)
      try {
        renameSync(temp, file)
      } catch (error) {
        try {
          unlinkSync(temp)
        } catch {
          // The temp file is private and can be retried.
        }
        throw error
      }
      if (!syncDirectory(this.preservedDir)) {
        throw new Error('could not fsync the preserved-original directory')
      }
      this.log('preserved', { offset: 0, state: 'durable' })
      return { status: 'created', file, hash }
    } catch (error) {
      this.logger?.warn?.(`could not preserve the damaged temporary-session registry: ${String(error)}`)
      return { status: 'failed', file: undefined, hash }
    }
  }

  /** Remove one preserved original only after a durable recovered publish. */
  retire(file) {
    if (typeof file !== 'string' || !existsSync(file)) return true
    try {
      unlinkSync(file)
      syncDirectory(this.preservedDir)
      this.log('preserved-retired')
      return true
    } catch (error) {
      this.logger?.warn?.(`could not retire a preserved temporary-session registry: ${String(error)}`)
      return false
    }
  }

  /**
   * Append unresolved fragments with byte offsets. Existing lines are never
   * rewritten. When the bound would be crossed this stops adding and keeps the
   * previous bytes; the preserved original remains the complete evidence.
   */
  appendUnresolved(source, fragments) {
    if (!Array.isArray(fragments) || fragments.length === 0) return { written: 0, full: false }
    try {
      mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 })
      const existingText = readBacklog(this.backlog)
      const existing = new Set()
      for (const line of existingText.split('\n')) {
        if (line === '') continue
        try {
          const entry = JSON.parse(line)
          if (entry.v === 1 && typeof entry.bytes === 'string') {
            existing.add(`${entry.source}:${entry.offset}:${entry.reason}:${entry.bytes}`)
          }
        } catch {
          // Preserve an unreadable old line; it is evidence too.
        }
      }
      let size = Buffer.byteLength(existingText)
      let written = 0
      let full = false
      for (const item of fragments) {
        const bytes = Buffer.from(item.bytes ?? Buffer.alloc(0))
        const encoded = bytes.toString('base64')
        const key = `${source}:${item.offset}:${item.reason}:${encoded}`
        if (existing.has(key)) continue
        const line = `${JSON.stringify({
          v: 1,
          source,
          offset: item.offset,
          reason: item.reason,
          bytes: encoded,
        })}\n`
        const length = Buffer.byteLength(line)
        if (size + length > this.maxBacklogBytes) {
          full = true
          this.log('backlog-full', { reason: 'bounded' })
          break
        }
        appendPrivate(this.backlog, line)
        existing.add(key)
        size += length
        written += 1
      }
      return { written, full }
    } catch (error) {
      this.logger?.warn?.(`could not append the temporary-session recovery backlog: ${String(error)}`)
      return { written: 0, full: false, error }
    }
  }
}
