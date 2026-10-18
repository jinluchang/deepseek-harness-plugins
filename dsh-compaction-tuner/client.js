/**
 * Client half of @local/dsh-compaction-tuner: one Settings page that edits the
 * tuner's full `compaction-basic` policy surface — the request threshold, the
 * pressure headroom, the two mutually exclusive retention forms, the
 * summarization target pair, the summary token cap, both retry counts, the
 * exact-target `modelPolicies` table, and the `auto` switch — in ONE atomic
 * write, plus a bold restart-required notice and a restart action for the step
 * that makes the saved values reach the agent presets, and a secondary
 * **Reset to system defaults** action that stages the all-unset draft without
 * writing anything.
 *
 * Every field's copy states the upstream `compaction-basic` code default and its
 * allowed range (`index.js` `TUNE_OPTIONS` is the host-side source of that
 * metadata; the two halves cannot import each other, so the tables are kept in
 * step by the offline suite). The bundle seeds nothing: with no stored value the
 * tuner runs those code defaults, and the note above the fields says so. A field
 * whose code default is a concrete number but whose schema carries no
 * `.default()` (`retainRatio`) shows that effective default as the input's
 * placeholder while the empty value still means "unset upstream" — see
 * `DEFAULT_RETAIN_RATIO`.
 *
 * Plain browser bundle (no build step): it self-registers with the page's
 * module loader and requests React, the only module-table entry it needs.
 * Values are read and written through `ctx.configForms.get('compaction-tuner')`
 * — the Host profile row that carries the tuner's config — so the page owns no
 * copy of another plugin's state and makes no cross-plugin value import. The
 * per-model picker enumerates providers/models through the client Remote
 * service (`ctx.remote.session.modelCatalog()`), which the plugin injects as
 * `remote`; that read is the only other service this page uses.
 *
 * The cross-field rules (`retainRatio` XOR `retainTokens` and below the
 * threshold, the summarization pair, the derived summary cap, the
 * `modelPolicies` table) couple fields, so the draft is validated locally first
 * and then submitted as a single `form.mutate(ops, revision)`, so a concurrent
 * writer that moved the revision is refused instead of half-applied.
 * A blank optional field is submitted as an `unset` op, because the tuner's own
 * schema deliberately gives `retainRatio`, `retainTokens` and `maxTokens` no
 * default: materializing one would make the XOR undetectable.
 * `mutate` resolves `false` on a Host refusal; the controller then performs its
 * own recovery read, so this page only surfaces the refusal and re-seeds from
 * whatever the Host reports next.
 *
 * The restart action adds NO second restart path: it calls the authenticated
 * shared Connection channel owned by @local/dsh-backend-restart and frozen in
 * that package's CONTRACT.md (`status` / `restart`) through
 * `ctx.get('connection').rpc.call(...)`. Every path that cannot reach that
 * channel — not installed, refused, or transport-dead — degrades to localized
 * "restart it yourself" copy with the action disabled, while the bold
 * restart-required note stays visible: it is a fact about this plugin, and the
 * manual restart always exists.
 *
 * @module @local/dsh-compaction-tuner/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-compaction-tuner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } = React;

    /** Settings namespace and dictionary namespace: the Host profile row id. */
    const NS = 'compaction-tuner';
    /** Settings section key (drives the shell's `only` filtering). */
    const SECTION_ID = 'compaction-tuner';
    /**
     * Nav position: in-tree sections are account (-10), general (0), models
     * (10), plugins (15), agent-presets (20); the sibling out-of-tree tools
     * page is 30. 40 closes the nav after all of them, without colliding.
     */
    const SECTION_ORDER = 40;

    /**
     * The eleven tuner fields, in the order their ops are submitted: the host
     * `TUNE_KEYS` order, each with its client-side input shape and numeric bound
     * (`ratio` -> `step(0.01).min(0.01).max(1)`, `integer` -> `step(1).min(min)`).
     * A blank field is submitted as `unset`; only `retainRatio`, `retainTokens` and
     * `maxTokens` are ever legitimately blank (no schema default), and `retainRatio`
     * carries its unset default as a placeholder. `default` mirrors the host
     * `OPTION_SPECS` code default (`index.js:149-250`, cited per entry) — only
     * `react` may be required (`verify.mjs:682`); `undefined` = unset upstream.
     */
    const FIELDS = [
      { key: 'thresholdRatio', kind: 'ratio', default: 0.8 }, // index.js:153
      { key: 'headroomTokens', kind: 'integer', min: 0, default: 65_536 }, // index.js:161
      { key: 'retainRatio', kind: 'ratio', default: 0.16 }, // index.js:169
      { key: 'retainTokens', kind: 'integer', min: 0, default: undefined }, // index.js:177
      { key: 'summarizationProvider', kind: 'string', default: '' }, // index.js:185
      { key: 'summarizationModel', kind: 'string', default: '' }, // index.js:193
      { key: 'maxTokens', kind: 'integer', min: 1, default: undefined }, // index.js:201
      { key: 'compactionRetries', kind: 'integer', min: 0, default: 1 }, // index.js:209
      { key: 'maxOverflowRetries', kind: 'integer', min: 0, default: 1 }, // index.js:217
      { key: 'modelPolicies', kind: 'json', default: Object.freeze([]) }, // index.js:225
      { key: 'auto', kind: 'boolean', default: true }, // index.js:245
    ];

    /**
     * The upstream `compaction-basic` code default of `retainRatio`
     * (`packages/compaction/compaction-basic/src/config.ts:23`). The page needs
     * it because a blank ratio field means "unset", and the effective retention
     * is this default, which still has to stay below the threshold. The offline
     * suite compares it against the host `DEFAULT_TUNE`.
     */
    const DEFAULT_RETAIN_RATIO = 0.16;

    /**
     * The other upstream code defaults the cross-field checks fall back to when
     * a key is left unset by the Reset action (`DEFAULT_TUNE` in `index.js`).
     * The offline suite pins them against the host literals.
     */
    const DEFAULT_THRESHOLD_RATIO = 0.8;
    const DEFAULT_HEADROOM_TOKENS = 65_536;

    /** The keys one `modelPolicies` entry may carry (`config.ts:46-50`). */
    const MODEL_POLICY_KEYS = [
      'provider', 'model', 'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
      'summarizationProvider', 'summarizationModel', 'maxTokens', 'compactionRetries', 'maxOverflowRetries',
    ];

    /**
     * The nine per-model policy boxes, in the order they render. `provider` and
     * `model` identify the entry; `auto` is deliberately NOT per-model.
     */
    const PER_MODEL_KEYS = MODEL_POLICY_KEYS.filter(key => key !== 'provider' && key !== 'model');

    /**
     * Normalize one `ctx.remote.session.modelCatalog()` reply into what the
     * picker renders. The reply is the Remote result envelope
     * (`{ok:true, value}` / `{ok:false, error}`); a provider with no routable
     * model is dropped, because it cannot be selected. No provider or model id
     * is ever hardcoded: the whole list comes from this reply.
     * @param result - the Remote reply, possibly a rejection value.
     * @returns `{status, providers}` where status is `ready`, `empty`, or `error`.
     */
    function catalogState(result) {
      if (result === null || typeof result !== 'object' || result.ok !== true
        || result.value === null || typeof result.value !== 'object' || !Array.isArray(result.value.groups)) {
        // A refusal that names the missing Remote service renders the
        // "unavailable" note; any other refusal is a load error.
        const unavailable = result !== null && typeof result === 'object'
          && result.error !== undefined && result.error !== null
          && result.error.code === 'compaction-tuner/remote-unavailable';
        return { status: unavailable ? 'unavailable' : 'error', providers: [] };
      }
      const providers = result.value.groups.flatMap(group => {
        if (group === null || typeof group !== 'object' || typeof group.id !== 'string' || group.id === '') return [];
        const models = (Array.isArray(group.models) ? group.models : []).flatMap(model => (
          model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== ''
            ? [{ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }]
            : []
        ));
        if (models.length === 0) return [];
        return [{ id: group.id, name: typeof group.name === 'string' && group.name !== '' ? group.name : group.id, models }];
      });
      return { status: providers.length === 0 ? 'empty' : 'ready', providers };
    }

    /**
     * The repo's authenticated restart channel. It is owned and registered by
     * @local/dsh-backend-restart; this page only calls its two endpoints.
     */
    const RESTART_CHANNEL = '/backend-restart';

    /* Recovery budget: the old listener must disappear, then the successor
     * must answer. Both phases are bounded so the user never waits on a dead
     * page without the manual-reload fallback. */
    const DOWN_BUDGET_MS = 20000;
    const UP_BUDGET_MS = 60000;
    const POLL_INTERVAL_MS = 500;
    const PROBE_TIMEOUT_MS = 5000;

    /* A transient miss must not hide the action, so the mount probe retries
     * before it reports that this backend cannot restart itself from here. */
    const STATUS_ATTEMPTS = 3;
    const STATUS_RETRY_MS = 1000;

    const en = {
      'nav': 'Compaction tuner',
      'title': 'Compaction tuner',
      'intro': 'One set of values for every agent preset in this profile. Sessions started after a save use them; a running session keeps the values it started with.',
      'note.defaults': 'Each field notes the upstream compaction-basic code default. This bundle seeds nothing, so those code defaults are what this install runs until you edit a value; the field shows the stored value.',
      'field.thresholdRatio.label': 'Compaction threshold',
      'field.thresholdRatio.description': 'Share of the context budget at which compaction triggers. The Host schema enforces a 0.01 step inside 0.01-1; compaction-basic itself accepts any finite value in (0, 1].',
      'field.thresholdRatio.unit': 'ratio in (0, 1], step 0.01',
      'field.thresholdRatio.default': 'code default 0.8',
      'field.headroomTokens.label': 'Pressure headroom',
      'field.headroomTokens.description': 'Extra token headroom reserved beyond the routed output reservation before pressure is measured.',
      'field.headroomTokens.unit': 'integer >= 0',
      'field.headroomTokens.default': 'code default 65536',
      'field.retainRatio.label': 'Retained tail ratio',
      'field.retainRatio.description': 'Share of the message budget kept as the verbatim tail after compaction. Must stay below the threshold. Leave blank to use the code default, or set the token budget instead.',
      'field.retainRatio.unit': 'ratio in (0, 1], step 0.01; below the threshold',
      'field.retainRatio.default': 'code default 0.16',
      'field.retainTokens.label': 'Retained tail tokens',
      'field.retainTokens.description': 'Absolute token budget kept as the verbatim tail. Set either this or the ratio, never both. The resolved value must stay below the target threshold tokens.',
      'field.retainTokens.unit': 'integer >= 0; either this or the ratio',
      'field.retainTokens.default': 'code default: unset (the retainRatio default 0.16 governs)',
      'field.summarizationProvider.label': 'Summary provider',
      'field.summarizationProvider.description': 'Provider that writes the summary. Set it together with the summary model, or leave both empty to inherit the routed target.',
      'field.summarizationProvider.unit': 'string; set together with the summary model',
      'field.summarizationProvider.default': "code default '' (inherit the routed target)",
      'field.summarizationModel.label': 'Summary model',
      'field.summarizationModel.description': 'Model that writes the summary. Set it together with the summary provider, or leave both empty to inherit the routed target.',
      'field.summarizationModel.unit': 'string; set together with the summary provider',
      'field.summarizationModel.default': "code default '' (inherit the routed target)",
      'field.maxTokens.label': 'Summary token cap',
      'field.maxTokens.description': 'Provider generation cap for the summary request. Leave blank to derive it from the effective pressure headroom.',
      'field.maxTokens.unit': 'integer >= 1; blank derives it from the headroom',
      'field.maxTokens.default': 'code default: unset (derives from headroomTokens: 65536)',
      'field.compactionRetries.label': 'Compaction retries',
      'field.compactionRetries.description': 'Extra attempts after the first compaction while pressure stays above the threshold.',
      'field.compactionRetries.unit': 'integer >= 0',
      'field.compactionRetries.default': 'code default 1',
      'field.maxOverflowRetries.label': 'Overflow retries',
      'field.maxOverflowRetries.description': 'Attempts after a canonical context overflow. 0 disables overflow recovery.',
      'field.maxOverflowRetries.unit': 'integer >= 0',
      'field.maxOverflowRetries.default': 'code default 1',
      'field.modelPolicies.label': 'Per-model policies',
      'field.modelPolicies.description': 'JSON array of exact-target overrides: {"provider": "...", "model": "...", plus any of thresholdRatio, headroomTokens, retainRatio, retainTokens, summarizationProvider, summarizationModel, maxTokens, compactionRetries, maxOverflowRetries}. Example: [{"provider":"openai","model":"gpt-5","thresholdRatio":0.7}]. Provider and model must be non-empty and unique per entry. Leave the table empty to leave every preset\u2019s own table alone.',
      'field.modelPolicies.unit': 'JSON array of provider/model overrides',
      'field.modelPolicies.default': 'code default []',
      'field.auto.label': 'Automatic compaction',
      'field.auto.description': 'Enable the automatic step-boundary pressure and overflow-recovery listeners.',
      'field.auto.unit': 'true or false',
      'field.auto.default': 'code default true',
      'restart.note': 'Saving stores the values, but they reach the agent presets only after the DSH backend restarts.',
      'restart.action': 'Restart backend',
      'restart.manual': 'This deployment cannot restart itself from here. Restart DSH yourself to apply the saved values.',
      'restart.confirmLabel': 'Confirm backend restart',
      'restart.confirm': 'Restarting interrupts running turns, terminals, and open connections, and the page reloads once the backend is back. Restart now?',
      'restart.cancel': 'Cancel',
      'restart.confirmAction': 'Restart now',
      'restart.restarting': 'Restarting\u2026 waiting for the backend to come back',
      'restart.timeout': 'The backend did not answer in time. Reload the page to reconnect to the new process.',
      'restart.reload': 'Reload page',
      'restart.error.busy': 'A backend restart is already in progress.',
      'restart.error.unsupported': 'This process cannot restart itself.',
      'restart.error.spawnFailed': 'The backend could not be relaunched.',
      'restart.error.generic': 'The backend refused the restart request.',
      'action.save': 'Save',
      'action.saving': 'Saving\u2026',
      'status.loading': 'Loading the compaction tuner\u2026',
      'status.unavailable': 'This deployment does not serve the compaction-tuner settings namespace, so these values cannot be edited here.',
      'status.readOnly': 'These values are read-only in this deployment.',
      'status.saved': 'Saved. New sessions use the new values; running sessions keep theirs.',
      'error.refused': 'The host refused the write. The values shown are the ones the host reports now.',
      'error.thresholdRange': 'The compaction threshold must be greater than 0 and at most 1.',
      'error.headroomTokens': 'The pressure headroom must be a whole number from 0 to 9007199254740991 (the largest exact integer).',
      'error.retainRange': 'The retained tail ratio must be greater than 0 and at most 1.',
      'error.retainOrder': 'The retained tail must be smaller than the compaction threshold.',
      'error.retainTokens': 'The retained-tail token budget must be a whole number from 0 to 9007199254740991 (the largest exact integer).',
      'error.retentionExclusive': 'Set either the retained-tail ratio or the retained-tail token budget, not both.',
      'error.maxTokens': 'The summary token cap must be a whole number from 1 to 9007199254740991 (the largest exact integer).',
      'error.maxTokensResolved': 'With no summary token cap, the pressure headroom must resolve to a whole number from 1 to 9007199254740991, because the cap resolves to the headroom.',
      'error.overflowRetries': 'Overflow retries must be a whole number from 0 to 9007199254740991 (the largest exact integer).',
      'error.summarizationPair': 'Set the summary provider and model together, or leave both empty.',
      'error.modelPoliciesJson': 'The per-model policies must be valid JSON.',
      'error.modelPolicies': 'The per-model policies must be an array of objects with a non-empty provider and model, no duplicate provider/model pair, and in-range policy fields.',
      'error.modelPoliciesCap': 'Each per-model policy must resolve to a summary token cap from 1 to 9007199254740991; an entry with a zero headroom needs an explicit cap.',
      'error.compactionRetries': 'Compaction retries must be a whole number from 0 to 9007199254740991 (the largest exact integer).',
      'note.modelPolicies': 'An empty per-model policy table leaves every preset\u2019s own table untouched; a non-empty table replaces it. Clearing a preset\u2019s table with an empty one is deliberately not offered.',
      'perModel.heading': 'Per-model overrides',
      'perModel.description': 'One override per exact provider/model route. Fill any of the nine option boxes; an override with every box empty changes nothing and is dropped when you save. An empty table leaves each preset\u2019s own per-model table untouched.',
      'perModel.provider': 'Provider',
      'perModel.model': 'Model',
      'perModel.add': 'Add override',
      'perModel.remove': 'Remove',
      'perModel.none': 'No per-model override yet.',
      'perModel.loading': 'Loading the model catalog\u2026',
      'perModel.unavailable': 'The model catalog is not available in this deployment; a saved override can still be edited or removed.',
      'perModel.error': 'The model catalog could not be loaded; a saved override can still be edited or removed.',
      'perModel.empty': 'The catalog has no provider with a routable model.',
      'perModel.outOfCatalog': 'not in the current catalog',
      'action.resetDefaults': 'Reset to system defaults',
      'note.resetDefaults': 'Clears every stored choice, including the per-model overrides, so the DSH system defaults apply. It writes nothing until you press Save; the presets are re-tuned to those defaults on the next pass. There is no automatic migration, and this cannot be undone from this page.',
    };

    const zh = {
      'nav': '\u538b\u7f29\u8c03\u4f18',
      'title': '\u538b\u7f29\u8c03\u4f18',
      'intro': '\u4e3a\u5f53\u524d\u914d\u7f6e\u4e2d\u7684\u6bcf\u4e2a Agent \u9884\u8bbe\u7edf\u4e00\u8bbe\u7f6e\u3002\u4fdd\u5b58\u540e\u65b0\u5efa\u7684\u4f1a\u8bdd\u4f1a\u4f7f\u7528\u8fd9\u4e9b\u503c\uff1b\u6b63\u5728\u8fd0\u884c\u7684\u4f1a\u8bdd\u4fdd\u6301\u542f\u52a8\u65f6\u7684\u503c\u3002',
      'note.defaults': '\u6bcf\u4e2a\u5b57\u6bb5\u90fd\u6807\u6ce8\u4e86\u4e0a\u6e38 compaction-basic \u7684\u4ee3\u7801\u9ed8\u8ba4\u503c\u3002\u672c\u63d2\u4ef6\u4e0d\u5199\u5165\u4efb\u4f55\u79cd\u5b50\u503c\uff0c\u56e0\u6b64\u5728\u4f60\u4fee\u6539\u4e4b\u524d\uff0c\u672c\u5b89\u88c5\u8fd0\u884c\u7684\u6b63\u662f\u8fd9\u4e9b\u4ee3\u7801\u9ed8\u8ba4\u503c\uff1b\u5b57\u6bb5\u4e2d\u663e\u793a\u7684\u662f\u5df2\u4fdd\u5b58\u7684\u503c\u3002',
      'field.thresholdRatio.label': '\u538b\u7f29\u9608\u503c',
      'field.thresholdRatio.description': '\u89e6\u53d1\u538b\u7f29\u7684\u4e0a\u4e0b\u6587\u9884\u7b97\u5360\u6bd4\u3002\u5bbf\u4e3b schema \u5f3a\u5236 0.01 \u6b65\u957f\u4e14\u9650\u5236\u5728 0.01-1\uff1bcompaction-basic \u672c\u8eab\u63a5\u53d7 (0, 1] \u5185\u7684\u4efb\u610f\u6709\u9650\u6570\u503c\u3002',
      'field.thresholdRatio.unit': '0 \u5230 1 \u4e4b\u95f4\u7684\u6bd4\u4f8b\uff0c\u6b65\u957f 0.01',
      'field.thresholdRatio.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 0.8',
      'field.headroomTokens.label': '\u538b\u529b\u4f59\u91cf',
      'field.headroomTokens.description': '\u5728\u8def\u7531\u8f93\u51fa\u9884\u7559\u4e4b\u5916\uff0c\u7528\u4e8e\u8861\u91cf\u538b\u529b\u524d\u989d\u5916\u9884\u7559\u7684 token \u4f59\u91cf\u3002',
      'field.headroomTokens.unit': '\u4e0d\u5c0f\u4e8e 0 \u7684\u6574\u6570',
      'field.headroomTokens.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 65536',
      'field.retainRatio.label': '\u4fdd\u7559\u5c3e\u90e8\u6bd4\u4f8b',
      'field.retainRatio.description': '\u538b\u7f29\u540e\u4fdd\u7559\u4e3a\u9010\u5b57\u5c3e\u90e8\u7684\u6d88\u606f\u9884\u7b97\u5360\u6bd4\uff0c\u5fc5\u987b\u5c0f\u4e8e\u9608\u503c\u3002\u7559\u7a7a\u5219\u4f7f\u7528\u4ee3\u7801\u9ed8\u8ba4\u503c\uff0c\u6216\u6539\u8bbe token \u9884\u7b97\u3002',
      'field.retainRatio.unit': '0 \u5230 1 \u4e4b\u95f4\u7684\u6bd4\u4f8b\uff0c\u6b65\u957f 0.01\uff1b\u4e14\u5c0f\u4e8e\u9608\u503c',
      'field.retainRatio.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 0.16',
      'field.retainTokens.label': '\u4fdd\u7559\u5c3e\u90e8 token',
      'field.retainTokens.description': '\u4fdd\u7559\u4e3a\u9010\u5b57\u5c3e\u90e8\u7684\u7edd\u5bf9 token \u9884\u7b97\u3002\u6b64\u9879\u4e0e\u6bd4\u4f8b\u53ea\u80fd\u8bbe\u7f6e\u4e00\u4e2a\u3002\u89e3\u6790\u540e\u7684\u503c\u5fc5\u987b\u5c0f\u4e8e\u76ee\u6807 thresholdTokens\u3002',
      'field.retainTokens.unit': '\u4e0d\u5c0f\u4e8e 0 \u7684\u6574\u6570\uff1b\u4e0e\u6bd4\u4f8b\u4e8c\u9009\u4e00',
      'field.retainTokens.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c\uff1a\u672a\u8bbe\u7f6e\uff08\u7531 retainRatio \u9ed8\u8ba4\u503c 0.16 \u751f\u6548\uff09',
      'field.summarizationProvider.label': '\u6458\u8981\u63d0\u4f9b\u65b9',
      'field.summarizationProvider.description': '\u751f\u6210\u6458\u8981\u7684\u63d0\u4f9b\u65b9\u3002\u9700\u4e0e\u6458\u8981\u6a21\u578b\u6210\u5bf9\u8bbe\u7f6e\uff0c\u6216\u4e24\u8005\u90fd\u7559\u7a7a\u4ee5\u7ee7\u627f\u8def\u7531\u76ee\u6807\u3002',
      'field.summarizationProvider.unit': '\u5b57\u7b26\u4e32\uff1b\u4e0e\u6458\u8981\u6a21\u578b\u6210\u5bf9\u8bbe\u7f6e',
      'field.summarizationProvider.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c \'\'\uff08\u7ee7\u627f\u8def\u7531\u76ee\u6807\uff09',
      'field.summarizationModel.label': '\u6458\u8981\u6a21\u578b',
      'field.summarizationModel.description': '\u751f\u6210\u6458\u8981\u7684\u6a21\u578b\u3002\u9700\u4e0e\u6458\u8981\u63d0\u4f9b\u65b9\u6210\u5bf9\u8bbe\u7f6e\uff0c\u6216\u4e24\u8005\u90fd\u7559\u7a7a\u4ee5\u7ee7\u627f\u8def\u7531\u76ee\u6807\u3002',
      'field.summarizationModel.unit': '\u5b57\u7b26\u4e32\uff1b\u4e0e\u6458\u8981\u63d0\u4f9b\u65b9\u6210\u5bf9\u8bbe\u7f6e',
      'field.summarizationModel.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c \'\'\uff08\u7ee7\u627f\u8def\u7531\u76ee\u6807\uff09',
      'field.maxTokens.label': '\u6458\u8981 token \u4e0a\u9650',
      'field.maxTokens.description': '\u6458\u8981\u8bf7\u6c42\u7684\u63d0\u4f9b\u65b9\u751f\u6210\u4e0a\u9650\u3002\u7559\u7a7a\u5219\u7531\u751f\u6548\u7684\u538b\u529b\u4f59\u91cf\u63a8\u5bfc\u3002',
      'field.maxTokens.unit': '\u4e0d\u5c0f\u4e8e 1 \u7684\u6574\u6570\uff1b\u7559\u7a7a\u5219\u4ece\u4f59\u91cf\u63a8\u5bfc',
      'field.maxTokens.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c\uff1a\u672a\u8bbe\u7f6e\uff08\u7531 headroomTokens \u63a8\u5bfc\uff1a65536\uff09',
      'field.compactionRetries.label': '\u538b\u7f29\u91cd\u8bd5\u6b21\u6570',
      'field.compactionRetries.description': '\u9996\u6b21\u538b\u7f29\u540e\u538b\u529b\u4ecd\u9ad8\u4e8e\u9608\u503c\u65f6\u7684\u989d\u5916\u91cd\u8bd5\u6b21\u6570\u3002',
      'field.compactionRetries.unit': '\u4e0d\u5c0f\u4e8e 0 \u7684\u6574\u6570',
      'field.compactionRetries.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 1',
      'field.maxOverflowRetries.label': '\u6ea2\u51fa\u91cd\u8bd5\u6b21\u6570',
      'field.maxOverflowRetries.description': '\u4e0a\u4e0b\u6587\u89c4\u8303\u5316\u6ea2\u51fa\u540e\u7684\u91cd\u8bd5\u6b21\u6570\u30020 \u8868\u793a\u7981\u7528\u6ea2\u51fa\u6062\u590d\u3002',
      'field.maxOverflowRetries.unit': '\u4e0d\u5c0f\u4e8e 0 \u7684\u6574\u6570',
      'field.maxOverflowRetries.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c 1',
      'field.modelPolicies.label': '\u6309\u6a21\u578b\u7b56\u7565',
      'field.modelPolicies.description': '\u7cbe\u786e\u76ee\u6807\u8986\u76d6\u7684 JSON \u6570\u7ec4\uff1a{"provider": "...", "model": "...", \u4ee5\u53ca thresholdRatio\u3001headroomTokens\u3001retainRatio\u3001retainTokens\u3001summarizationProvider\u3001summarizationModel\u3001maxTokens\u3001compactionRetries\u3001maxOverflowRetries \u4e2d\u4efb\u610f\u5b57\u6bb5}\u3002\u793a\u4f8b\uff1a[{"provider":"openai","model":"gpt-5","thresholdRatio":0.7}]\u3002\u6bcf\u4e2a\u6761\u76ee\u7684 provider \u4e0e model \u5fc5\u987b\u975e\u7a7a\u4e14\u4e0d\u91cd\u590d\u3002\uff1b\u7559\u7a7a\u5219\u4fdd\u6301\u6bcf\u4e2a\u9884\u8bbe\u81ea\u5df1\u7684\u8868\u4e0d\u53d8\u3002',
      'field.modelPolicies.unit': 'provider/model \u8986\u76d6\u7684 JSON \u6570\u7ec4',
      'field.modelPolicies.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c []',
      'field.auto.label': '\u81ea\u52a8\u538b\u7f29',
      'field.auto.description': '\u542f\u7528\u6b65\u8fb9\u754c\u538b\u529b\u4e0e\u6ea2\u51fa\u6062\u590d\u7684\u81ea\u52a8\u76d1\u542c\u3002',
      'field.auto.unit': 'true \u6216 false',
      'field.auto.default': '\u4ee3\u7801\u9ed8\u8ba4\u503c true',
      'restart.note': '\u4fdd\u5b58\u53ea\u4f1a\u5b58\u4e0b\u8fd9\u4e9b\u503c\uff0c\u5b83\u4eec\u53ea\u6709\u5728 DSH \u540e\u7aef\u91cd\u542f\u540e\u624d\u4f1a\u5e94\u7528\u5230\u5404 Agent \u9884\u8bbe\u3002',
      'restart.action': '\u91cd\u542f\u540e\u7aef',
      'restart.manual': '\u5f53\u524d\u90e8\u7f72\u65e0\u6cd5\u4ece\u6b64\u5904\u91cd\u542f\u81ea\u8eab\u3002\u8bf7\u81ea\u884c\u91cd\u542f DSH \u4ee5\u5e94\u7528\u5df2\u4fdd\u5b58\u7684\u503c\u3002',
      'restart.confirmLabel': '\u786e\u8ba4\u91cd\u542f\u540e\u7aef',
      'restart.confirm': '\u91cd\u542f\u4f1a\u4e2d\u65ad\u6b63\u5728\u8fd0\u884c\u7684\u5bf9\u8bdd\u3001\u7ec8\u7aef\u548c\u8fde\u63a5\uff0c\u540e\u7aef\u6062\u590d\u540e\u9875\u9762\u4f1a\u81ea\u52a8\u91cd\u65b0\u52a0\u8f7d\u3002\u73b0\u5728\u91cd\u542f\u5417\uff1f',
      'restart.cancel': '\u53d6\u6d88',
      'restart.confirmAction': '\u7acb\u5373\u91cd\u542f',
      'restart.restarting': '\u6b63\u5728\u91cd\u542f\u2026\u7b49\u5f85\u540e\u7aef\u6062\u590d',
      'restart.timeout': '\u540e\u7aef\u672a\u53ca\u65f6\u54cd\u5e94\u3002\u8bf7\u91cd\u65b0\u52a0\u8f7d\u9875\u9762\u4ee5\u8fde\u63a5\u65b0\u8fdb\u7a0b\u3002',
      'restart.reload': '\u91cd\u65b0\u52a0\u8f7d\u9875\u9762',
      'restart.error.busy': '\u5df2\u6709\u91cd\u542f\u8bf7\u6c42\u6b63\u5728\u5904\u7406\u3002',
      'restart.error.unsupported': '\u5f53\u524d\u8fdb\u7a0b\u65e0\u6cd5\u81ea\u884c\u91cd\u542f\u3002',
      'restart.error.spawnFailed': '\u65e0\u6cd5\u91cd\u65b0\u542f\u52a8\u540e\u7aef\u3002',
      'restart.error.generic': '\u540e\u7aef\u62d2\u7edd\u4e86\u91cd\u542f\u8bf7\u6c42\u3002',
      'action.save': '\u4fdd\u5b58',
      'action.saving': '\u6b63\u5728\u4fdd\u5b58\u2026',
      'status.loading': '\u6b63\u5728\u52a0\u8f7d\u538b\u7f29\u8c03\u4f18\u8bbe\u7f6e\u2026',
      'status.unavailable': '\u5f53\u524d\u90e8\u7f72\u672a\u63d0\u4f9b compaction-tuner \u8bbe\u7f6e\u547d\u540d\u7a7a\u95f4\uff0c\u65e0\u6cd5\u5728\u6b64\u7f16\u8f91\u8fd9\u4e9b\u503c\u3002',
      'status.readOnly': '\u5f53\u524d\u90e8\u7f72\u4e2d\u8fd9\u4e9b\u503c\u4e3a\u53ea\u8bfb\u3002',
      'status.saved': '\u5df2\u4fdd\u5b58\u3002\u65b0\u4f1a\u8bdd\u5c06\u4f7f\u7528\u65b0\u7684\u503c\uff1b\u6b63\u5728\u8fd0\u884c\u7684\u4f1a\u8bdd\u4fdd\u6301\u539f\u503c\u3002',
      'error.refused': '\u5bbf\u4e3b\u62d2\u7edd\u4e86\u672c\u6b21\u5199\u5165\u3002\u5f53\u524d\u663e\u793a\u7684\u662f\u5bbf\u4e3b\u73b0\u5728\u62a5\u544a\u7684\u503c\u3002',
      'error.thresholdRange': '\u538b\u7f29\u9608\u503c\u5fc5\u987b\u5927\u4e8e 0 \u4e14\u4e0d\u8d85\u8fc7 1\u3002',
      'error.headroomTokens': '\u538b\u529b\u4f59\u91cf\u5fc5\u987b\u662f 0 \u5230 9007199254740991\uff08\u6700\u5927\u7cbe\u786e\u6574\u6570\uff09\u4e4b\u95f4\u7684\u6574\u6570\u3002',
      'error.retainRange': '\u4fdd\u7559\u5c3e\u90e8\u6bd4\u4f8b\u5fc5\u987b\u5927\u4e8e 0 \u4e14\u4e0d\u8d85\u8fc7 1\u3002',
      'error.retainOrder': '\u4fdd\u7559\u5c3e\u90e8\u5fc5\u987b\u5c0f\u4e8e\u538b\u7f29\u9608\u503c\u3002',
      'error.retainTokens': '\u4fdd\u7559\u5c3e\u90e8 token \u9884\u7b97\u5fc5\u987b\u662f 0 \u5230 9007199254740991\uff08\u6700\u5927\u7cbe\u786e\u6574\u6570\uff09\u4e4b\u95f4\u7684\u6574\u6570\u3002',
      'error.retentionExclusive': '\u4fdd\u7559\u5c3e\u90e8\u6bd4\u4f8b\u4e0e\u4fdd\u7559\u5c3e\u90e8 token \u9884\u7b97\u53ea\u80fd\u8bbe\u7f6e\u5176\u4e2d\u4e00\u4e2a\u3002',
      'error.maxTokens': '\u6458\u8981 token \u4e0a\u9650\u5fc5\u987b\u662f 1 \u5230 9007199254740991\uff08\u6700\u5927\u7cbe\u786e\u6574\u6570\uff09\u4e4b\u95f4\u7684\u6574\u6570\u3002',
      'error.maxTokensResolved': '\u672a\u8bbe\u7f6e\u6458\u8981 token \u4e0a\u9650\u65f6\uff0c\u538b\u529b\u4f59\u91cf\u5fc5\u987b\u89e3\u6790\u4e3a 1 \u5230 9007199254740991 \u4e4b\u95f4\u7684\u6574\u6570\uff0c\u56e0\u4e3a\u4e0a\u9650\u4f1a\u89e3\u6790\u4e3a\u4f59\u91cf\u3002',
      'error.overflowRetries': '\u6ea2\u51fa\u91cd\u8bd5\u6b21\u6570\u5fc5\u987b\u662f 0 \u5230 9007199254740991\uff08\u6700\u5927\u7cbe\u786e\u6574\u6570\uff09\u4e4b\u95f4\u7684\u6574\u6570\u3002',
      'error.summarizationPair': '\u6458\u8981\u63d0\u4f9b\u65b9\u4e0e\u6458\u8981\u6a21\u578b\u5fc5\u987b\u6210\u5bf9\u8bbe\u7f6e\uff0c\u6216\u4e24\u8005\u90fd\u7559\u7a7a\u3002',
      'error.modelPoliciesJson': '\u6309\u6a21\u578b\u7b56\u7565\u5fc5\u987b\u662f\u5408\u6cd5\u7684 JSON\u3002',
      'error.modelPolicies': '\u6309\u6a21\u578b\u7b56\u7565\u5fc5\u987b\u662f\u5bf9\u8c61\u6570\u7ec4\uff0c\u6bcf\u4e2a\u6761\u76ee\u7684 provider \u4e0e model \u975e\u7a7a\u4e14\u4e0d\u91cd\u590d\uff0c\u4e14\u7b56\u7565\u5b57\u6bb5\u90fd\u5728\u5141\u8bb8\u8303\u56f4\u5185\u3002',
      'error.modelPoliciesCap': '\u6bcf\u4e2a\u6309\u6a21\u578b\u7b56\u7565\u7684\u6458\u8981 token \u4e0a\u9650\u5fc5\u987b\u5728 1 \u5230 9007199254740991 \u4e4b\u95f4\uff1b\u4f59\u91cf\u4e3a 0 \u7684\u6761\u76ee\u9700\u8981\u663e\u5f0f\u4e0a\u9650\u3002',
      'error.compactionRetries': '\u538b\u7f29\u91cd\u8bd5\u6b21\u6570\u5fc5\u987b\u662f 0 \u5230 9007199254740991\uff08\u6700\u5927\u7cbe\u786e\u6574\u6570\uff09\u4e4b\u95f4\u7684\u6574\u6570\u3002',
      'note.modelPolicies': '\u6309\u6a21\u578b\u7b56\u7565\u8868\u4e3a\u7a7a\u65f6\uff0c\u6bcf\u4e2a\u9884\u8bbe\u81ea\u5df1\u7684\u8868\u4fdd\u6301\u4e0d\u53d8\uff1b\u586b\u5199\u975e\u7a7a\u8868\u5219\u4f1a\u66ff\u6362\u5b83\u3002\u672c\u63d2\u4ef6\u4e0d\u63d0\u4f9b\u201c\u7528\u7a7a\u8868\u6e05\u7a7a\u9884\u8bbe\u8868\u201d\u7684\u9009\u9879\uff0c\u8fd9\u662f\u523b\u610f\u7684\u53d6\u820d\u3002',
      'perModel.heading': '\u6309\u6a21\u578b\u8986\u76d6',
      'perModel.description': '\u4e3a\u6bcf\u4e2a\u7cbe\u786e\u7684 provider/model \u8def\u7531\u8bbe\u7f6e\u4e00\u6761\u8986\u76d6\u3002\u586b\u5199\u4e5d\u4e2a\u9009\u9879\u4e2d\u7684\u4efb\u610f\u4e00\u4e2a\uff1b\u6240\u6709\u9009\u9879\u90fd\u4e3a\u7a7a\u7684\u8986\u76d6\u4e0d\u4f1a\u6539\u53d8\u4efb\u4f55\u884c\u4e3a\uff0c\u4fdd\u5b58\u65f6\u4f1a\u88ab\u4e22\u5f03\u3002\u7a7a\u8868\u4e0d\u4f1a\u6539\u52a8\u5404\u9884\u8bbe\u81ea\u5df1\u7684\u6309\u6a21\u578b\u8868\u3002',
      'perModel.provider': '\u63d0\u4f9b\u65b9',
      'perModel.model': '\u6a21\u578b',
      'perModel.add': '\u6dfb\u52a0\u8986\u76d6',
      'perModel.remove': '\u79fb\u9664',
      'perModel.none': '\u5c1a\u65e0\u6309\u6a21\u578b\u8986\u76d6\u3002',
      'perModel.loading': '\u6b63\u5728\u52a0\u8f7d\u6a21\u578b\u76ee\u5f55\u2026',
      'perModel.unavailable': '\u6b64\u90e8\u7f72\u672a\u63d0\u4f9b\u6a21\u578b\u76ee\u5f55\uff1b\u5df2\u4fdd\u5b58\u7684\u8986\u76d6\u4ecd\u53ef\u7f16\u8f91\u6216\u79fb\u9664\u3002',
      'perModel.error': '\u6a21\u578b\u76ee\u5f55\u52a0\u8f7d\u5931\u8d25\uff1b\u5df2\u4fdd\u5b58\u7684\u8986\u76d6\u4ecd\u53ef\u7f16\u8f91\u6216\u79fb\u9664\u3002',
      'perModel.empty': '\u76ee\u5f55\u4e2d\u6ca1\u6709\u5e26\u53ef\u8def\u7531\u6a21\u578b\u7684\u63d0\u4f9b\u65b9\u3002',
      'perModel.outOfCatalog': '\u4e0d\u5728\u5f53\u524d\u76ee\u5f55\u4e2d',
      'action.resetDefaults': '\u6062\u590d\u7cfb\u7edf\u9ed8\u8ba4\u503c',
      'note.resetDefaults': '\u6e05\u9664\u6240\u6709\u5df2\u4fdd\u5b58\u7684\u9009\u62e9\uff08\u5305\u62ec\u6309\u6a21\u578b\u8986\u76d6\uff09\uff0c\u4f7f DSH \u7cfb\u7edf\u9ed8\u8ba4\u503c\u751f\u6548\u3002\u5728\u4f60\u6309\u4e0b\u4fdd\u5b58\u4e4b\u524d\u4e0d\u4f1a\u5199\u5165\u4efb\u4f55\u5185\u5bb9\uff1b\u5404\u9884\u8bbe\u4f1a\u5728\u4e0b\u4e00\u6b21\u540c\u6b65\u65f6\u6539\u4e3a\u8fd9\u4e9b\u9ed8\u8ba4\u503c\u3002\u672c\u63d2\u4ef6\u4e0d\u4f1a\u81ea\u52a8\u8fc1\u79fb\uff0c\u6b64\u64cd\u4f5c\u65e0\u6cd5\u5728\u672c\u9875\u64a4\u9500\u3002',
    };

    /* Component-local sheet: rendered inside the section's own tree, so
     * unmounting the plugin removes every rule it added. Class names are
     * namespaced `dct-`, and only `--dsw-alias-*` host theme tokens are read. */
    const STYLE_TEXT = [
      '.dct-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; max-width: 640px; padding: 4px 0 24px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }',
      '.dct-header { display: flex; flex-direction: column; gap: 6px; }',
      '.dct-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 24px; font-weight: 500; }',
      '.dct-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dct-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dct-restart { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-module-platform); }',
      '.dct-restart-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }',
      '.dct-restart-note { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; font-weight: 600; }',
      '.dct-restart-action { display: flex; flex: none; align-items: center; gap: 8px; }',
      '.dct-restart-manual { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dct-restart-block { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }',
      '.dct-restart-timeout { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dct-confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; }',
      '.dct-confirm-text { margin: 0; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }',
      '.dct-confirm-actions { display: flex; gap: 8px; }',
      '.dct-field { display: flex; flex-direction: column; gap: 6px; padding: 14px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }',
      '.dct-field-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
      '.dct-field-label { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; } .dct-field-label[data-nondefault="true"] { font-weight: 600; }',
      '.dct-unit { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dct-input { box-sizing: border-box; width: 160px; height: 28px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }',
      '.dct-input:disabled { cursor: not-allowed; opacity: 0.4; }',
      '.dct-select { box-sizing: border-box; width: 180px; height: 28px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }',
      '.dct-select:disabled { cursor: not-allowed; opacity: 0.4; }',
      '.dct-permodel { display: flex; flex-direction: column; gap: 10px; }',
      '.dct-permodel-picker { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.dct-permodel-list { display: flex; flex-direction: column; gap: 10px; }',
      '.dct-permodel-entry { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; }',
      '.dct-permodel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
      '.dct-permodel-target { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; font-weight: 500; }',
      '.dct-permodel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }',
      '.dct-policy { display: flex; flex-direction: column; gap: 4px; }',
      '.dct-policy-label { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dct-check { box-sizing: border-box; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-button-primary-fill); }',
      '.dct-check:disabled { cursor: not-allowed; opacity: 0.4; }',
      '.dct-default { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dct-description { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dct-alert { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }',
      '.dct-saved { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dct-actions { display: flex; align-items: center; gap: 12px; }',
      '.dct-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px; border: none; border-radius: 6px; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font-size: 12px; line-height: 18px; cursor: pointer; }',
      '.dct-button:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }',
      '.dct-button:disabled { cursor: not-allowed; opacity: 0.4; }',
      '.dct-outline { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); }',
      '.dct-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
    ].join('\n');

    /**
     * Canonical input text for one field of a snapshot value.
     * @param field - one of FIELDS.
     * @param raw - the snapshot's value for that field, possibly absent.
     * @returns the field's text, or an empty string when the value is absent.
     *   A boolean renders `true`/`false`; the JSON field renders its JSON text.
     */
    function canonicalText(field, raw) {
      if (raw === undefined || raw === null) return '';
      if (field.kind === 'json') {
        try {
          return JSON.stringify(raw);
        } catch (_unserializable) {
          return '';
        }
      }
      if (field.kind === 'boolean') return raw === true ? 'true' : 'false';
      return String(raw);
    }

    /**
     * Seed every input from a snapshot value (blank while the value is absent).
     * @param values - the snapshot's `value` section, possibly absent.
     * @returns one input text per field.
     */
    function seedDraft(values) {
      const draft = {};
      for (const field of FIELDS) {
        draft[field.key] = canonicalText(field, values === null || values === undefined ? undefined : values[field.key]);
      }
      return draft;
    }

    /** One empty input text per field, for a page with no snapshot value yet. */
    function blankDraft() {
      const draft = {};
      for (const field of FIELDS) draft[field.key] = '';
      return draft;
    }

    /** Largest integer a JS number carries exactly (see the Host's safe-range rule). */
    const SAFE_INTEGER_MAX = 9007199254740991;

    /**
     * Parse one numeric input; blank, non-finite, and non-decimal text yield
     * `undefined`. The decimal-only shape matters: `Number('0x10')` is `16`, so
     * accepting the raw `Number()` result would let a hexadecimal token budget
     * through as a different number than the user typed.
     * @param text - the raw input text.
     * @returns the finite number, or `undefined`.
     */
    function parseNumber(text) {
      if (typeof text !== 'string') return undefined;
      const trimmed = text.trim();
      if (trimmed === '') return undefined;
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return undefined;
      const value = Number(trimmed);
      return Number.isFinite(value) ? value : undefined;
    }

    /** Whether a value is an integer within the safe range. */
    function isSafeInteger(value) {
      return typeof value === 'number' && Number.isSafeInteger(value);
    }

    /**
     * Parse one integer input, honouring the field's own lower bound and the
     * safe-integer range. `9007199254740993` silently becomes `...992` and
     * `1e21` loses precision entirely, so both are refused rather than rounded;
     * `-0` is normalized to `0` here, where a value is already present, so an
     * absent field is never materialized by the normalization.
     * @param field - one of FIELDS.
     * @param text - the raw input text.
     * @returns the safe integer, or `undefined` when the text is not one.
     */
    function parseInteger(field, text) {
      const value = parseNumber(text);
      if (value === undefined || !isSafeInteger(value) || value < field.min) return undefined;
      if (!Number.isInteger(value)) return undefined;
      return value === 0 ? 0 : value;
    }

    /**
     * Validate one `modelPolicies` entry's policy fields, mirroring the
     * upstream `validatePolicy()` rules the Host `tuneProblem()` enforces.
     * @param entry - one candidate entry.
     * @param thresholdRatio - the top-level threshold an entry inherits.
     * @param capContext - the top-level cap an entry falls back to:
     *   `{ maxTokensExplicit, resolvedMaxTokens }`.
     * @returns an error key, or `undefined` when the entry is usable.
     */
    function policyFieldsProblem(entry, thresholdRatio, capContext) {
      const threshold = entry.thresholdRatio === undefined ? thresholdRatio : entry.thresholdRatio;
      if (entry.thresholdRatio !== undefined && !(entry.thresholdRatio > 0 && entry.thresholdRatio <= 1)) return 'error.modelPolicies';
      if (entry.headroomTokens !== undefined && !(isSafeInteger(entry.headroomTokens) && entry.headroomTokens >= 0)) return 'error.modelPolicies';
      if (entry.retainRatio !== undefined && entry.retainTokens !== undefined) return 'error.modelPolicies';
      if (entry.retainRatio !== undefined
        && (!(entry.retainRatio > 0 && entry.retainRatio <= 1) || !(entry.retainRatio < threshold))) return 'error.modelPolicies';
      if (entry.retainTokens !== undefined && !(isSafeInteger(entry.retainTokens) && entry.retainTokens >= 0)) return 'error.modelPolicies';
      if (entry.maxTokens !== undefined && !(isSafeInteger(entry.maxTokens) && entry.maxTokens >= 1)) return 'error.modelPolicies';
      if (entry.compactionRetries !== undefined && !(isSafeInteger(entry.compactionRetries) && entry.compactionRetries >= 0)) return 'error.modelPolicies';
      if (entry.maxOverflowRetries !== undefined && !(isSafeInteger(entry.maxOverflowRetries) && entry.maxOverflowRetries >= 0)) return 'error.modelPolicies';
      const provider = entry.summarizationProvider;
      const model = entry.summarizationModel;
      if (provider !== undefined && typeof provider !== 'string') return 'error.modelPolicies';
      if (model !== undefined && typeof model !== 'string') return 'error.modelPolicies';
      if (provider !== undefined || model !== undefined) {
        if (provider === undefined || model === undefined || (provider.length === 0) !== (model.length === 0)) return 'error.modelPolicies';
      }
      // Mirror the Host's per-entry cap resolution (compaction-basic
      // `resolveConfig`, config.ts:83-90), so a table the page accepts cannot
      // abort compaction-basic's own load at the next restart.
      const resolvedCap = entry.maxTokens !== undefined
        ? entry.maxTokens
        : (capContext.maxTokensExplicit
          ? capContext.resolvedMaxTokens
          : (entry.headroomTokens !== undefined ? entry.headroomTokens : capContext.resolvedMaxTokens));
      if (!(isSafeInteger(resolvedCap) && resolvedCap >= 1)) return 'error.modelPoliciesCap';
      return undefined;
    }

    /**
     * Validate the whole `modelPolicies` table, mirroring the upstream
     * `resolveModelPolicies()` rules (array, non-empty unique provider/model,
     * no unknown keys) that the Host `tuneProblem()` enforces.
     * @param policies - the parsed JSON value.
     * @param thresholdRatio - the top-level threshold an entry inherits.
     * @param capContext - the top-level cap an entry falls back to.
     * @returns an error key, or `undefined` when the table is usable.
     */
    function modelPoliciesProblem(policies, thresholdRatio, capContext) {
      if (!Array.isArray(policies)) return 'error.modelPolicies';
      const seen = new Set();
      for (const entry of policies) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'error.modelPolicies';
        for (const key of Object.keys(entry)) {
          if (!MODEL_POLICY_KEYS.includes(key)) return 'error.modelPolicies';
        }
        if (typeof entry.provider !== 'string' || entry.provider.length === 0) return 'error.modelPolicies';
        if (typeof entry.model !== 'string' || entry.model.length === 0) return 'error.modelPolicies';
        const target = `${entry.provider}\u0000${entry.model}`;
        if (seen.has(target)) return 'error.modelPolicies';
        seen.add(target);
        const problem = policyFieldsProblem(entry, thresholdRatio, capContext);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }

    /** One FIELDS entry by key; a missing key is a programming error. */
    function fieldOf(key) {
      const field = FIELDS.find(candidate => candidate.key === key);
      if (field === undefined) throw new Error(`compaction-tuner: unknown field "${key}"`);
      return field;
    }

    /**
     * Validate the DRAFT locally, before any Host call. This is where every
     * cross-field rule the Host `tuneProblem()` enforces is mirrored: the
     * retention pair is either/or, the effective tail stays below the
     * threshold, the summarization target is a pair, the derived summary cap
     * stays positive, and the `modelPolicies` table obeys the upstream rules.
     * A blank optional field means "unset", and the returned `values` carries
     * `undefined` for it so the write submits an `unset` op.
     * @param draft - the input texts, one per FIELDS entry.
     * @param blankMeansUnset - the Reset action's mode: a blank field of ANY key
     *   submits `unset` instead of being refused, and the cross-field checks
     *   resolve it to its upstream code default.
     * @returns `{ values }` when the draft is writable, otherwise
     *   `{ key }` naming the localized refusal.
     */
    function validateDraft(draft, blankMeansUnset = false) {
      const thresholdText = typeof draft.thresholdRatio === 'string' ? draft.thresholdRatio.trim() : '';
      const thresholdRatio = thresholdText === '' ? undefined : parseNumber(thresholdText);
      if (thresholdText === '') {
        if (!blankMeansUnset) return { key: 'error.thresholdRange' };
      } else if (thresholdRatio === undefined || !(thresholdRatio > 0 && thresholdRatio <= 1)) {
        return { key: 'error.thresholdRange' };
      }
      const headroomText = typeof draft.headroomTokens === 'string' ? draft.headroomTokens.trim() : '';
      const headroomTokens = headroomText === '' ? undefined : parseInteger(fieldOf('headroomTokens'), headroomText);
      if (headroomText === '') {
        if (!blankMeansUnset) return { key: 'error.headroomTokens' };
      } else if (headroomTokens === undefined) {
        return { key: 'error.headroomTokens' };
      }
      const ratioText = typeof draft.retainRatio === 'string' ? draft.retainRatio.trim() : '';
      const retainRatio = ratioText === '' ? undefined : parseNumber(ratioText);
      if (ratioText !== '' && (retainRatio === undefined || !(retainRatio > 0 && retainRatio <= 1))) {
        return { key: 'error.retainRange' };
      }
      const tokensText = typeof draft.retainTokens === 'string' ? draft.retainTokens.trim() : '';
      const retainTokens = tokensText === '' ? undefined : parseInteger(fieldOf('retainTokens'), tokensText);
      if (tokensText !== '' && retainTokens === undefined) return { key: 'error.retainTokens' };
      if (retainRatio !== undefined && retainTokens !== undefined) return { key: 'error.retentionExclusive' };
      if (retainTokens === undefined) {
        const effectiveRatio = retainRatio === undefined ? DEFAULT_RETAIN_RATIO : retainRatio;
        const effectiveThreshold = thresholdRatio === undefined ? DEFAULT_THRESHOLD_RATIO : thresholdRatio;
        if (!(effectiveRatio < effectiveThreshold)) return { key: 'error.retainOrder' };
      }
      const maxText = typeof draft.maxTokens === 'string' ? draft.maxTokens.trim() : '';
      const maxTokens = maxText === '' ? undefined : parseInteger(fieldOf('maxTokens'), maxText);
      if (maxText !== '' && maxTokens === undefined) return { key: 'error.maxTokens' };
      const effectiveHeadroom = headroomTokens === undefined ? DEFAULT_HEADROOM_TOKENS : headroomTokens;
      const resolvedMaxTokens = maxTokens === undefined ? effectiveHeadroom : maxTokens;
      if (!isSafeInteger(resolvedMaxTokens) || resolvedMaxTokens < 1) return { key: 'error.maxTokensResolved' };
      const retriesText = typeof draft.compactionRetries === 'string' ? draft.compactionRetries.trim() : '';
      const compactionRetries = retriesText === '' ? undefined : parseInteger(fieldOf('compactionRetries'), retriesText);
      if (retriesText === '') {
        if (!blankMeansUnset) return { key: 'error.compactionRetries' };
      } else if (compactionRetries === undefined) {
        return { key: 'error.compactionRetries' };
      }
      const overflowText = typeof draft.maxOverflowRetries === 'string' ? draft.maxOverflowRetries.trim() : '';
      const maxOverflowRetries = overflowText === '' ? undefined : parseInteger(fieldOf('maxOverflowRetries'), overflowText);
      if (overflowText === '') {
        if (!blankMeansUnset) return { key: 'error.overflowRetries' };
      } else if (maxOverflowRetries === undefined) {
        return { key: 'error.overflowRetries' };
      }
      const providerText = typeof draft.summarizationProvider === 'string' ? draft.summarizationProvider : '';
      const modelText = typeof draft.summarizationModel === 'string' ? draft.summarizationModel : '';
      if ((providerText.length === 0) !== (modelText.length === 0)) {
        return { key: 'error.summarizationPair' };
      }
      const policiesText = typeof draft.modelPolicies === 'string' && draft.modelPolicies.trim() !== ''
        ? draft.modelPolicies
        : '[]';
      let entries;
      try {
        entries = JSON.parse(policiesText);
      } catch (_malformedJson) {
        return { key: 'error.modelPoliciesJson' };
      }
      if (!Array.isArray(entries)) return { key: 'error.modelPolicies' };
      // The picker's boxes hold raw text, so every policy value is normalized
      // here (decimal-only numbers, safe integers, strings verbatim) before the
      // table reaches `modelPoliciesProblem()`. An entry whose nine boxes are all
      // empty is DROPPED: a provider/model-only row would make the table managed
      // and replace every preset's own overrides while changing nothing.
      const modelPolicies = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { key: 'error.modelPolicies' };
        if (typeof entry.provider !== 'string' || entry.provider === '') return { key: 'error.modelPolicies' };
        if (typeof entry.model !== 'string' || entry.model === '') return { key: 'error.modelPolicies' };
        const normalized = { ...entry };
        // The nine owned keys are re-normalized from their raw box text; any
        // OTHER key the stored entry carries is preserved verbatim so
        // `modelPoliciesProblem()` still refuses it instead of the editor
        // silently laundering it away.
        for (const key of PER_MODEL_KEYS) delete normalized[key];
        normalized.provider = entry.provider;
        normalized.model = entry.model;
        for (const key of PER_MODEL_KEYS) {
          const raw = entry[key];
          if (raw === undefined || raw === null || raw === '') continue;
          const policyField = fieldOf(key);
          const value = policyField.kind === 'string'
            ? String(raw).trim()
            : policyField.kind === 'integer'
              ? parseInteger(policyField, String(raw))
              : parseNumber(String(raw));
          if (value === undefined || (policyField.kind === 'string' && value === '')) return { key: 'error.modelPolicies' };
          normalized[key] = value;
        }
        if (Object.keys(normalized).length > 2) modelPolicies.push(normalized);
      }
      const policiesProblem = modelPoliciesProblem(modelPolicies, thresholdRatio, {
        maxTokensExplicit: maxText !== '',
        resolvedMaxTokens,
      });
      if (policiesProblem !== undefined) return { key: policiesProblem };
      // An empty table means "leave each preset's own table alone" (host
      // `managesModelPolicies()`), so it is submitted as `unset` rather than as
      // an explicit empty array.
      return {
        values: {
          thresholdRatio,
          headroomTokens,
          retainRatio,
          retainTokens,
          summarizationProvider: blankMeansUnset && providerText.length === 0 ? undefined : providerText,
          summarizationModel: blankMeansUnset && modelText.length === 0 ? undefined : modelText,
          maxTokens,
          compactionRetries,
          maxOverflowRetries,
          modelPolicies: modelPolicies.length === 0 ? undefined : modelPolicies,
          auto: blankMeansUnset && (typeof draft.auto !== 'string' || draft.auto.trim() === '')
            ? undefined
            : draft.auto === 'true',
        },
      };
    }

    /**
     * Call one restart-channel endpoint through the injected caller, turning a
     * missing or throwing caller into a rejection so every branch is uniform.
     * @param callBackend - the injected channel caller.
     * @param endpoint - `status` or `restart`.
     * @param payload - request payload (always `{}` for this channel).
     * @param signal - abort signal for the call, when one is owned.
     * @returns the reply, or a rejected promise.
     */
    function callBackendSafely(callBackend, endpoint, payload, signal) {
      try {
        return Promise.resolve(callBackend(endpoint, payload, signal));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    /**
     * Resolve one wire failure code to the dictionary key of its product copy.
     * The diagnostic `message` a refusal carries is never product text.
     * @param code - the reply's `error.code`, when present.
     * @returns the localized-copy key.
     */
    function restartFailureKey(code) {
      switch (code) {
        case 'backend-restart/busy': return 'restart.error.busy';
        case 'backend-restart/unsupported': return 'restart.error.unsupported';
        case 'backend-restart/spawn-failed': return 'restart.error.spawnFailed';
        default: return 'restart.error.generic';
      }
    }

    /**
     * Read one `status` reply: only `restartable: true` offers the action.
     * @param result - the channel reply.
     * @returns `ready` or `manual`.
     */
    function statusOutcome(result) {
      if (result === null || typeof result !== 'object' || result.ok !== true) return 'manual';
      const value = result.value;
      return value !== null && typeof value === 'object' && value.restartable === true ? 'ready' : 'manual';
    }

    /**
     * Wait for the interval, or reject when the poll is aborted.
     * @param ms - delay in milliseconds.
     * @param signal - poll cancellation signal, when one is owned.
     * @returns a promise settling after the delay.
     */
    function delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal !== undefined && signal.aborted) {
          reject(new Error('compaction-tuner: restart poll aborted'));
          return;
        }
        const onAbort = () => {
          window.clearTimeout(timer);
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          reject(new Error('compaction-tuner: restart poll aborted'));
        };
        const timer = window.setTimeout(() => {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        if (signal !== undefined) signal.addEventListener('abort', onAbort);
      });
    }

    /**
     * Ask whether this backend can restart itself, retrying a transport miss a
     * bounded number of times so one transient failure does not hide the
     * action. A definitive refusal is not retried.
     * @param callBackend - the injected channel caller.
     * @param signal - abort signal owned by the mounted section.
     * @returns a promise of `ready`, `manual`, or `aborted`.
     */
    function probeRestartable(callBackend, signal) {
      const aborted = () => signal !== undefined && signal.aborted;
      const attempt = (remaining) => callBackendSafely(callBackend, 'status', {}, signal).then(
        (result) => (aborted() ? 'aborted' : statusOutcome(result)),
        () => {
          if (aborted()) return 'aborted';
          if (remaining <= 1) return 'manual';
          return delay(STATUS_RETRY_MS, signal).then(() => attempt(remaining - 1), () => 'aborted');
        },
      );
      return attempt(STATUS_ATTEMPTS);
    }

    /**
     * Ask the current document root whether anything answers at all.
     * @param url - document root to probe.
     * @param signal - poll cancellation signal, when one is owned.
     * @returns whether the request resolved before its own timeout.
     */
    function probeRoot(url, signal) {
      const controller = new window.AbortController();
      const timer = window.setTimeout(() => { controller.abort(); }, PROBE_TIMEOUT_MS);
      const forward = () => { controller.abort(); };
      if (signal !== undefined && signal.aborted) forward();
      else if (signal !== undefined) signal.addEventListener('abort', forward);
      return window.fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      }).then(
        () => true,
        // A refused, reset, or timed-out probe is the "not answering yet" signal.
        () => false,
      ).then((answered) => {
        window.clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', forward);
        return answered;
      });
    }

    /**
     * Run the recovery sequence: poll the document root until the old listener
     * is gone, then until the successor answers.
     * @param signal - poll cancellation signal, when one is owned.
     * @returns `ready` when the successor answers, `timeout`, or `aborted`.
     */
    async function awaitSuccessor(signal) {
      const aborted = () => signal !== undefined && signal.aborted;
      const root = new window.URL('.', window.location.href).href;
      let gone = false;
      const downDeadline = Date.now() + DOWN_BUDGET_MS;
      while (Date.now() < downDeadline) {
        if (aborted()) return 'aborted';
        if (!(await probeRoot(root, signal))) {
          gone = true;
          break;
        }
        try {
          await delay(POLL_INTERVAL_MS, signal);
        } catch (_pollAborted) {
          return 'aborted';
        }
      }
      if (!gone) return 'timeout';
      const upDeadline = Date.now() + UP_BUDGET_MS;
      while (Date.now() < upDeadline) {
        if (aborted()) return 'aborted';
        if (await probeRoot(root, signal)) return 'ready';
        try {
          await delay(POLL_INTERVAL_MS, signal);
        } catch (_pollAborted) {
          return 'aborted';
        }
      }
      return 'timeout';
    }

    /**
     * The "Compaction tuner" settings page: the bold restart-required notice
     * and restart action, then one control per owned `compaction-basic` option
     * over the tuner's Host namespace, saved by one atomic mutation.
     * @param props - slot props.
     * @param props.form - shared config form for the `compaction-tuner` entry.
     * @param props.t - localized copy for this plugin's namespace.
     * @param props.callBackend - caller for the shared restart channel.
     * @param props.close - shell-owned panel exit; this page needs no exit of
     *   its own, so it never calls it. `readCatalog`, `connection` and `onConnectionReset` are the page's catalog seats.
     * @returns the section tree.
     */
    function TunerSection(props) {
      const { form, t, callBackend, readCatalog, connection, onConnectionReset } = props;
      // The controller's methods need their receiver, and uSES resubscribes
      // whenever `subscribe` identity changes, so both seats are memoized to
      // one stable pair per form rather than handing uSES the bare methods.
      const subscribe = useCallback(listener => form.subscribe(listener), [form]);
      const getSnapshot = useCallback(() => form.getSnapshot(), [form]);
      const snapshot = useSyncExternalStore(subscribe, getSnapshot);

      /* One stable id per field, in FIELDS order. The loop length is the frozen
       * FIELDS array, so the hook order never changes between renders. */
      const ids = {};
      for (const field of FIELDS) ids[field.key] = useId();

      const [editing, setEditing] = useState(null);
      const [edits, setEdits] = useState({});
      const [resetState, setResetState] = useState(null);
      const [saving, setSaving] = useState(false);
      const [outcome, setOutcome] = useState(null);
      const pendingRef = useRef(false);

      const [restartState, setRestartState] = useState('checking');
      const [restartFailure, setRestartFailure] = useState(null);
      const restartControllerRef = useRef(null);
      const restartPendingRef = useRef(false);

      /* One mount effect owns the availability probe and the abort signal that
       * every later call and poll rides: unmounting the section cancels a
       * restart already crossing the wire. */
      useEffect(() => {
        const controller = new window.AbortController();
        restartControllerRef.current = controller;
        let live = true;
        probeRestartable(callBackend, controller.signal).then((outcomeKey) => {
          if (!live || controller.signal.aborted) return;
          setRestartState(current => (current === 'checking' ? (outcomeKey === 'ready' ? 'ready' : 'manual') : current));
        });
        return () => {
          live = false;
          controller.abort();
        };
      }, [callBackend]);

      const [catalog, setCatalog] = useState({ status: 'loading', providers: [] });
      const [pickProvider, setPickProvider] = useState('');
      const [pickModel, setPickModel] = useState('');

      /* One mount effect reads the model catalog through the injected Remote
       * caller and re-reads it whenever a connection generation resets, so a
       * mount-time failure cannot outlive the connection it was made on.
       *
       * A genuine failure — a refused reply (`ok` not true) or a rejected
       * promise — is retried twice with backoff (300ms, then 1200ms) before it
       * settles on the load-error note, so a transient refusal cannot leave a
       * dead picker. The plugin's own `compaction-tuner/remote-unavailable`
       * reply is never retried: the Remote service is absent, so another call
       * cannot succeed and the page must make no further call at all in that
       * case (the offline suite pins exactly zero calls there). The abort
       * controller still cancels an in-flight read, and every pending retry.
       *
       * A missing service, a refused reply, a rejection and an empty catalog
       * each degrade to their own localized note; the rest of the page — and
       * any already-stored override — keeps working. */
      useEffect(() => watchCatalog({
        read: readCatalog,
        connection,
        onReset: onConnectionReset,
        onState: setCatalog,
      }), [readCatalog, connection, onConnectionReset]);

      const status = snapshot === undefined || snapshot === null || typeof snapshot.status !== 'string'
        ? 'loading'
        : snapshot.status;
      const ready = status === 'ready';
      const writable = ready && snapshot.writable !== false;
      const disabled = !ready || !writable;
      const value = snapshot === undefined || snapshot === null ? undefined : snapshot.value;

      /* Re-seed rule: the canonical text is always derived from the current
       * snapshot; a staged edit is shown only while it was staged against that
       * snapshot (same revision and value) or while its input still has focus.
       * A snapshot change therefore re-seeds every field the user is not
       * editing, which is what surfaces a refused write's recovery read. */
      const seedKey = ready ? `${String(snapshot.revision)}|${JSON.stringify(value ?? null)}` : '';
      // The Reset action's mode holds only for the snapshot it was pressed on:
      // a recovery read (new seedKey) drops it, so a stale reset can never turn
      // a later save into an all-unset write.
      const resetMode = resetState !== null && resetState.seedKey === seedKey;
      const baseline = ready ? seedDraft(value) : blankDraft();
      const shown = (field) => {
        const edit = edits[field];
        if (edit !== undefined && (edit.seedKey === seedKey || editing === field)) return edit.text;
        return baseline[field];
      };
      const draft = {};
      for (const field of FIELDS) draft[field.key] = shown(field.key);
      const dirty = ready && FIELDS.some(field => draft[field.key] !== baseline[field.key]);

      /* The per-model editor works on the same `modelPolicies` draft text the
       * JSON field used to hold: the picker adds a `{provider, model}` entry,
       * each option box writes its own raw text into that entry, and the Save
       * path normalizes the text once (see `validateDraft`). */
      const policyEntries = () => {
        try {
          const parsed = JSON.parse(draft.modelPolicies === '' ? '[]' : draft.modelPolicies);
          return Array.isArray(parsed)
            ? parsed.filter(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
            : [];
        } catch (_malformedPolicies) {
          return [];
        }
      };
      const providers = catalog.providers;
      const activeProvider = providers.some(provider => provider.id === pickProvider)
        ? pickProvider
        : (providers[0] === undefined ? '' : providers[0].id);
      const activeModels = (providers.find(provider => provider.id === activeProvider)?.models ?? []);
      const activeModel = activeModels.some(model => model.id === pickModel)
        ? pickModel
        : (activeModels[0] === undefined ? '' : activeModels[0].id);
      const entries = policyEntries();
      const pairPresent = entries.some(entry => entry.provider === activeProvider && entry.model === activeModel);

      /**
       * Stage one control's text; the snapshot it was staged against rides along
       * so a later snapshot change can drop the stale edit. A checkbox reports
       * the boolean through `checked`, never through `value`.
       * @param key - the FIELDS key being edited.
       * @param text - the raw input text to stage.
       */
      const stage = (key, text) => {
        setEdits(current => ({ ...current, [key]: { text, seedKey } }));
        setOutcome(null);
      };

      /**
       * Stage one control's event text.
       * @param field - the FIELDS entry being edited.
       * @param event - the control's change event.
       */
      const change = field => (event) => {
        const text = field.kind === 'boolean'
          ? (event.target.checked === true ? 'true' : 'false')
          : event.target.value;
        stage(field.key, text);
      };

      /** Write the whole per-model entries array back into the draft JSON text. */
      const writePolicies = (next) => { stage('modelPolicies', JSON.stringify(next)); };

      /** Set one option box of one entry; blank removes the key. */
      const setPolicyBox = (index, key, text) => {
        const next = policyEntries().map(entry => ({ ...entry }));
        const entry = next[index];
        if (entry === undefined) return;
        if (text === '') delete entry[key];
        else entry[key] = text;
        writePolicies(next);
      };

      /** Append the currently selected provider/model as a new override. */
      const addPolicy = () => {
        if (disabled || activeProvider === '' || activeModel === '' || pairPresent) return;
        writePolicies([...policyEntries(), { provider: activeProvider, model: activeModel }]);
      };

      /** Remove one override; removing the last one returns the table to `unset`. */
      const removePolicy = (index) => {
        writePolicies(policyEntries().filter((_entry, position) => position !== index));
      };

      /**
       * Replace the whole draft with the system-default (unset) state: every
       * managed field blank, the per-model table empty. This writes NOTHING —
       * the user reviews it and presses Save, which then submits one `unset` op
       * per managed key (`resetMode` makes a blank field of ANY key an unset).
       */
      const resetDraft = () => {
        if (disabled || saving || pendingRef.current) return;
        const next = { ...edits };
        for (const field of FIELDS) {
          next[field.key] = { text: field.kind === 'json' ? '[]' : '', seedKey };
        }
        setEdits(next);
        setResetState({ seedKey });
        setOutcome(null);
      };

      /**
       * Validate the draft and submit every field as one atomic write. A blank
       * optional field becomes an `unset` op: the tuner's schema gives
       * `retainRatio`, `retainTokens` and `maxTokens` no default on purpose, so
       * `unset` is what restores "unset upstream" instead of materializing one
       * side of the retention XOR. In `resetMode` a blank field of ANY key is
       * an `unset`, which is how the Reset action clears the materialized
       * defaults that would otherwise keep an old row alive.
       */
      const save = () => {
        if (disabled || saving || pendingRef.current) return;
        const check = validateDraft(draft, resetMode);
        if (check.values === undefined) {
          setOutcome({ kind: 'invalid', key: check.key });
          return;
        }
        setOutcome(null);
        pendingRef.current = true;
        setSaving(true);
        const ops = FIELDS.map((field) => {
          const fieldValue = check.values[field.key];
          return fieldValue === undefined
            ? { op: 'unset', path: [field.key] }
            : { op: 'set', path: [field.key], value: fieldValue };
        });
        form.mutate(ops, snapshot.revision).then(
          (accepted) => {
            pendingRef.current = false;
            setSaving(false);
            // The write's outcome owns the draft: the next snapshot (the
            // accepted view, or the controller's recovery read) re-seeds it.
            setEdits({});
            setResetState(null);
            setOutcome(accepted === true ? { kind: 'saved' } : { kind: 'refused' });
          },
          () => {
            pendingRef.current = false;
            setSaving(false);
            setEdits({});
            setResetState(null);
            setOutcome({ kind: 'refused' });
          },
        );
      };

      /** Open the inline confirmation; a native dialog is never used. */
      const openConfirm = () => {
        if (saving || restartState !== 'ready') return;
        setRestartFailure(null);
        setRestartState('confirming');
      };

      /** Dismiss the inline confirmation without touching the channel. */
      const cancelRestart = () => {
        setRestartState(current => (current === 'confirming' ? 'ready' : current));
      };

      /** Manual fallback after the recovery budget expired. */
      const reloadPage = () => { window.location.reload(); };

      /**
       * Poll until the successor answers, then reload; a bounded timeout lands
       * on the manual-reload guidance instead of a dead page.
       * @param signal - abort signal owned by the mounted section.
       */
      const recover = (signal) => {
        void awaitSuccessor(signal).then((result) => {
          if (signal !== undefined && signal.aborted) return;
          if (result === 'ready') {
            reloadPage();
            return;
          }
          if (result === 'timeout') setRestartState('timeout');
        });
      };

      /** Confirm: one restart call; a lost reply is "possibly restarting". */
      const confirmRestart = () => {
        if (restartState !== 'confirming' || restartPendingRef.current) return;
        restartPendingRef.current = true;
        setRestartFailure(null);
        setRestartState('restarting');
        const controller = restartControllerRef.current;
        const signal = controller === null ? undefined : controller.signal;
        callBackendSafely(callBackend, 'restart', {}, signal).then(
          (result) => {
            restartPendingRef.current = false;
            if (result !== null && typeof result === 'object' && result.ok === false) {
              const error = result.error;
              const code = error !== null && typeof error === 'object' ? error.code : undefined;
              setRestartState('ready');
              setRestartFailure(restartFailureKey(code));
              return;
            }
            recover(signal);
          },
          () => {
            restartPendingRef.current = false;
            /* The process can exit before its reply reaches the browser, so a
             * transport rejection is not proof the restart failed: recover. */
            recover(signal);
          },
        );
      };

      const restartActionDisabled = saving || restartState !== 'ready';
      const strongNote = h('strong', { className: 'dct-restart-note' }, t('restart.note'));
      const restartAlert = restartFailure === null
        ? null
        : h('p', { className: 'dct-alert', role: 'alert' }, t(restartFailure));
      const restartAction = h('button', {
        type: 'button',
        className: 'dct-button',
        disabled: restartActionDisabled,
        onClick: openConfirm,
      }, restartState === 'restarting' ? t('restart.restarting') : t('restart.action'));
      const manualNote = restartState === 'manual'
        ? h('span', { className: 'dct-restart-manual' }, t('restart.manual'))
        : null;
      const confirmBlock = h('div', {
        className: 'dct-confirm', role: 'group', 'aria-label': t('restart.confirmLabel'),
      },
        h('p', { className: 'dct-confirm-text' }, t('restart.confirm')),
        h('div', { className: 'dct-confirm-actions' },
          h('button', { type: 'button', className: 'dct-button dct-outline', onClick: cancelRestart }, t('restart.cancel')),
          h('button', { type: 'button', className: 'dct-button', onClick: confirmRestart }, t('restart.confirmAction')),
        ),
      );
      const timeoutBlock = h('div', { className: 'dct-restart-block' },
        h('p', { className: 'dct-restart-timeout' }, t('restart.timeout')),
        h('button', { type: 'button', className: 'dct-button', onClick: reloadPage }, t('restart.reload')),
      );
      // The bold note renders in EVERY state, confirming and timeout included:
      // it is a fact about this plugin, not about the channel.
      const restartBlock = restartState === 'confirming'
        ? h('div', { className: 'dct-restart' },
          h('div', { className: 'dct-restart-row' }, strongNote),
          confirmBlock,
          restartAlert,
        )
        : restartState === 'timeout'
          ? h('div', { className: 'dct-restart' },
            h('div', { className: 'dct-restart-row' }, strongNote),
            timeoutBlock,
            restartAlert,
          )
          : h('div', { className: 'dct-restart' },
            h('div', { className: 'dct-restart-row' },
              strongNote,
              h('div', { className: 'dct-restart-action' }, restartAction, manualNote),
            ),
            restartAlert,
          );

      if (status === 'loading') {
        return h('div', { className: 'dct-page' },
          h('style', null, STYLE_TEXT),
          h('p', { className: 'dct-note' }, t('status.loading')),
          restartBlock,
        );
      }

      /**
       * One override row: its provider/model heading, a remove action, and one
       * labelled box per policy option. The boxes render the raw draft text, so
       * an intermediate value the user is still typing is never rewritten.
       * @param entry - one `modelPolicies` entry from the draft.
       * @param index - its position, which addresses its boxes.
       * @returns the entry card.
       */
      const policyEntryRow = (entry, index) => {
        const provider = typeof entry.provider === 'string' ? entry.provider : '';
        const model = typeof entry.model === 'string' ? entry.model : '';
        const known = providers.some(candidate => candidate.id === provider
          && candidate.models.some(candidateModel => candidateModel.id === model));
        const boxes = PER_MODEL_KEYS.map((key) => {
          const policyField = fieldOf(key);
          const boxId = `${ids.modelPolicies}-${index}-${key}`;
          const raw = entry[key];
          const shared = {
            id: boxId,
            className: 'dct-input',
            disabled,
            value: raw === undefined || raw === null ? '' : String(raw),
            onChange: (event) => { setPolicyBox(index, key, event.target.value); },
          };
          const control = policyField.kind === 'string'
            ? h('input', { ...shared, type: 'text' })
            : h('input', {
              ...shared,
              type: 'number',
              inputMode: 'decimal',
              step: policyField.kind === 'ratio' ? 0.01 : 1,
              min: policyField.kind === 'ratio' ? 0.01 : policyField.min,
              max: policyField.kind === 'ratio' ? 1 : undefined,
            });
          return h('div', { className: 'dct-policy', key },
            h('label', { className: 'dct-policy-label', htmlFor: boxId }, t(`field.${key}.label`)),
            control,
          );
        });
        return h('div', { className: 'dct-permodel-entry', key: `${String(index)}:${provider}\u0000${model}` },
          h('div', { className: 'dct-permodel-head' },
            h('span', { className: 'dct-permodel-target' },
              known ? `${provider} / ${model}` : `${provider} / ${model} \u2014 ${t('perModel.outOfCatalog')}`),
            h('button', {
              type: 'button',
              className: 'dct-button dct-outline',
              disabled,
              onClick: () => { removePolicy(index); },
            }, t('perModel.remove')),
          ),
          h('div', { className: 'dct-permodel-grid' }, boxes),
        );
      };

      /**
       * The composite `modelPolicies` editor: a provider/model picker fed only
       * by the catalog, and one entry card per stored override. A pair that
       * already has an override cannot be added; an entry the catalog does not
       * know stays listed (and removable), so a saved override is never
       * silently dropped.
       * @returns the editor node.
       */
      const perModelField = () => {
        const catalogNote = catalog.status === 'loading' ? 'perModel.loading'
          : catalog.status === 'unavailable' ? 'perModel.unavailable'
            : catalog.status === 'error' ? 'perModel.error'
              : catalog.status === 'empty' ? 'perModel.empty'
                : null;
        return h('div', { className: 'dct-permodel', id: ids.modelPolicies, 'aria-describedby': `${ids.modelPolicies}-description` },
          h('span', { className: 'dct-permodel-target' }, t('perModel.heading')),
          h('p', { className: 'dct-description' }, t('perModel.description')),
          catalog.status === 'ready'
            ? h('div', { className: 'dct-permodel-picker' },
              h('label', { className: 'dct-policy-label', htmlFor: `${ids.modelPolicies}-provider` }, t('perModel.provider')),
              h('select', {
                id: `${ids.modelPolicies}-provider`,
                className: 'dct-select',
                disabled,
                value: activeProvider,
                onChange: (event) => { setPickProvider(event.target.value); setPickModel(''); },
              }, providers.map(provider => h('option', { key: provider.id, value: provider.id }, provider.name))),
              h('label', { className: 'dct-policy-label', htmlFor: `${ids.modelPolicies}-model` }, t('perModel.model')),
              h('select', {
                id: `${ids.modelPolicies}-model`,
                className: 'dct-select',
                disabled,
                value: activeModel,
                onChange: (event) => { setPickModel(event.target.value); },
              }, activeModels.map(model => h('option', { key: model.id, value: model.id }, model.name))),
              h('button', {
                type: 'button',
                className: 'dct-button dct-outline',
                disabled: disabled || activeProvider === '' || activeModel === '' || pairPresent,
                onClick: addPolicy,
              }, t('perModel.add')),
            )
            : null,
          catalogNote === null ? null : h('p', { className: 'dct-note' }, t(catalogNote)),
          entries.length === 0
            ? h('p', { className: 'dct-empty' }, t('perModel.none'))
            : h('div', { className: 'dct-permodel-list' }, entries.map(policyEntryRow)),
        );
      };

      /**
       * One labelled control: a numeric input for `ratio`/`integer`, a text
       * input for `string`, a checkbox for `boolean`, and the provider/model
       * picker for the `modelPolicies` table. The head shows the allowed range,
       * and the footer shows the upstream code default beside the description.
       * An empty `retainRatio` shows its effective code default as a
       * placeholder, so the blank value and the value actually in force are
       * both visible.
       * @param field - one FIELDS entry.
       * @returns the field row.
       */
      const fieldRow = field => {
        const key = field.key;
        const describedBy = `${ids[key]}-description`;
        const shared = {
          id: ids[key],
          disabled,
          'aria-describedby': describedBy,
          onFocus: () => { setEditing(key); },
          onBlur: () => { setEditing(current => (current === key ? null : current)); },
        };
        let control;
        if (field.kind === 'boolean') {
          control = h('input', {
            ...shared,
            className: 'dct-check',
            type: 'checkbox',
            checked: draft[key] === 'true',
            onChange: change(field),
          });
        } else if (field.kind === 'json') {
          control = perModelField();
        } else {
          const numeric = field.kind !== 'string';
          control = h('input', {
            ...shared,
            className: 'dct-input',
            type: numeric ? 'number' : 'text',
            inputMode: numeric ? 'decimal' : undefined,
            step: field.kind === 'ratio' ? 0.01 : field.kind === 'integer' ? 1 : undefined,
            min: field.kind === 'ratio' ? 0.01 : numeric ? field.min : undefined,
            max: field.kind === 'ratio' ? 1 : undefined,
            // A browser shows this only while the input is empty, so the
            // effective code default of an unset `retainRatio` is visible
            // without loading the value into the field: the input still
            // submits `unset`, and the retention XOR stays expressible.
            placeholder: field.key === 'retainRatio' ? String(DEFAULT_RETAIN_RATIO) : undefined,
            value: draft[key],
            onChange: change(field),
          });
        }
        return h('div', { className: 'dct-field', key },
          h('div', { className: 'dct-field-head' },
            h('label', { className: 'dct-field-label', htmlFor: ids[key], 'data-nondefault': isNonDefaultText(field, draft[key]) ? 'true' : undefined }, t(`field.${key}.label`)),
            h('span', { className: 'dct-unit' }, t(`field.${key}.unit`)),
          ),
          control,
          h('p', { className: 'dct-description', id: describedBy }, t(`field.${key}.description`)),
          h('span', { className: 'dct-default' }, t(`field.${key}.default`)),
        );
      };

      const alert = outcome !== null && outcome.kind === 'invalid'
        ? h('p', { className: 'dct-alert', role: 'alert' }, t(outcome.key))
        : outcome !== null && outcome.kind === 'refused'
          ? h('p', { className: 'dct-alert', role: 'alert' }, t('error.refused'))
          : null;

      return h('div', { className: 'dct-page' },
        h('style', null, STYLE_TEXT),
        h('header', { className: 'dct-header' },
          h('h2', { className: 'dct-title' }, t('title')),
          h('p', { className: 'dct-intro' }, t('intro')),
        ),
        status === 'unavailable'
          ? h('p', { className: 'dct-note' }, t('status.unavailable'))
          : null,
        !ready || writable ? null : h('p', { className: 'dct-note' }, t('status.readOnly')),
        ready ? h('p', { className: 'dct-note' }, t('note.defaults')) : null,
        ready && (draft.modelPolicies.trim() === '' || draft.modelPolicies.trim() === '[]')
          ? h('p', { className: 'dct-note' }, t('note.modelPolicies'))
          : null,
        FIELDS.map(fieldRow),
        alert,
        h('div', { className: 'dct-actions' },
          h('button', {
            type: 'button',
            className: 'dct-button',
            disabled: disabled || saving || !dirty,
            'aria-busy': saving ? 'true' : undefined,
            onClick: save,
          }, saving ? t('action.saving') : t('action.save')),
          h('button', {
            type: 'button',
            className: 'dct-button dct-outline',
            disabled: disabled || saving,
            onClick: resetDraft,
          }, t('action.resetDefaults')),
        ),
        ready ? h('p', { className: 'dct-note' }, t('note.resetDefaults')) : null,
        restartBlock,
      );
    }

    const plugin = {
      name: '@local/dsh-compaction-tuner',
      inject: ['slots', 'locale', 'configForms', 'connection', 'remote'],
      /**
       * Register the plugin dictionaries and the Compaction-tuner settings
       * section. The restart channel is resolved lazily inside the caller, so a
       * composition without it still registers the page, which then degrades to
       * the manual-restart copy.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), '@local/dsh-compaction-tuner: dictionaries');
        const form = ctx.configForms.get(NS);
        const t = ctx.locale.bind(NS);
        const callBackend = (endpoint, payload, signal) => {
          const connection = ctx.get('connection');
          if (connection === undefined || connection === null || connection.rpc === undefined
            || connection.rpc === null || typeof connection.rpc.call !== 'function') {
            return Promise.reject(new Error('compaction-tuner: the shared Connection service is unavailable'));
          }
          return connection.rpc.call(RESTART_CHANNEL, endpoint, payload, signal);
        };
        // Re-read the catalog whenever an established connection resets.
        const onConnectionReset = catalogResetSeat(ctx);
        /**
         * Read the provider-grouped model catalog through the client Remote
         * service; a missing service or an unexpected envelope resolves to a
         * refused result so the picker renders its own note.
         * @returns the Remote result envelope.
         */
        const readCatalog = () => {
          const remote = ctx.get('remote');
          if (remote === undefined || remote === null
            || remote.session === undefined || remote.session === null
            || typeof remote.session.modelCatalog !== 'function') {
            return Promise.resolve({
              ok: false,
              error: { code: 'compaction-tuner/remote-unavailable', message: 'the client Remote service does not expose session.modelCatalog' },
            });
          }
          try {
            return Promise.resolve(remote.session.modelCatalog());
          } catch (error) {
            return Promise.reject(error);
          }
        };
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          // `label` is required: an omitted label renders an empty nav row.
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ form, t, callBackend, readCatalog, connection: ctx.get('connection'), onConnectionReset }),
        }, TunerSection));
      },
    };

    /**
     * Whether the text SHOWN for one option deviates from that option's code
     * default — which is what a bold option LABEL marks. A blank field means
     * "unset", and the code default then applies, so a blank is never a
     * deviation (that covers `retainTokens`/`maxTokens`, whose code default is
     * itself `undefined`). `modelPolicies` is the composite field: the empty
     * table (`''` or `'[]'`) is the default, and any listed override deviates.
     * The marking rides on the label's `data-nondefault` attribute, styled in
     * STYLE_TEXT, so the label's className and its single direct text child —
     * both asserted exactly by the offline suite — never change.
     *
     * Declared below the last line CONTRACT.md cites (`client.js:1492`) on
     * purpose: `verify.mjs:898` resolves every documentation citation against
     * the current file, so a helper inserted mid-file would invalidate the
     * frozen citation set and fail the suite.
     * @param field - one FIELDS entry; it carries the mirrored code default.
     * @param text - the option's current draft text, exactly as shown.
     * @returns true when the shown value differs from the code default.
     */
    function isNonDefaultText(field, text) {
      const shown = typeof text === 'string' ? text.trim() : '';
      if (shown === '') return false;
      if (field.kind === 'json') {
        try {
          const parsed = JSON.parse(shown);
          return !(Array.isArray(parsed) && parsed.length === 0);
        } catch (_malformedPolicies) {
          // A table the user is still typing is not the empty default either.
          return true;
        }
      }
      if (field.default === undefined) return true;
      return shown !== String(field.default);
    }

    /**
     * The backoff between catalog read attempts: at most 1 + two calls, so a
     * transient mount-time refusal cannot spin against a failing gateway.
     */
    const CATALOG_RETRY_DELAYS = [300, 1200];

    /**
     * The diagnostic form of one failed `session.modelCatalog()` attempt. The
     * refusal code, its message and the raw reply (or the rejection value) used
     * to be discarded, which left the page's `perModel.error` note
     * undiagnosable; `watchCatalog` emits this beside its console line instead.
     * @param result - the refused reply, or the rejection value.
     * @returns `{code, message, reply}`, with `code` possibly `undefined`.
     */
    function catalogFailure(result) {
      const error = result !== null && typeof result === 'object' ? result.error : undefined;
      if (error !== null && typeof error === 'object') {
        return { code: error.code, message: error.message, reply: result };
      }
      // Duck-typed, not `instanceof Error`: a rejection can cross the vm realm
      // the harness mounts this client in, where that check is always false.
      const message = result !== null && typeof result === 'object' && typeof result.message === 'string'
        ? result.message
        : String(result);
      return { code: undefined, message, reply: result };
    }

    /**
     * The page's `connection/reset` seat. Every established connection
     * generation emits that context event
     * (`packages/client/connection/src/client/index.ts:28`), which is how the
     * in-tree pages re-pull their wire-derived caches; re-reading the catalog
     * on it is what keeps a mount-time failure from sticking. The context
     * listener exists only while a page seat is subscribed, and a context with
     * no event bus (the offline harness double) simply never fires.
     * @param ctx - the client root context.
     * @returns a subscribe function that returns its own disposer.
     */
    function catalogResetSeat(ctx) {
      const seats = new Set();
      let unsubscribe = null;
      return seat => {
        seats.add(seat);
        if (unsubscribe === null && typeof ctx.on === 'function') {
          const disposer = ctx.on('connection/reset', () => { for (const listener of [...seats]) listener(); });
          unsubscribe = typeof disposer === 'function' ? disposer : null;
        }
        return () => {
          seats.delete(seat);
          if (seats.size === 0 && unsubscribe !== null) {
            const disposer = unsubscribe;
            unsubscribe = null;
            disposer();
          }
        };
      };
    }

    /**
     * Own one catalog read cycle: read once, retry a GENUINE failure at most
     * `CATALOG_RETRY_DELAYS.length` times with that backoff, and re-read from
     * scratch whenever the connection resets. The plugin's own
     * `compaction-tuner/remote-unavailable` reply is never retried: the Remote
     * service is absent, so another call cannot succeed, and the missing-service
     * case must make no call at all beyond the first.
     * @param read - the injected `readCatalog` caller.
     * @param connection - the injected Connection service, when it emits by itself.
     * @param onReset - the context `connection/reset` seat, when one is available.
     * @param onState - receives every resolved `{status, providers}` state.
     * @returns the effect cleanup: stops retries, aborts, unsubscribes.
     */
    function watchCatalog({ read, connection, onReset, onState }) {
      const controller = new window.AbortController();
      let live = true;
      let timer;
      const attempt = (retry) => {
        const settle = (result) => {
          if (!live || controller.signal.aborted) return;
          const state = catalogState(result);
          if (state.status === 'error') {
            console.error('[compaction-tuner] model catalog load failed', catalogFailure(result));
            if (retry < CATALOG_RETRY_DELAYS.length) {
              timer = window.setTimeout(() => { attempt(retry + 1); }, CATALOG_RETRY_DELAYS[retry]);
            }
          }
          onState(state);
        };
        Promise.resolve().then(() => read()).then(settle, settle);
      };
      attempt(0);
      const reRead = () => {
        if (!live || controller.signal.aborted) return;
        if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
        attempt(0);
      };
      const offSeat = typeof onReset === 'function' ? onReset(reRead) : undefined;
      const offConnection = typeof connection?.on === 'function' ? connection.on('connection/reset', reRead) : undefined;
      return () => {
        live = false;
        controller.abort();
        if (timer !== undefined) window.clearTimeout(timer);
        if (typeof offSeat === 'function') offSeat();
        if (typeof offConnection === 'function') offConnection();
      };
    }

    return plugin;
  },
});
