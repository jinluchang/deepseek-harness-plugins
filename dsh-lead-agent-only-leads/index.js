/**
 * Host half of `dsh-lead-agent-only-leads`: keep a Team Lead non-blocking.
 *
 * The `lead-agent-only-leads` preset (inserted by this bundle's patch) carries the full
 * standard environment, because a teammate spawned by a Team Lead joins the
 * Lead's exact preset generation — a narrower preset would narrow the teammates
 * too, and teammates must stay ordinary agents that may block on each other.
 * The Lead-only asymmetry is therefore applied here, per Agent scope, once the
 * Agent exists.
 *
 * Per-Agent scope is what makes the asymmetry safe:
 *
 * - Tools a preset mounts live in an ANCESTOR layer of the Agent's scope, so
 *   `tools.restrict()` on the Agent's own scope hides them for that Agent alone.
 *   The Lead loses the shell, the file readers and writers, delegation-to-
 *   subagents, the web, jobs, and scheduling; it keeps `exit_plan_mode` as an
 *   enabled tool, though this contract does not mention or encourage making a
 *   plan. Teammates keep all of it.
 * - The Agent's OWN layer is exempt from restrictions. The Agent Teams tools are
 *   registered there, which is why restricting the Lead cannot — and should not —
 *   hide `spawn_teammate`, `send_message`, `list_agents`, or the shared task
 *   board: handing work out is the Lead's entire job. The same exemption covers
 *   the delegation tool whenever the preset mounts it with
 *   `modelSelectionSettings: true`: `subagent` and `list_subagent_models` are
 *   installed into each Agent's own scope, so no restriction can hide them
 *   either. `wait_agent`, `subagent`, and `list_subagent_models` are therefore
 *   taken away by a monotonic execution guard that denies them instead.
 * - A guard only denies; it cannot re-allow. Nothing downstream can turn the
 *   Lead's refusal to wait back into a permission.
 *
 * That deny list is the CATALOG default, not a fixed law: a profile `tools`
 * override can re-enable a guard tool (the live `web` profile patch re-enables
 * `subagent` and `list_subagent_models`), so the prompt contract below is built
 * from whatever policy `constrain()` actually resolved. The Lead never claims a
 * refusal its own scope does not enforce.
 *
 * The Lead also gets its own prompt section, ordered after the generic Agent
 * Teams policy section and stating plainly that the generic rule to wait for
 * teammates does not apply in this preset.
 *
 * @module @local/dsh-lead-agent-only-leads
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Resolve the config-schema library (`@deepseek-ai/schemastery`) without a
 * bundle-local `node_modules`.
 *
 * A settings `Config` cannot be a bare standard-schema object. Three harness
 * seams decide that, and all three need the real library:
 *
 * - the loader only treats a config change as volatile-only when
 *   `schema['~standard'].vendor === 'schemastery'` and it can read the schema's
 *   `meta`/`type`/`dict` (`vendor/loader/src/config/diff.ts` `equalExceptVolatile`);
 *   any other value compares the whole raw config, so a toggle edit would remount
 *   the plugin and re-reconcile every running Lead;
 * - the settings service needs `toJSON()` plus `meta`/`type`/`dict` on the schema
 *   (`packages/settings/settings/src/index.ts` `schema()`/`describe()`, and
 *   `packages/settings/settings/src/schema.ts` `volatileForm`/`isVolatilePath`);
 * - the no-remount commit walks cosmokit `Volatile` references that the schema
 *   validator produced, in the running config (`vendor/loader/src/config/entry.ts`
 *   `_commitVolatile`).
 *
 * The bundle ships no `node_modules`, and the Host that loads it always has the
 * library in its own resolution graph, so resolve from the Host — offline, and
 * stable across restarts:
 *
 * 1. the plugin's own location, for an install that did fetch dependencies;
 * 2. the running process entry (`process.argv[1]`), which is inside the harness;
 * 3. `$DSH_HARNESS_CHECKOUT` (the offline suites) through the pnpm workspace's
 *    hoisted store.
 *
 * @returns {object|undefined} the library, or `undefined` when no anchor resolves
 *   it. `Config` is then undefined: the plugin still enforces the catalog
 *   defaults, but no settings namespace exists to render the page.
 */
