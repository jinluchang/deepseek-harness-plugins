# Frozen interface: `dsh-llm-api-call-tuning`

Package directory: `dsh-llm-api-call-tuning/` (installed into the active DSH profile as a bundle).
Host half: `index.js`. Client half: `client.js`. Mount patch: `cordis.patch.yml`.

## Why this exists

DSH resolves one model-request **retry policy** for every provider route it registers
(`packages/llm/llm/src/retry-policy.ts` `RetryPolicySchema`): a retry mode (`normal` | `always`), a
bounded retry count, the failure codes eligible for a retry, and a bounded exponential backoff with
symmetric jitter. Those values are **provider-owned**: `llm-deepseek` and `llm-deepseek-account` read
`retryPolicy` at their own settings root (`llm-deepseek/src/config.ts:110`, `llm-deepseek-account/src/config.ts:21-31`
spreads the shared `deepSeekConfigFields`), and `llm-pi-ai` reads
`providers.<id>.retryPolicy` in its provider dictionary (`llm-pi-ai/src/config.ts:348,353`). DSH ships
**no** global settings namespace, CLI flag, environment variable, or GUI-core control for them, so a
deployment that wants one policy for every route has to hand-edit each provider row.

This plugin fills that gap with **one** Settings page, in two tiers:

- a **Global settings** card, first, holding every global knob in two labeled sub-groups inside the one
  card: **Retries** (the six retry values stored as a preset in this plugin's own settings namespace,
  `llm-api-call-tuning`) and **Fetch timeouts** (the two **process-wide** HTTP timers
  `headersTimeoutMs`, `bodyTimeoutMs` that the Host applies to the undici dispatcher every provider
  route, web search, and HTTP MCP server shares). Both timers are `unset` by default, so a fresh
  install changes no behavior. This part is adapted from the MIT-licensed `dsh-fetch-timeouts` project:
  it is a **stopgap** until DSH offers a native setting, and the upstream attribution lives in the
  repository root `THIRD-PARTY-NOTICES.md` (not edited by this bundle); and
- one **per-route** tier: a native route picker above the list, then one **merged card per deviating
  provider route**, carrying that route's retry policy and its application-layer timeouts
  (`streamIdleTimeoutMs` on every route, `timeoutMs` on `llm-pi-ai` routes, `filesApiTimeoutMs` on the
  two DeepSeek routes) as two labeled sub-groups. The card writes leaf-path operations **directly into
  that provider's own settings namespace**. A route is listed only when it deviates: its effective
  stored retry policy differs in at least one leaf from the global retry values, or its user layer
  explicitly stores one of its timeout leaves.

Retry and timeout are **not** separate sections: they share one card and one write per route, because
both groups address the same provider namespace and the same provider settings path.

Non-goals: the plugin owns no projection state and never copies the retry defaults onto a provider on
its own. It is not a new retry engine, it does not change any other profile, and it does not touch
provider configuration outside `retryPolicy` and the three explicitly documented timeout leaves. It is
also **per route, never per model**: DSH captures one retry policy per provider route at adapter
registration and carries no model in the agent/request-error payload, so a per-model override dict
would be stored and rendered but never applied (see *Known limitations*). It does not install a
per-provider **HTTP transport** timeout (`connectTimeoutMs` is out of scope; see *Provider timeout
fields*) or replace the Host's dispatcher with a bare agent: the fetch feature only wraps the current
dispatcher, only while a timer is set, and restores it on clear/dispose.

## Identity (do not change without updating both halves)

`file:line` references name the revision the contract was written against; the named symbol is
authoritative, and `verify.mjs` pins behaviour and the upstream constants rather than line numbers.

| Item | Value |
| --- | --- |
| Package | `dsh-llm-api-call-tuning` |
| Client module id | `dsh-llm-api-call-tuning` — the exact package name (`window.__ModuleLoader__.load` `client.js:88-89`) |
| Client plugin `name` | `dsh-llm-api-call-tuning` (`client.js:2418`) |
| Loader entry id / row id | `llm-api-call-tuning` (`cordis.patch.yml`) |
| Settings namespace | `llm-api-call-tuning` — this plugin's own `Config`, read/written with `ctx.configForms.get('llm-api-call-tuning')` |
| Locale namespace | `llm-api-call-tuning` |
| Host `name` export | `llm-api-call-tuning` (`index.js:588`) |
| Host module surface | `name`, `Config`, `DEFAULT_TUNE`, `TUNE_KEYS`, `TUNE_OPTIONS`, `TUNE_PROBLEMS`, `RETRY_MODES`, `RETRYABLE_CODES`, `DEFAULT_FETCH`, `FETCH_KEYS`, `FETCH_OPTIONS`, `PROVIDER_TIMEOUT_FIELDS`, `PROVIDER_TIMEOUT_KEYS`, `PROVIDER_TIMEOUT_OPTIONS`, `schemaLibrary`, `validateTune`, `apply`; **no** default export |
| Host `inject` | none exported — `apply()` calls `ctx.inject(['settings'], …)` for the page policy and mounts its fetch-timeout effect itself (see *Fetch timeout dispatcher*) |
| Host side effect | A process-wide undici dispatcher wrapper, installed only while at least one fetch value is a number; the previous dispatcher is restored on clear/dispose only while the wrapper is still the current dispatcher. With both values `unset` — the shipped default — nothing is installed. |
| Client `inject` | `['slots', 'locale', 'configForms', 'remote']` (`client.js:2419`) |
| Settings slot | `settings.section`, `id: 'llm-api-call-tuning'`, `order: 45`, `locale: 'llm-api-call-tuning'`, `label: () => t('nav')` (`client.js:2441-2449`) |
| Host ↔ Client wire | **No RPC channel of its own.** Reads and writes ride the shared settings form mirror (`configForms`), whose `mutate()` calls the Host `settings.mutate` (`packages/client/ui-settings/src/client/config-form.ts:129-151`). The provider directory is read from the Client Remote namespace `llm` (`llm.listProviders()` + `llm.listConfigurableProviders()`). |
| Mount patch seed | **nothing**: the row carries no `config`, so the global defaults start on the upstream code defaults, both fetch timers start `unset`, and a fresh install changes no provider behavior |

The host `Config` is registered with `settings.configure({ auto: false }, ctx.fiber)` so the
auto-generated generic page for this namespace is suppressed and the hand-written page is the only page
for the row. This is the documented own-page idiom, but the suppression itself is currently a **no-op
guarantee**: `autoGenerate` exists for clients that build pages from a namespace schema, and no shipped
DSH client does so yet (`packages/settings/settings/README.md:39`), so that call is future-proofing. It
is guarded: a policy conflict warns instead of failing boot.

`apply(ctx, config)` has a **second, independent job** besides that page policy: it installs, updates,
and restores the process-wide fetch-timeout dispatcher (see *Fetch timeout dispatcher*). That job lives
in its own `ctx.effect`, so the wrapper and its two reload listeners are owned by this row's fiber.
`apply()` therefore no longer "only suppresses the page"; it has exactly these two jobs and still owns no
projection state.

