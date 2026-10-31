/**
 * Non-authoritative model sanity pass for unresolved registry fragments.
 *
 * A model answer can flag fields or propose a reading, but it never becomes
 * trusted input. The proposal is checked against the exact fragment bytes and
 * against the journal ownership and stored header before it is logged as a
 * candidate. The worker never removes a backlog entry and never changes the
 * registry.
 *
 * @module dsh-temp-session-plugin/model-sanity
 */

import { readFileSync } from 'node:fs'
import { inspectFragment } from './healing.js'

/** Fixed default gateway endpoint. */
export const MODEL_ENDPOINT = 'http://127.0.0.1:8090/v1/chat/completions'

/** Fixed default local model alias. */
export const MODEL_ALIAS = 'strata/qwen-strata'

/** Whole-response deadline for one attempt. */
export const MODEL_TIMEOUT_MS = 10_000

/** Attempts per fragment, including the first. */
export const MODEL_MAX_ATTEMPTS = 2

/** Largest fragment sent to the model. */
export const MODEL_FRAGMENT_BYTES = 4 * 1024

/** Field names a model answer may mention or propose. */
export const MODEL_FIELD_NAMES = Object.freeze([
  'sessionId', 'dir', 'cwd', 'kind', 'parentSessionId', 'title',
  'createdAt', 'lastActivityAt', 'activitySince', 'pendingDelete',
])

/** Decision codes that may enter the private recovery log. */
export const MODEL_DECISIONS = Object.freeze([
  'consistent', 'inconsistent', 'candidate', 'rejected',
  'malformed-answer', 'malformed-fragment', 'not-a-record', 'no-proposal',
  'missing-id', 'invented-id', 'invented-field', 'not-member', 'not-owned',
  'no-header', 'no-locator', 'value-mismatch', 'kind-mismatch', 'parent-mismatch',
  'dir-mismatch', 'cwd-mismatch', 'created-at-mismatch', 'duplicate-field',
  'fragment-too-large', 'gateway-unavailable', 'deadline', 'backlog-unavailable',
])

const FIELDS = new Set(MODEL_FIELD_NAMES)
const DECISIONS = new Set(MODEL_DECISIONS)

/** Compare two values from JSON without trusting object identity. */
function sameValue(left, right) {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index]))
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

/**
 * Parse a model answer and discard every free-form key. The returned object
 * contains only booleans, allowlisted field names, and a proposal built from
 * allowlisted fields. A title or path in the answer is never returned.
 * @param {string | object} content - raw assistant content or an already parsed value.
 * @returns {{ looksLikeRecord: boolean, inconsistentFields: string[], proposal?: object } | undefined} answer.
 */
export function parseModelAnswer(content) {
  let value = content
  if (typeof content === 'string') {
    let text = content.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    }
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (typeof value.looksLikeRecord !== 'boolean') return undefined
  const inconsistentFields = Array.isArray(value.inconsistentFields)
    ? [...new Set(value.inconsistentFields.filter(field => typeof field === 'string' && FIELDS.has(field)))]
    : []
  let proposal
  if (value.proposal !== undefined && value.proposal !== null) {
    if (typeof value.proposal !== 'object' || Array.isArray(value.proposal)) return undefined
    proposal = {}
    for (const field of MODEL_FIELD_NAMES) {
      if (Object.hasOwn(value.proposal, field)) proposal[field] = value.proposal[field]
    }
  }
  return { looksLikeRecord: value.looksLikeRecord, inconsistentFields, ...(proposal === undefined ? {} : { proposal }) }
}

/**
 * Reparse a proposal against the exact fragment bytes and the journal-owned
 * context. Every projected field must be literally present in the scanned
 * prefix and equal to its value. Identity and association fields are also
 * checked against the journal entry, the stored header and the registry
 * membership.
 * @param {Buffer} bytes - exact fragment bytes.
 * @param {ReturnType<typeof parseModelAnswer>} answer - sanitized model answer.
 * @param {{ members?: Set<string>, journalEntry?: object, header?: object, storageDir?: string }} [context] - trusted context.
 * @returns {{ accepted: boolean, reason: string }} verdict.
 */