function resolveSchemaLibrary() {
  const anchors = [import.meta.url, process.argv[1]]
  const checkout = process.env.DSH_HARNESS_CHECKOUT
  if (typeof checkout === 'string' && checkout.length > 0) {
    anchors.push(join(checkout, 'node_modules', '.pnpm', 'node_modules', '__dsh_plugin_anchor__.js'))
  }
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || anchor.length === 0) continue
    try {
      const loaded = createRequire(anchor)('@deepseek-ai/schemastery')
      if (typeof loaded?.object === 'function') return loaded
      if (typeof loaded?.default?.object === 'function') return loaded.default
    } catch {
      // The next anchor may be the one inside the Host installation.
    }
  }
  return undefined
}

/** Schema library `Config` is built from; `undefined` when unresolved. */
export const schemaLibrary = resolveSchemaLibrary()

/** Preset that selects a non-blocking Lead. Must match the patch's preset id. */
const PRESET_ID = 'lead-agent-only-leads'

/**
 * The catalog's whitelist-ON default keep list, in catalog order, and the
 * fallback `nameList()` uses for a MALFORMED legacy `leadTools` value — a key
 * that is present but not an array. An absent key always resolves from
 * `LEAD_TOOL_CATALOG`, which is the source of truth; mirroring it here, in the
 * same order, is what stops the fallback and the real default policy from
 * disagreeing. The reading tools are deliberately not on it: teammates read.
 */
const DEFAULT_LEAD_TOOLS = Object.freeze([
  'ask_user_question',
  'todo_write',
  'exit_plan_mode',
  'present',
])

/**
 * Tools denied even though they stay listed. `wait_agent` is registered into the
 * Agent's own scope by the Agent Teams plugin, and `subagent` /
 * `list_subagent_models` into that same own scope by the delegation tool when the
 * preset sets `modelSelectionSettings: true`; a restriction cannot reach any of
 * them, so the guard is the only way to take them away.
 */
const DEFAULT_DENIED_TOOLS = Object.freeze(['wait_agent', 'subagent', 'list_subagent_models'])

/**
 * The tool universe the settings page toggles, in display order. One entry per
 * tool: `klass` is the only mechanism a toggle can use, `def` the default on/off.
 *
 * - `whitelist` — a preset- or global-layer tool. ON keeps the name in the
 *   Lead's allow list; OFF simply omits it (the allow list hides it).
 * - `guard` — an own-scope tool (the Team tools, the delegation tools) that a
 *   restriction cannot reach. OFF denies it through the guard; ON removes the
 *   denial.
 * - `none` — not reachable by either mechanism (slash commands, `disabled` rows,
 *   a child-only tool). `def` is fixed `false`, the page renders the row
 *   inoperative, and this plugin ignores the name entirely.
 *
 * The client half mirrors this exact array (same names, same order, same
 * klass/def); `verify.mjs` deep-compares the two so they cannot drift.
 */