## Config fields (this plugin's own namespace)

Six retry fields, one per retry value, **plus two process-wide fetch fields** — eight fields total, in
that order in `Config.dict`. **Every leaf is `.volatile()`**: a settings edit commits into the running
fiber without a remount (`vendor/loader/src/config/entry.ts` `_commitVolatile`,
`vendor/loader/src/config/diff.ts` `equalExceptVolatile`). The root is a plain schemastery object
because `volatileForm()` only descends object roots
(`packages/settings/settings/src/schema.ts:37-47`); a transform/refine/union at the root would cost the
whole settings section.

For the six retry rows, the *Code default* column is the upstream resolution fallback
(`retry-policy.ts:14-22`), also the value an unconfigured provider route resolves to
(`retry-policy.ts:149-158`). It is recorded once in `index.js` (`DEFAULT_TUNE`, `TUNE_OPTIONS`) and
pinned by `verify.mjs` against the upstream file text. The two fetch rows carry `unset` because their
schema deliberately has no `.default()`: see *Fetch timeout fields (tri-state)*.

| Field | Schemastery shape | Code default | Range (enforced by) |
| --- | --- | --- | --- |
| `mode` | `union([const('normal'), const('always')]).default('normal').volatile()` | `'normal'` | `'normal'` or `'always'` (upstream `resolveRetryPolicy` switch, `retry-policy.ts:149-195`) |
| `maxRetries` | `number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(5).volatile()` | `5` | integer 0..9007199254740991 (upstream `number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)`, `retry-policy.ts:89`; load-time `Number.isSafeInteger` assert `retry-policy.ts:167-169`) |
| `initialDelayMs` | `number().min(Number.MIN_VALUE).max(2147483647).default(500).volatile()` | `500` | finite and > 0, at most 2147483647; must not exceed maxDelayMs (upstream schema `retry-policy.ts:82`; load-time asserts `retry-policy.ts:127-135`; the order rule is cross-field and lives in `validateTune`) |
| `maxDelayMs` | `number().min(Number.MIN_VALUE).max(2147483647).default(10000).volatile()` | `10000` | finite and > 0, at most 2147483647; must not be below initialDelayMs (upstream schema `retry-policy.ts:83`; load-time asserts `retry-policy.ts:130-135`) |
| `jitterRatio` | `number().min(0).max(1).default(0.1).volatile()` | `0.1` | number in [0, 1] (upstream schema `retry-policy.ts:84`; load-time assert `retry-policy.ts:136-138`) |
| `retryableCodes` | `array(union(five consts)).min(1).default(all five).volatile()` | `'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'` | non-empty array of unique codes from the five upstream codes (upstream schema `retry-policy.ts:90`; load-time asserts `retry-policy.ts:170-178`; uniqueness is cross-field and lives in `validateTune`) |
| `headersTimeoutMs` | `number().step(1).min(0).max(2147483647).volatile()` — deliberately **no** `.default()` | `unset` | `unset` (absent materializes as `undefined`; `null` in `DEFAULT_FETCH`), or integer `0..2147483647`; `0` disables the timer (Host schema; `.step(1)` refuses fractions, `.min(0)` allows disabled, `.max` is the timer cap) |
| `bodyTimeoutMs` | `number().step(1).min(0).max(2147483647).volatile()` — deliberately **no** `.default()` | `unset` | `unset` (absent materializes as `undefined`; `null` in `DEFAULT_FETCH`), or integer `0..2147483647`; `0` disables the timer (same Host schema bounds) |

`DEFAULT_TUNE` is frozen, and so is its `retryableCodes` array.

### Fetch timeout fields (tri-state)

The two process-wide fetch fields are the last two rows of the field table above; they are declared once
in `FETCH_FIELDS`/`FETCH_OPTIONS` and merged after the retry fields in `Config`. They are deliberately
**not** in `TUNE_KEYS`, `TUNE_OPTIONS`, `DEFAULT_TUNE`, or `validateTune()`: the retry surface is
pinned and documented separately.

The tri-state contract is exactly three states per field:

- **absent / `null` = `unset`** — the shipped state and what a fresh install resolves. `unset` means
  **no behavior change**: no wrapper timeout is filled, the Host/Node/undici default applies, and the
  plugin installs no timer. `Config({})` materializes both leaves as absent volatile nodes; an explicit
  `null` input is accepted and materializes `null`.
- **`0` = explicitly disabled** — a real value, not unset. The wrapper passes it through, and undici
  treats a zero timeout as disabled.
- **integer `1..2147483647` = custom milliseconds** — the wrapper fills that value on requests that do
  not set their own.

`FETCH_KEYS`, `DEFAULT_FETCH`, and `FETCH_OPTIONS` are frozen. `DEFAULT_FETCH` is the single place the
unset default lives; flipping it to a number would seed a timer and is not the shipped state.

### Why the delay floor is `Number.MIN_VALUE`

schemastery has **no exclusive minimum**, while upstream rejects `0` and negatives
(`retry-policy.ts:127-132`). `Number.MIN_VALUE` is the smallest positive double, so
`0 < Number.MIN_VALUE`: `0` and every negative value are refused by `Config` while any positive
configured delay passes. A delay of exactly `0` is therefore a Host-schema refusal, not a page-only
refusal, and the page's own pre-check uses the same `> 0` rule.

### Rules the schema cannot express

- **`initialDelayMs <= maxDelayMs`** (`retry-policy.ts:133-135`). Both fields are individually in range
  and schemastery accepts the tuple; `validateTune()` (Host) and `validateDraft()` (page) refuse it.
- **Unique `retryableCodes`** (`retry-policy.ts:176-178`). A schemastery array cannot express "no
  duplicates", so `Config` accepts `['SERVER','SERVER']` and `validateTune()` is what refuses it. The
  page never submits duplicates, but a direct `settings.mutate` that bypasses the page can persist them
  in this plugin's own defaults row.
- **The provider-owned schema is looser than this `Config`.** Upstream accepts any non-empty string as a
  retryable code (`retry-policy.ts:90,170-178`); this plugin's allowlist is the five stable codes that
  the upstream policy ships with, because those are the codes the retry classifier can match. A
  hand-written provider `retryPolicy` naming another string is shown on the page as the five known
  codes (unknown entries are dropped; an all-unknown list falls back to all five), and a page save then
  writes the known subset.
- **The fetch fields have no cross-field rule.** Their whole contract is the per-field tri-state above,
  so `validateTune()` does not cover them: the schema is the enforcement boundary, and `0` is valid.

### `validateTune(values)` — the cross-field half

`index.js` exports `validateTune()`; it is the Host-side guard the page's rules are documented against,
and `verify.mjs` exercises it directly. It never throws, accepts a partial tune (every `undefined`
field falls back to `DEFAULT_TUNE`), and returns a **frozen** array of stable problem codes, empty when
the tune is safe to write:

