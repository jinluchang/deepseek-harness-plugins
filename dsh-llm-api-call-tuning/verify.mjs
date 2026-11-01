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

/** The rendered text inputs of one surface, in field order. */
const numericInputs = tree => findAll(tree, node => node.type === 'input' && node.props.inputMode !== undefined)

/**
 * The two fetch-timer inputs of the fourth card, in FETCH_KEYS order. They are
 * the only text inputs on the page root carrying the fetch placeholder (the
 * retry controls have none; the timeout card's inputs live in child rows).
 */
const fetchInputs = tree => findAll(
  tree,
  node => node.type === 'input' && node.props.inputMode !== undefined && node.props.placeholder === EN['fetch.placeholder'],
)

/**
 * The timeout-card inputs of one timeout row, in `timeoutFieldsFor(family)`
 * order. A timeout input is distinguishable by its numeric placeholder
 * (`300000` / `600000` / `60000`), which no other input carries.
 */
const timeoutInputs = tree => findAll(
  tree,
  node => node.type === 'input'
    && node.props.inputMode !== undefined
    && node.props.placeholder !== undefined
    && node.props.placeholder !== EN['fetch.placeholder'],
)

/** The mode select of one surface. */
const modeSelect = tree => findAll(tree, node => node.type === 'select')[0]

/** The rendered code checkboxes of one surface, in RETRYABLE_CODES order. */
const codeCheckboxes = tree => findAll(tree, node => node.type === 'input' && node.props.type === 'checkbox')

/** Type text into one numeric field by index (maxRetries, initial, max, jitter). */
function setNumeric(tree, index, text) {
  const input = numericInputs(tree)[index]
  if (input === undefined) throw new Error(`no rendered numeric input at index ${String(index)}`)
  input.props.onChange({ target: { value: text } })
}

/** Type text into one fetch-timer input by index (headers, body). */
function setFetchNumeric(tree, index, text) {
  const input = fetchInputs(tree)[index]
  if (input === undefined) throw new Error(`no rendered fetch input at index ${String(index)}`)
  input.props.onChange({ target: { value: text } })
}

/** Type text into one timeout-row input by index (field order of its family). */
function setTimeoutNumeric(tree, index, text) {
  const input = timeoutInputs(tree)[index]
  if (input === undefined) throw new Error(`no rendered timeout input at index ${String(index)}`)
  input.props.onChange({ target: { value: text } })
}

/** The "Unlimited" preset buttons of one timeout row, one per visible field. */
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

/** The six values the global defaults card starts from. */
const TUNE_VALUE = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
})

/**
 * The fresh-install state of the two process-wide fetch timers: both UNSET
 * (`null` in the host metadata), so the fetch card renders two empty inputs.
 */
const FETCH_VALUE = Object.freeze({ headersTimeoutMs: null, bodyTimeoutMs: null })

/** A ready own-namespace snapshot: the retry defaults plus the given fetch leaves. */
const tuningSnapshot = (fetch = {}, revision = 7) => readySnapshot({ ...TUNE_VALUE, ...fetch }, revision)

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

/** Build the form doubles for one mount; `overrides` replaces individual namespaces. */
function makeForms(overrides = {}) {
  const forms = {
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', readySnapshot(TUNE_VALUE, 7)),
    'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({}, 2)),
    'llm-deepseek-account': new BoundForm('llm-deepseek-account', readySnapshot({}, 3)),
    'llm-pi-ai': new BoundForm('llm-pi-ai', readySnapshot({
      providers: {
        openrouter: {
          retryPolicy: {
            mode: 'normal',
            maxRetries: 2,
            retryableCodes: ['RATE_LIMIT'],
            backoff: { initialDelayMs: 250, maxDelayMs: 5000, jitterRatio: 0.2 },
          },
        },
      },
    }, 4, { providers: { openrouter: { retryPolicy: { mode: 'normal', maxRetries: 2 } } } })),
  }
  return Object.assign(forms, overrides)
}

/**
 * Build the form doubles with ONE provider namespace replaced by an explicit
 * snapshot, for the provider-timeout seeding/gating fixtures.
 * @param ns - the provider namespace.
 * @param value - the resolved section value.
 * @param user - the user layer (timeout/retry overrides).
 * @param revision - the snapshot revision.
 * @returns the complete form set.
 */
function providerForms(ns, value, user, revision) {
  return makeForms({ [ns]: new BoundForm(ns, readySnapshot(value, revision, user)) })
}

/** A pi-ai section value with one openrouter profile. */
const piAiValue = profile => ({ providers: { openrouter: profile } })

/**
 * Build a fake client root context with the services the client half injects.
 * @param options - `forms` (the form doubles), `registered` / `configurable`
 *   (the provider directory), `remote` (`'dotted'`, `'fallback'`, `'throwing'`,
 *   or `'none'`), and `remoteImpl` (an explicit `llm` service double).
 * @returns the context double plus its recording state.
 */
