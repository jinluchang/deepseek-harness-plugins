/**
 * Host half of `dsh-llm-api-call-tuning`: the global DEFAULT retry values
 * behind the per-provider model-request retry policy.
 *
 * DSH resolves one `retryPolicy` for every provider route it registers
 * (`packages/llm/llm/src/retry-policy.ts`): a retry mode (`normal` | `always`),
 * a bounded retry count, the failure codes eligible for a retry, and a bounded
 * exponential backoff with symmetric jitter. Those values belong to the
 * provider rows (`llm-deepseek` and `llm-deepseek-account` under
 * `retryPolicy`, `llm-pi-ai` under `providers.<id>.retryPolicy`); there is no
 * global settings namespace for them in DSH itself.
 *
 * This plugin adds the missing page. The client half edits a provider row
 * DIRECTLY through the settings form API (`configForms.get(ns).mutate(ops,
 * rev)`), so no value is ever projected out of this module. The host half
 * therefore owns only a small set of GLOBAL DEFAULT values in this row's own
 * `Config` — the preset the page can copy into any active provider — and is
 * otherwise inert: `apply()` only suppresses the auto-generated settings page
 * for this namespace, exactly like the ui-settings precedent
 * (`packages/client/ui-settings/src/index.ts:23-24`), so the hand-written page
 * is the only page for this row.
 *
 * Every `Config` leaf is `.volatile()` because that is what makes a settings
 * edit commit into the running fiber without a remount
 * (`vendor/loader/src/config/entry.ts` `_commitVolatile`, and
 * `vendor/loader/src/config/diff.ts` `equalExceptVolatile`). A volatile leaf
 * also keeps the defaults editable while the Host runs, which is the whole
 * point of a preset.
 *
 * `Config` bounds mirror the upstream schema and load-time asserts
 * (`retry-policy.ts:81-91` and `:127-138`):
 *
 * - `mode`: `'normal'` | `'always'`, default `'normal'` (resolved default of an
 *   omitted policy, `retry-policy.ts:151-158`);
 * - `maxRetries`: integer `0..Number.MAX_SAFE_INTEGER`, default `5`
 *   (`retry-policy.ts:89,14`);
 * - `initialDelayMs` / `maxDelayMs`: finite and positive, at most
 *   `MAX_TIMER_DELAY_MS` = `2147483647`, defaults `500` / `10000`
 *   (`retry-policy.ts:82-83,15-16,127-132`);
 * - `jitterRatio`: `0..1`, default `0.1` (`retry-policy.ts:84,17`);
 * - `retryableCodes`: non-empty array drawn from the five upstream codes,
 *   defaulting to all five (`retry-policy.ts:90,18-22,170-177`).
 *
 * One upstream rule cannot be expressed in a schema: `initialDelayMs` must not
 * exceed `maxDelayMs` (`retry-policy.ts:133-135`). It is enforced by
 * `validateTune()`, which the settings page uses before every write and which
 * `verify.mjs` exercises directly.
 *
 * The module has no default export: the loader reads `name`, `Config`, and
 * `apply` as named bindings.
 *
 * @module dsh-llm-api-call-tuning
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
 *   `meta`/`type`/`dict` (`vendor/loader/src/config/diff.ts`
 *   `equalExceptVolatile`); any other value compares the whole raw config, so a
 *   commit would remount the plugin instead of just re-running a pass;
 * - the settings service needs `toJSON()` plus `meta`/`type`/`dict` on the
 *   schema (`packages/settings/settings/src/index.ts` `schema()`/`describe()`);
 * - the no-remount commit walks cosmokit `Volatile` references that the schema
 *   validator produced, in the running config (`vendor/loader/src/config/entry.ts`
 *   `_commitVolatile`).
 *
 * The bundle ships no `node_modules`, and the Host that loads it always has the
 * library in its own resolution graph, so resolve from the Host — offline, and
 * stable across restarts:
 *
 * 1. this module's own location, for an install that did fetch dependencies;
 * 2. the running process entry (`process.argv[1]`), which is inside the harness;
 * 3. `$DSH_HARNESS_CHECKOUT` (the offline suites) through the pnpm workspace's
 *    hoisted store.
 *
 * @returns {object|undefined} the library, or `undefined` when no anchor
 *   resolves it. `Config` is then undefined: the loader skips validation and
 *   the page cannot render, but `apply()` still suppresses the auto page and
 *   the exports stay importable.
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

/** The resolved library, or `undefined`: `Config` is then absent by design. */
const z = schemaLibrary

/**
 * Largest delay `setTimeout` accepts, matching `@deepseek-ai/dsh-timeout`
 * `MAX_TIMER_DELAY_MS` (`packages/util/timeout/src/index.ts:25`) and the
 * upstream retry-policy schema (`retry-policy.ts:82-83`).
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Retry modes DSH accepts (`retry-policy.ts:53-73`). */
export const RETRY_MODES = Object.freeze(['normal', 'always'])

