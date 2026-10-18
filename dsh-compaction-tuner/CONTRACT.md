# Frozen interface: `@local/dsh-compaction-tuner`

Package directory: `dsh-compaction-tuner/` (installed into the active DSH profile as a bundle).
Host half: `index.js`. Client half: `client.js`. Mount patch: `cordis.patch.yml`.

## Why this exists

A profile may declare several `@deepseek-ai/dsh-agent-preset` rows, and each one carries its own
`compaction-basic` child with its own `thresholdRatio`, `retainRatio`, and `compactionRetries`.
Tuning them by hand means editing the same three numbers in every preset patch, and forgetting one
preset leaves it on different compaction behaviour. This plugin owns the three values in its **own**
row, renders them as one Settings page, and pushes them into every preset row of the active profile.

Non-goals: it is not a per-preset knob, it does not touch another profile, and it is not a global
setting.

## Identity (do not change without updating both halves)

| Item | Value |
| --- | --- |
| Package | `@local/dsh-compaction-tuner` |
| Loader entry id | `compaction-tuner` — the row `id` in the profile's `cordis.patch.yml` |
| Settings namespace | `compaction-tuner` — the same id, read with `ctx.configForms.get('compaction-tuner')` |
| Locale namespace | `compaction-tuner` |
| Host `name` export | `compaction-tuner` (`index.js:153`) |
| Client module id | `@local/dsh-compaction-tuner` — the exact package name (`client.js:32`) |
| Client plugin `name` | `@local/dsh-compaction-tuner` (`client.js:715`) |
| Host ↔ Client wire | **No RPC channel of its own.** The tuner's values travel over the ui-settings form mirror: `configForms.get('compaction-tuner')` whose `mutate()` calls the Host's `ctx.remote.settings.mutate('compaction-tuner', ops, revision)` (`packages/client/ui-settings/src/client/config-form.ts:134`). The restart action separately calls a sibling-owned channel — see *Restart action (soft dependency)*. |
| Host `inject` | `['configEditor', 'loader']` (`index.js:156`) |
| Client `inject` | `['slots', 'locale', 'configForms', 'connection']` (`client.js:716`) |
| Restart channel | `/backend-restart`, owned by `@local/dsh-backend-restart`, called through `ctx.get('connection').rpc.call('/backend-restart', endpoint, payload, signal)` (`client.js:735`) |
| Settings slot | `settings.section`, `id: 'compaction-tuner'`, `order: 40`, `locale: 'compaction-tuner'` (`client.js:737-745`) |

The two halves never import each other's values. The Host owns the numbers; the Client reads and
writes them only through the config-form service.

## Config fields (the one namespace, `index.js:146-150`)

Exactly three flat `.volatile()` fields. The root must stay a plain schemastery object: `volatileForm()`
only descends `type === 'object'` (`packages/settings/settings/src/schema.ts:37-47`), so a
transform/refine/intersect/union node anywhere at the root would yield **no settings section at all**.

| Field | Schemastery shape | Constraint the Host schema enforces | Default |
| --- | --- | --- | --- |
| `thresholdRatio` | `z.number().step(0.01).min(0.01).max(1).default(0.8).volatile()` | number, `0.01`–`1`, step `0.01` | `0.8` |
| `retainRatio` | `z.number().step(0.01).min(0.01).max(1).default(0.16).volatile()` | number, `0.01`–`1`, step `0.01` | `0.16` |
| `compactionRetries` | `z.natural().default(1).volatile()` (`natural()` = `number().step(1).min(0)`) | integer, `>= 0` | `1` |

`.volatile()` is what makes a save commit into the running fiber without a remount, and what makes
the loader emit `loader/volatile-update` to the owning fiber
(`vendor/loader/src/index.ts:29-34`, `vendor/loader/src/config/entry.ts:188-195`). That covers **this
tuner's own namespace**; it does not by itself guarantee that the preset rows follow — see *Live save
behaviour*.

The tuner's own pre-write check (`tuneProblem()`, `index.js:253-270`) is coarser than the schema: it
accepts any finite number in `(0, 1]` and any non-negative integer, so it does **not** enforce the
`0.01` floor/step. A `0.005` or `0.155` ratio passes the page's local check and is then refused by
the Host schema on the way to disk. See "Honest limits".

`DEFAULT_TUNE` (`index.js:108-112`) is the upstream `compaction-basic` code default set,
`{thresholdRatio: 0.8, retainRatio: 0.16, compactionRetries: 1}`, taken from
`packages/compaction/compaction-basic/src/config.ts:20,23,105`. It stands in for every key a preset's
compaction child does not declare.

