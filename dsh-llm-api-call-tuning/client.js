/**
 * Client half of dsh-llm-api-call-tuning: one Settings page that (1) stores a
 * set of GLOBAL DEFAULT model-request retry values in this plugin's own
 * settings namespace and (2) lets the user inspect, edit, and reset the
 * `retryPolicy` of every active model provider route, writing DIRECTLY to the
 * provider's own settings namespace through `ctx.configForms.get(ns)`.
 *
 * The provider namespace map is read from the client Remote service
 * (`llm.listProviders()` joined with `llm.listConfigurableProviders()`), the
 * same join the Models page uses (`ui-settings-models/src/client/store.ts`),
 * so this page owns no copy of a provider's state: it paints the EFFECTIVE
 * value out of the provider form's snapshot and writes leaf-path operations
 * back through the same form. The global defaults row is a preset only —
 * nothing is projected from it onto a provider, and "Apply defaults to all"
 * copies it explicitly, one provider at a time.
 *
 * Every write is a list of LEAF path operations at the shared form's current
 * revision. A whole `retryPolicy` object is never set (that would materialize
 * schema defaults over a hand-written profile) and the whole `providers` dict
 * is never set (that would clobber sibling provider fields); `Reset` is the
 * single `unset` of `[...settingsPath, 'retryPolicy']`. `mode: 'always'`
 * additionally clears the two normal-mode-only leaves, because the upstream
 * union schema ignores them once the mode is `always`
 * (`packages/llm/llm/src/retry-policy.ts:105-112`).
 *
 * A third card owns the two PROCESS-WIDE HTTP timers the host settings schema
 * declares at the TOP LEVEL of this plugin's namespace (`headersTimeoutMs`,
 * `bodyTimeoutMs`), mirroring the `dsh-fetch-timeouts` plugin. Their tri-state
 * contract is what makes a fresh install behavior-neutral:
 * - an EMPTY field is the fresh-install state and writes the leaf as UNSET
 *   (`{op: 'unset', path: ['<key>']}`), so the host leaves the system default
 *   in place and this plugin installs no timeout of its own;
 * - `0` is an explicit "disable this timer" (undici treats a zero
 *   `headersTimeout`/`bodyTimeout` as disabled), visually distinct from empty;
 * - a positive integer is a custom limit in milliseconds, at most 2147483647.
 * Those leaves are written straight to this plugin's own namespace and are
 * deliberately NOT part of the retry defaults preset: `defaultsOps` and
 * `resetPolicyOps` stay retry-only, and "Apply defaults to all" never projects
 * a fetch timer onto a provider route. The card's own Reset is the same two
 * unsets, so it restores the system-default (fresh-install) state — never a
 * seeded 1800000 ms.
 *
 * The upstream schema does NOT enforce the cross-field rules the resolver
 * checks (`initialDelayMs <= maxDelayMs`, non-empty unique retryable codes),
 * so the draft is validated locally first and a row whose draft is invalid
 * cannot be submitted. `form.mutate(ops, revision)` resolves `false` on a
 * Host refusal (the controller then performs its own recovery read), and
 * rejects on a transport failure; both paths re-seed the row from whatever
 * the Host reports next. A superseded revision is retried at most once at the
 * freshly read revision.
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
     * The five stable transient failure codes the upstream schema allows
     * (`retry-policy.ts:18-24`); the code default retries all five.
     */
    const RETRYABLE_CODES = Object.freeze([
      'EMPTY_RESPONSE',
      'RATE_LIMIT',
      'SERVER',
      'TIMEOUT',
      'TRANSPORT',
    ]);

    /**
     * Upstream code defaults (`retry-policy.ts:14-24`), also what an
     * unconfigured provider route resolves to (`:151-158`). They are the
     * fallback the page shows when a namespace has not answered yet, and the
     * values "Reset" restores through the provider's own schema defaults.
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

    const en = {
      'nav': 'LLM API call tuning',
      'title': 'LLM API call tuning',
      'intro': 'Set one global default retry policy for this deployment, then inspect or override the retry policy of each active model provider; also set the process-wide HTTP fetch timeouts shared by every provider. Provider rows write straight to the provider\u2019s own settings namespace.',
      'defaults.heading': 'Global defaults',
      'defaults.description': 'A preset for the provider controls below and for "Apply defaults to all". The values are stored in this plugin\u2019s own settings namespace; a provider keeps using its own policy until one is written to it.',
      'defaults.note': 'Saving these defaults changes no provider. Use "Apply defaults to all active providers" or a row\u2019s "Use defaults" button to copy them.',
      'defaults.save': 'Save defaults',
      'defaults.saving': 'Saving defaults\u2026',
      'defaults.applyAll': 'Apply defaults to all active providers',
      'defaults.applying': 'Applying defaults\u2026',
      'defaults.applyAllNote': 'Writes the validated defaults to every active provider, one provider at a time. A provider that refuses the write keeps its current policy.',
      'providers.heading': 'Provider retry policies',
      'providers.description': 'Only provider routes active in this deployment are editable. The shown values are the effective values of the provider\u2019s namespace; the badge marks whether the user layer stores a retryPolicy override. Saving writes only the retry-policy fields shown here.',
      'providers.loading': 'Loading the provider directory\u2026',
      'providers.unavailable': 'This deployment does not expose the LLM provider directory, so no provider row can be listed.',
      'providers.error': 'The provider directory could not be loaded.',
      'providers.empty': 'No model provider is declared in this deployment.',
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
      'provider.alwaysNote': 'Always mode retries every model-request failure and ignores the retry limit and the retryable codes; saving clears both.',
      'fetch.heading': 'Fetch timeouts',
      'fetch.description': 'Process-wide HTTP timer limits, applied by the host to the fetch dispatcher that every provider, web search, and HTTP MCP server shares. Leave a field empty to keep the system default; 0 disables that timer; a positive value is the limit in milliseconds.',
      'fetch.note': 'An empty field writes nothing: the host leaves the process-wide system default in place, so a fresh install behaves exactly as if this plugin were absent. Saving writes only these two leaves; they are not provider retry settings, so "Apply defaults to all" never copies them onto a provider route.',
      'fetch.save': 'Save timeouts',
      'fetch.saving': 'Saving timeouts\u2026',
      'fetch.reset': 'Reset to system defaults',
      'fetch.resetting': 'Resetting\u2026',
      'fetch.placeholder': 'system default (leave empty)',
      'fetch.hint': 'empty = system default (leave empty); 0 = disabled; 1800000 ms = 30 min',
      'fetch.status.loading': 'Loading the fetch timeouts\u2026',
      'fetch.status.unavailable': 'This deployment does not serve the llm-api-call-tuning settings namespace, so the fetch timeouts cannot be edited here.',
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
      'field.retryableCodes.description': 'Stable transient failure codes that normal mode retries. At least one code must stay selected.',
      'field.retryableCodes.unit': 'at least one code',
      'field.retryableCodes.default': 'code default all five codes',
      'field.headersTimeoutMs.label': 'Response headers timeout',
      'field.headersTimeoutMs.description': 'Time allowed before response headers arrive. Empty keeps the system default; 0 disables the timer.',
      'field.headersTimeoutMs.unit': 'milliseconds, empty or 0 to 2147483647',
      'field.bodyTimeoutMs.label': 'Response body timeout',
      'field.bodyTimeoutMs.description': 'Time allowed between response body chunks. Empty keeps the system default; 0 disables the timer.',
      'field.bodyTimeoutMs.unit': 'milliseconds, empty or 0 to 2147483647',
      'mode.normal': 'Normal \u2014 selected codes',
      'mode.always': 'Always \u2014 every failure',
      'code.EMPTY_RESPONSE': 'Empty response',
      'code.RATE_LIMIT': 'Rate limit',
      'code.SERVER': 'Server error',
      'code.TIMEOUT': 'Timeout',
      'code.TRANSPORT': 'Transport error',
      'status.loading': 'Loading the retry defaults\u2026',
      'status.unavailable': 'This deployment does not serve the llm-api-call-tuning settings namespace, so the defaults cannot be edited here.',
      'status.readOnly': 'These values are read-only in this deployment.',
      'status.saved': 'Saved.',
      'status.reset': 'Reset. This provider no longer stores a retryPolicy override.',
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
      'apply.outcome.saved': 'Applied',
      'apply.outcome.refused': 'Refused',
      'apply.outcome.managed': 'Managed elsewhere',
    };

    const zh = {
      'nav': 'LLM \u8c03\u7528\u8c03\u4f18',
      'title': 'LLM \u8c03\u7528\u8c03\u4f18',
      'intro': '\u5728\u6b64\u5904\u8bbe\u7f6e\u4e00\u5957\u5168\u5c40\u9ed8\u8ba4\u91cd\u8bd5\u7b56\u7565\uff0c\u5e76\u53ef\u67e5\u770b\u6216\u8986\u76d6\u6bcf\u4e2a\u542f\u7528\u4e2d\u7684\u6a21\u578b\u63d0\u4f9b\u65b9\u91cd\u8bd5\u7b56\u7565\uff0c\u8fd8\u53ef\u8bbe\u7f6e\u6240\u6709\u63d0\u4f9b\u65b9\u5171\u7528\u7684\u8fdb\u7a0b\u7ea7 HTTP \u6293\u53d6\u8d85\u65f6\u3002\u63d0\u4f9b\u65b9\u884c\u4f1a\u76f4\u63a5\u5199\u5165\u8be5\u63d0\u4f9b\u65b9\u81ea\u5df1\u7684\u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\u3002',
      'defaults.heading': '\u5168\u5c40\u9ed8\u8ba4\u503c',
      'defaults.description': '\u4f5c\u4e3a\u4e0b\u65b9\u5404\u63d0\u4f9b\u65b9\u63a7\u4ef6\u4ee5\u53ca\u201c\u5e94\u7528\u9ed8\u8ba4\u503c\u5230\u5168\u90e8\u63d0\u4f9b\u65b9\u201d\u7684\u9884\u8bbe\u3002\u8fd9\u4e9b\u503c\u4fdd\u5b58\u5728\u672c\u63d2\u4ef6\u81ea\u5df1\u7684\u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\u4e2d\uff1b\u5728\u5411\u67d0\u4e2a\u63d0\u4f9b\u65b9\u5199\u5165\u4e4b\u524d\uff0c\u5b83\u4ecd\u4f7f\u7528\u81ea\u5df1\u7684\u7b56\u7565\u3002',
      'defaults.note': '\u4fdd\u5b58\u8fd9\u4e9b\u9ed8\u8ba4\u503c\u4e0d\u4f1a\u6539\u53d8\u4efb\u4f55\u63d0\u4f9b\u65b9\u3002\u8bf7\u4f7f\u7528\u201c\u5e94\u7528\u9ed8\u8ba4\u503c\u5230\u5168\u90e8\u542f\u7528\u4e2d\u7684\u63d0\u4f9b\u65b9\u201d\u6216\u67d0\u4e00\u884c\u7684\u201c\u4f7f\u7528\u9ed8\u8ba4\u503c\u201d\u6309\u94ae\u6765\u62f7\u8d1d\u5b83\u4eec\u3002',
      'defaults.save': '\u4fdd\u5b58\u9ed8\u8ba4\u503c',
      'defaults.saving': '\u6b63\u5728\u4fdd\u5b58\u9ed8\u8ba4\u503c\u2026',
      'defaults.applyAll': '\u5e94\u7528\u9ed8\u8ba4\u503c\u5230\u5168\u90e8\u542f\u7528\u4e2d\u7684\u63d0\u4f9b\u65b9',
      'defaults.applying': '\u6b63\u5728\u5e94\u7528\u9ed8\u8ba4\u503c\u2026',
      'defaults.applyAllNote': '\u6309\u987a\u5e8f\u5c06\u6821\u9a8c\u901a\u8fc7\u7684\u9ed8\u8ba4\u503c\u5199\u5165\u6bcf\u4e2a\u542f\u7528\u4e2d\u7684\u63d0\u4f9b\u65b9\uff0c\u4e00\u6b21\u4e00\u4e2a\u3002\u62d2\u7edd\u5199\u5165\u7684\u63d0\u4f9b\u65b9\u4fdd\u6301\u5f53\u524d\u7b56\u7565\u3002',
      'providers.heading': '\u5404\u63d0\u4f9b\u65b9\u91cd\u8bd5\u7b56\u7565',
      'providers.description': '\u4ec5\u5f53\u524d\u90e8\u7f72\u4e2d\u542f\u7528\u7684\u63d0\u4f9b\u65b9\u8def\u7531\u53ef\u7f16\u8f91\u3002\u6240\u663e\u793a\u7684\u662f\u8be5\u63d0\u4f9b\u65b9\u547d\u540d\u7a7a\u95f4\u7684\u751f\u6548\u503c\uff1b\u5fbd\u6807\u6807\u660e\u7528\u6237\u5c42\u662f\u5426\u4fdd\u5b58\u4e86 retryPolicy \u8986\u76d6\u3002\u4fdd\u5b58\u53ea\u5199\u5165\u6b64\u5904\u663e\u793a\u7684\u91cd\u8bd5\u7b56\u7565\u5b57\u6bb5\u3002',
      'providers.loading': '\u6b63\u5728\u52a0\u8f7d\u63d0\u4f9b\u65b9\u76ee\u5f55\u2026',
      'providers.unavailable': '\u5f53\u524d\u90e8\u7f72\u672a\u66b4\u9732 LLM \u63d0\u4f9b\u65b9\u76ee\u5f55\uff0c\u56e0\u6b64\u65e0\u6cd5\u5217\u51fa\u63d0\u4f9b\u65b9\u884c\u3002',
      'providers.error': '\u63d0\u4f9b\u65b9\u76ee\u5f55\u52a0\u8f7d\u5931\u8d25\u3002',
      'providers.empty': '\u5f53\u524d\u90e8\u7f72\u4e2d\u6ca1\u6709\u58f0\u660e\u4efb\u4f55\u6a21\u578b\u63d0\u4f9b\u65b9\u3002',
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
      'provider.alwaysNote': '\u201c\u603b\u662f\u201d\u6a21\u5f0f\u4f1a\u91cd\u8bd5\u6bcf\u6b21\u6a21\u578b\u8bf7\u6c42\u5931\u8d25\uff0c\u5ffd\u7565\u91cd\u8bd5\u4e0a\u9650\u4e0e\u53ef\u91cd\u8bd5\u9519\u8bef\u7801\uff1b\u4fdd\u5b58\u65f6\u4f1a\u6e05\u9664\u8fd9\u4e24\u9879\u3002',
      'fetch.heading': '\u6293\u53d6\u8d85\u65f6',
      'fetch.description': '\u8fdb\u7a0b\u7ea7\u7684 HTTP \u8ba1\u65f6\u4e0a\u9650\uff0c\u7531\u5bbf\u4e3b\u5e94\u7528\u5230\u6240\u6709\u63d0\u4f9b\u65b9\u3001\u8054\u7f51\u641c\u7d22\u4e0e HTTP MCP \u670d\u52a1\u5668\u5171\u7528\u7684 fetch \u8c03\u5ea6\u5668\u4e0a\u3002\u7559\u7a7a\u8868\u793a\u4fdd\u6301\u7cfb\u7edf\u9ed8\u8ba4\uff1b0 \u8868\u793a\u7981\u7528\u8be5\u8ba1\u65f6\u5668\uff1b\u6b63\u6570\u8868\u793a\u4ee5\u6beb\u79d2\u4e3a\u5355\u4f4d\u7684\u65f6\u957f\u3002',
      'fetch.note': '\u7559\u7a7a\u5b57\u6bb5\u4e0d\u4f1a\u5199\u5165\u4efb\u4f55\u503c\uff1a\u5bbf\u4e3b\u4fdd\u6301\u8fdb\u7a0b\u7ea7\u7684\u7cfb\u7edf\u9ed8\u8ba4\uff0c\u56e0\u6b64\u5168\u65b0\u5b89\u88c5\u7684\u884c\u4e3a\u4e0e\u672a\u5b89\u88c5\u672c\u63d2\u4ef6\u65f6\u5b8c\u5168\u4e00\u81f4\u3002\u4fdd\u5b58\u53ea\u5199\u5165\u8fd9\u4e24\u4e2a\u5b57\u6bb5\uff1b\u5b83\u4eec\u4e0d\u662f\u63d0\u4f9b\u65b9\u7684\u91cd\u8bd5\u8bbe\u7f6e\uff0c\u6240\u4ee5\u201c\u5e94\u7528\u9ed8\u8ba4\u503c\u5230\u5168\u90e8\u63d0\u4f9b\u65b9\u201d\u4e0d\u4f1a\u628a\u5b83\u4eec\u590d\u5236\u5230\u4efb\u4f55\u63d0\u4f9b\u65b9\u8def\u7531\u4e0a\u3002',
      'fetch.save': '\u4fdd\u5b58\u8d85\u65f6\u8bbe\u7f6e',
      'fetch.saving': '\u6b63\u5728\u4fdd\u5b58\u8d85\u65f6\u8bbe\u7f6e\u2026',
      'fetch.reset': '\u6062\u590d\u7cfb\u7edf\u9ed8\u8ba4',
      'fetch.resetting': '\u6b63\u5728\u6062\u590d\u2026',
      'fetch.placeholder': '\u7cfb\u7edf\u9ed8\u8ba4\uff08\u7559\u7a7a\uff09',
      'fetch.hint': '\u7559\u7a7a = \u7cfb\u7edf\u9ed8\u8ba4\uff08\u4fdd\u6301\u7559\u7a7a\uff09\uff1b0 = \u7981\u7528\uff1b1800000 \u6beb\u79d2 = 30 \u5206\u949f',
      'fetch.status.loading': '\u6b63\u5728\u52a0\u8f7d\u6293\u53d6\u8d85\u65f6\u8bbe\u7f6e\u2026',
      'fetch.status.unavailable': '\u5f53\u524d\u90e8\u7f72\u672a\u63d0\u4f9b llm-api-call-tuning \u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\uff0c\u65e0\u6cd5\u5728\u6b64\u7f16\u8f91\u6293\u53d6\u8d85\u65f6\u3002',
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
      'field.retryableCodes.description': '\u201c\u666e\u901a\u201d\u6a21\u5f0f\u4e0b\u4f1a\u91cd\u8bd5\u7684\u7a33\u5b9a\u4e34\u65f6\u9519\u8bef\u7801\u3002\u81f3\u5c11\u9700\u4fdd\u7559\u4e00\u9879\u3002',
      'field.retryableCodes.unit': '\u81f3\u5c11\u4e00\u4e2a\u9519\u8bef\u7801',
      'field.retryableCodes.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c\uff1a\u5168\u90e8\u4e94\u4e2a\u9519\u8bef\u7801',
      'field.headersTimeoutMs.label': '\u54cd\u5e94\u5934\u8d85\u65f6',
      'field.headersTimeoutMs.description': '\u7b49\u5f85\u54cd\u5e94\u5934\u8fd4\u56de\u7684\u6700\u957f\u65f6\u95f4\u3002\u7559\u7a7a\u8868\u793a\u4fdd\u6301\u7cfb\u7edf\u9ed8\u8ba4\uff1b0 \u8868\u793a\u7981\u7528\u8be5\u8ba1\u65f6\u5668\u3002',
      'field.headersTimeoutMs.unit': '\u6beb\u79d2\uff0c\u7559\u7a7a\u6216 0 \u5230 2147483647',
      'field.bodyTimeoutMs.label': '\u54cd\u5e94\u6b63\u6587\u8d85\u65f6',
      'field.bodyTimeoutMs.description': '\u54cd\u5e94\u6b63\u6587\u5404\u6570\u636e\u5757\u4e4b\u95f4\u5141\u8bb8\u7684\u6700\u957f\u95f4\u9694\u3002\u7559\u7a7a\u8868\u793a\u4fdd\u6301\u7cfb\u7edf\u9ed8\u8ba4\uff1b0 \u8868\u793a\u7981\u7528\u8be5\u8ba1\u65f6\u5668\u3002',
      'field.bodyTimeoutMs.unit': '\u6beb\u79d2\uff0c\u7559\u7a7a\u6216 0 \u5230 2147483647',
      'mode.normal': '\u666e\u901a \u2014 \u6240\u9009\u9519\u8bef\u7801',
      'mode.always': '\u603b\u662f \u2014 \u6bcf\u6b21\u5931\u8d25',
      'code.EMPTY_RESPONSE': '\u7a7a\u54cd\u5e94',
      'code.RATE_LIMIT': '\u9650\u6d41',
      'code.SERVER': '\u670d\u52a1\u5668\u9519\u8bef',
      'code.TIMEOUT': '\u8d85\u65f6',
      'code.TRANSPORT': '\u4f20\u8f93\u9519\u8bef',
      'status.loading': '\u6b63\u5728\u52a0\u8f7d\u91cd\u8bd5\u9ed8\u8ba4\u503c\u2026',
      'status.unavailable': '\u5f53\u524d\u90e8\u7f72\u672a\u63d0\u4f9b llm-api-call-tuning \u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\uff0c\u65e0\u6cd5\u5728\u6b64\u7f16\u8f91\u9ed8\u8ba4\u503c\u3002',
      'status.readOnly': '\u5f53\u524d\u90e8\u7f72\u4e2d\u8fd9\u4e9b\u503c\u4e3a\u53ea\u8bfb\u3002',
      'status.saved': '\u5df2\u4fdd\u5b58\u3002',
      'status.reset': '\u5df2\u91cd\u7f6e\u3002\u8be5\u63d0\u4f9b\u65b9\u4e0d\u518d\u4fdd\u5b58 retryPolicy \u8986\u76d6\u3002',
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
      'apply.outcome.saved': '\u5df2\u5e94\u7528',
      'apply.outcome.refused': '\u88ab\u62d2\u7edd',
      'apply.outcome.managed': '\u7531\u5176\u4ed6\u4f4d\u7f6e\u7ba1\u7406',
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
     * Normalize an allowlisted retryable-code list: known codes only, no
     * duplicates, declared order. An absent or unusable stored list falls back
     * to all five codes, which is the upstream default and the only shape the
     * page itself ever writes.
     * @param raw - the stored value (schema-resolved or user layer).
     * @returns a non-empty array of known codes.
     */
    function normalizeCodes(raw) {
      if (!Array.isArray(raw)) return [...RETRYABLE_CODES];
      const known = raw.filter(code => typeof code === 'string' && RETRYABLE_CODES.indexOf(code) >= 0);
      const unique = RETRYABLE_CODES.filter(code => known.indexOf(code) >= 0);
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
          || unique.some(code => RETRYABLE_CODES.indexOf(code) < 0)) {
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
          h('div', { className: 'dlct-code-list' }, RETRYABLE_CODES.map(code => h('label', { className: 'dlct-code', key: code },
            h('input', {
              type: 'checkbox',
              checked: selected.indexOf(code) >= 0,
              disabled,
              onChange: (event) => {
                const next = new Set(selected);
                if (event.target.checked === true) next.add(code);
                else next.delete(code);
                stage('retryableCodes', RETRYABLE_CODES.filter(known => next.has(known)));
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
     * The two process-wide fetch-timer controls of the third card. A plain
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
     * One provider row: its live snapshot, its draft, and its three actions.
     * The row subscribes to the provider's own shared config form, so a write
     * from anywhere re-seeds it from the next Host answer.
     * @param props - slot props plus the joined row, its form, the validated
     *   defaults, and the last "Apply defaults to all" outcome for this row.
     * @returns the row tree.
     */
    function ProviderRow(props) {
      const { row, t, form, defaultsValues, applyOutcome } = props;
      const store = form === undefined ? IDLE_FORM : form;
      const subscribe = useCallback(listener => store.subscribe(listener), [store]);
      const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
      const snapshot = useSyncExternalStore(subscribe, getSnapshot);

      const ids = {};
      for (const field of RETRY_FIELDS) ids[field.key] = useId();

      const [edits, setEdits] = useState({});
      /* Which action is crossing the wire, so Save and Reset can each show
       * their own in-flight copy (null while idle). */
      const [pending, setPending] = useState(null);
      const [outcome, setOutcome] = useState(null);
      const pendingRef = useRef(false);
      const saving = pending !== null;

      const editable = row.active && row.settingsNs !== '' && form !== undefined;
      const status = snapshot !== null && snapshot !== undefined && typeof snapshot.status === 'string'
        ? snapshot.status
        : 'loading';
      const ready = editable && status === 'ready';
      const writable = ready && snapshot.writable !== false;
      // Actions use the SAME gate as "Apply defaults to all": ready, writable,
      // and a numeric revision, so this page never sends an unconditional
      // write either (see `writeGate`).
      const disabled = !writeGate(row, snapshot, form).ok;
      const value = snapshot === null || snapshot === undefined ? undefined : snapshot.value;

      const policyRaw = ready ? getAt(value, [...row.settingsPath, 'retryPolicy']) : undefined;
      const override = ready ? userHasOverride(snapshot.user, row.settingsPath) : false;
      const seedKey = ready ? `${String(snapshot.revision)}|${JSON.stringify(policyRaw === undefined ? null : policyRaw)}` : '';
      const baseline = retryDraft(policyRaw);
      const draft = {};
      for (const field of RETRY_FIELDS) {
        const edit = edits[field.key];
        draft[field.key] = edit !== undefined && edit.seedKey === seedKey ? edit.value : baseline[field.key];
      }
      const check = validateDraft(draft, false);
      const errors = check.ok ? {} : check.errors;

      /** Stage one control value against the snapshot currently shown. */
      const stage = (key, next) => {
        setEdits(current => ({ ...current, [key]: { value: next, seedKey } }));
        setOutcome(null);
      };

      /** Write this row's retry policy as leaf ops. */
      const save = () => {
        if (disabled || saving || pendingRef.current || !check.ok) return;
        pendingRef.current = true;
        setPending('save');
        setOutcome(null);
        submitOps(form, retryPolicyOps(row.settingsPath, check.values)).then((result) => {
          pendingRef.current = false;
          setPending(null);
          setEdits({});
          setOutcome(result);
        });
      };

      /** Clear this row's retryPolicy so the namespace defaults apply again. */
      const reset = () => {
        if (disabled || saving || pendingRef.current) return;
        pendingRef.current = true;
        setPending('reset');
        setOutcome(null);
        submitOps(form, resetPolicyOps(row.settingsPath)).then((result) => {
          pendingRef.current = false;
          setPending(null);
          setEdits({});
          setOutcome(result.kind === 'saved' ? { kind: 'reset' } : result);
        });
      };

      /** Copy the validated defaults card into this draft (nothing written yet). */
      const useDefaults = () => {
        if (disabled || saving || defaultsValues === undefined) return;
        const next = {};
        for (const field of RETRY_FIELDS) {
          next[field.key] = { value: draftValueFromValues(field.key, defaultsValues), seedKey };
        }
        setEdits(next);
        setOutcome(null);
      };

      const namespaceText = [row.settingsNs, ...row.settingsPath].filter(part => part !== '').join(' \u203a ');
      const badge = editable
        ? h('span', {
            className: `dlct-badge ${override ? 'dlct-badge-override' : 'dlct-badge-default'}`,
          }, t(override ? 'provider.source.override' : 'provider.source.default'))
        : null;

      const rowBody = [];
      if (!row.active) {
        rowBody.push(h('p', { className: 'dlct-note', key: 'dormant' }, t('provider.status.dormant')));
      } else if (row.settingsNs === '') {
        rowBody.push(h('p', { className: 'dlct-note', key: 'no-settings' }, t('provider.status.noSettings')));
      } else if (form === undefined) {
        rowBody.push(h('p', { className: 'dlct-note', key: 'no-form' }, t('provider.status.unavailable')));
      } else if (status === 'loading') {
        rowBody.push(h('p', { className: 'dlct-note', key: 'loading' }, t('status.loading')));
      } else if (status === 'unavailable') {
        rowBody.push(h('p', { className: 'dlct-note', key: 'unavailable' }, t('provider.status.unavailable')));
      } else if (!writable) {
        rowBody.push(h('p', { className: 'dlct-note', key: 'read-only' }, t('status.readOnly')));
      } else {
        rowBody.push(h('div', { className: 'dlct-fields', key: 'fields' },
          renderRetryFields({
            t,
            ids,
            draft,
            errors,
            disabled: disabled || saving,
            stage,
            showNormalFields: draft.mode !== 'always',
          }),
        ));
        if (draft.mode === 'always') {
          rowBody.push(h('p', { className: 'dlct-note', key: 'always' }, t('provider.alwaysNote')));
        }
        rowBody.push(h('div', { className: 'dlct-actions', key: 'actions' },
          h('button', {
            type: 'button',
            className: 'dlct-button',
            disabled: disabled || saving || !check.ok,
            'aria-busy': pending === 'save' ? 'true' : undefined,
            onClick: save,
          }, pending === 'save' ? t('provider.saving') : t('provider.save')),
          h('button', {
            type: 'button',
            className: 'dlct-button dlct-outline',
            disabled: disabled || saving,
            'aria-busy': pending === 'reset' ? 'true' : undefined,
            onClick: reset,
          }, pending === 'reset' ? t('provider.resetting') : t('provider.reset')),
          h('button', {
            type: 'button',
            className: 'dlct-button dlct-outline',
            disabled: disabled || saving || defaultsValues === undefined,
            onClick: useDefaults,
          }, t('provider.useDefaults')),
        ));
        rowBody.push(h('div', { key: 'outcome' }, outcomeNode(outcome, t)));
      }

      /* A skipped row shows no extra badge: its body already states why (the
       * loading / unavailable / read-only note), and the inline en/zh
       * dictionaries own one key set only, so no third copy is invented. The
       * outcome itself is recorded in the page's `applyOutcomes` state. */
      if (applyOutcome !== undefined && applyOutcome !== 'skipped') {
        rowBody.push(h('span', { className: 'dlct-outcome', key: 'apply-outcome' }, `${t('defaults.heading')}: ${t(`apply.outcome.${applyOutcome}`)}`));
      }

      return h('section', { className: 'dlct-provider' },
        h('header', { className: 'dlct-provider-head' },
          h('h4', { className: 'dlct-provider-name' }, row.displayName, badge),
          h('p', { className: 'dlct-provider-meta' },
            h('code', { className: 'dlct-route' }, row.provider),
            namespaceText === ''
              ? null
              : h('span', { className: 'dlct-namespace' }, `${t('provider.namespace')}: ${namespaceText}`),
          ),
        ),
        rowBody,
      );
    }

    /**
     * The "LLM API call tuning" settings page, three cards in order: the global
     * retry defaults, one editable row per active provider route, and the
     * process-wide fetch timers.
     * @param props - slot props.
     * @param props.form - shared config form for this plugin's own namespace.
     * @param props.t - localized copy for this plugin's namespace.
     * @param props.getForm - namespace -> shared config form (provider rows).
     * @param props.readProviders - provider directory reader (Remote `llm`).
     * @returns the section tree.
     */
    function TuningSection(props) {
      const { form, t, getForm, readProviders } = props;
      // The controller's methods need their receiver, and uSES resubscribes
      // whenever `subscribe` identity changes, so both seats are memoized to
      // one stable pair per form rather than handing uSES the bare methods.
      const subscribe = useCallback(listener => form.subscribe(listener), [form]);
      const getSnapshot = useCallback(() => form.getSnapshot(), [form]);
      const snapshot = useSyncExternalStore(subscribe, getSnapshot);

      const ids = {};
      for (const field of RETRY_FIELDS) ids[field.key] = useId();
      /* A second id block for the fetch card. `FETCH_FIELDS` is frozen, so the
       * hook count of this component stays constant across renders. */
      const fetchIds = {};
      for (const field of FETCH_FIELDS) fetchIds[field.key] = useId();

      const [edits, setEdits] = useState({});
      const [saving, setSaving] = useState(false);
      const [outcome, setOutcome] = useState(null);
      const pendingRef = useRef(false);
      /* The fetch card keeps its own draft/outcome/pending slots: it writes two
       * flat leaves of the SAME own-namespace form, but it is not part of the
       * retry defaults draft, so sharing either state would let one card clear
       * the other's staged edits. */
      const [fetchEdits, setFetchEdits] = useState({});
      const [fetchPending, setFetchPending] = useState(null);
      const [fetchOutcome, setFetchOutcome] = useState(null);
      const fetchPendingRef = useRef(false);
      const [providers, setProviders] = useState({ status: 'loading', rows: [] });
      const [applying, setApplying] = useState(false);
      const [applyOutcomes, setApplyOutcomes] = useState({});

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

      /* The fetch card reads the SAME own-namespace snapshot, but its baseline
       * is the two flat top-level leaves rather than the retry defaults, and a
       * staged edit obeys the same re-seed rule. Keeping the two drafts apart
       * means one card's Save can never clear the other card's staged edit. */
      const fetchBaseline = fetchDraft(value);
      const fetchValues = {};
      for (const field of FETCH_FIELDS) {
        const edit = fetchEdits[field.key];
        fetchValues[field.key] = edit !== undefined && edit.seedKey === seedKey ? edit.value : fetchBaseline[field.key];
      }
      const fetchCheck = validateFetchDraft(fetchValues);
      const fetchErrors = fetchCheck.ok ? {} : fetchCheck.errors;
      const fetchBusy = fetchPending !== null;

      const stageFetch = (key, next) => {
        setFetchEdits(current => ({ ...current, [key]: { value: next, seedKey } }));
        setFetchOutcome(null);
      };

      /** Persist the six defaults as leaf ops on this plugin's own namespace. */
      const saveDefaults = () => {
        if (disabled || saving || pendingRef.current || !check.ok) return;
        pendingRef.current = true;
        setSaving(true);
        setOutcome(null);
        submitOps(form, defaultsOps(check.values)).then((result) => {
          pendingRef.current = false;
          setSaving(false);
          setEdits({});
          setOutcome(result);
        });
      };

      /**
       * Persist the two fetch timers as FLAT leaf ops on this plugin's own
       * namespace. An EMPTY field emits `unset`, so the system default is
       * restored/kept; a value emits `set`. Not a retry defaults write: no
       * provider is touched.
       */
      const saveFetch = () => {
        if (disabled || saving || fetchPendingRef.current || !fetchCheck.ok) return;
        fetchPendingRef.current = true;
        setFetchPending('save');
        setFetchOutcome(null);
        submitOps(form, fetchOps(fetchCheck.values)).then((result) => {
          fetchPendingRef.current = false;
          setFetchPending(null);
          setFetchEdits({});
          setFetchOutcome(result);
        });
      };

      /** Clear both timer leaves so the system (fresh-install) defaults apply again. */
      const resetFetch = () => {
        if (disabled || saving || fetchPendingRef.current) return;
        fetchPendingRef.current = true;
        setFetchPending('reset');
        setFetchOutcome(null);
        submitOps(form, fetchResetOps()).then((result) => {
          fetchPendingRef.current = false;
          setFetchPending(null);
          setFetchEdits({});
          setFetchOutcome(result.kind === 'saved' ? { kind: 'reset' } : result);
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
        if (disabled || saving || applying || !check.ok || applyTargets.length === 0) return;
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

      /* One shared "this card cannot be edited" note. The `status.*` copy names
       * the retry defaults, so the fetch card passes its own noun keys
       * (`fetch.status.*`) instead of reusing that text. */
      const statusNote = (loadingKey, unavailableKey) => status === 'loading'
        ? h('p', { className: 'dlct-note' }, t(loadingKey))
        : status === 'unavailable'
          ? h('p', { className: 'dlct-note' }, t(unavailableKey))
          : !writable
            ? h('p', { className: 'dlct-note' }, t('status.readOnly'))
            : null;
      const retryStatusNote = statusNote('status.loading', 'status.unavailable');
      const fetchStatusNote = statusNote('fetch.status.loading', 'fetch.status.unavailable');

      const providerNote = providers.status === 'loading'
        ? h('p', { className: 'dlct-note' }, t('providers.loading'))
        : providers.status === 'unavailable'
          ? h('p', { className: 'dlct-note' }, t('providers.unavailable'))
          : providers.status === 'error'
            ? h('p', { className: 'dlct-note' }, t('providers.error'))
            : providers.rows.length === 0
              ? h('p', { className: 'dlct-note' }, t('providers.empty'))
              : null;

      return h('div', { className: 'dlct-page' },
        h('style', null, STYLE_TEXT),
        h('header', { className: 'dlct-header' },
          h('h2', { className: 'dlct-title' }, t('title')),
          h('p', { className: 'dlct-intro' }, t('intro')),
        ),
        h('section', { className: 'dlct-card' },
          h('header', { className: 'dlct-card-head' },
            h('h3', { className: 'dlct-card-title' }, t('defaults.heading')),
            h('p', { className: 'dlct-card-description' }, t('defaults.description')),
          ),
          retryStatusNote,
          h('div', { className: 'dlct-fields' },
            renderRetryFields({
              t,
              ids,
              draft,
              errors,
              disabled: disabled || saving,
              stage,
              showNormalFields: true,
            }),
          ),
          h('div', { className: 'dlct-actions' },
            h('button', {
              type: 'button',
              className: 'dlct-button',
              disabled: disabled || saving || applying || fetchBusy || !check.ok,
              'aria-busy': saving ? 'true' : undefined,
              onClick: saveDefaults,
            }, saving ? t('defaults.saving') : t('defaults.save')),
            h('button', {
              type: 'button',
              className: 'dlct-button dlct-outline',
              disabled: disabled || saving || applying || fetchBusy || !check.ok || applyTargets.length === 0,
              'aria-busy': applying ? 'true' : undefined,
              onClick: applyAll,
            }, applying ? t('defaults.applying') : t('defaults.applyAll')),
          ),
          h('div', null, outcomeNode(outcome, t)),
          h('p', { className: 'dlct-note' }, t('defaults.note')),
          h('p', { className: 'dlct-note' }, t('defaults.applyAllNote')),
        ),
        h('section', { className: 'dlct-card' },
          h('header', { className: 'dlct-card-head' },
            h('h3', { className: 'dlct-card-title' }, t('providers.heading')),
            h('p', { className: 'dlct-card-description' }, t('providers.description')),
          ),
          providerNote,
          providers.status === 'ready'
            ? h('div', { className: 'dlct-providers' }, providers.rows.map(row => h(ProviderRow, {
                key: rowKey(row),
                row,
                t,
                form: row.form,
                defaultsValues: check.ok ? check.values : undefined,
                applyOutcome: applyOutcomes[rowKey(row)],
              })))
            : null,
        ),
        h('section', { className: 'dlct-card' },
          h('header', { className: 'dlct-card-head' },
            h('h3', { className: 'dlct-card-title' }, t('fetch.heading')),
            h('p', { className: 'dlct-card-description' }, t('fetch.description')),
          ),
          fetchStatusNote,
          h('div', { className: 'dlct-fields' },
            renderFetchFields({
              t,
              ids: fetchIds,
              draft: fetchValues,
              errors: fetchErrors,
              disabled: disabled || fetchBusy,
              stage: stageFetch,
            }),
          ),
          h('div', { className: 'dlct-actions' },
            h('button', {
              type: 'button',
              className: 'dlct-button',
              disabled: disabled || saving || fetchBusy || !fetchCheck.ok,
              'aria-busy': fetchPending === 'save' ? 'true' : undefined,
              onClick: saveFetch,
            }, fetchPending === 'save' ? t('fetch.saving') : t('fetch.save')),
            h('button', {
              type: 'button',
              className: 'dlct-button dlct-outline',
              disabled: disabled || saving || fetchBusy,
              'aria-busy': fetchPending === 'reset' ? 'true' : undefined,
              onClick: resetFetch,
            }, fetchPending === 'reset' ? t('fetch.resetting') : t('fetch.reset')),
          ),
          h('div', null, outcomeNode(fetchOutcome, t, 'status.fetchReset')),
          h('p', { className: 'dlct-note' }, t('fetch.note')),
        ),
      );
    }

    /* ══ plugin registration ═══════════════════════════════════════════════ */

    const plugin = {
      name: 'dsh-llm-api-call-tuning',
      inject: ['slots', 'locale', 'configForms', 'remote'],
      /**
       * Register the plugin dictionaries and the tuning settings section. The
       * provider directory is resolved lazily inside the mounted page, so a
       * composition without the Remote LLM namespace still registers the page
       * and degrades the provider list to a localized note.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-llm-api-call-tuning: dictionaries');
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
