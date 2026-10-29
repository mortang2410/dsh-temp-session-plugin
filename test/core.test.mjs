/**
 * Core temporary-session registry tests. The Host services are faked; the
 * registry file and session directories are real temporary paths.
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import {
  TemporarySessions,
  cleanupAllSync,
  installProcessCleanup,
  isSafeSessionDir,
  statePaths,
} from '../core.js'

let root
let stateFile
const warnings = []

function fakeSession(id, {
  cwd = '/tmp/project', events = [], isSeeded = false, origin, parentSession, inheritedEventCount,
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
      ...(origin === undefined ? {} : { origin }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

function harness({ sessions = new Map(), stored = [], registry } = {}) {
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
  stateFile = statePaths({ DSH_HOME: root }).file
})

beforeEach(async () => {
  await rm(stateFile, { force: true })
  await rm(join(root, 'sessions'), { recursive: true, force: true })
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
  h.temp.deps.sessionPersistence = { locate: () => ({ kind: 'sqlite' }) }
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

test('cleanupAllSync deletes every recorded directory but keeps tombstones', async () => {
  const first = fakeSession('session-sync-one')
  const second = fakeSession('session-sync-two')
  const h = harness({ sessions: new Map([[first.id, first], [second.id, second]]) })
  await h.temp.register({ sessionId: first.id })
  await h.temp.register({ sessionId: second.id })
  const firstDir = await materializeSession(first.id)
  const secondDir = await materializeSession(second.id)
  assert.equal(cleanupAllSync(stateFile), 2)
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
  assert.deepEqual(await h.temp.list(), { sessions: [] })
  await h.temp.reap()
  assert.equal(cleanupAllSync(stateFile), 0)
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
  const { createdAt, ...record } = saved.sessions[child.id]
  assert.ok(Number.isSafeInteger(createdAt))
  assert.deepEqual(record, {
    sessionId: child.id,
    dir: join(root, 'sessions', 'project', child.id),
    cwd: '/tmp/project',
    title: '',
    kind: 'subagent',
    parentSessionId: chat.id,
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

test('a subagent under an unrecorded live ancestor is recorded under the nearest recorded id', async () => {
  const chat = fakeSession('session-chat')
  // The middle subagent was never announced to the plugin, so it is not recorded.
  const middle = fakeSession('session-middle', { origin: 'subagent', parentSession: chat.id })
  const leaf = fakeSession('session-leaf', { origin: 'subagent', parentSession: middle.id })
  const h = harness({ sessions: new Map([[chat.id, chat], [middle.id, middle], [leaf.id, leaf]]) })
  await h.temp.register({ sessionId: chat.id })
  await h.temp.recordDescendant(leaf)
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.sessions[leaf.id].parentSessionId, chat.id)
  assert.equal(saved.sessions[middle.id], undefined)
})

test('exit cleanup deletes a recorded child together with its chat', async () => {
  const { chat, child } = await chatWithChild()
  const chatDir = await materializeSession(chat.id)
  const childDir = await materializeSession(child.id)
  assert.equal(cleanupAllSync(stateFile), 2)
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
  assert.equal(cleanupAllSync(stateFile), 0)
  assert.equal(await readFile(join(childDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
  assert.equal(await readFile(join(chatDir, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
})

test('boot reap deletes a child whose parent record is gone, and drops a child whose directory is gone', async () => {
  const { h, child } = await chatWithChild()
  const orphanDir = await materializeSession(child.id)
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
  const again = harness({ sessions: new Map([[chat2.id, chat2], [gone.id, gone]]) })
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
  assert.equal(cleanupAllSync(stateFile), 0)
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
  const removed = cleanupAllSync(stateFile, undefined, () => h.temp.state)
  await assert.rejects(readFile(join(childDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(removed, 2)
  // A boot reap after the exit: the child was never saved, so it has no record and its directory stays gone.
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
const EXIT_STATE_PROVIDER_KEY = Symbol.for('dsh.temp-session.exit-state-provider')

/**
 * Runs a body with the once-per-process guard and the exit state provider
 * cleared, so this test's install adds its own exit handler whether or not
 * another test installed one first. The body receives a reader for the exit
 * listeners this run added. Afterwards the added listeners are removed and both
 * globals are restored.
 */
