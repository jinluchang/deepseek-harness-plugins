/**
 * Self-check for this bundle: manifest metadata, the Host half's mounted route
 * and its Connection-shaped wire contract, the refusal rules, the supervisor's
 * argument and probe behavior, and the spawn-failure classification.
 *
 * It is hermetic: it never calls `restart`, never reaches the network outside
 * loopback, and the only successor it spawns is a path that cannot exist. The
 * full replacement cycle is a browser-and-instance test, not this file.
 *
 * Run: `node dsh-backend-restart/verify.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, currentOrigin, launchCommand, registerChannel, restartBlocker } from './index.js'
import { originEndpoint, parseArguments, probePort, startSuccessor, waitForSlot } from './restart-helper.js'

let checks = 0

/**
 * Run one named check.
 * @param {string} label - what is being checked.
 * @param {() => unknown} body - assertions to run.
 */
async function check(label, body) {
  await body()
  checks += 1
  process.stdout.write(`ok ${checks} - ${label}\n`)
}

/**
 * Build a Cordis context double for the Host half.
 *
 * It exposes exactly what the mounted route reads: the carrier's `register`
 * and `getOrigin`, and the Connection fence `requestRejection`. The old
 * `connection.rpc` accessor and the `ctx.root` fallback are deliberately gone,
 * so this double also guards against the removed registration mechanism
 * coming back.
 *
 * @param {{ appExit?: unknown, origin?: string | null, rejection?: 401 | 403 | ((request: object) => 401 | 403 | undefined) }} [options] - service stand-ins.
 * @returns {object} the context double, exposing what the plugin mounted and disposed.
 */
function fakeContext({ appExit = () => {}, origin = 'http://127.0.0.1:3099', rejection = undefined } = {}) {
  const routes = []
  const effects = []
  const warnings = []
  const rejections = []
  const services = new Map([['appExit', appExit]])
  const webServer = {
    getOrigin: () => {
      if (origin === null) throw new Error('webserver: origin read before the listener bound a port')
      return origin
    },
    register(route) {
      if (routes.some(entry => entry.kind === route.kind && entry.path === route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
  }
  services.set('webServer', webServer)
  const requestRejection = (request) => {
    rejections.push(request)
    return typeof rejection === 'function' ? rejection(request) : rejection
  }
  return {
    routes,
    effects,
    warnings,
    rejections,
    logger: { warn: message => { warnings.push(message) } },
    webServer,
    connection: { requestRejection },
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return () => { if (typeof disposer === 'function') disposer() }
    },
    get: name => services.get(name) ?? undefined,
    /** The removed fallback must stay removed. */
    get root() { throw new Error('the plugin must not reach for ctx.root') },
  }
}

/**
 * Build one node:http request double carrying an optional body.
 * @param {{ method?: string, url?: string, headers?: object, body?: string }} [request] - request facts.
 * @returns {object} the request double, iterable like an IncomingMessage.
 */
function fakeRequest({ method = 'POST', url = '/backend-restart/status', headers, body } = {}) {
  const request = {
    method,
    url,
    headers: headers ?? { 'content-type': 'application/json' },
    destroyed: false,
    destroy() { request.destroyed = true },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
  return request
}

/**
 * Build one node:http response double.
 * @returns {object} the response double, recording status, headers, and body.
 */
function fakeResponse() {
  const response = {
    status: undefined,
    headers: undefined,
    body: undefined,
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      if (response.headersSent) throw new Error(`writeHead(${status}) after the headers were sent`)
      response.status = status
      response.headers = headers
      response.headersSent = true
      return response
    },
    end(body) {
      response.body = body
      response.writableEnded = true
    },
  }
  return response
}

/**
 * Drive the plugin's mounted route with one request double.
 * @param {object} ctx - fake context holding the mounted route.
 * @param {{ method?: string, url?: string, headers?: object, body?: string }} request - request facts.
 * @returns {Promise<{ req: object, res: object, json: object | undefined }>} the exchange; `json` is set for JSON answers.
 */
async function send(ctx, request) {
  const req = fakeRequest(request)
  const res = fakeResponse()
  assert.equal(ctx.routes.length, 1, 'exactly one route is mounted')
  await ctx.routes[0].handler(req, res)
  const json = res.headers?.['content-type'] === 'application/json' ? JSON.parse(res.body) : undefined
  return { req, res, json }
}

/**
 * Build one Connection `client-request` envelope.
 * @param {string} rpcId - correlation id.
 * @param {string} method - endpoint the envelope claims.
 * @param {unknown} [payload] - channel payload.
 * @returns {object} the envelope.
 */
function clientRequest(rpcId, method, payload = {}) {
  return { type: 'client-request', rpcId, method, payload }
}

/**
 * POST one Connection envelope to the channel endpoint matching its method.
 * @param {object} ctx - fake context holding the mounted route.
 * @param {string} endpoint - channel-relative endpoint.
 * @param {string} [rpcId] - correlation id.
 * @param {unknown} [payload] - channel payload.
 * @returns {Promise<{ req: object, res: object, json: object }>} the exchange.
 */
async function post(ctx, endpoint, rpcId = `${endpoint}-rpc`, payload = {}) {
  const exchange = await send(ctx, {
    url: `/backend-restart/${endpoint}`,
    body: JSON.stringify(clientRequest(rpcId, endpoint, payload)),
  })
  return exchange
}

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')

await check('the manifest names the bundle, its patch, and every runtime file', () => {
  assert.equal(packageJson.name, 'dsh-backend-restart')
  assert.equal(packageJson.private, false)
  assert.equal(packageJson.type, 'module')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.deepEqual(packageJson.files, [
    'index.js', 'restart-helper.js', 'client.js', 'verify.mjs', 'cordis.patch.yml',
    'locale/*.json', 'icon.svg', 'LICENSE', 'README.md', 'README.zh.md', 'CONTRACT.md',
  ])
  assert.deepEqual(Object.keys(packageJson.exports).sort(), ['.', './client', './icon', './locale/*.json', './package.json'])
  for (const entry of packageJson.files) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(new URL(`./${entry}`, import.meta.url)), `${entry} is listed but missing`)
  }
})

