/**
 * Host half of `dsh-compaction-tuner`: one tune for every agent preset.
 *
 * A profile may declare several `@deepseek-ai/dsh-agent-preset` rows, and each
 * carries its own `compaction-basic` child with its own `thresholdRatio`,
 * `retainRatio`, and `compactionRetries`. Tuning them by hand means editing the
 * same three numbers in every preset patch, and forgetting one preset leaves it
 * on different compaction behavior. This plugin owns those three values in its
 * OWN row and pushes them into every preset row of the active profile, so the
 * page under Settings is the single control and the presets only carry the
 * projection.
 *
 * Mechanism, and why each seam is what it is:
 *
 * - The values are `.volatile()`: a settings edit commits straight into the
 *   running fiber without a remount (`vendor/loader/src/config/entry.ts`
 *   `_commitVolatile`), and the loader then emits `loader/volatile-update` to the
 *   OWNING fiber only (`entry.ts:188-195`). That event is the trigger for a
 *   retune pass, so the presets follow the control while the Host is running.
 * - The push goes through `ctx.configEditor`: `edit(entry, change)` validates the
 *   next config on the row's own fiber runtime before it persists anything
 *   (`packages/boot/config-editor/src/index.ts:102-104,142`), so a per-field
 *   range/step violation is refused by the row's own schema and never reaches the
 *   profile patch.
 * - `retainRatio < thresholdRatio` is a CROSS-field rule and therefore cannot
 *   live in `Config`: `volatileForm()` only descends `type === 'object'`
 *   (`packages/settings/settings/src/schema.ts:37-47`), and any
 *   transform/refine/intersect/union node on the root would yield no settings
 *   section at all. The pair is checked by `tuneProblem()` before any write, and
 *   the page refuses it in its own form.
 * - A preset row that already carries the live values is skipped without a write
 *   (`readTune` compare-and-skip), so an unchanged profile is not rewritten on
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

/** The three values this plugin owns, in the order the form and the patch use. */
const TUNE_KEYS = Object.freeze(['thresholdRatio', 'retainRatio', 'compactionRetries'])

/**
 * Upstream `compaction-basic` code defaults, used for every key a preset's
 * `compaction-basic` child does not declare
 * (`packages/compaction/compaction-basic/src/config.ts:20,23,105`).
 */
export const DEFAULT_TUNE = Object.freeze({
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  compactionRetries: 1,
})

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
 * Exactly three fields, all volatile, all flat numbers: `volatileForm()` only
 * descends an object root, so a transform/refine/union anywhere here would cost
 * the whole settings section. Their per-field shape is also what makes a bad
 * numeric edit impossible to persist — `configEditor.edit()` resolves the row's
 * own fiber runtime before writing, and `.step()`/`.min()`/`.max()` run there.
 *
 * `compactionRetries` uses `natural()` (= `number().step(1).min(0)`), which is
 * what refuses `1.5`.
 */
const z = schemaLibrary

export const Config = z === undefined ? undefined : z.object({
  thresholdRatio: z.number().step(0.01).min(0.01).max(1).default(0.8).volatile(),
  retainRatio: z.number().step(0.01).min(0.01).max(1).default(0.16).volatile(),
  compactionRetries: z.natural().default(1).volatile(),
})

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
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
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
 * @param {'thresholdRatio'|'retainRatio'|'compactionRetries'} key - the field.
 * @returns {unknown} the live value, or the default when the key is absent.
 */
function tuneValue(source, key) {
  const value = volatileValue(source?.[key])
  return value === undefined ? DEFAULT_TUNE[key] : value
}

/**
 * Read the live three values from this plugin's own (possibly wrapped) config.
 *
 * Called at pass time, not captured at `apply()` time: a volatile settings edit
 * is committed into the same config object in place, so this sees the newest
 * value without the plugin having been remounted.
 * @param {object} [config] - the row config.
 * @returns {{thresholdRatio: unknown, retainRatio: unknown, compactionRetries: unknown}}
 *   the live values, with `DEFAULT_TUNE` for absent keys.
 */
