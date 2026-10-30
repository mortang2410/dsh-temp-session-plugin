/**
 * Stop-path probe: a modeled Workspace archive-with-stop dispatch, a live Agent
 * registry and the job registry's list/kill/wait contract over real journal and
 * Session directories. It prints one ordered trace for the chat, both child
 * modes, a retried held member and the restart boundary:
 *
 *   mark session-fork
 *   archive session-fork
 *   cancel session-child
 *   job session-job settled
 *   idle session-fork
 *   one-shot session-child running=false
 *   continuable session-child running=false
 *   retry confirmed session-held
 *   folders remain until restart
 *
 * Run: node test/probes/stop-tree.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemporarySessions, statePaths } from '../../core.js'

const roots = []

/** Fail the probe loudly instead of printing a line that does not hold. */
function check(condition, message) {
  if (!condition) {
    process.stderr.write(`probe failed: ${message}\n`)
    process.exitCode = 1
    throw new Error(message)
  }
}

/** Assert that expected lines appear in this order inside the captured trace. */
function ordered(traces, expected) {
  let cursor = 0
  for (const line of traces) {
    if (cursor < expected.length && line === expected[cursor]) cursor += 1
  }
  check(cursor === expected.length, `missing ordered trace steps: ${expected.slice(cursor).join(', ')}`)
}

/** A live Agent that drops queued input and becomes idle when cancelled. */
function agentOf({ status = 'running', onCancel } = {}) {
  const agent = {
    status,
    inbox: { nextTurn: [], nextStep: [] },
    cancels: [],
    whenIdle: async () => {},
  }
  agent.cancel = (cause) => {
    agent.cancels.push(cause)
    if (onCancel !== undefined) {
      onCancel(agent, cause)
      return
    }
    agent.status = 'idle'
    agent.inbox.nextTurn.length = 0
    agent.inbox.nextStep.length = 0
  }
  return agent
}