await check('the bundle patch inserts this plugin exactly once', () => {
  const rows = patch.split('\n').filter(line => line.trimStart().startsWith('- id:'))
  assert.deepEqual(rows.map(row => row.trim()), ['- id: backend-restart'])
  assert.match(patch, /^\s+name: 'dsh-backend-restart'$/m)
})

await check('the launch command replays Node flags and the application arguments', () => {
  assert.deepEqual(
    launchCommand({ execPath: '/usr/bin/node', execArgv: ['--import', 'tsx/esm'], argv: ['/usr/bin/node', 'apps/cli/src/bin.ts', '--profile', 'web'], cwd: () => '/repo' }),
    { execPath: '/usr/bin/node', argv: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web'], cwd: '/repo' },
  )
  assert.equal(launchCommand({ execPath: '/usr/bin/node', execArgv: [], argv: ['/usr/bin/node'], cwd: () => '/' }), undefined)
})

await check('the origin is read from the carrier and survives a carrier that cannot name one', () => {
  assert.equal(currentOrigin(fakeContext()), 'http://127.0.0.1:3099')
  assert.equal(currentOrigin(fakeContext({ origin: null })), undefined)
})

await check('the channel mounts one authenticated prefix route and disposes it', async () => {
  const ctx = fakeContext()
  apply(ctx)
  assert.deepEqual(ctx.effects.map(entry => entry.label), ['backend-restart: restart exit', 'backend-restart: restart channel'])
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].kind, 'prefix')
  assert.equal(ctx.routes[0].path, '/backend-restart')
  assert.equal(typeof ctx.routes[0].handler, 'function')

  // Connection's fence answers before any method, body, or envelope decision.
  for (const [rejection, body] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const fenced = fakeContext({ rejection })
    apply(fenced)
    const denied = await send(fenced, { method: 'GET', url: '/backend-restart/status', headers: {} })
    assert.equal(denied.res.status, rejection)
    assert.equal(denied.res.body, body)
    assert.equal(denied.res.headers, undefined, 'the fence answers before any content-type decision')
    assert.equal(fenced.rejections.length, 1)
  }

  ctx.effects.forEach(entry => { if (typeof entry.disposer === 'function') entry.disposer() })
  assert.deepEqual(ctx.routes, [])
})