function fakeContext({ forms = makeForms(), registered = REGISTERED, configurable = CONFIGURABLE, remote = 'dotted', remoteImpl } = {}) {
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

/**
 * Mount the real section against a fresh form set.
 * @param options - passed through to {@link fakeContext}.
 * @returns the context, registration, injected face, and mounted page.
 */
function mountPage(options = {}) {
  const ctx = fakeContext(options)
  clientPlugin.apply(ctx)
  const registration = ctx.state.registered[0]
  const face = registration.options.inject()
  const page = react.mount(registration.component, face)
  return { ctx, registration, face, page }
}

/**
 * The rendered RETRY-row placeholders of a mounted page, in order. The timeout
 * card renders rows with the same `row` prop, so the retry set is identified by
 * its `defaultsValues` prop (the timeout rows carry `bodyTimeoutMs` instead).
 */
const rowElements = page => findAll(
  page.tree,
  node => typeof node.type === 'function' && node.props?.row !== undefined && 'defaultsValues' in node.props,
)

/** The rendered PROVIDER-TIMEOUT row placeholders of a mounted page, in order. */
const timeoutRowElements = page => findAll(
  page.tree,
  node => typeof node.type === 'function' && node.props?.row !== undefined && 'bodyTimeoutMs' in node.props,
)

/** The retry-row placeholder for one provider key. */
function rowElement(page, provider) {
  const found = rowElements(page).find(node => node.props.row.provider === provider)
  if (found === undefined) throw new Error(`no retry row rendered for "${provider}"`)
  return found
}

/** The timeout-row placeholder for one provider key. */
function timeoutRowElement(page, provider) {
  const found = timeoutRowElements(page).find(node => node.props.row.provider === provider)
  if (found === undefined) throw new Error(`no timeout row rendered for "${provider}"`)
  return found
}

/** Mount one retry-row child exactly as the page renders it. */
function mountRow(page, provider) {
  const element = rowElement(page, provider)
  return react.mount(element.type, element.props)
}

/** Mount one timeout-row child exactly as the page renders it. */
function mountTimeoutRow(page, provider) {
  const element = timeoutRowElement(page, provider)
  return react.mount(element.type, element.props)
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
      '@deepseek-ai/dsh-client-locale',
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
  return ctx.state.registered[0]?.options
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
 * Build a fake Host context with the `settings` inject and the row fiber.
 * @param options - `configure` overrides the settings.configure body (may throw);
 *   `logger` seeds the optional logger.
 * @returns the context, the recorded calls, and the fiber.
 */
function hostApplyContext({ configure, logger } = {}) {
  const calls = { injects: [], effects: 0, configures: [], warnings: [] }
  const fiber = { __fiber: true }
  const child = {
    effect(callback) {
      calls.effects += 1
      const dispose = callback()
      assert.equal(typeof dispose, 'function', 'the injected effect must return a disposer')
      return dispose
    },
    settings: {
      configure(presentation, owner) {
        calls.configures.push({ presentation, owner })
        if (typeof configure === 'function') return configure()
        return () => {}
      },
    },
  }
  const ctx = {
    fiber,
    get(service) { return service === 'logger' ? logger : undefined },
    inject(services, callback) { calls.injects.push(services); callback(child); return child },
  }
  return { ctx, calls, fiber }
}

await check('apply injects settings and suppresses the generated form with the row fiber', () => {
  const { ctx, calls, fiber } = hostApplyContext()
  host.apply(ctx)
  assert.deepEqual(calls.injects, [['settings']], `apply injected ${JSON.stringify(calls.injects)}`)
  assert.equal(calls.effects, 1, `apply mounted ${calls.effects} effects, expected one`)
  assert.equal(calls.configures.length, 1, `settings.configure was called ${calls.configures.length} times`)
  assert.deepEqual(calls.configures[0].presentation, { auto: false }, 'the auto-generated settings form was not suppressed')
  assert.equal(calls.configures[0].owner, fiber, 'settings.configure must receive the row fiber')
})

await check('a configure() refusal warns and still returns a disposer; a host without a logger is tolerated', () => {
  const logger = { last: undefined, warn(message) { this.last = message } }
  const refusing = hostApplyContext({ configure() { throw new Error('already configured') }, logger })
  assert.doesNotThrow(() => host.apply(refusing.ctx), 'apply must not fail boot when the page suppression is refused')
  assert.match(String(logger.last), /llm-api-call-tuning: the automatic settings page could not be suppressed: already configured/, `the warning drifted: ${String(logger.last)}`)

  const bare = hostApplyContext({ configure() { throw 'denied' } })
  assert.doesNotThrow(() => host.apply(bare.ctx), 'apply must not assume a logger')
})

await check('with no lifecycle effects or loader events, apply() still adds no projection and no extra inject', () => {
  // This fake context has no `ctx.on` and no `ctx.effect`, so the second job
  // (the fetch-timeout dispatcher) runs its reconcile inline: with both fetch
  // values unset that is a no-op. The new listener/effect surface is pinned by
  // the dispatcher checks below.
  const { ctx, calls } = hostApplyContext()
  host.apply(ctx)
  assert.deepEqual(calls.injects, [['settings']], 'apply injected another service')
  assert.equal(calls.effects, 1, 'apply mounted more than one injected effect')
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
  const state = { warnings: [], infos: [], listeners: [], disposers: [], effectLabels: [] }
  const logger = { warn(message) { state.warnings.push(message) }, info(message) { state.infos.push(message) } }
  const child = {
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
    settings: { configure() { return () => {} } },
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
    assert.deepEqual(state.listeners.map(entry => entry.event), ['loader/volatile-update', 'app-boot/config-reload'], 'the two reload listeners were not registered')
    assert.equal(state.effectLabels.includes('llm-api-call-tuning: fetch timeouts'), true, `the fetch-timeout effect label drifted: ${JSON.stringify(state.effectLabels)}`)
    assert.deepEqual(state.warnings, [], `apply() with both values unset warned: ${JSON.stringify(state.warnings)}`)
  } finally {
    dispose()
    undici.setGlobalDispatcher(original)
  }
  assert.deepEqual(state.listeners, [], 'dispose() did not detach both reload listeners')
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
    assert.equal(state.listeners.length, 2, 'the reload listeners are missing')

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
    assert.equal(state.listeners.length, 2, 'clearing the values detached the reload listeners (a later live save must still install)')

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
const child = { effect(callback) { return callback() }, settings: { configure() { return () => {} } } }
const ctx = {
  inject(services, callback) { callback(child); return child },
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
  assert.deepEqual(result.events, ['loader/volatile-update', 'app-boot/config-reload'], 'the reload listeners were not registered without undici')
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

await check('apply registers one settings.section immediately, with the frozen id, order, label, and locale', () => {
  const loadingOwn = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', loadingSnapshot) })
  const { ctx, registration } = mountPage({ forms: loadingOwn })
  assert.deepEqual(ctx.state.injections, ['settings.section'], `slots.inject was called with ${JSON.stringify(ctx.state.injections)}`)
  assert.equal(ctx.state.registered.length, 1, `apply registered ${ctx.state.registered.length} sections before the namespace was ready`)
  assert.equal(registration.options.name, 'settings.section', `the slot name drifted to ${String(registration.options.name)}`)
  assert.equal(registration.options.id, 'llm-api-call-tuning', `the section id drifted to ${String(registration.options.id)}`)
  assert.equal(registration.options.order, 45, `the section order drifted to ${String(registration.options.order)}`)
  assert.equal(typeof registration.options.label, 'function', 'the section label must be a thunk: a plain string would not follow the locale revision')
  assert.equal(registration.options.label(), EN.nav, 'the nav label does not resolve through the dictionary')
  assert.equal(registration.options.locale, 'llm-api-call-tuning', `the locale NS drifted to ${String(registration.options.locale)}`)
  assert.equal(ctx.state.effects[0], 'dsh-llm-api-call-tuning: dictionaries', `the dictionary effect label drifted to ${String(ctx.state.effects[0])}`)
  assert.equal(ctx.state.dictionaries.length, 1, `apply registered ${ctx.state.dictionaries.length} dictionaries`)
  assert.equal(ctx.state.dictionaries[0].ns, 'llm-api-call-tuning', 'the dictionary NS drifted')
})

await check('the en and zh dictionaries carry the same 121 non-empty keys, and English has no CJK text', () => {
  const en = COPY.en
  const zh = COPY.zh
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'the en and zh dictionaries do not carry identical key sets')
  assert.equal(Object.keys(en).length, 121, `the dictionary key count drifted to ${Object.keys(en).length}`)
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
  for (const key of [
    'nav', 'title', 'intro', 'defaults.heading', 'defaults.description', 'defaults.note',
    'defaults.save', 'defaults.saving', 'defaults.applyAll', 'defaults.applying', 'defaults.applyAllNote',
    'providers.heading', 'providers.description', 'providers.loading', 'providers.unavailable',
    'providers.error', 'providers.empty', 'provider.namespace', 'provider.source.override',
    'provider.source.default', 'provider.status.dormant', 'provider.status.noSettings',
    'provider.status.unavailable', 'provider.useDefaults', 'provider.reset', 'provider.save',
    'provider.saving', 'provider.resetting', 'provider.alwaysNote',
    'field.mode.label', 'field.maxRetries.label', 'field.initialDelayMs.label',
    'field.maxDelayMs.label', 'field.jitterRatio.label', 'field.retryableCodes.label',
    'mode.normal', 'mode.always',
    'code.EMPTY_RESPONSE', 'code.RATE_LIMIT', 'code.SERVER', 'code.TIMEOUT', 'code.TRANSPORT',
    'status.loading', 'status.unavailable', 'status.readOnly', 'status.saved', 'status.reset',
    'error.refused', 'error.managed', 'error.mode', 'error.maxRetries', 'error.initialDelayMs',
    'error.maxDelayMs', 'error.initialDelayOrder', 'error.jitterRatio', 'error.retryableCodes',
    'fetch.heading', 'fetch.description', 'fetch.note', 'fetch.save', 'fetch.saving',
    'fetch.reset', 'fetch.resetting', 'fetch.placeholder', 'fetch.hint',
    'fetch.status.loading', 'fetch.status.unavailable',
    'field.headersTimeoutMs.label', 'field.headersTimeoutMs.description', 'field.headersTimeoutMs.unit',
    'field.bodyTimeoutMs.label', 'field.bodyTimeoutMs.description', 'field.bodyTimeoutMs.unit',
    'error.headersTimeoutMs', 'error.bodyTimeoutMs', 'status.fetchReset',
    'timeouts.heading', 'timeouts.description', 'timeouts.note', 'timeouts.unit', 'timeouts.hint',
    'timeouts.unlimited', 'timeouts.save', 'timeouts.saving', 'timeouts.reset', 'timeouts.resetting',
    'timeouts.resetDone', 'timeouts.protocol', 'timeouts.protocol.catalog',
    'timeouts.advisory.sdkFirst', 'timeouts.advisory.transportFirst',
    'field.streamIdleTimeoutMs.label', 'field.streamIdleTimeoutMs.description',
    'field.timeoutMs.label', 'field.timeoutMs.description',
    'field.filesApiTimeoutMs.label', 'field.filesApiTimeoutMs.description',
    'error.streamIdleTimeoutMs', 'error.timeoutMs', 'error.filesApiTimeoutMs',
    'apply.outcome.saved', 'apply.outcome.refused', 'apply.outcome.managed',
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
  const registration = ctx.state.registered[0]
  const injected = registration.options.inject()
  assert.doesNotThrow(
    () => react.mount(registration.component, { ...injected, close: () => { throw new Error('close must not be called') } }),
    'the page called the shell close prop',
  )
})

await check('a direct apply() without ctx.configForms registers no page (belt-and-braces; real compositions park the fiber first)', () => {
  const ctx = fakeContext()
  Object.defineProperty(ctx, 'configForms', { value: undefined })
  assert.doesNotThrow(() => clientPlugin.apply(ctx), 'apply threw without configForms')
  assert.equal(ctx.state.registered.length, 0, 'a section was registered without configForms')
  assert.equal(ctx.state.dictionaries.length, 1, 'the dictionaries should still be registered')
})

/* ══ 9. the page render ════════════════════════════════════════════════════ */

await check('the page renders the defaults card with one control per retry field, both actions, and the empty fetch card', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const text = renderedText(page.tree)
  for (const key of ['title', 'intro', 'defaults.heading', 'defaults.description', 'defaults.note', 'defaults.applyAllNote', 'providers.heading', 'providers.description', 'timeouts.heading', 'timeouts.description', 'timeouts.note', 'fetch.heading', 'fetch.description', 'fetch.note']) {
    assert.ok(text.includes(EN[key]), `the page is missing the "${key}" copy`)
  }
  assert.equal(numericInputs(page.tree).length, 6, `the page rendered ${numericInputs(page.tree).length} numeric inputs (four retry + two fetch)`)
  assert.ok(modeSelect(page.tree) !== undefined, 'the defaults card has no mode select')
  assert.equal(codeCheckboxes(page.tree).length, 5, `the defaults card rendered ${codeCheckboxes(page.tree).length} code checkboxes`)
  assert.deepEqual(numericInputs(page.tree).map(input => input.props.value), ['5', '500', '10000', '0.1', '', ''], 'the retry controls are not seeded from the defaults, or the fetch controls are not empty (unset)')
  assert.equal(modeSelect(page.tree).props.value, 'normal', 'the defaults mode is not normal')
  assert.deepEqual(codeCheckboxes(page.tree).map(box => box.props.checked), [true, true, true, true, true], 'not every default code is checked')
  for (const key of ['defaults.save', 'defaults.applyAll', 'fetch.save', 'fetch.reset']) {
    assert.ok(buttonWithText(page.tree, [EN[key]]) !== undefined, `the "${key}" action is missing`)
  }
  assert.deepEqual(ctx.state.formRequests, ['llm-api-call-tuning', 'llm-deepseek-account', 'llm-deepseek', 'llm-pi-ai'], `apply/mount requested forms ${JSON.stringify(ctx.state.formRequests)}`)
})

await check('the cards render in order: defaults, provider retry policies, provider timeouts, fetch timeouts', async () => {
  const { page } = mountPage()
  await flush()
  const headings = findAll(page.tree, node => node.type === 'h3').map(node => directText(node))
  assert.deepEqual(
    headings,
    [EN['defaults.heading'], EN['providers.heading'], EN['timeouts.heading'], EN['fetch.heading']],
    `the card order drifted: ${JSON.stringify(headings)}`,
  )
  assert.equal(timeoutRowElements(page).length, 3, `the timeout card rendered ${timeoutRowElements(page).length} row placeholders, expected one per active route`)
  const inputs = fetchInputs(page.tree)
  assert.equal(inputs.length, host.FETCH_KEYS.length, `the fetch card rendered ${inputs.length} inputs, expected one per fetch key`)
  assert.deepEqual(inputs.map(input => input.props.value), ['', ''], 'the shipped fetch draft must be empty (unset), never a seeded 1800000')
  assert.deepEqual(inputs.map(input => input.props.placeholder), [EN['fetch.placeholder'], EN['fetch.placeholder']], 'the fetch inputs lost the system-default placeholder')
  const text = renderedText(page.tree)
  for (const key of ['field.headersTimeoutMs.label', 'field.headersTimeoutMs.description', 'field.bodyTimeoutMs.label', 'field.bodyTimeoutMs.description', 'fetch.hint']) {
    assert.ok(text.includes(EN[key]), `the fetch card is missing the "${key}" copy`)
  }
})

await check('an unserved own namespace degrades to status.unavailable and disables the card', async () => {
  const forms = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', unavailableSnapshot) })
  const { page } = mountPage({ forms })
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(EN['status.unavailable']), 'the own-namespace unavailable note is missing')
  assert.ok(text.includes(EN['fetch.status.unavailable']), 'the fetch card does not name the fetch timeouts in its unavailable note')
  assert.equal(numericInputs(page.tree).every(input => input.props.disabled === true), true, 'the controls stayed editable on an unserved namespace')
  assert.equal(buttonWithText(page.tree, [EN['defaults.save']]).props.disabled, true, 'Save defaults stayed enabled on an unserved namespace')
  assert.equal(rowElements(page).length, 3, 'the provider retry card disappeared with the defaults card degraded')
  assert.equal(timeoutRowElements(page).length, 3, 'the provider timeout card disappeared with the defaults card degraded')
})

await check('a loading or read-only own namespace renders its note and keeps the card disabled', async () => {
  const loading = mountPage({ forms: makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', loadingSnapshot) }) })
  await flush()
  assert.ok(renderedText(loading.page.tree).includes(EN['status.loading']), 'the own-namespace loading note is missing')
  assert.ok(renderedText(loading.page.tree).includes(EN['fetch.status.loading']), 'the fetch card does not name the fetch timeouts in its loading note')
  loading.page.unmount()

  const readOnly = mountPage({ forms: makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', { ...readySnapshot(TUNE_VALUE, 7), writable: false }) }) })
  await flush()
  assert.ok(renderedText(readOnly.page.tree).includes(EN['status.readOnly']), 'the read-only note is missing')
  assert.equal(numericInputs(readOnly.page.tree).every(input => input.props.disabled === true), true, 'a read-only namespace left the controls enabled')
})

await check('a bare root render shows only provider placeholders, not provider controls', async () => {
  const { page } = mountPage()
  await flush()
  const rows = rowElements(page)
  assert.equal(rows.length, 3, `the root render showed ${rows.length} provider retry rows`)
  for (const node of rows) {
    for (const prop of ['row', 't', 'form', 'defaultsValues', 'applyOutcome']) {
      assert.ok(prop in node.props, `a provider placeholder is missing the "${prop}" prop`)
    }
    assert.equal(typeof node.props.defaultsValues, 'object', 'the placeholder got no validated defaults')
  }
  const timeoutRows = timeoutRowElements(page)
  assert.equal(timeoutRows.length, 3, `the root render showed ${timeoutRows.length} provider timeout rows`)
  for (const node of timeoutRows) {
    for (const prop of ['row', 't', 'form', 'bodyTimeoutMs']) {
      assert.ok(prop in node.props, `a timeout placeholder is missing the "${prop}" prop`)
    }
  }
  for (const key of ['provider.save', 'provider.reset', 'timeouts.reset']) {
    assert.equal(buttonWithText(page.tree, [EN[key]]), undefined, `the root render rendered a "${key}" control`)
  }
  const timeoutSection = findAll(page.tree, node => node.type === 'section')[2]
  assert.ok(timeoutSection !== undefined, 'the timeout card section is missing from the root render')
  assert.equal(findAll(timeoutSection, node => node.type === 'button').length, 0, 'the timeout card leaked a Save/Reset control into the root render (its rows are child placeholders)')
  assert.equal(numericInputs(page.tree).length, 6, 'provider controls leaked into the root render; only the defaults card (four) and fetch card (two) should render')
})

await check('the page joins the directory in rank order and each row paints its effective value and badge', async () => {
  const { page } = mountPage()
  await flush()
  const order = rowElements(page).map(node => node.props.row.provider)
  assert.deepEqual(order, ['deepseek-account', 'deepseek-official', 'openrouter'], `the joined retry-row order drifted: ${JSON.stringify(order)}`)
  const timeoutOrder = timeoutRowElements(page).map(node => node.props.row.provider)
  assert.deepEqual(timeoutOrder, ['deepseek-account', 'deepseek-official', 'openrouter'], `the joined timeout-row order drifted: ${JSON.stringify(timeoutOrder)}`)

  const piAi = mountRow(page, 'openrouter')
  const piText = renderedText(piAi.tree)
  assert.ok(piText.includes(EN['provider.source.override']), 'the user-layer override badge is missing')
  assert.deepEqual(numericInputs(piAi.tree).map(input => input.props.value), ['2', '250', '5000', '0.2'], 'the row is not seeded from the effective provider policy')
  assert.deepEqual(codeCheckboxes(piAi.tree).map(box => box.props.checked), [false, true, false, false, false], 'the row did not select the stored RATE_LIMIT code')
  piAi.unmount()

  const official = mountRow(page, 'deepseek-official')
  assert.ok(renderedText(official.tree).includes(EN['provider.source.default']), 'the default badge is missing on an un-overridden row')
  assert.deepEqual(numericInputs(official.tree).map(input => input.props.value), ['5', '500', '10000', '0.1'], 'an empty provider policy did not fall back to the code defaults')
  official.unmount()
})

await check('the timeout card renders one row per active route with only that family\'s controls and blank placeholders', async () => {
  const { page } = mountPage()
  await flush()
  const piAi = mountTimeoutRow(page, 'openrouter')
  assert.equal(timeoutInputs(piAi.tree).length, 2, 'a pi-ai timeout row must render streamIdleTimeoutMs + timeoutMs only')
  assert.deepEqual(timeoutInputs(piAi.tree).map(input => input.props.placeholder), ['300000', '600000'], 'the pi-ai timeout placeholders drifted')
  assert.deepEqual(timeoutInputs(piAi.tree).map(input => input.props.value), ['', ''], 'an untouched route must start blank (package/SDK default), never the effective default')
  const piText = renderedText(piAi.tree)
  for (const key of ['field.streamIdleTimeoutMs.label', 'field.timeoutMs.label', 'timeouts.unit', 'timeouts.hint', 'timeouts.unlimited']) {
    assert.ok(piText.includes(EN[key]), `the pi-ai timeout row is missing the "${key}" copy`)
  }
  assert.equal(piText.includes(EN['field.filesApiTimeoutMs.label']), false, 'a pi-ai row rendered the DeepSeek-only Files API control')
  assert.ok(piText.includes(EN['provider.source.default']), 'an untouched timeout field must show the default badge')
  piAi.unmount()

  const official = mountTimeoutRow(page, 'deepseek-official')
  assert.equal(timeoutInputs(official.tree).length, 2, 'a DeepSeek timeout row must render streamIdleTimeoutMs + filesApiTimeoutMs only')
  assert.deepEqual(timeoutInputs(official.tree).map(input => input.props.placeholder), ['300000', '60000'], 'the DeepSeek timeout placeholders drifted')
  const officialText = renderedText(official.tree)
  assert.equal(officialText.includes(EN['field.timeoutMs.label']), false, 'a DeepSeek row rendered the pi-ai-only request-timeout control')
  for (const key of ['field.streamIdleTimeoutMs.label', 'field.filesApiTimeoutMs.label']) {
    assert.ok(officialText.includes(EN[key]), `the DeepSeek timeout row is missing the "${key}" copy`)
  }
  official.unmount()

  const account = mountTimeoutRow(page, 'deepseek-account')
  assert.deepEqual(timeoutInputs(account.tree).map(input => input.props.placeholder), ['300000', '60000'], 'the DeepSeek Account timeout row drifted')
  account.unmount()
})

await check('a timeout row seeds from the USER layer only, paints override badges, and shows each namespace/protocol', async () => {
  const seededPi = providerForms('llm-pi-ai',
    piAiValue({ api: 'openai-completions' }),
    { providers: { openrouter: { streamIdleTimeoutMs: 1_800_000, timeoutMs: 900_000 } } },
    4)
  const seeded = mountPage({ forms: seededPi })
  await flush()
  const row = mountTimeoutRow(seeded.page, 'openrouter')
  assert.deepEqual(timeoutInputs(row.tree).map(input => input.props.value), ['1800000', '900000'], 'the timeout draft is not seeded from the user layer')
  assert.ok(renderedText(row.tree).includes(EN['provider.source.override']), 'a user-layer timeout override did not paint the override badge')
  const seededText = renderedText(row.tree)
  assert.ok(seededText.includes('openai-completions'), 'the pi-ai protocol is not rendered from the route snapshot')
  assert.ok(seededText.includes('llm-pi-ai'), 'the timeout row does not name its namespace')
  row.unmount()
  seeded.page.unmount()

  const effectiveOnly = providerForms('llm-pi-ai', piAiValue({ streamIdleTimeoutMs: 300_000, timeoutMs: 600_000 }), {}, 4)
  const effective = mountPage({ forms: effectiveOnly })
  await flush()
  const effectiveRow = mountTimeoutRow(effective.page, 'openrouter')
  assert.deepEqual(timeoutInputs(effectiveRow.tree).map(input => input.props.value), ['', ''], 'a package/SDK default in the effective value was painted as an override')
  effectiveRow.unmount()
  effective.page.unmount()

  const seededDeepSeek = providerForms('llm-deepseek',
    { streamIdleTimeoutMs: 300_000, filesApiTimeoutMs: 60_000 },
    { streamIdleTimeoutMs: 600_000, filesApiTimeoutMs: 120_000 },
    2)
  const deepseek = mountPage({ forms: seededDeepSeek })
  await flush()
  const deepseekRow = mountTimeoutRow(deepseek.page, 'deepseek-official')
  assert.deepEqual(timeoutInputs(deepseekRow.tree).map(input => input.props.value), ['600000', '120000'], 'the DeepSeek timeout draft is not seeded from the user layer')
  assert.ok(renderedText(deepseekRow.tree).includes('anthropic-messages'), 'the DeepSeek protocol must render as anthropic-messages')
  deepseekRow.unmount()
  deepseek.page.unmount()
})

await check('a pi-ai route without a protocol in the snapshot falls back to the catalog-default copy', async () => {
  const { page } = mountPage({ forms: providerForms('llm-pi-ai', piAiValue({}), {}, 4) })
  await flush()
  const row = mountTimeoutRow(page, 'openrouter')
  assert.ok(renderedText(row.tree).includes(EN['timeouts.protocol.catalog']), 'a route with no api field did not render the catalog-default protocol copy')
  row.unmount()
})

await check('the timeout advisories warn about the SDK deadline and a short fetch body timeout without blocking Save', async () => {
  const sdkForms = providerForms('llm-pi-ai', piAiValue({}), { providers: { openrouter: { streamIdleTimeoutMs: 600_000 } } }, 4)
  const sdkPage = mountPage({ forms: sdkForms })
  await flush()
  const sdkRow = mountTimeoutRow(sdkPage.page, 'openrouter')
  setTimeoutNumeric(sdkRow.tree, 0, '900000')
  assert.ok(renderedText(sdkRow.tree).includes(EN['timeouts.advisory.sdkFirst']), 'the SDK-timeout advisory is missing when the idle window exceeds 600000 ms')
  assert.equal(buttonWithText(sdkRow.tree, [EN['timeouts.save']]).props.disabled, false, 'a non-blocking advisory disabled Save')
  sdkRow.unmount()
  sdkPage.page.unmount()

  const matchedForms = providerForms('llm-pi-ai', piAiValue({}), { providers: { openrouter: { streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 } } }, 4)
  const matchedPage = mountPage({ forms: matchedForms })
  await flush()
  const matchedRow = mountTimeoutRow(matchedPage.page, 'openrouter')
  setTimeoutNumeric(matchedRow.tree, 0, '900000')
  assert.equal(renderedText(matchedRow.tree).includes(EN['timeouts.advisory.sdkFirst']), false, 'the SDK advisory stayed when timeoutMs matched the idle window')
  matchedRow.unmount()
  matchedPage.page.unmount()

  const transportForms = {
    ...providerForms('llm-pi-ai', piAiValue({}), { providers: { openrouter: { streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 } } }, 4),
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ bodyTimeoutMs: 100_000 })),
  }
  const transportPage = mountPage({ forms: transportForms })
  await flush()
  const transportRow = mountTimeoutRow(transportPage.page, 'openrouter')
  setTimeoutNumeric(transportRow.tree, 0, '900000')
  assert.ok(renderedText(transportRow.tree).includes(EN['timeouts.advisory.transportFirst']), 'the transport advisory is missing when the fetch body timeout is below the idle window')
  transportRow.unmount()
  transportPage.page.unmount()

  const wideForms = {
    ...providerForms('llm-pi-ai', piAiValue({}), { providers: { openrouter: { streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 } } }, 4),
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ bodyTimeoutMs: 1_800_000 })),
  }
  const widePage = mountPage({ forms: wideForms })
  await flush()
  const wideRow = mountTimeoutRow(widePage.page, 'openrouter')
  setTimeoutNumeric(wideRow.tree, 0, '900000')
  assert.equal(renderedText(wideRow.tree).includes(EN['timeouts.advisory.transportFirst']), false, 'the transport advisory stayed when the fetch body timeout covered the idle window')
  wideRow.unmount()
  widePage.page.unmount()
})

await check('dormant, namespace-less, and unserved routes render read-only timeout rows and are never written', async () => {
  const registered = [...REGISTERED, { id: 'mystery', name: 'Mystery' }, { id: 'unserved', name: 'Unserved' }]
  const configurable = [
    ...CONFIGURABLE,
    { provider: 'dormant-route', displayName: 'Dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant-route'] },
    { provider: 'unserved', displayName: 'Unserved', settingsNs: 'llm-ghost', settingsPath: ['config'] },
  ]
  const forms = makeForms({ 'llm-ghost': new BoundForm('llm-ghost', unavailableSnapshot) })
  const { page, ctx } = mountPage({ forms, registered, configurable })
  await flush()

  const dormant = mountTimeoutRow(page, 'dormant-route')
  assert.ok(renderedText(dormant.tree).includes(EN['provider.status.dormant']), 'the dormant timeout row note is missing')
  assert.equal(timeoutInputs(dormant.tree).length, 0, 'a dormant timeout row rendered editable controls')
  assert.equal(buttonWithText(dormant.tree, [EN['timeouts.save']]), undefined, 'a dormant timeout row rendered Save')
  assert.equal(buttonWithText(dormant.tree, [EN['timeouts.reset']]), undefined, 'a dormant timeout row rendered Reset')
  dormant.unmount()

  const noSettings = mountTimeoutRow(page, 'mystery')
  assert.ok(renderedText(noSettings.tree).includes(EN['provider.status.noSettings']), 'the namespace-less timeout row note is missing')
  assert.equal(buttonWithText(noSettings.tree, [EN['timeouts.save']]), undefined, 'a namespace-less timeout row rendered Save')
  noSettings.unmount()

  const unserved = mountTimeoutRow(page, 'unserved')
  assert.ok(renderedText(unserved.tree).includes(EN['provider.status.unavailable']), 'the unserved timeout row note is missing')
  assert.equal(buttonWithText(unserved.tree, [EN['timeouts.save']]), undefined, 'an unserved timeout row rendered Save')
  unserved.unmount()

  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'llm-ghost']) {
    assert.equal(ctx.configForms.get(ns).calls.length, 0, `a read-only timeout row wrote the ${ns} namespace on mount`)
  }
})

