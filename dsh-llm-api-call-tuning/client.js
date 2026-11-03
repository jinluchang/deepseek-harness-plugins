/**
 * Client half of dsh-llm-api-call-tuning: one Settings page in two tiers.
 *
 * TIER 1 — one "Global settings" card, first, carrying every global knob in
 * two labeled sub-groups: the six GLOBAL DEFAULT retry values of this plugin's
 * own settings namespace, then the two PROCESS-WIDE HTTP fetch timers the host
 * schema declares at the TOP LEVEL of that same namespace (`headersTimeoutMs`,
 * `bodyTimeoutMs`, mirroring the `dsh-fetch-timeouts` plugin). The retry values
 * are a preset only — nothing is projected from them onto a provider, and
 * "Apply defaults to all" copies them explicitly, one provider at a time. The
 * fetch timers are a different knob and are never projected anywhere; their
 * tri-state contract is what makes a fresh install behavior-neutral:
 * - an EMPTY field is the fresh-install state and writes the leaf as UNSET
 *   (`{op: 'unset', path: ['<key>']}`), so the host leaves the system default
 *   in place and this plugin installs no timeout of its own;
 * - `0` is an explicit "disable this timer" (undici treats a zero
 *   `headersTimeout`/`bodyTimeout` as disabled), visually distinct from empty;
 * - a positive integer is a custom limit in milliseconds, at most 2147483647.
 * One Save writes the six retry leaves and the two fetch leaves in a single
 * ordered op list at one revision fence.
 *
 * TIER 2 — one per-route section: a native route picker above the list, and one
 * MERGED card per DEVIATING provider route, each card carrying that route's
 * retry policy and its application-layer timeouts as two labeled sub-groups.
 * The merge is sound because both groups write the SAME namespace and the SAME
 * settings path for a route: `providers.<route>` in `llm-pi-ai` (retryPolicy,
 * streamIdleTimeoutMs, timeoutMs on pi-ai routes) and the namespace root in
 * `llm-deepseek` / `llm-deepseek-account` (retryPolicy, streamIdleTimeoutMs,
 * filesApiTimeoutMs on the two DeepSeek routes); one Save writes both groups.
 *
 * The listing rule is value-based for retries and presence-based for timeouts:
 * a route is listed iff (a) its EFFECTIVE stored retry policy differs in at
 * least one leaf from the plugin's global effective retry values, OR (b) one of
 * the route's timeout leaves is explicitly present in the user layer — there is
 * no global counterpart for the timeouts, because the fetch timers above are
 * undici transport timers, not the route's application watchdogs. Picking a
 * route materializes its card in LOCAL state with the effective values and
 * writes nothing; a leaf set back to its global retry value (or a cleared
 * timeout) is written as an `unset`, so the override disappears and the card
 * leaves the list once the route no longer deviates.
 *
 * The provider namespace map is read from the client Remote service
 * (`llm.listProviders()` joined with `llm.listConfigurableProviders()`), the
 * same join the Models page uses (`ui-settings-models/src/client/store.ts`),
 * so this page owns no copy of a provider's state: it paints the EFFECTIVE
 * value out of the provider form's snapshot and writes leaf-path operations
 * back through the same form. The entity is the PROVIDER ROUTE, never a model:
 * DSH resolves retry and timeout policy once per route, with no per-model hook
 * (`packages/llm/llm/src/retry-policy.ts:78,450-455`), so no per-model config
 * dict is stored or rendered.
 *
 * Every write is a list of LEAF path operations at the shared form's current
 * revision. A whole `retryPolicy` object is never set except through the
 * documented reset/`Reset` path (that would materialize schema defaults over a
 * hand-written profile) and the whole `providers` dict is never set (that would
 * clobber sibling provider fields). `mode: 'always'` additionally clears the
 * two normal-mode-only leaves, because the upstream union schema ignores them
 * once the mode is `always` (`packages/llm/llm/src/retry-policy.ts:105-112`).
 * A blank timeout field is the unset state and writes an `unset` (or is skipped
 * when it already was blank), so the package/SDK default stays in force; `0` is
 * refused on all three timeout leaves (the package schemas reject it for the
 * two watchdogs, and a zero SDK request timeout aborts every request
 * immediately); the per-field "Unlimited" preset fills the 2147483647 ms
 * schema cap, never an off switch. Dormant or unaddressed routes render no
 * controls at all and are not pickable: writing a timeout leaf would
 * materialize a partial provider profile and could activate a dormant route.
 * Two advisory notes are computed but never block Save: an SDK request timeout
 * below a raised idle window, and a process-wide fetch `bodyTimeoutMs` below
 * it.
 *
 * The upstream schema does NOT enforce the cross-field rules the resolver
 * checks (`initialDelayMs <= maxDelayMs`, non-empty unique retryable codes),
 * so the draft is validated locally first and a route whose draft is invalid
 * cannot be submitted. `form.mutate(ops, revision)` resolves `false` on a
 * Host refusal (the controller then performs its own recovery read), and
 * rejects on a transport failure; both paths re-seed the cards from whatever
 * the Host reports next. A superseded revision is retried at most once at the
 * freshly read revision.
 *
 * A second, INDEPENDENT client contribution is the manual same-turn retry dock:
 * a `conversation.input.dock` row above the composer that appears only while
 * the Host's `agent/request-error` waterfall holds a turn open for a manual
 * decision. It polls the plugin-owned authenticated route (`state`) every 2 s
 * while the session is running, posts `decide` when the user clicks Retry or
 * Dismiss, hides itself when the Host answers `manual-retry/stale`, and renders
 * nothing at all when no decision is pending. It is registered BEFORE the
 * settings-page guard, so a Host that serves no settings form still gets it.
 *
 * Plain browser bundle (no build step): it self-registers with the page's
 * module loader and requests React, the only module-table entry it needs.
 * Every value shown has a documented fallback, so a deployment that does not
 * serve a namespace, or does not expose the provider directory, degrades to
 * localized notes instead of failing the page.
 *
 * @module dsh-llm-api-call-tuning/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-api-call-tuning',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } = React;

    /** Settings namespace and dictionary namespace: the Host profile row id. */
    const NS = 'llm-api-call-tuning';
    /** Settings section key (drives the shell's `only` filtering). */
    const SECTION_ID = 'llm-api-call-tuning';
    /**
     * Nav position: in-tree sections are account (-10), general (0), models
     * (10), plugins (15), agent-presets (20); the out-of-tree tools pages are
     * 30 and 40. 45 closes the nav after all of them without colliding.
     */
    const SECTION_ORDER = 45;

    /**
     * The two retry modes of the upstream policy
     * (`packages/llm/llm/src/retry-policy.ts:36-54`).
     */
    const MODES = Object.freeze(['normal', 'always']);

    /**
     * The five failure codes the upstream retry policy ships with
     * (`retry-policy.ts:18-24`), and this page's DEFAULT code list. Upstream
     * does not restrict the array to them — its schema is
     * `z.array(z.string())` and the executor matches exact code strings — so
     * the narrowing is this plugin's own and widening the offered list never
     * changes the default.
     */
    const RETRYABLE_CODES = Object.freeze([
      'EMPTY_RESPONSE',
      'RATE_LIMIT',
      'SERVER',
      'TIMEOUT',
      'TRANSPORT',
    ]);

    /**
     * The codes the page OFFERS, in checkbox order: the five upstream defaults
     * followed by five opt-in extras.
     *
     * `STREAM_CLOSED` / `MALFORMED_RESPONSE` / `PI_AI_ERROR` are the llm-pi-ai
     * failure codes; `HTTP_408` / `HTTP_409` are the status-shaped codes the
     * DeepSeek transport produces. OPT-IN ONLY: no default, fallback or unset
     * leaf ever resolves to an extra code, so an untouched page and every
     * existing stored config keep exactly the five-code policy. An extra is
     * written only when the user ticks its checkbox and saves.
     */
    const OFFERED_RETRYABLE_CODES = Object.freeze([
      ...RETRYABLE_CODES,
      'STREAM_CLOSED',
      'MALFORMED_RESPONSE',
      'PI_AI_ERROR',
      'HTTP_408',
      'HTTP_409',
    ]);

    /**
     * Upstream code defaults (`retry-policy.ts:14-24`), also what an
     * unconfigured provider route resolves to (`:151-158`). They are the
     * fallback the page shows when a namespace has not answered yet, and the
     * values "Reset" restores through the provider's own schema defaults. The
     * code list is deliberately the five upstream codes — NEVER the offered
     * ten — so an absent or unusable stored list cannot activate an opt-in
     * code.
     */
    const DEFAULT_POLICY = Object.freeze({
      mode: 'normal',
      maxRetries: 5,
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      retryableCodes: Object.freeze([...RETRYABLE_CODES]),
    });

    /**
     * Largest timer delay upstream accepts (`@deepseek-ai/dsh-timeout`
     * `MAX_TIMER_DELAY_MS`, used by `retry-policy.ts:82-84,127-135`). The fetch
     * timers use the same bound.
     */
    const MAX_TIMER_DELAY_MS = 2147483647;

    /**
     * The fresh-install state of both process-wide fetch timers: UNSET. An
     * absent leaf means "leave the process-wide system default in place" — the
     * host installs no timeout of its own, so a fresh install behaves exactly
     * as if this plugin were not installed. Both the empty input and the card's
     * Reset restore this state; a number here would instead seed a timer. The
     * sentinel is `null`, matching the host's `DEFAULT_FETCH`, so the unset
     * state compares and serializes identically on both halves.
     */
    const DEFAULT_FETCH = Object.freeze({
      headersTimeoutMs: null,
      bodyTimeoutMs: null,
    });

    /**
     * The five fields a retry draft carries beyond the mode; the order is the
     * order the defaults card renders and the order its ops are submitted.
     */
    const RETRY_FIELDS = Object.freeze([
      { key: 'mode', kind: 'mode' },
      { key: 'maxRetries', kind: 'integer' },
      { key: 'initialDelayMs', kind: 'delay' },
      { key: 'maxDelayMs', kind: 'delay' },
      { key: 'jitterRatio', kind: 'ratio' },
      { key: 'retryableCodes', kind: 'codes' },
    ]);

    /** Input attributes for the numeric controls, keyed by draft field. */
    const NUMERIC_FIELDS = Object.freeze([
      { key: 'maxRetries', inputMode: 'numeric', step: '1', min: '0', max: String(Number.MAX_SAFE_INTEGER) },
      { key: 'initialDelayMs', inputMode: 'numeric', step: '1', min: '1', max: String(MAX_TIMER_DELAY_MS) },
      { key: 'maxDelayMs', inputMode: 'numeric', step: '1', min: '1', max: String(MAX_TIMER_DELAY_MS) },
      { key: 'jitterRatio', inputMode: 'decimal', step: '0.01', min: '0', max: '1' },
    ]);

    /**
     * The two process-wide fetch timers this page owns, in render and submit
     * order. They are NOT in `NUMERIC_FIELDS`: that list drives the retry
     * draft and its delays are strictly positive (`>0`), while these fields are
     * OPTIONAL integers — empty ("system default") or `0`..`2147483647` — and
     * `0` disables the timer. They are not in `RETRY_FIELDS` either, because
     * they are neither a retry-policy leaf nor projected onto a provider route.
     */
    const FETCH_FIELDS = Object.freeze([
      { key: 'headersTimeoutMs', inputMode: 'numeric', step: '1', min: '0', max: String(MAX_TIMER_DELAY_MS) },
      { key: 'bodyTimeoutMs', inputMode: 'numeric', step: '1', min: '0', max: String(MAX_TIMER_DELAY_MS) },
    ]);

    /**
     * The per-route application-layer timeouts this page owns, in render and
     * submit order.
     *
     * Unlike the fetch timers these live in the PROVIDER namespaces, not in this
     * plugin's own namespace: the `llm-pi-ai` namespace keeps them under
     * `providers.<route>`, the `llm-deepseek` / `llm-deepseek-account`
     * namespaces keep them at the section root. `family` decides which rows get
     * a control: `all` on every editable route, `pi-ai` only on pi-ai routes,
     * `deepseek` only on the two DeepSeek routes.
     *
     * `placeholder` is the package/SDK default a BLANK field leaves in force
     * (300 000 ms idle watchdog, 600 000 ms SDK request timeout, 60 000 ms files
     * API). The page never writes a placeholder: blank stays unset, and `0` is
     * refused for all three (the schemas reject it for the two watchdogs, and
     * the SDKs abort every request immediately on a zero request timeout).
     * `MAX_TIMER_DELAY_MS` is the only "unlimited" the schema can express, so
     * the per-field preset fills that cap instead of an off switch.
     */
    const PROVIDER_TIMEOUT_FIELDS = Object.freeze([
      { key: 'streamIdleTimeoutMs', family: 'all', placeholder: 300_000 },
      { key: 'timeoutMs', family: 'pi-ai', placeholder: 600_000 },
      { key: 'filesApiTimeoutMs', family: 'deepseek', placeholder: 60_000 },
    ]);

    /** The SDK request timeout in force while `timeoutMs` is blank (advisory copy only). */
    const SDK_REQUEST_TIMEOUT_MS = 600_000;

    /** The per-field "unlimited" preset: the schema cap, never an off switch. */
    const UNLIMITED_TIMEOUT_MS = MAX_TIMER_DELAY_MS;

    /**
     * The config-editor refusal a home patch or command-line overlay produces
     * (`packages/boot/config-editor/src/index.ts:139`); the settings RPC wraps
     * it as `settings/rejected`. Either form means the value is managed
     * outside this page, so it gets its own copy instead of "refused".
     */
    const OVERRIDE_MARKER = 'overridden by a home patch or command-line overlay';
    const REJECTED_CODE = 'settings/rejected';

    /** The idle snapshot a row without a form subscribes to (hook stability). */
    const IDLE_SNAPSHOT = Object.freeze({
      status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false,
    });
    const IDLE_FORM = Object.freeze({
      subscribe: () => () => {},
      getSnapshot: () => IDLE_SNAPSHOT,
    });
    /** The candidate-route placeholder while the provider directory is unread. */
    const EMPTY_ROWS = Object.freeze([]);

    const en = {
      'nav': 'LLM API call tuning',
      'title': 'LLM API call tuning',
      'intro': 'One page in two tiers. The global card sets this deployment\u2019s retry defaults and the process-wide HTTP fetch timeouts shared by every provider; the per-route tier lists only the provider routes that deviate from those settings, and lets you edit their retry policy and application-layer timeouts in one merged card per route. A route card writes straight to that provider\u2019s own settings namespace.',
      'defaults.description': 'A preset for the per-route cards below and for "Apply defaults to all". The values are stored in this plugin\u2019s own settings namespace; a provider keeps using its own policy until one is written to it.',
      'defaults.applyAll': 'Apply defaults to all active providers',
      'defaults.applying': 'Applying defaults\u2026',
      'defaults.applyAllNote': 'Writes the validated defaults to every active provider, one provider at a time. A provider that refuses the write keeps its current policy.',
      'global.heading': 'Global settings',
      'global.description': 'The process-wide settings of this deployment, in one card: the retry defaults a per-route card below compares against, and the HTTP fetch timers every provider, web search, and HTTP MCP server shares.',
      'global.retriesHeading': 'Retries',
      'global.save': 'Save global settings',
      'global.saving': 'Saving global settings\u2026',
      'global.note': 'The retry values are a preset: saving them here changes no provider route, so use "Apply defaults to all active providers" or a route card\u2019s "Use defaults" button to copy them. An empty fetch timeout field writes nothing (the system default stays in force) and 0 disables that timer; the two fetch leaves are never copied onto a provider route.',
      'providers.heading': 'Per-route overrides',
      'providers.description': 'Only provider routes that DEVIATE are listed: the route\u2019s effective retry policy differs from the global retry values above, or the route stores an explicit timeout. Set a retry leaf back to the global value (or clear a timeout) and save, and the override is removed, so the card disappears. These are provider routes, not models: DSH resolves retry and timeout policy once per route.',
      'providers.loading': 'Loading the provider directory\u2026',
      'providers.unavailable': 'This deployment does not expose the LLM provider directory, so no provider row can be listed.',
      'providers.error': 'The provider directory could not be loaded.',
      'providers.empty': 'No model provider is declared in this deployment.',
      'routes.pickerLabel': 'Add a route',
      'routes.pickerPlaceholder': 'Select a provider route\u2026',
      'routes.add': 'Add',
      'routes.allListed': 'Every editable route is already listed.',
      'routes.empty': 'No provider route deviates from the global settings.',
      'routes.retryHeading': 'Retry policy',
      'routes.timeoutsHeading': 'Timeouts',
      'routes.pickedHint': 'This route stores no override yet: nothing is written until you edit a field and save. Reset closes this card without writing.',
      'provider.namespace': 'Namespace',
      'provider.source.override': 'override',
      'provider.source.default': 'default',
      'provider.status.dormant': 'This route is declared but not active, so it is read-only here.',
      'provider.status.noSettings': 'This route has no configurable settings namespace, so its retry policy cannot be edited here.',
      'provider.status.unavailable': 'This deployment does not serve this provider\u2019s settings namespace, so it is read-only here.',
      'provider.useDefaults': 'Use defaults',
      'provider.reset': 'Reset',
      'provider.save': 'Save',
      'provider.saving': 'Saving\u2026',
      'provider.resetting': 'Resetting\u2026',
      'provider.alwaysNote': 'Always mode retries EVERY model-request failure \u2014 including permanent ones such as AUTH, INVALID_REQUEST, or QUOTA \u2014 with no retry limit. The maximum-retries input stays visible but is ignored and unvalidated in this mode; saving clears the stored retry limit and code list. The offered codes are the checkboxes shown in normal mode.',
      'fetch.heading': 'Fetch timeouts',
      'fetch.description': 'Process-wide HTTP timer limits, applied by the host to the fetch dispatcher that every provider, web search, and HTTP MCP server shares. Leave a field empty to keep the system default; 0 disables that timer; a positive value is the limit in milliseconds.',
      'fetch.reset': 'Reset to system defaults',
      'fetch.resetting': 'Resetting\u2026',
      'fetch.placeholder': 'system default (leave empty)',
      'fetch.hint': 'empty = system default (leave empty); 0 = disabled; 1800000 ms = 30 min',
      'timeouts.unit': 'milliseconds, blank or 1 to 2147483647',
      'timeouts.hint': 'blank = package/SDK default; Unlimited fills 2147483647 (a cap, not an off switch)',
      'timeouts.unlimited': 'Unlimited',
      'timeouts.protocol': 'Protocol',
      'timeouts.protocol.catalog': 'catalog default',
      'timeouts.advisory.sdkFirst': 'The SDK request timeout (600000 ms by default) may fire before this idle window; raise Request timeout to match.',
      'timeouts.advisory.transportFirst': 'The process-wide fetch body timeout is set below this idle window, so the transport may abort first; raise Response body timeout in the global card.',
      'field.mode.label': 'Retry mode',
      'field.mode.description': 'Normal retries only the selected transient failure codes, up to the retry limit. Always retries every model-request failure until success, cancellation, or shutdown.',
      'field.mode.unit': 'normal or always',
      'field.mode.default': 'code default normal',
      'field.maxRetries.label': 'Maximum retries',
      'field.maxRetries.description': 'Eligible retries after the first request in normal mode. 0 disables retries.',
      'field.maxRetries.unit': 'integer 0 to 9007199254740991',
      'field.maxRetries.default': 'code default 5',
      'field.initialDelayMs.label': 'Initial backoff delay',
      'field.initialDelayMs.description': 'First locally scheduled retry delay, in milliseconds. Must be greater than 0 and no greater than the maximum delay.',
      'field.initialDelayMs.unit': 'positive milliseconds, at most 2147483647',
      'field.initialDelayMs.default': 'code default 500 ms',
      'field.maxDelayMs.label': 'Maximum backoff delay',
      'field.maxDelayMs.description': 'Cap on a locally scheduled or accepted provider delay, in milliseconds. Must be greater than 0 and at least the initial delay.',
      'field.maxDelayMs.unit': 'positive milliseconds, at most 2147483647',
      'field.maxDelayMs.default': 'code default 10000 ms',
      'field.jitterRatio.label': 'Backoff jitter',
      'field.jitterRatio.description': 'Symmetric random multiplier range around each local delay: 0 disables jitter, 1 allows up to double. Must be between 0 and 1.',
      'field.jitterRatio.unit': 'ratio 0 to 1',
      'field.jitterRatio.default': 'code default 0.1',
      'field.retryableCodes.label': 'Retryable failure codes',
      'field.retryableCodes.description': 'Failure codes normal mode retries. The five upstream codes are pre-selected; the added provider and HTTP codes are opt-in and stay inactive until ticked. At least one code must stay selected.',
      'field.retryableCodes.unit': 'at least one code',
      'field.retryableCodes.default': 'code default all five codes',
      'field.headersTimeoutMs.label': 'Response headers timeout',
      'field.headersTimeoutMs.description': 'Time allowed before response headers arrive. Empty keeps the system default; 0 disables the timer.',
      'field.headersTimeoutMs.unit': 'milliseconds, empty or 0 to 2147483647',
      'field.bodyTimeoutMs.label': 'Response body timeout',
      'field.bodyTimeoutMs.description': 'Time allowed between response body chunks. Empty keeps the system default; 0 disables the timer.',
      'field.bodyTimeoutMs.unit': 'milliseconds, empty or 0 to 2147483647',
      'field.streamIdleTimeoutMs.label': 'Stream idle timeout',
      'field.streamIdleTimeoutMs.description': 'How long one stream read may wait for the next chunk before the app-layer idle watchdog aborts (package default 300000 ms). Raise it for a slow first token.',
      'field.timeoutMs.label': 'Request timeout',
      'field.timeoutMs.description': 'SDK request timeout, covering the wait for response headers rather than the stream body (SDK default 600000 ms). 0 is not allowed because it would abort every request immediately.',
      'field.filesApiTimeoutMs.label': 'Files API timeout',
      'field.filesApiTimeoutMs.description': 'DeepSeek files-API request timeout (package default 60000 ms).',
      'mode.normal': 'Normal \u2014 selected codes',
      'mode.always': 'Always \u2014 every failure, no limit',
      'code.EMPTY_RESPONSE': 'Empty response',
      'code.RATE_LIMIT': 'Rate limit',
      'code.SERVER': 'Server error',
      'code.TIMEOUT': 'Timeout',
      'code.TRANSPORT': 'Transport error',
      'code.STREAM_CLOSED': 'Stream closed',
      'code.MALFORMED_RESPONSE': 'Malformed response',
      'code.PI_AI_ERROR': 'Provider error',
      'code.HTTP_408': 'HTTP 408',
      'code.HTTP_409': 'HTTP 409',
      'status.loading': 'Loading the retry defaults\u2026',
      'status.unavailable': 'This deployment does not serve the llm-api-call-tuning settings namespace, so the defaults cannot be edited here.',
      'status.readOnly': 'These values are read-only in this deployment.',
      'status.saved': 'Saved.',
      'status.reset': 'Reset. This provider no longer stores a retryPolicy override.',
      'status.routeReset': 'Reset. This route no longer stores the retry policy or timeout overrides shown here.',
      'status.fetchReset': 'Reset. The fetch timeouts return to the system defaults.',
      'error.refused': 'The host refused the write. The values shown are the ones the host reports now.',
      'error.managed': 'These values are managed elsewhere \u2014 a home patch or command-line overlay overrides them \u2014 so this page cannot change them.',
      'error.mode': 'The retry mode must be normal or always.',
      'error.maxRetries': 'The retry limit must be a whole number from 0 to 9007199254740991.',
      'error.initialDelayMs': 'The initial delay must be a finite number greater than 0 and at most 2147483647.',
      'error.maxDelayMs': 'The maximum delay must be a finite number greater than 0 and at most 2147483647.',
      'error.initialDelayOrder': 'The initial delay must be less than or equal to the maximum delay.',
      'error.jitterRatio': 'Jitter must be a finite number from 0 to 1.',
      'error.retryableCodes': 'Select at least one retryable code; unknown or duplicate codes are not allowed.',
      'error.headersTimeoutMs': 'The headers timeout must be empty (system default) or a whole number of milliseconds from 0 to 2147483647.',
      'error.bodyTimeoutMs': 'The body timeout must be empty (system default) or a whole number of milliseconds from 0 to 2147483647.',
      'error.streamIdleTimeoutMs': 'The stream idle timeout must be blank (package default) or a whole number from 1 to 2147483647; 0 is not allowed. Use the Unlimited preset or leave it blank.',
      'error.timeoutMs': 'The request timeout must be blank (SDK default) or a whole number from 1 to 2147483647; 0 would abort every request immediately.',
      'error.filesApiTimeoutMs': 'The files API timeout must be blank (package default) or a whole number from 1 to 2147483647; 0 is not allowed.',
      'apply.outcome.saved': 'Applied',
      'apply.outcome.refused': 'Refused',
      'apply.outcome.managed': 'Managed elsewhere',
      'apply.outcome.skipped': 'Skipped',
      'manualRetry.aria': 'Manual retry available for the failed model call',
      'manualRetry.title': 'Model call failed',
      'manualRetry.retry': 'Retry',
      'manualRetry.dismiss': 'Dismiss',
      'manualRetry.attempt': 'Attempt',
      'manualRetry.expired': 'This retry offer has expired.',
    };

    const zh = {
      'nav': 'LLM \u8c03\u7528\u8c03\u4f18',
      'title': 'LLM \u8c03\u7528\u8c03\u4f18',
      'intro': '单一页面分为两层：全局卡片设置本部署的全局重试默认值与所有提供方共享的进程级 HTTP 抓取超时；各路由层仅列出偏离这些设置的提供方路由，并为每个路由提供一张合并卡片来编辑其重试策略与应用层超时。路由卡片会直接写入该提供方自己的设置命名空间。',
      'defaults.description': '\u4f5c\u4e3a\u4e0b\u65b9\u5404\u8def\u7531\u5361\u7247\u4ee5\u53ca\u201c\u5e94\u7528\u9ed8\u8ba4\u503c\u5230\u5168\u90e8\u63d0\u4f9b\u65b9\u201d\u7684\u9884\u8bbe\u3002\u8fd9\u4e9b\u503c\u4fdd\u5b58\u5728\u672c\u63d2\u4ef6\u81ea\u5df1\u7684\u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\u4e2d\uff1b\u5728\u5411\u67d0\u4e2a\u63d0\u4f9b\u65b9\u5199\u5165\u4e4b\u524d\uff0c\u5b83\u4ecd\u4f7f\u7528\u81ea\u5df1\u7684\u7b56\u7565\u3002',
      'defaults.applyAll': '\u5e94\u7528\u9ed8\u8ba4\u503c\u5230\u5168\u90e8\u542f\u7528\u4e2d\u7684\u63d0\u4f9b\u65b9',
      'defaults.applying': '\u6b63\u5728\u5e94\u7528\u9ed8\u8ba4\u503c\u2026',
      'defaults.applyAllNote': '\u6309\u987a\u5e8f\u5c06\u6821\u9a8c\u901a\u8fc7\u7684\u9ed8\u8ba4\u503c\u5199\u5165\u6bcf\u4e2a\u542f\u7528\u4e2d\u7684\u63d0\u4f9b\u65b9\uff0c\u4e00\u6b21\u4e00\u4e2a\u3002\u62d2\u7edd\u5199\u5165\u7684\u63d0\u4f9b\u65b9\u4fdd\u6301\u5f53\u524d\u7b56\u7565\u3002',
      'global.heading': '全局设置',
      'global.description': '本部署的全局设置集中在同一个卡片中：各路由卡片用于比较的重试默认值，以及所有提供方、联网搜索与 HTTP MCP 服务器共享的 HTTP 抓取计时器。',
      'global.retriesHeading': '重试',
      'global.save': '保存全局设置',
      'global.saving': '正在保存全局设置…',
      'global.note': '重试值是预设：在此保存不会改动任何提供方路由；请使用“应用默认值到全部启用中的提供方”或某个路由卡片上的“使用默认值”来复制它们。抓取超时留空表示不写入任何值（保持系统默认），0 表示禁用该计时器；这两个抓取字段永远不会被复制到提供方路由上。',
      'providers.heading': '各路由覆盖',
      'providers.description': '仅列出存在偏差的路由：该路由的生效重试策略与上方全局重试值不同，或该路由显式保存了某项超时。把某个重试字段改回全局值（或清空某项超时）并保存，该覆盖即被移除，卡片随之消失。这些是提供方路由而非模型：DSH 按路由解析重试与超时策略。',
      'providers.loading': '\u6b63\u5728\u52a0\u8f7d\u63d0\u4f9b\u65b9\u76ee\u5f55\u2026',
      'providers.unavailable': '\u5f53\u524d\u90e8\u7f72\u672a\u66b4\u9732 LLM \u63d0\u4f9b\u65b9\u76ee\u5f55\uff0c\u56e0\u6b64\u65e0\u6cd5\u5217\u51fa\u63d0\u4f9b\u65b9\u884c\u3002',
      'providers.error': '\u63d0\u4f9b\u65b9\u76ee\u5f55\u52a0\u8f7d\u5931\u8d25\u3002',
      'providers.empty': '\u5f53\u524d\u90e8\u7f72\u4e2d\u6ca1\u6709\u58f0\u660e\u4efb\u4f55\u6a21\u578b\u63d0\u4f9b\u65b9\u3002',
      'routes.pickerLabel': '添加路由',
      'routes.pickerPlaceholder': '选择提供方路由…',
      'routes.add': '添加',
      'routes.allListed': '所有可编辑的路由都已列出。',
      'routes.empty': '没有提供方路由偏离全局设置。',
      'routes.retryHeading': '重试策略',
      'routes.timeoutsHeading': '超时',
      'routes.pickedHint': '该路由尚未保存任何覆盖：在你编辑字段并保存之前不会写入任何值。“重置”会在不写入的情况下关闭此卡片。',
      'provider.namespace': '\u547d\u540d\u7a7a\u95f4',
      'provider.source.override': '\u8986\u76d6',
      'provider.source.default': '\u9ed8\u8ba4',
      'provider.status.dormant': '\u8be5\u8def\u7531\u5df2\u58f0\u660e\u4f46\u672a\u542f\u7528\uff0c\u56e0\u6b64\u5728\u6b64\u4e3a\u53ea\u8bfb\u3002',
      'provider.status.noSettings': '\u8be5\u8def\u7531\u6ca1\u6709\u53ef\u914d\u7f6e\u7684\u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\uff0c\u56e0\u6b64\u65e0\u6cd5\u5728\u6b64\u7f16\u8f91\u5176\u91cd\u8bd5\u7b56\u7565\u3002',
      'provider.status.unavailable': '\u5f53\u524d\u90e8\u7f72\u672a\u63d0\u4f9b\u8be5\u63d0\u4f9b\u65b9\u7684\u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\uff0c\u56e0\u6b64\u5728\u6b64\u4e3a\u53ea\u8bfb\u3002',
      'provider.useDefaults': '\u4f7f\u7528\u9ed8\u8ba4\u503c',
      'provider.reset': '\u91cd\u7f6e',
      'provider.save': '\u4fdd\u5b58',
      'provider.saving': '\u6b63\u5728\u4fdd\u5b58\u2026',
      'provider.resetting': '\u6b63\u5728\u91cd\u7f6e\u2026',
      'provider.alwaysNote': '\u201c\u603b\u662f\u201d\u6a21\u5f0f\u4f1a\u91cd\u8bd5\u6bcf\u4e00\u6b21\u6a21\u578b\u8bf7\u6c42\u5931\u8d25\u2014\u2014\u5305\u62ec AUTH\u3001INVALID_REQUEST\u3001QUOTA \u7b49\u6c38\u4e45\u6027\u5931\u8d25\u2014\u2014\u4e14\u6ca1\u6709\u91cd\u8bd5\u4e0a\u9650\u3002\u6700\u5927\u91cd\u8bd5\u6b21\u6570\u8f93\u5165\u6846\u4ecd\u7136\u53ef\u89c1\uff0c\u4f46\u5728\u6b64\u6a21\u5f0f\u4e0b\u4f1a\u88ab\u5ffd\u7565\u4e14\u4e0d\u53c2\u4e0e\u6821\u9a8c\uff1b\u4ee5\u8be5\u6a21\u5f0f\u4fdd\u5b58\u4f1a\u6e05\u9664\u5df2\u4fdd\u5b58\u7684\u91cd\u8bd5\u4e0a\u9650\u4e0e\u9519\u8bef\u7801\u5217\u8868\u3002\u53ef\u9009\u7684\u9519\u8bef\u7801\u5373\u201c\u666e\u901a\u201d\u6a21\u5f0f\u4e0b\u663e\u793a\u7684\u590d\u9009\u6846\u3002',
      'fetch.heading': '\u6293\u53d6\u8d85\u65f6',
      'fetch.description': '\u8fdb\u7a0b\u7ea7\u7684 HTTP \u8ba1\u65f6\u4e0a\u9650\uff0c\u7531\u5bbf\u4e3b\u5e94\u7528\u5230\u6240\u6709\u63d0\u4f9b\u65b9\u3001\u8054\u7f51\u641c\u7d22\u4e0e HTTP MCP \u670d\u52a1\u5668\u5171\u7528\u7684 fetch \u8c03\u5ea6\u5668\u4e0a\u3002\u7559\u7a7a\u8868\u793a\u4fdd\u6301\u7cfb\u7edf\u9ed8\u8ba4\uff1b0 \u8868\u793a\u7981\u7528\u8be5\u8ba1\u65f6\u5668\uff1b\u6b63\u6570\u8868\u793a\u4ee5\u6beb\u79d2\u4e3a\u5355\u4f4d\u7684\u65f6\u957f\u3002',
      'fetch.reset': '\u6062\u590d\u7cfb\u7edf\u9ed8\u8ba4',
      'fetch.resetting': '\u6b63\u5728\u6062\u590d\u2026',
      'fetch.placeholder': '\u7cfb\u7edf\u9ed8\u8ba4\uff08\u7559\u7a7a\uff09',
      'fetch.hint': '\u7559\u7a7a = \u7cfb\u7edf\u9ed8\u8ba4\uff08\u4fdd\u6301\u7559\u7a7a\uff09\uff1b0 = \u7981\u7528\uff1b1800000 \u6beb\u79d2 = 30 \u5206\u949f',
      'timeouts.unit': '\u6beb\u79d2\uff0c\u7559\u7a7a\u6216 1 \u5230 2147483647',
      'timeouts.hint': '\u7559\u7a7a = \u5305/SDK \u9ed8\u8ba4\u503c\uff1b\u201c\u4e0d\u9650\u201d\u586b\u5165 2147483647\uff08\u4e0a\u9650\uff0c\u4e0d\u662f\u5173\u95ed\u5f00\u5173\uff09',
      'timeouts.unlimited': '\u4e0d\u9650',
      'timeouts.protocol': '\u534f\u8bae',
      'timeouts.protocol.catalog': '\u76ee\u5f55\u9ed8\u8ba4',
      'timeouts.advisory.sdkFirst': 'SDK \u8bf7\u6c42\u8d85\u65f6\uff08\u9ed8\u8ba4 600000 \u6beb\u79d2\uff09\u53ef\u80fd\u5148\u4e8e\u6b64\u7a7a\u95f2\u7a97\u53e3\u89e6\u53d1\uff1b\u8bf7\u540c\u6b65\u63d0\u9ad8\u201c\u8bf7\u6c42\u8d85\u65f6\u201d\u3002',
      'timeouts.advisory.transportFirst': '\u8fdb\u7a0b\u7ea7\u6293\u53d6\u6b63\u6587\u8d85\u65f6\u4f4e\u4e8e\u6b64\u7a7a\u95f2\u7a97\u53e3\uff0c\u4f20\u8f93\u5c42\u53ef\u80fd\u5148\u4e2d\u65ad\uff1b\u8bf7\u5728\u5168\u5c40\u5361\u7247\u4e2d\u63d0\u9ad8\u201c\u54cd\u5e94\u6b63\u6587\u8d85\u65f6\u201d\u3002',
      'field.mode.label': '\u91cd\u8bd5\u6a21\u5f0f',
      'field.mode.description': '\u201c\u666e\u901a\u201d\u6a21\u5f0f\u4ec5\u5728\u91cd\u8bd5\u4e0a\u9650\u5185\u91cd\u8bd5\u6240\u9009\u7684\u4e34\u65f6\u9519\u8bef\u7801\u3002\u201c\u603b\u662f\u201d\u6a21\u5f0f\u5bf9\u6bcf\u6b21\u6a21\u578b\u8bf7\u6c42\u5931\u8d25\u90fd\u91cd\u8bd5\uff0c\u76f4\u5230\u6210\u529f\u3001\u53d6\u6d88\u6216\u5173\u95ed\u3002',
      'field.mode.unit': 'normal \u6216 always',
      'field.mode.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c normal',
      'field.maxRetries.label': '\u6700\u5927\u91cd\u8bd5\u6b21\u6570',
      'field.maxRetries.description': '\u201c\u666e\u901a\u201d\u6a21\u5f0f\u4e0b\u9996\u6b21\u8bf7\u6c42\u4e4b\u540e\u7684\u53ef\u91cd\u8bd5\u6b21\u6570\u30020 \u8868\u793a\u7981\u7528\u91cd\u8bd5\u3002',
      'field.maxRetries.unit': '0 \u5230 9007199254740991 \u7684\u6574\u6570',
      'field.maxRetries.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 5',
      'field.initialDelayMs.label': '\u521d\u59cb\u9000\u907f\u5ef6\u8fdf',
      'field.initialDelayMs.description': '\u672c\u5730\u8c03\u5ea6\u7684\u9996\u6b21\u91cd\u8bd5\u5ef6\u8fdf\uff0c\u5355\u4f4d\u6beb\u79d2\u3002\u5fc5\u987b\u5927\u4e8e 0\uff0c\u4e14\u4e0d\u5f97\u5927\u4e8e\u6700\u5927\u5ef6\u8fdf\u3002',
      'field.initialDelayMs.unit': '\u5927\u4e8e 0 \u7684\u6beb\u79d2\u6570\uff0c\u6700\u5927 2147483647',
      'field.initialDelayMs.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 500 \u6beb\u79d2',
      'field.maxDelayMs.label': '\u6700\u5927\u9000\u907f\u5ef6\u8fdf',
      'field.maxDelayMs.description': '\u672c\u5730\u8c03\u5ea6\u6216\u63a5\u53d7\u63d0\u4f9b\u65b9\u5ef6\u8fdf\u7684\u4e0a\u9650\uff0c\u5355\u4f4d\u6beb\u79d2\u3002\u5fc5\u987b\u5927\u4e8e 0\uff0c\u4e14\u4e0d\u5f97\u5c0f\u4e8e\u521d\u59cb\u5ef6\u8fdf\u3002',
      'field.maxDelayMs.unit': '\u5927\u4e8e 0 \u7684\u6beb\u79d2\u6570\uff0c\u6700\u5927 2147483647',
      'field.maxDelayMs.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 10000 \u6beb\u79d2',
      'field.jitterRatio.label': '\u9000\u907f\u6296\u52a8\u6bd4\u4f8b',
      'field.jitterRatio.description': '\u6bcf\u4e2a\u672c\u5730\u5ef6\u8fdf\u5468\u56f4\u5bf9\u79f0\u968f\u673a\u500d\u6570\u8303\u56f4\uff1a0 \u8868\u793a\u65e0\u6296\u52a8\uff0c1 \u8868\u793a\u6700\u591a\u7ffb\u500d\u3002\u5fc5\u987b\u5728 0 \u5230 1 \u4e4b\u95f4\u3002',
      'field.jitterRatio.unit': '0 \u5230 1 \u7684\u6bd4\u4f8b',
      'field.jitterRatio.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 0.1',
      'field.retryableCodes.label': '\u53ef\u91cd\u8bd5\u9519\u8bef\u7801',
      'field.retryableCodes.description': '\u201c\u666e\u901a\u201d\u6a21\u5f0f\u4e0b\u4f1a\u91cd\u8bd5\u7684\u5931\u8d25\u9519\u8bef\u7801\u3002\u4e94\u4e2a\u4e0a\u6e38\u9519\u8bef\u7801\u9ed8\u8ba4\u9884\u9009\uff1b\u65b0\u589e\u7684\u63d0\u4f9b\u65b9\u4e0e HTTP \u9519\u8bef\u7801\u4e3a\u6309\u9700\u52fe\u9009\uff0c\u672a\u52fe\u9009\u65f6\u4e0d\u751f\u6548\u3002\u81f3\u5c11\u9700\u4fdd\u7559\u4e00\u9879\u3002',
      'field.retryableCodes.unit': '\u81f3\u5c11\u4e00\u4e2a\u9519\u8bef\u7801',
      'field.retryableCodes.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c\uff1a\u5168\u90e8\u4e94\u4e2a\u9519\u8bef\u7801',
      'field.headersTimeoutMs.label': '\u54cd\u5e94\u5934\u8d85\u65f6',
      'field.headersTimeoutMs.description': '\u7b49\u5f85\u54cd\u5e94\u5934\u8fd4\u56de\u7684\u6700\u957f\u65f6\u95f4\u3002\u7559\u7a7a\u8868\u793a\u4fdd\u6301\u7cfb\u7edf\u9ed8\u8ba4\uff1b0 \u8868\u793a\u7981\u7528\u8be5\u8ba1\u65f6\u5668\u3002',
      'field.headersTimeoutMs.unit': '\u6beb\u79d2\uff0c\u7559\u7a7a\u6216 0 \u5230 2147483647',
      'field.bodyTimeoutMs.label': '\u54cd\u5e94\u6b63\u6587\u8d85\u65f6',
      'field.bodyTimeoutMs.description': '\u54cd\u5e94\u6b63\u6587\u5404\u6570\u636e\u5757\u4e4b\u95f4\u5141\u8bb8\u7684\u6700\u957f\u95f4\u9694\u3002\u7559\u7a7a\u8868\u793a\u4fdd\u6301\u7cfb\u7edf\u9ed8\u8ba4\uff1b0 \u8868\u793a\u7981\u7528\u8be5\u8ba1\u65f6\u5668\u3002',
      'field.bodyTimeoutMs.unit': '\u6beb\u79d2\uff0c\u7559\u7a7a\u6216 0 \u5230 2147483647',
      'field.streamIdleTimeoutMs.label': '\u6d41\u7a7a\u95f2\u8d85\u65f6',
      'field.streamIdleTimeoutMs.description': '\u5355\u6b21\u6d41\u8bfb\u53d6\u7b49\u5f85\u4e0b\u4e00\u6570\u636e\u5757\u7684\u6700\u957f\u65f6\u95f4\uff0c\u8d85\u65f6\u540e\u7531\u5e94\u7528\u5c42\u7a7a\u95f2\u770b\u95e8\u72d7\u4e2d\u6b62\uff08\u5305\u9ed8\u8ba4\u503c 300000 \u6beb\u79d2\uff09\u3002\u9996\u4e2a\u4ee4\u724c\u8f83\u6162\u65f6\u53ef\u8c03\u9ad8\u3002',
      'field.timeoutMs.label': '\u8bf7\u6c42\u8d85\u65f6',
      'field.timeoutMs.description': 'SDK \u8bf7\u6c42\u8d85\u65f6\uff0c\u7ea6\u675f\u7684\u662f\u7b49\u5f85\u54cd\u5e94\u5934\u7684\u65f6\u95f4\uff0c\u800c\u975e\u6d41\u6b63\u6587\uff08SDK \u9ed8\u8ba4\u503c 600000 \u6beb\u79d2\uff09\u3002\u4e0d\u5141\u8bb8 0\uff0c\u56e0\u4e3a\u90a3\u4f1a\u8ba9\u6bcf\u4e2a\u8bf7\u6c42\u7acb\u5373\u4e2d\u6b62\u3002',
      'field.filesApiTimeoutMs.label': '\u6587\u4ef6 API \u8d85\u65f6',
      'field.filesApiTimeoutMs.description': 'DeepSeek \u6587\u4ef6 API \u8bf7\u6c42\u8d85\u65f6\uff08\u5305\u9ed8\u8ba4\u503c 60000 \u6beb\u79d2\uff09\u3002',
      'mode.normal': '\u666e\u901a \u2014 \u6240\u9009\u9519\u8bef\u7801',
      'mode.always': '\u603b\u662f \u2014 \u6bcf\u6b21\u5931\u8d25\uff0c\u65e0\u4e0a\u9650',
      'code.EMPTY_RESPONSE': '\u7a7a\u54cd\u5e94',
      'code.RATE_LIMIT': '\u9650\u6d41',
      'code.SERVER': '\u670d\u52a1\u5668\u9519\u8bef',
      'code.TIMEOUT': '\u8d85\u65f6',
      'code.TRANSPORT': '\u4f20\u8f93\u9519\u8bef',
      'code.STREAM_CLOSED': '\u6d41\u5df2\u5173\u95ed',
      'code.MALFORMED_RESPONSE': '\u54cd\u5e94\u683c\u5f0f\u9519\u8bef',
      'code.PI_AI_ERROR': '\u63d0\u4f9b\u65b9\u9519\u8bef',
      'code.HTTP_408': 'HTTP 408',
      'code.HTTP_409': 'HTTP 409',
      'status.loading': '\u6b63\u5728\u52a0\u8f7d\u91cd\u8bd5\u9ed8\u8ba4\u503c\u2026',
      'status.unavailable': '\u5f53\u524d\u90e8\u7f72\u672a\u63d0\u4f9b llm-api-call-tuning \u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\uff0c\u65e0\u6cd5\u5728\u6b64\u7f16\u8f91\u9ed8\u8ba4\u503c\u3002',
      'status.readOnly': '\u5f53\u524d\u90e8\u7f72\u4e2d\u8fd9\u4e9b\u503c\u4e3a\u53ea\u8bfb\u3002',
      'status.saved': '\u5df2\u4fdd\u5b58\u3002',
      'status.reset': '\u5df2\u91cd\u7f6e\u3002\u8be5\u63d0\u4f9b\u65b9\u4e0d\u518d\u4fdd\u5b58 retryPolicy \u8986\u76d6\u3002',
      'status.routeReset': '已重置。该路由不再保存此处显示的重试策略或超时覆盖。',
      'status.fetchReset': '\u5df2\u91cd\u7f6e\u3002\u6293\u53d6\u8d85\u65f6\u6062\u590d\u4e3a\u7cfb\u7edf\u9ed8\u8ba4\u3002',
      'error.refused': '\u5bbf\u4e3b\u62d2\u7edd\u4e86\u672c\u6b21\u5199\u5165\u3002\u5f53\u524d\u663e\u793a\u7684\u662f\u5bbf\u4e3b\u73b0\u5728\u62a5\u544a\u7684\u503c\u3002',
      'error.managed': '\u8fd9\u4e9b\u503c\u7531\u5176\u4ed6\u4f4d\u7f6e\u7ba1\u7406\u2014\u2014\u5bb6\u5ead\u8865\u4e01\u6216\u547d\u4ee4\u884c\u8986\u76d6\u4e86\u5b83\u4eec\u2014\u2014\u56e0\u6b64\u672c\u9875\u9762\u65e0\u6cd5\u4fee\u6539\u3002',
      'error.mode': '\u91cd\u8bd5\u6a21\u5f0f\u5fc5\u987b\u662f normal \u6216 always\u3002',
      'error.maxRetries': '\u91cd\u8bd5\u4e0a\u9650\u5fc5\u987b\u662f 0 \u5230 9007199254740991 \u4e4b\u95f4\u7684\u6574\u6570\u3002',
      'error.initialDelayMs': '\u521d\u59cb\u5ef6\u8fdf\u5fc5\u987b\u662f\u5927\u4e8e 0 \u4e14\u4e0d\u8d85\u8fc7 2147483647 \u7684\u6709\u9650\u6570\u3002',
      'error.maxDelayMs': '\u6700\u5927\u5ef6\u8fdf\u5fc5\u987b\u662f\u5927\u4e8e 0 \u4e14\u4e0d\u8d85\u8fc7 2147483647 \u7684\u6709\u9650\u6570\u3002',
      'error.initialDelayOrder': '\u521d\u59cb\u5ef6\u8fdf\u5fc5\u987b\u5c0f\u4e8e\u6216\u7b49\u4e8e\u6700\u5927\u5ef6\u8fdf\u3002',
      'error.jitterRatio': '\u6296\u52a8\u6bd4\u4f8b\u5fc5\u987b\u662f 0 \u5230 1 \u4e4b\u95f4\u7684\u6709\u9650\u6570\u3002',
      'error.retryableCodes': '\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u53ef\u91cd\u8bd5\u9519\u8bef\u7801\uff1b\u4e0d\u5141\u8bb8\u672a\u77e5\u6216\u91cd\u590d\u7684\u9519\u8bef\u7801\u3002',
      'error.headersTimeoutMs': '\u54cd\u5e94\u5934\u8d85\u65f6\u5fc5\u987b\u662f\u7559\u7a7a\uff08\u7cfb\u7edf\u9ed8\u8ba4\uff09\u6216 0 \u5230 2147483647 \u4e4b\u95f4\u7684\u6574\u6570\u6beb\u79d2\u503c\u3002',
      'error.bodyTimeoutMs': '\u54cd\u5e94\u6b63\u6587\u8d85\u65f6\u5fc5\u987b\u662f\u7559\u7a7a\uff08\u7cfb\u7edf\u9ed8\u8ba4\uff09\u6216 0 \u5230 2147483647 \u4e4b\u95f4\u7684\u6574\u6570\u6beb\u79d2\u503c\u3002',
      'error.streamIdleTimeoutMs': '\u6d41\u7a7a\u95f2\u8d85\u65f6\u5fc5\u987b\u662f\u7559\u7a7a\uff08\u5305\u9ed8\u8ba4\u503c\uff09\u6216 1 \u5230 2147483647 \u4e4b\u95f4\u7684\u6574\u6570\uff1b\u4e0d\u5141\u8bb8 0\uff0c\u8bf7\u4f7f\u7528\u201c\u4e0d\u9650\u201d\u9884\u8bbe\u6216\u7559\u7a7a\u3002',
      'error.timeoutMs': '\u8bf7\u6c42\u8d85\u65f6\u5fc5\u987b\u7559\u7a7a\uff08SDK \u9ed8\u8ba4\u503c\uff09\u6216\u4e3a 1 \u5230 2147483647 \u4e4b\u95f4\u7684\u6574\u6570\uff1b0 \u4f1a\u8ba9\u6bcf\u4e2a\u8bf7\u6c42\u7acb\u5373\u4e2d\u6b62\u3002',
      'error.filesApiTimeoutMs': '\u6587\u4ef6 API \u8d85\u65f6\u5fc5\u987b\u7559\u7a7a\uff08\u5305\u9ed8\u8ba4\u503c\uff09\u6216\u4e3a 1 \u5230 2147483647 \u4e4b\u95f4\u7684\u6574\u6570\uff1b\u4e0d\u5141\u8bb8 0\u3002',
      'apply.outcome.saved': '\u5df2\u5e94\u7528',
      'apply.outcome.refused': '\u88ab\u62d2\u7edd',
      'apply.outcome.managed': '\u7531\u5176\u4ed6\u4f4d\u7f6e\u7ba1\u7406',
      'apply.outcome.skipped': '已跳过',
      'manualRetry.aria': '失败的模型调用可手动重试',
      'manualRetry.title': '模型调用失败',
      'manualRetry.retry': '重试',
      'manualRetry.dismiss': '忽略',
      'manualRetry.attempt': '尝试次数',
      'manualRetry.expired': '该重试选项已过期。',
    };

    const STYLE_TEXT = [
      '.dlct-page { display: flex; flex-direction: column; gap: 20px; max-width: 960px; }',
      '.dlct-header { display: flex; flex-direction: column; gap: 6px; }',
      '.dlct-title { margin: 0; font-size: 1.35rem; }',
      '.dlct-intro { margin: 0; color: var(--text-secondary, #5b6472); line-height: 1.5; }',
      '.dlct-card { border: 1px solid var(--border, #d8dde4); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }',
      '.dlct-card-head { display: flex; flex-direction: column; gap: 4px; }',
      '.dlct-card-title { margin: 0; font-size: 1.05rem; }',
      '.dlct-card-description { margin: 0; color: var(--text-secondary, #5b6472); line-height: 1.5; }',
      '.dlct-fields { display: flex; flex-direction: column; gap: 16px; }',
      '.dlct-field { display: flex; flex-direction: column; gap: 4px; }',
      '.dlct-field-head { display: flex; align-items: baseline; gap: 8px; }',
      '.dlct-field-label { font-weight: 600; }',
      '.dlct-unit { font-size: 0.78rem; color: var(--text-tertiary, #7a8493); }',
      '.dlct-input, .dlct-select { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border, #c9d1da); border-radius: 6px; font: inherit; background: var(--surface, #fff); color: inherit; }',
      '.dlct-input[aria-invalid="true"] { border-color: var(--danger, #c0392b); }',
      '.dlct-codes { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }',
      '.dlct-code-list { display: flex; flex-wrap: wrap; gap: 6px 16px; }',
      '.dlct-code { display: inline-flex; align-items: center; gap: 6px; }',
      '.dlct-description { margin: 0; font-size: 0.82rem; color: var(--text-secondary, #5b6472); line-height: 1.45; }',
      '.dlct-default { font-size: 0.78rem; color: var(--text-tertiary, #7a8493); }',
      '.dlct-error { margin: 0; font-size: 0.82rem; color: var(--danger, #c0392b); }',
      '.dlct-alert { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--danger-surface, #fdecea); color: var(--danger, #a93226); }',
      '.dlct-note { margin: 0; color: var(--text-secondary, #5b6472); line-height: 1.5; }',
      '.dlct-actions { display: flex; flex-wrap: wrap; gap: 10px; }',
      '.dlct-button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--accent, #2563eb); background: var(--accent, #2563eb); color: #fff; cursor: pointer; }',
      '.dlct-button[disabled] { opacity: 0.55; cursor: default; }',
      '.dlct-outline { background: transparent; color: var(--accent, #2563eb); }',
      '.dlct-subgroup { display: flex; flex-direction: column; gap: 10px; }',
      '.dlct-subgroup-title { margin: 0; font-size: 0.95rem; }',
      '.dlct-picker { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }',
      '.dlct-picker-field { display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 1 1 220px; }',
      '.dlct-empty { margin: 0; color: var(--text-secondary, #5b6472); }',
      '.dlct-hint { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--surface-sunken, #f4f6f9); color: var(--text-secondary, #5b6472); font-size: 0.82rem; line-height: 1.45; }',
      '.dlct-providers { display: flex; flex-direction: column; gap: 14px; }',
      '.dlct-provider { border: 1px solid var(--border, #d8dde4); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }',
      '.dlct-provider-head { display: flex; flex-direction: column; gap: 4px; }',
      '.dlct-provider-name { margin: 0; font-size: 0.98rem; display: flex; align-items: center; gap: 8px; }',
      '.dlct-provider-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 0; font-size: 0.82rem; color: var(--text-secondary, #5b6472); }',
      '.dlct-route { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dlct-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; border: 1px solid currentColor; }',
      '.dlct-badge-override { color: var(--accent, #2563eb); }',
      '.dlct-badge-default { color: var(--text-tertiary, #7a8493); }',
      '.dlct-outcome { font-size: 0.82rem; color: var(--text-secondary, #5b6472); }',
      '.dlct-presets { display: flex; flex-wrap: wrap; gap: 8px; }',
      '.dlct-advisory { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--warning-surface, #fef7e0); color: var(--warning, #8a6100); font-size: 0.82rem; line-height: 1.45; }',
      '.dlct-protocol { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
    ].join('\n');

    /* ══ path / value helpers ═══════════════════════════════════════════════ */

    /** Whether a value is a plain data object (not null, an array, or a class). */
    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * Read one path off a JSON-shaped value.
     * @param root - the value to walk.
     * @param path - string keys, outermost first.
     * @returns the value at the path, or undefined.
     */
    function getAt(root, path) {
      let node = root;
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined;
        node = node[key];
      }
      return node;
    }

    /** A positive finite delay the retry resolver accepts, or undefined. */
    function validDelay(value) {
      return Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS ? value : undefined;
    }

    /** A jitter ratio the retry resolver accepts, or undefined. */
    function validJitter(value) {
      return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
    }

    /**
     * A fetch timer the host schema accepts, or undefined. The field is an
     * OPTIONAL integer: an absent leaf is the "system default" state and must
     * stay undefined, while a present value is a whole millisecond count from
     * `0` to `2147483647` (`0` disables the timer).
     * @param value - the stored leaf.
     * @returns the value when it is a whole millisecond count in range.
     */
    function validFetchTimeout(value) {
      return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS ? value : undefined;
    }

    /**
     * Normalize the flat process-wide fetch section into the two timer values
     * the page edits. A leaf that is absent — or unusable, which the schema
     * refuses anyway — stays UNSPECIFIED (`null` via `DEFAULT_FETCH`, or
     * `undefined` when the wire omits it): that is the fresh-install "system
     * default" state, never 0 and never a seeded 1800000.
     * @param raw - the settings section value.
     * @returns the two normalized timer values (`null` = unset).
     */
    function normalizeFetch(raw) {
      const section = isPlainObject(raw) ? raw : {};
      return {
        headersTimeoutMs: validFetchTimeout(section.headersTimeoutMs) ?? DEFAULT_FETCH.headersTimeoutMs,
        bodyTimeoutMs: validFetchTimeout(section.bodyTimeoutMs) ?? DEFAULT_FETCH.bodyTimeoutMs,
      };
    }

    /**
     * Build the editable fetch draft from the settings section. The unset state
     * is painted as EMPTY TEXT (an empty input), so "system default" is
     * visually distinct from an explicit `0`, and a half-typed value stays
     * representable.
     * @param raw - the settings section value, or undefined for the unset state.
     * @returns the two-field text draft ('' = unset).
     */
    function fetchDraft(raw) {
      const normalized = normalizeFetch(raw);
      const text = value => (value === null || value === undefined ? '' : String(value));
      return {
        headersTimeoutMs: text(normalized.headersTimeoutMs),
        bodyTimeoutMs: text(normalized.bodyTimeoutMs),
      };
    }

    /**
     * The family of one joined provider row, from its settings path: pi-ai
     * routes live under `settingsPath[0] === 'providers'`, the two DeepSeek
     * routes sit at their namespace root (`settingsPath === []`).
     * @param row - one joined provider row.
     * @returns `'pi-ai'` or `'deepseek'`.
     */
    function timeoutFamily(row) {
      return Array.isArray(row.settingsPath) && row.settingsPath[0] === 'providers' ? 'pi-ai' : 'deepseek';
    }

    /**
     * The per-route timeout fields one row owns, in render and submit order.
     * @param family - `'pi-ai'` or `'deepseek'`.
     * @returns the visible `PROVIDER_TIMEOUT_FIELDS` entries.
     */
    function timeoutFieldsFor(family) {
      return PROVIDER_TIMEOUT_FIELDS.filter(field => field.family === 'all' || field.family === family);
    }

    /**
     * Whether the USER layer of a row's namespace stores one timeout leaf.
     * Presence, never value comparison — the same rule the retry badge uses.
     * @param user - the form snapshot's user layer.
     * @param settingsPath - the provider profile path inside its namespace.
     * @param key - the timeout leaf.
     * @returns true when the user layer names the leaf.
     */
    function timeoutHasOverride(user, settingsPath, key) {
      if (!isPlainObject(user)) return false;
      const profile = getAt(user, settingsPath);
      if (!isPlainObject(profile)) return false;
      return Object.prototype.hasOwnProperty.call(profile, key) && profile[key] !== undefined;
    }

    /**
     * Seed one timeout control as TEXT from the USER layer only. A user value
     * paints as its number (an override); anything absent paints BLANK, which
     * means "leave the package/SDK default in force". The EFFECTIVE value is
     * deliberately not used: it already contains the package default (300 000,
     * 600 000, 60 000), and painting that would make an untouched route look
     * like an override the page had written.
     * @param user - the form snapshot's user layer.
     * @param settingsPath - the provider profile path inside its namespace.
     * @param key - the timeout leaf.
     * @returns the draft text ('' = unset).
     */
    function timeoutSeedText(user, settingsPath, key) {
      if (!isPlainObject(user)) return '';
      const profile = getAt(user, settingsPath);
      if (!isPlainObject(profile)) return '';
      const value = profile[key];
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    }

    /**
     * Build the two/three-field timeout draft of one row from its user layer.
     * @param user - the form snapshot's user layer.
     * @param settingsPath - the provider profile path inside its namespace.
     * @returns the text draft for every timeout field ('' = unset).
     */
    function timeoutSeedDraft(user, settingsPath) {
      const draft = {};
      for (const field of PROVIDER_TIMEOUT_FIELDS) draft[field.key] = timeoutSeedText(user, settingsPath, field.key);
      return draft;
    }

    /**
     * Validate one row's timeout draft. Blank means "unset: keep the
     * package/SDK default"; a value must be a whole number from 1 to
     * 2147483647. `0` is refused for every field: the two watchdogs reject it in
     * their schema, and a zero SDK request timeout aborts every request
     * immediately. Fractional, negative, exponent, overflowing, and malformed
     * text are refused too — a deliberate UI narrowing of schemas that
     * technically tolerate fractions.
     * @param draft - the row's text draft.
     * @param family - `'pi-ai'` or `'deepseek'`.
     * @returns `{ok:true, values}` (null = unset) or `{ok:false, errors}`.
     */
    function validateTimeoutDraft(draft, family) {
      const errors = {};
      const values = {};
      for (const field of timeoutFieldsFor(family)) {
        const text = typeof draft[field.key] === 'string' ? draft[field.key].trim() : '';
        if (text === '') {
          values[field.key] = null;
          continue;
        }
        const value = parseIntegerText(text);
        if (value === undefined || value < 1 || value > MAX_TIMER_DELAY_MS) errors[field.key] = `error.${field.key}`;
        else values[field.key] = value;
      }
      return Object.keys(errors).length === 0 ? { ok: true, values } : { ok: false, errors };
    }

    /**
     * Normalize a stored retryable-code list over the OFFERED codes: known
     * codes only, no duplicates, offered order.
     *
     * OPT-IN SAFETY: an absent, empty, or fully-unknown stored list falls back
     * to the five upstream codes — never to the offered ten — so merely
     * visiting or saving a page can never light up an extra code. A stored code
     * this page does not offer is dropped exactly as before; extras appear in
     * the draft only when the snapshot actually stores them (i.e. a user ticked
     * them earlier).
     * @param raw - the stored value (schema-resolved or user layer).
     * @returns a non-empty array of offered codes (the five defaults when
     *   nothing recognizable remains).
     */
    function normalizeCodes(raw) {
      if (!Array.isArray(raw)) return [...RETRYABLE_CODES];
      const known = raw.filter(code => typeof code === 'string' && OFFERED_RETRYABLE_CODES.indexOf(code) >= 0);
      const unique = OFFERED_RETRYABLE_CODES.filter(code => known.indexOf(code) >= 0);
      return unique.length === 0 ? [...RETRYABLE_CODES] : unique;
    }

    /**
     * Normalize one retry policy (or the flat defaults section) into the six
     * values the page edits. Partial or absent values fall back to the
     * documented code defaults, so an empty namespace still paints a complete,
     * submittable draft. Both the flat defaults shape (`initialDelayMs` at the
     * root) and the provider shape (`backoff.initialDelayMs`) are accepted.
     * @param raw - the section value or a retryPolicy object.
     * @returns the six normalized values.
     */
    function normalizePolicy(raw) {
      const policy = isPlainObject(raw) ? raw : {};
      const backoff = isPlainObject(policy.backoff) ? policy.backoff : {};
      const mode = policy.mode === 'always' ? 'always' : 'normal';
      const maxRetries = Number.isSafeInteger(policy.maxRetries) && policy.maxRetries >= 0
        ? policy.maxRetries
        : DEFAULT_POLICY.maxRetries;
      const initialDelayMs = validDelay(policy.initialDelayMs)
        ?? validDelay(backoff.initialDelayMs)
        ?? DEFAULT_POLICY.initialDelayMs;
      const maxDelayMs = validDelay(policy.maxDelayMs)
        ?? validDelay(backoff.maxDelayMs)
        ?? DEFAULT_POLICY.maxDelayMs;
      const jitterRatio = validJitter(policy.jitterRatio)
        ?? validJitter(backoff.jitterRatio)
        ?? DEFAULT_POLICY.jitterRatio;
      return {
        mode,
        maxRetries,
        initialDelayMs,
        maxDelayMs,
        jitterRatio,
        retryableCodes: normalizeCodes(policy.retryableCodes),
      };
    }

    /**
     * Build the editable draft (all numeric fields as text) from a stored
     * policy. Text keeps a half-typed value representable, and validation is
     * what turns it back into numbers.
     * @param policy - the stored value, or undefined for the code defaults.
     * @returns the six-field text draft.
     */
    function retryDraft(policy) {
      const normalized = normalizePolicy(policy);
      return {
        mode: normalized.mode,
        maxRetries: String(normalized.maxRetries),
        initialDelayMs: String(normalized.initialDelayMs),
        maxDelayMs: String(normalized.maxDelayMs),
        jitterRatio: String(normalized.jitterRatio),
        retryableCodes: normalized.retryableCodes,
      };
    }

    /**
     * One validated value as draft text, so "Use defaults" can stage a row.
     * @param key - the draft field key.
     * @param values - the validated defaults values.
     * @returns the staged draft value.
     */
    function draftValueFromValues(key, values) {
      return key === 'retryableCodes' ? [...values.retryableCodes] : String(values[key]);
    }

    /** Parse strict non-negative integer text; undefined when not exact. */
    function parseIntegerText(text) {
      const shown = typeof text === 'string' ? text.trim() : '';
      if (!/^(0|[1-9][0-9]*)$/.test(shown)) return undefined;
      const value = Number(shown);
      return Number.isSafeInteger(value) ? value : undefined;
    }

    /** Parse finite number text; undefined for blank or non-numeric text. */
    function parseNumberText(text) {
      const shown = typeof text === 'string' ? text.trim() : '';
      if (shown === '') return undefined;
      const value = Number(shown);
      return Number.isFinite(value) ? value : undefined;
    }

    /**
     * Validate one draft against the rules the upstream resolver enforces
     * (`retry-policy.ts:127-178`) plus the cross-field order the schema cannot
     * express. In a provider row whose mode is `always` the retry limit and
     * the code list are inactive: they are not validated, and the write
     * unsets them. The defaults card always owns both, so it validates them
     * even while its mode is `always`.
     * @param draft - the text draft.
     * @param requireNormalFields - validate the normal-mode-only leaves too.
     * @returns `{ok:true, values}` or `{ok:false, errors}` keyed by field.
     */
    function validateDraft(draft, requireNormalFields) {
      const errors = {};
      const values = {};
      const mode = draft.mode === 'normal' || draft.mode === 'always' ? draft.mode : undefined;
      if (mode === undefined) errors.mode = 'error.mode';
      else values.mode = mode;

      const needsNormalFields = requireNormalFields || mode === 'normal';
      if (needsNormalFields) {
        const maxRetries = parseIntegerText(draft.maxRetries);
        if (maxRetries === undefined) errors.maxRetries = 'error.maxRetries';
        else values.maxRetries = maxRetries;

        const codes = Array.isArray(draft.retryableCodes) ? draft.retryableCodes : [];
        const unique = codes.filter((code, index) => codes.indexOf(code) === index);
        if (codes.length === 0
          || unique.length !== codes.length
          || unique.some(code => OFFERED_RETRYABLE_CODES.indexOf(code) < 0)) {
          errors.retryableCodes = 'error.retryableCodes';
        } else {
          values.retryableCodes = [...unique];
        }
      }

      const initialDelayMs = parseNumberText(draft.initialDelayMs);
      if (initialDelayMs === undefined || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
        errors.initialDelayMs = 'error.initialDelayMs';
      } else {
        values.initialDelayMs = initialDelayMs;
      }

      const maxDelayMs = parseNumberText(draft.maxDelayMs);
      if (maxDelayMs === undefined || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
        errors.maxDelayMs = 'error.maxDelayMs';
      } else {
        values.maxDelayMs = maxDelayMs;
      }

      if (errors.initialDelayMs === undefined && errors.maxDelayMs === undefined
        && values.initialDelayMs > values.maxDelayMs) {
        errors.maxDelayMs = 'error.initialDelayOrder';
      }

      const jitterRatio = parseNumberText(draft.jitterRatio);
      if (jitterRatio === undefined || jitterRatio < 0 || jitterRatio > 1) {
        errors.jitterRatio = 'error.jitterRatio';
      } else {
        values.jitterRatio = jitterRatio;
      }

      return Object.keys(errors).length === 0 ? { ok: true, values } : { ok: false, errors };
    }

    /**
     * Validate the two fetch-timer draft values against the tri-state contract
     * the host schema exposes (an OPTIONAL integer `0..2147483647`):
     * - EMPTY (or whitespace-only) is legal and means UNSET — the fresh-install
     *   "system default" state; it is carried as `null` in `values` so the op
     *   builder emits an `unset` leaf;
     * - `0` is legal and means "disable this timer";
     * - a positive whole number up to 2147483647 is a custom limit;
     * - negative, fractional, exponent, blank-after-digits and out-of-range
     *   text are refused.
     * A dedicated path is needed because the retry delays are strictly positive
     * (`>0`) and the shared numeric draft rules do not apply.
     * @param draft - the two-field text draft ('' = unset).
     * @returns `{ok:true, values}` (null = unset) or `{ok:false, errors}`.
     */
    function validateFetchDraft(draft) {
      const errors = {};
      const values = {};
      for (const field of FETCH_FIELDS) {
        const text = typeof draft[field.key] === 'string' ? draft[field.key].trim() : '';
        if (text === '') {
          values[field.key] = null;
          continue;
        }
        const value = parseIntegerText(text);
        if (value === undefined || value > MAX_TIMER_DELAY_MS) errors[field.key] = `error.${field.key}`;
        else values[field.key] = value;
      }
      return Object.keys(errors).length === 0 ? { ok: true, values } : { ok: false, errors };
    }

    /* ══ operation builders ════════════════════════════════════════════════ */

    /**
     * The leaf ops that write one provider's retry policy. The whole
     * `retryPolicy` object is deliberately never set: a set at a leaf leaves
     * every sibling config field (api key reference, baseURL, models) alone.
     * In `always` mode the two normal-only leaves are unset instead.
     * @param settingsPath - the provider profile path inside its namespace.
     * @param values - validated values (`mode` and, when normal, the rest).
     * @returns ordered leaf-path ops.
     */
    function retryPolicyOps(settingsPath, values) {
      const base = [...settingsPath, 'retryPolicy'];
      const ops = [{ op: 'set', path: [...base, 'mode'], value: values.mode }];
      if (values.mode === 'always') {
        ops.push({ op: 'unset', path: [...base, 'maxRetries'] });
        ops.push({ op: 'unset', path: [...base, 'retryableCodes'] });
      } else {
        ops.push({ op: 'set', path: [...base, 'maxRetries'], value: values.maxRetries });
        ops.push({ op: 'set', path: [...base, 'retryableCodes'], value: [...values.retryableCodes] });
      }
      ops.push({ op: 'set', path: [...base, 'backoff', 'initialDelayMs'], value: values.initialDelayMs });
      ops.push({ op: 'set', path: [...base, 'backoff', 'maxDelayMs'], value: values.maxDelayMs });
      ops.push({ op: 'set', path: [...base, 'backoff', 'jitterRatio'], value: values.jitterRatio });
      return ops;
    }

    /**
     * The leaf ops that write this plugin's own flat defaults section.
     * @param values - the six validated values.
     * @returns ordered leaf-path ops.
     */
    function defaultsOps(values) {
      return [
        { op: 'set', path: ['mode'], value: values.mode },
        { op: 'set', path: ['maxRetries'], value: values.maxRetries },
        { op: 'set', path: ['initialDelayMs'], value: values.initialDelayMs },
        { op: 'set', path: ['maxDelayMs'], value: values.maxDelayMs },
        { op: 'set', path: ['jitterRatio'], value: values.jitterRatio },
        { op: 'set', path: ['retryableCodes'], value: [...values.retryableCodes] },
      ];
    }

    /** The single unset that makes a provider fall back to its namespace defaults. */
    function resetPolicyOps(settingsPath) {
      return [{ op: 'unset', path: [...settingsPath, 'retryPolicy'] }];
    }

    /** Whether two normalized retryable-code lists hold the same codes in order. */
    function sameRetryCodes(left, right) {
      return Array.isArray(left) && Array.isArray(right)
        && left.length === right.length
        && left.every((code, index) => code === right[index]);
    }

    /**
     * Which `retryPolicy` leaves the USER layer stores for one route. Only a
     * stored leaf ever needs an `unset`: a leaf that is already absent cannot
     * deviate from the global values, so writing over it would be a pointless
     * (and, through the settings layer's base fallback, potentially noisy) op.
     * @param user - the form snapshot's user layer.
     * @param settingsPath - the provider profile path inside its namespace.
     * @returns one boolean per managed leaf key.
     */
    function retryLeafPresence(user, settingsPath) {
      const policy = isPlainObject(user) ? getAt(user, [...settingsPath, 'retryPolicy']) : undefined;
      const plain = isPlainObject(policy) ? policy : undefined;
      const backoff = plain !== undefined && isPlainObject(plain.backoff) ? plain.backoff : undefined;
      const has = (node, key) => node !== undefined
        && Object.prototype.hasOwnProperty.call(node, key)
        && node[key] !== undefined;
      return {
        mode: has(plain, 'mode'),
        maxRetries: has(plain, 'maxRetries'),
        retryableCodes: has(plain, 'retryableCodes'),
        initialDelayMs: has(backoff, 'initialDelayMs'),
        maxDelayMs: has(backoff, 'maxDelayMs'),
        jitterRatio: has(backoff, 'jitterRatio'),
      };
    }

    /**
     * The leaf ops that write one ROUTE's retry policy RELATIVE to the plugin's
     * global effective retry values, which is what makes a merged per-route
     * card disappear once it no longer deviates:
     * - a leaf whose validated value DIFFERS from the global value is `set`;
     * - a leaf that reverts to the global value is `unset` — but only when the
     *   user layer actually STORES it (`presence`), so an untouched leaf is
     *   never written;
     * - when every emitted op is an `unset`, the single `retryPolicy` unset
     *   from {@link resetPolicyOps} replaces them, so no empty
     *   `{ backoff: {} }` shell is left in the user layer.
     * With no ops at all the builder returns an empty list, so a picked but
     * untouched route never writes.
     *
     * Only a leaf the user actually TOUCHED is written (`dirty`): an untouched
     * control — including the retryable-code list — produces no op at all, so a
     * default route can never be given a new (opt-in) code by pressing Save.
     *
     * `mode: 'always'` keeps its documented contract: the two normal-mode-only
     * leaves are inactive, so a STORED one is cleared, because the upstream
     * union schema ignores them once the mode is `always`.
     * @param settingsPath - the provider profile path inside its namespace.
     * @param values - the validated route values.
     * @param globalValues - the normalized global retry values (comparison base).
     * @param presence - `retryLeafPresence` of the current user layer.
     * @param dirty - `retryDraftDiff` of the draft against its seeded baseline.
     * @returns ordered leaf-path ops; empty when there is nothing to write.
     */
    function retryPolicyDiffOps(settingsPath, values, globalValues, presence, dirty) {
      const base = [...settingsPath, 'retryPolicy'];
      const ops = [];
      const leaf = (key, path, value, globalValue, equal) => {
        if (dirty === undefined || dirty[key] !== true) return;
        const same = equal === undefined ? value === globalValue : equal(value, globalValue);
        if (!same) ops.push({ op: 'set', path, value });
        else if (presence !== undefined && presence[key] === true) ops.push({ op: 'unset', path });
      };
      leaf('mode', [...base, 'mode'], values.mode, globalValues.mode);
      if (values.mode === 'always') {
        if (presence !== undefined && presence.maxRetries === true) {
          ops.push({ op: 'unset', path: [...base, 'maxRetries'] });
        }
        if (presence !== undefined && presence.retryableCodes === true) {
          ops.push({ op: 'unset', path: [...base, 'retryableCodes'] });
        }
      } else {
        leaf('maxRetries', [...base, 'maxRetries'], values.maxRetries, globalValues.maxRetries);
        leaf('retryableCodes', [...base, 'retryableCodes'], [...values.retryableCodes], globalValues.retryableCodes, sameRetryCodes);
      }
      leaf('initialDelayMs', [...base, 'backoff', 'initialDelayMs'], values.initialDelayMs, globalValues.initialDelayMs);
      leaf('maxDelayMs', [...base, 'backoff', 'maxDelayMs'], values.maxDelayMs, globalValues.maxDelayMs);
      leaf('jitterRatio', [...base, 'backoff', 'jitterRatio'], values.jitterRatio, globalValues.jitterRatio);
      if (ops.length === 0 || !ops.every(op => op.op === 'unset')) return ops;
      return resetPolicyOps(settingsPath);
    }

    /**
     * The leaf ops that write the two process-wide fetch timers. The host
     * settings schema exposes both at the TOP LEVEL of this plugin's namespace,
     * so the paths are FLAT: `['headersTimeoutMs']` and `['bodyTimeoutMs']`,
     * never a nested `fetchTimeouts` object. An UNSET draft value (`null`)
     * emits `{op: 'unset', path: [key]}` — the shape the settings API and
     * `ConfigFormController.unset` use — so the leaf disappears and the system
     * default applies again; a value emits the usual `set`. This is
     * deliberately separate from {@link defaultsOps}: the retry defaults are a
     * preset that "Apply defaults to all" projects onto providers, while these
     * timers are a process-wide side effect and are never projected anywhere.
     * @param values - the two validated timer values (`null` = unset).
     * @returns ordered flat leaf-path ops (one per field, in field order).
     */
    function fetchOps(values) {
      return FETCH_FIELDS.map((field) => {
        const value = values[field.key];
        return value === null || value === undefined
          ? { op: 'unset', path: [field.key] }
          : { op: 'set', path: [field.key], value };
      });
    }

    /**
     * The two unsets that remove the user-layer timers, so the process-wide
     * system defaults apply again. This is both the fetch card's Reset and the
     * fresh-install state (`DEFAULT_FETCH`), and is NOT part of
     * {@link resetPolicyOps}, which stays the retry-only single unset of a
     * provider's whole `retryPolicy`.
     * @returns ordered flat leaf-path unsets.
     */
    function fetchResetOps() {
      return [
        { op: 'unset', path: ['headersTimeoutMs'] },
        { op: 'unset', path: ['bodyTimeoutMs'] },
      ];
    }

    /**
     * The leaf ops that persist one row's CHANGED timeout leaves only. A leaf
     * whose draft text equals the seeded user layer is skipped (an untouched
     * route writes nothing); a cleared leaf emits `{op:'unset', path:[...]}`
     * and a value emits `{op:'set', ..., value}`. The paths are the row's own
     * `settingsPath` plus the leaf: `['providers', <route>, 'streamIdleTimeoutMs']`
     * in `llm-pi-ai`, or the flat `['streamIdleTimeoutMs']` /
     * `['filesApiTimeoutMs']` in `llm-deepseek` / `llm-deepseek-account`.
     * `retryPolicy` and whole provider objects are never touched.
     * @param settingsPath - the provider profile path inside its namespace.
     * @param family - `'pi-ai'` or `'deepseek'`.
     * @param baseline - the seeded text draft ('' = unset).
     * @param values - the validated draft values (null = unset).
     * @returns ordered leaf-path ops; empty when nothing changed.
     */
    function timeoutOps(settingsPath, family, baseline, values) {
      const ops = [];
      for (const field of timeoutFieldsFor(family)) {
        const value = values[field.key];
        const path = [...settingsPath, field.key];
        if (value === null || value === undefined) {
          if (baseline[field.key] !== '') ops.push({ op: 'unset', path });
          continue;
        }
        if (baseline[field.key] === String(value)) continue;
        ops.push({ op: 'set', path, value });
      }
      return ops;
    }

    /**
     * The unsets that restore the package/SDK defaults for one row: every
     * timeout leaf THIS card owns for the row's family, and nothing else —
     * never `retryPolicy`, never a whole provider profile.
     * @param settingsPath - the provider profile path inside its namespace.
     * @param family - `'pi-ai'` or `'deepseek'`.
     * @returns ordered flat leaf-path unsets.
     */
    function timeoutResetOps(settingsPath, family) {
      return timeoutFieldsFor(family).map(field => ({ op: 'unset', path: [...settingsPath, field.key] }));
    }

    /**
     * The non-blocking advisories for one row, from its own draft and the
     * process-wide fetch card's body-timeout draft. They never disable Save.
     * @param family - `'pi-ai'` or `'deepseek'`.
     * @param draft - the row's text draft.
     * @param bodyTimeoutText - the fetch card's `bodyTimeoutMs` draft text.
     * @returns ordered dictionary keys to render as notes.
     */
    function timeoutAdvisories(family, draft, bodyTimeoutText) {
      const advisories = [];
      const streamIdle = parseIntegerText(draft.streamIdleTimeoutMs);
      if (family === 'pi-ai'
        && streamIdle !== undefined && streamIdle > SDK_REQUEST_TIMEOUT_MS) {
        const requestText = typeof draft.timeoutMs === 'string' ? draft.timeoutMs.trim() : '';
        const request = requestText === '' ? SDK_REQUEST_TIMEOUT_MS : parseIntegerText(requestText);
        if (request === undefined || request < streamIdle) advisories.push('timeouts.advisory.sdkFirst');
      }
      const body = parseIntegerText(bodyTimeoutText);
      if (streamIdle !== undefined && body !== undefined && body > 0 && body < streamIdle) {
        advisories.push('timeouts.advisory.transportFirst');
      }
      return advisories;
    }

    /* ══ failure classification and submission ═════════════════════════════ */

    /** Render a rejection or envelope error as text without assuming its realm. */
    function messageOf(value) {
      if (value !== null && typeof value === 'object') {
        if (typeof value.message === 'string') return value.message;
        if (value.error !== undefined) return messageOf(value.error);
      }
      return String(value);
    }

    /**
     * Map one REJECTION to the outcome the page surfaces. A home-patch or
     * command-line overlay (config-editor's message, wrapped as the
     * `settings/rejected` RPC code) is "managed elsewhere"; everything else is
     * a plain refusal.
     *
     * DEFENSIVE-ONLY in this DSH release: `ConfigFormController.mutate`
     * converts every failed `settings/mutate` reply into `false` after its own
     * recovery read (`ui-settings/src/client/config-form.ts:129-151`), so a
     * home-patch or `--patch` overlay refusal normally reaches the page as the
     * generic refusal copy, and this branch is reachable only when the form
     * call rejects outright (an assembly/transport fault, or a future API that
     * rejects). The classification is kept for that path and is documented as
     * defensive-only in this release.
     * @param error - the rejection value or an envelope error.
     * @returns `'managed'` or `'refused'`.
     */
    function refusalKind(error) {
      const message = messageOf(error);
      const code = error !== null && typeof error === 'object' ? error.code : undefined;
      if (code === REJECTED_CODE || message.indexOf(REJECTED_CODE) >= 0 || message.indexOf(OVERRIDE_MARKER) >= 0) {
        return 'managed';
      }
      return 'refused';
    }

    /**
     * Submit one ordered op list against a shared form, fenced by the form's
     * current revision. A refusal triggers the controller's own recovery read;
     * when that read moved the revision, the write is retried ONCE at the fresh
     * revision (the only automatic retry this page performs). A transport
     * rejection is classified, never retried.
     * @param form - the provider or defaults config form.
     * @param ops - the leaf-path operation list.
     * @returns `{kind:'saved'|'refused'|'managed'}`.
     */
    function submitOps(form, ops) {
      const attempt = (revision, mayRetry) => Promise.resolve()
        .then(() => form.mutate(ops, revision))
        .then(
          (accepted) => {
            if (accepted === true) return { kind: 'saved' };
            const nextRevision = form.getSnapshot().revision;
            if (mayRetry && revision !== undefined && nextRevision !== undefined && nextRevision !== revision) {
              return attempt(nextRevision, false);
            }
            return { kind: 'refused' };
          },
          (error) => ({ kind: refusalKind(error) }),
        );
      return attempt(form.getSnapshot().revision, true);
    }

    /* ══ provider directory ════════════════════════════════════════════════ */

    /**
     * Resolve the injected `remote.llm` face. The real Remote service is a
     * tracked proxy whose NESTED namespace must be resolved through
     * `ctx.get('remote.llm')`, exactly as the sibling compaction-tuner resolves
     * `remote.session`; a plain injected `remote` object is the fallback the
     * offline doubles use.
     * @param ctx - client root context.
     * @returns the llm Remote namespace, or undefined.
     */
    function remoteLlm(ctx) {
      let resolved;
      try {
        resolved = typeof ctx.get === 'function' ? ctx.get('remote.llm') : undefined;
      } catch (_unresolvedDottedNamespace) {
        resolved = undefined;
      }
      if (resolved !== undefined && resolved !== null) return resolved;
      try {
        const remote = ctx.remote;
        if (remote !== undefined && remote !== null && remote.llm !== undefined && remote.llm !== null) {
          return remote.llm;
        }
      } catch (_noInjectedRemote) {
        return undefined;
      }
      return undefined;
    }

    /**
     * Unwrap a Remote result envelope, tolerating a double that answers with
     * the bare value.
     * @param result - the Remote reply.
     * @returns `{ok:true, value}` or `{ok:false, message}`.
     */
    function unwrapEnvelope(result) {
      if (Array.isArray(result)) return { ok: true, value: result };
      if (result !== null && typeof result === 'object' && result.ok === true) {
        return { ok: true, value: Array.isArray(result.value) ? result.value : [] };
      }
      const error = result !== null && typeof result === 'object' ? result.error : undefined;
      return { ok: false, message: messageOf(error === undefined ? result : error) };
    }

    /**
     * Join the directive directory with the live routes, exactly like the
     * Models page (`ui-settings-models/src/client/store.ts:45-76`): declared
     * providers keep their declaration order, undeclared live routes are
     * appended, and only a route present in `listProviders()` is active.
     * @param registered - live provider routes.
     * @param directory - declared configurable providers.
     * @returns joined rows.
     */
    function joinProviderDirectory(registered, directory) {
      const active = new Set(registered.map(provider => provider.id));
      const declared = new Set(directory.map(entry => entry.provider));
      const rows = directory.map(entry => ({
        provider: entry.provider,
        displayName: typeof entry.displayName === 'string' && entry.displayName.length > 0
          ? entry.displayName
          : entry.provider,
        settingsNs: typeof entry.settingsNs === 'string' ? entry.settingsNs : '',
        settingsPath: Array.isArray(entry.settingsPath) ? [...entry.settingsPath] : [],
        active: active.has(entry.provider),
      }));
      for (const provider of registered) {
        if (declared.has(provider.id)) continue;
        rows.push({
          provider: provider.id,
          displayName: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : provider.id,
          settingsNs: '',
          settingsPath: [],
          active: true,
        });
      }
      const rank = row => (row.provider === 'deepseek-account' ? 0 : row.provider === 'deepseek-official' ? 1 : 2);
      return rows.slice().sort((left, right) => rank(left) - rank(right));
    }

    /**
     * Read the provider directory through the Client Remote service. A missing
     * service degrades to `unavailable`; a refused reply or rejection degrades
     * to `error`; both keep the page (and its defaults card) usable.
     * @param ctx - client root context.
     * @returns a promise of `{status, rows, error?}`, never rejected.
     */
    function readProviderDirectory(ctx) {
      const llm = remoteLlm(ctx);
      if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') {
        return Promise.resolve({ status: 'unavailable', rows: [] });
      }
      let registered;
      let declared;
      try {
        registered = llm.listProviders();
        declared = typeof llm.listConfigurableProviders === 'function'
          ? llm.listConfigurableProviders()
          : Promise.resolve({ ok: true, value: [] });
      } catch (error) {
        return Promise.resolve({ status: 'error', rows: [], error: messageOf(error) });
      }
      return Promise.all([Promise.resolve(registered), Promise.resolve(declared)]).then(
        ([registeredReply, declaredReply]) => {
          const live = unwrapEnvelope(registeredReply);
          const configured = unwrapEnvelope(declaredReply);
          if (!live.ok) return { status: 'error', rows: [], error: live.message };
          if (!configured.ok) return { status: 'error', rows: [], error: configured.message };
          return { status: 'ready', rows: joinProviderDirectory(live.value, configured.value) };
        },
        (error) => ({ status: 'error', rows: [], error: messageOf(error) }),
      );
    }

    /** A row identity stable across provider reloads. */
    function rowKey(row) {
      return `${row.settingsNs}|${row.settingsPath.join('.')}|${row.provider}`;
    }

    /**
     * Resolve each editable row's config form once, when the directory loads.
     * `ConfigForms.get()` never throws for an unserved namespace: it returns a
     * controller whose snapshot reports `unavailable` itself
     * (`ui-settings/src/client/config-form.ts:270-282`), which the row renders
     * as its own note. No per-row catch is needed.
     * @param state - the directory state.
     * @param getForm - namespace -> shared config form.
     * @returns the state with a `form` on each addressed row.
     */
    function withForms(state, getForm) {
      if (state.status !== 'ready') return state;
      return {
        ...state,
        rows: state.rows.map((row) => {
          if (!row.active || row.settingsNs === '') return row;
          return { ...row, form: getForm(row.settingsNs) };
        }),
      };
    }

    /**
     * The write gate shared by a provider row's actions and "Apply defaults to
     * all": the route must be active and addressed, its namespace form must
     * exist, its current snapshot must be `ready` and writable, and the
     * snapshot must carry a NUMERIC revision. The revision is part of the gate
     * because `ConfigFormController.mutate` forwards an `undefined`
     * expectedRevision to `settings.mutate`, and the Host treats a missing
     * revision as an UNCONDITIONAL write
     * (`api/settings-controller/src/index.ts:111,128,147,152`). A row that
     * cannot supply a fence is therefore skipped, never written.
     * @param row - one joined provider row.
     * @param snapshot - the row's current form snapshot; read freshly when omitted.
     * @param form - the row's form; defaults to `row.form`.
     * @returns `{ok, revision}`; `revision` is only meaningful while `ok`.
     */
    function writeGate(row, snapshot, form) {
      if (row === null || row === undefined || !row.active || row.settingsNs === '') {
        return { ok: false, revision: undefined };
      }
      const rowForm = form === undefined ? row.form : form;
      if (rowForm === undefined || rowForm === null || typeof rowForm.getSnapshot !== 'function') {
        return { ok: false, revision: undefined };
      }
      const state = snapshot === undefined ? rowForm.getSnapshot() : snapshot;
      if (state === null || typeof state !== 'object') return { ok: false, revision: undefined };
      if (state.status !== 'ready' || state.writable === false) return { ok: false, revision: undefined };
      if (!Number.isFinite(state.revision)) return { ok: false, revision: undefined };
      return { ok: true, revision: state.revision };
    }

    /**
     * Whether the USER settings layer stores a `retryPolicy` at the provider's
     * settings path. Presence, never value comparison: an override equal to the
     * default still counts (`config-form-types.ts` on `user`).
     * @param user - the form snapshot's user layer.
     * @param settingsPath - the provider profile path.
     * @returns true when the user layer names retryPolicy.
     */
    function userHasOverride(user, settingsPath) {
      if (!isPlainObject(user)) return false;
      const profile = getAt(user, settingsPath);
      if (!isPlainObject(profile)) return false;
      return Object.prototype.hasOwnProperty.call(profile, 'retryPolicy') && profile.retryPolicy !== undefined;
    }

    /* ══ per-route deviation (the merged card's listing rule) ═══════════════ */

    /**
     * The form snapshot of one candidate row, or the idle snapshot while the
     * row carries no live form. Never throws: `ConfigFormController.getSnapshot`
     * is the only method called.
     * @param form - the row's shared config form, if any.
     * @returns the current snapshot (stable reference until the next change).
     */
    function snapshotOf(form) {
      if (form === undefined || form === null || typeof form.getSnapshot !== 'function') return IDLE_SNAPSHOT;
      const snapshot = form.getSnapshot();
      return snapshot === null || snapshot === undefined ? IDLE_SNAPSHOT : snapshot;
    }

    /**
     * Whether one joined row is a route this page can write at all: it must be
     * active, carry a settings namespace, and hold a live shared form. The
     * per-route picker offers exactly these rows (a deviating route is always a
     * subset), because a dormant or unaddressed route has no writable
     * namespace and no snapshot to read.
     * @param row - one joined provider row.
     * @returns true when the row is addressable.
     */
    function isRouteCandidate(row) {
      return row !== null && row !== undefined
        && row.active === true
        && row.settingsNs !== ''
        && row.form !== undefined;
    }

    /**
     * Whether two normalized retry value sets differ in at least one leaf.
     * VALUE-based on purpose: a stored `retryPolicy` identical to the global
     * values must not keep a card on the page.
     * @param routeValues - `normalizePolicy` of the route's effective value.
     * @param globalValues - `normalizePolicy` of the plugin's own section.
     * @returns true when the route deviates from the global retry values.
     */
    function retryValuesDeviate(routeValues, globalValues) {
      for (const field of RETRY_FIELDS) {
        if (field.key === 'retryableCodes') {
          if (!sameRetryCodes(routeValues.retryableCodes, globalValues.retryableCodes)) return true;
        } else if (routeValues[field.key] !== globalValues[field.key]) {
          return true;
        }
      }
      return false;
    }

    /**
     * The retry half of the merged listing rule: the route's EFFECTIVE stored
     * retry policy differs from the plugin's global effective retry values in at
     * least one leaf. A row whose snapshot has not answered cannot be judged,
     * so it is not listed (it is listed once its snapshot arrives).
     * @param snapshot - the route form snapshot.
     * @param settingsPath - the provider profile path inside its namespace.
     * @param globalValues - the normalized global retry values.
     * @returns true when the route's retry policy deviates.
     */
    function routeRetryDeviates(snapshot, settingsPath, globalValues) {
      if (snapshot === null || snapshot === undefined || snapshot.status !== 'ready') return false;
      return retryValuesDeviate(
        normalizePolicy(getAt(snapshot.value, [...settingsPath, 'retryPolicy'])),
        globalValues,
      );
    }

    /**
     * The timeout half of the merged listing rule. There is deliberately no
     * global counterpart to compare against: the global fetch timers are
     * undici transport timers, while these are the route's application-layer
     * watchdogs (`streamIdleTimeoutMs`, `timeoutMs`, `filesApiTimeoutMs`), so
     * "deviates" means PRESENCE in the user layer — a route that explicitly
     * stores any timeout leaf it owns is listed, whatever the value.
     * @param snapshot - the route form snapshot.
     * @param row - the joined provider row (supplies `settingsPath` and family).
     * @returns true when the user layer names one of the route's timeout leaves.
     */
    function routeTimeoutDeviates(snapshot, row) {
      if (snapshot === null || snapshot === undefined || snapshot.status !== 'ready') return false;
      for (const field of timeoutFieldsFor(timeoutFamily(row))) {
        if (timeoutHasOverride(snapshot.user, row.settingsPath, field.key)) return true;
      }
      return false;
    }

    /**
     * Which retry controls the user TOUCHED, i.e. which fields differ from the
     * draft seeded from the current snapshot. Text is compared exactly (a
     * half-typed value still counts as an edit) and the code list by its
     * ordered contents.
     *
     * This is what keeps the extra (opt-in) codes inert: the save path builds
     * ops only for touched leaves, so an untouched retryable-code list never
     * produces an op and can never add a code.
     * @param draft - the current text draft.
     * @param baseline - the draft reseeded from the current snapshot.
     * @returns one boolean per `RETRY_FIELDS` key.
     */
    function retryDraftDiff(draft, baseline) {
      const dirty = {};
      for (const field of RETRY_FIELDS) {
        const left = draft[field.key];
        const right = baseline[field.key];
        dirty[field.key] = Array.isArray(left) || Array.isArray(right)
          ? !sameRetryCodes(left, right)
          : left !== right;
      }
      return dirty;
    }

    /* ══ rendered helpers ══════════════════════════════════════════════════ */

    /**
     * One outcome (save/reset) as a note or an alert.
     * @param outcome - `{kind}` from a submission, or null.
     * @param t - translate.
     * @param resetKey - the copy a `reset` outcome uses; the provider rows keep
     *   the retry-specific default, the fetch card names its own reset.
     * @returns the node, or null.
     */
    function outcomeNode(outcome, t, resetKey = 'status.reset') {
      if (outcome === null || outcome === undefined) return null;
      if (outcome.kind === 'saved') {
        return h('p', { className: 'dlct-note', role: 'status' }, t('status.saved'));
      }
      if (outcome.kind === 'reset') {
        return h('p', { className: 'dlct-note', role: 'status' }, t(resetKey));
      }
      return h('p', { className: 'dlct-alert', role: 'alert' }, t(outcome.kind === 'managed' ? 'error.managed' : 'error.refused'));
    }

    /**
     * The six retry controls shared by the defaults card and every provider
     * row. A plain render helper (no hooks): ids and the draft come from the
     * caller, so both surfaces stay hook-count stable.
     * @param options - `{t, ids, draft, errors, disabled, stage, showNormalFields}`.
     * @returns the control nodes.
     */
    function renderRetryFields(options) {
      const { t, ids, draft, errors, disabled, stage, showNormalFields } = options;
      const nodes = [];
      nodes.push(h('div', { className: 'dlct-field', key: 'mode' },
        h('div', { className: 'dlct-field-head' },
          h('label', { className: 'dlct-field-label', htmlFor: ids.mode }, t('field.mode.label')),
          h('span', { className: 'dlct-unit' }, t('field.mode.unit')),
        ),
        h('select', {
          id: ids.mode,
          className: 'dlct-select',
          value: draft.mode,
          disabled,
          onChange: event => stage('mode', event.target.value),
        }, MODES.map(mode => h('option', { key: mode, value: mode }, t(`mode.${mode}`)))),
        h('p', { className: 'dlct-description' }, t('field.mode.description')),
        h('span', { className: 'dlct-default' }, t('field.mode.default')),
        errors.mode === undefined ? null : h('p', { className: 'dlct-error', role: 'alert' }, t(errors.mode)),
      ));

      for (const field of NUMERIC_FIELDS) {
        const invalid = errors[field.key];
        nodes.push(h('div', { className: 'dlct-field', key: field.key },
          h('div', { className: 'dlct-field-head' },
            h('label', { className: 'dlct-field-label', htmlFor: ids[field.key] }, t(`field.${field.key}.label`)),
            h('span', { className: 'dlct-unit' }, t(`field.${field.key}.unit`)),
          ),
          h('input', {
            id: ids[field.key],
            className: 'dlct-input',
            type: 'text',
            inputMode: field.inputMode,
            step: field.step,
            min: field.min,
            max: field.max,
            value: draft[field.key],
            disabled,
            'aria-invalid': invalid === undefined ? undefined : 'true',
            onChange: event => stage(field.key, event.target.value),
          }),
          h('p', { className: 'dlct-description' }, t(`field.${field.key}.description`)),
          h('span', { className: 'dlct-default' }, t(`field.${field.key}.default`)),
          invalid === undefined ? null : h('p', { className: 'dlct-error', role: 'alert' }, t(invalid)),
        ));
      }

      if (showNormalFields) {
        const selected = Array.isArray(draft.retryableCodes) ? draft.retryableCodes : [];
        nodes.push(h('fieldset', { className: 'dlct-field dlct-codes', key: 'retryableCodes', id: ids.retryableCodes },
          h('div', { className: 'dlct-field-head' },
            h('legend', { className: 'dlct-field-label' }, t('field.retryableCodes.label')),
            h('span', { className: 'dlct-unit' }, t('field.retryableCodes.unit')),
          ),
          h('div', { className: 'dlct-code-list' }, OFFERED_RETRYABLE_CODES.map(code => h('label', { className: 'dlct-code', key: code },
            h('input', {
              type: 'checkbox',
              checked: selected.indexOf(code) >= 0,
              disabled,
              onChange: (event) => {
                const next = new Set(selected);
                if (event.target.checked === true) next.add(code);
                else next.delete(code);
                stage('retryableCodes', OFFERED_RETRYABLE_CODES.filter(known => next.has(known)));
              },
            }),
            h('span', null, t(`code.${code}`)),
          ))),
          h('p', { className: 'dlct-description' }, t('field.retryableCodes.description')),
          h('span', { className: 'dlct-default' }, t('field.retryableCodes.default')),
          errors.retryableCodes === undefined
            ? null
            : h('p', { className: 'dlct-error', role: 'alert' }, t(errors.retryableCodes)),
        ));
      }

      return nodes;
    }

    /**
     * The two process-wide fetch-timer controls of the fourth card. A plain
     * render helper (no hooks) like {@link renderRetryFields}: ids and the
     * draft come from the caller, so the section stays hook-count stable.
     * @param options - `{t, ids, draft, errors, disabled, stage}`.
     * @returns the control nodes, in FETCH_FIELDS order.
     */
    function renderFetchFields(options) {
      const { t, ids, draft, errors, disabled, stage } = options;
      const nodes = [];
      for (const field of FETCH_FIELDS) {
        const invalid = errors[field.key];
        nodes.push(h('div', { className: 'dlct-field', key: field.key },
          h('div', { className: 'dlct-field-head' },
            h('label', { className: 'dlct-field-label', htmlFor: ids[field.key] }, t(`field.${field.key}.label`)),
            h('span', { className: 'dlct-unit' }, t(`field.${field.key}.unit`)),
          ),
          h('input', {
            id: ids[field.key],
            className: 'dlct-input',
            type: 'text',
            inputMode: field.inputMode,
            step: field.step,
            min: field.min,
            max: field.max,
            value: draft[field.key],
            placeholder: t('fetch.placeholder'),
            disabled,
            'aria-invalid': invalid === undefined ? undefined : 'true',
            onChange: event => stage(field.key, event.target.value),
          }),
          h('p', { className: 'dlct-description' }, t(`field.${field.key}.description`)),
          h('span', { className: 'dlct-default' }, t('fetch.hint')),
          invalid === undefined ? null : h('p', { className: 'dlct-error', role: 'alert' }, t(invalid)),
        ));
      }
      return nodes;
    }

    /**
     * The timeout controls of one row. A plain render helper (no hooks) like
     * {@link renderRetryFields}: only the fields the row's family owns are
     * rendered, and each carries its blank-by-default draft, the package/SDK
     * default as the placeholder, a per-field override/default state badge, and
     * the "unlimited" preset that fills the schema cap.
     * @param options - `{t, ids, family, draft, errors, overrides, disabled, stage, preset}`.
     * @returns the control nodes, in `timeoutFieldsFor(family)` order.
     */
    function renderTimeoutFields(options) {
      const { t, ids, family, draft, errors, overrides, disabled, stage, preset } = options;
      const nodes = [];
      for (const field of timeoutFieldsFor(family)) {
        const invalid = errors[field.key];
        const override = overrides[field.key] === true;
        nodes.push(h('div', { className: 'dlct-field', key: field.key },
          h('div', { className: 'dlct-field-head' },
            h('label', { className: 'dlct-field-label', htmlFor: ids[field.key] }, t(`field.${field.key}.label`)),
            h('span', { className: 'dlct-unit' }, t('timeouts.unit')),
            h('span', {
              className: `dlct-badge ${override ? 'dlct-badge-override' : 'dlct-badge-default'}`,
            }, t(override ? 'provider.source.override' : 'provider.source.default')),
          ),
          h('input', {
            id: ids[field.key],
            className: 'dlct-input',
            type: 'text',
            inputMode: 'numeric',
            step: '1',
            min: '1',
            max: String(MAX_TIMER_DELAY_MS),
            value: draft[field.key],
            placeholder: String(field.placeholder),
            disabled,
            'aria-invalid': invalid === undefined ? undefined : 'true',
            onChange: event => stage(field.key, event.target.value),
          }),
          h('p', { className: 'dlct-description' }, t(`field.${field.key}.description`)),
          h('span', { className: 'dlct-default' }, t('timeouts.hint')),
          h('div', { className: 'dlct-presets' },
            h('button', {
              type: 'button',
              className: 'dlct-button dlct-outline dlct-preset',
              disabled,
              onClick: () => preset(field.key),
            }, t('timeouts.unlimited')),
          ),
          invalid === undefined ? null : h('p', { className: 'dlct-error', role: 'alert' }, t(invalid)),
        ));
      }
      return nodes;
    }

    /**
     * One merged per-route card: the route's retry policy AND its
     * application-layer timeouts in ONE card, with two labeled sub-groups.
     *
     * The merge is sound because both groups write the SAME namespace and the
     * SAME settings path for a given route: `providers.<route>` in `llm-pi-ai`
     * (retryPolicy + streamIdleTimeoutMs + timeoutMs) and the namespace root in
     * `llm-deepseek` / `llm-deepseek-account` (retryPolicy +
     * streamIdleTimeoutMs + filesApiTimeoutMs). One Save therefore submits ONE
     * ordered op list at one revision fence, carrying the retry leaves and the
     * timeout leaves of both sub-groups.
     *
     * The retry draft is seeded from the EFFECTIVE value and compared against
     * the plugin's global retry values on save, so a leaf typed back to a
     * global value is written as an `unset` and the card disappears once the
     * route no longer deviates. The timeout draft is seeded from the USER layer
     * only (blank = the package/SDK default stays in force), so an untouched
     * control writes nothing and a cleared one becomes an `unset`.
     *
     * The card subscribes to the provider's own shared config form, so a write
     * from anywhere re-seeds both drafts from the next Host answer.
     * @param props - the joined row, its form, the translated copy, the
     *   validated global retry values ("Use defaults" and the unset-on-revert
     *   baseline), the global fetch body-timeout draft text (advisory only), and
     *   the parent's `onSettled` callback (drops the route from the local picked
     *   set once a save or reset settled it).
     * @returns the card tree.
     */
    function RouteCard(props) {
      const {
        row, t, form, defaultsValues, globalRetryValues, bodyTimeoutMs, onSettled,
      } = props;
      const store = form === undefined ? IDLE_FORM : form;
      const subscribe = useCallback(listener => store.subscribe(listener), [store]);
      const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
      const snapshot = useSyncExternalStore(subscribe, getSnapshot);

      const retryIds = {};
      for (const field of RETRY_FIELDS) retryIds[field.key] = useId();
      const timeoutIds = {};
      for (const field of PROVIDER_TIMEOUT_FIELDS) timeoutIds[field.key] = useId();

      const [retryEdits, setRetryEdits] = useState({});
      const [timeoutEdits, setTimeoutEdits] = useState({});
      const [pending, setPending] = useState(null);
      const [outcome, setOutcome] = useState(null);
      const pendingRef = useRef(false);
      const busy = pending !== null;

      const family = timeoutFamily(row);
      const editable = row.active && row.settingsNs !== '' && form !== undefined;
      const status = snapshot !== null && snapshot !== undefined && typeof snapshot.status === 'string'
        ? snapshot.status
        : 'loading';
      const ready = editable && status === 'ready';
      const writable = ready && snapshot.writable !== false;
      // The SAME gate as every other write on this page: ready, writable, and a
      // numeric revision, so no unconditional write is ever sent.
      const disabled = !writeGate(row, snapshot, form).ok;
      const value = snapshot === null || snapshot === undefined ? undefined : snapshot.value;
      const user = snapshot === null || snapshot === undefined ? undefined : snapshot.user;

      const policyRaw = ready ? getAt(value, [...row.settingsPath, 'retryPolicy']) : undefined;
      const storedRetry = ready ? userHasOverride(user, row.settingsPath) : false;
      const retryPresence = ready ? retryLeafPresence(user, row.settingsPath) : undefined;
      const retrySeedKey = ready
        ? `${String(snapshot.revision)}|${JSON.stringify(policyRaw === undefined ? null : policyRaw)}`
        : '';
      const retryBaseline = retryDraft(policyRaw);
      const retryValues = {};
      for (const field of RETRY_FIELDS) {
        const edit = retryEdits[field.key];
        retryValues[field.key] = edit !== undefined && edit.seedKey === retrySeedKey
          ? edit.value
          : retryBaseline[field.key];
      }
      const retryCheck = validateDraft(retryValues, false);
      const retryErrors = retryCheck.ok ? {} : retryCheck.errors;
      const retryDirty = retryDraftDiff(retryValues, retryBaseline);
      const retryChanged = RETRY_FIELDS.some(field => retryDirty[field.key] === true);

      const userProfile = ready && isPlainObject(user) ? getAt(user, row.settingsPath) : undefined;
      const timeoutSeedKey = ready
        ? `${String(snapshot.revision)}|${JSON.stringify(userProfile === undefined ? null : userProfile)}`
        : '';
      const timeoutBaseline = timeoutSeedDraft(user, row.settingsPath);
      const timeoutValues = {};
      for (const field of PROVIDER_TIMEOUT_FIELDS) {
        const edit = timeoutEdits[field.key];
        timeoutValues[field.key] = edit !== undefined && edit.seedKey === timeoutSeedKey
          ? edit.value
          : timeoutBaseline[field.key];
      }
      const timeoutCheck = validateTimeoutDraft(timeoutValues, family);
      const timeoutErrors = timeoutCheck.ok ? {} : timeoutCheck.errors;
      const overrides = {};
      for (const field of PROVIDER_TIMEOUT_FIELDS) {
        overrides[field.key] = timeoutHasOverride(user, row.settingsPath, field.key);
      }

      const retryOps = retryCheck.ok && retryChanged
        ? retryPolicyDiffOps(row.settingsPath, retryCheck.values, globalRetryValues, retryPresence, retryDirty)
        : [];
      const timeoutChangedOps = timeoutCheck.ok
        ? timeoutOps(row.settingsPath, family, timeoutBaseline, timeoutCheck.values)
        : [];
      const ops = [...retryOps, ...timeoutChangedOps];
      const storedDeviation = storedRetry
        || timeoutFieldsFor(family).some(field => overrides[field.key] === true);
      const resetOps = [
        ...resetPolicyOps(row.settingsPath),
        ...timeoutResetOps(row.settingsPath, family),
      ];

      /** Stage one retry value against the snapshot currently shown. */
      const stageRetry = (key, next) => {
        setRetryEdits(current => ({ ...current, [key]: { value: next, seedKey: retrySeedKey } }));
        setOutcome(null);
      };

      /** Stage one timeout value against the snapshot currently shown. */
      const stageTimeout = (key, next) => {
        setTimeoutEdits(current => ({ ...current, [key]: { value: next, seedKey: timeoutSeedKey } }));
        setOutcome(null);
      };

      /** Fill the schema cap (2147483647 ms) - a cap, not an off switch. */
      const presetTimeout = key => stageTimeout(key, String(UNLIMITED_TIMEOUT_MS));

      /**
       * Write every CHANGED leaf of both groups as one ordered op list at one
       * revision fence. Nothing here is projected onto another route.
       */
      const save = () => {
        if (disabled || busy || pendingRef.current || !retryCheck.ok || !timeoutCheck.ok || ops.length === 0) return;
        pendingRef.current = true;
        setPending('save');
        setOutcome(null);
        submitOps(form, ops).then((result) => {
          pendingRef.current = false;
          setPending(null);
          setRetryEdits({});
          setTimeoutEdits({});
          setOutcome(result);
          if (result.kind === 'saved' && typeof onSettled === 'function') onSettled(row);
        });
      };

      /**
       * Remove everything this card stores for the route (the whole
       * `retryPolicy` plus this family's timeout leaves) in one write. A picked
       * card that stores nothing yet is closed LOCALLY instead: writing unsets
       * over a route with no override would only add noise to the user layer.
       */
      const reset = () => {
        if (busy || pendingRef.current) return;
        setOutcome(null);
        if (!storedDeviation) {
          setRetryEdits({});
          setTimeoutEdits({});
          if (typeof onSettled === 'function') onSettled(row);
          return;
        }
        if (disabled) return;
        pendingRef.current = true;
        setPending('reset');
        submitOps(form, resetOps).then((result) => {
          pendingRef.current = false;
          setPending(null);
          setRetryEdits({});
          setTimeoutEdits({});
          setOutcome(result.kind === 'saved' ? { kind: 'reset' } : result);
          if (result.kind === 'saved' && typeof onSettled === 'function') onSettled(row);
        });
      };

      /** Copy the validated global retry defaults into the retry draft. */
      const useDefaults = () => {
        if (disabled || busy || defaultsValues === undefined) return;
        const next = {};
        for (const field of RETRY_FIELDS) {
          next[field.key] = { value: draftValueFromValues(field.key, defaultsValues), seedKey: retrySeedKey };
        }
        setRetryEdits(next);
        setOutcome(null);
      };

      const advisoryKeys = writable ? timeoutAdvisories(family, timeoutValues, bodyTimeoutMs) : [];
      const protocol = family === 'deepseek'
        ? 'anthropic-messages'
        : ready && typeof getAt(value, [...row.settingsPath, 'api']) === 'string'
          ? getAt(value, [...row.settingsPath, 'api'])
          : '';
      const namespaceText = [row.settingsNs, ...row.settingsPath].filter(part => part !== '').join(' \u203a ');
      const badge = editable
        ? h('span', {
            className: `dlct-badge ${storedRetry ? 'dlct-badge-override' : 'dlct-badge-default'}`,
          }, t(storedRetry ? 'provider.source.override' : 'provider.source.default'))
        : null;

      const body = [];
      if (!row.active) {
        body.push(h('p', { className: 'dlct-note', key: 'dormant' }, t('provider.status.dormant')));
      } else if (row.settingsNs === '') {
        body.push(h('p', { className: 'dlct-note', key: 'no-settings' }, t('provider.status.noSettings')));
      } else if (form === undefined) {
        body.push(h('p', { className: 'dlct-note', key: 'no-form' }, t('provider.status.unavailable')));
      } else if (status === 'loading') {
        body.push(h('p', { className: 'dlct-note', key: 'loading' }, t('status.loading')));
      } else if (status === 'unavailable') {
        body.push(h('p', { className: 'dlct-note', key: 'unavailable' }, t('provider.status.unavailable')));
      } else if (!writable) {
        body.push(h('p', { className: 'dlct-note', key: 'read-only' }, t('status.readOnly')));
      } else {
        if (!storedDeviation) {
          body.push(h('p', { className: 'dlct-hint', key: 'picked-hint' }, t('routes.pickedHint')));
        }
        body.push(h('div', { className: 'dlct-subgroup', key: 'retry-group' },
          h('h5', { className: 'dlct-subgroup-title' }, t('routes.retryHeading')),
          h('div', { className: 'dlct-fields' },
            renderRetryFields({
              t,
              ids: retryIds,
              draft: retryValues,
              errors: retryErrors,
              disabled: disabled || busy,
              stage: stageRetry,
              showNormalFields: retryValues.mode !== 'always',
            }),
          ),
        ));
        if (retryValues.mode === 'always') {
          body.push(h('p', { className: 'dlct-note', key: 'always' }, t('provider.alwaysNote')));
        }
        body.push(h('div', { className: 'dlct-subgroup', key: 'timeout-group' },
          h('h5', { className: 'dlct-subgroup-title' }, t('routes.timeoutsHeading')),
          h('div', { className: 'dlct-fields' },
            renderTimeoutFields({
              t,
              ids: timeoutIds,
              family,
              draft: timeoutValues,
              errors: timeoutErrors,
              overrides,
              disabled: disabled || busy,
              stage: stageTimeout,
              preset: presetTimeout,
            }),
          ),
        ));
        body.push(h('div', { className: 'dlct-actions', key: 'actions' },
          h('button', {
            type: 'button',
            className: 'dlct-button',
            disabled: disabled || busy || !retryCheck.ok || !timeoutCheck.ok || ops.length === 0,
            'aria-busy': pending === 'save' ? 'true' : undefined,
            onClick: save,
          }, pending === 'save' ? t('provider.saving') : t('provider.save')),
          h('button', {
            type: 'button',
            className: 'dlct-button dlct-outline',
            disabled: disabled || busy,
            'aria-busy': pending === 'reset' ? 'true' : undefined,
            onClick: reset,
          }, pending === 'reset' ? t('provider.resetting') : t('provider.reset')),
          h('button', {
            type: 'button',
            className: 'dlct-button dlct-outline',
            disabled: disabled || busy || defaultsValues === undefined,
            onClick: useDefaults,
          }, t('provider.useDefaults')),
        ));
        for (const key of advisoryKeys) {
          body.push(h('p', { className: 'dlct-advisory', role: 'status', key }, t(key)));
        }
        body.push(h('div', { key: 'outcome' }, outcomeNode(outcome, t, 'status.routeReset')));
      }

      return h('section', { className: 'dlct-provider' },
        h('header', { className: 'dlct-provider-head' },
          h('h4', { className: 'dlct-provider-name' }, row.displayName, badge),
          h('p', { className: 'dlct-provider-meta' },
            h('code', { className: 'dlct-route' }, row.provider),
            namespaceText === ''
              ? null
              : h('span', { className: 'dlct-namespace' }, `${t('provider.namespace')}: ${namespaceText}`),
            h('span', { className: 'dlct-protocol' }, `${t('timeouts.protocol')}: ${protocol === '' ? t('timeouts.protocol.catalog') : protocol}`),
          ),
        ),
        body,
      );
    }

    /**
     * The "LLM API call tuning" settings page, in two tiers:
     * 1. ONE "Global settings" card carrying both global sub-groups, retries
     *    first and then the process-wide fetch timeouts, so every global knob
     *    precedes anything per-route;
     * 2. ONE per-route tier: a native route picker ABOVE the list, and one
     *    merged card per DEVIATING route (retry policy AND timeouts inside it).
     *
     * A route is listed when (a) its effective stored retry policy differs in
     * at least one leaf from the global retry values, or (b) one of its timeout
     * leaves is explicitly present in the user layer (the global fetch timers
     * are a different knob, so presence is the only meaningful test there).
     *
     * The page subscribes ONCE to this plugin's own form AND to every candidate
     * route form, so the picker's "already listed" set and the deviating list
     * are recomputed on any provider snapshot change (a write from another page
     * included) while the component keeps a single external-store seat. The
     * snapshot objects are cached by identity, so the combined value is stable
     * between notifications.
     * @param props - slot props.
     * @param props.form - shared config form for this plugin's own namespace.
     * @param props.t - localized copy for this plugin's namespace.
     * @param props.getForm - namespace -> shared config form (provider rows).
     * @param props.readProviders - provider directory reader (Remote `llm`).
     * @returns the section tree.
     */
    function TuningSection(props) {
      const { form, t, getForm, readProviders } = props;

      const [providers, setProviders] = useState({ status: 'loading', rows: [] });
      const [applying, setApplying] = useState(false);
      const [applyOutcomes, setApplyOutcomes] = useState({});
      /* Routes materialized by the picker but not stored yet: picking is local
       * state only, so it writes NOTHING until a field is edited and saved. */
      const [pickedRoutes, setPickedRoutes] = useState({});
      const [pickRoute, setPickRoute] = useState('');

      // One mount read of the provider directory; `readProviders` and `getForm`
      // are stable closures owned by `apply`, so this cannot re-fire per render.
      useEffect(() => {
        let live = true;
        Promise.resolve()
          .then(() => readProviders())
          .then(
            (state) => { if (live) setProviders(withForms(state, getForm)); },
            (error) => { if (live) setProviders({ status: 'error', rows: [], error: messageOf(error) }); },
          );
        return () => { live = false; };
      }, [readProviders, getForm]);

      /* Candidate routes: active, addressed, and holding a live form. A
       * deviating route is always a subset of this list; the picker offers the
       * ones that are not listed yet. */
      const routeRows = providers.status === 'ready' ? providers.rows.filter(isRouteCandidate) : EMPTY_ROWS;
      /* Identity of the subscribed form set: it changes exactly when the
       * directory does, so both seats below stay memoized across renders. */
      const routeSignature = routeRows.map(row => rowKey(row)).join('|');

      const storeCache = useRef({ own: undefined, routes: EMPTY_ROWS, value: null });
      const subscribePage = useCallback((listener) => {
        const disposers = [form.subscribe(listener)];
        for (const row of routeRows) disposers.push(row.form.subscribe(listener));
        return () => { for (const dispose of disposers) dispose(); };
      }, [form, routeSignature]);
      const getPageState = useCallback(() => {
        const own = form.getSnapshot();
        const routes = routeRows.map(row => snapshotOf(row.form));
        const cache = storeCache.current;
        const unchanged = cache.own === own
          && cache.routes.length === routes.length
          && cache.routes.every((snapshot, index) => snapshot === routes[index]);
        if (unchanged) return cache.value;
        const value = Object.freeze({ own, routes });
        storeCache.current = { own, routes, value };
        return value;
      }, [form, routeSignature]);
      const pageState = useSyncExternalStore(subscribePage, getPageState);
      const snapshot = pageState.own;

      const ids = {};
      for (const field of RETRY_FIELDS) ids[field.key] = useId();
      /* A second id block for the fetch controls. `FETCH_FIELDS` is frozen, so
       * the hook count stays constant across renders. */
      const fetchIds = {};
      for (const field of FETCH_FIELDS) fetchIds[field.key] = useId();
      const pickerId = useId();

      const [edits, setEdits] = useState({});
      const [fetchEdits, setFetchEdits] = useState({});
      const [pending, setPending] = useState(null);
      const [outcome, setOutcome] = useState(null);
      const pendingRef = useRef(false);
      const busy = pending !== null;

      const status = snapshot !== null && snapshot !== undefined && typeof snapshot.status === 'string'
        ? snapshot.status
        : 'loading';
      const ready = status === 'ready';
      const writable = ready && snapshot.writable !== false;
      const disabled = !ready || !writable;
      const value = snapshot === null || snapshot === undefined ? undefined : snapshot.value;

      /* Re-seed rule: the canonical draft is derived from the current
       * snapshot; a staged edit is shown only while it was staged against that
       * snapshot (same revision and value). A snapshot change therefore
       * re-seeds every field, which is what surfaces a refused write's
       * recovery read. */
      const seedKey = ready ? `${String(snapshot.revision)}|${JSON.stringify(value === undefined ? null : value)}` : '';
      const baseline = retryDraft(value);
      const draft = {};
      for (const field of RETRY_FIELDS) {
        const edit = edits[field.key];
        draft[field.key] = edit !== undefined && edit.seedKey === seedKey ? edit.value : baseline[field.key];
      }
      const check = validateDraft(draft, true);
      const errors = check.ok ? {} : check.errors;

      const stage = (key, next) => {
        setEdits(current => ({ ...current, [key]: { value: next, seedKey } }));
        setOutcome(null);
      };

      /* The fetch controls read the SAME own-namespace snapshot, but their
       * baseline is the two flat top-level leaves and a staged edit obeys the
       * same re-seed rule. Both drafts live in ONE card now, yet stay apart, so
       * a refused global save can never clear a half-typed fetch timer. */
      const fetchBaseline = fetchDraft(value);
      const fetchValues = {};
      for (const field of FETCH_FIELDS) {
        const edit = fetchEdits[field.key];
        fetchValues[field.key] = edit !== undefined && edit.seedKey === seedKey ? edit.value : fetchBaseline[field.key];
      }
      const fetchCheck = validateFetchDraft(fetchValues);
      const fetchErrors = fetchCheck.ok ? {} : fetchCheck.errors;

      const stageFetch = (key, next) => {
        setFetchEdits(current => ({ ...current, [key]: { value: next, seedKey } }));
        setOutcome(null);
      };

      /**
       * Persist the six global retry defaults AND the two process-wide fetch
       * leaves in ONE write: every leaf lives in this plugin's own namespace, so
       * one ordered op list at one revision fence covers both sub-groups. An
       * empty fetch field emits `unset` (system default), never a seeded value.
       */
      const saveGlobal = () => {
        if (disabled || busy || pendingRef.current || !check.ok || !fetchCheck.ok) return;
        pendingRef.current = true;
        setPending('save');
        setOutcome(null);
        submitOps(form, [...defaultsOps(check.values), ...fetchOps(fetchCheck.values)]).then((result) => {
          pendingRef.current = false;
          setPending(null);
          setEdits({});
          setFetchEdits({});
          setOutcome(result);
        });
      };

      /** Clear both fetch leaves so the system (fresh-install) defaults apply again. */
      const resetFetch = () => {
        if (disabled || busy || pendingRef.current) return;
        pendingRef.current = true;
        setPending('resetFetch');
        setOutcome(null);
        submitOps(form, fetchResetOps()).then((result) => {
          pendingRef.current = false;
          setPending(null);
          setFetchEdits({});
          setOutcome(result.kind === 'saved' ? { kind: 'reset' } : result);
        });
      };

      /**
       * The rows "Apply defaults to all" may ADDRESS: an active route carrying
       * a settings namespace and a live form. Readiness, writability and the
       * revision fence are deliberately NOT decided here: `writeGate` re-reads
       * each row's snapshot immediately before its write, because a provider
       * form can still be loading (or become read-only / lose its revision)
       * after the directory joined it.
       */
      const applyTargets = providers.status === 'ready'
        ? providers.rows.filter(row => row.active && row.settingsNs !== '' && row.form !== undefined)
        : [];

      /**
       * Copy the validated defaults into every eligible provider, one provider
       * at a time. Immediately before EACH write the row is re-gated from its
       * freshest snapshot, and that same read supplies the revision fence, so:
       * - a loading/unavailable/read-only row is SKIPPED (recorded as
       *   `apply.outcome` state `'skipped'`) instead of being written;
       * - a row without a numeric revision is skipped too, because an
       *   `undefined` expectedRevision reaches the Host as an unconditional
       *   write (settings-controller);
       * - two rows sharing a namespace (llm-pi-ai) each take the revision
       *   folded in by the previous row's accepted write, never a stale one.
       * A refused row keeps its policy; the write outcome is recorded per row.
       */
      const applyAll = () => {
        if (disabled || busy || applying || !check.ok || applyTargets.length === 0) return;
        const values = check.values;
        setApplying(true);
        setApplyOutcomes({});
        const run = async () => {
          const outcomes = {};
          for (const row of applyTargets) {
            const key = rowKey(row);
            const gate = writeGate(row);
            if (!gate.ok) {
              outcomes[key] = 'skipped';
              setApplyOutcomes({ ...outcomes });
              continue;
            }
            let result;
            try {
              const accepted = await row.form.mutate(retryPolicyOps(row.settingsPath, values), gate.revision);
              result = accepted === true ? 'saved' : 'refused';
            } catch (error) {
              result = refusalKind(error);
            }
            outcomes[key] = result;
            setApplyOutcomes({ ...outcomes });
          }
          setApplying(false);
        };
        void run().catch(() => { setApplying(false); });
      };

      /* One shared "this card cannot be edited" note. */
      const retryStatusNote = status === 'loading'
        ? h('p', { className: 'dlct-note' }, t('status.loading'))
        : status === 'unavailable'
          ? h('p', { className: 'dlct-note' }, t('status.unavailable'))
          : !writable
            ? h('p', { className: 'dlct-note' }, t('status.readOnly'))
            : null;

      const providerNote = providers.status === 'loading'
        ? h('p', { className: 'dlct-note' }, t('providers.loading'))
        : providers.status === 'unavailable'
          ? h('p', { className: 'dlct-note' }, t('providers.unavailable'))
          : providers.status === 'error'
            ? h('p', { className: 'dlct-note' }, t('providers.error'))
            : providers.rows.length === 0
              ? h('p', { className: 'dlct-note' }, t('providers.empty'))
              : null;

      /* The global retry values are the comparison base for the listing rule
       * and for the unset-on-revert write: `normalizePolicy` of the plugin's own
       * section, so a leaf left unset compares as the value actually in force
       * (the documented code default). The validated draft is separately passed
       * to "Use defaults", which copies what the card currently shows. */
      const globalRetryValues = normalizePolicy(value);
      const defaultsValues = check.ok ? check.values : undefined;
      const routeStates = routeRows.map((row, index) => ({
        row,
        retryDeviates: routeRetryDeviates(
          pageState.routes[index] === undefined ? IDLE_SNAPSHOT : pageState.routes[index],
          row.settingsPath,
          globalRetryValues,
        ),
        timeoutsDeviate: routeTimeoutDeviates(
          pageState.routes[index] === undefined ? IDLE_SNAPSHOT : pageState.routes[index],
          row,
        ),
      }));
      const listedKeys = new Set();
      for (const entry of routeStates) {
        if (entry.retryDeviates || entry.timeoutsDeviate) listedKeys.add(rowKey(entry.row));
      }
      const visibleStates = routeStates.filter(entry => listedKeys.has(rowKey(entry.row))
        || pickedRoutes[rowKey(entry.row)] === true);
      const pickableRows = routeRows.filter(row => !listedKeys.has(rowKey(row))
        && pickedRoutes[rowKey(row)] !== true);
      const pickValue = pickableRows.some(row => rowKey(row) === pickRoute) ? pickRoute : '';

      /** Materialize one picked route's card in local state; write nothing. */
      const addRoute = () => {
        const row = pickableRows.find(candidate => rowKey(candidate) === pickValue);
        if (row === undefined) return;
        setPickedRoutes(current => ({ ...current, [rowKey(row)]: true }));
        setPickRoute('');
      };

      /* "Apply defaults to all" writes every eligible provider, and a route
       * that ends up equal to the global values is NOT listed (that is the
       * listing rule), so its per-card outcome would be invisible. The
       * section-level summary keeps every write's outcome on the page. */
      const applyOutcomeEntries = providers.status === 'ready'
        ? providers.rows
          .filter(row => applyOutcomes[rowKey(row)] !== undefined)
          .map(row => `${row.displayName}: ${t(`apply.outcome.${applyOutcomes[rowKey(row)]}`)}`)
        : [];

      /** Drop one route from the local picked set once its card settled. */
      const settleRoute = (row) => {
        const key = rowKey(row);
        setPickedRoutes((current) => {
          if (current[key] !== true) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      };

      return h('div', { className: 'dlct-page' },
        h('style', null, STYLE_TEXT),
        h('header', { className: 'dlct-header' },
          h('h2', { className: 'dlct-title' }, t('title')),
          h('p', { className: 'dlct-intro' }, t('intro')),
        ),
        h('section', { className: 'dlct-card' },
          h('header', { className: 'dlct-card-head' },
            h('h3', { className: 'dlct-card-title' }, t('global.heading')),
            h('p', { className: 'dlct-card-description' }, t('global.description')),
          ),
          retryStatusNote,
          h('div', { className: 'dlct-subgroup' },
            h('h4', { className: 'dlct-subgroup-title' }, t('global.retriesHeading')),
            h('p', { className: 'dlct-description' }, t('defaults.description')),
            h('div', { className: 'dlct-fields' },
              renderRetryFields({
                t,
                ids,
                draft,
                errors,
                disabled: disabled || busy,
                stage,
                showNormalFields: true,
              }),
            ),
          ),
          h('div', { className: 'dlct-subgroup' },
            h('h4', { className: 'dlct-subgroup-title' }, t('fetch.heading')),
            h('p', { className: 'dlct-description' }, t('fetch.description')),
            h('div', { className: 'dlct-fields' },
              renderFetchFields({
                t,
                ids: fetchIds,
                draft: fetchValues,
                errors: fetchErrors,
                disabled: disabled || busy,
                stage: stageFetch,
              }),
            ),
            h('div', { className: 'dlct-actions' },
              h('button', {
                type: 'button',
                className: 'dlct-button dlct-outline',
                disabled: disabled || busy,
                'aria-busy': pending === 'resetFetch' ? 'true' : undefined,
                onClick: resetFetch,
              }, pending === 'resetFetch' ? t('fetch.resetting') : t('fetch.reset')),
            ),
          ),
          h('div', { className: 'dlct-actions' },
            h('button', {
              type: 'button',
              className: 'dlct-button',
              disabled: disabled || busy || applying || !check.ok || !fetchCheck.ok,
              'aria-busy': pending === 'save' ? 'true' : undefined,
              onClick: saveGlobal,
            }, pending === 'save' ? t('global.saving') : t('global.save')),
            h('button', {
              type: 'button',
              className: 'dlct-button dlct-outline',
              disabled: disabled || busy || applying || !check.ok || applyTargets.length === 0,
              'aria-busy': applying ? 'true' : undefined,
              onClick: applyAll,
            }, applying ? t('defaults.applying') : t('defaults.applyAll')),
          ),
          h('div', null, outcomeNode(outcome, t, 'status.fetchReset')),
          h('p', { className: 'dlct-note' }, t('global.note')),
          h('p', { className: 'dlct-note' }, t('defaults.applyAllNote')),
        ),
        h('section', { className: 'dlct-card' },
          h('header', { className: 'dlct-card-head' },
            h('h3', { className: 'dlct-card-title' }, t('providers.heading')),
            h('p', { className: 'dlct-card-description' }, t('providers.description')),
          ),
          providerNote,
          applyOutcomeEntries.length === 0
            ? null
            : h('p', { className: 'dlct-outcome', role: 'status' }, applyOutcomeEntries.join(' \u00b7 ')),
          providers.status === 'ready' && routeRows.length > 0
            ? h('div', { className: 'dlct-picker' },
              h('div', { className: 'dlct-picker-field' },
                h('label', { className: 'dlct-field-label', htmlFor: pickerId }, t('routes.pickerLabel')),
                h('select', {
                  id: pickerId,
                  className: 'dlct-select',
                  disabled: pickableRows.length === 0,
                  value: pickValue,
                  onChange: event => setPickRoute(event.target.value),
                },
                  h('option', { value: '' }, t('routes.pickerPlaceholder')),
                  pickableRows.map(row => h('option', { key: rowKey(row), value: rowKey(row) }, `${row.displayName} (${row.provider})`)),
                ),
              ),
              h('button', {
                type: 'button',
                className: 'dlct-button',
                disabled: pickValue === '',
                onClick: addRoute,
              }, t('routes.add')),
            )
            : null,
          providers.status === 'ready' && pickableRows.length === 0 && routeRows.length > 0
            ? h('p', { className: 'dlct-note' }, t('routes.allListed'))
            : null,
          providers.status === 'ready' && routeRows.length > 0 && visibleStates.length === 0
            ? h('p', { className: 'dlct-empty' }, t('routes.empty'))
            : null,
          providers.status === 'ready'
            ? h('div', { className: 'dlct-providers' }, visibleStates.map(entry => h(RouteCard, {
                key: rowKey(entry.row),
                row: entry.row,
                t,
                form: entry.row.form,
                defaultsValues,
                globalRetryValues,
                bodyTimeoutMs: fetchValues.bodyTimeoutMs,
                onSettled: settleRoute,
              })))
            : null,
        ),
      );
    }

    /* ══ manual same-turn retry dock ═══════════════════════════════════════ */

    /**
     * Channel of the host's manual-retry web route (the plugin-owned
     * authenticated route that answers `state` and `decide`).
     */
    const MANUAL_RETRY_CHANNEL = '/llm-api-call-tuning';

    /** How often the dock asks the Host for a pending decision, in ms. */
    const MANUAL_RETRY_POLL_MS = 2000;

    /** The Host's per-turn manual-retry cap, mirrored for the `n/5` indicator. */
    const MANUAL_RETRY_MAX_ATTEMPTS = 5;

    /** Error code the Host returns when the offered decision is already gone. */
    const MANUAL_RETRY_STALE = 'manual-retry/stale';

    /**
     * Dock styles. The dock renders on the Conversation page, where the
     * settings page's `STYLE_TEXT` is not injected, so it carries its own rules
     * (the same theme variables and button conventions, one string because a
     * `<style>` child must be text).
     */
    const DOCK_STYLE_TEXT = [
      '.dlct-dock { display: flex; align-items: flex-start; gap: 10px; width: 100%; box-sizing: border-box; margin: 0 0 8px; padding: 8px 12px; border: 1px solid var(--border, #d8dde4); border-radius: 8px; background: var(--surface-sunken, #f4f6f9); }',
      '.dlct-dock-icon { flex: none; font-size: 15px; line-height: 20px; }',
      '.dlct-dock-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }',
      '.dlct-dock-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }',
      '.dlct-dock-title { font-weight: 600; }',
      '.dlct-dock-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }',
      '.dlct-dock-provider { font-size: 12px; color: var(--text-secondary, #5b6472); }',
      '.dlct-dock-attempt { font-size: 12px; color: var(--text-tertiary, #7a8493); }',
      '.dlct-dock-expired { font-size: 12px; color: var(--text-tertiary, #7a8493); }',
      '.dlct-dock-message { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; color: var(--text-secondary, #5b6472); }',
      '.dlct-dock-actions { flex: none; display: flex; gap: 6px; }',
      '.dlct-dock-button { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--accent, #2563eb); background: var(--accent, #2563eb); color: #fff; cursor: pointer; }',
      '.dlct-dock-button[disabled] { opacity: 0.55; cursor: default; }',
      '.dlct-dock-outline { background: transparent; color: var(--accent, #2563eb); }',
    ].join('\n');

    /**
     * Call one manual-retry endpoint, turning a synchronous throw into a
     * rejection so every caller only has to attach the two handlers.
     * @param call - the slot-injected route caller.
     * @param endpoint - `'state'` or `'decide'`.
     * @param payload - the endpoint payload.
     * @param signal - optional abort signal.
     * @returns a promise of the route result envelope.
     */
    function callManualRetry(call, endpoint, payload, signal) {
      try {
        return Promise.resolve(call(endpoint, payload, signal));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    /**
     * Read the pending manual-retry offer out of one `state` reply.
     *
     * The Host answers `{ok:true, value:{pending}}` on success and
     * `{ok:false, error}` on a refusal; anything else (including a transport
     * failure) is treated as "no offer", so the dock stays hidden rather than
     * showing a bar for a decision the Host no longer holds.
     * @param reply - the route result envelope.
     * @returns the pending decision object, or `null` when there is none.
     */
    function readManualRetryPending(reply) {
      if (reply === null || typeof reply !== 'object' || reply.ok !== true) return null;
      const value = reply.value;
      if (value === null || typeof value !== 'object') return null;
      const pending = value.pending;
      return pending !== null && typeof pending === 'object' ? pending : null;
    }

    /**
     * The 1-based attempt number shown for one offer. `attemptsLeft` counts the
     * manual retries still available on this turn, so the offered decision is
     * attempt `cap - attemptsLeft + 1` (with all five left, the first offer shows
     * `1/5`).
     * @param pending - the pending decision (`attemptsLeft` optional).
     * @returns the attempt number in `1..MANUAL_RETRY_MAX_ATTEMPTS`.
     */
    function manualRetryAttempt(pending) {
      const left = Number.isFinite(pending.attemptsLeft) ? pending.attemptsLeft : MANUAL_RETRY_MAX_ATTEMPTS;
      const remaining = Math.max(0, Math.min(MANUAL_RETRY_MAX_ATTEMPTS, left));
      return Math.min(MANUAL_RETRY_MAX_ATTEMPTS, MANUAL_RETRY_MAX_ATTEMPTS - remaining + 1);
    }

    /**
     * The manual same-turn retry bar above the composer.
     *
     * It renders ONLY while the Host reports a pending decision for this
     * session AND the session is running: the Host's waterfall is awaiting the
     * answer, so the turn is still open. Clicking Retry (or Dismiss) posts the
     * decision once; both buttons are disabled while that call is in flight,
     * and a stale/expired decision drops the bar silently. Polling stops on
     * unmount, on a session change, and as soon as the session stops running.
     * @param props - the session slot standard kit plus `{call}` from this
     *   plugin's registration.
     * @returns the alert row, or `null` when no decision is pending.
     */
    function ManualRetryDock(props) {
      const { sessionId, useSession, t, call } = props;
      const running = useSession(state => state.running);
      /** The last observed offer, tagged with the session it was fetched for. */
      const [offer, setOffer] = useState(null);
      /** Which decision is in flight, or `null` when both buttons are free. */
      const [busy, setBusy] = useState(null);

      useEffect(() => {
        // A session change invalidates every in-flight/awaited decision state.
        setBusy(null);
      }, [sessionId]);

      useEffect(() => {
        if (running !== true) {
          // Not running means no waterfall can be waiting: hide and stop.
          setOffer(null);
          return undefined;
        }
        const controller = new AbortController();
        let live = true;
        let timer;
        const poll = () => {
          callManualRetry(call, 'state', { sessionId }, controller.signal).then(
            reply => {
              if (!live) return;
              const pending = readManualRetryPending(reply);
              setOffer(pending === null ? null : { sessionId, pending, at: Date.now() });
              timer = setTimeout(poll, MANUAL_RETRY_POLL_MS);
            },
            () => {
              // A transient transport failure must not flicker the bar away:
              // keep the last known offer and ask again on the next tick.
              if (!live) return;
              timer = setTimeout(poll, MANUAL_RETRY_POLL_MS);
            },
          );
        };
        poll();
        return () => {
          live = false;
          if (timer !== undefined) clearTimeout(timer);
          controller.abort();
        };
      }, [call, running, sessionId]);

      const decide = useCallback(decision => {
        const current = offer !== null && offer.sessionId === sessionId ? offer.pending : null;
        if (current === null || busy !== null) return;
        setBusy(decision);
        callManualRetry(call, 'decide', { sessionId, nonce: current.nonce, decision }).then(
          reply => {
            setBusy(null);
            if (reply !== null && typeof reply === 'object' && reply.ok === true) {
              setOffer(null);
              return;
            }
            const error = reply !== null && typeof reply === 'object' ? reply.error : undefined;
            const code = error !== null && typeof error === 'object' ? error.code : undefined;
            // A decision the Host no longer holds (expired/timed out) or cannot
            // parse is terminal for this offer: drop the bar, do not retry it.
            if (code === MANUAL_RETRY_STALE || code === 'manual-retry/bad-request') setOffer(null);
          },
          () => { setBusy(null); },
        );
      }, [busy, call, offer, sessionId]);

      const current = offer !== null && offer.sessionId === sessionId ? offer : null;
      if (current === null || running !== true) return null;

      const pending = current.pending;
      const code = typeof pending.code === 'string' && pending.code.length > 0 ? pending.code : undefined;
      const provider = typeof pending.provider === 'string' && pending.provider.length > 0 ? pending.provider : undefined;
      const message = typeof pending.message === 'string' && pending.message.length > 0 ? pending.message : undefined;
      const expiresAt = Number.isFinite(pending.expiresAt) ? pending.expiresAt : undefined;
      const expired = expiresAt !== undefined && expiresAt <= current.at;
      const attempt = manualRetryAttempt(pending);
      const disabled = busy !== null;

      const actions = expired
        ? h('div', { className: 'dlct-dock-actions' },
            h('button', {
              type: 'button',
              className: 'dlct-dock-button dlct-dock-outline',
              disabled,
              onClick: () => decide('dismiss'),
            }, t('manualRetry.dismiss')),
          )
        : h('div', { className: 'dlct-dock-actions' },
            h('button', {
              type: 'button',
              className: 'dlct-dock-button',
              disabled,
              'aria-busy': busy === 'retry' ? 'true' : undefined,
              onClick: () => decide('retry'),
            }, t('manualRetry.retry')),
            h('button', {
              type: 'button',
              className: 'dlct-dock-button dlct-dock-outline',
              disabled,
              'aria-busy': busy === 'dismiss' ? 'true' : undefined,
              onClick: () => decide('dismiss'),
            }, t('manualRetry.dismiss')),
          );

      return h('div', {
        className: 'dlct-dock',
        role: 'alert',
        'aria-label': t('manualRetry.aria'),
      },
        h('style', { key: 'style' }, DOCK_STYLE_TEXT),
        h('span', { className: 'dlct-dock-icon', 'aria-hidden': 'true' }, '\u26A0'),
        h('div', { className: 'dlct-dock-body' },
          h('div', { className: 'dlct-dock-head' },
            h('strong', { className: 'dlct-dock-title' }, t('manualRetry.title')),
            code === undefined ? null : h('code', { className: 'dlct-dock-code' }, code),
            provider === undefined ? null : h('span', { className: 'dlct-dock-provider' }, provider),
            expired
              ? h('span', { className: 'dlct-dock-expired' }, t('manualRetry.expired'))
              : h('span', { className: 'dlct-dock-attempt' },
                  `${t('manualRetry.attempt')} ${attempt}/${MANUAL_RETRY_MAX_ATTEMPTS}`),
          ),
          message === undefined ? null : h('div', { className: 'dlct-dock-message' }, message),
        ),
        actions,
      );
    }

    /* ══ plugin registration ═══════════════════════════════════════════════ */

    const plugin = {
      name: 'dsh-llm-api-call-tuning',
      inject: ['slots', 'locale', 'configForms', 'remote', 'connection'],
      /**
       * Register the plugin dictionaries, the manual-retry dock, and the tuning
       * settings section. The provider directory is resolved lazily inside the
       * mounted page, so a composition without the Remote LLM namespace still
       * registers the page and degrades the provider list to a localized note.
       *
       * The dock is registered BEFORE the `configForms` guard below: it is a
       * Conversation-page contribution, independent of the settings page, and
       * must also work on a Host that serves no settings form for this row.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-llm-api-call-tuning: dictionaries');
        /**
         * One authenticated call on the plugin's manual-retry web route.
         * @param {string} endpoint - the route endpoint (`'state'` or `'decide'`).
         * @param {object} payload - the endpoint payload.
         * @param {AbortSignal} [signal] - cancels the request.
         * @returns {Promise<object>} the route result envelope.
         */
        const callHost = (endpoint, payload, signal) => {
          const connection = ctx.get('connection');
          if (connection === undefined) {
            return Promise.reject(new Error('llm-api-call-tuning: the connection service is unavailable'));
          }
          return connection.rpc.call(MANUAL_RETRY_CHANNEL, endpoint, payload, signal);
        };
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'manual-retry',
          order: 20,
          locale: NS,
          inject: () => ({ call: callHost }),
        }, ManualRetryDock));
        const forms = ctx.configForms;
        // `configForms` is an injected service, so a real composition without
        // it parks this fiber before `apply` runs (NIT-2 in the verification
        // report). This one-line guard is belt-and-braces for a direct
        // harness/composition that calls `apply` regardless; it keeps the page
        // (and nav row) hidden instead of throwing. `ConfigForms.get()` never
        // throws for an unserved namespace, so no deeper check is needed.
        if (forms === undefined || forms === null) return;
        const form = forms.get(NS);
        const t = ctx.locale.bind(NS);
        const getForm = ns => forms.get(ns);
        const readProviders = () => readProviderDirectory(ctx);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          // `label` is required: an omitted label renders an empty nav row.
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ form, t, getForm, readProviders }),
        }, TuningSection));
      },
    };

    return plugin;
  },
});
