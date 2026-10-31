/**
 * Real-boundary probe for the optional model sanity pass.
 *
 * Backlogs and private logs are real files under a fresh temporary root. The
 * model transport is faked because the local gateway is not part of the test
 * environment; the worker still uses the same deadline, single-flight,
 * sanitization and deterministic revalidation paths as production.
 *
 * Run: node test/probes/model-recovery.mjs
 *
 * It prints exactly five lines when the behaviour holds, and exits non-zero
 * with a diagnostic when it does not:
 *
 *   sanity: inconsistent fields
 *   rejected invented id
 *   aborted at deadline
 *   single flight kept
 *   redacted echo
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelSanity, validateModelProposal } from '../../model-sanity.js'

const prefix = join(tmpdir(), 'dsh-temp-model-recovery-')
const roots = []

/** Fail loudly instead of printing a line that does not hold. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** One real backlog file and its private log. */
async function setup(name) {
  const root = await mkdtemp(`${prefix}${name}-`)
  roots.push(root)
  const backlog = join(root, 'temp-session', 'records.unresolved.jsonl')
  await mkdir(join(root, 'temp-session'), { recursive: true })
  return { root, backlog }
}

function fragment(key, tail = '') {
  return `"${key}":{"sessionId":"${key}","dir":"/tmp/project","kind":"main","parentSessionId":null${tail}`
}

function entry(key = 'session-model-probe', bytes = fragment(key)) {
  return {
    v: 1,
    source: 'model-recovery-probe',
    offset: 0,
    reason: 'truncated-member',
    bytes: Buffer.from(bytes).toString('base64'),
  }
}

async function writeBacklog(path, records) {
  await writeFile(path, records.map(record => `${JSON.stringify(record)}\n`).join(''))
}

function answer(value) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) }
}

function context(key) {
  return {
    members: new Set([key]),
    journalEntry: { dir: '/tmp/project', kind: 'main', parentSessionId: null, cwd: null },
    header: { id: key, createdAt: 1 },
    storageDir: '/tmp/project',
  }
}

try {
  const inconsistent = await setup('inconsistent')
  const key = 'session-model-inconsistent'
  await writeBacklog(inconsistent.backlog, [entry(key)])
  const inconsistentLog = []
  const inconsistentWorker = new ModelSanity({
    backlog: inconsistent.backlog,
    log: (event, details) => inconsistentLog.push({ event, ...details }),
    transport: async () => answer({
      looksLikeRecord: true,
      inconsistentFields: ['dir', 'title'],
      proposal: null,
    }),
    timeoutMs: 200,
  })
  await inconsistentWorker.start()
  check(
    inconsistentLog.some(item => item.reason === 'inconsistent' && item.field === 'dir'),
    'the model did not flag the inconsistent field',
  )
  check(
    !JSON.stringify(inconsistentLog).includes('title-value'),
    'the model echoed free-form text',
  )
  process.stdout.write('sanity: inconsistent fields\n')

  const rejected = await setup('rejected')
  const rejectedKey = 'session-model-rejected'
  await writeBacklog(rejected.backlog, [entry(rejectedKey)])
  const rejectedLog = []
  const rejectedWorker = new ModelSanity({
    backlog: rejected.backlog,
    log: (event, details) => rejectedLog.push({ event, ...details }),
    transport: async () => answer({
      looksLikeRecord: true,
      inconsistentFields: [],
      proposal: { sessionId: 'session-model-invented' },
    }),
    timeoutMs: 200,
    validate: (item, value) => validateModelProposal(item.bytes, value, context(rejectedKey)),
  })
  await rejectedWorker.start()
  check(rejectedLog.some(item => item.reason === 'invented-id'), 'the invented id was not rejected')
  process.stdout.write('rejected invented id\n')

  const deadline = await setup('deadline')
  const deadlineKey = 'session-model-deadline'
  await writeBacklog(deadline.backlog, [entry(deadlineKey)])
  let aborted = false
  const deadlineLog = []
  const deadlineWorker = new ModelSanity({
    backlog: deadline.backlog,
    log: (event, details) => deadlineLog.push({ event, ...details }),
    transport: async (body, init) => new Promise((resolve, reject) => {
      const keepalive = setTimeout(() => {}, 1000)
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepalive)
        aborted = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    }),
    timeoutMs: 40,
  })
  const started = Date.now()
  const deadlineResult = await deadlineWorker.start()
  check(aborted, 'the deadline did not abort the transport')
  check(Date.now() - started < 500, 'the deadline did not bound the pass')
  check(deadlineResult.skipped === 1, 'the deadline pass did not stop the fragment')
  check(deadlineLog.some(item => item.reason === 'deadline'), 'the deadline was not logged')
  process.stdout.write('aborted at deadline\n')

  const flight = await setup('flight')
  const flightKey = 'session-model-flight'
  await writeBacklog(flight.backlog, [entry(flightKey)])
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const flightWorker = new ModelSanity({
    backlog: flight.backlog,
    transport: async () => {
      calls += 1
      await gate
      return answer({ looksLikeRecord: true, inconsistentFields: [], proposal: null })
    },
    timeoutMs: 500,
  })
  const first = flightWorker.start()
  const second = flightWorker.start()
  check(first === second, 'two passes started at once')
  check(calls === 1, 'the transport ran more than once')
  release()
  await first
  check(calls === 1, 'the transport overlapped a second pass')
  process.stdout.write('single flight kept\n')

  const redacted = await setup('redacted')
  const redactedKey = 'session-model-redacted'
  await writeBacklog(redacted.backlog, [entry(redactedKey)])
  const redactedLog = []
  const redactedWorker = new ModelSanity({
    backlog: redacted.backlog,
    log: (event, details) => redactedLog.push({ event, ...details }),
    transport: async () => answer({
      looksLikeRecord: true,
      inconsistentFields: ['title'],
      proposal: { sessionId: redactedKey, title: 'SENSITIVE TITLE', dir: '/SENSITIVE/PATH' },
      notes: 'SENSITIVE TITLE /SENSITIVE/PATH',
    }),
    timeoutMs: 200,
    validate: () => ({ accepted: false, reason: 'invented-field' }),
  })
  await redactedWorker.start()
  check(!JSON.stringify(redactedLog).includes('SENSITIVE'), 'the model echo reached the log')
  process.stdout.write('redacted echo\n')
} catch (error) {
  process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  for (const root of roots) {
    if (root.startsWith(prefix)) await rm(root, { recursive: true, force: true })
  }
}
