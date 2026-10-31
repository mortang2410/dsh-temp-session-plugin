/**
 * Deterministic registry healing and degraded-mode tests. The Host services
 * are faked; the registry, journal, evidence files and folders are real.
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { TemporarySessions, cleanupSnapshotSync, statePaths } from '../core.js'
import { appendJournalEvent } from '../journal.js'

let root

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function fakeSession(id, {
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

function sessionDirOf(id) {
  return join(root, 'sessions', 'project', id)
}

function pathsOf() {
  return statePaths({ DSH_HOME: root })
}

async function materialize(id) {
  const dir = sessionDirOf(id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

async function journalLines(paths) {
  try {
    return (await readFile(paths.journal, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function recordOf(session, overrides = {}) {
  return {
    sessionId: session.id,
    dir: sessionDirOf(session.id),
    cwd: session.header.cwd ?? null,
    createdAt: session.header.createdAt ?? 1,
    title: '',
    kind: 'main',
    parentSessionId: session.header.parentSession ?? null,
    pendingDelete: false,
    ...overrides,
  }
}

function rawSessionsText(records, suffix = '') {
  const members = Object.entries(records)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',')
  return `{"version":1,"sessions":{${members}}${suffix}`
}

async function writeRegistry(paths, sessions) {
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.file, JSON.stringify({ version: 1, sessions }, null, 2))
}

async function writeRawRegistry(paths, text) {
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.file, text)
}

async function seedOwnedSessions(paths, owned, {
  at = 100,
  preexisting = owned.map(item => item.session.id),
  complete = true,
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
      dir: sessionDirOf(item.session.id),
      cwd: item.session.header.cwd ?? null,
      at: tick,
    })
    tick += 1
  }
  if (pendingIds.length > 0) {
    await appendJournalEvent(paths.journal, {
      type: 'pending', sessionIds: pendingIds, reason: 'discard', at: tick,
    })
    tick += 1
  }
  if (complete) await appendJournalEvent(paths.journal, { type: 'migrationComplete', at: tick })
}

function newWorld({ live = [], stored = [] } = {}) {
  const paths = pathsOf()
  const liveMap = new Map(live.map(session => [session.id, session]))
  const storedHeaders = [...stored]
  const warnings = []
  const deps = {
    sessions: { get: id => liveMap.get(id), flush: async () => true },
    sessionPersistence: {
      locate: header => ({
        kind: 'jsonl',
        path: join(root, 'sessions', 'project', header.id, 'session.v4.jsonl.zstd'),
      }),
      list: async () => storedHeaders.map(header => ({ header })),
      stat: async id => {
        const header = storedHeaders.find(candidate => candidate.id === id)
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
    logger: { warn: message => warnings.push(message), info: () => {} },
    paths,
  }
  const temp = new TemporarySessions(deps)
  return {
    temp,
    deps,
    paths,
    live: liveMap,
    stored: storedHeaders,
    warnings,
  }
}

function modeOf(path) {
  return fs.statSync(path).mode & 0o777
}

test('an unrelated id is rejected', async () => {
  const chat = fakeSession('session-unrelated-chat', { createdAt: 10 })
  const victim = fakeSession('session-unrelated-victim', { createdAt: 20 })
  await materialize(chat.id)
  await materialize(victim.id)
  const w = newWorld({ stored: [chat.header, victim.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRawRegistry(w.paths, rawSessionsText({
    [chat.id]: recordOf(chat, { title: `look at ${victim.id}` }),
  }, `,"outside":{"sessionId":${JSON.stringify(victim.id)},"dir":${JSON.stringify(sessionDirOf(victim.id))}}}`))
  await w.temp.load()
  assert.deepEqual(Object.keys(w.temp.state.sessions), [chat.id])
  assert.equal(w.temp.state.sessions[victim.id], undefined)
  assert.equal(fs.existsSync(join(sessionDirOf(victim.id), 'session.v4.jsonl.zstd')), true)
})

test('a substring is not a token', async () => {
  const chat = fakeSession('session-substring-chat', { createdAt: 10 })
  const victim = fakeSession('session-substring-victim', { createdAt: 20 })
  await materialize(chat.id)
  await materialize(victim.id)
  const w = newWorld({ stored: [chat.header, victim.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRawRegistry(w.paths, rawSessionsText({
    [chat.id]: recordOf(chat, { title: `prefix-${victim.id}-suffix` }),
  }))
  await w.temp.load()
  assert.deepEqual(Object.keys(w.temp.state.sessions), [chat.id])
  assert.equal(w.temp.state.sessions[victim.id], undefined)
})

test('a permanent chat is never recovered', async () => {
  const permanent = fakeSession('session-permanent-recovery', { createdAt: 10 })
  const dir = await materialize(permanent.id)
  const w = newWorld({ stored: [permanent.header] })
  await writeRawRegistry(w.paths, rawSessionsText({}, `,"outside":{"sessionId":${JSON.stringify(permanent.id)},"dir":${JSON.stringify(dir)}}}`))
  await w.temp.load()
  assert.deepEqual(w.temp.state.sessions, {})
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('the key and the sessionId must agree', async () => {
  const first = fakeSession('session-key-first', { createdAt: 10 })
  const second = fakeSession('session-key-second', { createdAt: 20 })
  const duplicate = fakeSession('session-key-duplicate', { createdAt: 30 })
  const control = fakeSession('session-key-control', { createdAt: 40 })
  const owned = fakeSession('session-key-owned', { createdAt: 50 })
  for (const session of [first, second, duplicate, control, owned]) await materialize(session.id)
  const w = newWorld({
    stored: [first.header, second.header, duplicate.header, control.header, owned.header],
  })
  await seedOwnedSessions(w.paths, [{ session: owned }], {
    preexisting: [first.id, second.id, duplicate.id, control.id, owned.id],
  })
  const firstRecord = JSON.stringify(recordOf(first, { sessionId: second.id }))
  const secondRecord = JSON.stringify(recordOf(second, { sessionId: first.id }))
  const duplicateRecord = JSON.stringify(recordOf(duplicate))
  const ownedRecord = JSON.stringify(recordOf(owned, { sessionId: first.id }))
  await writeRawRegistry(w.paths, `{"version":1,"sessions":{${JSON.stringify(first.id)}:${firstRecord},${JSON.stringify(second.id)}:${secondRecord},${JSON.stringify(duplicate.id)}:${duplicateRecord},${JSON.stringify(duplicate.id)}:${duplicateRecord},${JSON.stringify(owned.id)}:${ownedRecord}}}`)
  await w.temp.load()
  // The journal-owned id is named by a key-mismatched row, so it stays
  // quarantined instead of being rebuilt as a journal-only deletion target.
  assert.deepEqual(Object.keys(w.temp.state.sessions), [])
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  for (const session of [first, second, duplicate, control, owned]) {
    assert.equal(fs.existsSync(join(sessionDirOf(session.id), 'session.v4.jsonl.zstd')), true)
  }
  assert.ok(w.warnings.some(message => message.includes('key-mismatch')))
  assert.ok(w.warnings.some(message => message.includes('duplicate-member')))
})

test('a truncated member keeps its surviving sessionId disagreement', async () => {
  const scenario = async (keyId, namedId) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const key = fakeSession(keyId, { createdAt: 10 })
      const named = fakeSession(namedId, { createdAt: 20 })
      const control = fakeSession(`session-truncated-control-${keyId}`, { createdAt: 30 })
      for (const session of [key, named, control]) await materialize(session.id)
      const w = newWorld({ stored: [key.header, named.header, control.header] })
      await seedOwnedSessions(w.paths, [{ session: key }, { session: named }])
      const original = `{"version":1,"sessions":{${JSON.stringify(key.id)}:{"sessionId":${JSON.stringify(named.id)},"title":`
      await writeRawRegistry(w.paths, original)
      await w.temp.load()
      assert.equal(w.temp.registryDisputed.has(key.id), true)
      assert.equal(w.temp.registryDisputed.has(named.id), true)
      assert.equal(w.temp.registryDegraded, true)
      assert.deepEqual(w.temp.state.sessions, {})
      assert.equal(await readFile(w.paths.file, 'utf8'), original)
      assert.deepEqual(w.temp.exitSnapshot().sessions, [])
      assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
      for (const session of [key, named, control]) {
        assert.equal(fs.existsSync(join(sessionDirOf(session.id), 'session.v4.jsonl.zstd')), true)
      }
      assert.ok(w.warnings.some(message => message.includes('key-mismatch')))
      const restarted = new TemporarySessions(w.deps)
      await restarted.load()
      assert.equal(restarted.registryDisputed.has(key.id), true)
      assert.equal(restarted.registryDisputed.has(named.id), true)
      assert.deepEqual(restarted.state.sessions, {})
      assert.equal(await readFile(w.paths.file, 'utf8'), original)
      for (const session of [key, named, control]) {
        assert.equal(fs.existsSync(join(sessionDirOf(session.id), 'session.v4.jsonl.zstd')), true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  await scenario('session-truncated-key', 'session-truncated-named')
  await scenario('session-truncated-named', 'session-truncated-key')
})

test('a matching truncated member is still recovered', async () => {
  const chat = fakeSession('session-truncated-matching', { createdAt: 10 })
  const permanent = fakeSession('session-truncated-permanent', { createdAt: 20 })
  for (const session of [chat, permanent]) await materialize(session.id)
  const w = newWorld({ stored: [chat.header, permanent.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const original = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"cwd":${JSON.stringify(chat.header.cwd)},"kind":"main","parentSessionId":null,"pendingDelete":false,"title":`
  await writeRawRegistry(w.paths, original)
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, false)
  assert.deepEqual(Object.keys(w.temp.state.sessions), [chat.id])
  assert.notEqual(await readFile(w.paths.file, 'utf8'), original)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(join(sessionDirOf(permanent.id), 'session.v4.jsonl.zstd')), true)
  assert.match(await readFile(w.paths.unresolved, 'utf8'), /truncated-member/)
  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  assert.deepEqual(Object.keys(restarted.state.sessions), [chat.id])
})

test('a matching truncated member with conflicting authority is quarantined', async () => {
  const scenario = async (label, produce) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const chat = fakeSession(`session-truncated-authority-${label}`, { createdAt: 10 })
      await materialize(chat.id)
      const w = newWorld({ stored: [chat.header] })
      await seedOwnedSessions(w.paths, [{ session: chat }])
      const original = produce(chat)
      await writeRawRegistry(w.paths, original)
      await w.temp.load()
      assert.equal(w.temp.registryDisputed.has(chat.id), true, label)
      assert.equal(w.temp.registryDegraded, true, label)
      assert.deepEqual(w.temp.state.sessions, {}, label)
      assert.equal(await readFile(w.paths.file, 'utf8'), original, label)
      assert.deepEqual(w.temp.exitSnapshot().sessions, [], label)
      assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0, label)
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, label)
      const restarted = new TemporarySessions(w.deps)
      await restarted.load()
      assert.equal(restarted.registryDisputed.has(chat.id), true, label)
      assert.deepEqual(restarted.state.sessions, {}, label)
      assert.equal(await readFile(w.paths.file, 'utf8'), original, label)
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, label)
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  const base = chat => `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)}`
  await scenario('dir', chat => `${base(chat)},"dir":${JSON.stringify(join(root, 'wrong', chat.id))},"title":`)
  await scenario('cwd', chat => `${base(chat)},"cwd":"/tmp/wrong","title":`)
  await scenario('kind', chat => `${base(chat)},"kind":"side","title":`)
  await scenario('parent', chat => `${base(chat)},"parentSessionId":"session-other","title":`)
  await scenario('pending', chat => `${base(chat)},"pendingDelete":true,"title":`)
  await scenario('duplicate', chat => `${base(chat)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"dir":`)
})

test('a surviving partial kind is compared with the journal', async () => {
  const scenario = async (journalKind, fieldKind, disputed) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const parent = { id: 'session-side-parent' }
      const chat = fakeSession(`session-side-${journalKind}-${fieldKind}`, {
        isSeeded: true, parentSession: parent.id, createdAt: 10,
      })
      const control = fakeSession('session-side-control', { createdAt: 20 })
      for (const session of [chat, control]) await materialize(session.id)
      const w = newWorld({ stored: [chat.header, control.header] })
      await seedOwnedSessions(w.paths, [{ session: chat, kind: journalKind, parent }])
      const original = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"kind":${JSON.stringify(fieldKind)},"title":`
      await writeRawRegistry(w.paths, original)
      await w.temp.load()
      if (disputed) {
        assert.equal(w.temp.registryDisputed.has(chat.id), true)
        assert.equal(w.temp.registryDegraded, true)
        assert.deepEqual(w.temp.state.sessions, {})
        assert.equal(await readFile(w.paths.file, 'utf8'), original)
        assert.deepEqual(w.temp.exitSnapshot().sessions, [])
        assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
        assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
        const restarted = new TemporarySessions(w.deps)
        await restarted.load()
        assert.equal(restarted.registryDisputed.has(chat.id), true)
        assert.deepEqual(restarted.state.sessions, {})
      } else {
        assert.equal(w.temp.state.sessions[chat.id].kind, 'side')
        assert.notEqual(await readFile(w.paths.file, 'utf8'), original)
        const restarted = new TemporarySessions(w.deps)
        await restarted.load()
        assert.equal(restarted.state.sessions[chat.id].kind, 'side')
      }
      assert.equal(fs.existsSync(join(sessionDirOf(control.id), 'session.v4.jsonl.zstd')), true)
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  await scenario('fork', 'side', true)
  await scenario('side', 'fork', false)
})

test('an unavailable stored listing defers partial disputes', async () => {
  const scenario = async (label, rawFor, disputed) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const chat = fakeSession(`session-list-${label}-chat`, { createdAt: 10 })
      const control = fakeSession(`session-list-${label}-control`, { createdAt: 20 })
      for (const session of [chat, control]) await materialize(session.id)
      const w = newWorld({ live: [chat], stored: [chat.header, control.header] })
      await seedOwnedSessions(w.paths, [{ session: chat }])
      const original = rawFor(chat)
      await writeRawRegistry(w.paths, original)
      w.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
      await w.temp.load()
      assert.equal(w.temp.registryDegraded, true, label)
      assert.equal(w.temp.registryDisputed.has(chat.id), disputed, label)
      assert.equal(await readFile(w.paths.file, 'utf8'), original, label)
      assert.deepEqual(w.temp.exitSnapshot().sessions, [], label)
      assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0, label)
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, label)
      assert.equal(fs.existsSync(join(sessionDirOf(control.id), 'session.v4.jsonl.zstd')), true, label)
      w.deps.sessionPersistence.list = async () => ([{ header: chat.header }, { header: control.header }])
      const retried = new TemporarySessions(w.deps)
      await retried.load()
      if (disputed) {
        assert.equal(retried.registryDisputed.has(chat.id), true, label)
        assert.equal(await readFile(w.paths.file, 'utf8'), original, label)
      } else {
        assert.deepEqual(Object.keys(retried.state.sessions), [chat.id], label)
        assert.notEqual(await readFile(w.paths.file, 'utf8'), original, label)
      }
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, label)
      assert.equal(fs.existsSync(join(sessionDirOf(control.id), 'session.v4.jsonl.zstd')), true, label)
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  await scenario('identity', chat => `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":"session-list-other","title":`, true)
  await scenario('authority', chat => `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":"/tmp/wrong","title":`, true)
  await scenario('safe', chat => `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"cwd":${JSON.stringify(chat.header.cwd)},"kind":"main","parentSessionId":null,"pendingDelete":false,"title":`, false)
})

test('a journal-first pending write is accepted for a partial row', async () => {
  const scenario = async (journalPending, fieldPending, disputed) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const chat = fakeSession(`session-partial-pending-${journalPending}-${fieldPending}`, { createdAt: 10 })
      await materialize(chat.id)
      const w = newWorld({ stored: [chat.header] })
      await seedOwnedSessions(w.paths, [{ session: chat }], {
        pendingIds: journalPending ? [chat.id] : [],
      })
      const original = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"pendingDelete":${fieldPending},"title":`
      await writeRawRegistry(w.paths, original)
      await w.temp.load()
      if (disputed) {
        assert.equal(w.temp.registryDisputed.has(chat.id), true)
        assert.equal(w.temp.registryDegraded, true)
        assert.equal(await readFile(w.paths.file, 'utf8'), original)
        assert.deepEqual(w.temp.state.sessions, {})
        assert.deepEqual(w.temp.exitSnapshot().sessions, [])
        assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
      } else {
        assert.equal(w.temp.state.sessions[chat.id].pendingDelete, true)
        assert.notEqual(await readFile(w.paths.file, 'utf8'), original)
      }
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
      const restarted = new TemporarySessions(w.deps)
      await restarted.load()
      if (disputed) assert.equal(restarted.registryDisputed.has(chat.id), true)
      else assert.equal(restarted.state.sessions[chat.id].pendingDelete, true)
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  await scenario(true, false, false)
  await scenario(false, true, true)
})

test('a complete row is validated when the stored listing is unavailable', async () => {
  const scenario = async (label, change) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const parent = { id: 'session-list-parent' }
      const chat = fakeSession(`session-list-complete-${label}`, {
        isSeeded: true, parentSession: parent.id, createdAt: 10,
      })
      const control = fakeSession('session-list-permanent', { createdAt: 20 })
      for (const session of [chat, control]) await materialize(session.id)
      const w = newWorld({ live: [chat], stored: [chat.header, control.header] })
      await seedOwnedSessions(w.paths, [{ session: chat, kind: 'fork', parent }])
      const row = recordOf(chat, { kind: 'fork', ...change(chat) })
      await writeRegistry(w.paths, { [chat.id]: row })
      const original = await readFile(w.paths.file, 'utf8')
      w.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
      await w.temp.load()
      assert.equal(w.temp.registryDisputed.has(chat.id), true, label)
      assert.equal(w.temp.registryDegraded, true, label)
      assert.deepEqual(w.temp.state.sessions, {}, label)
      assert.equal(await readFile(w.paths.file, 'utf8'), original, label)
      assert.deepEqual(w.temp.exitSnapshot().sessions, [], label)
      assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0, label)
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, label)
      assert.equal(fs.existsSync(join(sessionDirOf(control.id), 'session.v4.jsonl.zstd')), true, label)
      const restarted = new TemporarySessions(w.deps)
      await restarted.load()
      assert.equal(restarted.registryDisputed.has(chat.id), true, label)
      assert.equal(await readFile(w.paths.file, 'utf8'), original, label)
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  await scenario('dir', () => ({ dir: '/tmp/wrong' }))
  await scenario('cwd', () => ({ cwd: '/tmp/wrong' }))
  await scenario('kind', () => ({ kind: 'side' }))
  await scenario('parent', () => ({ parentSessionId: 'session-other' }))
  await scenario('pending', () => ({ pendingDelete: true }))
})

test('a matching partial row retries after the listing returns', async () => {
  const chat = fakeSession('session-listing-retry', { createdAt: 10 })
  const control = fakeSession('session-listing-retry-control', { createdAt: 20 })
  for (const session of [chat, control]) await materialize(session.id)
  const w = newWorld({ stored: [chat.header, control.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const original = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"title":`
  await writeRawRegistry(w.paths, original)
  w.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(chat.id), false)
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(w.temp.listingUncertain, true)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  w.deps.sessionPersistence.list = async () => ([{ header: chat.header }, { header: control.header }])
  await w.temp.reap()
  assert.equal(w.temp.registryDisputed.has(chat.id), false)
  assert.equal(w.temp.registryDegraded, false)
  assert.equal(w.temp.listingUncertain, false)
  assert.equal(fs.existsSync(join(sessionDirOf(control.id), 'session.v4.jsonl.zstd')), true)
})

test('a conflicting partial row is quarantined when the listing returns', async () => {
  const chat = fakeSession('session-listing-conflict', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const original = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":"/tmp/wrong","title":`
  await writeRawRegistry(w.paths, original)
  w.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(chat.id), false)
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(w.temp.listingUncertain, true)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  w.deps.sessionPersistence.list = async () => ([{ header: chat.header }])
  await w.temp.reap()
  assert.equal(w.temp.registryDisputed.has(chat.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
})

test('a conflicting orphan is quarantined before reconciliation deletes it', async () => {
  const scenario = async (disagreement) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const parent = fakeSession(`session-orphan-parent-${disagreement}`, { createdAt: 1 })
      const child = fakeSession(`session-orphan-child-${disagreement}`, {
        origin: 'subagent', parentSession: parent.id, createdAt: 10,
      })
      await materialize(child.id)
      const w = newWorld({ stored: [child.header] })
      await appendJournalEvent(w.paths.journal, {
        type: 'migration', ids: [parent.id, child.id], preexisting: [parent.id, child.id], at: 1,
      })
      await appendJournalEvent(w.paths.journal, {
        type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
        dir: sessionDirOf(parent.id), cwd: '/tmp/project', at: 2,
      })
      await appendJournalEvent(w.paths.journal, {
        type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
        dir: sessionDirOf(parent.id), cwd: '/tmp/project', at: 3,
      })
      await appendJournalEvent(w.paths.journal, {
        type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
        dir: sessionDirOf(child.id), cwd: '/tmp/project', at: 4,
      })
      await appendJournalEvent(w.paths.journal, { type: 'migrationComplete', at: 5 })
      const original = `{"version":1,"sessions":{${JSON.stringify(child.id)}:{"sessionId":${JSON.stringify(child.id)},"dir":${JSON.stringify(disagreement ? '/tmp/wrong' : sessionDirOf(child.id))},"title":`
      await writeRawRegistry(w.paths, original)
      w.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
      await w.temp.load()
      assert.equal(w.temp.registryDisputed.has(child.id), false)
      assert.equal(w.temp.listingUncertain, true)
      assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
      w.deps.sessionPersistence.list = async () => ([{ header: child.header }])
      await w.temp.reap()
      if (disagreement) {
        assert.equal(w.temp.registryDisputed.has(child.id), true)
        assert.equal(w.temp.registryDegraded, true)
        assert.equal(await readFile(w.paths.file, 'utf8'), original)
        assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
        assert.equal(w.temp.journal.entries[child.id].deleted, false)
      } else {
        assert.equal(w.temp.registryDisputed.has(child.id), false)
        assert.equal(w.temp.registryDegraded, false)
        assert.notEqual(await readFile(w.paths.file, 'utf8'), original)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  await scenario(true)
  await scenario(false)
})

test('a repaired registry does not reuse its stale read', async () => {
  const chat = fakeSession('session-stale-read', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const old = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"title":`
  await writeRawRegistry(w.paths, old)
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, false)
  assert.notEqual(await readFile(w.paths.file, 'utf8'), old)
  assert.equal(w.temp.registryRead, undefined)
  const newer = JSON.stringify({ version: 2, sessions: { [chat.id]: { sessionId: chat.id } } })
  await writeFile(w.paths.file, newer)
  await w.temp.reap()
  assert.equal(await readFile(w.paths.file, 'utf8'), newer)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
})

test('a repaired registry preserves a later damaged file', async () => {
  const chat = fakeSession('session-stale-damaged', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const old = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"title":`
  await writeRawRegistry(w.paths, old)
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, false)
  const damaged = '{damaged'
  await writeFile(w.paths.file, damaged)
  await w.temp.reap()
  assert.equal(await readFile(w.paths.file, 'utf8'), damaged)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
})

test('a repaired registry heals later recoverable damage', async () => {
  const chat = fakeSession('session-stale-recoverable', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const old = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"title":`
  await writeRawRegistry(w.paths, old)
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, false)
  const recovered = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"title":`
  await writeFile(w.paths.file, recovered)
  await w.temp.reap()
  assert.equal(w.temp.registryDegraded, false)
  assert.notEqual(await readFile(w.paths.file, 'utf8'), recovered)
})

test('a repaired registry remains healthy across a repeated reap', async () => {
  const chat = fakeSession('session-stale-healthy', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const old = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":${JSON.stringify(sessionDirOf(chat.id))},"title":`
  await writeRawRegistry(w.paths, old)
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, false)
  await w.temp.reap()
  assert.equal(w.temp.registryDegraded, false)
  assert.equal(JSON.parse(await readFile(w.paths.file, 'utf8')).version, 1)
})

test('a changed conflicting partial row is validated before the old record', async () => {
  const chat = fakeSession('session-changed-partial', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
  await w.temp.load()
  assert.deepEqual(Object.keys(w.temp.state.sessions), [chat.id])
  const changed = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:{"sessionId":${JSON.stringify(chat.id)},"dir":"/tmp/wrong","title":`
  await writeRawRegistry(w.paths, changed)
  await w.temp.reap()
  assert.equal(w.temp.registryDisputed.has(chat.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(await readFile(w.paths.file, 'utf8'), changed)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
})

test('a changed complete pending row is validated before the old record', async () => {
  const chat = fakeSession('session-changed-complete', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ live: [chat], stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
  await w.temp.load()
  assert.deepEqual(Object.keys(w.temp.state.sessions), [chat.id])
  const changed = JSON.stringify({
    version: 1,
    sessions: { [chat.id]: recordOf(chat, { pendingDelete: true }) },
  })
  await writeRawRegistry(w.paths, changed)
  w.live.delete(chat.id)
  await w.temp.reap()
  assert.equal(w.temp.registryDisputed.has(chat.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(await readFile(w.paths.file, 'utf8'), changed)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
})

test('a changed complete sibling is validated before the old record', async () => {
  for (const [label, change] of [
    ['dir', { dir: '/tmp/wrong' }],
    ['cwd', { cwd: '/tmp/wrong' }],
    ['kind', { kind: 'side' }],
    ['parent', { parentSessionId: 'session-other' }],
    ['pending', { pendingDelete: true }],
  ]) {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const chat = fakeSession(`session-changed-complete-${label}`, { createdAt: 10 })
      await materialize(chat.id)
      const w = newWorld({ live: [chat], stored: [chat.header] })
      await seedOwnedSessions(w.paths, [{ session: chat }])
      await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
      await w.temp.load()
      const changed = JSON.stringify({
        version: 1,
        sessions: { [chat.id]: recordOf(chat, change) },
      })
      await writeRawRegistry(w.paths, changed)
      w.live.delete(chat.id)
      await w.temp.reap()
      assert.equal(w.temp.registryDisputed.has(chat.id), true, label)
      assert.equal(w.temp.registryDegraded, true, label)
      assert.equal(await readFile(w.paths.file, 'utf8'), changed, label)
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, label)
      assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true, label)
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
})

test('repeated listing failures keep changed evidence unsettled until it settles', async () => {
  for (const conflict of [true, false]) {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const chat = fakeSession(`session-repeated-list-${conflict ? 'conflict' : 'match'}`, { createdAt: 10 })
      await materialize(chat.id)
      const w = newWorld({ live: [chat], stored: [chat.header] })
      await seedOwnedSessions(w.paths, [{ session: chat }], conflict ? {} : { pendingIds: [chat.id] })
      await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
      await w.temp.load()
      const changed = JSON.stringify({
        version: 1,
        sessions: { [chat.id]: recordOf(chat, { pendingDelete: true }) },
      })
      await writeRawRegistry(w.paths, changed)
      w.live.delete(chat.id)
      let failListing = true
      w.deps.sessionPersistence.list = async () => {
        if (failListing) throw new Error('listing unavailable')
        return [{ header: chat.header }]
      }
      await w.temp.reap()
      assert.equal(w.temp.registryDisputed.has(chat.id), false, conflict)
      assert.equal(w.temp.registryDegraded, true, conflict)
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, conflict)
      await w.temp.reap()
      assert.equal(w.temp.registryDisputed.has(chat.id), false, conflict)
      assert.equal(w.temp.registryDegraded, true, conflict)
      assert.equal(await readFile(w.paths.file, 'utf8'), changed, conflict)
      assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true, conflict)
      assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true, conflict)
      failListing = false
      await w.temp.reap()
      if (conflict) {
        assert.equal(w.temp.registryDisputed.has(chat.id), true)
        assert.equal(w.temp.registryDegraded, true)
        assert.equal(await readFile(w.paths.file, 'utf8'), changed)
        assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
        assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
      } else {
        assert.equal(w.temp.registryDisputed.has(chat.id), false)
        assert.equal(w.temp.registryDegraded, false)
        assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), false)
        assert.equal(w.temp.journal.entries[chat.id]?.deleted, true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
})

test('a matching complete side/fork row is accepted', async () => {
  const parent = fakeSession('session-complete-side-parent', { createdAt: 1 })
  const chat = fakeSession('session-complete-side', {
    isSeeded: true, parentSession: parent.id, createdAt: 10,
  })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat, kind: 'side', parent }])
  await writeRegistry(w.paths, {
    [chat.id]: recordOf(chat, { kind: 'fork', parentSessionId: parent.id }),
  })
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(chat.id), false)
  assert.equal(w.temp.registryDegraded, false)
  assert.equal(w.temp.state.sessions[chat.id].kind, 'side')
  assert.equal(await readFile(w.paths.file, 'utf8') !== '', true)
})

test('an unreadable registry blocks destructive orphan cleanup', async () => {
  const parent = fakeSession('session-unreadable-parent', { createdAt: 1 })
  const child = fakeSession('session-unreadable-child', {
    origin: 'subagent', parentSession: parent.id, createdAt: 10,
  })
  await materialize(child.id)
  const w = newWorld({ live: [child], stored: [child.header] })
  await appendJournalEvent(w.paths.journal, {
    type: 'migration', ids: [parent.id, child.id], preexisting: [parent.id, child.id], at: 1,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: sessionDirOf(parent.id), cwd: '/tmp/project', at: 2,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: sessionDirOf(parent.id), cwd: '/tmp/project', at: 3,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
    dir: sessionDirOf(child.id), cwd: '/tmp/project', at: 4,
  })
  await appendJournalEvent(w.paths.journal, { type: 'migrationComplete', at: 5 })
  await writeRegistry(w.paths, { [child.id]: recordOf(child, { kind: 'subagent', parentSessionId: parent.id }) })
  await w.temp.load()
  w.live.delete(child.id)
  const mode = fs.statSync(w.paths.file).mode & 0o777
  try {
    fs.chmodSync(w.paths.file, 0o000)
    await w.temp.reap()
  } finally {
    fs.chmodSync(w.paths.file, mode)
  }
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
  assert.notEqual(w.temp.journal.entries[child.id]?.deleted, true)
  await w.temp.reap()
  assert.equal(w.temp.registryDegraded, false)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), false)
  assert.equal(w.temp.journal.entries[child.id]?.deleted, true)
})

test('an unreadable registry at boot defers orphan reconciliation', async () => {
  const parent = fakeSession('session-unreadable-boot-parent', { createdAt: 1 })
  const child = fakeSession('session-unreadable-boot-child', {
    origin: 'subagent', parentSession: parent.id, createdAt: 10,
  })
  await materialize(child.id)
  const w = newWorld({ stored: [child.header] })
  await appendJournalEvent(w.paths.journal, {
    type: 'migration', ids: [parent.id, child.id], preexisting: [parent.id, child.id], at: 1,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: sessionDirOf(parent.id), cwd: '/tmp/project', at: 2,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: sessionDirOf(parent.id), cwd: '/tmp/project', at: 3,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
    dir: sessionDirOf(child.id), cwd: '/tmp/project', at: 4,
  })
  await appendJournalEvent(w.paths.journal, { type: 'migrationComplete', at: 5 })
  await writeRegistry(w.paths, { [child.id]: recordOf(child, { kind: 'subagent', parentSessionId: parent.id }) })
  const mode = fs.statSync(w.paths.file).mode & 0o777
  try {
    fs.chmodSync(w.paths.file, 0o000)
    await w.temp.load()
  } finally {
    fs.chmodSync(w.paths.file, mode)
  }
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
  assert.notEqual(w.temp.journal.entries[child.id]?.deleted, true)
  await w.temp.reap()
  assert.equal(w.temp.registryDegraded, false)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), false)
  assert.equal(w.temp.journal.entries[child.id]?.deleted, true)
  assert.equal(w.temp.migrationIncomplete, false)
  w.temp.assertWritable('register')
})

test('an unreadable registry at boot completes an interrupted migration on retry', async () => {
  const chat = fakeSession('session-unreadable-migration', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ live: [chat], stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }], { complete: false })
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
  const mode = fs.statSync(w.paths.file).mode & 0o777
  try {
    fs.chmodSync(w.paths.file, 0o000)
    await w.temp.load()
  } finally {
    fs.chmodSync(w.paths.file, mode)
  }
  assert.equal(w.temp.migrationIncomplete, true)
  await w.temp.reap()
  assert.equal(w.temp.migrationIncomplete, false)
  assert.equal(w.temp.registryDegraded, false)
  assert.equal(Object.keys(w.temp.state.sessions).includes(chat.id), true)
  w.temp.assertWritable('register')
})

test('an incomplete migration cannot clean up before it completes', async () => {
  const scenario = async (label, matching) => {
    const previous = root
    root = await mkdtemp(join(tmpdir(), 'dsh-temp-healing-'))
    try {
      const chat = fakeSession(`session-incomplete-${label}`, { createdAt: 10 })
      await materialize(chat.id)
      const w = newWorld({ stored: [chat.header] })
      const missing = `session-missing-${label}`
      await appendJournalEvent(w.paths.journal, {
        type: 'migration', ids: [missing], preexisting: [chat.id], at: 1,
      })
      await appendJournalEvent(w.paths.journal, {
        type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null,
        dir: sessionDirOf(chat.id), cwd: chat.header.cwd, at: 2,
      })
      if (matching) {
        await appendJournalEvent(w.paths.journal, {
          type: 'pending', sessionIds: [chat.id], reason: 'discard', at: 3,
        })
      }
      await writeRegistry(w.paths, { [chat.id]: recordOf(chat, { pendingDelete: true }) })
      const original = await readFile(w.paths.file, 'utf8')
      const artifact = join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')
      await mkdir(w.paths.preserved, { recursive: true })
      for (let index = 0; index < 16; index += 1) {
        await writeFile(join(w.paths.preserved, `prior-${index}.json`), 'prior evidence')
      }
      const mode = fs.statSync(w.paths.file).mode & 0o777
      try {
        fs.chmodSync(w.paths.file, 0o000)
        await w.temp.load()
      } finally {
        fs.chmodSync(w.paths.file, mode)
      }
      assert.equal(w.temp.migrationIncomplete, true, label)
      assert.equal(w.temp.startupStagesPending, true, label)
      for (const pass of [1, 2]) {
        await w.temp.reap()
        assert.equal(w.temp.migrationIncomplete, true, `${label} pass ${pass}`)
        assert.equal(w.temp.settlementPending, true, `${label} pass ${pass}`)
        assert.equal(await readFile(w.paths.file, 'utf8'), original, `${label} pass ${pass}`)
        assert.equal(fs.existsSync(artifact), true, `${label} pass ${pass}`)
        assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true, `${label} pass ${pass}`)
      }
      // Release one real preserved-evidence slot so the interrupted migration
      // can record its missing source and finish on the next readable pass.
      await rm(join(w.paths.preserved, fs.readdirSync(w.paths.preserved)[0]))
      await w.temp.reap()
      assert.equal(w.temp.migrationIncomplete, false, label)
      if (matching) {
        assert.equal(w.temp.registryDisputed.has(chat.id), false, label)
        assert.equal(w.temp.registryDegraded, false, label)
        assert.equal(fs.existsSync(artifact), false, label)
        assert.equal(w.temp.journal.entries[chat.id]?.deleted, true, label)
      } else {
        assert.equal(w.temp.registryDisputed.has(chat.id), true, label)
        assert.equal(w.temp.registryDegraded, true, label)
        assert.equal(await readFile(w.paths.file, 'utf8'), original, label)
        assert.equal(fs.existsSync(artifact), true, label)
        assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true, label)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      root = previous
    }
  }
  await scenario('conflict', false)
  await scenario('matching', true)
})

test('a journal-deleted stale row heals after unload cleanup', async () => {
  const chat = fakeSession('session-unload-stale', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ live: [chat], stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
  await w.temp.load()
  await w.temp.discard({ sessionId: chat.id })
  await w.temp.cleanupPending()
  const artifact = join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')
  assert.equal(fs.existsSync(artifact), false)
  assert.equal(w.temp.journal.entries[chat.id]?.deleted, true)
  const stale = JSON.parse(await readFile(w.paths.file, 'utf8'))
  assert.equal(stale.sessions[chat.id]?.sessionId, chat.id)
  w.stored.length = 0
  w.live.clear()
  const next = new TemporarySessions(w.deps)
  await next.load()
  await next.reap()
  assert.equal(next.registryDegraded, false)
  assert.equal(next.registryDisputed.size, 0)
  next.assertWritable('register')
  const saved = JSON.parse(await readFile(w.paths.file, 'utf8'))
  assert.equal(Object.keys(saved.sessions).includes(chat.id), false)
  assert.equal(fs.existsSync(artifact), false)
  assert.equal(next.exitSnapshot().sessions.some(record => record.sessionId === chat.id), false)
})

test('a readable full-budget conflict cannot enter the exit snapshot', async () => {
  const chat = fakeSession('session-full-budget-conflict', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await appendJournalEvent(w.paths.journal, {
    type: 'migration', ids: ['session-full-budget-missing'], preexisting: [chat.id], at: 1,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null,
    dir: sessionDirOf(chat.id), cwd: chat.header.cwd, at: 2,
  })
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat, { pendingDelete: true }) })
  const original = await readFile(w.paths.file, 'utf8')
  const artifact = join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')
  await mkdir(w.paths.preserved, { recursive: true })
  for (let index = 0; index < 16; index += 1) {
    await writeFile(join(w.paths.preserved, `prior-${index}.json`), 'prior evidence')
  }
  await w.temp.load()
  assert.equal(w.temp.migrationIncomplete, true)
  assert.equal(w.temp.startupStagesPending, true)
  assert.equal(w.temp.settlementPending, false)
  assert.equal(w.temp.listingUncertain, false)
  assert.equal(w.temp.exitSnapshot().degraded, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.equal(fs.existsSync(artifact), true)
  assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
})

test('a readable incomplete migration keeps the exit snapshot empty and retries', async () => {
  const chat = fakeSession('session-readable-incomplete', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await appendJournalEvent(w.paths.journal, {
    type: 'migration', ids: ['session-readable-missing'], preexisting: [chat.id], at: 1,
  })
  await appendJournalEvent(w.paths.journal, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null,
    dir: sessionDirOf(chat.id), cwd: chat.header.cwd, at: 2,
  })
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat, { pendingDelete: true }) })
  const original = await readFile(w.paths.file, 'utf8')
  const artifact = join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')
  await mkdir(w.paths.preserved, { recursive: true })
  for (let index = 0; index < 16; index += 1) {
    await writeFile(join(w.paths.preserved, `prior-${index}.json`), 'prior evidence')
  }
  let listingFails = true
  w.deps.sessionPersistence.list = async () => {
    if (listingFails) throw new Error('boot listing unavailable')
    return [{ header: chat.header }]
  }
  await w.temp.load()
  assert.equal(w.temp.migrationIncomplete, true)
  assert.equal(w.temp.startupStagesPending, true)
  assert.equal(w.temp.exitSnapshot().degraded, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  await w.temp.reap()
  assert.equal(w.temp.migrationIncomplete, true)
  assert.equal(w.temp.exitSnapshot().degraded, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.equal(fs.existsSync(artifact), true)
  assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
  listingFails = false
  await w.temp.reap()
  assert.equal(w.temp.migrationIncomplete, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(artifact), true)
  await rm(join(w.paths.preserved, fs.readdirSync(w.paths.preserved)[0]))
  await w.temp.reap()
  assert.equal(w.temp.migrationIncomplete, false)
  assert.equal(w.temp.registryDisputed.has(chat.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.equal(fs.existsSync(artifact), true)
  assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
})

test('an unreadable boot quarantines a readable complete pending conflict', async () => {  const chat = fakeSession('session-unreadable-boot-conflict', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat, { pendingDelete: false }) })
  const mode = fs.statSync(w.paths.file).mode & 0o777
  try {
    fs.chmodSync(w.paths.file, 0o000)
    await w.temp.load()
  } finally {
    fs.chmodSync(w.paths.file, mode)
  }
  const changed = JSON.stringify({
    version: 1,
    sessions: { [chat.id]: recordOf(chat, { pendingDelete: true }) },
  })
  await writeRawRegistry(w.paths, changed)
  await w.temp.reap()
  assert.equal(w.temp.registryDisputed.has(chat.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.equal(w.temp.migrationIncomplete, false)
  assert.equal(await readFile(w.paths.file, 'utf8'), changed)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  assert.notEqual(w.temp.journal.entries[chat.id]?.deleted, true)
})

test('a queued observation survives an unreadable boot', async () => {
  const parent = fakeSession('session-unreadable-queue-parent', { createdAt: 1 })
  const child = fakeSession('session-unreadable-queue-child', {
    origin: 'subagent', parentSession: parent.id, createdAt: 10,
  })
  await materialize(child.id)
  const w = newWorld({ live: [child], stored: [parent.header, child.header] })
  await seedOwnedSessions(w.paths, [{ session: parent }], { preexisting: [parent.id] })
  await writeRegistry(w.paths, { [parent.id]: recordOf(parent) })
  const mode = fs.statSync(w.paths.file).mode & 0o777
  try {
    fs.chmodSync(w.paths.file, 0o000)
    await w.temp.load()
  } finally {
    fs.chmodSync(w.paths.file, mode)
  }
  await w.temp.recordDescendant(child)
  assert.equal(w.temp.journal.entries[child.id]?.kind, 'subagent')
  await w.temp.reap()
  assert.equal(w.temp.registryDegraded, false)
  assert.equal(w.temp.state.sessions[child.id]?.kind, 'subagent')
})

test('every complete non-1 version is refused untouched', async () => {
  const chat = fakeSession('session-version-control-chat', { createdAt: 10 })
  const live = fakeSession('session-version-control-live', { createdAt: 20 })
  const dir = await materialize(chat.id)
  const w = newWorld({ live: [live], stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const base = JSON.stringify({ version: 1, sessions: { [chat.id]: recordOf(chat) } })
  for (const raw of ['"2"', 'null', '{"nested":2}', '2']) {
    const original = base.replace('"version":1', `"version":${raw}`)
    await writeRawRegistry(w.paths, original)
    const temp = new TemporarySessions(w.deps)
    await temp.load()
    assert.equal(temp.registryUnsupported, true, raw)
    assert.equal(temp.registryDegraded, true, raw)
    assert.deepEqual(temp.state.sessions, {}, raw)
    assert.equal(await readFile(w.paths.file, 'utf8'), original, raw)
    assert.equal((await temp.list()).degraded, true, raw)
    assert.deepEqual(temp.exitSnapshot().sessions, [], raw)
    assert.equal(cleanupSnapshotSync(temp.exitSnapshot()), 0, raw)
    assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true, raw)
    await assert.rejects(temp.register({ sessionId: live.id }), /registry is damaged/)
    await temp.reap()
    assert.equal(await readFile(w.paths.file, 'utf8'), original, raw)
    const restarted = new TemporarySessions(w.deps)
    await restarted.load()
    assert.equal(restarted.registryUnsupported, true, raw)
    assert.deepEqual(restarted.state.sessions, {}, raw)
    assert.equal(await readFile(w.paths.file, 'utf8'), original, raw)
    assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true, raw)
  }
})

test('the header cross-checks every field', async () => {
  const good = fakeSession('session-header-good', { createdAt: 10 })
  const badDir = fakeSession('session-header-dir', { createdAt: 20 })
  const badParent = fakeSession('session-header-parent', { createdAt: 30 })
  const badKind = fakeSession('session-header-kind', { createdAt: 40 })
  const other = fakeSession('session-header-other', { createdAt: 50 })
  for (const session of [good, badDir, badParent, badKind, other]) await materialize(session.id)
  const w = newWorld({ stored: [good.header, badDir.header, badParent.header, badKind.header, other.header] })
  await writeRawRegistry(w.paths, rawSessionsText({
    [good.id]: recordOf(good),
    [badDir.id]: recordOf(badDir, { dir: sessionDirOf(other.id) }),
    [badParent.id]: recordOf(badParent, { parentSessionId: other.id }),
    [badKind.id]: recordOf(badKind, { kind: 'side' }),
  }))
  await w.temp.load()
  assert.deepEqual(Object.keys(w.temp.state.sessions), [good.id])
  assert.deepEqual(Object.keys(JSON.parse(await readFile(w.paths.file, 'utf8')).sessions), [good.id])
  for (const session of [badDir, badParent, badKind]) {
    assert.equal(w.temp.state.sessions[session.id], undefined)
    assert.equal(fs.existsSync(join(sessionDirOf(session.id), 'session.v4.jsonl.zstd')), true)
  }
  assert.ok(w.warnings.some(message => message.includes('dir-mismatch')))
  assert.ok(w.warnings.some(message => message.includes('parent-mismatch')))
  assert.ok(w.warnings.some(message => message.includes('kind-mismatch')))
})

test('the side kind survives recovery', async () => {
  const source = fakeSession('session-side-recovery-source', { createdAt: 10 })
  const good = fakeSession('session-side-recovery-good', {
    isSeeded: true, parentSession: source.id, createdAt: 20,
  })
  const bad = fakeSession('session-side-recovery-bad', {
    isSeeded: true, parentSession: source.id, createdAt: 30,
  })
  for (const session of [source, good, bad]) await materialize(session.id)
  const w = newWorld({ stored: [source.header, good.header, bad.header] })
  await seedOwnedSessions(w.paths, [
    { session: good, kind: 'side', parent: source },
    { session: bad, kind: 'fork', parent: source },
  ], { pendingIds: [good.id] })
  await writeRawRegistry(w.paths, rawSessionsText({
    [good.id]: recordOf(good, { kind: 'side', title: 'Recovered side title', pendingDelete: true }),
    [bad.id]: recordOf(bad, { kind: 'side', title: 'Ambiguous side title' }),
  }))
  await w.temp.load()
  assert.equal(w.temp.state.sessions[good.id].kind, 'side')
  assert.equal(w.temp.state.sessions[good.id].title, 'Recovered side title')
  assert.equal(w.temp.state.sessions[good.id].pendingDelete, true)
  assert.equal(w.temp.state.sessions[bad.id], undefined)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(
    w.temp.exitSnapshot().sessions.map(record => record.sessionId),
    [good.id],
  )
  assert.equal(fs.existsSync(join(sessionDirOf(bad.id), 'session.v4.jsonl.zstd')), true)
  assert.ok(w.warnings.some(message => message.includes('journal-record-mismatch')))
  assert.match(await readFile(w.temp.paths.unresolved, 'utf8'), /journal-record-mismatch/)
  assert.ok(fs.readdirSync(w.temp.paths.preserved).length > 0)
})

test('a collapsed parent is migrated', async () => {
  const grand = fakeSession('session-collapsed-grand', { createdAt: 1 })
  const parent = fakeSession('session-collapsed-parent', {
    origin: 'subagent', parentSession: grand.id, createdAt: 2,
  })
  const child = fakeSession('session-collapsed-child', {
    origin: 'subagent', parentSession: parent.id, createdAt: 3,
  })
  await materialize(child.id)
  const w = newWorld({ stored: [grand.header, parent.header, child.header] })
  await writeRegistry(w.paths, { [child.id]: recordOf(child, { kind: 'subagent', parentSessionId: grand.id }) })
  await w.temp.load()
  const owned = (await journalLines(w.paths)).find(event => event.type === 'owned' && event.sessionId === child.id)
  assert.equal(owned.parentSessionId, parent.id)
  assert.equal(w.temp.state.sessions[child.id].parentSessionId, parent.id)
  assert.equal(JSON.parse(await readFile(w.paths.file, 'utf8')).sessions[child.id].parentSessionId, parent.id)
})

test('an invalid createdAt is replaced', async () => {
  const chat = fakeSession('session-invalid-created', { createdAt: 1234 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat, { createdAt: -99 }) })
  await w.temp.load()
  assert.equal(w.temp.state.sessions[chat.id].createdAt, 1234)
  assert.equal(JSON.parse(await readFile(w.paths.file, 'utf8')).sessions[chat.id].createdAt, 1234)
})

test('a missing pending flag defaults safe', async () => {
  const chat = fakeSession('session-missing-pending', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const row = recordOf(chat)
  delete row.pendingDelete
  await writeRegistry(w.paths, { [chat.id]: row })
  await w.temp.load()
  assert.equal(w.temp.state.sessions[chat.id].pendingDelete, false)
  const log = await readFile(w.temp.paths.recoveryLog, 'utf8')
  assert.match(log, /pending-absent/)
  assert.equal(modeOf(w.temp.paths.recoveryLog), 0o600)
})

test('the journal rebuilds a corrupt registry', async () => {
  const parent = fakeSession('session-rebuild-parent', { createdAt: 1 })
  const child = fakeSession('session-rebuild-child', {
    origin: 'subagent', parentSession: parent.id, createdAt: 2,
  })
  const stranger = fakeSession('session-rebuild-stranger', { createdAt: 3 })
  for (const session of [parent, child, stranger]) await materialize(session.id)
  const w = newWorld({ live: [parent, child], stored: [parent.header, child.header, stranger.header] })
  await seedOwnedSessions(w.paths, [
    { session: parent },
    { session: child, kind: 'subagent', parent },
  ], { pendingIds: [parent.id, child.id] })
  await writeRawRegistry(w.paths, '{"version":1,"sessions":{')
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, false)
  assert.deepEqual(Object.keys(w.temp.state.sessions).sort(), [parent.id, child.id].sort())
  assert.equal(w.temp.state.sessions[parent.id].pendingDelete, true)
  assert.equal(w.temp.state.sessions[child.id].pendingDelete, true)
  assert.deepEqual(
    w.temp.exitSnapshot().sessions.map(record => record.sessionId).sort(),
    [parent.id, child.id].sort(),
  )
  assert.equal(w.temp.state.sessions[parent.id].pendingDelete, true)
  assert.equal(w.temp.state.sessions[child.id].pendingDelete, true)
  const published = JSON.parse(await readFile(w.paths.file, 'utf8'))
  assert.deepEqual(Object.keys(published.sessions).sort(), [parent.id, child.id].sort())

  // A registry row that no journal entry owns is quarantined, not listed.
  await writeRegistry(w.paths, { [stranger.id]: recordOf(stranger) })
  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  assert.equal(restarted.state.sessions[stranger.id], undefined)
  assert.equal(fs.existsSync(join(sessionDirOf(stranger.id), 'session.v4.jsonl.zstd')), true)
  assert.match(await readFile(restarted.paths.unresolved, 'utf8'), /no-journal-entry/)
})

test('the accepted single-source rewrite is documented', async () => {
  // This is the accepted irreducible case from the spec: a journal-only owned
  // id for a real permanent Session is adopted from the journal and header.
  // A registry row that disagrees with the journal/header is quarantined.
  const chat = fakeSession('session-single-source-chat', { createdAt: 10 })
  const decoy = fakeSession('session-single-source-decoy', { createdAt: 20 })
  for (const session of [chat, decoy]) await materialize(session.id)
  const decoyDir = join(root, 'sessions', 'project', `${decoy.id}-decoy`)
  await mkdir(decoyDir, { recursive: true })
  await writeFile(join(decoyDir, 'session.v4.jsonl.zstd'), 'decoy')
  const w = newWorld({ stored: [chat.header, decoy.header] })
  await seedOwnedSessions(w.paths, [
    { session: chat },
    { session: decoy },
  ])
  await writeRegistry(w.paths, { [decoy.id]: recordOf(decoy, { dir: decoyDir }) })
  await w.temp.load()
  // A journal-only owned id with no registry row is the accepted rewrite and is
  // rebuilt from the journal and header.
  assert.equal(w.temp.state.sessions[chat.id].sessionId, chat.id)
  // A row that disagrees with that proof is quarantined even when the journal
  // owns the id; it must not turn into a journal-only deletion target.
  assert.equal(w.temp.state.sessions[decoy.id], undefined)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(
    w.temp.exitSnapshot().sessions.map(record => record.sessionId),
    [chat.id],
  )
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 1)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), false)
  assert.equal(fs.existsSync(join(sessionDirOf(decoy.id), 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(join(decoyDir, 'session.v4.jsonl.zstd')), true)
  const audit = await readFile(w.temp.paths.recoveryLog, 'utf8')
  assert.match(audit, /"event":"adopted"/)
  assert.match(audit, new RegExp(chat.id))
  assert.match(audit, /"reason":"journal-only"/)
  assert.match(await readFile(w.temp.paths.unresolved, 'utf8'), /dir-mismatch/)
  const still = JSON.parse(await readFile(w.paths.file, 'utf8'))
  assert.equal(still.sessions[decoy.id].dir, decoyDir)
  assert.ok(fs.readdirSync(w.temp.paths.preserved).length > 0)
})

test('a disputed boot keeps a queued child and its parent', async () => {
  const parent = fakeSession('session-disputed-boot-parent', { createdAt: 1 })
  const bad = fakeSession('session-disputed-boot-bad', { createdAt: 2 })
  const child = fakeSession('session-disputed-boot-child', {
    isSeeded: true, parentSession: parent.id, createdAt: 200,
  })
  for (const session of [parent, bad, child]) await materialize(session.id)
  const w = newWorld({
    live: [child],
    stored: [parent.header, bad.header],
  })
  await seedOwnedSessions(w.paths, [
    { session: parent },
    { session: bad },
  ], { preexisting: [parent.id, bad.id] })
  await writeRegistry(w.paths, {
    [parent.id]: recordOf(parent),
    [bad.id]: recordOf(bad, { dir: join(root, 'wrong', bad.id) }),
  })
  // The announcement arrived while load was taking its listing, after the
  // parent became journal-owned. The disputed row blocks adoption, so the
  // observation must survive for the next boot and its parent must survive exit.
  w.temp.pending.push(child)
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.size, 1)
  assert.deepEqual(Object.keys(w.temp.state.sessions), [parent.id])
  assert.equal(w.temp.pending.length, 1)
  assert.equal(w.temp.journal.entries[child.id], undefined)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(sessionDirOf(parent.id), 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
})

test('a dispute keeps its parent out of exit cleanup', async () => {
  const parent = fakeSession('session-disputed-parent-keep', { createdAt: 1 })
  const child = fakeSession('session-disputed-parent-child', {
    origin: 'subagent', parentSession: parent.id, createdAt: 2,
  })
  for (const session of [parent, child]) await materialize(session.id)
  const w = newWorld({ stored: [parent.header, child.header] })
  await seedOwnedSessions(w.paths, [
    { session: parent },
    { session: child, kind: 'subagent', parent },
  ], { preexisting: [parent.id, child.id] })
  await writeRegistry(w.paths, {
    [parent.id]: recordOf(parent),
    [child.id]: recordOf(child, {
      kind: 'subagent',
      parentSessionId: parent.id,
      dir: join(root, 'wrong', child.id),
    }),
  })
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(child.id), true)
  assert.deepEqual(Object.keys(w.temp.state.sessions), [parent.id])
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(sessionDirOf(parent.id), 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
})

test('a journal-record dispute degrades even without parse damage', async () => {
  const chat = fakeSession('session-disputed-pending-flag', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat, { pendingDelete: true }) })
  const before = await readFile(w.paths.file, 'utf8')
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(chat.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(w.temp.state.sessions, {})
  assert.equal(await readFile(w.paths.file, 'utf8'), before)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
})

test('a disputed orphan under a deleted parent is kept', async () => {
  const parent = fakeSession('session-disputed-orphan-parent', { createdAt: 1 })
  const child = fakeSession('session-disputed-orphan-child', {
    origin: 'subagent', parentSession: parent.id, createdAt: 2,
  })
  await materialize(child.id)
  const w = newWorld({ stored: [child.header] })
  await seedOwnedSessions(w.paths, [
    { session: parent },
    { session: child, kind: 'subagent', parent },
  ], { preexisting: [parent.id, child.id] })
  await appendJournalEvent(w.paths.journal, {
    type: 'deleted',
    sessionId: parent.id,
    kind: 'main',
    parentSessionId: null,
    dir: sessionDirOf(parent.id),
    cwd: '/tmp/project',
    at: 3,
  })
  await writeRegistry(w.paths, {
    [child.id]: recordOf(child, {
      kind: 'subagent',
      parentSessionId: parent.id,
      dir: join(root, 'wrong', child.id),
    }),
  })
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(child.id), true)
  assert.notEqual(w.temp.journal.entries[child.id]?.deleted, true)
  assert.equal(w.temp.state.sessions[child.id], undefined)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
})

test('ambiguous framing keeps the original and deletes nothing', async () => {
  const chat = fakeSession('session-ambiguous-chat', { createdAt: 10 })
  const permanent = fakeSession('session-ambiguous-control', { createdAt: 20 })
  for (const session of [chat, permanent]) await materialize(session.id)
  const w = newWorld({ stored: [chat.header, permanent.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const wrongDir = join(root, 'wrong', chat.id)
  await writeRawRegistry(w.paths, `{"version":1,"sessions":{${JSON.stringify(chat.id)}:${JSON.stringify(recordOf(chat, { dir: wrongDir }))}},"sessions":{${JSON.stringify(permanent.id)}:${JSON.stringify(recordOf(permanent))}}}`)
  const before = await readFile(w.paths.file, 'utf8')
  await w.temp.load()
  assert.equal(w.temp.registryAmbiguous, true)
  assert.equal(w.temp.registryUnsupported, false)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(w.temp.state.sessions, {})
  assert.equal(await readFile(w.paths.file, 'utf8'), before)
  assert.equal(w.temp.exitSnapshot().degraded, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(join(sessionDirOf(permanent.id), 'session.v4.jsonl.zstd')), true)
})

test('a conflicting workspace is quarantined', async () => {
  const chat = fakeSession('session-workspace-chat', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat, { cwd: '/tmp/wrong' }) })
  const before = await readFile(w.paths.file, 'utf8')
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(chat.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(w.temp.state.sessions, {})
  assert.equal(await readFile(w.paths.file, 'utf8'), before)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  assert.match(await readFile(w.temp.paths.unresolved, 'utf8'), /cwd-mismatch/)
})

test('an explicit null parent is quarantined', async () => {
  const source = fakeSession('session-null-parent-source', { createdAt: 1 })
  const control = fakeSession('session-null-parent-control', { createdAt: 2 })
  const child = fakeSession('session-null-parent-child', {
    isSeeded: true, parentSession: source.id, createdAt: 3,
  })
  for (const session of [source, control, child]) await materialize(session.id)
  const w = newWorld({ stored: [source.header, control.header, child.header] })
  await seedOwnedSessions(w.paths, [{ session: child, kind: 'fork', parent: source }], {
    at: 100,
    preexisting: [source.id],
  })
  await writeRegistry(w.paths, {
    [child.id]: recordOf(child, {
      kind: 'fork',
      parentSessionId: null,
    }),
  })
  const before = await readFile(w.paths.file, 'utf8')
  await w.temp.load()
  assert.equal(w.temp.registryDisputed.has(child.id), true)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(w.temp.state.sessions, {})
  assert.equal(await readFile(w.paths.file, 'utf8'), before)
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  for (const session of [source, control, child]) {
    assert.equal(fs.existsSync(join(sessionDirOf(session.id), 'session.v4.jsonl.zstd')), true)
  }
  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  assert.equal(restarted.registryDisputed.has(child.id), true)
  assert.deepEqual(restarted.state.sessions, {})
  assert.equal(await readFile(w.paths.file, 'utf8'), before)
  for (const session of [source, control, child]) {
    assert.equal(fs.existsSync(join(sessionDirOf(session.id), 'session.v4.jsonl.zstd')), true)
  }
})

test('a damaged marker keeps a torn journal byte-identical', async () => {
  const chat = fakeSession('session-torn-damaged-marker', { createdAt: 10 })
  const dir = await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeFile(w.paths.marker, 'not-json')
  const journal = await readFile(w.paths.journal, 'utf8')
  await writeFile(w.paths.journal, `${journal}{"type":"owned"`)
  const before = await readFile(w.paths.journal, 'utf8')
  await w.temp.load()
  assert.equal(w.temp.journalDegraded, true)
  assert.equal(w.temp.journal.torn, true)
  assert.equal(await readFile(w.paths.journal, 'utf8'), before)
  assert.equal(w.temp.exitSnapshot().degraded, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('the migration resumes and completes', async () => {
  const first = fakeSession('session-resume-first', { createdAt: 10 })
  const second = fakeSession('session-resume-second', { createdAt: 20 })
  const third = fakeSession('session-resume-third', { createdAt: 30 })
  for (const session of [first, second, third]) await materialize(session.id)
  const w = newWorld({ stored: [first.header, second.header, third.header] })
  const firstRecord = JSON.stringify(recordOf(first))
  const secondRecord = JSON.stringify(recordOf(second))
  await writeRawRegistry(w.paths, `{"version":1,"sessions":{${JSON.stringify(first.id)}:${firstRecord},${JSON.stringify(second.id)}:${secondRecord},${JSON.stringify(third.id)}:{"sessionId":`)
  await w.temp.load()
  const lines = await journalLines(w.paths)
  const migration = lines.find(event => event.type === 'migration')
  assert.deepEqual(migration.ids.sort(), [first.id, second.id, third.id].sort())
  assert.deepEqual(migration.preexisting.sort(), [first.id, second.id, third.id].sort())
  assert.equal(lines.filter(event => event.type === 'migrationComplete').length, 1)
  assert.deepEqual(
    lines.filter(event => event.type === 'owned').map(event => event.sessionId).sort(),
    [first.id, second.id].sort(),
  )
  assert.deepEqual(Object.keys(w.temp.state.sessions).sort(), [first.id, second.id].sort())
  assert.equal(w.temp.migrationIncomplete, false)
  assert.ok(fs.existsSync(w.paths.marker))
  const backlog = (await readFile(w.paths.unresolved, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(backlog.some(entry => Number.isSafeInteger(entry.offset)))
  assert.ok(backlog.some(entry => entry.bytes !== ''))
  assert.ok(fs.readdirSync(w.paths.preserved).length > 0)

  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  const after = await journalLines(w.paths)
  assert.equal(after.filter(event => event.type === 'migration').length, 1)
  assert.equal(after.filter(event => event.type === 'migrationComplete').length, 1)
  assert.deepEqual(Object.keys(restarted.state.sessions).sort(), [first.id, second.id].sort())
})

test('the migration imports and quarantines', async () => {
  const parent = fakeSession('session-cutoff-parent', { createdAt: 1 })
  const old = fakeSession('session-cutoff-old', {
    isSeeded: true, parentSession: parent.id, createdAt: 500,
  })
  const equal = fakeSession('session-cutoff-equal', {
    isSeeded: true, parentSession: parent.id, createdAt: 1000,
  })
  const later = fakeSession('session-cutoff-later', {
    isSeeded: true, parentSession: parent.id, createdAt: 1001,
  })
  const rollback = fakeSession('session-cutoff-rollback', {
    isSeeded: true, parentSession: parent.id, createdAt: 999,
  })
  for (const session of [parent, old, equal, later, rollback]) await materialize(session.id)
  const w = newWorld({
    live: [parent],
    stored: [parent.header, old.header, equal.header, later.header, rollback.header],
  })
  await seedOwnedSessions(w.paths, [{ session: parent }], {
    at: 1000,
    preexisting: [old.id, parent.id],
    complete: false,
  })
  w.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
  await w.temp.load()
  assert.equal(w.temp.migrationIncomplete, true)
  assert.equal(w.temp.journal.entries[old.id], undefined)
  assert.equal(w.temp.journal.entries[later.id], undefined)

  w.deps.sessionPersistence.list = async () => w.stored.map(header => ({ header }))
  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  assert.equal(restarted.migrationIncomplete, false)
  assert.equal(restarted.journal.entries[old.id], undefined)
  assert.equal(restarted.journal.entries[equal.id], undefined)
  assert.equal(restarted.journal.entries[rollback.id], undefined)
  assert.equal(restarted.journal.entries[later.id].parentSessionId, parent.id)
  const audit = await readFile(restarted.paths.recoveryLog, 'utf8')
  assert.match(audit, /"event":"cutoff"/)
  assert.match(audit, new RegExp(old.id))
  const cutoffCount = async () => (await readFile(restarted.paths.recoveryLog, 'utf8'))
    .split('\n')
    .filter(line => line.includes('"event":"cutoff"') && line.includes(old.id))
    .length
  const cutoffBefore = await cutoffCount()
  await restarted.reap()
  await restarted.reap()
  assert.equal(await cutoffCount(), cutoffBefore)
  assert.deepEqual(Object.keys(restarted.state.sessions).sort(), [parent.id, later.id].sort())
  for (const session of [old, equal, later, rollback]) {
    assert.equal(fs.existsSync(join(sessionDirOf(session.id), 'session.v4.jsonl.zstd')), true)
  }
})

test('an unsupported version is refused', async () => {
  const chat = fakeSession('session-unsupported-chat', { createdAt: 10 })
  const live = fakeSession('session-unsupported-live', { createdAt: 20 })
  const dir = await materialize(chat.id)
  const w = newWorld({ live: [live], stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
  const original = (await readFile(w.paths.file, 'utf8')).replace('"version": 1', '"version": 2')
  await writeRawRegistry(w.paths, original)
  let flushed = false
  w.deps.sessions.flush = async () => { flushed = true; return true }
  await w.temp.load()
  assert.equal(w.temp.registryUnsupported, true)
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(w.temp.state.sessions, {})
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.equal((await w.temp.list()).degraded, true)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  await assert.rejects(w.temp.register({ sessionId: live.id }), /registry is damaged/)
  assert.equal(flushed, false)

  // A normal reap and a later announcement must not turn journal and header
  // evidence into a deletion snapshot while the version is unsupported.
  const child = fakeSession('session-unsupported-child', {
    isSeeded: true, parentSession: chat.id, createdAt: 30,
  })
  const journalBefore = await readFile(w.paths.journal, 'utf8')
  await w.temp.recordDescendant(child)
  assert.equal(w.temp.state.sessions[child.id], undefined)
  await w.temp.reap()
  assert.deepEqual(w.temp.state.sessions, {})
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(w.temp.exitSnapshot()), 0)
  assert.equal(await readFile(w.paths.journal, 'utf8'), journalBefore)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true)

  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  await restarted.reap()
  assert.deepEqual(restarted.state.sessions, {})
  assert.deepEqual(restarted.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(restarted.exitSnapshot()), 0)
  assert.equal(await readFile(w.paths.file, 'utf8'), original)
  assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('degraded registration never flushes a transcript', async () => {
  const parent = fakeSession('session-degraded-register-parent', { createdAt: 1 })
  const live = fakeSession('session-degraded-register-live', { createdAt: 2 })
  const w = newWorld({ live: [live] })
  await seedOwnedSessions(w.paths, [{ session: parent }])
  await writeRawRegistry(w.paths, JSON.stringify({
    version: 1,
    sessions: { 'SYNTHETIC PRIVATE TITLE': { sessionId: 'different' } },
  }))
  await writeFile(w.paths.journal, `${await readFile(w.paths.journal, 'utf8')}not an event\n`)
  const before = await readFile(w.paths.journal, 'utf8')
  let flushed = false
  w.deps.sessions.flush = async () => { flushed = true; return true }
  await w.temp.load()
  assert.equal(w.temp.journalDegraded, true)
  await assert.rejects(w.temp.register({ sessionId: live.id }), /journal is degraded/)
  assert.equal(flushed, false)
  assert.equal(await readFile(w.paths.journal, 'utf8'), before)
  assert.equal(fs.existsSync(w.temp.paths.recoveryLog), false)
  assert.equal(fs.existsSync(w.temp.paths.preserved), false)
  assert.equal(fs.existsSync(w.temp.paths.unresolved), false)
  assert.deepEqual(w.temp.exitSnapshot().sessions, [])
})

test('registry degradation keeps journaling', async () => {
  const parent = fakeSession('session-degraded-kept-parent', { createdAt: 1 })
  const child = fakeSession('session-degraded-kept-child', {
    isSeeded: true, parentSession: parent.id, createdAt: 200,
  })
  for (const session of [parent, child]) await materialize(session.id)
  const w = newWorld({ live: [parent, child], stored: [parent.header] })
  await seedOwnedSessions(w.paths, [{ session: parent }], {
    at: 100,
    preexisting: [parent.id],
  })
  await writeRawRegistry(w.paths, '{damaged')
  await mkdir(w.paths.dir, { recursive: true })
  await writeFile(w.paths.lock, `${process.ppid}\n`)
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, true)
  assert.deepEqual(Object.keys(w.temp.state.sessions), [parent.id])
  await w.temp.recordDescendant(child)
  assert.equal(w.temp.journal.entries[child.id].parentSessionId, parent.id)
  assert.deepEqual(Object.keys(w.temp.state.sessions).sort(), [parent.id, child.id].sort())
  assert.equal(await readFile(w.paths.file, 'utf8'), '{damaged')
  assert.ok(fs.readdirSync(w.paths.preserved).length > 0)

  await rm(w.paths.lock, { force: true })
  await w.temp.reap()
  assert.equal(w.temp.registryDegraded, false)
  const recovered = JSON.parse(await readFile(w.paths.file, 'utf8'))
  assert.deepEqual(Object.keys(recovered.sessions).sort(), [parent.id, child.id].sort())
  assert.equal(fs.existsSync(join(sessionDirOf(parent.id), 'session.v4.jsonl.zstd')), true)
  assert.equal(fs.existsSync(join(sessionDirOf(child.id), 'session.v4.jsonl.zstd')), true)
})

test('the healing transaction survives a crash at every boundary', async () => {
  const paths = pathsOf()
  for (const stage of ['preserve', 'backlog', 'publish']) {
    await rm(paths.dir, { recursive: true, force: true })
    await rm(join(root, 'sessions'), { recursive: true, force: true })
    const chat = fakeSession(`session-crash-${stage}`, { createdAt: 10 })
    await materialize(chat.id)
    const w = newWorld({ stored: [chat.header] })
    await seedOwnedSessions(w.paths, [{ session: chat }])
    const original = `{"version":1,"sessions":{${JSON.stringify(chat.id)}:${JSON.stringify(recordOf(chat))}}`
    await writeRawRegistry(w.paths, original)
    if (stage === 'preserve') {
      const preserve = w.temp.recovery.preserve.bind(w.temp.recovery)
      w.temp.recovery.preserve = (...args) => {
        preserve(...args)
        throw new Error('injected crash after preserve')
      }
    } else if (stage === 'backlog') {
      const append = w.temp.recovery.appendUnresolved.bind(w.temp.recovery)
      w.temp.recovery.appendUnresolved = (...args) => {
        append(...args)
        throw new Error('injected crash after backlog')
      }
    } else {
      w.temp.publisher.publish = () => { throw new Error('injected crash before publish') }
    }
    await w.temp.load()
    assert.equal(w.temp.registryDegraded, true)
    assert.equal(await readFile(w.paths.file, 'utf8'), original)
    assert.deepEqual(Object.keys(w.temp.state.sessions), [chat.id])
    assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)

    const restarted = new TemporarySessions(w.deps)
    await restarted.load()
    assert.equal(restarted.registryDegraded, false)
    assert.deepEqual(Object.keys(restarted.state.sessions), [chat.id])
    const published = JSON.parse(await readFile(w.paths.file, 'utf8'))
    assert.deepEqual(Object.keys(published.sessions), [chat.id])
    assert.equal(fs.existsSync(join(sessionDirOf(chat.id), 'session.v4.jsonl.zstd')), true)
  }

  // A crash after the durable publish but before the preserved original is
  // retired leaves the recovered registry and only extra evidence.
  await rm(paths.dir, { recursive: true, force: true })
  await rm(join(root, 'sessions'), { recursive: true, force: true })
  const chat = fakeSession('session-crash-retire', { createdAt: 10 })
  await materialize(chat.id)
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, { [chat.id]: recordOf(chat) })
  await w.temp.load()
  w.temp.registryContext.damaged = true
  w.temp.registryDegraded = true
  w.temp.registryUnresolved = []
  w.temp.recovery.retire = () => { throw new Error('injected crash before retire') }
  assert.equal(w.temp.repairRegistry(w.temp.registryContext), true)
  assert.equal(JSON.parse(await readFile(w.paths.file, 'utf8')).sessions[chat.id].sessionId, chat.id)
  assert.ok(fs.readdirSync(w.paths.preserved).length > 0)
  const restarted = new TemporarySessions(w.deps)
  await restarted.load()
  assert.deepEqual(Object.keys(restarted.state.sessions), [chat.id])
})

test('partial recovery keeps the unresolved bytes', async () => {
  const good = fakeSession('session-partial-good', { createdAt: 10 })
  const permanent = fakeSession('session-partial-permanent', { createdAt: 20 })
  const observed = fakeSession('session-partial-observed', {
    isSeeded: true, parentSession: good.id, createdAt: 200,
  })
  for (const session of [good, permanent, observed]) await materialize(session.id)
  const w = newWorld({ live: [observed], stored: [good.header, permanent.header] })
  await seedOwnedSessions(w.paths, [{ session: good }], {
    at: 100,
    preexisting: [good.id, permanent.id],
  })
  const goodRecord = JSON.stringify(recordOf(good))
  await writeRawRegistry(w.paths, `{"version":1,"sessions":{${JSON.stringify(good.id)}:${goodRecord},${JSON.stringify(permanent.id)}:{"sessionId":`)
  w.temp.pending.push(observed)
  await w.temp.load()
  assert.equal(w.temp.registryDegraded, false)
  assert.deepEqual(Object.keys(w.temp.state.sessions).sort(), [good.id, observed.id].sort())
  assert.equal(w.temp.journal.entries[observed.id].parentSessionId, good.id)
  assert.equal(w.temp.state.sessions[permanent.id], undefined)
  const published = JSON.parse(await readFile(w.paths.file, 'utf8'))
  assert.deepEqual(Object.keys(published.sessions).sort(), [good.id, observed.id].sort())
  const backlog = await readFile(w.paths.unresolved, 'utf8')
  assert.ok(backlog.includes('truncated-member'))
  assert.ok(fs.readdirSync(w.paths.preserved).length > 0)
  assert.equal(fs.existsSync(join(sessionDirOf(permanent.id), 'session.v4.jsonl.zstd')), true)
})

test('the backlog is private and bounded', async () => {
  const paths = pathsOf()
  const chat = fakeSession('session-backlog-chat', { createdAt: 10 })
  await materialize(chat.id)
  await mkdir(paths.dir, { recursive: true })
  const existing = 'existing-evidence'
  await writeFile(paths.unresolved, existing, { mode: 0o600 })
  const w = newWorld({ stored: [chat.header] })
  w.temp.recovery.maxBacklogBytes = existing.length + 1
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRawRegistry(w.paths, `{"version":1,"sessions":{${JSON.stringify(chat.id)}:${JSON.stringify(recordOf(chat))}}`)
  await w.temp.load()
  assert.equal(await readFile(w.paths.unresolved, 'utf8'), existing)
  assert.equal(modeOf(w.paths.unresolved), 0o600)
  const preserved = fs.readdirSync(w.paths.preserved)
  assert.ok(preserved.length > 0)
  assert.equal(modeOf(join(w.paths.preserved, preserved[0])), 0o600)
  assert.equal(w.temp.registryDegraded, false)

  // The preserved-original cap refuses a new copy and leaves the damaged
  // registry in place instead of replacing evidence.
  await rm(w.paths.dir, { recursive: true, force: true })
  await rm(join(root, 'sessions'), { recursive: true, force: true })
  const capped = fakeSession('session-preserved-cap', { createdAt: 10 })
  await materialize(capped.id)
  const second = newWorld({ stored: [capped.header] })
  await seedOwnedSessions(second.paths, [{ session: capped }])
  await mkdir(second.paths.preserved, { recursive: true })
  await writeFile(join(second.paths.preserved, 'existing.json'), 'evidence', { mode: 0o600 })
  second.temp.recovery.maxPreservedFiles = 1
  const damaged = `{"version":1,"sessions":{${JSON.stringify(capped.id)}:${JSON.stringify(recordOf(capped))}}`
  await writeRawRegistry(second.paths, damaged)
  await second.temp.load()
  assert.equal(second.temp.registryDegraded, true)
  assert.equal(await readFile(second.paths.file, 'utf8'), damaged)
  assert.equal(fs.readdirSync(second.paths.preserved).length, 1)
  assert.equal(modeOf(join(second.paths.preserved, 'existing.json')), 0o600)
})

test('the recovery log keeps private data out', async () => {
  const chat = fakeSession('session-log-chat', { createdAt: 10 })
  const leaky = fakeSession('session-log-leaky', { createdAt: 20 })
  for (const session of [chat, leaky]) await materialize(session.id)
  const w = newWorld({ stored: [chat.header, leaky.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  await writeRegistry(w.paths, {
    [chat.id]: recordOf(chat, { title: 'SENSITIVE TITLE', cwd: '/tmp/SENSITIVE PATH' }),
    [leaky.id]: recordOf(leaky, { title: 'SENSITIVE TITLE', dir: '/tmp/SENSITIVE PATH' }),
    'SENSITIVE MEMBER KEY': { sessionId: 'different' },
  })
  await w.temp.load()
  const logPath = w.paths.recoveryLog
  assert.equal(modeOf(logPath), 0o600)
  let log = await readFile(logPath, 'utf8')
  assert.match(log, /quarantined/)
  assert.doesNotMatch(log, /SENSITIVE TITLE/)
  assert.doesNotMatch(log, /SENSITIVE PATH/)
  assert.doesNotMatch(log, /SENSITIVE MEMBER KEY/)
  assert.doesNotMatch(w.warnings.join('\n'), /SENSITIVE MEMBER KEY/)
  const backlogBefore = await readFile(w.paths.unresolved, 'utf8')
  w.temp.recovery.logBytes = 140
  w.temp.recovery.log('decision', {
    title: 'SENSITIVE TITLE',
    path: '/tmp/SENSITIVE PATH',
    model: 'SENSITIVE MODEL ECHO',
  })
  for (let index = 0; index < 40; index += 1) w.temp.recovery.log('published', { count: index })
  const names = (await readdir(w.paths.dir)).filter(name => name === 'recovery.log' || name.startsWith('recovery.log.'))
  assert.ok(names.length <= 1 + w.temp.recovery.logBackups)
  log = await readFile(logPath, 'utf8')
  assert.doesNotMatch(log, /SENSITIVE/)
  assert.equal(await readFile(w.paths.unresolved, 'utf8'), backlogBefore)
})

test('exit during degradation deletes nothing', async () => {
  const chat = fakeSession('session-exit-degraded', { createdAt: 10 })
  const w = newWorld({ stored: [chat.header] })
  await seedOwnedSessions(w.paths, [{ session: chat }])
  const dir = await materialize(chat.id)
  await writeFile(w.paths.journal, `${await readFile(w.paths.journal, 'utf8')}not an event\n`)
  const boot = new TemporarySessions(w.deps)
  await boot.load()
  assert.equal(boot.exitSnapshot().degraded, true)
  assert.deepEqual(boot.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(boot.exitSnapshot(), w.deps.logger, w.paths.journal), 0)
  assert.equal(fs.existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})
