#!/usr/bin/env node
/**
 * Offline verification for `dsh-lead-agent-only-leads`.
 *
 * Runs without a live Host and checks four things:
 *
 * 1. the pure helpers `index.js` exports;
 * 2. the behaviour of `apply()` against a model of the two scope layers that
 *    matter — a preset layer the Agent INHERITS (which a restriction can filter)
 *    and the Agent's OWN layer, where the Agent Teams plugin registers the team
 *    tools (which a restriction cannot touch). The model therefore also proves
 *    that `wait_agent` survives the restriction, which is why the guard exists;
 * 3. the structure of `cordis.patch.yml`, deep-parsed with the harness's own
 *    js-yaml when the checkout is reachable. The decisive check is that this
 *    preset mounts the same rows, in the same order, as the shipped `standard`
 *    preset: teammates inherit this preset, so anything narrower would make them
 *    non-standard;
 * 4. the preset-classification contract: the immutable creation header never
 *    decides the current preset, the authoritative Session projection does, the
 *    late-mounting registry triggers a re-reconcile, and an unresolvable preset
 *    fails closed instead of reading as "someone else's preset".
 *
 * Usage: `node verify.mjs` — exit code 0 means every check passed.
 *
 * @module dsh-lead-agent-only-leads/verify
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HARNESS = process.env.DSH_HARNESS_CHECKOUT ?? join(HERE, '..', '..', 'deepseek-harness')
const STANDARD_PRESET = join(HARNESS, 'packages/bundle/web-app/presets/standard.patch.yml')

// index.js resolves `@deepseek-ai/schemastery` from the Host installation (it
// ships no node_modules). Point it at the same checkout this suite already reads
// for js-yaml before it is evaluated; the env var is the offline anchor.
process.env.DSH_HARNESS_CHECKOUT ??= HARNESS

const {
  apply,
  Config,
  catalogDefaults,
  isTeamLead,
  LEAD_TOOL_CATALOG,
  leadContract,
  nameList,
  rejectedNames,
  resolveToolPolicy,
  restrictPruning,
  schemaLibrary,
  selectLeadTools,
  toolToggleMap,
  volatileValue,
} = await import('./index.js')

/**
 * Tool names the `standard` preset mounts, which an Agent of it inherits. The
 * plan-mode row registers only `exit_plan_mode`: plan mode itself is session
 * state the user enters (the `/plan` command or the composer), not a tool.
 * `subagent` and `list_subagent_models` are preset-mounted too: the delegation
 * row sets `modelSelection: true` and `modelDiscovery: true`, and both tools are
 * registered in the preset generation scope, which is an ancestor of every
 * Agent scope — so a restriction reaches them.
 */
const PRESET_SURFACE = [
  'bash', 'pwsh', 'read', 'read_image', 'write', 'edit', 'glob', 'grep',
  'job_list', 'job_output', 'job_kill', 'schedule_create', 'schedule_list',
  'subagent', 'subagent_fork', 'list_subagent_models', 'workflow', 'todo_write',
  'ask_user_question', 'web_search', 'web_fetch', 'present', 'skill', 'exit_plan_mode',
]

/**
 * Tool names registered into an Agent's own layer, which a restriction cannot
 * reach: the Agent Teams tools (including `wait_agent`). The guard has to deny
 * the ones a Lead cannot keep; only `wait_agent` is denied by default.
 */
const AGENT_LAYER = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
]

/**
 * Catalog-default keep list: every `whitelist` row whose `def` is true, in
 * catalog order. A Lead talks to the user, tracks the work, and can submit a
 * plan; it cannot read, search, write, or run anything.
 */
const KEPT_BY_DEFAULT = ['ask_user_question', 'todo_write', 'exit_plan_mode', 'present']

/** The catalog's guard-off defaults, i.e. the deny list a fresh Lead gets. */
const DENIED_BY_DEFAULT = ['wait_agent']

/** Every class-`whitelist` toggle turned OFF — the all-off intent. */
const ALL_WHITELIST_OFF = Object.fromEntries(
  LEAD_TOOL_CATALOG.filter(entry => entry.klass === 'whitelist').map(entry => [entry.name, false]),
)

let sequence = 0

/**
 * Model one Agent's tool layers.
 * @param {object} [options] - preset id, Team role, extra session header.
 * @returns {object} the agent plus readers for what was registered on it.
 */
