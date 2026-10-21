#!/usr/bin/env node
/**
 * Hermetic self-check for `@local/dsh-use-repo-tmp`.
 *
 * Runs without a Host, a model, a network, or any filesystem write: it asserts
 * the manifest and the bundle patch, then drives `apply()` against a fake
 * Cordis context that records what the plugin registered. The fake context is
 * the whole point — the section must be cache-stable (no session-dependent
 * values, no variables, no absolute path but the fixed `/tmp` contrast) and the
 * context must resolve the real session directory through the optional
 * `workingDirectory` service, fall back to the Session header, and contribute
 * nothing (rather than throw) when neither exists.
 *
 * The patch check is structural, not textual: the YAML is deep-parsed with the
 * checkout's own js-yaml (the bundle ships no node_modules) and the document
 * must be exactly one `insert` holding exactly one `{ id, name }` row, so an
 * indent bug that detaches `name:` from the row fails. When no checkout is
 * reachable the deep parse is reported as an explicit SKIP naming the reason,
 * and the strict text fallback still runs.
 *
 * The README's quoted policy block is compared byte-for-byte against the text
 * `apply()` actually registers, so prose and prompt cannot drift.
 *
 * Run: `node verify.mjs` (from this directory or from the repository root).
 * Exit code 0 means every check passed.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from './index.js'

const { apply, inject, name, scratchText, workspaceRoot } = plugin

/** This package's directory; every read below is anchored here, never `cwd`. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Files the manifest promises; the check below also proves nothing else is here. */
const SHIPPED_FILES = ['index.js', 'verify.mjs', 'cordis.patch.yml', 'README.md', 'CONTRACT.md']

let checks = 0
let failures = 0

/**
 * Run one named check and record its outcome.
 * @param {string} label - what is being checked.
 * @param {() => void} body - assertions to run.
 * @returns {void}
 */
