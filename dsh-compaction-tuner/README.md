# `dsh-compaction-tuner`

English | [中文](README.zh.md)

A DSH plugin that puts **one** control in Settings for the compaction policy of **every agent
preset in the active profile**. A profile usually declares several
`@deepseek-ai/dsh-agent-preset` rows, each with its own `compaction-basic` child; this plugin owns the
**full eleven-key `compaction-basic` policy surface** in its own row, renders it as the **Compaction
tuner** Settings section, and pushes it into every preset row so all of them run the same tune. Today
those values are edited by hand in each preset patch, and forgetting one preset leaves it on different
compaction behaviour.

Every option is documented and rendered with **both** facts the request asks for:

- its **upstream code default** — the value `compaction-basic` itself resolves to when nothing is set
  (`packages/compaction/compaction-basic/src/config.ts`), stated per field in the page and in the
  *Use* table below; and
- its **allowed range** — the load-time asserts it runs (`validatePolicy` `config.ts:277-304`, `assertRatio` `config.ts:358-361`),
  which its own schema does NOT carry: that `Config` declares **no `.max()`** and leaves the two ratio
  nodes bare `z.number()` (`packages/compaction/compaction-basic/src/index.ts:81,83,117,119`); only the
  token/count nodes carry `.min(0)`/`.min(1)` (`index.ts:82,84,87-89`). So the `(0, 1]` ratio bound
  lives solely in `assertRatio`, and the tuner's schema carries its own bounds and its checks mirror
  the asserts.

**Nothing is seeded.** The bundle inserts the tuner row with no stored values, so the tuner's own
defaults **are** the upstream `compaction-basic` code defaults and a fresh install changes no preset on
its own: a preset whose `compaction-basic` child already omits the eleven keys already runs them, and the
first retune pass skips it with no write. The tune changes only when the user edits a value on the page;
see *Initial values* and *Install behaviour change* below.

The wire format shared by the two halves is frozen in [CONTRACT.md](CONTRACT.md).

## Install behaviour change (read before installing)

The tuner owns **every** `compaction-basic` option and projects its stored tune into each preset row at
the first boot. On a fresh install that tune is the upstream code defaults, and a preset that declares a
**different** value for any of these **ten** keys is overwritten, and the result is written into the
profile's `cordis.patch.yml`: uninstalling the plugin does not revert it, and reverting it means
hand-editing the profile. (A preset that already omits the keys is skipped: the install is a no-op for
it. A profile installed before the seed was removed keeps its stored `0.5 / 0.15 / 2` — see *Initial
values*.)

| Key | What the first pass does to a preset that disagrees |
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

`modelPolicies` is the deliberate exception: an **empty** tuner table leaves each preset's own table
untouched (see *Optional fields and the retention XOR* and the page note), so a preset's per-model
overrides are replaced only when the user enters a non-empty table.

The concrete consequences above are fixtures the offline suite pins: `auto: false → true`,
`summarizationProvider: "local" → ""`, `maxOverflowRetries: 0 → 1`, `headroomTokens: 1234 → 65536`, and
a preset's `retainTokens` deleted in favour of the ratio form.

## Install

The plugin is a profile bundle, not a workspace package. Install it from this repository's root with
the DSH Plugin Manager, which links the directory into the active profile and records the bundle row:

```sh
dsh plugin --profile web add link:"$PWD/dsh-compaction-tuner"
```

In a running GUI session the same step is the `plugin_manager` tool with `action: install_bundle` and
`target: <absolute path to dsh-compaction-tuner>`; `application: "applied"` means the profile changed.
The plugin then loads on the next full page load.

The sibling bundle's README states that a first install needs one Host restart for the client half to
be discovered, and that a `link:`ed client bundle needs a page reload after a rebuild. That reload/HMR
behaviour was **not** re-verified for this plugin (see Limitations).

Beyond a local checkout, the bundle is distributable without a registry: `npm pack` in this directory
produces a tarball that installs by absolute path (or an `https:` URL), and a clone installs by Git with a
subdirectory selector, because this repository has no root `package.json`:

