# `dsh-compaction-tuner`

[English](README.md) | 中文

这是一个 DSH 插件，它在「设置」中为**当前 profile 里的每一个 agent 预设**的压缩策略提供**一个**控制项。一个 profile 通常会声明多个 `@deepseek-ai/dsh-agent-preset` 行，每一行都带有自己的 `compaction-basic` 子项；本插件在自己的行里掌管**完整的十一个键的 `compaction-basic` 策略面**，把它渲染成**压缩调优**设置页，并把它推送到每一个预设行，使所有预设运行同一份调优。目前这些值要在每个预设补丁中手工编辑，一旦漏掉某个预设，它就会停留在不同的压缩行为上。

每个选项都按需求中要求的**两项**事实来记录和渲染：

- 它的**上游代码默认值**——即没有任何设置时 `compaction-basic` 自身解析出的值（`packages/compaction/compaction-basic/src/config.ts`），页面上逐字段说明，也见下方的*使用*表格；以及
- 它的**允许范围**——即它在加载期运行的断言（`validatePolicy` `config.ts:277-304`、`assertRatio` `config.ts:358-361`），而它自己的 schema 并不携带这些范围：`Config` 声明的是**没有 `.max()`**，并把两个 ratio 节点留作裸 `z.number()`（`packages/compaction/compaction-basic/src/index.ts:81,83,117,119`）；只有 token/计数节点带 `.min(0)`/`.min(1)`（`index.ts:82,84,87-89`）。因此 `(0, 1]` 的 ratio 边界只存在于 `assertRatio` 中，而调优器自己的 schema 带有自己的边界，其校验也镜像这些断言。

**不预先写入任何值（seedless）。** 该插件包插入调优器行时不带任何存储值，因此调优器自身的默认值**就是**上游 `compaction-basic` 的代码默认值，全新安装本身不会改动任何预设：如果某个预设的 `compaction-basic` 子项已经省略这十一个键，它本来就在按这些值运行，首轮重新调优会跳过它且不写入。只有当用户在页面上编辑某个值时，调优才会改变；见下方的*初始值*与*安装行为变更*。

两侧之间共享的协议格式冻结在 [CONTRACT.md](CONTRACT.md) 中。

## 安装行为变更（安装前必读）

调优器掌管**每一个** `compaction-basic` 选项，并在首次启动时把它存储的调优投影到每个预设行。全新安装时，这份调优就是上游代码默认值；任何预设只要为这**十个**键中的任意一个声明了**不同**的值，就会被覆盖，结果写入 profile 的 `cordis.patch.yml`：卸载插件不会回退它，要回退只能手工编辑 profile。（已经省略这些键的预设会被跳过：对它是空操作。在移除种子值之前安装的 profile 会保留其存储的 `0.5 / 0.15 / 2`——见*初始值*。）

| 键 | 首轮处理对一个取值不同的预设做了什么 |
| --- | --- |
| `thresholdRatio` | 设为调优器的值（全新安装时代码默认值是 `0.8`） |
| `headroomTokens` | 设为调优器的值（未设置时为 `65536`，因此 `1234 → 65536`） |
| `retainRatio` | 当调优器处于 ratio 形式时写入；过期的 `retainTokens` 会被删除 |
| `retainTokens` | 当调优器处于 token 形式时写入；过期的 `retainRatio` 会被删除 |
| `summarizationProvider` | 设为调优器的字符串；`''` 会清除预设的本地摘要路由（`"local" → ""`） |
| `summarizationModel` | 设为调优器的字符串，作为该配对的另一半 |
| `maxTokens` | 设为调优器解析出的上限（`maxTokens ?? headroomTokens`） |
| `compactionRetries` | 设为调优器的值（全新安装时代码默认值是 `1`） |
| `maxOverflowRetries` | 设为调优器的值（未设置时为 `1`，因此预设的 `0` 会被重新启用：`0 → 1`） |
| `auto` | 设为调优器的值（未设置时为 `true`，因此仅手动触发的预设会被重新启用：`false → true`） |

`modelPolicies` 是刻意的例外：**空**的调优器表格不会改动每个预设自己的表格（见*可选字段与保留策略的互斥关系*与页面说明），因此只有当用户输入非空表格时，预设的按模型覆盖才会被替换。

上述具体后果都是离线套件所固定的 fixture：`auto: false → true`、`summarizationProvider: "local" → ""`、`maxOverflowRetries: 0 → 1`、`headroomTokens: 1234 → 65536`，以及预设的 `retainTokens` 因改用 ratio 形式而被删除。

## 安装

本插件是一个 profile 插件包，而不是工作区包。请从此仓库根目录用 DSH 插件管理器安装它；插件管理器会把该目录链接到当前 profile 中，并记录插件包行：

```sh
dsh plugin --profile web add link:"$PWD/dsh-compaction-tuner"
```

在运行中的 GUI 会话里，同样的步骤是 `plugin_manager` 工具，参数为 `action: install_bundle` 和 `target: <absolute path to dsh-compaction-tuner>`；`application: "applied"` 表示 profile 已发生变化。随后插件会在下一次整页加载时载入。

兄弟插件包的 README 指出，首次安装需要重启一次宿主，客户端侧才会被发现；并且用 `link:` 链接的客户端插件包在重新构建后需要重新加载页面。本插件的这套 reload/HMR 行为**未**重新验证（见限制）。

除本地检出外，该插件包也可以不经注册表分发：在本目录运行 `npm pack` 会生成一个 tarball，可经绝对路径（或 `https:` URL）安装；由于本仓库没有根 `package.json`，克隆本仓库后还可以用 Git 加子目录选择器安装：

