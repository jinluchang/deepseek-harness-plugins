# dsh-lead-agent-only-leads

[English](README.md) | 中文

一个 DeepSeek Harness 插件包，新增 **Lead 只负责带领**预设：一个把每项工作都交给 teammate、自己始终对用户可用的 Team Lead。默认情况下它不能运行 shell 命令、不能读取或搜索工作区、不能查看图片、不能写文件、不能等待 teammate 完成，也不能启动一次性 `subagent`——但它保留了委派、引导、呈现和回答所需的全部工具：

| | 标准 Lead | Lead 只负责带领 |
| --- | --- | --- |
| Shell（`bash`）、文件写入（`write`、`edit`） | 是 | **否** |
| 读取与搜索（`read`、`read_image`、`glob`、`grep`） | 是 | **否** |
| 作业、调度、web、`subagent_fork`、workflow | 是 | **否** |
| `ask_user_question`、`todo_write` | 是 | 是 |
| Plan 模式（`exit_plan_mode`） | 是 | 是——该工具保持启用；约定既不提及也不鼓励规划 |
| `present`（文件与图片卡片） | 是 | 是 |
| `spawn_teammate`、`send_message`、`list_agents`、`interrupt_agent`、任务板 | 是 | 是 |
| `wait_agent` | 是 | 列出；默认被**拒绝** |
| `subagent`、`list_subagent_models` | 是 | 默认被**隐藏** |
| Teammate | 标准 | **标准** |

`wait_agent` 仍留在 Lead 的工具列表里，但**默认**被守卫拒绝——那是 catalog 的 `guard` 默认值，不是固定法则。它注册进 Agent **自己的**作用域，`tools.restrict()` 触及不到那里，因此守卫是唯一能拿走它的 seam，拒绝信息也会指出替代做法（`send_message` / 结束本轮次）。

`subagent` 与 `list_subagent_models` 不需要守卫：在当前 DSH 中，预设以 `modelSelection: true` 和 `modelDiscovery: true` 挂载委派工具，这会把两个工具注册进预设的代际作用域——那是 Lead 的限制能够触及的**祖先**层。它们是普通的 `whitelist` 行：默认 OFF（被允许列表隐藏），而把其中一个打开的 profile `tools` 覆盖会保留它。Lead 的**提示词约定由解析后的策略生成**，因此它的拒绝句只列出真正被拒绝的工具，其 shell、写入与读取论断都跟随解析后的允许列表，结尾那句论断列出的也是 Lead 的**实际**工具——同样由那份允许列表推导，并让 Team 工具保持为泛称——所以当 catalog 变化时文本不会过时。它从不与 Lead 真正拥有的权限相矛盾。`exit_plan_mode` 仍是启用的工具——允许制定计划——但约定从不提及 plan 模式或规划；它只在解析后的列表中列出该工具。`list_subagent_models` 只有在预设以 `modelDiscovery: true` 挂载委派工具时才被注册；如果某个 profile 的委派行省略了它，就没有这个工具，因此 Lead 也从不会列出它。

Teammate 是普通 agent：它们可以阻塞、可以互相等待，并且由它们来写。限制与守卫只作用于 Lead 自己的 Agent 作用域，所以 profile 中的其他东西都不变。

## 安装

该插件包是普通的工作区插件。把安装器指向该目录：

```
plugin_manager({ action: "install_bundle", target: "/path/to/deepseek-harness-plugins/dsh-lead-agent-only-leads" })
```

这会把插件包注册进 profile、链接该包并追加它的补丁。插件包作用于**新会话**：重启 Host，然后在 Web UI 里启动会话时选择 **Lead 只负责带领**。

**升级已安装的 profile。** Web 编辑器会把一整行 `preset-lead-agent-only-leads`（包含其 `config.plugins` 列表）写入 profile 自己的 `cordis.patch.yml`，而那一用户层会按 id 覆盖插件包行。以更早的插件包版本保存的行会保留已退役的 `tool-subagent-list-agents` 行和旧的 `modelSelectionSettings` 配置，因此升级后请从 profile 补丁中删除该行（或在 Web 编辑器中重新保存该预设）。插件包补丁本身已经带有当前的 `standard` 行与配置。

