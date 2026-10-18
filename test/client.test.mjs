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
    registered: [],
    opened: [],
    archived: [],
    discarded: [],
    promoted: [],
    forks: [],
    drafts: [],
    resources: [],
    openedResources: [],
    lists: 0,
    slots: [],
    locale: undefined,
  }
  const listeners = new Set()
  const currentProvideInfo = {
    getSnapshot: () => ({ sessionId: 'session-current' }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const store = {
    ids: [],
    byId: { 'session-current': { cwd: '/tmp/project', blank: false } },
  }
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
      list: { getSnapshot: () => store },
      async create(options) { calls.created.push(options); return 'session-new' },
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
    sidebarRightTabs: { register(definition) { return () => {} } },
    sidebarRight: {
      openResource(address, options) { calls.openedResources.push({ address, options }) },
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
      async archiveSession(id) { calls.archived.push(id) },
    },
    remote: {
      async $mount(contribution) {
        calls.mount = contribution
        ctx.remote.tempSession = {
          async list() { calls.lists += 1; return { ok: true, value: { sessions: [] } } },
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
          async promote(request) {
            calls.promoted.push(request)
            return { ok: true, value: { promoted: true } }
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
    'sidebar.footer.action',
    'conversation.session.header.actions',
    'conversation.hero.options',
    'conversation.input.dock',
    'sidebar.session.row.leading',
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
  assert.deepEqual(shape(calls.mount.descriptors), shape(tempSessionDescriptors))
  assert.ok(calls.locale.dictionaries.zh.create.length > 0)
  assert.ok(calls.locale.dictionaries.en.create.length > 0)
  assert.equal(calls.lists, 1)
})

test('the footer action creates a Session, registers it, and opens it', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx, calls } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const footer = captured.find(options => options.name === 'sidebar.footer.action')
  const injected = footer.inject()
  await injected.actions.create()
  assert.deepEqual(calls.created, [{ workspaceId: 'workspace-1' }])
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

test('a selection starts a forked temporary side chat and can be promoted', async () => {
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

  await injected.actions.promote('session-fork')
  assert.deepEqual(calls.promoted, [{ sessionId: 'session-fork', title: 'selected text' }])
  assert.equal(injected.store.getSnapshot().side.has('session-fork'), false)
  assert.equal(injected.store.getSnapshot().ids.has('session-fork'), false)

  // A second side chat that stays temporary is discarded when its tab closes,
  // but remains hidden from the list until Host cleanup.
  await injected.actions.startSideChat('another selection')
  await injected.actions.closeSide('session-fork')
  assert.equal(calls.discarded.includes('session-fork'), true)
  assert.equal(injected.store.getSnapshot().ids.has('session-fork'), false)
  assert.equal(injected.store.getSnapshot().side.has('session-fork'), true)
})

test('hydration keeps ended side chats hidden without counting them active', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const footer = captured.find(options => options.name === 'sidebar.footer.action')
  const injected = footer.inject()
  injected.store.hydrate([
    { sessionId: 'session-main', createdAt: 1, kind: 'main', pendingDelete: false },
    { sessionId: 'session-side', createdAt: 2, kind: 'side', pendingDelete: false },
    { sessionId: 'session-ended', createdAt: 3, kind: 'side', pendingDelete: true },
  ])
  assert.deepEqual([...injected.store.getSnapshot().ids], ['session-main', 'session-side'])
  assert.deepEqual([...injected.store.getSnapshot().side], ['session-side', 'session-ended'])
})

test('the composer dock ends a temporary Session through archive and discard', async () => {
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
  assert.deepEqual(calls.archived, ['session-new'])
  assert.deepEqual(calls.discarded, ['session-new'])
  assert.equal(injected.store.getSnapshot().ids.has('session-new'), false)
})

test('components render the localized labels and only mark temporary Sessions', async () => {
  const { registration } = await loadBundle()
  const plugin = registration.factory(() => React)
  const captured = []
  const { ctx } = makeContext()
  ctx.slots.register = (options, component) => { captured.push({ ...options, component }); return () => {} }
  await plugin.apply(ctx)
  const t = ctx.locale.bind()
  const footer = captured.find(options => options.name === 'sidebar.footer.action')
  const footerProps = { ...footer.inject(), wide: true, t }
  const created = footer.component(footerProps)
  assert.equal(created.type, 'button')
  assert.ok(texts(created).includes('create'))

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