function makeAgent({ preset = 'lead-agent-only-leads', role = 'lead', header = {} } = {}) {
  let allow
  const guards = []
  const sections = new Map()
  const agent = { id: `session-${sequence += 1}`, __role: role, session: { header: { agentPreset: preset, ...header } } }
  // The Agent's view: what it inherits (filtered by any restriction) plus what
  // its own layer registers, which no restriction can reach.
  const visible = () => [...(allow ?? PRESET_SURFACE), ...AGENT_LAYER]
  const tools = {
    schemas: () => visible().map(name => ({ name })),
    restrict: filter => {
      const names = filter.allow ?? []
      const restrictable = new Set(PRESET_SURFACE)
      const rejected = names.filter(name => !restrictable.has(name))
      if (rejected.length > 0) {
        const quoted = rejected.map(name => `"${name}"`).join(', ')
        throw new Error(`tools.restrict() names unknown global tool ${quoted}; known global tools: ${[...restrictable].sort().join(', ')}`)
      }
      allow = [...names]
      return () => { allow = undefined }
    },
    guard: guard => {
      guards.push(guard)
      return () => { const at = guards.indexOf(guard); if (at >= 0) guards.splice(at, 1) }
    },
  }
  const systemPrompt = {
    section: section => {
      if (sections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`)
      sections.set(section.name, section)
      return () => sections.delete(section.name)
    },
  }
  // The real registry binds a preset to the Agent's scope, so the preset id
  // travels on the scope, not on the session header.
  agent.ctx = { tools, systemPrompt, __preset: preset }
  return {
    agent,
    guards,
    sections,
    activeAllow: () => allow,
    names: visible,
    deny: name => guards.map(guard => guard({ name })).find(reason => reason !== undefined),
  }
}

/**
 * Model the Cordis context this plugin is applied to.
 * @param {object} [options] - live agents plus the optional services (the
 *   Loader entry tree doubles as the composition-readability capability probe).
 * @returns {object} the context, an event emitter, and a teardown helper.
 */
function makeHost({ agents = [], presets, teams, settings, loader } = {}) {
  const listeners = new Map()
  const effects = []
  const warnings = []
  /** `settings.configure({ auto })` calls the plugin made, with their owner. */
  const presentations = []
  /** Optional services, mutable so a test can simulate a late activation. */
  const services = new Map()
  if (presets !== undefined) services.set('agentPresets', presets)
  if (teams !== undefined) services.set('agentTeams', teams)
  if (settings !== undefined) services.set('settings', settings)
  if (loader !== undefined) services.set('loader', loader)
  /** `ctx.inject` children waiting for every dependency to appear. */
  const injections = []
  const settingsFace = {
    configure: (policy, owner) => {
      presentations.push({ policy, owner })
      return () => {
        const at = presentations.findIndex(entry => entry.policy === policy)
        if (at >= 0) presentations.splice(at, 1)
      }
    },
  }
  /** Run one injection whose dependencies are all provided, once. */
  const runInjection = entry => {
    if (entry.started) return
    if (!entry.deps.every(dep => services.get(dep) !== undefined)) return
    entry.started = true
    entry.dispose = entry.callback(entry.child)
  }
  const host = {
    agents: { list: () => [...agents], get: id => agents.find(agent => agent.id === id) },
    fiber: { id: 'model-fiber' },
    get: service => services.get(service),
    on: (event, listener) => {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
    },
    effect: callback => {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    // Optional-service injection: the callback runs only when the host provides
    // every dependency, and runs when one of them appears later, mirroring Cordis.
    inject: (deps, callback) => {
      const child = {
        effect: host.effect,
        get: name => services.get(name),
      }
      Object.defineProperty(child, 'settings', {
        get: () => services.get('settings') === undefined ? undefined : settingsFace,
      })
      const entry = { deps, callback, child, started: false, dispose: undefined }
      injections.push(entry)
      runInjection(entry)
      return child
    },
    logger: { warn: message => warnings.push(String(message)), info: () => {} },
  }
  host.emit = (event, ...payload) => {
    for (const listener of listeners.get(event) ?? []) listener(...payload)
  }
  /** Provide one optional service, as the late-mounting registry does. */
  host.provide = (service, value) => {
    services.set(service, value)
    for (const entry of injections) runInjection(entry)
  }
  /** Remove one optional service, as a Host unloading that row would. */
  host.retract = service => {
    services.delete(service)
  }
  host.unload = () => {
    for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose()
  }
  return { host, warnings, presentations }
}

const results = []
/**
 * Record one check.
 * @param {string} label - what is being asserted.
 * @param {() => void} body - the assertions.
 */
function check(label, body) {
  try {
    body()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** A preset registry whose binding is the one recorded on the scope. */
const presetRegistry = { composedPreset: agentCtx => agentCtx.__preset }
/** A Team roster that reads the role recorded on the agent. */
const roster = { tryMembership: agent => ({ role: agent.__role ?? 'lead' }) }

// --- pure helpers -----------------------------------------------------------

check('nameList dedupes, drops junk, and falls back only when unset', () => {
  assert.deepEqual(nameList(['read', 'read', 7, '', 'glob'], []), ['read', 'glob'])
  assert.deepEqual(nameList(undefined, ['fallback']), ['fallback'])
  assert.deepEqual(nameList('read', ['fallback']), ['fallback'])
})

check('selectLeadTools keeps only names the scope knows', () => {
  assert.deepEqual(selectLeadTools(['read', 'list_agents', 'nope'], ['read', 'glob']), ['read'])
})

check('rejectedNames reads the quoted offenders, not the unquoted known list', () => {
  const error = new Error('tools.restrict() names unknown global tool "a", "b"; known global tools: bash, read')
  assert.deepEqual(rejectedNames(error), ['a', 'b'])
})

check('restrictPruning prunes rejected names instead of giving up', () => {
  const calls = []
  const tools = {
    restrict: filter => {
      calls.push(filter.allow)
      if (filter.allow.includes('list_agents')) {
        throw new Error('tools.restrict() names unknown global tool "list_agents"; known global tools: read, glob')
      }
      return () => {}
    },
  }
  restrictPruning(tools, {}, ['read', 'list_agents', 'glob'])
  assert.deepEqual(calls, [['read', 'list_agents', 'glob'], ['read', 'glob']])
})

check('restrictPruning rethrows a rejection it cannot attribute to a name', () => {
  const tools = { restrict: () => { throw new Error('tools.restrict({}) is a no-op') } }
  assert.throws(() => restrictPruning(tools, {}, ['read']), /no-op/)
})

check('isTeamLead trusts the roster, and the root Session without one', () => {
  assert.equal(isTeamLead({ session: { header: {} } }, roster), true)
  assert.equal(isTeamLead({ session: { header: {} }, __role: 'teammate' }, roster), false)
  assert.equal(isTeamLead({ session: { header: {} } }, undefined), true)
  assert.equal(isTeamLead({ session: { header: { parentSession: 'x' } } }, undefined), false)
  assert.equal(isTeamLead({ session: { header: {} } }, { tryMembership: () => undefined }), false)
  assert.equal(isTeamLead({ session: { header: {} } }, { tryMembership: () => { throw new Error('gone') } }), false)
})

check('leadContract states the non-blocking contract and supersedes the wait rule', () => {
  const text = leadContract()
  assert.match(text, /non-blocking Team Lead/i)
  assert.match(text, /wait_agent/)
  assert.match(text, /supersedes/i)
  assert.match(text, /end your turn/i)
})

/**
 * The contract text the catalog defaults produce, embedded so the check needs
 * neither git state nor a historical copy. `leadContract()` with no arguments,
 * `leadContract({})`, and `leadContract({ deny: catalog.deny })` must all return
 * it byte for byte.
 */
const FROZEN_CONTRACT_TEXT = "Non-blocking Lead\n\nYou are a non-blocking Team Lead. You cannot run shell commands, you cannot write or edit files, you cannot read files, search the workspace, or view images, and `wait_agent` is refused — do not count on waiting. Your own tools are `ask_user_question`, `todo_write`, `exit_plan_mode`, and `present`, plus the Team tools; everything else the preset mounts is off your list. This supersedes the Agent Teams instruction to wait for teammates before answering.\n\nHand every part of the job out, and answer the user as soon as it is out.\n- Give each teammate a brief that states the goal, the exact files it may write, and how it must verify the result. To know those files or checks, you may create a reconnaissance task: deploy one teammate on a read-only task — recorded on the shared board like any other task — that states the question and asks for the facts (where the code lives, which files a change touches, how the result should be verified). End your turn; the report arrives as your next turn, and you split and brief the real work from it.\n- Record ownership and dependencies on the shared task board (team_task_*), and use list_agents to see who is running.\n- Use send_message to steer a teammate or to wake an inactive one; a teammate report arrives as a new turn, and the next user message can arrive at any time.\n- Teammates do the reading, searching, and writing; you brief and coordinate. Use ask_user_question when the decision is the user's to make.\n- Assemble the final answer from teammate reports. When a report you need is missing, send_message that teammate and end your turn."

/** The user's exact reconnaissance wording, embedded so it is asserted byte for byte. */
const RECON_BULLET = '- Give each teammate a brief that states the goal, the exact files it may write, and how it must verify the result. To know those files or checks, you may create a reconnaissance task: deploy one teammate on a read-only task — recorded on the shared board like any other task — that states the question and asks for the facts (where the code lives, which files a change touches, how the result should be verified). End your turn; the report arrives as your next turn, and you split and brief the real work from it.'

/** The wording task-14 deleted; it must not survive anywhere in the contract. */
const DELETED_RECON_SENTENCE = 'You cannot read, search, or list the repository, so you may not know those files or checks yet. That is what reconnaissance is for:'

/**
 * Whether a contract text talks about planning at all. Naming the `exit_plan_mode`
 * TOOL is required by the resolved-tool-list sentence (the tool stays enabled), so
 * that backticked name is stripped first: what must never appear is "plan mode",
 * "planning", or any other bare "plan".
 * @param {string} text - a contract text.
 * @returns {boolean} true when the text talks about planning beyond naming the tool.
 */
function mentionsPlanning(text) {
  return /plan/i.test(text.split('`exit_plan_mode`').join(''))
}

check('leadContract() with no arguments is the frozen catalog-default text', () => {
  const text = leadContract()
  assert.equal(text, FROZEN_CONTRACT_TEXT)
  assert.equal(Buffer.byteLength(text, 'utf8'), 1621, 'the frozen text is 1621 UTF-8 bytes')
  assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), '70981d4fa57a6f4481a66ff11bba315d70068f0735dee5021936e4e0b3fdaf1e')
  assert.equal(leadContract({}), FROZEN_CONTRACT_TEXT, 'an empty options object must also keep the frozen text')
  // The contract must not read as if it mentioned or encouraged planning, even
  // though `exit_plan_mode` stays an enabled catalog tool and is therefore named
  // by the resolved-tool-list sentence.
  assert.equal(/plan mode|planning/i.test(text), false, 'the contract must never say "plan mode" or "planning"')
  assert.equal(mentionsPlanning(text), false, 'the only "plan" in the text may be the `exit_plan_mode` tool name')
  // The brief bullet carries the reconnaissance flow, byte for byte and once.
  assert.equal(text.split(RECON_BULLET).length - 1, 1, 'the reconnaissance bullet must appear exactly once, byte-identical')
  assert.equal(text.includes(DELETED_RECON_SENTENCE), false, 'the deleted sentence must not survive')
  assert.match(text, /you may create a reconnaissance task/, 'the reconnaissance flow lives inside the brief bullet')
  assert.equal(/\bwait|\bblock/i.test(RECON_BULLET), false, 'the reconnaissance bullet must not introduce blocking language')
  // The claim paragraph names the resolved tools and the generic Team-tools phrase.
  assert.match(text, /Your own tools are `ask_user_question`, `todo_write`, `exit_plan_mode`, and `present`, plus the Team tools; everything else the preset mounts is off your list\./)
})

check('leadContract({ deny: [] }) states no refusal clause at all', () => {
  const text = leadContract({ deny: [] })
  assert.equal(text.includes('refused'), false, 'an empty deny list must not claim a refusal')
  assert.equal(text.includes('wait_agent'), false)
  assert.equal(text.includes('subagent'), false)
  assert.equal(text.includes('list_subagent_models'), false)
  assert.match(text, /You cannot run shell commands, you cannot write or edit files, and you cannot read files, search the workspace, or view images\./)
  assert.match(text, /supersedes the Agent Teams instruction/i)
})

check('leadContract({ deny: ["subagent"] }) names only subagent and keeps the delegation clause', () => {
  const text = leadContract({ deny: ['subagent'] })
  assert.match(text, /`subagent` is refused/)
  assert.match(text, /do not count on one-shot delegation/)
  assert.equal(text.includes('wait_agent'), false, 'a tool outside `deny` must not be named')
  assert.equal(text.includes('list_subagent_models'), false)
  assert.equal(text.includes('count on waiting'), false, 'waiting is only refused while wait_agent is denied')
})

check('leadContract defaults follow the catalog; deny grammar and hidden flags are faithful', () => {
  const catalog = catalogDefaults()
  assert.equal(leadContract({ deny: catalog.deny }), FROZEN_CONTRACT_TEXT, 'the catalog deny list must reproduce the frozen text')
  for (const denied of catalog.deny) {
    assert.equal(leadContract().includes(`\`${denied}\``), true, `the default text must name ${denied}`)
  }
  // 0/1/many grammar for the refusal sentence.
  assert.equal(leadContract({ deny: [] }).includes('refused'), false)
  assert.match(leadContract({ deny: ['subagent'] }), /`subagent` is refused/)
  assert.match(leadContract({ deny: ['wait_agent', 'subagent'] }), /`wait_agent` and `subagent` are refused/)
  const bare = leadContract({ deny: ['wait_agent'], shellHidden: false, writersHidden: false })
  assert.match(bare, /`wait_agent` is refused — do not count on waiting\./)
  assert.equal(bare.includes('shell commands'), false, 'shellHidden: false must drop the shell claim')
  assert.equal(bare.includes('write or edit files'), false, 'writersHidden: false must drop the writer claim')
  // An unknown flag (anything but an explicit `false`) keeps the catalog text.
  assert.equal(leadContract({ deny: ['wait_agent'], shellHidden: undefined }), leadContract({ deny: ['wait_agent'] }))
})

