#!/usr/bin/env node
/**
 * Offline verification for `dsh-lead-only-leads`.
 *
 * Runs without a live Host and checks three things:
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
 *    non-standard.
 *
 * Usage: `node verify.mjs` — exit code 0 means every check passed.
 *
 * @module dsh-lead-only-leads/verify
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HARNESS = process.env.DSH_HARNESS_CHECKOUT ?? '/home/user/Public/deepseek-harness'
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

/** Tool names the `standard` preset mounts, which an Agent of it inherits. */
const PRESET_SURFACE = [
  'bash', 'pwsh', 'read', 'read_image', 'write', 'edit', 'glob', 'grep',
  'job_list', 'job_output', 'job_kill', 'schedule_create', 'schedule_list',
  'subagent_fork', 'workflow', 'todo_write', 'ask_user_question',
  'web_search', 'web_fetch', 'present', 'skill', 'plan_mode',
]

/**
 * Tool names registered into an Agent's own layer, which a restriction cannot
 * reach: the Agent Teams tools, plus the delegation tool's `subagent` and
 * `list_subagent_models` (a preset with `modelSelectionSettings: true` installs
 * them per Agent). The guard has to deny the ones a Lead cannot keep.
 */
const AGENT_LAYER = [
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'subagent', 'list_subagent_models',
]

const KEPT_BY_DEFAULT = ['read', 'read_image', 'glob', 'grep', 'ask_user_question', 'todo_write']

