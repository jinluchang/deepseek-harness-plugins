# `dsh-llm-api-call-tuning`

English | [中文](README.zh.md)

A DSH plugin that puts **one** Settings page behind the model-request retry policy of **every active
model provider route**. DSH resolves one retry policy per route — retry mode, max retries, retryable
failure codes, and a bounded exponential backoff with jitter (`packages/llm/llm/src/retry-policy.ts`) —
but each provider owns its own copy (`llm-deepseek` and `llm-deepseek-account` under `retryPolicy`,
`llm-pi-ai` under `providers.<id>.retryPolicy`) and DSH has no global knob, CLI flag, environment
variable, or GUI-core page for them. Tuning them by hand means editing every provider row and keeping
five numbers in sync.

The page has two parts:

- **Global defaults** — the six retry values stored once in this plugin's own settings namespace
  (`llm-api-call-tuning`) as a **preset**. Saving them changes **no provider**.
- **Provider retry policies** — one row per active provider route, showing that route's **effective**
  retry policy and writing leaf-path operations **directly into the provider's own settings
  namespace**. A row is editable only when its namespace is served; declared-but-dormant routes, routes
  without a settings namespace, and routes whose namespace is unserved are listed as read-only rows.

The provider rows are authoritative; the global defaults are copied only when you explicitly ask
(**Use defaults** on a row, or **Apply defaults to all active providers**). The wire format is frozen
in [CONTRACT.md](CONTRACT.md).

## Install

The plugin is a profile bundle, not a workspace package. Install it from the DSH checkout (so the
`pnpm dsh` entry point resolves), pointing the `link:` at the bundle directory — use your own checkout
and plugins-workspace paths:

```sh
cd /abs/path/to/deepseek-harness
plugins=/abs/path/to/deepseek-harness-plugins
pnpm dsh plugin --profile web add link:"$plugins/dsh-llm-api-call-tuning"
```

Or, from the plugins workspace (the parent of this bundle) with the `dsh` CLI on `PATH`:

```sh
dsh plugin --profile web add link:"$PWD/dsh-llm-api-call-tuning"
```