## 使用

启动新会话并选择 `Lead agent only leads` 预设（输入框的预设位显示为 *Lead 只负责带领*）。Lead 会负责委派：给它一个任务，它会向 teammate 交代简报，然后立刻回到你这里。Teammate 的报告会作为新的轮次到达，因此工作还在进行时你可以继续对话。

由于 Lead 不能读取、搜索或列举仓库，它可能事先并不知道某份简报中确切的文件或检查项。因此它的约定把侦察并入了简报条目：为了知道那些文件或检查项，它**可以创建一个侦察任务**——让一个 teammate 承担一项**只读任务**，与其他任务一样记录在共享任务板上，写明问题并索取事实（代码在哪里、某次改动涉及哪些文件、结果应如何校验）。随后 Lead 结束自己的轮次：报告作为它的下一个轮次到达，它再依据该报告确立的内容拆分并交代真正的工作。没有任何环节被阻塞：Lead 从不等待侦察者。

## 设置页

该插件包在设置下提供一个 **Lead 只负责带领**页面（section id `lead-agent-only-leads-tools`），由 Host 针对 `lead-agent-only-leads` 行的 `configForms` 命名空间驱动。它按机制把整个工具全集分组，每行带说明与默认值，并为每个开关写入一个字典键：

- **Whitelist**（36）——预设/全局层的工具，包含两个委派工具。ON 保留该工具，OFF 隐藏它。默认 ON：`ask_user_question`、`todo_write`、`exit_plan_mode`、`present`；其余每一行——包括四个读取工具（`read`、`read_image`、`glob`、`grep`）——默认 OFF。
- **Guard**（9）——限制触及不到的自身作用域工具，因此 OFF 会通过守卫拒绝它们。默认 ON：八个 Team 工具。默认 OFF：`wait_agent`。
- **No effect**（6）——`/goal`、`/plan`、`/compact`（命令，不是工具）、`plugin_manager`、`plugin_market`（未挂载进此 profile），以及 `structured_output`（只出现在被委派的子进程里）。显示为禁用，并在开关位置显示 *不可切换* 徽标。这些行不再渲染 `default on/off` 行：该标签是无效的，因为插件完全忽略 `none` 条目，所以只有可切换的行才显示默认值。

该页面**以当前选择所生成的 Lead 约定提示词开头**，作为引用块显示在分组之上：它就是 `constrain()` 交给 Lead 系统提示词的文本，因此可以把该页面读作「这就是将要告诉 Lead 的内容」。`client.js` 镜像了宿主端的 `leadContract()` 以及同一套保留/拒绝解析（catalog 开关，或按整体生效的旧版 `leadTools`/`denyTools` 数组——当开关不再驱动策略时，引用也随之遵循该覆盖），`verify.mjs` 则对两个构建器逐字节比较：catalog 默认值、关闭 `ask_user_question` 的选择、开启 `bash` 的选择、仅 `grep` 的选择（它钉住 `readersHidden` 分支），以及一次旧版覆盖。诚实的限制：客户端只根据本页 catalog 加开关推导三项能力论断与具名工具列表，无法读取宿主实时的 `reachable` 作用域，因此 profile 未挂载的工具仍会出现在预览里，而实时提示词会把它丢掉。引用随每次开关注更新，因为它由各行所渲染的同一份实时快照计算得出。

开关是**易变的**：一次编辑会提交进运行中的配置而无需重挂插件，因此它作用于**此后创建的 Lead**；已经在运行的 Lead 保持它被约束时的工具面。首次安装需要重启一次 Host，客户端半边才会被发现；之后的 `client.js` 编辑会热重载。

该插件包**不附带 `node_modules`**。`index.js` 从加载它的 Host 解析配置 schema 库（`@deepseek-ai/schemastery`）：先走普通 import（从市场安装并已拉取依赖的情形），然后是运行进程入口，最后通过工作区的提升存储读 `$DSH_HARNESS_CHECKOUT`。离线可用且重启安全。若都解析不到，插件仍会强制 catalog 默认值；只是设置页缺席，因为不存在配置命名空间。

