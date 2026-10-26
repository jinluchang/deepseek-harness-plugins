# `dsh-use-repo-tmp`

Prompt guidance that tells the model to put scratch files, temporary downloads, and generated
artifacts under `tmp/` at the root of the workspace — the current working directory — instead
of `/tmp`, and resolves that directory for the session in the runtime-context snapshot.

It is **guidance only**. It registers one static system-prompt section and one runtime context.
It does not intercept tool calls, does not guard or rewrite any tool, does not swap the file or
shell provider, and installs nothing outside the active profile.

## The problem it addresses

`/tmp` does not mean the same directory to every surface of a sandboxed DSH session:

- **A confined shell command gets a private, ephemeral `/tmp`.** On the Linux bwrap runner, a
  `workspace-write` command runs with `--tmpfs /tmp` plus a writable bind of the workspace
  (`packages/sandbox/sandbox-local/src/profiles.ts`). The tmpfs is created for that one command
  and discarded when it exits, so a file written to `/tmp` by `bash` is gone by the next
  command. A persistent terminal session is one long-lived bwrap process, so its tmpfs lasts for
  that session — it is still not the host `/tmp` and it disappears with the session.
- **The file tools write the host `/tmp`.** `read`, `write`, and `edit` run in-process behind the
  file-effect fence, whose `workspace-write` allow-list is the workspace root, the host `/tmp`,
  and `os.tmpdir()` (`packages/sandbox/sandbox/src/roots.ts`).

The two surfaces therefore never share `/tmp` under that runner: a shell-written file is
invisible to the file tools (and dies with the command), and a file-tool-written file is
invisible to the next shell command. `tmp/` inside the workspace is the one directory every
surface can share and that survives the turn.

This asymmetry is **runner-dependent**, and the injected text says so: it scopes the durability
claim to bwrap-sandboxed runners and never claims that the host `/tmp` is wiped or deleted. Under
the Landlock runner `/tmp` is granted read-write and is the real host `/tmp`, so there the advice
is a convention about durability and consistency, not a workaround for a missing directory. On
every runner, keeping intermediates inside the workspace is still the safer habit: it is the one
location the workspace-write policy promises, and it makes a task's artifacts inspectable and
disposable after the fact.

## What is injected

Both registrations live in the plugin's own Cordis layer, so one `apply()` covers every Agent in
the composition — the Lead, subagents, and teammates.

| Seam | Name | Order | Content |
| --- | --- | --- | --- |
| System-prompt section | `repo-tmp:policy` | `950` | Static text, `interpolate: false`. |
| Runtime context | `repo-tmp:root` | `111` | `Durable scratch directory for this session: "<workspace>/tmp".`, `interpolate: false`. |

Order `950` places the section between `FILE_REFERENCE` (900) and `TOOL_BASH` (1000), so the
general policy is read before the tool-specific shell guidance. Order `111` is one past
`SANDBOX_POLICY` (110), so the resolved directory renders directly beside the "Current DSH file
policy" line. Both orders are written as literals because a custom section or context name is
not part of `getSectionOrder`/`getContextOrder`'s typed placement union.

The section is deliberately **cache-stable**: it carries no session-dependent path, no
interpolation variables, and no per-session value, so every session and every cached prompt
prefix shares one text. The only absolute path in it is the literal `/tmp` being contrasted.

The context is dynamic and value-bearing. It resolves the workspace root as
`ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd` — the optional lookup keeps
the bundle loadable in a profile that does not mount the working-directory service — and
contributes an empty string (which renders nothing) when no Agent is being assembled. The path
is quoted with `JSON.stringify`, so a directory containing spaces or unusual characters cannot
break the sentence.

Injected policy text:

