# Frozen interface: `@local/dsh-compaction-tuner`

Package directory: `dsh-compaction-tuner/` (installed into the active DSH profile as a bundle).
Host half: `index.js`. Client half: `client.js`. Mount patch: `cordis.patch.yml`.

## Why this exists

A profile may declare several `@deepseek-ai/dsh-agent-preset` rows, and each one carries its own
`compaction-basic` child with its own policy — `thresholdRatio`, `headroomTokens`, `retainRatio`,
`retainTokens`, `summarizationProvider`, `summarizationModel`, `maxTokens`, `compactionRetries`,
`maxOverflowRetries`, `modelPolicies`, and `auto`. Tuning them by hand means editing the same values in
every preset patch, and forgetting one preset leaves it on different compaction behaviour. This plugin
owns the full key set in its **own** row, renders it as one Settings page, and projects it into every
preset row of the active profile. Each option is documented with its **upstream code default** and its
**allowed range** (`index.js` `OPTION_SPECS`, the single source of both).

Non-goals: it is not a per-preset knob, it does not touch another profile, it is not a global setting,
and it does not touch the separate `@deepseek-ai/dsh-compaction-tool-result-pruner` sibling (its
`thresholdChars` / `headChars` / `tailChars` are out of scope; see *Honest limits*).

## Identity (do not change without updating both halves)

`file:line` references in this document name the revision the contract was written against; the named
symbol is authoritative, and `verify.mjs` pins behaviour rather than line numbers.

| Item | Value |
| --- | --- |
| Package | `@local/dsh-compaction-tuner` |
| Loader entry id | `compaction-tuner` — the row `id` in the profile's `cordis.patch.yml` |
| Settings namespace | `compaction-tuner` — the same id, read with `ctx.configForms.get('compaction-tuner')` |
| Locale namespace | `compaction-tuner` |
| Host `name` export | `compaction-tuner` (`name` `index.js:315`) |
| Client module id | `@local/dsh-compaction-tuner` — the exact package name (`__ModuleLoader__.load` `client.js:54`) |
| Client plugin `name` | `@local/dsh-compaction-tuner` (`name` `client.js:1447`) |
| Host ↔ Client wire | **No RPC channel of its own.** The tuner's values travel over the ui-settings form mirror: `configForms.get('compaction-tuner')` whose `mutate()` calls the Host's `settings.mutate` (`packages/client/ui-settings/src/client/config-form.ts:134`). The restart action separately calls a sibling-owned channel — see *Restart action (soft dependency)*. |
| Host `inject` | `['configEditor', 'loader']` (`inject` `index.js:318`) |
| Client `inject` | `['slots', 'locale', 'configForms', 'connection', 'remote']` (`inject` `client.js:1448`) |
| Restart channel | `/backend-restart`, owned by `@local/dsh-backend-restart`, called through `ctx.get('connection').rpc.call('/backend-restart', endpoint, payload, signal)` |
| Settings slot | `settings.section`, `id: 'compaction-tuner'`, `order: 40`, `locale: 'compaction-tuner'` (`ctx.slots.register` `client.js:1492`) |

The two halves never import each other's values. The Host owns the numbers; the Client reads and
writes them only through the config-form service.

## Config fields (the one namespace, `index.js` `OPTION_SPECS` → `Config`)

Eleven `.volatile()` fields, one per owned option. The root must stay a plain schemastery object:
`volatileForm()` only descends `type === 'object'` (`packages/settings/settings/src/schema.ts:37-47`),
so a transform/refine/intersect/union node anywhere at the root would yield **no settings section at
all**. The `modelPolicies` field is a volatile **array**; that is still supported, because
`volatileForm()` returns a volatile node before it ever looks at `type`.

The *Code default* column is the upstream `compaction-basic` resolution fallback
(`packages/compaction/compaction-basic/src/config.ts:20,23,75-76,102-103,105-108,244-245`); the
*Range (enforced by)* column is the load-time assert. **Precisely:** upstream's own `Config` declares
**no `.max()`** and leaves the two ratio nodes bare `z.number()`
(`packages/compaction/compaction-basic/src/index.ts:81,83,117,119`), so the `(0, 1]` ratio bound lives
ONLY in `assertRatio`; the token/count nodes do carry `.min(0)`/`.min(1)` (`index.ts:82,84,87-89`).
**Nothing is seeded.** `cordis.patch.yml` inserts the row with no `config`, so the *Code default* column
is also the value a fresh install runs, and a preset that omits the keys is already in tune.