| Problem code | Rule |
| --- | --- |
| `mode` | must be `'normal'` or `'always'` |
| `maxRetries` | must be a non-negative safe integer |
| `initialDelayMs` | must be finite, `> 0`, `<= 2147483647` |
| `maxDelayMs` | must be finite, `> 0`, `<= 2147483647` |
| `delayOrder` | `initialDelayMs` must not exceed `maxDelayMs` (only checked when both are individually valid) |
| `jitterRatio` | must be finite and within `[0, 1]` |
| `retryableCodes` | must be a non-empty array of unique strings from the five upstream codes |

Problem codes are emitted in that field order when several rules fail at once. A direct write of
`{ initialDelayMs: 20000, maxDelayMs: 10000 }` is thus refused as `['delayOrder']`, not as two field
problems.

## Source-of-truth rule

The provider rows are the **source of truth** for a route's policy; the plugin's own defaults are a
preset, never a fallback layer.

- **Provider rows are authoritative.** A route's effective retry policy is whatever the provider's own
  settings namespace resolves (`snapshot.value` of the provider's config form). The page paints that
  value; it owns no copy and projects nothing.
- **The global defaults are presets only.** Saving them writes this plugin's own six fields and changes
  no provider. They are applied only by an explicit **Use defaults** (one row, staged then Saved) or
  **Apply defaults to all active providers** (each row written separately); a provider that refuses
  keeps its policy.
- **The plugin's row is not a fallback.** A provider with no `retryPolicy` keeps resolving the upstream
  code defaults, not this plugin's stored defaults; the defaults are a value the user can copy, not a
  layer that silently feeds every route.
- **The listing is derived from effective values, not from stored state.** The per-route tier shows a
  route only when it **deviates**: its effective stored retry policy differs in at least one leaf from
  the plugin's global effective retry values (`normalizePolicy` of this plugin's own `snapshot.value`),
  or one of its owned timeout leaves is explicitly present in the user layer. A stored retry override
  that happens to equal the global values is hidden (but the route stays pickable, so the page never
  loses the ability to address it); presence, not value, is the only meaningful timeout test because
  the global fetch timers are undici transport timers, not the route's application-layer watchdogs.
- **The fetch timers are not a preset and not a per-provider fallback.** They are a process-wide side
  effect of this plugin's row. The global card's retry half, a route card's Save/Reset, and "Apply
  defaults to all" never read, write, or project the two fetch leaves onto a provider route;
  conversely, the global card's fetch half writes only its two flat leaves in this plugin's own
  namespace.
- **Provider timeouts are provider-owned leaves, not `Config` fields and not presets.** The merged route
  card paints the row's user layer and writes only that route's changed timeout leaves in the
  provider's own namespace, in the same atomic write as its retry leaves;
  `PROVIDER_TIMEOUT_FIELDS`/`PROVIDER_TIMEOUT_KEYS`/`PROVIDER_TIMEOUT_OPTIONS` are frozen metadata for
  the page/docs/verify, and `Config` deliberately keeps its six retry + two fetch fields.
- **Per-write gate and revision fencing.** A write is attempted only when the target form's freshest
  snapshot is `ready`, not explicitly read-only (`writable !== false`), and carries a **numeric**
  revision; that same read supplies the fence as one atomic `mutate(ops, revision)`, so the page never
  sends an unconditional write (an `undefined` `expectedRevision` reaches the Host as unconditional,
  `packages/api/settings-controller/src/index.ts:111,128,147,152`). A row failing the gate is **skipped,
  not written**: the route's actions are disabled, and "Apply defaults to all" records the outcome
  `'skipped'` in the section-level summary.
  Two rows that share a namespace (`llm-pi-ai`) each read that namespace's revision immediately before
  their own write, so the second never uses a stale fence. A refusal makes the controller perform its
  own recovery read; if that read moved the revision, the page retries **once** at the fresh revision
  and never again.
- **Local-first validation.** The page refuses an invalid draft itself (no Host call). A direct
  `settings.mutate` written outside the page can bypass that, which is why `validateTune()` and the
  schema bounds are also documented as Host-side rules.

## Fetch timeout dispatcher (host side effect)

`apply(ctx, config)` mounts a second `ctx.effect` that calls `installFetchTimeouts(ctx, config)`. This
is opt-in by value, not by a flag: it performs **no** dispatcher work while both fetch fields are
`unset`, and installs only once at least one of them is a number. There is deliberately no extra
enable/disable boolean.

**Resolution.** The bundle ships no `node_modules`. The host half resolves `undici` from the running
Host through `createRequire` anchors, in order: the Host-context anchor derived from `ctx.baseUrl` (the
profile directory the deployed GUI actually resolves plugins from), this module's own location, the
process entry, and `$DSH_HARNESS_CHECKOUT`'s pnpm store. If no anchor resolves a module with
`getGlobalDispatcher`/`setGlobalDispatcher`/`EnvHttpProxyAgent`, the effect warns **once** and is a
no-op; a missing `undici` never fails the Host boot. A failed resolution is cached for the module
lifetime.

**Install / update / restore.**

