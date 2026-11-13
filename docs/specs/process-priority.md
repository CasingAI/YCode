# Agent 与工具进程的跨平台调度优先级

## 目标与范围

Windows、macOS 和 Linux 上，Agent/CLI 使用较低的 CPU 调度优先级，工具工作进程使用 Node 接口可设置的最低普通调度优先级。多个 Agent 并发时，应优先把 CPU 执行机会留给正常优先级的桌面界面和其他前台程序。

本规则不是 CPU 百分比限制，也不限制磁盘 I/O、内存、网络或进程数量，不能承诺任意负载下机器都不会卡顿。JSVM 的线程隔离、线程优先级原生接口、资源硬配额和动态负载调度不属于本次范围。除 Windows、macOS、Linux 外的平台跳过设置。

## 产品规则

| 对象                                                                       | Node 调度值                   | Windows 优先级类              | macOS / Linux |
| -------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ------------- |
| Agent/CLI，包括独立 TUI 和协议服务进程                                     | `PRIORITY_BELOW_NORMAL`（10） | `BELOW_NORMAL_PRIORITY_CLASS` | `nice = 10`   |
| 工具终端、Bash/PowerShell/cmd 执行根、Python 等后续工具命令                | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| stdio MCP 服务及其探测进程                                                 | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| 直接启动的原生搜索、Git 命令、插件工作进程和脚本工作流                     | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| CLI 受管 headless Chromium 的根进程及由其派生的 renderer/utility           | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| CLI 受管浏览器的 Linux 启动宿主进程及其创建的全部线程/后代                 | `PRIORITY_LOW`（19）          | 不适用（仅 Linux）            | `nice = 19`   |
| Desktop 内置浏览器 guest renderer、临时 Chrome localStorage/helper 子进程  | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| Desktop Main、主 UI Renderer、Local Host、连接/鉴权/SSH 基础设施、共享 GPU | 不修改                        | 保持现状                      | 保持现状      |
| 用户已有浏览器、扩展宿主、登录态浏览器和用户自建 profile                   | 不修改                        | 保持现状                      | 保持现状      |

公共接口沿用 `below-normal` / `idle` 两个策略名称；`idle` 在 Unix 仅表示 Node 接口可设置的最低 nice 值 `19`，不是 Linux `SCHED_IDLE` 调度策略，也不设置 macOS QoS class。macOS 系统还可存在 `nice = 20`，若进程已继承该值则保持，不提高到 `19`。三个平台的实际调度效果不保证相同。

只降低、不提高已有优先级。工具终端内再启动 CLI 时，如果它已经继承 Idle 或 `nice = 19`，CLI 入口不得将它提高到 Below Normal 或 `nice = 10`。Unix 的 10/19 是绝对目标 nice 值，不是在当前值上重复累加。

CLI 的 `--prepare-storage` 路径可以运行在 Host Worker 内，必须跳过进程级自降，避免连带降低整个 Host。CLI 的 `__internal-search`、`__zcode-plugin-host`、`__zcode-dwf-child`、`__zcode-browser-host` 工作进程入口使用 `idle`；普通 Agent/CLI 入口使用 `below-normal`。`__zcode-browser-host` 是 Linux 专用隐藏入口，必须先于 Playwright/Chromium 的任何启动线程完成自降。

已有的进程内 Worker 和 QuickJS 实例没有独立 PID，不单独设置线程优先级。Windows 上它们受承载进程的优先级类影响；Linux 的 nice 是线程级属性，按 PID 设置只覆盖线程组主线程，之后由该线程创建的线程通常继承其 nice，已存在的 Worker、线程池不被追溯调整。因此 Linux 的 Chromium 不能依赖 launch 返回后再按根 PID 设置：必须在创建 Chromium 之前让承载进程的主线程已经是 `idle`，由它派生的 zygote/launcher 和 renderer 才能继承 `nice = 19`。

用户命令主动调整优先级、提权/其他用户进程拒绝设置、第三方启动器主动覆盖继承值，不属于本规则的强制保证。

## 所有者与公共接口

