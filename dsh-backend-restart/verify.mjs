/**
 * Self-check for this bundle: manifest metadata, the Host half's channel contract
 * and refusal rules, the supervisor's argument and probe behavior, and the
 * spawn-failure classification.
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
 * @param {{ appExit?: unknown, origin?: string | null, guardError?: boolean }} [options] - service stand-ins.
 * @returns {object} the context double, exposing what the plugin registered and disposed.
 */
function fakeContext({ appExit = () => {}, origin = 'http://127.0.0.1:3099', guardError = false } = {}) {
  const registered = []
  const effects = []
  const warnings = []
  const services = new Map([['appExit', appExit], ['webServer', origin === null ? undefined : { getOrigin: () => origin }]])
  const handle = (channel, handler) => {
    if (guardError) throw new Error('cannot get property "webServer" without inject')
    registered.push({ channel, handler })
    return () => {}
  }
  const context = {
    registered,
    effects,
    warnings,
    logger: { warn: message => { warnings.push(message) } },
    connection: { rpc: { handle } },
    webServer: { getOrigin: () => { if (origin === null) throw new Error('not listening'); return origin } },
    effect(callback, label) {
      const disposer = callback()
      effects.push({ label, disposer })
      return () => { if (typeof disposer === 'function') disposer() }
    },
    get: name => services.get(name) ?? undefined,
  }
  context.root = { connection: { rpc: { handle: (channel, handler) => { registered.push({ channel, handler }); return () => {} } } } }
  return context
}

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')

await check('the manifest names the bundle, its patch, and every runtime file', () => {
  assert.equal(packageJson.name, '@local/dsh-backend-restart')
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.type, 'module')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.deepEqual(packageJson.files, [
    'index.js', 'restart-helper.js', 'client.js', 'verify.mjs', 'cordis.patch.yml',
    'locale/*.json', 'icon.svg', 'README.md', 'CONTRACT.md',
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
  assert.match(patch, /^\s+name: '@local\/dsh-backend-restart'$/m)
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

await check('the channel registers under the documented name and disposes both effects', () => {
  const ctx = fakeContext()
  apply(ctx)
  assert.deepEqual(ctx.effects.map(entry => entry.label), ['backend-restart: restart exit', 'backend-restart: restart channel'])
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].channel, '/backend-restart')
  ctx.effects.forEach(entry => { if (typeof entry.disposer === 'function') entry.disposer() })
})

await check('status reports this process as restartable, and an unknown endpoint is refused', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const handler = ctx.registered[0].handler
  const status = await handler('status', {}, new AbortController().signal, {})
  assert.equal(status.ok, true)
  assert.deepEqual(Object.keys(status.value).sort(), ['pid', 'restartable', 'status'])
  assert.equal(status.value.status, 'running')
  assert.equal(status.value.pid, process.pid)
  assert.equal(status.value.restartable, true)
  const unknown = await handler('nope', {}, new AbortController().signal, {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'backend-restart/unknown-endpoint')
})

await check('a launcher without a bounded exit refuses the restart instead of half-restarting', async () => {
  const ctx = fakeContext({ appExit: null })
  apply(ctx)
  assert.equal(restartBlocker(ctx), 'this launcher has no bounded process-exit capability')
  const refused = await ctx.registered[0].handler('restart', {}, new AbortController().signal, {})
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'backend-restart/unsupported')
  const status = await ctx.registered[0].handler('status', {}, new AbortController().signal, {})
  assert.equal(status.value.restartable, false)
  assert.match(status.value.reason, /bounded process-exit/)
})

await check('a refused carrier registration falls back to the root scope, and only then', () => {
  const guarded = fakeContext({ guardError: true })
  apply(guarded)
  assert.equal(guarded.registered.length, 1)
  assert.equal(guarded.registered[0].channel, '/backend-restart')

  assert.throws(
    () => registerChannel({
      get: () => undefined,
      connection: { rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } } },
    }, async () => ({})),
    /without inject/,
  )

  let fallbacks = 0
  registerChannel({
    get: () => ({}),
    connection: { rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } } },
    root: { connection: { rpc: { handle: () => { fallbacks += 1; return () => {} } } } },
  }, async () => ({}))
  assert.equal(fallbacks, 1)
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