- On the first numeric value it snapshots `getGlobalDispatcher()`, wraps **that** dispatcher (never a
  bare agent, so DSH's own proxy routing survives), and calls `setGlobalDispatcher()` with the wrapper.
- When `NODE_USE_ENV_PROXY` is set, the wrapper's target is a new `EnvHttpProxyAgent`; otherwise it
  wraps the snapshot dispatcher itself.
- The wrapper fills `headersTimeout`/`bodyTimeout` only for options the request left nullish. A
  per-request value always wins. `0` is passed through as a real "disabled" value; an `unset` field is
  left absent, so the dispatcher's own default applies.
- The live values are re-read on every dispatch, so changing one on an installed wrapper takes effect on
  the next request **without reinstalling**. The wrapper also delegates every other member to the
  target, so `close()`, `destroy()`, and interceptors keep working.
- Volatile-only settings commits do not re-run `apply()`, so the effect also re-reads the live values on
  `loader/volatile-update` and `app-boot/config-reload`: setting a first value installs, clearing the
  last one restores.
- Clearing every value restores the previous dispatcher **only while the wrapper is still the current
  dispatcher**; a dispatcher installed after ours wins. Both listeners stay registered while the values
  are `unset` (a later live save must be able to install again); the disposer detaches them, restores
  the previous dispatcher under the same "still current" rule, and closes an env-proxy agent it created.
- Applying with both values `unset` is a pure no-op: no dispatcher is read, replaced, or restored.

**Blast radius.** The timer limits are **process-wide** and shared by every provider route, web search,
and HTTP MCP server in the Host process; there is no per-provider HTTP timeout. A request already
in flight keeps the timeout it started with.

**Why a stopgap.** DSH has no native global fetch-timeout setting. The wrapper behavior is adapted from
the MIT-licensed `dsh-fetch-timeouts` project (© 2026 Dev Mehra); the attribution and provenance are in
the repository root `THIRD-PARTY-NOTICES.md`. The stopgap may be removed once DSH exposes an equivalent
native setting.

## Provider namespaces and retry-policy addresses

The provider directory comes from the Client Remote namespace `llm`: `listProviders()` (live routes)
joined with `listConfigurableProviders()` (declared configurable routes), exactly like the Models page
(`ui-settings-models/src/client/store.ts:45-76`). Each editable row carries a provider-owned settings
address:

| Provider route | `settingsNs` (owner row id) | `settingsPath` | Retry policy address |
| --- | --- | --- | --- |
| `deepseek-official` | `llm-deepseek` | `[]` | `['retryPolicy']` |
| `deepseek-account` | `llm-deepseek-account` | `[]` | `['retryPolicy']` |
| any `llm-pi-ai` route (e.g. `openrouter`) | `llm-pi-ai` | `['providers', <id>]` | `['providers', <id>, 'retryPolicy']` |

`settingsNs` is whatever the adapter declares (`ctx.fiber.entry?.options.id ?? name`, e.g.
`llm-pi-ai/src/index.ts:139` for the path and `llm-deepseek/src/index.ts` for the namespace), so a
profile that renames the row still works; the page never hardcodes a provider namespace. Only rows that
are **active** (present in `listProviders()`), declare a non-empty `settingsNs`, and hold a live shared
form are addressable: they are the only routes the picker offers and the only ones a deviating list can
contain. A declared-but-dormant directory entry (never in `listProviders()`), a route without a settings
namespace, and a route whose namespace the deployment does not serve are **neither listed nor
pickable** — without a live config form their deviation cannot be proven, and there is no snapshot to
read.

The merged card's two halves address the **same provider namespace and the same provider settings
path**, which is what makes the merge sound: for an `llm-pi-ai` route the retry leaves sit under
`providers.<route>.retryPolicy` and the timeout leaves under `providers.<route>.` (one level up), and
for the two DeepSeek routes both sit at the namespace root (`retryPolicy.*` and the flat timeout
leaves). One card therefore writes one provider family with one save, at one revision fence.

The policy shape follows the upstream union (`retry-policy.ts:87-101`): `normal` carries `mode`,
`maxRetries`, `retryableCodes`, `backoff`; `always` carries `mode` and `backoff`, and the other two
leaves are inactive. A route card shows an `always` draft without the retry-limit/code controls and
clears those leaves when saving.

## Provider timeout fields (per-route, provider-owned)

The **Timeouts** sub-group inside each merged route card edits three application-layer timeout leaves
that live in the **provider's** settings namespace. They are ordinary DSH provider settings, not fields
of this plugin's `Config`; the host half only publishes frozen metadata (`PROVIDER_TIMEOUT_FIELDS`,
`PROVIDER_TIMEOUT_KEYS`, `PROVIDER_TIMEOUT_OPTIONS`) that the page, the docs, and `verify.mjs` read. The
page writes them through the provider's own shared form, exactly like `retryPolicy`, and merges them
into the same op list as the card's retry leaves.

| Field | `settingsNs` | `settingsPath` + leaf | Code default | Accepted by the page |
| --- | --- | --- | --- | --- |
| `streamIdleTimeoutMs` | `llm-pi-ai`; `llm-deepseek`; `llm-deepseek-account` | `['providers', <route>, 'streamIdleTimeoutMs']`; `['streamIdleTimeoutMs']` at the two DeepSeek roots | `300000` ms (5 min), upstream `DEFAULT_STREAM_IDLE_TIMEOUT_MS` | blank = unset (package default), or integer `1..2147483647`; `0` refused |
| `timeoutMs` | `llm-pi-ai` only | `['providers', <route>, 'timeoutMs']` | `unset` = SDK default (about `600000` ms); DSH records no default (`z.natural()`) | blank = unset (SDK default), or integer `1..2147483647`; `0` refused |
| `filesApiTimeoutMs` | `llm-deepseek`; `llm-deepseek-account` only | `['filesApiTimeoutMs']` at the two DeepSeek roots | `60000` ms (1 min), upstream `DEFAULT_FILES_API_TIMEOUT_MS` | blank = unset (package default), or integer `1..2147483647`; `0` refused |

**Blank = unset = keep the package/SDK default.** The card seeds the timeout draft from the **user
layer** only: a stored override paints its number, and an untouched route paints blank even when the
effective value the Host reports is the package default (`300000` / `600000` / `60000`). Save writes only
the leaves whose draft changed; an untouched control writes nothing.

**`0` is refused, and there is no off switch.** The upstream DeepSeek and stream-idle schemas require a
strictly positive value and their load-time asserts reject `<= 0`; a zero SDK request timeout would
abort every request immediately. None of the three schemas has a "disabled" state, so the page's
**Unlimited** preset fills the maximum `2147483647` ms (about 24.8 days) — a cap, not an off switch. `zeroRejected` and `unlimitedPreset` are recorded in the metadata and pinned by `verify.mjs`.
A **direct `settings.mutate`** (or a hand-edited profile patch) can still persist `0`; for the two
watchdogs that fails the provider's load-time assert and the route then fails to resolve, which is the
failure this page prevents.

**Addressable routes only.** A route is listed and pickable only when it is active, carries a non-empty
`settingsNs`, and holds a live shared form; a dormant route, a route without a settings namespace, or a
route whose namespace is not served never appears and is never written. Each card additionally requires
a `ready` snapshot, `writable !== false`, and a numeric revision before any action is enabled. Writing a
timeout leaf into `providers.<route>` would materialize a partial provider profile and could activate
the dormant route, so the page blocks it by not addressing such a route at all.

**SDK / transport interplay.** For SSE routes the SDK request timeout (`timeoutMs`, ~600 s by default)
bounds the wait for **response headers**, `streamIdleTimeoutMs` bounds silence **between** streamed
chunks, and the process-wide fetch `bodyTimeoutMs` bounds the transport between chunks. Raising only the
idle window does not help when an SDK or transport deadline still fires first, so the card shows two
**non-blocking** advisories (`timeouts.advisory.sdkFirst`, `timeouts.advisory.transportFirst`). A
failure reported as an **`llm-pi-ai` stream idle timeout after 300000 ms** is the default idle watchdog
aborting a slow first token (TTFT stall); raise `streamIdleTimeoutMs` on the route card (and match
`timeoutMs` / `bodyTimeoutMs`) instead of hand-editing the profile.

**`connectTimeoutMs` is out of scope.** undici has no per-request connect timeout in versions 6, 7, or 8,
and only a fragile agent rebuild could express one. A transport connect limit belongs upstream in
`packages/util/http-proxy/src/install.ts` (the proxy-aware dispatcher install, around lines 154-167), not
in this page. This is recorded here so the omission is intentional, not an oversight.

The upstream defaults and schema bounds the metadata mirrors are pinned against `$DSH_HARNESS_CHECKOUT`:
`llm-deepseek/src/defaults.ts` (`DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`,
`DEFAULT_FILES_API_TIMEOUT_MS = 60_000`), `llm-deepseek/src/config.ts` and `llm-pi-ai/src/config.ts`
(`z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS)`, `timeoutMs: z.natural()`).