- 共享 Node 适配函数由 `@zcode/shared/node` 导出，并提供无额外模块求值副作用的叶子入口 `@zcode/shared/process-priority`，供 CLI 在安装 stderr 边界之前加载。两者是同一实现，负责支持平台判断、PID 校验、读取和降低 OS 优先级；不维护进程表、队列、缓存或定时任务，不依赖 UI 或具体 Runtime。
- Agent 进程管理器负责它刚创建的 Agent PID；CLI 主入口负责独立启动时的自身 PID。两条入口调用同一幂等函数，已有更低优先级保持不变。
- 各工具启动适配器负责自己新创建的根 PID。MCP 使用现有 stdio transport 获取 SDK 创建的进程，不修改 SDK，也不改变现有 Windows Job 的清理职责。
- `@zcode/dynamic-workflow-runtime` 的 `RunWorkflowOptions.onChildSpawn(pid)` 是宿主与 harness 之间的资源策略接口：子进程 spawn 返回且 PID 有效时同步通知，harness 不 import 共享包或适配器（保持 app-free），由 bootstrap 在回调内调用 `lowerProcessPriority(pid, "idle")`。回调仅用于尽力设置资源策略；回调异常不阻断后续桥接、结算与清理。
- CLI 受管 headless Chromium 由现有 CDP 浏览器 runtime（`apps/zcode-cli/packages/adapters/src/browser/index.ts`）独占连接、session、命令和回收生命周期。Linux 上 `launchServer` 和 `BrowserServer` 由专用 `idle` 启动宿主进程（隐藏入口 `__zcode-browser-host`）独占：宿主在加载 Playwright、创建 Chromium 根进程及 zygote/launcher 线程之前同步自降为 `idle`，根进程、线程和后续 renderer/utility 从该主线程继承 `nice = 19`。父 CLI 保持 `below-normal`，只负责 `chromium.connect()`、Browser 连接、context/page/命令和清理，不读取 Linux 宿主的根 PID，也不在 launch 返回后补设根 PID。
- Linux 宿主只接受父 CLI 的显式关闭请求：stdout 单行 JSON 报告 `ready`/`error`，stdin 接受 `{"type":"close"}` 或 EOF；命令行 payload 携带 `executablePath`、`args` 和父进程的 `closeTimeoutMs`。宿主在 `loadPlaywright` 返回后、`launchServer` 之前再次检查关闭状态，已请求关闭时不得创建浏览器；`launchServer` 返回后若已请求关闭，也不得再写 `ready`，只关闭 server 并退出。宿主收到关闭请求后启动有界 watchdog：若已持有公开的 `BrowserServer` 句柄，先调用公开的 `BrowserServer.kill()` 结束自己启动的浏览器进程组（含 zygote/launcher 与 renderer），再退出；组信号在 `kill()` 返回 Promise 前已同步发出，watchdog 不等待清理完成。若仍卡在加载/launch，则直接退出，由 Playwright 的浏览器 pipe EOF 触发 Chromium 自行回收。宿主只处理自己创建的 BrowserServer，不枚举或终止其它进程。
- 父 CLI 在 spawn 后立即注册宿主 stdin/stdout/stderr/error/exit 处理，不等待 `ready`。握手 `error`、无效消息后的 ready 超时、提前退出和 spawn 失败都先向宿主写入 close 行并结束 stdin，再有界等待宿主退出；超时后只对本次 spawn 的宿主 `kill("SIGKILL")`，不会只发 SIGTERM 后无限等待。宿主 watchdog 负责在父进程强制结束前先清理已启动的浏览器；父进程的强制退出是最后保障，不扫描、不 kill 其它进程。
- 宿主写 stdout 的同步异常和异步 `EPIPE` 都必须进入关闭路径：同步写失败时关闭已创建的 server 并返回非零退出码；异步错误触发与 close 行相同的关闭请求，之后不得再写 `ready`。错误信息始终使用脱敏固定文案，不包含 profile、CDP endpoint 或底层异常文本。
- 非 SEA 自 re-exec 复用 `process.execArgv` 与当前入口，但过滤 `--inspect`、`--inspect-brk` 及其 `=...` 形式，避免工作进程继承调试端口或断点等待；SEA 使用 `process.execPath`。不为此新增公共 helper 或依赖。
- 非 Linux 平台保留进程内 `launchServer`：runtime 通过公开的 `BrowserType.launchServer()` 启动浏览器，用 `BrowserServer.process()` 取得 Playwright 实际派生的根进程 PID，在 `connect()` 之前同步应用 `idle`。Windows 的 Idle 优先级类和 macOS 的进程级 nice 会覆盖该根进程及其后代，不需要额外宿主进程。两种路径都不读取 `Browser.process()`（该 API 不存在）、不访问私有字段、不深导入 Playwright 内部模块。
- CLI 受管浏览器的控制 WebSocket 必须显式 `host: "127.0.0.1"`，只监听回环地址；Linux 宿主和进程内路径都适用。Playwright 1.59.1 在 `host` 缺省时把 `undefined` 传给 `server.listen`，实际绑定 `::`/`0.0.0.0`；`wsEndpoint()` 中回显的 `localhost` 不代表绑定范围。绑定回环失败时按 launch 失败处理，不回退到外网接口。
- CLI runtime 只关闭自己通过 `launchServer` 启动的 BrowserServer/宿主和连接，不关闭、复用或枚举用户已有浏览器、扩展宿主和登录态 profile。Linux 宿主是 BrowserServer 的唯一所有者；父进程只发送关闭请求并等待宿主退出，不直接操作宿主内部的 server 句柄。
- Desktop `BrowserGuestManager` 是内置浏览器 guest 优先级的唯一所有者。它复用现有 guest 登记和有效 OS PID，在 guest attach 之后以及主 frame 导航提交/加载完成后重新应用 `idle`；如果 guest PID 与主 UI renderer PID 相同则跳过，避免连带降低主界面。
- Desktop Main、主 UI Renderer、Local Host、连接/鉴权/SSH 基础设施和共享 GPU 进程不设置优先级。临时 Chrome localStorage/helper 由 Desktop 启动方在 spawn 返回后立即设置 `idle`。用户已有浏览器、扩展宿主、登录态浏览器和用户自建 profile 不属于受管 guest，不修改。
- 终端、Git、执行、MCP 和浏览器的存活、归属、退出、取消与回收仍由原有组件拥有。优先级调整不是业务状态，不持久化、不广播，也不新增协议字段。