export const LEAD_TOOL_CATALOG = Object.freeze([
  // whitelist (34)
  { name: 'read', klass: 'whitelist', def: false },
  { name: 'read_image', klass: 'whitelist', def: false },
  { name: 'glob', klass: 'whitelist', def: false },
  { name: 'grep', klass: 'whitelist', def: false },
  { name: 'ask_user_question', klass: 'whitelist', def: true },
  { name: 'todo_write', klass: 'whitelist', def: true },
  { name: 'bash', klass: 'whitelist', def: false },
  { name: 'pwsh', klass: 'whitelist', def: false },
  { name: 'write', klass: 'whitelist', def: false },
  { name: 'edit', klass: 'whitelist', def: false },
  { name: 'job_output', klass: 'whitelist', def: false },
  { name: 'job_list', klass: 'whitelist', def: false },
  { name: 'job_kill', klass: 'whitelist', def: false },
  { name: 'schedule_create', klass: 'whitelist', def: false },
  { name: 'schedule_list', klass: 'whitelist', def: false },
  { name: 'schedule_delete', klass: 'whitelist', def: false },
  { name: 'schedule_update', klass: 'whitelist', def: false },
  { name: 'skill', klass: 'whitelist', def: false },
  { name: 'get_goal', klass: 'whitelist', def: false },
  { name: 'create_goal', klass: 'whitelist', def: false },
  { name: 'update_goal', klass: 'whitelist', def: false },
  { name: 'exit_plan_mode', klass: 'whitelist', def: true },
  { name: 'subagent_fork', klass: 'whitelist', def: false },
  { name: 'workflow', klass: 'whitelist', def: false },
  { name: 'web_search', klass: 'whitelist', def: false },
  { name: 'web_fetch', klass: 'whitelist', def: false },
  { name: 'present', klass: 'whitelist', def: true },
  { name: 'session_search', klass: 'whitelist', def: false },
  { name: 'session_event_search', klass: 'whitelist', def: false },
  { name: 'session_event_read', klass: 'whitelist', def: false },
  { name: 'session_event_trace', klass: 'whitelist', def: false },
  { name: 'session_trace', klass: 'whitelist', def: false },
  { name: 'ralph', klass: 'whitelist', def: false },
  { name: 'create_worktree', klass: 'whitelist', def: false },
  // guard (11)
  { name: 'spawn_teammate', klass: 'guard', def: true },
  { name: 'send_message', klass: 'guard', def: true },
  { name: 'list_agents', klass: 'guard', def: true },
  { name: 'interrupt_agent', klass: 'guard', def: true },
  { name: 'team_task_create', klass: 'guard', def: true },
  { name: 'team_task_list', klass: 'guard', def: true },
  { name: 'team_task_get', klass: 'guard', def: true },
  { name: 'team_task_update', klass: 'guard', def: true },
  { name: 'wait_agent', klass: 'guard', def: false },
  { name: 'subagent', klass: 'guard', def: false },
  { name: 'list_subagent_models', klass: 'guard', def: false },
  // none (6) — rendered inoperative; no config effect
  { name: '/goal', klass: 'none', def: false },
  { name: '/plan', klass: 'none', def: false },
  { name: '/compact', klass: 'none', def: false },
  { name: 'plugin_manager', klass: 'none', def: false },
  { name: 'plugin_market', klass: 'none', def: false },
  { name: 'structured_output', klass: 'none', def: false },
])

/**
 * Row config. `tools` is the per-tool toggle map the settings page writes; it is
 * volatile, so a toggle edit commits into the running fiber without a remount
 * and is read by Leads constrained afterwards (never by ones already running).
 *
 * The legacy keys carry NO default and are unions with `undefined`, because
 * `z.array(z.string())` on its own normalizes an absent key to `[]` — which
 * would erase the "not configured" signal the legacy precedence rule needs.
 * They are ALSO volatile: the settings projection carries only volatile fields,
 * so without that the page could not show its "legacy override is set" notice.
 * A volatile field is wrapped, so `volatileValue()` unwraps it and `.get()` is
 * what still distinguishes absent (`undefined`) from an explicit `[]`.
 *
 * `schemaLibrary` is the Host's own copy (see `resolveSchemaLibrary`). When no
 * anchor resolves it, `Config` is undefined and only the page is lost: the
 * loader skips validation and `apply()` reads the catalog defaults.
 */
const z = schemaLibrary

export const Config = z === undefined ? undefined : z.object({
  preset: z.string(),
  leadTools: z.union([z.array(z.string()), z.const(undefined)]).volatile(),
  denyTools: z.union([z.array(z.string()), z.const(undefined)]).volatile(),
  tools: z.dict(z.boolean()).default({}).volatile(),
})

/** Section name and placement: after `TEAM_POLICY` (600), before `PTC_ONLY` (800). */
const SECTION_NAME = 'lead-agent-only-leads:contract'
const SECTION_ORDER = 650

/** Denial text per denied tool; the model reads this instead of a result. */
const DENIALS = Object.freeze({
  wait_agent: 'wait_agent is disabled for a non-blocking Lead: end your turn instead. A teammate report or the next user message starts a new turn; use send_message to steer or wake a teammate.',
  subagent: 'subagent is disabled for a non-blocking Lead: hand the work to a teammate with spawn_teammate instead, and use send_message to steer it.',
  list_subagent_models: 'list_subagent_models is disabled for a non-blocking Lead: it only describes routes for the delegation tools this preset refuses. Use spawn_teammate to start a teammate.',
})

/**
 * Bounded attempts at a restriction whose candidate names are pruned from the
 * registry's own rejection. One attempt suffices unless the caller configured a
 * name the scope cannot restrict.
 */
const RESTRICT_ATTEMPTS = 8

/** Plugin name reported to the Host loader. */
export const name = 'lead-agent-only-leads'

/** Services this plugin needs mounted before it can shrink a Lead. */
export const inject = ['agents', 'tools', 'systemPrompt']

