/**
 * Self-check for the out-of-tree bundle `@local/dsh-compaction-tuner`.
 *
 * It is hermetic: no network, no server, no filesystem writes, and no DSH
 * instance. Every check runs against the plugin's own files plus the REAL
 * `@deepseek-ai/schemastery` resolved through `$DSH_HARNESS_CHECKOUT`, so a
 * schema regression cannot hide behind a stand-in. If the schema library is
 * unresolvable this file FAILS loudly instead of skipping: a silent skip here
 * would green-light a `Config` that renders no settings section at all.
 *
 * Run:
 *   DSH_HARNESS_CHECKOUT=/home/user/Public/deepseek-harness node dsh-compaction-tuner/verify.mjs
 *
 * What it does NOT cover: the live mechanism against a booted Host (profile
 * patch writes, remount cleanliness, HMR) is the isolated end-to-end smoke, not
 * this file. Section 5 pins the `apply()` wiring that a live Settings save
 * depends on — the three trigger seams, the `ctx.fiber.config` read, disposal,
 * and the no-fiber fallback — because a regression there shipped once and only
 * the live run caught it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import * as host from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
/** Read one repo file of this bundle as UTF-8 text. */
const read = file => readFileSync(join(here, file), 'utf8')
/** Read one repo JSON file of this bundle. */
const readJson = file => JSON.parse(read(file))

let checks = 0
/** Check labels that threw, in order. */
const failures = []
/** Checks deliberately not run; must stay empty for this bundle. */
const skips = []

/**
 * Run one named check and report its outcome without aborting the rest.
 * @param {string} label - what is being checked.
 * @param {() => unknown} body - assertions to run.
 */