## Write operation shapes (exact)

Every write is one atomic list of **leaf-path operations** (`SettingsPathOp`):
`{ op: 'set', path: string[], value }` or `{ op: 'unset', path: string[] }`.

- **Global card Save** — one ordered list on this plugin's own namespace: the six retry `set` leaves
  (in `TUNE_KEYS` order) followed by the two fetch leaves (one op per field in `FETCH_KEYS` order; an
  empty draft field is `unset`, and a typed value — including `0` — is `set`):

  ```json
  [
    { "op": "set", "path": ["mode"], "value": "normal" },
    { "op": "set", "path": ["maxRetries"], "value": 5 },
    { "op": "set", "path": ["initialDelayMs"], "value": 500 },
    { "op": "set", "path": ["maxDelayMs"], "value": 10000 },
    { "op": "set", "path": ["jitterRatio"], "value": 0.1 },
    { "op": "set", "path": ["retryableCodes"], "value": ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"] },
    { "op": "set", "path": ["headersTimeoutMs"], "value": 0 },
    { "op": "unset", "path": ["bodyTimeoutMs"] }
  ]
  ```

  Both sub-groups travel in that ONE write at ONE revision fence. The global card's **Reset to system
  defaults** is the fetch-only Reset documented below; the six retry defaults have no reset op (saving
  the code-default values is the equivalent).

- **Route card Save, retry half** — the six managed leaves are

  ```
  [...settingsPath, 'retryPolicy', 'mode']
  [...settingsPath, 'retryPolicy', 'maxRetries']
  [...settingsPath, 'retryPolicy', 'retryableCodes']
  [...settingsPath, 'retryPolicy', 'backoff', 'initialDelayMs']
  [...settingsPath, 'retryPolicy', 'backoff', 'maxDelayMs']
  [...settingsPath, 'retryPolicy', 'backoff', 'jitterRatio']
  ```

  but they are written **relative to the global retry values** and to what the user layer stores: a leaf
  whose validated value differs from the global value is `set`; a leaf that equals the global value is
  `unset` when (and only when) the user layer stores it, so a stored-but-equal override is cleaned up
  and an untouched leaf is never written. `retryableCodes` is compared as an ordered list of the five
  known codes. In an `always` draft the two normal-only leaves are inactive, so a stored
  `maxRetries`/`retryableCodes` is `unset` instead, keeping the upstream union's shape. When the
  resulting list is non-empty and contains **only** unsets, it collapses into the single reset op:

  ```
  unset [...settingsPath, 'retryPolicy']
  ```

- **Route card Save, timeout half** — only the CHANGED leaves for the row's family, in field order. A
  pi-ai route writes under `['providers', <route>]`; the two DeepSeek routes write at the namespace
  root:

  ```json
  [
    { "op": "set", "path": ["providers", "openrouter", "streamIdleTimeoutMs"], "value": 1800000 },
    { "op": "set", "path": ["providers", "openrouter", "timeoutMs"], "value": 1800000 }
  ]
  ```

  ```json
  [
    { "op": "set", "path": ["streamIdleTimeoutMs"], "value": 600000 },
    { "op": "set", "path": ["filesApiTimeoutMs"], "value": 120000 }
  ]
  ```

  Clearing a seeded leaf emits its unset instead, for example
  `{ "op": "unset", "path": ["providers", "<route>", "timeoutMs"] }`; an untouched field emits nothing.

- **Route card Save, whole list** — one `mutate(ops, revision)` at one revision fence: the retry ops
  (when the retry draft changed) followed by the changed timeout ops, in that order. A route with no
  changed leaf at all emits an empty list and its Save stays disabled; a route whose retry draft is
  unchanged contributes no retry ops.

- **Route card Reset** — one write: the whole `retryPolicy` unset followed by one unset per timeout leaf
  THIS card owns for the row's family, and nothing else:

  ```json
  [
    { "op": "unset", "path": ["providers", "openrouter", "retryPolicy"] },
    { "op": "unset", "path": ["providers", "openrouter", "streamIdleTimeoutMs"] },
    { "op": "unset", "path": ["providers", "openrouter", "timeoutMs"] }
  ]
  ```

  For a DeepSeek route the last two paths are `['streamIdleTimeoutMs']` and `['filesApiTimeoutMs']`.
  A picked card that stores nothing yet (no `retryPolicy` and no owned timeout leaf in the user layer)
  is closed **locally** by Reset: no operation at all is sent.

- **Picking a route** — **no write**. The card is materialized in local state from the effective values
  and persists nothing until a field is edited and the card is saved.

- **Fetch timeouts Reset** (global card, "Reset to system defaults") — exactly two unsets, in field
  order, so the process-wide system defaults apply again:

  ```json
  [
    { "op": "unset", "path": ["headersTimeoutMs"] },
    { "op": "unset", "path": ["bodyTimeoutMs"] }
  ]
  ```

**Never:** a whole `retryPolicy` object set (that would materialize schema defaults over a hand-written
profile), a whole `providers` dict set (that would clobber sibling provider fields), or a profile-object
set. Every `set` op addresses one leaf; the only subtree unsets are Reset's `retryPolicy` and the
route's own timeout leaves. The two fetch leaves are always **flat** (`['headersTimeoutMs']`,
`['bodyTimeoutMs']`), never nested under a `fetchTimeouts` object, and they never appear in a route
card's Save/Reset or in "Apply defaults to all". A route card's op list may carry retry and timeout ops
together, but each op addresses one leaf of that route's own address; "Apply defaults to all" emits
retry ops only.

### Refusal copy, and the defensive "managed elsewhere" branch

`ConfigFormController.mutate()` converts **every** failed `settings/mutate` reply into `false`
(`packages/client/ui-settings/src/client/config-form.ts:135-137`): the gateway client returns
`{ ok: false, error }` envelopes for Host refusals (`packages/api/gateway/src/client/index.ts:461-472`),
the controller performs its own recovery read and resolves `false`. The refusal reason is therefore
**not observable** through the page's write API.

Consequently **every Host refusal — including one caused by a home patch or `--patch` overlay owning
the row (`packages/api/settings-controller/src/index.ts:257-267`; marker
`packages/boot/config-editor/src/index.ts:139`) — shows the generic refusal copy (`error.refused`)**,
and the fields re-seed from the Host's recovery read. The page does **not** claim to distinguish a
managed row through this path.

`refusalKind()` still classifies a **rejection** as "managed elsewhere" (`error.managed`) when it
carries code `settings/rejected` or the config editor's override marker. That branch is **defensive
only and unreachable through `ConfigForm`**: the controller never rejects for a Host refusal; the only
realistic rejection is a local "no active Connection" assembly fault
(`packages/api/gateway/src/client/index.ts:456`), which is a transport failure, not a managed row.
The branch is retained so a direct `RemoteError` caller/harness gets the right copy, and `verify.mjs`
exercises it as a unit test of the classification path, explicitly marked defensive.