## Persistence rule

The three values live in the **tuner row's `config`** — `compaction-tuner` — in the active profile's
`cordis.patch.yml`. The bundle mount patch seeds them (`cordis.patch.yml:15-21`, `0.5 / 0.15 / 2`);
after the first save they live in the profile's own patch file, which is
`PROFILE_PATCH_FILENAME = 'cordis.patch.yml'` (`packages/boot/app-boot/src/profile.ts:40`).

The tuner then pushes the same three values into the preset rows the resolved editor reports, matching
`entry.options.name === '@deepseek-ai/dsh-agent-preset'` (`index.js:115,417`). "Push" means a
whole-config replacement:

- A patch **replaces a row's entire `config`** — the patch loop copies each override key onto the row,
  so a `config` override is not merged (`vendor/include/src/index.ts:120-123`).
- Preset **children are not addressable**: the include recursion only indexes rows where
  `entry.group && Array.isArray(entry.config)` (`vendor/include/src/index.ts:69-71`), so a nested
  `compaction-basic` row is never a patch target.
- `withTune()` therefore returns a deep clone of the preset's config in which **only** the three owned
  keys of the existing `compaction-basic` child change (`index.js:366-379`). Every other child row,
  every other key of the compaction child, and every `{__jsExpr: "..."}` expression map is preserved
  verbatim; `deepClone()` passes any value with a non-plain prototype through untouched
  (`index.js:325-333`). On write, the editor turns single-key `{__jsExpr}` maps back into `!!js` tags
  (`packages/boot/config-editor/src/index.ts:129-134`).
- `withTune()` **throws** when the preset has no compaction child (`index.js:369-371`); `retune()`
  never reaches that throw, because it skips such a row first.

`configEditor.edit()` re-validates the next config on the row's own fiber runtime before it writes
anything — `resolveConfig` at `packages/boot/config-editor/src/index.ts:103-104`, atomic write at
`:142` — so a per-field range/step violation never reaches the profile patch.

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

## Host tuning rules (`retune()`, `index.js:405-440`)

`retune(editor, config, warn)` returns `{ changed: string[], skipped: string[], refused?: string }`
and drives only an object shaped like a `ctx.configEditor` (`configuration()` + `edit(entry, change)`),
so the mechanism is testable without a Host.

1. **Read live, then validate first.** The live tune is read from the (possibly volatile-wrapped) row
   config at pass time. If `tuneProblem()` reports anything, the pass **writes nothing at all**, logs
   the reason, and returns `refused`. There is never a partial profile.
2. **Compare-and-skip.** For each preset row: the effective config is `entry.options.config` when it
   has keys, otherwise the `inherited` layer the editor supplied (`index.js:421`). A row whose
   effective `compaction-basic` child already carries the live three values is **skipped with no
   `edit()` call** (`index.js:425-428`), which is what keeps an unchanged profile from being rewritten
   on every pass.
3. **Out of scope, no insert.** A preset row with no `compaction-basic` child at all is also skipped
   (counted in `skipped`, no write, no warning). The tuner pushes into an existing child and never
   inserts rows into a preset.
4. **Isolation.** A rejected `edit()` — for example an id owned by a home patch or a `--patch` overlay
   (`packages/boot/config-editor/src/index.ts:139-141`) — is caught, logged as a warning naming the
   entry id, and does **not** stop the remaining rows (`index.js:429-437`).
5. **Match by plugin name, never by preset id.** No shipped preset id is hardcoded, so any preset row
   in the profile is tuned, including presets a later bundle adds.

### Candidate-editor walk (shipped defence, not a fix)

`configEditorsOf()` (`index.js:455-472`) collects every configuration-editor object the context can
resolve — the guarded `ctx.configEditor` property read first, then the guarded
`ctx.get('configEditor')` lookup — deduplicated by identity. A pass tries each candidate once, in
order, and stops at the first `retune()` result that found anything
(`changed.length > 0 || skipped.length > 0 || refused !== undefined`, `index.js:611-623`); a candidate
whose call throws counts as "found nothing" and the next is tried.

This exists because one context was observed handing out **different** editor objects from the property
read and the service lookup inside the same tick (three reads yielded three distinct objects), so a pass
that consults only the first could see zero addressable preset rows while the settings write path, using
another object, saw them all. It is a **defence, not a fix**: the candidate-walk build propagated 0 of 1
measured rounds, exactly like the retry-only build (see *Live save behaviour*).

