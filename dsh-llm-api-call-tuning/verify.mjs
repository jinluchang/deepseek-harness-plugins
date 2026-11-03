/**
 * Self-check for the out-of-tree bundle `dsh-llm-api-call-tuning`.
 *
 * It is hermetic: no network, no server, no filesystem writes, and no DSH
 * instance. Every check runs against the plugin's own files plus the REAL
 * `@deepseek-ai/schemastery` and the upstream `retry-policy.ts` resolved
 * through `$DSH_HARNESS_CHECKOUT`, so a schema or constant regression cannot
 * hide behind a stand-in. If either cannot be resolved this file FAILS loudly
 * instead of skipping: a silent skip here would green-light a `Config` that
 * renders no settings section, or defaults that no longer match upstream.
 *
 * Run:
 *   DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs
 *
 * What it does NOT cover: the live mechanism against a booted Host (a real
 * settings save, the real nav row, next-request latency, or a live model call
 * whose headers/body actually time out under the installed dispatcher) is a
 * deployment property, not this file. The dispatcher side effect is exercised
 * against a recording fake dispatcher and the Host's real `undici` globals;
 * the client half is evaluated in `node:vm` with a minimal React double that
 * pins the element tree and the exact write shapes, not a real browser render.
 * The missing-`undici` degradation runs in a child process, because the host
 * half caches its resolution for the lifetime of the module.
 *
 * The manual same-turn retry is exercised entirely in memory: the
 * `agent/request-error` listener against synthetic waterfall payloads, the
 * plugin-owned decision route against fake `node:http` req/res objects, and the
 * dock against a fake session store plus fake timers. No live Host, browser,
 * turn, or socket is involved.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
 * @param {() => unknown} body - assertions to run (may be async).
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
 * `useState`, `useCallback`, `useEffect`, and `useSyncExternalStore` to drive
 * the settings page and its provider rows as trees of host elements.
 * @returns the stub React object plus its mount helper.
 */
function createReactStub() {
  let current = null
  let idSeed = 0
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
      if (typeof inst.render === 'function') inst.render()
    }
    return [inst.hooks[slot], setState]
  }
  const useSyncExternalStore = (subscribe, getSnapshot) => {
    const [inst, slot] = slotOf()
    inst.store = { subscribe, getSnapshot }
    return getSnapshot()
  }
  const useEffect = (effect, deps) => {
    const [inst, slot] = slotOf()
    inst.effects.set(slot, { effect, deps })
  }
  const commitStore = inst => {
    const wanted = inst.store
    if (wanted === undefined) return
    if (inst.active !== undefined && inst.active.subscribe === wanted.subscribe) {
      inst.active.getSnapshot = wanted.getSnapshot
      return
    }
    if (inst.active !== undefined) inst.active.unsubscribe()
    const active = { subscribe: wanted.subscribe, getSnapshot: wanted.getSnapshot, unsubscribe: () => {} }
    const unsubscribe = wanted.subscribe(() => { if (typeof inst.render === 'function') inst.render() })
    active.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : () => {}
    inst.active = active
  }
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
  const mount = (component, props) => {
    const inst = {
      component, props, hooks: [], hookIndex: 0, tree: null, store: undefined,
      effects: new Map(), effectState: new Map(), active: undefined,
    }
    const render = () => {
      if (inst.rendering === true) { inst.pending = true; return }
      inst.rendering = true
      try {
        inst.hookIndex = 0
        inst.effects = new Map()
        current = inst
        try { inst.tree = inst.component(inst.props) } finally { current = null }
        commitStore(inst)
        commitEffects(inst)
      } finally {
        inst.rendering = false
      }
      if (inst.pending === true) { inst.pending = false; render() }
    }
    inst.render = render
    render()
    return {
      get tree() { return inst.tree },
      rerender: render,
      updateProps: next => { inst.props = next; render() },
      unmount: () => {
        if (inst.active !== undefined) inst.active.unsubscribe()
        for (const entry of inst.effectState.values()) {
          if (typeof entry.cleanup === 'function') entry.cleanup()
        }
      },
    }
  }
  return { React: { createElement, useEffect, useCallback, useId, useRef, useState, useSyncExternalStore }, mount }
}

/** Detach a vm-realm value before comparing it (cross-realm prototypes). */
const plain = value => JSON.parse(JSON.stringify(value))

/* ── tree helpers ───────────────────────────────────────────────────────── */

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

/** The first index of a matching node in depth-first order (-1 when absent). */
function firstIndex(tree, predicate) {
  const order = []
  walk(tree, node => order.push(node))
  return order.findIndex(predicate)
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

/** The first button whose visible copy is exactly one of `keys`. */
const buttonWithText = (tree, keys) => findAll(
  tree,
  node => node.type === 'button' && keys.some(key => directText(node) === key),
)[0]

/** Every rendered text input (retry, fetch, and provider-timeout controls). */
const textInputs = tree => findAll(tree, node => node.type === 'input' && node.props.inputMode !== undefined)

/**
 * The retry numeric inputs of one surface (the four NUMERIC_FIELDS), in field
 * order. Retry controls carry no placeholder; the fetch and provider-timeout
 * controls both do, so they never collide with this set.
 */
const retryInputs = tree => findAll(
  tree,
  node => node.type === 'input' && node.props.inputMode !== undefined && node.props.placeholder === undefined,
)

/** The package/SDK default placeholders of the provider-timeout controls. */
const TIMEOUT_PLACEHOLDERS = Object.freeze(['300000', '600000', '60000'])

/** The provider-timeout inputs of one merged route card, in family field order. */
const timeoutInputs = tree => findAll(
  tree,
  node => node.type === 'input'
    && node.props.inputMode !== undefined
    && TIMEOUT_PLACEHOLDERS.includes(node.props.placeholder),
)

/** The two process-wide fetch-timer inputs of the global card, in FETCH_KEYS order. */
const fetchInputs = tree => findAll(
  tree,
  node => node.type === 'input' && node.props.inputMode !== undefined && node.props.placeholder === EN['fetch.placeholder'],
)

/** The mode select of one surface. */
const modeSelect = tree => findAll(tree, node => node.type === 'select')[0]

/** The rendered code checkboxes of one surface, in RETRYABLE_CODES order. */
const codeCheckboxes = tree => findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox')

/** Type text into one retry numeric field by index (maxRetries, initial, max, jitter). */
function setRetryInput(tree, index, text) {
  const input = retryInputs(tree)[index]
  if (input === undefined) throw new Error(`no rendered retry input at index ${String(index)}`)
  input.props.onChange({ target: { value: text } })
}

/** Type text into one fetch-timer input by index (headers, body). */
function setFetchInput(tree, index, text) {
  const input = fetchInputs(tree)[index]
  if (input === undefined) throw new Error(`no rendered fetch input at index ${String(index)}`)
  input.props.onChange({ target: { value: text } })
}

/** Type text into one provider-timeout input by index (family field order). */
function setTimeoutInput(tree, index, text) {
  const input = timeoutInputs(tree)[index]
  if (input === undefined) throw new Error(`no rendered provider-timeout input at index ${String(index)}`)
  input.props.onChange({ target: { value: text } })
}

/** The "Unlimited" preset buttons of one merged route card, one per visible field. */
const timeoutPresetButtons = tree => findAll(
  tree,
  node => node.type === 'button' && directText(node) === EN['timeouts.unlimited'],
)

/** Choose a mode on one surface. */
function setMode(tree, value) {
  const select = modeSelect(tree)
  if (select === undefined) throw new Error('no rendered mode select')
  select.props.onChange({ target: { value } })
}

/** Toggle one code checkbox by its position in RETRYABLE_CODES. */
function toggleCode(tree, index, checked) {
  const box = codeCheckboxes(tree)[index]
  if (box === undefined) throw new Error(`no rendered code checkbox at index ${String(index)}`)
  box.props.onChange({ target: { checked } })
}

/** Await the microtask queue plus the next macrotask, so a `mutate()` settles. */
const flush = async () => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise(resolve => { setImmediate(resolve) })
  }
}

/** The two `<section class="dlct-card">` tiers of the merged page. */
const sectionCards = tree => findAll(tree, node => node.type === 'section' && node.props.className === 'dlct-card')

/** The ONE per-route add-selector of the merged page (its first option is the placeholder). */
const pickerSelect = tree => findAll(
  tree,
  node => node.type === 'select'
    && node.props.className === 'dlct-select'
    && (node.children ?? []).some(child => child !== null && child !== undefined && child.type === 'option' && child.props.value === ''),
)[0]

/** The add-selector's option copy, in render order (placeholder first). */
function pickerOptions(tree) {
  const select = pickerSelect(tree)
  if (select === undefined) return []
  return findAll(select, node => node.type === 'option').map(node => directText(node))
}

/** Every merged RouteCard placeholder the page root rendered, in rank order. */
const routeCardElements = page => findAll(
  page.tree,
  node => typeof node.type === 'function' && node.props?.row !== undefined,
)

/** The merged RouteCard placeholder for one provider key. */
function routeCardElement(page, provider) {
  const found = routeCardElements(page).find(node => node.props.row.provider === provider)
  if (found === undefined) throw new Error(`no merged route card rendered for "${provider}"`)
  return found
}

/** Mount one merged route card exactly as the page rendered it. */
function mountRouteCard(page, provider) {
  const element = routeCardElement(page, provider)
  return react.mount(element.type, element.props)
}

/** Assert one recorded op list, detached from the vm realm. */
function assertOps(actual, expected, label) {
  assert.deepEqual(plain(actual), expected, `${label}: ${JSON.stringify(plain(actual))}`)
}

/* ── config-form double ─────────────────────────────────────────────────── */

/**
 * The shared config-form double. Methods are prototype methods, like the real
 * controller, and every write is recorded with the revision the page passed.
 */
class BoundForm {
  constructor(ns, snapshot, options = {}) {
    this.ns = ns
    this.snapshot = snapshot
    this.listeners = new Set()
    this.calls = []
    this.accept = options.accept ?? true
    /** Push a fresh revision when the first write resolves `false` (recovery). */
    this.reviseOnRefuse = options.reviseOnRefuse === true
    /** Push a fresh revision on EVERY write, then resolve `false`. */
    this.refuseRevising = options.refuseRevising === true
    /** Push the next revision after an ACCEPTED write, like a real mirror fold. */
    this.advanceOnAccept = options.advanceOnAccept === true
    /** A rejection factory: `(form, ops, revision) => Promise`. */
    this.reject = options.reject
  }

  /** The controller's reference-stable snapshot reader. */
  getSnapshot() { return this.snapshot }

  /** The controller's subscriber; returns its own disposer. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Publish a new snapshot to the mounted surface (the recovery read). */
  push(snapshot) {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }

  /** The controller's atomic writer. */
  mutate(ops, revision) {
    this.calls.push({ ops, revision })
    if (typeof this.reject === 'function') return this.reject(this, ops, revision)
    if (this.refuseRevising) {
      this.push({ ...this.snapshot, revision: (this.snapshot.revision ?? 0) + 1 })
      return Promise.resolve(false)
    }
    if (this.reviseOnRefuse && this.calls.length === 1) {
      this.push({ ...this.snapshot, revision: (this.snapshot.revision ?? 0) + 1 })
      return Promise.resolve(false)
    }
    if (this.advanceOnAccept && this.accept === true) {
      this.push({ ...this.snapshot, revision: (this.snapshot.revision ?? 0) + 1 })
    }
    return Promise.resolve(this.accept)
  }
}

/** A ready snapshot with the given revision, effective value, and user layer. */
const readySnapshot = (value, revision, user = undefined) => ({
  status: 'ready', value, base: undefined, user, revision, writable: true,
})

/** An unserved own namespace: the page must degrade, not pretend to write. */
const unavailableSnapshot = { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: 0, writable: false }
/** A still-loading namespace. */
const loadingSnapshot = { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false }

/** The six global retry values the global card starts from. */
const TUNE_VALUE = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
})

/** A deep copy of {@link TUNE_VALUE}, for fixtures that need a per-route section. */
const tuneValue = () => plain(TUNE_VALUE)

/** A ready own-namespace snapshot: the retry defaults plus the given fetch leaves. */
const tuningSnapshot = (fetch = {}, revision = 7) => readySnapshot({ ...TUNE_VALUE, ...fetch }, revision)

/** A retryPolicy that differs from the global values in every leaf (the base pi-ai override). */
const PI_AI_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['RATE_LIMIT']),
  backoff: Object.freeze({ initialDelayMs: 250, maxDelayMs: 5_000, jitterRatio: 0.2 }),
})

/** A pi-ai snapshot value carrying one openrouter profile. */
const piAiValue = profile => ({ providers: { openrouter: profile } })

/** The provider directory the fake Remote `llm` answers with. */
const REGISTERED = [
  { id: 'deepseek-official', name: 'DeepSeek' },
  { id: 'deepseek-account', name: 'DeepSeek Account' },
  { id: 'openrouter', name: 'OpenRouter' },
]
const CONFIGURABLE = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
  { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
  { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
]

/**
 * Build the form doubles for one mount. The base fixture makes exactly ONE
 * route deviate (openrouter's stored retry policy differs from the global
 * values), which is the merged page's primitive state; `overrides` replaces
 * individual namespaces.
 */
function makeForms(overrides = {}) {
  const forms = {
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot()),
    'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({}, 2)),
    'llm-deepseek-account': new BoundForm('llm-deepseek-account', readySnapshot({}, 3)),
    'llm-pi-ai': new BoundForm('llm-pi-ai', readySnapshot(
      piAiValue({ retryPolicy: plain(PI_AI_RETRY_POLICY) }),
      4,
      { providers: { openrouter: { retryPolicy: { mode: 'normal', maxRetries: 2 } } } },
    )),
  }
  return Object.assign(forms, overrides)
}

/**
 * Build the form doubles with ONE provider namespace replaced by an explicit
 * snapshot, for the per-route deviation/seeding/gating fixtures.
 * @param ns - the provider namespace.
 * @param value - the resolved section value.
 * @param user - the user layer (retry/timeout overrides).
 * @param revision - the snapshot revision.
 * @returns the complete form set.
 */
function providerForms(ns, value, user, revision) {
  return makeForms({ [ns]: new BoundForm(ns, readySnapshot(value, revision, user)) })
}

/**
 * A form set whose only deviating routes are the ones named in `deviations`:
 * a route deviates through a stored retryPolicy (value-based) and/or through a
 * timeout leaf present in the user layer.
 * @param deviations - `{deepseek, account, openrouter}` partial overrides.
 * @returns the complete form set.
 */
function deviationForms(deviations = {}) {
  const forms = makeForms({
    'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot(deviations.deepseek?.value ?? {}, 2, deviations.deepseek?.user)),
    'llm-deepseek-account': new BoundForm('llm-deepseek-account', readySnapshot(deviations.account?.value ?? {}, 3, deviations.account?.user)),
    'llm-pi-ai': new BoundForm('llm-pi-ai', readySnapshot(
      deviations.openrouter !== undefined ? piAiValue(deviations.openrouter.value) : {},
      4,
      deviations.openrouter !== undefined ? { providers: { openrouter: deviations.openrouter.user } } : undefined,
    )),
  })
  return forms
}

/**
 * Build a fake client root context with the services the client half injects.
 * @param options - `forms` (the form doubles), `registered` / `configurable`
 *   (the provider directory), `remote` (`'dotted'`, `'fallback'`, `'throwing'`,
 *   or `'none'`), and `remoteImpl` (an explicit `llm` service double).
 * @returns the context double plus its recording state.
 */
function fakeContext({ forms = makeForms(), registered = REGISTERED, configurable = CONFIGURABLE, remote = 'dotted', remoteImpl, connection } = {}) {
  const state = {
    dictionaries: [], registered: [], effects: [], injections: [], serviceReads: [], formRequests: [],
  }
  const defaultLlm = {
    listProviders: () => Promise.resolve({ ok: true, value: [...registered] }),
    listConfigurableProviders: () => Promise.resolve({ ok: true, value: [...configurable] }),
  }
  const llm = remote === 'none' ? undefined : (remoteImpl ?? defaultLlm)
  const ctx = {
    state,
    get(name) {
      state.serviceReads.push(name)
      if (name === 'connection') return connection
      if (name !== 'remote.llm') return undefined
      if (remote === 'throwing') throw new Error('cannot get property "remote.llm" without inject')
      return remote === 'dotted' ? llm : undefined
    },
    remote: remote === 'fallback' || remote === 'throwing' ? { llm } : undefined,
    effect(callback, label) {
      state.effects.push(label)
      const disposer = callback()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    locale: {
      register(ns, dictionary) { state.dictionaries.push({ ns, dictionary }); return () => {} },
      bind(ns) {
        return key => {
          const entry = state.dictionaries.find(candidate => candidate.ns === ns)
          const table = entry?.dictionary?.en ?? {}
          return typeof table[key] === 'string' ? table[key] : `«missing:${ns}.${key}»`
        }
      },
    },
    slots: {
      inject(slot, callback) { state.injections.push(slot); callback() },
      register(options, component) { state.registered.push({ options, component }); return () => {} },
    },
    configForms: {
      get(ns) {
        state.formRequests.push(ns)
        return forms[ns] ?? new BoundForm(ns, unavailableSnapshot)
      },
    },
  }
  return ctx
}

/* ══ fixture load and the client vm realm ══════════════════════════════════ */

/**
 * A deterministic fake-timer set for the client vm realm. The manual-retry
 * dock polls every 2000 ms, so its loop is driven by advancing this clock
 * instead of waiting on real timers.
 * @returns the timer functions plus `advance(ms)`, `flush()`, `pending()`, `now()`.
 */
function createTimerDouble() {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map()
  const setTimeout = (callback, ms, ...args) => {
    const id = nextId
    nextId += 1
    timers.set(id, { callback, args, at: now + Math.max(0, Number(ms) || 0), order: id })
    return id
  }
  const clearTimeout = id => { timers.delete(id) }
  const pending = () => timers.size
  const drainMicrotasks = () => new Promise(resolve => { setImmediate(resolve) })
  const runDue = async () => {
    for (;;) {
      let due
      for (const [id, entry] of timers) {
        if (entry.at > now) continue
        if (due === undefined || entry.at < due.entry.at || (entry.at === due.entry.at && entry.order < due.entry.order)) {
          due = { id, entry }
        }
      }
      if (due === undefined) return
      timers.delete(due.id)
      due.entry.callback(...due.entry.args)
      await drainMicrotasks()
    }
  }
  return {
    setTimeout,
    clearTimeout,
    pending,
    now: () => now,
    async advance(ms) { now += ms; await runDue() },
    async flush() { await drainMicrotasks() },
  }
}

const vmTimers = createTimerDouble()

const manifest = readJson('package.json')
const patch = read('cordis.patch.yml')
const clientSource = read('client.js')
const hostSource = read('index.js')
const localeEn = readJson('locale/en.json')
const localeZh = readJson('locale/zh.json')

const react = createReactStub()
let captured
const requested = []
const clientVm = createContext({
  window: { __ModuleLoader__: { load: options => { captured = options } } },
  console,
  setTimeout: vmTimers.setTimeout,
  clearTimeout: vmTimers.clearTimeout,
  AbortController,
})
runInContext(clientSource, clientVm, { filename: 'client.js' })
const clientPlugin = captured.factory(specifier => {
  requested.push(specifier)
  if (specifier === 'react') return react.React
  throw new Error(`client.js requested "${specifier}", which is not in the baseline module table`)
})

/** The en/zh copy tables, from one throwaway registration. */
const COPY = (() => {
  const ctx = fakeContext()
  clientPlugin.apply(ctx)
  return ctx.state.dictionaries[0].dictionary
})()
const EN = COPY.en

/** One named slot registration from a fake client context. */
function registrationByName(ctx, name) {
  const found = ctx.state.registered.find(entry => entry.options?.name === name)
  assert.ok(
    found !== undefined,
    `the client registered no ${name} slot (registrations: ${JSON.stringify(ctx.state.registered.map(entry => entry.options?.name))})`,
  )
  return found
}

/** The manual-retry dock registration (registered BEFORE the settings guard). */
const dockRegistration = ctx => registrationByName(ctx, 'conversation.input.dock')

/** The tuning settings section registration. */
const settingsRegistration = ctx => registrationByName(ctx, 'settings.section')

/**
 * Mount the real settings section against a fresh form set. The dock is
 * registered first on purpose, so the section is selected BY NAME.
 * @param options - passed through to {@link fakeContext}.
 * @returns the context, registration, injected face, and mounted page.
 */
function mountPage(options = {}) {
  const ctx = fakeContext(options)
  clientPlugin.apply(ctx)
  const registration = settingsRegistration(ctx)
  const face = registration.options.inject()
  const page = react.mount(registration.component, face)
  return { ctx, registration, face, page }
}

/**
 * Mount the manual-retry dock with one fake session and the injected route
 * caller.
 * @param options - `running` (session state), `connection` (rpc double),
 *   `sessionId`, and `props` (extra slot props).
 * @returns the context, registration, session double, and mounted dock.
 */
function mountDock({ running = true, connection, sessionId = 'sess-main', props: extraProps = {} } = {}) {
  const ctx = fakeContext({ connection })
  clientPlugin.apply(ctx)
  const registration = dockRegistration(ctx)
  const face = registration.options.inject()
  const session = sessionDouble(running)
  const props = {
    sessionId,
    useSession: session.useSession,
    t: ctx.locale.bind('llm-api-call-tuning'),
    ...face,
    ...extraProps,
  }
  const page = react.mount(registration.component, props)
  return { ctx, registration, session, page, props }
}

/**
 * The global card's retry sub-group values, from the page root. The retry
 * inputs of a route card never appear in the root tree (that card is a child
 * placeholder), so an unmounted page carries exactly the global four.
 */
const globalRetryValues = page => retryInputs(page.tree).map(input => input.props.value)

/** The single fetch sub-group of the global card. */
const globalFetchValues = page => fetchInputs(page.tree).map(input => input.props.value)

/** The global card node (the FIRST `section.dlct-card`). */
function globalCard(page) {
  const cards = sectionCards(page.tree)
  if (cards.length === 0) throw new Error('the page rendered no global card')
  return cards[0]
}

/** The per-route card node (the SECOND `section.dlct-card`). */
function providersCard(page) {
  const cards = sectionCards(page.tree)
  if (cards.length < 2) throw new Error(`the page rendered ${cards.length} card tiers, expected two`)
  return cards[1]
}

/* ══ 1. manifest ═══════════════════════════════════════════════════════════ */

await check('the manifest declares the frozen identity, bundle patch, engines, and web client', () => {
  assert.equal(manifest.name, 'dsh-llm-api-call-tuning', `package name drifted to ${String(manifest.name)}`)
  assert.equal(manifest.version, '0.2.2-alpha.2', `version drifted to ${String(manifest.version)}`)
  assert.equal(manifest.private, false, 'the package must be publicly publishable')
  assert.equal(manifest.type, 'module', `type drifted to ${String(manifest.type)}`)
  assert.equal(manifest.engines?.dsh, '^0.2.2-alpha.2', `engines.dsh drifted to ${String(manifest.engines?.dsh)}`)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', `dsh.bundle.patch drifted to ${String(manifest.dsh?.bundle?.patch)}`)
  assert.equal(manifest.dsh?.client?.platform, 'web', `dsh.client.platform drifted to ${String(manifest.dsh?.client?.platform)}`)
  assert.deepEqual(
    [...manifest.dsh.client.inject],
    [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-general',
      '@deepseek-ai/dsh-api-remotes',
    ],
    `dsh.client.inject drifted: ${JSON.stringify(manifest.dsh.client.inject)}`,
  )
  assert.equal(manifest.scripts?.verify, 'node verify.mjs', `scripts.verify drifted to ${String(manifest.scripts?.verify)}`)
  assert.equal(manifest.dependencies, undefined, 'the plugin must ship no dependencies: an install step could reach the network')
  assert.equal(manifest.devDependencies, undefined, 'the plugin must ship no devDependencies')
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0, 'the manifest has no description')
})

await check('every export subpath the packaging contract needs is present', () => {
  for (const subpath of ['.', './client', './package.json', './locale/*.json']) {
    assert.ok(manifest.exports?.[subpath] !== undefined, `exports is missing "${subpath}"`)
  }
  assert.equal(manifest.exports['.'], './index.js', 'exports["."] must be the host half')
  assert.equal(manifest.exports['./client'], './client.js', 'exports["./client"] must be the browser half')
})

await check('every shipped entry of "files" exists on disk, including the docs and verify.mjs', () => {
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(join(here, entry)), `the "files" entry ${entry} does not exist`)
  }
  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'verify.mjs', 'README.md', 'README.zh.md', 'CONTRACT.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(entry), `"files" is missing ${entry}`)
  }
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
  assert.equal(patchRow[1], 'llm-api-call-tuning', `the loader entry id drifted to ${patchRow[1]}`)
  assert.equal(patchRow[2], manifest.name, `the loader row name ${patchRow[2]} is not the bare package name ${manifest.name}`)
  assert.equal((patch.match(/- insert:/g) ?? []).length, 1, 'the patch must insert exactly one row')
  assert.equal((patch.match(/- id:/g) ?? []).length, 1, 'the patch must declare exactly one row id')
})

await check('the mount patch seeds NOTHING, so a fresh install runs the upstream code defaults', () => {
  for (const key of ['mode', 'maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio', 'retryableCodes']) {
    assert.doesNotMatch(
      patch,
      new RegExp(`^\\s+${key}:`, 'm'),
      `the mount patch seeds ${key}, which would make an install choice the default`,
    )
  }
  assert.doesNotMatch(patch, /^\s+config:\s*$/m, 'the mounted row must not carry a config block')
})

await check('the client module id is the exact package name, textually and when evaluated', () => {
  const textual = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientSource)
  assert.ok(textual !== null, 'client.js does not call window.__ModuleLoader__.load({ id: ... })')
  assert.equal(textual[1], manifest.name, `the client module id ${textual[1]} drifted from the package name`)
  assert.equal(captured?.id, manifest.name, 'the evaluated __ModuleLoader__.load id drifted from the package name')
  assert.equal(typeof captured?.factory, 'function', 'the captured module has no factory')
  assert.deepEqual(requested, ['react'], `the evaluated factory requested ${JSON.stringify(requested)}`)
})

await check('the client artifact requests only react, and touches no forbidden global', () => {
  const requires = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(match => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], `client.js require() calls drifted: ${JSON.stringify(requires)}`)
  const externalLines = clientSource.split('\n').filter(line => line.includes('@deepseek-ai/'))
  assert.ok(
    externalLines.every(line => /^\s*(\*|\/\/)/.test(line)),
    `client.js references a baseline external (@deepseek-ai/...) on a non-comment line: ${externalLines.filter(line => !/^\s*(\*|\/\/)/.test(line)).join(' | ')}`,
  )
  assert.ok(!/\bdocument\./.test(clientSource), 'client.js reaches for document.*, which the client module table does not provide')
  const windows = [...clientSource.matchAll(/\bwindow\.[A-Za-z_$]+/g)].map(match => match[0])
  assert.deepEqual([...new Set(windows)], ['window.__ModuleLoader__'], `client.js uses window beyond the module loader: ${JSON.stringify(windows)}`)
})

await check('the host half has no default export and exposes only the frozen named surface', () => {
  assert.equal('default' in host, false, 'index.js must not have a default export')
  assert.deepEqual(
    Object.keys(host).sort(),
    [
      'Config', 'DEFAULT_FETCH', 'DEFAULT_TUNE', 'FETCH_KEYS', 'FETCH_OPTIONS',
      'OFFERED_RETRYABLE_CODES',
      'PROVIDER_TIMEOUT_FIELDS', 'PROVIDER_TIMEOUT_KEYS', 'PROVIDER_TIMEOUT_OPTIONS',
      'RETRYABLE_CODES', 'RETRY_MODES', 'TUNE_KEYS', 'TUNE_OPTIONS', 'TUNE_PROBLEMS',
      'apply', 'name', 'schemaLibrary', 'validateTune',
    ],
    `index.js exported surface drifted: ${JSON.stringify(Object.keys(host).sort())}`,
  )
  assert.equal(host.name, 'llm-api-call-tuning', `index.js exported name drifted to ${String(host.name)}`)
  assert.equal(typeof host.apply, 'function', 'index.js has no apply()')
  assert.equal(typeof host.validateTune, 'function', 'index.js has no validateTune()')
  assert.equal('inject' in host, false, 'index.js must not export inject: apply() injects settings itself')
})

await check('DEFAULT_TUNE is exactly the six upstream retry-policy constants and stays frozen', () => {
  assert.equal(Object.isFrozen(host.DEFAULT_TUNE), true, 'DEFAULT_TUNE must stay frozen')
  assert.equal(Object.isFrozen(host.DEFAULT_TUNE.retryableCodes), true, 'DEFAULT_TUNE.retryableCodes must stay frozen')
  assert.deepEqual(
    plain(host.DEFAULT_TUNE),
    {
      mode: 'normal',
      maxRetries: 5,
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    },
    `DEFAULT_TUNE drifted: ${JSON.stringify(host.DEFAULT_TUNE)}`,
  )
  assert.deepEqual([...host.TUNE_KEYS], ['mode', 'maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio', 'retryableCodes'], 'TUNE_KEYS drifted')
})

