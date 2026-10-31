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

This plugin fills that gap with **one** Settings page:

- a **global defaults** card that stores the six retry values as a preset in this plugin's own settings
  namespace (`llm-api-call-tuning`), and
- one **provider row** per active provider route that shows the route's **effective** retry policy and
  writes leaf-path operations **directly into that provider's own settings namespace**; a
  declared-but-dormant directory entry is listed as a read-only row.

Non-goals: the plugin owns no projection state and never copies the defaults onto a provider on its
own. It is not a new retry engine, it does not change any other profile, and it does not touch provider
configuration outside `retryPolicy`.

## Identity (do not change without updating both halves)

`file:line` references name the revision the contract was written against; the named symbol is
authoritative, and `verify.mjs` pins behaviour and the upstream constants rather than line numbers.

| Item | Value |
| --- | --- |
| Package | `dsh-llm-api-call-tuning` |
| Client module id | `dsh-llm-api-call-tuning` — the exact package name (`window.__ModuleLoader__.load` `client.js:44`) |
| Client plugin `name` | `dsh-llm-api-call-tuning` (`client.js:1334`) |
| Loader entry id / row id | `llm-api-call-tuning` (`cordis.patch.yml`) |
| Settings namespace | `llm-api-call-tuning` — this plugin's own `Config`, read/written with `ctx.configForms.get('llm-api-call-tuning')` |
| Locale namespace | `llm-api-call-tuning` |
| Host `name` export | `llm-api-call-tuning` (`index.js:260`) |
| Host module surface | `name`, `Config`, `DEFAULT_TUNE`, `TUNE_KEYS`, `TUNE_OPTIONS`, `TUNE_PROBLEMS`, `RETRY_MODES`, `RETRYABLE_CODES`, `schemaLibrary`, `validateTune`, `apply`; **no** default export |
| Host `inject` | none exported — `apply()` calls `ctx.inject(['settings'], …)` itself (`index.js:372-381`) |
| Client `inject` | `['slots', 'locale', 'configForms', 'remote']` (`client.js:1335`) |
| Settings slot | `settings.section`, `id: 'llm-api-call-tuning'`, `order: 45`, `locale: 'llm-api-call-tuning'`, `label: () => t('nav')` (`client.js:1357-1365`) |
| Host ↔ Client wire | **No RPC channel of its own.** Reads and writes ride the shared settings form mirror (`configForms`), whose `mutate()` calls the Host `settings.mutate` (`packages/client/ui-settings/src/client/config-form.ts:129-151`). The provider directory is read from the Client Remote namespace `llm` (`llm.listProviders()` + `llm.listConfigurableProviders()`). |
| Mount patch seed | **nothing**: the row carries no `config`, so the global defaults start on the upstream code defaults and a fresh install changes no provider |

The host `Config` is registered with `settings.configure({ auto: false }, ctx.fiber)` so the
auto-generated generic page for this namespace is suppressed and the hand-written page is the only page
for the row (`index.js:372-381`). This is the documented own-page idiom, but it is currently a **no-op
guarantee**: `autoGenerate` exists for clients that build pages from a namespace schema, and no shipped
DSH client does so yet (`packages/settings/settings/README.md:39`), so the call is future-proofing. It
is guarded: a policy conflict warns instead of failing boot.

## Config fields (this plugin's own namespace)

Six fields, one per retry value. **Every leaf is `.volatile()`**: a settings edit commits into the
running fiber without a remount (`vendor/loader/src/config/entry.ts` `_commitVolatile`,
`vendor/loader/src/config/diff.ts` `equalExceptVolatile`). The root is a plain schemastery object
because `volatileForm()` only descends object roots
(`packages/settings/settings/src/schema.ts:37-47`); a transform/refine/union at the root would cost the
whole settings section.

The *Code default* column is the upstream resolution fallback (`retry-policy.ts:14-22`), also the value
an unconfigured provider route resolves to (`retry-policy.ts:149-158`). It is recorded once in
`index.js` (`DEFAULT_TUNE`, `TUNE_OPTIONS`) and pinned by `verify.mjs` against the upstream file text.