export function validateModelProposal(bytes, answer, context = {}) {
  if (answer === undefined || answer.looksLikeRecord !== true) return { accepted: false, reason: 'not-a-record' }
  const fragment = inspectFragment(bytes)
  if (!fragment.ok) return { accepted: false, reason: 'malformed-fragment' }
  if (fragment.key === undefined) return { accepted: false, reason: 'missing-id' }
  const proposal = answer.proposal
  if (proposal === undefined) return { accepted: false, reason: 'no-proposal' }
  if (!Object.hasOwn(proposal, 'sessionId')) return { accepted: false, reason: 'missing-id' }
  if (proposal.sessionId !== fragment.key) return { accepted: false, reason: 'invented-id' }
  if (context.members !== undefined && !context.members.has(fragment.key)) {
    return { accepted: false, reason: 'not-member' }
  }
  const entry = context.journalEntry
  if (entry === undefined || entry.deleted === true) return { accepted: false, reason: 'not-owned' }
  const header = context.header
  if (header === undefined || header.id !== fragment.key) return { accepted: false, reason: 'no-header' }
  if (context.storageDir === undefined) return { accepted: false, reason: 'no-locator' }
  if (context.storageDir !== undefined && entry.dir !== context.storageDir) {
    return { accepted: false, reason: 'dir-mismatch' }
  }
  const fields = new Map()
  for (const item of fragment.entries) {
    if (fields.has(item.key)) return { accepted: false, reason: 'duplicate-field' }
    fields.set(item.key, item.value)
  }
  for (const field of Object.keys(proposal)) {
    if (!FIELDS.has(field)) continue
    if (!fields.has(field)) return { accepted: false, reason: 'invented-field' }
    if (!sameValue(fields.get(field), proposal[field])) return { accepted: false, reason: 'value-mismatch' }
    if (field === 'kind' && proposal[field] !== entry.kind) {
      return { accepted: false, reason: 'kind-mismatch' }
    }
    if (field === 'parentSessionId' && (proposal[field] ?? null) !== (entry.parentSessionId ?? null)) {
      return { accepted: false, reason: 'parent-mismatch' }
    }
    if (field === 'dir' && proposal[field] !== entry.dir) {
      return { accepted: false, reason: 'dir-mismatch' }
    }
    if (field === 'cwd' && (proposal[field] ?? null) !== (entry.cwd ?? null)) {
      return { accepted: false, reason: 'cwd-mismatch' }
    }
    if (field === 'createdAt' && proposal[field] !== header.createdAt) {
      return { accepted: false, reason: 'created-at-mismatch' }
    }
  }
  if (proposal.parentSessionId !== undefined && entry.parentSessionId === undefined) {
    return { accepted: false, reason: 'parent-mismatch' }
  }
  return { accepted: true, reason: 'candidate' }
}

/** Read and validate one backlog line, never trusting its JSON blindly. */
function readEntry(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || value.v !== 1) return undefined
  if (!Number.isSafeInteger(value.offset) || value.offset < 0) return undefined
  if (typeof value.reason !== 'string' || value.reason.length === 0) return undefined
  if (typeof value.bytes !== 'string') return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.bytes)) return undefined
  const bytes = Buffer.from(value.bytes, 'base64')
  return { offset: value.offset, reason: value.reason, bytes }
}

function noop() {}

/**
 * Single-flight model sanity worker. One call is in flight at a time and one
 * attempt is bounded by the deadline; an unavailable gateway leaves the
 * backlog untouched for the next start.
 */
