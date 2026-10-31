/**
 * Real-boundary probe for deterministic registry healing and degraded modes.
 *
 * Every registry, journal, evidence file and Session directory is a real file
 * under a fresh temporary root. The Host services are faked, so this verifies
 * the plugin's own recovery paths rather than a live DSH installation. The
 * probe prints exactly seven lines when the behaviour holds, and exits
 * non-zero with a diagnostic when it does not:
 *
 *   recovered 3
 *   rejected 1: key mismatch
 *   unsupported version: untouched
 *   registration refused while journal degraded
 *   side preserved session-side
 *   backlog 0600
 *   retried after crash
 *
 * Run: node test/probes/healing.mjs
 */

import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemporarySessions, cleanupSnapshotSync, statePaths } from '../../core.js'
import { appendJournalEvent } from '../../journal.js'

const prefix = join(tmpdir(), 'dsh-temp-session-healing-probe-')
const roots = []

/** Fail loudly instead of printing a line that does not hold. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** One isolated state directory and the fake Host around it. */
async function setup(name) {
  const root = await mkdtemp(`${prefix}${name}-`)
  roots.push(root)
  const paths = statePaths({ DSH_HOME: root })
  const live = new Map()
  const stored = []
  const deps = {
    sessions: { get: id => live.get(id), flush: async () => true },
    sessionPersistence: {
      locate: header => ({
        kind: 'jsonl',
        path: join(root, 'sessions', 'project', header.id, 'session.v4.jsonl.zstd'),
      }),
      list: async () => stored.map(header => ({ header })),
      stat: async id => {
        const header = stored.find(candidate => candidate.id === id)
        return header === undefined ? undefined : { header, revision: 'revision' }
      },
    },
    sessionController: {
      rename: async request => ({ title: request.title, seq: 1 }),
      cancel: () => ({ accepted: true }),
    },
    agents: { get: () => undefined },
    jobs: { list: () => [], kill: () => 'requested', wait: async () => ({ status: 'killed' }) },
    workspaceRegistry: { archiveSession: async () => {}, unarchiveSession: async () => {} },
    trace: () => {},
    logger: { warn: () => {}, info: () => {} },
    paths,
  }
  return { root, paths, deps, live, stored, temp: new TemporarySessions(deps) }
}