async function check(label, body) {
  const number = checks + 1
  checks = number
  try {
    await body()
    process.stdout.write(`ok ${number} - ${label}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push({ label, message })
    process.stdout.write(`not ok ${number} - ${label}\n  ${message}\n`)
  }
}

/* ══ doubles ═══════════════════════════════════════════════════════════════ */

/**
 * Minimal React double: enough of `createElement`, `useId`, `useRef`,
 * `useState`, `useCallback`, and `useSyncExternalStore` to drive the settings
 * section as a tree of host elements. It deliberately does not paper over the
 * `this`-binding the real controller needs.
 * @returns the stub React object plus its mount and instrumentation helpers.
 */
function createReactStub() {
  let current = null
  let idSeed = 0
  const useSyncExternalStoreCalls = []

  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.filter(child => child !== null && child !== undefined && child !== false && child !== true),
  })
  const slotOf = () => {
    const inst = current
    const slot = inst.hookIndex
    inst.hookIndex += 1
    return [inst, slot]
  }
  const sameDeps = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

  const useCallback = (fn, deps) => {
    const [inst, slot] = slotOf()
    const previous = inst.hooks[slot]
    if (previous !== undefined && Array.isArray(deps) && sameDeps(previous.deps, deps)) return previous.fn
    inst.hooks[slot] = { fn, deps }
    return fn
  }
  const useId = () => {
    const [inst, slot] = slotOf()
    if (inst.hooks[slot] === undefined) inst.hooks[slot] = `:r${++idSeed}:`
    return inst.hooks[slot]
  }
  const useRef = initial => {
    const [inst, slot] = slotOf()
    if (inst.hooks[slot] === undefined) inst.hooks[slot] = { current: initial }
    return inst.hooks[slot]
  }
  const useState = initial => {
    const [inst, slot] = slotOf()
    if (inst.hooks[slot] === undefined) inst.hooks[slot] = typeof initial === 'function' ? initial() : initial
    const setState = next => {
      const value = typeof next === 'function' ? next(inst.hooks[slot]) : next
      if (Object.is(value, inst.hooks[slot])) return
      inst.hooks[slot] = value
      render(inst)
    }
    return [inst.hooks[slot], setState]
  }
  const useSyncExternalStore = (subscribe, getSnapshot) => {
    const [inst, slot] = slotOf()
    inst.store = { subscribe, getSnapshot }
    useSyncExternalStoreCalls.push({ subscribe, getSnapshot })
    return getSnapshot()
  }
  const useEffect = (effect, deps) => {
    const [inst, slot] = slotOf()
    inst.effects.set(slot, { effect, deps })
  }

  const commit = inst => {
    const wanted = inst.store
    if (wanted === undefined) return
    if (inst.active !== undefined && inst.active.subscribe === wanted.subscribe) {
      inst.active.getSnapshot = wanted.getSnapshot
      return
    }
    if (inst.active !== undefined) inst.active.unsubscribe()
    const active = { subscribe: wanted.subscribe, getSnapshot: wanted.getSnapshot, unsubscribe: () => {} }
    const unsubscribe = wanted.subscribe(() => { render(inst) })
    active.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : () => {}
    inst.active = active
  }

  /**
   * Run each effect whose dependencies changed, cleaning up the previous run
   * first — real React's run-and-cleanup ordering, which the restart effect
   * relies on for its abort-on-unmount contract.
   */
  const commitEffects = inst => {
    for (const [slot, entry] of inst.effects) {
      const previous = inst.effectState.get(slot)
      const unchanged = previous !== undefined
        && Array.isArray(entry.deps) && Array.isArray(previous.deps)
        && sameDeps(previous.deps, entry.deps)
      if (unchanged) continue
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = entry.effect()
      inst.effectState.set(slot, { deps: entry.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
    }
  }

  const render = inst => {
    inst.hookIndex = 0
    inst.effects = new Map()
    current = inst
    try {
      inst.tree = inst.component(inst.props)
    } finally {
      current = null
    }
    commit(inst)
    commitEffects(inst)
    return inst.tree
  }

  const mount = (component, props) => {
    const inst = {
      component,
      props,
      hooks: [],
      hookIndex: 0,
      tree: null,
      store: undefined,
      active: undefined,
      effects: new Map(),
      effectState: new Map(),
    }
    render(inst)
    inst.unmount = () => {
      for (const previous of inst.effectState.values()) {
        if (typeof previous.cleanup === 'function') previous.cleanup()
      }
      inst.effectState = new Map()
      if (inst.active !== undefined) {
        inst.active.unsubscribe()
        inst.active = undefined
      }
    }
    return inst
  }

  return {
    React: { createElement, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore },
    mount,
    useSyncExternalStoreCalls,
  }
}

/**
 * Config-form double whose methods are PROTOTYPE methods, exactly like the real
 * controller: a bare (unbound) reference throws, which is how the check below
 * proves the client wraps them.
 */
class BoundForm {
  constructor() {
    this.snapshot = undefined
    this.listeners = new Set()
    this.writes = []
    this.nextResult = true
  }

  /** Seed the snapshot and the result the next `mutate` resolves. */
  set(snapshot, nextResult = true) {
    this.snapshot = snapshot
    this.nextResult = nextResult
  }

  /** The controller's reference-stable snapshot reader. */
  getSnapshot() { return this.snapshot }

  /** The controller's subscriber; returns its own disposer. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The controller's atomic writer; records the call and resolves the seeded result. */
  mutate(ops, revision) {
    this.writes.push({ ops, revision })
    return Promise.resolve(this.nextResult)
  }

  /** Publish a new snapshot to the mounted component (the recovery read). */
  push(snapshot) {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * The `ctx.get('remote')` double. The real Remote service is a tracked proxy:
 * reading a nested namespace off it (`remote.session`) resolves the dotted
 * service `'remote.session'` through the context, which throws unless the
 * plugin injected that exact key. Exposing a plain nested object here is what
 * let the missing `'remote.session'` inject pass the suite and ship the dead
 * model picker.
 * @returns the Remote namespace double, whose `.session` access throws.
 */
function remoteNamespaceDouble() {
  return {
    get session() {
      throw new Error('cannot get property "remote.session" without inject')
    },
  }
}

/**
 * Build a fake client root context with the services the client half injects.
 * @returns the context double plus its recording state.
 */
function fakeClientContext() {
  const state = {
    language: 'en',
    dictionaries: [],
    registered: [],
    effects: [],
    injections: [],
    formRequests: [],
    connection: undefined,
    remote: undefined,
    /** The dotted `'remote.session'` service, seeded by `mountSection`. */
    remoteSession: undefined,
    /** Every service key `ctx.get()` was asked for, in call order. */
    serviceReads: [],
    catalogCalls: 0,
  }
  const form = new BoundForm()
  /** The context event bus, so a `connection/reset` seat can be driven. */
  const events = new Map()
  const ctx = {
    state,
    form,
    /** Service resolution, faithful to cordis: only exact keys resolve. */
    get(name) {
      state.serviceReads.push(name)
      if (name === 'connection') return state.connection
      if (name === 'remote') return state.remote
      if (name === 'remote.session') return state.remoteSession
      return undefined
    },
    on(event, listener) {
      const listeners = events.get(event) ?? new Set()
      listeners.add(listener)
      events.set(event, listeners)
      return () => { listeners.delete(listener) }
    },
    /** Emit one context event, exactly as the Connection service does on connect. */
    emit(event) {
      for (const listener of [...(events.get(event) ?? [])]) listener()
    },
    effect(callback, label) {
      state.effects.push(label)
      const disposer = callback()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    locale: {
      register(ns, dictionary) {
        state.dictionaries.push({ ns, dictionary })
        return () => {}
      },
      bind(ns) {
        return key => {
          const entry = state.dictionaries.find(candidate => candidate.ns === ns)
          const table = entry?.dictionary?.[state.language] ?? {}
          return typeof table[key] === 'string' ? table[key] : `«missing:${ns}.${key}»`
        }
      },
    },
    slots: {
      inject(slot, callback) {
        state.injections.push(slot)
        callback()
      },
      register(options, component) {
        state.registered.push({ options, component })
        return () => {}
      },
    },
    configForms: {
      get(ns) {
        state.formRequests.push(ns)
        return form
      },
    },
  }
  return ctx
}

/* ── rendered-tree helpers ───────────────────────────────────────────────── */

/** Depth-first walk over a rendered element tree. */
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.children, visit)
}

/** Every node matching a predicate. */
function findAll(tree, predicate) {
  const found = []
  walk(tree, node => { if (predicate(node)) found.push(node) })
  return found
}

/** The direct string children of a node, joined. */
function directText(node) {
  return (node.children ?? []).filter(child => typeof child === 'string').join('')
}

/** Every string rendered anywhere in a tree. */
function renderedText(tree) {
  let text = ''
  walk(tree, node => { text += directText(node) })
  return text
}

/**
 * The eleven owned keys in the order both halves render and write them. The
 * client `FIELDS` table cannot be imported (separate closure), so this is the
 * order the parity checks below assert the page renders.
 */
const TUNE_ORDER = [
  'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
  'summarizationProvider', 'summarizationModel', 'maxTokens',
  'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto',
]

/**
 * The upstream `compaction-basic` code defaults, spelled out here so a change to
 * the host table cannot silently drift from `config.ts`.
 */
const UPSTREAM_DEFAULTS = {
  thresholdRatio: 0.8,
  headroomTokens: 65_536,
  retainRatio: 0.16,
  retainTokens: undefined,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: undefined,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  modelPolicies: [],
  auto: true,
}

/**
 * The historical install seed `cordis.patch.yml` used to commit. The mount patch
 * now seeds nothing, so this is a REGRESSION FIXTURE: profiles installed before
 * the seed was removed still store `0.5 / 0.15 / 2`, and those stored values must
 * keep being projected exactly as before.
 */
const LEGACY_SEED = { thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2 }

/**
 * One realistic stored snapshot value: the legacy install seed for the three keys
 * it used to seed plus the code defaults, with `retainTokens` and `maxTokens`
 * genuinely unset (the tuner's schema gives them no default).
 */
function storedValue(overrides = {}) {
  return {
    thresholdRatio: LEGACY_SEED.thresholdRatio,
    headroomTokens: UPSTREAM_DEFAULTS.headroomTokens,
    retainRatio: LEGACY_SEED.retainRatio,
    summarizationProvider: '',
    summarizationModel: '',
    compactionRetries: LEGACY_SEED.compactionRetries,
    maxOverflowRetries: UPSTREAM_DEFAULTS.maxOverflowRetries,
    modelPolicies: [],
    auto: true,
    ...overrides,
  }
}

/** A ready snapshot with the given revision and values. */
function readySnapshot(revision, values = storedValue()) {
  return { status: 'ready', value: values, base: {}, user: values, revision, writable: true }
}

/** Await the microtask queue plus the next macrotask, so a `mutate()` settles. */
const flush = () => new Promise(resolve => { setImmediate(resolve) })

/** The rendered top-level field label for one owned key. */
function fieldLabelOf(ui, key) {
  return findAll(ui.tree(), node => node.type === 'label'
    && node.props?.className === 'dct-field-label'
    && directText(node) === enCopy(`field.${key}.label`))[0]
}

/** The rendered control for one owned key (undefined for the composite field). */
function controlOf(ui, key) {
  const label = fieldLabelOf(ui, key)
  if (label === undefined) return undefined
  return findAll(ui.tree(), node => (node.type === 'input' || node.type === 'textarea')
    && node.props.id === label.props.htmlFor)[0]
}

/** One id inside the per-model editor, derived from the field label's `for`. */
function perModelId(ui, suffix) {
  const label = fieldLabelOf(ui, 'modelPolicies')
  if (label === undefined) throw new Error('the modelPolicies field label is not rendered')
  return `${label.props.htmlFor}-${suffix}`
}

/** The composite per-model editor node. */
function perModelEditor(ui) {
  return findAll(ui.tree(), node => node.props?.className === 'dct-permodel')[0]
}

/** One rendered override card, in draft order. */
function perModelEntries(ui) {
  return findAll(ui.tree(), node => node.props?.className === 'dct-permodel-entry')
}

/** The provider or model `<select>` inside the per-model picker. */
function perModelSelect(ui, which) {
  const id = perModelId(ui, which)
  return findAll(ui.tree(), node => node.type === 'select' && node.props.id === id)[0]
}

/** The labelled policy box of one override card. */
function perModelBox(ui, index, key) {
  const id = `${perModelId(ui, String(index))}-${key}`
  return findAll(ui.tree(), node => node.type === 'input' && node.props.id === id)[0]
}

/** The Add-override button. */
function perModelAdd(ui) {
  return findAll(ui.tree(), node => node.type === 'button' && directText(node) === enCopy('perModel.add'))[0]
}

/** The Reset-to-system-defaults action. */
function resetButton(ui) {
  return findAll(ui.tree(), node => node.type === 'button' && directText(node) === enCopy('action.resetDefaults'))[0]
}

/** The remove action of one override card, in draft order. */
function perModelRemove(ui, index) {
  return findAll(ui.tree(), node => node.type === 'button' && directText(node) === enCopy('perModel.remove'))[index]
}

/** Type text into one policy box of one override card. */
function setPolicyBox(ui, index, key, text) {
  const box = perModelBox(ui, index, key)
  if (box === undefined) throw new Error(`no rendered per-model box for entry ${String(index)} key "${key}"`)
  box.props.onChange({ target: { value: text } })
}

/** Type text into one field by key; a checkbox takes `'true'`/`'false'`. */
function setField(ui, key, text) {
  const control = controlOf(ui, key)
  if (control === undefined) throw new Error(`no rendered control for "${key}"`)
  if (control.props.type === 'checkbox') control.props.onChange({ target: { checked: text === 'true' } })
  else control.props.onChange({ target: { value: text } })
}

/** Click the Save action and let its promise settle. */
async function clickSave(ui) {
  ui.saveButton().props.onClick()
  await flush()
}

/* ══ fixture load ══════════════════════════════════════════════════════════ */

const manifest = readJson('package.json')
const patch = read('cordis.patch.yml')
const clientSource = read('client.js')

const react = createReactStub()
let captured
const requested = []
/**
 * The page's `window` double. Everything the client reads at call time stays
 * mutable per mount, and the timer seats forward to `globalThis` so the fake
 * clock the retry checks install also governs the page's own polls.
 */
const clientWindow = {
  __ModuleLoader__: { load: options => { captured = options } },
  AbortController,
  URL: globalThis.URL,
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: id => globalThis.clearTimeout(id),
  fetch: () => Promise.resolve({ ok: true }),
  location: { href: 'http://127.0.0.1:3080/', reload: () => { clientWindow.__reloads += 1 } },
  __reloads: 0,
}
// `Date` is handed in as the HOST's Date, so the virtual clock the recovery
// checks install also governs the budget arithmetic inside the vm realm.
const clientVm = createContext({ window: clientWindow, console, Date: globalThis.Date })
runInContext(clientSource, clientVm, { filename: 'client.js' })
const clientContext = fakeClientContext()
const clientPlugin = captured.factory(specifier => {
  requested.push(specifier)
  if (specifier === 'react') return react.React
  throw new Error(`client.js requested "${specifier}", which is not in the baseline module table`)
})
clientPlugin.apply(clientContext)

/** One entry of the registered English copy table. */
const enCopy = key => clientContext.state.dictionaries[0].dictionary.en[key]

/** Locate a button by its visible copy, so the restart action cannot shadow Save. */
const buttonWithText = (tree, keys) => findAll(
  tree,
  node => node.type === 'button' && keys.some(key => directText(node) === enCopy(key)),
)[0]

/**
 * The provider-grouped catalog the injected Remote double answers with. The
 * picker must render only these ids: no provider or model may be hardcoded.
 */
const CATALOG_GROUPS = [
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'gpt-5-mini', name: 'GPT-5 mini' }] },
  { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }] },
]

/** The default `modelCatalog()` reply: a ready catalog with two providers. */
const CATALOG_OK = () => Promise.resolve({ ok: true, value: { groups: CATALOG_GROUPS } })

/**
 * Mount a fresh copy of the section against a fresh form double.
 * @param snapshot - the config-form snapshot to serve.
 * @param options - `nextResult` seeds what `mutate` resolves; `call` is the raw
 *   `/backend-restart` RPC implementation; `fetch` is the document-root probe;
 *   `catalog` is the injected `session.modelCatalog()` implementation;
 *   `remoteUnavailable` omits the Remote service and its dotted namespace.
 * @returns the mounted double plus its recorders and drivers.
 */
function mountSection(snapshot, { nextResult = true, call, fetch: fetchImpl, catalog, remoteUnavailable = false } = {}) {
  const calls = []
  const impl = call ?? ((channel, endpoint) => Promise.resolve(
    endpoint === 'status' ? { ok: true, value: { restartable: true } } : { ok: true },
  ))
  let fetchCalls = 0
  clientWindow.__reloads = 0
  clientWindow.fetch = (...args) => {
    fetchCalls += 1
    return (fetchImpl ?? (() => Promise.resolve({ ok: true })))(...args)
  }
  const ctx = fakeClientContext()
  ctx.form.set(snapshot, nextResult)
  ctx.state.connection = {
    rpc: {
      call: (channel, endpoint, payload, signal) => {
        calls.push({ channel, endpoint, payload, signal })
        return impl(channel, endpoint, payload, signal)
      },
    },
  }
  // Real cordis semantics: `remote.session` is a dotted service resolved
  // through the context, so only `ctx.get('remote.session')` reaches it; the
  // injected `remote` object's own `.session` access throws. The namespace is
  // seeded under the dotted key, never as a nested property of the double.
  if (!remoteUnavailable) {
    ctx.state.remote = remoteNamespaceDouble()
    ctx.state.remoteSession = {
      modelCatalog: () => {
        ctx.state.catalogCalls += 1
        return (catalog ?? CATALOG_OK)()
      },
    }
  }
  clientPlugin.apply(ctx)
  const registration = ctx.state.registered[0]
  const face = registration.options.inject()
  const start = react.useSyncExternalStoreCalls.length
  const inst = react.mount(registration.component, { close: () => {}, ...face })
  return {
    ctx,
    form: ctx.form,
    registration,
    inst,
    tree: () => inst.tree,
    settle: drain,
    unmount: () => inst.unmount(),
    calls: () => calls,
    fetchCalls: () => fetchCalls,
    reloads: () => clientWindow.__reloads,
    /** Every service key the plugin asked the context for, in call order. */
    serviceReads: () => ctx.state.serviceReads,
    saveButton: () => buttonWithText(inst.tree, ['action.save', 'action.saving']),
    restartButton: () => buttonWithText(inst.tree, ['restart.action', 'restart.restarting']),
    cancelButton: () => buttonWithText(inst.tree, ['restart.cancel']),
    confirmButton: () => buttonWithText(inst.tree, ['restart.confirmAction']),
    reloadButton: () => buttonWithText(inst.tree, ['restart.reload']),
    controls: () => findAll(inst.tree, node => node.type === 'input' || node.type === 'textarea'),
    alerts: () => findAll(inst.tree, node => node.props?.role === 'alert'),
    subscribeCalls: () => react.useSyncExternalStoreCalls.slice(start),
  }
}

/* ══ 1. manifest ═══════════════════════════════════════════════════════════ */

await check('the manifest declares the frozen identity, bundle patch, and web client', () => {
  assert.equal(manifest.name, '@local/dsh-compaction-tuner', `package name drifted to ${String(manifest.name)}`)
  assert.equal(manifest.version, '1.0.0', `version drifted to ${String(manifest.version)}`)
  assert.equal(manifest.private, true, 'the package must stay private')
  assert.equal(manifest.type, 'module', `type drifted to ${String(manifest.type)}`)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', `dsh.bundle.patch drifted to ${String(manifest.dsh?.bundle?.patch)}`)
  assert.equal(manifest.dsh?.client?.platform, 'web', `dsh.client.platform drifted to ${String(manifest.dsh?.client?.platform)}`)
  for (const dependency of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-connection']) {
    assert.ok(manifest.dsh.client.inject.includes(dependency), `dsh.client.inject is missing ${dependency}`)
  }
  assert.equal(manifest.scripts?.verify, 'node verify.mjs', `scripts.verify drifted to ${String(manifest.scripts?.verify)}`)
  assert.equal(manifest.dependencies, undefined, 'the plugin must ship no dependencies: an install step could reach the network')
})

await check('every export subpath the packaging contract needs is present', () => {
  for (const subpath of ['.', './client', './locale/*.json']) {
    assert.ok(manifest.exports?.[subpath] !== undefined, `exports is missing "${subpath}"`)
  }
})

await check('every non-glob entry of "files" exists on disk', () => {
  const missing = manifest.files.filter(entry => !entry.includes('*') && !existsSync(join(here, entry)))
  assert.deepEqual(missing, [], `these "files" entries do not exist: ${missing.join(', ')}`)
})

await check('both locale files carry the display metadata of a shipped dictionary', () => {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const locale = readJson(file)
    assert.equal(typeof locale.meta?.title, 'string', `${file} has no meta.title`)
    assert.ok((locale.meta?.title ?? '').length > 0, `${file} meta.title is empty`)
    assert.equal(typeof locale.meta?.description, 'string', `${file} has no meta.description`)
    assert.ok((locale.meta?.description ?? '').length > 0, `${file} meta.description is empty`)
  }
})

/* ══ 2. drift guard across the halves ══════════════════════════════════════ */

const patchRow = /- insert:\s*\n\s*-\s*id:\s*([^\s]+)\s*\n\s*name:\s*'([^']+)'/.exec(patch)

await check('the bundle patch mounts exactly one row with the frozen entry id and bare package name', () => {
  assert.ok(patchRow !== null, 'cordis.patch.yml does not match the frozen insert-row shape')
  assert.equal(patchRow[1], 'compaction-tuner', `the loader entry id drifted to ${patchRow[1]}`)
  assert.equal(patchRow[2], manifest.name, `the loader row name ${patchRow[2]} is not the bare package name ${manifest.name}`)
  assert.equal((patch.match(/- insert:/g) ?? []).length, 1, 'the patch must insert exactly one row')
  assert.equal((patch.match(/- id:/g) ?? []).length, 1, 'the patch must declare exactly one row id')
})

await check('the mount patch seeds NO option, so a fresh install runs the code defaults', () => {
  // The patch inserts a bare row and no `config`: the tuner therefore runs the
  // upstream compaction-basic code defaults (index.js `OPTION_SPECS`), and a
  // preset that omits the keys already runs them, so the install changes
  // nothing until the user edits a value.
  for (const key of TUNE_ORDER) {
    assert.doesNotMatch(
      patch,
      new RegExp(`^\\s+${key}:`, 'm'),
      `the mount patch seeds ${key}, which would make an install choice reach every preset`,
    )
  }
  assert.doesNotMatch(patch, /^\s+config:\s*$/m, 'the mounted row must not carry a config block')
  assert.ok(!/commits\s+thresholdRatio|standard\.patch\.yml currently commits/i.test(patch), 'the false provenance comment is still in the mount patch')
})

await check('the client module id is the exact package name', () => {
  const textual = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientSource)
  assert.ok(textual !== null, 'client.js does not call window.__ModuleLoader__.load({ id: ... })')
  assert.equal(textual[1], manifest.name, `the client module id ${textual[1]} drifted from the package name`)
  assert.equal(captured?.id, manifest.name, 'the evaluated __ModuleLoader__.load id drifted from the package name')
})

await check('the client artifact requests only react from the baseline module table', () => {
  const requires = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(match => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], `client.js require() calls drifted: ${JSON.stringify(requires)}`)
  assert.ok(!/@deepseek-ai\//.test(clientSource), 'client.js references a baseline external (@deepseek-ai/...) that the module table would refuse')
  assert.deepEqual(requested, ['react'], `the evaluated factory requested ${JSON.stringify(requested)}`)
})

await check('the host half has no default export and exposes the frozen named surface', () => {
  assert.equal('default' in host, false, 'index.js must not have a default export')
  for (const name of [
    'name', 'inject', 'Config', 'schemaLibrary', 'DEFAULT_TUNE', 'TUNE_KEYS', 'TUNE_OPTIONS', 'TARGET_PRESET_PLUGIN',
    'COMPACTION_ROW_ID', 'COMPACTION_PLUGIN', 'volatileValue', 'rawTune', 'liveTune', 'projectedTune', 'tuneProblem',
    'findCompactionRow', 'readTune', 'withTune', 'retune', 'apply',
  ]) {
    assert.ok(name in host, `index.js is missing the export "${name}"`)
  }
  assert.equal(host.name, 'compaction-tuner', `index.js exported name drifted to ${String(host.name)}`)
  assert.deepEqual([...host.inject], ['configEditor', 'loader'], `index.js inject drifted to ${JSON.stringify(host.inject)}`)
  assert.equal(host.TARGET_PRESET_PLUGIN, '@deepseek-ai/dsh-agent-preset', 'TARGET_PRESET_PLUGIN drifted')
  assert.equal(host.COMPACTION_ROW_ID, 'compaction-basic', 'COMPACTION_ROW_ID drifted')
  assert.equal(host.COMPACTION_PLUGIN, '@deepseek-ai/dsh-compaction-basic', 'COMPACTION_PLUGIN drifted')
})

await check('DEFAULT_TUNE is exactly the eleven upstream code defaults', () => {
  assert.deepEqual([...host.TUNE_KEYS], TUNE_ORDER, `TUNE_KEYS drifted: ${JSON.stringify([...host.TUNE_KEYS])}`)
  assert.equal(Object.isFrozen(host.DEFAULT_TUNE), true, 'DEFAULT_TUNE must stay frozen')
  assert.deepEqual(
    Object.keys(host.DEFAULT_TUNE).sort(),
    [...TUNE_ORDER].sort(),
    `DEFAULT_TUNE does not carry exactly the owned keys: ${JSON.stringify(Object.keys(host.DEFAULT_TUNE))}`,
  )
  for (const key of TUNE_ORDER) {
    assert.deepEqual(
      host.DEFAULT_TUNE[key],
      UPSTREAM_DEFAULTS[key],
      `DEFAULT_TUNE.${key} drifted: ${JSON.stringify(host.DEFAULT_TUNE[key])} vs upstream ${JSON.stringify(UPSTREAM_DEFAULTS[key])}`,
    )
  }
})

await check('TUNE_OPTIONS states a default text and an allowed range for every key', () => {
  assert.deepEqual(host.TUNE_OPTIONS.map(option => option.key), TUNE_ORDER, 'TUNE_OPTIONS is not one entry per owned key, in order')
  for (const option of host.TUNE_OPTIONS) {
    assert.ok(['ratio', 'nonNegativeInteger', 'positiveInteger', 'string', 'boolean', 'modelPolicies'].includes(option.kind), `${option.key} has the unknown kind ${String(option.kind)}`)
    assert.ok(typeof option.defaultText === 'string' && option.defaultText.length > 0, `${option.key} has no defaultText`)
    assert.ok(typeof option.range === 'string' && option.range.length > 0, `${option.key} has no range text`)
    assert.ok(option.range.includes('>=') || option.range.includes('(0, 1]') || option.range.includes('true or false') || option.range.includes('string') || option.range.includes('array'), `${option.key} range text advertises nothing: ${option.range}`)
    assert.deepEqual(option.default, UPSTREAM_DEFAULTS[option.key], `${option.key} default drifted from upstream`)
  }
})

await check('the entry id, settings namespace, locale NS, and both halves agree', () => {
  const options = clientContext.state.registered[0]?.options
  assert.equal(host.name, patchRow[1], `index.js name ${host.name} and the loader entry id ${patchRow[1]} disagree`)
  assert.equal(options?.id, 'compaction-tuner', `the client section id drifted to ${String(options?.id)}`)
  assert.equal(options?.locale, 'compaction-tuner', `the client locale NS drifted to ${String(options?.locale)}`)
  assert.equal(clientContext.state.dictionaries[0]?.ns, 'compaction-tuner', `the client dictionary NS drifted to ${String(clientContext.state.dictionaries[0]?.ns)}`)
  assert.equal(options?.id, host.name, 'the settings section id and index.js name disagree')
  assert.equal(options?.locale, patchRow[1], 'the locale NS and the loader entry id disagree')
})

/* ══ 2b. docs, and the volatile-array seam the page depends on ════════════ */

await check('README and CONTRACT document all eleven options and the code defaults', () => {
  const readme = read('README.md')
  const contract = read('CONTRACT.md')
  for (const option of host.TUNE_OPTIONS) {
    assert.ok(readme.includes(`\`${option.key}\``), `README does not name the option ${option.key}`)
    assert.ok(contract.includes(`\`${option.key}\``), `CONTRACT does not name the option ${option.key}`)
  }
  for (const [file, text] of [['README.md', readme], ['CONTRACT.md', contract]]) {
    assert.ok(/code default/i.test(text), `${file} does not distinguish the upstream code default`)
    // The seedless behaviour must be stated, and no doc may claim the install
    // seeds 0.5 / 0.15 / 2 again (the legacy value may only appear as a stored
    // value kept for existing profiles).
    assert.ok(/seeds?\s+\*{0,2}nothing/i.test(text), `${file} does not state that the install seeds nothing`)
    assert.doesNotMatch(text, /seeds\s+`?0\.5/i, `${file} claims the install seeds 0.5 / 0.15 / 2`)
    assert.doesNotMatch(text, /install'?s seed/i, `${file} still describes an install-time seed`)
    // The disproved provenance claim must be gone: no shipped preset patch
    // commits any compaction option (only snapshot fixtures set them).
    assert.ok(!/standard\.patch\.yml[^\n]{0,80}commits/i.test(text), `${file} still claims a preset patch commits the seed`)
  }
})

await check('the volatile modelPolicies array survives volatileForm (the settings-page projection)', () => {
  // Faithful copy of `volatileForm()`/`plainSchema()`
  // (packages/settings/settings/src/schema.ts:18-47), the seam that decides
  // whether a Config field reaches a settings page at all. The check exists
  // because "an array of objects cannot be tuned through a volatile form" was a
  // live objection: a volatile ARRAY field short-circuits before any type check.
  const z = host.schemaLibrary
  const plainSchema = schema => {
    const result = new z(schema.toJSON())
    const walk = node => {
      delete node.meta.volatile
      for (const child of Object.values(node.dict ?? {})) walk(child)
      if (node.inner) walk(node.inner)
      for (const child of node.list ?? []) walk(child)
    }
    walk(result)
    return result
  }
  const volatileForm = schema => {
    if (schema.meta.volatile) return plainSchema(schema)
    if (schema.type === 'object') {
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }))
      return Object.keys(dict).length === 0 ? undefined : z.object(dict)
    }
    return undefined
  }
  const form = volatileForm(host.Config)
  assert.ok(form !== undefined, 'volatileForm(Config) is undefined: the settings page would disappear')
  assert.deepEqual(Object.keys(form.dict).sort(), [...TUNE_ORDER].sort(), `the settings form is missing options: ${JSON.stringify(Object.keys(form.dict))}`)
  assert.equal(form.dict.modelPolicies.type, 'array', 'modelPolicies must project into the form as an array field')
  assert.equal(host.Config.dict.modelPolicies.meta.volatile, true, 'the modelPolicies array must be volatile: equalExceptVolatile short-circuits on that flag before any type check (vendor/loader/src/config/diff.ts:14)')
  // `settings.write()` refuses any op path that is not volatile
  // (packages/settings/settings/src/index.ts:387-389), so the same seam decides
  // whether a one-op modelPolicies write is accepted. Faithful copy of
  // isVolatilePath() from that package's schema.ts.
  const isVolatilePath = (schema, path) => {
    if (schema.meta.volatile) return true
    const [key, ...rest] = path
    const child = key === undefined ? undefined : schema.dict?.[key]
    return child !== undefined && isVolatilePath(child, rest)
  }
  for (const key of TUNE_ORDER) {
    assert.equal(isVolatilePath(host.Config, [key]), true, `a settings write to ${key} would be refused as non-volatile`)
  }
  assert.equal(isVolatilePath(host.Config, ['modelPolicies', '0', 'provider']), true, 'a nested array path must also resolve through the volatile array node')
})

/* ══ 2b. docs: citations, tables, and the install-change section ══════════ */

/**
 * Markdown table rows whose header line contains `headerNeedle`, keyed by the
 * header cell text.
 * @param markdown - the document.
 * @param headerNeedle - a substring of the target table's header row.
 * @returns the header cells plus one object per body row.
 */
function markdownTable(markdown, headerNeedle) {
  const lines = markdown.split('\n')
  // The prose above a table also names its columns, so the header is the first
  // PIPE-LEADING line that carries the needle.
  const start = lines.findIndex(line => line.trim().startsWith('|') && line.includes(headerNeedle))
  assert.ok(start >= 0, `no markdown table whose header contains "${headerNeedle}"`)
  const header = lines[start].split('|').map(cell => cell.trim()).filter(cell => cell.length > 0)
  const rows = []
  for (let index = start + 2; index < lines.length && lines[index].trim().startsWith('|'); index += 1) {
    const cells = lines[index].split('|').map(cell => cell.trim()).slice(1, -1)
    const row = {}
    header.forEach((name, position) => { row[name] = cells[position] ?? '' })
    rows.push(row)
  }
  return { header, rows }
}

/** Strip markdown emphasis so a cell can be compared against plain metadata text. */
function plainCell(text) {
  return text.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Boundary-aware containment: `0.8` must not match inside `0.85`, and a symbol
 * must not match inside a longer identifier. Non-word edges (brackets, quotes,
 * spaces) fall back to a plain substring test.
 * @param text - the haystack.
 * @param needle - the literal to find.
 * @returns whether `needle` occurs as a whole token.
 */
function containsToken(text, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A leading/trailing dot is deliberately NOT a boundary: `config.maxTokens`
  // legitimately contains the member name `maxTokens`, and `window.__load`
  // contains `__load`. Digit/word adjacency is what must not be crossed, so
  // `0.8` still cannot match inside `0.85` or `10.8`.
  const left = /^[A-Za-z0-9_]/.test(needle) ? '(?<![A-Za-z0-9_])' : ''
  const right = /[A-Za-z0-9_]$/.test(needle) ? '(?![A-Za-z0-9_])' : ''
  return new RegExp(left + escaped + right).test(text)
}

/**
 * Every `file:line` citation target the docs may use, resolved explicitly. A
 * bare basename is a doc shorthand and is pinned here, so a new target fails
 * loudly instead of silently resolving to the wrong file. Paths with a `/` are
 * checkout-relative, except the sibling bundle under this workspace.
 */
function citationTarget(target) {
  const checkout = process.env.DSH_HARNESS_CHECKOUT ?? ''
  const local = {
    'index.js': join(here, 'index.js'),
    'client.js': join(here, 'client.js'),
    'verify.mjs': join(here, 'verify.mjs'),
    'cordis.patch.yml': join(here, 'cordis.patch.yml'),
    'README.md': join(here, 'README.md'),
    'CONTRACT.md': join(here, 'CONTRACT.md'),
    'package.json': join(here, 'package.json'),
    'dsh-backend-restart/CONTRACT.md': join(here, '..', 'dsh-backend-restart', 'CONTRACT.md'),
    // Doc shorthands: a bare basename always means the compaction-basic source.
    'config.ts': join(checkout, 'packages/compaction/compaction-basic/src/config.ts'),
    'index.ts': join(checkout, 'packages/compaction/compaction-basic/src/index.ts'),
    'standard.patch.yml': join(checkout, 'packages/bundle/web-app/presets/standard.patch.yml'),
  }
  if (local[target] !== undefined) return local[target]
  if (target.includes('/')) return join(checkout, target)
  return undefined
}

/** A source line that is only a comment cannot vouch for a symbol. */
function isCommentLine(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
    || trimmed.startsWith('#') || trimmed.startsWith('<!--') || trimmed.startsWith('-->')
}

await check('every code citation in the docs points at the symbol it names', () => {
  const checkout = process.env.DSH_HARNESS_CHECKOUT
  assert.ok(checkout, 'DSH_HARNESS_CHECKOUT is unset: the checkout citations cannot be resolved')
  let citations = 0
  for (const doc of ['README.md', 'CONTRACT.md']) {
    const text = read(doc)
    // `file:12`, `file:12-14` and `file:12,14,105` are all citations; the anchor
    // is the backticked span that ends immediately before the citation.
    for (const match of text.matchAll(/`([^`\n]+?):(\d+(?:,\d+)*)(?:-(\d+))?`/g)) {
      citations += 1
      const [, target, firstText, lastText] = match
      const lines = firstText.split(',').map(Number)
      const first = lines[0]
      const last = lastText === undefined ? lines[lines.length - 1] : Number(lastText)
      const before = text.slice(Math.max(0, match.index - 400), match.index)
      const close = before.lastIndexOf('`')
      const open = close === -1 ? -1 : before.lastIndexOf('`', close - 1)
      assert.ok(open !== -1 && close > open, `${doc}:${match[0]} has no backticked symbol anchor before it`)
      const anchor = before.slice(open + 1, close)
      assert.ok(!/:[0-9]/.test(anchor) || !anchor.includes('/'), `${doc}:${match[0]} is anchored to another citation, not a symbol (${anchor})`)
      const needle = anchor.replace(/\(\)$/, '').trim()
      assert.ok(
        needle.length >= 2 && needle.length <= 90 && !needle.includes('\n'),
        `${doc}:${match[0]} is anchored to "${anchor}", which is not a single symbol`,
      )
      const path = citationTarget(target)
      assert.ok(path !== undefined, `${doc}:${match[0]} uses the unregistered citation target "${target}"; register it in citationTarget()`)
      assert.ok(existsSync(path), `${doc}:${match[0]} resolves to ${path}, which does not exist`)
      const fileLines = readFileSync(path, 'utf8').split('\n')
      assert.ok(first >= 1 && last <= fileLines.length, `${doc}:${match[0]} is outside ${target} (${fileLines.length} lines)`)
      const body = fileLines.slice(first - 1, last).filter(line => line.trim() !== '' && !isCommentLine(line)).join('\n')
      assert.ok(
        containsToken(body, needle),
        `${doc}:${match[0]} does not contain the anchor symbol "${needle}" on a non-comment line (checked ${target} lines ${first}-${last})`,
      )
    }
  }
  assert.ok(citations >= 100, `expected the full citation set across both docs, found ${citations}`)
})

