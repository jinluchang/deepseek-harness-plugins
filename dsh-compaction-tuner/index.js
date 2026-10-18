/**
 * Host half of `dsh-compaction-tuner`: one tune for every agent preset.
 *
 * A profile may declare several `@deepseek-ai/dsh-agent-preset` rows, and each
 * carries its own `compaction-basic` child with its own policy — the request
 * pressure fraction, the retention budget, the summarization target, the retry
 * counts, the per-model override table, and the on/off switch. Tuning them by
 * hand means editing the same values in every preset patch, and forgetting one
 * preset leaves it on different compaction behavior. This plugin owns the full
 * eleven-key policy surface in its OWN row (`OPTION_SPECS`, each option with its
 * upstream code default and its allowed range) and pushes it into every preset
 * row of the active profile, so the page under Settings is the single control and
 * the presets only carry the projection.
 *
 * Mechanism, and why each seam is what it is:
 *
 * - The values are `.volatile()`: a settings edit commits straight into the
 *   running fiber without a remount (`vendor/loader/src/config/entry.ts`
 *   `_commitVolatile`), and the loader then emits `loader/volatile-update` to the
 *   OWNING fiber only (`entry.ts:188-195`). That event is the trigger for a
 *   retune pass, so the presets follow the control while the Host is running.
 *   A volatile ARRAY field (the `modelPolicies` table) rides the same path:
 *   `equalExceptVolatile` short-circuits on `schema.meta.volatile` before any
 *   type check (`vendor/loader/src/config/diff.ts:14`), and `volatileEntries`
 *   finds the wrapper at its own path (`vendor/cosmokit/src/volatile.ts:62-76`).
 * - The push goes through `ctx.configEditor`: `edit(entry, change)` validates the
 *   next config on the row's own fiber runtime before it persists anything
 *   (`packages/boot/config-editor/src/index.ts:102-104,142`), so a per-field
 *   range/step violation is refused by the row's own schema and never reaches the
 *   profile patch.
 * - The cross-field rules (`retainRatio < thresholdRatio`, `retainRatio` XOR
 *   `retainTokens`, the summarization pair, the derived `maxTokens` bound, and
 *   the `modelPolicies` table rules) cannot live in `Config`:
 *   `volatileForm()` only descends `type === 'object'`
 *   (`packages/settings/settings/src/schema.ts:37-47`), and any
 *   transform/refine/intersect/union node on the root would yield no settings
 *   section at all. They are checked by `tuneProblem()` before any write, and the
 *   page refuses them in its own form.
 * - A preset row that already carries the live values is skipped without a write
 *   (`sameTune` compare-and-skip), so an unchanged profile is not rewritten on
 *   every pass, and a row whose edit is rejected (a home patch or `--patch`
 *   overlay owning that id, `config-editor/src/index.ts:139-141`) is reported and
 *   left alone while the remaining rows are still tuned.
 *
 * The module has no default export: the loader reads `name`, `inject`, `Config`,
 * and `apply` as named bindings.
 *
 * @module @local/dsh-compaction-tuner
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
 * @returns {object|undefined} the library, or `undefined` when no anchor
 *   resolves it. `Config` is then undefined: the loader skips validation, the
 *   page is lost, and `apply()` still pushes raw values.
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

/** The resolved library, or `undefined`: `apply()` still pushes raw values without it. */
const z = schemaLibrary

/**
 * The complete `compaction-basic` policy surface this plugin owns, declared
 * ONCE. The schema, `TUNE_KEYS`, `DEFAULT_TUNE`, `TUNE_OPTIONS`, the
 * `tuneProblem()` rules and the docs all read this table, so a code default or
 * an allowed range cannot drift between them.
 *
 * Every code default is the upstream `compaction-basic` resolution fallback
 * (`packages/compaction/compaction-basic/src/config.ts`), and every range is the
 * upstream load-time assert, because that plugin's own schema carries no bounds:
 *
 * - `thresholdRatio`, `retainRatio`: `assertRatio`, `(0, 1]` (config.ts:358-361,
 *   called at :288,:290); `retainRatio` must additionally resolve below
 *   `thresholdRatio` (config.ts:230-241) and is mutually exclusive with
 *   `retainTokens` (config.ts:292-294). The tuner's own schema narrows both
 *   ratios to a `0.01` step inside `0.01`-`1`, so the page's copy says so.
 * - `headroomTokens`, `retainTokens`: non-negative integers (config.ts:352-356,
 *   :289,:291); `retainRatio` XOR `retainTokens`.
 * - `maxTokens`: `config.maxTokens ?? headroomTokens` (config.ts:76), so its code
 *   default is DERIVED, not a constant: `65536` only while headroom is 65536. The
 *   resolved value must be a positive integer (config.ts:346-350, :77).
 * - `summarizationProvider`/`summarizationModel`: `''` (config.ts:102-103), set
 *   together as an empty or non-empty pair (config.ts:306-327).
 * - `compactionRetries` `1` (config.ts:105), `maxOverflowRetries` `1`
 *   (config.ts:106): non-negative integers (config.ts:296-301).
 * - `modelPolicies` `[]` (config.ts:244-245): array of exact-target overrides
 *   with non-empty, duplicate-free provider/model (config.ts:246-258, :340-344).
 * - `auto` `true` (config.ts:108): boolean (config.ts:71-73).
 *
 * `retainTokens` and `maxTokens` deliberately carry NO schema default: their
 * absence is meaningful (retention falls back to `retainRatio`, `maxTokens` falls
 * back to `headroomTokens`), and a schemastery `.default()` would be materialized
 * into the running config, which would make the `retainRatio` XOR `retainTokens`
 * rule undetectable. `DEFAULT_TUNE` still records their code default as
 * `undefined` — "unset, resolved upstream".
 *
 * `field(z)` is the exact schemastery field, `.volatile()` included: a settings
 * edit commits into the running fiber without a remount.
 */