## Persistence and live semantics

- A save writes through the shared settings form (`configForms.get(ns).mutate`), i.e. the same
  `settings.mutate` path as the Models page; the settings service persists the change into the active
  profile's `cordis.patch.yml` (the profile's own patch, next to its `package.json`). The plugin ships
  no storage of its own.
- Retry-policy changes are expected to take effect on the **next model request**, with **no backend
  restart**: every consumer captures a route's policy at **registration** (`packages/llm/llm/src/index.ts:435-470`,
  `prepareRoutes`), and each provider re-registers its routes when the loader reports a changed
  volatile value. `llm-deepseek`/`llm-deepseek-account` do that in `llm-deepseek/src/host.ts:82-90`;
  `llm-pi-ai` does it by including `retryPolicy` in its `registrationFacts()` and re-registering on
  `loader/volatile-update` (`llm-pi-ai/src/index.ts:108-120,289-319`). That event is emitted after a
  volatile config commit (`vendor/loader/src/config/entry.ts:181-195`). `verify.mjs` pins the write
  path and the page contract, not a live save; the live latency is a deployment property.
- **A request already in flight keeps the policy it started with.** There is no mid-request update.
- **Route-card timeout changes persist in the provider's namespace** and are picked up with the next
  request/route registration; there is no global timer and no projection of these leaves onto another
  route. A dormant, unaddressed, or unserved route is not listed or pickable and is never written.
- **Picking a route persists nothing.** The card is local state until an edit plus Save; the deviating
  list and the picker recompute on any provider form snapshot change (a write from another page
  included), while the provider **directory** itself is read once per mount.
- **Fetch-timer changes take effect on the next HTTP dispatch.** The wrapper re-reads the live values on
  every request, so a save needs no backend restart. The two leaves persist in this plugin's own
  settings namespace like every other Host setting; Reset (or clearing both) restores the system-default
  state. A request already in flight keeps the timeout it started with.
- The **page itself** needs a full page reload to appear after install/upgrade; a first install may also
  need a backend restart before the bundle patch is discovered. Neither is needed for a value change.
- Uninstalling the bundle removes this plugin's row and page. It does **not** revert `retryPolicy`
  values already written into provider rows, and the plugin performs no automatic migration.

## Known limitations

- **No cross-provider transaction.** "Apply defaults to all" writes one provider at a time, each at its
  own freshly read revision. If one provider refuses, the already-written providers stay written and the
  later ones are untouched; a provider whose form is not `ready`/writable/fenced is **skipped** instead
  of written, and the section-level summary reports each route's outcome (`saved` / `refused` /
  `managed`, plus `skipped`). There is no rollback.
- **A home-patch or `--patch` override refuses writes.** When the config editor refuses a row because a
  home patch or command-line overlay owns it, the page cannot write it. Through `ConfigForm` that
  refusal resolves `false` and the page shows the **generic refusal copy**, not "managed elsewhere" (the
  managed classification is defensive-only; see *Refusal copy*). There is no force path and no way to
  see the overlay's value beyond the effective value the Host reports.
- **In-flight requests keep the old policy**, as above.
- **Per route, not per model, and there is no per-model seam.** DSH captures one retry policy per
  **provider route** at adapter registration (`packages/llm/llm/src/retry-policy.ts:78,450-455`), and
  the agent/request-error payload carries the provider but no model
  (`packages/core/agent/src/runtime-types.ts:389`). A per-model override would be stored and rendered
  but never applied, so the page deliberately does not offer one and does not relabel routes as models.
- **A stored retry override equal to the global values is hidden.** The list is a list of deviations,
  not of stored state, so a `retryPolicy` identical to the global retry values produces no card and a
  stored-but-equal leaf is only cleaned up by a later route-card save that emits its `unset`. A timeout
  leaf, by contrast, is listed by **presence**, even when its value equals the package default.
- **Dormant, unaddressed, and unserved routes are not listed and not pickable.** `llm-pi-ai` lists
  declared provider profiles even when the route is not currently active, but the page only addresses
  routes that are active, carry a settings namespace, and hold a live config form: without a live form
  a route's deviation cannot be proven, and writing a timeout leaf would materialize a partial provider
  profile and could activate a dormant route. Such a route therefore never appears and is never written.
- **The provider directory is read once, when the section mounts.** `readProviders()` runs in one
  mount effect (`client.js:2024-2033`) and the page does **not** subscribe to
  `llm/adapters-updated`, `settings/document-updated`, or `connection/reset` the way the Models page
  does (`packages/client/ui-settings-models/src/client/index.ts:122-128`). Provider **form** snapshots
  are subscribed, so the deviating list and the picker still recompute when a provider form changes;
  the directory itself is only re-read when the section remounts. Navigating away and back re-reads; a
  provider added or removed while the page stays open needs a page reload.
- **Only the deployment's own directory is addressable.** A provider route that is not returned by
  `llm.listProviders()` / `llm.listConfigurableProviders()` cannot be edited here; the page does not
  guess namespaces.
- **The five-code allowlist is narrower than the provider schema.** Upstream accepts any non-empty
  string code; this page only offers the five stable codes and normalizes an unknown stored list when
  it saves. Codes outside the five can be stored by hand but the retry classifier would never match
  them, so the narrowing is deliberate.
- **Duplicate codes are not a `Config` error.** Only `validateTune()` refuses them; a direct Host write
  can persist them in this plugin's own defaults row, and the page will refuse to submit that draft.
- **`Config`'s numeric bounds do not reject `NaN`.** schemastery compares a value against `.min()`/`.max()`
  and a `NaN` comparison is false, so `Config({ initialDelayMs: NaN })` is accepted even though the
  documented range says "finite". The page's own parser and `validateTune()` both refuse `NaN`, and
  `verify.mjs` pins this schemastery behaviour so a change in either direction is noticed.
- **The runtime policy is read from the provider, not re-validated by this plugin.** A hand-written
  provider `retryPolicy` is accepted if the provider's own schema accepts it; the page's five-code
  allowlist and cross-field rules describe what the page will write, not a Host-side guarantee.
- **The page's local validation is not the Host schema.** A direct `settings.mutate` (or a hand-edited
  profile patch) can still write a provider policy that the provider's own loader will reject at load
  time; the page's refusal is a UX guard, not an enforcement boundary.
- **Provider timeouts are per route, and `0` is refused.** The page refuses `0` because the DeepSeek /
  stream-idle schemas reject it and a zero SDK request timeout aborts every request immediately; the
  **Unlimited** preset writes the `2147483647` ms cap (about 24.8 days) instead of an off switch. A
  direct `settings.mutate` can still persist `0`, which fails the provider's load-time assert and makes
  the route fail to resolve.
- **`connectTimeoutMs` is out of scope.** undici has no per-request connect timeout in versions 6, 7, or
  8; a transport connect limit belongs upstream in `packages/util/http-proxy/src/install.ts` (around
  lines 154-167), not in this page.
