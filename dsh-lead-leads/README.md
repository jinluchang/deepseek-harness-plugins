# dsh-lead-leads

A DeepSeek Harness bundle that adds a **Lead leads** agent preset: a Team Lead
that hands every job to teammates and stays available to the user. By default it
cannot run shell commands, cannot write files, cannot wait for a teammate to
finish, and cannot start a one-shot `subagent` — but it keeps every tool it needs
to delegate, steer, and answer:

| | Standard Lead | Lead leads |
| --- | --- | --- |
| Shell (`bash`), file writes (`write`, `edit`) | yes | **no** |
| Jobs, scheduling, web, `subagent_fork`, workflow, plan mode | yes | **no** |
| `read`, `read_image`, `glob`, `grep` | yes | yes |
| `ask_user_question`, `todo_write` | yes | yes |
| `spawn_teammate`, `send_message`, `list_agents`, `interrupt_agent`, task board | yes | yes |
| `wait_agent`, `subagent`, `list_subagent_models` | yes | listed; **refused** by default |
| Teammates | standard | **standard** |

`wait_agent`, `subagent`, and `list_subagent_models` stay in the Lead's tool list
but are refused by the guard **by default** — that is the catalog `guard` default,
not a fixed law. They register into the Agent's **own** scope, which
`tools.restrict()` cannot reach, so the guard is the only seam that takes them
away, and each refusal names the replacement (`spawn_teammate` / `send_message`).
A profile `tools` override changes the default: the live `web` profile patch sets
`tools: { subagent: true, list_subagent_models: true }`, so there the guard refuses
only `wait_agent`. The Lead's **prompt contract is generated from the resolved
policy**, so its refusal sentence names only the tools actually denied and its
shell/write claims follow the resolved allow list; it never contradicts the
permissions the Lead really has. Note also that `list_subagent_models` is
registered only when a preset mounts the delegation tool with
`modelSelectionSettings: true`; with no per-session model-selection policy it is
not in any Agent's tool list, so naming it would describe a tool that does not
exist.

Teammates are ordinary agents: they may block, they may wait on each other, and
they do the writing. The restriction and the guard apply to the Lead's own Agent
scope only, so nothing else in the profile changes.

## Install

The bundle is a normal workspace plugin. Point the installer at the directory:

```
plugin_manager({ action: "install_bundle", target: "/home/user/Public/deepseek-harness-plugins/dsh-lead-leads" })
```

That registers the bundle in the profile, links the package, and appends its
patch. Bundles apply to **new sessions**: restart the Host, then pick
**Lead leads** when starting a session in the Web UI.

## Use

Start a new session and choose the `Lead leads` preset (the composer's preset
seat lists it as *Lead leads*). The Lead will delegate: give it a task, and it
briefs a teammate and comes straight back to you. Teammate reports arrive as new
turns, so you can keep talking while work is in flight.

## Settings page

The bundle ships a **Lead tools** page under Settings (section id
`lead-leads-tools`), driven by the Host's `configForms` namespace for the
`lead-leads` row. It lists the whole tool universe grouped by mechanism, with a
per-row description and its default, and writes one dictionary key per toggle:

- **Whitelist** (34) — preset/global-layer tools. ON keeps the tool, OFF hides
  it. Defaults ON: `read`, `read_image`, `glob`, `grep`, `ask_user_question`,
  `todo_write`; every other row defaults OFF.
- **Guard** (11) — own-scope tools a restriction cannot reach, so OFF denies
  them through the guard. Defaults ON: the eight Team tools. Defaults OFF:
  `wait_agent`, `subagent`, `list_subagent_models`.
- **No effect** (6) — `/goal`, `/plan`, `/compact` (commands, not tools),
  `plugin_manager`, `plugin_market` (not mounted in this profile), and
  `structured_output` (only appears inside a delegated child). Shown disabled,
  with a *not toggleable* badge where the switch would be. These rows no longer
  render a `default on/off` line: that label was inert, because the plugin
  ignores `none` entries entirely, so only togglable rows show their default.

