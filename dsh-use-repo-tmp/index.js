/**
 * `dsh-use-repo-tmp`: point scratch work at `<workspace>/tmp`, not `/tmp`.
 *
 * Under the live Linux bwrap sandbox each confined `bash` call runs with a fresh `tmpfs`
 * on `/tmp` (`packages/sandbox/sandbox-local/src/profiles.ts`), while the in-process
 * file tools write the host `/tmp` the policy lists as writable
 * (`packages/sandbox/sandbox/src/roots.ts`). The two surfaces never share `/tmp`: a
 * shell-written file is gone by the next call and was never visible to
 * `read`/`write`/`edit`, and a file-tool-written file is invisible to the next call.
 * `tmp/` inside the workspace is the one directory every surface reaches and that
 * survives the turn, so the guidance is about durability and consistency — not about
 * the host `/tmp` being deleted. Runner-dependent: under Landlock the real `/tmp` is
 * granted read-write and is shared, so there the advice is a convention.
 *
 * Guidance only: one cache-stable policy section plus one runtime context naming the
 * resolved directory. DSH has no tool-argument rewrite seam by design (a pre-tool
 * decision only allows, denies, or asks — `packages/core/tools/src/index.ts`), and a
 * deny guard would turn a working command into a retry loop without making the file
 * appear, so the prompt is the honest seam.
 *
 * @module dsh-use-repo-tmp
 */

import { join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'use-repo-tmp'

/** Required service: the registry that owns prompt sections and runtime contexts. */
export const inject = ['systemPrompt']

/** Scratch directory name under the workspace root. */
const SCRATCH = 'tmp'

/** Between `FILE_REFERENCE` (900) and `TOOL_BASH` (1000): general policy before shell guidance. */
const POLICY_ORDER = 950

/** One past `SANDBOX_POLICY` (110): renders beside the "Current DSH file policy" line. */
const ROOT_ORDER = 111

/**
 * Cache-stable policy: no working directory, no absolute path but the `/tmp`
 * contrast, and no `{{variables}}`, so every session and cache prefix shares it.
 */
const POLICY = [
  'Put scratch files, temporary downloads, and generated artifacts under `tmp/` at the root of the workspace — the current working directory — instead of `/tmp`.',
  '`/tmp` is not durable on a bwrap-sandboxed runner: a confined shell there gets its own empty `/tmp` that is not the host `/tmp` the file tools read, so anything written there can vanish or stay invisible to other tools.',
  'Run `mkdir -p tmp` before the first use, then address the files by workspace-relative path (`tmp/out.log`) or by absolute path inside the workspace. Keep intermediates there while a task needs them; do not put tracked deliverables in `tmp/`.',
].join('\n\n')

/**
 * Resolve the workspace root the way the loop does: the Session's effective
 * working directory when that service is mounted, its header otherwise. The
 * service is looked up, not injected, so the bundle still loads without it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [context] - the prompt assembly context.
 * @returns {string | undefined} the absolute workspace root, or undefined when no Agent is assembled.
 */
export function workspaceRoot(ctx, context) {
  const session = context?.agent?.session
  if (session === undefined) return undefined
  return ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd
}

/**
 * Build the runtime-context line naming the durable scratch directory.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} [context] - the prompt assembly context.
 * @returns {string} the context text, or '' when no workspace is named (empty context contributes nothing).
 */
export function scratchText(ctx, context) {
  const root = workspaceRoot(ctx, context)
  if (root === undefined) return ''
  return `Durable scratch directory for this session: ${JSON.stringify(join(root, SCRATCH))}.`
}

/**
 * Register the policy section and the resolved scratch directory.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'repo-tmp:policy',
    order: POLICY_ORDER,
    interpolate: false,
    text: POLICY,
  })
  ctx.systemPrompt.context({
    name: 'repo-tmp:root',
    order: ROOT_ORDER,
    interpolate: false,
    text: context => scratchText(ctx, context),
  })
}