const OPTION_SPECS = Object.freeze([
  {
    key: 'thresholdRatio',
    kind: 'ratio',
    default: 0.8,
    defaultText: '0.8',
    range: 'ratio in (0, 1], step 0.01',
    field: z => z.number().step(0.01).min(0.01).max(1).default(0.8).volatile(),
  },
  {
    key: 'headroomTokens',
    kind: 'nonNegativeInteger',
    default: 65_536,
    defaultText: '65536',
    range: 'integer >= 0',
    field: z => z.number().step(1).min(0).default(65_536).volatile(),
  },
  {
    key: 'retainRatio',
    kind: 'ratio',
    default: 0.16,
    defaultText: '0.16',
    range: 'ratio in (0, 1], step 0.01; below thresholdRatio; either this or retainTokens',
    field: z => z.number().step(0.01).min(0.01).max(1).volatile(),
  },
  {
    key: 'retainTokens',
    kind: 'nonNegativeInteger',
    default: undefined,
    defaultText: 'unset (the retainRatio default 0.16 governs)',
    range: 'integer >= 0; either this or retainRatio; the resolved value must stay below the target thresholdTokens',
    field: z => z.number().step(1).min(0).volatile(),
  },
  {
    key: 'summarizationProvider',
    kind: 'string',
    default: '',
    defaultText: "'' (inherit the routed target)",
    range: 'string; set together with summarizationModel (both empty = inherit)',
    field: z => z.string().default('').volatile(),
  },
  {
    key: 'summarizationModel',
    kind: 'string',
    default: '',
    defaultText: "'' (inherit the routed target)",
    range: 'string; set together with summarizationProvider (both empty = inherit)',
    field: z => z.string().default('').volatile(),
  },
  {
    key: 'maxTokens',
    kind: 'positiveInteger',
    default: undefined,
    defaultText: 'unset (derives from headroomTokens: 65536)',
    range: 'integer >= 1; when unset it resolves to the effective headroomTokens',
    field: z => z.number().step(1).min(1).volatile(),
  },
  {
    key: 'compactionRetries',
    kind: 'nonNegativeInteger',
    default: 1,
    defaultText: '1',
    range: 'integer >= 0',
    field: z => z.natural().default(1).volatile(),
  },
  {
    key: 'maxOverflowRetries',
    kind: 'nonNegativeInteger',
    default: 1,
    defaultText: '1',
    range: 'integer >= 0 (0 disables overflow recovery)',
    field: z => z.number().step(1).min(0).default(1).volatile(),
  },
  {
    key: 'modelPolicies',
    kind: 'modelPolicies',
    default: Object.freeze([]),
    defaultText: '[]',
    range: 'array of {provider, model, thresholdRatio, headroomTokens, retainRatio, retainTokens, summarizationProvider, summarizationModel, maxTokens, compactionRetries, maxOverflowRetries}; provider and model non-empty and unique per entry',
    field: z => z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: z.number().step(0.01).min(0.01).max(1),
      headroomTokens: z.number().step(1).min(0),
      retainRatio: z.number().step(0.01).min(0.01).max(1),
      retainTokens: z.number().step(1).min(0),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
    })).default([]).volatile(),
  },
  {
    key: 'auto',
    kind: 'boolean',
    default: true,
    defaultText: 'true',
    range: 'true or false',
    field: z => z.boolean().default(true).volatile(),
  },
])

/** The eleven owned keys, in the order the settings page and `withTune()` use. */
export const TUNE_KEYS = Object.freeze(OPTION_SPECS.map(option => option.key))

/**
 * Public option metadata: key, kind, code default, its default text, and the
 * allowed range. This is the single source the client dictionary, README and
 * CONTRACT tables are checked against.
 */
export const TUNE_OPTIONS = Object.freeze(OPTION_SPECS.map(option => Object.freeze({
  key: option.key,
  kind: option.kind,
  default: option.default,
  defaultText: option.defaultText,
  range: option.range,
})))

/**
 * Upstream `compaction-basic` code defaults, used for every key a preset's
 * `compaction-basic` child does not declare
 * (`packages/compaction/compaction-basic/src/config.ts:20,23,75-76,102-103,105-108,244-245`).
 * `undefined` means "unset upstream": retention then falls back to
 * `retainRatio`, and `maxTokens` resolves to `headroomTokens`.
 */
export const DEFAULT_TUNE = Object.freeze(Object.fromEntries(
  OPTION_SPECS.map(option => [option.key, option.default]),
))

/** Plugin name of an agent-preset declaration row. */
export const TARGET_PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

/** Row id of the compaction child inside a preset's plugin list. */
export const COMPACTION_ROW_ID = 'compaction-basic'

/** Plugin name of that child, matched when a profile renamed the row. */
export const COMPACTION_PLUGIN = '@deepseek-ai/dsh-compaction-basic'

/**
 * Backoff between retune retries, in milliseconds: one retry per entry, then a
 * single warning. A pass that finds no agent-preset row at all has answered its
 * trigger but could not see the profile yet, and no further trigger may arrive —
 * the live failure propagated in only some runs for exactly that reason.
 * Exported so the offline suite can assert the sequence without real time.
 */
export const RETUNE_BACKOFF = Object.freeze([250, 1000, 3000, 10000])