await check('dormant, namespace-less, and unserved provider rows render their own read-only note', async () => {
  const registered = [...REGISTERED, { id: 'mystery', name: 'Mystery' }, { id: 'unserved', name: 'Unserved' }]
  const configurable = [
    ...CONFIGURABLE,
    { provider: 'dormant-route', displayName: 'Dormant', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'dormant-route'] },
    { provider: 'unserved', displayName: 'Unserved', settingsNs: 'llm-ghost', settingsPath: ['config'] },
  ]
  const forms = makeForms({ 'llm-ghost': new BoundForm('llm-ghost', unavailableSnapshot) })
  const { page } = mountPage({ forms, registered, configurable })
  await flush()

  const dormant = mountRow(page, 'dormant-route')
  assert.ok(renderedText(dormant.tree).includes(EN['provider.status.dormant']), 'the dormant note is missing')
  assert.equal(buttonWithText(dormant.tree, [EN['provider.save']]), undefined, 'a dormant row rendered Save')
  dormant.unmount()

  const noSettings = mountRow(page, 'mystery')
  assert.ok(renderedText(noSettings.tree).includes(EN['provider.status.noSettings']), 'the no-settings note is missing')
  assert.equal(buttonWithText(noSettings.tree, [EN['provider.save']]), undefined, 'a namespace-less row rendered Save')
  noSettings.unmount()

  const unserved = mountRow(page, 'unserved')
  assert.ok(renderedText(unserved.tree).includes(EN['provider.status.unavailable']), 'the namespace-unavailable note is missing')
  assert.equal(buttonWithText(unserved.tree, [EN['provider.save']]), undefined, 'an unserved-namespace row rendered Save')
  unserved.unmount()
})