```sh
npm pack    # -> dsh-<name>-<version>.tgz (local only; nothing is published)
```

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/dsh-<name>-<version>.tgz" })
plugin_manager({ action: "install_bundle", target: "git+https://github.com/jinluchang/deepseek-harness-plugins.git#<commit>&path:/dsh-<name>" })
```

Nothing here is published to an npm registry.

## Use

Open Settings (the account menu at the bottom of the sidebar, then **Settings**) and choose
**Compaction tuner**, the last nav row. The page shows one control per owned option, in this order.
The *Accepts* column is the allowed range the Host enforces (or that `compaction-basic` enforces at
load, marked *upstream*); the *Code default* column is the upstream `compaction-basic` resolution
fallback. **That code default is also what this install runs**: the bundle seeds nothing, so the tuner's
stored tune starts at these defaults and the page shows them until a value is edited and saved.

| Option | Meaning | Accepts | Code default |
| --- | --- | --- | --- |
| `thresholdRatio` | Share of the context budget at which compaction triggers. | ratio in (0, 1], step 0.01; upstream accepts any finite `(0, 1]` ratio, the tuner schema admits only 0.01-multiples | `0.8` |
| `headroomTokens` | Extra token headroom beyond the routed output reservation before pressure is measured. | integer >= 0 | `65536` |
| `retainRatio` | Share of the message budget kept as the verbatim tail. | ratio in (0, 1], step 0.01; must stay below `thresholdRatio`; mutually exclusive with `retainTokens` | `0.16` |
| `retainTokens` | Absolute verbatim-tail token budget. | integer >= 0; mutually exclusive with `retainRatio`; the resolved value must stay below the target `thresholdTokens` (upstream, capacity-dependent) | unset (the retainRatio default 0.16 governs) |
| `summarizationProvider` | Provider that writes the summary. | any string; must be set together with `summarizationModel` as an empty or non-empty pair | `''` (inherit the routed target) |
| `summarizationModel` | Model that writes the summary. | any string; same pair rule with `summarizationProvider` | `''` (inherit the routed target) |
| `maxTokens` | Provider generation cap for the summarization request. | integer >= 1; when unset it resolves to the effective `headroomTokens` | unset (derives from headroomTokens: 65536) — the TUNER's headroom, or an explicit tuner cap |
| `compactionRetries` | Extra attempts after the first compaction while pressure stays above the threshold. | integer >= 0 | `1` |
| `maxOverflowRetries` | Attempts after a canonical context overflow; `0` disables overflow recovery. | integer >= 0; `0` disables overflow recovery | `1` |
| `modelPolicies` | Exact-target override table (provider/model picker on the page). | array of `{provider, model, ...policy}`; `provider` and `model` non-empty and unique per entry; per-entry policy fields obey the same rules as the top level; per-entry cap obeys the resolved-cap rule | `[]` |
| `auto` | Automatic step-boundary pressure and overflow-recovery listeners. | true or false | `true` |

`modelPolicies` is the one structured option, and the page edits it without any JSON: the **provider**
and **model** selects are populated from the deployment's own model catalog (read through the nested
`ctx.get('remote.session')` namespace, `session.modelCatalog()` — no provider or model id is hardcoded), **Add
override** appends the selected pair, and each override card carries one labelled box for each of the
nine policy keys —

```
thresholdRatio, headroomTokens, retainRatio, retainTokens, summarizationProvider,
summarizationModel, maxTokens, compactionRetries, maxOverflowRetries
```

— so the entry the page submits is exactly

```json
[
  { "provider": "openai", "model": "gpt-5", "thresholdRatio": 0.7 },
  { "provider": "anthropic", "model": "claude-sonnet-4", "retainTokens": 4096, "compactionRetries": 3 }
]
```

Each entry requires a non-empty `provider` and `model`, may carry any of the nine keys above, may not
carry any other key, and may not repeat a `provider`/`model` pair. The picker cannot add a pair that
already has an override (Add disables), and a saved override whose pair is not in the current catalog
stays listed, is marked *not in the current catalog*, and remains editable and removable. An override
whose nine boxes are all empty changes nothing and is **dropped when you save**; if that leaves no
override, the page submits `unset` for `modelPolicies`. The page refuses an out-of-range box
(a fractional token budget, a ratio at or above the threshold, both retention forms in one entry, a
zero resolved cap) with its own localized message, and the Host re-checks all of it before any preset
is written, so an accepted table cannot abort `compaction-basic`'s own load at runtime.

If the deployment does not expose the model catalog, the page says so (and distinguishes "not
available" from "the read failed") while any saved override keeps working; the rest of the page is
unaffected.

Edit any field and choose **Save**. The page validates the draft locally first (an out-of-range ratio,
a retained tail at or above the threshold, both retention forms at once, an out-of-range per-model box,
or a fractional retry count is refused with a localized message and no Host call), then submits
**one op per option** as **one atomic write** with the revision the page last read. A blank *optional*
field (`retainRatio`, `retainTokens`, `maxTokens`) is submitted as an `unset` op — see *Optional fields
and the retention XOR*. **Save** stays disabled while nothing has changed, while a write is in flight,
and when the deployment reports the namespace read-only. A successful save shows **no separate
confirmation line** — the restart-required notice below the Save button is the post-save message. The
stored values are accurate for the tuner's own namespace, but they are **not** a promise that the preset rows of a running profile re-tune — see *Save and reload semantics*. A refusal by the
Host shows a localized alert and the fields re-seed from whatever the Host reports next. If the
deployment does not serve the `compaction-tuner` namespace, the page says so and disables the fields
instead of pretending to write.

### Optional fields and the retention XOR

`retainRatio` and `retainTokens` are **mutually exclusive** upstream (`config.ts:292-294`): setting
both is a load-time error. The tuner expresses that as "exactly one may hold a value":

- **Neither field holds a value** — the tune is in the ratio form with the code default (`DEFAULT_RETAIN_RATIO` `config.ts:23`, `resolveRetention` `config.ts:220-227`), and the page submits `unset retainRatio` plus `unset retainTokens`.
- **The ratio field holds a value** — the tune is in the ratio form; `retainTokens` is unset.
- **The token field holds a value** — the tune is in the token form; `retainRatio` is unset.

`maxTokens` is the third optional field: blank means "derive it from the effective
`headroomTokens`", which is exactly how upstream resolves it. A blank optional field therefore
**must** be written as `unset`, and the tuner's own `Config` deliberately gives these three fields
**no schemastery `.default()`**: a default is materialized into the running config, and a materialized
`retainRatio` next to an explicit `retainTokens` would make the XOR impossible to detect. A
maintainer adding `.default()` to either retention field silently breaks that rule — the offline suite
asserts its absence.

Because the tuner projects exactly one retention form, a preset that declares `retainTokens` of its
own is moved onto the ratio form (and vice versa) unless the tuner's own field selects the other form.
The one key `withTune()` ever deletes from a preset child is that counterpart.

**`modelPolicies` is the fourth optional field, and empty means unmanaged.** While the tuner's own
table is empty (the default), the projection omits the key entirely: every preset keeps its own
per-model overrides, and `retune()` reports those rows in a separate `unmanaged` list so a skip caused
by this rule is not confused with "already in tune". Entering a non-empty table replaces every preset's
table with it. An explicit "clear every preset's table" is deliberately **not** offered — the empty
table already means "no opinion", and adding a second empty meaning would be ambiguous. Removing the
last override card on the page therefore returns to the default "no opinion" state, not to "clear the
presets".

The background-token budget is validated against the safe-integer range at every layer
(`Number.isSafeInteger`), which makes the tuner **narrower than upstream**: `compaction-basic` accepts
`1e21` and silently loses precision on it, while the tuner refuses anything above
`9007199254740991` and any non-decimal input (`0x10` is not `16` here). That is a deliberate refusal of
silent corruption; see Limitations.

### How `maxTokens` is derived, and which headroom decides it

`maxTokens` is projected as the **tuner row's** `maxTokens ?? headroomTokens` — upstream's own
resolution order (`config.maxTokens ?? headroomTokens` `config.ts:76`), but applied to the tuner's
values, not the preset's. The precise
consequences for a preset whose child omits `maxTokens`:

- the child's resolved cap is preserved when its own `headroomTokens` equals the tuner's (the common
  case, and always the case when the child omitted both);
- when the child's `headroomTokens` differs, the **tuner's** headroom decides the projected cap, and
  the child's old cap is not preserved. A child with `headroomTokens: 1800` under a tuner headroom of
  `65536` is projected `maxTokens: 65536`.

The tuner does not read the child's headroom when deriving the cap. That is the documented projection
rule, not an accident; changing it would be a change to what "one tune for every preset" means.

**After saving, restart the backend.** A saved tune reaches the agent presets at the next DSH backend
start; propagation from the running Host does not work in measured runs (see *Save and reload
semantics*). The page states this in bold — *"Saving stores the values, but they reach the agent presets
only after the DSH backend restarts."* (zh: *"保存只会存下这些值，它们只有在 DSH 后端重启后才会应用到各 Agent
预设。"*) — and offers a **Restart backend** action beside it, or restart DSH yourself.

## Restart action

The page renders the bold restart-required notice in **every** state, and a **Restart backend** action
when the backend reports that it can restart itself. Choosing it opens an inline confirmation (never a
native dialog); confirming interrupts running turns, terminals, and open connections, and the page
reloads itself once the successor answers. If the successor does not answer inside the recovery budget
(20 s for the old listener to disappear, then 60 s for the successor), the page offers a manual
**Reload page** instead of leaving a dead tab. Unmounting the section aborts a restart already crossing
the wire.

The action calls the existing authenticated Connection channel `/backend-restart`, owned by the separate
`dsh-backend-restart` plugin — so this is a **soft runtime dependency, not a required one**:
nothing is imported from that package, this plugin loads and its page works without it, and when the
channel is absent, refuses, or reports `restartable:false`, the page degrades to localized
manual-restart copy ("This deployment cannot restart itself from here. Restart DSH yourself to apply the
saved values."). A per-code refusal (`busy`, `unsupported`, `spawn-failed`, anything else) is shown as
localized copy; the diagnostic `message` from the channel is never rendered. A **transport rejection** is
treated as possibly restarting, because the backend may exit before its reply arrives — the same rule
`dsh-backend-restart/CONTRACT.md` sets for its own client.

The full client contract is frozen in [CONTRACT.md](CONTRACT.md).

## Initial values

The bundle's mount patch seeds **nothing**: it inserts the tuner row with no `config`, so the tuner's
own defaults are the upstream `compaction-basic` code defaults (`DEFAULT_THRESHOLD_RATIO` `config.ts:20`, `DEFAULT_RETAIN_RATIO` `config.ts:23`, `compactionRetries` `config.ts:105`), recorded once in `index.js` `OPTION_SPECS` and documented with their ranges in the *Use* table above. De-seeding was a
deliberate change: the request was to use the system defaults rather than an install-time choice.

They were never carried over from a shipped preset patch. An earlier revision of this file claimed
`packages/bundle/web-app/presets/standard.patch.yml` committed those numbers; that was false. The
standard preset declares its `compaction-basic` child with **no** config of its own
(`compaction-basic` `standard.patch.yml:73-74`), and a grep of every `*.yml`/`*.yaml` in the checkout finds no preset or
bundle row that sets any **compaction-basic** option — only snapshot fixtures under `snapshots/` set
them. (The sibling pruner's `thresholdChars` / `headChars` / `tailChars` **are** set by shipped
presets, e.g. `tailChars` `standard.patch.yml:78-82`; this tuner does not touch that plugin.)

The consequence is a real behaviour statement, not a formality: because `retune()` reads this row's
live values and `withTune()` projects them into every preset's `compaction-basic` child, a preset that
declares none of these keys is already in tune and is **skipped with no write**. A preset that declares
a different value for one of the ten always-projected keys is still overwritten with the tuner's value
(the code default on a fresh install); see *Install behaviour change*.

Comparison is **whole-projection, not per-key**: `sameTune()` compares every key the tune manages, and
a pass writes nothing only when all of them already match. When any one differs, `withTune()` writes
the entire projected set — including keys whose value already equals the default — so a preset with one
stale key gets all ten rewritten (with equal values for the rest).

The page states that rule: each field shows its upstream code default beside its description, and the
note above the fields says the bundle seeds nothing, so those defaults are what a fresh install runs
until a value is edited. `retainRatio` carries **no** schema default — so "unset" stays expressible for
the retention XOR — and its empty input shows the effective code default `0.16` as a placeholder.

**No automatic migration.** A profile that installed an earlier revision of this bundle stored
`thresholdRatio: 0.5`, `retainRatio: 0.15`, `compactionRetries: 2` in its own `cordis.patch.yml` (or a
`--patch` overlay), and already-projected preset children hold those values. Removing the seed does not
rewrite either: the stored row keeps its values and the tuner keeps projecting them, so such a profile
only moves onto the system defaults when the user clears it — uninstalling does not revert the written
profile patch either, and nothing runs on boot.

### Reset to system defaults (the explicit, manual route)

The page has a secondary **Reset to system defaults** action next to **Save** (same enabled/disabled
rule as Save: not ready or not writable, or a write in flight). Choosing it:

1. replaces the whole draft with the **unset** state — every one of the eleven managed fields blank and
   the per-model override table empty — and **writes nothing**;
2. lets the user review it, then **Save** issues the same one atomic mutate, now with an `unset` op for
   **all eleven** managed keys. That is the part that matters: the page otherwise always sets the eight
   materialized code defaults, and those explicit values are exactly what keeps an old row alive. The
   settings layer resolves each `unset` against the `inherited` layer and applies either the deletion
   or a set of the inherited value (`packages/settings/settings/src/index.ts:372-373`); when the
   resulting config deep-equals that inherited layer, the config editor removes the row's `config` from
   the profile patch — and deletes the row itself when only `id`/`name` remain (the `next` it derives at
   `packages/boot/config-editor/src/index.ts:99-100,120-126`). With this bundle's seedless mount patch
   the inherited config is `{}`, so a reset leaves no explicit override at all;
3. the retune pass then resolves the code defaults (`liveTune` on an empty row) and rewrites every
   preset child it manages that still holds other values — this is what moves the stale
   `0.5 / 0.15 / 2` children onto `0.8 / 0.16 / 1`. It still writes explicit code-default keys, so the
   profile patch is **not pristine**: the behaviour becomes the defaults; the file is not emptied.

**Adoption point.** The save itself does not reliably propagate to the preset rows live (see *Save and
reload semantics*); the reliable adoption point is the next boot/recompose. The retune pass **is**
scheduled by the save — the plugin listens to the form's `loader/volatile-update` and to
`app-boot/config-reload` — so the Reset action is not cosmetic; what is unreliable in measured runs is
the live delivery to the preset rows, not the scheduling. HMR watches only the profile
patch, the home patch and the profile `package.json` (`packages/boot/hmr/src/index.ts:384-385,406-407`), so
bundle-code changes are re-read only on a recompose. After pressing Reset and Save, restart the backend
(the page's **Restart backend** action, or your own restart).

**Back up first.** The profile patch is outside version control and has no automatic backup, and the
reset is irreversible from the UI: copy `~/.dsh/profiles/<profile>/cordis.patch.yml` before pressing it.
The action is deliberately explicit and manual — there is **no** automatic migration and no heuristic
that guesses whether stored values were the old seed or a deliberate choice.

The other three shipped presets (`ptc`, `minimal`, `cordis`) commit no compaction config, so the first
pass is a **no-op** for them: their `compaction-basic` children already omit the eleven keys, which is
exactly the tuner's own state on a fresh install. That is the point of the plugin — one tune for every
preset — and with the seed gone the install itself no longer moves them.

## Scope

- Every declaration row in the active profile whose plugin name is `@deepseek-ai/dsh-agent-preset`
  **and** which already has a `compaction-basic` child. This includes presets another bundle adds;
  the tuner matches by plugin name, never by a hardcoded preset id.
- The tuner pushes values into an existing child and **never inserts rows into a preset**. A preset
  without a `compaction-basic` child is out of scope: it is skipped, with no write and no warning.
- Not a per-preset knob, not a change to any other profile, and not a global setting.

The isolated boot runs confirm the name-based match end to end: a `--patch` overlay was propagated in
one boot pass to five preset rows, including a third-party bundle's `preset-lead-agent-only-leads`.

## Save and reload semantics

**The save persists; the presets do not follow it live.** On an isolated instance with a real
`POST /api/settings/mutate`, the write succeeds (`ok:true`, `applies:"live"`), the new values persist
into the profile's `cordis.patch.yml`, and the tuner's own namespace reports them (`autoGenerate:false`
also confirms the auto-form suppression works). But propagation from that save to the preset rows does
not work in measured runs: an earlier loose run saw 2 of 5 identical saves propagate, the retry-only
build propagated **0 of 1** measured rounds, and the candidate-walk build propagated **0 of 1**. In the
failing round the plugin's own timestamps (`Date.now()`, plus a `SAVE_SEEN` line emitted from the
`app-boot/config-reload` listener) recorded **16 empty passes in the 30 s after the save, each
returning the production `{"changed":[],"skipped":[]}`**, and every empty result was followed within
**0–1 ms** by
a probe reporting the editor view at **214 rows containing 5 rows named exactly
`@deepseek-ai/dsh-agent-preset`** — the exact predicate the retune loop filters on, with `undef=0` and
no duplicate ids. The loop's own view and the probe disagree about rows that are demonstrably present,
so the failure is **downstream of editor selection and of the retry**, the cause is unidentified, and
**the plugin cannot address this from its side**. **Edit the values, then restart the backend** — the
page's **Restart backend** action, or your own restart: the save persists, and preset propagation is
reliably effective at the next boot only. `applies:"live"` describes
the settings write, not the presets.

**Both plugin-side defences are shipped, and neither is a fix.** A pass first walks every candidate
configuration editor it can resolve (`configEditorsOf()`, deduplicated by identity) and stops at the
first result that finds anything; if every candidate is empty it retries on the bounded, exported
`RETUNE_BACKOFF = [250, 1000, 3000, 10000]` ms (exported from `index.js`), resetting as soon as a pass sees an
addressable row or a definitive refusal, warning exactly once after the last attempt, and clearing both
timers on disposal. The retry was armed throughout the measured failure and the failure persisted
regardless; the candidate walk changed nothing either. No pre-fix baseline contrast was measured (arm B
never ran), so neither defence is claimed to have moved the rate in either direction.

Two gaps stay recorded rather than papered over: arm B (the pre-fix baseline) was never measured, and in
that round four passes returned a non-empty result while nothing reached the patch, with no breakdown
captured of whether they were `skipped`-only or refusals.

**Boot-time propagation is reliable and idempotent.** At boot the tuner wrote the differing preset rows
in one pass (~262 ms after app-ready); a second boot produced a byte-identical patch; and a `--patch`
overlay propagated to five preset rows, including a third-party bundle's preset, with removing the
overlay restoring the exact earlier patch hash.

New sessions get the new tune once the values have reached the preset rows; **sessions already running
keep the retired revision**, because `compaction-basic` resolves its policy once when a preset mounts and
there is no runtime override path for a preset that is already running.

A retune pass is triggered by the tuner row's **own** volatile commits, by the profile-reconcile
completion signal (`app-boot/config-reload`), and by a preset row activating later. Because
`loader/volatile-update` is dispatched to the owning fiber only, editing a preset row directly on its own
Settings page does **not** retune it; that row is retuned only when it remounts or when the tuner's
values change again.

## Maintenance cost

A patch replaces a row's **whole** config (`overrides` `vendor/include/src/index.ts:120-123`) and preset children
are not addressable, so the tuner must restate each preset's entire `plugins` list in the replacement
config. Any later upstream edit to a shipped preset is silently hidden behind that restatement until the
preset row is reset. Treat the tuner's copies as a fork of the preset patches and run the drift check
after any upstream update: diff the tuner's restated `plugins` list against the shipped preset rows.
This is the dominant cost of the chosen mechanism; a smaller core seam (an addressable preset child, or
a compaction policy read from a service rather than a row) would remove it.

## Verify

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-compaction-tuner/verify.mjs
```