/** The catalog's guard-off defaults, i.e. the deny list a fresh Lead gets. */
const DENIED_BY_DEFAULT = ['wait_agent', 'subagent', 'list_subagent_models']

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
function makeAgent({ preset = 'lead-only-leads', role = 'lead', header = {} } = {}) {
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
 * @param {object} [options] - live agents plus the optional services.
 * @returns {object} the context, an event emitter, and a teardown helper.
 */
function makeHost({ agents = [], presets, teams, settings } = {}) {
  const listeners = new Map()
  const effects = []
  const warnings = []
  /** `settings.configure({ auto })` calls the plugin made, with their owner. */
  const presentations = []
  const host = {
    agents: { list: () => [...agents], get: id => agents.find(agent => agent.id === id) },
    fiber: { id: 'model-fiber' },
    get: service => service === 'agentPresets' ? presets : service === 'agentTeams' ? teams : undefined,
    on: (event, listener) => {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
    },
    effect: callback => {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    // Optional-service injection: the callback runs only when the host provides
    // every dependency, mirroring Cordis. `settings` is the one the plugin uses.
    inject: (deps, callback) => {
      const child = {
        effect: host.effect,
        settings: settings === undefined ? undefined : {
          configure: (policy, owner) => {
            presentations.push({ policy, owner })
            return () => {
              const at = presentations.findIndex(entry => entry.policy === policy)
              if (at >= 0) presentations.splice(at, 1)
            }
          },
        },
      }
      if (deps.includes('settings') && settings !== undefined) callback(child)
      return child
    },
    logger: { warn: message => warnings.push(String(message)), info: () => {} },
  }
  host.emit = (event, payload) => {
    for (const listener of listeners.get(event) ?? []) listener(payload)
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
 * The contract text exactly as it shipped before `leadContract()` accepted
 * options, embedded so the check needs neither git state nor a historical copy.
 * The no-argument call must still return this byte for byte.
 */
const LEGACY_CONTRACT_TEXT = "Non-blocking Lead\n\nYou are a non-blocking Team Lead. You cannot run shell commands, you cannot write or edit files, and `wait_agent`, `subagent`, and `list_subagent_models` are refused — do not plan around waiting or around one-shot delegation. This supersedes the Agent Teams instruction to wait for teammates before answering.\n\nHand every part of the job out, and answer the user as soon as it is out.\n- Give each teammate a brief that states the goal, the exact files it may write, and how it must verify the result.\n- Record ownership and dependencies on the shared task board (team_task_*), and use list_agents to see who is running.\n- Use send_message to steer a teammate or to wake an inactive one; a teammate report arrives as a new turn, and the next user message can arrive at any time.\n- Use read, glob, and grep to inspect the workspace before and while briefing, and ask_user_question when the decision is the user's to make. Teammates do the writing.\n- Assemble the final answer from teammate reports. When a report you need is missing, send_message that teammate and end your turn."

check('leadContract() with no arguments is byte-identical to the pre-options text', () => {
  const text = leadContract()
  assert.equal(text, LEGACY_CONTRACT_TEXT)
  assert.equal(Buffer.byteLength(text, 'utf8'), 1098, 'the frozen text is 1098 UTF-8 bytes')
  assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), '85224c623b11cdcbced5db780028b7c1ce6921fad0625764439423bd5357dfa9')
  assert.equal(leadContract({}), LEGACY_CONTRACT_TEXT, 'an empty options object must also keep the legacy text')
})

check('leadContract({ deny: [] }) states no refusal clause at all', () => {
  const text = leadContract({ deny: [] })
  assert.equal(text.includes('refused'), false, 'an empty deny list must not claim a refusal')
  assert.equal(text.includes('wait_agent'), false)
  assert.equal(text.includes('subagent'), false)
  assert.equal(text.includes('list_subagent_models'), false)
  assert.match(text, /You cannot run shell commands and you cannot write or edit files\./)
  assert.match(text, /supersedes the Agent Teams instruction/i)
})

check('leadContract({ deny: ["subagent"] }) names only subagent and keeps the delegation clause', () => {
  const text = leadContract({ deny: ['subagent'] })
  assert.match(text, /`subagent` is refused/)
  assert.match(text, /do not plan around one-shot delegation/)
  assert.equal(text.includes('wait_agent'), false, 'a tool outside `deny` must not be named')
  assert.equal(text.includes('list_subagent_models'), false)
  assert.equal(text.includes('around waiting'), false, 'waiting is only refused while wait_agent is denied')
})

check('leadContract defaults follow the catalog; deny grammar and hidden flags are faithful', () => {
  const catalog = catalogDefaults()
  assert.equal(leadContract({ deny: catalog.deny }), LEGACY_CONTRACT_TEXT, 'the catalog deny list must reproduce the legacy text')
  for (const denied of catalog.deny) {
    assert.equal(leadContract().includes(`\`${denied}\``), true, `the default text must name ${denied}`)
  }
  // 0/1/many grammar for the refusal sentence.
  assert.equal(leadContract({ deny: [] }).includes('refused'), false)
  assert.match(leadContract({ deny: ['subagent'] }), /`subagent` is refused/)
  assert.match(leadContract({ deny: ['wait_agent', 'subagent'] }), /`wait_agent` and `subagent` are refused/)
  const bare = leadContract({ deny: ['wait_agent'], shellHidden: false, writersHidden: false })
  assert.match(bare, /`wait_agent` is refused — do not plan around waiting\./)
  assert.equal(bare.includes('shell commands'), false, 'shellHidden: false must drop the shell claim')
  assert.equal(bare.includes('write or edit files'), false, 'writersHidden: false must drop the writer claim')
  // An unknown flag (anything but an explicit `false`) keeps the catalog text.
  assert.equal(leadContract({ deny: ['wait_agent'], shellHidden: undefined }), leadContract({ deny: ['wait_agent'] }))
})

check('the registered contract follows the resolved policy (live-profile override shape)', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  // Exactly the live `web` profile patch: the guard keeps `subagent` and
  // `list_subagent_models`, so only `wait_agent` may be refused, and the prompt
  // must not claim a refusal this policy does not enforce.
  apply(host, { tools: { subagent: true, list_subagent_models: true } })
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT)
  assert.equal(lead.deny('subagent'), undefined, 'an allowed guard tool must not be denied')
  assert.equal(lead.deny('list_subagent_models'), undefined)
  assert.match(lead.deny('wait_agent'), /disabled for a non-blocking Lead/)
  const text = lead.sections.get('lead-only-leads:contract').text
  assert.match(text, /`wait_agent` is refused — do not plan around waiting\./)
  assert.equal(text.includes('list_subagent_models'), false, 'the prompt must not name a tool this policy allows')
  assert.equal(/`subagent`/.test(text), false, 'the prompt must not name `subagent` when it is allowed')
  assert.match(text, /cannot run shell commands/, 'the resolved allow list still hides bash/pwsh')
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
  assert.equal(by('whitelist').length, 34)
  assert.equal(by('guard').length, 11)
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
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, {})

  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT, 'the restriction is the configured keep list')
  const names = lead.names()
  for (const hidden of ['bash', 'pwsh', 'write', 'edit', 'subagent_fork', 'workflow', 'present', 'plan_mode']) {
    assert.equal(names.includes(hidden), false, `${hidden} must be hidden from the Lead`)
  }
  for (const kept of [...KEPT_BY_DEFAULT, ...AGENT_LAYER]) {
    assert.equal(names.includes(kept), true, `${kept} must stay visible`)
  }
  assert.equal(names.includes('wait_agent'), true, 'wait_agent is an Agent-layer tool, so the restriction cannot hide it')
  assert.equal(names.includes('subagent'), true, 'subagent is an Agent-layer tool, so the restriction cannot hide it')
  assert.match(lead.deny('wait_agent'), /disabled for a non-blocking Lead/)
  assert.match(lead.deny('subagent'), /spawn_teammate/, 'the subagent denial points at spawn_teammate')
  assert.match(lead.deny('list_subagent_models'), /spawn_teammate/, 'the list_subagent_models denial points at spawn_teammate')
  assert.equal(lead.deny('read'), undefined, 'the guard denies one tool, not every tool')
  assert.equal(lead.deny('spawn_teammate'), undefined)

  const section = lead.sections.get('lead-only-leads:contract')
  assert.notEqual(section, undefined, 'the Lead gets its own contract section')
  assert.equal(section.text, LEGACY_CONTRACT_TEXT, 'the catalog default must register the frozen contract text')
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
  const mate = makeAgent({ preset: 'lead-only-leads', role: 'teammate', header: { parentSession: 'session-0' } })
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

  agent.agent.ctx.__preset = 'lead-only-leads'
  host.emit('agent-preset/selected', agent.agent.id)
  assert.deepEqual(agent.activeAllow(), KEPT_BY_DEFAULT)

  agent.agent.ctx.__preset = 'standard'
  host.emit('agent-preset/selected', agent.agent.id)
  assert.equal(agent.activeAllow(), undefined, 'moving away releases the restriction')
  assert.equal(agent.guards.length, 0, 'moving away releases the guard')
  assert.equal(agent.sections.size, 0, 'moving away releases the section')
})

