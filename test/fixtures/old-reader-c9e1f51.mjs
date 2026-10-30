/**
 * The installed c9e1f51 cleanup reader, copied verbatim enough to prove its
 * behaviour. Source: the c9e1f51 copy in the web profile's node_modules. It
 * reads no version and deletes every safe parseable record, including a new
 * version-1 fork record.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, isAbsolute, resolve, sep } from 'node:path'

/** Decide whether a recorded path is the per-session storage directory. */
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

/** Delete every safe record from a registry, without reading its version. */
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