/* ══ 10. operation shapes ══════════════════════════════════════════════════ */

/** Assert one recorded op list, detached from the vm realm. */
function assertOps(actual, expected, label) {
  assert.deepEqual(plain(actual), expected, `${label}: ${JSON.stringify(plain(actual))}`)
}

await check('a normal-mode provider Save writes the six leaf sets under the joined settings path', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const row = mountRow(page, 'openrouter')
  const form = ctx.configForms.get('llm-pi-ai')
  setNumeric(row.tree, 0, '7')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 1, `expected one mutate call, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 4, `the write was fenced at revision ${form.calls[0].revision}, not the snapshot revision 4`)
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'mode'], value: 'normal' },
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'maxRetries'], value: 7 },
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'retryableCodes'], value: ['RATE_LIMIT'] },
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'backoff', 'initialDelayMs'], value: 250 },
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'backoff', 'maxDelayMs'], value: 5000 },
    { op: 'set', path: ['providers', 'openrouter', 'retryPolicy', 'backoff', 'jitterRatio'], value: 0.2 },
  ], 'the normal-mode save ops drifted')
  assert.ok(!JSON.stringify(plain(form.calls[0].ops)).includes('"retryPolicy":{"mode"'), 'a whole retryPolicy object was set')
})

await check('always mode sets the mode and unsets the two normal-mode-only leaves', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const row = mountRow(page, 'deepseek-official')
  const form = ctx.configForms.get('llm-deepseek')
  setMode(row.tree, 'always')
  assert.equal(codeCheckboxes(row.tree).length, 0, 'the code list stayed rendered in always mode')
  assert.ok(renderedText(row.tree).includes(EN['provider.alwaysNote']), 'the always-mode note is missing')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['retryPolicy', 'mode'], value: 'always' },
    { op: 'unset', path: ['retryPolicy', 'maxRetries'] },
    { op: 'unset', path: ['retryPolicy', 'retryableCodes'] },
    { op: 'set', path: ['retryPolicy', 'backoff', 'initialDelayMs'], value: 500 },
    { op: 'set', path: ['retryPolicy', 'backoff', 'maxDelayMs'], value: 10000 },
    { op: 'set', path: ['retryPolicy', 'backoff', 'jitterRatio'], value: 0.1 },
  ], 'the always-mode save ops drifted')
})

await check('Reset is the single unset of the whole retryPolicy and nothing else', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const row = mountRow(page, 'openrouter')
  const form = ctx.configForms.get('llm-pi-ai')
  buttonWithText(row.tree, [EN['provider.reset']]).props.onClick()
  await flush()
  assertOps(form.calls[0].ops, [{ op: 'unset', path: ['providers', 'openrouter', 'retryPolicy'] }], 'the reset op drifted')
  assert.equal(form.calls[0].revision, 4, 'Reset did not use the snapshot revision')
  assert.ok(renderedText(row.tree).includes(EN['status.reset']), 'the reset confirmation copy is missing')
})

await check('Use defaults stages the validated defaults and writes nothing until Save', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const row = mountRow(page, 'openrouter')
  const form = ctx.configForms.get('llm-pi-ai')
  buttonWithText(row.tree, [EN['provider.useDefaults']]).props.onClick()
  assert.equal(form.calls.length, 0, 'Use defaults wrote to the Host')
  assert.deepEqual(numericInputs(row.tree).map(input => input.props.value), ['5', '500', '10000', '0.1'], 'Use defaults did not stage the defaults values')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const ops = plain(form.calls[0].ops)
  assert.equal(ops[0].value, 'normal', 'the staged mode is not the defaults mode')
  assert.equal(ops[1].value, 5, 'the staged maxRetries is not the defaults value')
  assert.deepEqual(ops[2].value, ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'], 'the staged code list is not the defaults value')
})

await check('the defaults card saves six flat leaf sets on its own namespace', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const form = ctx.configForms.get('llm-api-call-tuning')
  setNumeric(page.tree, 0, '9')
  buttonWithText(page.tree, [EN['defaults.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 1, `expected one defaults write, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 7, `the defaults write was fenced at ${form.calls[0].revision}`)
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['mode'], value: 'normal' },
    { op: 'set', path: ['maxRetries'], value: 9 },
    { op: 'set', path: ['initialDelayMs'], value: 500 },
    { op: 'set', path: ['maxDelayMs'], value: 10000 },
    { op: 'set', path: ['jitterRatio'], value: 0.1 },
    { op: 'set', path: ['retryableCodes'], value: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] },
  ], 'the defaults save ops drifted')
  assert.ok(renderedText(page.tree).includes(EN['status.saved']), 'the defaults save confirmation is missing')
})