function check(label, body) {
  const position = checks + failures + 1
  try {
    body()
    checks += 1
    process.stdout.write(`ok ${position} - ${label}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`not ok ${position} - ${label}\n`)
    const detail = error instanceof Error ? error.message : String(error)
    process.stdout.write(`  ${detail.split('\n').join('\n  ')}\n`)
  }
}

/**
 * Record one check that could not run, without weakening any other check.
 * @param {string} label - what would have been checked.
 * @param {string} reason - why it cannot run in this environment.
 * @returns {void}
 */
function skip(label, reason) {
  const position = checks + failures + 1
  checks += 1
  process.stdout.write(`ok ${position} - ${label} # SKIP ${reason}\n`)
}

/**
 * Resolve js-yaml from a reachable DSH checkout, the way the sibling bundles do.
 * The bundle ships no node_modules, so the library is borrowed from the
 * installation; `DSH_HARNESS_CHECKOUT` is the explicit offline anchor and this
 * plugins workspace's sibling checkout is the fallback guess.
 * @returns {{ yaml?: object, gap?: string }} the library, or why it is unavailable.
 */
function loadYaml() {
  const anchors = [
    process.env.DSH_HARNESS_CHECKOUT,
    join(HERE, '..', '..', 'deepseek-harness'),
  ].filter(anchor => typeof anchor === 'string' && anchor.length > 0)
  const gaps = []
  for (const anchor of anchors) {
    try {
      return { yaml: createRequire(join(anchor, 'package.json'))('js-yaml') }
    } catch (error) {
      gaps.push(`${anchor}: ${error instanceof Error ? error.code ?? error.message : String(error)}`)
    }
  }
  return { gap: gaps.length === 0 ? 'no checkout anchor to resolve from' : gaps.join('; ') }
}

/**
 * Build a Cordis context double that records prompt registrations.
 * @param {{ workingDirectory?: object }} [options] - optional service stand-ins.
 * @returns {object} the context double, exposing what the plugin registered.
 */
function fakeContext({ workingDirectory } = {}) {
  const sections = []
  const contexts = []
  const services = new Map()
  if (workingDirectory !== undefined) services.set('workingDirectory', workingDirectory)
  return {
    sections,
    contexts,
    systemPrompt: {
      section(entry) { sections.push(entry); return () => {} },
      context(entry) { contexts.push(entry); return () => {} },
    },
    get: service => services.get(service),
  }
}

/** A Session double whose header carries a fallback directory. */
const session = { header: { cwd: '/repo/fallback' } }

/**
 * Every absolute path token in `text`: a `/` that does not continue a relative
 * path segment, plus the path characters that follow it. The slash scan matters
 * — a pattern anchored on punctuation before the token misses `cwd:/home/x`.
 * @param {string} text - text to scan.
 * @returns {string[]} distinct tokens in order of appearance.
 */
function absolutePaths(text) {
  const found = new Set()
  for (let index = text.indexOf('/'); index >= 0; index = text.indexOf('/', index + 1)) {
    const before = text[index - 1] ?? ' '
    if (/[A-Za-z0-9._~-]/.test(before)) continue
    const token = /^\/[^\s`"'),.;:]+/.exec(text.slice(index))
    if (token !== null) found.add(token[0])
  }
  return [...found]
}

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const patchText = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8')
const { yaml, gap } = loadYaml()

const ctx = fakeContext()
apply(ctx)

check('the module exports its stable name, its single required service, and no default', () => {
  assert.equal(name, 'use-repo-tmp')
  assert.deepEqual(inject, ['systemPrompt'])
  assert.equal(Object.prototype.hasOwnProperty.call(plugin, 'default'), false, 'a default export would displace the plugin namespace at load')
  assert.equal(plugin.apply, apply)
})

check('the manifest is a private ESM bundle with load-bearing export targets', () => {
  assert.equal(manifest.name, '@local/dsh-use-repo-tmp')
  assert.equal(manifest.private, true)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.main, undefined)
  assert.equal(manifest.dsh.client, undefined)
  assert.deepEqual(manifest.exports, {
    '.': './index.js',
    './package.json': './package.json',
  })
  assert.deepEqual(manifest.files, SHIPPED_FILES)
  for (const entry of manifest.files) {
    assert.ok(existsSync(new URL(`./${entry}`, import.meta.url)), `${entry} is listed but missing`)
  }
})

check('the package directory holds exactly the shipped files plus package.json', () => {
  const expected = [...manifest.files, 'package.json'].sort()
  assert.deepEqual(readdirSync(HERE).sort(), expected, 'an unlisted stray file would fail')
})

if (yaml === undefined) {
  skip('the bundle patch deep-parses to exactly one insert row', `js-yaml unavailable (${gap})`)
} else {
  check('the bundle patch deep-parses to exactly one insert row', () => {
    const doc = yaml.load(patchText, { schema: yaml.DEFAULT_SCHEMA })
    assert.ok(Array.isArray(doc), 'the document must be a YAML sequence')
    assert.equal(doc.length, 1, 'exactly one top-level entry')
    const [entry] = doc
    assert.deepEqual(Object.keys(entry), ['insert'], 'the top-level entry only inserts')
    assert.ok(Array.isArray(entry.insert), 'insert must hold a sequence of rows')
    assert.equal(entry.insert.length, 1, 'exactly one inserted row')
    const [row] = entry.insert
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'], 'the row carries exactly id and name')
    assert.equal(row.id, 'use-repo-tmp')
    assert.equal(row.name, '@local/dsh-use-repo-tmp')
  })
}

check('the bundle patch also passes the strict text fallback (fixed indentation)', () => {
  assert.match(patchText, /^- insert:$/m)
  assert.match(patchText, /^ {4}- id: use-repo-tmp$/m, 'the row id is indented exactly under insert')
  assert.match(patchText, /^ {6}name: '@local\/dsh-use-repo-tmp'$/m, 'the row name is a property of that row')
  const rows = patchText.split('\n').filter(line => line.trimStart().startsWith('- id:'))
  assert.deepEqual(rows.map(row => row.trim()), ['- id: use-repo-tmp'])
})

check('apply() registers exactly one section, the static cache-stable policy', () => {
  assert.equal(ctx.sections.length, 1)
  const section = ctx.sections[0]
  assert.equal(section.name, 'repo-tmp:policy')
  assert.equal(section.order, 950)
  assert.ok(section.order > 900 && section.order < 1000, 'order must sit between FILE_REFERENCE and TOOL_BASH')
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'string')
  assert.ok(section.text.length > 0)
  assert.equal(section.text, section.text.trim(), 'the section text must not rely on surrounding whitespace')
})

check('the policy names the repo scratch dir and /tmp, and instructs mkdir before use', () => {
  const { text } = ctx.sections[0]
  assert.ok(text.includes('tmp'), 'the policy must name tmp')
  assert.ok(text.includes('/tmp'), 'the policy must name /tmp so the contrast is explicit')
  assert.ok(text.includes('mkdir -p tmp'), 'the policy must tell the model to create the directory')
  assert.ok(text.includes('workspace'), 'the policy must anchor tmp/ at the workspace')
})

check('the policy is safe to cache: no variables, no session-dependent path, runner-scoped', () => {
  const { text } = ctx.sections[0]
  assert.ok(!text.includes('{{'), 'a cached section must not reference prompt variables')
  assert.ok(!/\\/.test(text), 'the policy must stay portable, without Windows paths or escapes')
  assert.ok(text.includes('bwrap'), 'the durability claim must stay scoped to the bwrap runner')
  // The scanner itself must not depend on punctuation before the token: the old
  // character-class pattern returned [] for `cwd:/home/user/secret/tmp`.
  assert.deepEqual(absolutePaths('cwd:/home/user/secret/tmp'), ['/home/user/secret/tmp'])
  assert.deepEqual(absolutePaths('`tmp/out.log`'), [], 'a slash inside a relative path is not absolute')
  assert.deepEqual(absolutePaths(text), ['/tmp'], 'the only absolute token may be the fixed /tmp contrast')
})

check('the README quotes the registered policy text byte-for-byte', () => {
  const quoted = /```text\n([\s\S]*?)\n```/.exec(readme)
  assert.ok(quoted !== null, 'the README must quote the policy in a ```text block')
  assert.equal(quoted[1], ctx.sections[0].text)
})

check('apply() registers exactly one context, the dynamic scratch directory', () => {
  assert.equal(ctx.contexts.length, 1)
  const context = ctx.contexts[0]
  assert.equal(context.name, 'repo-tmp:root')
  assert.equal(context.order, 111)
  assert.ok(context.order > 110, 'order must follow SANDBOX_POLICY (110)')
  assert.equal(context.interpolate, false)
  assert.equal(typeof context.text, 'function')
})

check('the context resolves the directory through the optional workingDirectory service', () => {
  const service = { get: candidate => candidate === session ? '/repo/example' : undefined }
  const served = fakeContext({ workingDirectory: service })
  apply(served)
  const text = served.contexts[0].text({ agent: { session } })
  assert.equal(text, `Durable scratch directory for this session: ${JSON.stringify(join('/repo/example', 'tmp'))}.`)
  assert.ok(text.includes(join('/repo/example', 'tmp')))
  assert.ok(!text.includes(join('/repo/fallback', 'tmp')), 'the header must not win over the service')
  assert.ok(!text.includes('\n'), 'a runtime-context line stays one line')
})

check('the context falls back to the Session header when the service is absent', () => {
  const headerOnly = fakeContext()
  apply(headerOnly)
  assert.equal(workspaceRoot(headerOnly, { agent: { session } }), '/repo/fallback')
  assert.equal(
    headerOnly.contexts[0].text({ agent: { session } }),
    `Durable scratch directory for this session: ${JSON.stringify(join('/repo/fallback', 'tmp'))}.`,
  )
})

check('the context contributes nothing, without throwing, when no directory exists', () => {
  const headerOnly = fakeContext()
  apply(headerOnly)
  const provider = headerOnly.contexts[0].text
  assert.equal(provider({}), '')
  assert.equal(provider(undefined), '')
  assert.equal(provider({ agent: {} }), '')
  assert.equal(provider({ agent: { session: { header: {} } } }), '')
  assert.equal(scratchText(headerOnly, { agent: { session: { header: {} } } }), '')
})

check('apply() stays loadable when the context exposes no services at all', () => {
  const registered = []
  const bare = {
    systemPrompt: {
      section: entry => { registered.push(entry); return () => {} },
      context: entry => { registered.push(entry); return () => {} },
    },
    get: () => undefined,
  }
  assert.doesNotThrow(() => apply(bare))
  assert.equal(registered.length, 2)
  const provider = registered.find(entry => typeof entry.text === 'function')
  assert.ok(provider !== undefined)
  assert.doesNotThrow(() => provider.text({ agent: { session: { header: { cwd: '/repo/header-only' } } } }))
})

if (failures > 0) {
  process.stdout.write(`\n# ${failures} of ${checks + failures} checks failed\n`)
  process.exit(1)
}

process.stdout.write(`\n# ${checks} checks passed; the plugin is guidance-only and enforces nothing at runtime\n`)
