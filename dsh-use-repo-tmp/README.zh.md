# `dsh-use-repo-tmp`

[English](README.md) | 中文

提示词引导：让模型把草稿文件、临时下载和生成产物放到工作区根目录——即当前工作目录——下的 `tmp/`，而不是 `/tmp`，并在运行时上下文快照中为会话解析出该目录。

它**只是引导**。它注册一个静态的系统提示词片段和一个运行时上下文。它不拦截工具调用，不守卫也不改写任何工具，不替换文件或 shell provider，并且在当前 profile 之外不安装任何东西。

## 它解决的问题

对沙箱化 DSH 会话的不同接口而言，`/tmp` 并不指同一个目录：

- **受限的 shell 命令拿到的是私有、一次性的 `/tmp`。** 在 Linux bwrap 运行器上，`workspace-write` 命令以 `--tmpfs /tmp` 加上工作区的可写 bind 运行（`packages/sandbox/sandbox-local/src/profiles.ts`）。这个 tmpfs 只为那一条命令创建，命令退出时即被丢弃，因此 `bash` 写到 `/tmp` 的文件在下一条命令前就已消失。持久终端会话本身是一个长期存活的 bwrap 进程，所以它的 tmpfs 能活过该会话——但它仍不是宿主 `/tmp`，并且会随会话消失。
- **文件工具写的是宿主 `/tmp`。** `read`、`write` 和 `edit` 在文件效应围栏（file-effect fence）内以进程内方式运行，其 `workspace-write` 允许列表是工作区根目录、宿主 `/tmp` 和 `os.tmpdir()`（`packages/sandbox/sandbox/src/roots.ts`）。

因此在该运行器下，这两个接口从不共享 `/tmp`：shell 写入的文件对文件工具不可见（并随命令消失），而文件工具写入的文件对下一条 shell 命令不可见。工作区内的 `tmp/` 是每个接口都能共享、且能存活过本轮次的唯一目录。

这种不对称**取决于运行器**，注入的文本也如实说明了这一点：它把持久性论断限定在 bwrap 沙箱运行器上，从不声称宿主 `/tmp` 会被清空或删除。在 Landlock 运行器下 `/tmp` 被授予读写、就是真正的宿主 `/tmp`，因此那里的建议是一条关于持久性与一致性的约定，而不是针对缺失目录的变通。在任何运行器上，把中间产物留在工作区内仍是更稳妥的习惯：它是 workspace-write 策略承诺的唯一位置，也能让任务的产物在事后可检查、可丢弃。

## 注入了什么

两处注册都位于插件自己的 Cordis 层，因此一次 `apply()` 就覆盖组合中的每个 Agent——Lead、subagent 和 teammate。

| Seam | Name | Order | Content |
| --- | --- | --- | --- |
| 系统提示词片段 | `repo-tmp:policy` | `950` | 静态文本，`interpolate: false`。 |
| 运行时上下文 | `repo-tmp:root` | `111` | `Durable scratch directory for this session: "<workspace>/tmp".`，`interpolate: false`。 |

顺序 `950` 把该片段放在 `FILE_REFERENCE`（900）与 `TOOL_BASH`（1000）之间，于是通用策略先于工具专属的 shell 引导被读到。顺序 `111` 紧接在 `SANDBOX_POLICY`（110）之后，因此解析出的目录正好渲染在「Current DSH file policy」一行旁边。两个顺序都写成字面量，因为自定义片段名或上下文名不属于 `getSectionOrder`/`getContextOrder` 的类型化位置联合。

该片段刻意保持**缓存稳定**：它不携带任何依赖会话的路径、没有任何插值变量、也没有任何按会话变化的值，因此每个会话、每段被缓存的提示词前缀共享同一份文本。其中唯一的绝对路径是用来对照的字面量 `/tmp`。

上下文是动态且带值的。它以 `ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd` 解析工作区根目录——这个可选查找让该插件包在未挂载工作目录服务的 profile 中仍可加载——并且在没有任何 Agent 被组装时贡献一个空字符串（不会渲染出任何内容）。路径用 `JSON.stringify` 加引号，因此包含空格或异常字符的目录不会破坏这句话。

注入的策略文本：

