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
      if (value.kind !== undefined && value.kind !== 'main' && value.kind !== 'side') {
        throw new Error('temporary session kind must be "main" or "side"')
      }
      return {
        ...base,
        title: typeof value.title === 'string' ? value.title : '',
        kind: value.kind === 'side' ? 'side' : 'main',
      }
    })
    const promoteRequest = strict('PromoteRequest', (value) => {
      const base = sessionRequest.create().parse(value)
      return { ...base, title: typeof value.title === 'string' ? value.title : '' }
    })
    const promoteResult = strict('PromoteResult', (value) => {
      if (value === null || typeof value !== 'object' || value.promoted !== true) {
        throw new Error('temporary session promotion returned an invalid receipt')
      }
      return { promoted: true }
    })
    const registerResult = strict('RegisterResult', (value) => {
      if (value === null
        || typeof value !== 'object'
        || typeof value.sessionId !== 'string'
        || !Number.isSafeInteger(value.createdAt)
        || (value.kind !== 'main' && value.kind !== 'side')
        || typeof value.pendingDelete !== 'boolean') {
        throw new Error('temporary session registration returned an invalid record')
      }
      return {
        sessionId: value.sessionId,
        createdAt: value.createdAt,
        kind: value.kind,
        pendingDelete: value.pendingDelete,
      }
    })
    const listedRecord = strict('ListedRecord', (value) => registerResult.create().parse(value))
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
        {
          id: 'dsh-temp-session-plugin#tempSession/promote',
          service: 'tempSessionsHost',
          namespace: 'tempSession',
          method: 'promote',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: promoteRequest }],
          result: promoteResult,
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
      mark: '临时',
      markHint: '把当前新会话标记为临时会话，退出应用后删除',
      markFailed: '标记临时会话失败：{message}',
      title: '临时会话 · {time}',
      failed: '临时会话创建失败：{message}',
      endFailed: '结束临时会话失败：{message}',
      dismiss: '关闭提示',
      selectionStart: '临时会话',
      selectionHint: '选中文字，开始一个继承当前上下文的临时会话',
      sideFailed: '临时会话启动失败：{message}',
      sideNoParent: '请先打开一个会话，再选中文字开始临时会话',
      sideNoBoundary: '当前会话还没有完成的回合，暂时无法继承上下文',
      sideTab: '临时会话',
      sideBar: '临时会话 · 退出应用后删除',
      promote: '提升为长期会话',
      promoteHint: '保留这段对话，使它不再随应用退出而删除',
      promotedTitle: '会话 · {time}',
      promoteFailed: '提升长期会话失败：{message}',
      sideLoading: '正在打开临时会话…',
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
      mark: 'Temporary',
      markHint: 'Mark this new chat as temporary; its log is deleted when the app exits',
      markFailed: 'Could not mark the chat as temporary: {message}',
      title: 'Temporary chat · {time}',
      failed: 'Could not create a temporary chat: {message}',
      endFailed: 'Could not end the temporary chat: {message}',
      dismiss: 'Dismiss',
      selectionStart: 'Temporary chat',
      selectionHint: 'Start a temporary chat that inherits this conversation',
      sideFailed: 'Could not start the temporary chat: {message}',
      sideNoParent: 'Open a conversation and select text to start a temporary chat',
      sideNoBoundary: 'This conversation has no completed turn to inherit yet',
      sideTab: 'Temporary chat',
      sideBar: 'Temporary chat · deleted when the app exits',
      promote: 'Keep as long-term chat',
      promoteHint: 'Keep this conversation; stop deleting it when the app exits',
      promotedTitle: 'Chat · {time}',
      promoteFailed: 'Could not keep the chat: {message}',
      sideLoading: 'Opening the temporary chat…',
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
.dts-heroPill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
.dts-heroPill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dts-heroPill:disabled{cursor:default}
.dts-heroPillActive{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:transparent}
.dts-dock{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:6px 10px;box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-dockLabel{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dts-dockEnd{flex:none;display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dts-dockEnd:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dts-rowBadge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}
.dts-menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;text-align:left;white-space:nowrap;cursor:pointer}
.dts-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dts-sidechat{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0}
.dts-sidebar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dts-sidebarLabel{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dts-sidebarPromote{flex:none;padding:3px 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dts-sidebarPromote:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dts-sidechatBody{flex:1;min-height:0;display:flex;flex-direction:column;width:100%;overflow:hidden}
.dts-sidechatLoading{padding:12px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dts-selectionAction{position:fixed;z-index:1300;transform:translate(-50%,0);display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;box-shadow:0 4px 14px var(--dsw-alias-bg-mask-1)}
.dts-selectionAction:hover{background:var(--dsw-alias-interactive-bg-hover)}
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

    /**
     * Small external store for the browser's view of temporary Sessions.
     * `ids` are active (badge/count) sessions; `side` are forked side chats
     * hidden from the main sidebar, including ones already ended.
     */
    function createStore() {
      let snapshot = { ids: new Set(), side: new Set(), selection: null, creating: false, notice: null }
      let noticeSeq = 0
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() { return snapshot },
        hydrate(records) {
          const ids = new Set()
          const side = new Set()
          for (const record of records) {
            if (record.kind === 'side') side.add(record.sessionId)
            if (record.pendingDelete !== true) ids.add(record.sessionId)
          }
          snapshot = { ...snapshot, ids, side }
          emit()
        },
        add(id, kind = 'main') {
          const ids = new Set(snapshot.ids)
          ids.add(id)
          const side = kind === 'side' ? new Set(snapshot.side).add(id) : snapshot.side
          snapshot = { ...snapshot, ids, side }
          emit()
        },
        markEnded(id) {
          const ids = new Set(snapshot.ids)
          ids.delete(id)
          snapshot = { ...snapshot, ids }
          emit()
        },
        promote(id) {
          const ids = new Set(snapshot.ids)
          ids.delete(id)
          const side = new Set(snapshot.side)
          side.delete(id)
          snapshot = { ...snapshot, ids, side }
          emit()
        },
        setSelection(selection) {
          if (snapshot.selection === selection) return
          snapshot = { ...snapshot, selection }
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

    /**
     * Compact New Session option that adopts the already created, workspace-bound
     * blank Session as temporary. The normal New Session flow chooses the
     * workspace, so the temporary chat never asks for one afterwards.
     */
    function HeroOption({ sessionId, t, actions, store }) {
      const ids = React.useSyncExternalStore(store.subscribe, () => store.getSnapshot().ids)
      const active = ids.has(sessionId)
      return h('button', {
        type: 'button',
        className: active ? 'dts-heroPill dts-heroPillActive' : 'dts-heroPill',
        'aria-pressed': active,
        title: t(active ? 'badgeHint' : 'markHint'),
        disabled: active,
        onClick: () => { void actions.markCurrent(sessionId) },
      },
      h(ClockChatIcon, { size: 13 }),
      h('span', null, t('mark')))
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
      const { ids, side } = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      // A forked side chat carries its own bar in the right pane; the main
      // conversation's composer dock would duplicate that marker and offer the
      // wrong end action.
      if (!ids.has(sessionId) || side.has(sessionId)) return null
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

    // ---- Forked side chats in the right sidebar ----

    const TEMPCHAT_PREFIX = 'dsh-resource://tempchat/session/'

    /** Canonical resource address for one temporary side chat. */
    function tempChatAddress(sessionId) {
      return TEMPCHAT_PREFIX + encodeURIComponent(sessionId)
    }

    /** Session id encoded in a tempchat resource address, or undefined. */
    function parseTempChatAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(TEMPCHAT_PREFIX)) return undefined
      const encoded = address.slice(TEMPCHAT_PREFIX.length)
      if (encoded === '' || encoded.includes('/')) return undefined
      try {
        const id = decodeURIComponent(encoded)
        return id === '' ? undefined : id
      } catch {
        return undefined
      }
    }

    /** Quote selected text for the side chat's draft. */
    function quoteSelection(text) {
      const trimmed = String(text).trim()
      const clipped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\u2026` : trimmed
      return `${clipped.split('\n').map(line => `> ${line}`).join('\n')}\n\n`
    }

    /** A lasting Session title derived from the selected text. */
    function promotionTitle(text, t, time) {
      const first = String(text).split('\n')
        .map(line => line.replace(/^>\s?/, '').trim())
        .find(line => line !== '')
      if (first === undefined) return t('promotedTitle', { time })
      return first.length > 40 ? `${first.slice(0, 40)}\u2026` : first
    }

    /** Remove hidden side-chat Sessions from a Sessions list snapshot. */
    function withoutSideSessions(snapshot, hidden) {
      if (snapshot === undefined || hidden.size === 0) return snapshot
      const ids = snapshot.ids.filter(id => !hidden.has(id))
      if (ids.length === snapshot.ids.length) return snapshot
      const byId = { ...snapshot.byId }
      for (const id of hidden) delete byId[id]
      return { ...snapshot, ids, byId }
    }

    /** Fixed Chat view for the embedded side conversation. */
    function TempChatView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    /** Native Conversation content rendered inside one side-chat tab. */
    function TempChatConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
      const session = useSession(value => value)
      const conversation = useConversation(value => value)
      const active = conversation.activeTargets.size > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
      const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
      const settling = !active && session.openState === 'loading' && summaryBlank !== true
      const hero = !active && (session.openState === 'open' || summaryBlank === true)
      return renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : hero ? 'hero' : 'active',
        hero,
      }, { slots: { views: TempChatView } })
    }

    /** Right-sidebar tab body: a temporary bar plus the native conversation. */
    function TempChatTab({ useResource, useTabInfo, SessionProvider, renderSlot, t, store, actions }) {
      const { tab } = useTabInfo()
      const resource = useResource(tab.contentId)
      const sessionId = parseTempChatAddress(tab.contentId)
      const active = React.useSyncExternalStore(
        store.subscribe,
        () => sessionId !== undefined && store.getSnapshot().ids.has(sessionId),
      )
      return h('div', { className: 'dts-sidechat', 'data-sidebar-chat': '' },
        active && sessionId !== undefined
          ? h('div', { className: 'dts-sidebar' },
              h('span', { className: 'dts-sidebarLabel' },
                h(BubbleBadgeIcon),
                h('span', null, t('sideBar'))),
              h('button', {
                type: 'button',
                className: 'dts-sidebarPromote',
                title: t('promoteHint'),
                onClick: () => { void actions.promote(sessionId) },
              }, t('promote')))
          : null,
        h('div', { className: 'dts-sidechatBody' },
          resource.value === undefined
            ? h('p', { className: 'dts-sidechatLoading', role: 'status' }, t('sideLoading'))
            : h(SessionProvider, { session: resource.value.reference },
                renderSlot('dts.tempchat.conversation', {}))))
    }

    /** Floating action shown after a text selection in the main conversation. */
    function SelectionAction({ t, store, actions }) {
      const { selection } = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      if (selection === null) return null
      return h('button', {
        type: 'button',
        className: 'dts-selectionAction',
        style: { left: `${selection.x}px`, top: `${selection.y}px` },
        title: t('selectionHint'),
        onMouseDown: (event) => { event.preventDefault(); event.stopPropagation() },
        onClick: () => {
          const text = selection.text
          store.setSelection(null)
          void actions.startSideChat(text)
        },
      }, h(ClockChatIcon, { size: 13 }), h('span', null, t('selectionStart')))
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
      const sideRefs = new Map()
      const sideQuotes = new Map()
      const closingSide = new Set()
      let startingSide = false

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

      /**
       * The Session shown in the main view. The provide channel is the direct
       * source; the list's main-view retention count is the same fact the
       * sidebar uses to highlight the current row, and works before that
       * channel materializes.
       */
      const currentSessionId = () => {
        const provided = ctx.sessions.currentProvideInfo?.getSnapshot?.().sessionId
        if (provided !== undefined) return provided
        const sessions = ctx.sessions.list.getSnapshot()
        return Object.values(sessions.byId)
          .find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id
      }

      /**
       * Workspace for a new temporary Session: the open Session's workspace,
       * then one matched by its cwd, then the workspace of the most recently
       * active Session, then the first Workspace. Attaching to a Workspace is
       * what keeps the composer usable instead of asking to choose one.
       */
      const resolveWorkspace = () => {
        const sessions = ctx.sessions.list.getSnapshot()
        const items = ctx.workspaces?.list?.getSnapshot?.().items ?? []
        const currentId = currentSessionId()
        if (currentId !== undefined) {
          const member = items.find(item => item.sessionIds.includes(currentId))
          if (member !== undefined) return member
          const cwd = sessions.byId[currentId]?.cwd
          if (typeof cwd === 'string' && cwd !== '') {
            const byPath = items.find(item => item.path === cwd)
            if (byPath !== undefined) return byPath
          }
        }
        for (const id of sessions.ids) {
          const owner = items.find(item => item.sessionIds.includes(id))
          if (owner !== undefined) return owner
        }
        return items[0]
      }

      /** Title shared by the footer entry and the New Session option. */
      const tempTitle = () => t('title', { time: timeLabel() })

      const actions = {
        async create() {
          if (store.getSnapshot().creating) return
          store.setCreating(true)
          try {
            const workspace = resolveWorkspace()
            const sessionId = await ctx.sessions.create(
              workspace === undefined ? {} : { workspaceId: workspace.workspaceId },
            )
            const result = await ctx.remote.tempSession.register({
              sessionId,
              title: tempTitle(),
            })
            if (!result.ok) {
              await hide(sessionId)
              throw result.error
            }
            store.add(result.value.sessionId, result.value.kind)
            ctx.uiWorkspace.openSession(result.value.sessionId)
          } catch (error) {
            log?.warn?.(`could not create a temporary session: ${String(error)}`)
            store.notify(t('failed', { message: messageOf(error) }))
          } finally {
            store.setCreating(false)
          }
        },

        /**
         * Adopt the already open, workspace-bound blank Session as temporary.
         * This is the workspace-first flow: the user created a New Session in
         * a Workspace and opted into the temporary lifetime before typing.
         */
        async markCurrent(sessionId) {
          if (store.getSnapshot().ids.has(sessionId)) return
          try {
            const result = await ctx.remote.tempSession.register({
              sessionId,
              title: tempTitle(),
            })
            if (!result.ok) throw result.error
            store.add(result.value.sessionId, result.value.kind)
          } catch (error) {
            log?.warn?.(`could not mark a temporary session: ${String(error)}`)
            store.notify(t('markFailed', { message: messageOf(error) }))
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
            store.markEnded(sessionId)
          } catch (error) {
            log?.warn?.(`could not end a temporary session: ${String(error)}`)
            store.notify(t('endFailed', { message: messageOf(error) }))
          } finally {
            ending.delete(sessionId)
          }
        },

        /**
         * Fork the open conversation into a temporary side chat, prefill the
         * selected text as a quote, and open the native chat in the right
         * sidebar. The fork inherits the parent's workspace on the Host.
         */
        async startSideChat(selectedText) {
          if (startingSide === true) return
          startingSide = true
          let forkId
          try {
            const parentId = currentSessionId()
            if (parentId === undefined) {
              store.notify(t('sideNoParent'))
              return
            }
            const parent = ctx.sessions.list.getSnapshot().byId[parentId]
            if (parent !== undefined && parent.blank === true) {
              store.notify(t('sideNoBoundary'))
              return
            }
            forkId = await ctx.sessions.fork({ sessionId: parentId })
            const result = await ctx.remote.tempSession.register({
              sessionId: forkId,
              title: tempTitle(),
              kind: 'side',
            })
            if (!result.ok) {
              await hide(forkId)
              forkId = undefined
              throw result.error
            }
            store.add(result.value.sessionId, 'side')
            sideQuotes.set(forkId, selectedText)
            const reference = ctx.sessions.retain(forkId, { source: 'controllerOperation' })
            sideRefs.set(forkId, reference)
            try {
              await reference.ready
              const applied = ctx.conversation.input.requestDraftInitialization(
                reference.binding,
                { prompt: quoteSelection(selectedText) },
              )
              if (applied !== 'applied') log?.warn?.(`side-chat draft was not applied: ${applied}`)
            } catch (error) {
              log?.warn?.(`could not prefill the side-chat draft: ${String(error)}`)
            }
            ctx.sidebarRight.openResource(tempChatAddress(forkId), {
              kind: 'tempchat',
              preferNewPane: true,
            })
          } catch (error) {
            log?.warn?.(`could not start a temporary side chat: ${String(error)}`)
            store.notify(t('sideFailed', { message: messageOf(error) }))
          } finally {
            startingSide = false
          }
        },

        /** Drop the temporary record so exit cleanup keeps the fork forever. */
        async promote(sessionId) {
          try {
            const result = await ctx.remote.tempSession.promote({
              sessionId,
              title: promotionTitle(sideQuotes.get(sessionId) ?? '', t, timeLabel()),
            })
            if (!result.ok) throw result.error
            store.promote(sessionId)
            sideQuotes.delete(sessionId)
            void ctx.sessions.refreshProjections?.(sessionId)?.catch?.((error) => {
              log?.warn?.(`could not refresh the promoted session title: ${String(error)}`)
            })
          } catch (error) {
            log?.warn?.(`could not promote a temporary side chat: ${String(error)}`)
            store.notify(t('promoteFailed', { message: messageOf(error) }))
          }
        },

        /** Close a side chat: discard its log unless it was promoted. */
        async closeSide(sessionId) {
          if (closingSide.has(sessionId)) return
          closingSide.add(sessionId)
          try {
            const reference = sideRefs.get(sessionId)
            sideRefs.delete(sessionId)
            try { reference?.release?.() } catch (error) { log?.warn?.(`side-chat release failed: ${String(error)}`) }
            if (store.getSnapshot().ids.has(sessionId)) {
              const result = await ctx.remote.tempSession.discard({ sessionId })
              if (!result.ok) throw result.error
              store.markEnded(sessionId)
            }
            sideQuotes.delete(sessionId)
          } catch (error) {
            log?.warn?.(`could not close a temporary side chat: ${String(error)}`)
            store.notify(t('endFailed', { message: messageOf(error) }))
          } finally {
            closingSide.delete(sessionId)
          }
        },
      }

      // ---- Temporary side chats: resource, tab type, and body ----
      if (ctx.resources !== undefined && ctx.sidebarRightTabs !== undefined && ctx.sidebarRight !== undefined) {
        ctx.effect(() => ctx.resources.register({
          protocol: 'tempchat',
          async *open(address, { signal }) {
            const sessionId = parseTempChatAddress(address)
            if (sessionId === undefined) throw new Error(`invalid temporary side-chat address "${address}"`)
            if (signal.aborted) return
            const reference = ctx.sessions.retain(sessionId, { source: 'sidebarChat', signal })
            try {
              yield { ok: true, value: { sessionId, reference } }
              if (!signal.aborted) {
                await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
              }
            } finally {
              reference.release()
            }
          },
        }), 'temp-session: side-chat resource')

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: 'dsh-temp-session-plugin',
          kind: 'tempchat',
          patterns: [`${TEMPCHAT_PREFIX}**`],
          priority: 'extension',
          multiple: true,
          keepMounted: true,
          canOpen: address => parseTempChatAddress(address) !== undefined,
          title: (address) => {
            const sessionId = parseTempChatAddress(address)
            const title = sessionId === undefined
              ? undefined
              : ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.title
            return typeof title === 'string' && title !== '' ? title : t('sideTab')
          },
        }), 'temp-session: side-chat type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: 'dsh-temp-session-plugin',
          locale: NS,
          inject: () => ({ t, store, actions }),
          children: { 'dts.tempchat.conversation': { kind: 'single', scope: 'session' } },
        }, TempChatTab)), 'temp-session: side-chat tab')

        ctx.effect(() => ctx.slots.inject('dts.tempchat.conversation', () => ctx.slots.register({
          name: 'dts.tempchat.conversation',
        }, TempChatConversation)), 'temp-session: side-chat conversation')

        ctx.effect(() => ctx.sidebarRight.registerCloseHandler('tempchat', (_parentId, tab) => {
          const sessionId = parseTempChatAddress(tab.contentId)
          if (sessionId !== undefined) void actions.closeSide(sessionId)
        }), 'temp-session: side-chat close')
      }

      // ---- Hide forked side chats from the main session list ----
      ctx.effect(() => {
        if (typeof ctx.slots.entriesOfSlot !== 'function') return () => {}
        const entry = ctx.slots.entriesOfSlot('sidebar.workspaces')
          .find(candidate => typeof candidate?.component === 'function')
        if (entry === undefined) {
          log?.warn?.('sidebar.workspaces entry is unavailable; side chats stay visible in the list')
          return () => {}
        }
        const native = entry.component
        function FilteredWorkspaceBrowser(props) {
          const hidden = React.useSyncExternalStore(store.subscribe, () => store.getSnapshot().side)
          const useSessions = props.useSessions === undefined
            ? undefined
            : (selector = value => value, equal) => props.useSessions(
                value => selector(withoutSideSessions(value, hidden)),
                equal,
              )
          const searchSessions = props.searchSessions === undefined
            ? undefined
            : async (...args) => {
                const result = await props.searchSessions(...args)
                if (result?.ok !== true || hidden.size === 0) return result
                return {
                  ...result,
                  value: {
                    ...result.value,
                    items: result.value.items.filter(item => !hidden.has(item.sessionId)),
                  },
                }
              }
          return h(native, { ...props, useSessions, searchSessions })
        }
        entry.component = FilteredWorkspaceBrowser
        return () => { if (entry.component === FilteredWorkspaceBrowser) entry.component = native }
      }, 'temp-session: hide side chats from the sidebar')

      // ---- Selection action ----
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'temp-session-selection',
        order: 120,
        locale: NS,
        inject: () => ({ t, store, actions }),
      }, SelectionAction))

      ctx.effect(() => {
        if (typeof document === 'undefined'
          || typeof document.addEventListener !== 'function'
          || typeof window === 'undefined'
          || typeof window.getSelection !== 'function') return () => {}
        const readSelection = () => {
          const selection = window.getSelection()
          if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
          const text = selection.toString().trim()
          if (text === '' || text.length > 6000) return undefined
          const range = selection.getRangeAt(0)
          const container = range.commonAncestorContainer
          const element = container.nodeType === 1 ? container : container.parentElement
          if (element === null || element === undefined) return undefined
          if (element.closest('[data-sidebar-chat]') !== null) return undefined
          if (element.closest('[data-conversation-scroll]') === null) return undefined
          if (element.closest('input, textarea, [contenteditable="true"]') !== null) return undefined
          const rect = range.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return undefined
          const x = Math.max(70, Math.min(window.innerWidth - 70, rect.left + rect.width / 2))
          const y = Math.min(window.innerHeight - 44, rect.bottom + 8)
          return { text, x, y }
        }
        const onPointerUp = () => {
          window.setTimeout(() => { store.setSelection(readSelection() ?? null) }, 0)
        }
        const onSelectionChange = () => {
          const selection = window.getSelection()
          if (selection === null || selection.isCollapsed) store.setSelection(null)
        }
        const onPointerDown = (event) => {
          const action = event.target?.closest?.('.dts-selectionAction')
          if (action !== null && action !== undefined) return
          store.setSelection(null)
        }
        const onScroll = () => { store.setSelection(null) }
        document.addEventListener('pointerup', onPointerUp)
        document.addEventListener('selectionchange', onSelectionChange)
        document.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('pointerup', onPointerUp)
          document.removeEventListener('selectionchange', onSelectionChange)
          document.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, 'temp-session: selection listeners')

      ctx.effect(() => () => {
        for (const reference of sideRefs.values()) {
          try { reference.release() } catch {}
        }
        sideRefs.clear()
      }, 'temp-session: release side-chat references')

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

      ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'temp-session-mark',
        order: 10,
        locale: NS,
        inject: () => ({ actions, store }),
      }, HeroOption))

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
          if (result.ok) store.hydrate(result.value.sessions)
          else log?.warn?.(`could not list temporary sessions: ${result.error.message}`)
        } catch (error) {
          log?.warn?.(`could not list temporary sessions: ${String(error)}`)
        }
      })()
    }

    return {
      inject: [
        'remote', 'slots', 'sessions', 'workspaces', 'locale', 'uiWorkspace',
        'resources', 'sidebarRight', 'sidebarRightTabs', 'conversation',
      ],
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