```text
Put scratch files, temporary downloads, and generated artifacts under `tmp/` at the root of the workspace — the current working directory — instead of `/tmp`.

`/tmp` is not durable on a bwrap-sandboxed runner: a confined shell there gets its own empty `/tmp` that is not the host `/tmp` the file tools read, so anything written there can vanish or stay invisible to other tools.

Run `mkdir -p tmp` before the first use, then address the files by workspace-relative path (`tmp/out.log`) or by absolute path inside the workspace. Keep intermediates there while a task needs them; do not put tracked deliverables in `tmp/`.
```

## Install

The bundle is a normal profile plugin, not a workspace package. Capture its path in this plugins
workspace, then install it from the DSH checkout root:

```sh
# in this plugins workspace
PLUGIN="$(pwd)/dsh-use-repo-tmp"

# from the DSH checkout root
pnpm dsh plugin --profile web add link:"$PLUGIN"
```

The plugin then loads on the next full page load; no build step is needed, because the bundle is
plain ESM loaded from source. In a running GUI session the same step is the `plugin_manager`
tool with `action: install_bundle` and `target: "$PLUGIN"`.

## Verify

```sh
# from this plugin directory
node --check index.js && node verify.mjs

# from the plugins workspace root
node dsh-use-repo-tmp/verify.mjs
```

`verify.mjs` is hermetic: no network, no model, no filesystem write. It checks the manifest and
the bundle patch (deep-parsed with the js-yaml of a reachable DSH checkout — the checkout of the
`DSH_HARNESS_CHECKOUT` override or the sibling `deepseek-harness` directory; when neither is
reachable the deep parse prints an explicit `SKIP` naming the reason and the strict text fallback
still runs), drives `apply()` against a fake Cordis context, and asserts the section's name,
order, cache-stability (no variables, no session-dependent path, only the fixed `/tmp` token),
and the context's resolution order — service first, Session header as the fallback, `''` and no
throw when neither exists. It also compares the policy block quoted above byte-for-byte with the
text `apply()` registers. It passes from the plugin directory and from the plugins workspace
root.

Repositories that adopt this convention should ignore the directory:

```gitignore
/tmp/
```

## Alternatives considered and rejected

- **Deny `/tmp` at the file tools** (`PreToolDecision` / `tools.guard`). A guard sees the call,
  but a pre-tool decision can only allow, deny, cancel, or ask
  (`packages/core/tools/src/index.ts`), so denying produces a failed call and a retry, not a
  file at a usable path. It is also the wrong claim about policy: the host `/tmp` really is
  writable through the file tools.
- **Swap or wrap the file/shell provider** to remap `/tmp` into the workspace. That widens the
  sandbox's trust boundary to save the model one path segment, and it would silently change the
  meaning of every command that legitimately means the host `/tmp`.
- **Rewrite tool arguments** before dispatch. DSH has no such seam by design: "Input rewriting
  is excluded because arguments are already logged and presented"
  (`packages/core/tools/src/index.ts`). The guidance goes into the prompt because the prompt is
  where behaviour can be changed without lying about what the tools did.

## What it cannot do

- It cannot enforce anything. A model that ignores the section can still write to `/tmp`, and
  the plugin has no opinion about the result.
- It cannot make a shell's `/tmp` and the file tools' `/tmp` agree; only the sandbox runner and
  the tools own that.
- It changes no permission. Under `workspace-write`, `tmp/` inside the workspace is writable;
  under `read-only` nothing is, and this plugin does not widen that.
- It does not add, hide, or reorder tools. It contributes one cache-stable prompt section and
  one runtime-context line, and it persists nothing between sessions.
- It assumes the workspace root is where the task's files belong. A session whose
  working directory is intentionally outside the project (for example a scratch directory the
  user chose) gets that directory named, which is the honest answer for that session.

## Files

| File | Role |
| --- | --- |
| `index.js` | The static policy section, the dynamic scratch-directory context, `apply()`. |
| `cordis.patch.yml` | Bundle patch: one top-level insert so every Agent receives the guidance. |
| `verify.mjs` | Hermetic self-check of the manifest, the patch, and both registrations. |
| `README.md` | This document. |
| `CONTRACT.md` | The frozen surface of the bundle. |