In a running GUI session the same step is the `plugin_manager` tool with
`action: "install_bundle"` and the absolute directory path as `target`:

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/to/deepseek-harness-plugins/dsh-llm-api-call-tuning" })
```

`application: "applied"` means the profile changed. Then **reload the page**; a first install may also
need a backend restart before the bundle patch is read. The bundle ships no dependencies (it resolves
the Host's own `@deepseek-ai/schemastery` at load time), and nothing here is published to an npm
registry: installing from this checkout, an absolute path, or `npm pack` is the supported route.

## Use

Open **Settings** (the account menu at the bottom of the sidebar) and choose **LLM API call tuning**,
the last nav row (section order 45). The page renders:

1. **Global defaults** — one control for each of the six fields below, a **Save defaults** action, and
   **Apply defaults to all active providers**. These values are stored in `llm-api-call-tuning` and are
   a preset: saving them does not touch a provider.
2. **Provider retry policies** — one **editable** row per active provider route (account and official
   routes first), each showing its namespace, an *override* / *default* badge, the six fields seeded
   from the route's effective retry policy, and **Save**, **Reset**, and **Use defaults**. A
   declared-but-dormant route, a route without a settings namespace, and a route whose namespace the
   deployment does not serve are listed read-only and say why.

The field table (same values the Host's `Config` and the upstream retry resolver use):

| Field | Meaning | Accepts | Code default |
| --- | --- | --- | --- |
| `mode` | Retry mode. `normal` retries only the selected codes up to the retry limit; `always` retries every failure until success, cancellation, or shutdown and ignores the limit and the code list. | `'normal'` or `'always'` | `'normal'` |
| `maxRetries` | Eligible retries after the first request in `normal` mode; `0` disables retries. | integer 0..9007199254740991 | `5` |
| `initialDelayMs` | First locally scheduled retry delay, in milliseconds. | finite and > 0, at most 2147483647; must not exceed maxDelayMs | `500` |
| `maxDelayMs` | Cap on a locally scheduled or accepted provider delay, in milliseconds. | finite and > 0, at most 2147483647; must not be below initialDelayMs | `10000` |
| `jitterRatio` | Symmetric random multiplier around each local delay: `0` disables jitter, `1` allows up to double. | number in [0, 1] | `0.1` |
| `retryableCodes` | Stable transient failure codes `normal` mode retries. | non-empty array of unique codes from the five upstream codes | `'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'` |

The **Code default** column is the upstream resolution fallback (`retry-policy.ts:14-22`), also what an
unconfigured provider route runs. The bundle seeds nothing, so the page starts on those values.

### Saving a provider row

**Save** validates the draft locally first — a fractional retry limit, a delay of `0` or above
`2147483647`, an initial delay above the maximum, a jitter outside `[0, 1]`, or an empty/unknown/
duplicate code list is refused with a localized message and **no Host call** — then submits **one
atomic write of leaf operations** at the revision the page last read. A `normal`-mode save sets
`retryPolicy.mode`, `retryPolicy.maxRetries`, `retryPolicy.retryableCodes` and the three
`retryPolicy.backoff.*` leaves. An `always`-mode save sets `retryPolicy.mode` and **unsets**
`retryPolicy.maxRetries` and `retryPolicy.retryableCodes`, because those are inactive upstream. A whole
`retryPolicy` object is never set, so sibling configuration (base URL, credentials reference, models)
is left alone.

**Reset** clears the provider's `retryPolicy` with the single `unset` of
`[...settingsPath, 'retryPolicy']`, so the provider falls back to its own defaults. **Use defaults**
copies the validated global defaults into the row's draft; nothing is written until **Save**.

A write is attempted only when the row's form reports `ready`, is not read-only, and carries a numeric
revision; that same read is the revision fence, so the page never sends an unconditional write. A row
that fails the gate stays disabled (and is **skipped** by "Apply defaults to all" instead of written).

If the Host refuses the write, `mutate` resolves `false` — that is **every** Host refusal, including
one caused by a home patch or `--patch` overlay owning the row, because the settings form API does not
surface the reason. The page shows the **generic refusal copy** and re-seeds every field from whatever
the Host reports next; if the refusal was a superseded revision and the recovery read moved it, the
write is retried **once** at the fresh revision. The page keeps a separate "managed elsewhere" copy for
a **direct `RemoteError` carrying `settings/rejected`**, but that classification is defensive only and
is not reachable through the settings form API: a home-patch-owned row shows the generic copy.

**Apply defaults to all active providers** copies the validated defaults into every editable row, one
provider at a time, each at its own freshly read revision. It re-checks each row immediately before its
write: a row whose form is still loading, read-only, or missing a numeric revision is **skipped** (its
body already states why, so no extra badge is rendered). It is **not a transaction**: a provider that
refuses keeps its policy, the ones already written stay written, and the per-row outcome says which is
which.

### Live and persisted semantics

- The save travels the shared settings form API — the same `settings.mutate` path the Models page uses —
  and the settings service persists it into the active profile's `cordis.patch.yml` (the profile's own
  patch next to its `package.json`). The plugin stores nothing itself.
- A retry-policy change is meant for the **next model request**, with **no backend restart**: every
  route's policy is captured at **registration** (`packages/llm/llm/src/index.ts:435-470`), and each
  provider re-registers its routes when the loader reports a changed volatile value (after a settings
  save). `llm-deepseek`/`llm-deepseek-account` do that in `llm-deepseek/src/host.ts:82-90`;
  `llm-pi-ai` includes `retryPolicy` in its registration facts and re-registers on
  `loader/volatile-update` (`llm-pi-ai/src/index.ts:108-120,289-319`).
- A request already in flight keeps the policy it started with.
- The page only needs a reload to appear after install/upgrade (and a first install may need a backend
  restart). A value change does not need either.

### The two halves

`index.js` (Host) owns only the global-defaults `Config` — six `.volatile()` fields, one per retry
value — plus `validateTune()`, the cross-field guard for the rules the schema cannot express, and
`apply()`, which registers the documented `auto: false` page policy for this namespace (future-
proofing: no shipped DSH client builds pages from a namespace schema yet). It never projects
anything onto a provider. `client.js` (browser) is the page: it reads the provider directory from the
Client Remote `llm` namespace, paints each route's effective policy from that route's config form, and
writes leaf-path operations back through the same form. The provider rows are the source of truth;
`DEFAULT_TUNE` is the preset the page offers, not a fallback layer.

## Troubleshooting

- **The nav row is missing.** The bundle is not loaded into the active profile, or the page has not
  been reloaded since the install. Check the install command aborted cleanly, do a full page reload,
  and if the row is still absent restart the backend so the profile patch is read again. The row is
  expected at the end of the Settings nav (order 45).
- **A provider row is missing or read-only.** Only routes that are declared by an installed provider
  adapter and currently active are editable. A declared-but-dormant `llm-pi-ai` route, a route with no
  settings namespace, and a route whose namespace this deployment does not serve are shown read-only
  with the reason.
- **"The host refused the write" on a home-patch/`--patch` row.** A home patch or a `--patch` overlay
  owns that provider row, so the config editor refuses the write and the page shows the **generic**
  refusal copy (the settings form API does not surface the reason). Edit the overlay (or the profile
  patch) instead; this page deliberately has no force path. The separate "managed elsewhere" copy
  exists only for a direct `RemoteError` carrying `settings/rejected` and is not reachable here.
- **"The host refused the write" on a normal row.** The value was not accepted as written (for example
  the revision was superseded). The fields re-seed from the Host's current values; review and save
  again.
- **Saving defaults changed nothing.** That is the design: the defaults card is a preset. Use **Use
  defaults** on a row or **Apply defaults to all active providers** to write them into providers.
- **The values look different from what I typed.** The page always shows the effective value the Host
  reports. In `always` mode the retry limit and code list are not editable and are cleared on save.
- **The provider directory is unavailable.** This deployment does not expose the Remote `llm` directory
  (`providers.unavailable`), or the read failed (`providers.error`). No provider row can be listed, but
  the global defaults card still works.
- **A provider I just added is not listed.** The directory is read once when the section mounts and is
  not live-refreshed; navigate away and back (or reload the page) to re-read it.

## Verify

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs
```