```sh
npm pack    # -> dsh-<name>-<version>.tgz (local only; nothing is published)
```

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/dsh-<name>-<version>.tgz" })
plugin_manager({ action: "install_bundle", target: "git+https://github.com/jinluchang/deepseek-harness-plugins.git#<commit>&path:/dsh-<name>" })
```

本仓库不会向 npm 注册表发布任何内容。

## 使用

打开设置（侧边栏底部的账号菜单，然后选择**设置**），再选择**压缩调优**——它是最后一行导航项。页面为每个受管选项显示一个控件，顺序如下。*接受范围*列是宿主强制执行的允许范围（或 `compaction-basic` 在加载时强制执行的范围，标记为*上游*）；*代码默认值*列是上游 `compaction-basic` 解析时的回退值。**这个代码默认值也正是本次安装所运行的值**：插件包不写入任何种子值，因此调优器存储的调优从这些默认值开始，页面会一直显示它们，直到某个值被编辑并保存。

| 选项 | 含义 | 接受范围 | 代码默认值 |
| --- | --- | --- | --- |
| `thresholdRatio` | 触发压缩时所占上下文预算的比例。 | 取值范围 (0, 1]，步长 0.01；上游接受任意有限的 `(0, 1]` 比例，调优器 schema 只接受 0.01 的整数倍 | `0.8` |
| `headroomTokens` | 在测量压力之前，于已路由的输出预留之外额外保留的 token 余量。 | 整数 >= 0 | `65536` |
| `retainRatio` | 消息预算中作为原文尾部保留的比例。 | 取值范围 (0, 1]，步长 0.01；必须低于 `thresholdRatio`；与 `retainTokens` 互斥 | `0.16` |
| `retainTokens` | 原文尾部的绝对 token 预算。 | 整数 >= 0；与 `retainRatio` 互斥；解析后的值必须低于目标 `thresholdTokens`（上游行为，取决于容量） | unset（由 retainRatio 的默认值 0.16 决定） |
| `summarizationProvider` | 撰写摘要的 provider。 | 任意字符串；必须与 `summarizationModel` 作为空对或非空对一起设置 | `''`（继承路由目标） |
| `summarizationModel` | 撰写摘要的 model。 | 任意字符串；与 `summarizationProvider` 遵循同一配对规则 | `''`（继承路由目标） |
| `maxTokens` | 摘要请求的 provider 生成上限。 | 整数 >= 1；未设置时解析为生效的 `headroomTokens` | unset（由 headroomTokens 推导：65536）——取**调优器**的余量，或调优器显式设置的上限 |
| `compactionRetries` | 压力持续高于阈值时，在首次压缩之后的额外尝试次数。 | 整数 >= 0 | `1` |
| `maxOverflowRetries` | 发生标准的上下文溢出后的尝试次数；`0` 表示禁用溢出恢复。 | 整数 >= 0；`0` 禁用溢出恢复 | `1` |
| `modelPolicies` | 精确目标的覆盖表（页面上有 provider/model 选择器）。 | `{provider, model, ...policy}` 的数组；每个条目的 `provider` 与 `model` 非空且唯一；条目内的策略字段遵循与顶层相同的规则；条目内的上限遵循解析后的上限规则 | `[]` |
| `auto` | 自动的步骤边界压力监听器与溢出恢复监听器。 | true 或 false | `true` |

`modelPolicies` 是唯一的结构化选项，页面无需任何 JSON 即可编辑它：**provider** 与 **model** 下拉框由部署自身的模型目录填充（通过嵌套的 `ctx.get('remote.session')` 命名空间读取，`session.modelCatalog()`——没有硬编码任何 provider 或 model id），**添加覆盖**会追加所选的配对，每张覆盖卡片为九个策略键各提供一个带标签的输入框——

```
thresholdRatio, headroomTokens, retainRatio, retainTokens, summarizationProvider,
summarizationModel, maxTokens, compactionRetries, maxOverflowRetries
```

——因此页面提交的条目恰好是

```json
[
  { "provider": "openai", "model": "gpt-5", "thresholdRatio": 0.7 },
  { "provider": "anthropic", "model": "claude-sonnet-4", "retainTokens": 4096, "compactionRetries": 3 }
]
```

每个条目都要求非空的 `provider` 和 `model`，可以携带上述九个键中的任意一个，不得携带任何其他键，也不得重复 `provider`/`model` 配对。选择器无法添加已有覆盖的配对（「添加覆盖」会被禁用）；若某个已保存覆盖的配对不在当前目录中，它仍会列出，标记为*不在当前目录中*，并且仍可编辑和移除。九个输入框全为空的覆盖不会产生任何改动，并会在**保存时被丢弃**；如果因此不再有任何覆盖，页面会为 `modelPolicies` 提交 `unset`。页面会用自己的本地化消息拒绝越界的输入框（小数 token 预算、达到或超过阈值的比例、同一条目里同时出现两种保留形式、解析后的上限为零），而宿主在写入任何预设之前会重新校验全部内容，因此被接受的表格不会在运行时中断 `compaction-basic` 自身的加载。

如果部署未暴露模型目录，页面会说明这一点（并区分「不可用」与「读取失败」），同时任何已保存的覆盖仍然有效；页面的其余部分不受影响。

编辑任意字段并选择**保存**。页面会先在本地校验草稿（越界的比例、达到或超过阈值的保留尾部、同时出现两种保留形式、越界的按模型输入框，或小数的重试次数，都会被本地化消息拒绝，且不调用宿主），然后以**每个选项一个 op** 的形式，用页面最后读到的 revision 作为**一次原子写入**提交。空白的*可选*字段（`retainRatio`、`retainTokens`、`maxTokens`）会作为 `unset` op 提交——见*可选字段与保留策略的互斥关系*。**保存**在没有任何改动时、写入进行中时，以及部署报告该命名空间只读时保持禁用。保存成功**不会显示单独的确认行**——保存按钮下方的需要重启提示就是保存后的消息。存储的值对调优器自己的命名空间是准确的，但它们**并不**保证运行中 profile 的预设行会重新调优——见*保存与重载语义*。宿主的拒绝会显示本地化警告，字段会按宿主下一次报告的内容重新填充。如果部署不提供 `compaction-tuner` 命名空间，页面会说明这一点并禁用字段，而不是假装写入。

### 可选字段与保留策略的互斥关系

`retainRatio` 与 `retainTokens` 在上游是**互斥的**（`config.ts:292-294`）：同时设置二者是加载期错误。调优器把它表达为「恰好一个可以持有值」：

- **两个字段都不持有值**——调优处于 ratio 形式并使用代码默认值（`DEFAULT_RETAIN_RATIO` `config.ts:23`、`resolveRetention` `config.ts:220-227`），页面提交 `unset retainRatio` 和 `unset retainTokens`。
- **ratio 字段持有值**——调优处于 ratio 形式；`retainTokens` 未设置。
- **token 字段持有值**——调优处于 token 形式；`retainRatio` 未设置。

`maxTokens` 是第三个可选字段：留空表示「从生效的 `headroomTokens` 推导」，这也正是上游的解析方式。因此空白的可选字段**必须**写成 `unset`，而调优器自己的 `Config` 刻意不给这三个字段任何 schemastery `.default()`：默认值会被物化进运行中的配置，而物化出的 `retainRatio` 与显式的 `retainTokens` 并存会让互斥关系无法被检测。维护者若给任一保留字段添加 `.default()`，就会静默破坏这条规则——离线套件会断言其不存在。

由于调优器只投影一种保留形式，一个自己声明了 `retainTokens` 的预设会被迁移到 ratio 形式（反之亦然），除非调优器自己的字段选择了另一种形式。`withTune()` 唯一会从预设子项中删除的键就是那个对应项。

**`modelPolicies` 是第四个可选字段，空表示不受管。** 当调优器自己的表格为空（默认情况）时，投影会完全省略该键：每个预设都保留自己的按模型覆盖，`retune()` 会在单独的 `unmanaged` 列表中报告这些行，这样因该规则产生的跳过就不会与「已经调优一致」混淆。输入非空表格会用它替换每个预设的表格。刻意**不**提供显式的「清空每个预设的表格」——空表格已经表示「没有意见」，再增加第二种空含义会造成歧义。因此，移除页面上最后一张覆盖卡片会回到默认的「没有意见」状态，而不是「清空预设」。

后台 token 预算在每一层都按安全整数范围校验（`Number.isSafeInteger`），这使调优器**比上游更窄**：`compaction-basic` 接受 `1e21` 并在其上静默丢失精度，而调优器拒绝任何大于 `9007199254740991` 的值以及任何非十进制输入（这里的 `0x10` 不是 `16`）。这是对静默数据损坏的刻意拒绝；见限制。

### `maxTokens` 如何推导，以及由哪一处余量决定

`maxTokens` 按**调优器行**的 `maxTokens ?? headroomTokens` 投影——这是上游自己的解析顺序（`config.maxTokens ?? headroomTokens` `config.ts:76`），但作用于调优器的值，而不是预设的值。对于一个其子项省略 `maxTokens` 的预设，具体后果是：

- 当子项自己的 `headroomTokens` 与调优器相等时，子项解析出的上限会被保留（这是常见情况，当子项两者都省略时则总是如此）；
- 当子项的 `headroomTokens` 不同时，由**调优器**的余量决定投影出的上限，子项旧的上限不会被保留。在调优器余量为 `65536` 的情况下，一个 `headroomTokens: 1800` 的子项会被投影为 `maxTokens: 65536`。

调优器在推导上限时不会读取子项的余量。这是有文档记录的投影规则，而非意外；改变它就等于改变「所有预设共用一份调优」的含义。

**保存后，请重启后端。** 已保存的调优会在下一次 DSH 后端启动时到达各 agent 预设；在实测运行中，从运行中的宿主进行传播并不可行（见*保存与重载语义*）。页面用粗体说明了这一点——*"保存只会存下这些值，它们只有在 DSH 后端重启后才会应用到各 Agent 预设。"*（English: *"Saving stores the values, but they reach the agent presets only after the DSH backend restarts."*）——并在旁边提供一个**重启后端**操作，或者由你自己重启 DSH。

## 重启操作

页面在**每一种**状态下都会渲染粗体的需要重启提示，并且当后端报告它可以重启自身时渲染一个**重启后端**操作。选择它会打开行内确认（绝不使用原生对话框）；确认会中断运行中的轮次、终端和打开的连接，一旦继任进程应答，页面会自行重新加载。如果继任进程没有在恢复预算内应答（旧监听器消失 20 s，随后继任进程 60 s），页面会提供手动的**重新加载页面**，而不是留下一个死标签页。卸载该区块会中止已经在传输途中的重启。

该操作会调用既有的已认证 Connection 通道 `/backend-restart`，它由独立的 `dsh-backend-restart` 插件拥有——因此这是一个**软运行时依赖，而非必需依赖**：不从该包导入任何内容，本插件在没有它时也能加载且页面可用；当该通道缺失、拒绝或报告 `restartable:false` 时，页面会降级为本地化的手动重启文案（"当前部署无法从此处重启自身。请自行重启 DSH 以应用已保存的值。"）。按错误码的拒绝（`busy`、`unsupported`、`spawn-failed`、其他任何情况）会显示为本地化文案；通道返回的诊断信息 `message` 永远不会被渲染。**传输层拒绝**会被当作可能正在重启，因为后端可能在回复到达之前就退出——`dsh-backend-restart/CONTRACT.md` 为其自身客户端设定的也是同一条规则。

完整的客户端契约冻结在 [CONTRACT.md](CONTRACT.md) 中。

## 初始值

该插件包的挂载补丁**不写入任何种子值**：它在插入调优器行时不带 `config`，因此调优器自身的默认值就是上游 `compaction-basic` 的代码默认值（`DEFAULT_THRESHOLD_RATIO` `config.ts:20`、`DEFAULT_RETAIN_RATIO` `config.ts:23`、`compactionRetries` `config.ts:105`），这些值在 `index.js` `OPTION_SPECS` 中记录一次，并在上方的*使用*表格中连同范围一起说明。移除种子值是刻意的改动：需求是使用系统默认值，而不是安装时的选择。

它们从来不是从某个随附预设补丁搬运来的。本文件早先的修订曾声称 `packages/bundle/web-app/presets/standard.patch.yml` 提交了这些数字；那是错误的。标准预设声明其 `compaction-basic` 子项时**没有**自带任何 config（`compaction-basic` `standard.patch.yml:73-74`），而对检出的所有 `*.yml`/`*.yaml` 做 grep，都找不到任何设置 **compaction-basic** 选项的预设或插件包行——只有 `snapshots/` 下的快照 fixture 设置了它们。（兄弟修剪器的 `thresholdChars` / `headChars` / `tailChars` **确实**由随附预设设置，例如 `tailChars` `standard.patch.yml:78-82`；本调优器不碰那个插件。）

这一后果是一个真实的行为陈述，而不是形式上的说明：因为 `retune()` 读取该行的实时值，`withTune()` 又把这些值投影到每个预设的 `compaction-basic` 子项，所以一个不声明这些键中任何一个的预设本来就已调优一致，并会**被跳过且不写入**。而一个为十个始终投影的键中的某个键声明了不同值的预设，仍会被覆盖为调优器的值（全新安装时即代码默认值）；见*安装行为变更*。

比较是**整体投影比较，而非逐键比较**：`sameTune()` 比较调优所管理的每一个键，只有当它们全部已经匹配时，一轮处理才会不写入。只要有任意一个不同，`withTune()` 就会写入整个投影集合——包括值已经等于默认值的键——因此一个只有一处过期键的预设会让十个键全部被重写（其余键写入相同的值）。

页面说明了这条规则：每个字段都在描述旁显示其上游代码默认值，字段上方的说明指出插件包不写入种子值，因此这些默认值就是全新安装所运行的值，直到某个值被编辑。`retainRatio` **不带** schema 默认值——以便保留策略的互斥关系仍能表达「未设置」——它的空输入会把生效的代码默认值 `0.16` 显示为占位符。

**没有自动迁移。** 安装过本插件包早期版本的 profile 会在自己的 `cordis.patch.yml`（或 `--patch` 覆盖层）中存储 `thresholdRatio: 0.5`、`retainRatio: 0.15`、`compactionRetries: 2`，而已经投影过的预设子项会持有这些值。移除种子值不会重写任何一方：存储的行保留其值，调优器也继续投影它们，因此这样的 profile 只有在用户清除它时才会迁移到系统默认值——卸载也不会回退已写入的 profile 补丁，并且启动时不会运行任何东西。

### 恢复系统默认值（显式的手动路径）

页面在**保存**旁边有一个次要的**恢复系统默认值**操作（启用/禁用规则与保存相同：未就绪或不可写，或写入进行中）。选择它会：

1. 用**未设置**状态替换整个草稿——十一个受管字段全部清空，按模型覆盖表也清空——并**不写入任何内容**；
2. 让用户先检查，然后**保存**会发出同样的一次原子 mutate，只是现在为**全部十一个**受管键各带一个 `unset` op。关键之处正在于此：页面在其他情况下总是设置八个物化的代码默认值，而那些显式值恰恰是让旧行继续存在的原因。设置层会针对 `inherited` 层解析每个 `unset`，并应用删除或设置继承值（`packages/settings/settings/src/index.ts:372-373`）；当得到的 config 与该继承层深度相等时，config 编辑器会从 profile 补丁中移除该行的 `config`——当只剩 `id`/`name` 时还会删除该行本身（它在 `packages/boot/config-editor/src/index.ts:99-100,120-126` 推导出的 `next`）。对于本插件包无种子值的挂载补丁，继承的 config 是 `{}`，因此重置后完全不留下显式覆盖；
3. 随后重新调优处理会解析代码默认值（空行上的 `liveTune`），并重写它所管理、仍持有其他值的每一个预设子项——正是这一步把过期的 `0.5 / 0.15 / 2` 子项迁移到 `0.8 / 0.16 / 1`。它仍会写入显式的代码默认键，所以 profile 补丁**并不干净**：行为变成了默认行为；文件并未被清空。

**生效点。** 保存本身并不可靠地实时传播到预设行（见*保存与重载语义*）；可靠的生效点是下一次启动/重组。重新调优处理**确实**由保存调度——插件监听表单的 `loader/volatile-update` 和 `app-boot/config-reload`——因此重置操作并非摆设；在实测运行中不可靠的是到预设行的实时投递，而不是调度本身。HMR 只监视 profile 补丁、home 补丁和 profile 的 `package.json`（`packages/boot/hmr/src/index.ts:384-385,406-407`），因此插件包代码的改动只会在重组时被重新读取。按下重置并保存后，请重启后端（页面上的**重启后端**操作，或你自己重启）。

**先备份。** profile 补丁不在版本控制之下，也没有自动备份，而重置从 UI 上不可逆：请在按下它之前复制 `~/.dsh/profiles/<profile>/cordis.patch.yml`。该操作刻意保持显式且手动——**没有**自动迁移，也没有任何启发式去猜测存储值是旧种子值还是刻意的选择。

另外三个随附预设（`ptc`、`minimal`、`cordis`）不提交任何压缩配置，因此首轮处理对它们是**空操作**：它们的 `compaction-basic` 子项已经省略这十一个键，而这恰好就是全新安装时调优器自身的状态。这正是本插件的要点——所有预设共用一份调优——而且既然种子值已移除，安装本身也不再改动它们。

## 适用范围

- 当前 profile 中插件名为 `@deepseek-ai/dsh-agent-preset`、**且**已经拥有一个 `compaction-basic` 子项的每一个声明行。这包括其他插件包添加的预设；调优器按插件名匹配，绝不按硬编码的预设 id 匹配。
- 调优器只把值推入已有的子项，**绝不向预设插入行**。没有 `compaction-basic` 子项的预设不在适用范围内：它会被跳过，不写入也不警告。
- 它不是逐预设的旋钮，不是对任何其他 profile 的改动，也不是全局设置。

隔离启动运行端到端地确认了这种基于名称的匹配：一个 `--patch` 覆盖层在一次启动处理中被传播到五个预设行，其中包括第三方插件包的 `preset-lead-agent-only-leads`。

## 保存与重载语义

**保存会持久化；预设不会实时跟随它。** 在一个带真实 `POST /api/settings/mutate` 的隔离实例上，写入成功（`ok:true`、`applies:"live"`），新值持久化进 profile 的 `cordis.patch.yml`，调优器自己的命名空间也会报告它们（`autoGenerate:false` 也确认了自动表单抑制生效）。但实测运行中，从该保存到预设行的传播并不可行：早先一次宽松运行看到 5 次相同保存中有 2 次传播成功，仅重试构建传播了实测轮次中的 **0/1**，候选遍历构建也传播了 **0/1**。在失败的那一轮里，插件自己的时间戳（`Date.now()`，加上从 `app-boot/config-reload` 监听器发出的 `SAVE_SEEN` 行）记录到**保存后 30 s 内有 16 次空处理，每次都返回生产环境的 `{"changed":[],"skipped":[]}`**，而每个空结果之后 **0–1 ms** 内都跟着一次探测，报告编辑器视图为**214 行，其中包含 5 个名称恰好为 `@deepseek-ai/dsh-agent-preset` 的行**——正是重新调优循环所过滤的谓词，且 `undef=0`、没有重复 id。循环自己的视图与探测对明显存在的行判断不一致，因此失败发生在**编辑器选择与重试的下游**，原因尚未查明，**插件无法从自身一侧解决这个问题**。**先编辑值，然后重启后端**——页面上的**重启后端**操作，或你自己重启：保存会持久化，而预设传播只有在下次启动时才可靠生效。`applies:"live"` 描述的是设置写入，而不是预设。

**插件侧的两道防线都已发布，但两者都不是修复。** 一轮处理会先遍历它能解析的每一个候选配置编辑器（`configEditorsOf()`，按身份去重），并在第一个找到内容的候选处停止；如果所有候选都为空，它就会按有界的导出常量 `RETUNE_BACKOFF = [250, 1000, 3000, 10000]` ms（从 `index.js` 导出）重试，一旦某轮处理看到一个可寻址的行或一个确定的拒绝就重置，在最后一次尝试后恰好警告一次，并在销毁时清除两个定时器。重试在整段实测失败期间都处于启用状态，失败依然持续；候选遍历也没有产生任何改变。没有测到修复前的基线对照（arm B 从未运行），因此并不声称这两道防线在任何方向上改变了该比例。

有两处缺口被如实记录而非掩盖：arm B（修复前基线）从未被测量；以及在那一轮中，有四次处理返回了非空结果，却没有任何内容到达补丁，而且没有记录其中究竟是仅 `skipped` 还是拒绝的细分。

**启动时传播可靠且幂等。** 启动时调优器在一次处理中写入了存在差异的预设行（app-ready 后约 262 ms）；第二次启动产生了逐字节相同的补丁；一个 `--patch` 覆盖层传播到了五个预设行，其中包括第三方插件包的预设，移除该覆盖层后恢复了与之前完全相同的补丁哈希。

一旦值到达预设行，新会话就会获得新的调优；**已在运行的会话保留被替换掉的旧版本**，因为 `compaction-basic` 在预设挂载时解析一次策略，而对于已经在运行的预设不存在运行时覆盖路径。

重新调优处理由调优器行**自身**的 volatile 提交、由 profile 协调完成信号（`app-boot/config-reload`）以及由某个预设行稍后激活来触发。由于 `loader/volatile-update` 只分派给拥有它的 fiber，直接在其自己的设置页上编辑某个预设行**不会**重新调优它；该行只有在重新挂载或调优器的值再次变化时才会被重新调优。

## 维护成本

补丁会替换一行的**整个** config（`overrides` `vendor/include/src/index.ts:120-123`），而预设子项不可寻址，因此调优器必须在替换用的 config 中重述每个预设的全部 `plugins` 列表。此后任何对随附预设的上游修改都会被这次重述静默遮蔽，直到该预设行被重置。请把调优器的副本视为预设补丁的一个分支，并在任何上游更新之后运行漂移检查：把调优器重述的 `plugins` 列表与随附的预设行做 diff。这是所选机制的主要成本；一个更小的核心 seam（可寻址的预设子项，或从服务而非行读取压缩策略）可以消除它。

## 校验

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-compaction-tuner/verify.mjs
```

