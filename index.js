/**
 * Host half of the temporary-session bundle.
 *
 * It records Sessions the browser creates as temporary, titles them, and
 * coordinates their confirmed stop and stored-log deletion on plugin unload,
 * at process exit, or by the next boot after a hard kill. A process signal
 * handler covers application quit, which does not run Cordis disposal.
 *
 * @module dsh-temp-session-plugin
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  TemporarySessions,
  installExitCleanup,
  statePaths,
} from './core.js'
import { tempSessionContribution } from './remote.js'
import { createModelSanity } from './model-sanity.js'

/** Loader diagnostics name. */
export const name = 'temp-session'

/** Services this plugin needs before it can adopt or clean up Sessions. */
export const inject = ['sessions', 'sessionPersistence', 'sessionController', 'typert']

/**
 * Mount the temporary-session registry and its Host RPC namespace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export async function apply(ctx) {
  const log = typeof ctx.logger === 'function' ? ctx.logger('temp-session') : ctx.logger
  const paths = statePaths(process.env, ctx.get('dshHomePath'))
  const temp = new TemporarySessions({
    sessions: ctx.sessions,
    sessionPersistence: ctx.sessionPersistence,
    sessionController: ctx.sessionController,
    get agents() { return ctx.get('agents') },
    get goals() { return ctx.get('goals') },
    get jobs() { return ctx.get('jobs') },
    get workspaceRegistry() { return ctx.get('workspaceRegistry') },
    logger: log,
    paths,
  })

  // The model pass is advisory and only reads the unresolved backlog. It is
  // deliberately started by `temp.start()` after the deterministic boot, not
  // awaited there, so a missing or slow gateway cannot delay readiness.
  temp.modelSanity = createModelSanity(temp, paths)

  // Every announced Session passes here. A descendant of a recorded chat, at
  // any kind and depth, is queued, journaled before its registry write, and
  // reconciled to a fixed point. The listener never throws synchronously: a
  // throw would roll back the Host attach, and a rejected promise is only logged.
  ctx.on('session/created', (session) => {
    temp.recordDescendant(session).catch((error) => {
      log.warn(`temporary-session child tracking failed: ${String(error)}`)
    })
  })

  // Real Session events are the only clock for idle expiry. A listener that
  // throws would starve the Host's own event dispatch, so contain every error.
  ctx.on('session/event', (session, event) => {
    temp.noteActivity(session, event).catch((error) => {
      log.warn(`temporary-session activity tracking failed: ${String(error)}`)
    })
  })

  // Complete boot reconciliation and reap before the browser can list Sessions.
  // The ready promise also covers announcements queued while the stored listing
  // was being taken.
  try {
    await temp.start()
  } catch (error) {
    log.warn(`temporary-session boot cleanup failed: ${String(error)}`)
  }

  // Ended Sessions are deleted as soon as the plugin unloads (for example a
  // live profile reload). Live temporary Sessions stay for the next boot.
  ctx.effect(() => () => {
    temp.closeAdmission()
    return temp.cleanupPending()
  }, 'temp-session: ended cleanup')

  // A hard KillAgent shutdown sends SIGTERM without Cordis disposal: delete
  // synchronously there and at normal process exit. The handler reads the
  // immutable validated snapshot and never parses the registry file; the
  // binding deliberately outlives an unload, so an unloaded plugin still
  // deletes the Sessions it validated.
  installExitCleanup(() => temp.exitSnapshot(), log, paths.journal, () => temp.closeAdmission())

  /**
   * Host service behind the `tempSession` Remote namespace. Methods are
   * discovered by name from the contributions registered below.
   */
  class TempSessionsHost extends TypertRemoteService {
    constructor(inner) {
      super(inner, 'tempSessionsHost', { namespace: 'tempSession' })
    }

    reserve(request) {
      return temp.reserve(request)
    }

    register(request) {
      return temp.register(request)
    }

    list() {
      return temp.list()
    }

    discard(request) {
      return temp.discard(request)
    }

    promote(request) {
      return temp.promote(request)
    }
  }
  ctx.plugin(TempSessionsHost)
  ctx.effect(
    () => ctx.typert.register(tempSessionContribution),
    'temp-session: Remote contribution',
  )

  log.info(`temporary-session registry ready (${paths.file})`)
}
