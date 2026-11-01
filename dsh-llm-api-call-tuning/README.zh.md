# `dsh-llm-api-call-tuning`

[English](README.md) | 中文

一个 DSH 插件，用**一个**设置页统一管理**每个已激活模型提供方路由**的模型请求重试策略。DSH 为每个路由解析一份重试策略——重试模式、最大重试次数、可重试错误码，以及带抖动的有界指数退避（`packages/llm/llm/src/retry-policy.ts`）——但每份策略归提供方自己所有（`llm-deepseek` 与 `llm-deepseek-account` 在 `retryPolicy` 下，`llm-pi-ai` 在 `providers.<id>.retryPolicy` 下），而 DSH 没有全局设置命名空间、命令行开关、环境变量或 GUI 核心页面。手工调整意味着逐行修改每个提供方行，并让五个数值保持一致。

页面分为三部分：

- **全局默认值**——六个重试值保存在本插件自己的设置命名空间（`llm-api-call-tuning`）中，作为**预设**。保存它们**不会改动任何提供方**。
- **各提供方重试策略**——每个已激活提供方路由一行，显示该路由的**生效值**，并通过**叶子路径操作**直接写入该提供方自己的设置命名空间。只有当该路由的设置命名空间可用时才可编辑；已声明但未激活的路由、没有设置命名空间的路由，以及命名空间不可用的路由都以只读行列出。
- **抓取超时**——两个进程级 HTTP 计时器 `headersTimeoutMs` 与 `bodyTimeoutMs`，由宿主应用到所有提供方、联网搜索与 HTTP MCP 服务器共用的 fetch 调度器上。两者默认都是 `unset`，因此全新安装不改变任何行为；`0` 表示显式禁用该计时器，正整数表示以毫秒为单位的时长。

提供方行是权威来源；只有在明确要求时（某一行的**使用默认值**，或**应用默认值到全部提供方**）才会复制全局默认值。两个抓取计时器则是独立的**进程级**副作用：它们不属于重试预设，也不会被复制到任何提供方路由。线格式冻结在 [CONTRACT.md](CONTRACT.md)。

## 安装

本插件是 profile bundle，不是 workspace 包。请从 DSH 检出版本安装（以便 `pnpm dsh` 入口可用），把 `link:` 指向本 bundle 目录——路径请换成你自己的检出与插件工作区：

```sh
cd /abs/path/to/deepseek-harness
plugins=/abs/path/to/deepseek-harness-plugins
pnpm dsh plugin --profile web add link:"$plugins/dsh-llm-api-call-tuning"
```

或者，在插件工作区（本 bundle 的父目录）中且 `dsh` CLI 在 `PATH` 上时：

```sh
dsh plugin --profile web add link:"$PWD/dsh-llm-api-call-tuning"
```