| Field | Schemastery shape | Code default | Range (enforced by) |
| --- | --- | --- | --- |
| `thresholdRatio` | `number().step(0.01).min(0.01).max(1).default(0.8).volatile()` | `0.8` | ratio in (0, 1], step 0.01 (upstream `assertRatio`, `config.ts:358-361`); upstream accepts any finite `(0, 1]`, the tuner schema narrows it to 0.01-multiples |
| `headroomTokens` | `number().step(1).min(0).default(65536).volatile()` | `65536` | integer >= 0 (`assertNonNegativeInteger` `config.ts:352-356`) |
| `retainRatio` | `number().step(0.01).min(0.01).max(1).volatile()` — **no default** | `0.16` | ratio in (0, 1], step 0.01 **and below the resolved `thresholdRatio`** (`config.ts:230-241`); mutually exclusive with `retainTokens` (`config.ts:292-294`) |
| `retainTokens` | `number().step(1).min(0).volatile()` — **no default** | unset (the retainRatio default 0.16 governs) | integer `>= 0`; mutually exclusive with `retainRatio`; the resolved value must stay below the target `thresholdTokens` (`config.ts:198-204`, capacity-dependent) |
| `summarizationProvider` | `string().default('').volatile()` | `''` (inherit the routed target) | any string; must be set together with `summarizationModel` as an empty or non-empty pair (`config.ts:306-327`) |
| `summarizationModel` | `string().default('').volatile()` | `''` (inherit the routed target) | any string; same pair rule |
| `maxTokens` | `number().step(1).min(1).volatile()` — **no default** | unset (derives from headroomTokens: 65536) — **DERIVED** `config.maxTokens ?? headroomTokens` (`config.ts:76`), from the TUNER row's headroom | integer >= 1 on the resolved value (`assertPositiveInteger` `config.ts:346-350`) |
| `compactionRetries` | `natural().default(1).volatile()` (= `number().step(1).min(0)`) | `1` | integer >= 0 (`compactionRetries` `config.ts:296-298`) |
| `maxOverflowRetries` | `number().step(1).min(0).default(1).volatile()` | `1` | integer >= 0; 0 disables overflow recovery (`maxOverflowRetries` `config.ts:299-301`) |
| `modelPolicies` | `array(object({provider, model, + the nine policy keys})).default([]).volatile()` | `[]` | array of `{provider, model, ...policy}`; each entry an object with non-empty `provider`/`model`, no unknown keys, duplicate `provider\0model` rejected (`resolveModelPolicies` `config.ts:243-274`, `assertNonEmptyString` `config.ts:340-344`); per-entry policy fields and the entry's RESOLVED cap obey the top-level rules (`policy.maxTokens` `config.ts:83-90`) |
| `auto` | `boolean().default(true).volatile()` | `true` | true or false (`auto` `config.ts:71-73`) |

The accepted `modelPolicies` table, as the page's picker and the Host both check it:

```json
[
  { "provider": "openai", "model": "gpt-5", "thresholdRatio": 0.7 },
  { "provider": "anthropic", "model": "claude-sonnet-4", "retainTokens": 4096, "compactionRetries": 3 }
]
```

The page never accepts or emits JSON text: the provider and model come from `<select>` elements
populated by the deployment's own model catalog, and each override card carries one labelled input per
policy key. Exactly those eleven key names are accepted per entry (`provider`, `model`, plus the nine
policy keys); an unknown key, a missing or empty `provider`/`model`, a duplicate pair, or an
out-of-range entry field is refused before any write. An override whose nine boxes are all empty is
**dropped on save** (a provider/model-only entry would make the table managed while changing nothing),
so a table with no filled override is submitted as `unset`.

`.volatile()` is what makes a save commit into the running fiber without a remount, and what makes
the loader emit `loader/volatile-update` to the owning fiber
(`loader/volatile-update` `vendor/loader/src/index.ts:29-34`, `loader/volatile-update` `vendor/loader/src/config/entry.ts:188-195`). That covers **this
tuner's own namespace**; it does not by itself guarantee that the preset rows follow — see *Live save
behaviour*. The volatile-array field rides the same path: `equalExceptVolatile` short-circuits on
the volatile flag before any type check (`schema?.meta?.volatile` `vendor/loader/src/config/diff.ts:18`), and
`volatileEntries` finds the wrapper at its own path (`vendor/cosmokit/src/volatile.ts:62-76`).

**Why `retainRatio`, `retainTokens` and `maxTokens` carry no `.default()`.** A schemastery default is
materialized into the running config by `resolveConfig`. If `retainRatio` had a default it would
always be present next to an explicit `retainTokens`, the XOR could never be observed, and every token
retention tune would refuse itself. `maxTokens` deliberately stays absent so it can derive from the
headroom exactly like upstream. The page submits a blank optional field as an `unset` op
(`packages/settings/settings/src/index.ts:83,86-110`); adding a `.default()` to any of the three
silently breaks that contract, and `verify.mjs` asserts the absence. Because `retainRatio` is therefore
blank while its effective value is `0.16`, the page shows `0.16` as the input's placeholder; the blank
value still submits `unset`.