Toggles are **volatile**: an edit is committed into the running config without
remounting the plugin, so it applies to **Leads created afterwards**; a Lead
that is already running keeps the surface it was constrained with. The first
install needs one Host restart for the client half to be discovered; later
`client.js` edits hot-reload.

The bundle ships **no `node_modules`**. `index.js` resolves the config-schema
library (`@deepseek-ai/schemastery`) from the Host that loaded it: a normal
import first (a marketplace install that fetched dependencies), then the running
process entry, then `$DSH_HARNESS_CHECKOUT` through the workspace's hoisted store.
Offline and restart-safe. If none resolves, the plugin still enforces the catalog
defaults; only the settings page is absent, because no config namespace exists.

Turning every whitelist toggle off keeps **nothing** — the Lead is restricted to
its own-scope tools rather than left holding every tool. The same fail-closed
rule covers a toggle list whose tools are not mounted in this scope (everything
off except `pwsh`, say, on Linux): the Lead keeps nothing and the warning names
the tools that are not mounted. The only path that leaves the preset surface
intact is an explicit legacy `leadTools` row config whose names are all absent
from the scope. An explicitly configured legacy `leadTools`/`denyTools` array
still wins wholesale over the catalog for its own list, and the page shows a
notice while one is set.

## Files

| File | What it is |
| --- | --- |
| `cordis.patch.yml` | Two host rows: the plugin, and the preset declaration. |
| `index.js` | The plugin: per-Agent restriction, denial guard, prompt contract, catalog, `Config`. |
| `client.js` | Client half: the `Lead tools` settings page and the mirrored `LEAD_TOOL_CATALOG`. |
| `locale/*.json` | Marketplace metadata (title/description). |
| `verify.mjs` | Offline check suite — `node verify.mjs`. |
| `CONTRACT.md` | Frozen interface, invariants, non-goals. |
| `package.json` | Bundle manifest (`dsh.bundle.patch`, `dsh.client`). |

## Configure

Row config, in the profile patch. The settings page writes `tools`; these keys
are the manual equivalent:

```yaml
- id: lead-leads
  config:
    preset: lead-leads                # which preset gets the contract
    tools:                            # per-tool toggles; absent key = catalog default
      bash: true
    leadTools: [read, glob, grep]     # legacy: explicit keep list, wins wholesale
    denyTools: []                     # legacy: explicit deny list; [] removes the guard
```

`tools` and the two legacy keys are volatile, so an edit reaches Leads created
afterwards without a plugin remount. Every `leadTools` name the scope cannot
restrict is pruned rather than fatal; an explicit empty `leadTools` keeps
**nothing** (the "all off" intent), and `denyTools: []` removes the guard.

## Verify

```
node verify.mjs
```

Thirty-nine checks on a checkout whose `js-yaml` is reachable: the pure helpers,
the `Config` schema shape, the catalog, the config-aware contract text (the frozen
no-argument bytes, an empty deny list, a `subagent`-only deny, the gated
shell/write claims, and the text the plugin actually registers under the live
profile's override shape), the plugin's behaviour against a model of
the two scope layers (preset-inherited vs. Agent-owned), the toggle→keep/deny
mapping including the all-off and unknown-names cases, a deep-parse of the patch
that also proves this preset mounts exactly the shipped `standard` rows, and a
real load of `client.js` through a stubbed module loader that deep-compares the
host and client catalogs. The suite needs no live Host; it reads the harness
checkout for `js-yaml` and `standard.patch.yml`, and the one aggregate
deep-parse check is skipped when the checkout is unreachable.

## Why it is built this way

The preset deliberately duplicates the `standard` plugin list instead of being
narrow. A teammate inherits the Lead's preset generation, so a narrow preset
would make the teammates non-standard too; the reduction has to happen per Agent
scope at runtime. `CONTRACT.md` explains the seam, what it can and cannot do, and
why the catalog refuses `wait_agent`, `subagent`, and `list_subagent_models` with
a guard rather than deleting them from the catalog.