/**
 * The schema the settings page renders and the loader validates against.
 *
 * One field per owned option, all volatile: `volatileForm()` only descends an
 * object root, so a transform/refine/union anywhere here would cost the whole
 * settings section. Their per-field shape is also what makes a bad edit
 * impossible to persist — `configEditor.edit()` resolves the row's own fiber
 * runtime before writing, and `.step()`/`.min()`/`.max()` run there.
 *
 * `compactionRetries` uses `natural()` (= `number().step(1).min(0)`), which is
 * what refuses `1.5`. `retainRatio` and `retainTokens` deliberately have no
 * `.default()`: see `OPTION_SPECS`.
 */
export const Config = z === undefined ? undefined : z.object(Object.fromEntries(
  OPTION_SPECS.map(option => [option.key, option.field(z)]),
))

/** Plugin name reported to the Host loader; also the settings and locale namespace. */
export const name = 'compaction-tuner'

/** Services this plugin needs mounted before it can push a tune. */
export const inject = ['configEditor', 'loader']

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
 * Render any value for a diagnostic message.
 * @param {unknown} value - the offending value.
 * @returns {string} a short, JSON-flavored rendering (so strings are quoted).
 */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value)
  if (typeof value === 'boolean' || value === null) return String(value)
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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
 * number). Plain values pass through, for direct callers and tests.
 * @param {unknown} value - the raw or wrapped config field.
 * @returns {unknown} the underlying value, or `undefined` when absent.
 */
export function volatileValue(value) {
  if (value === undefined || value === null) return undefined
  return typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * One tune value, with the code default standing in for an undeclared key.
 * @param {unknown} source - a possibly-volatile config object.
 * @param {string} key - one of `TUNE_KEYS`.
 * @returns {unknown} the live value, or `DEFAULT_TUNE[key]` when the key is
 *   absent (`undefined` for `retainTokens` and `maxTokens`, which are unset
 *   upstream).
 */
function tuneValue(source, key) {
  const value = volatileValue(source?.[key])
  if (value === undefined) return DEFAULT_TUNE[key]
  // `-0` is the same number as `0` but serializes and compares surprisingly;
  // normalize it ONLY here, where a value is already present, so an absent
  // optional field is never materialized (that would break the retention XOR).
  return value === 0 ? 0 : value
}

/**
 * Unwrap every owned field of a possibly-volatile config, preserving absence.
 *
 * `tuneValue()` cannot answer "was this key explicitly set?" for keys that have
 * a code default, and the `retainRatio` XOR `retainTokens` rule needs exactly
 * that: a schemastery `.default()` is materialized into the running config, so
 * presence has to be read from the raw value.
 * @param {unknown} source - a possibly-volatile config object.
 * @returns {Record<string, unknown>} one entry per `TUNE_KEYS`, `undefined` for absent.
 */
export function rawTune(source) {
  const raw = {}
  for (const key of TUNE_KEYS) raw[key] = volatileValue(source?.[key])
  return raw
}

/**
 * Read the live values from this plugin's own (possibly wrapped) config.
 *
 * Called at pass time, not captured at `apply()` time: a volatile settings edit
 * is committed into the same config object in place, so this sees the newest
 * value without the plugin having been remounted.
 * @param {object} [config] - the row config.
 * @returns {Record<string, unknown>} the live values, with `DEFAULT_TUNE` for
 *   absent keys.
 */
export function liveTune(config = {}) {
  const values = {}
  for (const key of TUNE_KEYS) values[key] = tuneValue(config, key)
  return values
}

/**
 * The exact `compaction-basic` child config one tune is projected onto.
 *
 * Three rules do not simply copy a live value:
 *
 * - the retention pair is atomic. When a live `retainTokens` exists the result
 *   carries `retainTokens` and NO `retainRatio`; otherwise it carries
 *   `retainRatio` and NO `retainTokens`, because upstream rejects the two
 *   together (`packages/compaction/compaction-basic/src/config.ts:292-294`).
 * - `maxTokens` is DERIVED when unset, exactly as upstream resolves it:
 *   `config.maxTokens ?? headroomTokens` (`config.ts:76`). It is derived from
 *   the TUNER ROW's effective headroom (or an explicit tuner `maxTokens`), not
 *   from the child's: preserving a child's own resolved cap holds only when the
 *   child's `headroomTokens` equals the tuner's (see CONTRACT "maxTokens
 *   derivation").
 * - `modelPolicies` is UNMANAGED while the live table is empty: the key is
 *   omitted, so a preset's own per-model table is neither replaced nor removed
 *   (`managesModelPolicies()`). A non-empty live table is projected as one
 *   array and replaces whatever the child had.
 * @param {object} [values] - a tune (possibly volatile-wrapped).
 * @returns {Record<string, unknown>} the child keys to write, all defined.
 */
export function projectedTune(values = {}) {
  const headroomTokens = tuneValue(values, 'headroomTokens')
  const retainTokens = tuneValue(values, 'retainTokens')
  const maxTokens = tuneValue(values, 'maxTokens')
  const projected = {
    thresholdRatio: tuneValue(values, 'thresholdRatio'),
    headroomTokens,
    summarizationProvider: tuneValue(values, 'summarizationProvider'),
    summarizationModel: tuneValue(values, 'summarizationModel'),
    maxTokens: maxTokens === undefined ? headroomTokens : maxTokens,
    compactionRetries: tuneValue(values, 'compactionRetries'),
    maxOverflowRetries: tuneValue(values, 'maxOverflowRetries'),
    auto: tuneValue(values, 'auto'),
  }
  if (retainTokens === undefined) projected.retainRatio = tuneValue(values, 'retainRatio')
  else projected.retainTokens = retainTokens
  if (managesModelPolicies(values)) projected.modelPolicies = deepClone(tuneValue(values, 'modelPolicies'))
  return projected
}

/**
 * Whether the live tune manages each preset's `modelPolicies` table.
 *
 * An empty table means "this install expresses no per-model policy", and the
 * tuner then leaves every preset's own table exactly as it found it. There is
 * deliberately no way to express "replace the preset's table with an empty one";
 * that is the documented trade of this rule.
 * @param {object} [values] - a tune (possibly volatile-wrapped).
 * @returns {boolean} false only when the live table is an empty array.
 */
export function managesModelPolicies(values = {}) {
  const policies = tuneValue(values, 'modelPolicies')
  return !(Array.isArray(policies) && policies.length === 0)
}

/**
 * Whether a value is a usable fraction in `(0, 1]`.
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for a finite number strictly above 0 and at most 1.
 */
function isRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
}