```text
Put scratch files, temporary downloads, and generated artifacts under `tmp/` at the root of the workspace — the current working directory — instead of `/tmp`.

`/tmp` is not durable on a bwrap-sandboxed runner: a confined shell there gets its own empty `/tmp` that is not the host `/tmp` the file tools read, so anything written there can vanish or stay invisible to other tools.

Run `mkdir -p tmp` before the first use, then address the files by workspace-relative path (`tmp/out.log`) or by absolute path inside the workspace. Keep intermediates there while a task needs them; do not put tracked deliverables in `tmp/`.
```

## 安装

该插件包是普通的 profile 插件，不是工作区包。先在本插件工作区里取得它的路径，然后从 DSH 检出根目录安装：

```sh
# in this plugins workspace
PLUGIN="$(pwd)/dsh-use-repo-tmp"

# from the DSH checkout root
pnpm dsh plugin --profile web add link:"$PLUGIN"
```

插件随后会在下一次整页加载时载入；无需构建步骤，因为该插件包是从源码加载的普通 ESM。在运行中的 GUI 会话里，同一步骤是 `plugin_manager` 工具，传入 `action: install_bundle` 和 `target: "$PLUGIN"`。

## 校验

```sh
# from this plugin directory
node --check index.js && node verify.mjs

# from the plugins workspace root
node dsh-use-repo-tmp/verify.mjs
```

`verify.mjs` 是封闭式的：无网络、无模型、不写文件系统。它检查 manifest 与插件包补丁（用一个可达的 DSH 检出自带的 js-yaml 做深度解析——即 `DSH_HARNESS_CHECKOUT` 覆盖的检出或同级的 `deepseek-harness` 目录；两者都不可达时，深度解析会打印显式的 `SKIP` 说明原因，严格的文本回退仍会运行），用假 Cordis context 驱动 `apply()`，并断言片段的名称、顺序、缓存稳定性（无变量、无依赖会话的路径、只有固定的 `/tmp` 记号），以及上下文的解析顺序——先服务、再回退到 Session 头部、两者都不存在时得到 `''` 且不抛错。它还会把上文引用的策略块与 `apply()` 注册的文本逐字节比较。从插件目录和插件工作区根目录运行都能通过。

采用这一约定的仓库应忽略该目录：

```gitignore
/tmp/
```

## 已考虑并否决的替代方案

- **在文件工具处拒绝 `/tmp`**（`PreToolDecision` / `tools.guard`）。守卫能看到调用，但 pre-tool decision 只能允许、拒绝、取消或询问（`packages/core/tools/src/index.ts`），所以拒绝只能产生一次失败的调用与一次重试，而不是一个位于可用路径的文件。它也是关于策略的错误论断：宿主 `/tmp` 确实可以通过文件工具写入。
- **替换或包装文件/shell provider**，把 `/tmp` 重映射进工作区。为了替模型省下一个路径段而扩大沙箱的信任边界，并且会静默改变每一条真正意指宿主 `/tmp` 的命令的含义。
- **在派发前改写工具参数**。DSH 在设计上就没有这样的 seam：「Input rewriting is excluded because arguments are already logged and presented」（`packages/core/tools/src/index.ts`）。引导进入提示词，是因为提示词才是能在不歪曲工具实际行为的前提下改变行为的地方。

## 它做不到的事

- 它不能强制任何事。忽略该片段的模型仍然可以写 `/tmp`，插件对结果不持意见。
- 它不能使 shell 的 `/tmp` 与文件工具的 `/tmp` 一致；那只有沙箱运行器和工具本身能决定。
- 它不改变任何权限。在 `workspace-write` 下，工作区内的 `tmp/` 可写；在 `read-only` 下什么都不可写，本插件不会放宽这一点。
- 它不增加、隐藏或重排工具。它只贡献一个缓存稳定的提示词片段和一行运行时上下文，并且不在会话之间持久化任何东西。
- 它假定工作区根目录就是任务文件该待的地方。若某会话的工作目录有意在项目之外（例如用户选择的草稿目录），它就会报出那个目录——对那个会话而言这才是诚实的答案。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 静态策略片段、动态草稿目录上下文、`apply()`。 |
| `cordis.patch.yml` | 插件包补丁：一次顶层 insert，让每个 Agent 都收到该引导。 |
| `verify.mjs` | 针对 manifest、补丁和两处注册的封闭式自检。 |
| `README.md` | 本文件。 |
| `CONTRACT.md` | 该插件包冻结的接口面。 |