Run from this repository's root (or inside the plugin directory with the same variable exported). The
suite is hermetic — `node:assert/strict`, fake Context doubles, no network, no server — and resolves
the **real** schemastery through `$DSH_HARNESS_CHECKOUT`, so set that variable or the schema checks
cannot run.

**Observed run — green, and still a regression gate.** With the per-model picker and the Reset action
in place, the command above printed `97 passed, 0 failed, 0 skipped (97 checks)` and exited `0` (about
280 ms wall in my measurement, including Node startup). Two consecutive runs in one shell call produced
byte-identical output. The suite grew from 71 to 97 checks: the rewritten and new ones pin the option
table (`Config.dict` is exactly the eleven keys, every field `.volatile()`, the three optional keys
carry no `.default()`), `DEFAULT_TUNE` against the upstream literals, `TUNE_OPTIONS` metadata, the
projection (`maxTokens` derived as `maxTokens ?? headroomTokens`, exactly one retention form, the
counterpart deleted), behaviour preservation (a preset that omits every option is skipped on the code
defaults), the full `tuneProblem()` rule set, the mount patch's **seedless** shape and its corrected
provenance, the page's fresh-install render (code defaults, blank optional fields, the `retainRatio`
placeholder, and `unset` ops for the untouched blanks), the
`volatileForm()` seam that admits the `modelPolicies` array, the unmanaged-`modelPolicies` rules in
both directions, the safe-integer and per-entry-cap rules on both halves, the **per-model picker**
(catalog read through the injected `remote` service with refusal/rejection/missing/empty handling, the
provider-group selects, Add/Remove, duplicate prevention, the all-empty-entry drop, and an
out-of-catalog override surviving a save), the **Reset to system defaults** action (present and disabled
with the same rule as Save, the blanked draft with the per-model table cleared, and the exact one-atomic
`unset` op list for all eleven keys) and its host half (a cleared tuner row re-tunes a stale
`0.5 / 0.15 / 2` preset child onto the code defaults), a **citation check over
README.md and CONTRACT.md that requires every `file:line` reference — including the checkout
targets — to carry the symbol named beside it on a non-comment line of the cited range**, a **table
check that parses the README/CONTRACT option tables and compares each cell against the host metadata
by whole-value equality**, a **locale check that the en and zh dictionaries share a key set, that no
English value contains CJK text, and that the zh modelPolicies copy carries the empty-table
translation**, and the
client half's eleven top-level fields, its en+zh copy parity (each field naming its code default and
range), its local refusals, and its `set`/`unset` op mix. An earlier revision of this document published a `71 passed, 0 failed` run for
the three-option version, and a `40 passed, 16 failed` run before that; all 16 of those failures were
defects in an intermediate draft of the suite. `verify.mjs` deliberately pins no file digests (it
ships as `scripts.verify`), so this file names no digest for the new revision either.