### Empty-pass retry (shipped defence, not a fix)

When **every** candidate returns `changed=[]` with `skipped=[]` and no refusal, no candidate exposed an
addressable agent-preset row — that is not "nothing to do". The pass then arms the next delay from the
bounded, exported `RETUNE_BACKOFF = [250, 1000, 3000, 10000]` ms (`index.js:123-130`):

- one retry per entry, in order (`retry()`, `index.js:566-587`);
- after the last attempt is exhausted, exactly one warning (`index.js:568-569`);
- the sequence resets as soon as any candidate pass sees an addressable row (any `changed` or `skipped`
  entry) or a definitive refusal, and on any fresh trigger (`schedule()`, `index.js:547-560`);
- both the debounce timer and the retry timer are cleared on disposal (`index.js:648-656`).

It is a defence, **not a fix**: it was armed throughout the measured failure and the failure persisted
regardless (see *Live save behaviour*).

### What triggers a pass (`apply()`, `index.js:505-677`)

- `loader/volatile-update`, which the loader dispatches to the **owning fiber only**, i.e. this
  plugin's own volatile commits. A save on the Settings page is what this carries.
- `app-boot/config-reload`, the profile-reconcile completion signal (declared at
  `packages/boot/app-boot/src/index.ts:54`, emitted at `:411`), so a live save is followed even when
  the volatile-diff branch never reports it; the settings service consumes the same event
  (`packages/settings/settings/src/index.ts:234`).
- `loader/entry-init` for a row whose `name` is `@deepseek-ai/dsh-agent-preset`, so a preset that
  activates later is tuned too (`vendor/loader/src/config/entry.ts:60`).
- One initial pass at mount.

The pass reads its values from the fiber's own resolved config (`ctx.fiber?.config ?? config`,
`index.js:607`) rather than the object captured at `apply()` time, because a volatile commit may land in
a different object than the one `apply()` received.

Passes are debounced through a single `setTimeout(..., 0)`; one pass runs at a time and a trigger that
arrives mid-pass coalesces into exactly one more pass afterwards. If no candidate editor resolves at
all, the pass logs once and returns without arming a retry (`index.js:596-599`). These seams make a live
save reach a pass, but they do not make propagation to the preset rows work — see *Live save
behaviour*.

**Limitation:** because `loader/volatile-update` is fiber-filtered, editing a **preset** row directly
on its own Settings page does **not** trigger a retune. That row is retuned only when it remounts
(`loader/entry-init`) or when the tuner's own values change again.

`apply()` also suppresses the auto-generated generic config form for this same row
(`ctx.settings.configure({ auto: false }, ctx.fiber)`, guarded so a policy conflict cannot fail the
boot — `index.js:512-519`), because the bundle ships its own page.

## Client contract

Module artifact: one `window.__ModuleLoader__.load({ id: '@local/dsh-compaction-tuner', factory })`
closure (`client.js:31-36`). The factory requests exactly one module-table entry, `react`
(`client.js:34`), and returns `{ name, inject, apply }` with
`inject = ['slots', 'locale', 'configForms', 'connection']` (`client.js:716`).

`apply(ctx)`:

1. `ctx.effect(() => ctx.locale.register('compaction-tuner', { en, zh }), ...)` registers the
   complete English + Chinese dictionary (`client.js:725`).
2. `const form = ctx.configForms.get('compaction-tuner')` (`client.js:726`).
3. Resolves the restart caller lazily (`callBackend`, `client.js:728-736`): it reads
   `ctx.get('connection')` on every call and rejects when the service or `connection.rpc.call` is
   absent, so a composition without the connection service still registers the page.
4. Registers the section with a `label` function (required; an omitted label renders an empty nav row),
   `locale: 'compaction-tuner'`, and an inject face exposing `{ form, t, callBackend }`
   (`client.js:737-745`).

The page (`TunerSection`, `client.js:413-712`):

- State comes from `React.useSyncExternalStore(form.subscribe, form.getSnapshot)`, with the two
  methods memoized per form so the subscribe identity is stable (`client.js:418-420`).
- `status === 'loading'` renders the localized loading text; `status === 'unavailable'` renders the
  localized note with all inputs disabled and **never attempts a write**; `ready` renders three
  labelled numeric inputs seeded from `snapshot.value`.
