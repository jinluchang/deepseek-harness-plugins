# `dsh-llm-api-call-tuning`

English | [中文](README.zh.md)

A DSH plugin that puts **one** Settings page behind the model-request retry policy of **every active
model provider route**. DSH resolves one retry policy per route — retry mode, max retries, retryable
failure codes, and a bounded exponential backoff with jitter (`packages/llm/llm/src/retry-policy.ts`) —
but each provider owns its own copy (`llm-deepseek` and `llm-deepseek-account` under `retryPolicy`,
`llm-pi-ai` under `providers.<id>.retryPolicy`) and DSH has no global knob, CLI flag, environment
variable, or GUI-core page for them. Tuning them by hand means editing every provider row and keeping
five numbers in sync.

The page has four parts:

- **Global defaults** — the six retry values stored once in this plugin's own settings namespace
  (`llm-api-call-tuning`) as a **preset**. Saving them changes **no provider**.
- **Provider retry policies** — one row per active provider route, showing that route's **effective**
  retry policy and writing leaf-path operations **directly into the provider's own settings
  namespace**. A row is editable only when its namespace is served; declared-but-dormant routes, routes
  without a settings namespace, and routes whose namespaces are unserved are listed as read-only rows.
- **Provider timeouts** — one row per active route for the per-route application-layer timeouts:
  `streamIdleTimeoutMs` on every route, `timeoutMs` on `llm-pi-ai` routes, and `filesApiTimeoutMs` on the
  two DeepSeek routes. A blank field leaves the package/SDK default in force; `0` is refused and the
  **Unlimited** preset fills the `2147483647` ms cap (a limit, not an off switch).
- **Fetch timeouts** — the two process-wide HTTP timers `headersTimeoutMs` and `bodyTimeoutMs`, applied by
  the Host to the fetch dispatcher that every provider route, web search, and HTTP MCP server shares.
  Both are `unset` by default, so a fresh install changes no behavior; `0` explicitly disables a timer
  and a positive integer sets it in milliseconds.

The provider rows are authoritative; the global defaults are copied only when you explicitly ask
(**Use defaults** on a row, or **Apply defaults to all active providers**). The two fetch timers are a
separate, **process-wide** side effect: they are not part of the retry preset and are never copied onto a
provider route. The wire format is frozen in [CONTRACT.md](CONTRACT.md).

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

1. **Global defaults** — one control for each of the six retry fields below, a **Save defaults**
   action, and **Apply defaults to all active providers**. These values are stored in
   `llm-api-call-tuning` and are a preset: saving them does not touch a provider.
2. **Provider retry policies** — one **editable** row per active provider route (account and official
   routes first), each showing its namespace, an *override* / *default* badge, the six fields seeded
   from the route's effective retry policy, and **Save**, **Reset**, and **Use defaults**. A
   declared-but-dormant route, a route without a settings namespace, and a route whose namespace the
   deployment does not serve are listed read-only and say why.
3. **Provider timeouts** — one row per active route, with **Save timeouts** and **Reset timeouts** and
   an **Unlimited** preset per field. A blank field keeps the package/SDK default, `0` is refused, and
   the preset fills `2147483647` ms. Only active routes are editable: writing a timeout leaf onto a
   dormant route would materialize a partial provider profile and could activate it.
4. **Fetch timeouts** — two text inputs for the process-wide HTTP timers, with **Save timeouts** and
   **Reset to system defaults**. An empty input is the `unset` (system-default) state, `0` disables the
   timer, and a positive integer is the limit in milliseconds.

