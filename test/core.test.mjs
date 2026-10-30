/**
 * Core temporary-session registry tests. The Host services are faked; the
 * registry file and session directories are real temporary paths.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import {
  TemporarySessions,
  cleanupSnapshotSync,
  installExitCleanup,
  isSafeSessionDir,
  statePaths,
} from '../core.js'
import { appendJournalEvent, replayJournal, writeJournalMarker } from '../journal.js'
import { Publisher } from '../publisher.js'
import { readRecord, recordFields } from '../records.js'
import { tempSessionDescriptors } from '../remote.js'

let root
let stateFile
let stateDir
let journalFile
let markerFile
const warnings = []
const NOW = 1_760_000_000_000

function fakeSession(id, {
  cwd = '/tmp/project', events = [], isSeeded = false, origin, parentSession, inheritedEventCount, createdAt,
} = {}) {
  return {
    id,
    seq: events.length,
    inheritedEventCount,
    snapshotEvents: () => events,
    header: {
      id,
      cwd,
      isSeeded,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(origin === undefined ? {} : { origin }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

/** The stored artifact directory the fake locator derives from a Session id. */
function sessionDirOf(id) {
  return join(root, 'sessions', 'project', id)
}

/** Every event line the ownership journal holds, in file order. */
async function journalLines() {
  let text
  try {
    text = await readFile(journalFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line))
}

/** A state record as a pre-journal registry would have written it. */
function legacyRecord(session, kind = 'main', parentSessionId = null) {
  return {
    sessionId: session.id,
    dir: sessionDirOf(session.id),
    cwd: session.header.cwd ?? null,
    createdAt: session.header.createdAt ?? 1,
    title: '',
    kind,
    parentSessionId,
    pendingDelete: false,
  }
}

/** Write a version-1 registry index directly, as a previous run would have. */
async function writeRegistry(sessions) {
  await mkdir(stateDir, { recursive: true })
  await writeFile(stateFile, JSON.stringify({ version: 1, sessions }, null, 2))
}

function harness({ sessions = new Map(), stored = [], registry, persistence = {} } = {}) {
  const live = new Map(sessions)
  const removed = []
  const renames = []
  const cancelled = []
  const unarchived = []
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
      ...persistence,
    },
    sessionController: {
      rename: async request => { renames.push(request.title); return { title: request.title, seq: 1 } },
      cancel: request => { cancelled.push(request.sessionId); return { accepted: true } },
    },
    agents: { get: id => (registry?.running?.includes(id) ? { status: 'running' } : undefined) },
    workspaceRegistry: { unarchiveSession: async id => { unarchived.push(id) } },
    logger: { warn: message => warnings.push(message), info: () => {} },
    paths: statePaths({ DSH_HOME: root }),
  }
  return {
    temp: new TemporarySessions(deps),
    deps,
    live,
    removed,
    renames,
    cancelled,
    unarchived,
  }
}

async function materializeSession(id) {
  const dir = join(root, 'sessions', 'project', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-temp-session-test-'))
  const paths = statePaths({ DSH_HOME: root })
  stateFile = paths.file
  stateDir = paths.dir
  journalFile = paths.journal
  markerFile = paths.marker
})

beforeEach(async () => {
  await rm(join(root, 'temp-session'), { recursive: true, force: true })
  await rm(join(root, 'sessions'), { recursive: true, force: true })
  warnings.length = 0
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('state paths prefer the Host home-path service', () => {
  const paths = statePaths({}, relative => join(root, relative))
  assert.equal(paths.dir, join(root, 'temp-session'))
  assert.equal(paths.file, join(root, 'temp-session', 'records.json'))
})

test('safe deletion requires the Session id in the leaf directory', () => {
  assert.equal(isSafeSessionDir('/home/u/.dsh/sessions/p/session-abc', 'session-abc'), true)
  assert.equal(isSafeSessionDir('/home/u/.dsh/sessions/p/other', 'session-abc'), false)
  assert.equal(isSafeSessionDir('/', 'session-abc'), false)
  assert.equal(isSafeSessionDir('/home/u', 'session-abc'), false)
  assert.equal(isSafeSessionDir('/a/b', 'b'), false)
  assert.equal(isSafeSessionDir(undefined, 'session-abc'), false)
})

test('register stores a fresh Session, titles it, and lists it', async () => {
  const session = fakeSession('session-register')
  const h = harness({ sessions: new Map([[session.id, session]]) })
  const record = await h.temp.register({ sessionId: session.id, title: '临时会话 · 10:00' })
  assert.equal(record.sessionId, session.id)
  assert.deepEqual(h.renames, ['临时会话 · 10:00'])
  const listed = await h.temp.list()
  assert.deepEqual(listed.sessions.map(item => item.sessionId), [session.id])
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[session.id].dir, join(root, 'sessions', 'project', session.id))
})

test('the registry lists a fresh Session before its log is materialized', async () => {
  // An outside reader learns nothing from the plugin except this file. If the record only
  // appears after the flush, a turn written by that flush is visible while the Session is
  // still unregistered.
  const session = fakeSession('session-early')
  const h = harness({ sessions: new Map([[session.id, session]]) })
  let listedDuringFlush
  h.temp.deps.sessions.flush = async () => {
    const raw = await readFile(stateFile, 'utf8').catch(() => '')
    listedDuringFlush = raw.includes(`"${session.id}":`)
    return true
  }
  await h.temp.register({ sessionId: session.id })
  assert.equal(listedDuringFlush, true)
  // The locator's answer still lands in the registry after the flush.
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[session.id].dir, join(root, 'sessions', 'project', session.id))
})

test('a directory without the log artifact does not keep a record', async () => {
  // The Host creates the directory before it links the log, so a failure between the two leaves
  // an empty directory and no transcript. That must not gate the Session.
  const session = fakeSession('session-badflush')
  const h = harness({ sessions: new Map([[session.id, session]]) })
  h.temp.deps.sessions.flush = async () => {
    await mkdir(join(root, 'sessions', 'project', session.id), { recursive: true })
    throw new Error('link failed')
  }
  await assert.rejects(h.temp.register({ sessionId: session.id }), /link failed/)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(saved.sessions, {})
})

test('a flush that publishes the log before failing keeps the record', async () => {
  // The Host backend links the artifact and then syncs the directory; a sync failure leaves the
  // log on disk. Rolling back there would expose a temporary transcript to readers of this file.
  const session = fakeSession('session-half-flush')
  const h = harness({ sessions: new Map([[session.id, session]]) })
  const dir = join(root, 'sessions', 'project', session.id)
  h.temp.deps.sessions.flush = async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), '')
    throw new Error('directory sync failed')
  }
  await assert.rejects(h.temp.register({ sessionId: session.id }), /directory sync failed/)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[session.id].dir, dir)
})

test('an unresolvable locator fails before anything is written', async () => {
  const session = fakeSession('session-nolocator')
  const h = harness({ sessions: new Map([[session.id, session]]) })
  h.temp.deps.sessionPersistence = { ...h.temp.deps.sessionPersistence, locate: () => ({ kind: 'sqlite' }) }
  let flushed = false
  h.temp.deps.sessions.flush = async () => { flushed = true; return true }
  await assert.rejects(h.temp.register({ sessionId: session.id }), /JSONL session store/)
  assert.equal(flushed, false)
  await assert.rejects(readFile(stateFile, 'utf8'), /ENOENT/)
})

test('register rejects existing history and seeded or subagent Sessions', async () => {
  const h = harness({
    sessions: new Map([
      ['session-used', fakeSession('session-used', {
        events: [{ type: 'user/message', data: { source: { kind: 'user' } } }],
      })],
      ['session-turned', fakeSession('session-turned', { events: [{ type: 'turn/start', data: {} }] })],
      ['session-seeded', fakeSession('session-seeded', { isSeeded: true })],
      ['session-sub', fakeSession('session-sub', { origin: 'subagent' })],
      ['session-setup', fakeSession('session-setup', { events: [{ type: 'developer/message', data: {} }] })],
    ]),
  })
  await assert.rejects(h.temp.register({ sessionId: 'session-used' }), /unused/)
  await assert.rejects(h.temp.register({ sessionId: 'session-turned' }), /unused/)
  await assert.rejects(h.temp.register({ sessionId: 'session-seeded' }), /seeded temporary Session must name/)
  await assert.rejects(h.temp.register({ sessionId: 'session-sub' }), /subagent/)
  await assert.rejects(h.temp.register({ sessionId: 'session-turned' }), /unused/)
  await assert.rejects(h.temp.register({ sessionId: 'session-missing' }), /not live/)
  // Setup-only records (delegation policy, prompt wiring) are not history.
  const record = await h.temp.register({ sessionId: 'session-setup' })
  assert.equal(record.sessionId, 'session-setup')
})

test('register adopts a fork whose child-owned tail is unused', async () => {
  const inherited = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' } } },
    { type: 'turn/end', data: { turn: 1, reason: 'completed' } },
  ]
  const fork = fakeSession('session-fork', {
    isSeeded: true,
    parentSession: 'session-parent',
    inheritedEventCount: 3,
    events: [...inherited, { type: 'fork/boundary', data: {} }],
  })
  const h = harness({ sessions: new Map([[fork.id, fork]]) })
  const record = await h.temp.register({ sessionId: fork.id, kind: 'side' })
  assert.equal(record.kind, 'side')
  assert.equal(record.pendingDelete, false)
  // A turn owned by the child itself is real use and is refused.
  const busyFork = fakeSession('session-busy-fork', {
    isSeeded: true,
    parentSession: 'session-parent',
    inheritedEventCount: 3,
    events: [...inherited, { type: 'turn/start', data: { turn: 2 } }],
  })
  h.live.set(busyFork.id, busyFork)
  await assert.rejects(h.temp.register({ sessionId: busyFork.id, kind: 'side' }), /unused/)
})

test('discard marks the record and cancels running work', async () => {
  const session = fakeSession('session-discard')
  const h = harness({
    sessions: new Map([[session.id, session]]),
    registry: { running: [session.id] },
  })
  await h.temp.register({ sessionId: session.id, title: '临时会话 · 10:01' })
  assert.deepEqual(await h.temp.discard({ sessionId: session.id }), { discarded: true })
  assert.deepEqual(h.cancelled, [session.id])
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[session.id].pendingDelete, true)
  await assert.rejects(h.temp.discard({ sessionId: 'other' }), /not a recorded/)
  // Ended sessions stay listed with their pending flag so the browser can
  // keep hiding a side chat until the Host deletes it.
  const listed = (await h.temp.list()).sessions
  assert.equal(listed.length, 1)
  assert.equal(listed[0].pendingDelete, true)
})

test('promote drops the record and renames the lasting Session', async () => {
  const session = fakeSession('session-promote')
  const h = harness({ sessions: new Map([[session.id, session]]) })
  await h.temp.register({ sessionId: session.id, title: '临时会话 · 10:02' })
  assert.deepEqual(await h.temp.promote({ sessionId: session.id, title: '保留的会话' }), { promoted: true })
  assert.deepEqual(h.renames, ['临时会话 · 10:02', '保留的会话'])
  assert.deepEqual((await h.temp.list()).sessions, [])
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[session.id], undefined)
  await assert.rejects(h.temp.promote({ sessionId: 'other' }), /not a recorded/)
})