在运行中的 GUI 会话中，同一步骤也可以用 `plugin_manager` 工具完成，动作为 `install_bundle`，`target` 填绝对目录路径：

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/to/deepseek-harness-plugins/dsh-llm-api-call-tuning" })
```

返回 `application: "applied"` 表示 profile 已变更。随后请**刷新页面**；首次安装可能还需要重启后端，才能读到 bundle patch。本 bundle 不携带依赖（加载时使用 Host 自己的 `@deepseek-ai/schemastery`），并且没有发布到任何 npm registry：从本检出目录、绝对路径或 `npm pack` 安装是受支持的方式。

## 使用

打开**设置**（侧边栏底部的账户菜单），选择**LLM API 调用调优**，它是导航的最后一行（section order 45）。页面包含：

1. **全局默认值**——下表六个重试字段各一个控件、**保存默认值**、以及**应用默认值到全部启用的提供方**。这些值存储在 `llm-api-call-tuning` 命名空间中，只是预设：保存不会改动任何提供方。
2. **各提供方重试策略**——每个已激活提供方路由一个**可编辑**行（账户路由和官方路由在前），显示其命名空间、*覆盖* / *默认* 徽标、从该路由生效策略初始化的六个字段，以及**保存**、**重置**、**使用默认值**。已声明但未激活的路由、没有设置命名空间的路由，以及当前部署不提供其设置命名空间的路由以只读行列出，并会说明原因。
3. **抓取超时**——两个进程级 HTTP 计时器的文本框，以及**保存超时设置**与**恢复系统默认**。空输入是 `unset`（系统默认）状态，`0` 表示禁用该计时器，正整数表示以毫秒为单位的时限。

重试字段表（与 Host `Config` 及上游重试解析器使用的值一致），后面是两个进程级抓取字段：

| 字段 | 含义 | 接受范围 | 代码默认值 |
| --- | --- | --- | --- |
| `mode` | 重试模式。`normal` 仅在重试上限内重试所选错误码；`always` 对每次失败都重试，直到成功、取消或关闭，并忽略重试上限与错误码列表。 | `'normal'` 或 `'always'` | `'normal'` |
| `maxRetries` | `normal` 模式下首次请求之后的可重试次数；`0` 表示禁用重试。 | 0..9007199254740991 的整数 | `5` |
| `initialDelayMs` | 本地调度的首次重试延迟，单位毫秒。 | 大于 0 的有限数，最大 2147483647；不得大于 maxDelayMs | `500` |
| `maxDelayMs` | 本地调度或接受的提供方延迟上限，单位毫秒。 | 大于 0 的有限数，最大 2147483647；不得小于 initialDelayMs | `10000` |
| `jitterRatio` | 每个本地延迟周围的对称随机倍数：`0` 关闭抖动，`1` 最多翻倍。 | 0 到 1 之间的数 | `0.1` |
| `retryableCodes` | `normal` 模式会重试的稳定临时错误码。 | 来自五个上游错误码的非空且不重复的数组 | `'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'` |
| `headersTimeoutMs` | 进程级 HTTP 响应头超时，单位毫秒，由宿主应用到所有提供方、联网搜索与 HTTP MCP 服务器共用的 fetch 调度器上。 | `unset`（保持系统/DSH 默认不变），或 0..2147483647 的整数；`0` 表示禁用该计时器 | `unset`（未设置） |
| `bodyTimeoutMs` | 同一 fetch 调度器上的进程级 HTTP 响应正文（分块）超时，单位毫秒。 | `unset`（保持系统/DSH 默认不变），或 0..2147483647 的整数；`0` 表示禁用该计时器 | `unset`（未设置） |

重试行的**代码默认值**列是上游解析回退值（`retry-policy.ts:14-22`），也是未配置的提供方路由实际运行的值。bundle 不写入任何初始值，因此页面从这些值开始。两个抓取行的代码默认值是 **`unset`**，而不是数字：schema 刻意没有 `.default()`，所以全新安装不会物化任何计时器，宿主自己的调度器默认值继续生效。`unset` 表示不改变行为；`0` 是真实取值，表示禁用该计时器；正整数表示设置该值。

### 保存某个提供方行

**保存**会先在本地校验草稿——小数重试上限、`0` 或大于 `2147483647` 的延迟、初始延迟大于最大延迟、超出 `[0, 1]` 的抖动，或为空/未知/重复的错误码列表，都会以本地化消息拒绝，且**不发起 Host 调用**——然后按页面最后读取的 revision 提交**一次原子写入的叶子操作**。`normal` 模式保存会设置 `retryPolicy.mode`、`retryPolicy.maxRetries`、`retryPolicy.retryableCodes` 和三个 `retryPolicy.backoff.*` 叶子；`always` 模式保存会设置 `retryPolicy.mode` 并**清除** `retryPolicy.maxRetries` 与 `retryPolicy.retryableCodes`，因为这两项在上游模式下不生效。永远不会整体设置 `retryPolicy` 对象，因此同级配置（base URL、凭据引用、模型）不受影响。

**重置**用单条 `unset [...settingsPath, 'retryPolicy']` 清除该提供方的 `retryPolicy`，使其回退到自己的默认值。**使用默认值**把已校验的全局默认值复制到该行草稿；在**保存**之前不会写入任何内容。

只有该行表单报告 `ready`、不是只读、且带有数字 revision 时才会尝试写入；同一次读取也用作 revision 围栏，因此页面绝不会发送无条件写入。未通过门控的行保持禁用，并且**应用默认值到全部**会把它**跳过**而不是写入。

如果 Host 拒绝写入，`mutate` 会解析为 `false`——**所有** Host 拒绝都是如此，包括由 home patch 或 `--patch` 覆盖层拥有该行的情况，因为设置表单 API 不暴露具体原因。页面显示**通用拒绝文案**，并用 Host 随后报告的值重新填充所有字段；如果拒绝源于被取代的 revision 且恢复读取已推进 revision，页面会在新 revision 上**重试一次**。页面仍保留独立的“由其他位置管理”文案，用于直接携带 `settings/rejected` 的 `RemoteError`；该分类仅属防御性分支，通过设置表单 API 不可达：由 home patch 拥有的行显示通用文案。

**应用默认值到全部启用的提供方**会把已校验的默认值逐个写入每个可编辑行，每次使用该行表单**新读取**的 revision。每次写入前都会重新检查该行：表单仍在加载、只读或缺少数字 revision 的行会被**跳过**（其正文已说明原因，因此不再显示额外徽标）。它**不是事务**：拒绝的提供方保留原策略，已写入的提供方保持写入，逐行结果会说明哪个是哪种情况。它绝不会把两个抓取计时器写入提供方：它们是进程级的，不是重试设置。

### 抓取超时（进程级）

抓取卡片编辑本插件命名空间顶层的两个叶子。三态契约如下：

- **空输入 = `unset`**——全新安装状态。保存空字段会发出 `{ op: 'unset', path: ['<key>'] }`，因此不应用本插件的任何计时器，宿主/系统默认值保持不变。全新安装不改变任何行为。
- **`0` = 禁用**——真实的写入（`{ op: 'set', path: ['<key>'], value: 0 }`），在视觉上与空输入不同，表示“禁用该计时器”，而不是“未设置”。
- **正整数 = 自定义毫秒数**，最大 `2147483647`。

该效果是**进程级**的：宿主包装当前全局 undici 调度器，只在请求自身未设置 `headersTimeout`/`bodyTimeout` 时填入这两个值，因此进程内所有提供方路由、联网搜索与 HTTP MCP 服务器共享它。请求自带的超时始终优先。包装仅在两个值中至少一个为数字时惰性安装；清除最后一个值会恢复宿主原有调度器（且仅当该包装仍是当前调度器时），之后的实时保存会重新安装。这是一个**过渡方案**：改编自 MIT 许可的 `dsh-fetch-timeouts` 项目（© 2026 Dev Mehra），署名与来源记录在仓库根目录的 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。它不是 DSH 原生设置，未来的 DSH 版本可能取代它。

### 生效与持久化语义

- 保存走共享设置表单 API——与模型页面相同的 `settings.mutate` 路径——设置服务会把变更持久化到活动 profile 的 `cordis.patch.yml`（profile 自己的 patch，与它的 `package.json` 相邻）。插件自身不存储任何内容。
- 重试策略的变更预期在**下一次模型请求**生效，**无需重启后端**：每条路由的策略在**注册时**捕获（`packages/llm/llm/src/index.ts:435-470`），各提供方在 loader 报告 volatile 值变化（即设置保存之后）时重新注册路由。`llm-deepseek`/`llm-deepseek-account` 在 `llm-deepseek/src/host.ts:82-90` 完成；`llm-pi-ai` 把 `retryPolicy` 纳入注册事实，并在 `loader/volatile-update` 时重新注册（`llm-pi-ai/src/index.ts:108-120,289-319`）。
- 已经在进行中的请求保持其开始时的策略。
- 抓取计时器的修改会在**下一次 HTTP 调度**时生效（包装会在每次请求时重新读取实时值），**无需重启后端**。这些值和其他 Host 设置一样持久化在本插件的设置命名空间中；清空（或重置）后恢复系统默认状态。
- 页面只在安装/升级后需要刷新（首次安装可能还需要重启后端）；修改数值则两者都不需要。

### 两半的职责

`index.js`（Host）拥有全局默认值 `Config`——六个 `.volatile()` 重试字段加两个进程级抓取字段——以及 `DEFAULT_TUNE`/`TUNE_OPTIONS`、`DEFAULT_FETCH`/`FETCH_KEYS`/`FETCH_OPTIONS`、`validateTune()`（schema 无法表达的重试组合规则守卫）和 `apply(ctx, config)`。`apply()` 有两项职责：为该命名空间注册文档化的 `auto: false` 页面策略（当前只是面向未来的准备：本版本没有内置客户端会从 schema 生成页面），以及安装上述可选的抓取超时调度器包装。它从不把任何值投射到提供方。`client.js`（浏览器）是页面：从 Client Remote `llm` 命名空间读取提供方目录，从每个路由自己的配置表单读取生效策略，并通过同一表单写回叶子路径操作，同时拥有第三张抓取超时卡片。提供方行是事实来源；`DEFAULT_TUNE` 是页面提供的预设，而不是回退层；抓取计时器是进程级副作用，不是任何提供方的回退。

## 故障排查

- **导航行缺失。** bundle 未加载到活动 profile，或安装后尚未刷新页面。确认安装命令正常结束，做一次完整页面刷新；如果仍缺失，重启后端以重新读取 profile patch。该行应位于设置导航末尾（order 45）。
- **提供方行缺失或只读。** 只有已安装的提供方适配器声明且当前激活的路由可编辑。已声明但未激活的 `llm-pi-ai` 路由、没有设置命名空间的路由，以及本部署不提供其命名空间的路由都会只读显示并说明原因。
- **由 home patch/`--patch` 拥有的行显示“宿主拒绝了本次写入”。** home patch 或 `--patch` 覆盖层拥有该提供方行，配置编辑器拒绝写入，页面显示**通用**拒绝文案（设置表单 API 不暴露原因）。请改为编辑覆盖层（或 profile patch）；本页面刻意不提供强制写入。独立的“由其他位置管理”文案只用于直接携带 `settings/rejected` 的 `RemoteError`，在此不可达。
- **普通行显示“宿主拒绝了本次写入”。** 写入值未被接受（例如 revision 已被取代）。字段会用 Host 当前值重新填充；请检查后再次保存。
- **保存默认值后没有变化。** 这是设计如此：默认值卡片是预设。请用某一行的**使用默认值**或**应用默认值到全部启用的提供方**把它们写入提供方。
- **显示值与输入不一致。** 页面始终显示 Host 报告的生效值。`always` 模式下重试上限和错误码列表不可编辑，并会在保存时被清除。
- **提供方目录不可用。** 本部署未暴露 Remote `llm` 目录（`providers.unavailable`），或读取失败（`providers.error`）。此时无法列出提供方行，但全局默认值卡片仍可用。
- **刚添加的提供方没有列出。** 目录只在页面挂载时读取一次，不会实时刷新；请离开后重新进入（或刷新页面）以重新读取。

## 校验

```sh
DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness node dsh-llm-api-call-tuning/verify.mjs
```

在本仓库根目录运行（或在插件目录内导出同一变量后运行）。套件是封闭的——纯 Node、`node:assert/strict`、`node:vm` 中的 Context/表单/React 替身，无网络、无服务器、无文件写入——并通过 `$DSH_HARNESS_CHECKOUT` 解析**真实的** `@deepseek-ai/schemastery` 与上游 `retry-policy.ts`，因此 schema 或常量漂移会显式失败。它覆盖 manifest 与 bundle patch、Host `Config` 的接受/拒绝矩阵、`validateTune()` 规则、`apply()`、客户端注册、en/zh 文案一致性（95 个键）、默认值/普通/always/重置/抓取保存/抓取重置的精确操作形状、校验、拒绝、逐写门控/跳过与 revision 重试路径、提供方目录合并与所有降级路径、抓取超时调度器对记录型假调度器与宿主真实 `undici` 全局对象的安装/填充/恢复/dispose/`NODE_USE_ENV_PROXY` 行为（含 `undici` 不可解析时的子进程场景），以及本 README 与 CONTRACT.md 中的字段表。“由其他位置管理”分类只作为防御性单元路径用会 reject 的假表单测试；真实设置表单的拒绝会解析为 `false`。

绿色运行会打印 `104 passed, 0 failed, 0 skipped (104 checks)` 并以 `0` 退出。这是离线契约检查，不是真实 GUI 测试：它不启动 Host 或浏览器，也不会执行真实设置保存、真实导航行、下一请求延迟，或一次真实 HTTP 请求在已安装调度器下真正超时的验证。这些仍属于部署检查；套件证明的是线格式契约与调度器形状，而不是真实计时。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半部：六个重试全局默认字段与两个进程级抓取字段（`Config`）、`DEFAULT_TUNE`/`TUNE_OPTIONS`、`DEFAULT_FETCH`/`FETCH_KEYS`/`FETCH_OPTIONS`、`validateTune()`，以及抑制自动页面并安装/恢复可选抓取超时调度器包装的 `apply(ctx, config)`。 |
| `client.js` | 浏览器半部：**LLM API 调用调优**设置页（默认值卡片 + 每个已激活提供方一个可编辑行 + 抓取超时卡片）、本地校验，以及通过提供方表单和本插件命名空间的叶子路径写入。 |
| `cordis.patch.yml` | 插入 `llm-api-call-tuning` 行且**不带初始值**的 bundle patch。 |
| `locale/en.json`、`locale/zh.json` | 供 Plugin Manager 与设置清单使用的插件显示元数据。 |
| `package.json` | Bundle manifest（`dsh.bundle.patch`、`dsh.client` injects、`exports`、`files`）。 |
| `verify.mjs` | 覆盖 manifest、两半代码、规则与文档表格的封闭自检。 |
| `CONTRACT.md` | 冻结接口：身份、字段、地址、操作形状、持久化、限制。 |

## 限制

完整列表见 [CONTRACT.md](CONTRACT.md)；用户最可能遇到的包括：

- **没有跨提供方事务。** 应用到全部时逐个提供方写入；失败时此前的写入仍然保留。
- **home patch / `--patch` 拥有的行无法编辑**，会显示通用拒绝文案（“由其他位置管理”分类仅是防御性分支，通过设置表单 API 不可达）。
- **进行中的请求保持旧策略。**
- **未激活的 `llm-pi-ai` 路由以及没有设置命名空间的路由为只读。**
- **提供方目录每次挂载只读取一次**，没有实时刷新：页面保持打开时新增或移除的提供方需要刷新页面。
- **不存在命令行、环境变量或 GUI 核心设置**——本页面是唯一受支持的 UI；手工编辑 profile patch 会绕过其校验。
- **抓取计时器是进程级的。** 它们作用于 Host 进程内所有提供方路由、联网搜索与 HTTP MCP 服务器；没有按提供方区分的 HTTP 超时。`unset` 保持宿主默认不变，`0` 禁用该计时器，调用方为单次请求设置的超时始终优先。
- **抓取调度器包装是过渡方案**，改编自 MIT 许可的 `dsh-fetch-timeouts` 项目；署名与来源记录在仓库根目录的 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。它不是 DSH 原生设置。
- **真实计时无法离线证明。** `verify.mjs` 只是用记录型假调度器固定安装/填充/恢复的形状，无法证明真实请求会在配置的毫秒数后超时；那属于部署检查。
- **未发布到 npm**，插件在安装或卸载时不执行任何迁移。