The retry field table (same values the Host's `Config` and the upstream retry resolver use), followed
by the two process-wide fetch fields:

| Field | Meaning | Accepts | Code default |
| --- | --- | --- | --- |
| `mode` | Retry mode. `normal` retries only the selected codes up to the retry limit; `always` retries every failure until success, cancellation, or shutdown and ignores the limit and the code list. | `'normal'` or `'always'` | `'normal'` |
| `maxRetries` | Eligible retries after the first request in `normal` mode; `0` disables retries. | integer 0..9007199254740991 | `5` |
| `initialDelayMs` | First locally scheduled retry delay, in milliseconds. | finite and > 0, at most 2147483647; must not exceed maxDelayMs | `500` |
| `maxDelayMs` | Cap on a locally scheduled or accepted provider delay, in milliseconds. | finite and > 0, at most 2147483647; must not be below initialDelayMs | `10000` |
| `jitterRatio` | Symmetric random multiplier around each local delay: `0` disables jitter, `1` allows up to double. | number in [0, 1] | `0.1` |
| `retryableCodes` | Stable transient failure codes `normal` mode retries. | non-empty array of unique codes from the five upstream codes | `'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'` |
| `headersTimeoutMs` | Process-wide HTTP response-headers timeout, in milliseconds, applied by the Host to the fetch dispatcher that every provider route, web search, and HTTP MCP server shares. | `unset` (leave the system/DSH default untouched), or integer 0..2147483647; `0` disables the timer | `unset` |
| `bodyTimeoutMs` | Process-wide HTTP response-body (chunk) timeout, in milliseconds, on that same fetch dispatcher. | `unset` (leave the system/DSH default untouched), or integer 0..2147483647; `0` disables the timer | `unset` |

The **Code default** column for the retry rows is the upstream resolution fallback
(`retry-policy.ts:14-22`), also what an unconfigured provider route runs. The bundle seeds nothing, so
the page starts on those values. For the two fetch rows the code default is **`unset`**, not a number:
the schema deliberately has no `.default()`, so a fresh install materializes no timer and the Host's own
dispatcher defaults apply. `unset` means no behavior change; `0` is a real value that disables that one
timer; a positive integer sets it.

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
which. It never writes the two fetch timers onto a provider: those are process-wide, not retry settings.

### Provider timeouts (per route)

This card edits the application-layer timeouts that live in each **provider's own** namespace, the same
cross-namespace write the retry card performs. Defaults are the upstream package/SDK values; a blank
field writes nothing, so the route keeps them.

| Field | Applies to | Namespace / path | Default | Accepts |
| --- | --- | --- | --- | --- |
| `streamIdleTimeoutMs` | every active route | `llm-pi-ai` → `providers.<route>.streamIdleTimeoutMs`; `llm-deepseek` / `llm-deepseek-account` → `streamIdleTimeoutMs` | `300000` ms (5 min) | blank (package default) or integer 1..2147483647; `0` is refused |
| `timeoutMs` | `llm-pi-ai` routes only | `llm-pi-ai` → `providers.<route>.timeoutMs` | unset = SDK default (about `600000` ms) | blank (SDK default) or integer 1..2147483647; `0` is refused |
| `filesApiTimeoutMs` | `llm-deepseek` and `llm-deepseek-account` only | `llm-deepseek` / `llm-deepseek-account` namespace root → `filesApiTimeoutMs` | `60000` ms (1 min) | blank (package default) or integer 1..2147483647; `0` is refused |

Why `0` is refused and there is no off switch: the DeepSeek and stream-idle schemas require a strictly
positive value (the load-time asserts reject `<= 0`), and a zero SDK request timeout would abort every
request immediately. The schemas have no "disabled" state, so the **Unlimited** preset writes the
maximum `2147483647` ms (about 24.8 days) instead — a very large limit, not a disable. A direct
`settings.mutate` (or a hand-edited profile patch) can still persist `0`; for the two watchdogs that
fails the provider's load-time assert and the route then fails to resolve, which is exactly what the
page prevents.

Interplay with the other two timeout surfaces: for SSE routes the SDK request timeout bounds the wait
for **response headers**, while `streamIdleTimeoutMs` bounds silence **between** streamed chunks, and the
process-wide fetch `bodyTimeoutMs` bounds the transport between chunks. When the idle window is raised
above the default `600000` ms SDK request timeout, the row warns (non-blocking) if `timeoutMs` is
shorter, or if the fetch body timeout is set below the idle window. Raising only the idle window is not
enough if a shorter SDK or transport deadline still fires.

Diagnosis pointer: an `llm-pi-ai` failure reported as a **stream idle timeout after 300000 ms** is the
default idle watchdog aborting a slow first token (TTFT stall), not a transport failure. Raise
`streamIdleTimeoutMs` on this card (and match `timeoutMs` and the fetch `bodyTimeoutMs` if they are
shorter) instead of editing the profile patch by hand.

`connectTimeoutMs` is **out of scope**: undici has no per-request connect timeout in versions 6, 7, or 8,
and only a fragile agent rebuild could express one. A proper transport connect limit belongs upstream in
`packages/util/http-proxy/src/install.ts` (the proxy-aware dispatcher install), not in this page.

### Fetch timeouts (process-wide)

The fetch card edits the two top-level leaves of this plugin's own namespace. The tri-state contract is:

- **Empty input = `unset`** — the fresh-install state. Saving an empty field emits
  `{ op: 'unset', path: ['<key>'] }`, so no timer of this plugin's is applied and the Host/system default
  is left untouched. A fresh install changes no behavior.
- **`0` = disabled** — a real write (`{ op: 'set', path: ['<key>'], value: 0 }`). It is visually
  distinct from empty and means "disable this timer", not "unset".
- **Positive integer = custom milliseconds**, at most `2147483647`.

The effect is **process-wide**: the Host wraps the current global undici dispatcher and fills
`headersTimeout`/`bodyTimeout` only on requests that do not set their own value, so every provider
route, web search, and HTTP MCP server in the process shares it. A per-request timeout always wins. The
wrapper is installed lazily, only while at least one of the two values is a number; clearing the last
value restores the dispatcher the Host had (only while that wrapper is still the current dispatcher),
and a later live save re-installs it. This is a **stopgap** on top of an upstream design: it is adapted
from the MIT-licensed `dsh-fetch-timeouts` project (© 2026 Dev Mehra), whose attribution lives in the
repository's [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). It is not a DSH-native setting, so a
future DSH release may supersede it.

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
- A provider-timeout change is persisted in the provider's namespace and is picked up by the next
  request/route registration, with no backend restart; a route that is dormant or whose namespace is not
  served is read-only here.
- A fetch-timer change is picked up on the **next HTTP dispatch** (the wrapper re-reads the live values on
  every request) with **no backend restart**. The values persist in this plugin's settings namespace like
  any other Host setting; clearing them (or Reset) restores the system-default state.
- The page only needs a reload to appear after install/upgrade (and a first install may need a backend
  restart). A value change does not need either.

### The two halves

`index.js` (Host) owns the global-defaults `Config` — six `.volatile()` retry fields plus the two
process-wide fetch fields — plus `DEFAULT_TUNE`/`TUNE_OPTIONS`, `DEFAULT_FETCH`/`FETCH_KEYS`/
`FETCH_OPTIONS`, `PROVIDER_TIMEOUT_FIELDS`/`PROVIDER_TIMEOUT_KEYS`/`PROVIDER_TIMEOUT_OPTIONS` (frozen
metadata for the provider card; NOT `Config` fields), `validateTune()` (the cross-field guard for the
retry rules the schema cannot express), and `apply(ctx, config)`. `apply()` has two jobs: it registers
the documented `auto: false` page policy for this namespace (future-proofing: no shipped DSH client
builds pages from a namespace schema yet) and installs the opt-in fetch-timeout dispatcher wrapper
described above. It never projects any value onto a provider. `client.js` (browser) is the page: it
reads the provider directory from the Client Remote `llm` namespace, paints each route's effective policy
from that route's config form, writes leaf-path operations back through the same form, owns the third
provider-timeout card, and owns the fourth process-wide fetch-timeout card. The provider rows are the
source of truth; `DEFAULT_TUNE` is the preset the page offers, not a fallback layer, and the fetch timers
are a process-wide side effect rather than a fallback for any provider.

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
- **An `llm-pi-ai` call fails with a stream idle timeout after 300000 ms.** That is the package idle
  watchdog's default (a slow first token / TTFT stall), not a transport error. Raise
  `streamIdleTimeoutMs` on the provider timeouts card and, if it is shorter, the request `timeoutMs` and
  the process-wide fetch `bodyTimeoutMs` too. The row shows a non-blocking warning when one of those
  deadlines would still fire first.
- **A provider timeouts row is read-only.** Dormant routes, routes without a settings namespace, and
  routes whose namespace is not served cannot be written: writing a timeout leaf would materialize a
  partial provider profile and could activate a dormant route.

## Verify

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs
```

Run from this repository's root (or from the plugin directory with the same variable exported). The
suite is hermetic — plain Node, `node:assert/strict`, fake Context/form/React doubles in `node:vm`, no
network, no server, no file writes — and resolves the **real** `@deepseek-ai/schemastery` and the
upstream `retry-policy.ts` through `$DSH_HARNESS_CHECKOUT`, so a schema or constant drift fails loudly.
It checks the manifest and bundle patch, the Host `Config` accept/reject matrix, the `validateTune()`
rules, `apply()`, the client registration, the en/zh copy parity (121 keys), the exact operation shapes
for defaults/normal/always/reset/fetch Save/fetch Reset/provider-timeout Save and Reset, the provider-timeout
metadata (frozen keys/defaults/bounds/scopes and the upstream schema + defaults they mirror), the
validation, refusal, per-write gate/skip, and revision-retry paths, the provider directory join and every
degradation path, the provider-timeout card (family visibility, user-layer seeding, protocol display,
advisories, active-only gate, Unlimited preset, zero rejection), the fetch-timeout dispatcher against a
recording fake dispatcher and the Host's real `undici` globals (install/fill/restore/dispose/
`NODE_USE_ENV_PROXY`, plus a missing-`undici` child-process run), and the field tables in this README and
CONTRACT.md. The "managed elsewhere" classification is tested only as a defensive unit path with a
rejecting fake form; real settings-form refusals resolve `false`.

A green run prints `127 passed, 0 failed, 0 skipped (127 checks)` and exits `0`. That is an offline
contract check, not a live GUI test: it starts no Host or browser and does not exercise a real
settings save, the real nav row, next-request latency, a real HTTP request whose headers/body/stream
actually time out under the installed dispatcher, or a live provider route's timeout aborting a slow
first token. Those remain deployment checks; the suite proves the
wire contract and the dispatcher's shape, not the wire's timing.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the six retry global-default fields and the two process-wide fetch fields (`Config`), `DEFAULT_TUNE`/`TUNE_OPTIONS`, `DEFAULT_FETCH`/`FETCH_KEYS`/`FETCH_OPTIONS`, frozen `PROVIDER_TIMEOUT_FIELDS`/`PROVIDER_TIMEOUT_KEYS`/`PROVIDER_TIMEOUT_OPTIONS` metadata, `validateTune()`, and `apply(ctx, config)`, which suppresses the auto page and installs/restores the opt-in fetch-timeout dispatcher wrapper. |
| `client.js` | Browser half: the **LLM API call tuning** Settings section (defaults card + one editable retry row per active provider + the provider-timeout card + the fetch-timeout card), local validation, and leaf-path writes through the provider forms and its own namespace. |
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
- **Provider timeouts are per route, not global, and `0` is refused.** The page refuses `0` because the
  DeepSeek/stream-idle schemas reject it and a zero SDK request timeout aborts every request; the
  Unlimited preset writes the `2147483647` ms cap (about 24.8 days) instead of an off switch. A direct
  `settings.mutate` can still persist `0`, which fails the provider's load-time assert and makes the
  route fail to resolve.
- **Dormant routes are read-only on the provider-timeout card.** Writing a timeout leaf would
  materialize a partial provider profile and could activate the route, so it is blocked by design.
- **`connectTimeoutMs` is out of scope.** undici has no per-request connect timeout in versions 6, 7, or
  8; a transport connect limit belongs upstream in `packages/util/http-proxy/src/install.ts`, not in
  this page.
- **The fetch timers are process-wide.** They apply to every provider route, web search, and HTTP MCP
  server in the Host process; there is no per-provider HTTP timeout. An unset timer leaves the Host
  default alone, `0` disables that timer, and a per-request timeout set by a caller always wins.
- **The fetch dispatcher wrapper is a stopgap**, adapted from the MIT-licensed
  `dsh-fetch-timeouts` project; attribution and provenance are in the repository's
  [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). It is not a DSH-native setting.
- **The live timing is not provable offline.** `verify.mjs` pins the dispatcher's install/fill/restore
  shape against a recording fake dispatcher, but it cannot prove that a real request times out after the
  configured milliseconds; that is a deployment check.
- **Not published to npm**, and the plugin performs no migration on install or uninstall.