/** Largest integer a JS number carries exactly; beyond it, arithmetic rounds silently. */
const SAFE_INTEGER_MAX = 9_007_199_254_740_991

/**
 * Whether a value is an integer `>= 0` that a JS number carries exactly.
 *
 * Stricter than upstream on purpose: upstream's `Number.isInteger(1e21)` passes,
 * and the value then loses precision on its way through YAML/JSON. A refusal is
 * cheaper than silent corruption; see CONTRACT "Honest limits".
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for `0` and every safe positive integer.
 */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Whether a value is an integer `>= 1` that a JS number carries exactly.
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for every safe strictly positive integer.
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** The nine policy keys an exact-target `modelPolicies` entry may mirror. */
const POLICY_TUNE_KEYS = Object.freeze(TUNE_KEYS.filter(key => key !== 'modelPolicies' && key !== 'auto'))

/** The complete accepted key set of one `modelPolicies` entry (config.ts:46-50). */
const MODEL_POLICY_KEYS = Object.freeze(['provider', 'model', ...POLICY_TUNE_KEYS])

/**
 * Validate the policy fields shared by the top level and one `modelPolicies`
 * entry, mirroring `validatePolicy()` (`config.ts:277-304`) and
 * `validateSummarizationPair()` (`config.ts:306-327`).
 * @param {object} source - the candidate policy fields.
 * @param {string} name - the diagnostic name of this scope.
 * @param {number} fallbackThresholdRatio - the threshold a missing
 *   `thresholdRatio` inherits.
 * @param {{maxTokensExplicit: boolean, resolvedMaxTokens: number}} capContext -
 *   the top-level resolution an entry's cap falls back to.
 * @returns {string|undefined} a diagnostic, or `undefined` when usable.
 */
function policyProblem(source, name, fallbackThresholdRatio, capContext) {
  const thresholdRatio = source.thresholdRatio === undefined ? fallbackThresholdRatio : source.thresholdRatio
  if (source.thresholdRatio !== undefined && !isRatio(source.thresholdRatio)) {
    return `${name}.thresholdRatio must be a finite number in (0, 1], got ${describe(source.thresholdRatio)}`
  }
  if (source.headroomTokens !== undefined && !isNonNegativeInteger(source.headroomTokens)) {
    return `${name}.headroomTokens must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(source.headroomTokens)}`
  }
  const hasRatio = source.retainRatio !== undefined
  const hasTokens = source.retainTokens !== undefined
  if (hasRatio && hasTokens) {
    return `${name}: retainRatio and retainTokens are mutually exclusive`
  }
  if (hasRatio && !isRatio(source.retainRatio)) {
    return `${name}.retainRatio must be a finite number in (0, 1], got ${describe(source.retainRatio)}`
  }
  if (hasRatio && !(source.retainRatio < thresholdRatio)) {
    return `${name}.retainRatio (${String(source.retainRatio)}) must be smaller than the resolved thresholdRatio (${String(thresholdRatio)})`
  }
  if (hasTokens && !isNonNegativeInteger(source.retainTokens)) {
    return `${name}.retainTokens must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(source.retainTokens)}`
  }
  if (source.maxTokens !== undefined && !isPositiveInteger(source.maxTokens)) {
    return `${name}.maxTokens must be a positive integer no greater than ${SAFE_INTEGER_MAX}, got ${describe(source.maxTokens)}`
  }
  // Mirror `resolveConfig()`'s per-entry cap resolution (config.ts:83-90): an
  // entry that omits maxTokens takes the top-level cap, except that when the top
  // level itself leaves maxTokens unset an entry with headroomTokens derives its
  // cap from that headroom. Validating it HERE means the tuner never projects a
  // table whose load would throw, rather than relying on projectedTune happening
  // to emit a top-level maxTokens.
  const resolvedCap = source.maxTokens !== undefined
    ? source.maxTokens
    : (capContext.maxTokensExplicit
      ? capContext.resolvedMaxTokens
      : (source.headroomTokens !== undefined ? source.headroomTokens : capContext.resolvedMaxTokens))
  if (!isPositiveInteger(resolvedCap)) {
    return `${name}.maxTokens must resolve to a positive integer no greater than ${SAFE_INTEGER_MAX}, got ${describe(resolvedCap)}`
  }
  if (source.compactionRetries !== undefined && !isNonNegativeInteger(source.compactionRetries)) {
    return `${name}.compactionRetries must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(source.compactionRetries)}`
  }
  if (source.maxOverflowRetries !== undefined && !isNonNegativeInteger(source.maxOverflowRetries)) {
    return `${name}.maxOverflowRetries must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(source.maxOverflowRetries)}`
  }
  const provider = source.summarizationProvider
  const model = source.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') {
    return `${name}.summarizationProvider must be a string, got ${describe(provider)}`
  }
  if (model !== undefined && typeof model !== 'string') {
    return `${name}.summarizationModel must be a string, got ${describe(model)}`
  }
  if (provider !== undefined || model !== undefined) {
    if (provider === undefined || model === undefined || (provider.length === 0) !== (model.length === 0)) {
      return `${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`
    }
  }
  return undefined
}