await check('the fetch card Save on an empty draft emits the two flat unsets and touches no provider', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const form = ctx.configForms.get('llm-api-call-tuning')
  buttonWithText(page.tree, [EN['fetch.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 1, `expected one fetch write, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 7, `the fetch write was fenced at ${form.calls[0].revision}`)
  assertOps(form.calls[0].ops, [
    { op: 'unset', path: ['headersTimeoutMs'] },
    { op: 'unset', path: ['bodyTimeoutMs'] },
  ], 'an empty fetch save must unset both leaves (unset leaves the system default in place)')
  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
    assert.equal(ctx.configForms.get(ns).calls.length, 0, `the fetch save wrote the provider namespace ${ns}`)
  }
  assert.ok(renderedText(page.tree).includes(EN['status.saved']), 'the fetch save confirmation is missing')
})

await check('0 is a real fetch write (disabled), not the unset state', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const form = ctx.configForms.get('llm-api-call-tuning')
  setFetchNumeric(page.tree, 0, '0')
  setFetchNumeric(page.tree, 1, '1800000')
  assert.deepEqual(fetchInputs(page.tree).map(input => input.props.value), ['0', '1800000'], 'the fetch inputs did not stage the typed values')
  buttonWithText(page.tree, [EN['fetch.save']]).props.onClick()
  await flush()
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['headersTimeoutMs'], value: 0 },
    { op: 'set', path: ['bodyTimeoutMs'], value: 1_800_000 },
  ], 'a 0 fetch timeout must be written as a set (disabled), never as an unset')
})

await check('clearing one seeded fetch field emits one unset and keeps the other set', async () => {
  const forms = makeForms({
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ headersTimeoutMs: 0, bodyTimeoutMs: 1_800_000 })),
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const form = ctx.configForms.get('llm-api-call-tuning')
  assert.deepEqual(fetchInputs(page.tree).map(input => input.props.value), ['0', '1800000'], 'a stored timer was not seeded into the fetch draft')
  setFetchNumeric(page.tree, 0, '')
  buttonWithText(page.tree, [EN['fetch.save']]).props.onClick()
  await flush()
  assertOps(form.calls[0].ops, [
    { op: 'unset', path: ['headersTimeoutMs'] },
    { op: 'set', path: ['bodyTimeoutMs'], value: 1_800_000 },
  ], 'a mixed unset/set fetch save is wrong')
})

await check('the fetch card Reset emits exactly the two unsets and reports its own confirmation', async () => {
  const forms = makeForms({
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ headersTimeoutMs: 250, bodyTimeoutMs: 500 })),
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const form = ctx.configForms.get('llm-api-call-tuning')
  buttonWithText(page.tree, [EN['fetch.reset']]).props.onClick()
  await flush()
  assertOps(form.calls[0].ops, [
    { op: 'unset', path: ['headersTimeoutMs'] },
    { op: 'unset', path: ['bodyTimeoutMs'] },
  ], 'the fetch Reset op drifted')
  assert.ok(renderedText(page.tree).includes(EN['status.fetchReset']), 'the fetch Reset confirmation is missing')
  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
    assert.equal(ctx.configForms.get(ns).calls.length, 0, `the fetch Reset wrote the provider namespace ${ns}`)
  }
})

await check('the fetch draft validates the tri-state: negative, fractional, overflow, and string values are refused; 0 and the cap pass', async () => {
  const { page } = mountPage()
  await flush()
  const save = () => buttonWithText(page.tree, [EN['fetch.save']])
  for (const [label, value, copy] of [
    ['a negative timeout', '-1', 'error.headersTimeoutMs'],
    ['a fractional timeout', '1.5', 'error.headersTimeoutMs'],
    ['an overflow timeout', '2147483648', 'error.headersTimeoutMs'],
    ['a negative body timeout', '-5', 'error.bodyTimeoutMs'],
  ]) {
    setFetchNumeric(page.tree, copy === 'error.bodyTimeoutMs' ? 1 : 0, value)
    assert.equal(save().props.disabled, true, `Save stayed enabled on ${label}`)
    assert.ok(renderedText(page.tree).includes(EN[copy]), `the ${copy} error copy is missing for ${label}`)
    setFetchNumeric(page.tree, copy === 'error.bodyTimeoutMs' ? 1 : 0, '')
  }
  for (const [label, index, value] of [['0 (disabled)', 0, '0'], ['the timer cap', 0, '2147483647'], ['empty (unset)', 0, '']]) {
    setFetchNumeric(page.tree, index, value)
    assert.equal(save().props.disabled, false, `Save stayed disabled on ${label}`)
  }
})

await check('a pi-ai timeout Save writes exactly the changed leaves under providers.<route>', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const row = mountTimeoutRow(page, 'openrouter')
  const form = ctx.configForms.get('llm-pi-ai')
  setTimeoutNumeric(row.tree, 0, '1800000')
  setTimeoutNumeric(row.tree, 1, '900000')
  buttonWithText(row.tree, [EN['timeouts.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 1, `expected one timeout write, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 4, `the timeout write was fenced at ${form.calls[0].revision}`)
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'], value: 1_800_000 },
    { op: 'set', path: ['providers', 'openrouter', 'timeoutMs'], value: 900_000 },
  ], 'the pi-ai timeout save ops drifted')
  assert.ok(!JSON.stringify(plain(form.calls[0].ops)).includes('retryPolicy'), 'a timeout Save projected a retry leaf')

  const partial = mountPage()
  await flush()
  const partialRow = mountTimeoutRow(partial.page, 'openrouter')
  const partialForm = partial.ctx.configForms.get('llm-pi-ai')
  setTimeoutNumeric(partialRow.tree, 0, '450000')
  buttonWithText(partialRow.tree, [EN['timeouts.save']]).props.onClick()
  await flush()
  assertOps(partialForm.calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'], value: 450_000 },
  ], 'a partial pi-ai timeout save must write only the changed leaf')
})

await check('a seeded pi-ai timeout row emits a single unset when cleared and two unsets on Reset', async () => {
  const forms = providerForms('llm-pi-ai', piAiValue({}), { providers: { openrouter: { streamIdleTimeoutMs: 1_800_000, timeoutMs: 900_000 } } }, 4)
  const { page, ctx } = mountPage({ forms })
  await flush()
  const row = mountTimeoutRow(page, 'openrouter')
  const form = ctx.configForms.get('llm-pi-ai')
  setTimeoutNumeric(row.tree, 1, '')
  buttonWithText(row.tree, [EN['timeouts.save']]).props.onClick()
  await flush()
  assertOps(form.calls[0].ops, [
    { op: 'unset', path: ['providers', 'openrouter', 'timeoutMs'] },
  ], 'clearing one seeded pi-ai timeout must emit only its unset')

  const resetForms = providerForms('llm-pi-ai', piAiValue({}), { providers: { openrouter: { streamIdleTimeoutMs: 1_800_000, timeoutMs: 900_000 } } }, 4)
  const resetPage = mountPage({ forms: resetForms })
  await flush()
  const resetRow = mountTimeoutRow(resetPage.page, 'openrouter')
  const resetForm = resetPage.ctx.configForms.get('llm-pi-ai')
  buttonWithText(resetRow.tree, [EN['timeouts.reset']]).props.onClick()
  await flush()
  assertOps(resetForm.calls[0].ops, [
    { op: 'unset', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'] },
    { op: 'unset', path: ['providers', 'openrouter', 'timeoutMs'] },
  ], 'the pi-ai timeout Reset ops drifted')
  assert.equal(resetForm.calls[0].revision, 4, 'the pi-ai timeout Reset revision drifted')
  assert.ok(renderedText(resetRow.tree).includes(EN['timeouts.resetDone']), 'the timeout Reset confirmation copy is missing')
})

await check('a DeepSeek timeout Save and Reset address the namespace root, never retryPolicy', async () => {
  const official = mountPage()
  await flush()
  const row = mountTimeoutRow(official.page, 'deepseek-official')
  const form = official.ctx.configForms.get('llm-deepseek')
  setTimeoutNumeric(row.tree, 0, '600000')
  setTimeoutNumeric(row.tree, 1, '120000')
  buttonWithText(row.tree, [EN['timeouts.save']]).props.onClick()
  await flush()
  assert.equal(form.calls[0].revision, 2, 'the DeepSeek timeout write did not use the namespace revision')
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['streamIdleTimeoutMs'], value: 600_000 },
    { op: 'set', path: ['filesApiTimeoutMs'], value: 120_000 },
  ], 'the DeepSeek timeout save ops drifted')

  const account = mountPage()
  await flush()
  const accountRow = mountTimeoutRow(account.page, 'deepseek-account')
  const accountForm = account.ctx.configForms.get('llm-deepseek-account')
  buttonWithText(accountRow.tree, [EN['timeouts.reset']]).props.onClick()
  await flush()
  assert.equal(accountForm.calls[0].revision, 3, 'the DeepSeek Account Reset did not use the namespace revision')
  assertOps(accountForm.calls[0].ops, [
    { op: 'unset', path: ['streamIdleTimeoutMs'] },
    { op: 'unset', path: ['filesApiTimeoutMs'] },
  ], 'the DeepSeek Account timeout Reset ops drifted')
})