check('Without a Team service, only a root Session is a Lead', () => {
  const root = makeAgent({ preset: 'lead-only-leads', header: {} })
  const child = makeAgent({ preset: 'lead-only-leads', header: { parentSession: 'session-0' } })
  const { host } = makeHost({ agents: [root.agent, child.agent], presets: presetRegistry })
  apply(host, {})
  assert.deepEqual(root.activeAllow(), KEPT_BY_DEFAULT)
  assert.equal(child.activeAllow(), undefined)
})

check('Config can narrow the keep list and drop the guard', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: ['read', 'glob'], denyTools: [] })
  assert.deepEqual(lead.activeAllow(), ['read', 'glob'])
  assert.equal(lead.guards.length, 0)
})

check('A keep list naming a scope-registered tool is pruned, not fatal', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
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
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  lead.agent.ctx.tools.schemas = () => [...AGENT_LAYER].map(name => ({ name }))
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: ['pwsh'] })
  assert.equal(lead.activeAllow(), undefined, 'an explicit legacy keep list is the ONE retained warn-and-keep path')
  assert.match(warnings.join(' | '), /no configured Lead tool/)
  assert.equal(lead.names().includes('bash'), true, 'this path deliberately leaves the preset surface intact')
})

check('(a) TOGGLE-derived keep list of only absent tools restricts the Lead to nothing', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
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
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  lead.agent.ctx.tools.schemas = () => [...PRESET_SURFACE.filter(name => name !== 'pwsh'), ...AGENT_LAYER].map(name => ({ name }))
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { ...ALL_WHITELIST_OFF, read: true, pwsh: true } })
  assert.deepEqual(lead.activeAllow(), ['read'], 'the known name is kept and the absent one is dropped')
  assert.equal(warnings.length, 0, `the mixed case must not warn; got: ${warnings.join(' | ')}`)
})

