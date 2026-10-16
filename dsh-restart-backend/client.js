/**
 * Client half of @local/dsh-restart-backend: a General-settings row that
 * asks the Host process to replace itself through the frozen /restart-backend
 * channel, waits for the successor to answer again, then reloads the page.
 * Plain browser bundle module; React is the only module-table request.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-restart-backend',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useId, useRef, useState } = React;

    /** Channel, endpoints, and dictionary namespace frozen by CONTRACT.md. */
    const CHANNEL = '/restart-backend';
    const NS = 'restart-backend';

    /* Recovery budget: the old listener must disappear, then the successor
     * must answer. Both phases are bounded so the user never waits on a dead
     * page without the manual-reload fallback. */
    const DOWN_BUDGET_MS = 20000;
    const UP_BUDGET_MS = 60000;
    const PROBE_INTERVAL_MS = 500;
    const PROBE_TIMEOUT_MS = 5000;

    /* A transient miss must not hide the action, so the mount probe retries
     * before it reports the Host as unreachable. */
    const STATUS_ATTEMPTS = 3;
    const STATUS_RETRY_MS = 1000;

    const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
    const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

    const en = {
      'action.label': 'Restart backend',
      'action.description': 'Restarting replaces the backend process. Running turns, terminals, and open connections are interrupted.',
      'action.restarting': 'Restarting…',
      'action.unavailable': 'This process cannot restart itself.',
      'dialog.title': 'Restart the DSH backend?',
      'dialog.description': 'Restarting replaces the backend process. Running turns, terminals, and open connections are interrupted.',
      'dialog.confirm': 'Restart',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.restarting': 'Waiting for the backend to come back…',
      'status.timeout': 'The backend did not answer in time. Reload the page to connect to the new process.',
      'status.reload': 'Reload page',
      'error.busy': 'A backend restart is already in progress.',
      'error.unsupported': 'This process cannot restart itself.',
      'error.spawnFailed': 'The backend could not be relaunched.',
      'error.generic': 'The backend refused the restart request.',
      'error.unreachable': 'The backend is unreachable.',
    };

    const zh = {
      'action.label': '重启后端',
      'action.description': '重启会替换后端进程，正在运行的对话、终端和连接都会中断。',
      'action.restarting': '正在重启…',
      'action.unavailable': '当前进程无法自行重启。',
      'dialog.title': '要重启 DSH 后端吗？',
      'dialog.description': '重启会替换后端进程，正在运行的对话、终端和连接都会中断。',
      'dialog.confirm': '重启',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.restarting': '正在等待后端恢复…',
      'status.timeout': '后端未及时响应。请重新加载页面以连接新进程。',
      'status.reload': '重新加载页面',
      'error.busy': '已有重启请求正在处理。',
      'error.unsupported': '当前进程无法自行重启。',
      'error.spawnFailed': '无法重新启动后端。',
      'error.generic': '后端拒绝了重启请求。',
      'error.unreachable': '无法连接后端。',
    };

    /* Component-local sheet: rendered inside the row's own tree, so
     * unmounting the plugin removes every rule it added. Host theme tokens
     * only, and class names are namespaced to avoid collisions. */
    const STYLE_TEXT = [
      '.dsr-setting { box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 60px; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }',
      '.dsr-setting-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 48px; }',
      '.dsr-setting-title { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }',
      '.dsr-setting-description { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dsr-setting-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dsr-setting-action { flex: none; display: flex; align-items: center; gap: 8px; }',
      '.dsr-alert { max-width: 220px; overflow: hidden; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsr-alert-block { max-width: none; white-space: normal; }',
      '.dsr-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; cursor: pointer; }',
      '.dsr-button:disabled { cursor: not-allowed; opacity: 0.4; }',
      '.dsr-outline { border: 0.5px solid var(--dsw-alias-border-l3); }',
      '.dsr-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsr-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }',
      '.dsr-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }',
      '.dsr-row-button { height: 36px; min-width: 90px; max-width: 280px; padding: 0 14px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; white-space: nowrap; }',
      '.dsr-row-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsr-overlay { pointer-events: auto; position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; }',
      '.dsr-mask { position: absolute; inset: 0; backdrop-filter: var(--dsw-mask-blur); }',
      '.dsr-mask::after { content: ""; position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); }',
      '.dsr-dialog { box-sizing: border-box; position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(380px, 100%); padding: 0 0 24px; overflow: hidden; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); }',
      '.dsr-dialog:focus { outline: none; }',
      '.dsr-content { display: flex; flex-direction: column; width: 100%; }',
      '.dsr-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }',
      '.dsr-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 24px; font-weight: 500; }',
      '.dsr-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
      '.dsr-close:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.dsr-description { margin: 0; padding: 0 24px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }',
      '.dsr-body { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; padding: 0 24px; }',
      '.dsr-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; }',
      '.dsr-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }',
    ].join('\n');

    /**
     * Resolve one RPC failure code to the dictionary key of its product copy.
     * @param result - Connection RPC result.
     * @returns the localized-copy key for the failure.
     */
    function failureKey(result) {
      const error = result !== null && typeof result === 'object' && result.ok === false ? result.error : undefined;
      const code = error !== null && typeof error === 'object' ? error.code : undefined;
      switch (code) {
        case 'restart-backend/busy': return 'error.busy';
        case 'restart-backend/unsupported': return 'error.unsupported';
        case 'restart-backend/spawn-failed': return 'error.spawnFailed';
        default: return 'error.generic';
      }
    }

    /**
     * Focus an automatic destination without a focus ring until the user
     * navigates by keyboard; mirrors the host primitive's presentation rule.
     * @param element - control receiving automatic focus.
     */
    function focusWithoutRing(element) {
      if (!(element instanceof HTMLElement)) return;
      const release = () => {
        element.removeAttribute('data-dsh-automatic-focus');
        element.removeEventListener('blur', release);
        element.removeEventListener('keydown', navigate, true);
      };
      const navigate = (event) => {
        if (!event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && NAVIGATION_KEYS.has(event.key)) release();
      };
      element.setAttribute('data-dsh-automatic-focus', '');
      element.addEventListener('blur', release);
      element.addEventListener('keydown', navigate, true);
      element.focus({ preventScroll: true });
      if (!element.matches(':focus')) release();
    }

    /**
     * Wait for the interval or reject when the poll is cancelled.
     * @param ms - delay in milliseconds.
     * @param signal - poll cancellation signal.
     * @returns a promise settling after the delay.
     */
    function delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('restart-backend: recovery poll aborted'));
          return;
        }
        const onAbort = () => {
          window.clearTimeout(timer);
          reject(new Error('restart-backend: recovery poll aborted'));
        };
        const timer = window.setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort);
      });
    }

    /**
     * Ask whether the current document root answers at all.
     * @param url - document root to probe.
     * @param signal - poll cancellation signal.
     * @returns whether the request resolved before its own timeout.
     */
    function probe(url, signal) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => { controller.abort(); }, PROBE_TIMEOUT_MS);
      const forward = () => { controller.abort(); };
      if (signal.aborted) forward();
      else signal.addEventListener('abort', forward);
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
        signal.removeEventListener('abort', forward);
        return answered;
      });
    }

    /**
     * Run the CONTRACT.md recovery sequence: poll the document root until the
     * old listener is gone, then until the successor serves again.
     * @param signal - poll cancellation signal.
     * @returns `ready` when the successor answers, otherwise `timeout`.
     */
    async function awaitSuccessor(signal) {
      const root = new URL('.', window.location.href).href;
      let gone = false;
      const downDeadline = Date.now() + DOWN_BUDGET_MS;
      while (Date.now() < downDeadline) {
        if (!(await probe(root, signal))) {
          gone = true;
          break;
        }
        await delay(PROBE_INTERVAL_MS, signal);
      }
      if (!gone) return 'timeout';
      const upDeadline = Date.now() + UP_BUDGET_MS;
      while (Date.now() < upDeadline) {
        if (await probe(root, signal)) return 'ready';
        await delay(PROBE_INTERVAL_MS, signal);
      }
      return 'timeout';
    }

    /**
     * Render the confirmation dialog that gates one backend restart.
     * @param props.t - localized copy.
     * @param props.restarting - a restart request owns the process.
     * @param props.timedOut - recovery budget expired.
     * @param props.alertKey - dictionary key of the current failure copy, or null.
     * @param props.onConfirm - accepted restart request.
     * @param props.onClose - dismissed dialog.
     * @param props.onReload - manual reload fallback.
     * @returns the overlay tree.
     */
    function RestartConfirmation(props) {
      const { t, restarting, timedOut, alertKey, onConfirm, onClose, onReload } = props;
      const titleId = useId();
      const descriptionId = useId();
      const dialogRef = useRef(null);

      useEffect(() => {
        const element = dialogRef.current;
        if (element === null) return undefined;
        const document = element.ownerDocument;
        const previous = document.activeElement;
        const initial = element.querySelector('[data-modal-autofocus]')
          ?? element.querySelector(FOCUSABLE) ?? element;
        if (!element.contains(document.activeElement)) focusWithoutRing(initial);

        const keydown = (event) => {
          if (event.defaultPrevented || event.isComposing
            || event.ctrlKey || event.altKey || event.metaKey) return;
          if (event.key === 'Escape' && !event.shiftKey) {
            // Capture-phase ownership keeps the settings panel behind this
            // dialog from consuming the same Escape.
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const items = Array.from(element.querySelectorAll(FOCUSABLE))
            .filter(item => !item.closest('[inert], [hidden]'));
          const first = items[0] ?? element;
          const last = items[items.length - 1] ?? element;
          const active = document.activeElement;
          const atEdge = event.shiftKey ? active === first : active === last;
          if (active === element || !element.contains(active) || atEdge) {
            event.preventDefault();
            event.stopPropagation();
            (event.shiftKey ? last : first).focus();
          }
        };
        document.addEventListener('keydown', keydown, true);
        return () => {
          document.removeEventListener('keydown', keydown, true);
          if (previous instanceof HTMLElement && previous.isConnected) focusWithoutRing(previous);
        };
      }, [onClose]);

      const closeButton = h('button', {
        type: 'button',
        className: 'dsr-close',
        'aria-label': t('dialog.close'),
        onClick: onClose,
      }, h('svg', {
        width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        d: 'M2 2L12 12M12 2L2 12',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      })));

      const footerItems = restarting ? [] : timedOut ? [
        h('button', { type: 'button', className: 'dsr-button dsr-outline', onClick: onClose }, t('dialog.cancel')),
        h('button', { type: 'button', className: 'dsr-button dsr-primary', onClick: onReload }, t('status.reload')),
      ] : [
        h('button', {
          type: 'button', className: 'dsr-button dsr-outline', 'data-modal-autofocus': '', onClick: onClose,
        }, t('dialog.cancel')),
        h('button', { type: 'button', className: 'dsr-button dsr-primary', onClick: onConfirm }, t('dialog.confirm')),
      ];

      return h('div', { className: 'dsr-overlay', role: 'presentation' },
        h('div', { className: 'dsr-mask', 'aria-hidden': 'true', onClick: onClose }),
        h('div', {
          ref: dialogRef,
          tabIndex: -1,
          className: 'dsr-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          'aria-describedby': descriptionId,
        },
          h('div', { className: 'dsr-content' },
            h('div', { className: 'dsr-header' },
              h('h2', { className: 'dsr-title', id: titleId }, t('dialog.title')),
              closeButton,
            ),
            h('p', { className: 'dsr-description', id: descriptionId }, t('dialog.description')),
            h('div', { className: 'dsr-body' },
              restarting ? h('p', { className: 'dsr-note' }, t('dialog.restarting')) : null,
              alertKey === null ? null : h('span', { className: 'dsr-alert dsr-alert-block', role: 'alert' }, t(alertKey)),
            ),
          ),
          footerItems.length === 0 ? null : h('div', { className: 'dsr-footer' }, ...footerItems),
        ),
      );
    }

    /**
     * Render the General-settings restart row and its confirmation dialog.
     * @param props.t - localized copy for this plugin's namespace.
     * @param props.callHost - Host RPC caller for the frozen channel.
     * @returns the preference row, or null while Host status is still unresolved.
     */
    function RestartAction(props) {
      const { t, callHost } = props;
      const unavailableId = useId();
      const [status, setStatus] = useState('loading');
      const [failure, setFailure] = useState(null);
      const [pending, setPending] = useState(false);
      const [recovery, setRecovery] = useState('none');
      const [dialogOpen, setDialogOpen] = useState(false);

      useEffect(() => {
        const controller = new AbortController();
        let live = true;
        let retry = 0;
        const attempt = (remaining) => {
          callHost('status', {}, controller.signal).then(
            (result) => {
              if (!live) return;
              if (result.ok !== true) {
                setFailure(failureKey(result));
                setStatus('unreachable');
                return;
              }
              const value = result.value !== null && typeof result.value === 'object' ? result.value : {};
              // A restart that already owns the process answers `restarting`
              // with restartable:false; that is progress, not a refusal.
              if (value.status === 'restarting') {
                setStatus('owned');
                return;
              }
              if (value.restartable === false) {
                setStatus('blocked');
                return;
              }
              setStatus('ready');
            },
            () => {
              if (!live) return;
              // One missed probe is not proof that the Host is gone, so the
              // action only gives up after the bounded retries.
              if (remaining > 1) {
                retry = window.setTimeout(() => { attempt(remaining - 1); }, STATUS_RETRY_MS);
                return;
              }
              setFailure('error.unreachable');
              setStatus('unreachable');
            },
          );
        };
        attempt(STATUS_ATTEMPTS);
        return () => {
          live = false;
          window.clearTimeout(retry);
          controller.abort();
        };
      }, [callHost]);

      useEffect(() => {
        if (recovery !== 'polling') return undefined;
        const controller = new AbortController();
        let live = true;
        void awaitSuccessor(controller.signal).then(
          (outcome) => {
            if (!live) return;
            if (outcome === 'ready') {
              window.location.reload();
              return;
            }
            setRecovery('timeout');
          },
          () => {
            if (live) setRecovery('timeout');
          },
        );
        return () => {
          live = false;
          controller.abort();
        };
      }, [recovery]);

      const openDialog = useCallback(() => {
        setFailure(null);
        setDialogOpen(true);
      }, []);
      const closeDialog = useCallback(() => { setDialogOpen(false); }, []);
      const reload = useCallback(() => { window.location.reload(); }, []);
      const confirmRestart = useCallback(() => {
        setFailure(null);
        setPending(true);
        callHost('restart', {}, undefined).then(
          (result) => {
            setPending(false);
            // The reply means the successor was launched: only now does the
            // recovery sequence own the page.
            if (result.ok === true) {
              setRecovery('polling');
              return;
            }
            setFailure(failureKey(result));
          },
          () => {
            setPending(false);
            /* The process can exit before its reply reaches the browser, so a
             * transport rejection is not proof the restart failed: poll, and
             * let the bounded budget settle it. */
            setRecovery('polling');
          },
        );
      }, [callHost]);

      if (status === 'loading') return null;

      const restarting = pending || recovery === 'polling';
      const timedOut = recovery === 'timeout';
      const alertKey = timedOut ? 'status.timeout' : failure;
      const alert = alertKey === null
        ? null
        : h('span', { className: 'dsr-alert dsr-alert-block', role: 'alert' }, t(alertKey));
      const reloadButton = h('button', {
        type: 'button', className: 'dsr-button dsr-row-button', onClick: reload,
      }, t('status.reload'));
      const trigger = h('button', {
        type: 'button',
        className: 'dsr-button dsr-row-button',
        disabled: status !== 'ready' || restarting,
        title: status === 'blocked' ? t('action.unavailable') : undefined,
        'aria-describedby': status === 'blocked' ? unavailableId : undefined,
        onClick: openDialog,
      }, restarting || status === 'owned' ? t('action.restarting') : t('dialog.confirm'));
      // A disabled control leaves the keyboard and screen-reader path, so the
      // explanation it shows on hover is also rendered as a visible row note.
      const unavailableNote = status === 'blocked'
        ? h('p', { className: 'dsr-setting-note', id: unavailableId }, t('action.unavailable'))
        : null;

      return h(React.Fragment, null,
        h('div', { className: 'dsr-setting' },
          h('style', null, STYLE_TEXT),
          h('div', { className: 'dsr-setting-text' },
            h('div', { className: 'dsr-setting-title' }, t('action.label')),
            h('p', { className: 'dsr-setting-description' }, t('action.description')),
            unavailableNote,
            alert,
          ),
          h('div', { className: 'dsr-setting-action' },
            !dialogOpen && timedOut ? reloadButton : null,
            trigger,
          ),
        ),
        dialogOpen ? h(RestartConfirmation, {
          t, restarting, timedOut, alertKey, onConfirm: confirmRestart, onClose: closeDialog, onReload: reload,
        }) : null,
      );
    }

    return {
      name: '@local/dsh-restart-backend',
      inject: ['slots', 'locale', 'connection'],
      /**
       * Register the plugin dictionaries and the General-settings restart row.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), '@local/dsh-restart-backend: dictionaries');
        const callHost = (endpoint, payload, signal) => {
          const connection = ctx.get('connection');
          if (connection === undefined) {
            return Promise.reject(new Error('restart-backend: the connection service is unavailable'));
          }
          return connection.rpc.call(CHANNEL, endpoint, payload, signal);
        };
        // A composition without the shared Host transport cannot reach this
        // backend: contribute nothing instead of a dead action.
        if (ctx.get('connection') === undefined) return;
        // The row closes the General column: after every feature preference
        // and immediately above the version row (`current-version`, order 100).
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'restart-backend',
          order: 99,
          locale: NS,
          inject: () => ({ callHost }),
        }, RestartAction));
      },
    };
  },
});