把每个 whitelist 开关都关掉会**什么都不保留**——Lead 被限制在自己的作用域工具上，而不是仍握着所有工具。同一条失败即关闭的规则也覆盖开关列表中的工具未在本作用域挂载的情形（比如在 Linux 上除 `pwsh` 外全部关闭）：Lead 什么都不保留，并且警告会列出未挂载的工具。唯一能让预设工具面保持完整的路径，是一条显式的旧版 `leadTools` 行配置，且其中所有名字在本作用域中都不存在。显式配置的旧版 `leadTools`/`denyTools` 数组仍会针对它自己的列表整体胜过 catalog，并且在设置它时页面会显示提示。

## 文件

| 文件 | 内容 |
| --- | --- |
| `cordis.patch.yml` | 两个 host 行：插件本身，以及预设声明。 |
| `index.js` | 插件本体：按 Agent 的限制、拒绝守卫、提示词约定、catalog、`Config`。 |
| `client.js` | 客户端半边：`Lead agent only leads` 设置页与镜像的 `LEAD_TOOL_CATALOG`。 |
| `locale/*.json` | 市场元数据（标题/描述）。 |
| `verify.mjs` | 离线检查套件——`node verify.mjs`。 |
| `CONTRACT.md` | 冻结的接口、不变量与非目标。 |
| `package.json` | 插件包 manifest（`dsh.bundle.patch`、`dsh.client`）。 |

## 配置

行配置，写在 profile 补丁里。设置页写入 `tools`；以下这些键是手工等价物：

```yaml
- id: lead-agent-only-leads
  config:
    preset: lead-agent-only-leads     # which preset gets the contract
    tools:                            # per-tool toggles; absent key = catalog default
      bash: true
    leadTools: [ask_user_question, todo_write]   # legacy: explicit keep list, wins wholesale
    denyTools: []                     # legacy: explicit deny list; [] removes the guard
```

`tools` 与两个旧版键都是易变的，因此一次编辑无需重挂插件就能到达此后创建的 Lead。`leadTools` 中本作用域无法限制的每个名字都会被裁掉而不是致命；显式为空的 `leadTools` 会**什么都不保留**（即「全关」意图），而 `denyTools: []` 会移除守卫。

## 校验

```
node verify.mjs
```

在 `js-yaml` 可达的检出上共 45 项检查：纯辅助函数、`Config` schema 形状、catalog 及其默认值（读取工具关闭，`exit_plan_mode` 与 `present` 开启，按 catalog 顺序）、感知配置的约定文本（冻结的无参字节与哈希、无 plan 模式不变量、逐字节断言的合并侦察条目、解析后工具列表句及其 1/2/多/空渲染、空拒绝列表、仅拒绝 `subagent`、按门控的 shell/写入/读取论断，以及插件在委派选择加入的覆盖形态下实际注册的文本）、插件在两层作用域模型下的行为（预设继承 vs. Agent 自有，包括一个未挂载 `exit_plan_mode` 的作用域）、开关→保留/拒绝映射（含全关与未知名字的情形）、对补丁的深度解析（同时证明该预设恰好挂载随附的 `standard` 行与配置），以及通过桩模块加载器真实加载 `client.js` 并深度比较 host 与 client 的 catalog。该套件不需要实时 Host；它从 harness 检出读取 `js-yaml` 与 `standard.patch.yml`，当检出不可达时会跳过那一项聚合深度解析检查。

## 为何如此设计

该预设刻意复制 `standard` 插件列表，而不是把自己收窄。teammate 会继承 Lead 的预设代际，因此一个狭窄的预设会让 teammate 也变得非标准；缩减必须在运行时的按 Agent 作用域上发生。`CONTRACT.md` 解释了该 seam、它能做什么与不能做什么，以及为什么 catalog 用守卫拒绝 `wait_agent`，却把 `subagent` 与 `list_subagent_models` 作为被限制隐藏的普通 whitelist 行保留。
