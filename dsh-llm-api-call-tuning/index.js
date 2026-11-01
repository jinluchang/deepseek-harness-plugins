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
 * - `retryableCodes`: non-empty array drawn from the five upstream codes,
 *   defaulting to all five (`retry-policy.ts:90,18-22,170-177`).
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

/**
 * Apply the host half.
 *
 * Two independent jobs:
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
}