await check('the README and CONTRACT option tables carry the host defaults and ranges', () => {
  const tables = [
    ['README.md', markdownTable(read('README.md'), 'Code default'), 'Code default', 'Accepts'],
    ['CONTRACT.md', markdownTable(read('CONTRACT.md'), 'Code default'), 'Code default', 'Range (enforced by)'],
  ]
  for (const [file, table, defaultColumn, rangeColumn] of tables) {
    assert.ok(table.rows.length >= host.TUNE_OPTIONS.length, `${file}: only ${table.rows.length} option rows`)
    for (const option of host.TUNE_OPTIONS) {
      const keyColumn = Object.keys(table.header)[0]
      const row = table.rows.find(candidate => plainCell(candidate[table.header[0]] ?? '') === option.key)
      assert.ok(row !== undefined, `${file} has no option-table row for ${option.key} (looked for a row whose first cell is the key; columns ${String(keyColumn)})`)
      const defaultCell = plainCell(row[defaultColumn] ?? '')
      assert.ok(
        containsToken(defaultCell, option.defaultText),
        `${file} default cell for ${option.key} does not carry the host defaultText "${option.defaultText}" as a whole value: ${defaultCell}`,
      )
      const rangeCell = plainCell(row[rangeColumn] ?? '')
      if (option.kind === 'modelPolicies') {
        assert.ok(/array/i.test(rangeCell), `${file} range cell for ${option.key} is not an array range: ${rangeCell}`)
      } else {
        const coreRange = plainCell(option.range.split(';')[0].replace(/\s*\(.*\)$/, ''))
        assert.ok(
          containsToken(rangeCell, coreRange),
          `${file} range cell for ${option.key} does not carry "${coreRange}": ${rangeCell}`,
        )
      }
      // A row that names a number the host does not use is the failure mode this
      // check exists for: the row must not contradict the metadata.
      for (const number of option.range.match(/\d+(?:\.\d+)?/g) ?? []) {
        assert.ok(
          containsToken(rangeCell, number) || containsToken(defaultCell, number),
          `${file} row for ${option.key} never mentions the host range number ${number} as a whole value: ${rangeCell}`,
        )
      }
    }
  }
})

await check('the install behaviour change section names every always-projected key', () => {
  const readme = read('README.md')
  const contract = read('CONTRACT.md')
  assert.ok(readme.includes('Install behaviour change'), 'README has no "Install behaviour change" section')
  assert.ok(contract.includes('Install behaviour change'), 'CONTRACT has no "Install behaviour change" section')
  const readmeStart = readme.indexOf('## Install behaviour change')
  const readmeEnd = readme.indexOf('\n## ', readmeStart + 1)
  const contractStart = contract.indexOf('### Install behaviour change')
  const contractEnd = contract.indexOf('\n### ', contractStart + 1)
  for (const [file, section] of [
    ['README.md', readme.slice(readmeStart, readmeEnd === -1 ? undefined : readmeEnd)],
    ['CONTRACT.md', contract.slice(contractStart, contractEnd === -1 ? undefined : contractEnd)],
  ]) {
    assert.ok(section.length > 0, `${file}: no install-behaviour section`)
    for (const key of host.TUNE_KEYS) {
      if (key === 'modelPolicies') continue
      assert.ok(section.includes(key), `${file}: the install-behaviour section does not name the projected key ${key}`)
    }
    assert.ok(section.includes('modelPolicies'), `${file}: the install-behaviour section does not state the modelPolicies exception`)
  }
})

await check('no shipped doc or comment cites the removed TODO.md', () => {
  // The needle is built at runtime so this suite's own diagnostic text cannot
  // satisfy it; verify.mjs is excluded because it is the check, not a citation.
  const needle = 'TODO' + '.md'
  for (const file of ['README.md', 'CONTRACT.md', 'client.js', 'index.js', 'locale/en.json', 'locale/zh.json', 'cordis.patch.yml']) {
    assert.ok(!read(file).includes(needle), `${file} still cites ${needle}, which does not exist in this repository`)
  }
})

/* ══ 3. host half against the REAL schemastery ═════════════════════════════ */

await check('the real schemastery resolves through $DSH_HARNESS_CHECKOUT (never skipped silently)', () => {
  assert.ok(process.env.DSH_HARNESS_CHECKOUT, 'DSH_HARNESS_CHECKOUT is unset; run: DSH_HARNESS_CHECKOUT=/home/user/Public/deepseek-harness node dsh-compaction-tuner/verify.mjs')
  assert.ok(host.schemaLibrary !== undefined, `the host half could not resolve @deepseek-ai/schemastery from ${process.env.DSH_HARNESS_CHECKOUT}`)
  assert.ok(host.Config !== undefined, 'Config is undefined, so the Host would render no settings namespace at all')
})

await check('Config is a real schemastery object root, not a transform, refine, or union', () => {
  assert.equal(typeof host.Config, 'function', `Config is ${typeof host.Config}, not a schema`)
  assert.equal(host.Config.type, 'object', `Config.type is ${String(host.Config.type)}: volatileForm only descends an object root`)
  assert.equal(host.Config['~standard']?.vendor, 'schemastery', `the schema vendor is ${String(host.Config['~standard']?.vendor)}`)
  assert.deepEqual(
    Object.keys(host.Config.dict ?? {}).sort(),
    [...TUNE_ORDER].sort(),
    `Config.dict is not exactly the eleven owned options: ${JSON.stringify(Object.keys(host.Config.dict ?? {}))}`,
  )
})

await check('Config declares all eleven options as volatile fields with the frozen shapes', () => {
  const expected = {
    thresholdRatio: { step: 0.01, min: 0.01, max: 1, default: 0.8 },
    headroomTokens: { step: 1, min: 0, default: 65_536 },
    retainRatio: { step: 0.01, min: 0.01, max: 1 },
    retainTokens: { step: 1, min: 0 },
    summarizationProvider: { default: '' },
    summarizationModel: { default: '' },
    maxTokens: { step: 1, min: 1 },
    compactionRetries: { step: 1, min: 0, default: 1 },
    maxOverflowRetries: { step: 1, min: 0, default: 1 },
    modelPolicies: { type: 'array' },
    auto: { default: true },
  }
  for (const field of TUNE_ORDER) {
    const node = host.Config.dict[field]
    const shape = expected[field]
    assert.ok(node !== undefined, `Config has no "${field}" field`)
    assert.ok(shape !== undefined, `the suite has no expected shape for "${field}"`)
    assert.equal(node.meta?.volatile, true, `${field} is not .volatile(), so a settings edit would remount the row`)
    for (const [key, value] of Object.entries(shape)) {
      if (key === 'type') {
        assert.equal(node.type, value, `${field} is a ${String(node.type)} field, expected ${String(value)}`)
        continue
      }
      assert.equal(node.meta?.[key], value, `${field}.${key} drifted: expected ${String(value)}, got ${String(node.meta?.[key])}`)
    }
  }
  // The three optional keys carry NO schema default on purpose: a schemastery
  // default is materialized into the running config, which would make the
  // retainRatio XOR retainTokens rule undetectable.
  for (const field of ['retainRatio', 'retainTokens', 'maxTokens']) {
    assert.equal(host.Config.dict[field].meta?.default, undefined, `${field} must not carry a schema default`)
  }
})

await check('Config({thresholdRatio: 0.5}) fills the code defaults and leaves the unset keys unset', () => {
  const parsed = host.Config({ thresholdRatio: 0.5 })
  assert.equal(host.volatileValue(parsed.thresholdRatio), 0.5, 'thresholdRatio was not parsed to 0.5')
  assert.equal(host.volatileValue(parsed.headroomTokens), 65_536, 'headroomTokens default drifted')
  assert.equal(host.volatileValue(parsed.compactionRetries), 1, `compactionRetries default drifted to ${String(host.volatileValue(parsed.compactionRetries))}`)
  assert.equal(host.volatileValue(parsed.maxOverflowRetries), 1, 'maxOverflowRetries default drifted')
  assert.equal(host.volatileValue(parsed.summarizationProvider), '', 'summarizationProvider default drifted')
  assert.equal(host.volatileValue(parsed.summarizationModel), '', 'summarizationModel default drifted')
  assert.deepEqual(host.volatileValue(parsed.modelPolicies), [], 'modelPolicies default drifted')
  assert.equal(host.volatileValue(parsed.auto), true, 'auto default drifted')
  assert.equal(host.volatileValue(parsed.retainRatio), undefined, 'retainRatio must stay unset: a default would break the retention XOR')
  assert.equal(host.volatileValue(parsed.retainTokens), undefined, 'retainTokens must stay unset')
  assert.equal(host.volatileValue(parsed.maxTokens), undefined, 'maxTokens must stay unset so it can derive from headroomTokens')
  assert.deepEqual(host.liveTune(parsed), { ...host.DEFAULT_TUNE, thresholdRatio: 0.5 }, 'liveTune did not resolve the unset keys to the code defaults')
})

await check('the schema refuses every out-of-shape per-field value before the profile patch can change', () => {
  const cases = [
    ['thresholdRatio: 0', { thresholdRatio: 0 }],
    ['thresholdRatio: 1.2', { thresholdRatio: 1.2 }],
    ['retainRatio: 0.005', { thresholdRatio: 0.8, retainRatio: 0.005 }],
    ['headroomTokens: -1', { headroomTokens: -1 }],
    ['headroomTokens: 1.5', { headroomTokens: 1.5 }],
    ['retainTokens: 1.5', { retainTokens: 1.5 }],
    ['maxTokens: 0', { maxTokens: 0 }],
    ['compactionRetries: -1', { compactionRetries: -1 }],
    ['compactionRetries: 1.5', { compactionRetries: 1.5 }],
    ['maxOverflowRetries: -1', { maxOverflowRetries: -1 }],
    ['auto: "yes"', { auto: 'yes' }],
    ['modelPolicies: {}', { modelPolicies: {} }],
    ['modelPolicies entry without a provider', { modelPolicies: [{ model: 'gpt-5' }] }],
  ]
  for (const [label, input] of cases) {
    assert.throws(() => host.Config(input), `Config({${label}}) must throw but was accepted`)
  }
})

await check('the schema cannot express retainRatio < thresholdRatio, and tuneProblem is what refuses it', () => {
  // The cross-field pair is IN-STEP and per-field in range, so schemastery
  // accepts it: that is exactly why the root has to stay a plain object and why
  // tuneProblem() is the guard. A "throws" expectation here would contradict the
  // frozen host contract.
  const pair = { thresholdRatio: 0.01, retainRatio: 0.02 }
  const parsed = host.Config(pair)
  assert.equal(host.volatileValue(parsed.thresholdRatio), 0.01, 'the schema did not accept the in-range thresholdRatio')
  assert.equal(host.volatileValue(parsed.retainRatio), 0.02, 'the schema did not accept the in-range retainRatio')
  assert.match(String(host.tuneProblem(pair)), /smaller than thresholdRatio/, 'tuneProblem must refuse the cross-field pair the schema cannot')
})

await check('tuneProblem refuses every cross-field rule the schema cannot express', () => {
  assert.equal(host.tuneProblem({}), undefined, 'the code defaults must be a usable tune')
  assert.equal(host.tuneProblem({ thresholdRatio: 0.6, retainRatio: 0.2, compactionRetries: 3 }), undefined, 'a usable tune must not be refused')
  assert.equal(host.tuneProblem({ thresholdRatio: 0.6, retainTokens: 1024 }), undefined, 'the token retention form must be usable')
  assert.equal(host.tuneProblem({ thresholdRatio: 0.6, maxTokens: 2048, headroomTokens: 0 }), undefined, 'an explicit maxTokens must make a zero headroom usable')
  for (const [label, input, pattern] of [
    ['retainRatio above thresholdRatio', { thresholdRatio: 0.2, retainRatio: 0.3, compactionRetries: 1 }, /smaller than thresholdRatio/],
    ['retainRatio equal to thresholdRatio', { thresholdRatio: 0.2, retainRatio: 0.2, compactionRetries: 1 }, /smaller than thresholdRatio/],
    ['thresholdRatio out of range', { thresholdRatio: 0, retainRatio: 0, compactionRetries: 1 }, /thresholdRatio must be/],
    ['compactionRetries fractional', { thresholdRatio: 0.6, retainRatio: 0.2, compactionRetries: 1.5 }, /compactionRetries must be a non-negative integer/],
    ['retainRatio and retainTokens together', { thresholdRatio: 0.6, retainRatio: 0.2, retainTokens: 1024 }, /mutually exclusive/],
    ['headroomTokens negative', { headroomTokens: -1 }, /headroomTokens must be a non-negative integer/],
    ['retainTokens fractional', { retainTokens: 1.5 }, /retainTokens must be a non-negative integer/],
    ['headroomTokens 0 with no maxTokens', { headroomTokens: 0 }, /maxTokens must resolve to a positive integer/],
    ['maxOverflowRetries fractional', { maxOverflowRetries: 0.5 }, /maxOverflowRetries must be a non-negative integer/],
    ['summarizationProvider without its model', { summarizationProvider: 'openai' }, /must be set together/],
    ['summarizationModel without its provider', { summarizationModel: 'gpt-5' }, /must be set together/],
    ['auto not a boolean', { auto: 'yes' }, /auto must be a boolean/],
    ['modelPolicies not an array', { modelPolicies: {} }, /modelPolicies must be an array/],
    ['modelPolicies entry without a provider', { modelPolicies: [{ model: 'gpt-5' }] }, /provider must be a non-empty string/],
    ['modelPolicies entry without a model', { modelPolicies: [{ provider: 'openai' }] }, /model must be a non-empty string/],
    ['duplicate modelPolicies target', { modelPolicies: [{ provider: 'openai', model: 'gpt-5' }, { provider: 'openai', model: 'gpt-5' }] }, /duplicate model policy/],
    ['unknown modelPolicies key', { modelPolicies: [{ provider: 'openai', model: 'gpt-5', bogus: 1 }] }, /unknown key "bogus"/],
    ['modelPolicies entry retainRatio above its threshold', { modelPolicies: [{ provider: 'openai', model: 'gpt-5', thresholdRatio: 0.2, retainRatio: 0.4 }] }, /smaller than the resolved thresholdRatio/],
    ['modelPolicies entry with both retention forms', { modelPolicies: [{ provider: 'openai', model: 'gpt-5', retainRatio: 0.2, retainTokens: 100 }] }, /mutually exclusive/],
    ['modelPolicies entry maxTokens 0', { modelPolicies: [{ provider: 'openai', model: 'gpt-5', maxTokens: 0 }] }, /maxTokens must be a positive integer/],
  ]) {
    assert.match(String(host.tuneProblem(input)), pattern, `tuneProblem missed: ${label}`)
  }
})

await check('tuneProblem refuses integers outside the safe range at every layer, and normalizes -0', () => {
  // Silent rounding is worse than a refusal: 9007199254740993 is already
  // 9007199254740992 as a JS number, and 1e21 loses precision entirely.
  for (const [label, input] of [
    ['headroomTokens 1e21', { headroomTokens: 1e21 }],
    ['headroomTokens 9007199254740993', { headroomTokens: 9_007_199_254_740_993 }],
    ['retainTokens 1e21', { retainTokens: 1e21 }],
    ['compactionRetries 1e21 with a valid headroom', { headroomTokens: 100, compactionRetries: 1e21 }],
    ['maxOverflowRetries 1e21 with a valid headroom', { headroomTokens: 100, maxOverflowRetries: 1e21 }],
    ['modelPolicies entry headroomTokens 1e21', { headroomTokens: 100, modelPolicies: [{ provider: 'o', model: 'm', headroomTokens: 1e21 }] }],
    ['derived maxTokens 1e21 (headroom only)', { headroomTokens: 1e21 }],
  ]) {
    assert.equal(typeof host.tuneProblem(input), 'string', `tuneProblem accepted an unsafe integer: ${label}`)
  }
  assert.equal(host.tuneProblem({ headroomTokens: 9_007_199_254_740_991 }), undefined, 'the largest safe integer must be accepted')
  // -0 is the same number as 0 but serializes oddly; the projection must emit +0.
  const negativeZero = host.projectedTune({ headroomTokens: -0, maxTokens: 5 })
  assert.equal(Object.is(negativeZero.headroomTokens, -0), false, 'projectedTune emitted -0 for headroomTokens')
  assert.equal(negativeZero.headroomTokens, 0, 'projectedTune did not normalize -0 to 0')
  // An ABSENT optional field must never be materialized by that normalization.
  assert.equal(Object.hasOwn(host.projectedTune({}), 'retainTokens'), false, '-0 normalization materialized an absent retainTokens')
  assert.equal(Object.hasOwn(host.projectedTune({}), 'retainRatio'), true, 'the ratio form must still be projected')
  assert.match(String(host.tuneProblem({ headroomTokens: -0 })), /maxTokens must resolve to a positive integer.*got -0/, 'a -0 headroom with no cap must be refused and rendered as -0, matching upstream')
})

await check('tuneProblem validates each modelPolicies entry RESOLVED cap (config.ts:83-90)', () => {
  // Upstream mutates an entry's cap to its own headroomTokens when the TOP LEVEL
  // leaves maxTokens unset, so an entry with headroomTokens 0 throws at load.
  // The tuner must refuse it rather than rely on projectedTune happening to emit
  // a top-level maxTokens.
  const entry = { provider: 'openai', model: 'gpt-5', headroomTokens: 0 }
  assert.match(
    String(host.tuneProblem({ modelPolicies: [entry] })),
    /modelPolicies\[0\]\.maxTokens must resolve to a positive integer/,
    'an entry with a zero headroom and no cap must be refused',
  )
  assert.equal(
    host.tuneProblem({ maxTokens: 4096, modelPolicies: [entry] }),
    undefined,
    'an explicit top-level maxTokens makes the same entry usable, exactly like upstream',
  )
  assert.equal(
    host.tuneProblem({ modelPolicies: [{ ...entry, maxTokens: 1 }] }),
    undefined,
    'an explicit entry cap makes the entry usable',
  )
  assert.equal(
    host.tuneProblem({ modelPolicies: [{ provider: 'openai', model: 'gpt-5', headroomTokens: 100 }] }),
    undefined,
    'a positive entry headroom is the entry cap when the top level leaves maxTokens unset',
  )
})

await check('an empty modelPolicies table is unmanaged in both directions', async () => {
  const ownTable = [{ provider: 'openai', model: 'gpt-5', thresholdRatio: 0.4 }]
  const withTable = {
    plugins: [{
      id: host.COMPACTION_ROW_ID,
      name: host.COMPACTION_PLUGIN,
      config: {
        thresholdRatio: 0.8, headroomTokens: 65_536, retainRatio: 0.16, summarizationProvider: '',
        summarizationModel: '', maxTokens: 65_536, compactionRetries: 1, maxOverflowRetries: 1,
        auto: true, modelPolicies: ownTable,
      },
    }],
  }
  // (a) empty tuner table: the preset's own table must survive, and the row must
  // be reported in `unmanaged` rather than silently looking like a no-op skip.
  const untouched = createEditor([{ id: 'preset-own', name: host.TARGET_PRESET_PLUGIN, config: withTable }])
  const first = await host.retune(untouched, {}, () => {})
  assert.deepEqual(first.changed, [], `an empty tuner table changed a preset: ${JSON.stringify(first.changed)}`)
  assert.deepEqual(first.unmanaged, ['preset-own'], `the row was not reported as unmanaged: ${JSON.stringify(first.unmanaged)}`)
  assert.deepEqual(first.skipped, ['preset-own'], 'the row must also be reported as skipped')
  assert.equal(untouched.edits.length, 0, 'an empty tuner table wrote a preset')
  // (c) the same pass repeated: the unmanaged key must never become a difference,
  // or an already-tuned preset would be rewritten on every pass.
  const second = await host.retune(untouched, {}, () => {})
  assert.equal(untouched.edits.length, 0, `the unmanaged key caused a rewrite loop: ${untouched.edits.length} edit(s)`)
  assert.deepEqual(second.unmanaged, ['preset-own'], 'the unmanaged report did not repeat')
  // (b) non-empty tuner table: it replaces the preset's table.
  const replaced = createEditor([{ id: 'preset-own', name: host.TARGET_PRESET_PLUGIN, config: JSON.parse(JSON.stringify(withTable)) }])
  const replacement = [{ provider: 'anthropic', model: 'claude-sonnet-4' }]
  const third = await host.retune(replaced, { modelPolicies: replacement }, () => {})
  assert.deepEqual(third.changed, ['preset-own'], 'a non-empty tuner table must replace the preset table')
  assert.deepEqual(third.unmanaged, [], 'a managed table must not be reported as unmanaged')
  const child = host.findCompactionRow(replaced.edits[0].next)
  assert.deepEqual(child.config.modelPolicies, replacement, 'the non-empty table did not replace the preset table')
})

