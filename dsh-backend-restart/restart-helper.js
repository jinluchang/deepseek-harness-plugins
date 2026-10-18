/**
 * Successor supervisor for one DSH backend restart.
 *
 * The running Host cannot rebind its own listening port, so a restart is a
 * process replacement: the Host starts this supervisor, answers the browser,
 * and asks its launcher to exit. The supervisor waits for the predecessor to
 * release the port and to finish exiting, then starts the recorded launch
 * command as a sibling in the predecessor's process group, so terminal signals
 * still reach the new backend.
 *
 * Two conditions are waited for, because neither is sufficient alone. The port
 * is what the successor needs, and a predecessor that was never reaped keeps
 * answering `kill(pid, 0)` while the port may already be free. Process death is
 * what keeps two generations off one Harness home, and the launcher may spend up
 * to its own forced-exit bound shutting down after it releases the port. Death is
 * observed exactly through the write end of an inherited pipe: the Host passes a
 * fourth descriptor, so end-of-file on it means the predecessor is gone. While
 * that pipe is readable it alone decides the wait, so the port being free cannot
 * start a second generation over a predecessor that is still shutting down; the
 * free-port grace applies only when the pipe is absent or unreadable. A start that
 * exits during its window is retried inside one bounded budget, so a carrier that
 * lingers briefly is not an outage.
 *
 * Exit codes: 0 successor started and survived its startup window, 2 bad usage,
 * 3 the restart slot was never usable, 4 the successor could not be spawned,
 * 5 every attempt exited during its startup window.
 */

import { spawn } from 'node:child_process'
import { connect, Socket } from 'node:net'

/** Total supervision budget: gate wait, attempts, and backoff together. */
const SUPERVISION_MS = 60_000

/** How long one successor must survive one attempt to count as started. */
const SETTLE_MS = 2_500

/**
 * Fallback death window: how long the port must stay free before a successor
 * starts over a predecessor that still answers signals. It is used only when the
 * death pipe is unavailable, and it must exceed the launcher's forced-exit bound,
 * which is what otherwise guarantees end-of-file on that pipe; below that bound
 * this fallback can start a second generation while the first is still shutting
 * down.
 */
const ZOMBIE_GRACE_MS = 6_000

/** Delay between attempts after a failed successor start. */
const RETRY_MS = 1_000

/** Poll interval for both waits. */
const POLL_MS = 200

/** How long one port probe waits before it reports the endpoint as unprobeable. */
const PROBE_TIMEOUT_MS = 1_000

/** Consecutive unprobeable results that end the wait instead of burning the budget. */
const UNPROBEABLE_LIMIT = 5

/**
 * Probe failures caused by this process rather than by the endpoint: sockets
 * cannot be created while descriptors or buffers are exhausted. They clear by
 * waiting, so they are reported separately from an endpoint that stays silent.
 */
const LOCAL_PROBE_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOBUFS', 'EMLINK'])

/** Descriptor carrying the predecessor-death pipe; standard streams occupy 0-2. */
const DEATH_FD = 3

/** Supervisor flags, all of which may appear at most once. */
const FLAGS = new Set(['--parent-pid', '--origin', '--cwd', '--death-pipe'])

/**
 * Spawn failures that cannot clear by waiting: the command itself is unusable.
 * Every other code is retried inside the budget, because transient exhaustion
 * (EMFILE, ENFILE, EAGAIN, ENOMEM) and Windows file locks do clear.
 */
const TERMINAL_SPAWN_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EACCES', 'EISDIR'])

// An inherited stdout pipe whose reader already exited must not kill the
// supervisor: the successor writes to the same descriptor.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

/**
 * Parse the supervisor's own flags and the launch command after `--`.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ parentPid: number, origin: string | undefined, cwd: string, deathPipe: boolean, execPath: string, args: string[] }}
 * @throws {Error} on a missing, malformed, or repeated flag.
 */