await check('TUNE_OPTIONS states a default text and an allowed range for every owned key', () => {
  assert.deepEqual(host.TUNE_OPTIONS.map(option => option.key), [...host.TUNE_KEYS], 'TUNE_OPTIONS is not one entry per owned key, in order')
  for (const option of host.TUNE_OPTIONS) {
    assert.ok(['mode', 'nonNegativeInteger', 'positiveFiniteMs', 'ratio', 'retryableCodes'].includes(option.kind), `${option.key} has the unknown kind ${String(option.kind)}`)
    assert.ok(typeof option.defaultText === 'string' && option.defaultText.length > 0, `${option.key} has no defaultText`)
    assert.ok(typeof option.range === 'string' && option.range.length > 0, `${option.key} has no range text`)
    assert.deepEqual(plain(option.default), plain(host.DEFAULT_TUNE[option.key]), `${option.key} default drifted from DEFAULT_TUNE`)
  }
})

await check('RETRY_MODES, RETRYABLE_CODES, and TUNE_PROBLEMS are frozen and exact', () => {
  assert.equal(Object.isFrozen(host.RETRY_MODES), true, 'RETRY_MODES must stay frozen')
  assert.deepEqual(plain(host.RETRY_MODES), ['normal', 'always'], 'RETRY_MODES drifted')
  assert.equal(Object.isFrozen(host.RETRYABLE_CODES), true, 'RETRYABLE_CODES must stay frozen')
  assert.deepEqual(plain(host.RETRYABLE_CODES), ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'], 'RETRYABLE_CODES drifted')
  assert.equal(Object.isFrozen(host.TUNE_PROBLEMS), true, 'TUNE_PROBLEMS must stay frozen')
  assert.deepEqual(plain(host.TUNE_PROBLEMS), {
    mode: 'mode',
    maxRetries: 'maxRetries',
    initialDelayMs: 'initialDelayMs',
    maxDelayMs: 'maxDelayMs',
    delayOrder: 'delayOrder',
    jitterRatio: 'jitterRatio',
    retryableCodes: 'retryableCodes',
  }, 'TUNE_PROBLEMS drifted')
})

await check('OFFERED_RETRYABLE_CODES is the frozen ten-code superset, and the default constant stays exactly the five', () => {
  assert.equal(Object.isFrozen(host.OFFERED_RETRYABLE_CODES), true, 'OFFERED_RETRYABLE_CODES must stay frozen')
  assert.deepEqual(plain(host.OFFERED_RETRYABLE_CODES), [
    'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
    'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'PI_AI_ERROR', 'HTTP_408', 'HTTP_409',
  ], `OFFERED_RETRYABLE_CODES drifted: ${JSON.stringify(plain(host.OFFERED_RETRYABLE_CODES))}`)
  assert.equal(host.OFFERED_RETRYABLE_CODES.length, host.RETRYABLE_CODES.length + 5, 'exactly five opt-in extras must be offered')
  assert.deepEqual(
    [...host.OFFERED_RETRYABLE_CODES.slice(0, host.RETRYABLE_CODES.length)],
    [...host.RETRYABLE_CODES],
    'the offered list must LEAD with the frozen five defaults, in order',
  )
  assert.deepEqual(plain(host.RETRYABLE_CODES), ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'], 'RETRYABLE_CODES (the default) must stay exactly the five upstream codes')
  assert.deepEqual(plain(host.DEFAULT_TUNE.retryableCodes), [...host.RETRYABLE_CODES], 'DEFAULT_TUNE.retryableCodes must stay the five defaults, never the offered ten')
  const offered = new Set(host.OFFERED_RETRYABLE_CODES)
  for (const defaultCode of host.RETRYABLE_CODES) {
    assert.equal(offered.has(defaultCode), true, `the offered set lost the default code ${defaultCode}`)
  }
})

await check('FETCH_KEYS, DEFAULT_FETCH, and FETCH_OPTIONS are frozen and exact', () => {
  assert.equal(Object.isFrozen(host.FETCH_KEYS), true, 'FETCH_KEYS must stay frozen')
  assert.deepEqual([...host.FETCH_KEYS], ['headersTimeoutMs', 'bodyTimeoutMs'], 'FETCH_KEYS drifted')
  assert.equal(Object.isFrozen(host.DEFAULT_FETCH), true, 'DEFAULT_FETCH must stay frozen')
  assert.deepEqual(plain(host.DEFAULT_FETCH), { headersTimeoutMs: null, bodyTimeoutMs: null }, `DEFAULT_FETCH drifted: ${JSON.stringify(host.DEFAULT_FETCH)}`)
  assert.equal(Object.isFrozen(host.FETCH_OPTIONS), true, 'FETCH_OPTIONS must stay frozen')
  assert.deepEqual(host.FETCH_OPTIONS.map(option => option.key), [...host.FETCH_KEYS], 'FETCH_OPTIONS is not one entry per fetch key, in order')
  for (const option of host.FETCH_OPTIONS) {
    assert.equal(Object.isFrozen(option), true, `${option.key} metadata must stay frozen`)
    assert.equal(option.kind, 'optionalNonNegativeIntegerMs', `${option.key} has the unknown kind ${String(option.kind)}`)
    assert.equal(option.default, null, `${option.key} metadata default must be null (unset)`)
    assert.equal(option.defaultText, 'unset', `${option.key} defaultText drifted to ${String(option.defaultText)}`)
    assert.deepEqual(plain(option.default), plain(host.DEFAULT_FETCH[option.key]), `${option.key} default drifted from DEFAULT_FETCH`)
    for (const number of [0, 2_147_483_647]) {
      assert.equal(option.range.includes(String(number)), true, `${option.key} range text lost the number ${number}`)
    }
    assert.match(option.range, /unset/i, `${option.key} range text does not say the value may be unset`)
    assert.match(option.range, /disabl/i, `${option.key} range text does not say 0 disables the timer`)
  }
})

await check('PROVIDER_TIMEOUT_FIELDS/KEYS/OPTIONS are frozen metadata, one per provider-owned timeout, in order', () => {
  assert.equal(Object.isFrozen(host.PROVIDER_TIMEOUT_KEYS), true, 'PROVIDER_TIMEOUT_KEYS must stay frozen')
  assert.deepEqual(
    [...host.PROVIDER_TIMEOUT_KEYS],
    ['streamIdleTimeoutMs', 'timeoutMs', 'filesApiTimeoutMs'],
    'PROVIDER_TIMEOUT_KEYS drifted',
  )
  assert.equal(Object.isFrozen(host.PROVIDER_TIMEOUT_FIELDS), true, 'PROVIDER_TIMEOUT_FIELDS must stay frozen')
  assert.deepEqual(host.PROVIDER_TIMEOUT_FIELDS.map(field => field.key), [...host.PROVIDER_TIMEOUT_KEYS], 'PROVIDER_TIMEOUT_FIELDS is not one entry per key, in order')
  assert.equal(Object.isFrozen(host.PROVIDER_TIMEOUT_OPTIONS), true, 'PROVIDER_TIMEOUT_OPTIONS must stay frozen')
  assert.deepEqual(host.PROVIDER_TIMEOUT_OPTIONS.map(option => option.key), [...host.PROVIDER_TIMEOUT_KEYS], 'PROVIDER_TIMEOUT_OPTIONS is not one entry per key, in order')
  assert.deepEqual(plain(host.PROVIDER_TIMEOUT_OPTIONS), plain(host.PROVIDER_TIMEOUT_FIELDS), 'the public PROVIDER_TIMEOUT_OPTIONS projection drifted from PROVIDER_TIMEOUT_FIELDS')
})

await check('every provider-timeout option carries the frozen shape, family, default, bounds, and unlimited preset', () => {
  const expected = {
    streamIdleTimeoutMs: {
      family: 'streamIdle',
      default: 300_000,
      defaultText: '300000 ms (5 min); unset = package default 300000',
      range: 'integer 1..2147483647; 0 is refused (schema and load-time assert)',
      scopes: [
        { ns: 'llm-pi-ai', pathTemplate: ['providers', '<route>', 'streamIdleTimeoutMs'] },
        { ns: 'llm-deepseek', pathTemplate: ['streamIdleTimeoutMs'] },
        { ns: 'llm-deepseek-account', pathTemplate: ['streamIdleTimeoutMs'] },
      ],
    },
    timeoutMs: {
      family: 'request',
      default: null,
      defaultText: 'unset = SDK default (about 600000 ms)',
      range: 'integer 1..2147483647; 0 is refused by the page (schema-legal but aborts every request)',
      scopes: [{ ns: 'llm-pi-ai', pathTemplate: ['providers', '<route>', 'timeoutMs'] }],
    },
    filesApiTimeoutMs: {
      family: 'files',
      default: 60_000,
      defaultText: '60000 ms (1 min); unset = package default 60000',
      range: 'integer 1..2147483647; 0 is refused (schema and load-time assert)',
      scopes: [
        { ns: 'llm-deepseek', pathTemplate: ['filesApiTimeoutMs'] },
        { ns: 'llm-deepseek-account', pathTemplate: ['filesApiTimeoutMs'] },
      ],
    },
  }
  assert.deepEqual(Object.keys(expected), [...host.PROVIDER_TIMEOUT_KEYS], 'the pinned option table is out of order')
  for (const option of host.PROVIDER_TIMEOUT_OPTIONS) {
    const shape = expected[option.key]
    assert.ok(shape !== undefined, `unexpected provider-timeout key ${option.key}`)
    assert.equal(Object.isFrozen(option), true, `${option.key} option must stay frozen`)
    assert.deepEqual(
      Object.keys(option).sort(),
      ['default', 'defaultText', 'description', 'family', 'integerOnly', 'key', 'range', 'scopes', 'unit', 'unlimitedPreset', 'zeroRejected'],
      `${option.key} option surface drifted: ${JSON.stringify(Object.keys(option))}`,
    )
    assert.equal(option.family, shape.family, `${option.key} family drifted`)
    assert.deepEqual(plain(option.default), plain(shape.default), `${option.key} default drifted`)
    assert.equal(option.defaultText, shape.defaultText, `${option.key} defaultText drifted`)
    assert.equal(option.range, shape.range, `${option.key} range text drifted`)
    assert.equal(option.unit, 'ms', `${option.key} unit drifted`)
    assert.equal(option.integerOnly, true, `${option.key} must be marked integerOnly`)
    assert.equal(option.zeroRejected, true, `${option.key} must be marked zeroRejected`)
    assert.equal(option.unlimitedPreset, 2_147_483_647, `${option.key} unlimitedPreset must be the 2147483647 cap`)
    assert.equal(typeof option.description, 'string', `${option.key} has no description`)
    assert.ok(option.description.length > 0, `${option.key} description is blank`)
    assert.match(option.range, /2147483647/, `${option.key} range text lost the 2147483647 cap`)
    assert.match(option.range, /0 is refused/, `${option.key} range text must say 0 is refused`)
    assert.equal(Object.isFrozen(option.scopes), true, `${option.key} scopes must stay frozen`)
    assert.deepEqual(plain(option.scopes), shape.scopes, `${option.key} namespace/path scopes drifted`)
    for (const scope of option.scopes) {
      assert.equal(Object.isFrozen(scope), true, `${option.key} scope must stay frozen`)
      assert.equal(Object.isFrozen(scope.pathTemplate), true, `${option.key} scope pathTemplate must stay frozen`)
    }
  }
})

await check("the provider-timeout keys are NOT fields of this plugin's Config: Config keeps six retry + two fetch fields", () => {
  for (const key of host.PROVIDER_TIMEOUT_KEYS) {
    assert.equal(key in (host.Config.dict ?? {}), false, `${key} leaked into Config.dict (Config must stay retry+fetch only)`)
    assert.equal(host.TUNE_KEYS.includes(key), false, `${key} leaked into TUNE_KEYS`)
    assert.equal(host.FETCH_KEYS.includes(key), false, `${key} leaked into FETCH_KEYS`)
  }
  assert.deepEqual(
    Object.keys(host.Config.dict ?? {}),
    [...host.TUNE_KEYS, ...host.FETCH_KEYS],
    'Config.dict drifted: the provider-timeout metadata must not become config fields',
  )
})

await check('the loader id, host name, section id, locale NS, and dictionary NS all agree', () => {
  const options = clientPluginApplyRegistration()
  assert.equal(host.name, patchRow[1], `index.js name ${host.name} and the loader entry id ${patchRow[1]} disagree`)
  assert.equal(options?.id, 'llm-api-call-tuning', `the client section id drifted to ${String(options?.id)}`)
  assert.equal(options?.locale, 'llm-api-call-tuning', `the client locale NS drifted to ${String(options?.locale)}`)
  assert.equal(COPY.en.nav, localeEn.meta.title, 'the nav copy and locale/en.json meta.title disagree')
})

/** The section registration from one throwaway apply, used by identity checks. */
function clientPluginApplyRegistration() {
  const ctx = fakeContext()
  clientPlugin.apply(ctx)
  return settingsRegistration(ctx).options
}

/* ══ 3. upstream drift: the real DSH sources ═══════════════════════════════ */

const checkout = process.env.DSH_HARNESS_CHECKOUT ?? ''
const retryPolicyPath = join(checkout, 'packages/llm/llm/src/retry-policy.ts')
const timeoutPath = join(checkout, 'packages/util/timeout/src/index.ts')
const deepseekDefaultsPath = join(checkout, 'packages/llm/llm-deepseek/src/defaults.ts')
const deepseekConfigPath = join(checkout, 'packages/llm/llm-deepseek/src/config.ts')
const piAiConfigPath = join(checkout, 'packages/llm/llm-pi-ai/src/config.ts')
let upstreamSourceCache
/** The upstream retry-policy source, read lazily so an unset checkout fails a check, not the import. */
function upstreamSource() {
  if (upstreamSourceCache === undefined) {
    assert.ok(existsSync(retryPolicyPath), `DSH_HARNESS_CHECKOUT does not contain ${retryPolicyPath}`)
    upstreamSourceCache = readFileSync(retryPolicyPath, 'utf8')
  }
  return upstreamSourceCache
}

/** Read one integer/float constant out of the upstream retry-policy source. */
function upstreamConstant(pattern, name) {
  const match = new RegExp(pattern).exec(upstreamSource())
  assert.ok(match !== null, `the upstream retry-policy source no longer contains ${name}`)
  return Number(match[1].replace(/_/g, ''))
}

await check('$DSH_HARNESS_CHECKOUT resolves the real schemastery and the upstream retry-policy source', () => {
  assert.ok(checkout !== '', 'DSH_HARNESS_CHECKOUT is unset; run: DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs')
  assert.ok(host.schemaLibrary !== undefined, `the host half could not resolve @deepseek-ai/schemastery from ${checkout}`)
  assert.ok(host.Config !== undefined, 'Config is undefined, so the Host would render no settings namespace at all')
  assert.ok(existsSync(retryPolicyPath), `the upstream file ${retryPolicyPath} does not exist`)
  assert.ok(existsSync(timeoutPath), `the upstream file ${timeoutPath} does not exist`)
  assert.ok(existsSync(deepseekDefaultsPath), `the upstream file ${deepseekDefaultsPath} does not exist`)
  assert.ok(existsSync(deepseekConfigPath), `the upstream file ${deepseekConfigPath} does not exist`)
  assert.ok(existsSync(piAiConfigPath), `the upstream file ${piAiConfigPath} does not exist`)
})

await check('the upstream provider-timeout defaults and schema bounds match the host metadata', () => {
  const deepseekDefaults = readFileSync(deepseekDefaultsPath, 'utf8')
  const deepseekConfig = readFileSync(deepseekConfigPath, 'utf8')
  const piAiConfig = readFileSync(piAiConfigPath, 'utf8')
  const constant = (source, pattern, name) => {
    const match = new RegExp(pattern).exec(source)
    assert.ok(match !== null, `the upstream source no longer records ${name}`)
    return Number(match[1].replace(/_/g, ''))
  }
  const streamIdleDefault = constant(deepseekDefaults, 'DEFAULT_STREAM_IDLE_TIMEOUT_MS\\s*=\\s*([\\d_]+)', 'DEFAULT_STREAM_IDLE_TIMEOUT_MS')
  const filesApiDefault = constant(deepseekDefaults, 'DEFAULT_FILES_API_TIMEOUT_MS\\s*=\\s*([\\d_]+)', 'DEFAULT_FILES_API_TIMEOUT_MS')
  assert.equal(streamIdleDefault, host.PROVIDER_TIMEOUT_OPTIONS.find(option => option.key === 'streamIdleTimeoutMs').default, 'the pi-ai/deepseek stream-idle default drifted from the upstream constant')
  assert.equal(constant(piAiConfig, 'DEFAULT_STREAM_IDLE_TIMEOUT_MS\\s*=\\s*([\\d_]+)', 'llm-pi-ai DEFAULT_STREAM_IDLE_TIMEOUT_MS'), streamIdleDefault, 'llm-pi-ai and llm-deepseek disagree on the stream-idle default')
  assert.equal(filesApiDefault, host.PROVIDER_TIMEOUT_OPTIONS.find(option => option.key === 'filesApiTimeoutMs').default, 'the Files API default drifted from the upstream constant')
  assert.match(
    deepseekConfig,
    /streamIdleTimeoutMs: z\.number\(\)\.min\(Number\.MIN_VALUE\)\.max\(MAX_TIMER_DELAY_MS\)\.default\(DEFAULT_STREAM_IDLE_TIMEOUT_MS\)\.volatile\(\),/,
    'llm-deepseek no longer declares streamIdleTimeoutMs as a volatile bounded leaf defaulting to the package default',
  )
  assert.match(
    deepseekConfig,
    /filesApiTimeoutMs: z\.number\(\)\.min\(Number\.MIN_VALUE\)\.max\(MAX_TIMER_DELAY_MS\)\.default\(DEFAULT_FILES_API_TIMEOUT_MS\)\.volatile\(\),/,
    'llm-deepseek no longer declares filesApiTimeoutMs as a volatile bounded leaf defaulting to the package default',
  )
  assert.match(
    piAiConfig,
    /streamIdleTimeoutMs: z\.number\(\)\.min\(Number\.MIN_VALUE\)\.max\(MAX_TIMER_DELAY_MS\)\.default\(DEFAULT_STREAM_IDLE_TIMEOUT_MS\),/,
    'llm-pi-ai no longer declares a bounded streamIdleTimeoutMs defaulting to the package default',
  )
  assert.match(piAiConfig, /timeoutMs: z\.natural\(\),/, 'llm-pi-ai no longer declares timeoutMs as a schema-legal non-negative integer, which is why the page rejects 0')
  assert.doesNotMatch(piAiConfig, /timeoutMs: z\.natural\(\)[^\n]*\.default\(/, 'llm-pi-ai now seeds a timeoutMs default: the metadata default must change from null')
})

await check('the upstream retry-policy code defaults parse to exactly DEFAULT_TUNE', () => {
  const defaults = {
    maxRetries: upstreamConstant('DEFAULT_MAX_RETRIES\\s*=\\s*([\\d_]+)', 'DEFAULT_MAX_RETRIES'),
    initialDelayMs: upstreamConstant('DEFAULT_INITIAL_DELAY_MS\\s*=\\s*([\\d_]+)', 'DEFAULT_INITIAL_DELAY_MS'),
    maxDelayMs: upstreamConstant('DEFAULT_MAX_DELAY_MS\\s*=\\s*([\\d_]+)', 'DEFAULT_MAX_DELAY_MS'),
    jitterRatio: upstreamConstant('DEFAULT_JITTER_RATIO\\s*=\\s*([\\d.]+)', 'DEFAULT_JITTER_RATIO'),
  }
  assert.equal(defaults.maxRetries, host.DEFAULT_TUNE.maxRetries, `upstream maxRetries ${defaults.maxRetries} != DEFAULT_TUNE ${host.DEFAULT_TUNE.maxRetries}`)
  assert.equal(defaults.initialDelayMs, host.DEFAULT_TUNE.initialDelayMs, `upstream initialDelayMs ${defaults.initialDelayMs} != DEFAULT_TUNE ${host.DEFAULT_TUNE.initialDelayMs}`)
  assert.equal(defaults.maxDelayMs, host.DEFAULT_TUNE.maxDelayMs, `upstream maxDelayMs ${defaults.maxDelayMs} != DEFAULT_TUNE ${host.DEFAULT_TUNE.maxDelayMs}`)
  assert.equal(defaults.jitterRatio, host.DEFAULT_TUNE.jitterRatio, `upstream jitterRatio ${defaults.jitterRatio} != DEFAULT_TUNE ${host.DEFAULT_TUNE.jitterRatio}`)
  // The code list is entries of EMPTY_RESPONSE_CODE plus four literals.
  const block = /DEFAULT_RETRYABLE_CODES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(upstreamSource())
  assert.ok(block !== null, 'the upstream DEFAULT_RETRYABLE_CODES block is missing')
  const upstreamCodes = [...block[1].matchAll(/'([A-Z_]+)'/g)].map(match => match[1])
  assert.equal(upstreamCodes.length, 4, `the upstream code list has ${upstreamCodes.length} string literals: ${JSON.stringify(upstreamCodes)}`)
  assert.equal(/EMPTY_RESPONSE_CODE/.test(block[1]), true, 'the upstream code list no longer starts from EMPTY_RESPONSE_CODE')
  assert.deepEqual([...host.RETRYABLE_CODES].filter(code => code !== 'EMPTY_RESPONSE'), upstreamCodes, 'the upstream literal codes drifted from RETRYABLE_CODES')
  assert.deepEqual(plain(host.DEFAULT_TUNE.retryableCodes), [...host.RETRYABLE_CODES], 'the default code list drifted from RETRYABLE_CODES')
})

await check('the upstream schema and load-time asserts still match the values and ranges this plugin records', () => {
  for (const [label, pattern] of [
    ['the normal-mode const', /z\.const\('normal'\)/],
    ['the always-mode const', /z\.const\('always'\)/],
    ['maxRetries bounds', /maxRetries: z\.number\(\)\.step\(1\)\.min\(0\)\.max\(Number\.MAX_SAFE_INTEGER\)/],
    ['the retryable-code array default', /retryableCodes: z\.array\(z\.string\(\)\)\.default\(\[\.\.\.DEFAULT_RETRYABLE_CODES\]\)/],
    ['the delay max bound', /initialDelayMs: z\.number\(\)\.max\(MAX_TIMER_DELAY_MS\)/],
    ['the jitter bounds', /jitterRatio: z\.number\(\)\.min\(0\)\.max\(1\)/],
    ['the positive-delay assert', /must be a positive finite number no greater than/],
    ['the delay-order assert', /must be less than or equal to maxDelayMs/],
    ['the jitter assert', /jitterRatio must be between 0 and 1/],
    ['the safe-integer assert', /maxRetries must be a non-negative safe integer/],
    ['the empty-code assert', /retryableCodes must not be empty/],
    ['the duplicate-code assert', /retryableCodes must not contain duplicates/],
    ['the mode assert', /mode must be "normal" or "always"/],
  ]) {
    assert.match(upstreamSource(), pattern, `the upstream retry-policy source no longer has ${label}`)
  }
  // The delay schema has NO lower bound (only resolveBackoff rejects <= 0). The
  // plugin encodes that gap as `.min(Number.MIN_VALUE)`, and CONTRACT.md says so.
  assert.doesNotMatch(
    /initialDelayMs: z\.number\(\)[^,]/.exec(upstreamSource())?.[0] ?? '',
    /\.min\(/,
    'the upstream delay schema gained a lower bound: revisit the Number.MIN_VALUE rationale in CONTRACT.md',
  )
})

await check('the three provider retry-policy addresses still exist in the DSH sources', () => {
  const files = {
    deepseek: join(checkout, 'packages/llm/llm-deepseek/src/config.ts'),
    account: join(checkout, 'packages/llm/llm-deepseek-account/src/config.ts'),
    piAiConfig: join(checkout, 'packages/llm/llm-pi-ai/src/config.ts'),
    piAiIndex: join(checkout, 'packages/llm/llm-pi-ai/src/index.ts'),
  }
  for (const [label, file] of Object.entries(files)) {
    assert.ok(existsSync(file), `the ${label} source ${file} does not exist`)
  }
  const deepseek = readFileSync(files.deepseek, 'utf8')
  const account = readFileSync(files.account, 'utf8')
  const piAiConfig = readFileSync(files.piAiConfig, 'utf8')
  const piAiIndex = readFileSync(files.piAiIndex, 'utf8')
  assert.match(deepseek, /retryPolicy: RetryPolicySchema\.volatile\(\),/, 'llm-deepseek no longer declares retryPolicy at its settings root')
  assert.match(account, /deepSeekConfigFields/, 'llm-deepseek-account no longer spreads the shared DeepSeek config fields')
  assert.match(account, /\.\.\.protocolFields,/, 'llm-deepseek-account no longer spreads protocolFields, so it may have lost retryPolicy')
  assert.match(piAiConfig, /retryPolicy: RetryPolicySchema,/, 'llm-pi-ai no longer declares retryPolicy in its provider profile')
  assert.match(piAiConfig, /providers: z\.dict\(profile\)\.default\(\{\}\)\.volatile\(\),/, 'llm-pi-ai no longer declares the providers dict')
  assert.match(piAiIndex, /settingsPath: \['providers', provider\],/, 'llm-pi-ai no longer addresses providers.<id> in its directory entry')
})

await check('MAX_TIMER_DELAY_MS is the same literal the plugin records', () => {
  const upstream = /export const MAX_TIMER_DELAY_MS\s*=\s*([\d_]+)/.exec(readFileSync(timeoutPath, 'utf8'))
  assert.ok(upstream !== null, 'the timeout package no longer exports MAX_TIMER_DELAY_MS')
  assert.equal(Number(upstream[1].replace(/_/g, '')), 2_147_483_647, 'MAX_TIMER_DELAY_MS changed upstream')
  assert.match(hostSource, /MAX_TIMER_DELAY_MS = 2_147_483_647/, 'index.js no longer records MAX_TIMER_DELAY_MS = 2_147_483_647')
  assert.equal(host.TUNE_OPTIONS.find(option => option.key === 'initialDelayMs').range.includes('2147483647'), true, 'the initialDelayMs range text lost the timer cap')
})

/* ══ 4. Config against the REAL schemastery ═══════════════════════════════ */

/** Read a schemastery-validated value (default materialization wraps it volatile). */
const volatileValue = value => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

await check('Config is a real schemastery object root carrying the six retry fields then the two fetch fields', () => {
  assert.equal(typeof host.Config, 'function', `Config is ${typeof host.Config}, not a schema`)
  assert.equal(host.Config.type, 'object', `Config.type is ${String(host.Config.type)}: volatileForm only descends an object root`)
  assert.equal(host.Config['~standard']?.vendor, 'schemastery', `the schema vendor is ${String(host.Config['~standard']?.vendor)}`)
  assert.deepEqual(
    Object.keys(host.Config.dict ?? {}),
    [...host.TUNE_KEYS, ...host.FETCH_KEYS],
    `Config.dict is not the six retry fields followed by the two fetch fields: ${JSON.stringify(Object.keys(host.Config.dict ?? {}))}`,
  )
})

await check('Config declares all six fields as volatile nodes with the frozen shapes and code defaults', () => {
  const expected = {
    mode: { type: 'union', meta: { default: 'normal' } },
    maxRetries: { type: 'number', meta: { step: 1, min: 0, max: Number.MAX_SAFE_INTEGER, default: 5 } },
    initialDelayMs: { type: 'number', meta: { min: Number.MIN_VALUE, max: 2_147_483_647, default: 500 } },
    maxDelayMs: { type: 'number', meta: { min: Number.MIN_VALUE, max: 2_147_483_647, default: 10_000 } },
    jitterRatio: { type: 'number', meta: { min: 0, max: 1, default: 0.1 } },
    retryableCodes: { type: 'array', meta: { min: 1 } },
  }
  for (const [key, shape] of Object.entries(expected)) {
    const node = host.Config.dict[key]
    assert.ok(node !== undefined, `Config has no "${key}" field`)
    assert.equal(node.meta?.volatile, true, `${key} is not .volatile(), so a settings edit would remount the row`)
    assert.equal(node.type, shape.type, `${key} is a ${String(node.type)} node, expected ${shape.type}`)
    for (const [metaKey, value] of Object.entries(shape.meta)) {
      assert.equal(node.meta?.[metaKey], value, `${key}.${metaKey} drifted: expected ${String(value)}, got ${String(node.meta?.[metaKey])}`)
    }
  }
  assert.deepEqual(plain(host.Config.dict.retryableCodes.meta.default), [...host.RETRYABLE_CODES], 'the retryableCodes schema default is not the five codes')
  assert.deepEqual(plain(host.Config.dict.retryableCodes.inner?.type ?? null), 'union', 'retryableCodes must be an array of union(const) allowlisted codes')
})

await check('the fetch leaves are volatile, nullable, bounded 0..2147483647, and carry no schema default', () => {
  for (const key of host.FETCH_KEYS) {
    const node = host.Config.dict[key]
    assert.ok(node !== undefined, `Config has no "${key}" field`)
    assert.equal(node.type, 'number', `${key} is a ${String(node.type)} node, expected number`)
    assert.equal(node.meta?.volatile, true, `${key} is not .volatile(), so a settings edit would remount the row`)
    assert.equal(node.meta?.step, 1, `${key} must refuse fractional milliseconds`)
    assert.equal(node.meta?.min, 0, `${key} must accept 0 (disabled)`)
    assert.equal(node.meta?.max, 2_147_483_647, `${key} max drifted to ${String(node.meta?.max)}`)
    assert.equal('default' in (node.meta ?? {}), false, `${key} must NOT carry a schema default: absent means unset`)
  }
  const parsed = host.Config({ headersTimeoutMs: null, bodyTimeoutMs: null })
  assert.equal(volatileValue(parsed.headersTimeoutMs), null, 'an explicit null fetch leaf must materialize as null')
  assert.equal(volatileValue(parsed.bodyTimeoutMs), null, 'an explicit null fetch leaf must materialize as null')
  assert.equal(volatileValue(host.Config({}).headersTimeoutMs), undefined, 'an absent fetch leaf must materialize as undefined, not a seeded timer')
})

await check('Config({}) materializes only the six retry defaults; the fetch leaves stay absent (unset)', () => {
  const parsed = host.Config({})
  const materialized = Object.fromEntries(
    Object.entries(parsed)
      .map(([key, value]) => [key, volatileValue(value)])
      .filter(([, value]) => value !== undefined),
  )
  assert.deepEqual(materialized, plain(host.DEFAULT_TUNE), `Config({}) materialized ${JSON.stringify(materialized)}`)
  assert.equal(volatileValue(parsed.headersTimeoutMs), undefined, 'Config({}) must leave headersTimeoutMs unset')
  assert.equal(volatileValue(parsed.bodyTimeoutMs), undefined, 'Config({}) must leave bodyTimeoutMs unset')
  assert.deepEqual(
    Object.keys(materialized).sort(),
    [...host.TUNE_KEYS].sort(),
    `Config({}) materialized a key outside the six retry defaults: ${JSON.stringify(Object.keys(materialized))}`,
  )
})

await check('the schema accepts every valid shape, including mode always and the boundary values', () => {
  const cases = [
    ['the code defaults', {}],
    ['mode always', { mode: 'always' }],
    ['maxRetries 0', { maxRetries: 0 }],
    ['maxRetries MAX_SAFE_INTEGER', { maxRetries: Number.MAX_SAFE_INTEGER }],
    ['delays of 1 ms', { initialDelayMs: 1, maxDelayMs: 1 }],
    ['delays of Number.MIN_VALUE', { initialDelayMs: Number.MIN_VALUE, maxDelayMs: Number.MIN_VALUE }],
    ['delays at the timer cap', { initialDelayMs: 2_147_483_647, maxDelayMs: 2_147_483_647 }],
    ['jitter 0', { jitterRatio: 0 }],
    ['jitter 1', { jitterRatio: 1 }],
    ['one code', { retryableCodes: ['SERVER'] }],
    ['all five codes', { retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] }],
  ]
  for (const [label, input] of cases) {
    assert.doesNotThrow(() => host.Config(input), `Config must accept ${label}`)
  }
})

await check('Config accepts every offered code, refuses non-offered codes, and keeps the five-code default', () => {
  for (const code of host.OFFERED_RETRYABLE_CODES) {
    assert.doesNotThrow(() => host.Config({ retryableCodes: [code] }), `Config must accept the offered code ${code}`)
  }
  assert.doesNotThrow(() => host.Config({ retryableCodes: [...host.OFFERED_RETRYABLE_CODES] }), 'Config must accept the full ten-code list')
  assert.deepEqual(plain(host.Config.dict.retryableCodes.meta.default), [...host.RETRYABLE_CODES], 'the schema default must stay the five codes')
  assert.deepEqual(plain(volatileValue(host.Config({}).retryableCodes)), [...host.RETRYABLE_CODES], 'Config({}) must materialize exactly the five-code default, never the offered ten')
  for (const unknown of ['AUTH', 'CONTEXT_WINDOW_EXCEEDED', 'OVERLOADED', 'NOPE']) {
    assert.throws(() => host.Config({ retryableCodes: [unknown] }), `Config must refuse the non-offered code ${unknown}`)
  }
})

await check('the schema refuses a bad mode, a bad retry limit, and out-of-range delays or jitter', () => {
  for (const [label, input] of [
    ['mode often', { mode: 'often' }],
    ['maxRetries -1', { maxRetries: -1 }],
    ['maxRetries 1.5', { maxRetries: 1.5 }],
    ['maxRetries 1e21', { maxRetries: 1e21 }],
    ['initialDelayMs 0', { initialDelayMs: 0 }],
    ['initialDelayMs -5', { initialDelayMs: -5 }],
    ['initialDelayMs 2147483648', { initialDelayMs: 2_147_483_648 }],
    ['maxDelayMs 0', { maxDelayMs: 0 }],
    ['maxDelayMs 2147483648', { maxDelayMs: 2_147_483_648 }],
    ['jitterRatio -0.1', { jitterRatio: -0.1 }],
    ['jitterRatio 1.1', { jitterRatio: 1.1 }],
  ]) {
    assert.throws(() => host.Config(input), `Config must refuse ${label}`)
  }
})

await check('the schema refuses an empty, unknown, or non-array code list', () => {
  for (const [label, input] of [
    ['an empty list', { retryableCodes: [] }],
    ['an unknown code', { retryableCodes: ['NOPE'] }],
    ['a non-string code', { retryableCodes: ['SERVER', 42] }],
    ['a bare string', { retryableCodes: 'SERVER' }],
  ]) {
    assert.throws(() => host.Config(input), `Config must refuse ${label}`)
  }
})

await check('duplicate codes are accepted by Config and refused by validateTune (a documented deviation)', () => {
  // schemastery cannot express "unique array", so the schema is deliberately
  // wider than validateTune here. The page never submits duplicates.
  assert.doesNotThrow(() => host.Config({ retryableCodes: ['SERVER', 'SERVER'] }), 'Config was expected to accept duplicates')
  assert.deepEqual([...host.validateTune({ retryableCodes: ['SERVER', 'SERVER'] })], ['retryableCodes'], 'validateTune must refuse duplicate codes')
})

await check('schemastery bounds are not a finiteness check: NaN slips through Config, so validateTune refuses it', () => {
  // A schemastery `.min()/.max()` comparison is false for NaN, so the Host
  // schema admits NaN. The page's own parser and validateTune are what stop it.
  // Pinned here so a schema change in either direction is noticed.
  assert.doesNotThrow(() => host.Config({ initialDelayMs: Number.NaN }), 'the schemastery NaN behaviour changed: revisit CONTRACT.md')
  assert.deepEqual([...host.validateTune({ initialDelayMs: Number.NaN })], ['initialDelayMs'], 'validateTune must refuse a NaN delay')
})

await check('the fetch schema accepts unset, absent, 0 (disabled), and both boundary integers', () => {
  for (const [label, input] of [
    ['both leaves absent', {}],
    ['both leaves explicitly null (unset)', { headersTimeoutMs: null, bodyTimeoutMs: null }],
    ['the unset boundary values', { headersTimeoutMs: undefined, bodyTimeoutMs: null }],
    ['0 on both leaves (disabled)', { headersTimeoutMs: 0, bodyTimeoutMs: 0 }],
    ['a 30-minute value', { headersTimeoutMs: 1_800_000, bodyTimeoutMs: 1_800_000 }],
    ['the timer cap', { headersTimeoutMs: 2_147_483_647, bodyTimeoutMs: 2_147_483_647 }],
    ['one leaf set, the other unset', { headersTimeoutMs: 500 }],
  ]) {
    assert.doesNotThrow(() => host.Config(input), `Config must accept ${label}`)
  }
  assert.equal(volatileValue(host.Config({ headersTimeoutMs: 0 }).headersTimeoutMs), 0, '0 must remain 0 (disabled), never fall back to unset')
  assert.equal(volatileValue(host.Config({ headersTimeoutMs: 2_147_483_647 }).headersTimeoutMs), 2_147_483_647, 'the timer cap must be accepted verbatim')
})

await check('the fetch schema refuses negative, fractional, overflow, string, boolean, and object values', () => {
  for (const [label, input] of [
    ['a negative timeout', { headersTimeoutMs: -1 }],
    ['a fractional timeout', { headersTimeoutMs: 1.5 }],
    ['a timeout above the timer cap', { headersTimeoutMs: 2_147_483_648 }],
    ['a stringified number', { headersTimeoutMs: '0' }],
    ['a boolean', { headersTimeoutMs: true }],
    ['an object', { headersTimeoutMs: {} }],
    ['a negative body timeout', { bodyTimeoutMs: -1 }],
    ['a fractional body timeout', { bodyTimeoutMs: 0.5 }],
    ['a body timeout above the timer cap', { bodyTimeoutMs: 2_147_483_648 }],
  ]) {
    assert.throws(() => host.Config(input), `Config must refuse ${label}`)
  }
})

/* ══ 5. validateTune, the cross-field guard ════════════════════════════════ */

await check('validateTune accepts the defaults, a partial tune, and every boundary value', () => {
  const cases = [
    ['no argument', undefined],
    ['an empty object', {}],
    ['null', null],
    ['undefined fields', { mode: undefined, maxRetries: undefined }],
    ['a partial tune', { maxRetries: 3 }],
    ['mode always', { mode: 'always', maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, retryableCodes: ['SERVER'] }],
    ['the largest retry limit', { maxRetries: Number.MAX_SAFE_INTEGER }],
    ['the timer cap on both delays', { initialDelayMs: 2_147_483_647, maxDelayMs: 2_147_483_647 }],
    ['jitter one', { jitterRatio: 1 }],
    ['all five codes', { retryableCodes: [...host.RETRYABLE_CODES] }],
  ]
  for (const [label, input] of cases) {
    assert.deepEqual([...host.validateTune(input)], [], `validateTune must accept ${label}`)
  }
})

await check('validateTune accepts every offered code and refuses non-offered, empty, duplicate, and non-string lists', () => {
  for (const code of host.OFFERED_RETRYABLE_CODES) {
    assert.deepEqual([...host.validateTune({ retryableCodes: [code] })], [], `validateTune must accept the offered code ${code}`)
  }
  assert.deepEqual([...host.validateTune({ retryableCodes: [...host.OFFERED_RETRYABLE_CODES] })], [], 'validateTune must accept the full offered list')
  for (const [label, codes] of [
    ['a non-offered permanent-failure code (AUTH)', ['AUTH']],
    ['CONTEXT_WINDOW_EXCEEDED', ['CONTEXT_WINDOW_EXCEEDED']],
    ['OVERLOADED', ['OVERLOADED']],
    ['an empty list', []],
    ['a duplicate list', ['SERVER', 'SERVER']],
    ['a non-string entry', ['SERVER', 42]],
  ]) {
    assert.deepEqual([...host.validateTune({ retryableCodes: codes })], ['retryableCodes'], `validateTune must refuse ${label}`)
  }
})

await check('validateTune reports the stable per-field problem codes', () => {
  const cases = [
    ['mode', { mode: 'often' }, 'mode'],
    ['maxRetries negative', { maxRetries: -1 }, 'maxRetries'],
    ['maxRetries fractional', { maxRetries: 1.5 }, 'maxRetries'],
    ['maxRetries unsafe', { maxRetries: 1e21 }, 'maxRetries'],
    ['maxRetries string', { maxRetries: '5' }, 'maxRetries'],
    ['initialDelayMs zero', { initialDelayMs: 0 }, 'initialDelayMs'],
    ['initialDelayMs negative', { initialDelayMs: -1 }, 'initialDelayMs'],
    ['initialDelayMs NaN', { initialDelayMs: Number.NaN }, 'initialDelayMs'],
    ['initialDelayMs infinite', { initialDelayMs: Number.POSITIVE_INFINITY }, 'initialDelayMs'],
    ['initialDelayMs above the cap', { maxDelayMs: 2_147_483_648 }, 'maxDelayMs'],
    ['maxDelayMs zero', { maxDelayMs: 0 }, 'maxDelayMs'],
    ['jitterRatio negative', { jitterRatio: -0.1 }, 'jitterRatio'],
    ['jitterRatio above one', { jitterRatio: 1.1 }, 'jitterRatio'],
    ['jitterRatio NaN', { jitterRatio: Number.NaN }, 'jitterRatio'],
    ['codes empty', { retryableCodes: [] }, 'retryableCodes'],
    ['codes unknown', { retryableCodes: ['NOPE'] }, 'retryableCodes'],
    ['codes duplicate', { retryableCodes: ['SERVER', 'SERVER'] }, 'retryableCodes'],
    ['codes not an array', { retryableCodes: 'SERVER' }, 'retryableCodes'],
  ]
  for (const [label, input, code] of cases) {
    assert.deepEqual([...host.validateTune(input)], [code], `validateTune missed ${label}`)
  }
})

await check('the delay-order rule is reported only when both delays are individually valid', () => {
  assert.deepEqual([...host.validateTune({ initialDelayMs: 20_000, maxDelayMs: 10_000 })], ['delayOrder'], 'the cross-field order rule was not reported')
  assert.deepEqual([...host.validateTune({ initialDelayMs: 10_000, maxDelayMs: 10_000 })], [], 'an equal pair is valid')
  // An invalid maxDelay is reported as its own field, never as delayOrder.
  assert.deepEqual([...host.validateTune({ initialDelayMs: 20_000, maxDelayMs: 0 })], ['maxDelayMs'], 'an invalid maxDelay must not also report delayOrder')
  assert.deepEqual([...host.validateTune({ initialDelayMs: 0, maxDelayMs: 10_000 })], ['initialDelayMs'], 'an invalid initialDelay must not also report delayOrder')
})

await check('validateTune accumulates problems in field order, returns a frozen array, and never throws', () => {
  const all = host.validateTune({ mode: 'x', maxRetries: -1, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 9, retryableCodes: [] })
  assert.deepEqual([...all], ['mode', 'maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio', 'retryableCodes'], `the problem order drifted: ${JSON.stringify(all)}`)
  assert.equal(Object.isFrozen(all), true, 'validateTune must return a frozen array')
  assert.equal(Object.isFrozen(host.validateTune({})), true, 'the empty result must be frozen too')
  for (const input of [null, undefined, 'x', 42, [], { retryableCodes: null }, { mode: Symbol('mode') }]) {
    assert.doesNotThrow(() => host.validateTune(input), `validateTune threw for ${String(input)}`)
    assert.equal(Array.isArray(host.validateTune(input)), true, 'validateTune must always return an array')
  }
})

/* ══ 6. apply(), the host half ═════════════════════════════════════════════ */

/**
 * Build a fake Host context carrying both inject jobs and the lifecycle seats:
 * `settings` (which the row suppression needs) plus `connection`/`webServer`
 * (which the manual-retry channel needs), a fiber, `effect`, and `on`.
 * @param options - `configure` overrides the settings.configure body (may
 *   throw); `logger` seeds the optional logger; `browser` is false to mimic a
 *   headless Host whose `connection`/`webServer` inject is never satisfied;
 *   `lifecycle` is false to drop `effect`/`on` (the offline-double path).
 * @returns the context, the recorded calls, and the fiber.
 */
function hostApplyContext({ configure, logger, browser = true, lifecycle = true, requestRejection } = {}) {
  const calls = {
    injects: [], ctxEffects: [], injectedEffects: [], configures: [], warnings: [],
    listeners: [], route: undefined,
  }
  const fiber = { __fiber: true }
  const log = logger ?? {
    warn(message) { calls.warnings.push(String(message)) },
    info() {},
  }
  const services = {
    settings: {
      configure(presentation, owner) {
        calls.configures.push({ presentation, owner })
        if (typeof configure === 'function') return configure()
        return () => {}
      },
    },
    connection: { requestRejection: typeof requestRejection === 'function' ? requestRejection : () => undefined },
    webServer: {
      register(registration) {
        calls.route = { path: registration.path, kind: registration.kind, handler: registration.handler, disposed: false }
        return () => { calls.route.disposed = true }
      },
    },
  }
  const makeChild = () => ({
    effect(callback, label) {
      const dispose = callback()
      assert.equal(typeof dispose, 'function', 'every injected effect must return a disposer')
      calls.injectedEffects.push({ label, dispose })
      return dispose
    },
    settings: services.settings,
    connection: services.connection,
    webServer: services.webServer,
    get(service) { return services[service] },
  })
  const ctx = {
    fiber,
    logger: log,
    get(service) { return service === 'logger' ? log : undefined },
    inject(servicesList, callback) {
      calls.injects.push(servicesList)
      // Cordis invokes the callback only when every dependency is served.
      if (servicesList.includes('settings') || browser) callback(makeChild())
      return makeChild()
    },
  }
  if (lifecycle) {
    ctx.effect = (callback, label) => {
      const dispose = callback()
      calls.ctxEffects.push({ label, dispose })
      return dispose
    }
    ctx.on = (event, listener) => {
      const entry = { event, listener }
      calls.listeners.push(entry)
      return () => { calls.listeners = calls.listeners.filter(candidate => candidate !== entry) }
    }
  }
  return { ctx, calls, fiber }
}

await check('apply injects settings and the browser services, suppressing the generated form and mounting the retry seats', () => {
  const { ctx, calls, fiber } = hostApplyContext()
  host.apply(ctx)
  assert.deepEqual(calls.injects, [['settings'], ['connection', 'webServer']], `apply injected ${JSON.stringify(calls.injects)}`)
  assert.deepEqual(
    calls.ctxEffects.map(entry => entry.label),
    ['llm-api-call-tuning: fetch timeouts', 'llm-api-call-tuning: manual-retry listener'],
    `the fiber-owned effects drifted: ${JSON.stringify(calls.ctxEffects.map(entry => entry.label))}`,
  )
  assert.equal(calls.injectedEffects.length, 2, `the injected effects drifted to ${calls.injectedEffects.length}`)
  assert.equal(calls.configures.length, 1, `settings.configure was called ${calls.configures.length} times`)
  assert.deepEqual(calls.configures[0].presentation, { auto: false }, 'the auto-generated settings form was not suppressed')
  assert.equal(calls.configures[0].owner, fiber, 'settings.configure must receive the row fiber')
  assert.equal(calls.listeners.filter(entry => entry.event === 'agent/request-error').length, 1, 'the agent/request-error listener was not registered')
  assert.equal(calls.route?.kind, 'prefix', 'the manual-retry channel was not mounted as a prefix route')
  assert.equal(calls.route?.path, '/llm-api-call-tuning', `the manual-retry channel path drifted to ${String(calls.route?.path)}`)
  assert.equal(typeof calls.route?.handler, 'function', 'the manual-retry channel has no handler')
})

await check('a configure() refusal warns and still returns a disposer; a host without a logger is tolerated', () => {
  const logger = { last: undefined, warn(message) { this.last = message } }
  const refusing = hostApplyContext({ configure() { throw new Error('already configured') }, logger })
  assert.doesNotThrow(() => host.apply(refusing.ctx), 'apply must not fail boot when the page suppression is refused')
  assert.match(String(logger.last), /llm-api-call-tuning: the automatic settings page could not be suppressed: already configured/, `the warning drifted: ${String(logger.last)}`)

  const bare = hostApplyContext({ configure() { throw 'denied' } })
  assert.doesNotThrow(() => host.apply(bare.ctx), 'apply must not assume a logger')
})

await check('with no lifecycle effects or loader events, apply() still boots, mounts the channel, and never throws', () => {
  // This fake context has no `ctx.on` and no `ctx.effect`: the fetch-timeout
  // reconcile and the listener registration run inline (the latter is a no-op
  // without `on`), while the channel still mounts through its inject.
  const { ctx, calls } = hostApplyContext({ lifecycle: false })
  assert.doesNotThrow(() => host.apply(ctx), 'apply() threw without lifecycle seats')
  assert.deepEqual(calls.injects, [['settings'], ['connection', 'webServer']], 'apply injected other services')
  assert.equal(calls.ctxEffects.length, 0, 'an effect was mounted without a lifecycle seat')
  assert.equal(calls.configures.length, 1, 'apply configured the settings service more than once')
  assert.deepEqual(calls.warnings, [], `apply warned although both fetch values are unset: ${JSON.stringify(calls.warnings)}`)
})

/* ══ 6b. apply(), the process-wide fetch-timeout dispatcher ═══════════════ */

/**
 * Resolve the Host's real `undici` with the same anchors `index.js` uses, so
 * the dispatcher checks can read and replace the process-wide dispatcher. This
 * mirrors `hostAnchors()` rather than importing undici as a dependency (the
 * bundle ships none).
 * @returns {object|undefined} undici, or undefined when the checkout does not
 *   expose it (in which case the dispatcher checks fail loudly).
 */
function resolveUndiciForChecks() {
  const anchors = [import.meta.url, process.argv[1]]
  if (checkout !== '') anchors.push(join(checkout, 'node_modules', '.pnpm', 'node_modules', '__dsh_plugin_anchor__.js'))
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || anchor.length === 0) continue
    try {
      const loaded = createRequire(anchor)('undici')
      if (typeof loaded?.getGlobalDispatcher === 'function'
        && typeof loaded?.setGlobalDispatcher === 'function'
        && typeof loaded?.EnvHttpProxyAgent === 'function') {
        return loaded
      }
    } catch {
      // The next anchor may resolve it.
    }
  }
  return undefined
}

/** The Host's real undici, used as the process-wide dispatcher of the checks. */
const undici = resolveUndiciForChecks()

/**
 * A fake global dispatcher that records the options it is asked to dispatch.
 * @returns the fake dispatcher.
 */
function fakeDispatcher() {
  return {
    calls: [],
    dispatch(options) { this.calls.push(options); return Promise.resolve() },
    close() { return Promise.resolve() },
  }
}

/**
 * A minimal Host context with the lifecycle seats the fetch-timeout effect
 * needs: `inject` for the settings job, and `effect`/`on` for the dispatcher
 * job. Every disposer and listener is tracked so a check can tear the state
 * down (and so "the listener detaches only on dispose" is observable).
 * @param config - the config passed to `apply()` (the fallback when there is no
 *   fiber; a fiber's own `config` wins, exactly like the host half).
 * @param fiber - an optional fiber whose live config drives re-reads.
 * @returns the context, its recorded state, a `run()` applying the config, and
 *   a disposer.
 */
function dispatcherHostContext(config = {}, fiber = undefined) {
  const state = { warnings: [], infos: [], listeners: [], disposers: [], effectLabels: [], route: undefined }
  const logger = { warn(message) { state.warnings.push(message) }, info(message) { state.infos.push(message) } }
  const child = {
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
    settings: { configure() { return () => {} } },
    connection: { requestRejection: () => undefined },
    webServer: {
      register(registration) {
        state.route = { path: registration.path, kind: registration.kind, disposed: false }
        return () => { state.route.disposed = true }
      },
    },
    get(service) { return service === 'logger' ? logger : (service === 'connection' ? this.connection : undefined) },
  }
  const ctx = {
    fiber,
    get(service) { return service === 'logger' ? logger : undefined },
    inject(services, callback) { callback(child); return child },
    effect(callback, label) {
      state.effectLabels.push(label)
      const dispose = callback()
      state.disposers.push(dispose)
      return dispose
    },
    on(event, listener) {
      const entry = { event, listener }
      state.listeners.push(entry)
      return () => { state.listeners = state.listeners.filter(candidate => candidate !== entry) }
    },
  }
  const dispose = () => {
    for (const teardown of state.disposers.splice(0).reverse()) {
      try {
        teardown()
      } catch {
        // A second uninstall is a no-op; keep the check's cleanup best-effort.
      }
    }
  }
  return { ctx, state, dispose, run: () => host.apply(ctx, config) }
}

await check('the dispatcher checks can resolve the Host\'s real undici (a loud prerequisite, never a skip)', () => {
  assert.ok(undici !== undefined, `undici is not resolvable through ${checkout}: the dispatcher checks cannot run`)
  assert.equal(typeof undici.getGlobalDispatcher, 'function', 'undici exposes no getGlobalDispatcher')
  assert.equal(typeof undici.setGlobalDispatcher, 'function', 'undici exposes no setGlobalDispatcher')
})

await check('apply() with both fetch values unset touches no dispatcher and still watches both reload events', () => {
  const original = undici.getGlobalDispatcher()
  const { state, dispose, run } = dispatcherHostContext({}, undefined)
  try {
    run()
    assert.equal(undici.getGlobalDispatcher(), original, 'an all-unset apply() replaced the global dispatcher')
    assert.deepEqual(state.listeners.map(entry => entry.event), ['loader/volatile-update', 'app-boot/config-reload', 'agent/request-error'], 'the reload listeners plus the retry listener were not registered')
    assert.equal(state.effectLabels.includes('llm-api-call-tuning: fetch timeouts'), true, `the fetch-timeout effect label drifted: ${JSON.stringify(state.effectLabels)}`)
    assert.equal(state.effectLabels.includes('llm-api-call-tuning: manual-retry listener'), true, `the manual-retry listener effect is missing: ${JSON.stringify(state.effectLabels)}`)
    assert.equal(state.route?.path, '/llm-api-call-tuning', 'the manual-retry channel did not mount next to the dispatcher job')
    assert.deepEqual(state.warnings, [], `apply() with both values unset warned: ${JSON.stringify(state.warnings)}`)
  } finally {
    dispose()
    undici.setGlobalDispatcher(original)
  }
  assert.deepEqual(state.listeners, [], 'dispose() did not detach the two reload listeners and the retry listener')
  assert.equal(undici.getGlobalDispatcher(), original, 'dispose() changed the global dispatcher although nothing was installed')
})

await check('a numeric fetch value installs a wrapper that fills only a nullish per-request timeout, and 0 is a real value', async () => {
  const original = undici.getGlobalDispatcher()
  const previous = fakeDispatcher()
  undici.setGlobalDispatcher(previous)
  const { state, dispose, run } = dispatcherHostContext({ headersTimeoutMs: 0, bodyTimeoutMs: 1_500 }, undefined)
  try {
    run()
    const wrapper = undici.getGlobalDispatcher()
    assert.notEqual(wrapper, previous, 'a numeric fetch value did not install the dispatcher wrapper')

    await wrapper.dispatch({}, {})
    assert.deepEqual(previous.calls[0], { headersTimeout: 0, bodyTimeout: 1_500 }, 'the wrapper did not fill both nullish timeouts (0 must pass through as disabled)')

    await wrapper.dispatch({ headersTimeout: 42, bodyTimeout: null }, {})
    assert.deepEqual(previous.calls[1], { headersTimeout: 42, bodyTimeout: 1_500 }, 'a per-request value must win and only nullish options are filled')

    await wrapper.dispatch({ headersTimeout: 0 }, {})
    assert.deepEqual(previous.calls[2], { headersTimeout: 0, bodyTimeout: 1_500 }, 'an explicit per-request 0 must not be overwritten')
  } finally {
    dispose()
    undici.setGlobalDispatcher(original)
  }
  assert.deepEqual(state.warnings, [], `the dispatcher install warned: ${JSON.stringify(state.warnings)}`)
})

await check('a live value change is re-read without reinstalling, clearing restores the previous dispatcher, and re-enabling installs again', async () => {
  const original = undici.getGlobalDispatcher()
  const previous = fakeDispatcher()
  undici.setGlobalDispatcher(previous)
  const fiber = { config: { headersTimeoutMs: 300 } }
  const { state, dispose, run } = dispatcherHostContext({}, fiber)
  try {
    run()
    const wrapper = undici.getGlobalDispatcher()
    assert.notEqual(wrapper, previous, 'the first value did not install the wrapper')
    assert.equal(state.listeners.length, 3, 'the reload listeners plus the retry listener are missing')

    await wrapper.dispatch({}, {})
    assert.deepEqual(previous.calls[0], { headersTimeout: 300 }, 'an unset body timeout must stay absent so the dispatcher default applies')

    fiber.config = { headersTimeoutMs: 75 }
    for (const entry of [...state.listeners]) entry.listener()
    assert.equal(undici.getGlobalDispatcher(), wrapper, 'a value change reinstalled the wrapper instead of re-reading it')
    await wrapper.dispatch({}, {})
    assert.deepEqual(previous.calls[1], { headersTimeout: 75 }, 'the wrapper did not pick up the changed live value')

    fiber.config = { headersTimeoutMs: null, bodyTimeoutMs: null }
    for (const entry of [...state.listeners]) entry.listener()
    assert.equal(undici.getGlobalDispatcher(), previous, 'clearing both values did not restore the previous dispatcher')
    assert.equal(state.listeners.length, 3, 'clearing the values detached a listener (a later live save must still install)')

    fiber.config = { bodyTimeoutMs: 0 }
    for (const entry of [...state.listeners]) entry.listener()
    const reinstalled = undici.getGlobalDispatcher()
    assert.notEqual(reinstalled, previous, 're-enabling a cleared value did not install the wrapper again')
    await reinstalled.dispatch({}, {})
    assert.deepEqual(previous.calls[2], { bodyTimeout: 0 }, '0 must be installed as a real "disabled" value')
  } finally {
    dispose()
    undici.setGlobalDispatcher(original)
  }
  assert.deepEqual(state.warnings, [], `the live re-read path warned: ${JSON.stringify(state.warnings)}`)
})

await check('dispose() restores the previous dispatcher only while ours is still the current one', () => {
  const original = undici.getGlobalDispatcher()
  const previous = fakeDispatcher()
  undici.setGlobalDispatcher(previous)
  const { dispose, run } = dispatcherHostContext({ headersTimeoutMs: 250 }, undefined)
  try {
    run()
    const ours = undici.getGlobalDispatcher()
    assert.notEqual(ours, previous, 'the wrapper was not installed')
    const newer = fakeDispatcher()
    undici.setGlobalDispatcher(newer)
    dispose()
    assert.equal(undici.getGlobalDispatcher(), newer, 'dispose() replaced a dispatcher installed after ours')
  } finally {
    dispose()
    undici.setGlobalDispatcher(original)
  }
})

await check('NODE_USE_ENV_PROXY installs an EnvHttpProxyAgent as the wrapped target', () => {
  const original = undici.getGlobalDispatcher()
  const previous = fakeDispatcher()
  undici.setGlobalDispatcher(previous)
  const hadProxyFlag = process.env.NODE_USE_ENV_PROXY
  process.env.NODE_USE_ENV_PROXY = '1'
  const { dispose, run } = dispatcherHostContext({ headersTimeoutMs: 100 }, undefined)
  try {
    run()
    const wrapper = undici.getGlobalDispatcher()
    assert.notEqual(wrapper, previous, 'the wrapper was not installed with NODE_USE_ENV_PROXY set')
    assert.equal(Object.getPrototypeOf(wrapper)?.constructor?.name, 'EnvHttpProxyAgent', 'the wrapper did not target an EnvHttpProxyAgent')
  } finally {
    dispose()
    if (hadProxyFlag === undefined) delete process.env.NODE_USE_ENV_PROXY
    else process.env.NODE_USE_ENV_PROXY = hadProxyFlag
    undici.setGlobalDispatcher(original)
  }
})

await check('an unresolvable undici warns once and never throws (isolated process; the module caches the failure)', () => {
  const script = `
import * as host from ${JSON.stringify(pathToFileURL(join(here, 'index.js')).href)}
const symbol = Symbol.for('undici.globalDispatcher.2')
const before = globalThis[symbol]
const warnings = []
const events = []
const settingsChild = { effect(callback) { return callback() }, settings: { configure() { return () => {} } } }
const browserChild = {
  effect(callback) { return callback() },
  connection: { requestRejection: () => undefined },
  webServer: { register() { return () => {} } },
}
const ctx = {
  inject(services, callback) { const child = services.includes('settings') ? settingsChild : browserChild; callback(child); return child },
  effect(callback) { return callback() },
  on(event, listener) { events.push([event, listener]); return () => {} },
  get(service) { return service === 'logger' ? { warn(message) { warnings.push(message) }, info() {} } : undefined },
}
let threw = null
try { host.apply(ctx, { headersTimeoutMs: 100, bodyTimeoutMs: 0 }) } catch (error) { threw = String(error && error.message ? error.message : error) }
for (const [, listener] of events) listener()
console.log(JSON.stringify({
  threw,
  warnings,
  events: events.map(([event]) => event),
  dispatcherUnchanged: before === globalThis[symbol],
}))
`
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: here,
    encoding: 'utf8',
    env: { ...process.env, DSH_HARNESS_CHECKOUT: '' },
  })
  const result = JSON.parse(output.trim().split('\n').pop())
  assert.equal(result.threw, null, `apply() threw without undici: ${String(result.threw)}`)
  assert.equal(result.warnings.length, 1, `the missing-undici warning must run once per instance, got ${JSON.stringify(result.warnings)}`)
  assert.match(result.warnings[0], /undici could not be resolved from the Host/, `the missing-undici warning drifted: ${String(result.warnings[0])}`)
  assert.deepEqual(result.events, ['loader/volatile-update', 'app-boot/config-reload', 'agent/request-error'], 'the reload listeners plus the retry listener were not registered without undici')
  assert.equal(result.dispatcherUnchanged, true, 'apply() changed a process-wide dispatcher although undici was unresolvable')
})