check('ALL-OFF intent: an empty keep list restricts to nothing instead of failing open', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
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
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host, warnings } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: ['list_agents', 'wait_agent'] })
  assert.deepEqual(lead.activeAllow(), [], 'non-empty intent with zero restrictable names must keep nothing')
  assert.match(warnings.join(' | '), /none of 2 configured Lead tools is restrictable/)
})

check('an explicit empty legacy leadTools now keeps nothing (documented change)', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { leadTools: [] })
  assert.deepEqual(lead.activeAllow(), [], 'an explicit empty keep list is a "keep nothing" intent')
})

// --- per-tool toggles drive the two lists ------------------------------------

check('a whitelist toggle ON joins the keep list and OFF leaves it', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { bash: true, read: false } })
  const allow = lead.activeAllow()
  assert.ok(allow.includes('bash'), 'bash toggled ON must be kept')
  assert.ok(!allow.includes('read'), 'read toggled OFF must be dropped')
})

check('a guard toggle ON removes the denial and OFF adds it', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { wait_agent: true, spawn_teammate: false } })
  assert.equal(lead.deny('wait_agent'), undefined, 'wait_agent toggled ON must not be denied')
  assert.match(lead.deny('spawn_teammate'), /spawn_teammate is disabled/, 'spawn_teammate toggled OFF must be denied')
})

check('a class-none toggle has no effect on either list', () => {
  const lead = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const { host } = makeHost({ agents: [lead.agent], presets: presetRegistry, teams: roster })
  apply(host, { tools: { '/plan': true, plugin_manager: true, structured_output: true } })
  assert.deepEqual(lead.activeAllow(), KEPT_BY_DEFAULT)
  assert.match(lead.deny('wait_agent'), /disabled for a non-blocking Lead/, 'guard defaults still apply')
})

check('a volatile toggle edit reaches a Lead created afterwards, without a remount', () => {
  let live = {}
  const config = { tools: { get: () => live } }
  const first = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const agents = [first.agent]
  const { host } = makeHost({ agents, presets: presetRegistry, teams: roster })
  apply(host, config)
  assert.deepEqual(first.activeAllow(), KEPT_BY_DEFAULT, 'precondition: the first Lead got the defaults')
  // A settings-page write commits into the running config in place; `apply` is
  // not re-run, so the running Lead must keep its surface.
  live = { bash: true }
  assert.deepEqual(first.activeAllow(), KEPT_BY_DEFAULT, 'a running Lead must not be re-reconciled')
  const second = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  agents.push(second.agent)
  host.emit('agent/created', { agent: second.agent })
  assert.ok(second.activeAllow().includes('bash'), 'a Lead created after the edit must see the toggled tool')
})

check('apply suppresses the automatic settings page only when a settings service is mounted', () => {
  const withSettings = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const mounted = makeHost({ agents: [withSettings.agent], presets: presetRegistry, teams: roster, settings: {} })
  apply(mounted.host, {})
  assert.equal(mounted.presentations.length, 1, 'the auto-generated page must be suppressed for this row instance')
  assert.deepEqual(mounted.presentations[0].policy, { auto: false })
  assert.equal(mounted.presentations[0].owner, mounted.host.fiber, 'the policy must be owned by this plugin fiber')
  mounted.host.unload()
  assert.equal(mounted.presentations.length, 0, 'unload must release the page policy')

  // A composition without the settings service must still boot cleanly.
  const bare = makeAgent({ preset: 'lead-only-leads', role: 'lead' })
  const without = makeHost({ agents: [bare.agent], presets: presetRegistry, teams: roster })
  apply(without.host, {})
  assert.equal(without.presentations.length, 0)
  assert.equal(without.warnings.length, 0, `no warnings expected without a settings service; got: ${without.warnings.join(' | ')}`)
})