请从此仓库根目录运行（或在插件目录内运行并导出同一个变量）。该套件是封闭式（hermetic）的——`node:assert/strict`、假的 Context 替身、无网络、无服务器——并通过 `$DSH_HARNESS_CHECKOUT` 解析**真实的** schemastery，因此必须设置该变量，否则 schema 校验无法运行。

**实测运行——通过，而且仍是回归门禁。** 在按模型选择器和重置操作就位的情况下，上面的命令打印了 `97 passed, 0 failed, 0 skipped (97 checks)` 并以 `0` 退出（在我的测量中墙钟约 280 ms，含 Node 启动）。在一次 shell 调用中连续运行两次，产生了逐字节相同的输出。套件从 71 项增长到 97 项检查：被重写的和新加的检查固定了选项表（`Config.dict` 恰为十一个键、每个字段都 `.volatile()`、三个可选键不带 `.default()`）、`DEFAULT_TUNE` 与上游字面量一致、`TUNE_OPTIONS` 元数据、投影（`maxTokens` 按 `maxTokens ?? headroomTokens` 推导、恰好一种保留形式、对应项被删除）、行为保持（省略每个选项的预设会在代码默认值上被跳过）、完整的 `tuneProblem()` 规则集、挂载补丁的**无种子值**形态及修正后的来源说明、页面的全新安装渲染（代码默认值、空的可选字段、`retainRatio` 占位符，以及未触碰空白字段的 `unset` op）、接纳 `modelPolicies` 数组的 `volatileForm()` seam、两个方向上不受管 `modelPolicies` 的规则、两侧上的安全整数与条目内上限规则、**按模型选择器**（通过注入的 `remote` 服务读取目录，并处理拒绝、异常、缺失与为空的情况、按 provider 分组的下拉框、添加/移除、重复防护、全空条目丢弃，以及不在目录中的覆盖在保存后仍能存续）、**恢复系统默认值**操作（存在且按与保存相同的规则禁用、清空草稿并清空按模型表格，以及全部十一个键精确的一次原子 `unset` op 列表）及其宿主侧（被清空的调优器行会把过期的 `0.5 / 0.15 / 2` 预设子项重新调优到代码默认值）、**一项对 README.md 与 CONTRACT.md 的引文检查：要求每一个 `file:line` 引用——包括 checkout 中的目标——在引用范围的非注释行上承载其旁边点名的符号**、**一项解析 README/CONTRACT 选项表、按整值相等逐格对照宿主元数据的表格检查**、**一项语言检查：en 与 zh 词典共享同一键集、任何英文值都不含 CJK 文本、且 zh 的 modelPolicies 文案带有空表格译文**，以及客户端侧的十一个顶层字段、其 en+zh 文案对等（每个字段都点名其代码默认值与范围）、其本地拒绝，以及其 `set`/`unset` op 组合。本文件早先的修订曾为三选项版本公布过 `71 passed, 0 failed` 运行结果，再早之前还有 `40 passed, 16 failed`；那 16 项失败全部是该套件某个中间草稿的缺陷。`verify.mjs` 刻意不固定任何文件摘要（它以 `scripts.verify` 发布），因此本文件也没有为新修订点名任何摘要。