/**
 * Join already-formatted names the way the contract reads them: `A`, `A and B`,
 * or `A, B, and C`. Empty input yields an empty string, so a caller can omit the
 * whole clause instead of printing a dangling list.
 * @param {readonly string[]} names - the formatted names, in display order.
 * @returns {string} the joined list, or `''` for no names.
 */
function joinQuoted(names) {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/**
 * Prompt text that turns the generic Agent Teams policy into this preset's
 * contract. It states behaviour, not mechanism, and says each fact once.
 *
 * The text follows the policy `constrain()` actually resolved, so the Lead is
 * never told it cannot do something its own scope still allows:
 *
 * - `deny` is the resolved deny list. The refusal sentence names exactly those
 *   tools (0/1/many grammar) and disappears when the list is empty. The
 *   follow-on clause mentions waiting only while `wait_agent` is denied and
 *   one-shot delegation only while `subagent` is.
 * - `shellHidden` / `writersHidden` / `readersHidden` gate the "cannot run shell
 *   commands", "cannot write or edit files", and "cannot read files, search the
 *   workspace, or view images" claims on whether `bash`/`pwsh`, `write`/`edit`,
 *   and `read`/`read_image`/`glob`/`grep` are actually off the Lead's resolved
 *   allow list.
 *
 * The text never mentions plan mode: `exit_plan_mode` stays an enabled catalog
 * tool (making a plan is allowed), but this contract neither advertises nor
 * encourages it.
 *
 * The closing sentence of the claim paragraph names the Lead's ACTUAL tools,
 * derived from the resolved allow list rather than hardcoded, so the text cannot
 * go stale when the catalog changes. The Team tools stay a generic trailing
 * phrase: they are the Lead's own-scope coordination surface, already governed by
 * the refusal clause, not preset tools to enumerate.
 *
 * Every argument falls back to the catalog default, so a call with NO arguments
 * returns the frozen catalog-default text byte for byte, and a fact the caller
 * cannot supply never fails a boot.
 * @param {object} [options] - the resolved policy.
 * @param {readonly string[]} [options.deny] - denied tools; defaults to the catalog guard defaults.
 * @param {boolean} [options.shellHidden] - whether `bash`/`pwsh` are hidden; defaults true.
 * @param {boolean} [options.writersHidden] - whether `write`/`edit` are hidden; defaults true.
 * @param {boolean} [options.readersHidden] - whether `read`/`read_image`/`glob`/`grep` are hidden; defaults true.
 * @param {readonly string[]} [options.tools] - the resolved allow list, named as the Lead's own tools; defaults to the catalog ON list.
 * @returns {string} the section text.
 */
export function leadContract(options = {}) {
  // An unknown fact (a non-array `deny`) falls back to the catalog defaults
  // rather than guessing, which is also the pre-options text.
  const deny = Array.isArray(options?.deny)
    ? [...new Set(options.deny.filter(entry => typeof entry === 'string' && entry.length > 0))]
    : DEFAULT_DENIED_TOOLS
  // The resolved allow list named as the Lead's own tools. An absent or
  // unreadable one falls back to the catalog ON list, the same conservative
  // stance the boolean flags take.
  const tools = Array.isArray(options?.tools)
    ? [...new Set(options.tools.filter(entry => typeof entry === 'string' && entry.length > 0))]
    : DEFAULT_LEAD_TOOLS
  // Only an explicit `false` drops a claim: an unknown flag keeps today's text.
  const shellHidden = options?.shellHidden !== false
  const writersHidden = options?.writersHidden !== false
  const readersHidden = options?.readersHidden !== false

  const quoted = deny.map(entry => `\`${entry}\``)
  const refused = quoted.length === 0 ? '' : `${joinQuoted(quoted)} ${quoted.length === 1 ? 'is' : 'are'} refused`
  const followOn = [
    deny.includes('wait_agent') ? 'waiting' : undefined,
    deny.includes('subagent') ? 'one-shot delegation' : undefined,
  ].filter(Boolean)
  const refusal = refused === '' || followOn.length === 0
    ? refused
    : `${refused} — do not count on ${followOn.join(' or on ')}`

  const claims = []
  if (shellHidden) claims.push('You cannot run shell commands')
  if (writersHidden) claims.push('you cannot write or edit files')
  if (readersHidden) claims.push('you cannot read files, search the workspace, or view images')
  if (refusal !== '') claims.push(refusal)
  const joined = claims.length <= 1
    ? claims.join('')
    : `${claims.slice(0, -1).join(', ')}${claims.length > 2 ? ',' : ''} and ${claims[claims.length - 1]}`
  const restriction = joined === '' ? '' : ` ${joined[0].toUpperCase()}${joined.slice(1)}.`

  // Name the Lead's actual tools, derived from the resolved allow list, so the
  // text cannot go stale when the catalog changes. An empty list must not leave
  // a dangling "are , plus".
  const toolList = joinQuoted(tools.map(entry => `\`${entry}\``))
  const ownTools = toolList === ''
    ? "You keep none of the preset's tools, plus the Team tools; everything else the preset mounts is off your list."
    : `Your own tools are ${toolList}, plus the Team tools; everything else the preset mounts is off your list.`

  return `Non-blocking Lead

You are a non-blocking Team Lead.${restriction} ${ownTools} This supersedes the Agent Teams instruction to wait for teammates before answering.

Hand every part of the job out, and answer the user as soon as it is out.
- Give each teammate a brief that states the goal, the exact files it may write, and how it must verify the result. To know those files or checks, you may create a reconnaissance task: deploy one teammate on a read-only task — recorded on the shared board like any other task — that states the question and asks for the facts (where the code lives, which files a change touches, how the result should be verified). End your turn; the report arrives as your next turn, and you split and brief the real work from it.
- Record ownership and dependencies on the shared task board (team_task_*), and use list_agents to see who is running.
- Use send_message to steer a teammate or to wake an inactive one; a teammate report arrives as a new turn, and the next user message can arrive at any time.
- Teammates do the reading, searching, and writing; you brief and coordinate. Use ask_user_question when the decision is the user's to make.
- Assemble the final answer from teammate reports. When a report you need is missing, send_message that teammate and end your turn.`
}

/**
 * Normalize a configured or defaulted name list.
 * @param {unknown} value - the configured value, honoured only when it is an array.
 * @param {readonly string[]} fallback - names used when `value` is absent.
 * @returns {string[]} unique, non-empty names in first-seen order.
 */
export function nameList(value, fallback) {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.filter(entry => typeof entry === 'string' && entry.length > 0))]
}