/* ══ 7. docs: identity, tables, operation shapes, limits ══════════════════ */

const readme = read('README.md')
const readmeZh = read('README.zh.md')
const contract = read('CONTRACT.md')

/**
 * Markdown table rows whose header line contains `headerNeedle`, keyed by the
 * header cell text.
 * @param markdown - the document.
 * @param headerNeedle - a substring of the target table's header row.
 * @returns the header cells plus one object per body row.
 */
function markdownTable(markdown, headerNeedle) {
  const lines = markdown.split('\n')
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

/** Strip markdown emphasis and quoting so a cell can be compared to plain text. */
const plainCell = text => text.replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim()

/** Every number token in a piece of text. */
const numberTokens = text => new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number))

const ALL_OPTIONS = [...host.TUNE_OPTIONS, ...host.FETCH_OPTIONS]

await check('README.md and CONTRACT.md name every owned field and their default cells carry the host defaultText', () => {
  for (const [file, text] of [['README.md', readme], ['CONTRACT.md', contract]]) {
    for (const option of ALL_OPTIONS) {
      assert.ok(text.includes(`\`${option.key}\``), `${file} does not name the option ${option.key}`)
    }
  }
  const tables = [
    ['README.md', markdownTable(readme, 'Code default'), 'Code default'],
    ['CONTRACT.md', markdownTable(contract, 'Code default'), 'Code default'],
  ]
  for (const [file, table, defaultColumn] of tables) {
    assert.ok(table.rows.length >= ALL_OPTIONS.length, `${file}: only ${table.rows.length} field rows`)
    const keyColumn = table.header[0]
    for (const option of ALL_OPTIONS) {
      const row = table.rows.find(candidate => plainCell(candidate[keyColumn] ?? '') === option.key)
      assert.ok(row !== undefined, `${file} has no field-table row for ${option.key}`)
      assert.equal(
        plainCell(row[defaultColumn] ?? ''),
        plainCell(option.defaultText),
        `${file} default cell for ${option.key} does not carry "${option.defaultText}": ${String(row[defaultColumn])}`,
      )
    }
  }
})