- **The route card's advisories are heuristics, not enforcement.** They compare the card's draft values
  (and the global fetch body-timeout draft) locally; a shorter deadline set through a direct write or a
  different namespace layer is not detected, and the advisories never block Save.
- **The fetch timers are process-wide.** They limit the shared undici dispatcher for every provider
  route, web search, and HTTP MCP server in the Host process. There is no per-provider HTTP timeout; a
  per-request timeout set by a caller always wins. `unset` leaves the system/DSH default untouched, `0`
  disables that timer, and a positive integer sets it.
- **The dispatcher wrapper is a stopgap adapted from upstream.** It is adapted from the MIT-licensed
  `dsh-fetch-timeouts` project (© 2026 Dev Mehra); attribution and provenance are in the repository root
  `THIRD-PARTY-NOTICES.md`. It is not a DSH-native setting, and its resolution depends on the running
  Host/profile providing `undici`; when it does not, the plugin warns once and applies no timer.
- **The live timing cannot be proven offline.** `verify.mjs` pins the wrapper's install, fill, re-read,
  restore, and dispose shape against a recording fake dispatcher plus the Host's real `undici` globals,
  and covers the missing-`undici` no-op in a child process. It cannot prove that a real HTTP request
  actually times out after the configured milliseconds; that remains a deployment check.
- **Not published to any npm registry**, and `verify.mjs` is a hermetic offline suite: it starts no
  Host and no browser, so it cannot confirm a live GUI save, the nav row's real position in the shell,
  the next-request latency, or live dispatcher timing.

## Client contract

### Registration (immediate)

`apply(ctx)` registers the dictionary and the section synchronously; there is no `whileServed` gate and
no deferred registration. `configForms` is a **declared** client inject, so a composition without the
settings service parks this fiber before `apply` runs: neither the dictionaries nor the section are
registered and the page simply does not activate. The `forms === undefined` guard in `client.js:2436`
is belt-and-braces for a direct harness/composition that calls `apply` regardless; in a real composition
it is never reached.

The section registration is:

```js
ctx.slots.register({
  name: 'settings.section',
  id: 'llm-api-call-tuning',
  order: 45,
  label: () => t('nav'),
  locale: 'llm-api-call-tuning',
  inject: () => ({ form, t, getForm, readProviders }),
}, TuningSection)
```

Order 45 follows the in-tree sections (account `-10`, general `0`, models `10`, plugins `15`,
agent-presets `20`) and the out-of-tree tools pages (`30`, `40`); it closes the nav without colliding.
The restructure adds **no** new nav row: the whole merged page is this one `settings.section`.

A slot component receives more than the injected face. `TuningSection` gets the renderer **kit**
(standard hooks and the framework `t` seat), the injected face `{ form, t, getForm, readProviders }`,
and the owner `close` prop (`packages/client/ui-renderer/src/client/scoped-slots.tsx:598-624`); it
destructures the four injected members and ignores `close`. The injected `t` overrides the kit's seat
and is the same bound function as the declared `locale` seat, so the duplication is harmless. Route
cards are a separate `RouteCard` child component rendered with `{ row, t, form, defaultsValues,
globalRetryValues, bodyTimeoutMs, onSettled }`, so a bare root render shows the global card and the
section notes only — a card's controls exist after the child mounts.

### Provider directory read

`readProviders()` resolves the Remote LLM namespace via `ctx.get('remote.llm')` and falls back to
`ctx.remote.llm`; it never rejects. `listProviders()` and `listConfigurableProviders()` may each answer
with a bare array or with an `{ ok: true, value }` envelope (a bare array is accepted too); the join
keeps the declared order, appends undeclared live routes, and marks a row active only when its provider
id appears in `listProviders()`. The read runs **once per mount** with no directory refresh
subscription (see *Known limitations*). Outcomes:

| Situation | Rendered note |
| --- | --- |
| no Remote service or no `listProviders` | `providers.unavailable` |
| an envelope reports `ok: false`, or a read throws/rejects | `providers.error` |
| ready but no rows | `providers.empty` |
| ready with rows | the candidate routes are the rows that are active, carry a non-empty `settingsNs`, and hold a live shared form (`withForms`) |

The page **owns no copy** of a route's state: it paints the effective value out of the provider form's
snapshot and writes leaf-path operations back through the same form. Provider **form** snapshots are
subscribed, so a change made anywhere (another page included) re-seeds the drafts and recomputes the
deviating list and the picker.

### Route card state (merged)

- **Listing rule (deviation).** A route is listed iff **(a)** its effective stored retry policy differs
  in at least one leaf from the plugin's global effective retry values (`normalizePolicy` of
  `snapshot.value` of this plugin's own section; `retryableCodes` compared as an ordered list), **or**
  **(b)** one of the timeout leaves that route owns is explicitly present in the user layer. The two
  halves are deliberately asymmetric: retry deviation is value-based, timeout deviation is
  presence-based, because the global fetch timers are undici **transport** timers with no counterpart to
  the route's application-layer watchdogs.
- **Stored-but-equal entries are hidden but remain pickable.** A stored `retryPolicy` identical to the
  global values produces no card; because the picker offers every candidate route that is not currently
  listed, the route can still be added, but adding it writes nothing.
- `snapshot.value` is the **effective** value; the retry policy is read at
  `[...settingsPath, 'retryPolicy']` and seeded into the retry draft. The timeout draft is seeded from
  `snapshot.user` only (blank = package/SDK default), so an untouched route never looks overridden.
- The card's *override* / *default* badge is driven by **retry `user` presence** only: it reflects
  whether the user layer stores its own `retryPolicy` at `settingsPath`, not whether the route is
  listed (a timeout-only deviation still shows *default*).
- **Picking.** `pickedRoutes` is local state: **Add** materializes one card prefilled from the
  effective values and writes nothing. Reset on such a card closes it locally, with no write.
- **Per-write gate.** A card is written only when the route is active, carries a non-empty `settingsNs`,
  holds a live form, and its freshest snapshot is `ready`, `writable !== false`, and carries a
  **numeric** revision; that same read is the revision fence. A route that fails the gate renders one of
  the read-only notes (`provider.status.dormant`, `provider.status.noSettings`,
  `provider.status.unavailable`, `status.loading`, `status.readOnly`) and its actions stay disabled. In
  practice the candidate filter already excludes dormant, namespace-less, and unserved routes, so such a
  route is never listed in the first place.
- `ConfigForms.get()` never throws for an unserved namespace; it returns a controller whose snapshot
  reports `unavailable`, which a card renders as its own note
  (`ui-settings/src/client/config-form.ts:270-282`).
- The page's own card renders `status.loading`, `status.unavailable` (the deployment does not serve
  `llm-api-call-tuning`), or `status.readOnly` instead of pretending to write.

### Page copy