/**
 * Keep only the configured names this scope can actually restrict.
 *
 * A name the scope does not know makes `tools.restrict()` throw, and a name the
 * scope registers itself (the Agent Teams tools) is not restrictable at all, so
 * both are dropped here. Names that are absent are absent for a reason the Lead
 * does not need: a tool it never had needs no rule.
 * @param {readonly string[]} configured - requested tools for the Lead.
 * @param {Iterable<string>} available - tool names visible in the Lead's scope.
 * @returns {string[]} the configured names that exist in that scope.
 */
export function selectLeadTools(configured, available) {
  const known = new Set(available)
  return configured.filter(entry => known.has(entry))
}

/**
 * The catalog defaults, derived from the same array the page mirrors.
 * @returns {{keep: string[], deny: string[]}} default keep and deny lists.
 */
export function catalogDefaults() {
  return {
    keep: LEAD_TOOL_CATALOG.filter(entry => entry.klass === 'whitelist' && entry.def).map(entry => entry.name),
    deny: LEAD_TOOL_CATALOG.filter(entry => entry.klass === 'guard' && !entry.def).map(entry => entry.name),
  }
}

/**
 * Read the live toggle map.
 *
 * `config.tools` is a schemastery volatile wrapper whose `.get()` returns the
 * value currently committed into the running fiber, so calling this at constrain
 * time sees a settings edit without the plugin having been remounted. A plain
 * object is accepted too, for direct callers and tests.
 * @param {object} [config] - the row config.
 * @returns {Record<string, boolean>} the sparse per-tool override map.
 */
export function toolToggleMap(config = {}) {
  const tools = config?.tools
  if (tools === undefined || tools === null) return {}
  if (typeof tools.get === 'function') return tools.get() ?? {}
  return typeof tools === 'object' ? tools : {}
}

/**
 * Read a possibly-volatile config field.
 *
 * `.volatile()` wraps its value, so a configured legacy array and an absent key
 * are both wrapper objects; only `.get()` tells them apart (`[]` versus
 * `undefined`). Plain values pass through, for direct callers and tests.
 * @param {unknown} value - the raw or wrapped config field.
 * @returns {unknown} the underlying value, or `undefined` when absent.
 */