check('the catalog defaults keep the user-facing tools, the planner, and present, in catalog order', () => {
  const catalog = catalogDefaults()
  assert.deepEqual(catalog.keep, ['ask_user_question', 'todo_write', 'exit_plan_mode', 'present'])
  assert.deepEqual(catalog.deny, ['wait_agent'], 'only the own-scope Team tool is denied by default')
  const onRows = LEAD_TOOL_CATALOG.filter(entry => entry.klass === 'whitelist' && entry.def).map(entry => entry.name)
  assert.deepEqual(catalog.keep, onRows, 'the keep list must follow catalog order')
  const resolved = resolveToolPolicy({})
  assert.deepEqual(resolved.keep, catalog.keep)
  assert.deepEqual(resolved.deny, catalog.deny)
  assert.equal(resolved.keepConfigured, false)
  assert.equal(resolved.denyConfigured, false)
  // The four reading tools are OFF by default and stay `whitelist` rows.
  // `exit_plan_mode` stays ON (making a plan is allowed; the contract simply
  // never mentions it) and so does `present`.
  for (const reader of ['read', 'read_image', 'glob', 'grep']) {
    const entry = LEAD_TOOL_CATALOG.find(candidate => candidate.name === reader)
    assert.equal(entry.klass, 'whitelist', `${reader} must stay a whitelist row`)
    assert.equal(entry.def, false, `${reader} must default OFF`)
  }
  const planner = LEAD_TOOL_CATALOG.find(candidate => candidate.name === 'exit_plan_mode')
  assert.equal(planner.klass, 'whitelist')
  assert.equal(planner.def, true, 'exit_plan_mode must default ON')
  const presenter = LEAD_TOOL_CATALOG.find(candidate => candidate.name === 'present')
  assert.equal(presenter.klass, 'whitelist')
  assert.equal(presenter.def, true, 'present must default ON')
})

check('the reading claim follows its flag, and no contract text mentions planning', () => {
  const base = leadContract()
  assert.equal(leadContract({}), base, 'an empty options object is the frozen text')
  assert.equal(leadContract({ deny: catalogDefaults().deny }), base, 'the catalog deny list reproduces it')
  // An unknown flag (anything but an explicit `false`) keeps the claim.
  assert.equal(leadContract({ readersHidden: undefined }), base)

  const readable = leadContract({ readersHidden: false })
  assert.equal(readable.includes('read files'), false, 'readersHidden: false must drop the reading claim')
  assert.equal(readable.includes('search the workspace'), false)
  assert.equal(readable.includes('view images'), false)
  assert.match(readable, /You cannot run shell commands, you cannot write or edit files, and `wait_agent`/)

  const bare = leadContract({ readersHidden: false, shellHidden: false, writersHidden: false })
  assert.equal(bare.includes('read files'), false)
  assert.equal(bare.includes('shell commands'), false)
  assert.equal(bare.includes('write or edit files'), false)
  assert.match(bare, /You are a non-blocking Team Lead\. `wait_agent`/)

  // No option drops the reconnaissance bullet, and `planEnabled` is not an
  // option at all any more: none of these texts may mention planning.
  for (const text of [base, readable, bare, leadContract({ deny: [] }), leadContract({ planEnabled: false })]) {
    assert.equal(mentionsPlanning(text), false, 'no contract text may mention planning')
    assert.match(text, /read-only task/, 'the reconnaissance-first bullet survives every flag combination')
  }
})

check('the claim paragraph names the actual resolved tool list', () => {
  const text = leadContract()
  // Default: exactly the catalog ON list, in catalog order, plus the generic phrase.
  assert.match(text, /Your own tools are `ask_user_question`, `todo_write`, `exit_plan_mode`, and `present`, plus the Team tools;/)
  assert.deepEqual(catalogDefaults().keep, ['ask_user_question', 'todo_write', 'exit_plan_mode', 'present'])
  // 1/2/many joining, in the order given, and never enumerating the Team tools.
  assert.match(leadContract({ tools: ['todo_write'] }), /Your own tools are `todo_write`, plus the Team tools;/)
  assert.match(leadContract({ tools: ['read', 'todo_write'] }), /Your own tools are `read` and `todo_write`, plus the Team tools;/)
  assert.match(leadContract({ tools: ['ask_user_question', 'todo_write', 'exit_plan_mode', 'present'] }), /Your own tools are `ask_user_question`, `todo_write`, `exit_plan_mode`, and `present`, plus the Team tools;/)
  assert.equal(text.includes('spawn_teammate'), false, 'the Team tools stay a generic phrase, never enumerated')
  // An EMPTY resolved list must not print a dangling list.
  const empty = leadContract({ tools: [] })
  assert.equal(empty.includes('Your own tools are'), false)
  assert.match(empty, /You keep none of the preset's tools, plus the Team tools; everything else the preset mounts is off your list\./)
  assert.equal(/are\s*,/.test(empty), false, 'an empty list must not leave a dangling "are ,"')
  // A non-array falls back to the catalog ON list.
  assert.equal(leadContract({ tools: 'nope' }), text)
  // The sentence follows the policy: re-enabling the reader drops the claim and names read.
  const readable = leadContract({ tools: ['read', 'todo_write'], readersHidden: false })
  assert.match(readable, /Your own tools are `read` and `todo_write`, plus the Team tools;/)
  assert.equal(readable.includes('you cannot read files'), false, 're-enabling read must drop the reading claim')
  // Dropping present removes it from the list.
  const noPresent = leadContract({ tools: ['ask_user_question', 'todo_write', 'exit_plan_mode'] })
  assert.match(noPresent, /Your own tools are `ask_user_question`, `todo_write`, and `exit_plan_mode`, plus the Team tools;/)
  assert.equal(noPresent.includes('`present`'), false)
  // The merged reconnaissance bullet is unchanged in every variant.
  for (const variant of [text, empty, readable, noPresent]) {
    assert.equal(variant.split(RECON_BULLET).length - 1, 1, 'exactly one merged brief bullet')
  }
})

check('selectLeadTools drops exit_plan_mode when the scope does not mount it', () => {
  const keep = catalogDefaults().keep
  assert.deepEqual(selectLeadTools(keep, ['ask_user_question', 'todo_write', 'present']), ['ask_user_question', 'todo_write', 'present'])
  assert.deepEqual(selectLeadTools(keep, ['ask_user_question', 'todo_write', 'exit_plan_mode', 'present']), keep)
  assert.deepEqual(selectLeadTools(keep, ['exit_plan_mode']), ['exit_plan_mode'])
  assert.deepEqual(selectLeadTools(keep, ['present']), ['present'])
  assert.deepEqual(selectLeadTools(keep, ['read', 'glob']), [], 'a scope with only the reading tools keeps none of them')
})

check('the registered contract follows the resolved policy (delegation opt-in shape)', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  // A profile `tools` override re-enables the two preset-scope delegation tools:
  // they join the allow list, only `wait_agent` is denied, and the prompt names
  // the tools the Lead actually keeps.
  apply(host, { tools: { subagent: true, list_subagent_models: true } })
  assert.deepEqual(lead.activeAllow(), [
    'ask_user_question', 'todo_write', 'exit_plan_mode', 'subagent', 'list_subagent_models', 'present',
  ])
  assert.equal(lead.deny('subagent'), undefined, 'a whitelisted delegation tool is not denied')
  assert.equal(lead.deny('list_subagent_models'), undefined)
  assert.match(lead.deny('wait_agent'), /disabled for a non-blocking Lead/)
  const text = lead.sections.get('lead-agent-only-leads:contract').text
  assert.match(text, /`wait_agent` is refused — do not count on waiting\./)
  assert.match(text, /`subagent`/, 'the prompt names a delegation tool this policy keeps')
  assert.match(text, /`list_subagent_models`/)
  assert.match(text, /cannot run shell commands/, 'the resolved allow list still hides bash/pwsh')
  assert.match(text, /you cannot read files, search the workspace, or view images/, 'the resolved allow list hides the reading tools')
  assert.match(text, /Your own tools are `ask_user_question`, `todo_write`, `exit_plan_mode`, `subagent`, `list_subagent_models`, and `present`, plus the Team tools;/, 'the named list is the resolved allow list')
  // `exit_plan_mode` stays in the resolved allow list, but the contract text
  // never mentions it or planning at all.
  assert.equal(lead.activeAllow().includes('exit_plan_mode'), true, 'making a plan stays allowed')
  assert.equal(mentionsPlanning(text), false, 'the registered contract must not mention planning')
  assert.equal(warnings.length, 0, `no warnings expected, got: ${warnings.join(' | ')}`)
})

