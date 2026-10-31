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
 * authentication, and the HTTP carrier this plugin mounts its route on.
 */
export const inject = ['connection', 'webServer']

/** Name of the channel this plugin owns; `/api` is reserved and never reused. */
const CHANNEL = '/backend-restart'

/** Endpoint segment shape Connection accepts inside one channel. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Bound on one request envelope; every request this channel carries has a `{}` payload. */
const MAX_BODY_BYTES = 64 * 1024

/** Correlation id Connection answers with when a request never carried one. */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

/** Failure code Connection uses for a malformed or misframed request. */
const BAD_REQUEST_CODE = 'gateway/bad-request'

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
 * Mount the restart channel as an authenticated Web route.
 *
 * `ctx.connection.rpc.handle()` cannot be used here. On Cordis 4.0.0-rc.11 the
 * Connection provider resolves `webServer` through its own def-site inject list
 * (`['credentials']`), so that call is refused with "cannot get property
 * webServer without inject" even though this plugin declares and can read
 * `webServer`; no caller-side scope reaches through the provider's fiber.
 *
 * Mounting the route on this plugin's own fiber keeps `webServer` resolution
 * where it belongs. Connection's channel adapter is reproduced before dispatch:
 * its Host/Origin fence and browser authentication run first, then the request
 * guards (POST only, channel-relative endpoint, JSON media type, JSON body), the
 * `client-request` envelope parse, and the `server-response` framing including
 * Connection's failure results and its raw 500 for a thrown handler.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context (injects connection + webServer).
 * @param {(endpoint: string, payload: unknown) => Promise<object>} handler - decoded endpoint handler.
 * @returns {() => void} synchronous route disposer, owned by the caller's effect.
 */
export function registerChannel(ctx, handler) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      // Connection's fence owns trust and browser authentication; it answers
      // before any method, body, or envelope decision, as its own adapter does.
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = endpointOf(req.url)
      if (req.method !== 'POST' || endpoint === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const mediaType = typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type'].split(';', 1)[0].trim().toLowerCase()
        : undefined
      if (mediaType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let text
      try {
        text = await readBody(req)
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      if (text === undefined) {
        // Connection's bridge bounds every buffered body; this channel carries
        // only `{}` payloads, so its ceiling is far below the shared one.
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      // Connection's client-request schema: a JSON object with the message
      // literal, a string id, a string method, and a present (any-valued)
      // payload. Unknown keys are stripped by that schema, so they are ignored.
      if (!isRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string'
        || typeof body.method !== 'string' || !Object.hasOwn(body, 'payload')) {
        const rpcId = isRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID
        sendEnvelope(res, rpcId, badRequest('invalid client-request message'))
        return
      }
      if (body.method !== endpoint) {
        sendEnvelope(res, body.rpcId, badRequest(
          `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      try {
        // The handler shape is unchanged: `(endpoint, payload) => result`.
        sendEnvelope(res, body.rpcId, await handler(endpoint, body.payload))
      } catch (error) {
        res.writeHead(500)
        res.end(`handler failure: ${String(error)}`)
      }
    },
  })
}

/**
 * Write one Connection `server-response` envelope.
 * @param {import('node:http').ServerResponse} res - response owned here.
 * @param {string} rpcId - correlation id echoed to the caller.
 * @param {object} result - handler result or Connection failure result.
 */
function sendEnvelope(res, rpcId, result) {
  // Serialize before writing headers: a malformed handler result must reach the
  // handler-failure path, not leave a half-written response.
  const payload = JSON.stringify({ type: 'server-response', rpcId, result: frameResult(result) })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(payload)
}

/**
 * Frame one handler result as Connection does for a JSON (attachment-free) channel.
 * @param {object} result - handler result.
 * @returns {object} the result carried in the envelope.
 */
function frameResult(result) {
  // Same shape test as Connection's adapter: a missing/falsy `ok` is framed
  // as-is (and a non-result throws on property access, answered as a 500).
  if (!result.ok) return result
  const { attachments: _attachments, ...framed } = result
  return framed
}

/**
 * Build one Connection failure result for a malformed request.
 * @param {string} message - diagnostic text.
 * @returns {{ ok: false, error: { code: string, message: string, details: { issues: object[] } } }} the failure result.
 */
function badRequest(message) {
  return { ok: false, error: { code: BAD_REQUEST_CODE, message, details: { issues: [] } } }
}

/**
 * Extract the channel-relative endpoint from a request target.
 * @param {string | undefined} url - request target as node:http supplied it.
 * @returns {string | undefined} the endpoint, or undefined outside the channel.
 */
function endpointOf(url) {
  const pathname = new URL(url ?? '/', 'http://dsh.internal').pathname
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(CHANNEL.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

/**
 * Buffer one request body under this channel's ceiling.
 * @param {import('node:http').IncomingMessage} req - request owning the body.
 * @returns {Promise<string | undefined>} UTF-8 body, or undefined past the ceiling.
 */
async function readBody(req) {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES) return undefined
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, received).toString('utf8')
}

/**
 * Narrow an unknown JSON value to a non-array object.
 * @param {unknown} value - parsed JSON value.
 * @returns {value is Record<string, unknown>} whether it is a JSON object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
