/**
 * Expiry-clock probe: the hourly sweep over real registry, journal and Session
 * directories. It prints exactly these seven lines when the clock, the busy
 * exclusions, the idle-held mark, the pre-commit race and the restart boundary
 * all hold:
 *
 *   expired session-old
 *   kept session-busy-agent
 *   kept session-maintenance
 *   kept session-job
 *   marked idle-held session-held
 *   aborted by event session-race
 *   deleted at restart session-old
 *
 * Run: node test/probes/expiry-clock.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemporarySessions, statePaths } from '../../core.js'

const roots = []
const NOW = 1_760_000_000_000
const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000

/** Fail loudly instead of printing a line that does not hold. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** A Host-shaped Session whose persistence locator derives its real directory. */
function sessionOf(id, { createdAt = NOW } = {}) {
  return {
    id,
    seq: 0,
    snapshotEvents: () => [],
    header: { id, cwd: '/tmp/project', isSeeded: false, createdAt },
  }
}

/** Materialize the real per-Session directory and current log artifact. */
async function materialize(root, id) {
  const dir = join(root, 'sessions', 'project', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
  return dir
}

/** One isolated state root and the Host-shaped services around it. */
async function hostFor(name) {
  const root = await mkdtemp(join(tmpdir(), `dsh-expiry-clock-${name}-`))
  roots.push(root)
  const live = new Map()
  const stored = []
  const agents = new Map()
  const jobs = new Map()
  const deps = {
    sessions: { get: id => live.get(id), flush: async () => true },
    sessionPersistence: {
      locate: header => ({
        kind: 'jsonl',
        path: join(root, 'sessions', 'project', header.id, 'session.v4.jsonl.zstd'),
      }),
      list: async () => stored.map(({ header }) => {
        const artifact = join(root, 'sessions', 'project', header.id, 'session.v4.jsonl.zstd')
        return existsSync(artifact)
          ? { header, revision: 'probe', sizeBytes: 1 }
          : { header, revision: 'probe' }
      }),
      stat: async id => {
        const entry = stored.find(candidate => candidate.header.id === id)
        return entry === undefined ? undefined : { header: entry.header, revision: 'probe' }
      },
    },
    sessionController: {
      rename: async request => ({ title: request.title, seq: 1 }),
      cancel: () => ({ accepted: true }),
    },
    agents: { get: id => agents.get(id) },
    jobs: {
      list: owner => [...jobs.values()].filter(job => job.owner === owner
        && (job.status === 'running' || job.status === 'stopping')),
      kill: () => 'requested',
      wait: async () => ({ status: 'killed' }),
    },
    workspaceRegistry: {
      archiveSession: async () => {},
      unarchiveSession: async () => {},
    },
    logger: { warn: () => {}, info: () => {} },
    paths: statePaths({ DSH_HOME: root }),
  }
  const host = { root, deps, live, stored, agents, jobs, temp: new TemporarySessions(deps) }
  return host
}

/** Register one materialized chat and age its activity clock. */
async function agedChat(host, id) {
  const chat = sessionOf(id)
  host.live.set(id, chat)
  host.stored.push({ header: chat.header })
  await host.temp.register({ sessionId: id })
  await materialize(host.root, id)
  host.temp.state.sessions[id].lastActivityAt = NOW - FOUR_DAYS
  host.temp.state.sessions[id].activitySince = NOW - FOUR_DAYS
  await host.temp.save()
  return chat
}

try {
  const oldHost = await hostFor('old')
  await agedChat(oldHost, 'session-old')
  check(await oldHost.temp.sweepExpiry(NOW) === true, 'the idle chat did not expire')
  check(oldHost.temp.state.sessions['session-old'].pendingDelete === true, 'the idle chat was not marked pending')
  process.stdout.write('expired session-old\n')

  const busyHost = await hostFor('busy')
  await agedChat(busyHost, 'session-busy-agent')
  busyHost.agents.set('session-busy-agent', { status: 'running' })
  check(await busyHost.temp.sweepExpiry(NOW) === false, 'a running Agent did not keep its chat')
  process.stdout.write('kept session-busy-agent\n')

  const maintenanceHost = await hostFor('maintenance')
  await agedChat(maintenanceHost, 'session-maintenance')
  maintenanceHost.agents.set('session-maintenance', {
    status: 'idle',
    whenIdle: () => new Promise(() => {}),
  })
  check(await maintenanceHost.temp.sweepExpiry(NOW) === false, 'a maintenance run did not keep its chat')
  process.stdout.write('kept session-maintenance\n')

  const jobHost = await hostFor('job')
  await agedChat(jobHost, 'session-job')
  jobHost.jobs.set('job-1', { id: 'job-1', owner: 'session-job', status: 'running' })
  check(await jobHost.temp.sweepExpiry(NOW) === false, 'an owned job did not keep its chat')
  process.stdout.write('kept session-job\n')

  const heldHost = await hostFor('held')
  await agedChat(heldHost, 'session-held')
  const heldAgent = { status: 'idle', whenIdle: async () => {} }
  heldHost.agents.set('session-held', heldAgent)
  check(await heldHost.temp.sweepExpiry(NOW) === true, 'an idle held agent was not marked')
  check(heldHost.temp.state.sessions['session-held'].pendingDelete === true, 'the held chat was not hidden')
  check(existsSync(join(heldHost.root, 'sessions', 'project', 'session-held')) === true, 'the held folder was removed live')
  process.stdout.write('marked idle-held session-held\n')

  const raceHost = await hostFor('race')
  const raceChat = await agedChat(raceHost, 'session-race')
  raceHost.temp.expiryBusy = async () => {
    raceHost.temp.noteActivity(raceChat, { type: 'user/message', time: NOW })
    return false
  }
  check(await raceHost.temp.sweepExpiry(NOW) === false, 'the event before the commit did not abort expiry')
  await raceHost.temp.queue
  check(raceHost.temp.state.sessions['session-race'].pendingDelete === false, 'the raced chat was marked')
  process.stdout.write('aborted by event session-race\n')

  oldHost.live.clear()
  const restarted = new TemporarySessions(oldHost.deps)
  await restarted.start()
  check(existsSync(join(oldHost.root, 'sessions', 'project', 'session-old')) === false, 'the restart kept the expired folder')
  process.stdout.write('deleted at restart session-old\n')
} catch (error) {
  process.stderr.write(`probe failed: ${String(error)}\n`)
  process.exitCode = 1
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true })
}

// An assertion failure must never leave a successful exit code behind.
assert.equal(process.exitCode ?? 0, 0)