公共调用示例：

```ts
import { lowerProcessPriority } from "@zcode/shared/node";

lowerProcessPriority(agent.pid, "below-normal");
lowerProcessPriority(tool.pid, "idle");
```

函数允许测试注入平台及 `getPriority`/`setPriority`。仅接受正整数 PID，不把 `undefined`、`0` 或负数传给 OS；调用当前进程时显式使用 `process.pid`。读取到当前值大于或等于目标值时不设置，读取失败也不冒险提高优先级。

## 启动时序与继承

```text
正常优先级的 Desktop Host / 外部终端
  └─ 创建 Agent/CLI
       ├─ 创建方拿到 PID 后同步应用 below-normal（Windows 类 / Unix nice 10）
       └─ CLI 主入口按调用角色自降（已有更低优先级则保持）
            └─ 创建工具根进程
                 ├─ 拿到 PID 后同步应用 idle（Windows 类 / Unix nice 19）
                 └─ 工具后续派生的 Python / Git / 搜索等通常继承该值

正常优先级的 Desktop Host
  ├─ 创建交互式终端 shell → 立即对 shell PID 应用 idle
  └─ 创建 Git 命令 → 立即对 Git PID 应用 idle

CLI Agent（below-normal）
  ├─ Linux
  │    ├─ 自 re-exec 启动 __zcode-browser-host（继承父 CLI 的已清洗环境）
  │    │    ├─ 宿主入口按 idle 角色同步自降（主线程 nice 19，先于 Playwright 加载）
  │    │    ├─ 宿主延迟加载 Playwright → 解析 executablePath
  │    │    ├─ 宿主 chromium.launchServer(executablePath, headless, host: 127.0.0.1, args)
  │    │    │    └─ Chromium 根、zygote/launcher、renderer/utility 从 idle 主线程继承 nice 19
  │    │    ├─ 宿主经 stdout 报告回环 wsEndpoint（已请求关闭时不写）
  │    │    └─ 宿主独占 BrowserServer；close/EOF 后先强制结束自己的浏览器，再有界退出
  │    └─ 父 CLI chromium.connect(wsEndpoint)
  │         └─ newContext / newPage / 导航（全部在 connect 之后）
  └─ 非 Linux
       ├─ 进程内 chromium.launchServer(...)
       │    └─ BrowserServer.process() 返回根 PID → 同步应用 idle
       └─ chromium.connect(wsEndpoint) → context/page/导航

Desktop BrowserGuestManager
  ├─ attach guest 且 OS PID 有效 → 应用 idle（与主 UI renderer PID 相同则跳过）
  └─ 主 frame 导航提交/加载完成 → 对新的 guest PID 重新应用 idle
```