await check('projectedTune projects the derived maxTokens and exactly one retention form', () => {
  const defaults = host.projectedTune({})
  assert.deepEqual(defaults, {
    thresholdRatio: 0.8,
    headroomTokens: 65_536,
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 65_536,
    compactionRetries: 1,
    maxOverflowRetries: 1,
    auto: true,
    retainRatio: 0.16,
  }, `the default projection drifted: ${JSON.stringify(defaults)}`)
  assert.equal(Object.hasOwn(defaults, 'modelPolicies'), false, 'an empty modelPolicies table must NOT be projected (it is unmanaged)')
  assert.equal(host.managesModelPolicies({}), false, 'an empty table must read as unmanaged')
  assert.equal(host.managesModelPolicies({ modelPolicies: [{ provider: 'o', model: 'm' }] }), true, 'a non-empty table must read as managed')
  assert.deepEqual(host.projectedTune({ modelPolicies: [{ provider: 'o', model: 'm' }] }).modelPolicies, [{ provider: 'o', model: 'm' }], 'a non-empty table must be projected')
  const lowerHeadroom = host.projectedTune({ headroomTokens: 32_768 })
  assert.equal(lowerHeadroom.maxTokens, 32_768, 'an unset maxTokens must follow the effective headroomTokens, exactly like upstream `maxTokens ?? headroomTokens`')
  assert.equal(host.projectedTune({ maxTokens: 4096, headroomTokens: 32_768 }).maxTokens, 4096, 'an explicit maxTokens must win over the headroom')
  const tokenForm = host.projectedTune({ retainTokens: 1024 })
  assert.equal(tokenForm.retainTokens, 1024, 'the token retention form was not projected')
  assert.equal(Object.hasOwn(tokenForm, 'retainRatio'), false, 'both retention keys were projected, which upstream rejects')
  assert.equal(Object.hasOwn(defaults, 'retainTokens'), false, 'the ratio retention form must not carry retainTokens')
})

await check('readTune separates "no child" from "child with undeclared keys", and withTune refuses a childless preset', () => {
  const childWithNoKeys = { plugins: [{ id: host.COMPACTION_ROW_ID, name: host.COMPACTION_PLUGIN, config: {} }] }
  assert.deepEqual(host.readTune(childWithNoKeys), { ...host.DEFAULT_TUNE }, 'a child declaring no keys must read as DEFAULT_TUNE')
  assert.equal(host.readTune({ plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] }), undefined, 'a preset with no compaction child must read undefined')
  assert.throws(() => host.withTune({ plugins: [{ id: 'persona' }] }, host.DEFAULT_TUNE), /no "compaction-basic" child/, 'withTune must throw for a childless preset')
})

await check('readTune separates "no child" from "child with undeclared keys", and withTune refuses a childless preset', () => {
  const childWithNoKeys = { plugins: [{ id: host.COMPACTION_ROW_ID, name: host.COMPACTION_PLUGIN, config: {} }] }
  assert.deepEqual(host.readTune(childWithNoKeys), { ...host.DEFAULT_TUNE }, 'a child declaring no keys must read as DEFAULT_TUNE')
  assert.equal(host.readTune({ plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] }), undefined, 'a preset with no compaction child must read undefined')
  assert.throws(() => host.withTune({ plugins: [{ id: 'persona' }] }, host.DEFAULT_TUNE), /no "compaction-basic" child/, 'withTune must throw for a childless preset')
})

/* ══ 4. the host mechanism, driven through retune() ════════════════════════ */

const LIVE = { thresholdRatio: 0.6, retainRatio: 0.2, compactionRetries: 3 }
const EXPR = { __jsExpr: 'ctx.config.budget ?? 4096' }

/**
 * A preset row config shaped like a shipped one: a persona sibling, a
 * `cordis:group` compaction group carrying the compaction child, and a second
 * group sibling that must survive untouched.
 * @param compactionConfig - the compaction child's own config.
 * @returns a fresh preset config.
 */
function presetConfig(compactionConfig) {
  return {
    id: 'standard',
    order: 1,
    description: 'A preset description',
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent.', marker: EXPR } },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true },
        config: [
          { id: host.COMPACTION_ROW_ID, name: host.COMPACTION_PLUGIN, config: compactionConfig },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192 } },
        ],
      },
      { id: 'delegation', name: 'cordis:group', group: true, config: [{ id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' }] },
    ],
  }
}

/**
 * Build a fake `ctx.configEditor` over fixture rows.
 * @param rows - `{id, name, config, inherited, fail}` fixture rows.
 * @returns the editor double plus its recorded edits.
 */
function createEditor(rows) {
  const state = rows.map(row => ({
    entry: { options: { id: row.id, name: row.name, config: row.config } },
    inherited: row.inherited,
    fail: row.fail === true,
  }))
  const edits = []
  return {
    edits,
    configuration: () => state.map(item => ({ entry: item.entry, inherited: item.inherited })),
    async edit(entry, change) {
      const item = state.find(candidate => candidate.entry === entry)
      if (item === undefined) throw new Error(`unknown entry ${String(entry?.options?.id)}`)
      if (item.fail) throw new Error('the entry is owned by a home patch or a --patch overlay')
      const next = change(entry.options.config, item.inherited)
      edits.push({ id: entry.options.id, next })
      item.entry = { ...entry, options: { ...entry.options, config: next } }
      return next
    },
  }
}

/** Fixture rows exercising every branch of retune(). */
function fixtureRows() {
  const standard = presetConfig({ thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2, prunerBudget: EXPR })
  const minimal = presetConfig({})
  minimal.plugins[1].config[0].id = 'compact'
  const tuned = presetConfig({ ...LIVE })
  const inherited = presetConfig({ thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2 })
  return {
    standard,
    minimal,
    tuned,
    inherited,
    rows: [
      { id: 'preset-standard', name: host.TARGET_PRESET_PLUGIN, config: standard },
      { id: 'preset-minimal', name: host.TARGET_PRESET_PLUGIN, config: minimal },
      { id: 'preset-cordis', name: host.TARGET_PRESET_PLUGIN, config: tuned },
      { id: 'preset-bare', name: host.TARGET_PRESET_PLUGIN, config: { id: 'bare', plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] } },
      {
        id: 'preset-conflicted',
        name: host.TARGET_PRESET_PLUGIN,
        config: presetConfig({ thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2 }),
        fail: true,
      },
      { id: 'preset-inherited', name: host.TARGET_PRESET_PLUGIN, config: {}, inherited },
      { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'verbose' } },
    ],
  }
}

const first = fixtureRows()
const editor = createEditor(first.rows)
const warnings = []
const passOne = await host.retune(editor, LIVE, message => warnings.push(message))

await check('one retune pass writes each out-of-tune preset exactly once, in configuration order', () => {
  assert.deepEqual(passOne.changed, ['preset-standard', 'preset-minimal', 'preset-inherited'], `changed drifted: ${JSON.stringify(passOne.changed)}`)
  assert.deepEqual(passOne.skipped, ['preset-cordis', 'preset-bare'], `skipped drifted: ${JSON.stringify(passOne.skipped)}`)
  assert.equal(passOne.refused, undefined, `a valid tune must not be refused, got ${String(passOne.refused)}`)
  assert.deepEqual(editor.edits.map(edit => edit.id), ['preset-standard', 'preset-minimal', 'preset-inherited'], `the edits drifted: ${JSON.stringify(editor.edits.map(edit => edit.id))}`)
})

await check('the tune lands inside the compaction-basic child of every written preset', () => {
  for (const edit of editor.edits) {
    const child = host.findCompactionRow(edit.next)
    assert.ok(child !== undefined, `${edit.id}: no compaction-basic child in the written config`)
    for (const [field, value] of Object.entries(LIVE)) {
      assert.equal(child.config?.[field], value, `${edit.id}: ${field} is ${String(child.config?.[field])}, expected ${String(value)}`)
    }
  }
})

await check('every sibling row and every {__jsExpr} map survives the write verbatim', () => {
  const written = editor.edits.find(edit => edit.id === 'preset-standard').next
  const original = first.standard
  assert.notEqual(written, original, 'withTune must return a clone, not the original object')
  assert.deepEqual(written.plugins[0], original.plugins[0], 'the persona sibling row changed')
  assert.deepEqual(written.plugins[1].config[1], original.plugins[1].config[1], 'the command-compact sibling child changed')
  assert.deepEqual(written.plugins[1].config[2], original.plugins[1].config[2], 'the tool-result-pruner sibling child changed')
  assert.deepEqual(written.plugins[2], original.plugins[2], 'the delegation group sibling changed')
  assert.equal(written.id, original.id, 'the preset id changed')
  assert.equal(written.order, original.order, 'the preset order changed')
  assert.deepEqual(written.plugins[1].config[0].config.prunerBudget, EXPR, 'the {__jsExpr} map inside the compaction child was not preserved')
  assert.deepEqual(written.plugins[0].config.marker, EXPR, 'the {__jsExpr} map in a sibling row was not preserved')
  assert.equal(original.plugins[1].config[0].config.thresholdRatio, 0.5, 'the fixture config was mutated in place')
})

await check('a preset whose declared config is empty is tuned from the inherited layer', () => {
  const written = editor.edits.find(edit => edit.id === 'preset-inherited').next
  assert.ok(written !== undefined, 'the inherited-config preset was not written')
  assert.deepEqual(written.plugins[0], first.inherited.plugins[0], 'the inherited sibling rows were not carried into the replacement config')
  const child = host.findCompactionRow(written)
  assert.equal(child.config.thresholdRatio, LIVE.thresholdRatio, 'the inherited compaction child was not tuned')
})

await check('a preset already carrying the live tune is skipped without any write', () => {
  assert.ok(passOne.skipped.includes('preset-cordis'), 'the already-tuned preset was not skipped')
  assert.ok(!editor.edits.some(edit => edit.id === 'preset-cordis'), 'the already-tuned preset was rewritten')
})

await check('a second identical pass performs NO edit at all (compare-and-skip)', async () => {
  const before = editor.edits.length
  const second = await host.retune(editor, LIVE, message => warnings.push(message))
  assert.deepEqual(second.changed, [], `the second pass rewrote ${JSON.stringify(second.changed)}`)
  assert.equal(editor.edits.length, before, `the second pass added ${editor.edits.length - before} edit(s)`)
  assert.ok(second.skipped.includes('preset-standard'), 'the now-tuned preset was not reported as skipped')
})

await check('the live tune is read from a schemastery-validated (volatile-wrapped) config too', async () => {
  const wrapped = host.Config({ thresholdRatio: 0.6, retainRatio: 0.2, compactionRetries: 3 })
  const fixture = fixtureRows()
  const wrappedEditor = createEditor(fixture.rows)
  const result = await host.retune(wrappedEditor, wrapped, () => {})
  assert.deepEqual(result.changed, ['preset-standard', 'preset-minimal', 'preset-inherited'], `a wrapped config did not drive the same writes: ${JSON.stringify(result.changed)}`)
})

await check('a preset without a compaction-basic child is skipped with NO warning and no edit', async () => {
  const fixture = fixtureRows()
  const bareEditor = createEditor(fixture.rows)
  const bareWarnings = []
  const result = await host.retune(bareEditor, LIVE, message => bareWarnings.push(message))
  assert.ok(result.skipped.includes('preset-bare'), `the childless preset was not reported as skipped: ${JSON.stringify(result.skipped)}`)
  assert.ok(!bareEditor.edits.some(edit => edit.id === 'preset-bare'), 'the childless preset was written')
  assert.ok(!bareWarnings.some(message => message.includes('preset-bare')), `the childless preset warned: ${JSON.stringify(bareWarnings)}`)
})

await check('an inconsistent retainRatio >= thresholdRatio writes NOTHING and logs one warning', async () => {
  const fixture = fixtureRows()
  const refusedEditor = createEditor(fixture.rows)
  const refusedWarnings = []
  const result = await host.retune(refusedEditor, { thresholdRatio: 0.2, retainRatio: 0.3, compactionRetries: 1 }, message => refusedWarnings.push(message))
  assert.equal(typeof result.refused, 'string', 'an inconsistent pair must be refused')
  assert.match(result.refused, /smaller than thresholdRatio/, `the refusal text drifted: ${String(result.refused)}`)
  assert.deepEqual(result.changed, [], 'a refused tune must change nothing')
  assert.deepEqual(result.skipped, [], 'a refused tune must not report skips')
  assert.equal(refusedEditor.edits.length, 0, `a refused tune wrote ${refusedEditor.edits.length} edit(s)`)
  assert.equal(refusedWarnings.length, 1, `a refused tune logged ${refusedWarnings.length} warning(s)`)
  assert.match(refusedWarnings[0], /no preset was changed/, `the refusal warning drifted: ${refusedWarnings[0]}`)
})

await check('one rejected edit is logged and does not stop the remaining presets', async () => {
  const fixture = fixtureRows()
  const rows = [
    fixture.rows.find(row => row.id === 'preset-conflicted'),
    ...fixture.rows.filter(row => row.id !== 'preset-conflicted'),
  ]
  const conflictEditor = createEditor(rows)
  const conflictWarnings = []
  const result = await host.retune(conflictEditor, LIVE, message => conflictWarnings.push(message))
  assert.equal(conflictWarnings.length, 1, `expected one warning naming the refused row, got ${JSON.stringify(conflictWarnings)}`)
  assert.match(conflictWarnings[0], /preset-conflicted/, `the warning does not name the entry id: ${conflictWarnings[0]}`)
  assert.match(conflictWarnings[0], /home patch|--patch overlay/, `the conflict warning drifted: ${conflictWarnings[0]}`)
  assert.ok(!conflictEditor.edits.some(edit => edit.id === 'preset-conflicted'), 'the conflicted preset was edited')
  assert.deepEqual(result.changed, ['preset-standard', 'preset-minimal', 'preset-inherited'], `the rejection stopped the other presets: ${JSON.stringify(result.changed)}`)
})

await check('withTune deletes the retention counterpart instead of leaving the pair side by side', () => {
  const ratioTune = host.withTune(presetConfig({ retainTokens: 4096, thresholdRatio: 0.5 }), { thresholdRatio: 0.5 })
  const ratioChild = host.findCompactionRow(ratioTune).config
  assert.equal(ratioChild.retainRatio, 0.16, 'the ratio form did not write retainRatio')
  assert.equal(Object.hasOwn(ratioChild, 'retainTokens'), false, 'withTune left retainTokens next to retainRatio, which compaction-basic rejects at load (config.ts:292-294)')
  const tokenTune = host.withTune(presetConfig({ retainRatio: 0.15, thresholdRatio: 0.5 }), { thresholdRatio: 0.5, retainTokens: 4096 })
  const tokenChild = host.findCompactionRow(tokenTune).config
  assert.equal(tokenChild.retainTokens, 4096, 'the token form did not write retainTokens')
  assert.equal(Object.hasOwn(tokenChild, 'retainRatio'), false, 'withTune left retainRatio next to retainTokens')
})

await check('behaviour preservation: a preset that omits every option is NOT rewritten on the code defaults', async () => {
  // This is the executable form of the behaviour-preservation rule: with the
  // tuner on its code defaults, a preset whose compaction child declares none of
  // the eleven keys already runs them, so the pass must skip it with no write.
  const untouched = presetConfig({})
  const untouchedEditor = createEditor([{ id: 'preset-untouched', name: host.TARGET_PRESET_PLUGIN, config: untouched }])
  const result = await host.retune(untouchedEditor, {}, () => {})
  assert.deepEqual(result.changed, [], `a preset that omits every option was rewritten: ${JSON.stringify(result.changed)}`)
  assert.deepEqual(result.skipped, ['preset-untouched'], 'the untouched preset must be reported as skipped')
  assert.equal(untouchedEditor.edits.length, 0, 'writing the code defaults changed a preset that already ran them')
})

await check('a stored legacy seed is still projected into a preset that omits the seeded keys', async () => {
  // Regression test for profiles installed before the mount patch stopped
  // seeding: their stored `0.5 / 0.15 / 2` must keep reaching the presets.
  const untouched = presetConfig({})
  const seededEditor = createEditor([{ id: 'preset-untouched', name: host.TARGET_PRESET_PLUGIN, config: untouched }])
  const result = await host.retune(seededEditor, LEGACY_SEED, () => {})
  assert.deepEqual(result.changed, ['preset-untouched'], 'the seeded keys must reach a preset that omits them')
  const child = host.findCompactionRow(seededEditor.edits[0].next).config
  assert.equal(child.thresholdRatio, 0.5, 'the seeded thresholdRatio was not projected')
  assert.equal(child.retainRatio, 0.15, 'the seeded retainRatio was not projected')
  assert.equal(child.compactionRetries, 2, 'the seeded compactionRetries was not projected')
})

/* ══ 5. apply(): the three triggers and the fiber read ═════════════════════ */

/** Await the debounced pass, which `schedule()` arms through `setTimeout(..., 0)`. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 10) })

/** Preset rows that all already carry the legacy mount-time tune, so the mount pass is a no-op. */
function applyRows() {
  const tune = { thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2 }
  const minimal = presetConfig({ ...tune })
  minimal.plugins[1].config[0].id = 'compact'
  return [
    { id: 'preset-standard', name: host.TARGET_PRESET_PLUGIN, config: presetConfig({ ...tune }) },
    { id: 'preset-minimal', name: host.TARGET_PRESET_PLUGIN, config: minimal },
  ]
}

/** Sentinel for a service read that throws instead of resolving. */
const EDITOR_THROWS = Symbol('editor-throws')

/**
 * Mount the host half on a fake ctx carrying the three trigger seams, the
 * settings-suppression seam, and the candidate editors the walk resolves.
 * @param config - the object `apply` captures (the row's mount config).
 * @param fiber - the row's fiber double, or undefined to exercise the fallback.
 * @param editorSpec - one editor shared by both service reads, or
 *   `{property, lookup}` to give the guarded property read and the guarded
 *   service lookup DIFFERENT candidates (`EDITOR_THROWS` makes that read throw).
 * @returns the editor, the recorded effects and warnings, and the drivers.
 */
function mountApply(config, fiber, editorSpec = createEditor(applyRows())) {
  const spec = editorSpec !== null && typeof editorSpec === 'object' && ('property' in editorSpec || 'lookup' in editorSpec)
    ? editorSpec
    : { property: editorSpec, lookup: editorSpec }
  const handlers = new Map()
  const effects = []
  const configureCalls = []
  const warnings = []
  const ctx = {
    fiber,
    get configEditor() {
      if (spec.property === EDITOR_THROWS) throw new Error('configEditor is not injected')
      return spec.property
    },
    logger: { warn: message => warnings.push(message) },
    get: name => {
      if (name !== 'configEditor') return undefined
      if (spec.lookup === EDITOR_THROWS) throw new Error('configEditor lookup failed')
      return spec.lookup
    },
    on(event, handler) {
      const list = handlers.get(event)
      if (list === undefined) handlers.set(event, [handler])
      else list.push(handler)
    },
    effect(callback, label) {
      effects.push({ label, disposer: callback() })
      return () => {}
    },
    inject(services, callback) {
      callback({
        effect: (cb, label) => { effects.push({ label, disposer: cb() }); return () => {} },
        settings: {
          configure: (options, fiberRef) => { configureCalls.push({ options, fiberRef }); return () => {} },
        },
      })
    },
  }
  host.apply(ctx, config)
  return {
    editor: spec.property === EDITOR_THROWS ? spec.lookup : spec.property,
    effects,
    configureCalls,
    warnings,
    emit: (event, ...payload) => { for (const handler of handlers.get(event) ?? []) handler(...payload) },
    events: () => [...handlers.keys()].sort(),
    dispose: label => {
      const entry = effects.find(candidate => candidate.label === label)
      if (entry !== undefined && typeof entry.disposer === 'function') entry.disposer()
    },
  }
}

/** The tune the settings row mounts with, and the tune a live save commits. */
const CAPTURED = { thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2 }
const SAVED = { thresholdRatio: 0.62, retainRatio: 0.21, compactionRetries: 4 }