The tuner's own pre-write check (`tuneProblem()`) mirrors the upstream asserts and the cross-field
rules; it does not enforce the `0.01` floor/step, which lives in the schema above (the same split as
upstream: `compaction-basic`'s ratios are bare `z.number()` and the bounds are asserts). A `0.005`
retainRatio passes the page's local check and is refused by the Host schema on the way to disk; a
`0.005` entry ratio inside `modelPolicies` is refused by the tuner's schema the same way. See "Honest
limits".

`DEFAULT_TUNE` is the eleven-key upstream code-default set derived from `OPTION_SPECS`; `TUNE_KEYS` is
the key order; `TUNE_OPTIONS` is the public metadata (key, kind, default, default text, range). The
mount patch seeds nothing, so the page note states that a fresh install runs the code defaults rather
than repeating a seed; `verify.mjs` checks the note against that rule.

## Persistence rule

The eleven values live in the **tuner row's `config`** — `compaction-tuner` — in the active profile's
`cordis.patch.yml`. The bundle mount patch seeds nothing, so a fresh install stores no values and the
tuner runs the upstream code defaults; the first save writes the edited values into the profile's own
patch file, which is `PROFILE_PATCH_FILENAME = 'cordis.patch.yml'` (`packages/boot/app-boot/src/profile.ts:41`).
A profile that installed an earlier revision still stores the legacy seed `0.5 / 0.15 / 2` in its own
patch file, and there is **no automatic migration** (see *Install behaviour change* and *Reset to system
defaults*).

### Reset to system defaults (explicit, manual)

The page's secondary **Reset to system defaults** action clears the row explicitly, and only on the
user's Save. It blanks the whole draft (all eleven keys, per-model table included) and writes nothing
itself; Save then emits the same one atomic mutate with an **`unset` op for all eleven managed keys**.
That is required because the page otherwise always sets the eight materialized code defaults, which is
what keeps a legacy row alive. `settings.mutate` resolves each unset against the `inherited` layer and
applies either the deletion or a set of the inherited value
(`packages/settings/settings/src/index.ts:372-373`); the write then calls `configEditor.edit`
(`packages/settings/settings/src/index.ts:390-398`). When the resulting config deep-equals that
inherited layer, the config editor removes the row's `config` from the profile patch — and deletes the
row itself when only `id`/`name` remain (the `next` it derives at
`packages/boot/config-editor/src/index.ts:99-100,120-126`). The retune pass then resolves the code defaults
(`liveTune` on an empty row) and rewrites every managed preset child that holds other values, while a
child that already omits the keys stays skipped. It still writes explicit code-default keys, so the
profile patch is **not pristine** after a reset. The retune pass **is** scheduled by the save itself
(`index.js` subscribes to `loader/volatile-update` and `app-boot/config-reload`), so the action is not
cosmetic; only the live delivery to the preset rows is unreliable in measured runs, and the next
boot/recompose does it reliably. Nothing runs on load or boot: there is no automatic
migration and no seed heuristic.

The tuner then projects the same values into the preset rows the resolved editor reports, matching
`entry.options.name === '@deepseek-ai/dsh-agent-preset'`. "Push" means a whole-config replacement:

- A patch **replaces a row's entire `config`** — the patch loop copies each override key onto the row,
  so a `config` override is not merged (`overrides` `vendor/include/src/index.ts:120-123`).
- Preset **children are not addressable**: the include recursion only indexes rows where
  `entry.group && Array.isArray(entry.config)` (`vendor/include/src/index.ts:69-71`), so a nested
  `compaction-basic` row is never a patch target.
- `withTune()` therefore returns a deep clone of the preset's config in which the existing
  `compaction-basic` child's config is replaced by `{...existing, ...projectedTune(values)}`, with both
  retention keys deleted first so the projection can never leave `retainRatio` and `retainTokens` side
  by side (`config.ts:292-294`). That counterpart deletion is the **only** key `withTune()` ever
  removes. Every other child row, every other key of the compaction child, and every
  `{__jsExpr: "..."}` expression map is preserved verbatim; `deepClone()` passes any value with a
  non-plain prototype through untouched. On write, the editor turns single-key `{__jsExpr}` maps back
  into `!!js` tags (`visit(document` `packages/boot/config-editor/src/index.ts:128-134`).
- `projectedTune(values)` is the exact key set written: the live/default value of each owned key, the
  retention pair resolved to exactly one form, and `maxTokens` resolved as
  `liveMaxTokens ?? liveHeadroomTokens` — upstream's derivation order (`config.maxTokens ?? headroomTokens` `config.ts:76`) applied to the
  **TUNER row's** headroom. The child's resolved cap is therefore preserved **only when the child's own
  `headroomTokens` equals the tuner's** (always true when the child omitted both); when they differ, the
  tuner's headroom decides the projected cap and the child's old cap is not preserved (a child with
  `headroomTokens: 1800` under a tuner headroom of `65536` is projected `maxTokens: 65536`). This is the
  documented projection rule, not an accident; see *Honest limits*.
- `modelPolicies` is projected **only when the live table is non-empty** (`managesModelPolicies()`). An
  empty live table leaves the key out of the projection, so every preset keeps its own per-model table
  and `withTune()` neither replaces nor deletes it. There is deliberately no way to express "clear every
  preset's table": `[]` means "no opinion".
- `withTune()` **throws** when the preset has no compaction child; `retune()` never reaches that throw,
  because it skips such a row first.

`configEditor.edit()` re-validates the next config on the row's own fiber runtime before it writes
anything — `resolveConfig` at `packages/boot/config-editor/src/index.ts:103-104`, atomic write at
`:142` — so a per-field range/step violation never reaches the profile patch.

### Install behaviour change (the ten projected keys)

The tuner owns every `compaction-basic` option and projects its stored tune into each preset row at the
first boot. On a fresh install that stored tune **is** the upstream code defaults, so the install is a
no-op for a preset that already omits the eleven keys; a preset that declares any **other** value is
still overwritten, and the result is persisted into the profile's `cordis.patch.yml`; uninstalling does
not revert it.

| Key | Consequence for a preset that disagrees |
| --- | --- |
| `thresholdRatio` | set to the tuner's value (the code default is `0.8` on a fresh install) |
| `headroomTokens` | set to the tuner's value (`65536` when unset, so `1234 → 65536`) |
| `retainRatio` | written when the tuner is on the ratio form; a stale `retainTokens` is deleted |
| `retainTokens` | written when the tuner is on the token form; a stale `retainRatio` is deleted |
| `summarizationProvider` | set to the tuner's string; `''` clears a preset's local summarizer route (`"local" → ""`) |
| `summarizationModel` | set to the tuner's string, as the other half of the pair |
| `maxTokens` | set to the tuner's resolved cap (`maxTokens ?? headroomTokens`) |
| `compactionRetries` | set to the tuner's value (the code default is `1` on a fresh install) |
| `maxOverflowRetries` | set to the tuner's value (`1` when unset, so a preset's `0` is re-enabled: `0 → 1`) |
| `auto` | set to the tuner's value (`true` when unset, so a manual-only preset is re-enabled: `false → true`) |

**Legacy seed, no migration.** A profile that installed an earlier revision of this bundle stored
`thresholdRatio: 0.5`, `retainRatio: 0.15`, `compactionRetries: 2` in its own `cordis.patch.yml` (or a
`--patch` overlay), and already-projected preset children carry those values. Removing the seed from the
mount patch does **not** rewrite either: the stored row keeps its values, the tuner keeps projecting
them, and `sameTune()` therefore still treats the preset children as in tune. Such a profile moves onto
the code defaults only when the user clears it with the explicit **Reset to system defaults** action
(which unsets all eleven keys; see *Reset to system defaults*); uninstalling does not revert
the written profile patch either.

