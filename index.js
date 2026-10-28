/**
 * Host half of the temporary-session bundle.
 *
 * It records Sessions the browser creates as temporary, titles them, and
 * deletes their stored logs when the Host exits. A boot-time reap handles the
 * crash case; a process signal handler covers application quit, which does not
 * run Cordis disposal.
 *
 * @module dsh-temp-session-plugin
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  TemporarySessions,
  installProcessCleanup,
  statePaths,
} from './core.js'
import { tempSessionContribution } from './remote.js'

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
    get workspaceRegistry() { return ctx.get('workspaceRegistry') },
    logger: log,
    paths,
  })

  // Every announced Session passes here. A subagent under a recorded chat is recorded so exit,
  // discard, and promote handle it with its chat. The listener never throws synchronously: a
  // throw would roll back the Host attach, and a rejected promise is only logged.
  ctx.on('session/created', (session) => {
    temp.recordDescendant(session).catch((error) => {
      log.warn(`temporary-session child tracking failed: ${String(error)}`)
    })
  })

  // Reap before the browser can list Sessions: every recorded Session that
  // does not belong to a live Agent is a leftover from a previous run.
  try {
    await temp.reap()
  } catch (error) {
    log.warn(`temporary-session boot cleanup failed: ${String(error)}`)
  }

  // Ended Sessions are deleted as soon as the plugin unloads (for example a
  // live profile reload). Live temporary Sessions stay for the next boot.
  ctx.effect(() => () => temp.cleanupPending(), 'temp-session: ended cleanup')

  // A hard KillAgent shutdown sends SIGTERM without Cordis disposal: delete
  // synchronously there and at normal process exit.
  ctx.effect(() => installProcessCleanup(paths.file, log), 'temp-session: process cleanup')

  /**
   * Host service behind the `tempSession` Remote namespace. Methods are
   * discovered by name from the contributions registered below.
   */
  class TempSessionsHost extends TypertRemoteService {
    constructor(inner) {
      super(inner, 'tempSessionsHost', { namespace: 'tempSession' })
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