await check('apply wires all three trigger seams and suppresses the generated form with the row fiber', () => {
  const fiber = { config: { ...CAPTURED } }
  const ui = mountApply({ ...CAPTURED }, fiber)
  assert.deepEqual(
    ui.events(),
    ['app-boot/config-reload', 'loader/entry-init', 'loader/volatile-update'],
    `apply subscribed to ${JSON.stringify(ui.events())}, not the three frozen seams`,
  )
  assert.equal(ui.configureCalls.length, 1, `settings.configure was called ${ui.configureCalls.length} times`)
  assert.deepEqual(JSON.parse(JSON.stringify(ui.configureCalls[0].options)), { auto: false }, 'the auto-generated form was not suppressed')
  assert.equal(ui.configureCalls[0].fiberRef, fiber, 'settings.configure must receive the row fiber')
})

await check('an app-boot/config-reload emit tunes from ctx.fiber.config, not the stale object apply captured', async () => {
  const fiber = { config: { ...CAPTURED } }
  const ui = mountApply({ ...CAPTURED }, fiber)
  await settle()
  assert.equal(ui.editor.edits.length, 0, `the mount-time pass wrote ${ui.editor.edits.length} edit(s); the rows already carried the captured tune`)
  // The Settings save lands in the row's own resolved config; the object `apply`
  // captured is left stale. This is the shipped regression: without the reload
  // seam nothing schedules, and reading the captured object would skip anyway.
  fiber.config = { ...SAVED }
  ui.emit('app-boot/config-reload')
  await settle()
  assert.ok(ui.editor.edits.length > 0, 'the config-reload emit scheduled no write: the reload trigger seam is missing')
  for (const edit of ui.editor.edits) {
    const child = host.findCompactionRow(edit.next)
    assert.equal(child.config.thresholdRatio, SAVED.thresholdRatio, `${edit.id}: read thresholdRatio ${String(child.config.thresholdRatio)} from the stale captured object instead of the fiber value ${String(SAVED.thresholdRatio)}`)
    assert.equal(child.config.retainRatio, SAVED.retainRatio, `${edit.id}: read retainRatio ${String(child.config.retainRatio)} instead of the fiber value`)
    assert.equal(child.config.compactionRetries, SAVED.compactionRetries, `${edit.id}: read compactionRetries ${String(child.config.compactionRetries)} instead of the fiber value`)
  }
})

await check('loader/volatile-update still schedules a pass that reads the fiber values', async () => {
  const fiber = { config: { ...CAPTURED } }
  const ui = mountApply({ ...CAPTURED }, fiber)
  await settle()
  fiber.config = { ...SAVED }
  ui.emit('loader/volatile-update')
  await settle()
  assert.ok(ui.editor.edits.length > 0, 'the volatile-update emit scheduled no write')
  const child = host.findCompactionRow(ui.editor.edits[0].next)
  assert.equal(child.config.thresholdRatio, SAVED.thresholdRatio, `the volatile-update pass read ${String(child.config.thresholdRatio)}, not the fiber value`)
})

await check('a repeated reload emit performs no further write (compare-and-skip holds live)', async () => {
  const fiber = { config: { ...CAPTURED } }
  const ui = mountApply({ ...CAPTURED }, fiber)
  await settle()
  fiber.config = { ...SAVED }
  ui.emit('app-boot/config-reload')
  await settle()
  const afterFirst = ui.editor.edits.length
  assert.ok(afterFirst > 0, 'the first reload emit wrote nothing')
  ui.emit('app-boot/config-reload')
  ui.emit('app-boot/config-reload')
  await settle()
  assert.equal(ui.editor.edits.length, afterFirst, `repeated reload emits added ${ui.editor.edits.length - afterFirst} edit(s)`)
})

await check('disposal clears the pending pass before it runs', async () => {
  const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } })
  ui.dispose('compaction-tuner: retune pass')
  await settle()
  assert.equal(ui.editor.edits.length, 0, `a disposed plugin still ran ${ui.editor.edits.length} pass write(s)`)
})

await check('apply falls back to its captured config when ctx.fiber is absent', async () => {
  const ui = mountApply({ ...SAVED }, undefined)
  await settle()
  assert.ok(ui.editor.edits.length > 0, 'apply with no fiber wrote nothing')
  const child = host.findCompactionRow(ui.editor.edits[0].next)
  assert.equal(child.config.thresholdRatio, SAVED.thresholdRatio, `the no-fiber fallback read ${String(child.config.thresholdRatio)} instead of the captured value`)
})

await check('apply still tunes in a host that cannot resolve schemastery (Config === undefined)', () => {
  const pluginUrl = pathToFileURL(join(here, 'index.js')).href
  // Build the fixture as data so the injected literal can never drift out of
  // balance the way a hand-written nested JSON string can.
  const childRows = [{
    entry: {
      options: {
        id: 'preset-standard',
        name: host.TARGET_PRESET_PLUGIN,
        config: { plugins: [{ id: host.COMPACTION_ROW_ID, name: host.COMPACTION_PLUGIN, config: { ...CAPTURED } }] },
      },
    },
  }]
  const script = [
    `const host = await import(${JSON.stringify(pluginUrl)})`,
    `const rows = ${JSON.stringify(childRows)}`,
    `let edits = 0`,
    `let last = null`,
    `const editor = { configuration: () => rows, async edit(entry, change) { edits += 1; last = change(entry.options.config, undefined) } }`,
    `const fiber = { config: ${JSON.stringify(SAVED)} }`,
    `const ctx = { fiber, configEditor: editor, get: n => (n === 'configEditor' ? editor : undefined), on: () => {}, effect: () => () => {}, inject: (_services, callback) => callback({ effect: () => () => {}, settings: { configure: () => () => {} } }) }`,
    `host.apply(ctx, ${JSON.stringify(CAPTURED)})`,
    `await new Promise(resolve => setTimeout(resolve, 30))`,
    `const child = last === null ? {} : last.plugins[0].config`,
    `process.stdout.write(JSON.stringify({ config: typeof host.Config, library: typeof host.schemaLibrary, edits, threshold: child.thresholdRatio }))`,
  ].join('\n')
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: tmpdir(),
    env: { ...process.env, DSH_HARNESS_CHECKOUT: '' },
    encoding: 'utf8',
  })
  const result = JSON.parse(stdout)
  assert.equal(result.config, 'undefined', `Config was ${String(result.config)} in the child process; the no-library path was not exercised`)
  assert.equal(result.library, 'undefined', `schemaLibrary was ${String(result.library)} in the child process`)
  assert.equal(result.edits, 1, `apply performed ${result.edits} edit(s) with Config undefined`)
  assert.equal(result.threshold, SAVED.thresholdRatio, `the no-library pass read ${String(result.threshold)} instead of the fiber value`)
})

/* ══ 6. client half ════════════════════════════════════════════════════════ */

await check('apply registers one settings.section entry with the frozen id, a label thunk, and the locale NS', () => {
  const options = clientContext.state.registered[0]?.options
  assert.equal(clientContext.state.injections[0], 'settings.section', `slots.inject was called with ${String(clientContext.state.injections[0])}`)
  assert.equal(options?.name, 'settings.section', `the slot name drifted to ${String(options?.name)}`)
  assert.equal(options?.id, 'compaction-tuner', `the section id drifted to ${String(options?.id)}`)
  assert.equal(typeof options?.label, 'function', 'the section label must be a thunk: a plain string would not follow the locale revision')
  assert.ok((options?.label() ?? '').length > 0, 'the nav label renders empty')
  assert.equal(options?.locale, 'compaction-tuner', `the locale NS drifted to ${String(options?.locale)}`)
  assert.equal(clientContext.state.effects.length, 1, `apply registered ${clientContext.state.effects.length} effects, expected 1`)
  assert.equal(clientContext.state.effects[0], '@local/dsh-compaction-tuner: dictionaries', `the effect label drifted to ${String(clientContext.state.effects[0])}`)
})

await check('apply registers one dictionary under the entry id carrying both en and zh', () => {
  const record = clientContext.state.dictionaries[0]
  assert.equal(clientContext.state.dictionaries.length, 1, `apply registered ${clientContext.state.dictionaries.length} dictionaries`)
  assert.equal(record?.ns, 'compaction-tuner', `the dictionary NS drifted to ${String(record?.ns)}`)
  const en = record?.dictionary?.en
  const zh = record?.dictionary?.zh
  assert.equal(typeof en, 'object', 'the dictionary is missing its en table')
  assert.equal(typeof zh, 'object', 'the dictionary is missing its zh table')
  for (const key of Object.keys(en)) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh is missing the key "${key}"`)
  }
  for (const key of [
    'nav', 'title', 'intro', 'note.defaults',
    'action.resetDefaults', 'note.resetDefaults',
    'perModel.heading', 'perModel.description', 'perModel.provider', 'perModel.model',
    'perModel.add', 'perModel.remove', 'perModel.none', 'perModel.loading',
    'perModel.unavailable', 'perModel.error', 'perModel.empty', 'perModel.outOfCatalog',
    'action.save', 'action.saving', 'status.loading', 'status.unavailable', 'status.readOnly', 'status.saved',
    'error.refused', 'error.retainOrder', 'error.thresholdRange', 'error.retainRange', 'error.compactionRetries',
    'error.modelPoliciesCap',
    'error.headroomTokens', 'error.retainTokens', 'error.retentionExclusive', 'error.maxTokens',
    'error.maxTokensResolved', 'error.overflowRetries', 'error.summarizationPair', 'error.modelPoliciesJson',
    'error.modelPolicies',
  ]) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en is missing the key "${key}"`)
  }
})

await check('the en and zh dictionaries agree, and no English copy carries CJK text', () => {
  const record = clientContext.state.dictionaries[0]
  const en = record.dictionary.en
  const zh = record.dictionary.zh
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'the en and zh dictionaries do not carry identical key sets')
  // The exact bug this check exists for: a translated sentence pasted into the
  // English table renders on the English Settings page.
  const cjk = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/
  for (const [key, value] of Object.entries(en)) {
    assert.ok(!cjk.test(value), `the English dictionary value for "${key}" contains CJK text: ${value}`)
  }
  assert.ok(
    en['field.modelPolicies.description'].includes('Leave the table empty'),
    'the en modelPolicies copy lost the empty-table rule',
  )
  assert.ok(
    cjk.test(zh['field.modelPolicies.description']) && zh['field.modelPolicies.description'].includes('\u7559\u7a7a'),
    `the zh modelPolicies copy does not carry the empty-table translation: ${zh['field.modelPolicies.description']}`,
  )
})

await check('the nav label re-resolves through the locale face instead of freezing one string', () => {
  const options = clientContext.state.registered[0].options
  const english = options.label()
  clientContext.state.language = 'zh'
  const chinese = options.label()
  clientContext.state.language = 'en'
  assert.notEqual(chinese, english, 'the label did not re-resolve through the locale face')
  assert.equal(english, clientContext.state.dictionaries[0].dictionary.en.nav, 'the nav label is not the dictionary nav string')
})

await check('the section injects the shared config form and its translator', () => {
  const face = clientContext.state.registered[0].options.inject()
  assert.equal(face?.form, clientContext.form, 'the injected face must expose the configForms.get() form')
  assert.equal(typeof face?.t, 'function', 'the injected face must expose a translator')
  assert.deepEqual(clientContext.state.formRequests, ['compaction-tuner'], `configForms.get() was called as ${JSON.stringify(clientContext.state.formRequests)}`)
})

await check('the dictionary carries the code default and the allowed range for every owned key', () => {
  const en = clientContext.state.dictionaries[0].dictionary.en
  const zh = clientContext.state.dictionaries[0].dictionary.zh
  for (const option of host.TUNE_OPTIONS) {
    for (const suffix of ['label', 'description', 'unit', 'default']) {
      const key = `field.${option.key}.${suffix}`
      assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en is missing "${key}"`)
      assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh is missing "${key}"`)
    }
    assert.ok(
      en[`field.${option.key}.default`].includes(option.defaultText),
      `the en default copy for ${option.key} does not name the host defaultText "${option.defaultText}": ${en[`field.${option.key}.default`]}`,
    )
    // zh is translated, so only the literals of the default text have to survive
    // it; the numbers/booleans/array are what could drift.
    for (const literal of option.defaultText.match(/\d+(?:\.\d+)?|true|false|\[\]|''/g) ?? []) {
      assert.ok(
        zh[`field.${option.key}.default`].includes(literal),
        `the zh default copy for ${option.key} is missing the literal ${literal}: ${zh[`field.${option.key}.default`]}`,
      )
    }
    // The unit copy carries the core allowed range; the trailing parenthetical of
    // the metadata is a UI detail, so only the leading range clause is compared.
    // The modelPolicies entry schema is long, so its unit is a one-line summary.
    if (option.kind === 'modelPolicies') {
      assert.ok(/array/i.test(en[`field.${option.key}.unit`]), `the en unit for ${option.key} must say it is an array: ${en[`field.${option.key}.unit`]}`)
    } else {
      const coreRange = option.range.split(';')[0].replace(/\s*\(.*\)$/, '')
      assert.ok(
        en[`field.${option.key}.unit`].includes(coreRange),
        `the en range copy for ${option.key} does not match the host range "${option.range}": ${en[`field.${option.key}.unit`]}`,
      )
    }
  }
  // There is no install-seed note any more: the bundle seeds nothing. The page
  // states that the code defaults are what a fresh install runs.
  assert.ok(en['note.defaults'].includes('code default'), 'the page must state that each field shows the upstream code default')
  assert.ok(en['note.seed'] === undefined && zh['note.seed'] === undefined, 'the removed install-seed note is still in the dictionary')
})

await check('a ready snapshot renders one labelled control per owned option, in TUNE_KEYS order', async () => {
  const ui = mountSection(readySnapshot(7))
  await ui.settle()
  const en = clientContext.state.dictionaries[0].dictionary.en
  const labels = findAll(ui.tree(), node => node.type === 'label' && node.props?.className === 'dct-field-label')
  assert.equal(labels.length, TUNE_ORDER.length, `expected ${TUNE_ORDER.length} top-level field labels, rendered ${labels.length}`)
  labels.forEach((label, index) => {
    const key = TUNE_ORDER[index]
    assert.equal(directText(label), en[`field.${key}.label`], `field ${index} is not the ${key} field`)
    assert.ok(typeof label.props.htmlFor === 'string' && label.props.htmlFor.length > 0, `the ${key} label has no htmlFor`)
    if (key === 'modelPolicies') {
      // The composite editor is one labelled group, not a single control.
      const group = findAll(ui.tree(), node => node.props?.id === label.props.htmlFor)[0]
      assert.equal(group?.props?.className, 'dct-permodel', 'the modelPolicies label does not point at the per-model editor')
      return
    }
    const control = findAll(ui.tree(), node => node.type === 'input' && node.props.id === label.props.htmlFor)[0]
    assert.ok(control !== undefined, `no <input> carries the id the ${key} label points at`)
    assert.equal(control.props.disabled, false, `a writable ready snapshot must not disable the ${key} control`)
  })
  // Seeding: the stored legacy seed for the three keys it seeded (a profile
  // installed before the mount patch stopped seeding still holds them), the code
  // defaults for the materialized ones, and blank for the three deliberately
  // unset ones.
  assert.equal(controlOf(ui, 'thresholdRatio').props.value, '0.5', 'thresholdRatio did not seed from the snapshot')
  assert.equal(controlOf(ui, 'headroomTokens').props.value, '65536', 'headroomTokens did not seed from the snapshot')
  assert.equal(controlOf(ui, 'retainRatio').props.value, '0.15', 'retainRatio did not seed from the snapshot')
  assert.equal(controlOf(ui, 'retainTokens').props.value, '', 'an unset retainTokens must render blank')
  assert.equal(controlOf(ui, 'summarizationProvider').props.value, '', 'summarizationProvider did not seed from the snapshot')
  assert.equal(controlOf(ui, 'summarizationModel').props.value, '', 'summarizationModel did not seed from the snapshot')
  assert.equal(controlOf(ui, 'maxTokens').props.value, '', 'an unset maxTokens must render blank')
  assert.equal(controlOf(ui, 'compactionRetries').props.value, '2', 'compactionRetries did not seed from the snapshot')
  assert.equal(controlOf(ui, 'maxOverflowRetries').props.value, '1', 'maxOverflowRetries did not seed from the snapshot')
  assert.equal(controlOf(ui, 'auto').props.checked, true, 'auto did not seed from the snapshot')
  assert.equal(controlOf(ui, 'auto').props.type, 'checkbox', 'auto must render as a checkbox')
  // The stored table is empty, so the editor renders the empty-table note and
  // the picker, with no override card.
  assert.equal(perModelEntries(ui).length, 0, 'an empty stored table must render no override card')
  assert.equal(perModelEditor(ui) !== undefined, true, 'the modelPolicies field is not the per-model editor')
  assert.equal(perModelSelect(ui, 'provider') !== undefined, true, 'the catalog picker did not render a provider select')
  assert.equal(ui.saveButton().props.disabled, true, 'Save must be disabled while the draft equals the snapshot')
  assert.equal(renderedText(ui.tree()).includes('«missing:'), false, `the page rendered a missing dictionary key: ${renderedText(ui.tree())}`)
})

await check('a fresh install (no stored row values) renders the code defaults and keeps the unset keys unset', async () => {
  // What the page shows right after installing with the seedless mount patch:
  // the tuner row carries no config, so the snapshot holds only the keys the
  // schemastery root materializes. `retainRatio` and its two companions still
  // mean "unset upstream"; `retainRatio` alone has a concrete effective default,
  // so its empty input displays that default as a placeholder.
  const fresh = {
    thresholdRatio: 0.8,
    headroomTokens: 65_536,
    summarizationProvider: '',
    summarizationModel: '',
    compactionRetries: 1,
    maxOverflowRetries: 1,
    modelPolicies: [],
    auto: true,
  }
  const ui = mountSection(readySnapshot(1, fresh))
  assert.equal(controlOf(ui, 'thresholdRatio').props.value, '0.8', 'thresholdRatio did not render the code default')
  assert.equal(controlOf(ui, 'headroomTokens').props.value, '65536', 'headroomTokens did not render the code default')
  assert.equal(controlOf(ui, 'retainRatio').props.value, '', 'an unset retainRatio must render blank')
  assert.equal(controlOf(ui, 'retainRatio').props.placeholder, '0.16', 'the blank retainRatio must display its effective code default')
  assert.equal(controlOf(ui, 'retainTokens').props.value, '', 'an unset retainTokens must render blank')
  assert.equal(controlOf(ui, 'retainTokens').props.placeholder, undefined, 'retainTokens has no concrete effective default to display')
  assert.equal(controlOf(ui, 'maxTokens').props.value, '', 'an unset maxTokens must render blank')
  assert.equal(controlOf(ui, 'maxTokens').props.placeholder, undefined, 'maxTokens has no concrete effective default to display')
  assert.equal(controlOf(ui, 'compactionRetries').props.value, '1', 'compactionRetries did not render the code default')
  assert.equal(ui.saveButton().props.disabled, true, 'a fresh install has nothing dirty to save')
  // Editing one field must NOT materialize the blank retention keys: they stay
  // `unset` ops, which is what keeps the retention XOR expressible.
  setField(ui, 'thresholdRatio', '0.9')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the fresh-install draft was not writable')
  const ops = Object.fromEntries(JSON.parse(JSON.stringify(ui.form.writes[0].ops)).map(op => [op.path[0], op]))
  assert.deepEqual(ops.retainRatio, { op: 'unset', path: ['retainRatio'] }, 'an untouched blank retainRatio must stay unset')
  assert.deepEqual(ops.retainTokens, { op: 'unset', path: ['retainTokens'] }, 'an untouched blank retainTokens must stay unset')
  assert.deepEqual(ops.maxTokens, { op: 'unset', path: ['maxTokens'] }, 'an untouched blank maxTokens must stay unset')
})

