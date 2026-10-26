# CONTRACT — `dsh-use-repo-tmp`

Frozen interface of the `use-repo-tmp` bundle. Package directory:
`dsh-use-repo-tmp/` in this plugins workspace (installed into the active DSH profile as a
bundle via `link:`, a tarball, or a Git URL).

## Why this exists

`/tmp` is not one directory to a sandboxed session. Under the Linux bwrap runner a
`workspace-write` shell command gets a per-command `--tmpfs /tmp`
(`packages/sandbox/sandbox-local/src/profiles.ts`), so anything `bash` writes there is
discarded with the command and is never the host `/tmp` the in-process file tools use
(`packages/sandbox/sandbox/src/roots.ts`). A session that bounces intermediate files
through `/tmp` therefore loses them — or finds them missing from the other surface.
`tmp/` inside the workspace is the one directory both surfaces reach, and it survives
the turn. This bundle puts that instruction in the prompt because there is no
tool-argument rewrite seam in DSH by design.

## Owned surface (do not change without updating `verify.mjs`)

The bundle owns exactly two prompt registrations, both registered by `apply(ctx)` in
the plugin's own Cordis layer, plus the bundle patch row that mounts it.

| Kind | Name | Order | Owned fields |
| --- | --- | --- | --- |
| Section | `repo-tmp:policy` | `950` | `interpolate: false`, static string `text`. |
| Context | `repo-tmp:root` | `111` | `interpolate: false`, `text` is a provider function. |

- **Section order** `950` sits between `FILE_REFERENCE` (900) and `TOOL_BASH` (1000) in
  the central section orders, so general policy precedes tool-specific guidance. The
  literal is intentional: `getSectionOrder()` accepts only centrally allocated names,
  and `repo-tmp:policy` is not one; passing a custom name would throw.
- **Context order** `111` is `SANDBOX_POLICY` (110) + 1, so the resolved directory
  renders directly beside the "Current DSH file policy" line. Same literal rule as
  above.
- The section text is **cache-stable by contract**: no session-dependent paths, no
  absolute path other than the fixed `/tmp` contrast, no `{{variable}}` references, no
  per-session values, and the durability claim stays scoped to bwrap-sandboxed runners.
  New content must keep those properties; per-session facts belong in the context.
- The context resolves the workspace root as
  `ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd`, where `session`
  is `context.agent?.session`. Both lookups are optional: the service is looked up,
  never declared in `inject`, so the bundle loads in a profile that does not mount the
  working-directory service. No Agent being assembled (or no directory at all) yields
  `''`; an empty context text contributes nothing to the snapshot.
- The context text is one line, quoted with `JSON.stringify`, of the shape
  `Durable scratch directory for this session: "<workspace>/tmp".`

The module exports `name = 'use-repo-tmp'` and `inject = ['systemPrompt']`, plus the
pure helpers `workspaceRoot` and `scratchText` for verification. It exports no `Config`:
the bundle is zero-config by design, and it has no settings page.

## Bundle patch

```yaml
- insert:
    - id: use-repo-tmp
      name: 'dsh-use-repo-tmp'
```

One top-level insert at the bundle layer — not a row inside a preset — because the
guidance must reach every Agent in the composition: the main agent, every subagent, and
every teammate. A preset row would only reach the Agents bound to that preset.

## What this bundle must not do

- **No tool interception.** No pre-tool guard, no deny, no approval, no tool
  registration, restriction, or reordering. Denying `/tmp` only converts a working
  command into a retry, because the decision cannot redirect the call, and rewriting is
  excluded from the tool seam by design (`packages/core/tools/src/index.ts`: "Input
  rewriting is excluded because arguments are already logged and presented").
- **No file or shell provider swap, and no sandbox change.** The bundle must never
  remap paths, mount anything, or alter a policy. It describes the sandbox; it does not
  govern it.
- **No enforced persistence claim.** It must not state or imply that the host `/tmp` is
  deleted: under the Landlock and Seatbelt runners the real `/tmp` is granted
  read-write and is shared. The claim is limited to durability inside the bwrap runner
  and to the asymmetry between the confined shell and the in-process file tools.
- **No writes outside the prompt registry.** No files, no directories, no environment
  variables, no Harness home changes, no config, no session state.
- **No hard requirement on `workingDirectory`.** Declaring it in `inject` would make the
  bundle fail to load in profiles without the service and would couple it to the
  service's lifecycle.
- **No duplicate names within one layer.** A section or context name is unique per
  layer; re-registering the same name, or shipping the bundle twice, is a load error by
  design.

## Composition

- One `apply()` call registers both entries; Cordis owns their disposal through the
  plugin's fiber, so uninstalling or reloading the bundle removes them with it.
- The bundle is side-effect free at import time: the only import is `node:path`, and no
  work happens until `apply()` runs.
- The static section is always present; the dynamic line renders only when it resolves
  non-empty. Suppressing optional runtime context removes the line and leaves the policy
  intact.
- Repository convention: a consuming repository should ignore `tmp/` in its
  `.gitignore`, because the policy tells the model to create the directory on demand and
  never to commit it.

## Verification

`node verify.mjs` (from this directory or from the repository root) is hermetic and is
the executable form of this contract. It asserts the manifest and patch, then drives
`apply()` against a fake Cordis context: exactly one section and one context with the
names, orders, and `interpolate: false` above; the section's cache-stability and
`/tmp`-only absolute path; context resolution through the service, the Session-header
fallback, and the `''`/no-throw empty case; and loadability with a context that exposes
no services. A change to any value in the table above must update this document and
`verify.mjs` together.
