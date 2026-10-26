# CONTRACT — dsh-lead-agent-only-leads

Frozen interface of the `Lead agent only leads` preset and the host plugin that keeps a
Team Lead non-blocking. Public names here are referenced by the profile's
`package.json` and by the preset picker in the Web UI.

## Why this exists

A Team Lead that can block is a Team Lead the user cannot talk to. `wait_agent`,
a long `bash` job, or a half-written file all hold the turn open, and the user's
next message has to wait behind them. The `Lead agent only leads` preset exists to remove
that: the Lead hands work out and returns to the user immediately.

## Why the preset carries the whole standard environment

A teammate spawned by a Team Lead joins the **Lead's exact preset generation**
(the subagent runtime mounts the parent's composed preset when the activation
names none — and the Team roster never names one). Anything the preset omits
would be missing for teammates too, and teammates must stay ordinary agents:
they may block, they may wait on each other, they write the files.

So the asymmetry is not in the preset. The preset is the `standard` row list
verbatim — same plugins, same order, same configs — and the Lead-only reduction
is applied per **Agent scope** at runtime, by the host plugin this bundle also
mounts. `verify.mjs` fails if the preset's rows or their configs ever drift from the
shipped `standard` preset's.

## Why per-Agent scope is the right seam

- Tools a preset mounts live in an **ancestor** layer of every Agent scope bound
  to that preset, and `tools.restrict()` filters exactly what a scope inherits.
  A restriction on the Lead's own scope therefore hides preset tools from the
  Lead and from nobody else.
- A scope's **own** layer is exempt from its own restriction — that is where the
  Agent Teams tools are registered. Handing work out is the Lead's whole job, so
  those tools must survive, and they do. The cost of the exemption is therefore
  `wait_agent`: it is an Agent-layer tool, so no restriction can hide it.
- The delegation tools are **not** own-scope: the preset mounts `tool-subagent`
  with `modelSelection: true` and `modelDiscovery: true`, which registers
  `subagent` and `list_subagent_models` in the preset generation scope — an
  ancestor layer the Lead's restriction reaches. They are ordinary `whitelist`
  rows: OFF (the default) hides them, ON keeps them.
- A guard can only deny. Nothing after this plugin can turn the Lead's refusal
  to wait back into a permission.

## Host rows

| Row id | Plugin | Purpose |
| --- | --- | --- |
| `lead-agent-only-leads` | `dsh-lead-agent-only-leads` | Applies the contract to each Lead of the preset. |
| `preset-lead-agent-only-leads` | `@deepseek-ai/dsh-agent-preset` | Declares the `lead-agent-only-leads` preset (`Lead agent only leads`, order 5). |

## The Lead's surface

Kept from the preset (the catalog `whitelist` default): `ask_user_question`,
`todo_write`, `exit_plan_mode`, `present`. The Lead cannot read, search, or view
images: what it needs to know arrives in a teammate's report. `exit_plan_mode`
stays an enabled tool — making a plan is allowed — but the contract never mentions
plan mode or planning: it only names the tool inside the resolved tool list. Plan
mode itself is session state the user enters (the `/plan` command or the composer).
`present` lets a Lead show the finished work as a file or image card in the
conversation.

A Lead's briefs are written in two steps, because the Lead cannot inspect anything
itself. The brief bullet therefore carries the reconnaissance flow: when the Lead does
not yet know a brief's exact files, write scopes, or checks, it **may create a
reconnaissance task** — one teammate on a read-only task, recorded on the shared task
board like any other task, that states the question and asks for the facts (where the
code lives, which files a change touches, how the result should be verified). The
Lead then ends its turn; the report arrives as its next turn, and it splits and briefs
the real work from what the report establishes. Nothing blocks: the Lead never waits
on the scout.

Kept from the Agent Teams layer: `spawn_teammate`, `send_message`, `list_agents`,
`interrupt_agent`, `team_task_create`, `team_task_list`, `team_task_get`,
`team_task_update`.

Refused while it stays listed (the catalog `guard` default): `wait_agent`. The
Agent Teams tools register into the Agent's **own** layer, which a restriction
cannot reach, so a monotonic guard is the only seam that can take `wait_agent`
away.

That one-name list is the catalog default, not a fixed law: a profile `tools`
override can empty it. The Lead's prompt
contract is generated from the policy `constrain()` actually resolved, so it
cannot contradict the Lead's own permissions: its refusal sentence names only the
tools present in the resolved deny list (singular/plural grammar, and the clause
is omitted entirely for an empty list), its "do not count on waiting" clause
appears only while `wait_agent` is denied, its "one-shot delegation" clause only
while `subagent` is (a legacy `denyTools` can name it), and its "cannot run shell
commands" / "cannot write or edit files" / "cannot read files, search the
workspace, or view images" claims appear
only while `bash`/`pwsh`, `write`/`edit`, and
`read`/`read_image`/`glob`/`grep` are off the resolved allow list. The closing
sentence of that paragraph names the Lead's **actual** tools, derived from the same
resolved allow list (1/2/many joining; the Team tools stay a generic trailing phrase),
and an empty list is stated as "none of the preset's tools" rather than a dangling
list. The text never mentions plan mode: `exit_plan_mode` appears only as a tool name
inside that list, whatever the resolved list keeps. `leadContract()` called with no
arguments still returns the catalog-default text byte for byte.