check('a scope that does not mount exit_plan_mode names only the tools it really keeps', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  lead.agent.ctx.tools.schemas = () => [...PRESET_SURFACE.filter(name => name !== 'exit_plan_mode'), ...AGENT_LAYER].map(name => ({ name }))
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, {})
  assert.deepEqual(lead.activeAllow(), ['ask_user_question', 'todo_write', 'present'], 'the unmounted planner is pruned from the keep list')
  const text = lead.sections.get('lead-agent-only-leads:contract').text
  assert.match(text, /Your own tools are `ask_user_question`, `todo_write`, and `present`, plus the Team tools;/, 'the pruned tool is not named')
  assert.equal(text.includes('exit_plan_mode'), false, 'the contract must not offer a tool this scope does not mount')
  assert.match(text, /you cannot read files, search the workspace, or view images/, 'the reading claim is unaffected')
  assert.equal(text.split(RECON_BULLET).length - 1, 1, 'the merged reconnaissance bullet is unaffected')
  assert.equal(warnings.length, 0, `no warnings expected, got: ${warnings.join(' | ')}`)
})

// --- config schema and catalog ----------------------------------------------

check('the config schema library resolves from the Host, with no bundle-local node_modules', () => {
  assert.notEqual(schemaLibrary, undefined, 'index.js must resolve @deepseek-ai/schemastery from the Host installation')
  assert.equal(typeof schemaLibrary.object, 'function', 'the resolved value must be the schema library')
  assert.notEqual(Config, undefined, 'Config exists whenever the library resolves')
  // The loader decides "volatile-only, no remount" from this tag
  // (vendor/loader/src/config/diff.ts), so it has to be the real library.
  assert.equal(Config['~standard'].vendor, 'schemastery', 'the loader keys volatile-only updates off this vendor tag')
})

check('Config declares a volatile tools dict and default-free volatile legacy keys', () => {
  const json = Config.toJSON()
  const outer = json.refs[json.uid]
  assert.equal(outer.type, 'object')
  assert.deepEqual(Object.keys(outer.dict).sort(), ['denyTools', 'leadTools', 'preset', 'tools'])
  const tools = json.refs[outer.dict.tools]
  assert.equal(tools.type, 'dict')
  assert.deepEqual(tools.meta.default, {}, 'tools must default to an empty map')
  assert.equal(tools.meta.volatile, true, 'tools must be volatile so an edit commits without a remount')
  // The legacy keys must be volatile too (the settings projection carries only
  // volatile fields, which is what the page's legacy-override notice reads) and
  // must carry NO default, so absent stays distinguishable from an explicit [].
  for (const key of ['leadTools', 'denyTools']) {
    const node = json.refs[outer.dict[key]]
    assert.equal(node.meta.volatile, true, `${key} must be volatile for the settings projection`)
    assert.equal(node.meta.default, undefined, `${key} must not carry a schema default`)
  }
  const parsed = Config({})
  assert.equal(parsed.preset, undefined)
  assert.equal(volatileValue(parsed.leadTools), undefined, 'an absent volatile legacy key unwraps to undefined')
  assert.equal(volatileValue(parsed.denyTools), undefined)
  assert.deepEqual(parsed.tools.get(), {})
  assert.deepEqual(Config({ tools: { bash: true } }).tools.get(), { bash: true })
  assert.deepEqual(volatileValue(Config({ leadTools: ['read'] }).leadTools), ['read'], 'a configured legacy key unwraps to its array')
  assert.deepEqual(volatileValue(Config({ denyTools: [] }).denyTools), [], 'an explicit empty deny list must survive validation')
})

check('LEAD_TOOL_CATALOG has the frozen shape, classes, defaults, and order', () => {
  assert.equal(LEAD_TOOL_CATALOG.length, 51)
  const by = klass => LEAD_TOOL_CATALOG.filter(entry => entry.klass === klass)
  assert.equal(by('whitelist').length, 36)
  assert.equal(by('guard').length, 9)
  assert.equal(by('none').length, 6)
  for (const entry of LEAD_TOOL_CATALOG) {
    assert.deepEqual(Object.keys(entry).sort(), ['def', 'klass', 'name'], `entry ${entry.name} must be exactly {name, klass, def}`)
    assert.equal(typeof entry.def, 'boolean')
    assert.ok(['whitelist', 'guard', 'none'].includes(entry.klass), `bad class for ${entry.name}`)
  }
  assert.equal(new Set(LEAD_TOOL_CATALOG.map(entry => entry.name)).size, LEAD_TOOL_CATALOG.length, 'catalog names must be unique')
  for (const entry of by('none')) assert.equal(entry.def, false, `none row ${entry.name} must default false`)
  // The catalog defaults must reproduce the legacy default lists exactly.
  assert.deepEqual(catalogDefaults(), { keep: KEPT_BY_DEFAULT, deny: DENIED_BY_DEFAULT })
})

check('resolveToolPolicy maps toggles to keep/deny and leaves none rows inert', () => {
  assert.deepEqual(resolveToolPolicy({}), {
    keep: KEPT_BY_DEFAULT,
    deny: DENIED_BY_DEFAULT,
    keepConfigured: false,
    denyConfigured: false,
  })
  const flipped = resolveToolPolicy({ tools: { bash: true, wait_agent: true, spawn_teammate: false } })
  assert.ok(flipped.keep.includes('bash'), 'a whitelist tool toggled ON must join the keep list')
  assert.ok(!flipped.deny.includes('wait_agent'), 'a guard tool toggled ON must leave the deny list')
  assert.ok(flipped.deny.includes('spawn_teammate'), 'a guard tool toggled OFF must join the deny list')
  const none = resolveToolPolicy({
    tools: { '/goal': true, '/plan': true, '/compact': true, plugin_manager: true, plugin_market: true, structured_output: true },
  })
  assert.deepEqual(none.keep, KEPT_BY_DEFAULT, 'none rows must never be kept')
  assert.deepEqual(none.deny, DENIED_BY_DEFAULT, 'none rows must never be denied')
  const legacy = resolveToolPolicy({ leadTools: ['read'], denyTools: [], tools: { bash: true } })
  assert.deepEqual(legacy.keep, ['read'], 'legacy leadTools wins wholesale over the map')
  assert.deepEqual(legacy.deny, [], 'an explicit empty denyTools wins wholesale and drops the guard')
  assert.equal(legacy.keepConfigured, true)
  assert.equal(legacy.denyConfigured, true)
})

