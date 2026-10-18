/**
 * Client half of @local/dsh-compaction-tuner: one Settings page that edits the
 * tuner's three values — `thresholdRatio`, `retainRatio`, and
 * `compactionRetries` — in ONE atomic write.
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
 * @module @local/dsh-compaction-tuner/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-compaction-tuner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useId, useRef, useState, useSyncExternalStore } = React;

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
     * The "Compaction tuner" settings page: three numeric inputs over the
     * tuner's Host namespace, saved by one atomic mutation.
     * @param props - slot props.
     * @param props.form - shared config form for the `compaction-tuner` entry.
     * @param props.t - localized copy for this plugin's namespace.
     * @param props.close - shell-owned panel exit; this page needs no exit of
     *   its own, so it never calls it (the contract still passes it).
     * @returns the section tree.
     */
    function TunerSection(props) {
      const { form, t } = props;
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

      if (status === 'loading') {
        return h('div', { className: 'dct-page' },
          h('style', null, STYLE_TEXT),
          h('p', { className: 'dct-note' }, t('status.loading')),
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
      inject: ['slots', 'locale', 'configForms'],
      /**
       * Register the plugin dictionaries and the Compaction-tuner settings
       * section.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), '@local/dsh-compaction-tuner: dictionaries');
        const form = ctx.configForms.get(NS);
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          // `label` is required: an omitted label renders an empty nav row.
          label: () => t('nav'),
          locale: NS,
          inject: () => ({ form, t }),
        }, TunerSection));
      },
    };
  },
});