/**
 * The failure codes the upstream retry policy ships with
 * (`retry-policy.ts:18-22`). `EMPTY_RESPONSE` is `EMPTY_RESPONSE_CODE` in
 * `packages/llm/llm/src/error.ts`; the other four are literal strings.
 */
export const RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** Fast membership test for the code allowlist. */
const RETRYABLE_CODE_SET = new Set(RETRYABLE_CODES)

/**
 * The complete global-default surface this plugin owns, declared ONCE. The
 * schema, `DEFAULT_TUNE`, `TUNE_KEYS`, `TUNE_OPTIONS`, `validateTune()` and the
 * docs all read this table, so a code default or an allowed range cannot drift
 * between them.
 *
 * `build(lib)` returns the exact schemastery field, `.volatile()` included.
 * `default` is the upstream retry-policy code default recorded by
 * `retry-policy.ts:14-22`; `range` is the upstream schema bound plus the
 * load-time assertion when the two differ.
 *
 * The delay fields use `.min(Number.MIN_VALUE)` — the smallest positive double
 * — because schemastery has no exclusive minimum and upstream rejects `0` and
 * negatives (`retry-policy.ts:127-132`): `0 < Number.MIN_VALUE`, so `0` and
 * every negative value are refused while any positive configured delay passes.
 * `retryableCodes` uses a union of consts for the allowlist and `.min(1)` for
 * "must not be empty"; duplicates are not expressible in the schema and are
 * left to `validateTune()` (`retry-policy.ts:176-178`).
 */
const TUNE_FIELDS = Object.freeze([
  {
    key: 'mode',
    kind: 'mode',
    default: 'normal',
    defaultText: "'normal'",
    range: "'normal' or 'always'",
    build: lib => lib.union([lib.const('normal'), lib.const('always')]).default('normal').volatile(),
  },
  {
    key: 'maxRetries',
    kind: 'nonNegativeInteger',
    default: 5,
    defaultText: '5',
    range: 'integer 0..9007199254740991',
    build: lib => lib.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(5).volatile(),
  },
  {
    key: 'initialDelayMs',
    kind: 'positiveFiniteMs',
    default: 500,
    defaultText: '500',
    range: 'finite and > 0, at most 2147483647; must not exceed maxDelayMs',
    build: lib => lib.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(500).volatile(),
  },
  {
    key: 'maxDelayMs',
    kind: 'positiveFiniteMs',
    default: 10_000,
    defaultText: '10000',
    range: 'finite and > 0, at most 2147483647; must not be below initialDelayMs',
    build: lib => lib.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(10_000).volatile(),
  },
  {
    key: 'jitterRatio',
    kind: 'ratio',
    default: 0.1,
    defaultText: '0.1',
    range: 'number in [0, 1]',
    build: lib => lib.number().min(0).max(1).default(0.1).volatile(),
  },
  {
    key: 'retryableCodes',
    kind: 'retryableCodes',
    default: RETRYABLE_CODES,
    defaultText: "'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'",
    range: 'non-empty array of unique codes from the five upstream codes',
    build: lib => lib.array(lib.union(RETRYABLE_CODES.map(code => lib.const(code))))
      .min(1)
      .default([...RETRYABLE_CODES])
      .volatile(),
  },
])

/** The six owned keys, in the order the settings page and `DEFAULT_TUNE` use. */
export const TUNE_KEYS = Object.freeze(TUNE_FIELDS.map(field => field.key))

/**
 * Public field metadata: key, kind, code default, its default text, and the
 * allowed range. This is the single source the client dictionary, README and
 * CONTRACT tables are checked against.
 */
export const TUNE_OPTIONS = Object.freeze(TUNE_FIELDS.map(field => Object.freeze({
  key: field.key,
  kind: field.kind,
  default: field.default,
  defaultText: field.defaultText,
  range: field.range,
})))

/**
 * Upstream retry-policy code defaults (`retry-policy.ts:14-22`), also the
 * values an unconfigured provider route resolves to (`:151-158`). Frozen, and
 * `retryableCodes` is a frozen copy, so a consumer cannot mutate the preset
 * through this object.
 */
export const DEFAULT_TUNE = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
  retryableCodes: Object.freeze([...RETRYABLE_CODES]),
})

/**
 * The schema the settings page validates against.
 *
 * One field per owned value, every leaf `.volatile()`: a settings edit commits
 * into the running fiber without a remount. The root is a plain object because
 * `volatileForm()` only descends object roots
 * (`packages/settings/settings/src/schema.ts:37-47`); a transform/refine/union
 * on the ROOT would cost the whole settings section, which is why the only
 * union here is a leaf allowlist.
 */
export const Config = z === undefined ? undefined : z.object(Object.fromEntries(
  TUNE_FIELDS.map(field => [field.key, field.build(z)]),
))