export function volatileValue(value) {
  if (value === undefined || value === null) return undefined
  return typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * Resolve a config into the effective keep and deny lists.
 *
 * Catalog semantics: a `whitelist` tool is kept iff `tools[name] ?? def`, and a
 * `guard` tool is denied iff `tools[name] ?? def` is OFF. `none` entries never
 * contribute to either list.
 *
 * Precedence: an explicitly configured legacy `leadTools`/`denyTools` array wins
 * WHOLESALE for its own list (backward compatibility). Absence of the key — not
 * an empty array — is what selects the catalog, which is exactly why `Config`
 * declares those keys without defaults.
 * @param {object} [config] - the row config.
 * @returns {{keep: string[], deny: string[], keepConfigured: boolean, denyConfigured: boolean}}
 *   the effective lists and whether each came from the legacy key.
 */
export function resolveToolPolicy(config = {}) {
  const map = toolToggleMap(config)
  const legacyKeepValue = volatileValue(config.leadTools)
  const legacyDenyValue = volatileValue(config.denyTools)
  const legacyKeep = Array.isArray(legacyKeepValue) ? legacyKeepValue : undefined
  const legacyDeny = Array.isArray(legacyDenyValue) ? legacyDenyValue : undefined
  const on = entry => map[entry.name] ?? entry.def
  const catalogKeep = LEAD_TOOL_CATALOG
    .filter(entry => entry.klass === 'whitelist' && on(entry))
    .map(entry => entry.name)
  const catalogDeny = LEAD_TOOL_CATALOG
    .filter(entry => entry.klass === 'guard' && !on(entry))
    .map(entry => entry.name)
  return {
    keep: legacyKeep === undefined ? catalogKeep : nameList(legacyKeep, DEFAULT_LEAD_TOOLS),
    deny: legacyDeny === undefined ? catalogDeny : nameList(legacyDeny, DEFAULT_DENIED_TOOLS),
    keepConfigured: legacyKeep !== undefined,
    denyConfigured: legacyDeny !== undefined,
  }
}

/**
 * Parse the tool names a rejection message names, which is the registry's own
 * report of names it will not accept.
 * @param {unknown} error - the thrown rejection.
 * @returns {string[]} quoted names found in the message.
 */
export function rejectedNames(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return [...message.matchAll(/"([^"]+)"/g)].map(match => match[1])
}

/**
 * Restrict a scope, pruning names the registry rejects instead of leaving the
 * Lead unrestricted.
 * @param {object} tools - the Agent-scoped Tools service.
 * @param {object} agent - the Agent, used as the scope key.
 * @param {string[]} names - candidate allow list.
 * @returns {() => void} the restriction disposer.
 * @throws when every attempt is rejected, or when a rejection names nothing.
 */
export function restrictPruning(tools, agent, names) {
  let candidate = [...names]
  for (let attempt = 0; attempt < RESTRICT_ATTEMPTS; attempt += 1) {
    try {
      return tools.restrict({ allow: candidate })
    } catch (error) {
      const rejected = rejectedNames(error)
      const kept = candidate.filter(entry => !rejected.includes(entry))
      if (kept.length === candidate.length || kept.length === 0) throw error
      candidate = kept
    }
  }
  throw new Error(`tools.restrict() was rejected for every one of: ${names.join(', ')}`)
}

/**
 * Log a warning without assuming the context carries a logger.
 * @param {object} ctx - the plugin context.
 * @param {string} message - the warning.
 */
function warn(ctx, message) {
  const logger = ctx.get?.('logger') ?? ctx.logger
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message)
}

/**
 * Read the preset an Agent is composed under, preferring the live binding.
 * @param {object} agent - the Agent to inspect.
 * @param {object|undefined} presets - the Agent-preset registry, when mounted.
 * @returns {string|undefined} the bound preset id.
 */
function presetOf(agent, presets) {
  if (presets !== undefined && typeof presets.composedPreset === 'function') {
    const bound = presets.composedPreset(agent.ctx)
    if (bound !== undefined) return bound
  }
  return agent.session?.header?.agentPreset
}

/**
 * Decide whether an Agent is the Lead of this preset.
 *
 * Teammates inherit the Lead's preset, so the preset alone cannot tell them
 * apart; the Team roster can. When no Team service is mounted there is no roster
 * to ask and a root Session is the Lead by construction.
 * @param {object} agent - the Agent to classify.
 * @param {object|undefined} teams - the Agent Teams service, when mounted.
 * @returns {boolean} true only for a Lead that may be shrunk.
 */
