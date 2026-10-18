/**
 * Client half of @local/dsh-compaction-tuner: one Settings page that edits the
 * tuner's three values — `thresholdRatio`, `retainRatio`, and
 * `compactionRetries` — in ONE atomic write, plus a bold restart-required
 * notice and a restart action for the step that makes the saved values reach
 * the agent presets.
 *
 * Plain browser bundle (no build step): it self-registers with the page's
 * module loader and requests React, the only module-table entry it needs.
 * Values are read and written through `ctx.configForms.get('compaction-tuner')`
 * — the Host profile row that carries the tuner's config — so the page owns no
 * copy of another plugin's state and makes no cross-plugin value import.
 *
 * `retainRatio < thresholdRatio` couples two fields, so the draft is validated
 * locally first and then submitted as a single `form.mutate(ops, revision)`
 * (TODO.md §4.5). `mutate` resolves `false` on a Host refusal; the controller
 * then performs its own recovery read, so this page only surfaces the refusal
 * and re-seeds from whatever the Host reports next.
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

    /** The three tuner fields, in the order their ops are submitted. */
    const FIELDS = ['thresholdRatio', 'retainRatio', 'compactionRetries'];

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
      'field.thresholdRatio.label': 'Compaction threshold',
      'field.thresholdRatio.description': 'Share of the context budget at which compaction triggers.',
      'field.thresholdRatio.unit': 'ratio in (0, 1]',
      'field.retainRatio.label': 'Retained tail',
      'field.retainRatio.description': 'Share of the budget kept as the tail after compaction. It must stay below the compaction threshold.',
      'field.retainRatio.unit': 'ratio in (0, 1]',
      'field.compactionRetries.label': 'Compaction retries',
      'field.compactionRetries.description': 'How many times a failed compaction is retried before the turn continues.',
      'field.compactionRetries.unit': 'whole number \u2265 0',
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
      'error.retainRange': 'The retained tail must be greater than 0 and at most 1.',
      'error.retainOrder': 'The retained tail must be smaller than the compaction threshold.',
      'error.retriesInteger': 'Compaction retries must be a whole number not below 0.',
    };

    const zh = {
      'nav': '\u538b\u7f29\u8c03\u4f18',
      'title': '\u538b\u7f29\u8c03\u4f18',
      'intro': '\u4e3a\u5f53\u524d\u914d\u7f6e\u4e2d\u7684\u6bcf\u4e2a Agent \u9884\u8bbe\u7edf\u4e00\u8bbe\u7f6e\u3002\u4fdd\u5b58\u540e\u65b0\u5efa\u7684\u4f1a\u8bdd\u4f1a\u4f7f\u7528\u8fd9\u4e9b\u503c\uff1b\u6b63\u5728\u8fd0\u884c\u7684\u4f1a\u8bdd\u4fdd\u6301\u542f\u52a8\u65f6\u7684\u503c\u3002',
      'field.thresholdRatio.label': '\u538b\u7f29\u9608\u503c',
      'field.thresholdRatio.description': '\u89e6\u53d1\u538b\u7f29\u7684\u4e0a\u4e0b\u6587\u9884\u7b97\u5360\u6bd4\u3002',
      'field.thresholdRatio.unit': '0 \u5230 1 \u4e4b\u95f4\u7684\u6bd4\u4f8b',
      'field.retainRatio.label': '\u4fdd\u7559\u5c3e\u90e8\u6bd4\u4f8b',
      'field.retainRatio.description': '\u538b\u7f29\u540e\u4fdd\u7559\u4e3a\u5c3e\u90e8\u7684\u9884\u7b97\u5360\u6bd4\uff0c\u5fc5\u987b\u5c0f\u4e8e\u538b\u7f29\u9608\u503c\u3002',
      'field.retainRatio.unit': '0 \u5230 1 \u4e4b\u95f4\u7684\u6bd4\u4f8b',
      'field.compactionRetries.label': '\u538b\u7f29\u91cd\u8bd5\u6b21\u6570',
      'field.compactionRetries.description': '\u538b\u7f29\u5931\u8d25\u540e\u7ee7\u7eed\u91cd\u8bd5\u7684\u6b21\u6570\u3002',
      'field.compactionRetries.unit': '\u4e0d\u5c0f\u4e8e 0 \u7684\u6574\u6570',
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
      'error.retainRange': '\u4fdd\u7559\u5c3e\u90e8\u6bd4\u4f8b\u5fc5\u987b\u5927\u4e8e 0 \u4e14\u4e0d\u8d85\u8fc7 1\u3002',
      'error.retainOrder': '\u4fdd\u7559\u5c3e\u90e8\u6bd4\u4f8b\u5fc5\u987b\u5c0f\u4e8e\u538b\u7f29\u9608\u503c\u3002',
      'error.retriesInteger': '\u538b\u7f29\u91cd\u8bd5\u6b21\u6570\u5fc5\u987b\u662f\u4e0d\u5c0f\u4e8e 0 \u7684\u6574\u6570\u3002',
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
      '.dct-field-label { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }',
      '.dct-unit { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dct-input { box-sizing: border-box; width: 160px; height: 28px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }',
      '.dct-input:disabled { cursor: not-allowed; opacity: 0.4; }',
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
     * @param values - the snapshot's `value` section, possibly absent.
     * @param field - one of FIELDS.
     * @returns the field's text, or an empty string when the value is absent.
     */
    function fieldText(values, field) {
      const raw = values === null || values === undefined ? undefined : values[field];
      return raw === undefined || raw === null ? '' : String(raw);
    }

    /**
     * Seed every input from a snapshot value (blank while the value is absent).
     * @param values - the snapshot's `value` section, possibly absent.
     * @returns one input text per field.
     */
    function seedDraft(values) {
      return {
        thresholdRatio: fieldText(values, 'thresholdRatio'),
        retainRatio: fieldText(values, 'retainRatio'),
        compactionRetries: fieldText(values, 'compactionRetries'),
      };
    }

    /**
     * Parse one numeric input; blank and non-finite text yield `undefined`.
     * @param text - the raw input text.
     * @returns the finite number, or `undefined`.
     */
    function parseNumber(text) {
      if (typeof text !== 'string' || text.trim() === '') return undefined;
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }

    /**
     * Validate the DRAFT locally, before any Host call. This is the only place
     * the cross-field rule (`retainRatio < thresholdRatio`) is enforced
     * client-side; the Host enforces it again on the atomic write.
     * @param draft - the three input texts.
     * @returns `{ values }` when the draft is writable, otherwise
     *   `{ key }` naming the localized refusal.
     */
    function validateDraft(draft) {
      const thresholdRatio = parseNumber(draft.thresholdRatio);
      if (thresholdRatio === undefined || !(thresholdRatio > 0 && thresholdRatio <= 1)) {
        return { key: 'error.thresholdRange' };
      }
      const retainRatio = parseNumber(draft.retainRatio);
      if (retainRatio === undefined || !(retainRatio > 0 && retainRatio <= 1)) {
        return { key: 'error.retainRange' };
      }
      if (!(retainRatio < thresholdRatio)) return { key: 'error.retainOrder' };
      const compactionRetries = parseNumber(draft.compactionRetries);
      if (compactionRetries === undefined || !Number.isInteger(compactionRetries) || compactionRetries < 0) {
        return { key: 'error.retriesInteger' };
      }
      return { values: { thresholdRatio, retainRatio, compactionRetries } };
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
     * and restart action, then three numeric inputs over the tuner's Host
     * namespace, saved by one atomic mutation.
     * @param props - slot props.
     * @param props.form - shared config form for the `compaction-tuner` entry.
     * @param props.t - localized copy for this plugin's namespace.
     * @param props.callBackend - caller for the shared restart channel.
     * @param props.close - shell-owned panel exit; this page needs no exit of
     *   its own, so it never calls it (the contract still passes it).
     * @returns the section tree.
     */
    function TunerSection(props) {
      const { form, t, callBackend } = props;
      // The controller's methods need their receiver, and uSES resubscribes
      // whenever `subscribe` identity changes, so both seats are memoized to
      // one stable pair per form rather than handing uSES the bare methods.
      const subscribe = useCallback(listener => form.subscribe(listener), [form]);
      const getSnapshot = useCallback(() => form.getSnapshot(), [form]);
      const snapshot = useSyncExternalStore(subscribe, getSnapshot);

      const thresholdId = useId();
      const retainId = useId();
      const retriesId = useId();
      const ids = {
        thresholdRatio: thresholdId,
        retainRatio: retainId,
        compactionRetries: retriesId,
      };

      const [editing, setEditing] = useState(null);
      const [edits, setEdits] = useState({});
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
      const baseline = ready
        ? seedDraft(value)
        : { thresholdRatio: '', retainRatio: '', compactionRetries: '' };
      const shown = (field) => {
        const edit = edits[field];
        if (edit !== undefined && (edit.seedKey === seedKey || editing === field)) return edit.text;
        return baseline[field];
      };
      const draft = {
        thresholdRatio: shown('thresholdRatio'),
        retainRatio: shown('retainRatio'),
        compactionRetries: shown('compactionRetries'),
      };
      const dirty = ready && FIELDS.some(field => draft[field] !== baseline[field]);

      /**
       * Stage one input's text; the snapshot it was staged against rides along
       * so a later snapshot change can drop the stale edit.
       * @param field - the field being edited.
       * @param event - the input's change event.
       */
      const change = field => (event) => {
        const text = event.target.value;
        setEdits(current => ({ ...current, [field]: { text, seedKey } }));
        setOutcome(null);
      };

      /** Validate the draft and submit all three fields as one atomic write. */
      const save = () => {
        if (disabled || saving || pendingRef.current) return;
        const check = validateDraft(draft);
        if (check.values === undefined) {
          setOutcome({ kind: 'invalid', key: check.key });
          return;
        }
        setOutcome(null);
        pendingRef.current = true;
        setSaving(true);
        form.mutate([
          { op: 'set', path: ['thresholdRatio'], value: check.values.thresholdRatio },
          { op: 'set', path: ['retainRatio'], value: check.values.retainRatio },
          { op: 'set', path: ['compactionRetries'], value: check.values.compactionRetries },
        ], snapshot.revision).then(
          (accepted) => {
            pendingRef.current = false;
            setSaving(false);
            // The write's outcome owns the draft: the next snapshot (the
            // accepted view, or the controller's recovery read) re-seeds it.
            setEdits({});
            setOutcome(accepted === true ? { kind: 'saved' } : { kind: 'refused' });
          },
          () => {
            pendingRef.current = false;
            setSaving(false);
            setEdits({});
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
       * One labelled numeric field.
       * @param field - one of FIELDS.
       * @returns the field row.
       */
      const fieldRow = field => h('div', { className: 'dct-field', key: field },
        h('div', { className: 'dct-field-head' },
          h('label', { className: 'dct-field-label', htmlFor: ids[field] }, t(`field.${field}.label`)),
          h('span', { className: 'dct-unit' }, t(`field.${field}.unit`)),
        ),
        h('input', {
          id: ids[field],
          className: 'dct-input',
          type: 'number',
          inputMode: field === 'compactionRetries' ? 'numeric' : 'decimal',
          step: field === 'compactionRetries' ? 1 : 'any',
          min: field === 'compactionRetries' ? 0 : undefined,
          value: draft[field],
          disabled,
          'aria-describedby': `${ids[field]}-description`,
          onFocus: () => { setEditing(field); },
          onBlur: () => { setEditing(current => (current === field ? null : current)); },
          onChange: change(field),
        }),
        h('p', { className: 'dct-description', id: `${ids[field]}-description` }, t(`field.${field}.description`)),
      );

      const alert = outcome !== null && outcome.kind === 'invalid'
        ? h('p', { className: 'dct-alert', role: 'alert' }, t(outcome.key))
        : outcome !== null && outcome.kind === 'refused'
          ? h('p', { className: 'dct-alert', role: 'alert' }, t('error.refused'))
          : null;
      const saved = outcome !== null && outcome.kind === 'saved'
        ? h('p', { className: 'dct-saved', role: 'status' }, t('status.saved'))
        : null;

      return h('div', { className: 'dct-page' },
        h('style', null, STYLE_TEXT),
        h('header', { className: 'dct-header' },
          h('h2', { className: 'dct-title' }, t('title')),
          h('p', { className: 'dct-intro' }, t('intro')),
        ),
        restartBlock,
        status === 'unavailable'
          ? h('p', { className: 'dct-note' }, t('status.unavailable'))
          : null,
        !ready || writable ? null : h('p', { className: 'dct-note' }, t('status.readOnly')),
        fieldRow('thresholdRatio'),
        fieldRow('retainRatio'),
        fieldRow('compactionRetries'),
        alert,
        saved,
        h('div', { className: 'dct-actions' },
          h('button', {
            type: 'button',
            className: 'dct-button',
            disabled: disabled || saving || !dirty,
            'aria-busy': saving ? 'true' : undefined,
            onClick: save,
          }, saving ? t('action.saving') : t('action.save')),
        ),
      );
    }

    return {
      name: '@local/dsh-compaction-tuner',
      inject: ['slots', 'locale', 'configForms', 'connection'],
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
          if (connection === undefined || connection === null
            || connection.rpc === undefined || connection.rpc === null
            || typeof connection.rpc.call !== 'function') {
            return Promise.reject(new Error('compaction-tuner: the shared Connection service is unavailable'));
          }
          return connection.rpc.call(RESTART_CHANNEL, endpoint, payload, signal);
        };
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          // `label` is required: an omitted label renders an empty nav row.
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ form, t, callBackend }),
        }, TunerSection));
      },
    };
  },
});