`modelPolicies` is the deliberate exception: an empty tuner table leaves each preset's own table
untouched (the `unmanaged` report), so per-model overrides are replaced only when the user enters a
non-empty table. There is no expression for "clear every preset's table".

### Live save behaviour (observed)

An isolated instance with a real `POST /api/settings/mutate` confirms the write itself: `ok:true`,
`applies:"live"`, the new values persist into the profile's `cordis.patch.yml`, and the tuner's own
namespace reports them (`autoGenerate:false` also confirms the form suppression). Boot-time propagation
is reliable: the boot pass wrote the differing preset rows in one pass (~262 ms after app-ready), a
second boot produced a byte-identical patch, and a `--patch` overlay propagated to five preset rows
including a third-party bundle's `preset-lead-agent-only-leads`, with removing the overlay restoring the
exact earlier patch hash.

**Propagation from a live save to the preset rows does not work, and neither shipped defence changes
that.** An earlier loose run measured 2 of 5 identical saves propagating. Later, measured single rounds:
the retry-only build propagated **0 of 1**, and the candidate-walk build propagated **0 of 1**. No
pre-fix baseline contrast exists — the A/B stopped on the first arm-A failure, so arm B never ran — and
no claim is made that either change moved the rate.

In the failing round the plugin took its own timestamps (`Date.now()`, plus a `SAVE_SEEN` line emitted
from the `app-boot/config-reload` listener itself) and recorded **16 empty passes in the 30 s after the
save, each returning the production `{"changed":[],"skipped":[]}`**. Every empty result was followed
within **0–1 ms** by a probe that reported the editor view at **214 rows containing 5 rows named
exactly `@deepseek-ai/dsh-agent-preset`** — the exact predicate the retune loop filters on, with
`undef=0` and no duplicate ids. The failure is therefore **downstream of editor selection and of the
retry**: the loop's own view and the surrounding probe disagree about rows that are demonstrably
present. The plugin **cannot address this from its side**, and the cause is unidentified.