/**
 * Validate an exact-target `modelPolicies` table, mirroring
 * `resolveModelPolicies()`/`assertModelPolicy()` (`config.ts:243-274`): an array
 * of objects with non-empty `provider`/`model`, no unknown keys, and no
 * duplicate provider/model target.
 * @param {unknown} configured - the candidate table.
 * @param {number} thresholdRatio - the top-level threshold inherited by an entry.
 * @param {{maxTokensExplicit: boolean, resolvedMaxTokens: number}} capContext -
 *   the top-level cap resolution an entry inherits.
 * @returns {string|undefined} a diagnostic, or `undefined` when usable.
 */
function modelPoliciesProblem(configured, thresholdRatio, capContext) {
  if (configured === undefined) return undefined
  if (!Array.isArray(configured)) return `modelPolicies must be an array, got ${describe(configured)}`
  const seen = new Set()
  for (const [index, source] of configured.entries()) {
    const name = `modelPolicies[${index}]`
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      return `${name} must be an object, got ${describe(source)}`
    }
    for (const key of Object.keys(source)) {
      if (!MODEL_POLICY_KEYS.includes(key)) return `${name}: unknown key "${key}"`
    }
    if (typeof source.provider !== 'string' || source.provider.length === 0) {
      return `${name}.provider must be a non-empty string`
    }
    if (typeof source.model !== 'string' || source.model.length === 0) {
      return `${name}.model must be a non-empty string`
    }
    const target = `${source.provider}\u0000${source.model}`
    if (seen.has(target)) return `duplicate model policy for ${source.provider}/${source.model}`
    seen.add(target)
    const problem = policyProblem(source, name, thresholdRatio, capContext)
    if (problem !== undefined) return problem
  }
  return undefined
}

/**
 * Diagnose a tune before anything is written.
 *
 * This is where every CROSS-field rule lives, because no single schemastery
 * field can express them and the root has to stay a plain object:
 * `retainRatio < thresholdRatio` (`config.ts:230-241`), `retainRatio` XOR
 * `retainTokens` (`config.ts:292-294`), the summarization pair
 * (`config.ts:306-327`), the derived `maxTokens` positive-integer rule
 * (`config.ts:76-77`), and the `modelPolicies` table rules
 * (`config.ts:243-274`). The capacity-dependent rule "resolved `retainTokens`
 * must stay below the target `thresholdTokens`" (`config.ts:198-204`) cannot be
 * checked here: it needs the routed model's context window, which is not
 * available before a turn starts.
 * @param {object} [values] - a tune (possibly volatile-wrapped).
 * @returns {string|undefined} a diagnostic, or `undefined` when the tune is usable.
 */
export function tuneProblem(values = {}) {
  const raw = rawTune(values)
  const thresholdRatio = raw.thresholdRatio === undefined ? DEFAULT_TUNE.thresholdRatio : raw.thresholdRatio
  if (!isRatio(thresholdRatio)) {
    return `thresholdRatio must be a finite number in (0, 1], got ${describe(thresholdRatio)}`
  }
  const headroomTokens = raw.headroomTokens === undefined ? DEFAULT_TUNE.headroomTokens : raw.headroomTokens
  if (!isNonNegativeInteger(headroomTokens)) {
    return `headroomTokens must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(headroomTokens)}`
  }
  if (raw.retainRatio !== undefined && raw.retainTokens !== undefined) {
    return 'retainRatio and retainTokens are mutually exclusive'
  }
  if (raw.retainTokens !== undefined) {
    if (!isNonNegativeInteger(raw.retainTokens)) {
      return `retainTokens must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(raw.retainTokens)}`
    }
  } else {
    const retainRatio = raw.retainRatio === undefined ? DEFAULT_TUNE.retainRatio : raw.retainRatio
    if (!isRatio(retainRatio)) {
      return `retainRatio must be a finite number in (0, 1], got ${describe(retainRatio)}`
    }
    if (!(retainRatio < thresholdRatio)) {
      return `retainRatio (${String(retainRatio)}) must be smaller than thresholdRatio (${String(thresholdRatio)})`
    }
  }
  const maxTokens = raw.maxTokens === undefined ? headroomTokens : raw.maxTokens
  if (!isPositiveInteger(maxTokens)) {
    return `maxTokens must resolve to a positive integer no greater than ${SAFE_INTEGER_MAX} (maxTokens ?? headroomTokens), got ${describe(maxTokens)}`
  }
  const compactionRetries = raw.compactionRetries === undefined ? DEFAULT_TUNE.compactionRetries : raw.compactionRetries
  if (!isNonNegativeInteger(compactionRetries)) {
    return `compactionRetries must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(compactionRetries)}`
  }
  const maxOverflowRetries = raw.maxOverflowRetries === undefined ? DEFAULT_TUNE.maxOverflowRetries : raw.maxOverflowRetries
  if (!isNonNegativeInteger(maxOverflowRetries)) {
    return `maxOverflowRetries must be a non-negative integer no greater than ${SAFE_INTEGER_MAX} (the largest safe integer), got ${describe(maxOverflowRetries)}`
  }
  const provider = raw.summarizationProvider === undefined ? DEFAULT_TUNE.summarizationProvider : raw.summarizationProvider
  const model = raw.summarizationModel === undefined ? DEFAULT_TUNE.summarizationModel : raw.summarizationModel
  if (typeof provider !== 'string') {
    return `summarizationProvider must be a string, got ${describe(provider)}`
  }
  if (typeof model !== 'string') {
    return `summarizationModel must be a string, got ${describe(model)}`
  }
  if ((provider.length === 0) !== (model.length === 0)) {
    return 'summarizationProvider and summarizationModel must be set together as an empty or non-empty pair'
  }
  const modelPolicies = raw.modelPolicies === undefined ? DEFAULT_TUNE.modelPolicies : raw.modelPolicies
  const policiesProblem = modelPoliciesProblem(modelPolicies, thresholdRatio, {
    maxTokensExplicit: raw.maxTokens !== undefined,
    resolvedMaxTokens: maxTokens,
  })
  if (policiesProblem !== undefined) return policiesProblem
  const auto = raw.auto === undefined ? DEFAULT_TUNE.auto : raw.auto
  if (typeof auto !== 'boolean') {
    return `auto must be a boolean, got ${describe(auto)}`
  }
  return undefined
}

