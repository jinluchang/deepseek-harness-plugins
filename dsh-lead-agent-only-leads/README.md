# dsh-lead-agent-only-leads

English | [中文](README.zh.md)

A DeepSeek Harness bundle that adds a **Lead agent only leads** preset: a Team Lead
that hands every job to teammates and stays available to the user. By default it
cannot run shell commands, cannot read or search the workspace, cannot view
images, cannot write files, cannot wait for a teammate to finish, and cannot start
a one-shot `subagent` — but it keeps every tool it needs to delegate, steer,
present, and answer:

| | Standard Lead | Lead agent only leads |
| --- | --- | --- |
| Shell (`bash`), file writes (`write`, `edit`) | yes | **no** |
| Reading and search (`read`, `read_image`, `glob`, `grep`) | yes | **no** |
| Jobs, scheduling, web, `subagent_fork`, workflow | yes | **no** |
| `ask_user_question`, `todo_write` | yes | yes |
| Plan mode (`exit_plan_mode`) | yes | yes — the tool stays enabled; the contract neither mentions nor encourages planning |
| `present` (file and image cards) | yes | yes |
| `spawn_teammate`, `send_message`, `list_agents`, `interrupt_agent`, task board | yes | yes |
| `wait_agent` | yes | listed; **refused** by default |
| `subagent`, `list_subagent_models` | yes | **hidden** by default |
| Teammates | standard | **standard** |

`wait_agent` stays in the Lead's tool list but is refused by the guard
**by default** — that is the catalog `guard` default, not a fixed law. It
registers into the Agent's **own** scope, which `tools.restrict()` cannot reach,
so the guard is the only seam that takes it away, and the refusal names the
replacement (`send_message` / ending the turn).

`subagent` and `list_subagent_models` need no guard: in the current DSH the
preset mounts the delegation tool with `modelSelection: true` and
`modelDiscovery: true`, which registers both tools in the preset generation
scope — an **ancestor** layer the Lead's restriction reaches. They are ordinary
`whitelist` rows: OFF by default (hidden by the allow list), and a profile
`tools` override that turns one on keeps it. The Lead's **prompt contract is
generated from the resolved policy**, so its refusal sentence names only the
tools actually denied, its shell, writer, and reading claims follow the resolved
allow list, and its closing claim sentence names the Lead's **actual** tools —
derived from that same allow list, with the Team tools kept as a generic phrase —
so the text cannot go stale when the catalog changes. It never contradicts the
permissions the Lead really has. `exit_plan_mode` stays an enabled tool — making
a plan is allowed — but the contract never mentions plan mode or planning; it
only names the tool inside the resolved list. `list_subagent_models` is
registered only when a preset mounts the delegation tool with
`modelDiscovery: true`; a profile whose delegation row omits it has no such tool,
so the Lead never names it.

Teammates are ordinary agents: they may block, they may wait on each other, and
they do the writing. The restriction and the guard apply to the Lead's own Agent
scope only, so nothing else in the profile changes.

## Install

The bundle is a normal workspace plugin. Point the installer at the directory:

```
plugin_manager({ action: "install_bundle", target: "/path/to/deepseek-harness-plugins/dsh-lead-agent-only-leads" })
```

That registers the bundle in the profile, links the package, and appends its
patch. Bundles apply to **new sessions**: restart the Host, then pick
**Lead agent only leads** when starting a session in the Web UI.

**Upgrading an installed profile.** The Web editor writes a full
`preset-lead-agent-only-leads` row (its `config.plugins` list included) into the
profile's own `cordis.patch.yml`, and that user layer overrides the bundle row by
id. A row saved under an earlier bundle revision keeps the retired
`tool-subagent-list-agents` row and the old `modelSelectionSettings` config, so
delete that row from the profile patch (or re-save the preset in the Web editor)
after upgrading. The bundle patch itself already carries the current `standard`
rows and configs.

## Use

Start a new session and choose the `Lead agent only leads` preset (the composer's preset
seat lists it as *Lead agent only leads*). The Lead will delegate: give it a task, and it
briefs a teammate and comes straight back to you. Teammate reports arrive as new
turns, so you can keep talking while work is in flight.

Because the Lead cannot read, search, or list the repository, it may not know a
brief's exact files or checks up front. Its contract therefore folds reconnaissance
into the brief bullet: to know those files or checks it **may create a reconnaissance
task** — one teammate on a **read-only task**, recorded on the shared board like any
other task, that states the question and asks for the facts (where the code lives,
which files a change touches, how the result should be verified). The Lead then ends
its turn: the report arrives as its next turn, and it splits and briefs the real work
from what that report establishes. Nothing blocks: the Lead never waits on the scout.