await check('the README "Accepts" and CONTRACT range cells carry every host range number', () => {
  const tables = [
    ['README.md', markdownTable(readme, 'Code default'), 'Accepts'],
    ['CONTRACT.md', markdownTable(contract, 'Code default'), 'Range (enforced by)'],
  ]
  for (const [file, table, rangeColumn] of tables) {
    const keyColumn = table.header[0]
    for (const option of ALL_OPTIONS) {
      const row = table.rows.find(candidate => plainCell(candidate[keyColumn] ?? '') === option.key)
      assert.ok(row !== undefined, `${file} has no field-table row for ${option.key}`)
      const cell = plainCell(row[rangeColumn] ?? '')
      for (const number of numberTokens(option.range)) {
        assert.ok(numberTokens(cell).has(number), `${file} range cell for ${option.key} never mentions the host range number ${number}: ${cell}`)
      }
      if (option.kind === 'mode') assert.ok(/normal/.test(cell) && /always/.test(cell), `${file} mode range cell must name both modes: ${cell}`)
      if (option.kind === 'retryableCodes') assert.ok(/non-empty/.test(cell) && /unique/.test(cell), `${file} code range cell must state non-empty and unique: ${cell}`)
      if (option.kind === 'optionalNonNegativeIntegerMs') {
        assert.match(cell, /unset/i, `${file} fetch range cell for ${option.key} must say the value may be unset: ${cell}`)
        assert.match(cell, /disabl/i, `${file} fetch range cell for ${option.key} must say 0 disables the timer: ${cell}`)
      }
    }
  }
})

await check('README.zh.md carries the two fetch rows with an unset default and the full range', () => {
  const table = markdownTable(readmeZh, '代码默认值')
  const keyColumn = table.header[0]
  const rangeColumn = table.header[2]
  const defaultColumn = table.header[3]
  for (const option of host.FETCH_OPTIONS) {
    const row = table.rows.find(candidate => plainCell(candidate[keyColumn] ?? '') === option.key)
    assert.ok(row !== undefined, `README.zh.md has no field-table row for ${option.key}`)
    const defaultCell = plainCell(row[defaultColumn] ?? '')
    assert.match(defaultCell, /unset/i, `README.zh.md default cell for ${option.key} does not carry "unset": ${defaultCell}`)
    assert.match(defaultCell, /未设置/, `README.zh.md default cell for ${option.key} does not say 未设置: ${defaultCell}`)
    const rangeCell = plainCell(row[rangeColumn] ?? '')
    for (const number of numberTokens(option.range)) {
      assert.ok(numberTokens(rangeCell).has(number), `README.zh.md range cell for ${option.key} never mentions ${number}: ${rangeCell}`)
    }
    assert.match(rangeCell, /禁用/, `README.zh.md range cell for ${option.key} must say 0 禁用: ${rangeCell}`)
  }
})

await check('CONTRACT.md documents the identity, addresses, and exact operation shapes', () => {
  for (const token of [
    'dsh-llm-api-call-tuning', 'llm-api-call-tuning', 'settings.section', 'order: 45',
    'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai',
    "['retryPolicy']", "['providers', <id>, 'retryPolicy']",
    "'retryPolicy', 'mode'", "'retryPolicy', 'maxRetries'", "'retryPolicy', 'retryableCodes'",
    "'retryPolicy', 'backoff', 'initialDelayMs'", "'retryPolicy', 'backoff', 'maxDelayMs'",
    "'retryPolicy', 'backoff', 'jitterRatio'",
    "unset [...settingsPath, 'retryPolicy']",
    'settings/rejected', 'validateTune', 'delayOrder', 'source of truth', 'preset',
    'CLI flag', 'environment variable', 'auto: false', 'source of truth',
  ]) {
    assert.ok(contract.includes(token), `CONTRACT.md does not document ${JSON.stringify(token)}`)
  }
  for (const option of ALL_OPTIONS) {
    assert.ok(contract.includes(`\`${option.key}\``), `CONTRACT.md does not name the config field ${option.key}`)
  }
})

await check('CONTRACT.md documents the fetch-timeout host surface, apply(ctx, config), and the exact unset op shapes', () => {
  for (const token of [
    'DEFAULT_FETCH', 'FETCH_KEYS', 'FETCH_OPTIONS', 'apply(ctx, config)', 'installFetchTimeouts',
    'undici', 'getGlobalDispatcher', 'setGlobalDispatcher', 'EnvHttpProxyAgent',
    'loader/volatile-update', 'app-boot/config-reload', 'process-wide',
    'two process-wide fetch fields',
  ]) {
    assert.ok(contract.includes(token), `CONTRACT.md does not document ${JSON.stringify(token)}`)
  }
  for (const [label, pattern] of [
    ['the fetch Save path', /"path": \["headersTimeoutMs"\]/],
    ['the body Save path', /"path": \["bodyTimeoutMs"\]/],
    ['the headers unset op', /"op": "unset", "path": \["headersTimeoutMs"\]/],
    ['the body unset op', /"op": "unset", "path": \["bodyTimeoutMs"\]/],
    ['the dispatcher restoration rule', /restor\w*[\s\S]{0,120}(?:still current|current dispatcher)/i],
    ['the no-dependency undici resolution', /resolve[sd]?[\s\S]{0,80}undici[\s\S]{0,120}(?:Host|profile)/i],
  ]) {
    assert.match(contract, pattern, `CONTRACT.md does not document ${label}`)
  }
  assert.doesNotMatch(contract, /no side effects/i, 'CONTRACT.md still claims apply() has no side effects')
  assert.doesNotMatch(contract, /apply\(\) (?:only|does nothing)/i, 'CONTRACT.md still claims apply() only suppresses the page')
})

await check('CONTRACT.md states the documented limitations', () => {
  for (const [label, pattern] of [
    ['the no-transaction caveat', /no cross-provider transaction/i],
    ['the home-patch/--patch refusal', /home[- ]patch[\s\S]{0,120}--patch/i],
    ['the in-flight caveat', /in-flight/i],
    ['the dormant-route caveat', /dormant/i],
    ['the npm note', /not published to any npm registry/i],
    ['the no-CLI/env/core-setting note', /environment variable/i],
    ['the MIT attribution pointer', /THIRD-PARTY-NOTICES\.md/],
    ['the upstream-adaptation note', /adapted from[\s\S]{0,80}dsh-fetch-timeouts|dsh-fetch-timeouts[\s\S]{0,120}MIT/i],
    ['the stopgap note', /stopgap/i],
    ['the no-offline-live-proof caveat', /cannot (?:confirm|prove)|not provable offline|deployment property/i],
  ]) {
    assert.match(contract, pattern, `CONTRACT.md does not state ${label}`)
  }
})

await check('README.md and README.zh.md document install, the page location, the field table, and the npm note', () => {
  for (const [file, text] of [['README.md', readme], ['README.zh.md', readmeZh]]) {
    assert.ok(text.includes('pnpm dsh plugin --profile web add link:'), `${file} does not state the workspace install command`)
    assert.ok(text.includes('plugin_manager'), `${file} does not offer the plugin_manager alternative`)
    assert.ok(text.includes('dsh-llm-api-call-tuning'), `${file} does not name the bundle`)
    assert.match(text, /order 45/, `${file} does not state the nav order`)
    assert.match(text, /npm/, `${file} does not carry the npm note`)
    for (const option of ALL_OPTIONS) {
      assert.ok(text.includes(`\`${option.key}\``), `${file} does not name the field ${option.key}`)
    }
  }
  for (const token of ['9007199254740991', '2147483647', '10000', '0.1']) {
    assert.ok(readmeZh.includes(token), `README.zh.md does not state the default/range value ${token}`)
  }
  assert.ok(readmeZh.includes('LLM API 调用调优'), 'README.zh.md does not name the page')
  assert.ok(readme.includes('LLM API call tuning'), 'README.md does not name the page')
})

await check('all three docs state the tri-state fetch contract: unset = no behavior change, 0 = disabled', () => {
  for (const [file, text, unsetPattern, disabledPattern, freshPattern] of [
    ['README.md', readme, /unset/i, /0[^.]{0,48}disabl/i, /fresh install/i],
    ['README.zh.md', readmeZh, /unset/i, /禁用/, /全新安装/],
    ['CONTRACT.md', contract, /unset/i, /0[^.]{0,48}disabl/i, /fresh install/i],
  ]) {
    assert.match(text, unsetPattern, `${file} does not use the word "unset" for the empty fetch state`)
    assert.match(text, disabledPattern, `${file} does not state that 0 disables the timer`)
    assert.match(text, freshPattern, `${file} does not describe the fresh-install (unset) behavior`)
  }
  assert.match(readme, /no behavior change/i, 'README.md does not say an unset timer leaves behavior unchanged')
  assert.match(readmeZh, /不改变[^。]*行为|行为[^。]*不改变/, 'README.zh.md does not say an unset timer leaves behavior unchanged')
  assert.doesNotMatch(readme, /unset[^.]{0,80}1800000/, 'README.md implies an unset timer seeds the 1800000 ms preset')
})

await check('both READMEs and CONTRACT.md state the process-wide blast radius of the fetch timers', () => {
  for (const [file, text, searchPattern, serverPattern] of [
    ['README.md', readme, /web search/i, /HTTP MCP/],
    ['README.zh.md', readmeZh, /联网搜索/, /HTTP MCP/],
    ['CONTRACT.md', contract, /web search/i, /HTTP MCP/],
  ]) {
    assert.match(text, searchPattern, `${file} does not name web search among the affected clients`)
    assert.match(text, serverPattern, `${file} does not name HTTP MCP servers among the affected clients`)
  }
  assert.match(readme, /process-wide/i, 'README.md does not call the fetch timers process-wide')
  assert.match(readmeZh, /进程级/, 'README.zh.md does not call the fetch timers process-level')
  assert.match(contract, /process-wide/i, 'CONTRACT.md does not call the fetch timers process-wide')
})

await check('the docs point at the MIT attribution and state the stopgap and no-offline-live-proof caveats', () => {
  for (const [file, text] of [['README.md', readme], ['README.zh.md', readmeZh], ['CONTRACT.md', contract]]) {
    assert.ok(text.includes('THIRD-PARTY-NOTICES.md'), `${file} does not point at THIRD-PARTY-NOTICES.md`)
  }
  assert.match(contract, /MIT/, 'CONTRACT.md does not name the MIT license of the adapted upstream')
  assert.match(contract, /dsh-fetch-timeouts/, 'CONTRACT.md does not name the upstream project')
  assert.match(readme, /stopgap/i, 'README.md does not describe the dispatcher wrapper as a stopgap')
  assert.match(readmeZh, /过渡方案|临时方案/, 'README.zh.md does not describe the dispatcher wrapper as a stopgap')
  assert.match(readme, /live GUI|does not start|offline/i, 'README.md does not caveat that the live dispatcher is not proven offline')
  assert.match(contract, /cannot (?:confirm|prove)|not provable offline|deployment property/i, 'CONTRACT.md does not caveat the offline limits')
})

await check('the docs describe the real refusal path and mark managed-elsewhere as defensive-only', () => {
  // S1: ConfigForm resolves every Host refusal to `false`, so the generic copy is
  // the only observable one; the managed branch must never be described as reachable.
  for (const [file, text] of [['CONTRACT.md', contract], ['README.md', readme], ['README.zh.md', readmeZh]]) {
    assert.ok(/generic refusal/i.test(text) || /通用拒绝/.test(text), `${file} does not name the generic refusal copy`)
  }
  assert.ok(/defensive/i.test(contract) && /unreachable/i.test(contract), 'CONTRACT.md does not mark the managed branch defensive-only and unreachable')
  assert.ok(/defensive/i.test(readme), 'README.md does not mark the managed branch defensive-only')
  assert.ok(/防御/.test(readmeZh), 'README.zh.md does not mark the managed branch defensive-only')
  assert.doesNotMatch(contract, /settings RPC rejects|rejects with code `settings\/rejected`/i, 'CONTRACT.md still claims the managed copy is reachable through a rejection')
})

const PROVIDER_TIMEOUT_DOC_OPTIONS = host.PROVIDER_TIMEOUT_OPTIONS

await check('all three docs name every provider-timeout field with its namespace, default, and range', () => {
  for (const [file, text] of [['README.md', readme], ['README.zh.md', readmeZh], ['CONTRACT.md', contract]]) {
    for (const option of PROVIDER_TIMEOUT_DOC_OPTIONS) {
      assert.ok(text.includes(`\`${option.key}\``), `${file} does not name the provider-timeout field ${option.key}`)
    }
    for (const token of ['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account', 'providers.<route>', '2147483647']) {
      assert.ok(text.includes(token), `${file} does not document the provider-timeout address/range token ${token}`)
    }
  }
  for (const token of ['300000', '600000', '60000']) {
    assert.ok(readme.includes(token), `README.md does not state the provider-timeout default ${token}`)
    assert.ok(readmeZh.includes(token), `README.zh.md does not state the provider-timeout default ${token}`)
    assert.ok(contract.includes(token), `CONTRACT.md does not state the provider-timeout default ${token}`)
  }
  assert.match(readmeZh, /\u7559\u7a7a|\u672a\u8bbe\u7f6e/, 'README.zh.md does not describe the blank/unset provider-timeout state')
  assert.match(contract, /unset/i, 'CONTRACT.md does not use "unset" for the provider-timeout blank state')

  // Row-wise check of the three provider-timeout tables: every field row must
  // carry its own namespaces, pointer, code default, and accepted range. A
  // token-presence check alone once let a wrong "Namespace / path" cell pass.
  const timeoutTables = [
    {
      label: 'README.md',
      table: markdownTable(readme, 'Namespace / path'),
      field: 'Field',
      ns: 'Applies to',
      path: 'Namespace / path',
      default: 'Default',
      accepts: 'Accepts',
      nsInPath: true,
      unset: /unset/i,
    },
    {
      label: 'README.zh.md',
      table: markdownTable(readmeZh, '\u547d\u540d\u7a7a\u95f4 / \u8def\u5f84'),
      field: '\u5b57\u6bb5',
      ns: '\u9002\u7528\u8def\u7531',
      path: '\u547d\u540d\u7a7a\u95f4 / \u8def\u5f84',
      default: '\u9ed8\u8ba4\u503c',
      accepts: '\u63a5\u53d7\u8303\u56f4',
      nsInPath: true,
      unset: /\u672a\u8bbe\u7f6e/,
    },
    {
      label: 'CONTRACT.md',
      table: markdownTable(contract, '\u0060settingsPath\u0060 + leaf'),
      field: 'Field',
      ns: '\u0060settingsNs\u0060',
      path: '\u0060settingsPath\u0060 + leaf',
      default: 'Code default',
      accepts: 'Accepted by the page',
      nsInPath: false,
      unset: /unset/i,
    },
  ]
  for (const spec of timeoutTables) {
    for (const option of PROVIDER_TIMEOUT_DOC_OPTIONS) {
      const row = spec.table.rows.find(candidate => plainCell(candidate[spec.field] ?? '') === option.key)
      assert.ok(row !== undefined, `${spec.label} has no provider-timeout table row for ${option.key}`)
      const nsCell = plainCell(row[spec.ns] ?? '')
      const pathCell = plainCell(row[spec.path] ?? '')
      for (const scope of option.scopes) {
        const addressCell = spec.nsInPath ? pathCell : nsCell
        assert.ok(
          addressCell.includes(scope.ns),
          `${spec.label} ${option.key} row does not name the namespace ${scope.ns} in its address: ${addressCell}`,
        )
        if (scope.pathTemplate[0] === 'providers') {
          assert.ok(
            /providers/.test(pathCell) && /<route>/.test(pathCell),
            `${spec.label} ${option.key} row does not show the providers.<route> path: ${pathCell}`,
          )
        }
      }
      const defaultCell = plainCell(row[spec.default] ?? '')
      if (option.default === null) {
        assert.match(defaultCell, spec.unset, `${spec.label} ${option.key} default cell does not say unset: ${defaultCell}`)
      } else {
        assert.ok(
          defaultCell.includes(String(option.default)),
          `${spec.label} ${option.key} default cell does not carry ${String(option.default)}: ${defaultCell}`,
        )
      }
      const acceptsCell = plainCell(row[spec.accepts] ?? '')
      for (const number of numberTokens(option.range)) {
        assert.ok(
          numberTokens(acceptsCell).has(number),
          `${spec.label} ${option.key} accepts cell never mentions the range number ${number}: ${acceptsCell}`,
        )
      }
    }
  }
})

await check('the docs explain the provider-timeout table: blank default, 0 refusal, and the Unlimited cap', () => {
  for (const [file, text] of [['README.md', readme], ['README.zh.md', readmeZh], ['CONTRACT.md', contract]]) {
    assert.match(text, /0[^.]{0,60}(?:refus|reject|not allowed|\u62d2\u7edd)/i, `${file} does not state that 0 is refused for provider timeouts`)
    assert.match(text, /2147483647/, `${file} does not state the Unlimited cap`)
  }
  assert.match(readme, /24\.8 days|about 24\.8/i, 'README.md does not explain the 2147483647 ms cap as about 24.8 days')
  assert.match(readmeZh, /24\.8/, 'README.zh.md does not explain the 2147483647 ms cap as about 24.8 days')
  assert.match(contract, /24\.8 days/i, 'CONTRACT.md does not explain the 2147483647 ms cap as about 24.8 days')
  assert.match(readme, /a limit, not an off switch|cap.*not.*off switch/i, 'README.md does not say the Unlimited preset is a limit, not an off switch')
  assert.match(readmeZh, /\u4e0a\u9650\uff0c\u4e0d\u662f\u5173\u95ed\u5f00\u5173/, 'README.zh.md does not say the Unlimited preset is a cap, not an off switch')
  assert.match(contract, /a limit, not an off switch|cap.*not.*(?:off switch|disable)/i, 'CONTRACT.md does not say the Unlimited preset is a limit, not an off switch')
})

await check('the docs state that a direct settings.mutate can still persist 0 and fail the route load', () => {
  for (const [file, text] of [['README.md', readme], ['README.zh.md', readmeZh], ['CONTRACT.md', contract]]) {
    assert.match(text, /settings\.mutate/i, `${file} does not name the direct settings.mutate bypass`)
    assert.match(text, /0/, `${file} does not relate the bypass to a zero timeout`)
    assert.match(text, /(?:load[- ]time assert|fails? the provider|load failure|\u52a0\u8f7d\u671f\u65ad\u8a00|\u65e0\u6cd5\u89e3\u6790|\u5931\u8d25)/i, `${file} does not state that a persisted 0 breaks the route load`)
  }
})

await check('the docs explain the SDK/transport timeout interplay and the 300000 ms stream-idle diagnosis', () => {
  for (const [file, text] of [['README.md', readme], ['README.zh.md', readmeZh], ['CONTRACT.md', contract]]) {
    assert.match(text, /streamIdleTimeoutMs/, `${file} does not name the idle watchdog in the interplay note`)
    assert.match(text, /300000|300 000/, `${file} does not mention the 300000 ms default in the diagnosis`)
    assert.match(text, /TTFT|first token|\u9996\u4e2a token/i, `${file} does not identify the slow-first-token (TTFT) cause`)
    assert.match(text, /bodyTimeoutMs/, `${file} does not mention the transport body timeout in the interplay note`)
  }
  assert.match(readme, /response headers/i, 'README.md does not explain that the SDK timeout bounds response headers')
  assert.match(contract, /response headers/i, 'CONTRACT.md does not explain that the SDK timeout bounds response headers')
})

await check('the docs state the active-only/timeout materialization guard and the connectTimeout out-of-scope fix', () => {
  for (const [file, text] of [['README.md', readme], ['README.zh.md', readmeZh], ['CONTRACT.md', contract]]) {
    assert.match(text, /(?:dormant|\u4f11\u7720)/i, `${file} does not state the dormant-route guard`)
    assert.match(text, /materializ|\u751f\u6210\u4e0d\u5b8c\u6574|\u4e0d\u5b8c\u6574\u7684\u63d0\u4f9b\u65b9/i, `${file} does not explain why a dormant write is blocked (partial profile materialization)`)
    assert.match(text, /connectTimeoutMs/, `${file} does not name connectTimeoutMs as out of scope`)
    assert.match(text, /packages\/util\/http-proxy\/src\/install\.ts/, `${file} does not point at the upstream connect-timeout fix location`)
  }
})

await check('CONTRACT.md documents the provider-timeout host surface, namespaces, and exact op shapes', () => {
  for (const token of [
    'PROVIDER_TIMEOUT_FIELDS', 'PROVIDER_TIMEOUT_KEYS', 'PROVIDER_TIMEOUT_OPTIONS',
    'Provider timeout fields (per-route, provider-owned)',
  ]) {
    assert.ok(contract.includes(token), `CONTRACT.md does not document ${JSON.stringify(token)}`)
  }
  for (const option of PROVIDER_TIMEOUT_DOC_OPTIONS) {
    assert.ok(contract.includes(option.key), `CONTRACT.md does not document the provider-timeout key ${option.key}`)
    assert.ok(contract.includes(option.range) || /0.*refus/i.test(contract), `CONTRACT.md does not pin the range/refusal of ${option.key}`)
  }
  for (const [label, pattern] of [
    ['the pi-ai stream-idle set path', /"path": \["providers", "openrouter", "streamIdleTimeoutMs"\]/],
    ['the pi-ai request-timeout set path', /"path": \["providers", "openrouter", "timeoutMs"\]/],
    ['the deepseek stream-idle root path', /"path": \["streamIdleTimeoutMs"\]/],
    ['the deepseek files-api root path', /"path": \["filesApiTimeoutMs"\]/],
    ['the timeout unset op', /"op": "unset", "path": \["providers", "<route>", "timeoutMs"\]/],
    ['the never-whole-provider rule', /whole `providers` dict set/],
  ]) {
    assert.match(contract, pattern, `CONTRACT.md does not document ${label}`)
  }
})