await check('the timeout Save is disabled when nothing changed, and 0 plus every malformed shape is refused', async () => {
  const { page } = mountPage()
  await flush()
  const row = mountTimeoutRow(page, 'openrouter')
  const save = () => buttonWithText(row.tree, [EN['timeouts.save']])
  const reset = () => buttonWithText(row.tree, [EN['timeouts.reset']])
  assert.equal(save().props.disabled, true, 'Save stayed enabled on an untouched, blank timeout row')
  assert.equal(reset().props.disabled, false, 'Reset stayed disabled on a writable timeout row')

  for (const [label, value, copy] of [
    ['0 on the idle watchdog', '0', 'error.streamIdleTimeoutMs'],
    ['a negative value', '-1', 'error.streamIdleTimeoutMs'],
    ['a fractional value', '1.5', 'error.streamIdleTimeoutMs'],
    ['an overflow value', '2147483648', 'error.streamIdleTimeoutMs'],
    ['a leading zero', '007', 'error.streamIdleTimeoutMs'],
    ['exponent notation', '1e6', 'error.streamIdleTimeoutMs'],
  ]) {
    setTimeoutNumeric(row.tree, 0, value)
    assert.equal(save().props.disabled, true, `Save stayed enabled on ${label}`)
    assert.ok(renderedText(row.tree).includes(EN[copy]), `the ${copy} copy is missing for ${label}`)
  }
  setTimeoutNumeric(row.tree, 1, '0')
  assert.equal(save().props.disabled, true, 'Save stayed enabled on a zero SDK request timeout')
  assert.ok(renderedText(row.tree).includes(EN['error.timeoutMs']), 'the 0-request-timeout copy is missing')

  setTimeoutNumeric(row.tree, 1, '')
  setTimeoutNumeric(row.tree, 0, ' 2147483647 ')
  assert.equal(save().props.disabled, false, 'the 2147483647 cap (whitespace-trimmed) must be accepted')
  assert.equal(renderedText(row.tree).includes(EN['error.streamIdleTimeoutMs']), false, 'the idle-watchdog error copy stayed after a valid value')

  const deepseek = mountPage()
  await flush()
  const deepseekRow = mountTimeoutRow(deepseek.page, 'deepseek-official')
  setTimeoutNumeric(deepseekRow.tree, 1, '0')
  assert.equal(buttonWithText(deepseekRow.tree, [EN['timeouts.save']]).props.disabled, true, 'Save stayed enabled on a zero files-API timeout')
  assert.ok(renderedText(deepseekRow.tree).includes(EN['error.filesApiTimeoutMs']), 'the 0-files-api copy is missing')
})

await check('the Unlimited preset fills 2147483647 ms on every timeout field, including the Files API cap', async () => {
  const piAi = mountPage()
  await flush()
  const piRow = mountTimeoutRow(piAi.page, 'openrouter')
  const presets = timeoutPresetButtons(piRow.tree)
  assert.equal(presets.length, 2, 'the pi-ai timeout row must offer one Unlimited preset per visible field')
  presets[0].props.onClick()
  presets[1].props.onClick()
  assert.deepEqual(timeoutInputs(piRow.tree).map(input => input.props.value), ['2147483647', '2147483647'], 'the pi-ai Unlimited preset must fill the 2147483647 cap, never 0')
  buttonWithText(piRow.tree, [EN['timeouts.save']]).props.onClick()
  await flush()
  assertOps(piAi.ctx.configForms.get('llm-pi-ai').calls[0].ops, [
    { op: 'set', path: ['providers', 'openrouter', 'streamIdleTimeoutMs'], value: 2_147_483_647 },
    { op: 'set', path: ['providers', 'openrouter', 'timeoutMs'], value: 2_147_483_647 },
  ], 'the Unlimited preset did not persist the cap')

  const deepseek = mountPage()
  await flush()
  const deepseekRow = mountTimeoutRow(deepseek.page, 'deepseek-official')
  const deepseekPresets = timeoutPresetButtons(deepseekRow.tree)
  assert.equal(deepseekPresets.length, 2, 'the DeepSeek timeout row must offer one Unlimited preset per visible field')
  deepseekPresets[0].props.onClick()
  deepseekPresets[1].props.onClick()
  assert.deepEqual(timeoutInputs(deepseekRow.tree).map(input => input.props.value), ['2147483647', '2147483647'], 'the DeepSeek Unlimited preset must cover the Files API field too')
})

await check('the timeout Save is independent of the retry and fetch saves in both directions', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const own = ctx.configForms.get('llm-api-call-tuning')
  const piForm = ctx.configForms.get('llm-pi-ai')
  const timeoutRow = mountTimeoutRow(page, 'openrouter')
  setTimeoutNumeric(timeoutRow.tree, 0, '600000')
  buttonWithText(timeoutRow.tree, [EN['timeouts.save']]).props.onClick()
  await flush()
  for (const ns of ['llm-api-call-tuning', 'llm-deepseek', 'llm-deepseek-account']) {
    assert.equal(ctx.configForms.get(ns).calls.length, 0, `a timeout Save wrote the unrelated namespace ${ns}`)
  }
  for (const op of plain(piForm.calls[0].ops)) {
    assert.equal(op.path.join('.').includes('retryPolicy'), false, `a timeout Save emitted the retry leaf ${op.path.join('.')}`)
    assert.equal(op.path.join('.').includes('TimeoutMs') && op.path.length < 3, false, 'a timeout Save addressed a short (whole-profile) path')
  }

  const retryRow = mountRow(page, 'openrouter')
  setNumeric(retryRow.tree, 0, '7')
  buttonWithText(retryRow.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(piForm.calls.length, 2, 'the retry Save did not add its own write')
  for (const op of plain(piForm.calls[1].ops)) {
    assert.equal(op.path.join('.').includes('retryPolicy'), true, `a retry Save emitted the non-retry path ${op.path.join('.')}`)
    assert.equal(JSON.stringify(op).includes('TimeoutMs'), false, 'a retry Save projected a provider-timeout leaf')
  }

  buttonWithText(page.tree, [EN['fetch.save']]).props.onClick()
  await flush()
  assert.equal(own.calls.length, 1, 'the fetch Save did not write its own namespace')
  for (const op of plain(own.calls[0].ops)) {
    assert.ok(
      op.path.length === 1 && (op.path[0] === 'headersTimeoutMs' || op.path[0] === 'bodyTimeoutMs'),
      `the fetch Save emitted a non-fetch path ${JSON.stringify(op.path)}`,
    )
  }
  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
    assert.equal(ctx.configForms.get(ns).calls.length, ns === 'llm-pi-ai' ? 2 : 0, `the fetch Save wrote the provider namespace ${ns}`)
  }
})

await check('a timeout row without a numeric revision, or read-only, disables both actions and never writes', async () => {
  const noRevision = providerForms('llm-pi-ai', piAiValue({}), { providers: { openrouter: { streamIdleTimeoutMs: 600_000 } } }, undefined)
  const page = mountPage({ forms: noRevision })
  await flush()
  const row = mountTimeoutRow(page.page, 'openrouter')
  setTimeoutNumeric(row.tree, 0, '900000')
  assert.equal(buttonWithText(row.tree, [EN['timeouts.save']]).props.disabled, true, 'Save stayed enabled without a numeric revision')
  assert.equal(buttonWithText(row.tree, [EN['timeouts.reset']]).props.disabled, true, 'Reset stayed enabled without a numeric revision')
  buttonWithText(row.tree, [EN['timeouts.save']]).props.onClick()
  buttonWithText(row.tree, [EN['timeouts.reset']]).props.onClick()
  await flush()
  assert.equal(page.ctx.configForms.get('llm-pi-ai').calls.length, 0, 'a row without a numeric revision wrote the namespace')
  row.unmount()

  const readOnlyForms = providerForms('llm-pi-ai', piAiValue({}), {}, 4)
  readOnlyForms['llm-pi-ai'] = new BoundForm('llm-pi-ai', { ...readySnapshot(piAiValue({}), 4, {}), writable: false })
  const readOnly = mountPage({ forms: readOnlyForms })
  await flush()
  const readOnlyRow = mountTimeoutRow(readOnly.page, 'openrouter')
  assert.equal(buttonWithText(readOnlyRow.tree, [EN['timeouts.save']]), undefined, 'a read-only timeout row rendered Save')
  assert.equal(buttonWithText(readOnlyRow.tree, [EN['timeouts.reset']]), undefined, 'a read-only timeout row rendered Reset')
  assert.ok(renderedText(readOnlyRow.tree).includes(EN['status.readOnly']), 'a read-only timeout row did not render the read-only note')
})