- **One atomic write.** The draft is validated locally first (`validateDraft()`, `client.js:230-245`:
  each ratio in `(0, 1]`, `retainRatio < thresholdRatio`, retries a non-negative integer). On failure
  the page shows the matching localized message and calls **no** Host method. On success it calls
  `form.mutate([...exactly the three `set` ops...], snapshot.revision)` **once** (`client.js:511-515`).
- The Save action is disabled while the namespace is unwritable, while a write is in flight, and while
  the draft equals the snapshot (`client.js:706`).
- `mutate` resolving `true` shows the localized saved confirmation; resolving `false` (or rejecting)
  shows the localized refused copy in a `role="alert"`, and the draft is re-seeded from whatever the
  Host reports next — the controller performs its own recovery read
  (`packages/client/ui-settings/src/client/config-form.ts:129-148`). The saved copy is accurate for
  the tuner's own namespace only; it is not a promise that the preset rows of a running profile follow,
  and the presets pick the values up at the next Host start (see *Live save behaviour*).
- Accessibility: real `htmlFor`/`id` pairs via `React.useId()`, `role="alert"` for failures,
  `role="status"` for the confirmation, no colour-only signalling.
- Styling is a component-local `<style>` string inside the section tree, class names namespaced
  `dct-`, and only `--dsw-alias-*` host theme tokens (`client.js:154-185`).
- `close` is passed by the shell but this page never calls it.

### Restart contract (Client)

- **Bold notice in every state.** The restart-required fact renders as a real `<strong>`
  (`client.js:594`, class `dct-restart-note`) inside `restartBlock`, which is returned in the
  `confirming`, `timeout`, and default (ready/manual/restarting) states alike (`client.js:620-640`),
  and is also part of the `loading` return (`client.js:642-648`) and the main render
  (`client.js:692`). The English copy is `restart.note` — "Saving stores the values, but they reach the
  agent presets only after the DSH backend restarts." (`client.js:84`); the Chinese copy is
  `client.js:124`.
- **Availability probe.** On mount an effect owns an `AbortController` (`client.js:445-457`) and calls
  `probeRestartable()` (`client.js:323-334`): `status` on `/backend-restart`, retried up to
  `STATUS_ATTEMPTS = 3` times (`client.js:68`) at `STATUS_RETRY_MS = 1000` ms (`client.js:69`) on a
  transport miss only. A resolved reply is judged by `statusOutcome()` (`client.js:284-288`): only
  `ok:true` with `value.restartable === true` yields `ready`; anything else yields `manual`, and the
  action is disabled with the localized manual copy beside it (`restart.manual`, `client.js:86`;
  rendered at `client.js:604-606`).
- **Inline confirmation.** The action opens a `role="group"` confirm block
  (`client.js:607-615`); no native dialog is used. Cancel leaves the channel untouched
  (`cancelRestart()`, `client.js:541-543`).
- **Exactly one `restart` call.** Confirm (`confirmRestart()`, `client.js:565-591`) calls `restart`
  once on `/backend-restart` with the mount controller's signal.
- **Refusals are localized, diagnostics never rendered.** `restartFailureKey()` (`client.js:270-277`)
  maps `backend-restart/busy`, `.../unsupported`, `.../spawn-failed` to their copy and everything else
  to a generic message; the channel's `message` field is never product text. The refusal renders in a
  `role="alert"` (`client.js:595-597`).
- **Transport rejection means possibly-restarting.** A rejected `restart` call enters recovery rather
  than reporting failure (`client.js:584-589`), because the process may exit before its reply arrives —
  the rule `dsh-backend-restart/CONTRACT.md:52` sets for that channel's own client.
- **Bounded recovery.** `recover()` (`client.js:553-562`) runs `awaitSuccessor()` (`client.js:370-399`):
  poll the document root (`probeRoot()`, `client.js:342-362`; GET, `cache:'no-store'`, same-origin, 5 s
  probe timeout) until the old listener stops answering, for up to `DOWN_BUDGET_MS = 20000`
  (`client.js:61`), then until the successor answers, for up to `UP_BUDGET_MS = 60000`
  (`client.js:62`), at `POLL_INTERVAL_MS = 500` (`client.js:63`). `ready` calls
  `window.location.reload()` (`client.js:546`); `timeout` renders the manual **Reload page** block
  (`client.js:616-619`).
- **Unmount aborts.** The mount effect's cleanup aborts the controller (`client.js:453-456`), and every
  call and poll rides that signal: `delay()` and `probeRoot()` forward the abort
  (`client.js:296-313`, `client.js:342-362`), and `recover()` ignores a result after an abort
  (`client.js:554-555`).