await check('the client-request envelope round-trips status and refuses an unknown endpoint', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const status = await post(ctx, 'status')
  assert.equal(status.res.status, 200)
  assert.deepEqual(status.res.headers, { 'content-type': 'application/json' })
  assert.equal(status.json.type, 'server-response')
  assert.equal(status.json.rpcId, 'status-rpc')
  assert.equal(status.json.result.ok, true)
  assert.deepEqual(Object.keys(status.json.result.value).sort(), ['pid', 'restartable', 'status'])
  assert.equal(status.json.result.value.status, 'running')
  assert.equal(status.json.result.value.pid, process.pid)
  assert.equal(status.json.result.value.restartable, true)

  const unknown = await post(ctx, 'nope', 'nope-rpc', { probe: true })
  assert.equal(unknown.res.status, 200)
  assert.equal(unknown.json.rpcId, 'nope-rpc')
  assert.equal(unknown.json.result.ok, false)
  assert.equal(unknown.json.result.error.code, 'backend-restart/unknown-endpoint')
})

await check('a launcher without a bounded exit refuses the restart instead of half-restarting', async () => {
  const ctx = fakeContext({ appExit: null })
  apply(ctx)
  assert.equal(restartBlocker(ctx), 'this launcher has no bounded process-exit capability')
  const refused = await post(ctx, 'restart')
  assert.equal(refused.res.status, 200)
  assert.equal(refused.json.result.ok, false)
  assert.equal(refused.json.result.error.code, 'backend-restart/unsupported')
  const status = await post(ctx, 'status')
  assert.equal(status.json.result.value.restartable, false)
  assert.match(status.json.result.value.reason, /bounded process-exit/)
})

await check('the route reproduces Connection\'s request guards and handler-failure framing', async () => {
  const ctx = fakeContext()
  apply(ctx)

  // Connection's channel adapter answers "not found" for a non-POST method and
  // for a path outside the channel, rather than a 405.
  const get = await send(ctx, { method: 'GET', url: '/backend-restart/status', headers: {} })
  assert.equal(get.res.status, 404)
  assert.equal(get.res.body, 'not found')
  const bare = await send(ctx, { method: 'POST', url: '/backend-restart' })
  assert.equal(bare.res.status, 404)
  const traversal = await send(ctx, { method: 'POST', url: '/backend-restart/%2e%2e/status' })
  assert.equal(traversal.res.status, 404)
  const badSegment = await send(ctx, { method: 'POST', url: '/backend-restart/st%20atus' })
  assert.equal(badSegment.res.status, 404)

  const wrongMedia = await send(ctx, {
    method: 'POST', url: '/backend-restart/status',
    headers: { 'content-type': 'text/plain' }, body: '{}',
  })
  assert.equal(wrongMedia.res.status, 415)
  assert.equal(wrongMedia.res.body, 'content type must be application/json')

  const badJson = await send(ctx, { method: 'POST', url: '/backend-restart/status', body: '{' })
  assert.equal(badJson.res.status, 400)
  assert.equal(badJson.res.body, 'body is not JSON')

  // A malformed envelope is a logical failure carried in a 200 server-response.
  const invalid = await send(ctx, {
    url: '/backend-restart/status',
    body: JSON.stringify({ type: 'server-response', rpcId: 'r9', method: 'status', payload: {} }),
  })
  assert.equal(invalid.res.status, 200)
  assert.deepEqual(invalid.json.result, {
    ok: false,
    error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
  })
  assert.equal(invalid.json.rpcId, 'r9')

  // Missing rpcId falls back to Connection's placeholder id, and Connection's
  // schema requires the payload field even though its value is unconstrained.
  const anonymous = await send(ctx, {
    url: '/backend-restart/status',
    body: JSON.stringify({ type: 'client-request', method: 'status', payload: {} }),
  })
  assert.equal(anonymous.json.rpcId, 'invalid-request')
  const noPayload = await send(ctx, {
    url: '/backend-restart/status',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r10', method: 'status' }),
  })
  assert.equal(noPayload.json.result.error.code, 'gateway/bad-request')

  // A valid envelope whose method and path disagree is a logical failure.
  const mismatch = await send(ctx, { url: '/backend-restart/restart', body: JSON.stringify(clientRequest('r11', 'status')) })
  assert.equal(mismatch.res.status, 200)
  assert.equal(mismatch.json.result.error.code, 'gateway/bad-request')
  assert.match(mismatch.json.result.error.message, /does not match endpoint/)

  // Oversized bodies are refused before parsing, as Connection's bridge does.
  const huge = await send(ctx, { url: '/backend-restart/status', body: 'x'.repeat(64 * 1024 + 1) })
  assert.equal(huge.res.status, 413)
  assert.equal(huge.res.body, undefined)
  assert.equal(huge.req.destroyed, true)

  // A thrown handler keeps Connection's raw 500 text.
  const throwing = fakeContext()
  registerChannel(throwing, async () => { throw new Error('boom') })
  const thrown = await send(throwing, { url: '/backend-restart/status', body: JSON.stringify(clientRequest('r12', 'status')) })
  assert.equal(thrown.res.status, 500)
  assert.equal(thrown.res.body, 'handler failure: Error: boom')

  // A handler returning a non-result throws while framing, mapped the same way.
  const malformed = fakeContext()
  registerChannel(malformed, async () => undefined)
  const broken = await send(malformed, { url: '/backend-restart/status', body: JSON.stringify(clientRequest('r13', 'status')) })
  assert.equal(broken.res.status, 500)
  assert.match(broken.res.body, /^handler failure: TypeError/)
})