Linux 上浏览器优先级不依赖 `launchServer` 返回后的根 PID 设置：父 CLI 在 `connect` 前启动 idle 宿主，宿主完成自降后才加载 Playwright 并创建 Chromium，因此根进程、zygote/launcher 和 renderer 从创建时即继承 `nice = 19`。父 CLI 不读取宿主根 PID，也不在 launch 后补设。非 Linux 上 runtime 在 `launchServer` 返回后、`connect` 和任何 context/page/导航之前设置根 PID。`connect` 成功后的 Browser 连接关闭只断开连接，不会终止 `launchServer` 启动的浏览器；清理沿用原有每步有限等待，先关闭 Browser 连接，再关闭 Linux 宿主（或非 Linux 的 `BrowserServer`），连接失败时也要关闭已启动的宿主/server。意外断连与主动 `close()` 通过按启动实例登记的同一清理 Promise 去重：先到的一方执行关闭，后到的一方等待同一结果；`close()` 有界等待已在进行的清理，不会提前返回。有界 close 超时后才完成的迟到 launch 仍会在 `disposed` 检查处关闭自己的 Browser 和宿主/server。清理、取消、超时、session 归属和既有 generation 语义不变。

Desktop guest 的 renderer PID 在主 frame 导航后可能变化，因此 attach 后和导航提交/加载完成都要重应用，而不是只在首次 attach 时设置一次。重应用只针对已登记的受管 guest，不扫描进程树、不轮询、不枚举未知进程。

调整放在创建进程返回后的同步路径、后续等待之前，不依赖首条输出、握手、资源采样或延迟重试。对 `promisify(execFile)` 使用其 Promise 的同步 `.child.pid`，然后才等待结果，不重写命令退出和缓冲逻辑。

脚本工作流与 Dynamic Workflow 沙箱子进程同样在 spawn 返回后立即设置：bootstrap 自己的显式 spawn（脚本执行体、meta 求值）直接调用共享函数；沙箱子进程经 harness 的 `onChildSpawn` 回调把 PID 交回 bootstrap，再由同一个共享函数设置。

Node spawn 没有原子的“以目标优先级创建”公共选项。创建返回到设置之间，以及 MCP SDK `start()` 返回前，进程可能已经派生后代；已创建的后代不会被追溯降级。Windows 的 Below Normal/Idle 父级在通常创建方式下会被后代继承；Unix fork 继承 nice，exec 保留 nice，但第三方可以显式覆盖。本次采用尽力设置，不枚举或扫描未知进程，也不引入挂起启动器、原生扩展或强制 Job 优先级策略。

Linux 宿主消除了 launch 前的继承窗口：宿主在加载 Playwright 之前已是 idle，Chromium 的 zygote/launcher 由 idle 主线程创建，renderer 从这些线程 fork，因此不需要在 launch 返回后按根 PID 追溯主负载。非 Linux 仍在 launch 返回后设置根 PID；Chromium 在 launch 过程中可能已创建 GPU/utility 等子进程，其中一部分可能早于根 PID 设置完成，这些已派生进程不会被追溯降级，Chromium 也可能自行调整自身进程优先级。`idle` 只降低 CPU 调度优先级，不是 CPU 百分比、内存、GPU、网络或进程数量限制，复杂页面仍可能造成卡顿；本规则不承诺“绝不卡”。CLI 不在启动前临时降低自身再还原，也不使用 `--no-zygote`、`--renderer-cmd-prefix`、进程扫描或全局 monkey patch。macOS 已继承的 nice 20 保持不变。三个平台的实际调度效果不保证相同。