Hidden, because the preset mounts them and the restriction filters them:
`read`, `read_image`, `glob`, `grep`, `bash`, `pwsh`, `write`, `edit`, `job_*`,
`schedule_*`, `web_search`, `web_fetch`, `subagent`, `subagent_fork`,
`list_subagent_models`, `workflow`, `skill`. A
tool that is not visible is also absent from the prompt, because each tool's own
prompt section gates on its visibility. (`subagent`, `subagent_fork`, and
`list_subagent_models` stay hidden: they are preset-layer rows, not own-scope
registrations. Plan mode is not in this
list and not in the text: making a plan stays allowed through `exit_plan_mode`,
which the contract never advertises.)

## Per-tool toggles (the settings page)

`LEAD_TOOL_CATALOG` in `index.js` is the single source of truth for the tool
universe: 51 entries of `{ name, klass, def }`, fixed order, `klass` ∈
`whitelist` | `guard` | `none`. The client half (`client.js`) mirrors the array
verbatim and `verify.mjs` deep-compares the two.

| Class | Count | Toggle effect |
| --- | --- | --- |
| `whitelist` | 36 | ON ⇒ the name joins the Lead's allow list; OFF ⇒ omitted (the allow list hides it). |
| `guard` | 9 | OFF ⇒ denied by the guard while still listed; ON ⇒ no denial. |
| `none` | 6 | No effect. Rendered inoperative: `/goal`, `/plan`, `/compact` (commands, not tools), `plugin_manager`, `plugin_market` (disabled rows), `structured_output` (child-only). |

Defaults — ON is what the Lead can use today (4 + 8):

- ON: `ask_user_question`, `todo_write`, `exit_plan_mode`, `present` (whitelist)
  and `spawn_teammate`, `send_message`, `list_agents`, `interrupt_agent`,
  `team_task_create`, `team_task_list`, `team_task_get`, `team_task_update`
  (guard).
- OFF: `read`, `read_image`, `glob`, `grep`, `subagent`, `list_subagent_models`
  and every other `whitelist` row except the four above; `wait_agent` (guard).

Semantics. A `whitelist` tool is kept iff `tools[name] ?? def`; a `guard` tool is
denied iff `tools[name] ?? def` is OFF. The page writes one dictionary key per
toggle (`{ op: 'set', path: ['tools', name], value }`); an absent key means "use
the catalog default", so new catalog entries inherit theirs.

Precedence. An explicitly configured legacy `leadTools`/`denyTools` array wins
**wholesale** for its own list, and the catalog is not consulted for that list.
Absence of the key — not an empty array — is what selects the catalog, which is
why both keys are declared volatile and **without** a schema default.

Prompt preview. The page leads with the contract text the current selection
produces, quoted above the toggle groups. `client.js` carries a hand-kept mirror
of `leadContract()` plus a mirror of the keep/deny resolution (catalog toggles, or
a legacy `leadTools`/`denyTools` array wholesale — the quote follows the override,
since the toggles do not drive policy then), and `verify.mjs` asserts the two
builders agree byte for byte — the frozen no-argument text included — for the
catalog default, an `ask_user_question`-off selection, a `bash`-on selection, a
`grep`-only selection (which pins the `readersHidden` branch), and
a legacy override. Honest limitation: the host derives
`shellHidden`/`writersHidden`/`readersHidden` and the named tool list from the
live `reachable` scope `constrain()` reads, which the client cannot see; the
preview reports the resolved keep list as if every name were mounted, so it can
name a tool the profile does not mount, while the live prompt drops it. The
preview is a reading aid, not a second source of policy: nothing reads it back and
it changes no behaviour.

Apply timing. `tools` (and the two legacy keys) are volatile, so a page edit is
committed into the running config in place and does not remount the plugin. The
keep and deny lists are resolved inside `constrain()` from that live config, so a
change reaches **Leads created afterwards**; a running Lead keeps the surface it
was constrained with and is never re-reconciled. First-time discovery of the
client half needs one Host restart; later `client.js` edits hot-reload.

Fail-open fix. Every outcome in which the Lead may keep nothing now calls
`restrict({ allow: [] })`, which hides the whole inherited surface, instead of
leaving the Lead holding every tool. The **origin** of the keep list decides what
a zero result means:

- an empty keep list — every `whitelist` toggle off, or an explicit empty
  `leadTools` — restricts to nothing;
- a **toggle-derived** list whose names are all absent from the scope (every
  default off and only `pwsh` on, say, on Linux) also restricts to nothing, and
  the warning names the tools that are not mounted. This path is reachable from
  the page, so it fails closed rather than handing the Lead `bash` and `write`;