check('toolToggleMap reads through a live volatile wrapper on every call', () => {
  assert.deepEqual(toolToggleMap({}), {})
  assert.deepEqual(toolToggleMap({ tools: { bash: true } }), { bash: true })
  let live = { read: false }
  assert.deepEqual(toolToggleMap({ tools: { get: () => live } }), { read: false })
  live = { read: true }
  assert.deepEqual(toolToggleMap({ tools: { get: () => live } }), { read: true }, 'a later call must see the new value')
})

// --- behaviour on a Lead ----------------------------------------------------

check('Lead of this preset: preset tools hidden, hand-off tools kept, own-scope tools denied', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, {})

  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'the restriction is the configured keep list')
  const names = lead.names()
  for (const hidden of ['bash', 'pwsh', 'write', 'edit', 'read', 'read_image', 'glob', 'grep', 'subagent', 'subagent_fork', 'list_subagent_models', 'workflow']) {
    assert.equal(names.includes(hidden), false, `${hidden} must be hidden from the Lead`)
  }
  for (const kept of [...KEPT_BY_DEFAULT, ...AGENT_LAYER]) {
    assert.equal(names.includes(kept), true, `${kept} must stay visible`)
  }
  assert.equal(names.includes('wait_agent'), true, 'wait_agent is an Agent-layer tool, so the restriction cannot hide it')
  assert.match(lead.deny('wait_agent'), /disabled for a non-blocking Lead/)
  assert.equal(lead.deny('subagent'), undefined, 'subagent is restricted away by the allow list, not denied')
  assert.equal(lead.deny('list_subagent_models'), undefined, 'list_subagent_models is restricted away by the allow list, not denied')
  assert.equal(lead.deny('read'), undefined, 'the guard denies one tool, not every tool')
  assert.equal(lead.deny('spawn_teammate'), undefined)

  const section = lead.sections.get('lead-agent-only-leads:contract')
  assert.notEqual(section, undefined, 'the Lead gets its own contract section')
  assert.equal(section.text, FROZEN_CONTRACT_TEXT, 'the catalog default must register the frozen contract text')
  assert.equal(section.order > 600 && section.order < 800, true, 'it is ordered after TEAM_POLICY (600)')
  assert.equal(warnings.length, 0, `no warnings expected, got: ${warnings.join(' | ')}`)

  host.emit('agent/created', { agent: lead.agent })
  assert.equal(lead.guards.length, 1, 'reconciling twice registers one guard')
  assert.equal(lead.sections.size, 1, 'reconciling twice registers one section')

  host.unload()
  assert.equal(lead.activeAllow(), undefined, 'unloading releases the restriction')
  assert.equal(lead.guards.length, 0, 'unloading releases the guard')
  assert.equal(lead.sections.size, 0, 'unloading releases the section')
})

check('Teammate inherits the full standard surface, untouched', () => {
  const mate = makeAgent({ preset: 'lead-agent-only-leads', role: 'teammate', header: { parentSession: 'session-0' } })
  const { host } = makeHost({ agents: [mate.agent], presets: presetRegistry, teams: roster })
  apply(host, {})
  assert.equal(mate.activeAllow(), undefined)
  assert.deepEqual(mate.names(), [...PRESET_SURFACE, ...AGENT_LAYER])
  assert.deepEqual([...mate.sections.keys()], [])
  assert.equal(mate.guards.length, 0)
  assert.equal(mate.deny('subagent'), undefined, 'the guard is per constrained Lead, so a teammate keeps subagent')
  assert.equal(mate.deny('list_subagent_models'), undefined)
  assert.equal(mate.deny('wait_agent'), undefined)
})

check('Another preset is left alone', () => {
  const other = makeAgent({ preset: 'standard', role: 'lead' })
  const { host } = makeHost({ agents: [other.agent], presets: presetRegistry, teams: roster })
  apply(host, {})
  assert.equal(other.activeAllow(), undefined)
  assert.equal(other.guards.length, 0)
})

check('A live re-preset applies and lifts the contract', () => {
  const agent = makeAgent({ preset: 'standard', role: 'lead' })
  const { host } = makeHost({ agents: [agent.agent], presets: presetRegistry, teams: roster })
  apply(host, {})
  assert.equal(agent.activeAllow(), undefined)

  agent.agent.ctx.__preset = 'lead-agent-only-leads'
  host.emit('agent-preset/selected', agent.agent.id)
  assert.deepEqual(agent.activeAllow(), KEPT_BY_DEFAULT)

  agent.agent.ctx.__preset = 'standard'
  host.emit('agent-preset/selected', agent.agent.id)
  assert.equal(agent.activeAllow(), undefined, 'moving away releases the restriction')
  assert.equal(agent.guards.length, 0, 'moving away releases the guard')
  assert.equal(agent.sections.size, 0, 'moving away releases the section')
})

check('Without a Team service, only a root Session is a Lead', () => {
  const root = makeAgent({ preset: 'lead-agent-only-leads', header: {} })
  const child = makeAgent({ preset: 'lead-agent-only-leads', header: { parentSession: 'session-0' } })
  const { host } = makeHost({ agents: [root.agent, child.agent], presets: presetRegistry })
  apply(host, {})
  assert.deepEqual(root.activeAllow(), KEPT_BY_DEFAULT)
  assert.equal(child.activeAllow(), undefined)
})

check('Config can narrow the keep list and drop the guard', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: ['read', 'glob'], denyTools: [] })
  assert.deepEqual(lead.activeAllow(), ['read', 'glob'])
  assert.equal(lead.guards.length, 0)
})

check('A keep list naming a scope-registered tool is pruned, not fatal', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: ['read', 'list_agents', 'glob'] })
  assert.deepEqual(lead.activeAllow(), ['read', 'glob'])
  assert.equal(warnings.length, 0)
})

// --- empty-keep outcomes: the fail-open fix and the case left unchanged -------

// Empty-keep outcomes. The ORIGIN of the keep list decides the result: a
// catalog/toggle-derived list knows the scope is not the issue and fails closed,
// while an explicit legacy `leadTools` keeps the warn-and-keep path. These
// replace the old check "A Lead with no restrictable tool keeps its tools and
// warns", whose scenario is now case (b).

check('(b) LEGACY leadTools naming only absent tools keeps the preset tools and warns', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  lead.agent.ctx.tools.schemas = () => [...AGENT_LAYER].map(name => ({ name }))
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: ['pwsh'] })
  assert.equal(lead.activeAllow(), undefined, 'an explicit legacy keep list is the ONE retained warn-and-keep path')
  assert.match(warnings.join(' | '), /no configured Lead tool/)
  assert.equal(lead.names().includes('bash'), true, 'this path deliberately leaves the preset surface intact')
})

check('(a) TOGGLE-derived keep list of only absent tools restricts the Lead to nothing', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  // A scope without `pwsh` (platform-conditional row) alongside the own-scope tools.
  lead.agent.ctx.tools.schemas = () => [...PRESET_SURFACE.filter(name => name !== 'pwsh'), ...AGENT_LAYER].map(name => ({ name }))
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { ...ALL_WHITELIST_OFF, pwsh: true } })
  assert.deepEqual(lead.activeAllow(), [], 'a toggle-derived list resolving to nothing must fail closed')
  const names = lead.names()
  assert.equal(names.includes('bash'), false, 'bash must not survive: the Lead keeps nothing')
  assert.equal(names.includes('write'), false, 'write must not survive either')
  for (const own of AGENT_LAYER) {
    assert.equal(names.includes(own), true, `own-scope ${own} cannot be hidden by a restriction`)
  }
  assert.match(warnings.join(' | '), /pwsh is not mounted in this scope/, 'the warning must name the absent tool')
})

check('(c) MIXED toggle list of known and absent tools restricts to the known name only', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  lead.agent.ctx.tools.schemas = () => [...PRESET_SURFACE.filter(name => name !== 'pwsh'), ...AGENT_LAYER].map(name => ({ name }))
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { ...ALL_WHITELIST_OFF, read: true, pwsh: true } })
  assert.deepEqual(lead.activeAllow(), ['read'], 'the known name is kept and the absent one is dropped')
  assert.equal(warnings.length, 0, `the mixed case must not warn; got: ${warnings.join(' | ')}`)
})