await check('useSyncExternalStore gets one stable useCallback-wrapped bound pair, not bare methods', () => {
  const ui = mountSection(readySnapshot(7))
  const bare = ui.form.subscribe
  assert.throws(() => bare(() => {}), TypeError, 'the form double must prove the controller methods need their receiver')
  setField(ui, 'retainRatio', '0.1')
  const calls = ui.subscribeCalls()
  assert.ok(calls.length >= 2, `expected a re-render to add a uSES call, saw ${calls.length}`)
  assert.notEqual(calls[0].subscribe, BoundForm.prototype.subscribe, 'uSES was handed the bare prototype method')
  assert.notEqual(calls[0].getSnapshot, BoundForm.prototype.getSnapshot, 'uSES was handed the bare prototype method')
  assert.ok(calls.every(call => call.subscribe === calls[0].subscribe), 'the subscribe identity changed between renders, forcing a resubscribe')
  assert.ok(calls.every(call => call.getSnapshot === calls[0].getSnapshot), 'the getSnapshot identity changed between renders')
})

await check('a valid draft issues exactly ONE mutate with one op per option and the snapshot revision', async () => {
  const ui = mountSection(readySnapshot(7))
  setField(ui, 'retainRatio', '0.1')
  assert.equal(ui.saveButton().props.disabled, false, 'Save must enable once the draft differs from the snapshot')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, `expected exactly one mutate call, got ${ui.form.writes.length}`)
  const write = ui.form.writes[0]
  // The ops come from the vm realm, so compare normalized JSON rather than
  // across two Object prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(write.ops)), [
    { op: 'set', path: ['thresholdRatio'], value: 0.5 },
    { op: 'set', path: ['headroomTokens'], value: 65_536 },
    { op: 'set', path: ['retainRatio'], value: 0.1 },
    { op: 'unset', path: ['retainTokens'] },
    { op: 'set', path: ['summarizationProvider'], value: '' },
    { op: 'set', path: ['summarizationModel'], value: '' },
    { op: 'unset', path: ['maxTokens'] },
    { op: 'set', path: ['compactionRetries'], value: 2 },
    { op: 'set', path: ['maxOverflowRetries'], value: 1 },
    { op: 'unset', path: ['modelPolicies'] },
    { op: 'set', path: ['auto'], value: true },
  ], `the atomic write ops drifted: ${JSON.stringify(write.ops)}`)
  assert.equal(write.revision, 7, `the mutate revision is ${String(write.revision)}, expected the snapshot revision 7`)
  // Option (ii): the separate post-save confirmation is gone, so the standing
  // restart-required notice below the Save button is the post-save message.
  assert.ok(renderedText(ui.tree()).includes(clientContext.state.dictionaries[0].dictionary.en['restart.note']), `the post-save restart notice is not rendered: ${renderedText(ui.tree())}`)
  assert.equal(findAll(ui.tree(), node => node.props?.className === 'dct-saved').length, 0, 'the removed post-save confirmation line is rendered again')
  assert.equal(ui.alerts().length, 0, `a clean save rendered ${ui.alerts().length} error alert(s)`)
})

await check('the token retention form clears the ratio, and a blank optional field is an unset op', async () => {
  const ui = mountSection(readySnapshot(7))
  setField(ui, 'retainRatio', '')
  setField(ui, 'retainTokens', '4096')
  setField(ui, 'maxTokens', '2048')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the token-form draft was not writable')
  const ops = JSON.parse(JSON.stringify(ui.form.writes[0].ops))
  const byPath = Object.fromEntries(ops.map(op => [op.path[0], op]))
  assert.deepEqual(byPath.retainRatio, { op: 'unset', path: ['retainRatio'] }, 'the ratio side of the retention pair must be unset')
  assert.deepEqual(byPath.retainTokens, { op: 'set', path: ['retainTokens'], value: 4096 }, 'the token side of the retention pair must be set')
  assert.deepEqual(byPath.maxTokens, { op: 'set', path: ['maxTokens'], value: 2048 }, 'an explicit maxTokens must be set, not derived')
})

await check('a valid per-model override is submitted as one modelPolicies array op', async () => {
  const ui = mountSection(readySnapshot(7))
  await ui.settle()
  // Add the catalog's first provider/model and fill one policy box: the box
  // holds raw text, so the op proves the save path normalized it to a number.
  perModelAdd(ui).props.onClick()
  assert.equal(perModelEntries(ui).length, 1, 'the Add action did not create an override card')
  setPolicyBox(ui, 0, 'thresholdRatio', '0.4')
  assert.equal(ui.saveButton().props.disabled, false, 'a filled override must make the draft dirty')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'a valid modelPolicies table was refused locally')
  const op = JSON.parse(JSON.stringify(ui.form.writes[0].ops)).find(candidate => candidate.path[0] === 'modelPolicies')
  assert.deepEqual(
    op,
    { op: 'set', path: ['modelPolicies'], value: [{ provider: 'openai', model: 'gpt-5', thresholdRatio: 0.4 }] },
    `the modelPolicies op drifted: ${JSON.stringify(op)}`,
  )
  // An `auto: false` toggle must ride the same atomic write as a boolean.
  const ui2 = mountSection(readySnapshot(7))
  setField(ui2, 'auto', 'false')
  await clickSave(ui2)
  const autoOp = JSON.parse(JSON.stringify(ui2.form.writes[0].ops)).find(candidate => candidate.path[0] === 'auto')
  assert.deepEqual(autoOp, { op: 'set', path: ['auto'], value: false }, `the auto toggle op drifted: ${JSON.stringify(autoOp)}`)
})

await check('every client-side cross-field refusal mirrors the Host rule, and NO mutate is sent', async () => {
  const en = clientContext.state.dictionaries[0].dictionary.en
  const cases = [
    ['retainRatio at or above the threshold', { retainRatio: '0.9' }, 'error.retainOrder'],
    ['retainRatio outside (0, 1]', { retainRatio: '1.5' }, 'error.retainRange'],
    ['both retention forms', { retainRatio: '0.15', retainTokens: '1000' }, 'error.retentionExclusive'],
    ['retainTokens fractional', { retainTokens: '1.5' }, 'error.retainTokens'],
    ['headroomTokens fractional', { headroomTokens: '1.5' }, 'error.headroomTokens'],
    ['headroomTokens 0 with no maxTokens', { headroomTokens: '0' }, 'error.maxTokensResolved'],
    ['maxTokens 0', { maxTokens: '0' }, 'error.maxTokens'],
    ['compactionRetries fractional', { compactionRetries: '1.5' }, 'error.compactionRetries'],
    ['maxOverflowRetries negative', { maxOverflowRetries: '-1' }, 'error.overflowRetries'],
    ['summary provider without its model', { summarizationProvider: 'openai' }, 'error.summarizationPair'],
    ['thresholdRatio 1.2', { thresholdRatio: '1.2' }, 'error.thresholdRange'],
    ['headroomTokens unsafe integer', { headroomTokens: '9007199254740993' }, 'error.headroomTokens'],
    ['headroomTokens exponent overflow', { headroomTokens: '1e21' }, 'error.headroomTokens'],
    ['headroomTokens hexadecimal', { headroomTokens: '0x10' }, 'error.headroomTokens'],
    ['compactionRetries hexadecimal', { compactionRetries: '0x2' }, 'error.compactionRetries'],
    ['retainTokens unsafe integer', { retainTokens: '1e21' }, 'error.retainTokens'],
    ['maxTokens unsafe integer', { maxTokens: '9007199254740993' }, 'error.maxTokens'],
  ]
  for (const [label, fields, errorKey] of cases) {
    const ui = mountSection(readySnapshot(7))
    for (const [key, text] of Object.entries(fields)) setField(ui, key, text)
    await clickSave(ui)
    assert.equal(ui.form.writes.length, 0, `${label}: a locally invalid draft reached the Host: ${JSON.stringify(ui.form.writes)}`)
    const alerts = ui.alerts()
    assert.equal(alerts.length, 1, `${label}: expected one role="alert" node, got ${alerts.length}`)
    assert.equal(directText(alerts[0]), en[errorKey], `${label}: the refusal copy drifted: ${directText(alerts[0])}`)
  }
  // The per-model rules are reachable through the picker's own boxes and through
  // a stored table a direct `settings.mutate` could have written (the docs name
  // that bypass as possible). Each case fills a box or seeds a stored table,
  // makes the draft dirty through another field, and asserts the same refusal.
  const perModelCases = [
    ['per-model retainRatio at or above the threshold', { boxes: [['retainRatio', '0.9']] }, 'error.modelPolicies'],
    ['per-model retainRatio outside (0, 1]', { boxes: [['retainRatio', '1.5']] }, 'error.modelPolicies'],
    ['per-model both retention forms', { boxes: [['retainRatio', '0.1'], ['retainTokens', '100']] }, 'error.modelPolicies'],
    ['per-model retainTokens fractional', { boxes: [['retainTokens', '1.5']] }, 'error.modelPolicies'],
    ['per-model headroomTokens hexadecimal', { boxes: [['headroomTokens', '0x10']] }, 'error.modelPolicies'],
    ['per-model maxTokens 0', { boxes: [['maxTokens', '0']] }, 'error.modelPolicies'],
    ['per-model compactionRetries fractional', { boxes: [['compactionRetries', '1.5']] }, 'error.modelPolicies'],
    ['per-model summary provider without its model', { boxes: [['summarizationProvider', 'openai']] }, 'error.modelPolicies'],
    ['a stored table that is not an array', { snapshot: { modelPolicies: { provider: 'openai' } } }, 'error.modelPolicies'],
    ['a stored duplicate target', { snapshot: { modelPolicies: [{ provider: 'o', model: 'm', thresholdRatio: 0.2 }, { provider: 'o', model: 'm', thresholdRatio: 0.3 }] } }, 'error.modelPolicies'],
    ['a stored entry with a bogus key', { snapshot: { modelPolicies: [{ provider: 'o', model: 'm', thresholdRatio: 0.2, bogus: 1 }] } }, 'error.modelPolicies'],
    ['a stored entry with a zero resolved cap', { snapshot: { modelPolicies: [{ provider: 'o', model: 'm', headroomTokens: 0 }] } }, 'error.modelPoliciesCap'],
  ]
  for (const [label, spec, errorKey] of perModelCases) {
    const ui = mountSection(readySnapshot(7, storedValue(spec.snapshot ?? { modelPolicies: [{ provider: 'o', model: 'm' }] })))
    if (spec.boxes !== undefined) {
      await ui.settle()
      for (const [key, text] of spec.boxes) setPolicyBox(ui, 0, key, text)
    }
    // Make the draft dirty so Save is enabled; the invalid table is what must refuse.
    setField(ui, 'retainRatio', '0.1')
    await clickSave(ui)
    assert.equal(ui.form.writes.length, 0, `${label}: a locally invalid draft reached the Host: ${JSON.stringify(ui.form.writes)}`)
    const alerts = ui.alerts()
    assert.equal(alerts.length, 1, `${label}: expected one role="alert" node, got ${alerts.length}`)
    assert.equal(directText(alerts[0]), en[errorKey], `${label}: the refusal copy drifted: ${directText(alerts[0])}`)
  }
  // `error.modelPoliciesJson` is now UNREACHABLE from this page: the composite
  // editor always emits JSON.stringify output, so malformed JSON cannot be
  // typed. The key and the parse guard are kept as defence in depth (a future
  // raw path or a Host-side caller), and both dictionaries must still carry it.
  assert.ok(en['error.modelPoliciesJson'].length > 0, 'the retained defensive parse-failure copy is missing')
})

await check('the client mirrors the entry-cap rule and the unmanaged-table note', async () => {
  const en = clientContext.state.dictionaries[0].dictionary.en
  // The same entry is accepted once an explicit top-level cap exists, exactly
  // like upstream's per-entry resolution.
  const accepted = mountSection(readySnapshot(7, storedValue({ modelPolicies: [{ provider: 'o', model: 'm', headroomTokens: 0 }] })))
  setField(accepted, 'maxTokens', '4096')
  await clickSave(accepted)
  assert.equal(accepted.form.writes.length, 1, 'an explicit top-level cap must make the zero-headroom entry writable')
  const acceptedOp = JSON.parse(JSON.stringify(accepted.form.writes[0].ops)).find(candidate => candidate.path[0] === 'modelPolicies')
  assert.deepEqual(acceptedOp, { op: 'set', path: ['modelPolicies'], value: [{ provider: 'o', model: 'm', headroomTokens: 0 }] }, `the accepted per-model op drifted: ${JSON.stringify(acceptedOp)}`)
  // An empty table renders the "your presets keep their own table" note and is
  // submitted as `unset`, so the row never carries an explicit empty table.
  const empty = mountSection(readySnapshot(7))
  assert.ok(renderedText(empty.tree()).includes(en['note.modelPolicies']), 'the unmanaged-table note is not rendered while the table is empty')
  setField(empty, 'retainRatio', '0.1')
  await clickSave(empty)
  const policiesOp = JSON.parse(JSON.stringify(empty.form.writes[0].ops)).find(op => op.path[0] === 'modelPolicies')
  assert.deepEqual(policiesOp, { op: 'unset', path: ['modelPolicies'] }, `an empty table must be submitted as unset: ${JSON.stringify(policiesOp)}`)
  // A non-empty table must NOT show the note.
  const managed = mountSection(readySnapshot(7, storedValue({ modelPolicies: [{ provider: 'o', model: 'm' }] })))
  assert.equal(renderedText(managed.tree()).includes(en['note.modelPolicies']), false, 'the unmanaged-table note must not render for a non-empty table')
})

await check('the per-model picker prevents duplicates, drops all-empty entries, and preserves an out-of-catalog override', async () => {
  const en = clientContext.state.dictionaries[0].dictionary.en
  // Duplicate prevention: once the selected pair has an override, Add disables.
  const ui = mountSection(readySnapshot(7))
  await ui.settle()
  assert.equal(perModelAdd(ui).props.disabled, false, 'Add must be enabled for a pair with no override')
  perModelAdd(ui).props.onClick()
  assert.equal(perModelEntries(ui).length, 1, 'the Add action did not create the override')
  assert.equal(perModelAdd(ui).props.disabled, true, 'Add must disable for a pair that already has an override')
  assert.equal(perModelBox(ui, 0, 'thresholdRatio') !== undefined, true, 'the new override rendered none of its nine boxes')
  // Removing the only override returns the table to `unset` on the next save.
  perModelRemove(ui, 0).props.onClick()
  assert.equal(perModelEntries(ui).length, 0, 'the remove action did not delete the override')
  setField(ui, 'retainRatio', '0.1')
  await clickSave(ui)
  const removedOp = JSON.parse(JSON.stringify(ui.form.writes[0].ops)).find(candidate => candidate.path[0] === 'modelPolicies')
  assert.deepEqual(removedOp, { op: 'unset', path: ['modelPolicies'] }, `removing the last override must submit unset: ${JSON.stringify(removedOp)}`)
  // An override whose nine boxes are all empty is dropped on save (the Lead's
  // product decision), and the page copy states that rule.
  const emptyDraft = mountSection(readySnapshot(7))
  await emptyDraft.settle()
  perModelAdd(emptyDraft).props.onClick()
  assert.ok(renderedText(emptyDraft.tree()).includes(en['perModel.description']), 'the page does not state the all-empty-entry rule')
  setField(emptyDraft, 'retainRatio', '0.1')
  await clickSave(emptyDraft)
  const emptyOp = JSON.parse(JSON.stringify(emptyDraft.form.writes[0].ops)).find(candidate => candidate.path[0] === 'modelPolicies')
  assert.deepEqual(emptyOp, { op: 'unset', path: ['modelPolicies'] }, `an all-empty entry must be dropped, leaving unset: ${JSON.stringify(emptyOp)}`)
  // An out-of-catalog saved override stays listed (marked), removable, and
  // survives a save driven by another field.
  const ghost = mountSection(readySnapshot(7, storedValue({ modelPolicies: [{ provider: 'ghost', model: 'phantom', thresholdRatio: 0.4 }] })))
  await ghost.settle()
  assert.equal(perModelEntries(ghost).length, 1, 'an out-of-catalog override was not listed')
  assert.ok(renderedText(ghost.tree()).includes(en['perModel.outOfCatalog']), 'an out-of-catalog override is not marked as such')
  setField(ghost, 'retainRatio', '0.1')
  await clickSave(ghost)
  const ghostOp = JSON.parse(JSON.stringify(ghost.form.writes[0].ops)).find(candidate => candidate.path[0] === 'modelPolicies')
  assert.deepEqual(
    ghostOp,
    { op: 'set', path: ['modelPolicies'], value: [{ provider: 'ghost', model: 'phantom', thresholdRatio: 0.4 }] },
    `an out-of-catalog override was dropped or rewritten: ${JSON.stringify(ghostOp)}`,
  )
})

await check('the Reset action blanks every managed key and one Save unsets all eleven', async () => {
  const en = clientContext.state.dictionaries[0].dictionary.en
  // The fallbacks the cross-field checks use in reset mode must equal the host
  // code defaults, or a reset draft could be refused by a stale constant.
  const thresholdLiteral = /const DEFAULT_THRESHOLD_RATIO = ([0-9.]+);/.exec(clientSource)
  const headroomLiteral = /const DEFAULT_HEADROOM_TOKENS = ([\d_]+);/.exec(clientSource)
  assert.ok(thresholdLiteral !== null && headroomLiteral !== null, 'the client reset fallbacks are not declared')
  assert.equal(Number(thresholdLiteral[1]), host.DEFAULT_TUNE.thresholdRatio, 'the client threshold fallback drifted from the host default')
  assert.equal(Number(headroomLiteral[1].replace(/_/g, '')), host.DEFAULT_TUNE.headroomTokens, 'the client headroom fallback drifted from the host default')

  const ui = mountSection(readySnapshot(7, storedValue({
    thresholdRatio: 0.5,
    retainRatio: 0.15,
    compactionRetries: 2,
    modelPolicies: [{ provider: 'o', model: 'm', thresholdRatio: 0.4 }],
  })))
  await ui.settle()
  const reset = resetButton(ui)
  assert.ok(reset !== undefined, 'the Reset action is not rendered')
  assert.equal(reset.props.disabled, false, 'Reset must be enabled on a writable page')
  assert.equal(ui.saveButton().props.disabled, true, 'the pristine page must have Save disabled')
  assert.ok(renderedText(ui.tree()).includes(en['note.resetDefaults']), 'the reset explanation is not rendered')
  reset.props.onClick()
  // It writes nothing, and it blanks the whole draft including the cards.
  assert.equal(ui.form.writes.length, 0, `Reset performed a write: ${JSON.stringify(ui.form.writes)}`)
  for (const key of TUNE_ORDER) {
    if (key === 'modelPolicies') continue
    if (key === 'auto') {
      assert.equal(controlOf(ui, key).props.checked, false, 'Reset left the auto box checked')
      continue
    }
    assert.equal(controlOf(ui, key).props.value, '', `Reset left ${key} non-blank`)
  }
  assert.equal(perModelEntries(ui).length, 0, 'Reset left per-model cards behind')
  assert.ok(renderedText(ui.tree()).includes(en['note.modelPolicies']), 'the cleared table does not render the unmanaged note')
  assert.equal(ui.saveButton().props.disabled, false, 'Reset must make the draft dirty')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the reset draft must be one atomic write')
  assert.deepEqual(
    JSON.parse(JSON.stringify(ui.form.writes[0].ops)),
    TUNE_ORDER.map(key => ({ op: 'unset', path: [key] })),
    `the reset op list drifted: ${JSON.stringify(ui.form.writes[0].ops)}`,
  )
  assert.equal(ui.form.writes[0].revision, 7, 'the reset write must carry the snapshot revision')
  // The mode is spent once the write lands: the pristine draft disables Save.
  assert.equal(ui.saveButton().props.disabled, true, 'a completed reset must leave Save disabled again')
})

