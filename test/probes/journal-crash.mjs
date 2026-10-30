/**
 * Journal crash probe: a `deleted` event written before a folder removal is
 * finished at the next start; an old tombstone is pruned only after its folder
 * is gone; and a degraded journal deletes nothing.
 *
 * Run with: node test/probes/journal-crash.mjs
 */

import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemporarySessions, cleanupSnapshotSync, statePaths } from '../../core.js'
import { appendJournalEvent, replayJournal } from '../../journal.js'

const prefix = join(tmpdir(), 'dsh-temp-session-journal-crash-')
const root = await mkdtemp(prefix)
try {
  const paths = statePaths({ DSH_HOME: root })
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000
  const parentId = 'session-old'
  const parentDir = join(root, 'sessions', 'project', parentId)

  function session(id, extra = {}) {
    return {
      id,
      header: { id, cwd: '/tmp/project', isSeeded: false, ...extra },
      snapshotEvents: () => [],
    }
  }

  function harness(stored = []) {
    return new TemporarySessions({
      sessions: { get: () => undefined, flush: async () => true },
      sessionPersistence: {
        locate: header => ({ kind: 'jsonl', path: join(root, 'sessions', 'project', header.id, 'session.v4.jsonl.zstd') }),
        list: async () => stored.map(header => ({ header })),
        stat: async () => undefined,
      },
      sessionController: { rename: async () => ({}), cancel: () => ({ accepted: true }) },
      agents: { get: () => undefined },
      workspaceRegistry: { unarchiveSession: async () => {} },
      logger: { warn: () => {}, info: () => {} },
      paths,
    })
  }

  await mkdir(parentDir, { recursive: true })
  await writeFile(join(parentDir, 'session.v4.jsonl.zstd'), 'log')
  await appendJournalEvent(paths.journal, {
    type: 'migration', ids: [parentId], preexisting: [parentId], at: old,
  })
  await appendJournalEvent(paths.journal, {
    type: 'owned', sessionId: parentId, kind: 'main', parentSessionId: null, dir: parentDir, cwd: '/tmp/project', at: old,
  })
  await appendJournalEvent(paths.journal, {
    type: 'deleted', sessionId: parentId, kind: 'main', parentSessionId: null, dir: parentDir, cwd: '/tmp/project', at: old,
  })
  await appendJournalEvent(paths.journal, { type: 'migrationComplete', at: old })
  console.log('tombstoned session-old')

  const second = harness([session(parentId).header])
  await second.reap()
  if (existsSync(join(parentDir, 'session.v4.jsonl.zstd'))) throw new Error('next start did not finish the tombstone')
  console.log('finished session-old at next start')

  const lines = replayJournal(await readFile(paths.journal, 'utf8')).events
  if (lines.some(event => event.sessionId === parentId)) throw new Error('old tombstone was not pruned after cleanup')
  console.log('pruned only after cleanup')

  const bad = join(root, 'bad-journal')
  await mkdir(bad, { recursive: true })
  const third = harness()
  await third.load()
  const removed = cleanupSnapshotSync(third.exitSnapshot(), third.deps.logger, bad)
  if (removed !== 0) throw new Error('degraded journal deleted something')
  console.log('journal degraded: deleted 0')
} finally {
  if (root.startsWith(prefix)) await rm(root, { recursive: true, force: true })
}