await check('the locale metadata descriptions mention the provider timeouts in both languages', () => {
  assert.match(localeEn.meta.description, /provider timeouts/i, 'locale/en.json meta.description does not mention provider timeouts')
  assert.match(localeZh.meta.description, /\u63d0\u4f9b\u65b9\u8d85\u65f6/, 'locale/zh.json meta.description does not mention provider timeouts')
})

/* ══ 8. client registration and copy ═══════════════════════════════════════ */

await check('apply registers the dock FIRST, then exactly one settings.section, with the frozen ids/order/label/locale', () => {
  const loadingOwn = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', loadingSnapshot) })
  const { ctx, registration } = mountPage({ forms: loadingOwn })
  assert.deepEqual(ctx.state.injections, ['conversation.input.dock', 'settings.section'], `slots.inject was called with ${JSON.stringify(ctx.state.injections)}`)
  assert.equal(ctx.state.registered.length, 2, `apply registered ${ctx.state.registered.length} slots before the namespace was ready`)
  const dock = dockRegistration(ctx)
  assert.equal(dock.options.name, 'conversation.input.dock', `the dock slot name drifted to ${String(dock.options.name)}`)
  assert.equal(dock.options.id, 'manual-retry', `the dock id drifted to ${String(dock.options.id)}`)
  assert.equal(dock.options.order, 20, `the dock order drifted to ${String(dock.options.order)}`)
  assert.equal(dock.options.locale, 'llm-api-call-tuning', `the dock locale NS drifted to ${String(dock.options.locale)}`)
  assert.equal(registration.options.name, 'settings.section', `the settings slot name drifted to ${String(registration.options.name)}`)
  assert.equal(registration.options.id, 'llm-api-call-tuning', `the section id drifted to ${String(registration.options.id)}`)
  assert.equal(registration.options.order, 45, `the section order drifted to ${String(registration.options.order)}`)
  assert.equal(typeof registration.options.label, 'function', 'the section label must be a thunk: a plain string would not follow the locale revision')
  assert.equal(registration.options.label(), EN.nav, 'the nav label does not resolve through the dictionary')
  assert.equal(registration.options.locale, 'llm-api-call-tuning', `the locale NS drifted to ${String(registration.options.locale)}`)
  assert.equal(ctx.state.effects[0], 'dsh-llm-api-call-tuning: dictionaries', `the dictionary effect label drifted to ${String(ctx.state.effects[0])}`)
  assert.equal(ctx.state.dictionaries.length, 1, `apply registered ${ctx.state.dictionaries.length} dictionaries`)
  assert.equal(ctx.state.dictionaries[0].ns, 'llm-api-call-tuning', 'the dictionary NS drifted')
})

await check('the en and zh dictionaries carry the same 131-key set and every statically referenced key resolves', () => {
  const en = COPY.en
  const zh = COPY.zh
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'the en and zh dictionaries do not carry identical key SETS')
  assert.equal(Object.keys(en).length, 131, `the per-language dictionary key count drifted to ${Object.keys(en).length}`)
  /* Static audit: every key the client can hand to its translate helper must
   * resolve in BOTH languages. Three sources are unioned so a new call site
   * cannot slip through:
   * 1. literal `t('key')` calls;
   * 2. table-driven template families, expanded from the frozen metadata;
   * 3. dot-namespaced string literals (keys stored in maps and passed
   *    indirectly, e.g. `errors.maxRetries = 'error.maxRetries'`), except the
   *    two slot/service identifiers this module also spells with dots. */
  const RETRY_NUMERIC_KEYS = ['maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio']
  const FETCH_KEY_NAMES = ['headersTimeoutMs', 'bodyTimeoutMs']
  const TIMEOUT_KEY_NAMES = ['streamIdleTimeoutMs', 'timeoutMs', 'filesApiTimeoutMs']
  const ALL_FIELD_KEYS = [...RETRY_NUMERIC_KEYS, ...FETCH_KEY_NAMES, ...TIMEOUT_KEY_NAMES]
  const templateFamilies = [
    { template: 'mode.${mode}', values: ['normal', 'always'] },
    { template: 'code.${code}', values: [...host.OFFERED_RETRYABLE_CODES] },
    { template: 'field.${field.key}.label', values: ALL_FIELD_KEYS },
    { template: 'field.${field.key}.unit', values: [...RETRY_NUMERIC_KEYS, ...FETCH_KEY_NAMES] },
    { template: 'field.${field.key}.description', values: ALL_FIELD_KEYS },
    { template: 'field.${field.key}.default', values: RETRY_NUMERIC_KEYS },
    { template: 'apply.outcome.${applyOutcomes[rowKey(row)]}', values: ['saved', 'refused', 'managed', 'skipped'] },
  ]
  const referenced = new Set()
  for (const match of clientSource.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) referenced.add(match[2])
  const templatesFound = new Set()
  for (const match of clientSource.matchAll(/\bt\(\s*`([^`]*)`\s*\)/g)) templatesFound.add(match[1])
  const knownTemplates = new Set(templateFamilies.map(family => family.template))
  for (const template of templatesFound) {
    if (template.includes('${')) {
      assert.ok(knownTemplates.has(template), `the static dictionary audit needs an expansion for t(\`${template}\`)`)
    }
  }
  for (const family of templateFamilies) {
    assert.ok(templatesFound.has(family.template), `the static dictionary audit lost the template family ${family.template}`)
    for (const value of family.values) {
      referenced.add(family.template.replace(/\$\{[^}]+\}/, value))
    }
  }
  const allowed = new Set(['remote.llm', 'settings.section', 'conversation.input.dock'])
  for (const match of clientSource.matchAll(/'([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
    if (!allowed.has(match[1])) referenced.add(match[1])
  }
  assert.equal(referenced.size, 131, `the static reference set drifted to ${referenced.size} keys; update the audit when the page gains a call site`)
  const missing = [...referenced].filter(key => typeof en[key] !== 'string' || typeof zh[key] !== 'string').sort()
  assert.deepEqual(missing, [], `the client references dictionary keys missing from en/zh: ${JSON.stringify(missing)}`)
  /* Copy quality: English carries no CJK; every value in both languages is a
   * non-empty string. */
  const cjk = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/
  for (const [key, copy] of Object.entries(en)) {
    assert.equal(typeof copy, 'string', `en.${key} is not a string`)
    assert.ok(copy.length > 0, `en.${key} is blank`)
    assert.ok(!cjk.test(copy), `the English dictionary value for "${key}" contains CJK text: ${copy}`)
  }
  for (const [key, copy] of Object.entries(zh)) {
    assert.equal(typeof copy, 'string', `zh.${key} is not a string`)
    assert.ok(copy.length > 0, `zh.${key} is blank`)
  }
  /* The user-facing families the merged page depends on must be named. */
  for (const key of [
    'nav', 'title', 'intro', 'global.heading', 'global.retriesHeading', 'global.save',
    'global.saving', 'global.note', 'defaults.description', 'defaults.applyAll', 'defaults.applying',
    'defaults.applyAllNote', 'providers.heading', 'providers.description', 'providers.loading',
    'providers.unavailable', 'providers.error', 'providers.empty', 'routes.pickerLabel',
    'routes.pickerPlaceholder', 'routes.add', 'routes.allListed', 'routes.empty',
    'routes.retryHeading', 'routes.timeoutsHeading', 'routes.pickedHint',
    'provider.namespace', 'provider.source.override', 'provider.source.default',
    'provider.status.dormant', 'provider.status.noSettings', 'provider.status.unavailable',
    'provider.useDefaults', 'provider.reset', 'provider.save', 'provider.saving',
    'provider.resetting', 'provider.alwaysNote',
    'field.mode.label', 'field.maxRetries.label', 'field.initialDelayMs.label',
    'field.maxDelayMs.label', 'field.jitterRatio.label', 'field.retryableCodes.label',
    'mode.normal', 'mode.always',
    'code.EMPTY_RESPONSE', 'code.RATE_LIMIT', 'code.SERVER', 'code.TIMEOUT', 'code.TRANSPORT',
    'code.STREAM_CLOSED', 'code.MALFORMED_RESPONSE', 'code.PI_AI_ERROR', 'code.HTTP_408', 'code.HTTP_409',
    'status.loading', 'status.unavailable', 'status.readOnly', 'status.saved', 'status.reset',
    'status.routeReset', 'status.fetchReset', 'error.refused', 'error.managed',
    'fetch.heading', 'fetch.description', 'fetch.reset', 'fetch.resetting', 'fetch.placeholder',
    'fetch.hint', 'field.headersTimeoutMs.label', 'field.bodyTimeoutMs.label',
    'timeouts.unit', 'timeouts.hint', 'timeouts.unlimited', 'timeouts.protocol',
    'timeouts.protocol.catalog', 'timeouts.advisory.sdkFirst', 'timeouts.advisory.transportFirst',
    'field.streamIdleTimeoutMs.label', 'field.timeoutMs.label', 'field.filesApiTimeoutMs.label',
    'error.streamIdleTimeoutMs', 'error.timeoutMs', 'error.filesApiTimeoutMs',
    'apply.outcome.saved', 'apply.outcome.refused', 'apply.outcome.managed', 'apply.outcome.skipped',
    'manualRetry.aria', 'manualRetry.title', 'manualRetry.retry', 'manualRetry.dismiss',
    'manualRetry.attempt', 'manualRetry.expired',
  ]) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en is missing the key "${key}"`)
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh is missing the key "${key}"`)
  }
})

await check('the injected face carries exactly the four members, and the page ignores the shell close prop', () => {
  const { face } = mountPage()
  assert.deepEqual(Object.keys(face).sort(), ['form', 'getForm', 'readProviders', 't'], `the injected face drifted: ${JSON.stringify(Object.keys(face))}`)
  assert.equal(typeof face.form.subscribe, 'function', 'the face form is not a config form')
  assert.equal(typeof face.getForm, 'function', 'the face has no getForm')
  assert.equal(typeof face.readProviders, 'function', 'the face has no readProviders')
  assert.equal(typeof face.t, 'function', 'the face has no translate function')
  const ctx = fakeContext()
  clientPlugin.apply(ctx)
  const registration = settingsRegistration(ctx)
  const injected = registration.options.inject()
  assert.doesNotThrow(
    () => react.mount(registration.component, { ...injected, close: () => { throw new Error('close must not be called') } }),
    'the page called the shell close prop',
  )
})

await check('a direct apply() without ctx.configForms registers the dock but no settings page (belt-and-braces; real compositions park the fiber first)', () => {
  const ctx = fakeContext()
  Object.defineProperty(ctx, 'configForms', { value: undefined })
  assert.doesNotThrow(() => clientPlugin.apply(ctx), 'apply threw without configForms')
  assert.equal(ctx.state.registered.filter(entry => entry.options?.name === 'settings.section').length, 0, 'a settings.section was registered without configForms')
  assert.equal(ctx.state.registered.filter(entry => entry.options?.name === 'conversation.input.dock').length, 1, 'the dock must register even without configForms')
  assert.equal(ctx.state.dictionaries.length, 1, 'the dictionaries should still be registered')
})

/* ══ 9. the merged page render ═════════════════════════════════════════════ */

await check('the page renders ONE global card (retries + fetch timeouts) and ONE combined per-route section', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const cards = sectionCards(page.tree)
  assert.equal(cards.length, 2, `the merged page must render exactly 2 section.dlct-card tiers, got ${cards.length}`)
  assert.deepEqual(
    findAll(page.tree, node => node.type === 'h3').map(node => directText(node)),
    [EN['global.heading'], EN['providers.heading']],
    'the two card headings drifted',
  )
  assert.ok(
    firstIndex(page.tree, node => node === cards[0]) < firstIndex(page.tree, node => node === cards[1]),
    'the global card must precede the per-route section',
  )
  const global = cards[0]
  assert.deepEqual(
    findAll(global, node => node.type === 'h4').map(node => directText(node)),
    [EN['global.retriesHeading'], EN['fetch.heading']],
    'the global card must carry the Retries AND Fetch timeouts sub-groups',
  )
  assert.equal(modeSelect(global).props.value, 'normal', 'the global mode is not seeded from the snapshot')
  assert.deepEqual(retryInputs(global).map(input => input.props.value), ['5', '500', '10000', '0.1'], 'the global retry controls are not seeded from the defaults')
  assert.equal(codeCheckboxes(global).length, host.OFFERED_RETRYABLE_CODES.length, `the global card rendered ${codeCheckboxes(global).length} code checkboxes, expected one per offered code`)
  assert.deepEqual(codeCheckboxes(global).map(box => box.props.checked), [true, true, true, true, true, false, false, false, false, false], 'the global card must check exactly the five defaults and leave the five opt-in codes unchecked')
  assert.deepEqual(fetchInputs(global).map(input => input.props.value), ['', ''], 'the shipped fetch draft must be empty (unset), never a seeded timer')
  assert.deepEqual(
    fetchInputs(global).map(input => input.props.placeholder),
    [EN['fetch.placeholder'], EN['fetch.placeholder']],
    'the fetch inputs lost the system-default placeholder',
  )
  assert.equal(textInputs(page.tree).length, 6, `the page root rendered ${textInputs(page.tree).length} text inputs (expected the global 4 retry + 2 fetch; route cards are child placeholders)`)
  const text = renderedText(page.tree)
  for (const key of ['title', 'intro', 'global.description', 'global.retriesHeading', 'global.note', 'defaults.description', 'defaults.applyAllNote', 'fetch.description', 'providers.description']) {
    assert.ok(text.includes(EN[key]), `the merged page is missing the "${key}" copy`)
  }
  for (const key of ['global.save', 'defaults.applyAll', 'fetch.reset']) {
    assert.ok(buttonWithText(page.tree, [EN[key]]) !== undefined, `the "${key}" action is missing from the global card`)
  }
  assert.deepEqual(
    ctx.state.formRequests,
    ['llm-api-call-tuning', 'llm-deepseek-account', 'llm-deepseek', 'llm-pi-ai'],
    `apply/mount requested forms ${JSON.stringify(ctx.state.formRequests)}`,
  )
})

await check('the default retryable-code state is exactly the five CHECKED and the five opt-in codes UNCHECKED', async () => {
  const base = mountPage()
  await flush()
  const global = codeCheckboxes(globalCard(base.page))
  assert.equal(global.length, host.OFFERED_RETRYABLE_CODES.length, `the global card rendered ${global.length} code checkboxes, expected one per offered code`)
  assert.deepEqual(global.map(box => box.props.checked), [true, true, true, true, true, false, false, false, false, false], 'the global default must check the five and leave the five opt-in codes unchecked')
  base.page.unmount()

  const forms = deviationForms({
    deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 7 } }, user: { retryPolicy: { maxRetries: 7 } } },
  })
  const route = mountPage({ forms })
  await flush()
  const card = mountRouteCard(route.page, 'deepseek-official')
  const boxes = codeCheckboxes(card.tree)
  assert.equal(boxes.length, host.OFFERED_RETRYABLE_CODES.length, `a default route rendered ${boxes.length} code checkboxes, expected one per offered code`)
  assert.deepEqual(boxes.map(box => box.props.checked), [true, true, true, true, true, false, false, false, false, false], 'a default/untouched route must check exactly the five defaults and NEVER the five opt-in codes')
  const routeText = renderedText(card.tree)
  for (const code of host.OFFERED_RETRYABLE_CODES) {
    assert.ok(routeText.includes(EN[`code.${code}`]), `the rendered card is missing the dictionary label for ${code}`)
  }
  card.unmount()
  route.page.unmount()
})

await check('the old separate "global defaults", "provider retry policies", "provider timeouts", and "fetch timeouts" cards are GONE', async () => {
  const { page } = mountPage()
  await flush()
  const sections = findAll(page.tree, node => node.type === 'section')
  assert.equal(sections.length, 2, `the page rendered ${sections.length} section nodes; the two separate per-route tiers must be gone`)
  for (const node of sections) assert.equal(node.props.className, 'dlct-card', `an unexpected section class survived: ${String(node.props.className)}`)
  assert.deepEqual(
    findAll(page.tree, node => node.type === 'h3').map(node => directText(node)),
    [EN['global.heading'], EN['providers.heading']],
    'a tier-level heading survived the merge',
  )
  for (const key of [
    'defaults.heading', 'defaults.note', 'defaults.save', 'defaults.saving',
    'timeouts.heading', 'timeouts.description', 'timeouts.note',
    'timeouts.save', 'timeouts.saving', 'timeouts.reset', 'timeouts.resetting', 'timeouts.resetDone',
    'fetch.save', 'fetch.saving', 'fetch.note', 'fetch.status.loading', 'fetch.status.unavailable',
  ]) {
    assert.equal(EN[key], undefined, `the removed tier-level dictionary key "${key}" is back`)
  }
  const text = renderedText(page.tree)
  for (const oldCopy of ['Global defaults', 'Provider timeouts', 'Save defaults', 'Save timeouts', 'Reset timeouts']) {
    assert.equal(text.includes(oldCopy), false, `the removed tier copy "${oldCopy}" is still rendered`)
  }
  assert.equal(buttonWithText(page.tree, [EN['timeouts.unlimited']]), undefined, 'a detached provider-timeout tier leaked a preset button')
})

await check('the ONE add-selector sits ABOVE the list, excludes listed routes, and exactly the deviating route renders', async () => {
  const { page } = mountPage()
  await flush()
  const picker = pickerSelect(page.tree)
  assert.ok(picker !== undefined, 'the per-route add-selector is missing')
  const cards = routeCardElements(page)
  assert.equal(cards.length, 1, `the page rendered ${cards.length} merged route cards, expected exactly one (openrouter deviates)`)
  assert.equal(cards[0].props.row.provider, 'openrouter', 'the listed card is not the deviating route')
  assert.ok(
    firstIndex(page.tree, node => node === picker) < firstIndex(page.tree, node => node === cards[0]),
    'the add-selector must sit ABOVE the route list',
  )
  assert.deepEqual(
    pickerOptions(page.tree),
    [EN['routes.pickerPlaceholder'], 'DeepSeek Account (deepseek-account)', 'DeepSeek (deepseek-official)'],
    'the selector options drifted: a listed route must be excluded',
  )
  assert.equal(picker.props.disabled, false, 'the selector disabled although non-listed routes are pickable')
  assert.equal(picker.props.value, '', 'the selector is not on the placeholder')
  assert.equal(buttonWithText(page.tree, [EN['routes.add']]).props.disabled, true, 'Add stayed enabled before a route is picked')

  const card = mountRouteCard(page, 'openrouter')
  assert.deepEqual(retryInputs(card.tree).map(input => input.props.value), ['2', '250', '5000', '0.2'], 'the merged card is not seeded from the effective retry policy')
  assert.equal(codeCheckboxes(card.tree).length, host.OFFERED_RETRYABLE_CODES.length, `the merged card rendered ${codeCheckboxes(card.tree).length} code checkboxes, expected one per offered code`)
  assert.deepEqual(codeCheckboxes(card.tree).map(box => box.props.checked), [false, true, false, false, false, false, false, false, false, false], 'the merged card did not select the stored RATE_LIMIT code, or it checked an opt-in code by default')
  assert.deepEqual(timeoutInputs(card.tree).map(input => input.props.value), ['', ''], 'an untouched timeout half must start blank')
  assert.deepEqual(
    findAll(card.tree, node => node.type === 'h5').map(node => directText(node)),
    [EN['routes.retryHeading'], EN['routes.timeoutsHeading']],
    'the merged card lost one of its two sub-groups',
  )
  assert.ok(renderedText(card.tree).includes(EN['provider.source.override']), 'the user-layer override badge is missing')
  for (const key of ['provider.save', 'provider.reset', 'provider.useDefaults']) {
    assert.ok(buttonWithText(card.tree, [EN[key]]) !== undefined, `the merged card is missing its "${key}" action`)
  }
  assert.equal(
    findAll(card.tree, node => node.type === 'div' && node.props.className === 'dlct-actions').length,
    1,
    'the merged card must have exactly ONE action row',
  )
  card.unmount()
})

await check('a stored retry policy EQUAL to the global values stays hidden but pickable, and a route without an override never renders', async () => {
  const equalForms = deviationForms({
    deepseek: { value: { retryPolicy: tuneValue() }, user: { retryPolicy: { mode: 'normal' } } },
  })
  const equal = mountPage({ forms: equalForms })
  await flush()
  assert.equal(routeCardElements(equal.page).length, 0, 'a stored-retry-equal route rendered a card')
  assert.deepEqual(
    pickerOptions(equal.page.tree),
    [EN['routes.pickerPlaceholder'], 'DeepSeek Account (deepseek-account)', 'DeepSeek (deepseek-official)', 'OpenRouter (openrouter)'],
    'an equal-to-global route must stay pickable',
  )
  assert.equal(pickerSelect(equal.page.tree).props.disabled, false, 'the selector disabled although routes are pickable')
  assert.ok(renderedText(equal.page.tree).includes(EN['routes.empty']), 'the empty-state line is missing when nothing deviates')
  equal.page.unmount()

  const base = mountPage()
  await flush()
  for (const provider of ['deepseek-official', 'deepseek-account']) {
    assert.equal(
      routeCardElements(base.page).some(node => node.props.row.provider === provider),
      false,
      `a route with no stored overrides rendered a card: ${provider}`,
    )
  }
})

await check('a route deviating ONLY by a stored timeout field is listed, and its merged card shows retry AND timeout controls', async () => {
  const forms = deviationForms({ deepseek: { value: {}, user: { streamIdleTimeoutMs: 450_000 } } })
  const { page } = mountPage({ forms })
  await flush()
  const cards = routeCardElements(page)
  assert.equal(cards.length, 1, `the timeout-only route did not render exactly one card (got ${cards.length})`)
  assert.equal(cards[0].props.row.provider, 'deepseek-official', 'the timeout-only deviating route is missing')
  const card = mountRouteCard(page, 'deepseek-official')
  assert.deepEqual(timeoutInputs(card.tree).map(input => input.props.value), ['450000', ''], 'the timeout half is not seeded from the USER layer')
  assert.deepEqual(timeoutInputs(card.tree).map(input => input.props.placeholder), ['300000', '60000'], 'the DeepSeek timeout placeholders drifted')
  assert.deepEqual(retryInputs(card.tree).map(input => input.props.value), ['5', '500', '10000', '0.1'], 'a timeout-only route must still show its effective retry half')
  assert.deepEqual(
    findAll(card.tree, node => node.type === 'h5').map(node => directText(node)),
    [EN['routes.retryHeading'], EN['routes.timeoutsHeading']],
    'the timeout-only card lost a sub-group',
  )
  const text = renderedText(card.tree)
  assert.ok(text.includes(EN['provider.source.default']), 'the retry half must stay on the default badge')
  assert.ok(text.includes(EN['provider.source.override']), 'the stored timeout field lost its override badge')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled with no staged edit')
  card.unmount()
})

await check('the empty state renders when nothing deviates, and the all-listed note replaces the options when every route deviates', async () => {
  const empty = mountPage({ forms: deviationForms() })
  await flush()
  assert.equal(routeCardElements(empty.page).length, 0, 'a route rendered although nothing deviates')
  assert.ok(renderedText(empty.page.tree).includes(EN['routes.empty']), 'the empty-state line is missing')
  assert.equal(pickerSelect(empty.page.tree).props.disabled, false, 'the selector disabled although every route is pickable')
  assert.equal(renderedText(empty.page.tree).includes(EN['routes.allListed']), false, 'the all-listed note doubled up with the empty state')
  empty.page.unmount()

  const all = deviationForms({
    deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 3 } }, user: { retryPolicy: { maxRetries: 3 } } },
    account: { value: { retryPolicy: { mode: 'normal', maxRetries: 4 } }, user: { retryPolicy: { maxRetries: 4 } } },
    openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { mode: 'normal', maxRetries: 2 } } },
  })
  const full = mountPage({ forms: all })
  await flush()
  assert.deepEqual(
    routeCardElements(full.page).map(node => node.props.row.provider),
    ['deepseek-account', 'deepseek-official', 'openrouter'],
    'the all-listed card order drifted',
  )
  assert.equal(pickerSelect(full.page.tree).props.disabled, true, 'the selector stayed enabled although every route is listed')
  const fullText = renderedText(full.page.tree)
  assert.ok(fullText.includes(EN['routes.allListed']), 'the all-listed note is missing')
  assert.equal(fullText.includes(EN['routes.empty']), false, 'the empty state rendered while three routes deviate')
})

await check('picking a route materializes exactly ONE card prefilled from effective values and writes nothing; Reset closes it locally', async () => {
  const { page, ctx } = mountPage()
  await flush()
  pickerSelect(page.tree).props.onChange({ target: { value: 'llm-deepseek||deepseek-official' } })
  await flush()
  assert.equal(buttonWithText(page.tree, [EN['routes.add']]).props.disabled, false, 'Add stayed disabled after picking a route')
  buttonWithText(page.tree, [EN['routes.add']]).props.onClick()
  await flush()
  assert.deepEqual(
    routeCardElements(page).map(node => node.props.row.provider),
    ['deepseek-official', 'openrouter'],
    'picking a route did not add exactly one card',
  )
  assert.deepEqual(
    pickerOptions(page.tree),
    [EN['routes.pickerPlaceholder'], 'DeepSeek Account (deepseek-account)'],
    'the picked route stayed in the selector',
  )
  const card = mountRouteCard(page, 'deepseek-official')
  assert.ok(renderedText(card.tree).includes(EN['routes.pickedHint']), 'the picked-card hint is missing')
  assert.deepEqual(retryInputs(card.tree).map(input => input.props.value), ['5', '500', '10000', '0.1'], 'the picked card is not prefilled from the effective values')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled before an edit')
  assert.equal(ctx.configForms.get('llm-deepseek').calls.length, 0, 'picking a route wrote its namespace')
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 0, 'picking a route wrote a listed route namespace')
  buttonWithText(card.tree, [EN['provider.reset']]).props.onClick()
  await flush()
  assert.deepEqual(
    routeCardElements(page).map(node => node.props.row.provider),
    ['openrouter'],
    'Reset on a picked-but-unstored card did not close it locally',
  )
  assert.equal(ctx.configForms.get('llm-deepseek').calls.length, 0, 'closing a picked card wrote an unset')
  card.unmount()
})

await check('only addressable route candidates are offered: dormant and namespace-less providers never render, an unserved namespace shows its note', async () => {
  const registered = [...REGISTERED, { id: 'mystery', name: 'Mystery' }, { id: 'unserved', name: 'Unserved' }]
  const configurable = [
    ...CONFIGURABLE,
    { provider: 'dormant-route', displayName: 'Dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant-route'] },
    { provider: 'unserved', displayName: 'Unserved', settingsNs: 'llm-ghost', settingsPath: ['config'] },
  ]
  const forms = makeForms({ 'llm-ghost': new BoundForm('llm-ghost', unavailableSnapshot) })
  const { page } = mountPage({ forms, registered, configurable })
  await flush()
  assert.deepEqual(
    routeCardElements(page).map(node => node.props.row.provider),
    ['openrouter'],
    'a dormant or namespace-less route rendered a card',
  )
  const options = pickerOptions(page.tree)
  assert.equal(options.includes('Unserved (unserved)'), true, 'an addressable but unserved route was not offered')
  assert.equal(options.some(option => option.includes('Dormant')), false, 'a dormant route was offered in the selector')
  assert.equal(options.some(option => option.includes('Mystery')), false, 'a namespace-less route was offered in the selector')
  pickerSelect(page.tree).props.onChange({ target: { value: 'llm-ghost|config|unserved' } })
  await flush()
  buttonWithText(page.tree, [EN['routes.add']]).props.onClick()
  await flush()
  const card = mountRouteCard(page, 'unserved')
  assert.ok(renderedText(card.tree).includes(EN['provider.status.unavailable']), 'the unserved picked card lost its note')
  assert.equal(retryInputs(card.tree).length, 0, 'an unserved card rendered retry controls')
  assert.equal(timeoutInputs(card.tree).length, 0, 'an unserved card rendered timeout controls')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]), undefined, 'an unserved card rendered Save')
  card.unmount()
})