/**
 * Find the compaction child of a preset row config.
 *
 * A `cordis:group` row keeps its children in a `config` ARRAY, so the search
 * recurses only where that shape actually appears. A row matches by its id or by
 * its plugin name, because a profile may rename either one.
 * @param {object} [config] - the `config` of an `@deepseek-ai/dsh-agent-preset` row.
 * @returns {object|undefined} the matching child row, or `undefined` when the
 *   preset has none.
 */
export function findCompactionRow(config) {
  return searchRows(config?.plugins)
}

/**
 * Depth-first row search used by `findCompactionRow()`.
 * @param {unknown} rows - a candidate plugin list.
 * @returns {object|undefined} the compaction row, when present.
 */
function searchRows(rows) {
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.id === COMPACTION_ROW_ID || row.name === COMPACTION_PLUGIN) return row
    const nested = searchRows(row.config)
    if (nested !== undefined) return nested
  }
  return undefined
}

/**
 * Read the tune a preset row currently runs with.
 * @param {object} [config] - the `config` of a preset row, or its inherited layer.
 * @returns {Record<string, unknown>|undefined}
 *   the effective values of its compaction child (`DEFAULT_TUNE` for keys the
 *   child does not declare), or `undefined` when it has no such child.
 */
export function readTune(config) {
  const row = findCompactionRow(config)
  if (row === undefined) return undefined
  return liveTune(row.config)
}

/**
 * Deep-clone plain data, keeping every other value exactly as it was.
 *
 * `structuredClone` would rebuild a class instance as a plain object; this clone
 * passes anything with a non-plain prototype through untouched, which is what
 * "everything else preserved verbatim" needs for `{__jsExpr: "..."}` maps and
 * any opaque value a profile put in a row.
 * @param {unknown} value - the value to clone.
 * @returns {unknown} the clone.
 */
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone)
  if (value === null || typeof value !== 'object') return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const result = {}
  for (const [key, child] of Object.entries(value)) result[key] = deepClone(child)
  return result
}

/**
 * Whether a config carries any own key, i.e. whether the row's own config
 * overrides the inherited layer.
 * @param {unknown} value - the candidate config.
 * @returns {boolean} true for a non-empty plain record.
 */
function hasKeys(value) {
  return value !== null && typeof value === 'object' && Object.keys(value).length > 0
}

/**
 * Whether two plain data values are structurally identical.
 * @param {unknown} left - one value.
 * @param {unknown} right - the other value.
 * @returns {boolean} true when they carry the same data.
 */
function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  }
  return left === right
}

/**
 * Whether a preset's compaction child already runs the live tune.
 *
 * The comparison is on the PROJECTED child config, so a child that omits a key
 * and a tune carrying that key's code default compare equal (nothing is written),
 * while a stale key the projection excludes — a `retainTokens` on a child whose
 * tune uses the ratio form — counts as out of tune, because `withTune()` has to
 * remove it for the pair to stay legal. This is what keeps an unchanged profile
 * from being rewritten on every pass.
 *
 * Two keys are special:
 *
 * - an UNMANAGED `modelPolicies` (the live table is empty) is always equal: the
 *   projection omits the key, so a preset's own table must NOT count as a
 *   difference, or that preset would be rewritten on every single pass.
 * - a key the tune manages but the child lacks still compares against the
 *   projected default, because `projectedTune()` fills every managed key for
 *   both sides.
 * @param {object} childConfig - the raw config of the preset's compaction child.
 * @param {object} values - the live tune.
 * @returns {boolean} true when no write is needed.
 */
function sameTune(childConfig, values) {
  const existing = projectedTune(childConfig)
  const wanted = projectedTune(values)
  // Every key the live tune manages must already match. `Object.hasOwn` is not
  // needed for the others: projectedTune fills all managed keys on both sides.
  if (!Object.keys(wanted).every(key => sameValue(existing[key], wanted[key]))) return false
  const excluded = Object.hasOwn(wanted, 'retainTokens') ? 'retainRatio' : 'retainTokens'
  return volatileValue(childConfig?.[excluded]) === undefined
}

/**
 * Project a preset row config onto a tune.
 *
 * The clone keeps everything the preset declares — every other child row, every
 * other key of the compaction child, and every `{__jsExpr: "..."}` map — and
 * replaces the owned keys of that one child's config with `projectedTune()`.
 * Both retention keys are removed first, so the projection can never leave
 * `retainRatio` and `retainTokens` side by side (`config.ts:292-294`); that one
 * deletion is the only way this function removes a key.
 * @param {object} config - the preset row's `config` (current or inherited).
 * @param {object} values - the live tune to project.
 * @returns {object} the cloned preset config carrying the tune.
 * @throws {Error} when the preset has no `compaction-basic` child to tune.
 */
export function withTune(config, values) {
  const clone = deepClone(config)
  const row = findCompactionRow(clone)
  if (row === undefined) {
    throw new Error(`no "${COMPACTION_ROW_ID}" child in a "${TARGET_PRESET_PLUGIN}" row`)
  }
  const existing = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)
    ? row.config
    : {}
  const next = { ...existing }
  delete next.retainRatio
  delete next.retainTokens
  row.config = { ...next, ...projectedTune(values) }
  return clone
}