Operational guidance: the save persists and applies to the tuner's own namespace, and preset
propagation is reliably effective at the **next boot** only — so edit the values, then restart the
backend (the page's **Restart backend** action, or your own restart).
`applies:"live"` describes the settings write, not the presets.

Two gaps are recorded rather than papered over: **arm B (the pre-fix baseline) was never measured**, and
in that round **four passes returned a non-empty result while nothing reached the patch, with no
breakdown captured** (unknown whether they were `skipped`-only or refusals).

## Host tuning rules (`retune()`)

`retune(editor, config, warn)` returns
`{ changed: string[], skipped: string[], unmanaged: string[], refused?: string }` and drives only an
object shaped like a `ctx.configEditor` (`configuration()` + `edit(entry, change)`), so the mechanism is
testable without a Host. `unmanaged` names the rows whose own `modelPolicies` table was deliberately
left alone because the live table is empty: it is a **subset of `skipped`** (or of `changed`, when
another key differed) and exists so a live-propagation log can tell "left alone by the empty-table rule"
apart from "already in tune".

1. **Read live, then validate first.** The tune is read from the (possibly volatile-wrapped) row config
   at pass time (`liveTune()`), and `tuneProblem()` is run on the **raw** row config — not on the
   derived tune — because `liveTune()` fills the code default for an absent `retainRatio` and the XOR
   rule has to see that the key was not actually set. If `tuneProblem()` reports anything, the pass
   **writes nothing at all**, logs the reason, and returns `refused`. There is never a partial profile.
   The rules it enforces: every per-field bound, each an integer within the SAFE range
   (`SAFE_INTEGER_MAX` `index.js:486`, enforced by `isNonNegativeInteger` `index.js:497`) rather than merely
   `Number.isInteger`; `retainRatio` XOR
   `retainTokens`; `retainRatio` below `thresholdRatio`; the summarization pair; resolved
   `maxTokens = maxTokens ?? headroomTokens` a positive safe integer; and the `modelPolicies` table rules
   (array, non-empty unique provider/model, no unknown keys, per-entry policy fields, and each entry's
   RESOLVED cap positive — mirroring `resolveConfig()`'s per-entry resolution (`policy.maxTokens` `config.ts:83-90`).
2. **Compare-and-skip.** For each preset row: the effective config is `entry.options.config` when it
   has keys, otherwise the `inherited` layer the editor supplied. A row whose effective
   `compaction-basic` child, run through `projectedTune()`, already equals the live tune is **skipped
   with no `edit()` call**, which is what keeps an unchanged profile from being rewritten on every
   pass. A child whose stale `retainTokens` the projection would have to delete counts as out of tune.
   An **unmanaged** `modelPolicies` is always equal (the projection omits the key), so a preset whose
   only difference is its own per-model table is skipped *and* reported in `unmanaged` — the rule that
   keeps the empty-table case from becoming a rewrite loop.
3. **Out of scope, no insert.** A preset row with no `compaction-basic` child at all is also skipped
   (counted in `skipped`, no write, no warning). The tuner pushes into an existing child and never
   inserts rows into a preset.
4. **Isolation.** A rejected `edit()` — for example an id owned by a home patch or a `--patch` overlay
   (`effective` `packages/boot/config-editor/src/index.ts:137-139`) — is caught, logged as a warning naming the
   entry id, and does **not** stop the remaining rows.
5. **Match by plugin name, never by preset id.** No shipped preset id is hardcoded, so any preset row
   in the profile is tuned, including presets a later bundle adds.

### Behaviour preservation (why writing the defaults is a no-op for an untouched preset)

For a preset that declares **none** of the eleven keys, `projectedTune(child)` resolves every key the
same way `projectedTune(tunerRow)` does when the tuner carries only code defaults, so the pass skips
it with no write. That is the executable rule the offline suite pins. The exceptions are honest and
narrow:

- `maxTokens` is derived as `tunerMaxTokens ?? tunerHeadroomTokens`. Its resolved cap is preserved
  **only when the child's own `headroomTokens` equals the tuner's**; otherwise the tuner's headroom
  decides it, and the child's old cap is replaced (documented, not accidental).
- `retainTokens` is only ever projected when the tuner's own `retainTokens` is set; otherwise its
  absence is projected, which is upstream's "retention falls back to `retainRatio`".
- `modelPolicies` is not projected while the live table is empty, so a preset's own table is preserved.
- The mount patch seeds nothing, so a preset that omits every key is genuinely skipped with no write —
  the rule the offline suite pins. A **legacy** profile that still stores the old seed is the one
  exception: its row keeps `0.5 / 0.15 / 2` and the tuner keeps projecting those stored values, with no
  automatic migration. README *Install behaviour change* names every projected key and its consequence.

### Candidate-editor walk (shipped defence, not a fix)

`configEditorsOf()` (`index.js:961`) collects every configuration-editor object the context can
resolve — the guarded `ctx.configEditor` property read first, then the guarded
`ctx.get('configEditor')` lookup — deduplicated by identity. A pass tries each candidate once, in
order, and stops at the first `retune()` result that found anything
(`result.refused` `index.js:1124`: the `result.changed`/`result.skipped`/`result.refused` predicate); a candidate
whose call throws counts as "found nothing" and the next is tried.

This exists because one context was observed handing out **different** editor objects from the property
read and the service lookup inside the same tick (three reads yielded three distinct objects), so a pass
that consults only the first could see zero addressable preset rows while the settings write path, using
another object, saw them all. It is a **defence, not a fix**: the candidate-walk build propagated 0 of 1
measured rounds, exactly like the retry-only build (see *Live save behaviour*).

### Empty-pass retry (shipped defence, not a fix)

When **every** candidate returns `changed=[]` with `skipped=[]` and no refusal, no candidate exposed an
addressable agent-preset row — that is not "nothing to do". The pass then arms the next delay from the
bounded, exported `RETUNE_BACKOFF` (`index.js:295`, defined as `[250, 1000, 3000, 10000]` ms):

- one retry per entry, in order (`retry()`, `index.js:1071`);
- after the last attempt is exhausted, exactly one warning (`retry()` `index.js:1071-1078`);
- the sequence resets as soon as any candidate pass sees an addressable row (any `changed` or `skipped`
  entry) or a definitive refusal, and on any fresh trigger (`schedule()`, `index.js:1052`);
- both the debounce timer and the retry timer are cleared on disposal (`clearRetry()` `index.js:1153-1161`).

It is a defence, **not a fix**: it was armed throughout the measured failure and the failure persisted
regardless (see *Live save behaviour*).

### What triggers a pass (`apply()`, `index.js:1010`)

- `loader/volatile-update`, which the loader dispatches to the **owning fiber only**, i.e. this
  plugin's own volatile commits. A save on the Settings page is what this carries.
- `app-boot/config-reload`, the profile-reconcile completion signal (declared at
  `packages/boot/app-boot/src/index.ts:53`, emitted by `ctx.emit` at `:406`), so a live save is followed even when
  the volatile-diff branch never reports it; the settings service consumes the same event
  (`ctx.on` `packages/settings/settings/src/index.ts:234`).
- `loader/entry-init` for a row whose `name` is `@deepseek-ai/dsh-agent-preset`, so a preset that
  activates later is tuned too (`loader/entry-init` `vendor/loader/src/config/entry.ts:60`).
- One initial pass at mount.

The pass reads its values from the fiber's own resolved config (`ctx.fiber?.config ?? config`,
`values` `index.js:1112`) rather than the object captured at `apply()` time, because a volatile commit may land in
a different object than the one `apply()` received.

Passes are debounced through a single `setTimeout(..., 0)`; one pass runs at a time and a trigger that
arrives mid-pass coalesces into exactly one more pass afterwards. If no candidate editor resolves at
all, the pass logs once and returns without arming a retry (`pass()` `index.js:1097-1103`). These seams make a live
save reach a pass, but they do not make propagation to the preset rows work — see *Live save
behaviour*.

**Limitation:** because `loader/volatile-update` is fiber-filtered, editing a **preset** row directly
on its own Settings page does **not** trigger a retune. That row is retuned only when it remounts
(`loader/entry-init`) or when the tuner's own values change again.

`apply()` also suppresses the auto-generated generic config form for this same row
(`ctx.settings.configure({ auto: false }, ctx.fiber)`, guarded so a policy conflict cannot fail the
boot — `settings.configure` `index.js:1019`), because the bundle ships its own page.

## Client contract

Module artifact: one `window.__ModuleLoader__.load({ id: '@local/dsh-compaction-tuner', factory })`
closure (`__ModuleLoader__.load` `client.js:54`). The factory requests exactly one module-table entry, `react`
(`React` `client.js:57`), and returns `{ name, inject, apply }` with
`inject = ['slots', 'locale', 'configForms', 'connection', 'remote']` (`inject` `client.js:1448`).
`remote` is the client Remote parent service; the plugin resolves the nested session catalog through
`ctx.get('remote.session')` rather than `ctx.get('remote').session`, which cordis rejects with
`cannot get property "remote.session" without inject`.

`apply(ctx)`:

1. `ctx.effect(() => ctx.locale.register('compaction-tuner', { en, zh }), ...)` registers the
   complete English + Chinese dictionary (`ctx.locale.register` `client.js:1457`).
2. `const form = ctx.configForms.get('compaction-tuner')` (`ctx.configForms.get` `client.js:1458`).
3. Resolves the restart caller lazily (`callBackend`, `client.js:1460`): it reads
   `ctx.get('connection')` on every call and rejects when the service or `connection.rpc.call` is
   absent, so a composition without the connection service still registers the page.
4. Wraps the model-catalog read lazily (`readCatalog`, `client.js:1476`): it reads
   `ctx.get('remote.session')` and resolves a refusal envelope when `session.modelCatalog` is absent,
   so a composition without the Remote session service still registers the page and renders the
   "catalog not available" note.
5. Registers the section with a `label` function (required; an omitted label renders an empty nav row),
   `locale: 'compaction-tuner'`, and an inject face exposing `{ form, t, callBackend, readCatalog }`
   (`ctx.slots.register` `client.js:1492`).

The page (`TunerSection`):

- State comes from `React.useSyncExternalStore(form.subscribe, form.getSnapshot)`, with the two
  methods memoized per form so the subscribe identity is stable.
- `status === 'loading'` renders the localized loading text; `status === 'unavailable'` renders the
  localized note with **all eleven fields** disabled and **never attempts a write**; `ready` renders
  one labelled control per owned option, seeded from `snapshot.value` (`seedDraft()`): a numeric input
  for `ratio`/`integer`, a text input for `string`, a checkbox for `auto`, and the composite per-model
  editor for `modelPolicies` (a provider/model picker plus one labelled input per policy key of each
  override card). `retainRatio`, `retainTokens` and `maxTokens` render **blank** when the snapshot
  omits them, because "unset" is a real state the Host schema does not default away. `retainRatio`
  additionally carries its effective code default (`0.16`) as the input's `placeholder`, so the empty
  field and the value in force are both visible without materializing the key into the config.
- The per-model editor reads the catalog once per mount through the injected Remote caller
  (`readCatalog`) and renders the result: a ready catalog renders the provider-group selects and Add;
  a refused reply, a rejection and a missing Remote service each render their own localized note (the
  missing service a distinct "not available" one); an empty catalog renders its note. A saved override
  whose pair is not in the catalog stays listed, marked as out of catalog, and removable; Add is
  disabled for a pair that already has an override.
- The page note above the controls states the rule that the request is about: every field's **upstream
  code default** is shown beside its description, and the bundle seeds nothing, so those code defaults
  are what a fresh install runs until the user edits a value.
- **One atomic write.** The draft is validated locally first (`validateDraft()`): each ratio in
  `(0, 1]`, `retainRatio` XOR `retainTokens`, the effective tail below `thresholdRatio`, the
  summarization pair, resolved `maxTokens = maxTokens ?? headroomTokens >= 1`, both retry counts
  non-negative integers, and each `modelPolicies` entry's raw box text normalized (decimal-only
  numbers, safe integers) and checked against the upstream entry rules — an all-empty entry dropped
  first, an unknown stored key preserved so it is still refused. On failure the page shows the matching
  localized message and calls **no** Host method. On
  success it calls `form.mutate(ops, snapshot.revision)` **once**, where `ops` is one op per owned
  option in `FIELDS` order — `{ op: 'set', … }` for a value, `{ op: 'unset', path: [key] }` for a blank
  optional field. `settings.mutate` applies `unset` by deleting the key
  (`packages/settings/settings/src/index.ts:83,86-110`), which is what restores "unset upstream".