await check('the merged cards render in the joined rank order, seeded from each route effective value', async () => {
  const forms = deviationForms({
    account: { value: { retryPolicy: { mode: 'always' } }, user: { retryPolicy: { mode: 'always' } } },
    deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 3 } }, user: { retryPolicy: { mode: 'normal', maxRetries: 3 } } },
    openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { mode: 'normal', maxRetries: 2 } } },
  })
  const { page } = mountPage({ forms })
  await flush()
  assert.deepEqual(
    routeCardElements(page).map(node => node.props.row.provider),
    ['deepseek-account', 'deepseek-official', 'openrouter'],
    'the merged card order drifted from the joined rank order',
  )
  const official = mountRouteCard(page, 'deepseek-official')
  assert.deepEqual(retryInputs(official.tree).map(input => input.props.value), ['3', '500', '10000', '0.1'], 'the DeepSeek card is not seeded from its policy')
  assert.deepEqual(codeCheckboxes(official.tree).map(box => box.props.checked), [true, true, true, true, true, false, false, false, false, false], 'an absent stored code list must fall back to exactly the five defaults, never the offered ten')
  assert.ok(renderedText(official.tree).includes(EN['provider.source.override']), 'a stored retryPolicy did not paint the override badge')
  official.unmount()
  const account = mountRouteCard(page, 'deepseek-account')
  assert.equal(modeSelect(account.tree).props.value, 'always', 'the always-mode card is not seeded')
  assert.equal(codeCheckboxes(account.tree).length, 0, 'the always-mode card still rendered the normal-only code list')
  assert.ok(renderedText(account.tree).includes(EN['provider.alwaysNote']), 'the always-mode note is missing')
  account.unmount()
  const openrouter = mountRouteCard(page, 'openrouter')
  assert.deepEqual(retryInputs(openrouter.tree).map(input => input.props.value), ['2', '250', '5000', '0.2'], 'the pi-ai card is not seeded from its effective policy')
  assert.deepEqual(codeCheckboxes(openrouter.tree).map(box => box.props.checked), [false, true, false, false, false, false, false, false, false, false], 'the pi-ai code list drifted or an opt-in code was checked')
  openrouter.unmount()
})

await check('normalizeCodes fallbacks stay the five defaults: empty/unknown stored lists render five checked, a stored opt-in code round-trips', async () => {
  for (const [label, codes] of [
    ['an empty stored list', []],
    ['an all-unknown stored list', ['AUTH', 'OVERLOADED']],
    ['a non-array stored list', 'SERVER'],
  ]) {
    const forms = deviationForms({
      openrouter: { value: { retryPolicy: { mode: 'normal', maxRetries: 7, retryableCodes: codes } }, user: { retryPolicy: { maxRetries: 7 } } },
    })
    const { page } = mountPage({ forms })
    await flush()
    const card = mountRouteCard(page, 'openrouter')
    assert.equal(codeCheckboxes(card.tree).length, host.OFFERED_RETRYABLE_CODES.length, `${label}: the offered checkbox count drifted`)
    assert.deepEqual(codeCheckboxes(card.tree).map(box => box.props.checked), [true, true, true, true, true, false, false, false, false, false], `${label} must fall back to exactly the five defaults, never the offered ten`)
    card.unmount()
    page.unmount()
  }

  const stored = deviationForms({
    openrouter: { value: { retryPolicy: { mode: 'normal', maxRetries: 7, retryableCodes: ['STREAM_CLOSED'] } }, user: { retryPolicy: { maxRetries: 7 } } },
  })
  const { page } = mountPage({ forms: stored })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  assert.deepEqual(codeCheckboxes(card.tree).map(box => box.props.checked), [false, false, false, false, false, true, false, false, false, false], 'a stored opt-in code must render round-tripped, neither discarded nor expanded')
  card.unmount()
  page.unmount()
})

await check('each merged card names its namespace, its route, and the effective protocol (catalog default when the snapshot has none)', async () => {
  const forms = deviationForms({
    deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 3 } }, user: { retryPolicy: { maxRetries: 3 } } },
    openrouter: { value: { api: 'openai-completions', retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { maxRetries: 2 } } },
  })
  const { page } = mountPage({ forms })
  await flush()
  const pi = mountRouteCard(page, 'openrouter')
  const piText = renderedText(pi.tree)
  assert.ok(piText.includes('openai-completions'), 'the pi-ai protocol is not rendered from the route snapshot')
  assert.ok(piText.includes('llm-pi-ai'), 'the pi-ai card does not name its namespace')
  assert.ok(piText.includes('providers \u203a openrouter'), 'the pi-ai card does not name its profile path')
  pi.unmount()
  const ds = mountRouteCard(page, 'deepseek-official')
  const dsText = renderedText(ds.tree)
  assert.ok(dsText.includes('anthropic-messages'), 'the DeepSeek protocol must render as anthropic-messages')
  assert.ok(dsText.includes('llm-deepseek'), 'the DeepSeek card does not name its namespace')
  ds.unmount()

  const catalog = mountPage({
    forms: deviationForms({ openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { maxRetries: 2 } } } }),
  })
  await flush()
  const noProtocol = mountRouteCard(catalog.page, 'openrouter')
  assert.ok(renderedText(noProtocol.tree).includes(EN['timeouts.protocol.catalog']), 'a route with no api field did not render the catalog-default protocol copy')
  noProtocol.unmount()
})

await check('the timeout advisories warn about the SDK deadline and a short fetch body timeout without blocking Save', async () => {
  const sdk = mountPage({ forms: deviationForms({ openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { maxRetries: 2 }, streamIdleTimeoutMs: 600_000 } } }) })
  await flush()
  const sdkCard = mountRouteCard(sdk.page, 'openrouter')
  setTimeoutInput(sdkCard.tree, 0, '900000')
  assert.ok(renderedText(sdkCard.tree).includes(EN['timeouts.advisory.sdkFirst']), 'the SDK-timeout advisory is missing when the idle window exceeds 600000 ms')
  assert.equal(buttonWithText(sdkCard.tree, [EN['provider.save']]).props.disabled, false, 'a non-blocking advisory disabled Save')
  sdkCard.unmount()
  sdk.page.unmount()

  const matchedForms = deviationForms({ openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { maxRetries: 2 }, streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 } } })
  const matched = mountPage({ forms: matchedForms })
  await flush()
  const matchedCard = mountRouteCard(matched.page, 'openrouter')
  setTimeoutInput(matchedCard.tree, 0, '900000')
  assert.equal(renderedText(matchedCard.tree).includes(EN['timeouts.advisory.sdkFirst']), false, 'the SDK advisory stayed when timeoutMs matched the idle window')
  matchedCard.unmount()
  matched.page.unmount()

  const transport = mountPage({
    forms: {
      ...deviationForms({ openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { maxRetries: 2 }, streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 } } }),
      'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ bodyTimeoutMs: 100_000 })),
    },
  })
  await flush()
  const transportCard = mountRouteCard(transport.page, 'openrouter')
  setTimeoutInput(transportCard.tree, 0, '900000')
  assert.ok(renderedText(transportCard.tree).includes(EN['timeouts.advisory.transportFirst']), 'the transport advisory is missing when the fetch body timeout is below the idle window')
  transportCard.unmount()
  transport.page.unmount()

  const wide = mountPage({
    forms: {
      ...deviationForms({ openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: { retryPolicy: { maxRetries: 2 }, streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 } } }),
      'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ bodyTimeoutMs: 1_800_000 })),
    },
  })
  await flush()
  const wideCard = mountRouteCard(wide.page, 'openrouter')
  setTimeoutInput(wideCard.tree, 0, '900000')
  assert.equal(renderedText(wideCard.tree).includes(EN['timeouts.advisory.transportFirst']), false, 'the transport advisory stayed when the fetch body timeout covered the idle window')
  wideCard.unmount()
  wide.page.unmount()
})

await check('an unserved own namespace degrades the global card while the ready route cards stay usable', async () => {
  const forms = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', unavailableSnapshot) })
  const { page } = mountPage({ forms })
  await flush()
  assert.ok(renderedText(page.tree).includes(EN['status.unavailable']), 'the own-namespace unavailable note is missing')
  assert.equal(textInputs(globalCard(page)).every(input => input.props.disabled === true), true, 'the global controls stayed editable on an unserved namespace')
  for (const key of ['global.save', 'defaults.applyAll']) {
    assert.equal(buttonWithText(page.tree, [EN[key]]).props.disabled, true, `the "${key}" action stayed enabled on an unserved namespace`)
  }
  assert.equal(buttonWithText(page.tree, [EN['fetch.reset']]).props.disabled, true, 'the fetch Reset stayed enabled on an unserved namespace')
  assert.deepEqual(routeCardElements(page).map(node => node.props.row.provider), ['openrouter'], 'the ready route card disappeared with the degraded global card')
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, false, 'a ready route card stopped writing when only the global namespace was unserved')
  card.unmount()
})

await check('a loading or read-only own namespace renders its own note and disables the global card', async () => {
  const loading = mountPage({ forms: makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', loadingSnapshot) }) })
  await flush()
  assert.ok(renderedText(loading.page.tree).includes(EN['status.loading']), 'the own-namespace loading note is missing')
  assert.equal(textInputs(globalCard(loading.page)).every(input => input.props.disabled === true), true, 'the global controls stayed editable while loading')
  loading.page.unmount()

  const readOnly = mountPage({
    forms: makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', { ...readySnapshot(tuneValue(), 7), writable: false }) }),
  })
  await flush()
  assert.ok(renderedText(readOnly.page.tree).includes(EN['status.readOnly']), 'the read-only note is missing')
  assert.equal(buttonWithText(readOnly.page.tree, [EN['global.save']]).props.disabled, true, 'the global Save stayed enabled in a read-only namespace')
  assert.equal(buttonWithText(readOnly.page.tree, [EN['defaults.applyAll']]).props.disabled, true, 'Apply defaults stayed enabled in a read-only namespace')
  readOnly.page.unmount()
})

/* ══ 10. operation shapes ══════════════════════════════════════════════════ */

await check('the global Save writes the six retry defaults AND the two fetch leaves in ONE fenced write', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const own = ctx.configForms.get('llm-api-call-tuning')
  setRetryInput(page.tree, 0, '9')
  setFetchInput(page.tree, 0, '0')
  setFetchInput(page.tree, 1, '1800000')
  buttonWithText(page.tree, [EN['global.save']]).props.onClick()
  await flush()
  assert.equal(own.calls.length, 1, `expected one merged global write, got ${own.calls.length}`)
  assert.equal(own.calls[0].revision, 7, `the global write was fenced at ${own.calls[0].revision}`)
  assertOps(own.calls[0].ops, [
    { op: 'set', path: ['mode'], value: 'normal' },
    { op: 'set', path: ['maxRetries'], value: 9 },
    { op: 'set', path: ['initialDelayMs'], value: 500 },
    { op: 'set', path: ['maxDelayMs'], value: 10000 },
    { op: 'set', path: ['jitterRatio'], value: 0.1 },
    { op: 'set', path: ['retryableCodes'], value: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] },
    { op: 'set', path: ['headersTimeoutMs'], value: 0 },
    { op: 'set', path: ['bodyTimeoutMs'], value: 1800000 },
  ], 'the merged global save ops drifted')
  const codesOp = plain(own.calls[0].ops).find(op => op.path.join('.') === 'retryableCodes')
  assert.deepEqual(codesOp.value, [...host.RETRYABLE_CODES], 'the global Save must still write exactly the five default codes, byte-for-byte, never the offered ten')
  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
    assert.equal(ctx.configForms.get(ns).calls.length, 0, `the global Save wrote the provider namespace ${ns}`)
  }
  assert.ok(renderedText(page.tree).includes(EN['status.saved']), 'the global save confirmation is missing')
})

await check('the fetch half is tri-state: an empty draft unsets both leaves, and clearing one seeded leaf keeps the other', async () => {
  const fresh = mountPage()
  await flush()
  buttonWithText(fresh.page.tree, [EN['global.save']]).props.onClick()
  await flush()
  const freshOps = plain(fresh.ctx.configForms.get('llm-api-call-tuning').calls[0].ops)
  assert.deepEqual(
    freshOps.slice(6),
    [{ op: 'unset', path: ['headersTimeoutMs'] }, { op: 'unset', path: ['bodyTimeoutMs'] }],
    'an empty fetch draft must unset both leaves so the system default applies',
  )
  fresh.page.unmount()

  const seeded = mountPage({
    forms: makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ headersTimeoutMs: 0, bodyTimeoutMs: 1_800_000 })) }),
  })
  await flush()
  assert.deepEqual(globalFetchValues(seeded.page), ['0', '1800000'], 'the seeded fetch leaves are not painted')
  setFetchInput(seeded.page.tree, 0, '')
  buttonWithText(seeded.page.tree, [EN['global.save']]).props.onClick()
  await flush()
  const seededOps = plain(seeded.ctx.configForms.get('llm-api-call-tuning').calls[0].ops)
  assert.deepEqual(
    seededOps.slice(6),
    [{ op: 'unset', path: ['headersTimeoutMs'] }, { op: 'set', path: ['bodyTimeoutMs'], value: 1_800_000 }],
    'clearing one seeded fetch leaf must unset only it',
  )
  seeded.page.unmount()
})

await check('the fetch sub-group Reset emits exactly the two flat unsets, writes no retry leaf, and reports its own confirmation', async () => {
  const forms = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ headersTimeoutMs: 250, bodyTimeoutMs: 500 })) })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const form = ctx.configForms.get('llm-api-call-tuning')
  buttonWithText(page.tree, [EN['fetch.reset']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 1, `expected one fetch reset, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 7, 'the fetch Reset did not use the snapshot revision')
  assertOps(form.calls[0].ops, [
    { op: 'unset', path: ['headersTimeoutMs'] },
    { op: 'unset', path: ['bodyTimeoutMs'] },
  ], 'the fetch Reset ops drifted')
  assert.ok(renderedText(page.tree).includes(EN['status.fetchReset']), 'the fetch Reset confirmation is missing')
  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
    assert.equal(ctx.configForms.get(ns).calls.length, 0, `the fetch Reset wrote the provider namespace ${ns}`)
  }
})

await check('the global Save validates the fetch tri-state: malformed timers are refused, 0 and the cap pass', async () => {
  const { page } = mountPage()
  await flush()
  const save = () => buttonWithText(page.tree, [EN['global.save']])
  for (const [label, index, value, copy] of [
    ['a negative header timeout', 0, '-1', 'error.headersTimeoutMs'],
    ['a fractional header timeout', 0, '1.5', 'error.headersTimeoutMs'],
    ['an overflow header timeout', 0, '2147483648', 'error.headersTimeoutMs'],
    ['a negative body timeout', 1, '-5', 'error.bodyTimeoutMs'],
    ['a fractional body timeout', 1, '1.5', 'error.bodyTimeoutMs'],
  ]) {
    setFetchInput(page.tree, index, value)
    assert.equal(save().props.disabled, true, `Save stayed enabled on ${label}`)
    assert.ok(renderedText(page.tree).includes(EN[copy]), `the ${copy} error copy is missing for ${label}`)
    setFetchInput(page.tree, index, '')
  }
  for (const [label, index, value] of [['0 (disabled)', 0, '0'], ['the timer cap', 0, '2147483647'], ['empty (unset)', 0, '']]) {
    setFetchInput(page.tree, index, value)
    assert.equal(save().props.disabled, false, `Save stayed disabled on ${label}`)
  }
})

await check('Apply defaults writes every editable provider once, at its own revision, with a section-level outcome summary', async () => {
  const { page, ctx } = mountPage()
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  for (const [ns, revision] of [['llm-deepseek', 2], ['llm-deepseek-account', 3], ['llm-pi-ai', 4]]) {
    const calls = ctx.configForms.get(ns).calls
    assert.equal(calls.length, 1, `${ns} received ${calls.length} apply-all writes`)
    assert.equal(calls[0].revision, revision, `${ns} was written at revision ${calls[0].revision}, not ${revision}`)
    assert.equal(plain(calls[0].ops).length, 6, `${ns} received ${plain(calls[0].ops).length} retry leaves, expected six`)
  }
  const retryLeaves = base => [
    `${base}retryPolicy.mode`,
    `${base}retryPolicy.maxRetries`,
    `${base}retryPolicy.retryableCodes`,
    `${base}retryPolicy.backoff.initialDelayMs`,
    `${base}retryPolicy.backoff.maxDelayMs`,
    `${base}retryPolicy.backoff.jitterRatio`,
  ]
  assert.deepEqual(plain(ctx.configForms.get('llm-deepseek').calls[0].ops).map(op => op.path.join('.')), retryLeaves(''), 'the DeepSeek apply ops drifted')
  assert.deepEqual(plain(ctx.configForms.get('llm-deepseek-account').calls[0].ops).map(op => op.path.join('.')), retryLeaves(''), 'the DeepSeek Account apply ops drifted')
  assert.deepEqual(plain(ctx.configForms.get('llm-pi-ai').calls[0].ops).map(op => op.path.join('.')), retryLeaves('providers.openrouter.'), 'the pi-ai apply ops drifted')
  for (const [ns, base] of [['llm-deepseek', ''], ['llm-deepseek-account', ''], ['llm-pi-ai', 'providers.openrouter.']]) {
    const codesOp = plain(ctx.configForms.get(ns).calls[0].ops).find(op => op.path.join('.') === `${base}retryPolicy.retryableCodes`)
    assert.deepEqual(codesOp.value, [...host.RETRYABLE_CODES], `${ns}: Apply defaults must project exactly the five default codes, never the ten offered`)
  }
  const text = renderedText(page.tree)
  for (const displayName of ['DeepSeek Account', 'DeepSeek', 'OpenRouter']) {
    assert.ok(text.includes(`${displayName}: ${EN['apply.outcome.saved']}`), `the section summary is missing "${displayName}: ${EN['apply.outcome.saved']}"`)
  }
})

await check('Apply defaults projects only retryPolicy leaves, never a fetch timer or a provider-timeout leaf', async () => {
  const forms = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ headersTimeoutMs: 0, bodyTimeoutMs: 1_800_000 })) })
  const { page, ctx } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
    for (const call of ctx.configForms.get(ns).calls) {
      for (const op of plain(call.ops)) {
        assert.equal(op.path.join('.').includes('retryPolicy'), true, `${ns} received the non-retry path ${op.path.join('.')}`)
      }
    }
  }
})

await check('Apply defaults skips rows that are not ready or not writable, and the section summary records each skip', async () => {
  const forms = makeForms({
    'llm-deepseek': new BoundForm('llm-deepseek', loadingSnapshot),
    'llm-deepseek-account': new BoundForm('llm-deepseek-account', { ...readySnapshot({}, 3), writable: false }),
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  assert.equal(ctx.configForms.get('llm-deepseek').calls.length, 0, 'a loading row was written')
  assert.equal(ctx.configForms.get('llm-deepseek-account').calls.length, 0, 'a read-only row was written')
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 1, 'the ready provider was not written')
  const text = renderedText(page.tree)
  for (const displayName of ['DeepSeek', 'DeepSeek Account']) {
    assert.ok(text.includes(`${displayName}: ${EN['apply.outcome.skipped']}`), `the section summary is missing the skipped outcome for ${displayName}`)
  }
  assert.ok(text.includes(`OpenRouter: ${EN['apply.outcome.saved']}`), 'the ready row lost its saved outcome')
})

await check('Apply defaults never sends an unconditional write for a ready row without a numeric revision', async () => {
  const forms = makeForms({ 'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({}, undefined)) })
  const { page, ctx } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  assert.equal(ctx.configForms.get('llm-deepseek').calls.length, 0, 'a row without a numeric revision was written unconditionally')
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 1, 'the fenced provider was not written')
  assert.ok(renderedText(page.tree).includes(`DeepSeek: ${EN['apply.outcome.skipped']}`), 'the unfenced row was not recorded as skipped')
})

await check('two rows sharing one namespace each fence on the revision their predecessor advanced', async () => {
  const forms = makeForms({ 'llm-pi-ai': new BoundForm('llm-pi-ai', readySnapshot({}, 4), { advanceOnAccept: true }) })
  const registered = [...REGISTERED, { id: 'another', name: 'Another' }]
  const configurable = [...CONFIGURABLE, { provider: 'another', displayName: 'Another', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'another'] }]
  const { page, ctx } = mountPage({ forms, registered, configurable })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  const form = ctx.configForms.get('llm-pi-ai')
  assert.equal(form.calls.length, 2, `expected two writes on the shared namespace, got ${form.calls.length}`)
  assert.deepEqual(form.calls.map(call => call.revision), [4, 5], `the shared-namespace fences drifted: ${JSON.stringify(form.calls.map(call => call.revision))}`)
  assert.deepEqual(
    form.calls.map(call => plain(call.ops)[1].path.join('.')),
    ['providers.openrouter.retryPolicy.maxRetries', 'providers.another.retryPolicy.maxRetries'],
    'the two rows wrote the wrong provider paths',
  )
})

await check('a merged route Save writes the changed retry AND timeout leaves under the joined settings path in ONE fenced write', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  setTimeoutInput(card.tree, 0, '450000')
  setTimeoutInput(card.tree, 1, '900000')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const form = ctx.configForms.get('llm-pi-ai')
  assert.equal(form.calls.length, 1, `expected one merged route write, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 4, `the merged route write was fenced at ${form.calls[0].revision}`)
  /* Only the leaves the user TOUCHED are written: the edited retry limit and
   * the two timeout fields. The untouched mode/codes/backoff leaves produce no
   * op at all, which is what keeps the opt-in codes inert. */
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'maxRetries'], value: 7 },
    { op: 'set', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'], value: 450000 },
    { op: 'set', path: ['providers', 'openrouter', 'timeoutMs'], value: 900000 },
  ], 'the merged route save must write only the touched leaves')
  assert.equal(plain(form.calls[0].ops).some(op => op.path.join('.').includes('retryableCodes')), false, 'an untouched retryable-code list must produce no op')
  assert.ok(!JSON.stringify(plain(form.calls[0].ops)).includes('"retryPolicy":{"mode"'), 'a whole retryPolicy object was set')
  card.unmount()
})

await check('a retry Save writes ONLY leaves the user touched: editing maxRetries emits no retryableCodes/mode/backoff op', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assertOps(ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'maxRetries'], value: 7 },
  ], 'touching one retry leaf must write only that leaf')
  card.unmount()

  /* A stored five-code list round-trips identically: saving another leaf never
   * emits a retryableCodes op, and no opt-in code becomes checked. */
  const stored = deviationForms({
    openrouter: {
      value: { retryPolicy: { mode: 'normal', maxRetries: 7, retryableCodes: [...host.RETRYABLE_CODES] } },
      user: { retryPolicy: { maxRetries: 7, retryableCodes: [...host.RETRYABLE_CODES] } },
    },
  })
  const storedPage = mountPage({ forms: stored })
  await flush()
  const storedCard = mountRouteCard(storedPage.page, 'openrouter')
  assert.deepEqual(codeCheckboxes(storedCard.tree).map(box => box.props.checked), [true, true, true, true, true, false, false, false, false, false], 'a stored five-code policy did not render identically')
  setRetryInput(storedCard.tree, 0, '8')
  buttonWithText(storedCard.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assertOps(storedPage.ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'maxRetries'], value: 8 },
  ], 'a stored five-code list must round-trip with no retryableCodes op')
  storedCard.unmount()
  storedPage.page.unmount()
})

await check('ticking ONE opt-in code writes exactly that code leaf and never enables the others', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  assert.equal(codeCheckboxes(card.tree).length, host.OFFERED_RETRYABLE_CODES.length, 'the offered checkbox count drifted')
  toggleCode(card.tree, 5, true)
  await flush()
  assert.deepEqual(codeCheckboxes(card.tree).map(box => box.props.checked), [false, true, false, false, false, true, false, false, false, false], 'ticking STREAM_CLOSED must not toggle any other code')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assertOps(ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'retryableCodes'], value: ['RATE_LIMIT', 'STREAM_CLOSED'] },
  ], 'ticking one opt-in code must write one retryableCodes leaf containing exactly the stored code plus the ticked one')
  card.unmount()
})

await check('an untouched retry half contributes nothing to a timeout-only Save', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setTimeoutInput(card.tree, 0, '450000')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assertOps(ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'], value: 450000 },
  ], 'a timeout-only Save must not project an untouched retry leaf')
  card.unmount()
})