export function parseArguments(argv) {
  let parentPid
  let origin
  let cwd = process.cwd()
  let deathPipe = false
  const seen = new Set()
  const command = []
  const values = argv.values()
  for (const argument of values) {
    if (argument === '--') {
      command.push(...values)
      break
    }
    if (!FLAGS.has(argument)) {
      throw new Error(`restart-helper: unknown argument ${JSON.stringify(argument)}`)
    }
    if (seen.has(argument)) throw new Error(`restart-helper: repeated argument ${argument}`)
    seen.add(argument)
    if (argument === '--death-pipe') {
      deathPipe = true
      continue
    }
    const value = values.next().value
    if (value === undefined) throw new Error(`restart-helper: ${argument} needs a value`)
    if (argument === '--parent-pid') {
      if (!/^[1-9][0-9]*$/.test(String(value))) throw new Error(`restart-helper: invalid --parent-pid ${JSON.stringify(value)}`)
      parentPid = Number(value)
    } else if (argument === '--origin') origin = String(value)
    else cwd = String(value)
  }
  const [execPath, ...args] = command
  if (parentPid === undefined) throw new Error('restart-helper: --parent-pid is required')
  if (execPath === undefined) throw new Error('restart-helper: the launch command after -- is required')
  return { parentPid, origin, cwd, deathPipe, execPath, args }
}

/**
 * Report whether one process is still running.
 * @param {number} pid - the process to probe.
 * @returns {boolean} true while the process exists (`EPERM` counts as alive).
 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** @param {number} ms - delay in milliseconds. */
export function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Watch the inherited descriptor that ends when the predecessor exits.
 *
 * The Host passes this descriptor as a pipe and holds the write end for its own
 * lifetime, so end-of-file is the launcher's death rather than a timing guess.
 * Only end-of-file counts: a descriptor that cannot be read is a missing signal,
 * never a predecessor that died. While the signal is authoritative it decides the
 * wait on its own, so the caller may not substitute the free-port grace for it; a
 * descriptor that failed makes the signal non-authoritative and the grace applies
 * again. A supervisor started by hand declares no such descriptor at all.
 *
 * @param {boolean} enabled - whether the invoking Host passed the death pipe.
 * @returns {{ gone: () => boolean, authoritative: () => boolean }} the death signal and whether it may decide the wait alone.
 */
export function deathWatch(enabled) {
  if (enabled !== true) return { gone: () => false, authoritative: () => false }
  let ended = false
  let failed = false
  const describe = error => `restart-helper: the predecessor pipe is unreadable (${error.code ?? error.message}); using the free-port grace\n`
  try {
    const pipe = new Socket({ fd: DEATH_FD, readable: true, writable: false })
    pipe.on('end', () => { ended = true })
    pipe.on('error', (error) => {
      failed = true
      process.stderr.write(describe(error))
    })
    pipe.resume()
    // The pipe reports death; it must not itself outlive the supervisor. The
    // poll timers keep the process alive while it is waiting, so an unread
    // descriptor cannot end the wait early, and a predecessor already known dead
    // by its pid cannot leave this process running after the successor starts.
    pipe.unref()
  } catch (error) {
    // No inherited descriptor: the caller's grace window decides instead.
    process.stderr.write(`restart-helper: the predecessor pipe is unavailable (${error.message}); using the free-port grace\n`)
    return { gone: () => false, authoritative: () => false }
  }
  return { gone: () => ended, authoritative: () => !failed }
}

/**
 * Probe one TCP endpoint without confusing silence for a refusal.
 * @param {string} host - host to connect to.
 * @param {number} port - port to connect to.
 * @returns {Promise<{ state: 'free' | 'busy' | 'unknown' | 'local', code?: string }>} `busy` accepted the connection, `free` refused it, `unknown` neither answered nor refused it in time, `local` could not create the socket at all.
 */
export function probePort(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    let settled = false
    const settle = observation => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(observation)
    }
    socket.once('connect', () => { settle({ state: 'busy' }) })
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') settle({ state: 'free' })
      else if (LOCAL_PROBE_CODES.has(error.code)) settle({ state: 'local', code: error.code })
      else settle({ state: 'unknown', code: error.code })
    })
    socket.setTimeout(PROBE_TIMEOUT_MS, () => { settle({ state: 'unknown', code: 'ETIMEDOUT' }) })
  })
}

