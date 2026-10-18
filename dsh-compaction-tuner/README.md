# `@local/dsh-compaction-tuner`

A local DSH plugin that puts **one** control in Settings for the compaction thresholds of **every
agent preset in the active profile**. A profile usually declares several
`@deepseek-ai/dsh-agent-preset` rows, each with its own `compaction-basic` child; this plugin owns the
three values `thresholdRatio`, `retainRatio`, and `compactionRetries` in its own row, renders them as
the **Compaction tuner** Settings section, and pushes them into every preset row so all of them run the
same tune. Today those numbers are edited by hand in each preset patch, and forgetting one preset
leaves it on different compaction behaviour.

The wire format shared by the two halves is frozen in [CONTRACT.md](CONTRACT.md).

## Install

The plugin is a profile bundle, not a workspace package. Install it from this repository's root with
the DSH Plugin Manager, which links the directory into the active profile and records the bundle row:

```sh
pnpm dsh plugin --profile web add link:"$PWD/dsh-compaction-tuner"
```

In a running GUI session the same step is the `plugin_manager` tool with `action: install_bundle` and
`target: <absolute path to dsh-compaction-tuner>`; `application: "applied"` means the profile changed.
The plugin then loads on the next full page load.

The sibling bundle's README states that a first install needs one Host restart for the client half to
be discovered, and `TODO.md` §4.6 records that a `link:`ed client bundle needs a page reload after a
rebuild. That reload/HMR behaviour was **not** re-verified for this plugin (see Limitations and
`TODO.md` §7 open question 8).

## Use

Open Settings (the account menu at the bottom of the sidebar, then **Settings**) and choose
**Compaction tuner**, the last nav row. The page shows three numeric fields:

| Field | Meaning | Accepts |
| --- | --- | --- |
| **Compaction threshold** | Share of the context budget at which compaction triggers. | ratio in `(0, 1]` |
| **Retained tail** | Share of the budget kept as the tail after compaction. | ratio in `(0, 1]`, and below the threshold |
| **Compaction retries** | How many times a failed compaction is retried before the turn continues. | whole number `>= 0` |

Edit any field and choose **Save**. The page validates the draft locally first (a ratio out of range, a
retained tail at or above the threshold, or a fractional retry count is refused with a localized
message and no Host call), then submits all three values as **one atomic write** with the revision the
page last read. **Save** stays disabled while nothing has changed, while a write is in flight, and when
the deployment reports the namespace read-only. A successful save shows a confirmation that the values
are stored; that copy is accurate for the tuner's own namespace, but it is **not** a promise that the
preset rows of a running profile re-tune — see *Save and reload semantics*. A refusal by the Host shows a
localized alert and the fields re-seed from whatever the Host reports next. If the deployment does not
serve the `compaction-tuner` namespace, the page says so and disables the fields instead of pretending to
write.

**After saving, restart the Host** — or accept that the presets pick the values up at the next start.
The save is immediate and persists, but propagation from the running Host to the preset rows does not
work in measured runs, and the plugin has no way to repair it from its side; see *Save and reload
semantics*.

## Initial values

The bundle's mount patch seeds the tuner row with `thresholdRatio: 0.5`, `retainRatio: 0.15`,
`compactionRetries: 2` (`cordis.patch.yml:15-21`). Those are not the upstream code defaults: they
carry forward the tune currently committed for the **`standard`** preset in the checkout at
`packages/bundle/web-app/presets/standard.patch.yml:75-80`, which is the hand edit this plugin exists
to replace.

The upstream `compaction-basic` code defaults remain `0.8 / 0.16 / 1`
(`packages/compaction/compaction-basic/src/config.ts:20,23,105`), and the schema defaults on the
tuner's own fields are the same three values. A value equal to a preset's **effective** value is never
written — the tuner compares before it edits — so `standard` is not rewritten while its committed tune
already matches the control.