| Field | Schemastery shape | Code default | Range (enforced by) |
| --- | --- | --- | --- |
| `mode` | `union([const('normal'), const('always')]).default('normal').volatile()` | `'normal'` | `'normal'` or `'always'` (upstream `resolveRetryPolicy` switch, `retry-policy.ts:149-195`) |
| `maxRetries` | `number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(5).volatile()` | `5` | integer 0..9007199254740991 (upstream `number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)`, `retry-policy.ts:89`; load-time `Number.isSafeInteger` assert `retry-policy.ts:167-169`) |
| `initialDelayMs` | `number().min(Number.MIN_VALUE).max(2147483647).default(500).volatile()` | `500` | finite and > 0, at most 2147483647; must not exceed maxDelayMs (upstream schema `retry-policy.ts:82`; load-time asserts `retry-policy.ts:127-135`; the order rule is cross-field and lives in `validateTune`) |
| `maxDelayMs` | `number().min(Number.MIN_VALUE).max(2147483647).default(10000).volatile()` | `10000` | finite and > 0, at most 2147483647; must not be below initialDelayMs (upstream schema `retry-policy.ts:83`; load-time asserts `retry-policy.ts:130-135`) |
| `jitterRatio` | `number().min(0).max(1).default(0.1).volatile()` | `0.1` | number in [0, 1] (upstream schema `retry-policy.ts:84`; load-time assert `retry-policy.ts:136-138`) |
| `retryableCodes` | `array(union(five consts)).min(1).default(all five).volatile()` | `'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'` | non-empty array of unique codes from the five upstream codes (upstream schema `retry-policy.ts:90`; load-time asserts `retry-policy.ts:170-178`; uniqueness is cross-field and lives in `validateTune`) |

`DEFAULT_TUNE` is frozen, and so is its `retryableCodes` array.

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
- **Per-write gate and revision fencing.** A write is attempted only when the target form's freshest
  snapshot is `ready`, not explicitly read-only (`writable !== false`), and carries a **numeric**
  revision; that same read supplies the fence as one atomic `mutate(ops, revision)`, so the page never
  sends an unconditional write (an `undefined` `expectedRevision` reaches the Host as unconditional,
  `packages/api/settings-controller/src/index.ts:111,128,147,152`). A row failing the gate is **skipped,
  not written**: its own actions are disabled, and "Apply defaults to all" records the outcome
  `'skipped'` (no extra badge is rendered; the row body already states loading/read-only/unavailable).
  Two rows that share a namespace (`llm-pi-ai`) each read that namespace's revision immediately before
  their own write, so the second never uses a stale fence. A refusal makes the controller perform its
  own recovery read; if that read moved the revision, the page retries **once** at the fresh revision
  and never again.
- **Local-first validation.** The page refuses an invalid draft itself (no Host call). A direct
  `settings.mutate` written outside the page can bypass that, which is why `validateTune()` and the
  schema bounds are also documented as Host-side rules.

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
are **active** (present in `listProviders()`) and declare a non-empty `settingsNs` get an editable form;
a declared-but-dormant directory entry (never in `listProviders()`) is listed **read-only** with the
"declared but not active" note and gets no form at all.

The policy shape follows the upstream union (`retry-policy.ts:87-101`): `normal` carries `mode`,
`maxRetries`, `retryableCodes`, `backoff`; `always` carries `mode` and `backoff`, and the other two
leaves are inactive. The page shows `always` rows without the retry-limit/code controls and clears
those leaves when saving.

## Write operation shapes (exact)

Every write is one atomic list of **leaf-path operations** (`SettingsPathOp`):
`{ op: 'set', path: string[], value }` or `{ op: 'unset', path: string[] }`.

- **Global defaults Save** — six ordered leaf sets on this plugin's own namespace:

  ```json
  [
    { "op": "set", "path": ["mode"], "value": "normal" },
    { "op": "set", "path": ["maxRetries"], "value": 5 },
    { "op": "set", "path": ["initialDelayMs"], "value": 500 },
    { "op": "set", "path": ["maxDelayMs"], "value": 10000 },
    { "op": "set", "path": ["jitterRatio"], "value": 0.1 },
    { "op": "set", "path": ["retryableCodes"], "value": ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"] }
  ]
  ```