- The Save action is disabled while the namespace is unwritable, while a write is in flight, and while
  the draft equals the snapshot.
- **Reset to system defaults** is a secondary `.dct-outline` button in the same `.dct-actions` row,
  disabled on exactly the Save rule (not-ready/not-writable or a write in flight) and never on
  `!dirty`. Its click stages a blank text for every `FIELDS` entry (`'[]'` for `modelPolicies`) and
  records the snapshot it was staged against; it calls **no** Host method. The reset mode is scoped to
  that snapshot, so a recovery read drops it. While it is active, `validateDraft(draft, true)` accepts a
  blank field of ANY key as `unset` (the cross-field checks resolve a blank threshold/headroom to the
  code defaults `0.8`/`65536`), and Save emits one atomic mutate with `{ op: 'unset', path: [key] }` for
  all eleven `FIELDS` in order. The i18n'd `note.resetDefaults` beside the action states that it writes
  nothing until Save, that presets follow on the next pass, and that there is no automatic migration and
  no undo from the page.
- `mutate` resolving `true` shows no separate confirmation line: the restart-required notice below the
  Save button IS the post-save message. Resolving `false` (or rejecting) shows the localized refused copy
  in a `role="alert"`, and the draft is re-seeded from whatever the Host reports next — the controller
  performs its own recovery read (`mutate` `packages/client/ui-settings/src/client/config-form.ts:129-148`).
  The stored values are accurate for the tuner's own namespace only; they are not a promise that the
  preset rows of a running profile follow, and the presets pick the values up at the next Host start (see *Live save behaviour*).
- Accessibility: real `htmlFor`/`id` pairs via `React.useId()` (one id per field, allocated in a
  fixed-length loop over `FIELDS`), `role="alert"` for failures, no colour-only signalling; no
  `role="status"` node remains, because a successful save adds no separate confirmation line.
- Styling is a component-local `<style>` string inside the section tree, class names namespaced
  `dct-`, and only `--dsw-alias-*` host theme tokens.
- `close` is passed by the shell but this page never calls it.

### Restart contract (Client)

- **Bold notice in every state.** The restart-required fact renders as a real `<strong>`
  (`strongNote` `client.js:1182`, class `dct-restart-note`) inside `restartBlock`, returned in the
  `confirming`, `timeout`, and default (ready/manual/restarting) states alike (`restartBlock` `client.js:1210`),
  part of the `loading` return (`loading` `client.js:1230`), and — in the main render — the last child of
  `dct-page` (`dct-page` `client.js:1410`), directly below the Save button; a successful save adds no
  separate confirmation line, so this notice is the post-save message. The English copy is `restart.note` —
  "Saving stores the values, but they reach the agent presets only after the DSH backend restarts." (`restart.note` `client.js:225`); the Chinese copy is `restart.note` `client.js:326`.