test('reap deletes non-live leftovers and keeps live Sessions', async () => {
  const dead = fakeSession('session-dead')
  const alive = fakeSession('session-alive')
  const deadDir = await materializeSession(dead.id)
  const aliveDir = await materializeSession(alive.id)
  const h = harness({
    sessions: new Map([[alive.id, alive]]),
    stored: [dead.header, alive.header],
  })
  h.live.set(dead.id, dead)
  await h.temp.register({ sessionId: dead.id })
  await h.temp.register({ sessionId: alive.id })
  h.live.delete(dead.id)
  await h.temp.reap()
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[dead.id], undefined)
  assert.ok(saved.sessions[alive.id] !== undefined)
  await assert.rejects(readFile(join(deadDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.ok((await readFile(join(aliveDir, 'session.v4.jsonl.zstd'), 'utf8')) === 'log')
  assert.deepEqual(h.unarchived, [dead.id])
})

test('reap recovers a missing directory from the stored header', async () => {
  const session = fakeSession('session-recover')
  const h = harness({ sessions: new Map([[session.id, session]]), stored: [session.header] })
  await h.temp.register({ sessionId: session.id })
  const dir = await materializeSession(session.id)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  delete saved.sessions[session.id].dir
  await writeFile(stateFile, JSON.stringify(saved))
  h.live.clear()
  await h.temp.reap()
  await assert.rejects(readFile(join(dir, 'session.v4.jsonl.zstd')), /ENOENT/)
  const after = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(after.sessions[session.id], undefined)
})

test('snapshot cleanup deletes every recorded directory but keeps tombstones', async () => {
  const first = fakeSession('session-sync-one')
  const second = fakeSession('session-sync-two')
  const h = harness({ sessions: new Map([[first.id, first], [second.id, second]]) })
  await h.temp.register({ sessionId: first.id })
  await h.temp.register({ sessionId: second.id })
  const firstDir = await materializeSession(first.id)
  const secondDir = await materializeSession(second.id)
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 2)
  await assert.rejects(readFile(join(firstDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(secondDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(Object.keys(saved.sessions).length, 2)
})

test('cleanupPending removes only ended Sessions', async () => {
  const ended = fakeSession('session-ended')
  const live = fakeSession('session-kept')
  const h = harness({ sessions: new Map([[ended.id, ended], [live.id, live]]) })
  await h.temp.register({ sessionId: ended.id })
  await h.temp.register({ sessionId: live.id })
  await h.temp.discard({ sessionId: ended.id })
  const endedDir = await materializeSession(ended.id)
  const liveDir = await materializeSession(live.id)
  await h.temp.cleanupPending()
  await assert.rejects(readFile(join(endedDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(liveDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
})

test('a corrupt registry never throws and never deletes blindly', async () => {
  await mkdir(join(root, 'temp-session'), { recursive: true })
  await writeFile(stateFile, '{not json')
  const h = harness()
  const listed = await h.temp.list()
  assert.deepEqual(listed.sessions, [])
  assert.deepEqual(listed.stopping, [])
  assert.equal(listed.degraded, true)
  assert.equal(listed.sequence, 1)
  assert.ok(Number.isSafeInteger(listed.epoch) && listed.epoch > 0)
  await h.temp.reap()
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 0)
})

test('unload leaves an unreadable registry file untouched and leaves no temporary file', async () => {
  const dir = join(root, 'temp-session')
  const truncated = '{"version":1,"sessions":{'
  await mkdir(dir, { recursive: true })
  await writeFile(stateFile, truncated)
  const h = harness()
  await h.temp.load()
  await h.temp.cleanupPending()
  assert.equal(await readFile(stateFile, 'utf8'), truncated)
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
})

/** Register a chat and record one subagent child under it. */
async function chatWithChild() {
  const chat = fakeSession('session-chat')
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(child)
  return { h, chat, child }
}

test('a subagent under a recorded chat is recorded at creation; other Sessions are not', async () => {
  const chat = fakeSession('session-chat')
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id })
  // A plain fork of a chat is not a subagent, so it is left to the browser path.
  const fork = fakeSession('session-plain-fork', { parentSession: chat.id, isSeeded: true })
  // A subagent whose parent is neither recorded nor live is a guess, so it is refused.
  const stranger = fakeSession('session-stranger', { origin: 'subagent', parentSession: 'session-nowhere' })
  const h = harness({
    sessions: new Map([[chat.id, chat], [child.id, child], [fork.id, fork], [stranger.id, stranger]]),
  })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(child)
  await h.temp.recordDescendant(fork)
  await h.temp.recordDescendant(stranger)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(Object.keys(saved.sessions).sort(), ['session-chat', 'session-child'])
  const { createdAt, lastActivityAt, activitySince, ...record } = saved.sessions[child.id]
  for (const clock of [createdAt, lastActivityAt, activitySince]) {
    assert.ok(Number.isSafeInteger(clock) && clock > 0)
  }
  assert.deepEqual(record, {
    sessionId: child.id,
    kind: 'subagent',
    parentSessionId: chat.id,
    title: '',
    dir: join(root, 'sessions', 'project', child.id),
    cwd: '/tmp/project',
    pendingDelete: false,
  })
  // A Session without a header must not make the listener throw.
  await assert.doesNotReject(h.temp.recordDescendant({}))
})

test('a subagent record is not a chat: it is not listed, adopted, discarded, or promoted', async () => {
  const { h, chat, child } = await chatWithChild()
  assert.deepEqual((await h.temp.list()).sessions.map(item => item.sessionId), [chat.id])
  await assert.rejects(h.temp.register({ sessionId: child.id }), /subagent/)
  await assert.rejects(h.temp.discard({ sessionId: child.id }), /not a recorded/)
  await assert.rejects(h.temp.promote({ sessionId: child.id }), /not a recorded/)
})

test('a subagent under an unrecorded live ancestor is recorded with its true direct parent', async () => {
  const chat = fakeSession('session-chat')
  // The middle subagent was never announced to the plugin, so it is not recorded.
  const middle = fakeSession('session-middle', { origin: 'subagent', parentSession: chat.id })
  const leaf = fakeSession('session-leaf', { origin: 'subagent', parentSession: middle.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [middle.id, middle], [leaf.id, leaf]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(leaf)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  // The live chain proves the leaf belongs to the temporary tree; the record keeps
  // the announced direct parent, and boot reconciliation will adopt the middle.
  assert.equal(saved.sessions[leaf.id].parentSessionId, middle.id)
  assert.equal(saved.sessions[middle.id], undefined)
})

test('exit cleanup deletes a recorded child together with its chat', async () => {
  const { h, chat, child } = await chatWithChild()
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 2)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('discard marks the chat and its children, and unload cleanup deletes both', async () => {
  const { h, chat, child } = await chatWithChild()
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  await h.temp.discard({ sessionId: chat.id })
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[child.id].pendingDelete, true)
  await h.temp.cleanupPending()
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('a child recorded after its chat was discarded inherits the pending deletion', async () => {
  const chat = fakeSession('session-chat')
  const late = fakeSession('session-late', { origin: 'subagent', parentSession: chat.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [late.id, late]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.discard({ sessionId: chat.id })
  await h.temp.recordDescendant(late)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[late.id].pendingDelete, true)
})

test('promote drops the chat and its child records, so a later exit keeps the child log', async () => {
  const { h, chat, child } = await chatWithChild()
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  await h.temp.promote({ sessionId: chat.id })
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(saved.sessions, {})
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 0)
  assert.equal(await readFile(join(childDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  assert.equal(await readFile(join(chatDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
})

test('boot reap deletes a child whose parent record is gone, and drops a child whose directory is gone', async () => {
  const { h, chat, child } = await chatWithChild()
  const orphanDir = await materializeSession(child.id)
  h.deps.sessionPersistence.list = async () => [chat, child].map(session => ({ header: session.header }))
  h.temp.storedHeaders.set(chat.id, chat.header)
  h.temp.storedHeaders.set(child.id, child.header)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  // The parent record is removed without its cascade: the child must still be deleted.
  delete saved.sessions['session-chat']
  await writeFile(stateFile, JSON.stringify(saved))
  h.live.clear()
  await h.temp.reap()
  await assert.rejects(readFile(join(orphanDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).sessions, {})

  // A child whose directory was never materialized is dropped without error.
  const chat2 = fakeSession('session-chat2')
  const gone = fakeSession('session-gone', { origin: 'subagent', parentSession: chat2.id })
  const again = harness({
    sessions: new Map([[chat2.id, chat2], [gone.id, gone]]),
    stored: [chat2.header, gone.header],
  })
  await again.temp.register({ sessionId: chat2.id })
  await again.temp.recordDescendant(gone)
  again.live.clear()
  await again.temp.reap()
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).sessions, {})
})

test('a subagent of an ordinary fork is not recorded under the chat the fork came from', async () => {
  const chat = fakeSession('session-chat')
  // An ordinary fork of the chat is live and unrecorded. Its subagent belongs to the fork.
  const fork = fakeSession('session-plain-fork', { parentSession: chat.id, isSeeded: true })
  const child = fakeSession('session-plain-child', { origin: 'subagent', parentSession: fork.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [fork.id, fork], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(child)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(Object.keys(saved.sessions), [chat.id])
  // Ending the chat must leave the fork's subagent log alone.
  const childDir = await materializeSession(child.id)
  await h.temp.discard({ sessionId: chat.id })
  await h.temp.cleanupPending()
  assert.equal(await readFile(join(childDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
})

test('reap keeps a settled child while its live chat stays, through every depth, and promotion keeps its log', async () => {
  const chat = fakeSession('session-chat')
  const middle = fakeSession('session-middle', { origin: 'subagent', parentSession: chat.id })
  const leaf = fakeSession('session-leaf', { origin: 'subagent', parentSession: middle.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [middle.id, middle], [leaf.id, leaf]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(middle)
  await h.temp.recordDescendant(leaf)
  const leafDir = await materializeSession(leaf.id)
  // Both children settle while the chat stays live, as they do across a live profile reload.
  h.live.delete(middle.id)
  h.live.delete(leaf.id)
  await h.temp.reap()
  const kept = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(Object.keys(kept.sessions).sort(), ['session-chat', 'session-leaf', 'session-middle'])
  assert.equal(await readFile(join(leafDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  await h.temp.promote({ sessionId: chat.id })
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 0)
  assert.equal(await readFile(join(leafDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
})

test('exit cleanup also deletes a child whose registry save has not finished', async () => {
  const chat = fakeSession('session-chat')
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  // The child is associated in memory, and its registry save is still pending when the process exits.
  let saveStarted
  const started = new Promise(resolve => { saveStarted = resolve })
  h.temp.save = () => { saveStarted(); return new Promise(() => {}) }
  void h.temp.recordDescendant(child)
  await started
  const onDisk = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(onDisk.sessions[child.id], undefined)
  const removed = cleanupSnapshotSync(h.temp.exitSnapshot())
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(removed, 2)
  // A boot reap after the exit: the journal still owns the child, but the process is
  // gone, so neither a live Session nor its stored header survives to rebuild it.
  h.live.clear()
  await new TemporarySessions(h.temp.deps).reap()
  const afterReap = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(afterReap.sessions[child.id], undefined)
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('discard sends cancel only to the chat, never to a subagent child the Host refuses', async () => {
  const chat = fakeSession('session-chat')
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id })
  const h = harness({
    sessions: new Map([[chat.id, chat], [child.id, child]]),
    registry: { running: [chat.id, child.id] },
  })
  const attempts = []
  // The Host refuses cancel for every subagent-owned Session.
  h.temp.deps.sessionController.cancel = ({ sessionId }) => {
    attempts.push(sessionId)
    if (sessionId === child.id) throw new Error('session is owned by subagent routing')
  }
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(child)
  await h.temp.discard({ sessionId: chat.id })
  assert.deepEqual(attempts, [chat.id])
  // The child is still marked for deletion with its chat.
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[child.id].pendingDelete, true)
})

const PROCESS_CLEANUP_FLAG = Symbol.for('dsh.temp-session.process-cleanup')
const EXIT_SNAPSHOT_KEY = Symbol.for('dsh.temp-session.exit-snapshot')

/**
 * Runs a body with the once-per-process guard and the exit state provider
 * cleared, so this test's install adds its own exit handler whether or not
 * another test installed one first. The body receives a reader for the exit
 * listeners this run added. Afterwards the added listeners are removed and both
 * globals are restored.
 */
async function withFreshProcessCleanup(body) {
  const saved = new Map()
  for (const key of [PROCESS_CLEANUP_FLAG, EXIT_SNAPSHOT_KEY]) {
    saved.set(key, globalThis[key])
    delete globalThis[key]
  }
  const exitBefore = new Set(process.listeners('exit'))
  const signalsBefore = ['SIGTERM', 'SIGINT'].map(name => [name, new Set(process.listeners(name))])
  try {
    return await body(() => process.listeners('exit').filter(listener => !exitBefore.has(listener)))
  } finally {
    for (const listener of process.listeners('exit')) {
      if (!exitBefore.has(listener)) process.off('exit', listener)
    }
    for (const [name, before] of signalsBefore) {
      for (const listener of process.listeners(name)) {
        if (!before.has(listener)) process.off(name, listener)
      }
    }
    for (const [key, value] of saved) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}

test('exit cleanup reads the latest install snapshot, not the first install', () => withFreshProcessCleanup(async addedExitListeners => {
  const dirA = await materializeSession('session-a-first')
  const dirB = await materializeSession('session-b-latest')
  installExitCleanup(() => ({
    degraded: false,
    sessions: [{ sessionId: 'session-a-first', dir: dirA }],
  }))
  installExitCleanup(() => ({
    degraded: false,
    sessions: [{ sessionId: 'session-b-latest', dir: dirB }],
  }))
  assert.equal(addedExitListeners().length, 1)
  addedExitListeners()[0]()
  await assert.rejects(readFile(join(dirB, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(dirA, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
}))

test('exit cleanup deletes only the journal-owned child when a save is held', async () => {
  const chat = fakeSession('session-chat')
  const first = fakeSession('session-first', { origin: 'subagent', parentSession: chat.id })
  const second = fakeSession('session-second', { origin: 'subagent', parentSession: chat.id })
  const h = harness({
    sessions: new Map([[chat.id, chat], [first.id, first], [second.id, second]]),
  })
  await h.temp.register({ sessionId: chat.id })
  const chatDir = await materializeSession(chat.id)
  const firstDir = await materializeSession(first.id)
  const secondDir = await materializeSession(second.id)
  // The first child's registry save never finishes, so the second child waits behind it in the queue.
  let saveStarted
  const started = new Promise(resolve => { saveStarted = resolve })
  h.temp.save = () => { saveStarted(); return new Promise(() => {}) }
  void h.temp.recordDescendant(first)
  await started
  void h.temp.recordDescendant(second)
  assert.equal(h.temp.state.sessions[second.id], undefined)
  const removed = cleanupSnapshotSync(h.temp.exitSnapshot())
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(firstDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(removed, 2)
  // The queued child has no journal event, so exit never guesses it away.
  assert.equal(await readFile(join(secondDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  // A boot after the exit adopts the stored child under its journal-owned parent, so the
  // recovered ownership, not the exit path, deletes the folder.
  h.deps.sessionPersistence.list = async () => [chat, first, second].map(session => ({ header: session.header }))
  h.live.clear()
  await new TemporarySessions(h.temp.deps).reap()
  const afterReap = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(afterReap.sessions, {})
  await assert.rejects(readFile(join(secondDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('a failed child save keeps the record for exit cleanup and for the next successful save', async () => {
  const chat = fakeSession('session-chat')
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id })
  const second = fakeSession('session-second', { origin: 'subagent', parentSession: chat.id })
  const h = harness({
    sessions: new Map([[chat.id, chat], [child.id, child], [second.id, second]]),
  })
  await h.temp.register({ sessionId: chat.id })
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  // Exactly one registry write fails, as a full disk would.
  const save = h.temp.save
  let failures = 1
  h.temp.save = async function failOnce() {
    if (failures > 0) {
      failures -= 1
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    return save.call(this)
  }
  await assert.rejects(h.temp.recordDescendant(child), /ENOSPC/)
  assert.notEqual(h.temp.state.sessions[child.id], undefined)
  const onDisk = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(onDisk.sessions[child.id], undefined)
  // Exit cleanup still sees the child's record in the immutable snapshot.
  const removed = cleanupSnapshotSync(h.temp.exitSnapshot())
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(removed, 2)
  // The next successful save persists the record that the failed save left in memory.
  await h.temp.recordDescendant(second)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.notEqual(saved.sessions[child.id], undefined)
  assert.notEqual(saved.sessions[second.id], undefined)
})

/**
 * After an unload that left records only in memory: each child's record is on disk, a fresh
 * instance's boot reap keeps the children while the chat is live, and that instance's exit
 * cleanup deletes the journal-owned children with the chat. A child whose announcement never
 * reached the journal is published, then adopted on boot under its journal-owned parent.
 */
async function assertUnloadPublishes(h, addedExitListeners, { chatDir, children }) {
  const onDisk = JSON.parse(await readFile(stateFile, 'utf8'))
  for (const child of children) assert.notEqual(onDisk.sessions[child.id], undefined)
  for (const child of children) h.live.delete(child.id)
  const successor = new TemporarySessions(h.temp.deps)
  await successor.reap()
  const afterReap = JSON.parse(await readFile(stateFile, 'utf8'))
  for (const child of children) {
    assert.notEqual(afterReap.sessions[child.id], undefined)
    assert.equal(await readFile(join(child.dir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  }
  installExitCleanup(() => successor.exitSnapshot())
  assert.equal(addedExitListeners().length, 1)
  addedExitListeners()[0]()
  for (const child of children) {
    await assert.rejects(readFile(join(child.dir, 'session.v4.jsonl.zstd')), /ENOENT/)
  }
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
}

test('unload publishes a child queued behind a held save, so a fresh boot and exit still see it', () => withFreshProcessCleanup(async addedExitListeners => {
  const chat = fakeSession('session-chat')
  const first = fakeSession('session-first', { origin: 'subagent', parentSession: chat.id })
  const second = fakeSession('session-second', { origin: 'subagent', parentSession: chat.id })
  const h = harness({
    sessions: new Map([[chat.id, chat], [first.id, first], [second.id, second]]),
  })
  await h.temp.register({ sessionId: chat.id })
  const chatDir = await materializeSession(chat.id)
  const firstDir = await materializeSession(first.id)
  const secondDir = await materializeSession(second.id)
  // The first child's registry save never finishes, so the second child waits behind it in the queue.
  let saveStarted
  const started = new Promise(resolve => { saveStarted = resolve })
  h.temp.save = () => { saveStarted(); return new Promise(() => {}) }
  void h.temp.recordDescendant(first)
  await started
  void h.temp.recordDescendant(second)
  assert.notEqual(h.temp.state.sessions[first.id], undefined)
  assert.equal(h.temp.state.sessions[second.id], undefined)
  // Unload runs while the queue is blocked. It publishes both records without waiting;
  // the boot after exit adopts the unjournaled child under its journal-owned chat.
  void h.temp.cleanupPending()
  h.deps.sessionPersistence.list = async () => [chat, first, second].map(session => ({ header: session.header }))
  await assertUnloadPublishes(h, addedExitListeners, {
    chatDir,
    children: [{ id: first.id, dir: firstDir }, { id: second.id, dir: secondDir }],
  })
}))

test('unload publishes a child whose save failed, so a fresh boot and exit still see it', () => withFreshProcessCleanup(async addedExitListeners => {
  const chat = fakeSession('session-chat')
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  // Exactly one registry write fails, as a full disk would.
  const save = h.temp.save
  let failures = 1
  h.temp.save = async function failOnce() {
    if (failures > 0) {
      failures -= 1
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    return save.call(this)
  }
  await assert.rejects(h.temp.recordDescendant(child), /ENOSPC/)
  assert.notEqual(h.temp.state.sessions[child.id], undefined)
  await h.temp.cleanupPending()
  h.deps.sessionPersistence.list = async () => [chat, child].map(session => ({ header: session.header }))
  await assertUnloadPublishes(h, addedExitListeners, {
    chatDir,
    children: [{ id: child.id, dir: childDir }],
  })
}))

test('an exit listener from an earlier module generation reads the latest install snapshot', () => withFreshProcessCleanup(async addedExitListeners => {
  // Two module instances of core.js stand for two generations of one plugin after a watched-file reload.
  const generationOne = await import(new URL('../core.js?generation=1', import.meta.url).href)
  const generationTwo = await import(new URL('../core.js?generation=2', import.meta.url).href)
  assert.notEqual(generationOne, generationTwo)
  const dirA = await materializeSession('session-generation-one')
  const dirB = await materializeSession('session-generation-two')
  generationOne.installExitCleanup(() => ({
    degraded: false,
    sessions: [{ sessionId: 'session-generation-one', dir: dirA }],
  }))
  generationTwo.installExitCleanup(() => ({
    degraded: false,
    sessions: [{ sessionId: 'session-generation-two', dir: dirB }],
  }))
  // Only the first generation installed a handler; it must read the second generation's snapshot at exit.
  assert.equal(addedExitListeners().length, 1)
  addedExitListeners()[0]()
  await assert.rejects(readFile(join(dirB, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(dirA, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
}))

// --- The shared record shape, the journal schema, reservations and the migration ---

test('the record shape round-trips every field', async () => {
  const chat = fakeSession('session-shape', { createdAt: 1000 })
  const fork = fakeSession('session-shape-fork', { isSeeded: true, parentSession: chat.id, createdAt: 2000 })
  const child = fakeSession('session-shape-child', { origin: 'subagent', parentSession: chat.id, createdAt: 3000 })
  const h = harness({
    sessions: new Map([[chat.id, chat], [fork.id, fork], [child.id, child]]),
    stored: [chat.header, fork.header, child.header],
  })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.register({ sessionId: fork.id, kind: 'side' })
  await h.temp.recordDescendant(child)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  // Every stored record survives validation with every field, and each path that
  // writes a record writes the same shape.
  for (const [key, value] of Object.entries(saved.sessions)) {
    assert.deepEqual(readRecord(value, key, NOW), value)
  }
  const { lastActivityAt, activitySince, ...main } = saved.sessions[chat.id]
  assert.deepEqual(main, {
    sessionId: chat.id,
    kind: 'main',
    parentSessionId: null,
    title: '',
    dir: sessionDirOf(chat.id),
    cwd: '/tmp/project',
    createdAt: 1000,
    pendingDelete: false,
  })
  for (const clock of [lastActivityAt, activitySince]) assert.ok(Number.isSafeInteger(clock) && clock > 0)
  const { lastActivityAt: forkActivity, activitySince: forkSince, ...side } = saved.sessions[fork.id]
  assert.deepEqual(side, {
    sessionId: fork.id,
    kind: 'side',
    parentSessionId: chat.id,
    title: '',
    dir: sessionDirOf(fork.id),
    cwd: '/tmp/project',
    createdAt: 2000,
    pendingDelete: false,
  })
  for (const clock of [forkActivity, forkSince]) assert.ok(Number.isSafeInteger(clock) && clock > 0)
  const { lastActivityAt: childActivity, activitySince: childSince, ...subagent } = saved.sessions[child.id]
  assert.deepEqual(subagent, {
    sessionId: child.id,
    kind: 'subagent',
    parentSessionId: chat.id,
    title: '',
    dir: sessionDirOf(child.id),
    cwd: '/tmp/project',
    createdAt: 3000,
    pendingDelete: false,
  })
  for (const clock of [childActivity, childSince]) assert.ok(Number.isSafeInteger(clock) && clock > 0)

  // The `fork` kind is part of the one shape even before its recorder lands.
  const forkRecord = recordFields({
    sessionId: 'session-forkshape',
    kind: 'fork',
    parentSessionId: chat.id,
    title: 'forked',
    dir: '/tmp/dsh/sessions/project/session-forkshape',
    cwd: '/tmp/project',
    createdAt: 4000,
    lastActivityAt: 5000,
    activitySince: 4000,
    pendingDelete: true,
  }, NOW)
  assert.deepEqual(forkRecord, {
    sessionId: 'session-forkshape',
    kind: 'fork',
    parentSessionId: chat.id,
    title: 'forked',
    dir: '/tmp/dsh/sessions/project/session-forkshape',
    cwd: '/tmp/project',
    createdAt: 4000,
    lastActivityAt: 5000,
    activitySince: 4000,
    pendingDelete: true,
  })
  assert.deepEqual(readRecord(JSON.parse(JSON.stringify(forkRecord)), forkRecord.sessionId, NOW), forkRecord)
  assert.deepEqual(recordFields({ ...forkRecord, createdAt: undefined, lastActivityAt: undefined, activitySince: undefined }, NOW), {
    ...forkRecord,
    createdAt: NOW,
    lastActivityAt: NOW,
    activitySince: NOW,
  })

  // The browser listing validates the same kind set through the shared list codec.
  const listCodec = tempSessionDescriptors.find(descriptor => descriptor.method === 'list').result
  const listed = listCodec.create().parse({
    epoch: 3,
    sequence: 2,
    degraded: false,
    stopping: [{ sessionId: forkRecord.sessionId, kind: 'fork' }],
    sessions: [
      { sessionId: chat.id, createdAt: 1000, kind: 'main', pendingDelete: false },
      { sessionId: forkRecord.sessionId, createdAt: 4000, kind: 'fork', pendingDelete: true },
    ],
  })
  assert.deepEqual(listed, {
    epoch: 3,
    sequence: 2,
    degraded: false,
    stopping: [{ sessionId: forkRecord.sessionId, kind: 'fork' }],
    sessions: [
      { sessionId: chat.id, createdAt: 1000, kind: 'main', pendingDelete: false },
      { sessionId: forkRecord.sessionId, createdAt: 4000, kind: 'fork', pendingDelete: true },
    ],
  })
  assert.throws(() => listCodec.create().parse({
    epoch: 3,
    sequence: 2,
    degraded: false,
    stopping: [],
    sessions: [{ sessionId: chat.id, createdAt: 1000, kind: 'subagent', pendingDelete: false }],
  }), /invalid record/)
})

test('the journal schema round-trips every event', async () => {
  const at = 5000
  const events = [
    { type: 'migration', ids: ['session-legacy'], preexisting: ['session-old'], at },
    { type: 'reserved', sessionId: 'session-root', workspaceId: 'ws-1', cwd: '/tmp/project', at },
    { type: 'reservationDropped', sessionId: 'session-root', at },
    { type: 'owned', sessionId: 'session-legacy', kind: 'main', parentSessionId: null, dir: '/tmp/dsh/sessions/project/session-legacy', cwd: '/tmp/project', at },
    { type: 'owned', sessionId: 'session-child', kind: 'subagent', parentSessionId: 'session-legacy', dir: '/tmp/dsh/sessions/project/session-child', cwd: '/tmp/project', at },
    { type: 'pending', sessionIds: ['session-legacy', 'session-child'], reason: 'discard', at },
    { type: 'pending', sessionIds: ['session-child'], reason: 'expiry', at: at + 1 },
    { type: 'deleted', sessionId: 'session-legacy', kind: 'main', parentSessionId: null, dir: '/tmp/dsh/sessions/project/session-legacy', cwd: '/tmp/project', at: at + 2 },
    { type: 'migrationComplete', at: at + 3 },
  ]
  for (const event of events) await appendJournalEvent(journalFile, event)
  const replay = replayJournal(await readFile(journalFile, 'utf8'))
  assert.deepEqual(replay.events, events)
  assert.equal(replay.torn, false)
  assert.equal(replay.degraded, false)
  assert.deepEqual(replay.entries, {
    'session-legacy': {
      sessionId: 'session-legacy',
      kind: 'main',
      parentSessionId: null,
      dir: '/tmp/dsh/sessions/project/session-legacy',
      cwd: '/tmp/project',
      ownedAt: at,
      pending: true,
      pendingReason: 'discard',
      deleted: true,
      deletedAt: at + 2,
      deletedDir: '/tmp/dsh/sessions/project/session-legacy',
      deletedCwd: '/tmp/project',
    },
    'session-child': {
      sessionId: 'session-child',
      kind: 'subagent',
      parentSessionId: 'session-legacy',
      dir: '/tmp/dsh/sessions/project/session-child',
      cwd: '/tmp/project',
      ownedAt: at,
      pending: true,
      pendingReason: 'expiry',
      deleted: false,
      deletedAt: null,
      deletedDir: null,
      deletedCwd: null,
    },
  })
  assert.deepEqual(replay.reservations, {
    'session-root': { sessionId: 'session-root', workspaceId: 'ws-1', cwd: '/tmp/project', at, dropped: true },
  })
  assert.deepEqual(replay.migration, { ids: ['session-legacy'], preexisting: ['session-old'], at })
  assert.equal(replay.migrationComplete, at + 3)
  // An event outside the schema is refused by the writer, so the file only ever
  // holds events replay understands.
  await assert.rejects(appendJournalEvent(journalFile, { type: 'owned', sessionId: '', kind: 'main', dir: '/x', cwd: null, at }), /invalid/)
  await assert.rejects(appendJournalEvent(journalFile, { type: 'pending', sessionIds: [], reason: 'discard', at }), /invalid/)
})

test('a torn journal line is repaired before the next append', async () => {
  const first = fakeSession('session-torn-one', { createdAt: 10 })
  const second = fakeSession('session-torn-two', { createdAt: 20 })
  const h = harness({ sessions: new Map([[first.id, first], [second.id, second]]) })
  await h.temp.load()
  await h.temp.register({ sessionId: first.id })
  // A crash tore the final append: the last line has no newline and no valid event.
  const text = await readFile(journalFile, 'utf8')
  await writeFile(journalFile, `${text}{"type":"owned","sessionId":"session-torn`)
  const restarted = new TemporarySessions(h.deps)
  await restarted.load()
  assert.equal(restarted.journalDegraded, false)
  assert.equal(restarted.journal.torn, false)
  await restarted.register({ sessionId: second.id })
  // Dropping the torn bytes before the append keeps the next replay clean.
  const raw = await readFile(journalFile, 'utf8')
  const replay = replayJournal(raw)
  assert.equal(replay.torn, false)
  assert.equal(replay.degraded, false)
  assert.ok(replay.events.some(event => event.type === 'owned' && event.sessionId === second.id))
  assert.equal(raw.includes('session-torn"'), false)
})

test('replay folds the journal', async () => {
  const at = 7000
  const dir = join(root, 'sessions', 'project', 'session-fold')
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: 'session-fold', kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: ['session-fold'], reason: 'discard', at: at + 1 })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: 'session-fold', kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: at + 2,
  })
  const replay = replayJournal(await readFile(journalFile, 'utf8'))
  assert.equal(replay.degraded, false)
  assert.deepEqual(replay.entries['session-fold'], {
    sessionId: 'session-fold',
    kind: 'main',
    parentSessionId: null,
    dir,
    cwd: '/tmp/project',
    ownedAt: at,
    pending: true,
    pendingReason: 'discard',
    deleted: true,
    deletedAt: at + 2,
    deletedDir: dir,
    deletedCwd: '/tmp/project',
  })
})

test('the folded state survives compaction', async () => {
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000
  const chat = fakeSession('session-folded', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: old,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: chat.header.cwd, at: old,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: [chat.id], reason: 'discard', at: old })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: chat.header.cwd, at: old,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: old })
  const h = harness({ stored: [chat.header] })
  await h.temp.load()
  await h.temp.pruneJournal(new Map())
  const lines = await journalLines()
  assert.deepEqual(
    lines
      .filter(event => event.sessionId === chat.id || event.sessionIds?.includes(chat.id))
      .map(event => event.type),
    ['owned', 'pending', 'deleted'],
  )
  assert.equal(h.temp.journal.entries[chat.id].deletedDir, dir)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  const restarted = harness({ stored: [] })
  await restarted.temp.load()
  assert.equal(restarted.temp.journal.entries[chat.id].deleted, true)
  assert.equal(restarted.temp.journal.entries[chat.id].deletedDir, dir)
})

test('a corrupt registry does not resurrect a discarded tree', async () => {
  const parent = fakeSession('session-corrupt-parent', { createdAt: 1 })
  const child = fakeSession('session-corrupt-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null, dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: [parent.id], reason: 'discard', at: 102 })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  await mkdir(stateDir, { recursive: true })
  await writeFile(stateFile, '{not json')
  const h = harness({ stored: [parent.header, child.header] })
  await h.temp.load()
  assert.equal(h.temp.registryDegraded, true)
  assert.equal(h.temp.state.sessions[parent.id].pendingDelete, true)
  assert.equal(h.temp.state.sessions[child.id].pendingDelete, true)
  assert.deepEqual((await h.temp.list()).stopping.map(item => item.sessionId), [parent.id])
  assert.equal(existsSync(join(parentDir, 'session.v4.jsonl.zstd')), true)
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), true)
})

test('a deleted target must agree', async () => {
  const chat = fakeSession('session-target', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  const other = join(root, 'sessions', 'project', 'session-other-target')
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir: other, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  const h = harness({ stored: [chat.header] })
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('disagrees with its owned event')))
})

test('a deleted target must agree with its stored header', async () => {
  const chat = fakeSession('session-header-target', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  const mismatched = fakeSession(chat.id, { cwd: '/tmp/other-project', createdAt: 1 })
  const h = harness({ stored: [mismatched.header] })
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('stored header')))
})

test('an interrupted delete finishes only from a trustworthy target', async () => {
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000
  const chat = fakeSession('session-old-interrupted', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  const permanent = fakeSession('session-permanent-control', { createdAt: 1 })
  const permanentDir = await materializeSession(permanent.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: old,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: old,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: old,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: old })
  const h = harness({ stored: [] })
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
  assert.equal(existsSync(join(permanentDir, 'session.v4.jsonl.zstd')), true)
  assert.equal((await journalLines()).some(event => event.sessionId === chat.id), false)

  const unsafe = fakeSession('session-unsafe-target', { createdAt: 1 })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: unsafe.id, kind: 'main', parentSessionId: null, dir: '/tmp', cwd: '/tmp', at: old,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: unsafe.id, kind: 'main', parentSessionId: null, dir: '/tmp', cwd: '/tmp', at: old,
  })
  const second = harness({ stored: [] })
  await second.temp.reap()
  assert.ok(warnings.some(message => message.includes('journal target is unsafe')))
  assert.equal(existsSync('/tmp'), true)
})

test('a malformed parseable owned event is rejected', async () => {
  const control = fakeSession('session-malformed-control', { createdAt: 1 })
  const dir = await materializeSession(control.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [control.id], preexisting: [control.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: control.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: control.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  await writeFile(journalFile, `${await readFile(journalFile, 'utf8')}{"type":"owned","sessionId":"session-malformed-control","kind":"bogus","dir":"${dir}","cwd":"/tmp/project","at":104}\n`)
  const h = harness({ stored: [control.header] })
  await h.temp.reap()
  assert.equal(h.temp.journalDegraded, true)
  assert.equal(h.temp.exitSnapshot().degraded, true)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('a corrupt or semantic journal error blocks deletion', async () => {
  const control = fakeSession('session-semantic-control', { createdAt: 1 })
  const dir = await materializeSession(control.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [control.id], preexisting: [control.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: control.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: control.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  await writeFile(journalFile, `${await readFile(journalFile, 'utf8')}{"type":"pending","sessionIds":["session-never-owned"],"reason":"discard","at":104}\n`)
  const h = harness({ stored: [control.header] })
  await h.temp.reap()
  assert.equal(h.temp.journalDegraded, true)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('a missing migration event degrades the journal', async () => {
  const control = fakeSession('session-no-migration', { createdAt: 1 })
  const dir = await materializeSession(control.id)
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: control.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 102 })
  const h = harness({ stored: [control.header] })
  await h.temp.reap()
  assert.equal(h.temp.journalDegraded, true)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('a held writer is repaired at next start', () => withFreshProcessCleanup(async () => {
  const chat = fakeSession('session-held-writer', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  const before = new Set(process.listeners('SIGTERM'))
  const kill = process.kill
  let reraised
  try {
    process.kill = (_pid, signal) => { reraised = signal; return true }
    installExitCleanup(() => h.temp.exitSnapshot(), h.deps.logger, journalFile)
    const handler = process.listeners('SIGTERM').find(listener => !before.has(listener))
    assert.ok(handler)
    handler('SIGTERM')
  } finally {
    process.kill = kill
  }
  assert.equal(reraised, 'SIGTERM')
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
  // The writer still recreates the transcript after the signal cleanup.
  await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: Date.now(),
  })
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  const restarted = harness({ stored: [chat.header] })
  await restarted.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
  assert.equal(restarted.temp.journal.entries[chat.id].deleted, true)
}))

test('the marker separates a first install from a removed journal', async () => {
  await mkdir(stateDir, { recursive: true })
  await writeFile(markerFile, JSON.stringify({ version: 1, migrationAt: 1, completedAt: 2 }))
  const h = harness()
  await h.temp.load()
  assert.equal(h.temp.journalDegraded, true)
  await h.temp.reap()
  assert.equal(existsSync(journalFile), false)
})

test('a clean install runs the first migration', async () => {
  const h = harness()
  await h.temp.load()
  const lines = await journalLines()
  assert.deepEqual(lines.map(event => event.type), ['migration', 'migrationComplete'])
  assert.equal(h.temp.migrationIncomplete, false)
})

test('a torn migrationComplete is accepted from a valid marker', async () => {
  const chat = fakeSession('session-torn-marker', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  const migration = {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  }
  const owned = {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  }
  await mkdir(stateDir, { recursive: true })
  await writeFile(journalFile, `${JSON.stringify(migration)}\n${JSON.stringify(owned)}\n{"type":"migrationComplete","at":102`)
  await writeFile(markerFile, JSON.stringify({ version: 1, migrationAt: 100, completedAt: 102 }))
  const h = harness({ stored: [chat.header] })
  await h.temp.load()
  assert.equal(h.temp.journalDegraded, false)
  assert.equal(h.temp.journal.torn, false)
  assert.equal(h.temp.migrationIncomplete, false)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('a signal append failure blocks deletion', () => withFreshProcessCleanup(async () => {
  const chat = fakeSession('session-signal-failure', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  const badJournal = join(stateDir, 'signal-bad-journal')
  await mkdir(badJournal, { recursive: true })
  const before = new Set(process.listeners('SIGTERM'))
  const kill = process.kill
  let reraised
  try {
    process.kill = (_pid, signal) => { reraised = signal; return true }
    installExitCleanup(() => h.temp.exitSnapshot(), h.deps.logger, badJournal)
    const handler = process.listeners('SIGTERM').find(listener => !before.has(listener))
    assert.ok(handler)
    handler('SIGTERM')
  } finally {
    process.kill = kill
  }
  assert.equal(reraised, 'SIGTERM')
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.equal((await journalLines()).some(event => event.type === 'deleted' && event.sessionId === chat.id), false)
}))

test('the installed signal handler tombstones before re-raising', async () => {
  const chat = fakeSession('session-signal-handler', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  const before = Object.fromEntries(['exit', 'SIGTERM', 'SIGINT'].map(name => [name, new Set(process.listeners(name))]))
  const keys = [Symbol.for('dsh.temp-session.process-cleanup'), Symbol.for('dsh.temp-session.exit-snapshot')]
  const saved = new Map(keys.map(key => [key, globalThis[key]]))
  const kill = process.kill
  let reraised
  let tombstoneAtRaise = false
  let closed = false
  try {
    process.kill = (_pid, signal) => {
      reraised = signal
      const text = existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8') : ''
      tombstoneAtRaise = text.split('\n').some(line => {
        if (line === '') return false
        try {
          const event = JSON.parse(line)
          return event.type === 'deleted' && event.sessionId === chat.id
        } catch {
          return false
        }
      })
      return true
    }
    installExitCleanup(
      () => ({
        degraded: false,
        sessions: [{ sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project' }],
      }),
      { warn: () => {} },
      journalFile,
      () => { closed = true },
    )
    const handler = process.listeners('SIGTERM').find(listener => !before.SIGTERM.has(listener))
      ?? process.listeners('SIGTERM').find(listener => listener.name === 'onSignal')
    assert.ok(handler)
    handler('SIGTERM')
    assert.equal(closed, true)
    assert.equal(reraised, 'SIGTERM')
    assert.equal(tombstoneAtRaise, true)
    assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
    assert.ok((await journalLines()).some(event => event.type === 'deleted' && event.sessionId === chat.id))
  } finally {
    process.kill = kill
    for (const name of ['exit', 'SIGTERM', 'SIGINT']) {
      for (const listener of process.listeners(name)) {
        if (!before[name].has(listener)) process.off(name, listener)
      }
    }
    for (const [key, value] of saved) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})

test('an exit fsync failure deletes nothing', () => withFreshProcessCleanup(async () => {
  const chat = fakeSession('session-exit-fsync-failure', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  const original = fs.fsyncSync
  const before = new Set(process.listeners('SIGTERM'))
  const kill = process.kill
  let reraised
  try {
    fs.fsyncSync = () => { throw new Error('fsync failed') }
    syncBuiltinESMExports()
    process.kill = (_pid, signal) => { reraised = signal; return true }
    installExitCleanup(() => h.temp.exitSnapshot(), h.deps.logger, journalFile)
    const handler = process.listeners('SIGTERM').find(listener => !before.has(listener))
    assert.ok(handler)
    handler('SIGTERM')
  } finally {
    process.kill = kill
    fs.fsyncSync = original
    syncBuiltinESMExports()
  }
  assert.equal(reraised, 'SIGTERM')
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok((await journalLines()).some(event => event.type === 'deleted' && event.sessionId === chat.id))
  const restarted = harness({ stored: [chat.header] })
  await restarted.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
}))

test('the process exit event deletes nothing on fsync failure', () => withFreshProcessCleanup(async addedExitListeners => {
  const chat = fakeSession('session-exit-event-fsync-failure', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  const original = fs.fsyncSync
  try {
    fs.fsyncSync = () => { throw new Error('fsync failed') }
    syncBuiltinESMExports()
    installExitCleanup(() => h.temp.exitSnapshot(), h.deps.logger, journalFile)
    const listener = addedExitListeners()[0]
    assert.ok(listener)
    listener()
  } finally {
    fs.fsyncSync = original
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok((await journalLines()).some(event => event.type === 'deleted' && event.sessionId === chat.id))
  const restarted = harness({ stored: [chat.header] })
  await restarted.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
}))

test('closing admission refuses new temporary writes', async () => {
  const chat = fakeSession('session-admission', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  h.temp.closeAdmission()
  await assert.rejects(h.temp.register({ sessionId: chat.id }), /admission is closed/)
})

test('exit cleanup writes its tombstone before removal', async () => {
  const chat = fakeSession('session-exit-tombstone', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  const snapshot = h.temp.exitSnapshot()
  const later = fakeSession('session-after-snapshot', { createdAt: 2 })
  h.live.set(later.id, later)
  await h.temp.register({ sessionId: later.id })
  const laterDir = await materializeSession(later.id)
  assert.equal(cleanupSnapshotSync(snapshot, h.deps.logger, journalFile), 1)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
  assert.equal(existsSync(join(laterDir, 'session.v4.jsonl.zstd')), true)
  assert.ok((await journalLines()).some(event => event.type === 'deleted' && event.sessionId === chat.id))
})

test('a journal failure blocks ordinary exit', async () => {
  const chat = fakeSession('session-exit-failure', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  const badJournal = join(stateDir, 'not-a-journal')
  await mkdir(badJournal, { recursive: true })
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot(), h.deps.logger, badJournal), 0)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('a signal leaves a finishable journal', async () => {
  const chat = fakeSession('session-signal', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: Date.now(),
  })
  const restarted = harness({ stored: [chat.header] })
  await restarted.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
})

test('unload deletes only idle pending members', async () => {
  const ended = fakeSession('session-unload-ended', { createdAt: 1 })
  const registry = { running: [ended.id] }
  const h = harness({ sessions: new Map([[ended.id, ended]]), registry })
  await h.temp.register({ sessionId: ended.id })
  const dir = await materializeSession(ended.id)
  await h.temp.discard({ sessionId: ended.id })
  await h.temp.cleanupPending()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  registry.running = []
  await h.temp.cleanupPending()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
})

test('an announcement before prune keeps its anchor', async () => {
  const parent = fakeSession('session-queue-parent', { createdAt: 1 })
  const child = fakeSession('session-queue-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const dir = await materializeSession(parent.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 102 })
  const h = harness({ stored: [parent.header, child.header] })
  h.temp.pending.push(child)
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.equal(h.temp.state.sessions[parent.id].pendingDelete, false)
  assert.ok((await journalLines()).some(event => event.type === 'owned' && event.sessionId === parent.id))
})

test('pruning keeps every needed entry', async () => {
  const now = Date.now()
  const old = now - 31 * 24 * 60 * 60 * 1000
  const parent = fakeSession('session-prune-parent', { createdAt: 1 })
  const child = fakeSession('session-prune-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const reserved = 'session-prune-reserved'
  const dropped = 'session-prune-dropped'
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id], at: now,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null, dir: join(root, 'sessions', 'project', parent.id), cwd: '/tmp/project', at: now,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: [parent.id], reason: 'discard', at: now })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id, dir: join(root, 'sessions', 'project', child.id), cwd: '/tmp/project', at: now,
  })
  await appendJournalEvent(journalFile, { type: 'reserved', sessionId: reserved, workspaceId: null, cwd: null, at: now })
  await appendJournalEvent(journalFile, { type: 'reserved', sessionId: dropped, workspaceId: null, cwd: null, at: now })
  await appendJournalEvent(journalFile, { type: 'reservationDropped', sessionId: dropped, at: now })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: 'session-prune-old', kind: 'main', parentSessionId: null, dir: join(root, 'sessions', 'project', 'session-prune-old'), cwd: null, at: old,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: 'session-prune-young', kind: 'main', parentSessionId: null, dir: join(root, 'sessions', 'project', 'session-prune-young'), cwd: null, at: now,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: now })
  const h = harness({ sessions: new Map([[reserved, fakeSession(reserved, { createdAt: 1 })]]) })
  await h.temp.load()
  await h.temp.pruneJournal(new Map([[child.id, child.header]]))
  const lines = await journalLines()
  assert.deepEqual(lines.filter(event => event.type === 'migration' || event.type === 'migrationComplete').length, 2)
  assert.ok(lines.some(event => event.type === 'owned' && event.sessionId === parent.id))
  assert.ok(lines.some(event => event.type === 'pending' && event.sessionIds.includes(parent.id)))
  assert.ok(lines.some(event => event.type === 'owned' && event.sessionId === child.id))
  assert.ok(lines.some(event => event.type === 'reserved' && event.sessionId === reserved))
  assert.equal(lines.some(event => event.sessionId === dropped), false)
  assert.equal(lines.some(event => event.sessionId === 'session-prune-old'), false)
  assert.ok(lines.some(event => event.sessionId === 'session-prune-young'))
})

test('the reservation precedes and matches the create', async () => {
  const stored = []
  const h = harness({ stored })
  await h.temp.load()
  assert.deepEqual((await journalLines()).map(event => event.type), ['migration', 'migrationComplete'])
  const reserved = await h.temp.reserve({ workspaceId: 'ws-1', cwd: '/tmp/project' })
  assert.match(reserved.sessionId, /^session-/)
  const afterReserve = await journalLines()
  assert.deepEqual(afterReserve.slice(2), [
    { type: 'reserved', sessionId: reserved.sessionId, workspaceId: 'ws-1', cwd: '/tmp/project', at: reserved.at },
  ])
  const created = { id: reserved.sessionId, cwd: '/tmp/project', createdAt: reserved.at + 1 }
  // The Host's create sees the reservation already durable, and the plugin's id
  // reaches it: this is the contract the browser half passes through.
  const createCalls = []
  async function createSession(request) {
    assert.deepEqual((await journalLines()).at(-1), {
      type: 'reserved',
      sessionId: reserved.sessionId,
      workspaceId: 'ws-1',
      cwd: '/tmp/project',
      at: reserved.at,
    })
    createCalls.push(request)
    stored.push(created)
    h.live.set(created.id, fakeSession(created.id, { createdAt: created.createdAt }))
    return { sessionId: created.id }
  }
  const createdSession = await createSession({ workspaceId: 'ws-1', sessionId: reserved.sessionId })
  assert.deepEqual(createCalls, [{ workspaceId: 'ws-1', sessionId: reserved.sessionId }])
  const record = await h.temp.register({ sessionId: createdSession.sessionId })
  assert.deepEqual(record, { sessionId: reserved.sessionId, createdAt: created.createdAt, kind: 'main', pendingDelete: false })
  const lines = await journalLines()
  assert.deepEqual(lines.map(event => event.type), ['migration', 'migrationComplete', 'reserved', 'owned'])
  const owned = lines.at(-1)
  assert.deepEqual(owned, {
    type: 'owned',
    sessionId: reserved.sessionId,
    kind: 'main',
    parentSessionId: null,
    dir: sessionDirOf(reserved.sessionId),
    cwd: '/tmp/project',
    at: owned.at,
  })
  assert.ok(Number.isSafeInteger(owned.at))
  assert.deepEqual(h.temp.exitSnapshot().sessions.map(item => item.sessionId), [reserved.sessionId])

  // A stored header that disagrees with the reservation is never promoted.
  const mismatch = await h.temp.reserve({ workspaceId: 'ws-1', cwd: '/tmp/project' })
  const otherCwd = { id: mismatch.sessionId, cwd: '/tmp/other', createdAt: mismatch.at + 1 }
  stored.push(otherCwd)
  h.live.set(otherCwd.id, fakeSession(otherCwd.id, { createdAt: otherCwd.createdAt }))
  await assert.rejects(h.temp.register({ sessionId: otherCwd.id }), /does not match its reservation/)
  const after = await journalLines()
  assert.equal(after.some(event => event.type === 'owned' && event.sessionId === mismatch.sessionId), false)
  assert.equal(after.some(event => event.type === 'reservationDropped' && event.sessionId === mismatch.sessionId), false)
})

test('an ambiguous create retains the reservation', async () => {
  const stored = []
  const h = harness({ stored })
  await h.temp.load()
  // DSH created the Session, then the workspace attach failed: the plugin cannot
  // tell whether the transcript exists, so the reservation stays.
  const reserved = await h.temp.reserve({ workspaceId: 'ws-1', cwd: '/tmp/project' })
  stored.push({ id: reserved.sessionId, cwd: '/tmp/project', createdAt: reserved.at + 1 })
  h.live.set(reserved.sessionId, fakeSession(reserved.sessionId, { createdAt: reserved.at + 1 }))
  let lines = await journalLines()
  assert.equal(lines.some(event => event.type === 'owned'), false)
  assert.equal(lines.some(event => event.type === 'reservationDropped'), false)
  // The next start resolves it from the matching stored header.
  const restarted = new TemporarySessions(h.deps)
  await restarted.load()
  lines = await journalLines()
  assert.equal(lines.filter(event => event.type === 'owned').length, 1)
  assert.equal(lines.some(event => event.type === 'reservationDropped'), false)
  assert.deepEqual(restarted.exitSnapshot().sessions.map(item => item.sessionId), [reserved.sessionId])

  // A crash before create leaves no folder, and the next start drops the
  // reservation only once every check reports absence.
  const crashed = await h.temp.reserve({ workspaceId: 'ws-1', cwd: '/tmp/project' })
  assert.equal(existsSync(sessionDirOf(crashed.sessionId)), false)
  const afterCrash = new TemporarySessions(h.deps)
  await afterCrash.load()
  lines = await journalLines()
  assert.deepEqual(lines.filter(event => event.type === 'reservationDropped').map(event => event.sessionId), [crashed.sessionId])
  assert.equal(existsSync(sessionDirOf(crashed.sessionId)), false)

  // A Session that already has the reserved id is refused and never touched.
  const existing = fakeSession('session-existing', { createdAt: 90 })
  const beforeCount = (await journalLines()).length
  const liveHarness = harness({ sessions: new Map([[existing.id, existing]]), stored: [existing.header] })
  await liveHarness.temp.load()
  await assert.rejects(liveHarness.temp.reserve({ sessionId: existing.id, cwd: '/tmp/project' }), /already live/)
  const storedHarness = harness({ stored: [existing.header] })
  await storedHarness.temp.load()
  await assert.rejects(storedHarness.temp.reserve({ sessionId: existing.id, cwd: '/tmp/project' }), /already has the reserved id/)
  assert.equal((await journalLines()).length, beforeCount)
})

test('a skipped header is not absence', async () => {
  const h = harness()
  await h.temp.load()
  const reserved = await h.temp.reserve({ cwd: '/tmp/project' })
  await materializeSession(reserved.sessionId)
  // A listing succeeds but silently skips the corrupt header, the way the JSONL
  // backend does, and a direct stat reports the corruption.
  h.deps.sessionPersistence.list = async () => []
  h.deps.sessionPersistence.stat = async id => {
    throw Object.assign(new Error(`session "${id}": stored log is corrupt`), { name: 'SessionPersistenceCorruptionError' })
  }
  const restarted = new TemporarySessions(h.deps)
  await restarted.load()
  let lines = await journalLines()
  assert.equal(lines.some(event => event.type === 'reservationDropped'), false)
  assert.equal(lines.some(event => event.type === 'owned'), false)
  assert.ok(warnings.some(message => message.includes('could not be read')))

  // The store cannot even see the header, but the artifact on disk can: all three
  // signals must agree before the reservation is dropped.
  h.deps.sessionPersistence.stat = async () => undefined
  const blind = new TemporarySessions(h.deps)
  await blind.load()
  lines = await journalLines()
  assert.equal(lines.some(event => event.type === 'reservationDropped'), false)
  assert.ok(warnings.some(message => message.includes('its storage artifact exists')))
})

test('the mark-existing window stays permanent', async () => {
  const ordinary = fakeSession('session-ordinary', { createdAt: 10 })
  const chat = fakeSession('session-chat', { createdAt: 20 })
  const h = harness({
    sessions: new Map([[ordinary.id, ordinary], [chat.id, chat]]),
    stored: [ordinary.header, chat.header],
  })
  // The user made one open chat temporary; the browser crashed before it could
  // register the other one, so that Session must stay permanent.
  await h.temp.register({ sessionId: chat.id })
  const ordinaryDir = await materializeSession(ordinary.id)
  const chatDir = await materializeSession(chat.id)
  const snapshot = h.temp.exitSnapshot()
  assert.deepEqual(snapshot.sessions.map(item => item.sessionId), [chat.id])
  assert.equal(cleanupSnapshotSync(snapshot), 1)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(ordinaryDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  // A restart does not adopt the Session either: only registration owns it.
  const next = new TemporarySessions(h.deps)
  await next.reap()
  assert.equal(await readFile(join(ordinaryDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).sessions[ordinary.id], undefined)
})

test('the owned event lands before the transcript', async () => {
  const session = fakeSession('session-transcript', { createdAt: 100 })
  const h = harness({ sessions: new Map([[session.id, session]]) })
  let journalDuringFlush
  h.temp.deps.sessions.flush = async () => {
    journalDuringFlush = (await journalLines()).map(event => event.type)
    return true
  }
  await h.temp.register({ sessionId: session.id })
  assert.deepEqual(journalDuringFlush.slice(-1), ['owned'])
  // A failed journal append refuses registration before the transcript is flushed.
  const refused = fakeSession('session-unowned', { createdAt: 200 })
  h.live.set(refused.id, refused)
  await rm(journalFile, { force: true })
  await mkdir(journalFile, { recursive: true })
  let flushed = false
  h.temp.deps.sessions.flush = async () => { flushed = true; return true }
  await assert.rejects(h.temp.register({ sessionId: refused.id }), /EISDIR|illegal operation/)
  assert.equal(flushed, false)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[refused.id], undefined)
})

test('the migration resumes after every boundary', async () => {
  const first = fakeSession('session-legacy-one', { createdAt: 100 })
  const second = fakeSession('session-legacy-two', { createdAt: 200 })
  const stored = [first.header, second.header]
  const legacy = {
    [first.id]: legacyRecord(first),
    [second.id]: legacyRecord(second),
  }
  /** A pre-journal install: a registry, its two artifacts, and a journal prefix. */
  async function install(prefix) {
    await rm(stateDir, { recursive: true, force: true })
    await rm(join(root, 'sessions'), { recursive: true, force: true })
    await materializeSession(first.id)
    await materializeSession(second.id)
    await writeRegistry(legacy)
    for (const event of prefix) await appendJournalEvent(journalFile, event)
  }
  const migrationAt = 7000

  // A crash right after the migration event.
  await install([{ type: 'migration', ids: [first.id, second.id], preexisting: [], at: migrationAt }])
  const afterMigration = harness({ stored })
  await afterMigration.temp.load()
  let lines = await journalLines()
  assert.equal(lines.filter(event => event.type === 'migration').length, 1)
  assert.equal(lines.find(event => event.type === 'migration').at, migrationAt)
  assert.equal(lines.filter(event => event.type === 'migrationComplete').length, 1)
  assert.deepEqual(lines.filter(event => event.type === 'owned').map(event => event.sessionId).sort(), [first.id, second.id].sort())
  assert.deepEqual((await afterMigration.temp.list()).sessions.map(item => item.sessionId).sort(), [first.id, second.id].sort())
  assert.deepEqual(JSON.parse(await readFile(markerFile, 'utf8')), {
    version: 1,
    migrationAt,
    completedAt: lines.find(event => event.type === 'migrationComplete').at,
  })

  // A crash after the first import.
  await install([
    { type: 'migration', ids: [first.id, second.id], preexisting: [], at: migrationAt },
    { type: 'owned', sessionId: first.id, kind: 'main', parentSessionId: null, dir: sessionDirOf(first.id), cwd: '/tmp/project', at: migrationAt + 1 },
  ])
  const afterImport = harness({ stored })
  await afterImport.temp.load()
  lines = await journalLines()
  assert.equal(lines.filter(event => event.type === 'migration').length, 1)
  assert.equal(lines.find(event => event.type === 'migration').at, migrationAt)
  assert.deepEqual(lines.filter(event => event.type === 'owned').map(event => event.sessionId), [first.id, second.id])
  assert.equal(lines.filter(event => event.type === 'migrationComplete').length, 1)
  assert.deepEqual((await afterImport.temp.list()).sessions.map(item => item.sessionId).sort(), [first.id, second.id].sort())
  assert.equal(lines.some(event => event.type === 'reservationDropped'), false)
})

test('the migration marker completes after the imports', async () => {
  const first = fakeSession('session-marker-one', { createdAt: 100 })
  const second = fakeSession('session-marker-two', { createdAt: 200 })
  const stored = [first.header, second.header]
  await materializeSession(first.id)
  await materializeSession(second.id)
  await writeRegistry({ [first.id]: legacyRecord(first), [second.id]: legacyRecord(second) })
  const migrationAt = 8000
  const completedAt = 9000
  await appendJournalEvent(journalFile, { type: 'migration', ids: [first.id, second.id], preexisting: [], at: migrationAt })
  for (const session of [first, second]) {
    await appendJournalEvent(journalFile, { type: 'owned', sessionId: session.id, kind: 'main', parentSessionId: null, dir: sessionDirOf(session.id), cwd: '/tmp/project', at: migrationAt + 1 })
  }
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: completedAt })
  const before = (await journalLines()).length
  const h = harness({ stored })
  await h.temp.load()
  // The journal is untouched: no new cutoff, no re-import, no second completion.
  assert.equal((await journalLines()).length, before)
  assert.deepEqual(JSON.parse(await readFile(markerFile, 'utf8')), { version: 1, migrationAt, completedAt })
  assert.deepEqual((await h.temp.list()).sessions.map(item => item.sessionId).sort(), [first.id, second.id].sort())

  // The marker writer itself refuses to claim completion before the journal records it.
  await rm(stateDir, { recursive: true, force: true })
  await appendJournalEvent(journalFile, { type: 'migration', ids: [], preexisting: [], at: migrationAt })
  assert.throws(() => writeJournalMarker(
    { journal: journalFile, marker: markerFile },
    { migrationAt, completedAt },
  ), /migrationComplete/)
  await assert.rejects(readFile(markerFile, 'utf8'), /ENOENT/)
})

test('the migration repairs a collapsed legacy parent to the header direct parent', async () => {
  const grand = fakeSession('session-grand', { createdAt: 1 })
  const parent = fakeSession('session-parent', { origin: 'subagent', parentSession: grand.id, createdAt: 2 })
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: parent.id, createdAt: 3 })
  await materializeSession(child.id)
  // The old recorder stored the nearest recorded ancestor, not the true direct parent.
  await writeRegistry({ [child.id]: legacyRecord(child, 'subagent', grand.id) })
  const h = harness({ stored: [grand.header, parent.header, child.header] })
  await h.temp.load()
  const owned = (await journalLines()).find(event => event.type === 'owned' && event.sessionId === child.id)
  assert.equal(owned.parentSessionId, parent.id)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[child.id].parentSessionId, parent.id)
})

test('a legacy side row keeps its side kind through migration and exit cleanup', async () => {
  const source = fakeSession('session-side-source', { createdAt: 1 })
  const side = fakeSession('session-side', { isSeeded: true, parentSession: source.id, createdAt: 2 })
  const dir = await materializeSession(side.id)
  await writeRegistry({ [side.id]: legacyRecord(side, 'side', source.id) })
  const h = harness({ stored: [source.header, side.header] })
  await h.temp.load()
  const owned = (await journalLines()).find(event => event.type === 'owned' && event.sessionId === side.id)
  assert.equal(owned.kind, 'side')
  assert.deepEqual(h.temp.exitSnapshot().sessions.map(item => item.sessionId), [side.id])
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 1)
  await assert.rejects(readFile(join(dir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('a child announced while the first migration is deferred is adopted on restart', async () => {
  const parent = fakeSession('session-deferred-parent', { createdAt: 1 })
  const child = fakeSession('session-deferred-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await writeRegistry({ [parent.id]: legacyRecord(parent) })
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: sessionDirOf(parent.id), cwd: '/tmp/project', at: 101,
  })
  const deferred = harness({ sessions: new Map([[child.id, child]]), stored: [parent.header, child.header] })
  deferred.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
  await deferred.temp.load()
  assert.equal(deferred.temp.migrationIncomplete, true)
  await deferred.temp.recordDescendant(child)
  assert.equal((await journalLines()).some(event => event.type === 'owned' && event.sessionId === child.id), false)

  const restarted = harness({ stored: [parent.header, child.header] })
  await restarted.temp.load()
  const owned = (await journalLines()).find(event => event.type === 'owned' && event.sessionId === child.id)
  assert.equal(owned.parentSessionId, parent.id)
  assert.equal(restarted.temp.migrationIncomplete, false)
  await restarted.temp.reap()
  await assert.rejects(readFile(join(parentDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('an interrupted collapsed-parent migration repairs the registry on resume', async () => {
  const grand = fakeSession('session-resume-grand', { createdAt: 1 })
  const parent = fakeSession('session-resume-parent', { origin: 'subagent', parentSession: grand.id, createdAt: 2 })
  const child = fakeSession('session-resume-child', { origin: 'subagent', parentSession: parent.id, createdAt: 3 })
  const childDir = await materializeSession(child.id)
  await writeRegistry({ [child.id]: legacyRecord(child, 'subagent', grand.id) })
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [child.id], preexisting: [grand.id, parent.id, child.id], at: 100,
  })
  // The owned event is durable, but the migration did not complete and the corrected registry never published.
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
    dir: childDir, cwd: '/tmp/project', at: 101,
  })
  const h = harness({ stored: [grand.header, parent.header, child.header] })
  await h.temp.load()
  assert.notEqual(h.temp.journal.migrationComplete, undefined)
  assert.equal(h.temp.state.sessions[child.id].parentSessionId, parent.id)
  assert.deepEqual(h.temp.exitSnapshot().sessions.map(item => item.sessionId), [child.id])
  await h.temp.reap()
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('an adopted child of a pending parent inherits pending and is cleaned up', async () => {
  const parent = fakeSession('session-pending-parent', { createdAt: 1 })
  const child = fakeSession('session-pending-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await writeRegistry({ [parent.id]: { ...legacyRecord(parent), pendingDelete: true } })
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: [parent.id], reason: 'discard', at: 102 })
  const h = harness({ stored: [parent.header, child.header] })
  await h.temp.load()
  assert.equal(h.temp.journal.entries[child.id].pending, true)
  assert.equal(h.temp.state.sessions[child.id].pendingDelete, true)
  await h.temp.cleanupPending()
  await assert.rejects(readFile(join(parentDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('a lost pending event on an adopted child is repaired on the next load', async () => {
  const parent = fakeSession('session-pending-repair-parent', { createdAt: 1 })
  const child = fakeSession('session-pending-repair-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await writeRegistry({
    [parent.id]: { ...legacyRecord(parent), pendingDelete: true },
    [child.id]: legacyRecord(child, 'subagent', parent.id),
  })
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: [parent.id], reason: 'discard', at: 102 })
  // The child's owned event landed, then the crash lost its inherited pending event.
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
    dir: childDir, cwd: '/tmp/project', at: 103,
  })
  const h = harness({ stored: [parent.header, child.header] })
  await h.temp.load()
  assert.equal(h.temp.journal.entries[child.id].pending, true)
  assert.equal(h.temp.state.sessions[child.id].pendingDelete, true)
  await h.temp.cleanupPending()
  await assert.rejects(readFile(join(parentDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('a stored subagent of a journal-deleted parent is deleted', async () => {
  const parent = fakeSession('session-orphan-parent', { createdAt: 1 })
  const child = fakeSession('session-orphan-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 102,
  })
  const h = harness({ stored: [parent.header, child.header] })
  await h.temp.load()
  const childEvents = (await journalLines())
    .filter(event => event.sessionId === child.id && (event.type === 'owned' || event.type === 'deleted'))
  assert.deepEqual(childEvents.map(event => event.type), ['owned', 'deleted'])
  assert.equal(h.temp.journal.entries[child.id].deleted, true)
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), false)
})

test('a stored-list failure with a live header defers collapsed-parent repair without throwing', async () => {
  const grand = fakeSession('session-live-grand', { createdAt: 1 })
  const parent = fakeSession('session-live-parent', { origin: 'subagent', parentSession: grand.id, createdAt: 2 })
  const child = fakeSession('session-live-child', { origin: 'subagent', parentSession: parent.id, createdAt: 3 })
  const childDir = await materializeSession(child.id)
  await writeRegistry({ [child.id]: legacyRecord(child, 'subagent', grand.id) })
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [child.id], preexisting: [grand.id, parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
    dir: childDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 102 })
  const live = new Map([[child.id, child]])
  const first = harness({ sessions: live, stored: [grand.header, parent.header, child.header] })
  first.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
  await first.temp.load()
  assert.equal(first.temp.state.sessions[child.id].parentSessionId, grand.id)
  assert.deepEqual(first.temp.exitSnapshot().sessions, [])
  assert.equal(await readFile(join(childDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')

  const second = harness({ stored: [grand.header, parent.header, child.header] })
  await second.temp.load()
  assert.equal(second.temp.state.sessions[child.id].parentSessionId, parent.id)
  assert.deepEqual(second.temp.exitSnapshot().sessions.map(item => item.sessionId), [child.id])
  await second.temp.reap()
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('boot cleanup leaves a live subagent transcript until the child is no longer live', async () => {
  const parent = fakeSession('session-live-orphan-parent', { createdAt: 1 })
  const child = fakeSession('session-live-orphan-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 102,
  })
  const first = harness({ sessions: new Map([[child.id, child]]), stored: [parent.header, child.header] })
  await first.temp.reap()
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), true)
  assert.deepEqual(
    (await journalLines()).filter(event => event.sessionId === child.id).map(event => event.type),
    ['owned'],
  )

  const second = harness({ stored: [parent.header, child.header] })
  await second.temp.reap()
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), false)
  assert.deepEqual(
    (await journalLines()).filter(event => event.sessionId === child.id).map(event => event.type),
    ['owned', 'deleted'],
  )
})

test('boot cleanup leaves an already-deleted live subagent transcript', async () => {
  const parent = fakeSession('session-deleted-live-parent', { createdAt: 1 })
  const child = fakeSession('session-deleted-live-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
    dir: childDir, cwd: '/tmp/project', at: 103,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: child.id, kind: 'subagent', parentSessionId: parent.id,
    dir: childDir, cwd: '/tmp/project', at: 104,
  })
  const first = harness({ sessions: new Map([[child.id, child]]), stored: [parent.header, child.header] })
  await first.temp.reap()
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), true)

  const second = harness({ stored: [parent.header, child.header] })
  await second.temp.reap()
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), false)
})

test('reap rechecks liveness after the deleted append', async () => {
  const chat = fakeSession('session-live-after-append', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 102 })
  const h = harness({ stored: [chat.header] })
  await h.temp.load()
  const append = h.temp.appendEvent.bind(h.temp)
  h.temp.appendEvent = async (event) => {
    const result = await append(event)
    if (event.type === 'deleted') h.live.set(chat.id, chat)
    return result
  }
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('became live during deletion')))
  assert.ok(h.temp.state.sessions[chat.id])
})

test('reap keeps an Agent that becomes live during the deleted append', async () => {
  const chat = fakeSession('session-agent-live-after-append', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 102 })
  const h = harness({ stored: [chat.header] })
  let agentLive = false
  h.deps.agents = {
    get: id => (id === chat.id && agentLive ? { status: 'running' } : undefined),
  }
  const append = h.temp.appendEvent.bind(h.temp)
  h.temp.appendEvent = async event => {
    const result = await append(event)
    if (event.type === 'deleted') agentLive = true
    return result
  }
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('Session or Agent became live during deletion')))
  assert.ok(h.temp.state.sessions[chat.id])
})

test('a tombstone keeps a Session that becomes live during its header check', async () => {
  const chat = fakeSession('session-live-during-tombstone-stat', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  const h = harness({ stored: [chat.header] })
  h.deps.sessionPersistence.list = async () => []
  const stat = h.deps.sessionPersistence.stat
  h.deps.sessionPersistence.stat = async id => {
    const snapshot = await stat(id)
    if (id === chat.id) h.live.set(chat.id, chat)
    return snapshot
  }
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('became live during its header check')))
})

test('a tombstone keeps an Agent that becomes live during its header check', async () => {
  const chat = fakeSession('session-agent-live-during-tombstone-stat', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  const h = harness({ stored: [chat.header] })
  h.deps.sessionPersistence.list = async () => []
  let agentLive = false
  h.deps.agents = {
    get: id => (id === chat.id && agentLive ? { status: 'running' } : undefined),
  }
  const stat = h.deps.sessionPersistence.stat
  h.deps.sessionPersistence.stat = async id => {
    const snapshot = await stat(id)
    if (id === chat.id) agentLive = true
    return snapshot
  }
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('Session or Agent became live during its header check')))
})

test('a failed listing keeps a tombstone with a conflicting header', async () => {
  const chat = fakeSession('session-failed-listing', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  const conflicting = { ...chat.header, cwd: '/tmp/conflicting-header' }
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 102,
  })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  const h = harness({ stored: [conflicting] })
  h.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('stored header')))
  assert.ok((await journalLines()).some(event => event.type === 'deleted' && event.sessionId === chat.id))
})

test('a startup pass resumes cancellation for a journal-pending tree', async () => {
  const chat = fakeSession('session-pending-resume', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: [chat.id], reason: 'discard', at: 102 })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  const h = harness({ sessions: new Map([[chat.id, chat]]), stored: [chat.header] })
  await h.temp.reap()
  assert.deepEqual(h.cancelled, [chat.id])
  assert.equal(h.temp.state.sessions[chat.id].pendingDelete, true)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('unload keeps an idle Agent until whenIdle settles', async () => {
  const chat = fakeSession('session-idle-unsettled', { createdAt: 1 })
  const dir = await materializeSession(chat.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [chat.id], preexisting: [chat.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: chat.id, kind: 'main', parentSessionId: null, dir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, { type: 'pending', sessionIds: [chat.id], reason: 'discard', at: 102 })
  await appendJournalEvent(journalFile, { type: 'migrationComplete', at: 103 })
  const agent = { status: 'idle', whenIdle: () => new Promise(() => {}) }
  const h = harness({ stored: [chat.header] })
  h.deps.agents = { get: () => agent }
  await h.temp.cleanupPending()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  agent.whenIdle = async () => {}
  await h.temp.cleanupPending()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
})

test('unload keeps an Agent that becomes active during the deleted append', async () => {
  const chat = fakeSession('session-unload-append-active', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  await h.temp.discard({ sessionId: chat.id })
  const agent = { status: 'idle' }
  h.deps.agents = { get: id => (id === chat.id ? agent : undefined) }
  const append = h.temp.appendEvent.bind(h.temp)
  h.temp.appendEvent = async event => {
    const result = await append(event)
    if (event.type === 'deleted') agent.status = 'running'
    return result
  }
  await h.temp.cleanupPending()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('not confirmed idle after the deleted append')))
  assert.equal(h.temp.state.sessions[chat.id].pendingDelete, true)
  assert.ok((await journalLines()).some(event => event.type === 'deleted' && event.sessionId === chat.id))
})

test('unload keeps an Agent that wakes after whenIdle settles', async () => {
  const chat = fakeSession('session-wake-after-idle', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  await h.temp.discard({ sessionId: chat.id })
  let calls = 0
  const agent = {
    status: 'idle',
    whenIdle: () => {
      calls += 1
      const settled = Promise.resolve()
      if (calls > 1) settled.then(() => { agent.status = 'running' })
      return settled
    },
  }
  h.deps.agents = { get: id => (id === chat.id ? agent : undefined) }
  await h.temp.cleanupPending()
  assert.equal(calls, 2)
  assert.equal(agent.status, 'running')
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('not confirmed idle after the deleted append')))
  assert.equal(warnings.some(message => message.includes('Agent changed before removal')), false)
})

test('unload keeps an Agent that wakes before the final removal guard', async () => {
  const chat = fakeSession('session-wake-before-guard', { createdAt: 1 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  await h.temp.discard({ sessionId: chat.id })
  const agent = { status: 'idle' }
  h.deps.agents = { get: id => (id === chat.id ? agent : undefined) }
  const confirmIdle = h.temp.confirmIdle.bind(h.temp)
  let calls = 0
  h.temp.confirmIdle = async (candidate, sessionId) => {
    const result = await confirmIdle(candidate, sessionId)
    calls += 1
    if (calls === 2 && result === true && candidate !== undefined) {
      queueMicrotask(() => { candidate.status = 'running' })
    }
    return result
  }
  await h.temp.cleanupPending()
  assert.equal(calls, 2)
  assert.equal(agent.status, 'running')
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.ok(warnings.some(message => message.includes('Agent changed before removal')))
  assert.equal(warnings.some(message => message.includes('not confirmed idle after the deleted append')), false)
})

test('unknown or malformed journal events are rejected by replay', () => {
  for (const text of [
    '{"type":"unknown","at":1}\n',
    '{"type":"owned","sessionId":"session-x","kind":"main","cwd":null,"at":1}\n',
    '{"type":"owned","sessionId":"session-x","kind":"main","dir":"/tmp/x","cwd":null,"at":"later"}\n',
  ]) {
    assert.equal(replayJournal(text).degraded, true)
  }
})

test('a child that becomes live during the deleted append keeps its transcript', async () => {
  const parent = fakeSession('session-race-parent', { createdAt: 1 })
  const child = fakeSession('session-race-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 102,
  })
  const h = harness({ stored: [parent.header, child.header] })
  let checks = 0
  const get = h.deps.sessions.get
  h.deps.sessions.get = id => {
    if (id !== child.id) return get(id)
    checks += 1
    // The child becomes live while the durable `deleted` append is awaiting.
    return checks >= 2 ? child : undefined
  }
  await h.temp.reap()
  assert.ok(checks >= 3)
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), true)
  assert.deepEqual(
    (await journalLines()).filter(event => event.sessionId === child.id).map(event => event.type),
    ['owned', 'deleted'],
  )

  const second = harness({ stored: [parent.header, child.header] })
  await second.temp.reap()
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), false)
})

test('a grandchild listed first inherits pending after its parent becomes pending', async () => {
  const root = fakeSession('session-pending-root', { createdAt: 1 })
  const child = fakeSession('session-pending-child', { origin: 'subagent', parentSession: root.id, createdAt: 2 })
  const grand = fakeSession('session-pending-grand', { origin: 'subagent', parentSession: child.id, createdAt: 3 })
  const rootDir = await materializeSession(root.id)
  const childDir = await materializeSession(child.id)
  const grandDir = await materializeSession(grand.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [root.id], preexisting: [root.id, child.id, grand.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: root.id, kind: 'main', parentSessionId: null,
    dir: rootDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'pending', sessionIds: [root.id], reason: 'discard', at: 102,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: child.id, kind: 'subagent', parentSessionId: root.id,
    dir: childDir, cwd: '/tmp/project', at: 103,
  })
  const h = harness({ stored: [grand.header, child.header, root.header] })
  await h.temp.load()
  assert.equal(h.temp.journal.entries[child.id].pending, true)
  assert.equal(h.temp.journal.entries[grand.id].pending, true)
  assert.equal(h.temp.state.sessions[grand.id].pendingDelete, true)
  await h.temp.cleanupPending()
  for (const dir of [rootDir, childDir, grandDir]) {
    assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), false)
  }
})

test('stored descendants reconcile to a fixed point when the grandchild is listed first', async () => {
  const parent = fakeSession('session-fixed-parent', { createdAt: 1 })
  const child = fakeSession('session-fixed-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const grand = fakeSession('session-fixed-grand', { origin: 'subagent', parentSession: child.id, createdAt: 3 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  const grandDir = await materializeSession(grand.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id, grand.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 102,
  })
  const h = harness({ stored: [grand.header, child.header, parent.header] })
  await h.temp.reap()
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), false)
  assert.equal(existsSync(join(grandDir, 'session.v4.jsonl.zstd')), false)
  for (const sessionId of [child.id, grand.id]) {
    assert.deepEqual(
      (await journalLines()).filter(event => event.sessionId === sessionId).map(event => event.type),
      ['owned', 'deleted'],
    )
  }
})

test('stored descendants reconcile to a fixed point when the child is listed first', async () => {
  const parent = fakeSession('session-fixed-first-parent', { createdAt: 1 })
  const child = fakeSession('session-fixed-first-child', { origin: 'subagent', parentSession: parent.id, createdAt: 2 })
  const grand = fakeSession('session-fixed-first-grand', { origin: 'subagent', parentSession: child.id, createdAt: 3 })
  const parentDir = await materializeSession(parent.id)
  const childDir = await materializeSession(child.id)
  const grandDir = await materializeSession(grand.id)
  await appendJournalEvent(journalFile, {
    type: 'migration', ids: [parent.id], preexisting: [parent.id, child.id, grand.id], at: 100,
  })
  await appendJournalEvent(journalFile, {
    type: 'owned', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 101,
  })
  await appendJournalEvent(journalFile, {
    type: 'deleted', sessionId: parent.id, kind: 'main', parentSessionId: null,
    dir: parentDir, cwd: '/tmp/project', at: 102,
  })
  const h = harness({ stored: [child.header, grand.header, parent.header] })
  await h.temp.reap()
  assert.equal(existsSync(join(childDir, 'session.v4.jsonl.zstd')), false)
  assert.equal(existsSync(join(grandDir, 'session.v4.jsonl.zstd')), false)
  for (const sessionId of [child.id, grand.id]) {
    assert.deepEqual(
      (await journalLines()).filter(event => event.sessionId === sessionId).map(event => event.type),
      ['owned', 'deleted'],
    )
  }
})

test('an owned id survives a corrupt registry', async () => {
  const chat = fakeSession('session-owned', { createdAt: 50 })
  const h = harness({ sessions: new Map([[chat.id, chat]]), stored: [chat.header] })
  await h.temp.register({ sessionId: chat.id })
  const dir = await materializeSession(chat.id)
  // The index is corrupted; the journal and the stored header still prove ownership.
  await writeFile(stateFile, '{"version":1,"sessions":{')
  const boot = new TemporarySessions(h.deps)
  await boot.load()
  const snapshot = boot.exitSnapshot()
  assert.equal(snapshot.degraded, false)
  assert.equal(snapshot.sessions.length, 1)
  const { lastActivityAt, activitySince, ...rebuilt } = snapshot.sessions[0]
  for (const clock of [lastActivityAt, activitySince]) assert.ok(Number.isSafeInteger(clock) && clock > 0)
  assert.deepEqual(rebuilt, {
    sessionId: chat.id,
    kind: 'main',
    parentSessionId: null,
    title: '',
    dir,
    cwd: '/tmp/project',
    createdAt: 50,
    pendingDelete: false,
  })
  // The damaged bytes are preserved, and exit removes the rebuilt folder.
  assert.equal(await readFile(stateFile, 'utf8'), '{"version":1,"sessions":{')
  assert.equal(cleanupSnapshotSync(snapshot), 1)
  await assert.rejects(readFile(join(dir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

// --- The process-shared publisher ---

test('a held queued save does not erase a newer publish', async () => {
  const dir = join(root, 'publisher-held')
  const file = join(dir, 'records.json')
  const publisher = new Publisher({ file, lockFile: join(dir, 'records.lock') })
  assert.equal(publisher.publish('{"version":1,"sessions":{"a":1}}\n'), true)
  // A queued save captures its generation and then stages; while it is stalled a
  // mutation and a newer synchronous publish land.
  const held = publisher.begin()
  assert.ok(held !== undefined)
  assert.equal(held.generation, 0)
  publisher.mutate()
  assert.equal(publisher.publish('{"version":1,"sessions":{"a":2}}\n'), true)
  await writeFile(held.staging, '{"version":1,"sessions":{"a":1}}\n')
  assert.equal(publisher.commit(held), false)
  assert.equal(await readFile(file, 'utf8'), '{"version":1,"sessions":{"a":2}}\n')
  assert.equal(publisher.published, 1)
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
})

test('a normal revision after a mutation publishes', async () => {
  const dir = join(root, 'publisher-revision')
  const file = join(dir, 'records.json')
  const publisher = new Publisher({ file, lockFile: join(dir, 'records.lock') })
  assert.equal(publisher.publish('first'), true)
  assert.equal(publisher.published, 0)
  publisher.mutate()
  assert.equal(publisher.generation, 1)
  const ticket = publisher.begin()
  assert.equal(ticket.generation, 1)
  await writeFile(ticket.staging, 'second')
  assert.equal(publisher.commit(ticket), true)
  assert.equal(publisher.published, 1)
  assert.equal(await readFile(file, 'utf8'), 'second')
  publisher.mutate()
  assert.equal(publisher.publish('third'), true)
  assert.equal(publisher.published, 2)
  assert.equal(await readFile(file, 'utf8'), 'third')
})

test('an old module epoch cannot publish after a new one', async () => {
  const generationOne = await import(new URL('../publisher.js?generation=1', import.meta.url).href)
  const generationTwo = await import(new URL('../publisher.js?generation=2', import.meta.url).href)
  assert.notEqual(generationOne.Publisher, generationTwo.Publisher)
  const dir = join(root, 'publisher-epoch')
  const file = join(dir, 'records.json')
  const lockFile = join(dir, 'records.lock')
  const first = new generationOne.Publisher({ file, lockFile })
  assert.equal(first.publish('first'), true)
  // The reload instantiates a new module copy, which increments the shared epoch.
  const second = new generationTwo.Publisher({ file, lockFile })
  assert.ok(second.epoch > first.epoch)
  assert.equal(first.publish('stale'), false)
  assert.equal(await readFile(file, 'utf8'), 'first')
  assert.equal(second.publish('second'), true)
  // The check and the rename are one synchronous section: a ticket captured under
  // the newer epoch cannot commit after an even newer instance fences it.
  const ticket = second.begin()
  const third = new generationOne.Publisher({ file, lockFile })
  assert.ok(third.epoch > second.epoch)
  await writeFile(ticket.staging, 'stale')
  assert.equal(second.commit(ticket), false)
  assert.equal(await readFile(file, 'utf8'), 'second')
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
})

test('a foreign lock refuses and a stale lock is stolen', async () => {
  const dir = join(root, 'publisher-lock')
  const file = join(dir, 'records.json')
  const lockFile = join(dir, 'records.lock')
  await mkdir(dir, { recursive: true })
  // The running test runner's parent is alive and is not this process.
  await writeFile(lockFile, `${process.ppid}\n`)
  const refused = new Publisher({ file, lockFile })
  assert.equal(refused.publish('refused'), false)
  await assert.rejects(readFile(file, 'utf8'), /ENOENT/)
  assert.equal(await readFile(lockFile, 'utf8'), `${process.ppid}\n`)
  // A pid that has exited is not a writer any more.
  const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.ok(exited.pid > 0)
  await writeFile(lockFile, `${exited.pid}\n`)
  const stolen = new Publisher({ file, lockFile })
  assert.equal(stolen.publish('stolen'), true)
  assert.equal(await readFile(file, 'utf8'), 'stolen')
  assert.equal(await readFile(lockFile, 'utf8'), `${process.pid}\n`)
  // A lock left empty by a crash between create and pid write is stale, not a live writer.
  await writeFile(lockFile, '')
  const malformed = new Publisher({ file, lockFile })
  assert.equal(malformed.publish('malformed'), true)
  assert.equal(await readFile(file, 'utf8'), 'malformed')
  assert.equal(await readFile(lockFile, 'utf8'), `${process.pid}\n`)
})

test('the tree walk crosses fork boundaries', async () => {
  const chat = fakeSession('session-chat', { createdAt: 10 })
  const fork = fakeSession('session-fork', { isSeeded: true, parentSession: chat.id, createdAt: 20 })
  const forkOfFork = fakeSession('session-fork2', { isSeeded: true, parentSession: fork.id, createdAt: 30 })
  const underFork = fakeSession('session-sub', { origin: 'subagent', parentSession: fork.id, createdAt: 40 })
  const underSub = fakeSession('session-sub2', { origin: 'subagent', parentSession: underFork.id, createdAt: 50 })
  const stranger = fakeSession('session-stranger', { createdAt: 60 })
  const record = (session, kind, parentSessionId) => recordFields({
    sessionId: session.id,
    kind,
    parentSessionId,
    dir: sessionDirOf(session.id),
    cwd: '/tmp/project',
    createdAt: session.header.createdAt,
  }, NOW)
  await writeRegistry({
    [chat.id]: record(chat, 'main', null),
    [fork.id]: record(fork, 'fork', chat.id),
    [forkOfFork.id]: record(forkOfFork, 'fork', fork.id),
    [underFork.id]: record(underFork, 'subagent', fork.id),
    [underSub.id]: record(underSub, 'subagent', underFork.id),
    [stranger.id]: record(stranger, 'main', null),
  })
  const h = harness({ stored: [chat.header, fork.header, forkOfFork.header, underFork.header, underSub.header, stranger.header] })
  await h.temp.load()
  assert.deepEqual(
    h.temp.descendantRecords(chat.id).map(item => item.sessionId).sort(),
    [fork.id, forkOfFork.id, underFork.id, underSub.id].sort(),
  )
  assert.deepEqual(h.temp.descendantRecords(fork.id).map(item => item.sessionId).sort(), [forkOfFork.id, underFork.id, underSub.id].sort())
  assert.deepEqual(h.temp.descendantRecords(underFork.id).map(item => item.sessionId), [underSub.id])
  assert.deepEqual(h.temp.descendantRecords(stranger.id), [])
})

// --- The validated exit snapshot and the degraded flags ---

test('a failed child save still reaches the exit snapshot', async () => {
  const chat = fakeSession('session-chat', { createdAt: 10 })
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id, createdAt: 20 })
  const h = harness({ sessions: new Map([[chat.id, chat], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  const before = h.temp.exitSnapshot()
  const save = h.temp.save
  let failures = 1
  h.temp.save = async function failOnce() {
    if (failures > 0) {
      failures -= 1
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    return save.call(this)
  }
  await assert.rejects(h.temp.recordDescendant(child), /ENOSPC/)
  const after = h.temp.exitSnapshot()
  // A separate immutable generation, not the live registry object.
  assert.notEqual(after, before)
  assert.ok(Object.isFrozen(after))
  assert.ok(Object.isFrozen(after.sessions))
  assert.ok(after.sessions.every(item => Object.isFrozen(item)))
  assert.notEqual(after.sessions[0], h.temp.state.sessions[chat.id])
  assert.deepEqual(after.sessions.map(item => item.sessionId), [chat.id, child.id])
  // The durable published generation lags: the child's registry write failed.
  const onDisk = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(onDisk.sessions[child.id], undefined)
  assert.ok(h.temp.publisher.generation > h.temp.publisher.published)
})

test('the installed exit callback uses the failed-save child', () => withFreshProcessCleanup(async addedExitListeners => {
  const chat = fakeSession('session-chat', { createdAt: 10 })
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id, createdAt: 20 })
  const h = harness({ sessions: new Map([[chat.id, chat], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  const save = h.temp.save
  let failures = 1
  h.temp.save = async function failOnce() {
    if (failures > 0) {
      failures -= 1
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    return save.call(this)
  }
  await assert.rejects(h.temp.recordDescendant(child), /ENOSPC/)
  installExitCleanup(() => h.temp.exitSnapshot(), undefined)
  // The registry names a permanent Session: the handler must not read it.
  const controlDir = await materializeSession('session-permanent-control')
  await writeRegistry({ 'session-permanent-control': legacyRecord(fakeSession('session-permanent-control', { createdAt: 1 })) })
  assert.equal(addedExitListeners().length, 1)
  addedExitListeners()[0]()
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(controlDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
}))

test('runtime corruption does not un-validate the snapshot', async () => {
  const chat = fakeSession('session-chat', { createdAt: 10 })
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  await h.temp.register({ sessionId: chat.id })
  const chatDir = await materializeSession(chat.id)
  const controlDir = await materializeSession('session-permanent-control')
  assert.equal(h.temp.exitSnapshot().degraded, false)
  // The index is corrupted after the snapshot was validated.
  await writeFile(stateFile, '{oops')
  assert.equal(await h.temp.save(), false)
  assert.equal(await readFile(stateFile, 'utf8'), '{oops')
  const snapshot = h.temp.exitSnapshot()
  assert.equal(snapshot.degraded, false)
  assert.deepEqual(snapshot.sessions.map(item => item.sessionId), [chat.id])
  // Exit deletes the validated temporary chat and preserves the permanent control.
  assert.equal(cleanupSnapshotSync(snapshot), 1)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(controlDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
})

test('exit after unload uses the snapshot', () => withFreshProcessCleanup(async addedExitListeners => {
  const chat = fakeSession('session-chat', { createdAt: 10 })
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id, createdAt: 20 })
  const h = harness({ sessions: new Map([[chat.id, chat], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(child)
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  installExitCleanup(() => h.temp.exitSnapshot(), undefined)
  await h.temp.cleanupPending()
  // The unload disposed the plugin instance; its validated snapshot stays bound.
  assert.notEqual(globalThis[EXIT_SNAPSHOT_KEY], undefined)
  const controlDir = await materializeSession('session-permanent-control')
  await writeRegistry({ 'session-permanent-control': legacyRecord(fakeSession('session-permanent-control', { createdAt: 1 })) })
  assert.equal(addedExitListeners().length, 1)
  addedExitListeners()[0]()
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(controlDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
}))

test('the degraded flags fail closed', async () => {
  // A broken journal: no write of any kind, and the exit deletion set is empty.
  const chat = fakeSession('session-chat', { createdAt: 10 })
  await mkdir(stateDir, { recursive: true })
  await writeFile(journalFile, `{"type":"owned","sessionId":"session-chat","kind":"main","parentSessionId":null,"dir":"${sessionDirOf(chat.id)}","cwd":null,"at":1}\nnot an event\n`)
  const h = harness({ sessions: new Map([[chat.id, chat]]) })
  const chatDir = await materializeSession(chat.id)
  await assert.rejects(h.temp.register({ sessionId: chat.id }), /journal is degraded/)
  await assert.rejects(h.temp.reserve({ cwd: '/tmp/project' }), /journal is degraded/)
  await assert.rejects(h.temp.discard({ sessionId: chat.id }), /journal is degraded/)
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 0)
  assert.equal((await readFile(journalFile, 'utf8')).split('\n').filter(Boolean).length, 2)
  assert.equal(await readFile(join(chatDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  assert.equal((await h.temp.list()).degraded, true)

  // A damaged registry: journal-based recovery continues, registry writes refuse.
  await rm(stateDir, { recursive: true, force: true })
  const chatB = fakeSession('session-chat-b', { createdAt: 10 })
  const childB = fakeSession('session-child-b', { origin: 'subagent', parentSession: chatB.id, createdAt: 20 })
  const first = harness({
    sessions: new Map([[chatB.id, chatB], [childB.id, childB]]),
    stored: [chatB.header],
  })
  await first.temp.register({ sessionId: chatB.id })
  const chatBDir = await materializeSession(chatB.id)
  const childBDir = await materializeSession(childB.id)
  await writeFile(stateFile, '{damaged')
  const boot = new TemporarySessions(first.deps)
  await boot.load()
  assert.equal(boot.registryDegraded, true)
  assert.deepEqual(boot.exitSnapshot().sessions.map(item => item.sessionId), [chatB.id])
  assert.equal(await boot.save(), false)
  assert.equal(await readFile(stateFile, 'utf8'), '{damaged')
  // A new trusted observation still reaches the journal, and the snapshot keeps it.
  await boot.recordDescendant(childB)
  assert.ok((await journalLines()).some(event => event.type === 'owned' && event.sessionId === childB.id))
  assert.deepEqual(boot.exitSnapshot().sessions.map(item => item.sessionId), [chatB.id, childB.id])
  assert.equal(cleanupSnapshotSync(boot.exitSnapshot()), 2)
  await assert.rejects(readFile(join(chatBDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(childBDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(stateFile, 'utf8'), '{damaged')
})

test('the list result carries epoch, sequence and stopping', async () => {
  const chat = fakeSession('session-chat', { createdAt: 10 })
  const child = fakeSession('session-child', { origin: 'subagent', parentSession: chat.id, createdAt: 20 })
  const h = harness({ sessions: new Map([[chat.id, chat], [child.id, child]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(child)
  assert.deepEqual(await h.temp.list(), {
    epoch: h.temp.publisher.epoch,
    sequence: 1,
    degraded: false,
    stopping: [],
    sessions: [{ sessionId: chat.id, createdAt: 10, kind: 'main', pendingDelete: false }],
  })
  await h.temp.discard({ sessionId: chat.id })
  assert.deepEqual(await h.temp.list(), {
    epoch: h.temp.publisher.epoch,
    sequence: 2,
    degraded: false,
    stopping: [{ sessionId: chat.id, kind: 'main' }],
    sessions: [{ sessionId: chat.id, createdAt: 10, kind: 'main', pendingDelete: true }],
  })
})

test('boot reap refuses a registry row with no journal ownership', async () => {
  const session = fakeSession('session-unowned', { createdAt: 10 })
  const dir = await materializeSession(session.id)
  await writeRegistry({ [session.id]: legacyRecord(session) })
  const h = harness()
  await h.temp.load()
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.notEqual(h.temp.state.sessions[session.id], undefined)
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
})

test('boot reap deletes nothing while the journal is degraded', async () => {
  const session = fakeSession('session-degraded', { createdAt: 10 })
  const dir = await materializeSession(session.id)
  await writeRegistry({ [session.id]: legacyRecord(session) })
  await mkdir(stateDir, { recursive: true })
  await writeFile(journalFile, 'not an event\n')
  const h = harness()
  await h.temp.load()
  await h.temp.reap()
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
  assert.equal((await h.temp.list()).degraded, true)
})

test('an unowned registry parent cannot mint child ownership', async () => {
  const parent = fakeSession('session-unowned-parent', { createdAt: 10 })
  const child = fakeSession('session-unowned-child', { origin: 'subagent', parentSession: parent.id, createdAt: 20 })
  await writeRegistry({ [parent.id]: legacyRecord(parent) })
  const h = harness({ sessions: new Map([[child.id, child]]) })
  await h.temp.load()
  await h.temp.recordDescendant(child)
  assert.equal((await journalLines()).some(event => event.type === 'owned' && event.sessionId === child.id), false)
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
})

test('the exit snapshot refuses a target that disagrees with the journal', async () => {
  const session = fakeSession('session-target', { createdAt: 10 })
  const h = harness({ sessions: new Map([[session.id, session]]) })
  await h.temp.register({ sessionId: session.id })
  const ownedDir = await materializeSession(session.id)
  const decoyDir = join(root, 'sessions', 'project', `${session.id}-decoy`)
  await mkdir(decoyDir, { recursive: true })
  await writeFile(join(decoyDir, 'session.v4.jsonl.zstd'), 'decoy')
  h.temp.state.sessions[session.id].dir = decoyDir
  h.temp.refreshSnapshot()
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 0)
  assert.equal(await readFile(join(ownedDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  assert.equal(await readFile(join(decoyDir, 'session.v4.jsonl.zstd'), 'utf8'), 'decoy')
  assert.ok(warnings.some(message => message.includes('disagrees with the ownership journal')))
})

test('a live root keeps its reservation at startup', async () => {
  const h = harness()
  const reserved = await h.temp.reserve({ workspaceId: 'ws-1', cwd: '/tmp/project' })
  h.live.set(reserved.sessionId, fakeSession(reserved.sessionId, { createdAt: reserved.at + 1 }))
  const restarted = new TemporarySessions(h.deps)
  await restarted.load()
  assert.equal((await journalLines()).some(event => event.type === 'reservationDropped'), false)
  assert.equal((await journalLines()).some(event => event.type === 'reserved' && event.sessionId === reserved.sessionId), true)
})

test('a failed torn-tail repair degrades the journal and refuses writes', async () => {
  await mkdir(stateDir, { recursive: true })
  await writeFile(journalFile, [
    '{"type":"migration","ids":[],"preexisting":[],"at":1}',
    '{"type":"migrationComplete","at":2}',
    '{"type":"reserved","sessionId":"session-torn","workspaceId":null,"cwd":"/tmp/project","at":3}',
    '{"type":"reserved"',
  ].join('\n'))
  await chmod(stateDir, 0o500)
  try {
    const h = harness()
    const loaded = new TemporarySessions(h.deps)
    await loaded.load()
    assert.equal((await loaded.list()).degraded, true)
    await assert.rejects(loaded.reserve({ cwd: '/tmp/project' }), /journal is degraded/)
  } finally {
    await chmod(stateDir, 0o700)
  }
})

test('the exit snapshot refuses a record that disagrees with its stored header', async () => {
  const session = fakeSession('session-header', { createdAt: 10 })
  const h = harness({ sessions: new Map([[session.id, session]]), stored: [session.header] })
  await h.temp.register({ sessionId: session.id })
  const dir = await materializeSession(session.id)
  h.temp.storedHeaders.set(session.id, { ...session.header, cwd: '/tmp/other' })
  h.temp.refreshSnapshot()
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 0)
  assert.equal(await readFile(join(dir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  assert.ok(warnings.some(message => message.includes('disagrees with its stored header')))
})

test('a legacy record that disagrees with its header is not imported or deleted', async () => {
  const session = fakeSession('session-legacy-conflict', { createdAt: 10 })
  const header = fakeSession(session.id, {
    isSeeded: true, parentSession: 'session-permanent', createdAt: 20,
  }).header
  const dir = await materializeSession(session.id)
  const conflicting = { ...legacyRecord(session), cwd: '/tmp/wrong' }
  await writeRegistry({ [session.id]: conflicting })
  const h = harness({ stored: [header] })
  await h.temp.load()
  await h.temp.reap()
  assert.equal((await journalLines()).some(event => event.type === 'owned' && event.sessionId === session.id), false)
  assert.equal(existsSync(join(dir, 'session.v4.jsonl.zstd')), true)
})

test('the exit snapshot and boot reap require a stored header', async () => {
  const session = fakeSession('session-no-header', { createdAt: 10 })
  const h = harness({ sessions: new Map([[session.id, session]]), stored: [session.header] })
  await h.temp.register({ sessionId: session.id })
  const dir = await materializeSession(session.id)
  h.deps.sessionPersistence.list = async () => []
  h.temp.storedHeaders = new Map()
  h.live.clear()
  h.temp.refreshSnapshot()
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
  assert.equal(cleanupSnapshotSync(h.temp.exitSnapshot()), 0)
  assert.equal(await readFile(join(dir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  await h.temp.reap()
  assert.equal(await readFile(join(dir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  assert.ok(warnings.some(message => message.includes('no stored header confirms it')))
})

test('a successful reap-time listing supplies the header for that same reap', async () => {
  const session = fakeSession('session-fresh-header', { createdAt: 10 })
  const h = harness({ sessions: new Map([[session.id, session]]), stored: [session.header] })
  await h.temp.register({ sessionId: session.id })
  const dir = await materializeSession(session.id)
  h.deps.sessionPersistence.list = async () => []
  h.temp.storedHeaders = new Map()
  h.live.clear()
  h.temp.refreshSnapshot()
  assert.deepEqual(h.temp.exitSnapshot().sessions, [])
  h.deps.sessionPersistence.list = async () => [{ header: session.header }]
  await h.temp.reap()
  await assert.rejects(readFile(join(dir, 'session.v4.jsonl.zstd')), /ENOENT/)
})

test('a journal-directory fsync failure leaves the migration gate closed', async () => {
  const chat = fakeSession('session-fsync-gate', { createdAt: 10 })
  const h = harness({ sessions: new Map([[chat.id, chat]]), stored: [chat.header] })
  const originalFsync = fs.fsyncSync
  let failed = false
  fs.fsyncSync = fd => {
    if (!failed && fs.fstatSync(fd).isDirectory()) {
      failed = true
      throw Object.assign(new Error('injected journal-directory fsync failure'), { code: 'EIO' })
    }
    return originalFsync(fd)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(h.temp.load(), /ownership-journal directory/)
    assert.equal(h.temp.migrationIncomplete, true)
    await assert.rejects(h.temp.register({ sessionId: chat.id }), /migration is incomplete/)
    const lines = await journalLines()
    assert.equal(lines.some(event => event.type === 'migration'), true)
    assert.equal(lines.some(event => event.type === 'migrationComplete'), false)
  } finally {
    fs.fsyncSync = originalFsync
    syncBuiltinESMExports()
  }
})

test('registration is refused while the first migration is deferred', async () => {
  const session = fakeSession('session-migration', { createdAt: 10 })
  const h = harness({ sessions: new Map([[session.id, session]]) })
  h.deps.sessionPersistence.list = async () => { throw new Error('listing unavailable') }
  await h.temp.load()
  await assert.rejects(h.temp.register({ sessionId: session.id }), /migration is incomplete/)
  const restored = harness({ sessions: new Map([[session.id, session]]), stored: [session.header] })
  await restored.temp.load()
  await restored.temp.register({ sessionId: session.id })
  assert.deepEqual(restored.temp.exitSnapshot().sessions.map(item => item.sessionId), [session.id])
})
