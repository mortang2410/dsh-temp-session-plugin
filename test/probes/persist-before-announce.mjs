/**
 * Fixed-point boot reconciliation probe.
 *
 * It exercises the real registry, journal and per-session files under a fresh
 * temporary root. A child discovered only from its stored header is adopted
 * under its journal-owned parent; a reversed chain reaches a fixed point; a
 * pre-migration seeded descendant is quarantined and left on disk; an orphan
 * with no journal anchor is left alone; and a degraded pass journals an
 * observed fork, then adopts it on the next pass.
 *
 * Run with: node test/probes/persist-before-announce.mjs
 */

import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemporarySessions, statePaths } from '../../core.js'
import { appendJournalEvent } from '../../journal.js'

const roots = []

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function session(id, {
  origin, parentSession, isSeeded = false, createdAt, cwd = '/tmp/project',
} = {}) {
  return {
    id,
    seq: 0,
    snapshotEvents: () => [],
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-persist-before-announce-'))
  roots.push(root)
  const stored = []
  const live = new Map()
  const paths = statePaths({ DSH_HOME: root })
  const temp = new TemporarySessions({
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
    sessionController: { rename: async () => ({}), cancel: () => ({ accepted: true }) },
    agents: { get: () => undefined },
    workspaceRegistry: { unarchiveSession: async () => {} },
    logger: { warn: () => {}, info: () => {} },
    paths,
  })
  return { root, stored, live, paths, temp }
}

async function materialize(root, id) {
  const dir = join(root, 'sessions', 'project', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

async function seedOwned(paths, parent, {
  at = 100, preexisting = [parent.id], ids = [parent.id],
} = {}) {
  await appendJournalEvent(paths.journal, { type: 'migration', ids, preexisting, at })
  await appendJournalEvent(paths.journal, {
    type: 'owned',
    sessionId: parent.id,
    kind: 'main',
    parentSessionId: null,
    dir: join(paths.dir, '..', 'sessions', 'project', parent.id),
    cwd: parent.header.cwd ?? null,
    at: at + 1,
  })
  await appendJournalEvent(paths.journal, { type: 'migrationComplete', at: at + 2 })
}

async function journalLines(paths) {
  const text = await readFile(paths.journal, 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

try {
  // The stored child was never announced to this process.
  {
    const { root, stored, paths, temp } = await setup()
    const parent = session('session-parent', { createdAt: 1 })
    const child = session('session-child', { origin: 'subagent', parentSession: parent.id, createdAt: 101 })
    stored.push(parent.header, child.header)
    await seedOwned(paths, parent, { at: 100, preexisting: [parent.id] })
    await temp.load()
    const owned = (await journalLines(paths)).find(event => event.type === 'owned' && event.sessionId === child.id)
    check(owned?.parentSessionId === parent.id, 'stored child was not adopted')
    check(existsSync(join(root, 'sessions', 'project', parent.id, 'session.v4.jsonl.zstd')) === false, 'unexpected parent artifact')
    process.stdout.write('adopted session-child under session-parent\n')
  }

  // Reversed listing order: A is owned, B is a fork of A, C is a fork of B.
  {
    const { stored, paths, temp } = await setup()
    const a = session('session-a', { createdAt: 1 })
    const b = session('session-b', { isSeeded: true, parentSession: a.id, createdAt: 101 })
    const c = session('session-c', { isSeeded: true, parentSession: b.id, createdAt: 102 })
    stored.push(c.header, b.header, a.header)
    await seedOwned(paths, a, { at: 100, preexisting: [a.id] })
    await temp.load()
    const lines = await journalLines(paths)
    for (const child of [b, c]) {
      check(lines.some(event => event.type === 'owned' && event.sessionId === child.id), `${child.id} was not adopted`)
    }
    check(temp.state.sessions[c.id]?.parentSessionId === b.id, 'C did not keep its true direct parent')
    process.stdout.write('reversed chain adopted session-c\n')
  }

  // A seeded descendant at the migration cutoff is quarantined, not deleted.
  {
    const { root, stored, paths, temp } = await setup()
    const parent = session('session-side-parent', { createdAt: 1 })
    const side = session('session-side', {
      isSeeded: true, parentSession: parent.id, createdAt: 100,
    })
    const sideDir = await materialize(root, side.id)
    stored.push(side.header, parent.header)
    await seedOwned(paths, parent, { at: 100, preexisting: [parent.id, side.id] })
    await temp.load()
    const lines = await journalLines(paths)
    check(!lines.some(event => event.type === 'owned' && event.sessionId === side.id), 'side was adopted')
    check(existsSync(join(sideDir, 'session.v4.jsonl.zstd')), 'side artifact was deleted')
    process.stdout.write('quarantined pre-migration session-side\n')
  }

  // A subagent with no journal anchor and no stored parent is left alone.
  {
    const { stored, paths, temp } = await setup()
    const child = session('session-permanent-child', {
      origin: 'subagent', parentSession: 'session-permanent-parent', createdAt: 101,
    })
    stored.push(child.header)
    await appendJournalEvent(paths.journal, { type: 'migration', ids: [], preexisting: [], at: 100 })
    await appendJournalEvent(paths.journal, { type: 'migrationComplete', at: 101 })
    await temp.load()
    const lines = await journalLines(paths)
    check(!lines.some(event => event.type === 'owned' && event.sessionId === child.id), 'unproven orphan was adopted')
    process.stdout.write('left session-permanent-child\n')
  }

  // A degraded pass journals the observation and the next pass adopts it.
  {
    const { root, stored, paths, temp } = await setup()
    const parent = session('session-degraded-parent', { createdAt: 1 })
    const fork = session('session-degraded-fork', {
      isSeeded: true, parentSession: parent.id, createdAt: 101,
    })
    stored.push(parent.header)
    await seedOwned(paths, parent, { at: 100, preexisting: [parent.id] })
    await materialize(root, parent.id)
    temp.reconciliationDegraded = true
    await temp.load()
    await temp.recordDescendant(fork)
    const lines = await journalLines(paths)
    check(lines.some(event => event.type === 'owned' && event.sessionId === fork.id), 'degraded fork was not journaled')
    check(existsSync(paths.file) === false, 'degraded pass wrote a registry')
    temp.reconciliationDegraded = false
    await temp.retryObserved()
    check(temp.state.sessions[fork.id]?.parentSessionId === parent.id, 'fork was not adopted after recovery')
    process.stdout.write('degraded reconciliation retried\n')
  }
} finally {
  for (const root of roots) {
    if (root.startsWith(join(tmpdir(), 'dsh-persist-before-announce-'))) {
      await rm(root, { recursive: true, force: true })
    }
  }
}