- **Provider Save, `normal` mode** — six ordered leaf sets under the provider address:

  ```
  [...settingsPath, 'retryPolicy', 'mode']
  [...settingsPath, 'retryPolicy', 'maxRetries']
  [...settingsPath, 'retryPolicy', 'retryableCodes']
  [...settingsPath, 'retryPolicy', 'backoff', 'initialDelayMs']
  [...settingsPath, 'retryPolicy', 'backoff', 'maxDelayMs']
  [...settingsPath, 'retryPolicy', 'backoff', 'jitterRatio']
  ```

- **Provider Save, `always` mode** — a set of the mode plus two unsets, then the three backoff sets:

  ```
  set   [...settingsPath, 'retryPolicy', 'mode'] = 'always'
  unset [...settingsPath, 'retryPolicy', 'maxRetries']
  unset [...settingsPath, 'retryPolicy', 'retryableCodes']
  set   [...settingsPath, 'retryPolicy', 'backoff', 'initialDelayMs']
  set   [...settingsPath, 'retryPolicy', 'backoff', 'maxDelayMs']
  set   [...settingsPath, 'retryPolicy', 'backoff', 'jitterRatio']
  ```

- **Provider Reset** — exactly one op:

  ```
  unset [...settingsPath, 'retryPolicy']
  ```

  The provider then falls back to its namespace/schema defaults; there is no set of a whole
  `retryPolicy` object.

**Never:** a whole `retryPolicy` object set (that would materialize schema defaults over a hand-written
profile), a whole `providers` dict set (that would clobber sibling provider fields), or a profile-object
set. Every op addresses one leaf; `Reset` is the only op that unsets a subtree.

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
- The **page itself** needs a full page reload to appear after install/upgrade; a first install may also
  need a backend restart before the bundle patch is discovered. Neither is needed for a value change.
- Uninstalling the bundle removes this plugin's row and page. It does **not** revert `retryPolicy`
  values already written into provider rows, and the plugin performs no automatic migration.

## Known limitations

- **No cross-provider transaction.** "Apply defaults to all" writes one provider at a time, each at its
  own freshly read revision. If one provider refuses, the already-written providers stay written and the
  later ones are untouched; a provider whose form is not `ready`/writable/fenced is **skipped** instead
  of written, and the per-row outcome (`saved` / `refused` / `managed`, plus `skipped`, which renders no
  badge) is what tells the user. There is no rollback.
- **A home-patch or `--patch` override refuses writes.** When the config editor refuses a row because a
  home patch or command-line overlay owns it, the page cannot write it. Through `ConfigForm` that
  refusal resolves `false` and the page shows the **generic refusal copy**, not "managed elsewhere" (the
  managed classification is defensive-only; see *Refusal copy*). There is no force path and no way to
  see the overlay's value beyond the effective value the Host reports.
- **In-flight requests keep the old policy**, as above.
- **Dormant pi-ai routes are not editable.** `llm-pi-ai` lists declared provider profiles even when the
  route is not currently active; the page renders those rows read-only with the "declared but not
  active" note and never registers a form for them. Likewise, a route without a settings namespace
  (or one whose namespace the deployment does not serve) is read-only here.
- **The provider directory is read once, when the section mounts.** `readProviders()` runs in one
  mount effect (`client.js:1140-1151`) and the page does **not** subscribe to
  `llm/adapters-updated`, `settings/document-updated`, or `connection/reset` the way the Models page
  does (`packages/client/ui-settings-models/src/client/index.ts:122-128`). Navigating away and back
  re-reads; a provider added or removed while the page stays open needs a page reload.
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
- **Not published to any npm registry**, and `verify.mjs` is a hermetic offline suite: it starts no
  Host and no browser, so it cannot confirm a live GUI save, the nav row's real position in the shell,
  or the next-request latency.