/**
 * Split an origin into the endpoint a successor must be able to bind.
 * @param {string | undefined} origin - the predecessor's advertised origin.
 * @returns {{ host: string, port: number } | undefined} the endpoint, or undefined when the origin names none.
 */
export function originEndpoint(origin) {
  if (origin === undefined) return undefined
  try {
    const target = new URL(origin)
    const port = Number(target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : target.port)
    return Number.isInteger(port) && port > 0 ? { host: target.hostname, port } : undefined
  } catch {
    return undefined
  }
}

/**
 * Wait until a successor could bind and the predecessor is gone.
 *
 * With an origin the successor's endpoint decides when the slot is usable, and
 * predecessor death decides when the first generation has finished with the
 * Harness home. Death arrives exactly through the inherited pipe; while that pipe
 * is authoritative the port being free is not enough, and only the grace window
 * stands in when the pipe is absent or unreadable. An endpoint that neither
 * answers nor refuses connections is reported as unprobeable instead of being
 * misreported as busy, past a small number of those the wait ends rather than
 * spending the whole budget on probes, and a socket this process cannot create is
 * retried as transient and then reported as its own errno rather than as an
 * endpoint problem.
 *
 * @param {{ parentPid: number, origin: string | undefined }} request - parsed supervisor request.
 * @param {number} deadline - epoch milliseconds after which the wait gives up.
 * @param {{ gone: () => boolean, authoritative: () => boolean }} [predecessor] - exact death signal and whether it decides the wait alone.
 * @returns {Promise<{ state: 'ready' | 'port-busy' | 'parent-alive' | 'unprobeable' | 'resource', detail?: string }>} why the wait ended, with an operator-facing reason when it did not end ready.
 */
export async function waitForSlot(request, deadline, predecessor = { gone: () => false, authoritative: () => false }) {
  const endpoint = originEndpoint(request.origin)
  const gone = () => predecessor.gone() || !isAlive(request.parentPid)
  let freeFor = 0
  let freeTotal = 0
  let unprobeable = 0
  let localFailures = 0
  let lastLocal
  while (Date.now() < deadline) {
    if (endpoint === undefined) {
      if (gone()) return { state: 'ready' }
    } else {
      const probe = await probePort(endpoint.host, endpoint.port)
      if (probe.state === 'local') {
        // A socket this process cannot create is transient like EMFILE on a
        // spawn, so it is retried for the rest of the budget instead of ending
        // the wait; only the deadline turns it into the recorded errno.
        localFailures += 1
        lastLocal = probe.code
      } else {
        localFailures = 0
        if (probe.state === 'unknown') {
          unprobeable += 1
          if (unprobeable >= UNPROBEABLE_LIMIT) {
            return { state: 'unprobeable', detail: 'the restart port could not be probed; connections neither connected nor were refused' }
          }
        } else {
          unprobeable = 0
          if (probe.state === 'free') {
            freeFor += POLL_MS
            freeTotal += POLL_MS
            if (gone()) return { state: 'ready' }
            if (!predecessor.authoritative() && freeFor >= ZOMBIE_GRACE_MS) return { state: 'ready' }
          } else {
            freeFor = 0
          }
        }
      }
    }
    await sleep(POLL_MS)
  }
  if (endpoint === undefined) {
    return { state: 'parent-alive', detail: 'the predecessor process did not exit within the budget' }
  }
  const probeFailure = localFailures > 0
    ? { state: 'resource', detail: `this process cannot create a socket (${String(lastLocal)}); the restart port could not be probed` }
    : undefined
  // A socket this process cannot create is the reason the wait ended when the
  // predecessor is already gone: nothing else could have been observed, and the
  // errno is what an operator needs. With the predecessor alive the free-port
  // observation stays the better answer, and the errno remains the fallback.
  if (probeFailure !== undefined && gone()) return probeFailure
  if (gone()) return { state: 'port-busy', detail: 'the restart port was still busy at the end of the budget' }
  if (freeTotal > 0) {
    return {
      state: 'parent-alive',
      detail: `the restart port was free for ${String(freeTotal)}ms but the predecessor process did not exit within the budget`,
    }
  }
  if (probeFailure !== undefined) return probeFailure
  if (unprobeable >= UNPROBEABLE_LIMIT) {
    return { state: 'unprobeable', detail: 'the restart port could not be probed; connections neither connected nor were refused' }
  }
  return { state: 'port-busy', detail: 'the restart port was still busy at the end of the budget' }
}