## Settings page

The bundle ships a **Lead agent only leads** page under Settings (section id
`lead-agent-only-leads-tools`), driven by the Host's `configForms` namespace for the
`lead-agent-only-leads` row. It lists the whole tool universe grouped by mechanism, with a
per-row description and its default, and writes one dictionary key per toggle:

- **Whitelist** (36) — preset/global-layer tools, the two delegation tools
  included. ON keeps the tool, OFF hides it. Defaults ON: `ask_user_question`,
  `todo_write`, `exit_plan_mode`, `present`; every other row — the four reading
  tools (`read`, `read_image`, `glob`, `grep`) included — defaults OFF.
- **Guard** (9) — own-scope tools a restriction cannot reach, so OFF denies
  them through the guard. Defaults ON: the eight Team tools. Defaults OFF:
  `wait_agent`.
- **No effect** (6) — `/goal`, `/plan`, `/compact` (commands, not tools),
  `plugin_manager`, `plugin_market` (not mounted in this profile), and
  `structured_output` (only appears inside a delegated child). Shown disabled,
  with a *not toggleable* badge where the switch would be. These rows no longer
  render a `default on/off` line: that label was inert, because the plugin
  ignores `none` entries entirely, so only togglable rows show their default.

The page **leads with the Lead contract prompt the current selection produces**, shown as a
quote above the groups: it is the text `constrain()` hands the Lead's system prompt, so the
page can be read as "this is what the Lead will be told". `client.js` mirrors the host's
`leadContract()` and the same keep/deny resolution (catalog toggles, or a legacy
`leadTools`/`denyTools` array wholesale — the quote follows that override too, because the
toggles stop driving policy then), and `verify.mjs` compares the two builders byte for byte for
the catalog default, an `ask_user_question`-off selection, a `bash`-on selection, a `grep`-only
selection (which pins the `readersHidden` branch), and a legacy
override. Honest limit: the client derives the three capability claims and the named tool list
from this page's catalog plus the toggles and cannot read the host's live `reachable` scope, so
a tool the profile does not mount still appears in the preview, where the live prompt drops it.
The quote updates with every toggle, because it is computed from the same live snapshot the rows
render.

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
| `client.js` | Client half: the `Lead agent only leads` settings page and the mirrored `LEAD_TOOL_CATALOG`. |
| `locale/*.json` | Marketplace metadata (title/description). |
| `verify.mjs` | Offline check suite — `node verify.mjs`. |
| `CONTRACT.md` | Frozen interface, invariants, non-goals. |
| `package.json` | Bundle manifest (`dsh.bundle.patch`, `dsh.client`). |

## Configure

Row config, in the profile patch. The settings page writes `tools`; these keys
are the manual equivalent:

```yaml
- id: lead-agent-only-leads
  config:
    preset: lead-agent-only-leads     # which preset gets the contract
    tools:                            # per-tool toggles; absent key = catalog default
      bash: true
    leadTools: [ask_user_question, todo_write]   # legacy: explicit keep list, wins wholesale
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

Forty-five checks on a checkout whose `js-yaml` is reachable: the pure helpers,
the `Config` schema shape, the catalog and its defaults (the reading tools off,
`exit_plan_mode` and `present` on, in catalog order), the config-aware contract text
(the frozen no-argument bytes and hash, the no-plan-mode invariant, the merged
reconnaissance bullet asserted byte for byte, the resolved-tool-list sentence and its
1/2/many/empty renderings, an empty deny list, a `subagent`-only deny, the gated
shell/writer/reading claims, and the text the plugin
actually registers under a delegation opt-in override shape), the plugin's
behaviour against a model of the two scope layers (preset-inherited vs.
Agent-owned, including a scope that does not mount `exit_plan_mode`), the
toggle→keep/deny mapping including the all-off and unknown-names cases, a
deep-parse of the patch that also proves this preset mounts exactly the shipped
`standard` rows and configs, and a real load of `client.js` through a stubbed
module loader
that deep-compares the host and client catalogs. The suite needs no live Host; it
reads the harness checkout for `js-yaml` and `standard.patch.yml`, and the one
aggregate deep-parse check is skipped when the checkout is unreachable.

## Why it is built this way

The preset deliberately duplicates the `standard` plugin list instead of being
narrow. A teammate inherits the Lead's preset generation, so a narrow preset
would make the teammates non-standard too; the reduction has to happen per Agent
scope at runtime. `CONTRACT.md` explains the seam, what it can and cannot do, and
why the catalog refuses `wait_agent` with a guard while keeping `subagent` and
`list_subagent_models` as ordinary whitelist rows hidden by the restriction.