export function liveTune(config = {}) {
  return {
    thresholdRatio: tuneValue(config, 'thresholdRatio'),
    retainRatio: tuneValue(config, 'retainRatio'),
    compactionRetries: tuneValue(config, 'compactionRetries'),
  }
}

/**
 * Whether a value is a usable fraction in `(0, 1]`.
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for a finite number strictly above 0 and at most 1.
 */
function isRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
}

/**
 * Diagnose a tune before anything is written.
 *
 * This is the only place the CROSS-field rule lives: `retainRatio` must stay
 * below `thresholdRatio`, which no single schemastery field can express.
 * @param {object} [values] - a tune (possibly volatile-wrapped).
 * @returns {string|undefined} a diagnostic, or `undefined` when the tune is usable.
 */
export function tuneProblem(values = {}) {
  const thresholdRatio = tuneValue(values, 'thresholdRatio')
  const retainRatio = tuneValue(values, 'retainRatio')
  const compactionRetries = tuneValue(values, 'compactionRetries')
  if (!isRatio(thresholdRatio)) {
    return `thresholdRatio must be a finite number in (0, 1], got ${describe(thresholdRatio)}`
  }
  if (!isRatio(retainRatio)) {
    return `retainRatio must be a finite number in (0, 1], got ${describe(retainRatio)}`
  }
  if (!(retainRatio < thresholdRatio)) {
    return `retainRatio (${String(retainRatio)}) must be smaller than thresholdRatio (${String(thresholdRatio)})`
  }
  if (!Number.isInteger(compactionRetries) || compactionRetries < 0) {
    return `compactionRetries must be a non-negative integer, got ${describe(compactionRetries)}`
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
 * @returns {{thresholdRatio: unknown, retainRatio: unknown, compactionRetries: unknown}|undefined}
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
 * Whether two tunes carry the same three values.
 * @param {object} left - one tune.
 * @param {object} right - the other tune.
 * @returns {boolean} true when all three values are identical.
 */
function sameTune(left, right) {
  return TUNE_KEYS.every(key => left[key] === right[key])
}

/**
 * Project a preset row config onto a tune.
 *
 * The clone keeps everything the preset declares — every other child row, every
 * other key of the compaction child, and every `{__jsExpr: "..."}` map — and
 * replaces only the three owned keys of that one child's config.
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
  const tune = {}
  for (const key of TUNE_KEYS) tune[key] = tuneValue(values, key)
  const existing = row.config !== null && typeof row.config === 'object' && !Array.isArray(row.config)
    ? row.config
    : {}
  row.config = { ...existing, ...tune }
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
 * @returns {Promise<{changed: string[], skipped: string[], refused?: string}>}
 *   the ids written, the ids already in tune or out of scope, and the refusal
 *   when the live tune was rejected before any write.
 */
export async function retune(editor, config = {}, warn = () => {}) {
  const values = liveTune(config)
  const problem = tuneProblem(values)
  if (problem !== undefined) {
    warn(`${name}: ${problem}; no preset was changed`)
    return { changed: [], skipped: [], refused: problem }
  }

  const changed = []
  const skipped = []
  const rows = editor?.configuration?.() ?? []
  for (const { entry, inherited } of rows) {
    if (entry?.options?.name !== TARGET_PRESET_PLUGIN) continue
    const id = entry.options.id
    // The editor's own rule: the row's explicit config wins, otherwise the
    // inherited layer is what the preset would run with.
    const effective = hasKeys(entry.options.config) ? entry.options.config : inherited
    const existing = readTune(effective)
    // A preset without a `compaction-basic` child is out of scope: the tuner
    // pushes values into an existing child and never inserts rows into a preset.
    if (existing === undefined || sameTune(existing, values)) {
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
  return { changed, skipped }
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
 * @param {object} [config] - row config.
 * @param {number} [config.thresholdRatio] - request-pressure fraction, default 0.8.
 * @param {number} [config.retainRatio] - verbatim-tail fraction, default 0.16.
 * @param {number} [config.compactionRetries] - retries per compaction, default 1.
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