// --- patch ------------------------------------------------------------------

check('Patch declares both rows and no leftover of the standard preset', () => {
  const text = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
  for (const needle of [
    '- id: lead-only-leads',
    "name: '@local/dsh-lead-only-leads'",
    '- id: preset-lead-only-leads',
    "name: '@deepseek-ai/dsh-agent-preset'",
    'id: lead-only-leads',
    'name: Lead only leads',
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

/**
 * Every row id in a preset plugin list, groups included.
 * @param {object[]} plugins - the preset's `config.plugins`.
 * @returns {string[]} ids in mount order.
 */
function flatten(plugins) {
  return plugins.flatMap(row => row.group === true ? [row.id, ...flatten(row.config)] : [row.id])
}

if (yaml === undefined) {
  results.push({ label: 'Deep patch parse (skipped: js-yaml not reachable from the harness checkout)', ok: true, skipped: true })
} else {
  check('Patch deep-parses into two rows with the Lead only leads preset', () => {
    const doc = loadPatch(join(HERE, 'cordis.patch.yml'))
    assert.equal(Array.isArray(doc), true)
    const rows = doc[0].insert
    assert.deepEqual(rows.map(row => [row.id, row.name]), [
      ['lead-only-leads', '@local/dsh-lead-only-leads'],
      ['preset-lead-only-leads', '@deepseek-ai/dsh-agent-preset'],
    ])
    const config = rows[1].config
    assert.equal(config.id, 'lead-only-leads')
    assert.equal(config.name, 'Lead only leads')
    assert.equal(config.order, 5)
    assert.equal(Array.isArray(config.plugins), true)
    assert.equal(config.plugins.every(row => row.group === true ? Array.isArray(row.config) : row.name !== undefined), true)
    assert.equal(config.plugins.find(row => row.id === 'tool-bash').disabled.js, "process.platform === 'win32'", 'the platform guard survives as a JS expression')
  })

  check('This preset mounts the shipped standard rows, in the same order', () => {
    const ours = loadPatch(join(HERE, 'cordis.patch.yml'))[0].insert[1].config.plugins
    const standard = loadPatch(STANDARD_PRESET)[0].insert[0].config.plugins
    assert.deepEqual(flatten(ours), flatten(standard), 'teammates inherit this preset, so it must stay the standard environment')
  })
}

// --- host <-> client catalog parity -----------------------------------------

// `client.js` is a plain browser bundle: it self-registers on
// `window.__ModuleLoader__` and takes its one module-table entry through the
// factory's `require`. Load it that same way and compare the catalog it exposes
// with the host's, so the two halves cannot drift. A stub React suffices —
// nothing renders here.
const CLIENT_PATH = join(HERE, 'client.js')
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
    assert.equal(registration.id, '@local/dsh-lead-only-leads', 'the client bundle id must match the package name')
    assert.equal(typeof registration.factory, 'function', 'the registration must expose a factory')
    const face = registration.factory(specifier => {
      required.push(specifier)
      return stub
    })
    assert.ok(required.includes('react'), `the client must take React from the module table; required: ${required.join(', ') || 'nothing'}`)
    assert.notEqual(face?.LEAD_TOOL_CATALOG, undefined, 'the client module face must expose LEAD_TOOL_CATALOG')
    assert.deepEqual(face.LEAD_TOOL_CATALOG, LEAD_TOOL_CATALOG, 'the host and client catalogs must be identical')
    results.push({ label: 'Host and client LEAD_TOOL_CATALOG are deep-equal (51 entries, same order)', ok: true })
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