/**
 * Push this plugin's live tune into every agent-preset row of the profile.
 *
 * Runs only through an object shaped like `ctx.configEditor`
 * (`configuration()` + `edit(entry, change)`), so the whole mechanism is
 * testable without a Host.
 *
 * The order of decisions is deliberate:
 *
 * 1. an unusable tune writes NOTHING and returns `refused` — never a partial
 *    profile;
 * 2. a row whose effective config already carries the live values, and a row
 *    with no `compaction-basic` child at all, are skipped with no write, which
 *    is what keeps an unchanged profile untouched;
 * 3. a rejected `edit()` (for example an id owned by a home patch or a
 *    `--patch` overlay, `config-editor/src/index.ts:139-141`) is logged with the
 *    entry id and does not stop the remaining rows.
 * @param {object} editor - the configuration editor (`ctx.configEditor`).
 * @param {object} [config] - this plugin's own possibly-wrapped row config.
 * @param {(message: string) => void} [warn] - warning sink.
 * @returns {Promise<{changed: string[], skipped: string[], unmanaged: string[], refused?: string}>}
 *   the ids written, the ids already in tune or out of scope, the ids whose own
 *   `modelPolicies` table was deliberately left alone because the live table is
 *   empty (a subset of `skipped` unless another key changed the row), and the
 *   refusal when the live tune was rejected before any write.
 */
export async function retune(editor, config = {}, warn = () => {}) {
  const values = liveTune(config)
  const manages = managesModelPolicies(values)
  // Diagnose the RAW config, not `values`: `liveTune()` fills a code default for
  // an absent `retainRatio`, and the XOR rule has to see that the key was not
  // actually set.
  const problem = tuneProblem(config)
  if (problem !== undefined) {
    warn(`${name}: ${problem}; no preset was changed`)
    return { changed: [], skipped: [], unmanaged: [], refused: problem }
  }

  const changed = []
  const skipped = []
  const unmanaged = []
  const rows = editor?.configuration?.() ?? []
  for (const { entry, inherited } of rows) {
    if (entry?.options?.name !== TARGET_PRESET_PLUGIN) continue
    const id = entry.options.id
    // The editor's own rule: the row's explicit config wins, otherwise the
    // inherited layer is what the preset would run with.
    const effective = hasKeys(entry.options.config) ? entry.options.config : inherited
    const child = findCompactionRow(effective)
    // A preset without a `compaction-basic` child is out of scope: the tuner
    // pushes values into an existing child and never inserts rows into a preset.
    if (child === undefined) {
      skipped.push(id)
      continue
    }
    const childConfig = child.config !== null && typeof child.config === 'object' && !Array.isArray(child.config)
      ? child.config
      : {}
    // Reporting, not a decision: when the live table is empty the preset's own
    // per-model table is left alone, and that fact is named separately from a
    // plain "already in tune" skip so a live-propagation log can tell them apart.
    if (!manages && hasModelPolicies(childConfig)) unmanaged.push(id)
    if (sameTune(childConfig, values)) {
      skipped.push(id)
      continue
    }
    try {
      await editor.edit(entry, (current, base) => withTune(
        hasKeys(current) ? current : (base ?? inherited),
        values,
      ))
      changed.push(id)
    } catch (error) {
      warn(`${name}: the preset "${String(id)}" was not tuned: ${errorMessage(error)}`)
    }
  }
  return { changed, skipped, unmanaged }
}

/**
 * Whether a raw compaction child declares a non-empty `modelPolicies` table.
 * @param {object} childConfig - the child's config.
 * @returns {boolean} true when the child carries at least one exact-target override.
 */
function hasModelPolicies(childConfig) {
  const policies = volatileValue(childConfig?.modelPolicies)
  return Array.isArray(policies) && policies.length > 0
}

/**
 * Collect every configuration-editor object this context can resolve, in order,
 * deduplicated by identity, without failing a pass.
 *
 * The measured failure: one context can hand out DIFFERENT editor objects from
 * the property read and from the service lookup inside the same tick (three reads
 * yielded three distinct objects). A pass that consults only the first one can see
 * zero addressable preset rows while the settings write path, using another object,
 * sees them all — and retrying that same resolution path can never repair it. So
 * every resolvable candidate is tried once per pass.
 * @param {object} ctx - the plugin context.
 * @returns {object[]} the distinct editors, in resolution order (property first).
 */
function configEditorsOf(ctx) {
  const candidates = []
  const add = value => {
    if (value === undefined || value === null) return
    if (!candidates.includes(value)) candidates.push(value)
  }
  try {
    add(ctx.configEditor)
  } catch {
    // An uninjected service getter throws; the lookup below is the fallback.
  }
  try {
    add(ctx.get?.('configEditor'))
  } catch {
    // A lookup that throws simply contributes no candidate.
  }
  return candidates
}

/**
 * Apply the tuner to the profile.
 *
 * Pressure comes from three seams, plus the pass that reconciles whatever is
 * already mounted:
 *
 * - `loader/volatile-update` fires on the OWNING fiber when this row's own
 *   volatile config is committed without a remount
 *   (`vendor/loader/src/index.ts:29-34`, `entry.ts:188-195`), which is how a
 *   settings edit reaches the presets while the Host runs;
 * - `app-boot/config-reload` is the profile-reconcile completion signal
 *   (`packages/boot/app-boot/src/index.ts:392,411`), so a live Settings save is
 *   followed even when the volatile-diff branch never reports it;
 * - `loader/entry-init` fires as an entry is constructed (`entry.ts:60`), so a
 *   preset row that activates later is tuned too.
 *
 * Several triggers can land in the same tick, so passes are debounced through
 * one `setTimeout(..., 0)` timer; one pass runs at a time, and a trigger arriving
 * mid-pass coalesces into exactly one more pass afterwards.
 *
 * A pass that finds NO agent-preset row at all is retried on `RETUNE_BACKOFF`:
 * that empty result means the profile was not addressable yet, and the trigger
 * that started the pass may be the only one that ever arrives. The sequence
 * resets on real work and on a fresh trigger, and warns exactly once when the
 * last retry is exhausted.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [config] - row config; every owned option is optional and
 *   falls back to its `DEFAULT_TUNE` code default. See `TUNE_OPTIONS` for each
 *   option's kind, default and allowed range.
 */