await check('the retry defaults Save never projects a seeded fetch leaf', async () => {
  const forms = makeForms({
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ headersTimeoutMs: 0, bodyTimeoutMs: 1_800_000 })),
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  const form = ctx.configForms.get('llm-api-call-tuning')
  buttonWithText(page.tree, [EN['defaults.save']]).props.onClick()
  await flush()
  assertOps(form.calls[0].ops, [
    { op: 'set', path: ['mode'], value: 'normal' },
    { op: 'set', path: ['maxRetries'], value: 5 },
    { op: 'set', path: ['initialDelayMs'], value: 500 },
    { op: 'set', path: ['maxDelayMs'], value: 10000 },
    { op: 'set', path: ['jitterRatio'], value: 0.1 },
    { op: 'set', path: ['retryableCodes'], value: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] },
  ], 'the retry defaults save drifted or projected a fetch leaf')
})

await check('Apply defaults never projects a seeded fetch leaf onto a provider route', async () => {
  const forms = makeForms({
    'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', tuningSnapshot({ headersTimeoutMs: 0, bodyTimeoutMs: 1_800_000 })),
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  for (const ns of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai']) {
    for (const call of ctx.configForms.get(ns).calls) {
      for (const op of plain(call.ops)) {
        assert.equal(op.path.join('.').includes('TimeoutMs'), false, `${ns} received the fetch leaf ${op.path.join('.')}`)
      }
    }
  }
  assert.deepEqual(plain(ctx.configForms.get('llm-pi-ai').calls[0].ops).map(op => op.path.join('.')), [
    'providers.openrouter.retryPolicy.mode',
    'providers.openrouter.retryPolicy.maxRetries',
    'providers.openrouter.retryPolicy.retryableCodes',
    'providers.openrouter.retryPolicy.backoff.initialDelayMs',
    'providers.openrouter.retryPolicy.backoff.maxDelayMs',
    'providers.openrouter.retryPolicy.backoff.jitterRatio',
  ], 'the apply-all provider ops drifted')
})

await check('Apply defaults writes every editable provider once, at its own revision, with a per-row outcome', async () => {
  const { page, ctx } = mountPage()
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  for (const [ns, revision] of [['llm-deepseek', 2], ['llm-deepseek-account', 3], ['llm-pi-ai', 4]]) {
    const calls = ctx.configForms.get(ns).calls
    assert.equal(calls.length, 1, `${ns} received ${calls.length} apply-all writes`)
    assert.equal(calls[0].revision, revision, `${ns} was written at revision ${calls[0].revision}, not ${revision}`)
  }
  const piAiOps = plain(ctx.configForms.get('llm-pi-ai').calls[0].ops)
  assert.deepEqual(piAiOps.map(op => op.path.join('.')), [
    'providers.openrouter.retryPolicy.mode',
    'providers.openrouter.retryPolicy.maxRetries',
    'providers.openrouter.retryPolicy.retryableCodes',
    'providers.openrouter.retryPolicy.backoff.initialDelayMs',
    'providers.openrouter.retryPolicy.backoff.maxDelayMs',
    'providers.openrouter.retryPolicy.backoff.jitterRatio',
  ], 'the apply-all provider ops drifted')
  assert.deepEqual(rowElements(page).map(node => node.props.applyOutcome), ['saved', 'saved', 'saved'], 'the per-row apply outcomes are missing')
  const appliedRow = mountRow(page, 'openrouter')
  assert.ok(renderedText(appliedRow.tree).includes(`${EN['defaults.heading']}: ${EN['apply.outcome.saved']}`), 'the applied outcome copy is missing from a row')
})

await check('every write is fenced by a freshly read revision and never sets a whole object', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const form = ctx.configForms.get('llm-deepseek')
  // The recovery read moves the revision; the next write must fence on it.
  form.push(readySnapshot({ retryPolicy: { mode: 'normal' } }, 9))
  const row = mountRow(page, 'deepseek-official')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 1, `expected one write, got ${form.calls.length}`)
  assert.equal(form.calls[0].revision, 9, `the write used revision ${form.calls[0].revision}, not the freshly read 9`)
  for (const { ops } of form.calls) {
    for (const op of plain(ops)) {
      assert.ok(op.op === 'set' || op.op === 'unset', `an unknown op ${String(op.op)} was submitted`)
      assert.ok(Array.isArray(op.path) && op.path.length > 0, 'an op carried an empty path')
      if (op.op === 'set') {
        const whole = op.value !== null && typeof op.value === 'object' && !Array.isArray(op.value)
        assert.equal(whole, false, `a whole object was set at ${op.path.join('.')}: ${JSON.stringify(op.value)}`)
      }
    }
  }
  assert.equal(form.calls[0].ops.some(op => op.path.length === 1 && op.path[0] === 'retryPolicy'), false, 'a whole retryPolicy was addressed as a path')
})

await check('Apply defaults skips provider rows that are not ready or not writable, and writes the ready ones', async () => {
  const forms = makeForms({
    'llm-deepseek-account': new BoundForm('llm-deepseek-account', { ...readySnapshot({}, 3), writable: false }),
    'llm-deepseek': new BoundForm('llm-deepseek', loadingSnapshot),
  })
  const { page, ctx } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  assert.equal(ctx.configForms.get('llm-deepseek').calls.length, 0, 'a loading row was written')
  assert.equal(ctx.configForms.get('llm-deepseek-account').calls.length, 0, 'a read-only row was written')
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 1, 'the ready provider was not written')
  assert.deepEqual(rowElements(page).map(node => node.props.applyOutcome), ['skipped', 'skipped', 'saved'], `the per-row gate outcomes drifted: ${JSON.stringify(rowElements(page).map(node => node.props.applyOutcome))}`)
  const skippedRow = mountRow(page, 'deepseek-official')
  assert.ok(renderedText(skippedRow.tree).includes(EN['status.loading']), 'the skipped row lost its own status note')
  assert.equal(renderedText(skippedRow.tree).includes(`${EN['defaults.heading']}:`), false, 'a skipped row rendered an apply-outcome badge')
})