await check('a snapshot change drops the Reset mode, so a later Save is a normal write', async () => {
  // `resetMode` is scoped to the seedKey it was pressed on. This check exists
  // because nothing else pinned that scoping: without it a recovery read would
  // leave the stale reset in force and turn a normal Save into an all-unset
  // write (and blank fields into unsets they should not be).
  const ui = mountSection(readySnapshot(7, storedValue({ thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2 })))
  await ui.settle()
  resetButton(ui).props.onClick()
  assert.equal(controlOf(ui, 'thresholdRatio').props.value, '', 'Reset did not blank the draft')
  // The controller's recovery read lands a different snapshot: different
  // revision and value, so a different seedKey.
  ui.form.push(readySnapshot(8, storedValue({ thresholdRatio: 0.9, retainRatio: 0.3, compactionRetries: 4 })))
  assert.equal(controlOf(ui, 'thresholdRatio').props.value, '0.9', 'the reset draft survived a snapshot change: the mode is not scoped to its snapshot')
  assert.equal(controlOf(ui, 'retainRatio').props.value, '0.3', 'the retained tail did not re-seed from the recovery snapshot')
  // Make the draft dirty again, then Save: this must be a NORMAL write.
  setField(ui, 'headroomTokens', '32768')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the post-recovery draft was not writable')
  const ops = Object.fromEntries(JSON.parse(JSON.stringify(ui.form.writes[0].ops)).map(op => [op.path[0], op]))
  assert.deepEqual(ops.thresholdRatio, { op: 'set', path: ['thresholdRatio'], value: 0.9 }, 'the recovery value was not submitted as a set')
  assert.deepEqual(ops.headroomTokens, { op: 'set', path: ['headroomTokens'], value: 32_768 }, 'the edited headroom was not submitted as a set')
  // The blank-string fields are the discriminator: a stale reset mode turns an
  // empty provider/model into `unset`, while a normal save sets the empty pair.
  assert.deepEqual(ops.summarizationProvider, { op: 'set', path: ['summarizationProvider'], value: '' }, 'a stale reset mode turned the summary provider into an unset')
  assert.deepEqual(ops.summarizationModel, { op: 'set', path: ['summarizationModel'], value: '' }, 'a stale reset mode turned the summary model into an unset')
  assert.notDeepEqual(
    Object.values(ops).filter(op => op.op === 'unset').map(op => op.path[0]),
    TUNE_ORDER,
    'the stale reset emitted the all-unset op list after the snapshot changed',
  )
})

await check('a cleared tuner row re-tunes a preset child that still holds the legacy seed', async () => {
  // The Reset action's whole point: once the tuner row stores nothing, the
  // retune pass must move a preset child still holding 0.5 / 0.15 / 2 onto the
  // code defaults. The complementary no-write and legacy-seed checks stay green.
  const stale = presetConfig({ thresholdRatio: 0.5, retainRatio: 0.15, compactionRetries: 2 })
  const editor = createEditor([{ id: 'preset-stale', name: host.TARGET_PRESET_PLUGIN, config: stale }])
  const result = await host.retune(editor, {}, () => {})
  assert.deepEqual(result.changed, ['preset-stale'], `a cleared tuner row did not rewrite the stale preset child: ${JSON.stringify(result)}`)
  const child = host.findCompactionRow(editor.edits[0].next).config
  assert.equal(child.thresholdRatio, host.DEFAULT_TUNE.thresholdRatio, 'the retune did not restore the default thresholdRatio')
  assert.equal(child.headroomTokens, host.DEFAULT_TUNE.headroomTokens, 'the retune did not restore the default headroomTokens')
  assert.equal(child.retainRatio, host.DEFAULT_TUNE.retainRatio, 'the retune did not restore the default retainRatio')
  assert.equal(child.maxTokens, host.DEFAULT_TUNE.headroomTokens, 'the retune did not derive maxTokens from the default headroom')
  assert.equal(child.compactionRetries, host.DEFAULT_TUNE.compactionRetries, 'the retune did not restore the default compactionRetries')
  assert.equal(child.maxOverflowRetries, host.DEFAULT_TUNE.maxOverflowRetries, 'the retune did not restore the default maxOverflowRetries')
  assert.equal(child.auto, host.DEFAULT_TUNE.auto, 'the retune did not restore the default auto')
  assert.equal(Object.hasOwn(child, 'retainTokens'), false, 'the retune left retainTokens beside retainRatio')
})

await check('a Host refusal (mutate false) surfaces error.refused, then the recovery snapshot re-seeds the inputs', async () => {
  const ui = mountSection(readySnapshot(7), { nextResult: false })
  setField(ui, 'retainRatio', '0.1')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the refused write was never attempted')
  const alerts = ui.alerts()
  assert.equal(alerts.length, 1, `expected one role="alert" node after a refusal, got ${alerts.length}`)
  assert.equal(directText(alerts[0]), clientContext.state.dictionaries[0].dictionary.en['error.refused'], `the refusal copy drifted: ${directText(alerts[0])}`)
  ui.form.push(readySnapshot(8, storedValue({ thresholdRatio: 0.9, retainRatio: 0.3, compactionRetries: 4 })))
  assert.equal(controlOf(ui, 'thresholdRatio').props.value, '0.9', 'the threshold did not re-seed from the recovery snapshot')
  assert.equal(controlOf(ui, 'retainRatio').props.value, '0.3', 'the retained tail did not re-seed from the recovery snapshot')
  assert.equal(controlOf(ui, 'compactionRetries').props.value, '4', 'the retries did not re-seed from the recovery snapshot')
  assert.equal(controlOf(ui, 'headroomTokens').props.value, '65536', 'the headroom did not re-seed from the recovery snapshot')
})

await check('a locally-valid but sub-step ratio passes the page and surfaces the Host refusal', async () => {
  const ui = mountSection(readySnapshot(7), { nextResult: false })
  setField(ui, 'retainRatio', '0.005')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the page refused 0.005 locally; the host schema step(0.01) is the intended guard')
  const ratioOp = ui.form.writes[0].ops.find(op => op.path[0] === 'retainRatio')
  assert.equal(ratioOp.value, 0.005, `the submitted retainRatio drifted to ${String(ratioOp.value)}`)
  assert.equal(directText(ui.alerts()[0]), clientContext.state.dictionaries[0].dictionary.en['error.refused'], 'the Host refusal was not surfaced for a sub-step ratio')
})

await check('a non-writable snapshot disables every control and Save and writes nothing', async () => {
  const snapshot = readySnapshot(7)
  snapshot.writable = false
  const ui = mountSection(snapshot)
  await ui.settle()
  const editable = findAll(ui.tree(), node => node.type === 'input' || node.type === 'select' || node.type === 'textarea')
  assert.ok(editable.length >= TUNE_ORDER.length - 1, `a read-only page rendered only ${editable.length} controls`)
  for (const control of editable) assert.equal(control.props.disabled, true, 'a read-only snapshot must disable its controls')
  assert.equal(ui.saveButton().props.disabled, true, 'a read-only snapshot must disable Save')
  assert.equal(resetButton(ui)?.props.disabled, true, 'a read-only snapshot must disable Reset')
  setField(ui, 'retainRatio', '0.1')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 0, 'a read-only snapshot performed a write')
  assert.ok(renderedText(ui.tree()).includes(clientContext.state.dictionaries[0].dictionary.en['status.readOnly']), 'the read-only note is not rendered')
})

await check('an unavailable namespace renders its note, disables the controls, and never writes', async () => {
  const ui = mountSection({ status: 'unavailable', value: undefined, revision: 0, writable: false })
  await ui.settle()
  assert.ok(renderedText(ui.tree()).includes(clientContext.state.dictionaries[0].dictionary.en['status.unavailable']), 'the unavailable note is not rendered')
  const inputs = findAll(ui.tree(), node => node.type === 'input')
  assert.equal(inputs.length, TUNE_ORDER.length - 1, `the unavailable page should still render its ${TUNE_ORDER.length - 1} disabled scalar controls`)
  for (const control of findAll(ui.tree(), node => node.type === 'input' || node.type === 'select')) {
    assert.equal(control.props.disabled, true, 'an unavailable namespace must disable its controls')
  }
  setField(ui, 'retainRatio', '0.1')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 0, 'an unavailable namespace performed a write')
  assert.equal(resetButton(ui)?.props.disabled, true, 'an unavailable namespace must disable Reset')
})

await check('no rendered copy is missing from the dictionary in any state', async () => {
  const loading = mountSection({ status: 'loading', revision: 0 })
  const unavailable = mountSection({ status: 'unavailable', revision: 0 })
  const ready = mountSection(readySnapshot(7))
  const invalid = mountSection(readySnapshot(7))
  const refused = mountSection(readySnapshot(7), { nextResult: false })
  setField(invalid, 'retainRatio', '0.9')
  await clickSave(invalid)
  setField(refused, 'retainRatio', '0.1')
  await clickSave(refused)
  for (const [label, ui] of [['loading', loading], ['unavailable', unavailable], ['ready', ready], ['invalid', invalid], ['refused', refused]]) {
    const text = renderedText(ui.tree())
    assert.equal(text.includes('«missing:'), false, `${label}: rendered a missing dictionary key in ${text}`)
  }
})

/* ══ 7. the empty-pass retry ═══════════════════════════════════════════════ */

/**
 * Install a fake clock so the backoff is asserted rather than slept through,
 * and so the exact scheduled delays can be read back.
 * @returns the clock plus its pending-timer and cleared-id recorders.
 */
function installClock() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realNow = Date.now
  const timers = new Map()
  const cleared = new Set()
  const delays = []
  let nextId = 1
  let now = realNow()
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextId
    nextId += 1
    timers.set(id, { id, delay, callback })
    delays.push(delay)
    return id
  }
  globalThis.clearTimeout = id => { cleared.add(id); timers.delete(id) }
  // The recovery budget is measured with `Date.now()`, so the clock has to move
  // with the timers or a bounded poll would spin against real time.
  Date.now = () => now
  const ordered = () => [...timers.values()].sort((left, right) => left.id - right.id)
  const fire = async next => {
    timers.delete(next.id)
    now += next.delay
    next.callback()
    await drain()
  }
  return {
    delays,
    cleared,
    pending: ordered,
    pendingDelays: () => ordered().map(timer => timer.delay),
    retryDelays: () => delays.filter(delay => delay !== 0),
    // Run the oldest pending timer, then let any async work it started settle.
    async runOldest() {
      const next = ordered()[0]
      if (next === undefined) return false
      await fire(next)
      return true
    },
    /** Fire pending timers until none are left, so a bounded poll can expire. */
    async runUntilIdle(maxSteps = 400) {
      for (let step = 0; step < maxSteps; step += 1) {
        const next = ordered()[0]
        if (next === undefined) return step
        await fire(next)
      }
      return maxSteps
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      Date.now = realNow
    },
  }
}

/** Let every queued microtask and the async passes draining them finish. */
async function drain() {
  for (let round = 0; round < 8; round += 1) await new Promise(resolve => setImmediate(resolve))
}

/**
 * An editor double whose addressable rows can be withheld and released.
 * @param initialEmpty - whether `configuration()` answers with no rows at first.
 */
function switchableEditor(initialEmpty) {
  const inner = createEditor(applyRows())
  let empty = initialEmpty
  let calls = 0
  return {
    edits: inner.edits,
    calls: () => calls,
    setEmpty: value => { empty = value },
    configuration() {
      calls += 1
      return empty ? [] : inner.configuration()
    },
    async edit(entry, change) { return inner.edit(entry, change) },
  }
}

await check('RETUNE_BACKOFF is the frozen four-step schedule the retry is built from', () => {
  assert.ok('RETUNE_BACKOFF' in host, 'index.js does not export RETUNE_BACKOFF')
  assert.deepEqual([...host.RETUNE_BACKOFF], [250, 1000, 3000, 10000], `RETUNE_BACKOFF drifted: ${JSON.stringify([...host.RETUNE_BACKOFF])}`)
  assert.equal(Object.isFrozen(host.RETUNE_BACKOFF), true, 'RETUNE_BACKOFF must be frozen')
})

await check('a retry writes once when the preset rows appear on the second look', async () => {
  const clock = installClock()
  try {
    const editor = switchableEditor(true)
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, editor)
    ui.emit('app-boot/config-reload')
    await clock.runOldest()
    assert.equal(editor.edits.length, 0, `the empty pass already wrote ${editor.edits.length} edit(s)`)
    assert.deepEqual(clock.pendingDelays(), [host.RETUNE_BACKOFF[0]], `the retry was armed at ${JSON.stringify(clock.pendingDelays())}, not ${host.RETUNE_BACKOFF[0]}`)
    editor.setEmpty(false)
    await clock.runOldest()
    assert.equal(clock.retryDelays()[0], host.RETUNE_BACKOFF[0], `the first retry delay was ${String(clock.retryDelays()[0])}`)
    assert.ok(editor.edits.length > 0, 'the retry performed no write after the rows appeared')
    for (const edit of editor.edits) {
      const child = host.findCompactionRow(edit.next)
      assert.equal(child.config.thresholdRatio, SAVED.thresholdRatio, `${edit.id}: the retry wrote ${String(child.config.thresholdRatio)}, not the fiber value`)
    }
    assert.deepEqual(clock.pendingDelays(), [], `a timer survived the successful retry: ${JSON.stringify(clock.pendingDelays())}`)
  } finally { clock.restore() }
})

await check('with no addressable rows ever, the retry stops after every backoff entry with ONE warning and no write', async () => {
  const clock = installClock()
  try {
    const editor = switchableEditor(true)
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, editor)
    ui.emit('app-boot/config-reload')
    await clock.runOldest()
    for (let step = 0; step < host.RETUNE_BACKOFF.length; step += 1) await clock.runOldest()
    assert.equal(editor.edits.length, 0, `a retry wrote ${editor.edits.length} edit(s) with no rows addressable`)
    assert.deepEqual(clock.retryDelays(), [...host.RETUNE_BACKOFF], `scheduled retry delays drifted: ${JSON.stringify(clock.retryDelays())}`)
    assert.deepEqual(clock.pendingDelays(), [], `a retry is still armed after the last attempt: ${JSON.stringify(clock.pendingDelays())}`)
    const exhausted = ui.warnings.filter(message => message.includes('no agent-preset row was addressable'))
    assert.equal(exhausted.length, 1, `expected exactly one exhaustion warning, got ${JSON.stringify(ui.warnings)}`)
    assert.match(exhausted[0], new RegExp(`after ${host.RETUNE_BACKOFF.length} retries`), `the exhaustion warning drifted: ${exhausted[0]}`)
  } finally { clock.restore() }
})

await check('the retry counter resets after a pass that does real work', async () => {
  const clock = installClock()
  try {
    const editor = switchableEditor(true)
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, editor)
    await clock.runOldest()
    assert.deepEqual(clock.retryDelays(), [host.RETUNE_BACKOFF[0]], `the first retry was not step one: ${JSON.stringify(clock.retryDelays())}`)
    editor.setEmpty(false)
    await clock.runOldest()
    assert.ok(editor.edits.length > 0, 'the retry did not write, so nothing reset the counter')
    editor.setEmpty(true)
    ui.emit('app-boot/config-reload')
    await clock.runOldest()
    assert.deepEqual(
      clock.retryDelays(),
      [host.RETUNE_BACKOFF[0], host.RETUNE_BACKOFF[0]],
      `the sequence did not restart from the top after real work: ${JSON.stringify(clock.retryDelays())}`,
    )
  } finally { clock.restore() }
})

await check('a fresh trigger cancels a pending retry and restarts the sequence', async () => {
  const clock = installClock()
  try {
    const editor = switchableEditor(true)
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, editor)
    await clock.runOldest()
    const pending = clock.pending()
    assert.equal(pending.length, 1, `expected one pending retry, got ${JSON.stringify(clock.pendingDelays())}`)
    ui.emit('app-boot/config-reload')
    assert.ok(clock.cleared.has(pending[0].id), 'the fresh trigger did not clear the pending retry timer')
    assert.deepEqual(clock.pendingDelays(), [0], `the fresh trigger armed ${JSON.stringify(clock.pendingDelays())}, not one debounce pass`)
    await clock.runOldest()
    assert.deepEqual(
      clock.retryDelays(),
      [host.RETUNE_BACKOFF[0], host.RETUNE_BACKOFF[0]],
      `the restarted sequence did not begin at ${host.RETUNE_BACKOFF[0]}: ${JSON.stringify(clock.retryDelays())}`,
    )
  } finally { clock.restore() }
})

await check('disposal clears the pending debounce timer and any pending retry', async () => {
  const clock = installClock()
  try {
    const retryCase = switchableEditor(true)
    const uiRetry = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, retryCase)
    await clock.runOldest()
    const retryPending = clock.pending()
    assert.equal(retryPending.length, 1, `no retry was armed to dispose: ${JSON.stringify(clock.pendingDelays())}`)
    uiRetry.dispose('compaction-tuner: retune pass')
    assert.ok(clock.cleared.has(retryPending[0].id), 'disposal did not clear the pending retry timer')
    assert.deepEqual(clock.pendingDelays(), [], `a timer survived disposal: ${JSON.stringify(clock.pendingDelays())}`)
    const debounceCase = switchableEditor(true)
    const uiDebounce = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, debounceCase)
    const debouncePending = clock.pending()
    assert.equal(debouncePending.length, 1, `no debounce timer was armed to dispose: ${JSON.stringify(clock.pendingDelays())}`)
    uiDebounce.dispose('compaction-tuner: retune pass')
    assert.ok(clock.cleared.has(debouncePending[0].id), 'disposal did not clear the pending debounce timer')
    assert.deepEqual(clock.pendingDelays(), [], 'a timer survived the second disposal')
  } finally { clock.restore() }
})

await check('a trigger during an in-flight pass coalesces instead of starting a concurrent pass', async () => {
  const clock = installClock()
  try {
    const inner = createEditor(applyRows())
    let release
    const gate = new Promise(resolve => { release = resolve })
    let calls = 0
    let slow = false
    const editor = {
      edits: inner.edits,
      calls: () => calls,
      configuration() { calls += 1; return inner.configuration() },
      async edit(entry, change) {
        if (slow) await gate
        return inner.edit(entry, change)
      },
    }
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, editor)
    slow = true
    await clock.runOldest()
    assert.equal(calls, 1, `pass 1 called configuration() ${calls} times`)
    ui.emit('app-boot/config-reload')
    assert.equal(calls, 1, `a concurrent pass started: configuration() calls = ${calls}`)
    assert.deepEqual(clock.pendingDelays(), [], `the in-flight trigger armed a timer: ${JSON.stringify(clock.pendingDelays())}`)
    release()
    await drain()
    assert.equal(calls, 1, `the coalesced rerun ran concurrently: configuration() calls = ${calls}`)
    assert.deepEqual(clock.pendingDelays(), [0], `the coalesced rerun was not scheduled exactly once: ${JSON.stringify(clock.pendingDelays())}`)
    await clock.runOldest()
    assert.equal(calls, 2, `the coalesced pass never ran: configuration() calls = ${calls}`)
  } finally { clock.restore() }
})

/* ══ 8. the candidate-editor walk ══════════════════════════════════════════ */

await check('a blind first candidate falls through to a healthy one with one write and no retry', async () => {
  const clock = installClock()
  try {
    const blind = switchableEditor(true)
    const healthy = switchableEditor(false)
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, { property: blind, lookup: healthy })
    await clock.runOldest()
    assert.equal(blind.edits.length, 0, `the blind candidate wrote ${blind.edits.length} edit(s)`)
    assert.ok(healthy.edits.length > 0, 'the walk never reached the healthy candidate')
    assert.equal(clock.retryDelays().length, 0, `a retry was armed although a candidate found rows: ${JSON.stringify(clock.retryDelays())}`)
    assert.equal(clock.pendingDelays().length, 0, `a timer was left armed: ${JSON.stringify(clock.pendingDelays())}`)
    assert.equal(ui.warnings.filter(message => message.includes('no agent-preset row was addressable')).length, 0, `a spurious exhaustion warning was logged: ${JSON.stringify(ui.warnings)}`)
    for (const edit of healthy.edits) {
      const child = host.findCompactionRow(edit.next)
      assert.equal(child.config.thresholdRatio, SAVED.thresholdRatio, `${edit.id}: the healthy candidate wrote ${String(child.config.thresholdRatio)}`)
    }
  } finally { clock.restore() }
})

await check('when every candidate is blind the full backoff runs once with one warning and no write', async () => {
  const clock = installClock()
  try {
    const first = switchableEditor(true)
    const second = switchableEditor(true)
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, { property: first, lookup: second })
    await clock.runOldest()
    for (let step = 0; step < host.RETUNE_BACKOFF.length; step += 1) await clock.runOldest()
    assert.equal(first.edits.length + second.edits.length, 0, 'a blind candidate wrote')
    assert.deepEqual(clock.retryDelays(), [...host.RETUNE_BACKOFF], `the backoff drifted: ${JSON.stringify(clock.retryDelays())}`)
    assert.deepEqual(clock.pendingDelays(), [], `a retry is still armed: ${JSON.stringify(clock.pendingDelays())}`)
    const exhausted = ui.warnings.filter(message => message.includes('no agent-preset row was addressable'))
    assert.equal(exhausted.length, 1, `expected exactly one exhaustion warning across both candidates, got ${JSON.stringify(ui.warnings)}`)
  } finally { clock.restore() }
})