- **Availability probe.** On mount an effect owns an `AbortController` (`client.js:918`) and calls
  `probeRestartable()` (`client.js:798`): `status` on `/backend-restart`, retried up to
  `STATUS_ATTEMPTS` (`client.js:173`, `= 3`) times at `STATUS_RETRY_MS` (`client.js:174`, `= 1000` ms) on a
  transport miss only. A resolved reply is judged by `statusOutcome()` (`client.js:759`): only
  `ok:true` with `value.restartable === true` yields `ready`; anything else yields `manual`, and the
  action is disabled with the localized manual copy beside it (`restart.manual`, `client.js:227`;
  rendered by `manualNote` `client.js:1192`).
- **Inline confirmation.** The action opens a `role="group"` confirm block
  (`confirmBlock` `client.js:1195`); no native dialog is used. Cancel leaves the channel untouched
  (`cancelRestart()`, `client.js:1129`).
- **Exactly one `restart` call.** Confirm (`confirmRestart()`, `client.js:1153`) calls `restart`
  once on `/backend-restart` with the mount controller's signal.
- **Refusals are localized, diagnostics never rendered.** `restartFailureKey()` (`client.js:745`)
  maps `backend-restart/busy`, `.../unsupported`, `.../spawn-failed` to their copy and everything else
  to a generic message; the channel's `message` field is never product text. The refusal renders in a
  `role="alert"` (`restartAlert` `client.js:1183-1185`).
- **Transport rejection means possibly-restarting.** A rejected `restart` call enters recovery rather
  than reporting failure (`recover` `client.js:1176`), because the process may exit before its reply arrives —
  the rule (`transport rejection` `dsh-backend-restart/CONTRACT.md:52`) sets for that channel's own client.
- **Bounded recovery.** `recover()` (`client.js:1141`) runs `awaitSuccessor()` (`client.js:845`):
  poll the document root (`probeRoot()`, `client.js:817`; GET, `cache:'no-store'`, same-origin, 5 s
  probe timeout) until the old listener stops answering, for up to `DOWN_BUDGET_MS = 20000`
  (`DOWN_BUDGET_MS` `client.js:166`), then until the successor answers, for up to `UP_BUDGET_MS = 60000`
  (`UP_BUDGET_MS` `client.js:167`), at `POLL_INTERVAL_MS = 500` (`POLL_INTERVAL_MS` `client.js:168`). `ready` calls
  `window.location.reload()` (`reloadPage` `client.js:1134`); `timeout` renders the manual **Reload page** block
  (`timeoutBlock` `client.js:1204`).
- **Unmount aborts.** The mount effect's cleanup aborts the controller (`controller.abort()` `client.js:927`), and every
  call and poll rides that signal: `delay()` and `probeRoot()` forward the abort
  (`delay()` `client.js:771`, `probeRoot()` `client.js:817`), and `recover()` ignores a result after an abort
  (`signal.aborted` `client.js:1143`).

## Restart action (soft dependency)

The restart action calls the authenticated Connection channel `/backend-restart`
(`dsh-backend-restart/CONTRACT.md:19`), owned and registered by `@local/dsh-backend-restart` and frozen
in that package's CONTRACT.md (`status` / `restart`). This is a **soft runtime dependency, not a
required one**: nothing is imported from that package, the host half never references it, this plugin
loads and its page renders without it, and only the restart action degrades — to the localized manual
copy with the action disabled. The manifest declares the connection client in `dsh.client.inject`
(`package.json`) and the client half injects `connection` (`inject` `client.js:1448`).

## Honest limits

- **The cross-field rules are not in the schema.** `retainRatio < thresholdRatio`, `retainRatio` XOR
  `retainTokens`, the summarization pair, the derived `maxTokens` bound and the `modelPolicies` table
  rules cannot be expressed in schemastery without breaking the settings form, because `volatileForm()`
  only descends a plain object root (`packages/settings/settings/src/schema.ts:37-47`). They are
  enforced by the page before it writes and by `tuneProblem()` before the tuner pushes. A direct
  `settings.mutate` that bypasses the page can therefore persist an inconsistent tuple in the tuner's
  own row — the Host schema validates each field in isolation. The tuner then refuses to push it into
  any preset and logs the reason (`refused`).
- **The retention form is a single switch, not two knobs.** Projecting `retainTokens` deletes
  `retainRatio` from the child (and the reverse), because upstream rejects the two together
  (`config.ts:292-294`). A preset that declares its own `retainTokens` therefore moves to the ratio form
  unless the tuner's `retainTokens` is set.
- **The retention capacity rule cannot be checked before a turn.** "Resolved `retainTokens` must stay
  below the target `thresholdTokens`" (`config.ts:198-204`) needs the routed model's context window.
- **`modelPolicies` is unmanaged while empty and a whole-table override when not.** An empty live table
  leaves every preset's own per-model table untouched (reported in `unmanaged`); a non-empty table
  replaces it. There is deliberately no "clear every preset's table" expression. The page checks the
  picker's box values (including each entry's resolved cap), and `tuneProblem()` re-checks it Host-side before any
  write, mirroring `resolveConfig()`'s per-entry cap resolution (`policy.maxTokens` `config.ts:83-90`), so an accepted
  table cannot abort compaction-basic load at the next boot (`constructor` `index.ts:136-140`) — a property that no
  longer depends on `projectedTune()` happening to emit a top-level `maxTokens`.
- **The integer range is narrower than upstream's.** Every integer field, and the DERIVED `maxTokens`
  value, is checked with `Number.isSafeInteger` Host-side and page-side, so `9007199254740993` and `1e21`
  are refused instead of being silently rounded, and the page requires decimal text (`0x10` is not read
  as `16`). `compaction-basic` itself accepts those values and loses precision on the way to YAML/JSON.
  `-0` is normalized to `0` only where a value is already present, so an absent optional field is never
  materialized.
