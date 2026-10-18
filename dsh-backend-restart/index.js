/**
 * Host half of the backend-restart bundle.
 *
 * Owns one authenticated Connection channel: `status` reports whether this
 * process can relaunch itself, and `restart` launches the successor supervisor,
 * answers the browser, and asks the launcher to exit. The successor re-runs the
 * recorded launch command, so the process generation — and every module it
 * loaded — is replaced rather than reloaded.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Absolute path of the successor supervisor shipped beside this module. */
const HELPER_PATH = fileURLToPath(new URL('./restart-helper.js', import.meta.url))

/** Grace for the restart reply to reach the browser before the tree disposes. */
const EXIT_DELAY_MS = 500

/** Stable Cordis plugin name. */
export const name = 'backend-restart'

/**
 * Required services: the registry that owns the channel's trust and
 * authentication, and the HTTP carrier whose `webServer` property the
 * registration reads through this context.
 */
export const inject = ['connection', 'webServer']

/** Name of the channel this plugin owns; `/api` is reserved and never reused. */
const CHANNEL = '/backend-restart'

/**
 * Build one carrier-neutral failure result.
 * @param {string} code - channel-relative failure code.
 * @param {string} message - diagnostic text; the Client localizes its own copy.
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the failure result.
 */
function failure(code, message) {
  return { ok: false, error: { code: `backend-restart/${code}`, message, details: {} } }
}

/**
 * Recover the launch command that started this process.
 * @param {NodeJS.Process} proc - the running process.
 * @returns {{ execPath: string, argv: string[], cwd: string } | undefined} the command, or undefined when it is not replayable.
 */
export function launchCommand(proc = process) {
  const argv = [...proc.execArgv, ...proc.argv.slice(1)]
  if (argv.length === 0) return undefined
  return { execPath: proc.execPath, argv, cwd: proc.cwd() }
}

/**
 * Explain why this process cannot relaunch itself.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @returns {string | undefined} a diagnostic reason, or undefined when a restart is accepted.
 */
export function restartBlocker(ctx) {
  if (process.versions.electron !== undefined) {
    return 'the Electron main process owns DSH Desktop restarts'
  }
  if (launchCommand() === undefined) {
    return 'this process has no replayable launch command'
  }
  if (ctx.get('appExit') === undefined) {
    return 'this launcher has no bounded process-exit capability'
  }
  return undefined
}

/**
 * Read the origin the predecessor advertises, for the successor's port wait.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @returns {string | undefined} the origin, or undefined when the carrier cannot name one.
 */
export function currentOrigin(ctx) {
  try {
    return ctx.webServer.getOrigin()
  } catch {
    // `getOrigin` throws before the listener binds; a request can only arrive
    // after it does, so this is a carrier fact the successor may go without.
    return undefined
  }
}

/**
 * Register the restart channel on the shared carrier.
 *
 * `ctx.connection.rpc.handle` is the documented call, and it binds the route to
 * this plugin's fiber. A Host built before the carrier-registration fix resolves
 * the carrier's `webServer` through the provider fiber's inject list instead of
 * the caller's, so that call is refused even though this plugin declares and can
 * read the carrier. The root scope registers the identical route without the
 * guard; the returned disposer removes it either way. Every other failure keeps
 * its own error, and a composition without a carrier is not this plugin's to
 * paper over.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {(endpoint: string) => Promise<object>} handler - decoded endpoint handler.
 * @returns {() => unknown} the registration disposer.
 */
export function registerChannel(ctx, handler) {
  try {
    return ctx.connection.rpc.handle(CHANNEL, handler)
  } catch (error) {
    if (ctx.get('webServer') === undefined) throw error
    return ctx.root.connection.rpc.handle(CHANNEL, handler)
  }
}

/**
 * Register the restart channel and its handlers.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 */
export function apply(ctx) {
  /** Current restart phase; a pending restart owns the process until it exits. */
  let phase = 'running'
  /** Fiber-owned exit timer, so unloading the plugin inside the grace cancels the exit. */
  let exitTimer

  ctx.effect(() => () => {
    if (exitTimer !== undefined) clearTimeout(exitTimer)
  }, 'backend-restart: restart exit')

  const statusView = () => {
    if (phase !== 'running') {
      return { status: phase, pid: process.pid, restartable: false, reason: 'a restart is already in progress' }
    }
    const blocker = restartBlocker(ctx)
    return {
      status: phase,
      pid: process.pid,
      restartable: blocker === undefined,
      ...(blocker === undefined ? {} : { reason: blocker }),
    }
  }

  const requestRestart = () => {
    const blocker = restartBlocker(ctx)
    if (blocker !== undefined) return failure('unsupported', blocker)
    if (phase !== 'running') return failure('busy', 'a restart is already in progress')
    const command = launchCommand()
    // `restartBlocker` already refused a missing command; this keeps the type
    // narrowing local instead of re-deriving it from the same probe.
    if (command === undefined) return failure('unsupported', 'this process has no replayable launch command')
    const exit = ctx.get('appExit')
    if (exit === undefined) return failure('unsupported', 'this launcher has no bounded process-exit capability')
    const origin = currentOrigin(ctx)
    const helperArgs = [
      HELPER_PATH,
      '--parent-pid', String(process.pid),
      ...(origin === undefined ? [] : ['--origin', origin]),
      '--cwd', command.cwd,
      '--death-pipe',
      '--', command.execPath, ...command.argv,
    ]
    const helper = spawn(process.execPath, helperArgs, {
      // Standard streams are inherited so the successor keeps this launcher's
      // terminal; the extra descriptor is a pipe this process holds open only
      // for its own lifetime, which is how the supervisor learns that the
      // predecessor exited rather than inferring it from a quiet port.
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
      windowsHide: true,
    })
    // Attach before reading the pid: a failed spawn emits 'error' on a later
    // tick, and an unhandled one would throw inside the Host process.
    helper.once('error', (error) => {
      ctx.logger.warn(`backend-restart: successor supervisor failed: ${error.message}`)
    })
    if (helper.pid === undefined) {
      return failure('spawn-failed', 'the successor supervisor could not be started')
    }
    // Holding the death pipe must not keep this process alive: the launcher's
    // own exit closes it, which is exactly the signal the supervisor waits for.
    helper.stdio[3]?.unref()
    helper.unref()
    // Nothing above this line can fail once the supervisor is running, so the
    // phase moves last and every failure path leaves the plugin consistent.
    exitTimer = setTimeout(() => { void exit(0) }, EXIT_DELAY_MS)
    phase = 'restarting'
    return { ok: true, value: { status: phase, pid: process.pid } }
  }

  ctx.effect(() => {
    const dispose = registerChannel(ctx, async (endpoint) => {
      switch (endpoint) {
        case 'status': return { ok: true, value: statusView() }
        case 'restart': return requestRestart()
        default: return failure('unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`)
      }
    })
    return () => { void dispose() }
  }, 'backend-restart: restart channel')
}
