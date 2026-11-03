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
 * `Config` — the preset the page can copy into any active provider — plus the
 * two process-wide fetch timeouts described below. `apply()` otherwise just
 * suppresses the auto-generated settings page for this namespace, exactly like
 * the ui-settings precedent
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
 * - `retryableCodes`: non-empty array drawn from the codes this plugin OFFERS
 *   (the five upstream codes plus five opt-in extras, see
 *   `OFFERED_RETRYABLE_CODES`), defaulting to exactly the five upstream codes
 *   (`retry-policy.ts:90,18-22,170-177`). Upstream accepts any string here
 *   (`z.array(z.string())`) and matches exact strings at retry time, so the
 *   narrowing is this plugin's own; offering more codes cannot change the
 *   default policy, because the extras are opt-in checkboxes that only an
 *   explicit user tick can add.
 *
 * One upstream rule cannot be expressed in a schema: `initialDelayMs` must not
 * exceed `maxDelayMs` (`retry-policy.ts:133-135`). It is enforced by
 * `validateTune()`, which the settings page uses before every write and which
 * `verify.mjs` exercises directly.
 *
 * The host half has a second, independent job: the two process-wide HTTP
 * timeouts that upstream `dsh-fetch-timeouts` exposes, `headersTimeoutMs` and
 * `bodyTimeoutMs` (see `FETCH_FIELDS`). Both are UNSET by default, and an unset
 * field leaves the Host exactly as it is: no dispatcher, no listener side
 * effect on requests. Only once at least one value is a number does `apply()`
 * wrap the CURRENT dispatcher (DSH installs a proxy-aware global one before
 * plugins mount, `packages/util/http-proxy/src/install.ts`) instead of
 * replacing it, fill `headersTimeout`/`bodyTimeout` on requests that do not set
 * their own, and restore the previous dispatcher when the last value is cleared
 * or the plugin is disposed — and only when ours is still current. That
 * mechanism is adapted from `dsh-fetch-timeouts` (MIT, © 2026 Dev Mehra); see
 * THIRD-PARTY-NOTICES.md.
 *
 * A third, independent job is the manual same-turn retry: a non-retryable model
 * failure can be parked while the settings page asks the user whether to retry
 * it. It is purely additive — the `agent/request-error` listener awaits the
 * downstream recovery chain FIRST, so an automatic retry always wins and a
 * prompt is never shown for a failure the policy already handles. It is also
 * fully optional at runtime: without a page polling the decision route, no
 * turn is ever parked (see {@link createRetryDesk} and {@link registerRetryChannel}).
 *
 * None of it adds a dependency: the bundle ships no `node_modules`. undici is
 * resolved from the running Host (the profile the Host boots from, then the
 * same anchors as the schema library), so a deployed profile works without any
 * install step. Both halves degrade to a warning instead of failing the boot.
 *
 * Finally, the module publishes frozen METADATA for the three per-route
 * provider timeouts the page also tunes (`PROVIDER_TIMEOUT_FIELDS`,
 * `PROVIDER_TIMEOUT_KEYS`, `PROVIDER_TIMEOUT_OPTIONS`). Those values live in
 * the provider namespaces (`llm-pi-ai`, `llm-deepseek`,
 * `llm-deepseek-account`), not in this plugin: the page writes them straight
 * through each namespace's own form, so there is no `Config` field, no
 * `apply()` step, and no runtime behavior here — only the pinned contract the
 * page, the docs and `verify.mjs` read.
 *
 * The module has no default export: the loader reads `name`, `Config`, and
 * `apply` as named bindings.
 *
 * @module dsh-llm-api-call-tuning
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolution anchors for a package the Host provides, in priority order:
 *
 * 1. this module's own location, for an install that did fetch dependencies;
 * 2. the running process entry (`process.argv[1]`), which is inside the harness;
 * 3. `$DSH_HARNESS_CHECKOUT` (the offline suites) through the pnpm workspace's
 *    hoisted store.
 *
 * Shared by the schema library and undici so both resolve from the same places.
 * @returns {string[]} candidate `createRequire` anchors, possibly empty entries.
 */
function hostAnchors() {
  const anchors = [import.meta.url, process.argv[1]]
  const checkout = process.env.DSH_HARNESS_CHECKOUT
  if (typeof checkout === 'string' && checkout.length > 0) {
    anchors.push(join(checkout, 'node_modules', '.pnpm', 'node_modules', '__dsh_plugin_anchor__.js'))
  }
  return anchors
}

/**
 * Resolution anchors the RUNNING Host offers, ahead of the module anchors.
 *
 * `ctx.baseUrl` is the Host's own base URL: the boot path sets it to the
 * profile directory (`packages/boot/app-boot/src/index.ts:1223`), and every
 * plugin context inherits it. That directory is where the Host actually
 * resolves its plugins from, so `<profile>/node_modules` holds the packages a
 * real deployment uses (including `undici`), which `createRequire` reaches by
 * walking up from it. Without this anchor, a deployed profile can resolve the
 * schema library (a direct dependency of the CLI) but not `undici` (a
 * dependency of bundles and packages, not of the CLI entry the plugin would
 * otherwise anchor on).
 * @param {object} ctx - the plugin context.
 * @returns {string[]} candidate anchors derived from the Host context.
 */
function hostContextAnchors(ctx) {
  const anchors = []
  const baseUrl = ctx?.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return anchors
  try {
    anchors.push(fileURLToPath(new URL('node_modules/__dsh_plugin_anchor__.js', baseUrl)))
  } catch {
    // A non-file base URL cannot anchor a filesystem resolution; skip it.
  }
  return anchors
}

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
 * stable across restarts.
 *
 * @returns {object|undefined} the library, or `undefined` when no anchor
 *   resolves it. `Config` is then undefined: the loader skips validation and
 *   the page cannot render, but `apply()` still suppresses the auto page and
 *   the exports stay importable.
 */