## 失败语义

进程已退出、优先级读取/设置失败、权限不足均不改变命令退出码、不拒绝启动、不终止进程。降低同用户进程的调度优先级通常不需要提权，但不依赖这一点保证成功，也不尝试提权。每次启动最多尝试一次设置，不轮询、不重试。不支持的平台跳过 OS 调用。现有启动失败、取消、超时、stdio 转发、进程归属和清理顺序保持不变。

CLI 浏览器：Linux 宿主 spawn 失败、ready 超时、宿主提前退出或 `launchServer` 失败均按 launch 失败处理，父 CLI 不 `connect`，并关闭/终止宿主，避免残留 BrowserServer。宿主自降失败不阻断 launch；Linux 主线程继承仍是主路径，失败时按现状继续。非 Linux 优先级设置失败不阻断 `connect`；`BrowserServer.process()` 没有有效 PID 时跳过。`launchServer`、回环端口绑定或 `connect` 失败仍按现有路径返回“浏览器不可用”，但如果宿主/server 已创建则先关闭。宿主/server 关闭失败只影响清理尽力程度，不改变调用方取消/退出结果。关闭顺序固定为“请求宿主优雅关闭 → 有界等待退出 → 仅对本宿主强制结束”：宿主收到 close 行或 stdin EOF 后，若已有 BrowserServer 句柄则先调用 `BrowserServer.kill()` 结束该浏览器进程组再退出；父进程只在优雅关闭超时后 `kill("SIGKILL")` 本次 spawn 的宿主。若宿主仍在加载/launch，父进程的强制退出会关闭 Playwright 的浏览器 pipe，Chromium 按自身机制回收；此路径不保证能观察到浏览器退出码。Desktop guest 的 PID 读取失败或目标 PID 已退出时跳过，不改变 guest 生命周期、导航结果或命令退出码。

## 验收场景

