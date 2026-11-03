# `dsh-llm-api-call-tuning`

English | [中文](README.zh.md)

A DSH plugin that puts **one** Settings page behind the model-request retry policy of **every active
model provider route**. DSH resolves one retry policy per route — retry mode, max retries, retryable
failure codes, and a bounded exponential backoff with jitter (`packages/llm/llm/src/retry-policy.ts`) —
but each provider owns its own copy (`llm-deepseek` and `llm-deepseek-account` under `retryPolicy`,
`llm-pi-ai` under `providers.<id>.retryPolicy`) and DSH has no global knob, CLI flag, environment
variable, or GUI-core page for them. Tuning them by hand means editing every provider row and keeping
five numbers in sync.

The page is organised in **two tiers**:

- **Global settings card (first)** — one card holding every global knob in two labeled sub-groups:
  - **Retries** — the six retry values stored once in this plugin's own settings namespace
    (`llm-api-call-tuning`) as a **preset**. Saving them changes **no provider**.
  - **Fetch timeouts** — the two process-wide HTTP timers `headersTimeoutMs` and `bodyTimeoutMs`, applied
    by the Host to the fetch dispatcher that every provider route, web search, and HTTP MCP server shares.
    Both are `unset` by default, so a fresh install changes no behavior; `0` explicitly disables a timer
    and a positive integer sets it in milliseconds.
  One **Save global settings** writes the six retry leaves and the two fetch leaves in a single write;
  **Reset to system defaults** clears only the two fetch timers.
- **Per-route overrides (below)** — one route section with a native **route picker** above the list, then
  **one merged card per DEVIATING provider route**, carrying that route's retry policy and its
  application-layer timeouts as two sub-groups (**Retry policy** / **Timeouts**). Retry and timeout are
  no longer separate sections. A route appears when its **effective stored retry policy differs in at
  least one leaf** from the global retry values, or when the route **stores any timeout leaf
  explicitly**; an entry stored equal to the global values is hidden. A route card writes leaf-path
  operations **directly into that provider's own settings namespace**, and nothing is written until you
  edit a field.

**The extended retry codes are opt-in and off by default.** In `normal` mode the code checklist offers
**ten** failure codes, but exactly the **five upstream codes** are selected by default, on a fresh
install and for every stored policy that does not already name an extra: `EMPTY_RESPONSE`,
`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`. The five extras — `STREAM_CLOSED`,
`MALFORMED_RESPONSE`, `PI_AI_ERROR`, `HTTP_408`, `HTTP_409` — change nothing until you tick one and
save, so upgrading shows five additional **unchecked** checkboxes and nothing else changes. Saving an
untouched or default route writes **no `retryableCodes` change at all**: route saves now write only the
leaves you actually touched. The global card's preset (and therefore **Apply defaults to all** when you
have not ticked an extra there) remains exactly the five.

The listing rule is deliberately asymmetric: retry deviation is **value-based** (compared with the
global retry values), while timeout deviation is **presence-based**, because the global fetch timers are
undici **transport** timers and a route's `streamIdleTimeoutMs` / `timeoutMs` / `filesApiTimeoutMs` are
application-layer **watchdogs** — different knobs, with no global counterpart to compare against. These
are **provider routes, never models**: DSH resolves retry and timeout policy once per route.

The provider routes are authoritative; the global retry values are copied only when you explicitly ask
(**Use defaults** on a route card, or **Apply defaults to all active providers**). The two fetch timers
are a separate, **process-wide** side effect: they are not part of the retry preset and are never copied
onto a provider route. The wire format is frozen in [CONTRACT.md](CONTRACT.md).

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
the last nav row (section order 45). The page renders exactly two tiers:

1. **Global settings** — one card, first, with two labeled sub-groups and one **Save global settings**:
   - **Retries** — one control for each of the six retry fields in the table below. These values are
     stored in `llm-api-call-tuning` and are a **preset**: saving them does not touch a provider.
   - **Fetch timeouts** — the two process-wide HTTP timers, plus **Reset to system defaults**.
   The card also carries **Apply defaults to all active providers**.