await check('the supervisor parses its own flags and the command after --', () => {
  assert.deepEqual(
    parseArguments(['--parent-pid', '42', '--origin', 'http://127.0.0.1:3099', '--cwd', '/repo', '--death-pipe', '--', '/usr/bin/node', 'bin.ts']),
    { parentPid: 42, origin: 'http://127.0.0.1:3099', cwd: '/repo', deathPipe: true, execPath: '/usr/bin/node', args: ['bin.ts'] },
  )
  assert.equal(parseArguments(['--parent-pid', '42', '--', '/usr/bin/node']).deathPipe, false)
  assert.throws(() => parseArguments([]), /--parent-pid is required/)
  assert.throws(() => parseArguments(['--parent-pid', '42', '--parent-pid', '43', '--', 'node']), /repeated argument/)
  assert.throws(() => parseArguments(['--nope', '1', '--', 'node']), /unknown argument/)
  assert.throws(() => parseArguments(['--death-pipe', '--death-pipe', '--parent-pid', '1', '--', 'node']), /repeated argument/)
  assert.throws(() => parseArguments(['--parent-pid', '0', '--', 'node']), /invalid --parent-pid/)
})

await check('an origin names the endpoint a successor must bind', () => {
  assert.deepEqual(originEndpoint('http://127.0.0.1:3099'), { host: '127.0.0.1', port: 3099 })
  assert.deepEqual(originEndpoint('https://example.test'), { host: 'example.test', port: 443 })
  assert.equal(originEndpoint(undefined), undefined)
  assert.equal(originEndpoint('not a url'), undefined)
})

await check('a probe tells a refusal from a listener and from silence', async () => {
  const server = createServer()
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  assert.deepEqual(await probePort('127.0.0.1', port), { state: 'busy' })
  await new Promise(resolve => { server.close(resolve) })
  assert.deepEqual(await probePort('127.0.0.1', port), { state: 'free' })
  assert.equal((await probePort('10.255.255.1', 9)).state, 'unknown')
})

await check('an authoritative death signal outranks a free port, and the grace applies without one', async () => {
  const server = createServer()
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => { server.close(resolve) })
  const request = { parentPid: process.pid, origin: `http://127.0.0.1:${String(port)}` }
  const alive = { gone: () => false, authoritative: () => true }
  const held = await waitForSlot(request, Date.now() + 1_500, alive)
  assert.equal(held.state, 'parent-alive')
  assert.match(String(held.detail), /port was free for \d+ms/)
  const graced = await waitForSlot(request, Date.now() + 7_000, { gone: () => false, authoritative: () => false })
  assert.equal(graced.state, 'ready', 'the free-port grace opens the gate when the pipe is not authoritative')
  const dead = await waitForSlot(request, Date.now() + 1_500, { gone: () => true, authoritative: () => true })
  assert.equal(dead.state, 'ready')
})

await check('a spawn failure carries its errno instead of throwing', async () => {
  const missing = await startSuccessor({ execPath: '/definitely/not/a/binary', args: [], cwd: process.cwd() })
  assert.equal(missing.outcome, 'spawn-failed')
  assert.equal(missing.code, 'ENOENT')
  assert.match(missing.detail, /ENOENT/)
  // A directory as the command throws synchronously out of spawn rather than
  // emitting 'error', and must still arrive as the same classified outcome.
  const directory = await startSuccessor({ execPath: dirname(fileURLToPath(import.meta.url)), args: [], cwd: process.cwd() })
  assert.equal(directory.outcome, 'spawn-failed')
  assert.ok(directory.code !== undefined, `expected an errno, got ${String(directory.code)}`)
})

process.stdout.write(`\n${checks} checks passed\n`)