function resolveSchemaLibrary() {
  for (const anchor of hostAnchors()) {
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

/** Cached result of {@link resolveUndici}: `undefined` until the first attempt. */
let undiciLibrary
/** Whether {@link resolveUndici} already ran, so a failed load is not retried. */
let undiciResolved = false

/**
 * Resolve `undici` from the Host, without a bundle-local `node_modules`.
 *
 * The dispatcher API this half needs (`getGlobalDispatcher`,
 * `setGlobalDispatcher`, `EnvHttpProxyAgent`) is the Host's own, not a private
 * copy: requiring a second instance is fine (undici shares one global
 * dispatcher through `Symbol.for('undici.globalDispatcher.2')`), but resolving
 * through the Host is what keeps the module dependency-free and lets the
 * wrapper collaborate with the dispatcher DSH's `http-proxy` installed.
 *
 * The lazy cache means a failed load is not retried on every event, and the
 * import stays cheap for the settings-only use of this module.
 * @param {string[]} [extraAnchors] - Host-context anchors tried first, from
 *   {@link hostContextAnchors}.
 * @returns {object|undefined} undici, or `undefined` when no anchor resolves a
 *   module with the dispatcher surface.
 */
function resolveUndici(extraAnchors = []) {
  if (undiciResolved) return undiciLibrary
  undiciResolved = true
  for (const anchor of [...extraAnchors, ...hostAnchors()]) {
    if (typeof anchor !== 'string' || anchor.length === 0) continue
    try {
      const loaded = createRequire(anchor)('undici')
      if (typeof loaded?.getGlobalDispatcher === 'function'
        && typeof loaded?.setGlobalDispatcher === 'function'
        && typeof loaded?.EnvHttpProxyAgent === 'function') {
        undiciLibrary = loaded
        return undiciLibrary
      }
    } catch {
      // The next anchor may be the one inside the Host installation.
    }
  }
  return undefined
}

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
 * (`retry-policy.ts:18-22`), and this plugin's global DEFAULT code list.
 * `EMPTY_RESPONSE` is `EMPTY_RESPONSE_CODE` in
 * `packages/llm/llm/src/error.ts`; the other four are literal strings.
 *
 * Upstream does NOT restrict the array to these five: its schema is
 * `z.array(z.string())` (`retry-policy.ts:90`) and the executor matches exact
 * code strings (`packages/llm/llm-retry/src/index.ts:212`). The narrowing lives
 * only in this plugin, so it can widen what the page offers without changing
 * what an unconfigured policy resolves to.
 */
export const RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * The codes the settings page OFFERS, in checkbox order: the five upstream
 * defaults, then five opt-in extras.
 *
 * `STREAM_CLOSED` / `MALFORMED_RESPONSE` / `PI_AI_ERROR` are the llm-pi-ai
 * failure codes (`packages/llm/llm-pi-ai/src/stream.ts:67`,
 * `packages/llm/llm-pi-ai/src/stream.ts:40-41`); `HTTP_408` / `HTTP_409` are
 * the status-shaped codes the DeepSeek transport produces
 * (`packages/llm/llm-deepseek/src/transport.ts:35`).
 *
 * OPT-IN ONLY: every default, every fallback and every unset leaf still
 * resolves to `RETRYABLE_CODES`, so a fresh install and every existing stored
 * config keep the exact five-code policy. An extra code is written only when a
 * user ticks it.
 */
export const OFFERED_RETRYABLE_CODES = Object.freeze([
  ...RETRYABLE_CODES,
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
  'PI_AI_ERROR',
  'HTTP_408',
  'HTTP_409',
])

/** Fast membership test for every code the page offers (validation only). */
const OFFERED_RETRYABLE_CODE_SET = new Set(OFFERED_RETRYABLE_CODES)

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
    range: 'non-empty array of unique codes from the ten offered codes; defaults to the five upstream codes',
    build: lib => lib.array(lib.union(OFFERED_RETRYABLE_CODES.map(code => lib.const(code))))
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
 * The two process-wide HTTP timeouts this plugin also owns, declared ONCE.
 *
 * `null` means UNSET, and unset is the shipped default: a fresh install must
 * not change how the Host or Node already behaves. The wrapper is installed
 * only while at least one of the two values is a number; `0` is a real value
 * (undici treats a zero `headersTimeout`/`bodyTimeout` as "no timeout"), and
 * any positive integer up to `MAX_TIMER_DELAY_MS` is a custom timeout in
 * milliseconds. Clearing a field back to unset stops filling that one option;
 * clearing both restores the dispatcher the Host had.
 *
 * This single object is the one place the defaults live: `FETCH_FIELDS` derives
 * the schema and the `defaultText`/range shown to the page from it, so they
 * cannot drift. Flip both to a number here to ship a non-inert preset (for
 * example `1_800_000`, 30 minutes).
 */
export const DEFAULT_FETCH = Object.freeze({
  headersTimeoutMs: null,
  bodyTimeoutMs: null,
})

/**
 * The two process-wide fetch timeouts, declared ONCE beside `TUNE_FIELDS` and
 * kept separate from it: `TUNE_KEYS`, `TUNE_OPTIONS`, `DEFAULT_TUNE` and
 * `validateTune()` are the retry-policy surface, pinned by verify.mjs and
 * documented as such.
 *
 * `build(lib)` returns the exact schemastery field, `.volatile()` included, so
 * a settings edit commits into the running fiber without a remount.
 * `.step(1)` refuses a fractional timeout, `.min(0)` allows the documented
 * "disabled" value, and `.max(MAX_TIMER_DELAY_MS)` mirrors what
 * `setTimeout` / undici can carry.
 *
 * There is deliberately NO `.default(...)`: schemastery materializes an absent
 * number leaf as `undefined` (a `.default(null)` would put a null default in
 * the schema while still resolving to `undefined`), so the schema's own code
 * default is "absent", i.e. unset. `DEFAULT_FETCH` records that as `null` for
 * the runtime side, and both `undefined` and `null` mean unset there.
 */
const FETCH_FIELDS = Object.freeze([
  {
    key: 'headersTimeoutMs',
    kind: 'optionalNonNegativeIntegerMs',
    default: DEFAULT_FETCH.headersTimeoutMs,
    defaultText: 'unset',
    range: 'integer 0..2147483647, or unset; 0 disables the header timeout, unset leaves the Host default untouched',
    build: lib => lib.number()
      .step(1)
      .min(0)
      .max(MAX_TIMER_DELAY_MS)
      .volatile(),
  },
  {
    key: 'bodyTimeoutMs',
    kind: 'optionalNonNegativeIntegerMs',
    default: DEFAULT_FETCH.bodyTimeoutMs,
    defaultText: 'unset',
    range: 'integer 0..2147483647, or unset; 0 disables the body timeout, unset leaves the Host default untouched',
    build: lib => lib.number()
      .step(1)
      .min(0)
      .max(MAX_TIMER_DELAY_MS)
      .volatile(),
  },
])

/** The two owned fetch keys, in the order the settings page and `Config` use. */
export const FETCH_KEYS = Object.freeze(FETCH_FIELDS.map(field => field.key))

/**
 * Public fetch-field metadata, mirroring `TUNE_OPTIONS`: key, kind, code
 * default (`null`, meaning unset), its default text, and the allowed range. The
 * docs checks and the client dictionary read this table instead of hardcoding
 * the numbers.
 */
export const FETCH_OPTIONS = Object.freeze(FETCH_FIELDS.map(field => Object.freeze({
  key: field.key,
  kind: field.kind,
  default: field.default,
  defaultText: field.defaultText,
  range: field.range,
})))

/**
 * The schema the settings page validates against.
 *
 * One field per owned value, every leaf `.volatile()`: a settings edit commits
 * into the running fiber without a remount. The root is a plain object because
 * `volatileForm()` only descends object roots
 * (`packages/settings/settings/src/schema.ts:37-47`); a transform/refine/union
 * on the ROOT would cost the whole settings section, which is why the only
 * union here is a leaf allowlist.
 *
 * The retry fields come first, then the two fetch timeouts, so the dictionary
 * order the settings page renders is stable. The two fetch leaves carry no
 * schema default (unset means "leave the Host dispatcher alone"), so
 * `Config({})` materializes them as absent volatile nodes.
 */
export const Config = z === undefined ? undefined : z.object(Object.fromEntries(
  [...TUNE_FIELDS, ...FETCH_FIELDS].map(field => [field.key, field.build(z)]),
))

/**
 * Metadata for the "Provider timeouts" card: three per-route leaves that live
 * in the PROVIDER namespaces, not in this plugin's `Config`.
 *
 * These values are DSH provider settings (`streamIdleTimeoutMs` and
 * `filesApiTimeoutMs` are `.volatile()` leaves of `llm-deepseek`/
 * `llm-deepseek-account`; every `llm-pi-ai` route is a leaf under the volatile
 * `providers` dict), so the settings page writes them DIRECTLY through each
 * namespace's own form — the same cross-namespace write the retry card already
 * performs. This module therefore only publishes the frozen metadata the page,
 * the docs and verify.mjs read: it never reads, writes, or applies these
 * values, and `Config` deliberately has no field for them.
 *
 * The facts recorded here are the upstream schema contract:
 *
 * - `streamIdleTimeoutMs`: `packages/llm/llm-pi-ai/src/config.ts` (per-route)
 *   and `packages/llm/llm-deepseek/src/config.ts` (root) bound it to
 *   `(0, MAX_TIMER_DELAY_MS]` and the package default is 300 000 ms
 *   (`llm-pi-ai/src/config.ts`, `llm-deepseek/src/defaults.ts`); a `<= 0`
 *   value fails the load-time assert. It is the only one of the three that
 *   exists on every route.
 * - `timeoutMs`: `llm-pi-ai` only, DSH has no default of its own, and the
 *   Anthropic/OpenAI SDKs fall back to about 600 000 ms. The DSH schema is
 *   `z.natural()` (0 is schema-legal) but 0 aborts every request immediately,
 *   so the page refuses it and the metadata marks it zero-rejected.
 * - `filesApiTimeoutMs`: `llm-deepseek`/`llm-deepseek-account` only, package
 *   default 60 000 ms, same `(0, MAX_TIMER_DELAY_MS]` bound and assert.
 *
 * The page narrows all three to integers even where the upstream schema would
 * accept a fractional millisecond (`integerOnly`), and because the schemas have
 * no "off" switch, "unlimited" is expressed as the 2 147 483 647 cap
 * (`unlimitedPreset`), never as 0.
 *
 * `scopes` are the exact namespace/path templates one write addresses. The
 * literal `<route>` placeholder stands for the joined provider route id and is
 * substituted by the page from the row's `settingsPath`, exactly like the
 * retry card. Every nested object and array is frozen: this table is a pinned
 * contract for the docs and the verify gate.
 */
export const PROVIDER_TIMEOUT_FIELDS = Object.freeze([
  Object.freeze({
    key: 'streamIdleTimeoutMs',
    family: 'streamIdle',
    default: 300_000,
    defaultText: '300000 ms (5 min); unset = package default 300000',
    range: 'integer 1..2147483647; 0 is refused (schema and load-time assert)',
    unit: 'ms',
    integerOnly: true,
    zeroRejected: true,
    unlimitedPreset: MAX_TIMER_DELAY_MS,
    scopes: Object.freeze([
      Object.freeze({
        ns: 'llm-pi-ai',
        pathTemplate: Object.freeze(['providers', '<route>', 'streamIdleTimeoutMs']),
      }),
      Object.freeze({
        ns: 'llm-deepseek',
        pathTemplate: Object.freeze(['streamIdleTimeoutMs']),
      }),
      Object.freeze({
        ns: 'llm-deepseek-account',
        pathTemplate: Object.freeze(['streamIdleTimeoutMs']),
      }),
    ]),
    description: 'Maximum silence between streamed chunks before the idle watchdog aborts the attempt; applies to every route; 0 is refused, so the unlimited preset is 2147483647.',
  }),
  Object.freeze({
    key: 'timeoutMs',
    family: 'request',
    default: null,
    defaultText: 'unset = SDK default (about 600000 ms)',
    range: 'integer 1..2147483647; 0 is refused by the page (schema-legal but aborts every request)',
    unit: 'ms',
    integerOnly: true,
    zeroRejected: true,
    unlimitedPreset: MAX_TIMER_DELAY_MS,
    scopes: Object.freeze([
      Object.freeze({
        ns: 'llm-pi-ai',
        pathTemplate: Object.freeze(['providers', '<route>', 'timeoutMs']),
      }),
    ]),
    description: 'SDK request timeout for a pi-ai route (bounds the wait for response headers, not the stream body); unset keeps the SDK default of about 600000 ms.',
  }),
  Object.freeze({
    key: 'filesApiTimeoutMs',
    family: 'files',
    default: 60_000,
    defaultText: '60000 ms (1 min); unset = package default 60000',
    range: 'integer 1..2147483647; 0 is refused (schema and load-time assert)',
    unit: 'ms',
    integerOnly: true,
    zeroRejected: true,
    unlimitedPreset: MAX_TIMER_DELAY_MS,
    scopes: Object.freeze([
      Object.freeze({
        ns: 'llm-deepseek',
        pathTemplate: Object.freeze(['filesApiTimeoutMs']),
      }),
      Object.freeze({
        ns: 'llm-deepseek-account',
        pathTemplate: Object.freeze(['filesApiTimeoutMs']),
      }),
    ]),
    description: 'Timeout for the DeepSeek Files API calls on a DeepSeek route; unset keeps the package default of 60000 ms.',
  }),
])

/** The three per-route provider-timeout keys, in the order the page renders them. */
export const PROVIDER_TIMEOUT_KEYS = Object.freeze(PROVIDER_TIMEOUT_FIELDS.map(field => field.key))

/**
 * Public provider-timeout metadata, one frozen projection per field with every
 * key a doc table or a verify pin reads: key, family, code default, its default
 * text, the allowed range, unit, integer/zero rules, the unlimited preset, the
 * exact namespace/path templates, and a one-line description.
 */
export const PROVIDER_TIMEOUT_OPTIONS = Object.freeze(PROVIDER_TIMEOUT_FIELDS.map(field => Object.freeze({
  key: field.key,
  family: field.family,
  default: field.default,
  defaultText: field.defaultText,
  range: field.range,
  unit: field.unit,
  integerOnly: field.integerOnly,
  zeroRejected: field.zeroRejected,
  unlimitedPreset: field.unlimitedPreset,
  scopes: field.scopes,
  description: field.description,
})))


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
 * `OFFERED_RETRYABLE_CODES` (the five upstream defaults plus the opt-in extras;
 * an absent value still falls back to the five).
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
    && candidate.every(code => typeof code === 'string' && OFFERED_RETRYABLE_CODE_SET.has(code))
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
 * Log an informational line without assuming the context carries a logger.
 * @param {object} ctx - the plugin context.
 * @param {string} message - the message.
 */
function info(ctx, message) {
  const logger = ctx.get?.('logger') ?? ctx.logger
  if (logger !== undefined && typeof logger.info === 'function') logger.info(message)
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
 * Read a possibly-volatile config field.
 *
 * `.volatile()` wraps its value, so a configured value and an absent key are
 * both wrapper objects; only `.get()` tells them apart (`undefined` versus a
 * number). Plain values pass through, for a raw config and for tests.
 * @param {unknown} value - the raw or wrapped config field.
 * @returns {unknown} the underlying value, or `undefined` when absent.
 */
function volatileValue(value) {
  if (value === undefined || value === null) return undefined
  return typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * One timeout value read from a config source, with `null` for "unset".
 *
 * `undefined` (key absent) and `null` (explicitly cleared) both mean unset, and
 * both are deliberately distinct from `0`, which is a real value: undici treats
 * a zero timeout as disabled and must receive it. The schema already bounds the
 * field, so the range check is a defensive guard for a raw config and for a bad
 * volatile write; an impossible number is treated as unset rather than handed
 * to undici, whose `Request` constructor would throw `invalid headersTimeout`
 * on every request.
 * @param {object} source - a possibly-volatile config object.
 * @param {'headersTimeoutMs'|'bodyTimeoutMs'} key - one of `FETCH_KEYS`.
 * @returns {number|null} the live value, or `null` when the field is unset.
 */
function fetchValue(source, key) {
  const value = volatileValue(source?.[key])
  if (value === undefined || value === null) return DEFAULT_FETCH[key]
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) return DEFAULT_FETCH[key]
  return value
}

/**
 * Read the live fetch timeouts from this plugin's own (possibly wrapped) config.
 *
 * Called at install time and again on every reload signal, never captured as
 * plain numbers: a volatile settings edit commits new values into the running
 * fiber's config in place. The fiber's resolved config is authoritative because
 * the loader commits the new values into the refs it finds THERE
 * (`vendor/loader/src/config/entry.ts:164-186`), which is not necessarily the
 * object `apply()` captured; the captured object is the fallback for a context
 * without a fiber (the offline doubles).
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the config captured by `apply()`.
 * @returns {{headersTimeoutMs: number|null, bodyTimeoutMs: number|null}} the
 *   live values; `null` per field means unset.
 */
function liveFetchValues(ctx, config) {
  const fiber = ctx.fiber
  const source = fiber?.effectiveConfig ?? fiber?.config ?? config ?? {}
  return {
    headersTimeoutMs: fetchValue(source, 'headersTimeoutMs'),
    bodyTimeoutMs: fetchValue(source, 'bodyTimeoutMs'),
  }
}

/**
 * The proxy-aware agent upstream `dsh-fetch-timeouts` installs, kept identical
 * in behavior: Node honours `HTTP_PROXY` and friends only when
 * `NODE_USE_ENV_PROXY` is set, so build an `EnvHttpProxyAgent` for exactly that
 * case and `undefined` otherwise (which keeps the dispatcher already installed,
 * so DSH's own proxy routing is never replaced with a direct one).
 * @param {object} undici - the resolved undici library.
 * @param {object} env - the process environment.
 * @returns {object|undefined} the agent, or `undefined` when env proxying is off.
 */
function envProxyAgent(undici, env) {
  if (!env.NODE_USE_ENV_PROXY) return undefined
  return new undici.EnvHttpProxyAgent()
}

/**
 * The same dispatcher, with the currently set timeouts on every request that
 * does not set its own. Adapted from `dsh-fetch-timeouts` `withTimeouts` (MIT,
 * © 2026 Dev Mehra; see THIRD-PARTY-NOTICES.md).
 *
 * Each field is filled only when the live value is a number: an unset field
 * leaves `headersTimeout`/`bodyTimeout` absent, so the dispatcher's own default
 * (DSH's, Node's, or undici's) applies exactly as before. A per-request value
 * always wins over this plugin's, and `0` is a real value ("disabled") that is
 * passed through, not treated as absent. The values are read on every dispatch,
 * so a volatile edit takes effect on the next request without re-installing
 * anything. Every other member is delegated to the target (bound to it), so
 * `close()`, `destroy()`, and the interceptor chain keep working on the
 * dispatcher the Host installed.
 * @param {object} dispatcher - the dispatcher to wrap.
 * @param {() => {headersTimeoutMs: number|null, bodyTimeoutMs: number|null}} read
 *   - reads the live values.
 * @returns {object} a Proxy with the dispatcher's interface.
 */
function withTimeouts(dispatcher, read) {
  const dispatch = (opts, handler) => {
    const values = read()
    const next = { ...opts }
    const unset = candidate => candidate === undefined || candidate === null
    if (values.headersTimeoutMs !== null && unset(next.headersTimeout)) next.headersTimeout = values.headersTimeoutMs
    if (values.bodyTimeoutMs !== null && unset(next.bodyTimeout)) next.bodyTimeout = values.bodyTimeoutMs
    return dispatcher.dispatch(next, handler)
  }
  return new Proxy(dispatcher, {
    get(target, key) {
      if (key === 'dispatch') return dispatch
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Close an agent this plugin created, ignoring every failure: the Host may
 * already be shutting down, and a cleanup must never mask the real disposal.
 * @param {object|undefined} agent - the agent, when one was created.
 */
function closeQuietly(agent) {
  if (agent === undefined || agent === null) return
  try {
    const closing = agent.close()
    if (closing !== null && typeof closing?.catch === 'function') closing.catch(() => {})
  } catch {
    // Best effort only: the process is going away.
  }
}

/**
 * Keep the process-wide fetch timeouts installed exactly as long as a value is
 * set, and never touch a dispatcher otherwise.
 *
 * Order matters, and mirrors `dsh-fetch-timeouts` (MIT, © 2026 Dev Mehra; see
 * THIRD-PARTY-NOTICES.md): DSH's own `http-proxy` package installs a
 * proxy-aware global dispatcher before plugins mount
 * (`packages/util/http-proxy/src/install.ts`), so snapshot whatever dispatcher
 * is current, wrap THAT (never replace it with a bare Agent — that would drop
 * the proxy routing), and on removal restore the previous dispatcher only when
 * the current one is still ours, so a dispatcher installed after us wins.
 *
 * The wrapper is installed ONLY when at least one value is a number, so a fresh
 * install that leaves both unset changes nothing at all: undici is not even
 * required in that case. Volatile-only settings commits do not re-run `apply()`
 * (`vendor/loader/src/config/entry.ts` `_commitVolatile` emits
 * `loader/volatile-update` instead), so the same reconcile path runs from that
 * event and from `app-boot/config-reload` (the settings-write completion
 * signal, consumed the same way at `packages/settings/settings/src/index.ts:234`):
 * setting a first value installs, clearing the last one restores. A value
 * change on an installed wrapper does not re-install it; the wrapper reads the
 * mutable value snapshot.
 *
 * The two listeners stay registered while both fields are unset for one reason:
 * a later live save must be able to install the wrapper again, and a
 * volatile-only commit never re-runs `apply()`. They are removed by the
 * disposer, together with the wrapper.
 *
 * Every failure is reported and degrades to a no-op: a missing undici or a
 * refused dispatcher must not fail the Host boot.
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the config captured by `apply()`.
 * @returns {() => void} the disposer: detaches both listeners, restores the
 *   previous dispatcher when ours is still current, and closes the env-proxy
 *   agent.
 */
function installFetchTimeouts(ctx, config) {
  /** The Host anchors the first resolution should try first. */
  const contextAnchors = hostContextAnchors(ctx)
  /** Resolved undici, loaded on first use so an all-unset row requires nothing. */
  let undici
  /** Whether the missing-undici warning already ran (one per instance). */
  let warnedNoUndici = false
  /** The installed wrapper plus what its removal must restore. */
  let installed
  /** The live values the wrapper reads; `null` per field means unset. */
  let values = liveFetchValues(ctx, config)

  /**
   * Resolve undici the first time a value actually needs a dispatcher.
   * @returns {object|undefined} the library, or `undefined` when unresolvable.
   */
  const library = () => {
    if (undici === undefined) undici = resolveUndici(contextAnchors)
    return undici
  }

  /** Remove the wrapper, restoring the dispatcher it wrapped when still current. */
  const uninstall = () => {
    if (installed === undefined) return
    const { dispatcher, previous, own } = installed
    installed = undefined
    try {
      // Only step back if nobody installed another dispatcher after us: a newer
      // dispatcher (a host proxy reload, say) owns the global now, not ours to drop.
      if (undici?.getGlobalDispatcher() === dispatcher) undici.setGlobalDispatcher(previous)
    } catch (error) {
      warn(ctx, `${name}: the previous global dispatcher could not be restored: ${errorMessage(error)}`)
    }
    closeQuietly(own)
  }

  /** Install the wrapper around whatever dispatcher is current right now. */
  const install = () => {
    const lib = library()
    if (lib === undefined) {
      if (!warnedNoUndici) {
        warnedNoUndici = true
        warn(ctx, `${name}: undici could not be resolved from the Host, so the fetch timeouts are not applied`)
      }
      return
    }
    let previous
    try {
      previous = lib.getGlobalDispatcher()
    } catch (error) {
      warn(ctx, `${name}: the current global dispatcher could not be read: ${errorMessage(error)}`)
      return
    }
    let own
    try {
      own = envProxyAgent(lib, process.env)
    } catch (error) {
      // A malformed proxy variable must not cost the timeouts as well.
      warn(ctx, `${name}: the environment proxy agent could not be created: ${errorMessage(error)}`)
      own = undefined
    }
    const dispatcher = withTimeouts(own ?? previous, () => values)
    try {
      lib.setGlobalDispatcher(dispatcher)
    } catch (error) {
      warn(ctx, `${name}: the global dispatcher could not be replaced: ${errorMessage(error)}`)
      closeQuietly(own)
      return
    }
    installed = { dispatcher, previous, own }
    const applied = []
    if (values.headersTimeoutMs !== null) applied.push(`headers ${values.headersTimeoutMs} ms`)
    if (values.bodyTimeoutMs !== null) applied.push(`body ${values.bodyTimeoutMs} ms`)
    info(ctx, `${name}: ${applied.join(', ')} (process-wide${own === undefined ? '' : ', env proxy'})`)
  }

  /**
   * Re-read the live values and make the installed state match them: install
   * when a first value is set, remove the wrapper when the last one is cleared.
   */
  const reconcile = () => {
    values = liveFetchValues(ctx, config)
    const active = values.headersTimeoutMs !== null || values.bodyTimeoutMs !== null
    if (installed === undefined) {
      if (active) install()
      return
    }
    if (!active) uninstall()
  }

  reconcile()

  const detachers = []
  for (const event of ['loader/volatile-update', 'app-boot/config-reload']) {
    if (typeof ctx.on !== 'function') continue
    try {
      const detach = ctx.on(event, reconcile)
      if (typeof detach === 'function') detachers.push(detach)
    } catch (error) {
      warn(ctx, `${name}: the "${event}" listener could not be registered: ${errorMessage(error)}`)
    }
  }

  return () => {
    for (const detach of detachers.splice(0)) {
      try {
        detach()
      } catch {
        // A fiber-scoped disposer may already have run.
      }
    }
    uninstall()
  }
}

/* ══ Manual same-turn retry ═══════════════════════════════════════════════ */

/**
 * Authenticated Web route the settings page uses for the manual same-turn
 * retry. `dsh-backend-restart` established the shape: a plugin-owned prefix
 * route whose first act is `ctx.connection.requestRejection(req)`, so
 * Connection's Host/Origin fence and browser authentication run before any
 * method, body, or envelope decision.
 */
const RETRY_CHANNEL = '/llm-api-call-tuning'

/** How long one manual-retry prompt may hold the turn open before it declines. */
const RETRY_DECISION_TIMEOUT_MS = 90_000

/**
 * Freshness window of a page `state` poll. A prompt is offered only for a
 * session whose page polled `state` within this window, so a closed tab, a
 * disconnected browser, or a headless Host never parks an open turn.
 */
const RETRY_WATCHER_WINDOW_MS = 20_000

/**
 * Manual retries one turn may accept. A manual decision bypasses the policy's
 * own budget (`retryPolicy.maxRetries`), so this cap is the only bound on a
 * user pressing Retry over and over.
 */
const MANUAL_RETRY_MAX_PER_TURN = 5

/** Bound on one retry-channel body; every request carries two short strings. */
const RETRY_MAX_BODY_BYTES = 64 * 1024

/** Defensive bound on the session id this channel echoes back into a prompt. */
const RETRY_MAX_SESSION_ID_LENGTH = 256

/** Segment shape Connection accepts inside one channel endpoint. */
const RETRY_ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Correlation id answered when a request never carried a usable one. */
const RETRY_INVALID_RPC_ID = 'invalid-request'

/** Prefix of every failure code this channel returns. */
const RETRY_FAILURE_PREFIX = 'manual-retry'

/** The endpoints this channel serves, as `connection.rpc.call` addresses them. */
const RETRY_ENDPOINTS = Object.freeze(['state', 'decide'])

/**
 * Read the session id that owns one `agent/request-error` payload.
 * @param {object} payload - the waterfall payload.
 * @returns {string | undefined} `String(agent.id)`, or undefined when the payload carries no agent.
 */
function retrySessionId(payload) {
  const id = payload?.agent?.id
  if (id === undefined || id === null) return undefined
  const text = String(id)
  return text.length === 0 ? undefined : text
}

/**
 * One unguessable decision nonce. The page must echo it back, so a decision
 * cannot be replayed against a later prompt and a decision minted for one
 * prompt cannot settle another.
 * @returns {string} a fresh nonce.
 */
function retryNonce() {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') {
    try {
      return uuid.call(globalThis.crypto)
    } catch {
      // A restricted crypto implementation falls through to the local form.
    }
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Create the in-memory desk that parks one non-retryable model failure while
 * the page asks the user whether to retry it.
 *
 * The desk owns all of this feature's state:
 * - `pending`: one live prompt per session, because a turn runs one model
 *   request at a time; its `settle` resolves the parked waterfall.
 * - `watchers`: the last `state` poll per session — the only evidence that a
 *   page is open and may be prompted at all.
 * - `manualRetries`: accepted manual retries per `${sessionId}:${turn}`. A
 *   manual decision bypasses the retry policy's own budget, so this counter is
 *   the only bound on repeated manual retries.
 *
 * Every browser tab shares one pending entry: the first valid decision settles
 * it, and every later decision is answered `manual-retry/stale`.
 *
 * @returns {object} the desk API (`shouldOffer`, `awaitDecision`, `stateFor`, `decide`, `settleAll`).
 */
function createRetryDesk() {
  /** One live prompt per session; the waterfall is parked on its `settle`. */
  const pending = new Map()
  /** Last `state` poll per session: the heartbeat that authorizes prompting. */
  const watchers = new Map()
  /** Accepted manual retries per `${sessionId}:${turn}`. */
  const manualRetries = new Map()

  /**
   * Counter key for one session turn.
   * @param {string} sessionId - owning session.
   * @param {number} turn - turn number.
   * @returns {string} the key.
   */
  const counterKey = (sessionId, turn) => `${sessionId}:${turn}`

  /**
   * Manual retries this turn already accepted.
   * @param {string} sessionId - owning session.
   * @param {number} turn - turn number.
   * @returns {number} the accepted count (0 when none).
   */
  const used = (sessionId, turn) => {
    const count = manualRetries.get(counterKey(sessionId, turn))
    return Number.isSafeInteger(count) && count > 0 ? count : 0
  }

  /**
   * Drop heartbeat entries older than the window, so the map cannot grow with
   * closed tabs.
   * @param {number} now - current epoch milliseconds.
   */
  const pruneWatchers = now => {
    for (const [sessionId, at] of watchers) {
      if (now - at > RETRY_WATCHER_WINDOW_MS) watchers.delete(sessionId)
    }
  }

  /**
   * Whether this failure may be offered to the user.
   *
   * False when: the route retries automatically in `always` mode; the payload
   * carries no session; a prompt is already pending; the per-turn cap is spent;
   * or no page polled `state` within the watcher window. The listener has
   * already awaited `next()`, so this only decides the MANUAL fallback.
   * @param {object} payload - the `agent/request-error` payload.
   * @returns {boolean} whether to park the turn and prompt.
   */
  const shouldOffer = payload => {
    if (payload?.retryPolicy?.mode === 'always') return false
    const sessionId = retrySessionId(payload)
    if (sessionId === undefined) return false
    if (pending.has(sessionId)) return false
    const turn = Number.isSafeInteger(payload?.turn) ? payload.turn : -1
    if (used(sessionId, turn) >= MANUAL_RETRY_MAX_PER_TURN) return false
    const at = watchers.get(sessionId)
    return typeof at === 'number' && Date.now() - at <= RETRY_WATCHER_WINDOW_MS
  }

  /**
   * Park the turn until the page decides, the timeout expires, or the turn is
   * cancelled. The pending entry, its timer, and its abort link are all removed
   * by one idempotent `settle`.
   * @param {object} payload - the `agent/request-error` payload.
   * @returns {Promise<{ kind: 'retry' } | undefined>} the retry action, or undefined to decline.
   */
  const awaitDecision = payload => {
    const sessionId = retrySessionId(payload)
    if (sessionId === undefined) return Promise.resolve(undefined)
    const signal = payload?.signal
    if (signal !== undefined && signal.aborted === true) return Promise.resolve(undefined)
    const turn = Number.isSafeInteger(payload?.turn) ? payload.turn : -1
    const step = Number.isSafeInteger(payload?.step) ? payload.step : -1
    const provider = typeof payload?.provider === 'string' ? payload.provider : ''
    const code = typeof payload?.failure?.code === 'string' ? payload.failure.code : ''
    const message = typeof payload?.failure?.message === 'string' ? payload.failure.message : ''
    return new Promise(resolve => {
      const nonce = retryNonce()
      const expiresAt = Date.now() + RETRY_DECISION_TIMEOUT_MS
      let settled = false
      /** Fiber-owned expiry timer; cleared by `settle`. */
      let timer
      /** The abort link, replaced once the pending entry exists. */
      let onAbort = () => {}
      /**
       * Resolve once: clear the timer, unlink the abort listener, drop the map
       * entry, then hand the value to the parked waterfall.
       * @param {{ kind: 'retry' } | undefined} value - the decision.
       */
      const settle = value => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (signal !== undefined && typeof signal.removeEventListener === 'function') {
          try {
            signal.removeEventListener('abort', onAbort)
          } catch {
            // A foreign or already-disposed signal has nothing to remove.
          }
        }
        const current = pending.get(sessionId)
        if (current !== undefined && current.nonce === nonce) pending.delete(sessionId)
        resolve(value)
      }
      onAbort = () => settle(undefined)
      timer = setTimeout(() => settle(undefined), RETRY_DECISION_TIMEOUT_MS)
      pending.set(sessionId, { nonce, turn, step, provider, code, message, expiresAt, settle })
      // Forget counters of this session's earlier turns: only the live turn counts.
      const currentKey = counterKey(sessionId, turn)
      for (const key of manualRetries.keys()) {
        if (key.startsWith(`${sessionId}:`) && key !== currentKey) manualRetries.delete(key)
      }
      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        if (signal.aborted === true) settle(undefined)
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * The page's view of one session, and the heartbeat that authorizes
   * prompting: every call records the session as watched.
   * @param {string} sessionId - the session to report on.
   * @returns {{ pending: null | { nonce: string, turn: number, step: number, provider: string, code: string, message: string, expiresAt: number, attemptsLeft: number } }} the live prompt, if any.
   */
  const stateFor = sessionId => {
    const now = Date.now()
    pruneWatchers(now)
    watchers.set(sessionId, now)
    const entry = pending.get(sessionId)
    if (entry === undefined) return { pending: null }
    if (entry.expiresAt <= now) {
      entry.settle(undefined)
      return { pending: null }
    }
    return {
      pending: {
        nonce: entry.nonce,
        turn: entry.turn,
        step: entry.step,
        provider: entry.provider,
        code: entry.code,
        message: entry.message,
        expiresAt: entry.expiresAt,
        attemptsLeft: Math.max(0, MANUAL_RETRY_MAX_PER_TURN - used(sessionId, entry.turn)),
      },
    }
  }

  /**
   * Apply one decision. The first valid decision wins: it clears the pending
   * entry, so a later, foreign, or replayed decision is answered stale.
   * @param {string} sessionId - owning session.
   * @param {string} nonce - nonce of the prompt being answered.
   * @param {'retry' | 'dismiss'} decision - the user's choice.
   * @returns {{ accepted: boolean }} whether the decision settled the prompt.
   */
  const decide = (sessionId, nonce, decision) => {
    const entry = pending.get(sessionId)
    if (entry === undefined || entry.nonce !== nonce) return { accepted: false }
    if (entry.expiresAt <= Date.now()) {
      entry.settle(undefined)
      return { accepted: false }
    }
    if (decision === 'retry') {
      manualRetries.set(counterKey(sessionId, entry.turn), used(sessionId, entry.turn) + 1)
      entry.settle({ kind: 'retry' })
      return { accepted: true }
    }
    entry.settle(undefined)
    return { accepted: true }
  }

  /**
   * Decline every live prompt and drop all state. The effect disposer calls
   * this: without it, a disposed plugin would leave every parked turn waiting
   * out its 90 s timeout.
   */
  const settleAll = () => {
    for (const entry of [...pending.values()]) entry.settle(undefined)
    pending.clear()
    watchers.clear()
    manualRetries.clear()
  }

  return { shouldOffer, awaitDecision, stateFor, decide, settleAll }
}

/**
 * The `agent/request-error` listener: let every automatic policy decide first,
 * then offer the manual retry.
 *
 * Awaiting `next()` is what makes listener ordering irrelevant and the feature
 * additive: llm-retry answers `{ kind: 'retry' }` for a code it retries (and
 * for every failure in `always` mode), so this listener passes that action
 * through untouched and never prompts. It only sees the failures nothing else
 * recovered.
 * @param {object} desk - the desk from {@link createRetryDesk}.
 * @param {object} payload - the waterfall payload.
 * @param {() => Promise<object>} next - the downstream recovery chain.
 * @returns {Promise<object>} the automatic action, the manual retry action, or undefined to decline.
 */
async function retryOrPrompt(desk, payload, next) {
  // A bare listener invocation (a diagnostic or a host double calling every
  // registered listener) has no downstream chain to await; nothing can be
  // retried, so decline instead of throwing.
  if (typeof next !== 'function') return undefined
  const automatic = await next()
  if (automatic !== undefined) return automatic
  if (!desk.shouldOffer(payload)) return undefined
  return desk.awaitDecision(payload)
}

/**
 * Build one Connection-shaped failure result.
 * @param {string} code - channel-relative failure code.
 * @param {string} message - diagnostic text; the page localizes its own copy.
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the failure result.
 */
function retryFailure(code, message) {
  return { ok: false, error: { code: `${RETRY_FAILURE_PREFIX}/${code}`, message, details: {} } }
}

/**
 * Build the malformed-request failure result.
 * @param {string} message - diagnostic text.
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the failure result.
 */
function retryBadRequest(message) {
  return retryFailure('bad-request', message)
}

/**
 * Extract the channel-relative endpoint from a request target.
 * @param {string | undefined} url - request target as node:http supplied it.
 * @returns {string | undefined} `state` or `decide`, or undefined outside this channel.
 */
function retryEndpointOf(url) {
  const pathname = new URL(url ?? '/', 'http://dsh.internal').pathname
  if (!pathname.startsWith(`${RETRY_CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(RETRY_CHANNEL.length + 1)
  const segments = endpoint.split('/')
  if (segments.length !== 1) return undefined
  const [segment] = segments
  if (segment === '' || segment === '.' || segment === '..'
    || !RETRY_ENDPOINT_SEGMENT_PATTERN.test(segment)) {
    return undefined
  }
  return RETRY_ENDPOINTS.includes(segment) ? segment : undefined
}

/**
 * Buffer one request body under this channel's ceiling.
 * @param {import('node:http').IncomingMessage} req - request owning the body.
 * @returns {Promise<string | undefined>} UTF-8 body, or undefined past the ceiling.
 */
async function readRetryBody(req) {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > RETRY_MAX_BODY_BYTES) return undefined
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    received += buffer.byteLength
    if (received > RETRY_MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, received).toString('utf8')
}

/**
 * Narrow an unknown JSON value to a non-array object.
 * @param {unknown} value - parsed JSON value.
 * @returns {value is Record<string, unknown>} whether it is a JSON object.
 */
function isRetryRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Frame one handler result exactly as Connection's JSON channel does.
 * @param {object} result - handler result.
 * @returns {object} the result carried in the envelope.
 */
function frameRetryResult(result) {
  if (!result.ok) return result
  const { attachments: _attachments, ...framed } = result
  return framed
}

/**
 * Write one Connection `server-response` envelope.
 * @param {import('node:http').ServerResponse} res - response owned here.
 * @param {string} rpcId - correlation id echoed to the caller.
 * @param {object} result - handler result or Connection failure result.
 */
function sendRetryEnvelope(res, rpcId, result) {
  // Serialize before writing headers: a malformed handler result must reach the
  // handler-failure path, not leave a half-written response.
  const payload = JSON.stringify({ type: 'server-response', rpcId, result: frameRetryResult(result) })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(payload)
}

/**
 * Decode and serve one channel endpoint.
 * @param {object} desk - the desk from {@link createRetryDesk}.
 * @param {string} endpoint - `state` or `decide`.
 * @param {unknown} payload - the decoded `payload` member of the envelope.
 * @returns {object} a `{ ok: true, value }` or `{ ok: false, error }` result.
 */
function handleRetryRequest(desk, endpoint, payload) {
  if (!isRetryRecord(payload)) return retryBadRequest('payload must be a JSON object')
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0
    || sessionId.length > RETRY_MAX_SESSION_ID_LENGTH) {
    return retryBadRequest('payload.sessionId must be a non-empty string')
  }
  if (endpoint === 'state') return { ok: true, value: desk.stateFor(sessionId) }
  const nonce = payload.nonce
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) {
    return retryBadRequest('payload.nonce must be a non-empty string')
  }
  const decision = payload.decision
  if (decision !== 'retry' && decision !== 'dismiss') {
    return retryBadRequest('payload.decision must be "retry" or "dismiss"')
  }
  const outcome = desk.decide(sessionId, nonce, decision)
  if (outcome.accepted !== true) {
    return retryFailure('stale', 'this retry prompt is no longer pending')
  }
  return { ok: true, value: { accepted: true } }
}

/**
 * Mount the manual-retry channel as an authenticated Web route.
 *
 * `ctx.connection.rpc.handle()` is deliberately not used: on Cordis
 * 4.0.0-rc.11 the Connection provider resolves `webServer` through its own
 * def-site inject list, so that call is refused even though this plugin injects
 * `webServer` (the same limitation `dsh-backend-restart` records). Mounting on
 * this plugin's own fiber keeps `webServer` resolution here and reproduces
 * Connection's channel adapter before dispatch: its Host/Origin fence and
 * browser authentication first, then the request guards (POST only,
 * channel-relative endpoint, JSON media type, bounded body), the
 * `client-request` envelope parse, and the `server-response` framing.
 *
 * @param {object} ctx - a context that injects `connection` and `webServer`.
 * @param {object} desk - the desk from {@link createRetryDesk}.
 * @returns {() => void} the route disposer, owned by the caller's effect.
 */
function registerRetryChannel(ctx, desk) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  const connection = ctx.connection ?? ctx.get?.('connection')
  if (webServer === undefined || typeof webServer.register !== 'function'
    || connection === undefined || typeof connection.requestRejection !== 'function') {
    warn(ctx, `${name}: the manual-retry channel needs the connection and webServer services; it stays unmounted`)
    return () => {}
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: RETRY_CHANNEL,
    handler: async (req, res) => {
      // Connection's fence owns trust and browser authentication; it answers
      // before any method, body, or envelope decision, as its own adapter does.
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = retryEndpointOf(req.url)
      if (endpoint === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method must be POST')
        return
      }
      const mediaType = typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type'].split(';', 1)[0].trim().toLowerCase()
        : undefined
      if (mediaType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let text
      try {
        text = await readRetryBody(req)
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      if (text === undefined) {
        // Connection's bridge bounds every buffered body; this channel carries
        // two short strings, so its ceiling is far below the shared one.
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      // Connection's client-request schema: a JSON object with the message
      // literal, a string id, a string method, and a present (any-valued)
      // payload. Unknown keys are stripped by that schema, so they are ignored.
      if (!isRetryRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string'
        || typeof body.method !== 'string' || !Object.hasOwn(body, 'payload')) {
        const rpcId = isRetryRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : RETRY_INVALID_RPC_ID
        sendRetryEnvelope(res, rpcId, retryBadRequest('invalid client-request message'))
        return
      }
      if (body.method !== endpoint) {
        sendRetryEnvelope(res, body.rpcId, retryBadRequest(
          `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      try {
        sendRetryEnvelope(res, body.rpcId, handleRetryRequest(desk, endpoint, body.payload))
      } catch (error) {
        res.writeHead(500)
        res.end(`handler failure: ${String(error)}`)
      }
    },
  })
  return () => { void dispose() }
}

/**
 * Apply the host half.
 *
 * Three independent jobs:
 *
 * 1. The bundle ships its own settings page, so suppress the auto-generated
 *    generic config form for this same row; otherwise one namespace renders two
 *    pages. This is a HOST call by construction: only the Host can register an
 *    instance page policy (`settings.configure`, see the ui-settings precedent
 *    `packages/client/ui-settings/src/index.ts:23-24`). Guarded, because a
 *    policy conflict must not fail the boot.
 * 2. Keep the process-wide fetch timeouts in step with the two fetch settings
 *    (see {@link installFetchTimeouts}). This lives in its own `ctx.effect`, so
 *    the disposer that restores the previous dispatcher is owned by this row's
 *    fiber. With both settings unset — the shipped default — nothing is
 *    installed and the Host's dispatcher is untouched.
 * 3. Offer the manual same-turn retry (see {@link createRetryDesk}): the
 *    waterfall listener is fiber-owned, and the authenticated decision route
 *    mounts only where the Host serves `connection` and `webServer`. A headless
 *    Host therefore still boots and never parks a turn for a page that cannot
 *    exist.
 *
 * The page itself edits provider rows through the settings form API, and the
 * host half stores no projection state.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [config] - this row's validated config (the loader always
 *   passes it; the offline doubles may omit it).
 */
export function apply(ctx, config = {}) {
  ctx.inject(['settings'], child => child.effect(() => {
    try {
      return child.settings.configure({ auto: false }, ctx.fiber)
    } catch (error) {
      warn(ctx, `${name}: the automatic settings page could not be suppressed: ${errorMessage(error)}`)
      return () => {}
    }
  }))

  const install = () => {
    try {
      return installFetchTimeouts(ctx, config)
    } catch (error) {
      // Belt and braces: no install failure may fail the Host boot.
      warn(ctx, `${name}: the fetch timeouts could not be installed: ${errorMessage(error)}`)
      return () => {}
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(install, `${name}: fetch timeouts`)
  } else {
    // A context without lifecycle effects (the offline doubles) still gets the
    // side effect; it just has no fiber to dispose it.
    install()
  }

  // Manual same-turn retry. The desk lives exactly as long as this activation:
  // its disposer declines every parked prompt, so disposing the plugin can
  // never leave a turn waiting for a page that will never answer.
  const desk = createRetryDesk()

  /**
   * Register the `agent/request-error` listener on this fiber.
   * @returns {() => void} the disposer: detach the listener, then settle the desk.
   */
  const mountRetryListener = () => {
    if (typeof ctx.on !== 'function') return () => {}
    let detach
    try {
      detach = ctx.on('agent/request-error', (payload, next) => retryOrPrompt(desk, payload, next))
    } catch (error) {
      warn(ctx, `${name}: the manual-retry listener could not be registered: ${errorMessage(error)}`)
      return () => {}
    }
    return () => {
      try {
        if (typeof detach === 'function') detach()
      } catch {
        // A fiber-scoped disposer may already have run.
      }
      desk.settleAll()
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(mountRetryListener, `${name}: manual-retry listener`)
  } else {
    // Offline doubles without fiber effects still get the listener.
    mountRetryListener()
  }

  // The decision route needs the browser-facing services. A headless Host has
  // no page to answer, so this callback simply never runs there and the plugin
  // still boots; the listener above stays quiet because `shouldOffer` needs a
  // recent `state` poll from that same page.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection', 'webServer'], child => child.effect(() => {
      try {
        return registerRetryChannel(child, desk)
      } catch (error) {
        warn(ctx, `${name}: the manual-retry channel could not be mounted: ${errorMessage(error)}`)
        return () => {}
      }
    }, `${name}: manual-retry channel`))
  }
}
