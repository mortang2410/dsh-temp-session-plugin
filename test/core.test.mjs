/**
 * Core temporary-session registry tests. The Host services are faked; the
 * registry file and session directories are real temporary paths.
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import {
  TemporarySessions,
  cleanupAllSync,
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