export class ModelSanity {
  /**
   * @param {object} options - worker configuration.
   * @param {string} options.backlog - unresolved backlog path.
   * @param {(body: object, init: { signal: AbortSignal }) => Promise<object>} [options.transport] - HTTP transport.
   * @param {(event: string, details?: object) => void} [options.log] - private recovery log sink.
   * @param {(entry: object, answer: object) => { accepted: boolean, reason: string }} [options.validate] - trusted proposal validator.
   * @param {number} [options.timeoutMs] - whole-response deadline.
   * @param {number} [options.maxAttempts] - total attempts.
   * @param {number} [options.maxFragmentBytes] - largest fragment sent.
   * @param {string} [options.endpoint] - fixed default endpoint override for tests.
   * @param {string} [options.model] - fixed default alias override for tests.
   */
  constructor({
    backlog,
    transport = (body, init) => fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: init.signal,
    }),
    log = noop,
    validate = () => ({ accepted: false, reason: 'no-proposal' }),
    timeoutMs = MODEL_TIMEOUT_MS,
    maxAttempts = MODEL_MAX_ATTEMPTS,
    maxFragmentBytes = MODEL_FRAGMENT_BYTES,
    endpoint = MODEL_ENDPOINT,
    model = MODEL_ALIAS,
  } = {}) {
    this.backlog = backlog
    this.transport = transport
    this.log = log
    this.validate = validate
    this.timeoutMs = timeoutMs
    this.maxAttempts = maxAttempts
    this.maxFragmentBytes = maxFragmentBytes
    this.endpoint = endpoint
    this.model = model
    this.active = undefined
    this.controller = undefined
    this.closed = false
  }

  /** Read the backlog without rewriting it; a missing file is an empty pass. */
  entries() {
    let text
    try {
      text = readFileSync(this.backlog, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      this.record('backlog-unavailable')
      return []
    }
    return text.split('\n').filter(line => line !== '').map(readEntry).filter(Boolean)
  }

  /** Write one whitelisted decision; never let a log sink break the pass. */
  record(reason, details = {}) {
    const safeReason = DECISIONS.has(reason) ? reason : 'rejected'
    const safe = { reason: safeReason }
    if (Number.isSafeInteger(details.offset) && details.offset >= 0) safe.offset = details.offset
    if (typeof details.field === 'string' && FIELDS.has(details.field)) safe.field = details.field
    try {
      this.log('model-sanity', safe)
    } catch {
      // The recovery log is advisory; a failed sink must not stop the worker.
    }
  }

  /** Start one pass, or return the active pass when one is already running. */
  start() {
    if (this.active !== undefined) return this.active
    if (this.closed) return Promise.resolve({ processed: 0, candidates: 0, rejected: 0, skipped: 0 })
    const entries = this.entries()
    this.active = this.run(entries).finally(() => {
      this.active = undefined
      this.controller = undefined
    })
    return this.active
  }

  /** Abort the active transport and refuse a later pass. */
  abort() {
    this.closed = true
    this.controller?.abort()
  }

  /** Ask the model once, with two bounded attempts on transient failures. */
  async ask(text) {
    const body = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'Return one JSON object with looksLikeRecord (boolean), inconsistentFields (array of field names), and proposal (an object or null). Do not add identifiers that are not in the fragment.',
        },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: 256,
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController()
      this.controller = controller
      let timer
      let rejectAbort
      const aborted = new Promise((_, reject) => { rejectAbort = reject })
      const onAbort = () => rejectAbort(Object.assign(new Error('model sanity deadline'), { name: 'AbortError' }))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const request = (async () => {
          const response = await this.transport(body, { signal: controller.signal })
          if (response?.ok !== true) throw new Error('model gateway rejected the request')
          const payload = await response.json()
          const content = payload?.choices?.[0]?.message?.content
          if (typeof content !== 'string') throw new Error('model gateway returned no content')
          return content
        })()
        return { ok: true, content: await Promise.race([request, aborted]) }
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) {
          return { ok: false, reason: 'deadline' }
        }
        if (attempt >= this.maxAttempts) return { ok: false, reason: 'gateway-unavailable' }
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        if (this.controller === controller) this.controller = undefined
      }
    }
    return { ok: false, reason: 'gateway-unavailable' }
  }

  /** Process every entry in order, one transport call at a time. */
  async run(entries) {
    let processed = 0
    let candidates = 0
    let rejected = 0
    let skipped = 0
    for (const entry of entries) {
      if (this.closed) break
      if (entry.bytes.length > this.maxFragmentBytes) {
        this.record('fragment-too-large', { offset: entry.offset })
        skipped += 1
        continue
      }
      const text = entry.bytes.toString('utf8')
      if (text === '') {
        skipped += 1
        continue
      }
      processed += 1
      const asked = await this.ask(text)
      if (this.closed) break
      if (!asked.ok) {
        this.record(asked.reason, { offset: entry.offset })
        skipped += 1
        continue
      }
      const answer = parseModelAnswer(asked.content)
      if (answer === undefined) {
        this.record('malformed-answer', { offset: entry.offset })
        skipped += 1
        continue
      }
      for (const field of answer.inconsistentFields) {
        this.record('inconsistent', { offset: entry.offset, field })
      }
      if (answer.proposal !== undefined) {
        let verdict
        try {
          verdict = this.validate(entry, answer)
        } catch {
          verdict = { accepted: false, reason: 'rejected' }
        }
        if (verdict?.accepted === true) {
          this.record('candidate', { offset: entry.offset })
          candidates += 1
        } else {
          this.record(verdict?.reason ?? 'rejected', { offset: entry.offset })
          rejected += 1
        }
      }
    }
    return { processed, candidates, rejected, skipped }
  }
}

/**
 * Build the production worker and bind its proposal validation to the core.
 * Kept as a factory so the wiring can be exercised without loading the Host.
 * @param {{ recovery: { log: Function }, validateModelFragment: Function }} temp - core service.
 * @param {{ unresolved: string }} paths - private state paths.
 * @returns {ModelSanity} worker.
 */
export function createModelSanity(temp, paths) {
  return new ModelSanity({
    backlog: paths.unresolved,
    log: (event, details) => temp.recovery.log(event, details),
    validate: (entry, answer) => temp.validateModelFragment(entry, answer),
  })
}