2. **Per-route overrides** — a native **route picker** and an **Add** button above the list, then **one
   merged card per deviating route**. A card carries its **Retry policy** and **Timeouts** sub-groups,
   one **Save**, one **Reset**, and **Use defaults** (retry half). Only routes that deviate are listed;
   the picker offers the remaining routes and excludes the ones already listed. Picking a route
   materializes its card locally from the effective values and **writes nothing** until you edit a field
   and save. Editing a retry leaf back to its global value (or clearing a timeout) removes that override,
   so the card disappears once the route no longer deviates. An empty list says "No provider route
   deviates from the global settings.", and "Every editable route is already listed." appears when the
   picker has nothing left to offer.

A route is listed when its **effective stored retry policy differs in at least one leaf** from the
global retry values, **or** when the route **stores any timeout leaf** it owns. The two halves are
deliberately asymmetric: the global fetch timers are undici transport timers, while a route's
`streamIdleTimeoutMs` / `timeoutMs` / `filesApiTimeoutMs` are application-layer watchdogs, so there is no
global value to compare a route timeout against — presence is the only meaningful test there. A route
that stores a timeout equal to the package default is therefore still listed.

Routes that are declared but dormant, that declare no settings namespace, or whose namespace this
deployment does not serve are **not listed and not pickable**: without a live config form their deviation
cannot be proven, and writing a timeout leaf would materialize a partial provider profile and could
activate a dormant route.