/** Plugin name reported to the Host loader; also the settings and locale namespace. */
export const name = 'llm-api-call-tuning'

/**
 * Stable problem codes `validateTune()` returns. They name the failing field,
 * except `delayOrder`, which names the cross-field rule.
 */
export const TUNE_PROBLEMS = Object.freeze({
  mode: 'mode',
  maxRetries: 'maxRetries',
  initialDelayMs: 'initialDelayMs',
  maxDelayMs: 'maxDelayMs',
  delayOrder: 'delayOrder',
  jitterRatio: 'jitterRatio',
  retryableCodes: 'retryableCodes',
})

/**
 * Validate one complete (or partial) global-default tune.
 *
 * This is the cross-field half of the contract the schema cannot express. The
 * rules are exactly the upstream load-time asserts
 * (`retry-policy.ts:127-138,167-178`): a mode of `'normal'` or `'always'`, a
 * non-negative safe-integer `maxRetries`, two finite positive delays no larger
 * than `2147483647` with `initialDelayMs <= maxDelayMs`, a `jitterRatio` within
 * `[0, 1]`, and a non-empty, duplicate-free `retryableCodes` array drawn from
 * `RETRYABLE_CODES`.
 *
 * Fields that are `undefined` fall back to `DEFAULT_TUNE`, so a page draft that
 * omits an untouched field still validates. The function never throws: it
 * returns a frozen array of problem codes (`TUNE_PROBLEMS` values), empty when
 * the tune is safe to write. The client half cannot import this module, so it
 * duplicates these rules; CONTRACT.md documents them as the shared contract.
 *
 * @param {object} [values] - a partial or complete tune.
 * @returns {readonly string[]} the problem codes, empty when valid.
 */
export function validateTune(values = {}) {
  const source = values ?? {}
  /** One tune value, falling back to its documented default. */
  const value = key => {
    const configured = source[key]
    return configured === undefined ? DEFAULT_TUNE[key] : configured
  }
  const mode = value('mode')
  const maxRetries = value('maxRetries')
  const initialDelayMs = value('initialDelayMs')
  const maxDelayMs = value('maxDelayMs')
  const jitterRatio = value('jitterRatio')
  const retryableCodes = value('retryableCodes')

  /** Whether a value is a delay the upstream resolver would accept. */
  const isTimerDelay = candidate => typeof candidate === 'number'
    && Number.isFinite(candidate)
    && candidate > 0
    && candidate <= MAX_TIMER_DELAY_MS
  /** Whether a value is a ratio the upstream resolver would accept. */
  const isRatio = candidate => typeof candidate === 'number'
    && Number.isFinite(candidate)
    && candidate >= 0
    && candidate <= 1
  /** Whether a value is a code list the upstream resolver would accept. */
  const isRetryableCodes = candidate => Array.isArray(candidate)
    && candidate.length > 0
    && candidate.every(code => typeof code === 'string' && RETRYABLE_CODE_SET.has(code))
    && new Set(candidate).size === candidate.length

  const problems = []
  if (mode !== 'normal' && mode !== 'always') problems.push(TUNE_PROBLEMS.mode)
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) problems.push(TUNE_PROBLEMS.maxRetries)
  if (!isTimerDelay(initialDelayMs)) problems.push(TUNE_PROBLEMS.initialDelayMs)
  if (!isTimerDelay(maxDelayMs)) problems.push(TUNE_PROBLEMS.maxDelayMs)
  if (isTimerDelay(initialDelayMs) && isTimerDelay(maxDelayMs) && initialDelayMs > maxDelayMs) {
    problems.push(TUNE_PROBLEMS.delayOrder)
  }
  if (!isRatio(jitterRatio)) problems.push(TUNE_PROBLEMS.jitterRatio)
  if (!isRetryableCodes(retryableCodes)) problems.push(TUNE_PROBLEMS.retryableCodes)
  return Object.freeze(problems)
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
 * Message of a thrown value without assuming it is an `Error`.
 * @param {unknown} error - the thrown value.
 * @returns {string} its message or its string form.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Apply the host half.
 *
 * The bundle ships its own settings page, so suppress the auto-generated
 * generic config form for this same row; otherwise one namespace renders two
 * pages. This is a HOST call by construction: only the Host can register an
 * instance page policy (`settings.configure`, see the ui-settings precedent
 * `packages/client/ui-settings/src/index.ts:23-24`). Guarded, because a policy
 * conflict must not fail the boot.
 *
 * Nothing else runs here: the page edits provider rows through the settings
 * form API, and the host half stores no projection state.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.inject(['settings'], child => child.effect(() => {
    try {
      return child.settings.configure({ auto: false }, ctx.fiber)
    } catch (error) {
      warn(ctx, `${name}: the automatic settings page could not be suppressed: ${errorMessage(error)}`)
      return () => {}
    }
  }))
}