- names known but **none restrictable** (e.g. only own-scope Team tools) also
  keeps nothing;
- the **one** retained warn-and-keep path is an explicit legacy `leadTools` row
  config whose names are all absent from the scope: the user spoke in tool names
  about a scope the plugin did not choose, so the preset surface is left intact
  and a warning is logged.

The page is `settings.section` id `lead-agent-only-leads-tools`, registered by the client
half; the Host suppresses the auto-generated generic config page for this row
(`settings.configure({ auto: false })`, `index.js`).

Schema resolution. `Config` needs the real `@deepseek-ai/schemastery`, not a bare
standard-schema object: the loader decides "volatile-only, no remount" from
`~standard.vendor === 'schemastery'` plus the schema's `meta`/`type`/`dict`
(`vendor/loader/src/config/diff.ts`), the settings service needs `toJSON()` and
the same node shape (`packages/settings/settings/src/index.ts` `schema()`), and
the commit walks cosmokit `Volatile` references (`vendor/loader/src/config/entry.ts`
`_commitVolatile`). The bundle ships **no `node_modules`**; `resolveSchemaLibrary()`
in `index.js` loads the library from the Host that loaded the plugin — the
plugin's own location first (a marketplace install that fetched dependencies),
then the running process entry, then `$DSH_HARNESS_CHECKOUT` through the pnpm
workspace's hoisted store. If none resolves, `Config` is `undefined`: the loader
skips validation, `apply()` still enforces the catalog defaults, and the settings
page is absent because no namespace is served.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `preset` | `string` | `lead-agent-only-leads` | Preset whose Leads get the contract. |
| `tools` | `Record<string, boolean>` (volatile) | `{}` — catalog defaults | Per-tool overrides; an absent key means "use the catalog default". |
| `leadTools` | `string[]` (volatile, no default) | catalog whitelist ON | Legacy explicit keep list; wins wholesale when present. Names the scope cannot restrict are pruned. An explicit empty array keeps nothing. |
| `denyTools` | `string[]` (volatile, no default) | catalog guard OFF (`wait_agent`) | Legacy explicit deny list; wins wholesale when present. `[]` removes the guard. |

## Invariants

1. Only Agents composed under the configured preset are touched, and only the
   **Lead** of one: the Team roster decides. A teammate, an unrelated preset, and
   a provider-owned worker keep their full surface.
2. A Lead's session may be re-presetted while it is still blank. The plugin
   listens for the preset change and both applies and **lifts** its contribution.
3. Everything this plugin adds is released on preset change, on Agent disposal,
   and on plugin unload. Nothing is registered on the Host composition, so an
   uninstall leaves no residue.
4. `wait_agent` remains in the model's tool list. While the resolved deny list
   contains it (the catalog default), it is refused with actionable text:
   "wait_agent is disabled for a non-blocking Lead: end your turn instead." A
   profile `tools` override that turns it back on removes both the denial and the
   contract's refusal sentence.
5. The Lead's prompt section is named `lead-agent-only-leads:contract` and ordered 650 —
   after `TEAM_POLICY` (600), which is where the generic "The Lead must wait for
   required teammates before giving the final answer" lives. The section names
   that instruction and supersedes it. Its body is generated from the resolved
   keep/deny lists, so it describes the surface the Lead actually has: the
   refusal sentence, the shell/writer/reading claims, and the resolved tool list it
   closes with each follow the policy `constrain()` resolved, and an unreadable
   scope keeps the conservative catalog wording. The text never mentions plan mode
   (only the `exit_plan_mode` tool name may appear, inside that list). The
   no-argument `leadContract()` text is the frozen catalog-default text (1621 UTF-8
   bytes, sha256
   `70981d4fa57a6f4481a66ff11bba315d70068f0735dee5021936e4e0b3fdaf1e`), and
   `verify.mjs` asserts those exact values.
6. The plugin fails safe. A configured name the registry rejects is dropped and
   the remaining allow list still applies. Everything that resolves to "keep
   nothing" restricts the Lead to nothing rather than leaving it unrestricted: an
   empty keep list (all `whitelist` toggles off, or an explicit empty
   `leadTools`), a toggle-derived list whose names are all absent from the scope,
   and a list whose names are known but none restrictable. The only retained
   warn-and-keep path is an explicit legacy `leadTools` whose names are all
   absent from the scope, which keeps the preset tools and logs a warning. The
   Host never fails to boot because of this plugin.

## Non-goals

- It does not remove `wait_agent` from the catalog. Achieving that would mean
  disabling the profile-wide Agent Teams tool plugin and re-registering all nine
  Team tools here, changing every other session's Team tools for one catalog
  entry that is already refused.
- It does not stop teammates from waiting on each other. That is their job.
- It does not make the Lead permanently blind. `read`, `read_image`, `glob`, and
  `grep` stay in the catalog and on the settings page, so a profile can turn them
  back on for the Lead; by default they are OFF, and a teammate does the reading
  and searching.