The en and zh dictionaries are inline in `client.js` and carry the **same 120 keys**. English copy never
contains CJK text; every key has a non-empty Chinese value. The nav label is the `nav` key, the page
header/title is the `title` key, and `intro` describes the two tiers (the global card, then the
deviating-only per-route cards). The merged layout introduced `global.*` (card heading, description,
`retries` sub-group title, Save copy, note), `routes.*` (picker label/placeholder/Add, empty and
all-listed notes, the two sub-group titles, and the picked-card hint), `status.routeReset`,
`apply.outcome.*`, and the per-field `field.*` copy shared by the global retry sub-group and every route
card. The previous layout's separate `defaults.heading`/`defaults.note`, `fetch.save`/`fetch.saving`/
`fetch.status.*`, and `timeouts.heading`/`timeouts.description`/`timeouts.note`/`timeouts.save*`/
`timeouts.reset*` copy is gone; the remaining `timeouts.*` keys are the shared unit/hint/Unlimited/
protocol/advisory copy.

### Global card (retries + fetch timeouts), rendered first

The first card carries `global.heading` / `global.description` and two labeled sub-groups:

- **Retries** (`global.retriesHeading`, description `defaults.description`): the six retry controls from
  `renderRetryFields` — `mode`, `maxRetries`, `initialDelayMs`, `maxDelayMs`, `jitterRatio`, and the
  five-code `retryableCodes` fieldset. They are seeded from this plugin's own `snapshot.value` and are a
  preset: saving them changes no provider.
- **Fetch timeouts** (`fetch.heading`, description `fetch.description`): one text input per
  `FETCH_KEYS` field, built from the two **flat top-level** leaves of this plugin's own namespace. An
  absent/`null` leaf is painted **empty** (system default), `0` is painted as `0` (disabled), and a
  positive integer is painted as its digits. Local validation refuses negative, fractional, overflow,
  and non-integer text with `error.headersTimeoutMs` / `error.bodyTimeoutMs`; empty, `0`, and
  `1..2147483647` are accepted. **Reset to system defaults** (`fetch.reset`) submits the two flat
  unsets and paints `status.fetchReset`.

One **Save global settings** (`global.save`) validates both drafts and submits the combined op list
documented in *Write operation shapes* at one revision fence; it is disabled while either draft is
invalid, the form is not ready/writable, or this card's own save/Reset/apply is in flight. **Apply defaults to all
active providers** (`defaults.applyAll`) copies the validated retry values into every target row (active,
non-empty `settingsNs`, live form), re-gating each row immediately before its own write, and records
`apply.outcome.saved` / `refused` / `managed` / `skipped` in a section-level summary. The card also
renders `global.note` (retry values are a preset; the fetch halves are never projected) and
`defaults.applyAllNote`.

### Per-route section and merged card

The second card carries `providers.heading` / `providers.description`. Above the list is the native
**route picker**: a `<select>` whose options are the candidate routes that are not already listed and
not picked, labelled `${displayName} (${provider})`, with `routes.pickerLabel`, the
`routes.pickerPlaceholder` first option, and the `routes.add` button. The picker is disabled when no
route is pickable and says `routes.allListed` when no candidate is left to offer; when nothing deviates
the list shows `routes.empty`. Picking is local state only: nothing is written until an edit
plus Save.

Each deviating (or picked) route renders one merged `RouteCard`:

- Header: display name plus the retry-presence badge (`provider.source.override` /
  `provider.source.default`), the provider id, the namespace (`provider.namespace`), and the protocol
  (`timeouts.protocol`; pi-ai reads `snapshot.value.providers.<route>.api` and falls back to
  `timeouts.protocol.catalog`, DeepSeek always renders `anthropic-messages`).
- **Retry policy** sub-group (`routes.retryHeading`): the same six retry controls seeded from
  `[...settingsPath, 'retryPolicy']`; an `always` draft hides the two normal-only controls and renders
  `provider.alwaysNote`.
- **Timeouts** sub-group (`routes.timeoutsHeading`): the family's fields — a pi-ai card shows
  `streamIdleTimeoutMs` and `timeoutMs`, a DeepSeek card shows `streamIdleTimeoutMs` and
  `filesApiTimeoutMs`. Each is a text input seeded from the user layer, carries a per-field
  override marker and an **Unlimited** preset, and validates locally (`error.<key>`) exactly as
  described in *Provider timeout fields*. The non-blocking SDK/transport advisories
  (`timeouts.advisory.sdkFirst`, `timeouts.advisory.transportFirst`) render per card.
- Actions: **Save** (`provider.save`) writes the retry diff plus the changed timeout leaves in one
  `mutate(ops, revision)`; it is disabled when either draft is invalid or the op list is empty.
  **Reset** (`provider.reset`) writes the whole-`retryPolicy` unset plus the family's timeout unsets, or,
  on a picked card that stores nothing yet, just closes the card locally with no write. **Use defaults**
  (`provider.useDefaults`) copies the validated global retry values into the retry draft and persists
  nothing. A picked card that stores no override renders `routes.pickedHint`.
- Outcome copy: `status.saved` / `error.refused` / `error.managed`, and `status.routeReset` for Reset.

## Verify

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs
```

The suite is hermetic (`node:assert/strict`, fake Context/form/React doubles in `node:vm`, no network,
no server, no filesystem writes) and resolves the **real** `@deepseek-ai/schemastery`, the upstream
`retry-policy.ts`, and the Host's `undici` through `$DSH_HARNESS_CHECKOUT`, so schema and constant drift
fail loudly. It covers the manifest and bundle patch, the host `Config` accept/reject matrix (including
the fetch tri-state: unset/absent/null, `0` disabled, boundaries, and the refused shapes),
`validateTune()`, the `apply()` wiring, the fetch-timeout dispatcher against a recording fake dispatcher
(no install when unset; install and nullish-fill when numeric; `0` pass-through; live re-read on
`loader/volatile-update`/`app-boot/config-reload`; restore-on-clear; restore-on-dispose only while still
current; `NODE_USE_ENV_PROXY`; missing-`undici` warn-once no-op in a child process), the en/zh copy
parity (120 keys), the provider-timeout metadata and the upstream schema/defaults it mirrors, the client
registration and the merged page contract (one global card first with both sub-groups; the old separate
retry and timeout sections absent; the deviating-only listing rule including the stored-but-equal case;
the picker's exclusion set and local-only Add; an empty state; revert-to-global emitting `unset` and the
all-unset collapse; whole-list op shapes for global Save, route Save, and route Reset), the validation,
refusal, per-write gate/skip, and revision-retry paths, the provider-directory join and its degradation,
the route card (family visibility, user-layer seeding, protocol display, advisories, active-only gate,
Unlimited preset, zero rejection), and the docs' field tables in both languages. The "managed
elsewhere" classification is exercised as a **defensive unit test** of `submitOps`/`refusalKind` with a
rejecting fake form, not as real `ConfigForm` behaviour. It does **not** boot a Host or a browser: live
GUI behaviour, the real nav row, next-request latency, whether a real HTTP request actually times out,
and whether a live provider route aborts a slow first token remain deployment checks.
