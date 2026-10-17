/**
 * Browser half of the temporary-session bundle.
 *
 * Adds a "临时会话" entry to the sidebar foot, a temporary marker plus an end
 * action in a temporary Session's header, and a small badge on session rows.
 * Creating one asks the Host to adopt a fresh Session; the Host deletes its
 * log when the application exits.
 */

window.__ModuleLoader__.load({
  id: 'dsh-temp-session-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dshTempSession'

    /** Strict codecs identical to the Host contribution in remote.js. */
    const strict = (name, parse) => ({
      mode: 'strict',
      typeSymbol: `dsh-temp-session-plugin#${name}`,
      create: () => ({ parse }),
    })

    const sessionRequest = strict('SessionRequest', (value) => {
      if (value === null || typeof value !== 'object' || typeof value.sessionId !== 'string' || value.sessionId === '') {
        throw new Error('temporary session requests require a non-empty sessionId')
      }
      return { sessionId: value.sessionId }
    })
    const registerRequest = strict('RegisterRequest', (value) => {
      const base = sessionRequest.create().parse(value)
      return { ...base, title: typeof value.title === 'string' ? value.title : '' }
    })
    const registerResult = strict('RegisterResult', (value) => {
      if (value === null
        || typeof value !== 'object'
        || typeof value.sessionId !== 'string'
        || !Number.isSafeInteger(value.createdAt)) {
        throw new Error('temporary session registration returned an invalid record')
      }
      return { sessionId: value.sessionId, createdAt: value.createdAt }
    })
    const listedRecord = strict('ListedRecord', (value) => {
      const parsed = registerResult.create().parse(value)
      return { sessionId: parsed.sessionId, createdAt: parsed.createdAt }
    })
    const listResult = strict('ListResult', (value) => {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.sessions)) {
        throw new Error('temporary session listing returned an invalid payload')
      }
      return { sessions: value.sessions.map(item => listedRecord.create().parse(item)) }
    })
    const discardResult = strict('DiscardResult', (value) => {
      if (value === null || typeof value !== 'object' || value.discarded !== true) {
        throw new Error('temporary session discard returned an invalid receipt')
      }
      return { discarded: true }
    })

    const remoteContribution = {
      package: 'dsh-temp-session-plugin',
      descriptors: [
        {
          id: 'dsh-temp-session-plugin#tempSession/register',
          service: 'tempSessionsHost',
          namespace: 'tempSession',
          method: 'register',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: registerRequest }],
          result: registerResult,
        },
        {
          id: 'dsh-temp-session-plugin#tempSession/list',
          service: 'tempSessionsHost',
          namespace: 'tempSession',
          method: 'list',
          invocation: { kind: 'direct' },
          parameters: [],
          result: listResult,
        },
        {
          id: 'dsh-temp-session-plugin#tempSession/discard',
          service: 'tempSessionsHost',
          namespace: 'tempSession',
          method: 'discard',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: sessionRequest }],
          result: discardResult,
        },
      ],
    }

    const zh = {
      create: '临时会话',
      createHint: '新建临时会话，退出应用后自动删除',
      creating: '正在创建临时会话…',
      badge: '临时',
      badgeHint: '临时会话：退出应用后自动删除',
      end: '结束临时会话',
      endHint: '结束并隐藏这个临时会话，退出应用后彻底删除',
      activeCount: '当前有 {count} 个临时会话',
      title: '临时会话 · {time}',
      failed: '临时会话创建失败：{message}',
      endFailed: '结束临时会话失败：{message}',
      dismiss: '关闭提示',
    }
    const en = {
      create: 'Temporary chat',
      createHint: 'Start a temporary chat that is deleted when the app exits',
      creating: 'Creating a temporary chat…',
      badge: 'Temporary',
      badgeHint: 'Temporary chat: deleted when the app exits',
      end: 'End temporary chat',
      endHint: 'End and hide this temporary chat; its log is deleted when the app exits',
      activeCount: '{count} temporary chats are active',
      title: 'Temporary chat · {time}',
      failed: 'Could not create a temporary chat: {message}',
      endFailed: 'Could not end the temporary chat: {message}',
      dismiss: 'Dismiss',
    }

    const css = `
.dts-footer{flex:1;min-width:0;display:flex;align-items:center;justify-content:flex-start;gap:8px;height:42px;margin:4px -2px;padding:0 10px 0 8px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow:hidden}
.dts-footer:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dts-footer:disabled{opacity:.6;cursor:default}
.dts-footer.dts-rail{flex:none;width:36px;height:36px;margin:0;padding:0;justify-content:center}
.dts-footerLabel{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dts-count{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1}
.dts-icon{display:inline-flex;flex:none}
.dts-headerAction{display:inline-flex;align-items:center;gap:4px;min-width:0}
.dts-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}
.dts-iconButton{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dts-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dts-dock{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:6px 10px;box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-dockLabel{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dts-dockEnd{flex:none;display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dts-dockEnd:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dts-rowBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}
.dts-menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;text-align:left;white-space:nowrap;cursor:pointer}
.dts-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dts-notice{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1200;display:flex;align-items:center;gap:10px;max-width:min(520px,calc(100vw - 48px));padding:10px 12px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-1);font-size:13px;line-height:18px}
.dts-noticeText{min-width:0;word-break:break-word}
.dts-noticeClose{flex:none;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1;padding:2px 5px;cursor:pointer}
.dts-noticeClose:hover{background:var(--dsw-alias-interactive-bg-hover)}
`

    function ClockChatIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M20 11.5A8 8 0 1 1 12 4' }),
      h('path', { d: 'M20 4v4.5h-4.5' }),
      h('path', { d: 'M12 8v4l2.8 2' }))
    }

    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9 7V5h6v2' }),
      h('path', { d: 'M6.5 7l.9 12h9.2l.9-12' }),
      h('path', { d: 'M10 11v5M14 11v5' }))
    }

    function BubbleBadgeIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M2.5 7.5a5 5 0 0 1 5-5h1a5 5 0 0 1 5 5v.5a5 5 0 0 1-5 5H6l-3 2v-3.2a5 5 0 0 1-.5-2.3z' }),
      h('path', { d: 'M5.5 8h.01M8 8h.01M10.5 8h.01' }))
    }

    /** Small external store for the browser's view of temporary ids. */
    function createStore() {
      let snapshot = { ids: new Set(), creating: false, notice: null }
      let noticeSeq = 0
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() { return snapshot },
        setIds(ids) {
          snapshot = { ...snapshot, ids: new Set(ids) }
          emit()
        },
        add(id) {
          if (snapshot.ids.has(id)) return
          const next = new Set(snapshot.ids)
          next.add(id)
          snapshot = { ...snapshot, ids: next }
          emit()
        },
        remove(id) {
          if (!snapshot.ids.has(id)) return
          const next = new Set(snapshot.ids)
          next.delete(id)
          snapshot = { ...snapshot, ids: next }
          emit()
        },
        setCreating(creating) {
          if (snapshot.creating === creating) return
          snapshot = { ...snapshot, creating }
          emit()
        },
        notify(text) {
          const notice = { id: ++noticeSeq, text }
          snapshot = { ...snapshot, notice }
          emit()
          setTimeout(() => {
            if (snapshot.notice?.id !== notice.id) return
            snapshot = { ...snapshot, notice: null }
            emit()
          }, 7000)
        },
        dismiss() {
          if (snapshot.notice === null) return
          snapshot = { ...snapshot, notice: null }
          emit()
        },
      }
    }

    /** Render the sidebar-foot "start a temporary chat" entry. */
    function CreateEntry({ wide, t, actions, store }) {
      const { creating, ids } = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      const label = creating ? t('creating') : t('create')
      return h('button', {
        type: 'button',
        className: wide ? 'dts-footer' : 'dts-footer dts-rail',
        'aria-label': !creating && ids.size > 0 ? `${label} — ${t('activeCount', { count: ids.size })}` : label,
        title: t('createHint'),
        disabled: creating,
        onClick: () => { actions.create() },
      },
      h('span', { className: 'dts-icon' }, h(ClockChatIcon, { size: wide ? 16 : 18 })),
      wide ? h('span', { className: 'dts-footerLabel' }, label) : null,
      !creating && ids.size > 0 ? h('span', { className: 'dts-count', 'aria-label': t('activeCount', { count: ids.size }) }, String(ids.size)) : null)
    }

    /** Temporary marker for the open temporary Session's title row. */
    function HeaderAction({ sessionId, t, store }) {
      const ids = React.useSyncExternalStore(store.subscribe, () => store.getSnapshot().ids)
      if (!ids.has(sessionId)) return null
      return h('span', { className: 'dts-chip', title: t('badgeHint') }, t('badge'))
    }

    /**
     * Marker and end action above the composer. This slot also renders for a
     * blank Session's New Session view, where the title row does not exist yet,
     * so it is the one place a freshly created temporary Session stays
     * identifiable and can be ended.
     */
    function TempDock({ sessionId, t, actions, store }) {
      const ids = React.useSyncExternalStore(store.subscribe, () => store.getSnapshot().ids)
      if (!ids.has(sessionId)) return null
      return h('div', { className: 'dts-dock' },
        h('span', { className: 'dts-dockLabel', title: t('badgeHint') },
          h(BubbleBadgeIcon),
          h('span', null, t('badgeHint'))),
        h('button', {
          type: 'button',
          className: 'dts-dockEnd',
          title: t('endHint'),
          onClick: () => { void actions.end(sessionId) },
        }, h(TrashIcon), h('span', null, t('end'))))
    }

    /** Leading badge on a temporary Session's sidebar row. */
    function RowBadge({ sessionId, t, store }) {
      const ids = React.useSyncExternalStore(store.subscribe, () => store.getSnapshot().ids)
      if (!ids.has(sessionId)) return null
      return h('span', {
        className: 'dts-rowBadge',
        role: 'img',
        'aria-label': t('badge'),
        title: t('badgeHint'),
      }, h(BubbleBadgeIcon))
    }

    /** Transient failure notice rendered through the frame-wide overlay slot. */
    function Notice({ t, store }) {
      const { notice } = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      if (notice === null) return null
      return h('div', { className: 'dts-notice', role: 'status' },
        h('span', { className: 'dts-noticeText' }, notice.text),
        h('button', {
          type: 'button',
          className: 'dts-noticeClose',
          'aria-label': t('dismiss'),
          onClick: () => { store.dismiss() },
        }, '\u00d7'))
    }

    /** Sidebar row-menu entry that ends a temporary Session without opening it. */
    function EndMenuItem({ sessionId, t, actions, store, useMenuOpenState }) {
      const ids = React.useSyncExternalStore(store.subscribe, () => store.getSnapshot().ids)
      const [, setMenuOpen] = useMenuOpenState()
      if (!ids.has(sessionId)) return null
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dts-menuItem',
        onClick: (event) => {
          event.stopPropagation()
          setMenuOpen(false)
          void actions.end(sessionId)
        },
      }, h(TrashIcon), h('span', null, t('end')))
    }

    /** Human-readable message of an arbitrary failure. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Format a short local creation time for the Session title. */
    function timeLabel() {
      try {
        return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date())
      } catch {
        return new Date().toTimeString().slice(0, 5)
      }
    }

    /**
     * Mount the browser half once the Remote namespace exists.
     * @param {object} ctx - browser context carrying the injected services.
     * @param {string} NS - locale namespace.
     * @param {() => Promise<void>} unmount - disposer returned by `$mount`.
     */
    function mountUI(ctx, t, unmount) {
      const store = createStore()
      const ending = new Set()

      const log = typeof ctx.logger === 'function' ? ctx.logger('temp-session') : ctx.logger

      ctx.effect(() => () => { void unmount() }, 'temp-session: Remote unmount')

      /** Best-effort hide for a Session whose registration failed. */
      const hide = async (sessionId) => {
        try {
          await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
        } catch (error) {
          log?.warn?.(`could not hide an unregistered temporary session: ${String(error)}`)
        }
      }

      /** Cwd for the new Session: the open Session's project, then the first Workspace. */
      const resolveCwd = () => {
        const currentId = ctx.sessions.currentProvideInfo?.getSnapshot?.().sessionId
        const fromSession = currentId === undefined
          ? undefined
          : ctx.sessions.list.getSnapshot().byId[currentId]?.cwd
        if (typeof fromSession === 'string' && fromSession !== '') return fromSession
        const fromWorkspace = ctx.workspaces?.list?.getSnapshot?.().items?.[0]?.path
        return typeof fromWorkspace === 'string' && fromWorkspace !== '' ? fromWorkspace : undefined
      }

      const actions = {
        async create() {
          if (store.getSnapshot().creating) return
          store.setCreating(true)
          try {
            const cwd = resolveCwd()
            const sessionId = await ctx.sessions.create(cwd === undefined ? {} : { cwd })
            const result = await ctx.remote.tempSession.register({
              sessionId,
              title: t('title', { time: timeLabel() }),
            })
            if (!result.ok) {
              await hide(sessionId)
              throw result.error
            }
            store.add(result.value.sessionId)
            ctx.uiWorkspace.openSession(result.value.sessionId)
          } catch (error) {
            log?.warn?.(`could not create a temporary session: ${String(error)}`)
            store.notify(t('failed', { message: messageOf(error) }))
          } finally {
            store.setCreating(false)
          }
        },

        async end(sessionId) {
          if (ending.has(sessionId)) return
          ending.add(sessionId)
          try {
            try {
              await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
            } catch (error) {
              // The Host still owns the record; the log is deleted at exit.
              log?.warn?.(`could not archive an ended temporary session: ${String(error)}`)
            }
            const result = await ctx.remote.tempSession.discard({ sessionId })
            if (!result.ok) throw result.error
            store.remove(sessionId)
          } catch (error) {
            log?.warn?.(`could not end a temporary session: ${String(error)}`)
            store.notify(t('endFailed', { message: messageOf(error) }))
          } finally {
            ending.delete(sessionId)
          }
        },
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-temp-session-plugin'
        style.textContent = css
        document.head.append(style)
        return () => { style.remove() }
      }, 'temp-session: styles')

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'temp-session-create',
        order: 10,
        locale: NS,
        inject: () => ({ actions, store }),
      }, CreateEntry))

      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'temp-session-chip',
        order: 30,
        locale: NS,
        inject: () => ({ store }),
      }, HeaderAction))

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'temp-session-dock',
        order: 10,
        locale: NS,
        inject: () => ({ actions, store }),
      }, TempDock))

      ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
        name: 'sidebar.session.row.leading',
        id: 'temp-session-badge',
        order: 10,
        locale: NS,
        inject: () => ({ store }),
      }, RowBadge))

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'temp-session-end',
        order: 425,
        locale: NS,
        inject: () => ({ actions, store }),
      }, EndMenuItem))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'temp-session-notice',
        order: 100,
        locale: NS,
        inject: () => ({ store }),
      }, Notice))

      // Hydrate the marker set from the Host, so a page reload keeps badges.
      void (async () => {
        try {
          const result = await ctx.remote.tempSession.list()
          if (result.ok) store.setIds(result.value.sessions.map(record => record.sessionId))
          else log?.warn?.(`could not list temporary sessions: ${result.error.message}`)
        } catch (error) {
          log?.warn?.(`could not list temporary sessions: ${String(error)}`)
        }
      })()
    }

    return {
      inject: ['remote', 'slots', 'sessions', 'workspaces', 'locale', 'uiWorkspace'],
      async apply(ctx) {
        const unmount = await ctx.remote.$mount(remoteContribution)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'temp-session: locale')
        const t = ctx.locale.bind(NS)
        ctx.inject(['remote.tempSession'], (inner) => {
          mountUI(inner, t, unmount)
        })
      },
    }
  },
})