async function withFreshProcessCleanup(body) {
  const savedGuard = globalThis[PROCESS_CLEANUP_FLAG]
  const savedProvider = globalThis[EXIT_STATE_PROVIDER_KEY]
  delete globalThis[PROCESS_CLEANUP_FLAG]
  delete globalThis[EXIT_STATE_PROVIDER_KEY]
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
    if (savedGuard === undefined) delete globalThis[PROCESS_CLEANUP_FLAG]
    else globalThis[PROCESS_CLEANUP_FLAG] = savedGuard
    if (savedProvider === undefined) delete globalThis[EXIT_STATE_PROVIDER_KEY]
    else globalThis[EXIT_STATE_PROVIDER_KEY] = savedProvider
  }
}

test('exit cleanup reads the latest install registry, not the first install', () => withFreshProcessCleanup(async addedExitListeners => {
  const dirA = await materializeSession('session-a-first')
  const dirB = await materializeSession('session-b-latest')
  const disposeFirst = installProcessCleanup(stateFile, undefined, () => ({
    sessions: { 'session-a-first': { sessionId: 'session-a-first', dir: dirA } },
  }))
  installProcessCleanup(stateFile, undefined, () => ({
    sessions: { 'session-b-latest': { sessionId: 'session-b-latest', dir: dirB } },
  }))
  // The first instance unloads after the second installed, as in a live profile reload.
  disposeFirst()
  assert.equal(addedExitListeners().length, 1)
  addedExitListeners()[0]()
  await assert.rejects(readFile(join(dirB, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(dirA, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
}))

test('a disposer clears the exit registry, so exit falls back to the disk registry alone', () => withFreshProcessCleanup(async addedExitListeners => {
  const dirLive = await materializeSession('session-live-memory')
  const dirDisk = await materializeSession('session-disk-record')
  await mkdir(join(stateFile, '..'), { recursive: true })
  await writeFile(stateFile, JSON.stringify({
    version: 1,
    sessions: { 'session-disk-record': { sessionId: 'session-disk-record', dir: dirDisk } },
  }))
  const dispose = installProcessCleanup(stateFile, undefined, () => ({
    sessions: { 'session-live-memory': { sessionId: 'session-live-memory', dir: dirLive } },
  }))
  dispose()
  addedExitListeners()[0]()
  await assert.rejects(readFile(join(dirDisk, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(dirLive, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
}))

test('exit cleanup deletes a child queued behind a held registry save, with its chat', async () => {
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
  const removed = cleanupAllSync(stateFile, undefined, () => h.temp.registryForExit())
  await assert.rejects(readFile(join(chatDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(firstDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  await assert.rejects(readFile(join(secondDir, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(removed, 3)
  // A boot after the exit finds no record and no directory for the queued child.
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
  // Exit cleanup still sees the child's record in memory.
  const removed = cleanupAllSync(stateFile, undefined, () => h.temp.registryForExit())
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
 * cleanup deletes the children with the chat. The children are not live in the fresh boot,
 * so only the chat-owned rule can keep them.
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
  installProcessCleanup(stateFile, undefined, () => successor.registryForExit())
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
  // Unload runs while the queue is blocked. It must publish both memory-only records without waiting.
  void h.temp.cleanupPending()
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
  await assertUnloadPublishes(h, addedExitListeners, {
    chatDir,
    children: [{ id: child.id, dir: childDir }],
  })
}))

test('an exit listener from an earlier module generation reads the latest install registry', () => withFreshProcessCleanup(async addedExitListeners => {
  // Two module instances of core.js stand for two generations of one plugin after a watched-file reload.
  const generationOne = await import(new URL('../core.js?generation=1', import.meta.url).href)
  const generationTwo = await import(new URL('../core.js?generation=2', import.meta.url).href)
  assert.notEqual(generationOne, generationTwo)
  const dirA = await materializeSession('session-generation-one')
  const dirB = await materializeSession('session-generation-two')
  const disposeFirst = generationOne.installProcessCleanup(stateFile, undefined, () => ({
    sessions: { 'session-generation-one': { sessionId: 'session-generation-one', dir: dirA } },
  }))
  disposeFirst()
  generationTwo.installProcessCleanup(stateFile, undefined, () => ({
    sessions: { 'session-generation-two': { sessionId: 'session-generation-two', dir: dirB } },
  }))
  // Only the first generation installed a handler; it must read the second generation's registry at exit.
  assert.equal(addedExitListeners().length, 1)
  addedExitListeners()[0]()
  await assert.rejects(readFile(join(dirB, 'session.v4.jsonl.zstd')), /ENOENT/)
  assert.equal(await readFile(join(dirA, 'session.v4.jsonl.zstd'), 'utf8'), 'log')
}))