check('ALL-OFF intent: an empty keep list restricts to nothing instead of failing open', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: ALL_WHITELIST_OFF })
  assert.deepEqual(lead.activeAllow(), [], 'a user-intent keep list resolving to zero names must call restrict({ allow: [] })')
  const names = lead.names()
  for (const kept of KEPT_BY_DEFAULT) {
    assert.equal(names.includes(kept), false, `${kept} must be hidden when nothing is kept`)
  }
  for (const own of AGENT_LAYER) {
    assert.equal(names.includes(own), true, `own-scope ${own} cannot be hidden by a restriction`)
  }
  assert.equal(warnings.length, 0, `the all-off case must not warn; got: ${warnings.join(' | ')}`)
})

check('ZERO RESTRICTABLE: a keep list of only own-scope names keeps none of the preset tools', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: ['list_agents', 'wait_agent'] })
  assert.deepEqual(lead.activeAllow(), [], 'non-empty intent with zero restrictable names must keep nothing')
  assert.match(warnings.join(' | '), /none of 2 configured tools for the Lead is restrictable/)
})

check('an explicit empty legacy leadTools now keeps nothing (documented change)', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: [] })
  assert.deepEqual(lead.activeAllow(), [], 'an explicit empty keep list is a "keep nothing" intent')
})

// --- per-tool toggles drive the two lists ------------------------------------

check('a whitelist toggle ON joins the keep list and OFF leaves it', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { bash: true, read: false } })
  const allow = lead.activeAllow()
  assert.ok(allow.includes('bash'), 'bash toggled ON must be kept')
  assert.ok(!allow.includes('read'), 'read toggled OFF must be dropped')
})

check('a guard toggle ON removes the denial and OFF adds it', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { wait_agent: true, spawn_teammate: false } })
  assert.equal(lead.deny('wait_agent'), undefined, 'wait_agent toggled ON must not be denied')
  assert.match(lead.deny('spawn_teammate'), /spawn_teammate is disabled/, 'spawn_teammate toggled OFF must be denied')
})

check('a class-none toggle has no effect on either list', () => {
  const lead = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { '/plan': true, plugin_manager: true, structured_output: true } })
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT)
  assert.match(lead.deny('wait_agent'), /disabled for a non-blocking Lead/, 'guard defaults still apply')
})

check('a volatile toggle edit reaches a Lead created afterwards, without a remount', () => {
  let live = {}
  const config = { tools: { get: () => live } }
  const first = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const agents = [first.agent]
  const { host } = makeHost({ agents, presets: presetRegistry, teams: roster })
  apply(host, config)
  assert.deepEqual(first.activeAllow(), KEPT_BY_DEFAULT, 'precondition: the first Lead got the defaults')
  // A settings-page write commits into the running config in place; `apply` is
  // not re-run, so the running Lead must keep its surface.
  live = { bash: true }
  assert.deepEqual(first.activeAllow(), KEPT_BY_DEFAULT, 'a running Lead must not be re-reconciled')
  const second = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  agents.push(second.agent)
  host.emit('agent/created', { agent: second.agent })
  assert.ok(second.activeAllow().includes('bash'), 'a Lead created after the edit must see the toggled tool')
})

check('apply suppresses the automatic settings page only when a settings service is mounted', () => {
  const withSettings = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const mounted = makeHost({ agents: [withSettings.agent], presets: presetRegistry, teams: roster, settings: {} })
  apply(mounted.host, {})
  assert.equal(mounted.presentations.length, 1, 'the auto-generated page must be suppressed for this row instance')
  assert.deepEqual(mounted.presentations[0].policy, { auto: false })
  assert.equal(mounted.presentations[0].owner, mounted.host.fiber, 'the policy must be owned by this plugin fiber')
  mounted.host.unload()
  assert.equal(mounted.presentations.length, 0, 'unload must release the page policy')

  // A composition without the settings service must still boot cleanly.
  const bare = makeAgent({ preset: 'lead-agent-only-leads', role: 'lead' })
  const without = makeHost({ agents: [bare.agent], presets: presetRegistry, teams: roster })
  apply(without.host, {})
  assert.equal(without.presentations.length, 0)
  assert.equal(without.warnings.length, 0, `no warnings expected without a settings service; got: ${without.warnings.join(' | ')}`)
})

// --- preset classification: projection authority and fail-closed -------------

// `index.js` must classify from the live Session projection, never from the
// immutable creation header, and must recover when the late-mounting registry
// appears. The checks below cover the source-level rules and then the behaviour.

/** Source of the host half, read once for the classification guards. */
const INDEX_SOURCE = readFileSync(join(HERE, 'index.js'), 'utf8')

/**
 * A preset registry whose authoritative projection is recorded per Session.
 * `composedPreset` deliberately reports the creation-time binding, so a check
 * that changes only the projection proves which source decides.
 */
const projectionRegistry = {
  presetForSession: session => session.__projectedPreset ?? session.header.agentPreset ?? null,
  composedPreset: agentCtx => agentCtx.__preset,
}

check('index.js classifies via the projection, never via the creation header', () => {
  assert.equal(/\.header\s*\?*\.\s*agentPreset/.test(INDEX_SOURCE), false, 'the creation header must not decide the current preset')
  assert.equal(INDEX_SOURCE.includes('header.agentPreset'), false)
  assert.match(INDEX_SOURCE, /presetForSession/, 'the authoritative Session projection must be used')
  assert.match(INDEX_SOURCE, /resolved:\s*false/, 'a "cannot tell" classification state must exist')
  assert.match(INDEX_SOURCE, /ctx\.get\('agentPresets'\)/, 'the registry handle must be resolved lazily')
  assert.equal(INDEX_SOURCE.includes("const presets = ctx.get('agentPresets')"), false, 'the registry handle must not be captured once at apply')
  assert.match(INDEX_SOURCE, /ctx\.inject\(\s*\[\s*'agentPresets'\s*\]/, 'a late-arriving registry must trigger a re-reconcile')
  assert.match(INDEX_SOURCE, /ctx\.inject\(\s*\[\s*'agentTeams'\s*\]/, 'a late-arriving Team roster must trigger a re-reconcile')
})

check('a preset registry that activates after apply re-reconciles the Lead', () => {
  const lead = makeAgent({ preset: 'standard', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], teams: roster })
  apply(host, {})
  // No registry yet: an unresolvable preset must not read as "not ours".
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'an unresolvable preset must keep a possible Lead restricted')
  assert.match(warnings.join(' | '), /not resolvable yet/, 'the unresolved path must warn instead of falling back silently')
  // The registry activates; its projection names this Lead.
  lead.agent.session.__projectedPreset = 'lead-agent-only-leads'
  host.provide('agentPresets', projectionRegistry)
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'the resolved projection must keep the restriction')
  assert.equal(lead.guards.length, 1, 're-reconciling must not duplicate the guard')
  assert.equal(lead.sections.size, 1, 're-reconciling must not duplicate the section')
})

check('a late-arriving registry releases a genuine non-Lead', () => {
  const other = makeAgent({ preset: 'standard', role: 'lead' })
  const { host } = makeHost({ agents: [other.agent], teams: roster })
  apply(host, {})
  assert.deepEqual(other.activeAllow(), KEPT_BY_DEFAULT, 'precondition: fail-closed while the preset is unresolved')
  other.agent.session.__projectedPreset = 'standard'
  host.provide('agentPresets', projectionRegistry)
  assert.equal(other.activeAllow(), undefined, 'a resolved non-Lead preset must be released')
  assert.equal(other.guards.length, 0)
  assert.equal(other.sections.size, 0)
})

check('the projection decides the first turn, not the creation header', () => {
  // Created under `standard`, but the live projection says the Lead preset: the
  // exact failure a resumed blank Session produced.
  const lead = makeAgent({ preset: 'standard', role: 'lead' })
  lead.agent.session.__projectedPreset = 'lead-agent-only-leads'
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: projectionRegistry, teams: roster })
  apply(host, {})
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'the projected Lead must be constrained on its first turn')
  assert.equal(lead.guards.length, 1)
  assert.equal(warnings.length, 0, `no warnings expected once the projection answers; got: ${warnings.join(' | ')}`)
})