- **The page's pre-check is coarser than the Host schema.** It accepts any ratio in `(0, 1]`, while the
  schema requires `0.01`–`1` on a `0.01` step; an out-of-step value survives the local check and is
  refused by the Host with the generic refused copy. That narrowing is the tuner's own schema:
  `compaction-basic` accepts any finite ratio in `(0, 1]` (`config.ts:358-361`), so the tuner can refuse
  a value the upstream loader would take.
- **The `compaction-basic` surface is complete; the sibling pruner is a recommended FOLLOW-UP.**
  `@deepseek-ai/dsh-compaction-tool-result-pruner` (`thresholdChars`, `headChars`, `tailChars`, defaults
  `8192` / `4096` / `1024`, with `headChars + 39-codepoint PRUNE_MARKER + tailChars <= thresholdChars`)
  is a different plugin with its own `Config`; shipped presets already set those values
  (`tailChars` `standard.patch.yml:78-82`), and it is a second row family. This contract never matches, reads or
  writes a pruner row — `withTune()` targets only the `compaction-basic` child
  (`COMPACTION_ROW_ID` / `COMPACTION_PLUGIN`). Making it tunable is a separate change with its own
  contract, not an omission here.
- **The reset is explicit, irreversible from the page, and leaves the preset files materialized.** The
  **Reset to system defaults** action is the only migration path: no heuristic runs, nothing happens on
  load or boot, and the click writes nothing until Save. Once saved, the tuner row's `config` is deleted,
  but the retune pass still writes explicit code-default keys into every preset child it manages, so the
  profile patch is not pristine. The page offers no undo, and the profile patch
  (`~/.dsh/profiles/<profile>/cordis.patch.yml`) is outside version control with no automatic backup:
  copy it before pressing Reset. Adoption is a restart/recompose — HMR watches only the profile patch,
  the home patch and the profile `package.json` (`packages/boot/hmr/src/index.ts:384-385,406-407`), and live
  propagation of a save to the preset rows does not work in measured runs.
- **Reload semantics.** New sessions get the new tune once the preset rows carry it; a session already
  running keeps the retired revision, because `compaction-basic` resolves its policy once at mount and
  has no runtime override. Because live propagation does not work, edit the values and restart the
  backend (the page's **Restart backend** action, or your own restart): a saved value is reliably in
  force at the next boot.
- **The restart path has not been exercised end to end.** The element tree, the channel calls, the
  recovery sequencing and the abort contract are pinned by the hermetic stub suite, but no real browser
  render, no real process restart and no real `location.reload()` have been exercised on a live profile.
- **The live-save failure is long-lived, not transient, and is downstream of editor selection.** In the
  measured failing round 16 empty passes in 30 s returned that empty result, while a probe 0–1 ms away
  reported 214 editor rows containing the 5 preset rows the loop filters for. The loop's view and the
  probe disagree about rows that are demonstrably present; the plugin cannot address that from its side
  and the cause is unidentified. Nothing in this interface promises that a live save reaches the preset
  rows.
- **Neither shipped defence is a fix.** The candidate-editor walk (`configEditorsOf()`) and the
  empty-pass retry (`RETUNE_BACKOFF`) are armed and run, but the retry-only build propagated 0 of 1
  measured rounds and the candidate-walk build 0 of 1; the pre-fix baseline arm was never measured, so
  no rate change is claimed in either direction.
- **Two measurement gaps.** Arm B (the pre-fix baseline) was never measured because the A/B stopped on
  the first arm-A failure; and in the measured round four passes returned a non-empty result while
  nothing reached the patch, with no breakdown captured of whether they were `skipped`-only or
  refusals.
- **No live override of a mounted `compaction-basic`.** The plugin can only re-project the preset
  declarations; it cannot change the policy of a preset already running.
- **No `node_modules`.** If `@deepseek-ai/schemastery` resolves from none of the three anchors,
  `Config` is `undefined`: the loader skips validation, there is no settings namespace, the page renders
  the unavailable note, and `apply()` still pushes raw values.
- **Confirmed at runtime.** Isolated instances confirmed the settings write (`ok:true`,
  `applies:"live"`, values persisted into the profile patch and reported by the tuner's own namespace),
  reliable idempotent boot-time propagation, and name-based coverage of a third-party preset brought in
  by a `--patch` overlay. The multi-option projection itself is offline-verified only.
- **Still unconfirmed.** A reliable live-save path (no cause identified); arm B (never measured); the
  breakdown of the four non-empty passes; the browser/GUI path (real DOM render, nav row, page-driven
  save round-trip, including the new per-model picker, its catalog read and the checkbox); a real
  process restart and a real
  `location.reload()` on a live profile; HMR for a `link:`ed client bundle;
  question 2's live-session case; and question 5. The hermetic `verify.mjs` suite is stub-driven and
  starts no Host, so it says nothing about the live path or a real browser; see `README.md` → Verify.

## Build rules

- Plain ESM JavaScript, no build step, no dependencies. The host half resolves schemastery at runtime;
  the manifest ships no `dependencies` so an install step never needs the network.
- The client artifact is hand-rolled: a CJS closure factory around
  `window.__ModuleLoader__.load({ id, factory })`. Keep the baseline externals out — `client.js`
  requests only `react`.
- The restart action is a soft dependency: the manifest declares the `connection` client in
  `dsh.client.inject` and the client half injects `connection`, but nothing is imported from
  `@local/dsh-backend-restart`; only its `/backend-restart` channel is called at runtime.
- `locale/en.json` and `locale/zh.json` carry plugin **display metadata** only
  (`meta.title`, `meta.description`); UI copy comes from the dictionary registered by the client half.
- Style only with `--dsw-alias-*` host theme tokens; do not import Harness client packages.