/** A Host-shaped session whose persistence locator derives its real directory. */
function sessionOf(id, { origin, parentSession, isSeeded = false, createdAt = 1, events = [] } = {}) {
  return {
    id,
    seq: events.length,
    inheritedEventCount: events.length,
    snapshotEvents: () => events,
    header: {
      id,
      cwd: '/tmp/project',
      isSeeded,
      createdAt,
      ...(origin === undefined ? {} : { origin }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

/** One isolated real state root and the Host-shaped services around it. */
async function hostFor(name) {
  const root = await mkdtemp(join(tmpdir(), `dsh-stop-tree-${name}-`))
  roots.push(root)
  const live = new Map()
  const stored = []
  const agents = new Map()
  const traces = []
  const warnings = []
  const archived = []
  const archivedSet = new Set()
  const jobs = new Map()
  const host = {
    root,
    live,
    stored,
    agents,
    traces,
    warnings,
    archived,
    jobs,
    archiveFailure: false,
    failArchiveOnce: false,
  }

  /** Models the Workspace registry's archive-with-stop sequence locally. */
  host.workspaceRegistry = {
    async archiveSession(sessionId, options = {}) {
      if (host.failArchiveOnce) {
        host.failArchiveOnce = false
        throw new Error('injected archive provider failure')
      }
      if (archivedSet.has(sessionId)) return
      archivedSet.add(sessionId)
      archived.push({ sessionId, options })
      if (options.stopActivity !== true) return
      const agent = agents.get(sessionId)
      if (agent !== undefined) agent.cancel({ kind: 'user' })
      for (const job of jobs.values()) {
        if (job.owner === sessionId && (job.status === 'running' || job.status === 'stopping')) {
          job.status = 'stopping'
        }
      }
    },
    async unarchiveSession() {},
  }

  host.jobsService = {
    list: owner => [...jobs.values()].filter(job => job.owner === owner
      && (job.status === 'running' || job.status === 'stopping')),
    kill: (id, owner, reason) => {
      const job = jobs.get(id)
      check(job !== undefined && job.owner === owner, `job "${id}" was not owned by "${owner}"`)
      job.status = 'stopping'
      job.reason = reason
      return 'requested'
    },
    wait: async (id, timeout, owner) => {
      const job = jobs.get(id)
      check(job !== undefined && job.owner === owner, `job "${id}" was not owned by "${owner}"`)
      check(timeout > 0 && timeout <= 1000, `job wait was not bounded: ${String(timeout)}`)
      job.status = 'killed'
      return { ...job }
    },
  }

  host.paths = statePaths({ DSH_HOME: root })
  host.deps = {
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
    agents: { get: id => agents.get(id) },
    jobs: host.jobsService,
    workspaceRegistry: host.workspaceRegistry,
    trace: message => { traces.push(message) },
    logger: { warn: message => { warnings.push(message) }, info: () => {} },
    paths: host.paths,
  }
  host.temp = new TemporarySessions(host.deps)
  return host
}

/** Materialize the real per-Session directory and log artifact. */
async function materialize(host, id) {
  const dir = join(host.root, 'sessions', 'project', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

try {
  // A forked chat root, one continuable child and an owned job. The archive
  // listener and the explicit child cancel must both be visible, in order.
  const forkHost = await hostFor('fork')
  const fork = sessionOf('session-fork', {
    isSeeded: true,
    parentSession: 'session-source',
    events: [{ type: 'turn/start', data: { turn: 1 } }],
  })
  const child = sessionOf('session-child', { origin: 'subagent', parentSession: fork.id, createdAt: 2 })
  forkHost.live.set(fork.id, fork)
  forkHost.live.set(child.id, child)
  forkHost.stored.push(fork.header, child.header)
  const forkAgent = agentOf({ status: 'idle' })
  const childAgent = agentOf()
  childAgent.inbox.nextStep.push({ id: 'queued-step' })
  forkHost.agents.set(fork.id, forkAgent)
  forkHost.agents.set(child.id, childAgent)
  // The real background subagent tool registers the job under its parent.
  forkHost.jobs.set('session-job', {
    id: 'session-job', owner: fork.id, status: 'running', label: 'child job', startedAt: 1,
  })
  await forkHost.temp.register({ sessionId: fork.id, kind: 'side' })
  await forkHost.temp.recordDescendant(child)
  const forkDir = await materialize(forkHost, fork.id)
  const childDir = await materialize(forkHost, child.id)
  await forkHost.temp.discard({ sessionId: fork.id })
  ordered(forkHost.traces, [
    'mark session-fork',
    'archive session-fork',
    'cancel session-child',
    'job session-job settled',
    'idle session-fork',
    'confirmed session-child',
  ])
  check(forkHost.temp.stopped.has(fork.id), 'the fork chat was not confirmed stopped')
  check(forkHost.temp.stopped.has(child.id), 'the continuable child was not confirmed stopped')
  check(childAgent.status === 'idle', 'the continuable child Agent is still running')
  check(childAgent.inbox.nextStep.length === 0, 'the continuable child kept queued work')
  process.stdout.write('mark session-fork\n')
  process.stdout.write('archive session-fork\n')
  process.stdout.write('cancel session-child\n')
  process.stdout.write('job session-job settled\n')
  process.stdout.write('idle session-fork\n')

  // A one-shot child with no local Agent must be stopped through its job.
  const oneShotHost = await hostFor('one-shot')
  const oneShotRoot = sessionOf('session-one-shot-root', { createdAt: 1 })
  const oneShotChild = sessionOf('session-child', {
    origin: 'subagent', parentSession: oneShotRoot.id, createdAt: 2,
  })
  oneShotHost.live.set(oneShotRoot.id, oneShotRoot)
  oneShotHost.live.set(oneShotChild.id, oneShotChild)
  oneShotHost.stored.push(oneShotRoot.header, oneShotChild.header)
  oneShotHost.jobs.set('session-one-shot-job', {
    id: 'session-one-shot-job', owner: oneShotRoot.id, status: 'running', label: 'one-shot job', startedAt: 1,
  })
  await oneShotHost.temp.register({ sessionId: oneShotRoot.id })
  await oneShotHost.temp.recordDescendant(oneShotChild)
  const oneShotDir = await materialize(oneShotHost, oneShotChild.id)
  await oneShotHost.temp.discard({ sessionId: oneShotRoot.id })
  check(oneShotHost.agents.get(oneShotChild.id) === undefined, 'a local Agent exists for the remote one-shot child')
  check(oneShotHost.jobs.get('session-one-shot-job').status === 'killed', 'the one-shot job did not settle')
  check(oneShotHost.temp.stopped.has(oneShotChild.id), 'the remote one-shot child was not confirmed')
  process.stdout.write('one-shot session-child running=false\n')
  process.stdout.write('continuable session-child running=false\n')

  // A held member with a swallowed archive failure stays stopping; the next
  // pass confirms it after the Agent is gone.
  const heldHost = await hostFor('held')
  const held = sessionOf('session-held', { createdAt: 1 })
  heldHost.live.set(held.id, held)
  heldHost.stored.push(held.header)
  heldHost.agents.set(held.id, agentOf({ onCancel: () => {} }))
  heldHost.failArchiveOnce = true
  await heldHost.temp.register({ sessionId: held.id })
  await heldHost.temp.discard({ sessionId: held.id })
  check(heldHost.warnings.some(message => message.includes('injected archive provider failure')), 'the archive failure was not swallowed and logged')
  check(heldHost.temp.stopped.has(held.id) === false, 'a held member was confirmed stopped')
  heldHost.agents.delete(held.id)
  await heldHost.temp.retryObserved()
  check(heldHost.temp.stopped.has(held.id), 'the retry did not confirm the held member')
  ordered(heldHost.traces, ['retry confirmed session-held'])
  process.stdout.write('retry confirmed session-held\n')

  // A fork announced after the final scan inherits pending and is stopped by
  // reconciliation, not left for a restart.
  const lateHost = await hostFor('late')
  const lateRoot = sessionOf('session-late-root', { createdAt: 1 })
  lateHost.live.set(lateRoot.id, lateRoot)
  lateHost.stored.push(lateRoot.header)
  await lateHost.temp.register({ sessionId: lateRoot.id })
  await lateHost.temp.discard({ sessionId: lateRoot.id })
  const lateFork = sessionOf('session-late-fork', {
    isSeeded: true, parentSession: lateRoot.id, createdAt: Date.now() + 1000,
  })
  lateHost.live.set(lateFork.id, lateFork)
  const lateAgent = agentOf()
  lateHost.agents.set(lateFork.id, lateAgent)
  await lateHost.temp.recordDescendant(lateFork)
  check(lateHost.temp.state.sessions[lateFork.id]?.pendingDelete === true, 'the late fork did not inherit pending')
  check(lateHost.archived.some(item => item.sessionId === lateFork.id), 'the late fork was not archived')
  check(lateHost.temp.stopped.has(lateFork.id), 'the late fork was not stopped')

  check(existsSync(join(forkDir, 'session.v4.jsonl.zstd')), 'the fork folder was deleted before the restart boundary')
  check(existsSync(join(childDir, 'session.v4.jsonl.zstd')), 'the child folder was deleted before the restart boundary')
  check(existsSync(join(oneShotDir, 'session.v4.jsonl.zstd')), 'the one-shot folder was deleted before the restart boundary')
  process.stdout.write('folders remain until restart\n')

  // The restart boundary deletes only after the journal is replayed and the
  // stop is confirmed on the new instance.
  forkHost.live.clear()
  forkHost.agents.clear()
  const restarted = new TemporarySessions(forkHost.deps)
  await restarted.reap()
  check(!existsSync(join(forkDir, 'session.v4.jsonl.zstd')), 'the restart kept the fork folder')
  check(!existsSync(join(childDir, 'session.v4.jsonl.zstd')), 'the restart kept the child folder')
  const saved = JSON.parse(await readFile(forkHost.paths.file, 'utf8'))
  check(saved.sessions[fork.id] === undefined, 'the restart kept the fork record')
} catch (error) {
  if (process.exitCode !== 1) {
    process.stderr.write(`probe failed: ${String(error)}\n`)
    process.exitCode = 1
  }
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true })
}