/**
 * Start the successor and report whether it survived its startup window.
 * @param {{ execPath: string, args: string[], cwd: string }} command - the recorded launch.
 * @returns {Promise<{ outcome: 'started' | 'spawn-failed' | 'exited', code?: string, detail: string }>} the attempt outcome, carrying the errno of a failed spawn.
 */
export function startSuccessor(command) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command.execPath, command.args, {
        cwd: command.cwd,
        env: process.env,
        // The successor keeps the launcher's standard streams. Its inherited
        // stdin is the supervisor's own, whose descriptor carries the death pipe
        // only for the supervisor itself.
        stdio: ['inherit', 'inherit', 'inherit'],
        windowsHide: true,
      })
    } catch (error) {
      // Some errnos (ENOTDIR, ELOOP, ENAMETOOLONG) throw from spawn instead of
      // arriving as an 'error' event; both paths carry the same classification.
      resolve({
        outcome: 'spawn-failed',
        code: error.code,
        detail: `successor failed to start (${error.code ?? 'unknown error'}): ${error.message}`,
      })
      return
    }
    let settled = false
    const settle = outcome => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      // The successor owns its own lifetime from here: dropping the handle lets
      // the supervisor exit instead of lingering as its parent for the whole run.
      child.unref()
      settle({ outcome: 'started', detail: `successor pid ${String(child.pid)} stayed up` })
    }, SETTLE_MS)
    child.once('error', error => {
      settle({
        outcome: 'spawn-failed',
        code: error.code,
        detail: `successor failed to start (${error.code ?? 'unknown error'}): ${error.message}`,
      })
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settle({ outcome: 'exited', detail: `successor exited during startup (code ${String(code)}, signal ${String(signal)})` })
    })
  })
}

/**
 * Supervise one successor attempt loop inside the budget.
 * @param {{ parentPid: number, origin: string | undefined, cwd: string, execPath: string, args: string[] }} request - parsed supervisor request.
 * @param {number} deadline - epoch milliseconds bounding every wait and attempt.
 * @param {{ gone: () => boolean, authoritative: () => boolean }} [predecessor] - exact death signal from the inherited pipe.
 * @returns {Promise<number>} the supervisor's exit code.
 */
export async function supervise(request, deadline, predecessor) {
  while (Date.now() < deadline) {
    const slot = await waitForSlot(request, deadline, predecessor)
    if (slot.state !== 'ready') {
      process.stderr.write(`restart-helper: ${String(slot.detail)}\n`)
      return 3
    }
    const attempt = await startSuccessor(request)
    if (attempt.outcome === 'started') {
      process.stderr.write(`restart-helper: ${attempt.detail}\n`)
      return 0
    }
    process.stderr.write(`restart-helper: ${attempt.detail}\n`)
    // An unusable command cannot clear by waiting; transient exhaustion can.
    if (attempt.outcome === 'spawn-failed' && TERMINAL_SPAWN_CODES.has(attempt.code)) return 4
    if (Date.now() >= deadline) break
    await sleep(RETRY_MS)
  }
  return 5
}

/** Run the supervisor for this process invocation. */
async function main() {
  let request
  try {
    request = parseArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: restart-helper.js --parent-pid <pid> [--origin <url>] [--cwd <dir>] [--death-pipe] -- <execPath> [args...]\n`)
    process.exitCode = 2
    return
  }
  process.exitCode = await supervise(request, Date.now() + SUPERVISION_MS, deathWatch(request.deathPipe))
}

if (import.meta.main) await main()