/** A Session with the header fields the locator and validation read. */
function sessionOf(id, {
  cwd = '/tmp/project', isSeeded = false, origin, parentSession, createdAt = 1,
} = {}) {
  return {
    id,
    header: {
      id,
      cwd,
      isSeeded,
      createdAt,
      ...(origin === undefined ? {} : { origin }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

function sessionDirOf(root, id) {
  return join(root, 'sessions', 'project', id)
}

/** Create the stored directory and log artifact the locator derives for an id. */
async function materialize(root, id) {
  const dir = sessionDirOf(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

/** A registry row shaped like a pre-healing record. */
function recordOf(root, session, overrides = {}) {
  return {
    sessionId: session.id,
    dir: sessionDirOf(root, session.id),
    cwd: session.header.cwd ?? null,
    createdAt: session.header.createdAt ?? 1,
    title: '',
    kind: 'main',
    parentSessionId: session.header.parentSession ?? null,
    pendingDelete: false,
    ...overrides,
  }
}

/** Serialize a `sessions` object without its closing braces. */
function rawSessionsText(records) {
  const members = Object.entries(records)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',')
  return `{"version":1,"sessions":{${members}}`
}

async function writeRawRegistry(paths, text) {
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.file, text)
}

/** Seed one complete migration plus owned events. */
async function seedOwned(root, paths, owned, {
  at = 100,
  preexisting = owned.map(item => item.session.id),
  pendingIds = [],
} = {}) {
  await appendJournalEvent(paths.journal, {
    type: 'migration',
    ids: owned.map(item => item.session.id),
    preexisting,
    at,
  })
  let tick = at + 1
  for (const item of owned) {
    await appendJournalEvent(paths.journal, {
      type: 'owned',
      sessionId: item.session.id,
      kind: item.kind ?? 'main',
      parentSessionId: item.parent?.id ?? null,
      dir: sessionDirOf(root, item.session.id),
      cwd: item.session.header.cwd ?? null,
      at: tick,
    })
    tick += 1
  }
  if (pendingIds.length > 0) {
    await appendJournalEvent(paths.journal, {
      type: 'pending', sessionIds: pendingIds, reason: 'discard', at: tick,
    })
  }
  await appendJournalEvent(paths.journal, { type: 'migrationComplete', at: tick + 1 })
}

async function backlogEntries(paths) {
  const text = await readFile(paths.unresolved, 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function modeOf(path) {
  return fs.statSync(path).mode & 0o777
}

async function recoveredThree() {
  const w = await setup('recovered')
  const sessions = [
    sessionOf('session-probe-truncated-one', { createdAt: 10 }),
    sessionOf('session-probe-truncated-two', { createdAt: 20 }),
    sessionOf('session-probe-truncated-three', { createdAt: 30 }),
  ]
  for (const session of sessions) await materialize(w.root, session.id)
  w.stored.push(...sessions.map(session => session.header))
  await seedOwned(w.root, w.paths, sessions.map(session => ({ session })))
  const titles = new Map(sessions.map((session, index) => [session.id, `recovered title ${index + 1}`]))
  const records = Object.fromEntries(sessions.map(session => [
    session.id,
    recordOf(w.root, session, { title: titles.get(session.id) }),
  ]))
  await writeRawRegistry(w.paths, rawSessionsText(records))
  await w.temp.load()
  check(w.temp.registryDegraded === false, 'the truncated registry was not healed')
  const expected = sessions.map(session => session.id).sort()
  check(
    JSON.stringify(Object.keys(w.temp.state.sessions).sort()) === JSON.stringify(expected),
    'the recovered state does not hold exactly the three complete records',
  )
  const published = JSON.parse(await readFile(w.paths.file, 'utf8'))
  check(
    JSON.stringify(Object.keys(published.sessions).sort()) === JSON.stringify(expected),
    'the published registry does not hold exactly the three complete records',
  )
  for (const session of sessions) {
    check(
      published.sessions[session.id]?.title === titles.get(session.id),
      `the complete record for ${session.id} did not survive truncation`,
    )
  }
  check(w.temp.exitSnapshot().sessions.length === 3, 'the exit snapshot lost a recovered record')
  check(fs.readdirSync(w.paths.preserved).length > 0, 'the damaged original was not preserved')
  check(fs.existsSync(w.paths.unresolved), 'the unresolved bytes were not recorded')
}

async function keyMismatch() {
  const w = await setup('key-mismatch')
  const first = sessionOf('session-probe-key-first', { createdAt: 10 })
  const mismatched = sessionOf('session-probe-key-mismatch', { createdAt: 20 })
  const other = sessionOf('session-probe-key-other', { createdAt: 30 })
  for (const session of [first, mismatched, other]) await materialize(w.root, session.id)
  w.stored.push(first.header, mismatched.header, other.header)
  await seedOwned(w.root, w.paths, [{ session: first }])
  const row = recordOf(w.root, mismatched, { sessionId: other.id })
  await writeRawRegistry(
    w.paths,
    `{"version":1,"sessions":{${JSON.stringify(mismatched.id)}:${JSON.stringify(row)}}`,
  )
  await w.temp.load()
  const rejected = (await backlogEntries(w.paths)).filter(entry => entry.reason === 'key-mismatch')
  check(rejected.length === 1, `expected one key mismatch, saw ${rejected.length}`)
  check(w.temp.state.sessions[first.id] !== undefined, 'the journal-only record was not rebuilt')
  check(w.temp.state.sessions[mismatched.id] === undefined, 'the key-mismatched row was interpreted')
  check(fs.existsSync(join(sessionDirOf(w.root, mismatched.id), 'session.v4.jsonl.zstd')), 'the key-mismatched folder was deleted')
}

async function unsupportedVersion() {
  const w = await setup('unsupported')
  const chat = sessionOf('session-probe-unsupported', { createdAt: 10 })
  const live = sessionOf('session-probe-unsupported-live', { createdAt: 20 })
  const dir = await materialize(w.root, chat.id)
  w.stored.push(chat.header)
  w.live.set(live.id, live)
  await seedOwned(w.root, w.paths, [{ session: chat }])
  const original = `{"version":2,"sessions":{${JSON.stringify(chat.id)}:${JSON.stringify(recordOf(w.root, chat))}}}\n`
  await writeRawRegistry(w.paths, original)
  let flushed = false
  w.deps.sessions.flush = async () => { flushed = true; return true }
  await w.temp.load()
  check(w.temp.registryUnsupported === true, 'version 2 was not refused')
  check(w.temp.registryDegraded === true, 'the unsupported registry was not marked degraded')
  check(Object.keys(w.temp.state.sessions).length === 0, 'version 2 was interpreted')
  check(await readFile(w.paths.file, 'utf8') === original, 'the unsupported registry bytes changed')
  check(cleanupSnapshotSync(w.temp.exitSnapshot()) === 0, 'the unsupported registry deleted something')
  check(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), 'the Session folder was deleted')
  let refused = false
  try {
    await w.temp.register({ sessionId: live.id })
  } catch (error) {
    refused = /registry is damaged/.test(String(error))
  }
  check(refused, 'registration was not refused for an unsupported registry')
  check(flushed === false, 'registration flushed a transcript')

  const child = sessionOf('session-probe-unsupported-child', {
    isSeeded: true, parentSession: chat.id, createdAt: 30,
  })
  const journalBefore = await readFile(w.paths.journal, 'utf8')
  await w.temp.recordDescendant(child)
  check(w.temp.state.sessions[child.id] === undefined, 'the unsupported registry took an announcement')
  await w.temp.reap()
  check(Object.keys(w.temp.state.sessions).length === 0, 'the reap interpreted version 2')
  check(w.temp.exitSnapshot().sessions.length === 0, 'the reap exposed a deletion snapshot')
  check(cleanupSnapshotSync(w.temp.exitSnapshot()) === 0, 'the reaped unsupported registry deleted something')
  check(await readFile(w.paths.file, 'utf8') === original, 'the reaped unsupported registry bytes changed')
  check(await readFile(w.paths.journal, 'utf8') === journalBefore, 'the unsupported registry wrote the journal')
  check(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), 'the reaped Session folder was deleted')

  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  await restarted.reap()
  check(Object.keys(restarted.state.sessions).length === 0, 'the restart interpreted version 2')
  check(restarted.exitSnapshot().sessions.length === 0, 'the restart exposed a deletion snapshot')
  check(cleanupSnapshotSync(restarted.exitSnapshot()) === 0, 'the restarted unsupported registry deleted something')
  check(await readFile(w.paths.file, 'utf8') === original, 'the restarted unsupported registry bytes changed')
  check(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), 'the restarted Session folder was deleted')
}

async function journalDegradedRegistration() {
  const w = await setup('journal-degraded')
  const owned = sessionOf('session-probe-journal-owned', { createdAt: 10 })
  const live = sessionOf('session-probe-journal-live', { createdAt: 20 })
  w.stored.push(owned.header)
  w.live.set(live.id, live)
  await seedOwned(w.root, w.paths, [{ session: owned }])
  await writeFile(w.paths.journal, `${await readFile(w.paths.journal, 'utf8')}not an event\n`)
  const before = await readFile(w.paths.journal, 'utf8')
  let flushed = false
  w.deps.sessions.flush = async () => { flushed = true; return true }
  await w.temp.load()
  check(w.temp.journalDegraded === true, 'the damaged journal was not refused')
  let refused = false
  try {
    await w.temp.register({ sessionId: live.id })
  } catch (error) {
    refused = /journal is degraded/.test(String(error))
  }
  check(refused, 'registration was not refused while the journal was degraded')
  check(flushed === false, 'registration flushed a transcript while degraded')
  check(await readFile(w.paths.journal, 'utf8') === before, 'the journal changed during degraded registration')
}

async function sidePreserved() {
  const w = await setup('side')
  const source = sessionOf('session-probe-side-source', { createdAt: 1 })
  const side = sessionOf('session-probe-side-chat', {
    isSeeded: true, parentSession: source.id, createdAt: 20,
  })
  await materialize(w.root, source.id)
  await materialize(w.root, side.id)
  w.stored.push(source.header, side.header)
  await seedOwned(w.root, w.paths, [
    { session: side, kind: 'side', parent: source },
  ], {
    preexisting: [source.id, side.id],
    pendingIds: [side.id],
  })
  await writeRawRegistry(w.paths, rawSessionsText({
    [side.id]: recordOf(w.root, side, {
      kind: 'side', title: 'Recovered side title', pendingDelete: true,
    }),
  }))
  await w.temp.load()
  check(w.temp.state.sessions[side.id]?.kind === 'side', 'the recovered side kind was lost')
  check(w.temp.state.sessions[side.id]?.title === 'Recovered side title', 'the recovered side title was lost')
  check(w.temp.state.sessions[side.id]?.pendingDelete === true, 'the recovered side pending state was lost')
  check(
    w.temp.exitSnapshot().sessions.some(record => record.sessionId === side.id),
    'the recovered side record is absent from the exit snapshot',
  )
}

async function backlogPrivate() {
  const w = await setup('backlog')
  const chat = sessionOf('session-probe-backlog', { createdAt: 10 })
  await materialize(w.root, chat.id)
  w.stored.push(chat.header)
  await seedOwned(w.root, w.paths, [{ session: chat }])
  await writeRawRegistry(w.paths, `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":`)
  await w.temp.load()
  check(fs.existsSync(w.paths.unresolved), 'the unresolved backlog was not created')
  check(modeOf(w.paths.unresolved) === 0o600, 'the unresolved backlog is not 0600')
  const preserved = fs.readdirSync(w.paths.preserved)
  check(preserved.length > 0, 'the damaged original was not preserved')
  check(modeOf(join(w.paths.preserved, preserved[0])) === 0o600, 'the preserved original is not 0600')
}

async function retriedAfterCrash() {
  const w = await setup('retry')
  const chat = sessionOf('session-probe-crash', { createdAt: 10 })
  const dir = await materialize(w.root, chat.id)
  w.stored.push(chat.header)
  await seedOwned(w.root, w.paths, [{ session: chat }])
  const original = rawSessionsText({ [chat.id]: recordOf(w.root, chat) })
  await writeRawRegistry(w.paths, original)
  const preserve = w.temp.recovery.preserve.bind(w.temp.recovery)
  w.temp.recovery.preserve = (...args) => {
    preserve(...args)
    throw new Error('injected crash after preserve')
  }
  await w.temp.load()
  check(w.temp.registryDegraded === true, 'the injected crash did not leave the registry degraded')
  check(await readFile(w.paths.file, 'utf8') === original, 'the damaged original was overwritten before retirement')
  check(w.temp.state.sessions[chat.id] !== undefined, 'the journal-owned record was lost before restart')
  check(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), 'the folder was deleted during degradation')

  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  check(restarted.registryDegraded === false, 'the restart did not finish healing')
  check(restarted.state.sessions[chat.id] !== undefined, 'the restart lost the recovered record')
  const published = JSON.parse(await readFile(w.paths.file, 'utf8'))
  check(published.sessions[chat.id] !== undefined, 'the restart did not publish the recovered record')
  check(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), 'the restart deleted the folder')
}

try {
  await recoveredThree()
  process.stdout.write('recovered 3\n')

  await keyMismatch()
  process.stdout.write('rejected 1: key mismatch\n')

  await unsupportedVersion()
  process.stdout.write('unsupported version: untouched\n')

  await journalDegradedRegistration()
  process.stdout.write('registration refused while journal degraded\n')

  await sidePreserved()
  process.stdout.write('side preserved session-side\n')

  await backlogPrivate()
  process.stdout.write('backlog 0600\n')

  await retriedAfterCrash()
  process.stdout.write('retried after crash\n')
} catch (error) {
  process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  for (const root of roots) {
    if (root.startsWith(prefix)) await rm(root, { recursive: true, force: true })
  }
}
