/**
 * Browser-half wiring test. React is stubbed (components only call
 * createElement and useSyncExternalStore), so this runs without a browser or
 * a React install while still exercising apply, slot registration, and the
 * create/end action flows.
 */

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { tempSessionDescriptors } from '../remote.js'

/** Build an element tree with a minimal React. */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }
}

const React = {
  createElement,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Collect every rendered string. */
function texts(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.children)
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

/** Yield past the pending microtasks of one list read. */
function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

function makeStyle() {
  return {
    dataset: {},
    textContent: '',
    remove() {},
  }
}

async function loadBundle() {
  const code = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = {
    __ModuleLoader__: { load: value => { registration = value } },
    alert(message) { window.alerts.push(message) },
    alerts: [],
  }
  const document = {
    head: { append() {} },
    createElement: () => makeStyle(),
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'Intl', 'console', code)
  run(window, document, Intl, console)
  assert.equal(registration.id, 'dsh-temp-session-plugin')
  return { registration, window }
}

function makeContext() {
  const calls = {
    created: [],
    reserved: [],
    registered: [],
    opened: [],
    archived: [],
    discarded: [],
    forks: [],
    drafts: [],
    resources: [],
    openedResources: [],
    started: [],
    lists: 0,
    listReplies: [],
    closedTabs: [],
    closeAttempts: [],
    openTabs: [],
    unadoptedParents: new Set(),
    clearedMain: 0,
    currentSessionId: 'session-current',
    slots: [],
    locale: undefined,
  }
  const listeners = new Set()
  const sessionListeners = new Set()
  const openTabsListeners = new Set()
  const publishOpenTabs = (tabs) => {
    calls.openTabs = tabs
    for (const listener of openTabsListeners) listener()
  }
  calls.publishOpenTabs = publishOpenTabs
  const currentProvideInfo = {
    getSnapshot: () => ({ sessionId: calls.currentSessionId }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const store = {
    ids: [],
    byId: { 'session-current': { cwd: '/tmp/project', blank: false } },
  }
  const list = {
    getSnapshot: () => store,
    subscribe: (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener) },
  }
  const notifySessionList = () => { for (const listener of sessionListeners) listener() }
  const ctx = {
    logger: () => ({ warn() {}, info() {} }),
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(services, callback) { callback(ctx) },
    locale: {
      register(namespace, dictionaries) { calls.locale = { namespace, dictionaries }; return () => {} },
      bind() { return (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`) },
    },
    slots: {
      inject(name, factory) { calls.slots.push(name); factory() },
      register(options, component) { return () => {} },
      entriesOfSlot() { return [] },
    },
    sessions: {
      currentProvideInfo,
      list,
      notifySessionList,
      async create(options) { calls.created.push(options); return options.sessionId ?? 'session-new' },
      async fork(options) { calls.forks.push(options); return 'session-fork' },
      retain(id) {
        return {
          binding: { sessionId: id },
          ready: Promise.resolve(),
          release() {},
        }
      },
    },
    conversation: {
      input: {
        requestDraftInitialization(binding, options) {
          calls.drafts.push({ binding, options })
          return 'applied'
        },
      },
    },
    resources: { register(provider) { calls.resources.push(provider); return () => {} } },
    sidebarRightTabs: { register(definition) { calls.tabDefinition = definition; return () => {} } },
    sidebarRight: {
      tabs: [],
      openTabs: {
        getSnapshot: () => calls.openTabs,
        subscribe(listener) {
          openTabsListeners.add(listener)
          return () => { openTabsListeners.delete(listener) }
        },
      },
      openResource(address, options) { calls.openedResources.push({ address, options }) },
      tabsIn() { return this.tabs },
      closeIn(parentId, tabId) {
        calls.closeAttempts.push({ parentId, tabId })
        if (calls.unadoptedParents.has(parentId)) return
        calls.closedTabs.push({ parentId, tabId })
      },
      registerCloseHandler() { return () => {} },
    },
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [{ workspaceId: 'workspace-1', path: '/tmp/project', sessionIds: ['session-current'] }],
        }),
      },
    },
    uiWorkspace: {
      openSession(id) { calls.opened.push(id) },
      startSession(workspaceId) { calls.started.push(workspaceId) },
      clearMain() {
        calls.clearedMain += 1
        calls.currentSessionId = undefined
      },
      async archiveSession(id) { calls.archived.push(id) },
    },
    remote: {
      async $mount(contribution) {
        calls.mount = contribution
        ctx.remote.tempSession = {
          async list() {
            calls.lists += 1
            const reply = calls.listReplies.shift()
            if (reply !== undefined) return reply
            const byId = new Map()
            for (const request of calls.registered) {
              byId.set(request.sessionId, {
                sessionId: request.sessionId,
                createdAt: 1,
                kind: request.kind === 'side' ? 'side' : 'main',
                pendingDelete: calls.discarded.includes(request.sessionId),
              })
            }
            const sessions = [...byId.values()]
            return {
              ok: true,
              value: {
                epoch: 1,
                sequence: calls.lists,
                degraded: false,
                stopping: sessions
                  .filter(record => record.pendingDelete)
                  .map(record => ({ sessionId: record.sessionId, kind: record.kind })),
                sessions,
              },
            }
          },
          async reserve(request) {
            calls.reserved.push(request)
            return {
              ok: true,
              value: {
                sessionId: 'session-new',
                workspaceId: request.workspaceId ?? null,
                cwd: null,
                at: 1,
              },
            }
          },
          async register(request) {
            calls.registered.push(request)
            return {
              ok: true,
              value: {
                sessionId: request.sessionId,
                createdAt: 1,
                kind: request.kind === 'side' ? 'side' : 'main',
                pendingDelete: false,
              },
            }
          },
          async discard(request) {
            calls.discarded.push(request.sessionId)
            return { ok: true, value: { discarded: true } }
          },
        }
        return async () => {}
      },
    },
  }
  return { ctx, calls }
}

test('apply mounts the remote namespace, locale, and temporary-session surfaces', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
  assert.deepEqual(plugin.inject.includes('slots'), true)
  const { ctx, calls } = makeContext()
  await plugin.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.mount.package, 'dsh-temp-session-plugin')
  assert.equal(calls.mount.descriptors.length, 4)
  assert.deepEqual(calls.slots, [
    'sidebar.right.pane.tab',
    'dts.tempchat.conversation',
    'shell.overlay',
    'shell.overlay',
    'conversation.session.header.actions',
    'conversation.hero.options',
    'conversation.input.dock',
    'sidebar.session.row.leading',
    'shell.overlay',
    'shell.overlay',
  ])
  assert.equal(calls.resources.length, 1)
  assert.equal(calls.resources[0].protocol, 'tempchat')
  // The browser repeats the Host codecs; their wire identities must not drift.
  const shape = descriptors => descriptors.map(descriptor => ({
    id: descriptor.id,
    service: descriptor.service,
    namespace: descriptor.namespace,
    method: descriptor.method,
    invocation: descriptor.invocation,
    parameters: descriptor.parameters.map(parameter => ({
      name: parameter.name,
      wire: parameter.wire,
      source: parameter.source,
      typeSymbol: parameter.codec.typeSymbol,
    })),
    resultTypeSymbol: descriptor.result.typeSymbol,
  }))
  assert.deepEqual(shape(calls.mount.descriptors), shape(tempSessionDescriptors.filter(descriptor => descriptor.method !== 'promote')))
  assert.ok(calls.locale.dictionaries.zh.choiceTemp.length > 0)
  assert.ok(calls.locale.dictionaries.en.choiceTemp.length > 0)
  assert.equal(calls.lists, 1)
})

test('the create flow reserves before it creates', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const choice = captured.find(options => options.id === 'temp-session-workspace-choice')
  assert.ok(choice !== undefined)
  const injected = choice.inject()
  injected.actions.startNormal('workspace-1')
  assert.deepEqual(calls.started, ['workspace-1'])
  await injected.actions.createTempInWorkspace('workspace-1')
  assert.deepEqual(calls.reserved, [{ workspaceId: 'workspace-1', cwd: '/tmp/project' }])
  assert.deepEqual(calls.created, [{ workspaceId: 'workspace-1', sessionId: 'session-new' }])
  assert.equal(calls.registered.length, 1)
  assert.equal(calls.registered[0].sessionId, 'session-new')
  assert.match(calls.registered[0].title, /^title/)
  assert.deepEqual(calls.opened, ['session-new'])
})

test('the New Session option marks the open workspace-bound blank Session temporary', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const hero = captured.find(options => options.name === 'conversation.hero.options')
  assert.ok(hero !== undefined)
  const t = ctx.locale.bind()
  const injected = hero.inject()
  // Not temporary yet: the pill renders and adopts the current Session.
  const element = hero.component({ ...injected, sessionId: 'session-current', t })
  assert.equal(element.type, 'button')
  assert.equal(element.props['aria-pressed'], false)
  await injected.actions.markCurrent('session-current')
  assert.deepEqual(calls.registered.map(request => request.sessionId), ['session-current'])
  assert.equal(calls.created.length, 0)
  assert.equal(injected.store.getSnapshot().ids.has('session-current'), true)
})

test('a selection starts a forked temporary side chat', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const selection = captured.find(options => options.id === 'temp-session-selection')
  assert.ok(selection !== undefined)
  const injected = selection.inject()
  await injected.actions.startSideChat('selected text')
  assert.deepEqual(calls.forks, [{ sessionId: 'session-current' }])
  const sideRegister = calls.registered.find(request => request.kind === 'side')
  assert.equal(sideRegister.sessionId, 'session-fork')
  assert.equal(calls.drafts.length, 1)
  assert.equal(calls.drafts[0].options.prompt, '> selected text\n\n')
  assert.deepEqual(calls.openedResources, [{
    address: 'dsh-resource://tempchat/session/session-fork',
    options: { kind: 'tempchat', preferNewPane: true },
  }])
  assert.equal(injected.store.getSnapshot().side.has('session-fork'), true)
  assert.equal(injected.store.getSnapshot().ids.has('session-fork'), true)
  assert.equal(injected.actions.promote, undefined)
  assert.equal(calls.mount.descriptors.some(descriptor => descriptor.method === 'promote'), false)

  // A second side chat that stays temporary is discarded when its tab closes,
  // but remains hidden from the list until Host cleanup.
  await injected.actions.startSideChat('another selection')
  await injected.actions.closeSide('session-fork')
  assert.equal(calls.discarded.includes('session-fork'), true)
  assert.equal(injected.store.getSnapshot().ids.has('session-fork'), false)
  assert.equal(injected.store.getSnapshot().side.has('session-fork'), true)
})

test('a side chat keeps its treatment', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const injected = captured.find(options => options.id === 'temp-session-selection').inject()
  const t = ctx.locale.bind()
  injected.store.hydrate([
    { sessionId: 'session-main', createdAt: 1, kind: 'main', pendingDelete: false },
    { sessionId: 'session-side', createdAt: 2, kind: 'side', pendingDelete: false },
    { sessionId: 'session-ended', createdAt: 3, kind: 'side', pendingDelete: true },
  ])
  assert.deepEqual([...injected.store.getSnapshot().ids], ['session-main', 'session-side'])
  assert.deepEqual([...injected.store.getSnapshot().side], ['session-side', 'session-ended'])
  assert.equal(injected.store.getSnapshot().stopping.has('session-ended'), true)
  ctx.sessions.list.getSnapshot().byId['session-side'] = {
    projectionValues: { title: 'Native side title' },
  }
  assert.equal(
    calls.tabDefinition.title('dsh-resource://tempchat/session/session-side'),
    'Native side title',
  )

  const tab = captured.find(options => options.name === 'sidebar.right.pane.tab')
  injected.store.add('session-side', 'side')
  const element = tab.component({
    ...tab.inject(),
    t,
    useTabInfo: () => ({ tab: { contentId: 'dsh-resource://tempchat/session/session-side' } }),
    useResource: () => ({ value: { reference: { sessionId: 'session-side' } } }),
    SessionProvider: () => null,
    renderSlot: () => null,
  })
  assert.equal(texts(element).some(text => text.includes('promote')), false)
})

test('a mounted client follows host epochs', async () => {  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const store = captured.find(options => options.id === 'temp-session-selection').inject().store
  const record = (sessionId, pendingDelete = false, kind = 'main') => ({
    sessionId, createdAt: 1, kind, pendingDelete,
  })
  const list = (epoch, sequence, sessions, stopping = []) => ({
    epoch, sequence, degraded: false, stopping, sessions,
  })

  assert.equal(store.applyList(list(2, 1, [record('session-terminal')])).accepted, true)
  assert.equal(store.getSnapshot().ids.has('session-terminal'), true)

  // A delayed reply from the old publisher epoch is ignored.
  const old = store.applyList(list(1, 99, [record('session-stale')]))
  assert.equal(old.accepted, false)
  assert.equal(store.getSnapshot().ids.has('session-stale'), false)
  // A delayed lower sequence inside the current epoch is ignored too.
  const delayed = store.applyList(list(2, 1, [record('session-delayed')]))
  assert.equal(delayed.accepted, false)
  assert.equal(store.getSnapshot().ids.has('session-delayed'), false)

  // Pending is terminal until the record disappears from the list. A Host
  // list without a stopping entry means the work settled, so the view stays
  // hidden without a stopping badge.
  store.applyList(list(2, 2, [record('session-terminal', true, 'main')]))
  assert.equal(store.getSnapshot().ids.has('session-terminal'), false)
  assert.equal(store.getSnapshot().pending.has('session-terminal'), true)
  assert.equal(store.getSnapshot().stopping.has('session-terminal'), false)
  store.applyList(list(2, 3, [record('session-terminal', false, 'main')]))
  assert.equal(store.getSnapshot().ids.has('session-terminal'), false)
  assert.equal(store.getSnapshot().pending.has('session-terminal'), true)

  // A new epoch supersedes the old sequence cursor for unrelated records.
  store.applyList(list(3, 1, [record('session-new-epoch')]))
  assert.equal(store.getSnapshot().ids.has('session-new-epoch'), true)
})

test('a settled pending chat is hidden without a stopping entry', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const store = captured.find(options => options.id === 'temp-session-selection').inject().store
  const record = { sessionId: 'session-settled', createdAt: 1, kind: 'main', pendingDelete: true }
  // Hydration is optimistic until the Host list arrives.
  store.hydrate([record])
  assert.equal(store.getSnapshot().stopping.has('session-settled'), true)
  const applied = store.applyList({
    epoch: (store.getSnapshot().epoch ?? 0) + 1,
    sequence: 1,
    degraded: false,
    stopping: [],
    sessions: [record],
  })
  assert.equal(applied.accepted, true)
  assert.equal(store.getSnapshot().ids.has('session-settled'), false)
  assert.equal(store.getSnapshot().pending.has('session-settled'), true)
  assert.equal(store.getSnapshot().stopping.has('session-settled'), false)
})

test('a refresh requested during a read runs again', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  const first = deferred()
  calls.listReplies.push(first.promise)
  await plugin.apply(ctx)
  const injected = captured.find(options => options.id === 'temp-session-selection').inject()
  assert.equal(calls.lists, 1)
  const queued = injected.actions.refresh()
  first.resolve({
    ok: true,
    value: { epoch: 1, sequence: 1, degraded: false, stopping: [], sessions: [] },
  })
  await queued
  assert.equal(calls.lists, 2)
})

test('a session lifecycle change refreshes the list', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const before = calls.lists
  ctx.sessions.notifySessionList()
  await flush()
  assert.equal(calls.lists, before + 1)
})

test('a pending side chat keeps its stopping entry', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const stopping = captured.find(options => options.id === 'temp-session-stopping')
  assert.ok(stopping !== undefined)
  const injected = stopping.inject()
  injected.store.hydrate([
    { sessionId: 'session-side-pending', createdAt: 1, kind: 'side', pendingDelete: true },
  ])
  const element = stopping.component({ ...injected, t: ctx.locale.bind() })
  assert.ok(texts(element).some(text => text.includes('session-side-pending')))
  assert.ok(texts(element).some(text => text.includes('stopping')))
  assert.equal(injected.store.getSnapshot().stopping.has('session-side-pending'), true)
  assert.equal(injected.store.getSnapshot().ids.has('session-side-pending'), false)
})

test('both closes happen independently', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const selection = captured.find(options => options.id === 'temp-session-selection')
  const injected = selection.inject()
  await injected.actions.startSideChat('selected text')
  ctx.sidebarRight.tabs = [{
    id: 'tab-side', kind: 'tempchat', contentId: 'dsh-resource://tempchat/session/session-fork',
  }]
  calls.listReplies.push({
    ok: true,
    value: {
      epoch: 2,
      sequence: 10,
      degraded: false,
      stopping: [
        { sessionId: 'session-current', kind: 'main' },
        { sessionId: 'session-fork', kind: 'side' },
      ],
      sessions: [
        { sessionId: 'session-current', createdAt: 1, kind: 'main', pendingDelete: true },
        { sessionId: 'session-fork', createdAt: 1, kind: 'side', pendingDelete: true },
      ],
    },
  })
  await injected.actions.refresh()
  assert.equal(calls.clearedMain, 1)
  assert.deepEqual(calls.closedTabs, [{ parentId: 'session-current', tabId: 'tab-side' }])
  assert.equal(injected.store.getSnapshot().stopping.size, 2)
})

test('the composer dock ends a temporary Session through discard only', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const dock = captured.find(options => options.name === 'conversation.input.dock')
  const injected = dock.inject()
  injected.store.add('session-new')
  await injected.actions.end('session-new')
  // The Host archives after its durable pending event, so End must not archive
  // or stop the chat first.
  assert.deepEqual(calls.archived, [])
  assert.deepEqual(calls.discarded, ['session-new'])
  assert.equal(injected.store.getSnapshot().ids.has('session-new'), false)
})

test('a failed discard leaves the main view and record in place', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  let discardCalls = 0
  ctx.remote.tempSession.discard = async () => {
    discardCalls += 1
    return { ok: false, error: new Error('discard failed') }
  }
  calls.registered.push({ sessionId: 'session-current', title: 'current' })
  const dock = captured.find(options => options.name === 'conversation.input.dock')
  const injected = dock.inject()
  injected.store.add('session-current')
  await injected.actions.end('session-current')
  assert.equal(discardCalls, 1)
  assert.deepEqual(calls.archived, [])
  assert.deepEqual(calls.discarded, [])
  assert.equal(calls.clearedMain, 0)
  const snapshot = injected.store.getSnapshot()
  assert.equal(snapshot.ids.has('session-current'), true)
  assert.equal(snapshot.stopping.has('session-current'), false)
  assert.equal(snapshot.pending.has('session-current'), false)
})

test('a restored pending side tab is closed without a fresh startSideChat', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  calls.openTabs = [{
    sessionId: 'session-current',
    tabId: 'tab-restored',
    kind: 'tempchat',
    contentId: 'dsh-resource://tempchat/session/session-restored',
  }]
  calls.listReplies.push({
    ok: true,
    value: {
      epoch: 1,
      sequence: 1,
      degraded: false,
      stopping: [{ sessionId: 'session-restored', kind: 'side' }],
      sessions: [
        { sessionId: 'session-restored', createdAt: 1, kind: 'side', pendingDelete: true },
      ],
    },
  })
  await plugin.apply(ctx)
  const stopping = captured.find(options => options.id === 'temp-session-stopping')
  const injected = stopping.inject()
  await flush()
  assert.deepEqual(calls.closedTabs, [{ parentId: 'session-current', tabId: 'tab-restored' }])
  assert.equal(calls.clearedMain, 0)
  const snapshot = injected.store.getSnapshot()
  assert.equal(snapshot.stopping.has('session-restored'), true)
  assert.equal(snapshot.ids.has('session-restored'), false)
})

test('a restored pending side tab is retried after its layout is adopted', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  calls.unadoptedParents.add('session-current')
  calls.openTabs = [{
    sessionId: 'session-current',
    tabId: 'tab-delayed',
    kind: 'tempchat',
    contentId: 'dsh-resource://tempchat/session/session-delayed',
  }]
  calls.listReplies.push({
    ok: true,
    value: {
      epoch: 1,
      sequence: 1,
      degraded: false,
      stopping: [{ sessionId: 'session-delayed', kind: 'side' }],
      sessions: [
        { sessionId: 'session-delayed', createdAt: 1, kind: 'side', pendingDelete: true },
      ],
    },
  })
  await plugin.apply(ctx)
  const stopping = captured.find(options => options.id === 'temp-session-stopping')
  const injected = stopping.inject()
  await flush()
  assert.equal(calls.closeAttempts.length, 1)
  assert.deepEqual(calls.closedTabs, [])
  assert.equal(injected.store.getSnapshot().pending.has('session-delayed'), true)

  // DSH's closeIn is a no-op until the saved layout is adopted. Adoption
  // publishes the inventory, which retries the same still-pending side tab.
  calls.unadoptedParents.delete('session-current')
  calls.publishOpenTabs([...calls.openTabs])
  assert.deepEqual(calls.closedTabs, [{ parentId: 'session-current', tabId: 'tab-delayed' }])
  calls.publishOpenTabs([])
})

test('a pending side tab is retried on a later list refresh', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  calls.unadoptedParents.add('session-current')
  calls.openTabs = [{
    sessionId: 'session-current',
    tabId: 'tab-refresh',
    kind: 'tempchat',
    contentId: 'dsh-resource://tempchat/session/session-refresh',
  }]
  calls.listReplies.push({
    ok: true,
    value: {
      epoch: 1,
      sequence: 1,
      degraded: false,
      stopping: [{ sessionId: 'session-refresh', kind: 'side' }],
      sessions: [
        { sessionId: 'session-refresh', createdAt: 1, kind: 'side', pendingDelete: true },
      ],
    },
  })
  await plugin.apply(ctx)
  const dock = captured.find(options => options.name === 'conversation.input.dock')
  const injected = dock.inject()
  await flush()
  assert.deepEqual(calls.closedTabs, [])

  calls.unadoptedParents.delete('session-current')
  calls.listReplies.push({
    ok: true,
    value: {
      epoch: 1,
      sequence: 2,
      degraded: false,
      stopping: [{ sessionId: 'session-refresh', kind: 'side' }],
      sessions: [
        { sessionId: 'session-refresh', createdAt: 1, kind: 'side', pendingDelete: true },
      ],
    },
  })
  await injected.actions.refresh()
  assert.deepEqual(calls.closedTabs, [{ parentId: 'session-current', tabId: 'tab-refresh' }])
  assert.equal(injected.store.getSnapshot().pending.has('session-refresh'), true)
})

test('a side chat that became pending while forking is not opened', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  const gate = deferred()
  ctx.sessions.fork = async (options) => {
    calls.forks.push(options)
    await gate.promise
    return 'session-fork'
  }
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  await flush()
  const selection = captured.find(options => options.id === 'temp-session-selection')
  const injected = selection.inject()
  const action = injected.actions.startSideChat('selected text')
  await flush()
  calls.listReplies.push({
    ok: true,
    value: {
      epoch: 1,
      sequence: 2,
      degraded: false,
      stopping: [{ sessionId: 'session-fork', kind: 'side' }],
      sessions: [
        { sessionId: 'session-fork', createdAt: 1, kind: 'side', pendingDelete: true },
      ],
    },
  })
  await injected.actions.refresh()
  assert.equal(injected.store.getSnapshot().pending.has('session-fork'), true)

  ctx.remote.tempSession.register = async request => {
    calls.registered.push(request)
    return {
      ok: true,
      value: { sessionId: request.sessionId, createdAt: 1, kind: 'side', pendingDelete: true },
    }
  }
  calls.listReplies.push({
    ok: true,
    value: {
      epoch: 1,
      sequence: 3,
      degraded: false,
      stopping: [{ sessionId: 'session-fork', kind: 'side' }],
      sessions: [
        { sessionId: 'session-fork', createdAt: 1, kind: 'side', pendingDelete: true },
      ],
    },
  })
  gate.resolve()
  await action
  assert.equal(calls.openedResources.length, 0)
  assert.equal(calls.drafts.length, 0)
  const snapshot = injected.store.getSnapshot()
  assert.equal(snapshot.ids.has('session-fork'), false)
  assert.equal(snapshot.stopping.has('session-fork'), true)
  assert.equal(snapshot.pending.has('session-fork'), true)
})

test('a pending fork selected as current is closed when the view changes', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  // Use the installed client's main-view contract: retention counts, not the
  // optional provider that this fake context otherwise supplies.
  ctx.sessions.currentProvideInfo = undefined
  await plugin.apply(ctx)
  await flush()
  const record = { sessionId: 'session-pending', createdAt: 1, kind: 'fork', pendingDelete: true }
  let sequence = 1
  let visible = true
  ctx.remote.tempSession.list = async () => ({
    ok: true,
    value: {
      epoch: 1,
      sequence: ++sequence,
      degraded: false,
      stopping: visible ? [{ sessionId: 'session-pending', kind: 'fork' }] : [],
      sessions: visible ? [record] : [],
    },
  })
  const dock = captured.find(options => options.name === 'conversation.input.dock')
  const injected = dock.inject()
  await injected.actions.refresh()
  assert.equal(injected.store.getSnapshot().pending.has('session-pending'), true)
  assert.equal(calls.clearedMain, 0)

  const sessionList = ctx.sessions.list.getSnapshot()
  sessionList.byId['session-pending'] = { id: 'session-pending', cwd: '/tmp/project', blank: false }
  ctx.uiWorkspace.clearMain = () => {
    calls.clearedMain += 1
    // The real workspace releases main-view retention synchronously.
    delete sessionList.byId['session-pending'].retainedBy
    ctx.sessions.notifySessionList()
  }

  // First selection: the accepted list sees the pending id as current.
  sessionList.byId['session-pending'].retainedBy = { mainView: 1 }
  ctx.sessions.notifySessionList()
  await flush()
  assert.equal(calls.clearedMain, 1)

  // An unrelated refresh after the close must not clear again.
  visible = true
  await injected.actions.refresh()
  assert.equal(calls.clearedMain, 1)

  // Reselecting the same pending fork must close it again.
  sessionList.byId['session-pending'].retainedBy = { mainView: 1 }
  ctx.sessions.notifySessionList()
  await flush()
  assert.equal(calls.clearedMain, 2)
})

test('components render the localized labels and only mark temporary Sessions', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const t = ctx.locale.bind()
  const choice = captured.find(options => options.id === 'temp-session-workspace-choice')
  const choiceProps = { ...choice.inject(), t }
  choiceProps.store.openChoice({ workspaceId: 'workspace-1', title: 'demo-project', x: 10, y: 20 })
  const menu = choice.component(choiceProps)
  assert.equal(menu.type, 'div')
  assert.ok(texts(menu).includes('demo-project'))
  assert.ok(texts(menu).includes('choiceNormal'))
  assert.ok(texts(menu).includes('choiceTemp'))

  const badge = captured.find(options => options.name === 'sidebar.session.row.leading')
  const badgeProps = { ...badge.inject(), sessionId: 'session-other', t }
  assert.equal(badge.component(badgeProps), null)
  badgeProps.store.add('session-other')
  const badgeElement = badge.component(badgeProps)
  assert.equal(badgeElement.type, 'span')
  assert.equal(badgeElement.props['aria-label'], 'badge')

  const header = captured.find(options => options.name === 'conversation.session.header.actions')
  const headerProps = { ...header.inject(), sessionId: 'session-header-only', t }
  assert.equal(header.component(headerProps), null)
  headerProps.store.add('session-header-only')
  assert.ok(texts(header.component(headerProps)).includes('badge'))

  const dock = captured.find(options => options.name === 'conversation.input.dock')
  const dockProps = { ...dock.inject(), sessionId: 'session-dock-only', t }
  assert.equal(dock.component(dockProps), null)
  dockProps.store.add('session-dock-only')
  const dockElement = dock.component(dockProps)
  assert.equal(dockElement.type, 'div')
  assert.ok(texts(dockElement).includes('badgeHint'))
  assert.ok(texts(dockElement).includes('end'))

  // The selection action must not carry a native title tooltip (it overlaps
  // the transcript); the hint stays as its accessible name.
  const selection = captured.find(options => options.id === 'temp-session-selection')
  const selectionProps = { ...selection.inject(), t }
  selectionProps.store.setSelection({ text: 'x', x: 20, y: 30 })
  const selectionElement = selection.component(selectionProps)
  assert.equal(selectionElement.type, 'button')
  assert.equal(selectionElement.props.title, undefined)
  assert.equal(selectionElement.props['aria-label'], 'selectionHint')
  assert.equal(captured.some(options => options.name === 'sidebar.workspaces.session.menu.item'), false)
})
