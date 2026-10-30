/**
 * Real-boundary probe for the validated exit snapshot.
 *
 * The installed exit callback is invoked directly so a real process exit is not
 * needed; every registry, journal and Session directory it reads is a real file
 * under a fresh temporary root. The probe prints exactly four lines when the
 * snapshot behaviour holds, and exits non-zero with a diagnostic when it does
 * not:
 *
 *   deleted session-child
 *   deleted after unload session-child
 *   failed save reached the snapshot
 *   journal degraded: deleted 0
 *
 * Run: node test/probes/exit-snapshot.mjs
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TemporarySessions,
  cleanupSnapshotSync,
  installExitCleanup,
  statePaths,
} from '../../core.js'

const roots = []
const exitListeners = []

/** Fail the probe loudly instead of printing a line that does not hold. */
function check(condition, message) {
  if (!condition) {
    process.stderr.write(`probe failed: ${message}\n`)
    process.exitCode = 1
    throw new Error(message)
  }
}

/** One isolated state directory and the fake Host services around it. */
async function setup(name) {
  const root = await mkdtemp(join(tmpdir(), `dsh-exit-snapshot-${name}-`))
  roots.push(root)
  const live = new Map()
  const stored = []
  const deps = {
    sessions: { get: id => live.get(id), flush: async () => true },
    sessionPersistence: {
      locate: header => ({ kind: 'jsonl', path: join(root, 'sessions', 'project', header.id, 'session.v4.jsonl.zstd') }),
      list: async () => stored.map(header => ({ header })),
      stat: async id => {
        const header = stored.find(candidate => candidate.id === id)
        return header === undefined ? undefined : { header, revision: 'revision' }
      },
    },
    sessionController: { rename: async () => ({ title: '', seq: 1 }), cancel: () => ({ accepted: true }) },
    agents: { get: () => undefined },
    logger: { warn: () => {}, info: () => {} },
    paths: statePaths({ DSH_HOME: root }),
  }
  return { root, deps, live, stored, temp: new TemporarySessions(deps) }
}

/** A live Session with the header fields the locator and validation need. */
function sessionOf(id, { origin, parentSession, createdAt = Date.now() } = {}) {
  return {
    id,
    seq: 0,
    snapshotEvents: () => [],
    header: {
      id,
      cwd: '/tmp/project',
      isSeeded: false,
      createdAt,
      ...(origin === undefined ? {} : { origin }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

/** Create the stored directory and log artifact the locator derives for an id. */
async function materialize(root, id) {
  const dir = join(root, 'sessions', 'project', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

/** The one exit callback this process installed, bound to the latest snapshot. */
let exitCallback

/** Bind the exit cleanup to a snapshot provider and return the installed listener. */
function install(snapshotProvider) {
  const before = new Set(process.listeners('exit'))
  installExitCleanup(snapshotProvider, undefined)
  if (exitCallback === undefined) {
    exitCallback = process.listeners('exit').find(listener => !before.has(listener))
    check(exitCallback !== undefined, 'the exit callback was not installed')
    exitListeners.push(exitCallback)
  }
  return exitCallback
}

async function deletedChild() {
  const { root, live, stored, temp } = await setup('basic')
  const chat = sessionOf('session-chat', { createdAt: 1000 })
  const child = sessionOf('session-child', { origin: 'subagent', parentSession: chat.id, createdAt: 2000 })
  live.set(chat.id, chat)
  live.set(child.id, child)
  stored.push(chat.header, child.header)
  await temp.register({ sessionId: chat.id })
  await temp.recordDescendant(child)
  const chatDir = await materialize(root, chat.id)
  const childDir = await materialize(root, child.id)
  const exit = install(() => temp.exitSnapshot())
  exit()
  check(existsSync(chatDir) === false, 'the exit callback kept the chat directory')
  check(existsSync(childDir) === false, 'the exit callback kept the child directory')
  process.stdout.write('deleted session-child\n')
}

async function deletedAfterUnload() {
  const { root, live, stored, temp } = await setup('unload')
  const chat = sessionOf('session-chat', { createdAt: 1000 })
  const child = sessionOf('session-child', { origin: 'subagent', parentSession: chat.id, createdAt: 2000 })
  live.set(chat.id, chat)
  live.set(child.id, child)
  stored.push(chat.header, child.header)
  await temp.register({ sessionId: chat.id })
  await temp.recordDescendant(child)
  const chatDir = await materialize(root, chat.id)
  const childDir = await materialize(root, child.id)
  const exit = install(() => temp.exitSnapshot())
  // The plugin unloads: nothing is pending, so unload removes nothing and the
  // validated snapshot stays bound for the exit handler.
  await temp.cleanupPending()
  check(existsSync(childDir) === true, 'the unload path deleted a live child')
  exit()
  check(existsSync(chatDir) === false, 'exit after unload kept the chat directory')
  check(existsSync(childDir) === false, 'exit after unload kept the child directory')
  process.stdout.write('deleted after unload session-child\n')
}

async function failedChildSave() {
  const { deps, live, stored, temp } = await setup('failed-save')
  const chat = sessionOf('session-chat', { createdAt: 1000 })
  const child = sessionOf('session-child', { origin: 'subagent', parentSession: chat.id, createdAt: 2000 })
  live.set(chat.id, chat)
  live.set(child.id, child)
  stored.push(chat.header, child.header)
  await temp.register({ sessionId: chat.id })
  const save = temp.save
  let failures = 1
  temp.save = async function failOnce() {
    if (failures > 0) {
      failures -= 1
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    return save.call(this)
  }
  await temp.recordDescendant(child).catch(() => undefined)
  check(failures === 0, 'the child registry save did not fail')
  const snapshot = temp.exitSnapshot()
  check(snapshot.sessions.some(record => record.sessionId === child.id), 'the failed-save child is missing from the snapshot')
  const onDisk = JSON.parse(await readFile(deps.paths.file, 'utf8'))
  check(onDisk.sessions[child.id] === undefined, 'the failed save still reached the durable registry')
  process.stdout.write('failed save reached the snapshot\n')
}

async function journalDegraded() {
  const { root, deps, live } = await setup('degraded')
  const chat = sessionOf('session-chat', { createdAt: 1000 })
  live.set(chat.id, chat)
  await mkdir(deps.paths.dir, { recursive: true })
  const chatDir = join(root, 'sessions', 'project', chat.id)
  await writeFile(deps.paths.journal, `{"type":"owned","sessionId":"${chat.id}","kind":"main","parentSessionId":null,"dir":"${chatDir}","cwd":null,"at":1}\nnot an event\n`)
  await materialize(root, chat.id)
  const boot = new TemporarySessions(deps)
  await boot.load()
  check(boot.exitSnapshot().degraded === true, 'the corrupt journal did not degrade the snapshot')
  const exit = install(() => boot.exitSnapshot())
  exit()
  check(existsSync(chatDir) === true, 'the degraded journal still deleted the chat directory')
  const removed = cleanupSnapshotSync(boot.exitSnapshot())
  check(removed === 0, `a degraded snapshot removed ${String(removed)} directories`)
  process.stdout.write(`journal degraded: deleted ${String(removed)}\n`)
}

try {
  await deletedChild()
  await deletedAfterUnload()
  await failedChildSave()
  await journalDegraded()
} catch (error) {
  if (process.exitCode !== 1) {
    process.stderr.write(`probe failed: ${String(error)}\n`)
    process.exitCode = 1
  }
} finally {
  for (const listener of exitListeners) process.off('exit', listener)
  for (const root of roots) await rm(root, { recursive: true, force: true })
}