The other three shipped presets (`ptc`, `minimal`, `cordis`) declare **no** compaction config and run
on the code defaults. The first pass therefore does move them onto `0.5 / 0.15 / 2`. That is the point
of the plugin — one tune for every preset — but it is a real behaviour change for those presets, not a
no-op install; see Limitations.

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
**the plugin cannot address this from its side**. **Edit the values, then restart the Host:** the save
persists, and preset propagation is reliably effective at the next boot only. `applies:"live"` describes
the settings write, not the presets.

**Both plugin-side defences are shipped, and neither is a fix.** A pass first walks every candidate
configuration editor it can resolve (`configEditorsOf()`, deduplicated by identity) and stops at the
first result that finds anything; if every candidate is empty it retries on the bounded, exported
`RETUNE_BACKOFF = [250, 1000, 3000, 10000]` ms (`index.js:130`), resetting as soon as a pass sees an
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
keep the retired revision** (`TODO.md` §3.8), because `compaction-basic` resolves its policy once when a
preset mounts and there is no runtime override path for a preset that is already running.

A retune pass is triggered by the tuner row's **own** volatile commits, by the profile-reconcile
completion signal (`app-boot/config-reload`), and by a preset row activating later. Because
`loader/volatile-update` is dispatched to the owning fiber only, editing a preset row directly on its own
Settings page does **not** retune it; that row is retuned only when it remounts or when the tuner's
values change again.

## Maintenance cost

A patch replaces a row's **whole** `config` (`vendor/include/src/index.ts:120-123`) and preset children
are not addressable, so the tuner must restate each preset's entire `plugins` list in the replacement
config. Any later upstream edit to a shipped preset is silently hidden behind that restatement until
the preset row is reset (`TODO.md` §3.4). Treat the tuner's copies as a fork of the preset patches and
run the drift check after any upstream update: diff the tuner's restated `plugins` list against the
shipped preset rows (`TODO.md` §6.4). This is the dominant cost of the chosen mechanism; `TODO.md`
§3.7 sketches the smaller core seam that would remove it.

## Verify

```sh
DSH_HARNESS_CHECKOUT=/home/user/Public/deepseek-harness node dsh-compaction-tuner/verify.mjs
```

Run from this repository's root (or inside the plugin directory with the same variable exported). The
suite is hermetic — `node:assert/strict`, fake Context doubles, no network, no server — and resolves
the **real** schemastery through `$DSH_HARNESS_CHECKOUT`, so set that variable or the schema checks
cannot run.

**Observed run — green, and a regression gate.** With `verify.mjs` at sha256
`c7a0c1a46b803bccf94b8c0f3de6de75bb47120659282bcdac3c5741caa85df1` and the `index.js` it verified at
sha256 `f7dcd41ae43d3ed7fb8cb874aabf5e035cd7246e37cd181597c7ae39ef64e5d3` (I hashed the file from disk
myself and the digest matches), the command above printed `60 passed, 0 failed, 0 skipped` and exited
`0` in ~0.23 s (I measured 230 ms). Twelve of the 60 checks cover the plugin-side defences: seven for
the empty-pass retry and five for the candidate-editor walk. The suite is proven to bite: against a
`/tmp` copy of `index.js` with only `configEditorsOf` reverted to a single candidate, the same suite
reports `58 passed, 2 failed` (checks 56 and 60) against the shipped 60/60. An earlier revision of this
document published a `40 passed, 16 failed` run at sha256 `5e091743…`; all 16 of those failures were
defects in an intermediate draft of the suite — undefined helper placement, fake-context recorders that
read `undefined`, one check contradicting the frozen schema limit, and one two-pass warning count — and
none was a defect in either half. `verify.mjs` deliberately pins no file digests (it ships as
`scripts.verify`), so the revisions above are named here instead.

It covers: the manifest; a drift guard that the package name, the client module id, the
`cordis.patch.yml` row name, the loader entry id / namespace, the locale namespace, and `index.js`'s
`name` all agree; the host `Config` schema against real schemastery, including the refusals for `0`,
`1.2`, and `-1` / `1.5` retries; the `retune()` mechanism through a fake editor, including the
candidate-editor walk and the empty-pass retry sequence with its `RETUNE_BACKOFF` order; the client half
evaluated in `node:vm`
(exact module id, the `settings.section` registration, the en+zh dictionary,
three inputs for a ready snapshot, local refusal of an inconsistent draft with no `mutate` call, and
exactly one `mutate` with the three `set` ops and the snapshot revision); and a textual check that
`client.js` requests only `require('react')`.