It covers: the manifest; a drift guard that the package name, the client module id, the
`cordis.patch.yml` row name and seedless shape, the loader entry id / namespace, the locale namespace, and
`index.js`'s `name` all agree; a **table check that parses the README and CONTRACT option tables** and
asserts every row's code-default cell carries the host's `defaultText` and its range cell the host's
range clause (so a wrong default or a wrong range in either table fails, not just a missing key); a
**citation check that every `file:line` reference in README.md and CONTRACT.md (workspace files plus
the cited checkout sources) resolves to the symbol named beside it, on a non-comment line**; the host `Config` schema against real schemastery, including the refusals for out-of-shape ratios,
negative, fractional and unsafe token fields, a zero `maxTokens`, a non-boolean `auto`, a non-array
`modelPolicies`, an entry without a provider, and an entry whose resolved cap is not positive; the full
`tuneProblem()` cross-field set; the unmanaged-`modelPolicies` rules in both directions (an empty tuner
table leaves a preset's table intact and is reported in `unmanaged`; a non-empty table replaces it) and
idempotence when the only difference is the unmanaged key; the `retune()` mechanism through a fake
editor, including the candidate-editor walk and the empty-pass retry sequence with its
`RETUNE_BACKOFF` order; the client half evaluated in `node:vm` (exact module id, the
`settings.section` registration, the en+zh dictionary, one labelled top-level control per option in
`TUNE_KEYS` order with the per-model picker in its place, local refusal of every inconsistent draft
with no `mutate` call including hexadecimal and unsafe-integer input, and exactly one `mutate` with one
`set`/`unset` op per option and the snapshot revision); the restart contract (the `<strong>` notice present in the ready, unavailable and loading
states, the probe and its degrade-to-manual path, the inline confirm issuing exactly one
`/backend-restart` call, the down-then-up recovery and reload, the timeout fallback, the unmount abort,
and per-code localized failure copy with no diagnostic text); and a textual check that `client.js`
requests only `require('react')`.

`verify.mjs` starts no live Host and no browser, so a green run says nothing about live preset
propagation — that is a live-instance property, and the isolated runs recorded under *Save and reload
semantics* are the evidence for it. The suite is hermetic and stub-driven: it pins the element tree, the
channel calls, the recovery sequencing and the abort contract, but it does not render in a real browser.
The browser/GUI DOM path (a real DOM render, the nav row, and a save driven through the page) therefore
remains unconfirmed, and neither a real process restart nor a real `location.reload()` has been
exercised on a live profile.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: `OPTION_SPECS` declares all eleven options once (key, kind, code default, allowed range, schemastery field); owns them, finds every agent-preset row, and projects the tune into its `compaction-basic` child. |
| `client.js` | Browser half: the **Compaction tuner** Settings section, one control per option, its single atomic save, and the bold restart-required notice plus **Restart backend** action (soft dependency on `dsh-backend-restart`). |
| `cordis.patch.yml` | Bundle patch that inserts the tuner row with **no seed**, so the tuner runs the upstream code defaults. |
| `locale/en.json`, `locale/zh.json` | Plugin display metadata for the Plugin Manager and Settings inventory. |
| `package.json` | Bundle manifest (`dsh.bundle.patch`, `dsh.client` with the `connection` and model-catalog injects, `exports`, `files`). |
| `verify.mjs` | Hermetic self-check for the manifest, both halves, the option table, the tuning rules, and the restart contract. |
| `CONTRACT.md` | Frozen interface: identity, fields, persistence, tuning rules, limits. |

## Limitations

- **A fresh install is a no-op; a differing preset is still overwritten.** The mount patch seeds nothing,
  so the tuner projects the upstream code defaults, and a preset whose `compaction-basic` child already
  omits the keys is skipped with no write. A preset that declares a **different** value for one of the ten
  always-projected keys is overwritten with the tuner's value. *Install behaviour change* names each key
  and its concrete consequence; `auto: false → true`, `summarizationProvider: "local" → ""`,
  `maxOverflowRetries: 0 → 1`, `headroomTokens: 1234 → 65536`, and a deleted `retainTokens` are the
  fixtures the suite pins. Uninstalling does not revert the written profile patch.
- **No automatic migration for a profile that already stored the old seed.** A profile installed before
  the seed was removed still carries `0.5 / 0.15 / 2` in its own `cordis.patch.yml`, and
  already-projected preset children hold those values; a composed profile may also carry previously
  seeded or projected values from other bundles. This plugin does not retroactively rewrite its own
  stored row and nothing runs on boot, so those profiles keep running the stored values until the user
  clears them with the explicit **Reset to system defaults** action (see *Reset to system defaults*).
  Removing the seed changed the install default only; it deliberately did not touch existing data. The
  reset is irreversible from the UI, the profile patch has no version control or automatic backup, and
  the retune pass still materializes explicit code-default keys, so the file is not pristine after it.
- **Adopting a reset needs a restart/recompose.** HMR watches only the profile patch, the home patch and
  the profile `package.json` (`packages/boot/hmr/src/index.ts:384-385,406-407`); bundle-code changes are
  re-read only on a recompose, and live propagation of a save to the preset rows does not work in
  measured runs. Restart the backend after Reset + Save to be sure the presets moved.
- **The cross-field rules are not in the schema.** `retainRatio < thresholdRatio`, `retainRatio` XOR
  `retainTokens`, the summarization pair, the derived `maxTokens` bound and the `modelPolicies` table
  rules cannot be expressed in schemastery without breaking the settings form, because `volatileForm()`
  only descends a plain object root (`packages/settings/settings/src/schema.ts:37-47`). They are
  enforced by the page before it writes and by `tuneProblem()` before the tuner tunes. A direct
  `settings.mutate` that bypasses the page can persist an inconsistent tuple in the tuner's own row;
  the tuner then refuses to push it into any preset and logs the reason.
- **The retention form is a switch, not two independent knobs.** Setting `retainTokens` moves the whole
  tune onto the token form and removes `retainRatio` from each preset child (and the reverse), because
  upstream rejects the two together (`config.ts:292-294`). A preset that declares its own
  `retainTokens` is therefore moved onto the ratio form unless the tuner's `retainTokens` is set.
- **The retention form cannot be capacity-checked here.** "Resolved `retainTokens` must stay below the
  target `thresholdTokens`" (`config.ts:198-204`) depends on the routed model's context window, which is
  unknown until a turn starts. A `retainTokens` that is too large for one model surfaces as that
  target's load/route error, not as a refusal here.
- **`modelPolicies` is unmanaged while empty, and a whole-table override when not.** An empty tuner
  table means "no opinion": every preset keeps its own per-model overrides, and `retune()` reports those
  rows in `unmanaged` (a subset of `skipped` unless another key changed the row). A **non-empty** tuner
  table replaces every preset's table. The deliberate trade is that there is no way to express "clear
  every preset's table": `[]` already means "leave them alone". The page validates the picker's values
  against the upstream rules (non-empty unique provider/model, no unknown keys, in-range per-entry
  fields, and each entry's resolved cap) before writing, and the Host refuses an invalid table before
  any preset is touched.
- **The tuner's integer range is narrower than upstream's.** `Number.isSafeInteger` is enforced in the
  page and in `tuneProblem()`, and on the derived `maxTokens` too, so `9007199254740993` and `1e21` are
  refused instead of silently rounded, and decimal-only text is required (`0x10` is not accepted as
  `16`). `compaction-basic` itself accepts those values and corrupts them on the way to YAML/JSON; a
  refusal is deliberate here. `-0` is normalized to `0` where a value is already present, never
  materialized for an absent optional field.
- **The page's pre-check is coarser than the Host schema.** It accepts any ratio in `(0, 1]`, while the
  schema requires `0.01`–`1` on a `0.01` step, so an out-of-step value is refused by the Host with the
  generic refused copy rather than a field-specific message. That narrowing is the tuner's own schema:
  `compaction-basic` itself accepts any finite ratio in `(0, 1]` (`config.ts:358-361`), so a value the
  upstream loader would accept can be refused here.
- **Live propagation to the preset rows does not work, and the failure is downstream of editor
  selection.** An earlier loose run saw 2 of 5 identical saves propagate; the retry-only build
  propagated 0 of 1 measured rounds and the candidate-walk build 0 of 1. In the failing round, 16 empty
  passes in the 30 s after the save returned `{"changed":[],"skipped":[]}` while a probe 0–1 ms away
  reported 214 editor rows containing the 5 preset rows the loop filters for — the loop's view and the
  probe disagree about rows that are demonstrably present. The cause is unidentified and the plugin
  cannot address it from its side. **Edit the values, then restart the backend:** a value saved now is
  reliably in force at the next boot, not before it. `applies:"live"` does not imply the presets follow.
- **Neither shipped defence is a fix.** The candidate-editor walk and `RETUNE_BACKOFF` were both armed
  and run, and neither moved the outcome; the pre-fix baseline arm (B) was never measured, so no rate
  change is claimed. Two gaps stay open: arm B, and the four passes in the measured round that returned
  a non-empty result while nothing reached the patch, with no breakdown captured of whether they were
  `skipped`-only or refusals.
- **Live sessions keep the retired revision.** A session already running is not retuned, and it keeps
  the values it started with even after the preset rows are re-tuned; only sessions started afterwards
  use the new values.
- **A directly edited preset row is not retuned while it stays mounted**, because the trigger event is
  fiber-filtered to the tuner's own row.
- **An overlay can block one preset.** If a home patch or `--patch` overlay owns a preset row's id, the
  editor refuses that row's write; the tuner logs it and still tunes the remaining rows. (An overlay
  that merely supplies the tune for other rows does not block them: one boot pass propagated it to five
  preset rows.)
- **The sibling pruner is a recommended FOLLOW-UP, not an oversight.** The `compaction-basic` surface is
  complete (all eleven keys, per-model scope included). `@deepseek-ai/dsh-compaction-tool-result-pruner`
  is a *different plugin* with its own `Config` and its own three options (`thresholdChars`, `headChars`,
  `tailChars`, defaults `8192` / `4096` / `1024`) and a constraint no per-field schema can express
  (`headChars + 39-codepoint PRUNE_MARKER + tailChars <= thresholdChars`). Shipped presets already set
  them (`tailChars` `standard.patch.yml:78-82`), it is a second row family, and this tuner's `withTune()` matches only
  the `compaction-basic` child (`index.js` `COMPACTION_ROW_ID` / `COMPACTION_PLUGIN`) so it never reads
  or writes a pruner row. Making it tunable is a separate change with its own contract.
- **A reliable live-save path, arm B, the four-pass breakdown, the browser/GUI path, a real process
  restart, and a real `location.reload()` are unconfirmed.** The isolated runs exercised the real HTTP
  settings write and real boots, not a browser: no real DOM render, nav row, or page-driven save
  round-trip has been observed here, and no cause has been identified for the live propagation failure.
  The restart action's element tree and channel behaviour are pinned by the hermetic stub suite, but the
  action has not been driven against a real backend from a real page, and neither a real process restart
  nor a real `location.reload()` has been exercised on a live profile. Arm B was never measured, and the
  four non-empty passes had no breakdown captured. HMR for a `link:`ed client bundle is likewise
  unconfirmed.
- **The restart action is a soft dependency.** It calls `dsh-backend-restart`'s channel and
  nothing is imported from that package; a deployment without it loads this plugin and shows the manual
  restart copy instead.
- **Open measurement questions.** First-pass timing and the batching of repeated
  `configEditor.edit` calls are answered empirically by the verification runs (one pass, ~262 ms after
  app-ready, and a byte-identical second boot); the live-session case, the exactly-once behaviour of
  concurrent retune passes beyond the coalescing the suite pins, and HMR for a `link:`ed client bundle
  remain open.
- **No `node_modules`.** If `@deepseek-ai/schemastery` cannot be resolved from any of the plugin's
  anchors, there is no settings namespace and the page shows the unavailable note; the host half still
  pushes raw values.

## License

The bundles in this repository are licensed under **GPL-3.0-or-later**. The canonical GNU GPL v3 text
ships with the package as [LICENSE](LICENSE); the "or later" grant lives in the `license` field of
`package.json` and in this notice, not in the unchanged license text.

Copyright (c) 2026 Luchang Jin.

Nothing here is published to an npm registry: installing a bundle means a local checkout, a local
`npm pack` tarball, or a Git URL pointing at this repository.