Outside these two settings tiers the plugin also adds a **retry bar above the composer** for failures the
automatic policy declined ([Manual retry](#manual-retry)); it is a separate host/client feature, not a
third settings page.

The retry field table (same values the Host's `Config` and the upstream retry resolver use) applies to
the global card's **Retries** sub-group and to every route card; the two process-wide fetch fields
follow:

| Field | Meaning | Accepts | Code default |
| --- | --- | --- | --- |
| `mode` | Retry mode. `normal` retries only the selected codes up to the retry limit; `always` retries **every** model-request failure — including permanent ones such as AUTH, INVALID_REQUEST, or QUOTA — with no retry limit, until success, cancellation, or disposal, and ignores the code list. | `'normal'` or `'always'` | `'normal'` |
| `maxRetries` | Eligible retries after the first request in `normal` mode; `0` disables retries. | integer 0..9007199254740991 | `5` |
| `initialDelayMs` | First locally scheduled retry delay, in milliseconds. | finite and > 0, at most 2147483647; must not exceed maxDelayMs | `500` |
| `maxDelayMs` | Cap on a locally scheduled or accepted provider delay, in milliseconds. | finite and > 0, at most 2147483647; must not be below initialDelayMs | `10000` |
| `jitterRatio` | Symmetric random multiplier around each local delay: `0` disables jitter, `1` allows up to double. | number in [0, 1] | `0.1` |
| `retryableCodes` | Failure codes `normal` mode retries. The five upstream codes are selected by default; the five added provider/HTTP codes are opt-in and stay inactive until ticked. | non-empty array of unique codes from the ten offered codes; defaults to the five upstream codes | `'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'` |
| `headersTimeoutMs` | Process-wide HTTP response-headers timeout, in milliseconds, applied by the Host to the fetch dispatcher that every provider route, web search, and HTTP MCP server shares. | `unset` (leave the system/DSH default untouched), or integer 0..2147483647; `0` disables the timer | `unset` |
| `bodyTimeoutMs` | Process-wide HTTP response-body (chunk) timeout, in milliseconds, on that same fetch dispatcher. | `unset` (leave the system/DSH default untouched), or integer 0..2147483647; `0` disables the timer | `unset` |

The **Code default** column for the retry rows is the upstream resolution fallback
(`retry-policy.ts:14-22`), also what an unconfigured provider route runs. The bundle seeds nothing, so
the page starts on those values. For the two fetch rows the code default is **`unset`**, not a number:
the schema deliberately has no `.default()`, so a fresh install materializes no timer and the Host's own
dispatcher defaults apply. `unset` means no behavior change; `0` is a real value that disables that one
timer; a positive integer sets it.

### Retryable codes (opt-in extras)

`normal` mode offers ten checkboxes. Five are the upstream code defaults and start selected; the other
five are additions this page offers but never enables on its own:

| Code | Meaning |
| --- | --- |
| `STREAM_CLOSED` | The stream ended before a terminal event — a dropped or truncated connection mid-response. |
| `MALFORMED_RESPONSE` | A garbled or invalid stream frame (for example invalid JSON, or invalid tool arguments). |
| `PI_AI_ERROR` | An `llm-pi-ai` failure the adapter could not classify into a more specific code. |
| `HTTP_408` | The status-shaped fallback the DeepSeek transport produces for HTTP 408. |
| `HTTP_409` | The status-shaped fallback the DeepSeek transport produces for HTTP 409. |

**Opt-in semantics.** An unchecked extra is not part of the policy. The page remembers an extra only
after you tick it and save, and a stored list that already names an extra stays ticked. If a stored list
is empty or contains no code this page recognizes, it falls back to the five defaults — never to the
ten. An untouched list is never rewritten by a route card, so a save cannot silently activate a code.

**Upstream is not limited to five.** The retry schema is `retryableCodes: z.array(z.string())`
(`packages/llm/llm/src/retry-policy.ts:90`): the schema checks only that the entries are strings, and the
resolver additionally rejects an empty array, empty strings and duplicates
(`retry-policy.ts:170-178`) — no layer checks membership. The executor compares exact code strings
(`packages/llm/llm-retry/src/index.ts:212`). The five-code default is this plugin's own policy, not an
upstream limit; the ten-code list is what this page offers, and a hand-stored code outside it is dropped
from the draft only when the code list is actually rewritten (a route card writes only touched leaves; the
global card's Save always rewrites its six default leaves, so it normalizes the plugin's own preset).

**Never add `CONTEXT_WINDOW_EXCEEDED` or `IMAGE_OFFLOAD_REQUIRED`.** In `normal` mode a listed code is
retried **before** the executor delegates to `next()`, so the failure never reaches the handlers that
actually fix those cases — `compaction-basic`
(`packages/compaction/compaction-basic/src/index.ts:213,217`) and `compaction-image-offload`
(`packages/compaction/compaction-image-offload/src/index.ts:27,28`). Retrying them would burn attempts
instead of compacting or offloading; they are deliberately not offered.

### Saving the global card

**Save global settings** validates the six retry fields and the two fetch timers locally first (the retry
rules are in *Saving a route card* below), then writes **one atomic op list at one revision fence**: the
six retry `set` leaves followed by the two fetch leaves, where an empty fetch field emits an `unset` and
a typed value — including `0` — emits a `set`. Nothing is projected onto a provider: the retry values are
a preset, and the fetch leaves are a process-wide side effect. **Reset to system defaults** clears only
the two fetch leaves, so the Host's system defaults apply again; the six retry defaults keep their stored
values.

### Saving a route card

**Save** validates both drafts locally first — a fractional retry limit, a delay of `0` or above
`2147483647`, an initial delay above the maximum, a jitter outside `[0, 1]`, an empty/unknown/duplicate
code list, or a timeout outside blank/`1..2147483647` is refused with a localized message and **no Host
call** — then submits **one atomic write of leaf operations at one revision fence**, carrying that
route's retry leaves and its changed timeout leaves together.

The retry half is written **relative to the global retry values** and **only for the leaves you
actually touched**: an untouched leaf produces no operation at all, a touched leaf whose draft differs
from the global value is `set`, and a touched leaf turned back to the global value is `unset` (only when
the user layer actually stores it). That is also what keeps the opt-in code list safe: an untouched
`retryableCodes` list is never written, so a default route cannot be given an extra code by pressing
Save. When the retry half's list is non-empty and every op in it is an `unset`, the page collapses it
into the single `unset [...settingsPath, 'retryPolicy']`. In `normal` mode the touched leaves can be
`retryPolicy.mode`, `retryPolicy.maxRetries`, `retryPolicy.retryableCodes` and the three
`retryPolicy.backoff.*` leaves. In `always` mode the code checklist is **hidden**, the maximum-retries
input stays visible and typable but is **ignored and not validated**, and a save sets `retryPolicy.mode` and
**clears** any stored `retryPolicy.maxRetries` and `retryPolicy.retryableCodes`, because the upstream
`always` shape has no retry limit and no code list. Always mode retries **every** model-request failure
with no cap — permanent ones included (`AUTH`, `INVALID_REQUEST`, `QUOTA`,
`CONTEXT_WINDOW_EXCEEDED`, `IMAGE_OFFLOAD_REQUIRED`) — until success, cancellation, or disposal. A whole
`retryPolicy` object is never *set*, so sibling configuration (base URL, credentials reference, models)
is left alone.

The timeout half writes only the leaves whose draft changed: a blank field that was seeded from a stored
value emits its `unset`, a typed value emits its `set`, and an untouched field emits nothing. A picked
card that stores nothing yet has nothing to save (its **Save** stays disabled), and **Save** is also
disabled while either draft is invalid or nothing changed.

**Reset** removes everything the card stores for the route in one write: the whole `retryPolicy` plus
this family's timeout leaves. On a picked card that stores no override yet, **Reset** closes the card
locally with **no write at all**. **Use defaults** copies the validated global retry defaults into the
retry draft; nothing is written until **Save**.

A write is attempted only when the route's form reports `ready`, is not read-only, and carries a numeric
revision; that same read is the revision fence, so the page never sends an unconditional write. A route
that fails the gate stays disabled (and is **skipped** by "Apply defaults to all" instead of written).

If the Host refuses the write, `mutate` resolves `false` — that is **every** Host refusal, including
one caused by a home patch or `--patch` overlay owning the row, because the settings form API does not
surface the reason. The page shows the **generic refusal copy** and re-seeds every field from whatever
the Host reports next; if the refusal was a superseded revision and the recovery read moved it, the
write is retried **once** at the fresh revision. The page keeps a separate "managed elsewhere" copy for
a **direct `RemoteError` carrying `settings/rejected`**, but that classification is defensive only and
is not reachable through the settings form API: a home-patch-owned row shows the generic copy.

**Apply defaults to all active providers** copies the validated global retry defaults into every
editable route (active, with a settings namespace and a live form), one provider at a time, each at its
own freshly read revision. It re-checks each row immediately before its write: a row whose form is still
loading, read-only, or missing a numeric revision is **skipped** (the section-level summary still
reports it as `skipped`). It is **not a transaction**: a provider that refuses keeps its policy, the ones
already written stay written, and the per-row outcome says which is which. It never writes timeout leaves
or the two fetch timers onto a provider: those are per-route and process-wide settings, not the retry
preset.

### Timeouts (route card sub-group)

The **Timeouts** sub-group of each merged route card edits the application-layer timeouts that live in
each **provider's own** namespace, the same cross-namespace write the Retry policy sub-group performs.
Defaults are the upstream package/SDK values; a blank field writes nothing, so the route keeps them.

| Field | Applies to | Namespace / path | Default | Accepts |
| --- | --- | --- | --- | --- |
| `streamIdleTimeoutMs` | every active route | `llm-pi-ai` → `providers.<route>.streamIdleTimeoutMs`; `llm-deepseek` / `llm-deepseek-account` → `streamIdleTimeoutMs` | `300000` ms (5 min) | blank (package default) or integer 1..2147483647; `0` is refused |
| `timeoutMs` | `llm-pi-ai` routes only | `llm-pi-ai` → `providers.<route>.timeoutMs` | unset = SDK default (about `600000` ms) | blank (SDK default) or integer 1..2147483647; `0` is refused |
| `filesApiTimeoutMs` | `llm-deepseek` and `llm-deepseek-account` only | `llm-deepseek` / `llm-deepseek-account` namespace root → `filesApiTimeoutMs` | `60000` ms (1 min) | blank (package default) or integer 1..2147483647; `0` is refused |

Why `0` is refused and there is no off switch: the DeepSeek and stream-idle schemas require a strictly
positive value (the load-time asserts reject `<= 0`), and a zero SDK request timeout would abort every
request immediately. The schemas have no "disabled" state, so the **Unlimited** preset writes the
maximum `2147483647` ms (about 24.8 days) instead — a limit, not an off switch. A direct
`settings.mutate` (or a hand-edited profile patch) can still persist `0`; for the two watchdogs that
fails the provider's load-time assert and the route then fails to resolve, which is exactly what the
page prevents.

Interplay with the other two timeout surfaces: for SSE routes the SDK request timeout bounds the wait
for **response headers**, while `streamIdleTimeoutMs` bounds silence **between** streamed chunks, and the
process-wide fetch `bodyTimeoutMs` bounds the transport between chunks. When the idle window is raised
above the default `600000` ms SDK request timeout, the card warns (non-blocking) if `timeoutMs` is
shorter, or if the fetch body timeout is set below the idle window. Raising only the idle window is not
enough if a shorter SDK or transport deadline still fires.

Diagnosis pointer: an `llm-pi-ai` failure reported as a **stream idle timeout after 300000 ms** is the
default idle watchdog aborting a slow first token (TTFT stall), not a transport failure. Raise
`streamIdleTimeoutMs` on the route card (and match `timeoutMs` and the fetch `bodyTimeoutMs` if they are
shorter) instead of editing the profile patch by hand.

`connectTimeoutMs` is **out of scope**: undici has no per-request connect timeout in versions 6, 7, or 8,
and only a fragile agent rebuild could express one. A proper transport connect limit belongs upstream in
`packages/util/http-proxy/src/install.ts` (the proxy-aware dispatcher install), not in this page.

### Fetch timeouts (process-wide)

The **Fetch timeouts** sub-group of the global card edits the two top-level leaves of this plugin's own
namespace. The tri-state contract is:

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
- A route-card timeout change is persisted in the provider's namespace and is picked up by the next
  request/route registration, with no backend restart; a route that is dormant or whose namespace is not
  served is not listed here, so it cannot be written.
- A fetch-timer change is picked up on the **next HTTP dispatch** (the wrapper re-reads the live values on
  every request) with **no backend restart**. The values persist in this plugin's settings namespace like
  any other Host setting; clearing them (or Reset) restores the system-default state.
- Picking a route writes nothing. The deviating list and the picker recompute whenever any provider form
  snapshot changes (a write from another page included), while the provider **directory** itself is read
  once per mount.
- The page only needs a reload to appear after install/upgrade (and a first install may need a backend
  restart). A value change does not need either.

### The two halves

`index.js` (Host) owns the global-defaults `Config` — six `.volatile()` retry fields plus the two
process-wide fetch fields — plus `DEFAULT_TUNE`/`TUNE_OPTIONS`, `DEFAULT_FETCH`/`FETCH_KEYS`/
`FETCH_OPTIONS`, `PROVIDER_TIMEOUT_FIELDS`/`PROVIDER_TIMEOUT_KEYS`/`PROVIDER_TIMEOUT_OPTIONS` (frozen
metadata for the route cards; NOT `Config` fields), `validateTune()` (the cross-field guard for the
retry rules the schema cannot express), and `apply(ctx, config)`. `apply()` has three jobs: it registers
the documented `auto: false` page policy for this namespace (future-proofing: no shipped DSH client
builds pages from a namespace schema yet), installs the opt-in fetch-timeout dispatcher wrapper
described above, and runs the **manual same-turn retry** (the `agent/request-error` listener plus the
authenticated `state`/`decide` route). It never projects any value onto a provider. `client.js`
(browser) is the page — one **Global settings** card followed by one **Per-route overrides** tier — plus
the **Retry bar** above the composer. The page reads the provider directory from the Client Remote `llm`
namespace, paints each route's effective policy and stored timeout leaves from that route's config form,
writes leaf-path operations back through the same form, and never owns a copy of a route's state. The
provider routes are the source of truth; `DEFAULT_TUNE` is the preset the page offers, not a fallback
layer, and the fetch timers are a process-wide side effect rather than a fallback for any provider.

## Manual retry

A second feature, independent of the settings page: when a model request fails and the automatic retry
policy has already declined (no eligible code, retries exhausted, or recovery declined), a **Retry bar**
appears above the composer in the session that owns the failure. It shows the failure code, the
provider, the message, **Retry** / **Dismiss**, and a muted **`Attempt n/5`** indicator. It appears only
for an open, browser-watched session (`normal` mode, or a route with no stored policy; `always` already
retries every failure, so it never asks).

**Retry** re-issues that model request in the **same turn and step**. It is a re-dispatch, not a new
turn: the user message is not re-sent as a new message, `step/start` is not duplicated, and earlier
steps' tool results stay in the history. Each attempt re-runs request preparation and `llm.prepareCall()`, so the call is fresh and its
retry policy is re-captured; a tuning save made while the bar is up therefore applies to the retried
request (the global-defaults card is still only a preset — it does not rewrite a route by itself).

The manual decision **bypasses the retry-policy budget**: `maxRetries` and `retryableCodes` are not
consulted and no `llm/retry` event is logged. The only stops are the **5 manual retries per turn** and
**one click per attempt** (each new failure prompts once).

**Dismiss** ends the turn with the normal error row. So do the 90-second decision timeout, canceling the
turn, disposing the plugin, and closing the page (the last one after the timeout: the bar needs a page
polling the Host). While the bar is up the turn is still running, so the composer is disabled; **Cancel**
is the escape hatch. Only the first valid decision counts — a stale tab cannot settle a newer prompt.
The bar is host-authenticated and reachable only through the plugin's own `POST`+JSON route; headless or
CLI runs and crash-closed turns never see it and fall back to the old behavior. A retried call may repeat
side effects if the model re-issues the same tool calls, and the bar shows the provider, not the model
(the failure payload carries no model field).

## Troubleshooting

- **The nav row is missing.** The bundle is not loaded into the active profile, or the page has not
  been reloaded since the install. Check the install command aborted cleanly, do a full page reload,
  and if the row is still absent restart the backend so the profile patch is read again. The row is
  expected at the end of the Settings nav (order 45).
- **A route card is missing.** Only routes that **deviate** are listed: a route whose effective retry
  policy equals the global retry values in every leaf and that stores no timeout leaf is not shown. Use
  the route picker to add it if you want to override it; picking writes nothing until you edit a field.
  A stored retry override that happens to equal the global values is hidden too.
- **A route is not in the picker.** The picker only offers routes that are active in this deployment,
  declare a settings namespace, and hold a live config form. A declared-but-dormant `llm-pi-ai` route, a
  route with no settings namespace, and a route whose namespace this deployment does not serve are not
  listed and cannot be picked: their deviation cannot be proven without a live form.
- **"The host refused the write" on a home-patch/`--patch` row.** A home patch or a `--patch` overlay
  owns that provider row, so the config editor refuses the write and the page shows the **generic**
  refusal copy (the settings form API does not surface the reason). Edit the overlay (or the profile
  patch) instead; this page deliberately has no force path. The separate "managed elsewhere" copy
  exists only for a direct `RemoteError` carrying `settings/rejected` and is not reachable here.
- **"The host refused the write" on a normal row.** The value was not accepted as written (for example
  the revision was superseded). The fields re-seed from the Host's current values; review and save
  again.
- **Saving the global card changed nothing.** That is the design: the retry values are a preset. Use
  **Use defaults** on a route card or **Apply defaults to all active providers** to write them into
  providers.
- **The values look different from what I typed.** The page always shows the effective value the Host
  reports. On a route card in `always` mode the code checklist is hidden, the maximum-retries input
  stays visible but is ignored and unvalidated, and saving clears the stored limit and code list; the
  global card still stores all six retry values, because they are its preset for every route.
- **The retry bar never appears.** It is offered only when the automatic retry policy declined, the
  request is in `normal` mode, a browser page is polling the session, and the turn is not already
  crash-closed; headless/CLI runs, `always` mode, closed tabs, and already-interrupted turns keep the
  normal error row.
- **The turn seems stuck while the bar is up.** That is expected: the turn stays running and the
  composer is disabled while the Host waits for the decision, for at most 90 s. Click **Dismiss** (or
  **Cancel** the turn) to end it with the normal error row.
- **The provider directory is unavailable.** This deployment does not expose the Remote `llm` directory
  (`providers.unavailable`), or the read failed (`providers.error`). No route can be listed or picked,
  but the global card still works.
- **A provider I just added is not listed.** The directory is read once when the section mounts and is
  not live-refreshed; navigate away and back (or reload the page) to re-read it.
- **An `llm-pi-ai` call fails with a stream idle timeout after 300000 ms.** That is the package idle
  watchdog's default (a slow first token / TTFT stall), not a transport error. Raise
  `streamIdleTimeoutMs` on the route card and, if it is shorter, the request `timeoutMs` and the
  process-wide fetch `bodyTimeoutMs` too. The card shows a non-blocking warning when one of those
  deadlines would still fire first.
- **A route card is read-only.** A card whose form reports loading, read-only, or unavailable is never
  written: writing a timeout leaf would materialize a partial provider profile and could activate a
  dormant route. Picking such a route is not possible in the first place, because the candidate filter
  only offers active, addressed routes with a live form.

## Verify

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs
```

Run from this repository's root (or from the plugin directory with the same variable exported). The
suite is hermetic — plain Node, `node:assert/strict`, fake Context/form/React doubles in `node:vm`, no
network, no server, no file writes — and resolves the **real** `@deepseek-ai/schemastery` and the
upstream `retry-policy.ts` through `$DSH_HARNESS_CHECKOUT`, so a schema or constant drift fails loudly.
It checks the manifest and bundle patch, the Host `Config` accept/reject matrix, the `validateTune()`
rules, `apply()`, the client registration (one section, id `llm-api-call-tuning`, order 45), the en/zh
copy parity (131 keys), the offered ten retryable codes vs the five defaults (the exported offered-code
order, the `Config` union/default split, and `validateTune` membership), the rendered two-tier layout
(the single global card precedes the per-route
section; both sub-groups are present; the old separate retry and timeout sections are gone), the
deviating-only listing rule (a stored retry override equal to the global values is hidden, a route with
only a stored timeout is listed, the picker excludes listed routes, picking adds one card, an empty
state renders), the exact operation shapes (global Save carrying both the retry and fetch leaves,
merged route Save and Reset, touched-leaf retry saves that never add an opt-in code, a leaf reverted to
its global value emitting `unset`, the all-unset collapse, the hidden `always` checklist), the
provider-timeout metadata (frozen keys/defaults/bounds/scopes and the upstream schema +
defaults they mirror), the validation, refusal, per-write gate/skip, and revision-retry paths, the
provider directory join and every degradation path, the route-card behavior (family visibility,
user-layer seeding, protocol display, advisories, active-only gate, Unlimited preset, zero rejection),
the fetch-timeout dispatcher against a recording fake dispatcher and the Host's real `undici` globals
(install/fill/restore/dispose/`NODE_USE_ENV_PROXY`, plus a missing-`undici` child-process run), the
manual same-turn retry (the listener awaiting `next()` first, the desk's watcher window/timeout/cap and
nonce/stale handling, the authenticated route's guards/envelopes/error codes, and the dock's
render/poll/decide behavior), and the field tables in this README and CONTRACT.md. The "managed elsewhere" classification is tested only as a
defensive unit path with a rejecting fake form; real settings-form refusals resolve `false`.

A green run reports `0 failed, 0 skipped` for its full check list and exits `0`. That is an offline
contract check, not a live GUI test: it starts no Host or browser and does not exercise a real
settings save, the real nav row, next-request latency, a real HTTP request whose headers/body/stream
actually time out under the installed dispatcher, or a live provider route's timeout aborting a slow
first token. Those remain deployment checks; the suite proves the
wire contract and the dispatcher's shape, not the wire's timing.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: the six retry global-default fields and the two process-wide fetch fields (`Config`), `DEFAULT_TUNE`/`TUNE_OPTIONS`, `DEFAULT_FETCH`/`FETCH_KEYS`/`FETCH_OPTIONS`, frozen `PROVIDER_TIMEOUT_FIELDS`/`PROVIDER_TIMEOUT_KEYS`/`PROVIDER_TIMEOUT_OPTIONS` metadata, `validateTune()`, and `apply(ctx, config)`, which suppresses the auto page, installs/restores the opt-in fetch-timeout dispatcher wrapper, and registers the manual-retry listener plus its authenticated `state`/`decide` route. |
| `client.js` | Browser half: the **LLM API call tuning** Settings section, rendered as one **Global settings** card and one **Per-route overrides** tier (route picker above the list, one merged retry + timeout card per deviating route), plus local validation and leaf-path writes through the provider forms and its own namespace, and the **manual-retry dock** above the composer (id `manual-retry`, order 20). |
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
- **A manual-retry prompt holds the turn open.** While the bar is up the turn stays running and the
  composer is disabled, for at most 90 s; **Cancel** is the escape hatch.
- **Manual retry needs a browser watcher.** The bar is offered only for a session whose page polled the
  Host within the last 20 s; headless/CLI runs, closed tabs, and disconnected browsers keep the normal
  error behavior.
- **Crash-closed turns and headless runs get no manual retry.** A turn already closed as `interrupted`
  (Host crash/restart) and every run without a live browser page fall back to the automatic chain's
  outcome.
- **A manual retry can repeat side effects.** Earlier tool results stay in the history, but the retried
  call may re-issue the same tool calls and execute them again; the feature does not deduplicate.
- **The failure payload has no model field.** The bar shows the provider plus the failure code and
  message, not the model.
- **Per route, not per model.** DSH captures one retry policy per **provider route** when the adapter
  registers it (`packages/llm/llm/src/retry-policy.ts:78,450-455`), and the agent/request-error payload
  carries the provider but no model (`packages/core/agent/src/runtime-types.ts:389`). A per-model
  override would be stored and rendered but never applied, so the page does not offer one.
- **Dormant routes, routes without a settings namespace, and routes whose namespace is not served are
  not listed and not pickable.** Without a live config form their deviation cannot be proven, and
  writing a timeout leaf would materialize a partial provider profile and could activate a dormant
  route.
- **A stored override equal to the global values is hidden.** The list is a list of deviations, not of
  stored state: a `retryPolicy` identical to the global retry values (or only timeout leaves equal to
  the package defaults) does not produce a card. A timeout leaf still deviates by presence, because
  there is no global counterpart to compare it with.
- **The provider directory is read once per mount**, with no live refresh: a provider added or removed
  while the page stays open needs a page reload.
- **No CLI, environment, or GUI-core setting exists** — this page is the only supported UI; hand-editing
  the profile patch bypasses its validation.
- **The added retry codes are opt-in and off by default.** Ten codes are offered but the five upstream
  codes are pre-selected; an extra is written only after an explicit tick, and an untouched/default
  route save writes no `retryableCodes` change. The five-code default is this plugin's own, not an
  upstream limit, and the offered list is the page's UX subset rather than a whitelist enforced by DSH.
- **`CONTEXT_WINDOW_EXCEEDED` and `IMAGE_OFFLOAD_REQUIRED` are deliberately not offered.** Normal-mode
  retry on a listed code bypasses `next()`, so it would skip the compaction-basic / compaction-image-offload
  handlers that actually fix those failures.
- **Provider timeouts are per route, not global, and `0` is refused.** The page refuses `0` because the
  DeepSeek/stream-idle schemas reject it and a zero SDK request timeout aborts every request; the
  Unlimited preset writes the `2147483647` ms cap (about 24.8 days) instead of an off switch. A direct
  `settings.mutate` can still persist `0`, which fails the provider's load-time assert and makes the
  route fail to resolve.
- **The timeout advisories are heuristics, not enforcement.** They compare the card's draft values with
  the process-wide fetch body-timeout draft locally; a shorter deadline set through a direct write or a
  different namespace layer is not detected, and they never block Save.
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