await check('clearing one seeded timeout leaf emits only its unset, and the merged Reset unsets the whole retryPolicy plus the family timeout leaves', async () => {
  const forms = deviationForms({
    openrouter: {
      value: { retryPolicy: plain(PI_AI_RETRY_POLICY), streamIdleTimeoutMs: 1_800_000, timeoutMs: 900_000 },
      user: { retryPolicy: { mode: 'normal', maxRetries: 2 }, streamIdleTimeoutMs: 1_800_000, timeoutMs: 900_000 },
    },
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setTimeoutInput(card.tree, 1, '')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const form = ctx.configForms.get('llm-pi-ai')
  assertOps(form.calls[0].ops, [
    { op: 'unset', path: ['providers', 'openrouter', 'timeoutMs'] },
  ], 'clearing one seeded timeout leaf must emit only its unset')
  buttonWithText(card.tree, [EN['provider.reset']]).props.onClick()
  await flush()
  assertOps(form.calls[1].ops, [
    { op: 'unset', path: ['providers', 'openrouter', 'retryPolicy'] },
    { op: 'unset', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'] },
    { op: 'unset', path: ['providers', 'openrouter', 'timeoutMs'] },
  ], 'the merged Reset ops drifted')
  assert.equal(form.calls[1].revision, 4, 'the merged Reset did not use the snapshot revision')
  assert.ok(renderedText(card.tree).includes(EN['status.routeReset']), 'the route Reset confirmation is missing')
  card.unmount()
})

await check('reverting every stored retry leaf to the global values emits ONE whole-retryPolicy unset and the card disappears', async () => {
  const forms = deviationForms({
    openrouter: { value: { retryPolicy: { mode: 'normal', maxRetries: 7 } }, user: { retryPolicy: { mode: 'normal', maxRetries: 7 } } },
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  assert.deepEqual(routeCardElements(page).map(node => node.props.row.provider), ['openrouter'], 'the stored-retry deviation is not listed')
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '5')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const form = ctx.configForms.get('llm-pi-ai')
  assert.equal(form.calls.length, 1, `expected one revert write, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 4, 'the revert was not fenced at the snapshot revision')
  assertOps(form.calls[0].ops, [{ op: 'unset', path: ['providers', 'openrouter', 'retryPolicy'] }], 'a full revert must collapse to ONE whole-retryPolicy unset')
  card.unmount()
  form.push(readySnapshot(piAiValue({}), 5, {}))
  await flush()
  assert.equal(routeCardElements(page).length, 0, 'the fully reverted route stayed listed')
  assert.deepEqual(
    pickerOptions(page.tree),
    [EN['routes.pickerPlaceholder'], 'DeepSeek Account (deepseek-account)', 'DeepSeek (deepseek-official)', 'OpenRouter (openrouter)'],
    'the reverted route did not return to the selector',
  )
})

await check('Use defaults stages the validated global values and a Save reverts the route in one whole-retryPolicy unset', async () => {
  const forms = deviationForms({
    openrouter: {
      value: { retryPolicy: plain(PI_AI_RETRY_POLICY) },
      user: { retryPolicy: { mode: 'normal', maxRetries: 2 } },
    },
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  buttonWithText(card.tree, [EN['provider.useDefaults']]).props.onClick()
  await flush()
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 0, 'Use defaults wrote to the Host')
  assert.deepEqual(retryInputs(card.tree).map(input => input.props.value), ['5', '500', '10000', '0.1'], 'Use defaults did not stage the global values')
  assert.equal(codeCheckboxes(card.tree).length, host.OFFERED_RETRYABLE_CODES.length, 'Use defaults changed the offered checkbox count')
  assert.deepEqual(codeCheckboxes(card.tree).map(box => box.props.checked), [true, true, true, true, true, false, false, false, false, false], 'Use defaults did not stage exactly the five default codes (never the offered ten)')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assertOps(ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'unset', path: ['providers', 'openrouter', 'retryPolicy'] },
  ], 'a Save after Use defaults must revert the whole retryPolicy')
  card.unmount()
})

await check('a DeepSeek merged card writes namespace-root timeout paths and its Reset never sets a whole object', async () => {
  const forms = deviationForms({
    deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 7 } }, user: { retryPolicy: { maxRetries: 7 } } },
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const card = mountRouteCard(page, 'deepseek-official')
  setTimeoutInput(card.tree, 0, '600000')
  setTimeoutInput(card.tree, 1, '120000')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const form = ctx.configForms.get('llm-deepseek')
  assert.equal(form.calls[0].revision, 2, 'the DeepSeek write did not use the namespace revision')
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['streamIdleTimeoutMs'], value: 600000 },
    { op: 'set', path: ['filesApiTimeoutMs'], value: 120000 },
  ], 'the DeepSeek timeout save must address the namespace root')
  buttonWithText(card.tree, [EN['provider.reset']]).props.onClick()
  await flush()
  assertOps(form.calls[1].ops, [
    { op: 'unset', path: ['retryPolicy'] },
    { op: 'unset', path: ['streamIdleTimeoutMs'] },
    { op: 'unset', path: ['filesApiTimeoutMs'] },
  ], 'the DeepSeek Reset ops drifted')
  for (const { ops } of form.calls) {
    for (const op of plain(ops)) {
      assert.ok(op.op === 'set' || op.op === 'unset', `an unknown op ${String(op.op)} was submitted`)
      assert.ok(Array.isArray(op.path) && op.path.length > 0, 'an op carried an empty path')
      if (op.op === 'set') {
        const whole = op.value !== null && typeof op.value === 'object' && !Array.isArray(op.value)
        assert.equal(whole, false, `a whole object was set at ${op.path.join('.')}`)
      }
    }
  }
  card.unmount()
})

await check('the merged Save is disabled when nothing changed, and 0 plus every malformed provider timeout is refused', async () => {
  const { page } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  const save = () => buttonWithText(card.tree, [EN['provider.save']])
  const reset = () => buttonWithText(card.tree, [EN['provider.reset']])
  assert.equal(save().props.disabled, true, 'Save stayed enabled on an untouched card')
  assert.equal(reset().props.disabled, false, 'Reset stayed disabled on a writable card')
  for (const [label, value, copy] of [
    ['0 on the idle watchdog', '0', 'error.streamIdleTimeoutMs'],
    ['a negative value', '-1', 'error.streamIdleTimeoutMs'],
    ['a fractional value', '1.5', 'error.streamIdleTimeoutMs'],
    ['an overflow value', '2147483648', 'error.streamIdleTimeoutMs'],
    ['a leading zero', '007', 'error.streamIdleTimeoutMs'],
    ['exponent notation', '1e6', 'error.streamIdleTimeoutMs'],
  ]) {
    setTimeoutInput(card.tree, 0, value)
    assert.equal(save().props.disabled, true, `Save stayed enabled on ${label}`)
    assert.ok(renderedText(card.tree).includes(EN[copy]), `the ${copy} copy is missing for ${label}`)
  }
  setTimeoutInput(card.tree, 1, '0')
  assert.equal(save().props.disabled, true, 'Save stayed enabled on a zero SDK request timeout')
  assert.ok(renderedText(card.tree).includes(EN['error.timeoutMs']), 'the 0-request-timeout copy is missing')
  setTimeoutInput(card.tree, 1, '')
  setTimeoutInput(card.tree, 0, ' 2147483647 ')
  assert.equal(save().props.disabled, false, 'the 2147483647 cap (whitespace-trimmed) must be accepted')
  card.unmount()

  const dsPage = mountPage({
    forms: deviationForms({ deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 7 } }, user: { retryPolicy: { maxRetries: 7 } } } }),
  })
  await flush()
  const dsCard = mountRouteCard(dsPage.page, 'deepseek-official')
  setTimeoutInput(dsCard.tree, 1, '0')
  assert.equal(buttonWithText(dsCard.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled on a zero files-API timeout')
  assert.ok(renderedText(dsCard.tree).includes(EN['error.filesApiTimeoutMs']), 'the 0-files-api copy is missing')
  dsCard.unmount()
})

await check('the Unlimited preset fills the 2147483647 cap on every timeout field of the family', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  const presets = timeoutPresetButtons(card.tree)
  assert.equal(presets.length, 2, 'the pi-ai card must offer one Unlimited preset per visible field')
  presets[0].props.onClick()
  presets[1].props.onClick()
  assert.deepEqual(timeoutInputs(card.tree).map(input => input.props.value), ['2147483647', '2147483647'], 'the pi-ai Unlimited preset must fill the cap, never 0')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assertOps(ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'], value: 2_147_483_647 },
    { op: 'set', path: ['providers', 'openrouter', 'timeoutMs'], value: 2_147_483_647 },
  ], 'the Unlimited preset did not persist the cap')
  card.unmount()

  const dsPage = mountPage({
    forms: deviationForms({ deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 7 } }, user: { retryPolicy: { maxRetries: 7 } } } }),
  })
  await flush()
  const dsCard = mountRouteCard(dsPage.page, 'deepseek-official')
  const dsPresets = timeoutPresetButtons(dsCard.tree)
  assert.equal(dsPresets.length, 2, 'the DeepSeek card must offer one Unlimited preset per visible field')
  dsPresets[0].props.onClick()
  dsPresets[1].props.onClick()
  assert.deepEqual(timeoutInputs(dsCard.tree).map(input => input.props.value), ['2147483647', '2147483647'], 'the DeepSeek Unlimited preset must cover the Files API field too')
  dsCard.unmount()
})

await check('a route Save and the global Save never write each other namespace', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 1, 'the route Save did not write its own namespace')
  for (const ns of ['llm-api-call-tuning', 'llm-deepseek', 'llm-deepseek-account']) {
    assert.equal(ctx.configForms.get(ns).calls.length, 0, `the route Save wrote the unrelated namespace ${ns}`)
  }
  card.unmount()
  buttonWithText(page.tree, [EN['global.save']]).props.onClick()
  await flush()
  assert.equal(ctx.configForms.get('llm-api-call-tuning').calls.length, 1, 'the global Save did not write its own namespace')
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 1, 'the global Save wrote a provider namespace')
  for (const op of plain(ctx.configForms.get('llm-api-call-tuning').calls[0].ops)) {
    assert.ok(op.path.length === 1, `the global Save wrote the nested path ${op.path.join('.')}`)
    assert.ok(['mode', 'maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio', 'retryableCodes', 'headersTimeoutMs', 'bodyTimeoutMs'].includes(op.path[0]), `the global Save wrote an unexpected leaf ${op.path[0]}`)
  }
})

await check('a route card without a numeric revision or in a read-only namespace disables every action and never writes', async () => {
  const noRevision = makeForms({
    'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({ retryPolicy: { mode: 'normal', maxRetries: 7 } }, undefined, { retryPolicy: { maxRetries: 7 } })),
  })
  const noRev = mountPage({ forms: noRevision })
  await flush()
  const card = mountRouteCard(noRev.page, 'deepseek-official')
  for (const key of ['provider.save', 'provider.reset', 'provider.useDefaults']) {
    const button = buttonWithText(card.tree, [EN[key]])
    assert.ok(button !== undefined, `the ${key} action is missing`)
    assert.equal(button.props.disabled, true, `the ${key} action stayed enabled without a numeric revision`)
  }
  assert.equal(textInputs(card.tree).every(input => input.props.disabled === true), true, 'the card controls stayed editable without a numeric revision')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  buttonWithText(card.tree, [EN['provider.reset']]).props.onClick()
  await flush()
  assert.equal(noRev.ctx.configForms.get('llm-deepseek').calls.length, 0, 'a row without a numeric revision wrote its namespace')
  card.unmount()

  const readOnlyForms = makeForms({
    'llm-deepseek': new BoundForm('llm-deepseek', { ...readySnapshot({ retryPolicy: { mode: 'normal', maxRetries: 7 } }, 2, { retryPolicy: { maxRetries: 7 } }), writable: false }),
  })
  const readOnly = mountPage({ forms: readOnlyForms })
  await flush()
  const roCard = mountRouteCard(readOnly.page, 'deepseek-official')
  assert.ok(renderedText(roCard.tree).includes(EN['status.readOnly']), 'a read-only route card did not render the read-only note')
  assert.equal(buttonWithText(roCard.tree, [EN['provider.save']]), undefined, 'a read-only route card rendered Save')
  assert.equal(retryInputs(roCard.tree).length, 0, 'a read-only route card rendered editable controls')
  roCard.unmount()
})

/* ══ 11. validation ════════════════════════════════════════════════════════ */

/** The forms for one deviating DeepSeek route, so its merged card is on the page. */
const deepseekCardForms = () => deviationForms({
  deepseek: { value: { retryPolicy: { mode: 'normal', maxRetries: 7 } }, user: { retryPolicy: { mode: 'normal', maxRetries: 7 } } },
})

await check('an invalid retry limit disables the merged Save and renders the field error', async () => {
  const { page } = mountPage({ forms: deepseekCardForms() })
  await flush()
  const card = mountRouteCard(page, 'deepseek-official')
  setRetryInput(card.tree, 0, '2.5')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled on a fractional retry limit')
  assert.ok(renderedText(card.tree).includes(EN['error.maxRetries']), 'the maxRetries error copy is missing')
  card.unmount()
})

await check('out-of-range and mis-ordered delays are refused with their own copy', async () => {
  const { page } = mountPage({ forms: deepseekCardForms() })
  await flush()
  const card = mountRouteCard(page, 'deepseek-official')
  setRetryInput(card.tree, 1, '0')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled on a zero delay')
  assert.ok(renderedText(card.tree).includes(EN['error.initialDelayMs']), 'the initial-delay error copy is missing')
  setRetryInput(card.tree, 1, '20000')
  setRetryInput(card.tree, 2, '10000')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled when the initial delay exceeded the maximum')
  assert.ok(renderedText(card.tree).includes(EN['error.initialDelayOrder']), 'the delay-order error copy is missing')
  card.unmount()
})

await check('an out-of-range jitter and an empty code list are refused', async () => {
  const { page } = mountPage({ forms: deepseekCardForms() })
  await flush()
  const card = mountRouteCard(page, 'deepseek-official')
  setRetryInput(card.tree, 3, '2')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled on jitter 2')
  assert.ok(renderedText(card.tree).includes(EN['error.jitterRatio']), 'the jitter error copy is missing')
  setRetryInput(card.tree, 3, '0.1')
  for (let index = 0; index < 5; index += 1) toggleCode(card.tree, index, false)
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled with no retryable codes')
  assert.ok(renderedText(card.tree).includes(EN['error.retryableCodes']), 'the retryable-codes error copy is missing')
  card.unmount()
})

await check('the always-mode copy pins every failure incl. permanent, no retry limit, a visible but ignored limit, cleared stored limit+codes, and codes shown only in normal mode', () => {
  assert.equal(EN['mode.always'], 'Always \u2014 every failure, no limit', 'the mode.always label drifted')
  assert.equal(
    EN['provider.alwaysNote'],
    'Always mode retries EVERY model-request failure \u2014 including permanent ones such as AUTH, INVALID_REQUEST, or QUOTA \u2014 with no retry limit. The maximum-retries input stays visible but is ignored and unvalidated in this mode; saving clears the stored retry limit and code list. The offered codes are the checkboxes shown in normal mode.',
    'the always-mode note drifted',
  )
  for (const phrase of ['AUTH', 'INVALID_REQUEST', 'QUOTA', 'no retry limit', 'stays visible', 'ignored', 'saving clears the stored retry limit and code list', 'checkboxes shown in normal mode']) {
    assert.ok(EN['provider.alwaysNote'].includes(phrase), `the always-mode note lost "${phrase}"`)
  }
  assert.equal(EN['provider.alwaysNote'].includes('listed below'), false, 'the always-mode note must not claim the codes are listed below (the checklist is hidden in always mode)')
  assert.equal(COPY.zh['mode.always'], '\u603b\u662f \u2014 \u6bcf\u6b21\u5931\u8d25\uff0c\u65e0\u4e0a\u9650', 'the zh mode.always label drifted')
  for (const phrase of ['AUTH', 'INVALID_REQUEST', 'QUOTA', '\u6ca1\u6709\u91cd\u8bd5\u4e0a\u9650', '\u4ecd\u7136\u53ef\u89c1', '\u88ab\u5ffd\u7565', '\u6e05\u9664', '\u666e\u901a\u201d\u6a21\u5f0f\u4e0b\u663e\u793a\u7684\u590d\u9009\u6846']) {
    assert.ok(COPY.zh['provider.alwaysNote'].includes(phrase), `the zh always-mode note lost "${phrase}"`)
  }
  for (const phrase of ['five upstream codes are pre-selected', 'opt-in', 'inactive until ticked']) {
    assert.ok(EN['field.retryableCodes.description'].includes(phrase), `the code-list description lost "${phrase}"`)
  }
})

await check('an always-mode card skips the normal-only validation and unsets the two inactive leaves on Save, while the global card keeps validating', async () => {
  const forms = deviationForms({
    openrouter: {
      value: { retryPolicy: plain(PI_AI_RETRY_POLICY) },
      user: { retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 250, maxDelayMs: 5000, jitterRatio: 0.2 } } },
    },
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '2.5')
  setMode(card.tree, 'always')
  await flush()
  assert.equal(codeCheckboxes(card.tree).length, 0, 'the code list stayed rendered in always mode')
  assert.equal(retryInputs(card.tree).length, 4, 'the always-mode card hid the retry-limit input; it must stay visible')
  assert.equal(retryInputs(card.tree)[0].props.disabled, false, 'the visible retry-limit input must stay typable in always mode')
  assert.ok(renderedText(card.tree).includes(EN['provider.alwaysNote']), 'the always-mode note is missing')
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, false, 'always mode still validated the inactive retry limit')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  /* The always-mode contract is unchanged: the mode is set and every STORED
   * normal-only leaf is cleared. The untouched backoff leaves are not written
   * (touched-leaf safety), and no opt-in code can be activated here. */
  assertOps(ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'mode'], value: 'always' },
    { op: 'unset', path: ['providers', 'openrouter', 'retryPolicy', 'maxRetries'] },
    { op: 'unset', path: ['providers', 'openrouter', 'retryPolicy', 'retryableCodes'] },
  ], 'the always-mode save ops drifted')
  card.unmount()

  setRetryInput(page.tree, 0, '2.5')
  setMode(page.tree, 'always')
  assert.equal(buttonWithText(page.tree, [EN['global.save']]).props.disabled, true, 'the global card stopped validating the values it always owns')
  assert.ok(renderedText(page.tree).includes(EN['error.maxRetries']), 'the global card did not render the retry-limit error')
})

/* ══ 12. refusals, managed-elsewhere, and the one retry ═══════════════════ */

await check('a resolved-false refusal shows the generic refusal copy, never the managed copy, and is not retried', async () => {
  const forms = makeForms()
  forms['llm-pi-ai'].accept = false
  const { page } = mountPage({ forms })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const text = renderedText(card.tree)
  assert.ok(text.includes(EN['error.refused']), 'the refusal copy is missing')
  assert.equal(text.includes(EN['error.managed']), false, 'a resolved-false refusal rendered the managed-elsewhere copy')
  assert.equal(forms['llm-pi-ai'].calls.length, 1, 'a resolved-false refusal was retried without a revision move')
  card.unmount()
})

await check('DEFENSIVE ONLY: a direct RemoteError settings/rejected rejection is classified managed (fake form; unreachable through ConfigForm)', async () => {
  const form = new BoundForm('llm-pi-ai', readySnapshot(piAiValue({ retryPolicy: plain(PI_AI_RETRY_POLICY) }), 4, { providers: { openrouter: { retryPolicy: { maxRetries: 2 } } } }), {
    reject: () => Promise.reject(Object.assign(new Error('opaque'), { code: 'settings/rejected' })),
  })
  const { page } = mountPage({ forms: makeForms({ 'llm-pi-ai': form }) })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.ok(renderedText(card.tree).includes(EN['error.managed']), 'the managed-elsewhere copy is missing for a settings/rejected rejection')
  assert.equal(renderedText(card.tree).includes(EN['error.refused']), false, 'the generic refusal copy was rendered for a managed rejection')
  card.unmount()
})

await check('DEFENSIVE ONLY: a rejection carrying the override marker is managed even without the settings/rejected code', async () => {
  const form = new BoundForm('llm-pi-ai', readySnapshot(piAiValue({ retryPolicy: plain(PI_AI_RETRY_POLICY) }), 4, { providers: { openrouter: { retryPolicy: { maxRetries: 2 } } } }), {
    reject: () => Promise.reject(new Error('Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay')),
  })
  const { page } = mountPage({ forms: makeForms({ 'llm-pi-ai': form }) })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.ok(renderedText(card.tree).includes(EN['error.managed']), 'the override-marker rejection was not classified as managed')
  card.unmount()
})

await check('DEFENSIVE ONLY: any other rejection is a plain refusal and is not retried', async () => {
  const form = new BoundForm('llm-pi-ai', readySnapshot(piAiValue({ retryPolicy: plain(PI_AI_RETRY_POLICY) }), 4, { providers: { openrouter: { retryPolicy: { maxRetries: 2 } } } }), {
    reject: () => Promise.reject(new Error('transport failed')),
  })
  const { page } = mountPage({ forms: makeForms({ 'llm-pi-ai': form }) })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.ok(renderedText(card.tree).includes(EN['error.refused']), 'a generic rejection was not shown as a refusal')
  assert.equal(form.calls.length, 1, `a generic rejection was retried ${form.calls.length} times`)
  card.unmount()
})

await check('a superseded revision is retried once at the freshly read revision', async () => {
  const form = new BoundForm('llm-pi-ai', readySnapshot(piAiValue({ retryPolicy: plain(PI_AI_RETRY_POLICY) }), 4, { providers: { openrouter: { retryPolicy: { maxRetries: 2 } } } }), { reviseOnRefuse: true })
  const { page } = mountPage({ forms: makeForms({ 'llm-pi-ai': form }) })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 2, `expected one retry, got ${form.calls.length} calls`)
  assert.equal(form.calls[0].revision, 4, 'the first attempt did not use revision 4')
  assert.equal(form.calls[1].revision, 5, 'the retry did not use the fresh revision 5')
  assert.ok(renderedText(card.tree).includes(EN['status.saved']), 'the retried save did not report success')
  card.unmount()
})

await check('a refusal at the fresh revision is not retried a second time', async () => {
  const form = new BoundForm('llm-pi-ai', readySnapshot(piAiValue({ retryPolicy: plain(PI_AI_RETRY_POLICY) }), 4, { providers: { openrouter: { retryPolicy: { maxRetries: 2 } } } }), { refuseRevising: true })
  const { page } = mountPage({ forms: makeForms({ 'llm-pi-ai': form }) })
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 2, `the page retried ${form.calls.length} times; exactly one retry is allowed`)
  assert.equal(form.calls[0].revision, 4, 'the first attempt did not use revision 4')
  assert.equal(form.calls[1].revision, 5, 'the retry did not use the fresh revision 5')
  assert.ok(renderedText(card.tree).includes(EN['error.refused']), 'the second refusal was not shown')
  card.unmount()
})

/* ══ 13. provider directory and degradation ═══════════════════════════════ */

await check('readProviders resolves remote.llm through ctx.get and falls back to ctx.remote.llm', async () => {
  for (const remote of ['dotted', 'fallback', 'throwing']) {
    const ctx = fakeContext({ remote })
    clientPlugin.apply(ctx)
    const state = await settingsRegistration(ctx).options.inject().readProviders()
    assert.ok(ctx.state.serviceReads.includes('remote.llm'), `${remote}: readProviders never asked for remote.llm`)
    assert.equal(state.status, 'ready', `${remote}: the provider directory did not resolve`)
    assert.deepEqual(state.rows.map(row => row.provider), ['deepseek-account', 'deepseek-official', 'openrouter'], `${remote}: the joined rows drifted`)
  }
})

await check('both bare-array and {ok,value} envelope directory replies are accepted', async () => {
  const bare = mountPage({
    remoteImpl: {
      listProviders: () => [...REGISTERED],
      listConfigurableProviders: () => [...CONFIGURABLE],
    },
  })
  await flush()
  assert.equal(routeCardElements(bare.page).length, 1, 'a bare-array directory reply was not accepted')
  assert.equal(pickerOptions(bare.page.tree).length, 3, 'a bare-array directory reply did not reach the selector')

  const envelope = mountPage()
  await flush()
  assert.equal(routeCardElements(envelope.page).length, 1, 'the envelope directory reply was not accepted')
  assert.equal(pickerOptions(envelope.page.tree).length, 3, 'the envelope directory reply did not reach the selector')
})

await check('a deployment without the Remote LLM directory degrades to providers.unavailable', async () => {
  const { page, ctx } = mountPage({ remote: 'none' })
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(EN['providers.unavailable']), 'the provider-unavailable note is missing')
  assert.equal(routeCardElements(page).length, 0, 'cards were rendered without a provider directory')
  assert.equal(pickerSelect(page.tree), undefined, 'the selector rendered without a provider directory')
  const state = await settingsRegistration(ctx).options.inject().readProviders()
  assert.deepEqual(plain(state), { status: 'unavailable', rows: [] }, 'readProviders did not report unavailable')
})

await check('a refused directory envelope and a throwing read both degrade to providers.error', async () => {
  const refused = mountPage({
    remoteImpl: {
      listProviders: () => Promise.resolve({ ok: false, error: { code: 'llm/denied', message: 'no directory' } }),
      listConfigurableProviders: () => Promise.resolve({ ok: true, value: [...CONFIGURABLE] }),
    },
  })
  await flush()
  assert.ok(renderedText(refused.page.tree).includes(EN['providers.error']), 'a refused envelope did not render the directory error note')

  const throwing = mountPage({
    remoteImpl: {
      listProviders: () => { throw new Error('directory exploded') },
      listConfigurableProviders: () => Promise.resolve({ ok: true, value: [...CONFIGURABLE] }),
    },
  })
  await flush()
  assert.ok(renderedText(throwing.page.tree).includes(EN['providers.error']), 'a throwing read did not render the directory error note')
  const state = await settingsRegistration(throwing.ctx).options.inject().readProviders()
  assert.equal(state.status, 'error', 'readProviders did not report the throwing read as an error')
  throwing.page.unmount()
})

await check('an empty provider directory renders the empty note and no rows', async () => {
  const { page } = mountPage({ registered: [], configurable: [] })
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(EN['providers.empty']), 'the empty-directory note is missing')
  assert.equal(text.includes(EN['routes.empty']), false, 'the routes-empty note doubled up with the directory-empty note')
  assert.equal(routeCardElements(page).length, 0, 'cards were rendered for an empty directory')
  assert.equal(pickerSelect(page.tree), undefined, 'the selector rendered for an empty directory')
})

/* ══ 14. re-seeding, badges, and the settled outcome ══════════════════════ */

await check('a pushed snapshot re-seeds the merged card, and a refused write surfaces the recovery values', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({ retryPolicy: { mode: 'normal', maxRetries: 4 } }, 2, { retryPolicy: { mode: 'normal', maxRetries: 4 } }), { accept: false })
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  const card = mountRouteCard(page, 'deepseek-official')
  setRetryInput(card.tree, 0, '8')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  // The merged card clears its staged edits on EVERY settled Save (saved or
  // refused) and disables Save while nothing is staged; a fresh edit must make
  // the card usable again, which is what this check protects.
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, true, 'the merged card kept a staged edit after a settled refusal')
  form.push(readySnapshot({ retryPolicy: { mode: 'normal', maxRetries: 4 } }, 3, { retryPolicy: { mode: 'normal', maxRetries: 4 } }))
  await flush()
  assert.deepEqual(retryInputs(card.tree).map(input => input.props.value), ['4', '500', '10000', '0.1'], 'the card did not re-seed from the recovery read')
  assert.ok(renderedText(card.tree).includes(EN['error.refused']), 'the refusal copy did not survive the re-seed')
  setRetryInput(card.tree, 0, '8')
  await flush()
  assert.equal(buttonWithText(card.tree, [EN['provider.save']]).props.disabled, false, 'the card did not become usable again after a refusal')
  card.unmount()
})

await check('the retry badge follows the user layer, not a value comparison', async () => {
  const stored = mountPage()
  await flush()
  let card = mountRouteCard(stored.page, 'openrouter')
  assert.ok(renderedText(card.tree).includes(EN['provider.source.override']), 'a present user-layer retryPolicy did not render the override badge')
  card.unmount()
  stored.page.unmount()

  const valueOnly = mountPage({
    forms: deviationForms({ openrouter: { value: { retryPolicy: plain(PI_AI_RETRY_POLICY) }, user: undefined } }),
  })
  await flush()
  card = mountRouteCard(valueOnly.page, 'openrouter')
  assert.ok(renderedText(card.tree).includes(EN['provider.source.default']), 'a value-only deviation without user storage must show the default badge')
  card.unmount()
  valueOnly.page.unmount()
})

await check('a save clears the staged edits so the next snapshot is shown', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const card = mountRouteCard(page, 'openrouter')
  setRetryInput(card.tree, 0, '7')
  buttonWithText(card.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const form = ctx.configForms.get('llm-pi-ai')
  assert.equal(form.calls.length, 1, 'the save did not cross the wire')
  form.push(readySnapshot(piAiValue({ retryPolicy: { mode: 'normal', maxRetries: 1 } }), 5, { providers: { openrouter: { retryPolicy: { maxRetries: 1 } } } }))
  await flush()
  assert.deepEqual(retryInputs(card.tree).map(input => input.props.value), ['1', '500', '10000', '0.1'], 'the staged edit shadowed the next snapshot')
  card.unmount()
})

await check('Apply defaults reports each refused and managed outcome in the section summary without disturbing the others', async () => {
  const forms = makeForms({
    'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({}, 2), { accept: false }),
    'llm-pi-ai': new BoundForm('llm-pi-ai', readySnapshot(piAiValue({ retryPolicy: plain(PI_AI_RETRY_POLICY) }), 4, { providers: { openrouter: { retryPolicy: { maxRetries: 2 } } } }), {
      reject: () => Promise.reject(Object.assign(new Error('opaque'), { code: 'settings/rejected' })),
    }),
  })
  const { page } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(`DeepSeek: ${EN['apply.outcome.refused']}`), 'the refused apply outcome is missing from the summary')
  assert.ok(text.includes(`DeepSeek Account: ${EN['apply.outcome.saved']}`), 'the saved apply outcome is missing from the summary')
  assert.ok(text.includes(`OpenRouter: ${EN['apply.outcome.managed']}`), 'the managed apply outcome is missing from the summary')
})

/* ══ 15. manual same-turn retry: the Host desk, listener, and wire route ═══ */

/**
 * The Host's real `setTimeout`, captured before the timeout check clamps it.
 */
const realSetTimeout = globalThis.setTimeout

/** Sentinel for "the promise had not settled within the probe window". */
const NOT_SETTLED = Symbol('not-settled')

/** Resolve within `ms`, or return {@link NOT_SETTLED}. */
const settledWithin = (promise, ms = 40) => Promise.race([
  Promise.resolve(promise),
  new Promise(resolve => realSetTimeout(() => resolve(NOT_SETTLED), ms)),
])

/** One fake `http.ServerResponse` carrying the written status/headers/body. */
function retryRes() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers ?? {} },
    end(body) { out.body = body === undefined ? '' : String(body) },
  }
}

/** One fake `http.IncomingMessage` carrying a fixed UTF-8 body. */
function retryReq({ method = 'POST', url = '/llm-api-call-tuning/state', contentType = 'application/json', body = '' } = {}) {
  const headers = {}
  if (contentType !== undefined) headers['content-type'] = contentType
  if (body !== '') headers['content-length'] = String(Buffer.byteLength(body))
  return {
    method,
    url,
    headers,
    destroyed: false,
    destroy() { this.destroyed = true },
    [Symbol.asyncIterator]() {
      const chunk = body === '' ? undefined : Buffer.from(body)
      return (async function* () {
        if (chunk !== undefined) yield chunk
      })()
    },
  }
}

/** One `agent/request-error` payload. */
function retryPayload({
  sessionId = 'sess-main', turn = 1, step = 0, provider = 'deepseek',
  code = 'QUOTA', message = 'quota exceeded', mode = 'normal', signal, retryPolicy = true,
} = {}) {
  return {
    agent: { id: sessionId },
    turn,
    step,
    provider,
    failure: { code, message },
    ...(retryPolicy ? { retryPolicy: { mode } } : {}),
    ...(signal === undefined ? {} : { signal }),
  }
}

/** Build one host double and apply the real plugin against it. */
function manualRetryHost(options = {}) {
  const harness = hostApplyContext(options)
  host.apply(harness.ctx, {})
  return harness
}

/** The one `agent/request-error` listener the host registered. */
function retryListener(harness) {
  const entry = harness.calls.listeners.find(candidate => candidate.event === 'agent/request-error')
  assert.ok(entry !== undefined, 'the host registered no agent/request-error listener')
  return entry.listener
}

/** POST one client-request envelope through the real prefix route. */
async function retryCall(harness, {
  endpoint = 'state', payload, method = 'POST', contentType = 'application/json',
  url, rawBody, rpcId = 'rpc-1',
} = {}) {
  assert.equal(typeof harness.calls.route?.handler, 'function', 'the manual-retry route is not mounted')
  const body = rawBody !== undefined
    ? rawBody
    : JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
  const req = retryReq({ method, url: url ?? `/llm-api-call-tuning/${endpoint}`, contentType, body })
  const res = retryRes()
  await harness.calls.route.handler(req, res)
  let json
  try {
    json = JSON.parse(res.out.body)
  } catch {
    json = undefined
  }
  return { status: res.out.status, headers: res.out.headers, body: res.out.body, json, req }
}

/** Read the `value` of one successful route reply. */
const retryValue = reply => {
  assert.equal(reply.status, 200, `route answered HTTP ${reply.status}: ${reply.body}`)
  assert.equal(reply.json?.result?.ok, true, `route returned a failure envelope: ${reply.body}`)
  return reply.json.result.value
}

await check('the Host mounts the authenticated manual-retry route and the agent/request-error listener on its own fiber', () => {
  const harness = manualRetryHost()
  assert.deepEqual(harness.calls.injects, [['settings'], ['connection', 'webServer']], 'the host inject list drifted')
  assert.deepEqual(
    harness.calls.ctxEffects.map(entry => entry.label),
    ['llm-api-call-tuning: fetch timeouts', 'llm-api-call-tuning: manual-retry listener'],
    'the fiber-owned effects drifted',
  )
  assert.deepEqual(
    harness.calls.injectedEffects.map(entry => entry.label),
    [undefined, 'llm-api-call-tuning: manual-retry channel'],
    'the injected effects drifted',
  )
  assert.equal(typeof retryListener(harness), 'function', 'the agent/request-error listener is missing')
  assert.equal(harness.calls.route.path, '/llm-api-call-tuning', 'the manual-retry route path drifted')
  assert.equal(harness.calls.route.kind, 'prefix', 'the manual-retry route kind drifted')
  assert.equal(harness.calls.route.disposed, false, 'the route was disposed on mount')
  assert.deepEqual(harness.calls.warnings, [], `apply warned: ${JSON.stringify(harness.calls.warnings)}`)
  for (const entry of [...harness.calls.ctxEffects].reverse()) entry.dispose()
  for (const entry of [...harness.calls.injectedEffects].reverse()) entry.dispose?.()
  assert.equal(harness.calls.route.disposed, true, 'the channel disposer did not release the prefix route')
  assert.equal(harness.calls.listeners.filter(entry => entry.event === 'agent/request-error').length, 0, 'the listener disposer did not detach')
})

await check('always mode never prompts: the waterfall answers undefined immediately with a live watcher', async () => {
  const harness = manualRetryHost()
  retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-always' } }))
  const action = await settledWithin(retryListener(harness)(retryPayload({ sessionId: 'sess-always', mode: 'always' }), async () => undefined))
  assert.equal(action, undefined, `always mode answered ${String(action)} instead of declining`)
  assert.equal(action === NOT_SETTLED, false, 'always mode parked the turn behind a prompt')
  assert.deepEqual(retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-always' } })), { pending: null }, 'always mode left a pending prompt')
})

await check('next()-first ordering: an upstream retry action is passed through untouched and nothing is parked', async () => {
  const harness = manualRetryHost()
  retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-auto' } }))
  const action = await retryListener(harness)(retryPayload({ sessionId: 'sess-auto', code: 'AUTH' }), async () => ({ kind: 'retry' }))
  assert.deepEqual(action, { kind: 'retry' }, 'the downstream retry action was not passed through')
  assert.deepEqual(retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-auto' } })), { pending: null }, 'an automatically retried failure was also parked')
})

await check('the watcher gate declines immediately without a recent state poll, and a stale poll stops authorizing prompts', async () => {
  const harness = manualRetryHost()
  const noWatcher = await settledWithin(retryListener(harness)(retryPayload({ sessionId: 'sess-nowatch' }), async () => undefined))
  assert.equal(noWatcher, undefined, 'a session with no page watcher parked the turn')
  assert.equal(noWatcher === NOT_SETTLED, false, 'a session with no page watcher parked the turn behind a prompt')

  retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-stale' } }))
  const originalNow = Date.now
  try {
    const shifted = originalNow() + 21_000
    Date.now = () => shifted
    const stale = await settledWithin(retryListener(harness)(retryPayload({ sessionId: 'sess-stale' }), async () => undefined))
    assert.equal(stale, undefined, 'a 21 s-old state poll still authorized a prompt')
    assert.equal(stale === NOT_SETTLED, false, 'a stale watcher parked the turn behind a prompt')
  } finally {
    Date.now = originalNow
  }
})

await check('state parks one failure and reports nonce/turn/step/provider/code/message/expiresAt/attemptsLeft', async () => {
  const harness = manualRetryHost()
  const empty = await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-main' } })
  assert.deepEqual(plain(empty.json), {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: { ok: true, value: { pending: null } },
  }, 'the empty state envelope drifted')
  assert.equal(empty.headers['content-type'], 'application/json', 'the route did not answer application/json')

  const parked = retryListener(harness)(retryPayload({ sessionId: 'sess-main' }), async () => undefined)
  await flush()
  const pending = retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-main' } })).pending
  assert.ok(pending !== null, 'the parked failure did not surface on state')
  assert.equal(typeof pending.nonce, 'string', 'the pending prompt carries no nonce')
  assert.ok(pending.nonce.length >= 8, `the nonce is too short: ${pending.nonce}`)
  assert.equal(pending.turn, 1, 'the pending turn drifted')
  assert.equal(pending.step, 0, 'the pending step drifted')
  assert.equal(pending.provider, 'deepseek', 'the pending provider drifted')
  assert.equal(pending.code, 'QUOTA', 'the pending failure code drifted')
  assert.equal(pending.message, 'quota exceeded', 'the pending message drifted')
  assert.ok(Number.isFinite(pending.expiresAt) && pending.expiresAt > Date.now(), 'the pending expiry is in the past')
  assert.equal(pending.attemptsLeft, 5, 'the first prompt must offer five attempts')
  assert.ok(parked instanceof Promise, 'the waterfall was not parked')
  // Clean up: the parked waterfall owns a 90 s decision timer that would keep
  // the process alive (and disposal settling it is asserted separately below).
  harness.calls.ctxEffects.find(entry => entry.label === 'llm-api-call-tuning: manual-retry listener').dispose()
  assert.equal(await settledWithin(parked, 300), undefined, 'settling the shape fixture revealed a different action')
})

await check('decide accepts only the right nonce for the owning session; accept settles the retry, stale/replay/foreign decisions do not', async () => {
  const harness = manualRetryHost()
  retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-main' } }))
  const parked = retryListener(harness)(retryPayload({ sessionId: 'sess-main' }), async () => undefined)
  await flush()
  const pending = retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-main' } })).pending
  assert.ok(pending !== null, 'the failure was not parked')

  const wrong = await retryCall(harness, { endpoint: 'decide', payload: { sessionId: 'sess-main', nonce: 'nope', decision: 'retry' } })
  assert.equal(wrong.json.result.ok, false, 'a wrong nonce was accepted')
  assert.equal(wrong.json.result.error.code, 'manual-retry/stale', 'a wrong nonce did not answer manual-retry/stale')
  const foreign = await retryCall(harness, { endpoint: 'decide', payload: { sessionId: 'sess-other', nonce: pending.nonce, decision: 'retry' } })
  assert.equal(foreign.json.result.error.code, 'manual-retry/stale', 'a cross-session decision was not rejected as stale')
  const invalid = await retryCall(harness, { endpoint: 'decide', payload: { sessionId: 'sess-main', nonce: pending.nonce, decision: 'maybe' } })
  assert.equal(invalid.json.result.error.code, 'manual-retry/bad-request', 'an invalid decision was not answered bad-request')
  assert.equal(parked instanceof Promise, true, 'an invalid decision settled the parked turn')

  const accepted = await retryCall(harness, { endpoint: 'decide', payload: { sessionId: 'sess-main', nonce: pending.nonce, decision: 'retry' } })
  assert.deepEqual(retryValue(accepted), { accepted: true }, 'the accepted decision envelope drifted')
  assert.deepEqual(await parked, { kind: 'retry' }, 'the accepted retry did not reach the parked waterfall')
  const replay = await retryCall(harness, { endpoint: 'decide', payload: { sessionId: 'sess-main', nonce: pending.nonce, decision: 'retry' } })
  assert.equal(replay.json.result.error.code, 'manual-retry/stale', 'a replayed decision settled the prompt twice')
  assert.deepEqual(retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-main' } })), { pending: null }, 'the accepted decision left the pending entry behind')
})

await check('the per-turn cap is five manual retries; the sixth failure declines immediately', async () => {
  const harness = manualRetryHost()
  const sessionId = 'sess-cap'
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId } }))
    const parked = retryListener(harness)(retryPayload({ sessionId, turn: 3 }), async () => undefined)
    await flush()
    const pending = retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId } })).pending
    assert.ok(pending !== null, `attempt ${String(attempt)} was not offered`)
    assert.equal(pending.attemptsLeft, 6 - attempt, `attemptsLeft drifted on attempt ${String(attempt)}`)
    const accepted = await retryCall(harness, { endpoint: 'decide', payload: { sessionId, nonce: pending.nonce, decision: 'retry' } })
    assert.deepEqual(retryValue(accepted), { accepted: true }, `attempt ${String(attempt)} was not accepted`)
    assert.deepEqual(await parked, { kind: 'retry' }, `attempt ${String(attempt)} did not settle the waterfall`)
  }
  retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId } }))
  const sixth = await settledWithin(retryListener(harness)(retryPayload({ sessionId, turn: 3 }), async () => undefined))
  assert.equal(sixth, undefined, 'the sixth manual retry was offered')
  assert.equal(sixth === NOT_SETTLED, false, 'the per-turn cap parked the sixth prompt')
})

await check('the decision timeout and a payload.signal abort both resolve undefined and clear the pending entry', async () => {
  const harness = manualRetryHost()
  const unclamped = globalThis.setTimeout
  globalThis.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms >= 90_000 ? 10 : ms, ...args)
  try {
    retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-timeout' } }))
    const parked = retryListener(harness)(retryPayload({ sessionId: 'sess-timeout' }), async () => undefined)
    await flush()
    assert.ok(retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-timeout' } })).pending !== null, 'the timeout fixture did not park')
    assert.equal(await settledWithin(parked, 300), undefined, 'the 90 s decision timeout did not decline the prompt')
    assert.deepEqual(retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-timeout' } })), { pending: null }, 'a timed-out prompt stayed pending')
  } finally {
    globalThis.setTimeout = unclamped
  }

  const abortHarness = manualRetryHost()
  retryValue(await retryCall(abortHarness, { endpoint: 'state', payload: { sessionId: 'sess-abort' } }))
  const controller = new AbortController()
  const aborted = retryListener(abortHarness)(retryPayload({ sessionId: 'sess-abort', signal: controller.signal }), async () => undefined)
  await flush()
  assert.ok(retryValue(await retryCall(abortHarness, { endpoint: 'state', payload: { sessionId: 'sess-abort' } })).pending !== null, 'the abort fixture did not park')
  controller.abort()
  assert.equal(await settledWithin(aborted, 300), undefined, 'aborting the turn did not decline the prompt')
  assert.deepEqual(retryValue(await retryCall(abortHarness, { endpoint: 'state', payload: { sessionId: 'sess-abort' } })), { pending: null }, 'an aborted prompt stayed pending')
})

await check('disposal settles every parked prompt with undefined and detaches the listener (no open turn can hang)', async () => {
  const harness = manualRetryHost()
  retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-settle' } }))
  const parked = retryListener(harness)(retryPayload({ sessionId: 'sess-settle' }), async () => undefined)
  await flush()
  assert.ok(retryValue(await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-settle' } })).pending !== null, 'the disposal fixture did not park')
  const effect = harness.calls.ctxEffects.find(entry => entry.label === 'llm-api-call-tuning: manual-retry listener')
  assert.ok(effect !== undefined, 'the listener effect is missing')
  effect.dispose()
  assert.equal(await settledWithin(parked, 300), undefined, 'disposing the plugin left the parked turn open')
  assert.equal(harness.calls.listeners.filter(entry => entry.event === 'agent/request-error').length, 0, 'disposal did not detach the listener')
})

await check('the route fence answers requestRejection 401/403 before method, body, or envelope parsing', async () => {
  for (const [status, copy] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const harness = manualRetryHost({ requestRejection: () => status })
    const reply = await retryCall(harness, { method: 'GET', url: '/llm-api-call-tuning/state', rawBody: '{not json' })
    assert.equal(reply.status, status, `the trust fence did not answer ${String(status)} first`)
    assert.equal(reply.body, copy, `the ${String(status)} body drifted to ${JSON.stringify(reply.body)}`)
  }
})

await check('the route guards answer 404 unknown endpoint, 405 non-POST, 415 wrong media, 400 bad JSON, and 413 oversized bodies', async () => {
  const harness = manualRetryHost()
  const unknown = await retryCall(harness, { endpoint: 'nope', payload: { sessionId: 'x' } })
  assert.equal(unknown.status, 404, 'an unknown endpoint was not answered 404')
  const get = await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'x' }, method: 'GET' })
  assert.equal(get.status, 405, 'a non-POST request was not answered 405')
  assert.equal(get.headers.allow, 'POST', 'the 405 reply does not advertise allow: POST')
  const media = await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'x' }, contentType: 'text/plain' })
  assert.equal(media.status, 415, 'a wrong media type was not answered 415')
  const malformed = await retryCall(harness, { endpoint: 'state', rawBody: '{not json' })
  assert.equal(malformed.status, 400, 'a malformed body was not answered 400')
  const oversized = await retryCall(harness, { endpoint: 'state', rawBody: 'x'.repeat(70 * 1024) })
  assert.equal(oversized.status, 413, 'an oversized body was not answered 413')
  assert.equal(oversized.req.destroyed, true, 'the oversized request was not destroyed')
})

await check('the route frames every answer as a server-response envelope with connection-style business errors', async () => {
  const harness = manualRetryHost()
  const valid = await retryCall(harness, { endpoint: 'state', payload: { sessionId: 'sess-wire' } })
  assert.deepEqual(plain(valid.json), {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: { ok: true, value: { pending: null } },
  }, 'the successful envelope drifted')

  const bare = await retryCall(harness, { endpoint: 'state', rawBody: JSON.stringify({ nope: true }) })
  assert.equal(bare.status, 200, 'a malformed client-request must still be framed as 200 + envelope')
  assert.equal(bare.json.rpcId, 'invalid-request', 'the invalid-request rpcId drifted')
  assert.equal(bare.json.result.ok, false, 'a malformed client-request was accepted')
  assert.equal(bare.json.result.error.code, 'manual-retry/bad-request', 'the malformed envelope code drifted')

  const mismatch = await retryCall(harness, {
    endpoint: 'state',
    rawBody: JSON.stringify({ type: 'client-request', rpcId: 'r9', method: 'decide', payload: { sessionId: 'x' } }),
  })
  assert.equal(mismatch.json.rpcId, 'r9', 'the method-mismatch reply did not echo the rpcId')
  assert.equal(mismatch.json.result.error.code, 'manual-retry/bad-request', 'a method/endpoint mismatch was not bad-request')

  const badPayload = await retryCall(harness, { endpoint: 'state', payload: { sessionId: 42 } })
  assert.equal(badPayload.json.result.error.code, 'manual-retry/bad-request', 'a non-string sessionId was not bad-request')

  const stale = await retryCall(harness, { endpoint: 'decide', payload: { sessionId: 'sess-wire', nonce: 'nope', decision: 'retry' } })
  assert.equal(stale.json.result.ok, false, 'a stale decision was accepted')
  assert.equal(stale.json.result.error.code, 'manual-retry/stale', 'the stale code drifted')
  assert.equal(typeof stale.json.result.error.message, 'string', 'the stale error carries no message')
  assert.deepEqual(plain(stale.json.result.error.details), {}, 'the stale error details drifted')
})

await check('a headless Host boots without connection/webServer, registers no route, and the listener stays quiet', async () => {
  const harness = manualRetryHost({ browser: false })
  assert.deepEqual(harness.calls.injects, [['settings'], ['connection', 'webServer']], 'the guarded inject list drifted')
  assert.equal(harness.calls.route, undefined, 'a route was mounted although the browser services are unmet')
  assert.deepEqual(harness.calls.warnings, [], `the headless boot warned: ${JSON.stringify(harness.calls.warnings)}`)
  const action = await settledWithin(retryListener(harness)(retryPayload({ sessionId: 'sess-headless' }), async () => undefined))
  assert.equal(action, undefined, 'a headless Host parked a turn')
  assert.equal(action === NOT_SETTLED, false, 'a headless Host parked a turn behind a prompt')
})

/* ══ 16. manual same-turn retry: the client dock ══════════════════════════ */

/**
 * One fake session store for the dock's `useSession(selector)` prop, wired to
 * the gate's React double so `setRunning()` re-renders the dock.
 * @param running - the initial `state.running`.
 * @returns the store plus `useSession` and `setRunning`.
 */
function sessionDouble(running) {
  let snapshot = { running }
  const listeners = new Set()
  return {
    useSession(selector) {
      return react.React.useSyncExternalStore(
        listener => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        () => selector(snapshot),
      )
    },
    setRunning(next) {
      if (snapshot.running === next) return
      snapshot = { ...snapshot, running: next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * A fake `connection.rpc` that records every call and answers through `reply`.
 * @param reply - `(entry) => object | Promise<object>`; defaults to "no pending".
 * @returns the connection double with its recorded calls.
 */
function retryConnection(reply = () => ({ ok: true, value: { pending: null } })) {
  const calls = []
  return {
    calls,
    rpc: {
      call(channel, endpoint, payload, signal) {
        const entry = { channel, endpoint, payload, signal }
        calls.push(entry)
        try {
          return Promise.resolve(reply(entry))
        } catch (error) {
          return Promise.reject(error)
        }
      },
    },
  }
}

/** One wire-shaped pending decision for the dock fixtures. */
const retryPending = (overrides = {}) => ({
  nonce: 'nonce-abcdefgh',
  turn: 1,
  step: 0,
  provider: 'deepseek',
  code: 'QUOTA',
  message: 'quota exceeded',
  expiresAt: Date.now() + 90_000,
  attemptsLeft: 5,
  ...overrides,
})

/** The `state` replies: `pending` when armed, otherwise none. */
const stateReply = pending => () => ({ ok: true, value: { pending } })

await check('the dock renders NO alert when the Host holds no pending decision, and polls every 2000 ms while running', async () => {
  const connection = retryConnection()
  const { page } = mountDock({ connection })
  await flush()
  assert.equal(page.tree, null, 'the dock rendered without a pending decision')
  assert.equal(connection.calls.length, 1, `the dock did not poll once on mount (calls: ${connection.calls.length})`)
  assert.equal(connection.calls[0].channel, '/llm-api-call-tuning', 'the dock called the wrong channel')
  assert.equal(connection.calls[0].endpoint, 'state', 'the dock called the wrong endpoint')
  assert.deepEqual(plain(connection.calls[0].payload), { sessionId: 'sess-main' }, 'the state payload drifted')
  assert.ok(connection.calls[0].signal instanceof AbortSignal, 'the state poll carried no AbortSignal')
  await vmTimers.advance(2000)
  assert.equal(connection.calls.length, 2, 'the 2000 ms poll did not fire')
  await vmTimers.advance(2000)
  assert.equal(connection.calls.length, 3, 'the second 2000 ms poll did not fire')
  page.unmount()
})

await check('a pending decision renders code, provider, message, Retry/Dismiss, and the attempt indicator', async () => {
  const connection = retryConnection(stateReply(retryPending()))
  const { page } = mountDock({ connection })
  await flush()
  const alerts = findAll(page.tree, node => node.props?.role === 'alert')
  assert.equal(alerts.length, 1, `the dock rendered ${alerts.length} alert rows, expected one`)
  const text = renderedText(page.tree)
  for (const copy of ['QUOTA', 'deepseek', 'quota exceeded', EN['manualRetry.title'], EN['manualRetry.retry'], EN['manualRetry.dismiss'], `${EN['manualRetry.attempt']} 1/5`]) {
    assert.ok(text.includes(copy), `the dock is missing ${JSON.stringify(copy)}`)
  }
  assert.equal(alerts[0].props['aria-label'], EN['manualRetry.aria'], 'the dock aria-label drifted')
  assert.equal(buttonWithText(page.tree, [EN['manualRetry.retry']]).props.disabled, false, 'Retry is disabled on a live offer')
  assert.equal(buttonWithText(page.tree, [EN['manualRetry.dismiss']]).props.disabled, false, 'Dismiss is disabled on a live offer')
  page.unmount()
})

await check('the dock stops polling and hides as soon as the session is not running', async () => {
  const connection = retryConnection(stateReply(retryPending()))
  const { page, session } = mountDock({ connection })
  await flush()
  assert.notEqual(page.tree, null, 'the dock did not render for a running session with a pending decision')
  const pollsBefore = connection.calls.length
  const lastSignal = connection.calls[connection.calls.length - 1].signal
  session.setRunning(false)
  await flush()
  assert.equal(page.tree, null, 'the dock stayed visible on a stopped session')
  assert.equal(lastSignal.aborted, true, 'stopping the session did not abort the in-flight poll')
  await vmTimers.advance(2000)
  assert.equal(connection.calls.length, pollsBefore, 'the dock kept polling after the session stopped')
  page.unmount()
})

await check('Retry posts decide once with the session/nonce, disables both buttons while in flight, and hides on acceptance', async () => {
  let resolveDecide
  const connection = retryConnection(entry => {
    if (entry.endpoint === 'state') return { ok: true, value: { pending: retryPending() } }
    return new Promise(resolve => { resolveDecide = resolve })
  })
  const { page } = mountDock({ connection })
  await flush()
  buttonWithText(page.tree, [EN['manualRetry.retry']]).props.onClick()
  await flush()
  const decideCall = connection.calls[connection.calls.length - 1]
  assert.equal(decideCall.endpoint, 'decide', 'the Retry click did not post decide')
  assert.equal(decideCall.channel, '/llm-api-call-tuning', 'the decide call used the wrong channel')
  assert.deepEqual(plain(decideCall.payload), { sessionId: 'sess-main', nonce: 'nonce-abcdefgh', decision: 'retry' }, 'the decide payload drifted')
  assert.equal(buttonWithText(page.tree, [EN['manualRetry.retry']]).props.disabled, true, 'Retry stayed enabled while the decide call was in flight')
  assert.equal(buttonWithText(page.tree, [EN['manualRetry.dismiss']]).props.disabled, true, 'Dismiss stayed enabled while the decide call was in flight')
  resolveDecide({ ok: true, value: { accepted: true } })
  await flush()
  assert.equal(page.tree, null, 'the dock stayed visible after an accepted decision')
  page.unmount()
})

await check('Dismiss posts dismiss, a stale reply clears the bar silently, and a transport failure keeps the offer', async () => {
  const staleConnection = retryConnection(entry => {
    if (entry.endpoint === 'state') return { ok: true, value: { pending: retryPending() } }
    return { ok: false, error: { code: 'manual-retry/stale', message: 'gone', details: {} } }
  })
  const stale = mountDock({ connection: staleConnection })
  await flush()
  buttonWithText(stale.page.tree, [EN['manualRetry.dismiss']]).props.onClick()
  await flush()
  assert.equal(staleConnection.calls[staleConnection.calls.length - 1].payload.decision, 'dismiss', 'Dismiss did not post decision: dismiss')
  assert.equal(stale.page.tree, null, 'a stale reply did not clear the bar')
  stale.page.unmount()

  let stateCalls = 0
  const flakyConnection = retryConnection(entry => {
    if (entry.endpoint === 'state') {
      stateCalls += 1
      if (stateCalls === 1) return { ok: true, value: { pending: retryPending() } }
      return Promise.reject(new Error('connection blip'))
    }
    return Promise.reject(new Error('connection blip'))
  })
  const flaky = mountDock({ connection: flakyConnection })
  await flush()
  assert.notEqual(flaky.page.tree, null, 'the first offer did not render')
  buttonWithText(flaky.page.tree, [EN['manualRetry.retry']]).props.onClick()
  await flush()
  assert.notEqual(flaky.page.tree, null, 'a transport failure on decide flickered the offer away')
  assert.equal(buttonWithText(flaky.page.tree, [EN['manualRetry.retry']]).props.disabled, false, 'a transport failure left the buttons disabled')
  await vmTimers.advance(2000)
  assert.notEqual(flaky.page.tree, null, 'a transport failure on state dropped the last known offer')
  flaky.page.unmount()
})

await check('an expired offer renders the expired copy and only Dismiss (never Retry)', async () => {
  const connection = retryConnection(stateReply(retryPending({ expiresAt: Date.now() - 1000 })))
  const { page } = mountDock({ connection })
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(EN['manualRetry.expired']), 'the expired copy is missing')
  assert.equal(text.includes(EN['manualRetry.retry']), false, 'an expired offer still renders Retry')
  assert.ok(buttonWithText(page.tree, [EN['manualRetry.dismiss']]) !== undefined, 'an expired offer lost Dismiss')
  page.unmount()
})

await check('a session change re-polls for the new session and never paints the previous session offer', async () => {
  const connection = retryConnection(entry => ({ ok: true, value: { pending: retryPending() } }))
  const { page, props } = mountDock({ connection, sessionId: 'sess-a' })
  await flush()
  assert.notEqual(page.tree, null, 'the first session offer did not render')
  page.updateProps({ ...props, sessionId: 'sess-b' })
  await flush()
  const sessions = connection.calls.filter(entry => entry.endpoint === 'state').map(entry => entry.payload.sessionId)
  assert.deepEqual(sessions, ['sess-a', 'sess-b'], `the dock polled sessions ${JSON.stringify(sessions)}`)
  assert.notEqual(page.tree, null, 'the re-polled session offer did not render')
  assert.equal(connection.calls[connection.calls.length - 1].payload.sessionId, 'sess-b', 'the live offer still belongs to the old session')
  page.unmount()
})

await check('unmounting the dock aborts the in-flight poll and stops the timer', async () => {
  const connection = retryConnection(stateReply(retryPending()))
  const { page } = mountDock({ connection })
  await flush()
  const signal = connection.calls[connection.calls.length - 1].signal
  const callsBefore = connection.calls.length
  page.unmount()
  assert.equal(signal.aborted, true, 'unmounting the dock did not abort the in-flight poll')
  await vmTimers.advance(2000)
  assert.equal(connection.calls.length, callsBefore, 'unmounting the dock left its poll timer running')
})

await check('a dock mounted without the connection service stays hidden and never throws', async () => {
  const { page } = mountDock({ connection: undefined })
  await flush()
  assert.equal(page.tree, null, 'the dock rendered without a connection service')
  await vmTimers.advance(2000)
  assert.equal(page.tree, null, 'the dock surfaced an offer without a connection service')
  page.unmount()
})

/* ══ 17. cross-half contract and the settings page beside the dock ════════ */

await check('both halves agree on the channel, endpoints, poll cadence, cap, and the six manualRetry copy keys', async () => {
  const harness = manualRetryHost()
  assert.equal(harness.calls.route.path, '/llm-api-call-tuning', 'the host channel drifted')
  const connection = retryConnection()
  const { page } = mountDock({ connection })
  await flush()
  assert.equal(connection.calls[0].channel, harness.calls.route.path, 'the client and host channel literals disagree')
  assert.equal(connection.calls[0].endpoint, 'state', 'the first endpoint must be state')
  assert.equal(connection.calls.length, 1, 'the dock polled more than once on mount')
  await vmTimers.advance(2000)
  assert.equal(connection.calls.length, 2, 'the 2000 ms poll cadence drifted')
  page.unmount()
  for (const key of ['manualRetry.aria', 'manualRetry.title', 'manualRetry.retry', 'manualRetry.dismiss', 'manualRetry.attempt', 'manualRetry.expired']) {
    assert.equal(typeof COPY.en[key], 'string', `en is missing ${key}`)
    assert.equal(typeof COPY.zh[key], 'string', `zh is missing ${key}`)
  }
  assert.equal(COPY.en['manualRetry.attempt'], 'Attempt', 'the attempt copy drifted')
  assert.equal(COPY.en['manualRetry.retry'], 'Retry', 'the retry copy drifted')
  assert.equal(COPY.en['manualRetry.dismiss'], 'Dismiss', 'the dismiss copy drifted')
})

await check('the client declares the connection service its dock calls and resolves it lazily through ctx.get', async () => {
  assert.deepEqual(
    [...clientPlugin.inject],
    ['slots', 'locale', 'configForms', 'remote', 'connection'],
    `the client inject list drifted: ${JSON.stringify(clientPlugin.inject)}`,
  )
  const connection = retryConnection()
  const { ctx, page } = mountDock({ connection })
  await flush()
  assert.equal(ctx.state.serviceReads.includes('connection'), true, 'the dock never resolved the connection service through ctx.get')
  assert.equal(connection.calls.length, 1, 'the dock did not poll through the resolved connection service')
  page.unmount()
})

await check('the settings page still renders (and the dock stays hidden) when connection/webServer are unavailable', async () => {
  const headless = mountPage()
  await flush()
  assert.equal(sectionCards(headless.page.tree).length, 2, 'the settings page stopped rendering without the browser services')
  assert.deepEqual(ctxEffectsOf(headless.ctx), ['dsh-llm-api-call-tuning: dictionaries'], 'the client registered extra effects')
  assert.equal(headless.ctx.state.injections.length, 2, 'the dock and settings slot registrations drifted')
  headless.page.unmount()
})

/** Every effect label one fake client context recorded. */
function ctxEffectsOf(ctx) {
  return [...ctx.state.effects]
}

/* ══ summary ══════════════════════════════════════════════════════════════ */

/* ══ summary ═══════════════════════════════════════════════════════════════ */

const passed = checks - failures.length
process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${skips.length} skipped (${checks} checks)\n`)
if (failures.length > 0) {
  process.stdout.write(`failed checks:\n${failures.map(failure => `  - ${failure.label}: ${failure.message}`).join('\n')}\n`)
  process.exitCode = 1
}