`verify.mjs` starts no live Host and no browser, so a green run says nothing about live preset
propagation — that is a live-instance property, and the isolated runs recorded under *Save and reload
semantics* are the evidence for it. The browser/GUI path (a real DOM render, the nav row, and a save
driven through the page) also remains unconfirmed.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: owns the three values, finds every agent-preset row, and pushes the tune into its `compaction-basic` child. |
| `client.js` | Browser half: the **Compaction tuner** Settings section and its single atomic save. |
| `cordis.patch.yml` | Bundle patch that inserts the tuner row with the initial `0.5 / 0.15 / 2` values. |
| `locale/en.json`, `locale/zh.json` | Plugin display metadata for the Plugin Manager and Settings inventory. |
| `package.json` | Bundle manifest (`dsh.bundle.patch`, `dsh.client`, `exports`, `files`). |
| `verify.mjs` | Hermetic self-check for the manifest, both halves, and the tuning rules. |
| `CONTRACT.md` | Frozen interface: identity, fields, persistence, tuning rules, limits. |

## Limitations

- **The initial tune changes three presets.** Only `standard` ships a committed tune in the checkout;
  `ptc`, `minimal`, and `cordis` run on the code defaults, so the first retune pass moves them onto
  `0.5 / 0.15 / 2`. That is intended ("one tune for every preset"), but it is a behaviour change, not
  a silent no-op.
- **The cross-field rule is not in the schema.** `retainRatio < thresholdRatio` cannot be expressed in
  schemastery without breaking the settings form, because `volatileForm()` only descends a plain
  object root (`packages/settings/settings/src/schema.ts:37-47`). It is enforced by the page before it
  writes and by the tuner before it tunes. A direct `settings.mutate` that bypasses the page can
  persist an inconsistent pair in the tuner's own row; the tuner then refuses to push it into any
  preset and logs the reason.
- **The page's pre-check is coarser than the Host schema.** It accepts any ratio in `(0, 1]`, while the
  schema requires `0.01`–`1` on a `0.01` step, so an out-of-step value is refused by the Host with the
  generic refused copy rather than a field-specific message.
- **Live propagation to the preset rows does not work, and the failure is downstream of editor
  selection.** An earlier loose run saw 2 of 5 identical saves propagate; the retry-only build
  propagated 0 of 1 measured rounds and the candidate-walk build 0 of 1. In the failing round, 16 empty
  passes in the 30 s after the save returned `{"changed":[],"skipped":[]}` while a probe 0–1 ms away
  reported 214 editor rows containing the 5 preset rows the loop filters for — the loop's view and the
  probe disagree about rows that are demonstrably present. The cause is unidentified and the plugin
  cannot address it from its side. **Edit the values, then restart the Host:** a value saved now is
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
- **A reliable live-save path, arm B, the four-pass breakdown, and the browser/GUI path are
  unconfirmed.** The isolated runs exercised the real HTTP settings write and real boots, not a browser:
  no real DOM render, nav row, or page-driven save round-trip has been observed here, and no cause has
  been identified for the live propagation failure. Arm B was never measured, and the four non-empty
  passes had no breakdown captured. HMR for a `link:`ed client bundle (`TODO.md` §7 question 8) is
  likewise unconfirmed.
- **`TODO.md` open questions.** First-pass timing (1) and batching of repeated `configEditor.edit` calls
  (4) are answered empirically by the verification runs; question 2's live-session case, question 5, and
  question 8 remain open.
- **No `node_modules`.** If `@deepseek-ai/schemastery` cannot be resolved from any of the plugin's
  anchors, there is no settings namespace and the page shows the unavailable note; the host half still
  pushes raw values.