它覆盖：manifest；一项漂移防护，确认包名、客户端模块 id、`cordis.patch.yml` 行名与无种子值形态、loader 条目 id / 命名空间、locale 命名空间，以及 `index.js` 的 `name` 全部一致；一项**解析 README 与 CONTRACT 选项表**并断言每一行的代码默认值单元承载宿主的 `defaultText`、范围单元承载宿主范围子句的**表格检查**（因此任一表中的错误默认值或错误范围都会失败，而不仅仅是缺少键）；一项**引文检查：README.md 与 CONTRACT.md 中每一个 `file:line` 引用（工作区文件加上被引用的 checkout 源）都能在非注释行上解析到其旁边点名的符号**；宿主 `Config` schema 对真实 schemastery 的校验，包括对形态不符的 ratio、负数、小数与不安全的 token 字段、为零的 `maxTokens`、非布尔的 `auto`、非数组的 `modelPolicies`、缺少 provider 的条目，以及解析出的上限非正的条目的拒绝；完整的 `tuneProblem()` 跨字段集合；两个方向上不受管 `modelPolicies` 的规则（空调优器表格保持预设表格不变并在 `unmanaged` 中报告；非空表格则替换它），以及仅差异为不受管键时的幂等性；通过假编辑器验证 `retune()` 机制，包括候选编辑器遍历，以及带 `RETUNE_BACKOFF` 顺序的空处理重试序列；在 `node:vm` 中求值的客户端侧（精确模块 id、`settings.section` 注册、en+zh 词典、按 `TUNE_KEYS` 顺序为每个选项提供一个带标签的顶层控件且按模型选择器在其应在位置、对每个不一致草稿的本地拒绝且不调用 `mutate`（包括十六进制与不安全整数输入），以及对每个选项恰好一次 `mutate`、每个选项一个 `set`/`unset` op 和快照 revision）；重启契约（`<strong>` 提示在就绪、不可用和加载状态下均存在，探测及其降级到手动的路径，行内确认恰好发出一次 `/backend-restart` 调用，先下后上的恢复与重新加载，超时回退，卸载中止，以及按错误码的本地化失败文案且不带诊断文本）；以及一项文本检查，确认 `client.js` 只请求 `require('react')`。

