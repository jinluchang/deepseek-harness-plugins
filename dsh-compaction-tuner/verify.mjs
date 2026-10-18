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

  const render = inst => {
    inst.hookIndex = 0
    current = inst
    try {
      inst.tree = inst.component(inst.props)
    } finally {
      current = null
    }
    commit(inst)
    return inst.tree
  }

  const mount = (component, props) => {
    const inst = { component, props, hooks: [], hookIndex: 0, tree: null, store: undefined, active: undefined }
    render(inst)
    return inst
  }

  return {
    React: { createElement, useCallback, useId, useRef, useState, useSyncExternalStore },
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
  }
  const form = new BoundForm()
  const ctx = {
    state,
    form,
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

/** A ready snapshot with the given revision and values. */
function readySnapshot(revision, values = { thresholdRatio: 0.8, retainRatio: 0.16, compactionRetries: 1 }) {
  return { status: 'ready', value: values, base: {}, user: values, revision, writable: true }
}

/** Await the microtask queue plus the next macrotask, so a `mutate()` settles. */
const flush = () => new Promise(resolve => { setImmediate(resolve) })

/** Type text into the nth rendered input. */
function typeInto(ui, index, text) {
  findAll(ui.tree(), node => node.type === 'input')[index].props.onChange({ target: { value: text } })
}

/** Click the Save action and let its promise settle. */
async function clickSave(ui) {
  findAll(ui.tree(), node => node.type === 'button')[0].props.onClick()
  await flush()
}

/* ══ fixture load ══════════════════════════════════════════════════════════ */

const manifest = readJson('package.json')
const patch = read('cordis.patch.yml')
const clientSource = read('client.js')

const react = createReactStub()
let captured
const requested = []
const clientVm = createContext({ window: { __ModuleLoader__: { load: options => { captured = options } } }, console })
runInContext(clientSource, clientVm, { filename: 'client.js' })
const clientContext = fakeClientContext()
const clientPlugin = captured.factory(specifier => {
  requested.push(specifier)
  if (specifier === 'react') return react.React
  throw new Error(`client.js requested "${specifier}", which is not in the baseline module table`)
})
clientPlugin.apply(clientContext)

/**
 * Mount a fresh copy of the section against a fresh form double.
 * @param snapshot - the config-form snapshot to serve.
 * @param options - `nextResult` seeds what `mutate` resolves.
 * @returns the mounted double plus its recorders.
 */
function mountSection(snapshot, { nextResult = true } = {}) {
  const ctx = fakeClientContext()
  ctx.form.set(snapshot, nextResult)
  clientPlugin.apply(ctx)
  const registration = ctx.state.registered[0]
  const face = registration.options.inject()
  const start = react.useSyncExternalStoreCalls.length
  const inst = react.mount(registration.component, { close: () => {}, ...face })
  return {
    ctx,
    form: ctx.form,
    registration,
    tree: () => inst.tree,
    button: () => findAll(inst.tree, node => node.type === 'button')[0],
    inputs: () => findAll(inst.tree, node => node.type === 'input'),
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
  for (const dependency of ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings']) {
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

await check('the mount patch starts from the committed preset tune (0.5 / 0.15 / 2)', () => {
  for (const [key, value] of [['thresholdRatio', '0.5'], ['retainRatio', '0.15'], ['compactionRetries', '2']]) {
    assert.match(patch, new RegExp(`^\\s+${key}:\\s+${value}\\s*$`, 'm'), `the mount patch does not start ${key} at ${value}`)
  }
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
    'name', 'inject', 'Config', 'schemaLibrary', 'DEFAULT_TUNE', 'TARGET_PRESET_PLUGIN', 'COMPACTION_ROW_ID',
    'COMPACTION_PLUGIN', 'volatileValue', 'liveTune', 'tuneProblem', 'findCompactionRow', 'readTune', 'withTune',
    'retune', 'apply',
  ]) {
    assert.ok(name in host, `index.js is missing the export "${name}"`)
  }
  assert.equal(host.name, 'compaction-tuner', `index.js exported name drifted to ${String(host.name)}`)
  assert.deepEqual([...host.inject], ['configEditor', 'loader'], `index.js inject drifted to ${JSON.stringify(host.inject)}`)
  assert.equal(host.TARGET_PRESET_PLUGIN, '@deepseek-ai/dsh-agent-preset', 'TARGET_PRESET_PLUGIN drifted')
  assert.equal(host.COMPACTION_ROW_ID, 'compaction-basic', 'COMPACTION_ROW_ID drifted')
  assert.equal(host.COMPACTION_PLUGIN, '@deepseek-ai/dsh-compaction-basic', 'COMPACTION_PLUGIN drifted')
  assert.deepEqual({ ...host.DEFAULT_TUNE }, { thresholdRatio: 0.8, retainRatio: 0.16, compactionRetries: 1 }, 'DEFAULT_TUNE drifted')
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
    ['compactionRetries', 'retainRatio', 'thresholdRatio'],
    'Config.dict is not exactly the three tuner fields',
  )
})

await check('Config declares exactly three volatile fields with the frozen ranges and defaults', () => {
  const expected = {
    thresholdRatio: { step: 0.01, min: 0.01, max: 1, default: 0.8 },
    retainRatio: { step: 0.01, min: 0.01, max: 1, default: 0.16 },
    compactionRetries: { step: 1, min: 0, default: 1 },
  }
  for (const [field, shape] of Object.entries(expected)) {
    const node = host.Config.dict[field]
    assert.ok(node !== undefined, `Config has no "${field}" field`)
    assert.equal(node.meta?.volatile, true, `${field} is not .volatile(), so a settings edit would remount the row`)
    for (const [key, value] of Object.entries(shape)) {
      assert.equal(node.meta?.[key], value, `${field}.${key} drifted: expected ${String(value)}, got ${String(node.meta?.[key])}`)
    }
  }
})

await check('Config({thresholdRatio: 0.5}) fills the other two code defaults', () => {
  const parsed = host.Config({ thresholdRatio: 0.5 })
  assert.equal(host.volatileValue(parsed.thresholdRatio), 0.5, 'thresholdRatio was not parsed to 0.5')
  assert.equal(host.volatileValue(parsed.retainRatio), 0.16, `retainRatio default drifted to ${String(host.volatileValue(parsed.retainRatio))}`)
  assert.equal(host.volatileValue(parsed.compactionRetries), 1, `compactionRetries default drifted to ${String(host.volatileValue(parsed.compactionRetries))}`)
})

await check('the schema refuses every out-of-shape per-field value before the profile patch can change', () => {
  const cases = [
    ['thresholdRatio: 0', { thresholdRatio: 0 }],
    ['thresholdRatio: 1.2', { thresholdRatio: 1.2 }],
    ['retainRatio: 0.005', { thresholdRatio: 0.8, retainRatio: 0.005 }],
    ['compactionRetries: -1', { compactionRetries: -1 }],
    ['compactionRetries: 1.5', { compactionRetries: 1.5 }],
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

await check('tuneProblem is the only guard for the cross-field rule the schema cannot express', () => {
  assert.equal(host.tuneProblem({ thresholdRatio: 0.6, retainRatio: 0.2, compactionRetries: 3 }), undefined, 'a usable tune must not be refused')
  for (const [label, input, pattern] of [
    ['retainRatio above thresholdRatio', { thresholdRatio: 0.2, retainRatio: 0.3, compactionRetries: 1 }, /smaller than thresholdRatio/],
    ['retainRatio equal to thresholdRatio', { thresholdRatio: 0.2, retainRatio: 0.2, compactionRetries: 1 }, /smaller than thresholdRatio/],
    ['thresholdRatio out of range', { thresholdRatio: 0, retainRatio: 0, compactionRetries: 1 }, /thresholdRatio must be/],
    ['compactionRetries fractional', { thresholdRatio: 0.6, retainRatio: 0.2, compactionRetries: 1.5 }, /compactionRetries must be a non-negative integer/],
  ]) {
    assert.match(String(host.tuneProblem(input)), pattern, `tuneProblem missed: ${label}`)
  }
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

await check('a second identical pass performs NO edit at all (compare-and-skip, TODO.md 3.6)', async () => {
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

/* ══ 5. apply(): the three triggers and the fiber read ═════════════════════ */

/** Await the debounced pass, which `schedule()` arms through `setTimeout(..., 0)`. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 10) })

/** Preset rows that all already carry the mount-time tune, so the mount pass is a no-op. */
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
  for (const key of ['nav', 'title', 'action.save', 'action.saving', 'status.loading', 'status.unavailable', 'status.readOnly', 'status.saved', 'error.refused', 'error.retainOrder', 'error.thresholdRange', 'error.retainRange', 'error.retriesInteger']) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en is missing the key "${key}"`)
  }
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

await check('a ready snapshot renders three labelled inputs seeded from the snapshot', () => {
  const ui = mountSection(readySnapshot(7))
  const inputs = ui.inputs()
  assert.equal(inputs.length, 3, `expected 3 inputs for a ready snapshot, rendered ${inputs.length}`)
  assert.deepEqual(inputs.map(input => input.props.value), ['0.8', '0.16', '1'], `input seeding drifted: ${JSON.stringify(inputs.map(input => input.props.value))}`)
  const labels = findAll(ui.tree(), node => node.type === 'label')
  for (const input of inputs) {
    assert.equal(input.props.type, 'number', `the ${String(input.props.id)} input is not numeric`)
    assert.ok(typeof input.props.id === 'string' && input.props.id.length > 0, 'an input has no id for its label to point at')
    assert.ok(labels.some(label => label.props.htmlFor === input.props.id), `no <label for> points at input ${String(input.props.id)}`)
    assert.equal(input.props.disabled, false, 'a writable ready snapshot must not disable its inputs')
  }
  assert.equal(ui.button().props.disabled, true, 'Save must be disabled while the draft equals the snapshot')
  assert.equal(renderedText(ui.tree()).includes('«missing:'), false, `the page rendered a missing dictionary key: ${renderedText(ui.tree())}`)
})

await check('useSyncExternalStore gets one stable useCallback-wrapped bound pair, not bare methods', () => {
  const ui = mountSection(readySnapshot(7))
  const bare = ui.form.subscribe
  assert.throws(() => bare(() => {}), TypeError, 'the form double must prove the controller methods need their receiver')
  typeInto(ui, 1, '0.1')
  const calls = ui.subscribeCalls()
  assert.ok(calls.length >= 2, `expected a re-render to add a uSES call, saw ${calls.length}`)
  assert.notEqual(calls[0].subscribe, BoundForm.prototype.subscribe, 'uSES was handed the bare prototype method')
  assert.notEqual(calls[0].getSnapshot, BoundForm.prototype.getSnapshot, 'uSES was handed the bare prototype method')
  assert.ok(calls.every(call => call.subscribe === calls[0].subscribe), 'the subscribe identity changed between renders, forcing a resubscribe')
  assert.ok(calls.every(call => call.getSnapshot === calls[0].getSnapshot), 'the getSnapshot identity changed between renders')
})

await check('a valid draft issues exactly ONE mutate with the three set ops and the snapshot revision', async () => {
  const ui = mountSection(readySnapshot(7))
  typeInto(ui, 1, '0.1')
  assert.equal(ui.button().props.disabled, false, 'Save must enable once the draft differs from the snapshot')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, `expected exactly one mutate call, got ${ui.form.writes.length}`)
  const write = ui.form.writes[0]
  // The ops come from the vm realm, so compare normalized JSON rather than
  // across two Object prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(write.ops)), [
    { op: 'set', path: ['thresholdRatio'], value: 0.8 },
    { op: 'set', path: ['retainRatio'], value: 0.1 },
    { op: 'set', path: ['compactionRetries'], value: 1 },
  ], `the atomic write ops drifted: ${JSON.stringify(write.ops)}`)
  assert.equal(write.revision, 7, `the mutate revision is ${String(write.revision)}, expected the snapshot revision 7`)
  assert.ok(renderedText(ui.tree()).includes(clientContext.state.dictionaries[0].dictionary.en['status.saved']), `the saved confirmation is not rendered: ${renderedText(ui.tree())}`)
})

await check('an inconsistent draft is refused locally with the matching copy and NO mutate', async () => {
  const ui = mountSection(readySnapshot(7))
  typeInto(ui, 1, '0.9')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 0, `a locally invalid draft reached the Host: ${JSON.stringify(ui.form.writes)}`)
  const alerts = ui.alerts()
  assert.equal(alerts.length, 1, `expected one role="alert" node, got ${alerts.length}`)
  assert.equal(directText(alerts[0]), clientContext.state.dictionaries[0].dictionary.en['error.retainOrder'], `the refusal copy drifted: ${directText(alerts[0])}`)
})

await check('a Host refusal (mutate false) surfaces error.refused, then the recovery snapshot re-seeds the inputs', async () => {
  const ui = mountSection(readySnapshot(7), { nextResult: false })
  typeInto(ui, 1, '0.1')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the refused write was never attempted')
  const alerts = ui.alerts()
  assert.equal(alerts.length, 1, `expected one role="alert" node after a refusal, got ${alerts.length}`)
  assert.equal(directText(alerts[0]), clientContext.state.dictionaries[0].dictionary.en['error.refused'], `the refusal copy drifted: ${directText(alerts[0])}`)
  ui.form.push(readySnapshot(8, { thresholdRatio: 0.9, retainRatio: 0.3, compactionRetries: 4 }))
  assert.deepEqual(ui.inputs().map(input => input.props.value), ['0.9', '0.3', '4'], 'the inputs did not re-seed from the recovery snapshot')
})

await check('a locally-valid but sub-step ratio passes the page and surfaces the Host refusal', async () => {
  const ui = mountSection(readySnapshot(7), { nextResult: false })
  typeInto(ui, 1, '0.005')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 1, 'the page refused 0.005 locally; the host schema step(0.01) is the intended guard')
  assert.equal(ui.form.writes[0].ops[1].value, 0.005, `the submitted retainRatio drifted to ${String(ui.form.writes[0].ops[1].value)}`)
  assert.equal(directText(ui.alerts()[0]), clientContext.state.dictionaries[0].dictionary.en['error.refused'], 'the Host refusal was not surfaced for a sub-step ratio')
})

await check('a non-writable snapshot disables every input and Save and writes nothing', async () => {
  const snapshot = readySnapshot(7)
  snapshot.writable = false
  const ui = mountSection(snapshot)
  for (const input of ui.inputs()) assert.equal(input.props.disabled, true, 'a read-only snapshot must disable its inputs')
  assert.equal(ui.button().props.disabled, true, 'a read-only snapshot must disable Save')
  typeInto(ui, 1, '0.1')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 0, 'a read-only snapshot performed a write')
  assert.ok(renderedText(ui.tree()).includes(clientContext.state.dictionaries[0].dictionary.en['status.readOnly']), 'the read-only note is not rendered')
})

await check('an unavailable namespace renders its note, disables the inputs, and never writes', async () => {
  const ui = mountSection({ status: 'unavailable', value: undefined, revision: 0, writable: false })
  assert.ok(renderedText(ui.tree()).includes(clientContext.state.dictionaries[0].dictionary.en['status.unavailable']), 'the unavailable note is not rendered')
  assert.equal(ui.inputs().length, 3, 'the unavailable page should still render its three disabled inputs')
  typeInto(ui, 1, '0.1')
  await clickSave(ui)
  assert.equal(ui.form.writes.length, 0, 'an unavailable namespace performed a write')
})

await check('no rendered copy is missing from the dictionary in any state', async () => {
  const loading = mountSection({ status: 'loading', revision: 0 })
  const unavailable = mountSection({ status: 'unavailable', revision: 0 })
  const ready = mountSection(readySnapshot(7))
  const invalid = mountSection(readySnapshot(7))
  const refused = mountSection(readySnapshot(7), { nextResult: false })
  typeInto(invalid, 1, '0.9')
  await clickSave(invalid)
  typeInto(refused, 1, '0.1')
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
  const timers = new Map()
  const cleared = new Set()
  const delays = []
  let nextId = 1
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextId
    nextId += 1
    timers.set(id, { id, delay, callback })
    delays.push(delay)
    return id
  }
  globalThis.clearTimeout = id => { cleared.add(id); timers.delete(id) }
  const ordered = () => [...timers.values()].sort((left, right) => left.id - right.id)
  return {
    delays,
    cleared,
    pending: ordered,
    pendingDelays: () => ordered().map(timer => timer.delay),
    retryDelays: () => delays.filter(delay => delay !== 0),
    // Run the oldest pending timer, then let any async pass it started settle.
    async runOldest() {
      const next = ordered()[0]
      if (next === undefined) return false
      timers.delete(next.id)
      next.callback()
      await drain()
      return true
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
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

/* ══ summary ═══════════════════════════════════════════════════════════════ */

const passed = checks - failures.length
process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${skips.length} skipped (${checks} checks)\n`)
if (failures.length > 0) {
  process.stdout.write(`failed checks:\n${failures.map(failure => `  - ${failure.label}: ${failure.message}`).join('\n')}\n`)
  process.exitCode = 1
}