check('a genuine non-Lead is never restricted', () => {
  const other = makeAgent({ preset: 'standard', role: 'lead' })
  const { host } = makeHost({ agents: [other.agent], presets: projectionRegistry, teams: roster })
  apply(host, {})
  assert.equal(other.activeAllow(), undefined, 'a resolved non-Lead preset must stay untouched')
  assert.equal(other.guards.length, 0)

  const teammate = makeAgent({ preset: 'lead-agent-only-leads', role: 'teammate', header: { parentSession: 'session-0' } })
  const teamHost = makeHost({ agents: [teammate.agent], presets: projectionRegistry, teams: roster })
  apply(teamHost.host, {})
  assert.equal(teammate.activeAllow(), undefined, 'a teammate keeps the full preset surface')
  assert.deepEqual(teammate.names(), [...PRESET_SURFACE, ...AGENT_LAYER])
})

check('the agent-preset/selected payload classifies while the projection is unreadable', () => {
  const agent = makeAgent({ preset: 'standard', role: 'lead' })
  const { host } = makeHost({ agents: [agent.agent], teams: roster })
  apply(host, {})
  assert.deepEqual(agent.activeAllow(), KEPT_BY_DEFAULT, 'precondition: fail-closed without a projection')
  // The registry re-emits `(sessionId, agentPreset)`; without a projection the
  // payload is the secondary signal.
  host.emit('agent-preset/selected', agent.agent.id, 'standard')
  assert.equal(agent.activeAllow(), undefined, 'a payload naming another preset must release')
  host.emit('agent-preset/selected', agent.agent.id, 'lead-agent-only-leads')
  assert.deepEqual(agent.activeAllow(), KEPT_BY_DEFAULT, 'a payload naming the Lead preset must constrain')
})

check('session/event reconciles a selection recorded in the session log', () => {
  const lead = makeAgent({ preset: 'standard', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: projectionRegistry, teams: roster })
  apply(host, {})
  assert.equal(lead.activeAllow(), undefined, 'precondition: not constrained yet')
  lead.agent.session.__projectedPreset = 'lead-agent-only-leads'
  host.emit('session/event', { id: lead.agent.id }, { type: 'agent-preset/selected', data: { agentPreset: 'lead-agent-only-leads' } })
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'the session event must reconcile the Agent')
})

check('a selection observed before the Agent is published applies at creation', () => {
  const agents = []
  const { host } = makeHost({ agents, teams: roster })
  apply(host, {})
  const lead = makeAgent({ preset: 'standard', role: 'lead' })
  host.emit('agent-preset/selected', lead.agent.id, 'lead-agent-only-leads')
  assert.equal(lead.activeAllow(), undefined, 'the Agent does not exist yet')
  agents.push(lead.agent)
  host.emit('agent/created', { agent: lead.agent })
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'the early selection must be applied when the Agent appears')
})

// --- per-Agent bookkeeping: bounded, pruned, and capability-aware -------------

check('index.js prunes per-Agent bookkeeping and bounds early selections', () => {
  const deletions = (INDEX_SOURCE.match(/warnedUnresolved\.delete\(/g) ?? []).length
  assert.equal(deletions >= 3, true, `warnedUnresolved must be cleaned on every non-warning path and on disposal; saw ${deletions} deletion(s)`)
  assert.match(INDEX_SOURCE, /const EARLY_SELECTION_LIMIT = \d+/, 'remembered early selections need an explicit cap')
  assert.match(INDEX_SOURCE, /while \(earlySelections\.size > EARLY_SELECTION_LIMIT\)/, 'the cap must evict, not just exist')
  assert.match(INDEX_SOURCE, /earlySelections\.delete\(oldest\)/, 'eviction must drop the oldest entry')
  assert.match(INDEX_SOURCE, /const takeEarlySelection = sessionId =>/, 'publication must consume the remembered selection')
  assert.match(INDEX_SOURCE, /presetServiceExpected/, 'fail-closed must be capability-aware')
  assert.match(INDEX_SOURCE, /loader\.entries\(\)/, 'the capability probe must read the Loader composition')
})

check('unresolved warnings are one-shot per episode and re-armed by a resolved decision', () => {
  const lead = makeAgent({ preset: 'standard', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], teams: roster })
  apply(host, {})
  const unresolvedWarnings = () => warnings.filter(message => /not resolvable yet/.test(message)).length
  assert.equal(unresolvedWarnings(), 1, 'the first unresolved decision warns once')
  host.emit('agent/created', { agent: lead.agent })
  assert.equal(unresolvedWarnings(), 1, 'a repeated unresolved decision must not spam')
  // Resolving ends the episode; a fresh unresolved one warns again.
  lead.agent.session.__projectedPreset = 'lead-agent-only-leads'
  host.provide('agentPresets', projectionRegistry)
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT)
  host.retract('agentPresets')
  host.emit('agent/created', { agent: lead.agent })
  assert.equal(unresolvedWarnings(), 2, 'a resolved decision must re-arm the warning entry')
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'the fresh episode fails closed again')
})

check('a disposed Agent leaves no bookkeeping behind', () => {
  const lead = makeAgent({ preset: 'standard', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], teams: roster })
  apply(host, {})
  const unresolvedWarnings = () => warnings.filter(message => /not resolvable yet/.test(message)).length
  assert.equal(unresolvedWarnings(), 1)
  host.emit('agent/disposed', { agent: lead.agent })
  assert.equal(lead.activeAllow(), undefined, 'disposal releases the fail-closed restriction')
  // A new episode for the same object can only warn again if disposal dropped it.
  host.emit('agent/created', { agent: lead.agent })
  assert.equal(unresolvedWarnings(), 2, 'disposal must drop the warning entry')
})

check('remembered pre-publication selections stay bounded and are consumed once', () => {
  const agents = []
  const { host } = makeHost({ agents, teams: roster })
  apply(host, {})
  // Overflow the bound with Sessions that never publish an Agent. The Host stays
  // bounded (static guard above) and keeps serving fresh selections.
  for (let index = 0; index < 200; index += 1) {
    host.emit('agent-preset/selected', `ghost-${index}`, 'standard')
  }
  const lead = makeAgent({ preset: 'standard', role: 'lead' })
  host.emit('agent-preset/selected', lead.agent.id, 'lead-agent-only-leads')
  agents.push(lead.agent)
  host.emit('agent/created', { agent: lead.agent })
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'a remembered selection must still classify at publication')

  // Consumed, not merely read: the first publication resolves to the payload,
  // and a second reconcile has no hint left (so the unresolved state returns).
  const second = makeAgent({ preset: 'standard', role: 'lead' })
  host.emit('agent-preset/selected', second.agent.id, 'standard')
  agents.push(second.agent)
  host.emit('agent/created', { agent: second.agent })
  assert.equal(second.activeAllow(), undefined, 'the remembered non-Lead selection releases at publication')
  host.emit('agent/created', { agent: second.agent })
  assert.deepEqual(second.activeAllow(), KEPT_BY_DEFAULT, 'a second publication must not see a stale remembered selection')
})