`verify.mjs` 不会启动任何运行中的宿主，也不启动浏览器，因此一次通过的运行并不能说明实时预设传播——那是活实例的属性，*保存与重载语义*下记录的隔离运行为其提供了证据。该套件是封闭式且由桩驱动的：它固定元素树、通道调用、恢复顺序与中止契约，但不会在真实浏览器中渲染。因此浏览器/GUI DOM 路径（真实 DOM 渲染、导航行、以及通过页面驱动的保存）仍未确认，也没有在活 profile 上演练过真实进程重启或真实的 `location.reload()`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主侧：`OPTION_SPECS` 一次性声明全部十一个选项（键、类型、代码默认值、允许范围、schemastery 字段）；拥有这些选项，找到每个 agent 预设行，并把调优投影到其 `compaction-basic` 子项。 |
| `client.js` | 浏览器侧：**压缩调优**设置页、每个选项一个控件、其单次原子保存，以及粗体的需要重启提示和**重启后端**操作（对 `dsh-backend-restart` 的软依赖）。 |
| `cordis.patch.yml` | 插件包补丁，以**不写入种子值**的方式插入调优器行，因此调优器运行上游代码默认值。 |
| `locale/en.json`, `locale/zh.json` | 供插件管理器与设置清单使用的插件显示元数据。 |
| `package.json` | 插件包 manifest（`dsh.bundle.patch`、带 `connection` 与模型目录注入的 `dsh.client`、`exports`、`files`）。 |
| `verify.mjs` | 针对 manifest、两侧、选项表、调优规则与重启契约的封闭式自检。 |
| `CONTRACT.md` | 冻结的接口：标识、字段、持久化、调优规则、限制。 |