await check('Apply defaults never sends an unconditional write for a ready row without a numeric revision', async () => {
  const forms = makeForms({ 'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({}, undefined)) })
  const { page, ctx } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  assert.equal(ctx.configForms.get('llm-deepseek').calls.length, 0, 'a row without a numeric revision was written unconditionally')
  assert.equal(rowElement(page, 'deepseek-official').props.applyOutcome, 'skipped', 'the unfenced row was not recorded as skipped')
  assert.equal(ctx.configForms.get('llm-pi-ai').calls.length, 1, 'the fenced provider was not written')
})

await check('a provider row without a numeric revision keeps its controls and all three actions disabled', async () => {
  const forms = makeForms({ 'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({}, undefined)) })
  const { page } = mountPage({ forms })
  await flush()
  const row = mountRow(page, 'deepseek-official')
  for (const key of ['provider.save', 'provider.reset', 'provider.useDefaults']) {
    const button = buttonWithText(row.tree, [EN[key]])
    assert.ok(button !== undefined, `the ${key} action is missing`)
    assert.equal(button.props.disabled, true, `the ${key} action stayed enabled without a numeric revision`)
  }
  assert.equal(numericInputs(row.tree).every(input => input.props.disabled === true), true, 'the row controls stayed editable without a numeric revision')
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
    form.calls.map(call => call.ops[1].path.join('.')),
    ['providers.openrouter.retryPolicy.maxRetries', 'providers.another.retryPolicy.maxRetries'],
    'the two rows wrote the wrong provider paths',
  )
})

/* ══ 11. validation ════════════════════════════════════════════════════════ */

await check('an invalid retry limit disables Save and renders the field error', async () => {
  const { page } = mountPage()
  await flush()
  const row = mountRow(page, 'deepseek-official')
  setNumeric(row.tree, 0, '2.5')
  assert.equal(buttonWithText(row.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled on a fractional retry limit')
  assert.ok(renderedText(row.tree).includes(EN['error.maxRetries']), 'the maxRetries error copy is missing')
})

await check('out-of-range and mis-ordered delays are refused with their own copy', async () => {
  const { page } = mountPage()
  await flush()
  const row = mountRow(page, 'deepseek-official')
  setNumeric(row.tree, 1, '0')
  assert.equal(buttonWithText(row.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled on a zero delay')
  assert.ok(renderedText(row.tree).includes(EN['error.initialDelayMs']), 'the initial-delay error copy is missing')
  setNumeric(row.tree, 1, '20000')
  setNumeric(row.tree, 2, '10000')
  assert.equal(buttonWithText(row.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled when the initial delay exceeded the maximum')
  assert.ok(renderedText(row.tree).includes(EN['error.initialDelayOrder']), 'the delay-order error copy is missing')
})

await check('an out-of-range jitter and an empty code list are refused', async () => {
  const { page } = mountPage()
  await flush()
  const row = mountRow(page, 'deepseek-official')
  setNumeric(row.tree, 3, '2')
  assert.equal(buttonWithText(row.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled on jitter 2')
  assert.ok(renderedText(row.tree).includes(EN['error.jitterRatio']), 'the jitter error copy is missing')
  setNumeric(row.tree, 3, '0.1')
  for (let index = 0; index < 5; index += 1) toggleCode(row.tree, index, false)
  assert.equal(buttonWithText(row.tree, [EN['provider.save']]).props.disabled, true, 'Save stayed enabled with no retryable codes')
  assert.ok(renderedText(row.tree).includes(EN['error.retryableCodes']), 'the retryable-codes error copy is missing')
})

await check('an always-mode provider row skips the normal-only validation, while the defaults card keeps it', async () => {
  const { page } = mountPage()
  await flush()
  const row = mountRow(page, 'deepseek-official')
  setNumeric(row.tree, 0, '2.5')
  setMode(row.tree, 'always')
  assert.equal(buttonWithText(row.tree, [EN['provider.save']]).props.disabled, false, 'always mode still validated the inactive retry limit')
  row.unmount()

  setNumeric(page.tree, 0, '2.5')
  setMode(page.tree, 'always')
  assert.equal(buttonWithText(page.tree, [EN['defaults.save']]).props.disabled, true, 'the defaults card stopped validating the values it always owns')
  assert.ok(renderedText(page.tree).includes(EN['error.maxRetries']), 'the defaults card did not render the retry-limit error')
})

await check('a read-only container disables every control and the actions', async () => {
  const forms = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', { ...readySnapshot(TUNE_VALUE, 7), writable: false }) })
  const { page } = mountPage({ forms })
  await flush()
  assert.equal(numericInputs(page.tree).every(input => input.props.disabled === true), true, 'a read-only namespace left the inputs enabled')
  assert.equal(buttonWithText(page.tree, [EN['defaults.save']]).props.disabled, true, 'Save defaults stayed enabled in a read-only namespace')
  assert.equal(buttonWithText(page.tree, [EN['defaults.applyAll']]).props.disabled, true, 'Apply defaults stayed enabled in a read-only namespace')
})

/* ══ 12. refusals, managed-elsewhere, and the one retry ═══════════════════ */

await check('a resolved-false refusal (the realistic ConfigForm outcome) shows the generic refusal copy, never the managed copy', async () => {
  const forms = makeForms({ 'llm-pi-ai': new BoundForm('llm-pi-ai', readySnapshot({}, 4), { accept: false }) })
  const { page } = mountPage({ forms })
  await flush()
  const row = mountRow(page, 'openrouter')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  const text = renderedText(row.tree)
  assert.ok(text.includes(EN['error.refused']), `the refusal copy is missing: ${text}`)
  assert.equal(text.includes(EN['error.managed']), false, 'a resolved-false refusal rendered the managed-elsewhere copy')
  assert.equal(forms['llm-pi-ai'].calls.length, 1, 'a resolved-false refusal was retried without a revision move')
})

await check('DEFENSIVE ONLY: a direct RemoteError settings/rejected rejection is classified managed (fake form; unreachable through ConfigForm)', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({}, 2), {
    reject: () => Promise.reject(Object.assign(new Error('opaque'), { code: 'settings/rejected' })),
  })
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  const row = mountRow(page, 'deepseek-official')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.ok(renderedText(row.tree).includes(EN['error.managed']), 'the managed-elsewhere copy is missing for a settings/rejected rejection')
  assert.equal(renderedText(row.tree).includes(EN['error.refused']), false, 'the generic refusal copy was rendered for a managed rejection')
})

await check('DEFENSIVE ONLY: a rejection carrying the override marker is managed even without the settings/rejected code', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({}, 2), {
    reject: () => Promise.reject(new Error('Configuration for "llm-deepseek" is overridden by a home patch or command-line overlay')),
  })
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  const row = mountRow(page, 'deepseek-official')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.ok(renderedText(row.tree).includes(EN['error.managed']), 'the override-marker rejection was not classified as managed')
})

await check('DEFENSIVE ONLY: any other rejection is a plain refusal and is not retried', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({}, 2), {
    reject: () => Promise.reject(new Error('transport failed')),
  })
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  const row = mountRow(page, 'deepseek-official')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.ok(renderedText(row.tree).includes(EN['error.refused']), 'a generic rejection was not shown as a refusal')
  assert.equal(form.calls.length, 1, `a generic rejection was retried ${form.calls.length} times`)
})

await check('a superseded revision is retried once at the freshly read revision', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({}, 2), { reviseOnRefuse: true })
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  const row = mountRow(page, 'deepseek-official')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 2, `expected one retry, got ${form.calls.length} calls`)
  assert.equal(form.calls[0].revision, 2, 'the first attempt did not use revision 2')
  assert.equal(form.calls[1].revision, 3, 'the retry did not use the fresh revision 3')
  assert.ok(renderedText(row.tree).includes(EN['status.saved']), 'the retried save did not report success')
})

await check('a refusal at the fresh revision is not retried a second time', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({}, 2), { refuseRevising: true })
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  const row = mountRow(page, 'deepseek-official')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 2, `the page retried ${form.calls.length} times; exactly one retry is allowed`)
  assert.equal(form.calls[0].revision, 2, 'the first attempt did not use revision 2')
  assert.equal(form.calls[1].revision, 3, 'the retry did not use the fresh revision')
  assert.ok(renderedText(row.tree).includes(EN['error.refused']), 'the second refusal was not shown')
})

/* ══ 13. provider directory and degradation ═══════════════════════════════ */

await check('readProviders resolves remote.llm through ctx.get and falls back to ctx.remote.llm', async () => {
  for (const remote of ['dotted', 'fallback', 'throwing']) {
    const ctx = fakeContext({ remote })
    clientPlugin.apply(ctx)
    const state = await ctx.state.registered[0].options.inject().readProviders()
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
  assert.equal(rowElements(bare.page).length, 3, 'a bare-array directory reply was not accepted')

  const envelope = mountPage()
  await flush()
  assert.equal(rowElements(envelope.page).length, 3, 'the envelope directory reply was not accepted')
})

await check('a deployment without the Remote LLM directory degrades to providers.unavailable', async () => {
  const { page, ctx } = mountPage({ remote: 'none' })
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(EN['providers.unavailable']), 'the provider-unavailable note is missing')
  assert.equal(rowElements(page).length, 0, 'rows were rendered without a provider directory')
  const state = await ctx.state.registered[0].options.inject().readProviders()
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
  const state = await throwing.ctx.state.registered[0].options.inject().readProviders()
  assert.equal(state.status, 'error', 'readProviders did not report the throwing read as an error')
})

await check('an empty provider directory renders the empty note and no rows', async () => {
  const { page } = mountPage({ registered: [], configurable: [] })
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(EN['providers.empty']), 'the empty-directory note is missing')
  assert.equal(rowElements(page).length, 0, 'rows were rendered for an empty directory')
})

/* ══ 14. re-seeding and the reported outcome ══════════════════════════════ */

await check('a pushed snapshot re-seeds the row, and a refused write surfaces the recovery values', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({ retryPolicy: { mode: 'normal', maxRetries: 4 } }, 2), { accept: false })
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  const row = mountRow(page, 'deepseek-official')
  setNumeric(row.tree, 0, '8')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(buttonWithText(row.tree, [EN['provider.save']]).props.disabled, false, 'the row stayed disabled after a refusal')
  // The controller's own recovery read publishes the Host's real value.
  form.push(readySnapshot({ retryPolicy: { mode: 'normal', maxRetries: 4 } }, 3))
  assert.deepEqual(numericInputs(row.tree).map(input => input.props.value), ['4', '500', '10000', '0.1'], 'the row did not re-seed from the recovery read')
  assert.ok(renderedText(row.tree).includes(EN['error.refused']), 'the refusal copy did not survive the re-seed')
})

await check('the override badge follows the user layer, not a value comparison', async () => {
  const form = new BoundForm('llm-deepseek', readySnapshot({ retryPolicy: { mode: 'normal' } }, 2, {}))
  const { page } = mountPage({ forms: makeForms({ 'llm-deepseek': form }) })
  await flush()
  let row = mountRow(page, 'deepseek-official')
  assert.ok(renderedText(row.tree).includes(EN['provider.source.default']), 'an empty user layer did not render the default badge')
  row.unmount()
  // A user-layer retryPolicy equal to the effective value still counts.
  form.push(readySnapshot({ retryPolicy: { mode: 'normal' } }, 3, { retryPolicy: { mode: 'normal' } }))
  row = mountRow(page, 'deepseek-official')
  assert.ok(renderedText(row.tree).includes(EN['provider.source.override']), 'a present user-layer retryPolicy did not render the override badge')
})

await check('a save clears the staged edits so the next snapshot is shown', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const row = mountRow(page, 'deepseek-official')
  const form = ctx.configForms.get('llm-deepseek')
  setNumeric(row.tree, 0, '6')
  buttonWithText(row.tree, [EN['provider.save']]).props.onClick()
  await flush()
  assert.equal(form.calls.length, 1, 'the save did not cross the wire')
  form.push(readySnapshot({ retryPolicy: { mode: 'normal', maxRetries: 1 } }, 3))
  assert.deepEqual(numericInputs(row.tree).map(input => input.props.value), ['1', '500', '10000', '0.1'], 'the staged edit shadowed the next snapshot')
})

await check('an apply-all row that refuses (or, defensively, rejects) reports its own outcome without disturbing the others', async () => {
  const forms = makeForms({
    'llm-deepseek': new BoundForm('llm-deepseek', readySnapshot({}, 2), { accept: false }),
    'llm-pi-ai': new BoundForm('llm-pi-ai', readySnapshot({}, 4), {
      reject: () => Promise.reject(Object.assign(new Error('opaque'), { code: 'settings/rejected' })),
    }),
  })
  const { page } = mountPage({ forms })
  await flush()
  buttonWithText(page.tree, [EN['defaults.applyAll']]).props.onClick()
  await flush()
  assert.deepEqual(rowElements(page).map(node => node.props.applyOutcome), ['saved', 'refused', 'managed'], `the per-row apply outcomes drifted: ${JSON.stringify(rowElements(page).map(node => node.props.applyOutcome))}`)
  assert.equal(forms['llm-deepseek-account'].calls.length, 1, 'the successful provider was not written')
  const refusedRow = mountRow(page, 'deepseek-official')
  assert.ok(renderedText(refusedRow.tree).includes(`${EN['defaults.heading']}: ${EN['apply.outcome.refused']}`), 'the refused apply outcome copy is missing')
  const managedRow = mountRow(page, 'openrouter')
  assert.ok(renderedText(managedRow.tree).includes(`${EN['defaults.heading']}: ${EN['apply.outcome.managed']}`), 'the managed apply outcome copy is missing')
})

/* ══ summary ═══════════════════════════════════════════════════════════════ */

const passed = checks - failures.length
process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${skips.length} skipped (${checks} checks)\n`)
if (failures.length > 0) {
  process.stdout.write(`failed checks:\n${failures.map(failure => `  - ${failure.label}: ${failure.message}`).join('\n')}\n`)
  process.exitCode = 1
}