## Restart action (soft dependency)

The restart action calls the authenticated Connection channel `/backend-restart`
(`dsh-backend-restart/CONTRACT.md:19`), owned and registered by `@local/dsh-backend-restart` and frozen
in that package's CONTRACT.md (`status` / `restart`). This is a **soft runtime dependency, not a
required one**: nothing is imported from that package, the host half never references it, this plugin
loads and its page renders without it, and only the restart action degrades — to the localized manual
copy with the action disabled. The manifest declares the connection client in `dsh.client.inject`
(`package.json`) and the client half injects `connection` (`client.js:716`).

## Honest limits

- **The cross-field rule is not in the schema.** `retainRatio < thresholdRatio` cannot be expressed in
  schemastery without breaking the settings form, because `volatileForm()` only descends a plain
  object root (`packages/settings/settings/src/schema.ts:37-47`). It is enforced by the page before it
  writes (`client.js:239`) and by the tuner before it pushes (`index.js:263-265`). A direct
  `settings.mutate` that bypasses the page can therefore persist an inconsistent pair in the tuner's
  own row — the Host schema validates each field in isolation. The tuner then refuses to push that
  pair into any preset and logs the reason (`refused`).
- **The page's pre-check is coarser than the Host schema.** It accepts any ratio in `(0, 1]`, while the
  schema requires `0.01`–`1` on a `0.01` step; an out-of-step value survives the local check and is
  refused by the Host with the generic refused copy.
- **Reload semantics.** New sessions get the new tune once the preset rows carry it; a session already
  running keeps the retired revision (`TODO.md` §3.8). Because live propagation does not work, edit the
  values and restart the backend (the page's **Restart backend** action, or your own restart): a saved
  value is reliably in force at the next boot.
- **The restart path has not been exercised end to end.** The element tree, the channel calls, the
  recovery sequencing and the abort contract are pinned by the hermetic stub suite, but no real browser
  render, no real process restart and no real `location.reload()` have been exercised on a live profile.
- **The live-save failure is long-lived, not transient, and is downstream of editor selection.** In the
  measured failing round 16 empty passes in 30 s returned that empty result, while a probe 0–1 ms away
  reported 214 editor rows containing the 5 preset rows the loop filters for. The loop's view and the
  probe disagree about rows that are demonstrably present; the plugin cannot address that from its side
  and the cause is unidentified. Nothing in this interface promises that a live save reaches the preset
  rows.
- **Neither shipped defence is a fix.** The candidate-editor walk (`configEditorsOf()`,
  `index.js:455-472`) and the empty-pass retry (`RETUNE_BACKOFF`, `index.js:123-130`) are armed and run,
  but the retry-only build propagated 0 of 1 measured rounds and the candidate-walk build 0 of 1; the
  pre-fix baseline arm was never measured, so no rate change is claimed in either direction.
- **Two measurement gaps.** Arm B (the pre-fix baseline) was never measured because the A/B stopped on
  the first arm-A failure; and in the measured round four passes returned a non-empty result while
  nothing reached the patch, with no breakdown captured of whether they were `skipped`-only or
  refusals.
- **No live override of a mounted `compaction-basic`.** The plugin can only re-project the preset
  declarations; it cannot change the policy of a preset already running.
- **No `node_modules`.** If `@deepseek-ai/schemastery` resolves from none of the three anchors
  (`index.js:78-95`), `Config` is `undefined`: the loader skips validation, there is no settings
  namespace, the page renders the unavailable note, and `apply()` still pushes raw values.
- **Confirmed at runtime.** Isolated instances confirmed the settings write (`ok:true`,
  `applies:"live"`, values persisted into the profile patch and reported by the tuner's own namespace),
  reliable idempotent boot-time propagation, and name-based coverage of a third-party preset brought in
  by a `--patch` overlay.
- **Still unconfirmed.** A reliable live-save path (no cause identified); arm B (never measured); the
  breakdown of the four non-empty passes; the browser/GUI path (real DOM render, nav row, page-driven
  save round-trip); a real process restart and a real `location.reload()` on a live profile; `TODO.md`
  §7 question 8 (HMR for a `link:`ed client bundle); question 2's live-session case; and question 5.
  The hermetic `verify.mjs` suite is green (71/71) but is stub-driven and starts no Host, so it says
  nothing about the live path or a real browser; see `README.md` → Verify.

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