1. 三个平台均按同一角色策略启动 Agent：Windows 目标为 Below Normal，macOS/Linux 目标为 nice 10。创建方与 CLI 入口应用同一幂等规则。
2. 独立 CLI/TUI 入口使用 `below-normal`；`--prepare-storage` 不调用优先级接口；内部搜索/插件/工作流/浏览器宿主入口使用 `idle`。
3. 当前值为 15 或 19 的 Unix CLI 不被提高到 10；macOS 已是 nice 20 时两种策略均保留 20；Windows 已 Idle 的 CLI 不被提高。重复应用同一目标不重复设置。
4. 执行适配器创建的命令根进程使用 `idle`，后续 Python/搜索子进程继承相应值；前台和后台任务走相同启动路径。
5. Host 创建的交互式终端和 Git 使用 `idle`，不改变 Host 自身优先级。
6. MCP 普通连接与 disposable sibling probe 在同一 stdio transport 应用 `idle`，保留已有 Job/退出清理行为。
7. 直接 Git、原生搜索和工作流子进程在创建后立即设置，不因外部直接启动而漏掉。
8. win32/darwin/linux 平台注入测试覆盖 10/19、只降不升、读取/设置失败；不支持的平台与非法 PID 不访问 OS。
9. 隔离集成测试在三个目标平台上均可运行，只创建和回收测试自己的子进程，验证目标值读回、后代继承及父进程优先级不变；不为测试提高已继承的更低优先级，禁止操作当前 YCode 或其他现有进程。继承用例以明确的父子通知控制创建顺序，不依赖固定延迟。
10. CLI 受管浏览器的非 Linux 路径用 fake Playwright 验证事件顺序：`launchServer` 返回后立即对 `BrowserServer.process()` 的根 PID 应用 `idle`，然后才 `connect`；context/page/导航均发生在 connect 之后，不使用不存在的 `Browser.process()`。Linux 路径注入 launch host factory，验证父 CLI 不调用 `launchServer`、先取得宿主回环 `wsEndpoint` 再 `connect`，context/page/导航仍发生在 connect 之后。
11. CLI 浏览器在 `connect` 失败时关闭已启动的宿主/server；正常 `close()` 先关闭 Browser 连接，再关闭 Linux 宿主或非 Linux BrowserServer，且不改变既有超时/取消/清理顺序。
12. Desktop 已登记 guest 在 attach 后及主 frame 导航提交/加载完成时重应用 `idle`；与主 UI renderer 共享 PID 时跳过；临时 Chrome localStorage/helper 子进程 spawn 后立即 `idle`；用户已有浏览器、扩展宿主、登录态浏览器、主 UI/Main/Host/共享 GPU 不修改。
13. 运行目标测试、`pnpm typecheck`、CLI 类型检查、`pnpm lint` 和 `pnpm architecture:check --changed`，分别报告真实结果。当前 Windows 开发机不能代替 macOS/Linux 实机验证；Linux 宿主分支通过平台注入和 fake host 验证，不声称 Linux 实机通过。此变更不修改 UI 交互，无需 UI 自动化或 E2E。
14. 浏览器相关测试只使用 fake Playwright 或测试自建的短命子进程；不通过 CDP/DevTools/UI 自动化连接或操作正在运行的 YCode，不 kill/restart 已有进程。
15. fake Playwright 断言 `launchServer` 收到 `host: "127.0.0.1"`；不接受缺省 host 或其它接口。
16. 覆盖取消（abort 后不启动）、定时 close 后迟到 launch 仍关闭宿主/server 且只关一次、意外断连与主动 close 竞态共用一条幂等清理、context 创建失败后下一次命令可重建 session、`closeSession` 依次关闭 context/browser/宿主。
17. fake/隔离测试只关闭自己创建的 Browser/BrowserServer/宿主句柄；不扫描或操作用户已有浏览器进程。
18. Linux 宿主入口：`resolveCliProcessPriority` 将 `__zcode-browser-host` 归为 `idle`；宿主在加载 Playwright/`launchServer` 之前同步调用共享 helper 自降，fake 注入验证调用顺序；`launchServer` 收到 `host: "127.0.0.1"`、headless 和既有 args；ready 通过 stdout 单行 JSON 报告；close 行、stdin EOF 和父进程退出都只关闭一次 server；launch 失败输出脱敏 error 并非零退出；宿主独占 server，父进程不读取根 PID。load/launch 期间收到 close 后不创建浏览器、不写 ready；宿主关闭 watchdog 先调用 `BrowserServer.kill()` 结束自己 BrowserServer 的浏览器进程组，父进程超时后只强制结束本次宿主。
19. 隔离继承测试：短命 Node 父进程只把自身降为 `idle`（或保持已继承的更低值），不调用任何提升优先级的 API，再 spawn 子进程读取优先级，验证子进程继承父进程当前值且父值不低于目标；只创建和回收测试自己的进程，不用固定延迟。
20. 打包检查：CLI 构建产物包含 `__zcode-browser-host` 分派与宿主模块，且不新增依赖或私有 Playwright API；宿主通过现有自 re-exec 解析（SEA 用 `process.execPath`，非 SEA 用过滤后的 `process.execArgv + argv[1]`），不 fork bundler 不会产出的临时 `.ts`/`.js` 入口文件。
21. 父侧 launch-host 用可注入 spawn/fake ChildProcess 覆盖：ready、error 消息、提前 exit、无效消息后超时、close 行、重复 close、EOF/已退出、spawn 抛错；握手失败与超时都先写 close 行并结束 stdin，有界等待后仅对本宿主 `SIGKILL`。另有真实短命 Node 管道路由测试，只验证 ready/close 往返和退出，不启动浏览器。
22. 自 re-exec 参数：SEA 只使用 `process.execPath`；开发态保留入口与普通 execArgv，但移除 `--inspect`、`--inspect-brk` 及其 `=...` 形式，保留 `--max-old-space-size` 等非调试旗标。
23. 宿主 stdout 同步写失败与异步 `EPIPE`：同步失败关闭 server 并返回非零；异步错误进入关闭路径，launch 完成后不再写 ready；错误输出始终为脱敏固定文案。fake 和真实 pipe 关闭均不得产生 unhandled error。