export function apply(ctx, config = {}) {
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
      warn(ctx, `${name}: the automatic settings page could not be suppressed: ${errorMessage(error)}`)
      return () => {}
    }
  }))

  /** Pending debounce timer for a fresh trigger, if one is armed. */
  let timer
  /** Pending retry timer for an empty (no addressable preset row) pass, if armed. */
  let retryTimer
  /** Retries already scheduled in the current empty-pass sequence. */
  let attempt = 0
  /** Whether a pass is in flight. */
  let running = false
  /** Whether a trigger arrived while a pass was in flight. */
  let rerun = false
  /** Whether this plugin's effects were disposed. */
  let disposed = false

  /** Cancel a pending retry, if one is armed. */
  function clearRetry() {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  /**
   * Request a pass for a FRESH trigger, coalescing with whatever is already
   * pending. A fresh trigger supersedes any pending retry and restarts the
   * empty-pass sequence, so a burst of reloads cannot stack timers.
   */
  function schedule() {
    if (disposed) return
    clearRetry()
    attempt = 0
    if (running) {
      rerun = true
      return
    }
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void pass()
    }, 0)
  }

  /**
   * Arm the next backoff retry after a pass found no addressable preset row.
   * One retry per `RETUNE_BACKOFF` entry; the last one warns exactly once.
   */
  function retry() {
    if (disposed) return
    if (attempt >= RETUNE_BACKOFF.length) {
      warn(ctx, `${name}: no agent-preset row was addressable after ${RETUNE_BACKOFF.length} retries; the tune may only apply at the next boot`)
      attempt = 0
      return
    }
    const delay = RETUNE_BACKOFF[attempt]
    attempt += 1
    clearRetry()
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (disposed) return
      // A retry must never run concurrently with an in-flight pass; if one
      // somehow exists, it coalesces exactly like a trigger would.
      if (running) {
        rerun = true
        return
      }
      void pass()
    }, delay)
  }

  /**
   * Run one pass to completion, then honor a trigger that arrived meanwhile.
   */
  async function pass() {
    running = true
    try {
      const editors = configEditorsOf(ctx)
      if (editors.length === 0) {
        warn(ctx, `${name}: no configuration editor is mounted, so no preset was tuned`)
        return
      }
      // The observed failure: a live Settings save reported `applies: "live"`
      // and did reach the running config, yet the preset rows kept the retired
      // tune until the next boot. The loader commits volatile values into the
      // refs it finds in `fiber.config` (`vendor/loader/src/config/entry.ts:164-186`),
      // and that is not necessarily the object `apply` captured, so read the
      // pass's values from the fiber's own resolved config at pass time, keeping
      // the captured object as the fallback for a context without a fiber.
      const values = ctx.fiber?.config ?? config
      // Try each resolvable editor once, in order, and stop at the first result
      // that found anything. A candidate whose `configuration()` throws counts as
      // "found nothing": the next one is tried and the throw never escapes.
      let found = false
      for (const editor of editors) {
        let result
        try {
          result = await retune(editor, values, message => warn(ctx, message))
        } catch {
          continue
        }
        if (result.changed.length > 0 || result.skipped.length > 0 || result.refused !== undefined) {
          found = true
          break
        }
      }
      if (found) {
        // The profile was addressable: real work, or a definitive refusal. The
        // empty-pass sequence is over, so the next one starts from the top.
        attempt = 0
        clearRetry()
        return
      }
      // EVERY candidate returned `changed=[] skipped=[] refused=undefined`, which
      // can only mean none of them exposed an agent-preset row: the pass answered
      // its trigger but could not see the profile yet. The live save propagates
      // only sometimes, and once the trigger is consumed nothing else may arrive,
      // so retry with backoff instead of treating this as "nothing to do".
      retry()
    } catch (error) {
      warn(ctx, `${name}: the retune pass failed: ${errorMessage(error)}`)
    } finally {
      running = false
      if (rerun) {
        rerun = false
        schedule()
      }
    }
  }

  ctx.effect(() => () => {
    disposed = true
    rerun = false
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    clearRetry()
  }, `${name}: retune pass`)

  // This plugin's own volatile commits: the settings form's live values.
  ctx.on('loader/volatile-update', () => schedule())
  // The settings-write path's OWN completion signal. `configEditor.edit()`
  // reconciles the profile patch through `reconcileProfilePatches`, which
  // updates the include entry and then emits this once every entry update
  // settled (`packages/boot/app-boot/src/index.ts:392,411`; declared at `:54`,
  // and the settings service consumes it the same way at
  // `packages/settings/settings/src/index.ts:234`). Subscribing here is what
  // makes a live save propagate even when the volatile-diff branch above never
  // reports a change, which is the failure the isolated run reproduced. It
  // cannot ping-pong: a pass that changes nothing performs no `edit()`, so
  // nothing reconciles and no further reload is emitted.
  ctx.on('app-boot/config-reload', () => schedule())
  // A preset row that activates later still gets tuned.
  ctx.on('loader/entry-init', entry => {
    if (entry?.options?.name === TARGET_PRESET_PLUGIN) schedule()
  })

  schedule()
}