## 限制

- **全新安装是空操作；有差异的预设仍会被覆盖。** 挂载补丁不写入任何种子值，因此调优器投影上游代码默认值，而其 `compaction-basic` 子项已经省略这些键的预设会被跳过且不写入。为十个始终投影的键之一声明了**不同**值的预设，会被覆盖为调优器的值。*安装行为变更*点名了每个键及其具体后果；`auto: false → true`、`summarizationProvider: "local" → ""`、`maxOverflowRetries: 0 → 1`、`headroomTokens: 1234 → 65536`，以及被删除的 `retainTokens`，都是套件固定的 fixture。卸载不会回退已写入的 profile 补丁。
- **对已经存有旧种子值的 profile 没有自动迁移。** 在移除种子值之前安装的 profile 仍会在自己的 `cordis.patch.yml` 中携带 `0.5 / 0.15 / 2`，已经投影过的预设子项也持有这些值；一个组合出来的 profile 还可能带有其他插件包先前写入或投影的值。本插件不会追溯重写自己存储的行，启动时也不会运行任何东西，因此这些 profile 会继续运行存储的值，直到用户用显式的**恢复系统默认值**操作清除它们（见*恢复系统默认值*）。移除种子值只改变了安装默认值；它刻意不触碰既有数据。重置从 UI 上不可逆，profile 补丁没有版本控制也没有自动备份，而且重新调优处理仍会物化显式的代码默认键，因此重置后文件并不干净。
- **采用重置需要重启/重组。** HMR 只监视 profile 补丁、home 补丁和 profile 的 `package.json`（`packages/boot/hmr/src/index.ts:384-385,406-407`）；插件包代码的改动只会在重组时被重新读取，而保存到预设行的实时传播在实测运行中并不可行。重置并保存后请重启后端，以确保预设确实迁移了。
- **跨字段规则不在 schema 里。** `retainRatio < thresholdRatio`、`retainRatio` 与 `retainTokens` 的互斥、摘要配对、推导出的 `maxTokens` 边界以及 `modelPolicies` 表格规则，都无法在不破坏设置表单的情况下用 schemastery 表达，因为 `volatileForm()` 只下钻纯对象根（`packages/settings/settings/src/schema.ts:37-47`）。它们由页面在写入前执行，并由 `tuneProblem()` 在调优器调优前执行。绕过页面的直接 `settings.mutate` 可以把不一致的元组持久化进调优器自己的行；此后调优器会拒绝把它推入任何预设，并记录原因。
- **保留形式是一个开关，而不是两个独立的旋钮。** 设置 `retainTokens` 会把整份调优切到 token 形式，并从每个预设子项中移除 `retainRatio`（反之亦然），因为上游拒绝同时出现两者（`config.ts:292-294`）。因此，自己声明了 `retainTokens` 的预设会被迁移到 ratio 形式，除非调优器的 `retainTokens` 已设置。
- **保留形式在这里无法做容量校验。**「解析后的 `retainTokens` 必须低于目标 `thresholdTokens`」（`config.ts:198-204`）取决于被路由模型的上下文窗口，而这在轮次开始之前是未知的。对某个模型过大的 `retainTokens` 会表现为该目标的加载/路由错误，而不是这里的拒绝。
- **`modelPolicies` 为空时不受管，非空时则是整表覆盖。** 空的调优器表格意味着「没有意见」：每个预设保留自己的按模型覆盖，`retune()` 在 `unmanaged` 中报告这些行（`skipped` 的子集，除非另有某个键改变了该行）。**非空**的调优器表格会替换每个预设的表格。刻意的取舍在于无法表达「清空每个预设的表格」：`[]` 已经表示「不要动它们」。页面在写入前会按上游规则校验选择器的值（非空且唯一的 provider/model、无未知键、条目内字段在范围内、以及每个条目解析出的上限），宿主在任何预设被触碰之前会拒绝无效表格。
- **调优器的整数范围比上游更窄。** `Number.isSafeInteger` 在页面和 `tuneProblem()` 中强制执行，对推导出的 `maxTokens` 也是如此，因此 `9007199254740993` 和 `1e21` 会被拒绝而不是被静默取整，并且要求只含十进制的文本（`0x10` 不被接受为 `16`）。`compaction-basic` 自身接受这些值，并在写入 YAML/JSON 的过程中损坏它们；在这里拒绝是刻意的。`-0` 在值已存在时会被规范化为 `0`，绝不会为缺失的可选字段物化。
- **页面的预检查比宿主 schema 更粗。** 它接受 `(0, 1]` 中的任意 ratio，而 schema 要求以 `0.01` 为步长的 `0.01`–`1`，因此不在步长上的值会被宿主用通用的拒绝文案拒绝，而不是字段专属消息。这种收窄来自调优器自己的 schema：`compaction-basic` 自身接受 `(0, 1]` 中任意有限的 ratio（`config.ts:358-361`），因此上游加载器会接受的值在这里可能被拒绝。
- **到预设行的实时传播并不可行，而且失败发生在编辑器选择的下游。** 早先一次宽松运行看到 5 次相同保存中有 2 次传播成功；仅重试构建传播了实测轮次中的 0/1，候选遍历构建也是 0/1。在失败的那一轮中，保存后 30 s 内的 16 次空处理返回了 `{"changed":[],"skipped":[]}`，而 0–1 ms 之外的探测报告了 214 个编辑器行，其中包含循环所过滤的 5 个预设行——循环的视图与探测对明显存在的行判断不一致。原因尚未查明，插件无法从自身一侧解决。**先编辑值，然后重启后端：** 现在保存的值要到下次启动才可靠生效，而不是之前。`applies:"live"` 并不意味着预设会跟随。
- **两道已发布的防线都不是修复。** 候选编辑器遍历和 `RETUNE_BACKOFF` 都曾被启用并运行，但都没有改变结果；修复前基线分支（B）从未被测量，因此不声称比例有任何变化。仍有两处缺口：arm B，以及实测那一轮中四次返回非空结果却没有任何内容到达补丁的处理，且没有记录其中究竟是仅 `skipped` 还是拒绝。
- **运行中的会话保留被替换掉的旧版本。** 已运行的会话不会被重新调优，即使预设行已被重新调优，它也保留启动时的值；只有之后启动的会话才使用新值。
- **直接编辑的预设行在保持挂载期间不会被重新调优**，因为触发事件按 fiber 过滤到调优器自己的行。
- **覆盖层可能阻挠某一个预设。** 如果 home 补丁或 `--patch` 覆盖层拥有某个预设行的 id，编辑器会拒绝该行的写入；调优器会记录这一点，并仍然调优其余行。（仅仅为其他行提供调优的覆盖层不会阻挠它们：一次启动处理曾把它传播到五个预设行。）
- **兄弟修剪器是建议的后续工作（FOLLOW-UP），不是疏忽。** `compaction-basic` 策略面是完整的（全部十一个键，包括按模型作用域）。`@deepseek-ai/dsh-compaction-tool-result-pruner` 是一个*不同的插件*，有自己的 `Config`、自己的三个选项（`thresholdChars`、`headChars`、`tailChars`，默认值 `8192` / `4096` / `1024`），以及一个任何逐字段 schema 都无法表达的约束（`headChars + 39-codepoint PRUNE_MARKER + tailChars <= thresholdChars`）。随附预设已经设置了它们（`tailChars` `standard.patch.yml:78-82`），它属于另一类行，而本调优器的 `withTune()` 只匹配 `compaction-basic` 子项（`index.js` `COMPACTION_ROW_ID` / `COMPACTION_PLUGIN`），因此它从不读写修剪器行。使其可调优是一项单独的改动，有自己的契约。
- **可靠的实时保存路径、arm B、四次处理的细分、浏览器/GUI 路径、真实进程重启以及真实的 `location.reload()` 都未确认。** 隔离运行演练的是真实的 HTTP 设置写入和真实启动，而不是浏览器：这里没有观察到真实 DOM 渲染、导航行或页面驱动的保存往返，也没有查明实时传播失败的原因。重启操作的元素树和通道行为由封闭式桩套件固定，但该操作还没有从真实页面对真实后端驱动过，也没有在活 profile 上演练过真实进程重启或真实的 `location.reload()`。arm B 从未被测量，四次非空处理也没有记录细分。`link:` 链接的客户端插件包的 HMR 同样未确认。
- **重启操作是一个软依赖。** 它调用 `dsh-backend-restart` 的通道，不从该包导入任何内容；没有该包的部署仍会加载本插件，并显示手动重启文案。
- **尚未解决的测量问题。** 首轮处理耗时以及重复 `configEditor.edit` 调用的批处理方式，由验证运行从经验上给出答案（一次处理，在 app-ready 后约 262 ms，以及逐字节相同的第二次启动）；活会话情况、并发重新调优处理在套件固定的合并（coalescing）之外的恰好一次行为，以及 `link:` 链接的客户端插件包的 HMR，仍然是未决问题。
- **没有 `node_modules`。** 如果无法从插件的任何锚点解析出 `@deepseek-ai/schemastery`，就不存在设置命名空间，页面会显示不可用提示；宿主侧仍然推送原始值。

## 许可证

本仓库的插件包按 **GPL-3.0-or-later** 授权。规范的 GNU GPL v3 文本以 [LICENSE](LICENSE) 随包提供；“or later”（或其后续版本）的授权体现在 `package.json` 的 `license` 字段和本声明中，而不在未改动的许可证文本里。

Copyright (c) 2026 Luchang Jin.

本仓库不会向 npm 注册表发布任何内容：安装插件包意味着使用本地检出、本地 `npm pack` 生成的 tarball，或指向本仓库的 Git URL。