Run from this repository's root (or from the plugin directory with the same variable exported). The
suite is hermetic — plain Node, `node:assert/strict`, fake Context/form/React doubles in `node:vm`, no
network, no server, no file writes — and resolves the **real** `@deepseek-ai/schemastery` and the
upstream `retry-policy.ts` through `$DSH_HARNESS_CHECKOUT`, so a schema or constant drift fails loudly.
It checks the manifest and bundle patch, the Host `Config` accept/reject matrix, the `validateTune()`
rules, `apply()`, the client registration, the en/zh copy parity (77 keys), the exact operation shapes
for defaults/normal/always/reset, the validation, refusal, per-write gate/skip, and revision-retry
paths, the provider directory join and every degradation path, and the field tables in this README and
CONTRACT.md. The "managed elsewhere" classification is tested only as a defensive unit path with a
rejecting fake form; real settings-form refusals resolve `false`.

A green run prints `80 passed, 0 failed, 0 skipped (80 checks)` and exits `0`. That is an offline
contract check, not a live GUI test: it starts no Host or browser and does not exercise a real
settings save, the real nav row, or next-request latency.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the six global-default fields (`Config`), `DEFAULT_TUNE`, `validateTune()`, and `apply()`, which registers the `auto: false` page policy for this namespace (future-proofing today). |
| `client.js` | Browser half: the **LLM API call tuning** Settings section (defaults card + one editable row per active provider, read-only dormant rows), local validation, and leaf-path writes through the provider forms. |
| `cordis.patch.yml` | Bundle patch that inserts the `llm-api-call-tuning` row with **no seed**. |
| `locale/en.json`, `locale/zh.json` | Plugin display metadata for the Plugin Manager and Settings inventory. |
| `package.json` | Bundle manifest (`dsh.bundle.patch`, `dsh.client` injects, `exports`, `files`). |
| `verify.mjs` | Hermetic self-check for the manifest, both halves, the rules, and the documented tables. |
| `CONTRACT.md` | Frozen interface: identity, fields, addresses, operation shapes, persistence, limits. |

## Limitations

The full list is in [CONTRACT.md](CONTRACT.md); the ones a user is most likely to hit:

- **No transaction across providers.** Apply-to-all writes one provider at a time; a failure leaves the
  earlier writes in place.
- **Home-patch/`--patch` rows cannot be edited** and show the generic refusal copy (the managed-elsewhere
  classification is defensive-only, not reachable through the settings form API).
- **In-flight requests keep the old policy.**
- **Dormant `llm-pi-ai` routes and routes without a settings namespace are read-only.**
- **The provider directory is read once per mount**, with no live refresh: a provider added or removed
  while the page stays open needs a page reload.
- **No CLI, environment, or GUI-core setting exists** — this page is the only supported UI; hand-editing
  the profile patch bypasses its validation.
- **Not published to npm**, and the plugin performs no migration on install or uninstall.