// The Loader entry tree is the composition, so the harness can model the two
// shipped hosts exactly: Web composes the registry row, headless does not.
const HEADLESS_LOADER = {
  entries: () => [
    { options: { id: 'lead-agent-only-leads', name: 'dsh-lead-agent-only-leads' } },
    { options: { id: 'preset-lead-agent-only-leads', name: '@deepseek-ai/dsh-agent-preset' } },
  ],
}
const WEB_LOADER = {
  entries: () => [
    { options: { id: 'lead-agent-only-leads', name: 'dsh-lead-agent-only-leads' } },
    { options: { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry' } },
  ],
}

check('fail-closed follows composition capability, so a registry-less Host is not over-restricted', () => {
  // Headless composes no preset roster: no preset can ever resolve, so a root
  // Agent must not be held restricted forever.
  const headlessLead = makeAgent({ preset: 'standard', role: 'lead' })
  const headless = makeHost({ agents: [headlessLead.agent], teams: roster, loader: HEADLESS_LOADER })
  apply(headless.host, {})
  assert.equal(headlessLead.activeAllow(), undefined, 'a composition with no registry row must not be restricted')
  assert.equal(headlessLead.guards.length, 0)
  assert.equal(headless.warnings.length, 0, `no warning without a registry to expect; got: ${headless.warnings.join(' | ')}`)

  // The same unresolved preset on Web (row present, not ACTIVE yet) keeps the
  // strict hold that guarantees the Lead's first turn.
  const webLead = makeAgent({ preset: 'standard', role: 'lead' })
  const web = makeHost({ agents: [webLead.agent], teams: roster, loader: WEB_LOADER })
  apply(web.host, {})
  assert.deepEqual(webLead.activeAllow(), KEPT_BY_DEFAULT, 'a composed-but-pending registry must keep the first-turn guarantee')
  assert.equal(web.warnings.filter(message => /not resolvable yet/.test(message)).length, 1)

  // A disabled registry row never starts, so it is not a capability either.
  const disabledLead = makeAgent({ preset: 'standard', role: 'lead' })
  const disabled = makeHost({
    agents: [disabledLead.agent],
    teams: roster,
    loader: { entries: () => [{ options: { name: '@deepseek-ai/dsh-agent-preset-registry' }, disabled: true }] },
  })
  apply(disabled.host, {})
  assert.equal(disabledLead.activeAllow(), undefined, 'a disabled registry row must not justify a permanent hold')
})

// --- patch ------------------------------------------------------------------

check('Patch declares both rows and no leftover of the standard preset', () => {
  const text = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
  for (const needle of [
    '- id: lead-agent-only-leads',
    "name: 'dsh-lead-agent-only-leads'",
    '- id: preset-lead-agent-only-leads',
    "name: '@deepseek-ai/dsh-agent-preset'",
    'id: lead-agent-only-leads',
    'name: Lead agent only leads',
    'order: 5',
  ]) {
    assert.equal(text.includes(needle), true, `patch must contain ${JSON.stringify(needle)}`)
  }
  assert.equal(text.includes('preset-standard'), false)
  assert.equal(text.includes('id: standard'), false)
})

let yaml
try {
  const require = createRequire(join(HARNESS, 'package.json'))
  yaml = require('js-yaml')
} catch {
  yaml = undefined
}

/**
 * Load the harness's loader dialect: `!!js` is its own tag, so a plain schema
 * rejects it.
 * @param {string} path - patch file to parse.
 * @returns {object} the parsed patch document.
 */
function loadPatch(path) {
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: data => ({ js: data }),
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
  return yaml.load(readFileSync(path, 'utf8'), { schema })
}

if (yaml === undefined) {
  results.push({ label: 'Deep patch parse (skipped: js-yaml not reachable from the harness checkout)', ok: true, skipped: true })
} else {
  check('Patch deep-parses into two rows with the Lead agent only leads preset', () => {
    const doc = loadPatch(join(HERE, 'cordis.patch.yml'))
    assert.equal(Array.isArray(doc), true)
    const rows = doc[0].insert
    assert.deepEqual(rows.map(row => [row.id, row.name]), [
      ['lead-agent-only-leads', 'dsh-lead-agent-only-leads'],
      ['preset-lead-agent-only-leads', '@deepseek-ai/dsh-agent-preset'],
    ])
    const config = rows[1].config
    assert.equal(config.id, 'lead-agent-only-leads')
    assert.equal(config.name, 'Lead agent only leads')
    assert.equal(config.order, 5)
    assert.equal(Array.isArray(config.plugins), true)
    assert.equal(config.plugins.every(row => row.group === true ? Array.isArray(row.config) : row.name !== undefined), true)
    assert.equal(config.plugins.find(row => row.id === 'tool-bash').disabled.js, "process.platform === 'win32'", 'the platform guard survives as a JS expression')
  })

  check('This preset mounts the shipped standard rows, in the same order and config', () => {
    const ours = loadPatch(join(HERE, 'cordis.patch.yml'))[0].insert[1].config.plugins
    const standard = loadPatch(STANDARD_PRESET)[0].insert[0].config.plugins
    assert.deepEqual(ours, standard, 'teammates inherit this preset, so it must stay the standard environment')
  })
}

// --- host <-> client catalog parity -----------------------------------------

// `client.js` is a plain browser bundle: it self-registers on
// `window.__ModuleLoader__` and takes its one module-table entry through the
// factory's `require`. Load it that same way and compare the catalog it exposes
// with the host's, so the two halves cannot drift. A stub React suffices —
// nothing renders here.
const CLIENT_PATH = join(HERE, 'client.js')
/** Label for the client-side contract-preview parity result below. */
const CONTRACT_PREVIEW_LABEL = 'the client contract preview mirrors the host builder (5 selection cases)'
if (!existsSync(CLIENT_PATH)) {
  results.push({ label: 'Host and client LEAD_TOOL_CATALOG are deep-equal (skipped: client.js is absent)', ok: true, skipped: true })
} else {
  const stub = new Proxy(function () {}, {
    get: (_target, property) => property === 'then' ? undefined : stub,
    apply: () => stub,
    construct: () => stub,
  })
  try {
    let registration
    const required = []
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    globalThis.window = { __ModuleLoader__: { load: value => { registration = value } } }
    try {
      await import(`${pathToFileURL(CLIENT_PATH).href}?parity=${Date.now()}`)
    } finally {
      if (previousWindow === undefined) delete globalThis.window
      else Object.defineProperty(globalThis, 'window', previousWindow)
    }
    assert.notEqual(registration, undefined, 'client.js must self-register with window.__ModuleLoader__.load')
    assert.equal(registration.id, 'dsh-lead-agent-only-leads', 'the client bundle id must match the package name')
    assert.equal(typeof registration.factory, 'function', 'the registration must expose a factory')
    const face = registration.factory(specifier => {
      required.push(specifier)
      return stub
    })
    assert.ok(required.includes('react'), `the client must take React from the module table; required: ${required.join(', ') || 'nothing'}`)
    assert.notEqual(face?.LEAD_TOOL_CATALOG, undefined, 'the client module face must expose LEAD_TOOL_CATALOG')
    assert.deepEqual(face.LEAD_TOOL_CATALOG, LEAD_TOOL_CATALOG, 'the host and client catalogs must be identical')
    results.push({ label: 'Host and client LEAD_TOOL_CATALOG are deep-equal (51 entries, same order)', ok: true })
    // The page quotes the contract, so the client mirror must reproduce the host
    // builder byte for byte, and its selection resolution must match the host's
    // (the host derives the three hides from its live `reachable` scope; the
    // client approximates that scope with the resolved keep list).
    try {
      assert.equal(face.contractPreview(), FROZEN_CONTRACT_TEXT, 'the no-argument preview must be the frozen catalog-default text')
      const cases = [
        { label: 'catalog default', config: {} },
        { label: 'ask_user_question OFF', config: { tools: { ask_user_question: false } } },
        { label: 'bash ON', config: { tools: { bash: true } } },
        // Keeps `grep` as the ONLY reader, so the readersHidden branch is covered:
        // without this case, dropping a term from that flag's `&&` chain would not
        // change any of the other four texts.
        { label: 'grep ON only', config: { tools: { grep: true, glob: false, read: false, read_image: false } } },
        { label: 'legacy leadTools/denyTools override', config: { leadTools: ['read', 'bash'], denyTools: [] } },
      ]
      for (const { label, config } of cases) {
        const policy = resolveToolPolicy(config)
        const inputs = {
          deny: policy.deny,
          shellHidden: !policy.keep.includes('bash') && !policy.keep.includes('pwsh'),
          writersHidden: !policy.keep.includes('write') && !policy.keep.includes('edit'),
          readersHidden: !policy.keep.includes('read') && !policy.keep.includes('read_image')
            && !policy.keep.includes('glob') && !policy.keep.includes('grep'),
          tools: policy.keep,
        }
        assert.equal(face.contractPreview(inputs), leadContract(inputs), `${label}: the client builder must mirror leadContract byte for byte`)
        assert.equal(face.contractPreviewFor(config), leadContract(inputs), `${label}: the client selection preview must match the host contract`)
      }
      results.push({ label: CONTRACT_PREVIEW_LABEL, ok: true })
    } catch (error) {
      results.push({ label: CONTRACT_PREVIEW_LABEL, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  } catch (error) {
    results.push({
      label: 'Host and client LEAD_TOOL_CATALOG are deep-equal (51 entries, same order)',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// --- report -----------------------------------------------------------------

let failed = 0
for (const result of results) {
  if (result.ok) {
    process.stdout.write(`  ok    ${result.label}${result.skipped === true ? ' (skipped)' : ''}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL  ${result.label}\n        ${result.error}\n`)
  }
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`)
process.exit(failed === 0 ? 0 : 1)