## Client contract

### Registration (immediate)

`apply(ctx)` registers the dictionary and the section synchronously; there is no `whileServed` gate and
no deferred registration. `configForms` is a **declared** client inject, so a composition without the
settings service parks this fiber before `apply` runs: neither the dictionaries nor the section are
registered and the page simply does not activate. The `forms === undefined` guard in
`client.js:1345-1352` is belt-and-braces for a direct harness/composition that calls `apply` regardless;
in a real composition it is never reached.

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

A slot component receives more than the injected face. `TuningSection` gets the renderer **kit**
(standard hooks and the framework `t` seat), the injected face `{ form, t, getForm, readProviders }`,
and the owner `close` prop (`packages/client/ui-renderer/src/client/scoped-slots.tsx:598-624`); it
destructures the four injected members and ignores `close`. The injected `t` overrides the kit's seat
and is the same bound function as the declared `locale` seat, so the duplication is harmless. Provider
rows are a separate `ProviderRow` child component rendered with `{ row, form, defaultsValues,
applyOutcome }` (plus `t`), so a bare root render shows the defaults card and provider placeholders
only — the row controls exist after the child mounts.

### Provider directory read

`readProviders()` resolves the Remote LLM namespace via `ctx.get('remote.llm')` and falls back to
`ctx.remote.llm`; it never rejects. `listProviders()` and `listConfigurableProviders()` may each answer
with a bare array or with an `{ ok: true, value }` envelope (a bare array is accepted too). The read
runs **once per mount** with no refresh subscription (see *Known limitations*). Outcomes:

| Situation | Rendered note |
| --- | --- |
| no Remote service or no `listProviders` | `providers.unavailable` |
| an envelope reports `ok: false`, or a read throws/rejects | `providers.error` |
| ready but no rows | `providers.empty` |
| ready with rows | one row per joined entry |

### Provider row state

- `snapshot.value` is the **effective** value; the policy is read at
  `[...settingsPath, 'retryPolicy']`.
- The override badge is driven by **`user` presence**, not value comparison: the row shows *override*
  iff the user layer has its own `retryPolicy` property at `settingsPath` (an override equal to the
  default still counts), otherwise *default*.
- A row is **editable** only when it passes the same per-write gate as "Apply defaults to all": active,
  a non-empty `settingsNs`, a form, a `ready` snapshot, `writable !== false`, and a numeric revision.
  Otherwise it renders one of: dormant, no-settings-namespace, namespace-unavailable, loading, or
  read-only, and its actions stay disabled.
- `ConfigForms.get()` never throws for an unserved namespace; it returns a controller whose snapshot
  reports `unavailable`, which the row renders as its own note (`ui-settings/src/client/config-form.ts:270-282`).
- The page's own card renders `status.loading`, `status.unavailable` (the deployment does not serve
  `llm-api-call-tuning`), or `status.readOnly` instead of pretending to write.

### Page copy

The en and zh dictionaries are inline in `client.js` and carry the **same 77 keys**. English copy never
contains CJK text; every key has a non-empty Chinese value. The nav label is the `nav` key, and the
page header/title is the `title` key.

## Verify

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs
```

The suite is hermetic (`node:assert/strict`, fake Context/form/React doubles in `node:vm`, no network,
no server, no filesystem writes) and resolves the **real** `@deepseek-ai/schemastery` and the upstream
`retry-policy.ts` through `$DSH_HARNESS_CHECKOUT`, so schema and constant drift fail loudly. It covers
the manifest and bundle patch, the host `Config` accept/reject matrix, `validateTune()`, the `apply()`
wiring, the en/zh copy parity, the client registration and every op shape, the validation, refusal,
per-write gate/skip, and revision-retry paths, the provider-directory join and its degradation, and the
docs' field tables. The "managed elsewhere" classification is exercised as a **defensive unit test** of
`submitOps`/`refusalKind` with a rejecting fake form, not as real `ConfigForm` behaviour.
It does **not** boot a Host or a browser: live GUI behaviour, the real nav row, and next-request latency
remain deployment checks.