export function isTeamLead(agent, teams) {
  if (teams === undefined || typeof teams.tryMembership !== 'function') {
    return agent.session?.header?.parentSession === undefined
  }
  try {
    return teams.tryMembership(agent)?.role === 'lead'
  } catch {
    // A membership probe that cannot answer must not shrink an Agent: a
    // teammate has to keep its ordinary tools.
    return false
  }
}

/**
 * Register the Lead's prompt contract, restriction, and denial guard for one
 * Agent, and return the disposers that undo exactly that.
 *
 * The keep and deny lists are resolved HERE, from the live config, not at mount:
 * `config.tools` is volatile, so a settings-page edit is committed into the
 * running config in place and has to be visible to every Lead constrained after
 * it without the plugin remounting. That is also why `apply()` captures neither
 * list.
 * @param {object} agent - the Lead.
 * @param {object} config - the row config, read live.
 * @param {object} ctx - the plugin context, for diagnostics.
 * @returns {Array<() => void>} disposers, in registration order.
 */
function constrain(agent, config, ctx) {
  const disposers = []
  const scopedTools = agent.ctx.tools
  const prompt = agent.ctx.systemPrompt
  const policy = resolveToolPolicy(config)
  // What the Lead can reach once the restriction below has run, or `undefined`
  // when the scope could not be read. The contract text is built from THIS, so
  // it never claims a tool is hidden that the Lead actually keeps; `undefined`
  // keeps the catalog wording rather than guessing.
  let reachable

  try {
    const available = scopedTools.schemas(agent).map(schema => schema.name)
    reachable = available
    const allow = selectLeadTools(policy.keep, available)
    const restrictToNothing = () => {
      // `restrict({ allow: [] })` is legal and hides the whole inherited surface
      // (the registry rejects only `{}`), which is the fail-closed outcome for
      // "the Lead may keep nothing".
      disposers.push(scopedTools.restrict({ allow: [] }))
      reachable = []
    }
    if (policy.keep.length === 0) {
      // Branch 1 — "keep nothing" by intent: every class-`whitelist` toggle is
      // off, or the legacy `leadTools` was configured as an empty array.
      // Skipping the restriction here is the fail-open that once left an all-off
      // Lead holding every tool, so restrict to nothing instead.
      restrictToNothing()
    } else if (allow.length === 0) {
      // Branch 2 — the keep list is non-empty but EVERY name in it is absent
      // from this scope, so nothing can be kept. What that means depends on who
      // authored the list:
      if (policy.keepConfigured) {
        // LEGACY explicit `leadTools`: the user named tools for a scope the
        // plugin did not choose, so the scope may simply not be what the config
        // describes. This is the ONE retained warn-and-keep path.
        warn(ctx, `${name}: no configured Lead tool exists in this scope; the Lead keeps its preset tools`)
      } else {
        // CATALOG toggles: the page authored this list against the tool
        // universe, so a list resolving to nothing means "keep nothing" — fail
        // CLOSED. Reached by turning every default off except a tool this scope
        // does not mount (e.g. `pwsh` on Linux); warning and leaving the Lead
        // unrestricted would hand it bash, write and edit again.
        const absent = policy.keep.filter(entry => !available.includes(entry))
        restrictToNothing()
        warn(ctx, `${name}: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not mounted in this scope; the Lead keeps none of its preset tools`)
      }
    } else if (allow.length < available.length) {
      // Branch 3 — at least one requested name is restrictable; a mixed
      // known+absent list lands here and restricts to the known names only.
      try {
        disposers.push(restrictPruning(scopedTools, agent, allow))
        reachable = allow
      } catch (error) {
        // Branch 4 — non-empty by user intent yet zero RESTRICTABLE names:
        // every requested tool is own-scope (the Team tools) or otherwise
        // unreachable by `restrict()`. Keep nothing rather than fail open.
        restrictToNothing()
        warn(ctx, `${name}: none of ${allow.length} configured tools for the Lead is restrictable; the Lead keeps none of its preset tools (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  } catch (error) {
    warn(ctx, `${name}: restricting the Lead failed, so it keeps its preset tools: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (policy.deny.length > 0) {
    const denied = policy.deny
    disposers.push(scopedTools.guard(execution => {
      if (!denied.includes(execution.name)) return undefined
      return DENIALS[execution.name]
        ?? `${execution.name} is disabled for a non-blocking Lead in this preset.`
    }))
  }

  // The contract has to describe the surface the Lead really has: `deny` is the
  // resolved deny list, the shell/write/reading claims and the named tool list
  // follow the resolved allow list (`reachable === undefined` = unreadable scope,
  // so keep the catalog text).
  const shellHidden = reachable === undefined
    ? true
    : !reachable.includes('bash') && !reachable.includes('pwsh')
  const writersHidden = reachable === undefined
    ? true
    : !reachable.includes('write') && !reachable.includes('edit')
  const readersHidden = reachable === undefined
    ? true
    : !reachable.includes('read') && !reachable.includes('read_image')
      && !reachable.includes('glob') && !reachable.includes('grep')

  try {
    disposers.push(prompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: leadContract({ deny: policy.deny, shellHidden, writersHidden, readersHidden, tools: reachable }),
    }))
  } catch (error) {
    warn(ctx, `${name}: the Lead contract section was not registered: ${error instanceof Error ? error.message : String(error)}`)
  }

  return disposers
}

/**
 * Apply the non-blocking Lead contract to every Lead of the configured preset.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [config] - row config.
 * @param {string} [config.preset] - presets that keep a non-blocking Lead, default `lead-agent-only-leads`.
 * @param {string[]} [config.leadTools] - legacy explicit keep list; wins wholesale over the catalog.
 * @param {string[]} [config.denyTools] - legacy explicit deny list; wins wholesale over the catalog.
 * @param {Record<string, boolean>} [config.tools] - volatile per-tool toggles; absent key = catalog default.
 */
export function apply(ctx, config = {}) {
  const presetId = typeof config.preset === 'string' && config.preset.length > 0 ? config.preset : PRESET_ID
  // The keep and deny lists are deliberately NOT captured here. `constrain()`
  // resolves them from this same `config` object at constrain time, so a
  // volatile `tools` edit (committed in place, without a remount) is picked up
  // by every Lead created afterwards.

  /** Agents already constrained, mapped to the disposers that undo it. */
  const constrained = new Map()

  const presets = ctx.get('agentPresets')
  const teams = ctx.get('agentTeams')

  // The bundle ships its own settings page, so suppress the auto-generated
  // generic config form for this same row; otherwise one namespace renders two
  // pages. This is a HOST call by construction: only the Host can register an
  // instance page policy (`settings.configure`, see the ui-settings precedent
  // packages/client/ui-settings/src/index.ts:23-24). Guarded, because a policy
  // conflict must not fail the boot.
  ctx.inject(['settings'], child => child.effect(() => {
    try {
      return child.settings.configure({ auto: false }, ctx.fiber)
    } catch (error) {
      warn(ctx, `${name}: the automatic settings page could not be suppressed: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }))

  /**
   * Undo this plugin's contribution for one Agent, leaving any other scope
   * registration alone.
   * @param {object} agent - the Agent to release.
   */
  const release = agent => {
    const disposers = constrained.get(agent)
    if (disposers === undefined) return
    constrained.delete(agent)
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        warn(ctx, `${name}: releasing a Lead failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Bring one Agent in line with its current preset and Team role. Idempotent:
   * the same Agent is constrained once, and a preset change releases it again.
   * @param {object} agent - the Agent to reconcile.
   */
  const reconcile = agent => {
    const wanted = presetOf(agent, presets) === presetId && isTeamLead(agent, teams)
    if (!wanted) {
      release(agent)
      return
    }
    if (constrained.has(agent)) return
    constrained.set(agent, constrain(agent, config, ctx))
  }

  ctx.effect(() => () => {
    for (const agent of [...constrained.keys()]) release(agent)
  }, `${name}: per-Agent restrictions`)

  for (const agent of ctx.agents.list()) reconcile(agent)
  ctx.on('agent/created', ({ agent }) => reconcile(agent))
  ctx.on('agent/disposed', ({ agent }) => release(agent))
  // A live but unused Session can be re-presetted (the Web composer reuses a
  // blank Session), so the preset bound at creation is not the last word.
  ctx.on('agent-preset/selected', sessionId => {
    const id = typeof sessionId === 'string' ? sessionId : sessionId?.id
    const agent = id === undefined ? undefined : ctx.agents.get(id)
    if (agent !== undefined) reconcile(agent)
  })
}
