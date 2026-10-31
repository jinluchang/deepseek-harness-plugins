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
 * settings save, the real nav row, next-request latency) is a deployment
 * property, not this file. The client half is therefore evaluated in
 * `node:vm` with a minimal React double that pins the element tree and the
 * exact write shapes, not a real browser render.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** The rendered provider-row placeholders of a mounted page, in order. */
const rowElements = page => findAll(page.tree, node => typeof node.type === 'function' && node.props?.row !== undefined)

/** The provider-row placeholder for one provider key. */
function rowElement(page, provider) {
  const found = rowElements(page).find(node => node.props.row.provider === provider)
  if (found === undefined) throw new Error(`no provider row rendered for "${provider}"`)
  return found
}

/** Mount one provider row child exactly as the page renders it. */
function mountRow(page, provider) {
  const element = rowElement(page, provider)
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
      'Config', 'DEFAULT_TUNE', 'RETRYABLE_CODES', 'RETRY_MODES', 'TUNE_KEYS', 'TUNE_OPTIONS',
      'TUNE_PROBLEMS', 'apply', 'name', 'schemaLibrary', 'validateTune',
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

await check('Config is a real schemastery object root, not a transform, refine, or union', () => {
  assert.equal(typeof host.Config, 'function', `Config is ${typeof host.Config}, not a schema`)
  assert.equal(host.Config.type, 'object', `Config.type is ${String(host.Config.type)}: volatileForm only descends an object root`)
  assert.equal(host.Config['~standard']?.vendor, 'schemastery', `the schema vendor is ${String(host.Config['~standard']?.vendor)}`)
  assert.deepEqual(Object.keys(host.Config.dict ?? {}).sort(), [...host.TUNE_KEYS].sort(), `Config.dict is not exactly the six owned fields: ${JSON.stringify(Object.keys(host.Config.dict ?? {}))}`)
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

await check('Config({}) materializes exactly DEFAULT_TUNE', () => {
  const parsed = host.Config({})
  const materialized = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, volatileValue(value)]))
  assert.deepEqual(materialized, plain(host.DEFAULT_TUNE), `Config({}) materialized ${JSON.stringify(materialized)}`)
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

await check('apply does nothing else: no projection, no loader event, no extra inject', () => {
  const { ctx, calls } = hostApplyContext()
  host.apply(ctx)
  assert.deepEqual(calls.injects, [['settings']], 'apply injected another service')
  assert.equal(calls.effects, 1, 'apply mounted more than one effect')
  assert.equal(calls.configures.length, 1, 'apply configured the settings service more than once')
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

await check('README.md and CONTRACT.md name every owned field and their default cells carry the host defaultText', () => {
  for (const [file, text] of [['README.md', readme], ['CONTRACT.md', contract]]) {
    for (const option of host.TUNE_OPTIONS) {
      assert.ok(text.includes(`\`${option.key}\``), `${file} does not name the option ${option.key}`)
    }
  }
  const tables = [
    ['README.md', markdownTable(readme, 'Code default'), 'Code default'],
    ['CONTRACT.md', markdownTable(contract, 'Code default'), 'Code default'],
  ]
  for (const [file, table, defaultColumn] of tables) {
    assert.ok(table.rows.length >= host.TUNE_OPTIONS.length, `${file}: only ${table.rows.length} field rows`)
    const keyColumn = table.header[0]
    for (const option of host.TUNE_OPTIONS) {
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
    for (const option of host.TUNE_OPTIONS) {
      const row = table.rows.find(candidate => plainCell(candidate[keyColumn] ?? '') === option.key)
      assert.ok(row !== undefined, `${file} has no field-table row for ${option.key}`)
      const cell = plainCell(row[rangeColumn] ?? '')
      for (const number of numberTokens(option.range)) {
        assert.ok(numberTokens(cell).has(number), `${file} range cell for ${option.key} never mentions the host range number ${number}: ${cell}`)
      }
      if (option.kind === 'mode') assert.ok(/normal/.test(cell) && /always/.test(cell), `${file} mode range cell must name both modes: ${cell}`)
      if (option.kind === 'retryableCodes') assert.ok(/non-empty/.test(cell) && /unique/.test(cell), `${file} code range cell must state non-empty and unique: ${cell}`)
    }
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
  for (const option of host.TUNE_OPTIONS) {
    assert.ok(contract.includes(`\`${option.key}\``), `CONTRACT.md does not name the config field ${option.key}`)
  }
})

await check('CONTRACT.md states the documented limitations', () => {
  for (const [label, pattern] of [
    ['the no-transaction caveat', /no cross-provider transaction/i],
    ['the home-patch/--patch refusal', /home[- ]patch[\s\S]{0,120}--patch/i],
    ['the in-flight caveat', /in-flight/i],
    ['the dormant-route caveat', /dormant/i],
    ['the npm note', /not published to any npm registry/i],
    ['the no-CLI/env/core-setting note', /environment variable/i],
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
    for (const option of host.TUNE_OPTIONS) {
      assert.ok(text.includes(`\`${option.key}\``), `${file} does not name the field ${option.key}`)
    }
  }
  for (const token of ['9007199254740991', '2147483647', '10000', '0.1']) {
    assert.ok(readmeZh.includes(token), `README.zh.md does not state the default/range value ${token}`)
  }
  assert.ok(readmeZh.includes('LLM 调用调优'), 'README.zh.md does not name the page')
  assert.ok(readme.includes('LLM API call tuning'), 'README.md does not name the page')
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

await check('the en and zh dictionaries carry the same 77 non-empty keys, and English has no CJK text', () => {
  const en = COPY.en
  const zh = COPY.zh
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'the en and zh dictionaries do not carry identical key sets')
  assert.equal(Object.keys(en).length, 77, `the dictionary key count drifted to ${Object.keys(en).length}`)
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

await check('the page renders the defaults card with one control per field and both actions', async () => {
  const { page, ctx } = mountPage()
  await flush()
  const text = renderedText(page.tree)
  for (const key of ['title', 'intro', 'defaults.heading', 'defaults.description', 'defaults.note', 'defaults.applyAllNote', 'providers.heading', 'providers.description']) {
    assert.ok(text.includes(EN[key]), `the page is missing the "${key}" copy`)
  }
  assert.equal(numericInputs(page.tree).length, 4, `the defaults card rendered ${numericInputs(page.tree).length} numeric inputs`)
  assert.ok(modeSelect(page.tree) !== undefined, 'the defaults card has no mode select')
  assert.equal(codeCheckboxes(page.tree).length, 5, `the defaults card rendered ${codeCheckboxes(page.tree).length} code checkboxes`)
  assert.deepEqual(numericInputs(page.tree).map(input => input.props.value), ['5', '500', '10000', '0.1'], 'the defaults controls are not seeded from the effective defaults')
  assert.equal(modeSelect(page.tree).props.value, 'normal', 'the defaults mode is not normal')
  assert.deepEqual(codeCheckboxes(page.tree).map(box => box.props.checked), [true, true, true, true, true], 'not every default code is checked')
  for (const key of ['defaults.save', 'defaults.applyAll']) {
    assert.ok(buttonWithText(page.tree, [EN[key]]) !== undefined, `the "${key}" action is missing`)
  }
  assert.deepEqual(ctx.state.formRequests, ['llm-api-call-tuning', 'llm-deepseek-account', 'llm-deepseek', 'llm-pi-ai'], `apply/mount requested forms ${JSON.stringify(ctx.state.formRequests)}`)
})

await check('an unserved own namespace degrades to status.unavailable and disables the card', async () => {
  const forms = makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', unavailableSnapshot) })
  const { page } = mountPage({ forms })
  await flush()
  const text = renderedText(page.tree)
  assert.ok(text.includes(EN['status.unavailable']), 'the own-namespace unavailable note is missing')
  assert.equal(numericInputs(page.tree).every(input => input.props.disabled === true), true, 'the controls stayed editable on an unserved namespace')
  assert.equal(buttonWithText(page.tree, [EN['defaults.save']]).props.disabled, true, 'Save defaults stayed enabled on an unserved namespace')
  assert.equal(rowElements(page).length, 3, 'the provider card disappeared with the defaults card degraded')
})

await check('a loading or read-only own namespace renders its note and keeps the card disabled', async () => {
  const loading = mountPage({ forms: makeForms({ 'llm-api-call-tuning': new BoundForm('llm-api-call-tuning', loadingSnapshot) }) })
  await flush()
  assert.ok(renderedText(loading.page.tree).includes(EN['status.loading']), 'the own-namespace loading note is missing')
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
  assert.equal(rows.length, 3, `the root render showed ${rows.length} provider rows`)
  for (const node of rows) {
    for (const prop of ['row', 't', 'form', 'defaultsValues', 'applyOutcome']) {
      assert.ok(prop in node.props, `a provider placeholder is missing the "${prop}" prop`)
    }
    assert.equal(typeof node.props.defaultsValues, 'object', 'the placeholder got no validated defaults')
  }
  assert.equal(buttonWithText(page.tree, [EN['provider.save']]), undefined, 'the root render rendered a provider Save control')
  assert.equal(buttonWithText(page.tree, [EN['provider.reset']]), undefined, 'the root render rendered a provider Reset control')
  assert.equal(numericInputs(page.tree).length, 4, 'provider controls leaked into the root render; only the defaults card should render')
})

await check('the page joins the directory in rank order and each row paints its effective value and badge', async () => {
  const { page } = mountPage()
  await flush()
  const order = rowElements(page).map(node => node.props.row.provider)
  assert.deepEqual(order, ['deepseek-account', 'deepseek-official', 'openrouter'], `the joined row order drifted: ${JSON.stringify(order)}`)

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
