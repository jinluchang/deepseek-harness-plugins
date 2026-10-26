# `dsh-backend-restart`

[English](README.md) | 中文

这是一款 DSH 插件，在**通用**设置页末尾、版本信息正上方增加一行 **重启后端**。该操作会向正在运行的 Host 申请替换自身的权限，然后用同一个工作目录和同一套环境重新启动同一条命令，因此后端会在同一端口、同一个 Harness home 上重新起来。正在运行的轮次、终端和浏览器连接都会中断；后继进程重新开始监听后，浏览器会自行重新加载。

两个半边共享的协议格式冻结在 [CONTRACT.md](CONTRACT.md)。

## 安装

该插件是一个 profile 插件包，而不是工作区包。请从仓库根目录用 DSH 插件管理器安装，它会把该目录链接进当前 profile 并记录插件包行：

```sh
pnpm dsh plugin --profile web add link:"$PWD/plugins/dsh-backend-restart"
```

在运行中的 GUI 会话里，同一步骤是 `plugin_manager` 工具，传入 `action: install_bundle` 和 `target: <absolute path to plugins/dsh-backend-restart>`；`application: "applied"` 表示 profile 已更新、无需重启。插件随后会在下一次整页加载时载入。

## 使用

打开设置（侧边栏底部的账户菜单，然后选**设置**），停留在**通用**，在页面末尾、紧挨版本行上方的那一行**重启后端**上选择**重启**，再用**重启**确认。Linux Web 构建没有用于设置页的键盘快捷键；账户菜单就是入口。

当已有一次重启占着该进程时，该操作会保持禁用并显示一条本地化提示；当运行中的进程无法重新拉起（Electron 主进程、没有可替换 argv 的启动器，或永不退出的启动器）时，它也会说明原因。

## 校验

- 自检：`node plugins/dsh-backend-restart/verify.mjs` 会解析 manifest 和两个半边，然后断言通道约定、拒绝规则、carrier 作用域回退、supervisor 的标志与探测，以及 spawn 失败分类。共 13 项检查，封闭式：它从不重启任何东西。
- 语法与 manifest：`node --check plugins/dsh-backend-restart/index.js plugins/dsh-backend-restart/restart-helper.js` 以及 `node -e "JSON.parse(require('node:fs').readFileSync('plugins/dsh-backend-restart/package.json'))"`。
- 无 Host 时的 supervisor 行为：supervisor 是普通的 ESM 模块；它导出的 `parseArguments`、`probePort`、`waitForSlot`、`startSuccessor` 和 `supervise` 可以通过在命令行上传入标志、读取模块头部记录的退出码来直接演练。
- 无浏览器时的 Host 半边：插件的 `apply()` 只需要一个暴露 `connection.rpc`（以及可选的 `webServer`、`webServer.getOrigin`、`appExit`）的 Cordis context，因此用一个假 context 就能断言 `status` 与 `restart` 响应、各种拒绝情形，以及它记录的启动命令。
- 完整循环：在一个备用端口上、用独立的 `DSH_HOME` 运行隔离实例，从该 profile 铸造一个浏览器会话 cookie，调用 `POST /backend-restart/restart`，并观察 pid 在 down/up 过渡中发生变化。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：通道、拒绝规则、启动命令、退出请求。 |
| `restart-helper.js` | 分离的后继 supervisor；等待槽位，启动并收敛新的后端。 |
| `client.js` | 浏览器半边：通用设置里的重启行、确认，以及重新加载后的恢复。 |
| `locale/en.json`, `locale/zh.json` | 供插件管理器与设置清单使用的插件显示元数据。 |
| `icon.svg` | 插件图标，在 manifest 中声明为 `icon`，供插件管理器使用。 |
| `cordis.patch.yml` | 插件包补丁，把插件行插入 profile。 |
| `verify.mjs` | 针对 manifest、两个半边和 supervisor 的封闭式自检。 |

## 限制

- Host 无法重新绑定自己的端口，所以重启永远是一次进程替换：记录下来的启动命令必须可重复执行，后继进程只继承前任的终端，而不继承它的监督关系。在会退出的 shell 里手工启动的后端不会再回来。
- 后继进程继承前任的环境，包括 `DSH_HOME`，因此隔离实例在重启后仍保持隔离。
- 两代进程不得共用一个 Harness home。supervisor 通过继承的 death pipe 观察并等待前任进程的死亡，而只要该 pipe 可读，单凭死亡就足以打开闸门，因此空闲端口并不能让后继提前启动。Host 半边总会传这个 pipe。端口空闲的宽限是对不传该 pipe 的启动器、以及运行中 pipe 失效的启动器所做的回退：它等待 6 秒，长于启动器自身 5 秒的强制退出上限，然后即使前任还活着也会启动后继，宁可短暂重叠也不要没有后继。活过自身强制退出上限的前任本已异常，因此该回退只是限定了重叠，而不是消除重叠。
