# deepseek-harness-plugins

[English](README.md) | 中文

四个独立的 DeepSeek Harness（DSH）插件包。每一个都以 profile 插件包的形式安装进 DSH 宿主，自带英文与简体中文 README，并附带一套无需运行中 Host 的封闭式校验套件。

| 插件包 | 作用 | 出现位置 | 文档 |
| --- | --- | --- | --- |
| `dsh-backend-restart` | 增加一个 **重启后端**操作：通过 `/backend-restart` RPC 通道请求 Host 替换自身，并在后继进程应答后重新加载页面。 | 设置 → **通用**，位于版本行上方的一行 | [English](dsh-backend-restart/README.md) · [中文](dsh-backend-restart/README.zh.md) |
| `dsh-compaction-tuner` | 一个页面，掌管完整的十一键 `compaction-basic` 策略，并把调优推入当前 profile 里的每个 agent 预设。 | 设置 → **压缩调优**（导航的最后一行） | [English](dsh-compaction-tuner/README.md) · [中文](dsh-compaction-tuner/README.zh.md) |
| `dsh-lead-agent-only-leads` | 增加 **Lead 只负责带领**预设——一个把每项工作都委派出去、从不等待 teammate 的 Team Lead——外加执行工具限制的 host 插件。 | 会话预设选择器；工具开关在设置 → **Lead 只负责带领** | [English](dsh-lead-agent-only-leads/README.md) · [中文](dsh-lead-agent-only-leads/README.zh.md) |
| `dsh-use-repo-tmp` | 仅提示词层面的引导，把草稿文件送到 `<workspace>/tmp` 而不是 `/tmp`，由一段静态系统提示词片段加一行运行时上下文实现。 | 无 UI | [English](dsh-use-repo-tmp/README.md) · [中文](dsh-use-repo-tmp/README.zh.md) |

## 要求

- **DSH `^0.2.1-rc.3`** —— 在每个 manifest 中都声明为 `engines.dsh`，因此超出该范围的 DSH 宿主会拒绝安装。
- 这些包没有单独声明 Node.js 版本。它们的校验脚本是普通 ESM，用你运行 DSH 时已经在用的 `node` 二进制即可执行。

## 安装

插件包就是一个 npm 包，其 `package.json` 声明了 `dsh.bundle.patch`；安装它会把那一层补丁加入当前 DSH profile。目前有三条可用的安装路径。只有路径/`link:` 这条路线不需要 registry：`dsh-lead-agent-only-leads` 的 tarball 或 Git 安装还会从 registry 解析它唯一声明的依赖 `@deepseek-ai/schemastery@3.18.5`，因此那条路线需要可达的 registry，或宿主上已存在该依赖。

### 从本地检出安装（绝对路径）

在本仓库根目录下，用已在 `PATH` 上的 DSH CLI：

```sh
dsh plugin --profile web add link:"$PWD/dsh-backend-restart"
```

若改从 DSH 源码检出运行，则改用检出自己的脚本，并传入插件包的绝对路径：`pnpm dsh plugin --profile web add link:/abs/path/to/deepseek-harness-plugins/dsh-backend-restart`。

或者在运行中的 GUI 会话里，用 `plugin_manager` 工具：

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/to/deepseek-harness-plugins/dsh-backend-restart" })
```

安装器会把该包链接进 profile 并记录插件包行；插件在下一次整页加载时载入。

### 从 tarball 安装

在某个插件包目录里执行 `npm pack`，会得到一个本地 tarball，它可按绝对路径（或按 `https:` URL）安装：

```sh
cd dsh-backend-restart
npm pack    # -> dsh-backend-restart-0.2.1-rc.3.tgz
```

```js
plugin_manager({ action: "install_bundle", target: "/abs/path/dsh-backend-restart-0.2.1-rc.3.tgz" })
```

### 从 Git 安装（子目录选择器）

仓库里没有根 `package.json`，所以形如 `github:jinluchang/deepseek-harness-plugins` 的裸安装无法解析出一个包。请改用 `path:` 选择器来定位某一个插件包：

```js
plugin_manager({ action: "install_bundle", target: "git+https://github.com/jinluchang/deepseek-harness-plugins.git#<commit>&path:/dsh-backend-restart" })
```

为 `<commit>` 固定一个提交；同一套写法也适用于其他三个插件包，只需换成各自的 `path:/dsh-<name>`。

## 没有发布到 npm

这些插件包**没有发布**：这些包在 npm 上不存在任何版本。它们的 manifest 设为 `"private": false` 并带有发布元数据，因此将来可以发布，但至今没有向任何 registry 发布过任何内容。

## 说明

- `dsh-compaction-tuner` 会在首次启动时把调优写入 profile 的预设行；卸载它并不会回退这一改动。详见其 [README](dsh-compaction-tuner/README.md) 中的 *安装行为变更*（Install behaviour change）。
- `dsh-lead-agent-only-leads` 增加的预设作用于**新会话**：重启 Host，然后在启动会话时选择 **Lead 只负责带领**。

## 校验

每个插件包都自带一个自足的 `verify.mjs`；不需要网络、服务器，也不需要运行中的 Host。把 `DSH_HARNESS_CHECKOUT` 指向一份 DSH 源码检出——它是跑出全绿的必要条件：compaction tuner 缺少它会直接报错，其余套件则通过它解析检出中的库。

```sh
export DSH_HARNESS_CHECKOUT=/path/to/deepseek-harness

node dsh-backend-restart/verify.mjs          # 13 checks passed
node dsh-compaction-tuner/verify.mjs         # 99 passed, 0 failed, 0 skipped (99 checks)
node dsh-lead-agent-only-leads/verify.mjs    # 45/45 checks passed
node dsh-use-repo-tmp/verify.mjs             # 14 checks passed
```

## 仓库结构

```text
.
├── LICENSE                     GPL-3.0-or-later
├── THIRD-PARTY-NOTICES.md      upstream MIT text + provenance
├── dsh-backend-restart/        README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
├── dsh-compaction-tuner/       README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
├── dsh-lead-agent-only-leads/  README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
└── dsh-use-repo-tmp/           README.md README.zh.md CONTRACT.md LICENSE verify.mjs package.json …
```

## 许可证

本仓库以 **GPL-3.0-or-later** 授权；GNU GPL v3 的权威文本见 [LICENSE](LICENSE)。

Copyright (c) 2026 Luchang Jin.

[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 记录了以 MIT 许可、原样嵌入 `dsh-lead-agent-only-leads/cordis.patch.yml` 的 DeepSeek Harness plan 模式提示词文本；该文本仍属 MIT License，通知文件载有其来源与哈希。