await check('a healthy first candidate stops the walk: the second is never consulted', async () => {
  const clock = installClock()
  try {
    const healthy = switchableEditor(false)
    const second = switchableEditor(false)
    mountApply({ ...CAPTURED }, { config: { ...SAVED } }, { property: healthy, lookup: second })
    await clock.runOldest()
    assert.ok(healthy.edits.length > 0, 'the first candidate was not written through')
    assert.equal(second.calls(), 0, `the second candidate was consulted ${second.calls()} time(s)`)
    assert.equal(second.edits.length, 0, 'the second candidate wrote')
  } finally { clock.restore() }
})

await check('when both service reads yield the same object the candidate is consulted once', async () => {
  const clock = installClock()
  try {
    const only = switchableEditor(false)
    mountApply({ ...CAPTURED }, { config: { ...SAVED } }, { property: only, lookup: only })
    await clock.runOldest()
    assert.equal(only.calls(), 1, `the shared candidate was consulted ${only.calls()} time(s), expected once`)
    assert.ok(only.edits.length > 0, 'the shared candidate was not written through')
  } finally { clock.restore() }
})

await check('a candidate whose configuration() throws is skipped and the next one is used', async () => {
  const clock = installClock()
  try {
    let throws = 0
    const throwing = {
      edits: [],
      configuration() {
        throws += 1
        throw new Error('editor boom')
      },
      async edit() { throw new Error('editor boom') },
    }
    const healthy = switchableEditor(false)
    const ui = mountApply({ ...CAPTURED }, { config: { ...SAVED } }, { property: throwing, lookup: healthy })
    await clock.runOldest()
    assert.equal(throws, 1, `the throwing candidate was consulted ${throws} time(s)`)
    assert.ok(healthy.edits.length > 0, 'the walk did not fall through to the healthy candidate after the throw')
    assert.equal(ui.warnings.filter(message => message.includes('the retune pass failed')).length, 0, `the throw escaped the walk: ${JSON.stringify(ui.warnings)}`)
    assert.equal(clock.retryDelays().length, 0, 'a retry was armed although a later candidate found rows')
  } finally { clock.restore() }
})

/* ══ 9. the restart notice, action, confirm and recovery ═══════════════════ */

/** A `/backend-restart` implementation whose `status` answers `restartable`. */
const statusCall = (restartable, restartReply = { ok: true }) => (channel, endpoint) => Promise.resolve(
  endpoint === 'status' ? { ok: true, value: { restartable } } : restartReply,
)

await check('the client injects the connection and remote services at runtime and still requests only react', () => {
  assert.ok(Array.isArray(clientPlugin.inject), 'the client plugin exposes no inject array')
  assert.ok(clientPlugin.inject.includes('connection'), `the runtime inject list is missing connection: ${JSON.stringify(clientPlugin.inject)}`)
  assert.ok(clientPlugin.inject.includes('remote'), `the runtime inject list is missing remote: ${JSON.stringify(clientPlugin.inject)}`)
  assert.deepEqual([...clientPlugin.inject].sort(), ['configForms', 'connection', 'locale', 'remote', 'slots'], `the runtime inject list drifted: ${JSON.stringify(clientPlugin.inject)}`)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'), 'the manifest client inject is missing @deepseek-ai/dsh-client-connection')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'), 'the manifest client inject is missing @deepseek-ai/dsh-api-remotes, which provides the remote namespaces')
  assert.deepEqual(requested, ['react'], `the factory requested ${JSON.stringify(requested)} from the module table`)
})

await check('the catalog is read at mount through the injected Remote service, retries a failure a bounded number of times, and its reply gates the picker', async () => {
  // A ready reply populates the provider/model selects from the catalog alone.
  const ready = mountSection(readySnapshot(7))
  await ready.settle()
  assert.ok(ready.ctx.state.catalogCalls >= 1, 'the mount effect never called session.modelCatalog()')
  const provider = perModelSelect(ready, 'provider')
  const model = perModelSelect(ready, 'model')
  assert.ok(provider !== undefined && model !== undefined, 'the ready catalog did not render the provider/model selects')
  assert.deepEqual(
    findAll(provider, node => node.type === 'option').map(option => option.props.value),
    ['openai', 'anthropic'],
    'the provider select is not the catalog provider list',
  )
  assert.deepEqual(
    findAll(model, node => node.type === 'option').map(option => option.props.value),
    ['gpt-5', 'gpt-5-mini'],
    'the model select is not the first provider group\'s model list',
  )
  // A refused reply renders the error note and no picker, and the page still works.
  const refused = mountSection(readySnapshot(7), { catalog: () => Promise.resolve({ ok: false, error: { message: 'nope' } }) })
  await refused.settle()
  assert.ok(renderedText(refused.tree()).includes(enCopy('perModel.error')), 'a refused catalog reply did not render its note')
  assert.equal(perModelSelect(refused, 'provider'), undefined, 'a refused catalog reply still rendered the picker')
  assert.equal(refused.saveButton().props.disabled, true, 'a refused catalog reply broke the rest of the page')
  // A throwing catalog read (transport rejection) renders the same error note.
  const throwing = mountSection(readySnapshot(7), { catalog: () => Promise.reject(new Error('transport')) })
  await throwing.settle()
  assert.ok(renderedText(throwing.tree()).includes(enCopy('perModel.error')), 'a rejected catalog read did not render its note')
  // A missing Remote service renders the unavailable note instead.
  const missing = mountSection(readySnapshot(7), { remoteUnavailable: true })
  await missing.settle()
  assert.ok(renderedText(missing.tree()).includes(enCopy('perModel.unavailable')), 'a missing Remote service did not render its note')
  assert.equal(missing.ctx.state.catalogCalls, 0, 'a missing Remote service still counted a catalog call')
  // A ready catalog with no routable provider renders the empty note and no picker.
  const empty = mountSection(readySnapshot(7), { catalog: () => Promise.resolve({ ok: true, value: { groups: [] } }) })
  await empty.settle()
  assert.ok(renderedText(empty.tree()).includes(enCopy('perModel.empty')), 'an empty catalog did not render its note')
  assert.equal(perModelSelect(empty, 'provider'), undefined, 'an empty catalog still rendered the picker')
  // A genuine failure is retried twice with backoff (1 + 2 calls at most), and
  // a later `connection/reset` re-reads the catalog, so a mount-time failure
  // cannot stick the way the one-shot read did.
  const clock = installClock()
  try {
    let attempts = 0
    const flaky = mountSection(readySnapshot(7), {
      catalog: () => {
        attempts += 1
        return attempts <= 3
          ? Promise.resolve({ ok: false, error: { code: 'session/catalog-refused', message: 'catalog boom' } })
          : CATALOG_OK()
      },
    })
    await flaky.settle()
    assert.equal(flaky.ctx.state.catalogCalls, 1, `the first attempt made ${flaky.ctx.state.catalogCalls} calls, expected 1`)
    assert.ok(renderedText(flaky.tree()).includes(enCopy('perModel.error')), 'a transient refusal did not render its note')
    assert.deepEqual(clock.pendingDelays(), [300], `the first backoff was ${JSON.stringify(clock.pendingDelays())}`)
    await clock.runOldest()
    assert.equal(flaky.ctx.state.catalogCalls, 2, 'the first retry did not run')
    assert.deepEqual(clock.pendingDelays(), [1200], `the second backoff was ${JSON.stringify(clock.pendingDelays())}`)
    await clock.runOldest()
    assert.equal(flaky.ctx.state.catalogCalls, 3, 'the second retry did not run')
    assert.deepEqual(clock.pendingDelays(), [], 'the retry was not bounded to 1 + two calls')
    await clock.runOldest()
    assert.equal(flaky.ctx.state.catalogCalls, 3, 'a retry ran beyond the bound')
    assert.ok(renderedText(flaky.tree()).includes(enCopy('perModel.error')), 'an exhausted retry lost the load-error note')
    flaky.ctx.emit('connection/reset')
    await flaky.settle()
    assert.equal(flaky.ctx.state.catalogCalls, 4, 'a connection reset did not re-read the catalog')
    assert.equal(renderedText(flaky.tree()).includes(enCopy('perModel.error')), false, 'the recovered page still shows the load-error note')
    assert.ok(perModelSelect(flaky, 'provider') !== undefined, 'the recovered catalog did not render the picker')
  } finally { clock.restore() }
})

// Regression seat for the shipped "per-model picker cannot list models" bug:
// `readCatalog()` read `ctx.get('remote').session`, but the plugin never
// injected `remote.session`, so cordis' proxy threw and the picker stayed on
// its load-error note. The fake now throws on `.session` exactly like the real
// proxy, so this check fails for any reader that does not ask the context for
// the dotted service key.
await check('the catalog is read through the dotted remote.session service key, never off the injected remote namespace object', async () => {
  const ready = mountSection(readySnapshot(7))
  assert.notEqual(ready.ctx.state.remoteSession, undefined, 'the fixture does not seed the nested remote.session service')
  assert.throws(
    () => ready.ctx.state.remote.session,
    /cannot get property "remote\.session" without inject/,
    'the remote double no longer throws on `.session` the way the cordis proxy does',
  )
  await ready.settle()
  assert.ok(
    ready.serviceReads().includes('remote.session'),
    `the catalog was not read via ctx.get('remote.session'); service keys requested: ${JSON.stringify(ready.serviceReads())}`,
  )
  assert.ok(ready.ctx.state.catalogCalls >= 1, 'the mount effect never called session.modelCatalog() through the dotted key')
  const provider = perModelSelect(ready, 'provider')
  const model = perModelSelect(ready, 'model')
  assert.ok(provider !== undefined && model !== undefined, 'a healthy remote.session catalog did not render the provider/model selects')
  assert.deepEqual(
    findAll(provider, node => node.type === 'option').map(option => option.props.value),
    ['openai', 'anthropic'],
    'the provider select is not the catalog provider list',
  )
  assert.deepEqual(
    findAll(model, node => node.type === 'option').map(option => option.props.value),
    ['gpt-5', 'gpt-5-mini'],
    'the model select is not the first provider group\'s model list',
  )
  assert.equal(renderedText(ready.tree()).includes(enCopy('perModel.error')), false, 'the picker kept its load-error note although remote.session answered')
  assert.equal(renderedText(ready.tree()).includes(enCopy('perModel.unavailable')), false, 'the picker kept its unavailable note although remote.session is present')
})

await check('the restart-required notice is a real <strong> in the ready, unavailable and loading states', async () => {
  const states = [
    ['ready', mountSection(readySnapshot(7))],
    ['unavailable', mountSection({ status: 'unavailable', revision: 0, writable: false })],
    ['loading', mountSection({ status: 'loading', revision: 0 })],
  ]
  for (const [label, ui] of states) {
    await ui.settle()
    const strong = findAll(ui.tree(), node => node.type === 'strong')
    assert.equal(strong.length, 1, `${label}: expected exactly one <strong> note, rendered ${strong.length}`)
    assert.equal(directText(strong[0]), enCopy('restart.note'), `${label}: the bold note copy drifted: ${directText(strong[0])}`)
  }
})

await check('the restart action renders enabled when the probe reports restartable', async () => {
  const ui = mountSection(readySnapshot(7), { call: statusCall(true) })
  await ui.settle()
  const action = ui.restartButton()
  assert.ok(action !== undefined, 'the restart action is not rendered')
  assert.equal(action.props.disabled, false, 'the restart action is disabled although the backend is restartable')
  assert.equal(action.props.type, 'button', 'the restart action is not a plain button')
})

await check('the action degrades to the manual copy on restartable:false and after a rejecting probe retries', async () => {
  const clock = installClock()
  try {
    const manual = mountSection(readySnapshot(7), { call: statusCall(false) })
    await manual.settle()
    assert.equal(manual.restartButton().props.disabled, true, 'restartable:false must disable the action')
    assert.ok(renderedText(manual.tree()).includes(enCopy('restart.manual')), 'the manual copy is not rendered')

    let attempts = 0
    const rejecting = mountSection(readySnapshot(7), { call: () => { attempts += 1; return Promise.reject(new Error('no channel')) } })
    await rejecting.settle()
    await clock.runUntilIdle()
    await rejecting.settle()
    assert.equal(attempts, 3, `the probe attempted ${attempts} time(s), expected the three bounded attempts`)
    assert.equal(rejecting.restartButton().props.disabled, true, 'a rejected probe must leave the action disabled')
    assert.ok(renderedText(rejecting.tree()).includes(enCopy('restart.manual')), 'the manual copy is missing after a rejected probe')
    assert.equal(rejecting.reloads(), 0, 'a rejected probe reloaded the page')
  } finally { clock.restore() }
})

await check('the inline confirm is not a native dialog: Cancel calls nothing and Confirm calls /backend-restart once', async () => {
  const clock = installClock()
  try {
    const ui = mountSection(readySnapshot(7), { call: statusCall(true) })
    await ui.settle()
    const statusCalls = ui.calls().length
    assert.equal(statusCalls, 1, `expected one status probe, got ${statusCalls}`)
    ui.restartButton().props.onClick()
    assert.ok(renderedText(ui.tree()).includes(enCopy('restart.confirm')), 'activating the action did not show the confirm copy')
    assert.ok(ui.cancelButton() !== undefined, 'the Cancel action is not rendered')
    assert.ok(ui.confirmButton() !== undefined, 'the Confirm action is not rendered')
    ui.cancelButton().props.onClick()
    assert.equal(ui.calls().length, statusCalls, `Cancel issued ${ui.calls().length - statusCalls} channel call(s)`)
    assert.equal(ui.restartButton().props.disabled, false, 'Cancel did not return the action to the ready state')
    ui.restartButton().props.onClick()
    ui.confirmButton().props.onClick()
    await ui.settle()
    const restarts = ui.calls().filter(entry => entry.endpoint === 'restart')
    assert.equal(restarts.length, 1, `Confirm issued ${restarts.length} restart call(s)`)
    assert.equal(restarts[0].channel, '/backend-restart', `the restart went to ${String(restarts[0].channel)}`)
    assert.equal(ui.calls().filter(entry => entry.endpoint === 'status').length, 1, 'Confirm re-probed status')
  } finally { clock.restore() }
})

await check('an ok:true reply enters recovery and a reject-then-resolve poll reloads the page', async () => {
  const clock = installClock()
  try {
    let fetches = 0
    const ui = mountSection(readySnapshot(7), {
      call: statusCall(true),
      fetch: () => {
        fetches += 1
        return fetches === 1 ? Promise.reject(new Error('the old listener is gone')) : Promise.resolve({ ok: true })
      },
    })
    await ui.settle()
    ui.restartButton().props.onClick()
    ui.confirmButton().props.onClick()
    await ui.settle()
    assert.ok(renderedText(ui.tree()).includes(enCopy('restart.restarting')), 'the restarting copy is not rendered')
    assert.equal(ui.reloads(), 1, `location.reload was called ${ui.reloads()} time(s), expected once`)
    assert.equal(ui.fetchCalls() >= 2, true, `the recovery probed the root ${ui.fetchCalls()} time(s)`)
  } finally { clock.restore() }
})

await check('a transport rejection also enters recovery, because the process may exit before replying', async () => {
  const clock = installClock()
  try {
    let fetches = 0
    const ui = mountSection(readySnapshot(7), {
      call: (channel, endpoint) => (endpoint === 'status'
        ? Promise.resolve({ ok: true, value: { restartable: true } })
        : Promise.reject(new Error('the transport died with the process'))),
      fetch: () => {
        fetches += 1
        return fetches === 1 ? Promise.reject(new Error('gone')) : Promise.resolve({ ok: true })
      },
    })
    await ui.settle()
    ui.restartButton().props.onClick()
    ui.confirmButton().props.onClick()
    await ui.settle()
    assert.ok(renderedText(ui.tree()).includes(enCopy('restart.restarting')), 'a transport rejection did not enter the restarting state')
    assert.equal(ui.reloads(), 1, `location.reload was called ${ui.reloads()} time(s) after a transport rejection`)
  } finally { clock.restore() }
})

await check('a timed-out recovery shows the manual reload affordance instead of a dead page', async () => {
  const clock = installClock()
  try {
    const ui = mountSection(readySnapshot(7), {
      call: statusCall(true),
      fetch: () => Promise.resolve({ ok: true }),
    })
    await ui.settle()
    ui.restartButton().props.onClick()
    ui.confirmButton().props.onClick()
    await ui.settle()
    await clock.runUntilIdle(400)
    await ui.settle()
    assert.ok(renderedText(ui.tree()).includes(enCopy('restart.timeout')), `the timeout copy is not rendered; visible copy starts: ${renderedText(ui.tree()).slice(0, 160)}`)
    assert.ok(ui.reloadButton() !== undefined, 'the manual reload affordance is missing')
    assert.equal(ui.reloads(), 0, 'the page reloaded even though the successor never answered')
    const strong = findAll(ui.tree(), node => node.type === 'strong')
    assert.equal(directText(strong[0]), enCopy('restart.note'), 'the bold note vanished in the timeout state')
  } finally { clock.restore() }
})

await check('unmounting the section aborts the recovery poll', async () => {
  const clock = installClock()
  try {
    const ui = mountSection(readySnapshot(7), { call: statusCall(true), fetch: () => Promise.resolve({ ok: true }) })
    await ui.settle()
    ui.restartButton().props.onClick()
    ui.confirmButton().props.onClick()
    await ui.settle()
    const before = ui.fetchCalls()
    assert.ok(before >= 1, 'the recovery poll never started')
    ui.unmount()
    await clock.runUntilIdle(400)
    await ui.settle()
    assert.equal(ui.reloads(), 0, 'the aborted poll reloaded the page')
    assert.equal(ui.fetchCalls(), before, `the aborted poll kept probing (${ui.fetchCalls() - before} extra call(s))`)
  } finally { clock.restore() }
})

await check('a refusal maps to localized copy with no diagnostic text and no recovery poll', async () => {
  const ui = mountSection(readySnapshot(7), {
    call: statusCall(true, { ok: false, error: { code: 'backend-restart/busy', message: 'DIAGNOSTIC-ONLY-9f2' } }),
  })
  await ui.settle()
  ui.restartButton().props.onClick()
  ui.confirmButton().props.onClick()
  await ui.settle()
  const text = renderedText(ui.tree())
  assert.ok(text.includes(enCopy('restart.error.busy')), `the busy copy is not rendered: ${text}`)
  assert.equal(text.includes('DIAGNOSTIC-ONLY-9f2'), false, 'the diagnostic message leaked into the UI')
  assert.equal(ui.fetchCalls(), 0, `a refusal started a recovery poll (${ui.fetchCalls()} probe(s))`)
  assert.equal(ui.reloads(), 0, 'a refusal reloaded the page')
  assert.equal(ui.restartButton().props.disabled, false, 'the refusal did not re-enable the action')
})

await check('an unknown refusal code falls back to the generic localized copy', async () => {
  const ui = mountSection(readySnapshot(7), {
    call: statusCall(true, { ok: false, error: { code: 'backend-restart/never-heard-of-it', message: 'DIAGNOSTIC-ONLY-77' } }),
  })
  await ui.settle()
  ui.restartButton().props.onClick()
  ui.confirmButton().props.onClick()
  await ui.settle()
  const text = renderedText(ui.tree())
  assert.ok(text.includes(enCopy('restart.error.generic')), `the generic copy is not rendered: ${text}`)
  assert.equal(text.includes('DIAGNOSTIC-ONLY-77'), false, 'the unknown code leaked its diagnostic message')
})

/* ══ summary ═══════════════════════════════════════════════════════════════ */

const passed = checks - failures.length
process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${skips.length} skipped (${checks} checks)\n`)
if (failures.length > 0) {
  process.stdout.write(`failed checks:\n${failures.map(failure => `  - ${failure.label}: ${failure.message}`).join('\n')}\n`)
  process.exitCode = 1
}
