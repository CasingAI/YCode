# Agent 与工具进程的跨平台调度优先级

## 目标与范围

Windows、macOS 和 Linux 上，Agent/CLI 使用较低的 CPU 调度优先级，工具工作进程使用 Node 接口可设置的最低普通调度优先级。多个 Agent 并发时，应优先把 CPU 执行机会留给正常优先级的桌面界面和其他前台程序。

本规则不是 CPU 百分比限制，也不限制磁盘 I/O、内存、网络或进程数量，不能承诺任意负载下机器都不会卡顿。JSVM 的线程隔离、线程优先级原生接口、资源硬配额和动态负载调度不属于本次范围。除 Windows、macOS、Linux 外的平台跳过设置。

## 产品规则

| 对象                                                        | Node 调度值                   | Windows 优先级类              | macOS / Linux |
| ----------------------------------------------------------- | ----------------------------- | ----------------------------- | ------------- |
| Agent/CLI，包括独立 TUI 和协议服务进程                      | `PRIORITY_BELOW_NORMAL`（10） | `BELOW_NORMAL_PRIORITY_CLASS` | `nice = 10`   |
| 工具终端、Bash/PowerShell/cmd 执行根、Python 等后续工具命令 | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| stdio MCP 服务及其探测进程                                  | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| 直接启动的原生搜索、Git 命令、插件工作进程和脚本工作流      | `PRIORITY_LOW`（19）          | `IDLE_PRIORITY_CLASS`         | `nice = 19`   |
| Desktop Main、Renderer、Local Host、连接/鉴权/SSH 基础设施  | 不修改                        | 保持现状                      | 保持现状      |

公共接口沿用 `below-normal` / `idle` 两个策略名称；`idle` 在 Unix 仅表示 Node 接口可设置的最低 nice 值 `19`，不是 Linux `SCHED_IDLE` 调度策略，也不设置 macOS QoS class。macOS 系统还可存在 `nice = 20`，若进程已继承该值则保持，不提高到 `19`。三个平台的实际调度效果不保证相同。

只降低、不提高已有优先级。工具终端内再启动 CLI 时，如果它已经继承 Idle 或 `nice = 19`，CLI 入口不得将它提高到 Below Normal 或 `nice = 10`。Unix 的 10/19 是绝对目标 nice 值，不是在当前值上重复累加。

CLI 的 `--prepare-storage` 路径可以运行在 Host Worker 内，必须跳过进程级自降，避免连带降低整个 Host。CLI 的 `__internal-search`、`__zcode-plugin-host`、`__zcode-dwf-child` 工作进程入口使用 `idle`；普通 Agent/CLI 入口使用 `below-normal`。

已有的进程内 Worker 和 QuickJS 实例没有独立 PID，不单独设置线程优先级。Windows 上它们受承载进程的优先级类影响；Linux 的 nice 是线程级属性，按 PID 设置只覆盖线程组主线程，之后由该线程创建的线程通常继承其 nice，已存在的 Worker、线程池不被追溯调整。本规则不承诺整个 Linux 进程的所有线程都被统一设置。

用户命令主动调整优先级、提权/其他用户进程拒绝设置、第三方启动器主动覆盖继承值，不属于本规则的强制保证。

## 所有者与公共接口

- 共享 Node 适配函数由 `@zcode/shared/node` 导出，并提供无额外模块求值副作用的叶子入口 `@zcode/shared/process-priority`，供 CLI 在安装 stderr 边界之前加载。两者是同一实现，负责支持平台判断、PID 校验、读取和降低 OS 优先级；不维护进程表、队列、缓存或定时任务，不依赖 UI 或具体 Runtime。
- Agent 进程管理器负责它刚创建的 Agent PID；CLI 主入口负责独立启动时的自身 PID。两条入口调用同一幂等函数，已有更低优先级保持不变。
- 各工具启动适配器负责自己新创建的根 PID。MCP 使用现有 stdio transport 获取 SDK 创建的进程，不修改 SDK，也不改变现有 Windows Job 的清理职责。
- `@zcode/dynamic-workflow-runtime` 的 `RunWorkflowOptions.onChildSpawn(pid)` 是宿主与 harness 之间的资源策略接口：子进程 spawn 返回且 PID 有效时同步通知，harness 不 import 共享包或适配器（保持 app-free），由 bootstrap 在回调内调用 `lowerProcessPriority(pid, "idle")`。回调仅用于尽力设置资源策略；回调异常不阻断后续桥接、结算与清理。
- 终端、Git、执行和 MCP 的存活、归属、退出、取消与回收仍由原有组件拥有。优先级调整不是业务状态，不持久化、不广播，也不新增协议字段。

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
```

调整放在创建进程返回后的同步路径、后续等待之前，不依赖首条输出、握手、资源采样或延迟重试。对 `promisify(execFile)` 使用其 Promise 的同步 `.child.pid`，然后才等待结果，不重写命令退出和缓冲逻辑。

脚本工作流与 Dynamic Workflow 沙箱子进程同样在 spawn 返回后立即设置：bootstrap 自己的显式 spawn（脚本执行体、meta 求值）直接调用共享函数；沙箱子进程经 harness 的 `onChildSpawn` 回调把 PID 交回 bootstrap，再由同一个共享函数设置。

Node spawn 没有原子的“以目标优先级创建”公共选项。创建返回到设置之间，以及 MCP SDK `start()` 返回前，进程可能已经派生后代；已创建的后代不会被追溯降级。Windows 的 Below Normal/Idle 父级在通常创建方式下会被后代继承；Unix fork 继承 nice，exec 保留 nice，但第三方可以显式覆盖。本次采用尽力设置，不枚举或扫描未知进程，也不引入挂起启动器、原生扩展或强制 Job 优先级策略。

## 失败语义

进程已退出、优先级读取/设置失败、权限不足均不改变命令退出码、不拒绝启动、不终止进程。降低同用户进程的调度优先级通常不需要提权，但不依赖这一点保证成功，也不尝试提权。每次启动最多尝试一次设置，不轮询、不重试。不支持的平台跳过 OS 调用。现有启动失败、取消、超时、stdio 转发、进程归属和清理顺序保持不变。

## 验收场景

1. 三个平台均按同一角色策略启动 Agent：Windows 目标为 Below Normal，macOS/Linux 目标为 nice 10。创建方与 CLI 入口应用同一幂等规则。
2. 独立 CLI/TUI 入口使用 `below-normal`；`--prepare-storage` 不调用优先级接口；内部搜索/插件/工作流入口使用 `idle`。
3. 当前值为 15 或 19 的 Unix CLI 不被提高到 10；macOS 已是 nice 20 时两种策略均保留 20；Windows 已 Idle 的 CLI 不被提高。重复应用同一目标不重复设置。
4. 执行适配器创建的命令根进程使用 `idle`，后续 Python/搜索子进程继承相应值；前台和后台任务走相同启动路径。
5. Host 创建的交互式终端和 Git 使用 `idle`，不改变 Host 自身优先级。
6. MCP 普通连接与 disposable sibling probe 在同一 stdio transport 应用 `idle`，保留已有 Job/退出清理行为。
7. 直接 Git、原生搜索和工作流子进程在创建后立即设置，不因外部直接启动而漏掉。
8. win32/darwin/linux 平台注入测试覆盖 10/19、只降不升、读取/设置失败；不支持的平台与非法 PID 不访问 OS。
9. 隔离集成测试在三个目标平台上均可运行，只创建和回收测试自己的子进程，验证目标值读回、后代继承及父进程优先级不变；不为测试提高已继承的更低优先级，禁止操作当前 YCode 或其他现有进程。继承用例以明确的父子通知控制创建顺序，不依赖固定延迟。
10. 运行目标测试、`pnpm typecheck`、CLI 类型检查、`pnpm lint` 和 `pnpm architecture:check --changed`，分别报告真实结果。当前 Windows 开发机不能代替 macOS/Linux 实机验证；平台注入测试与真实 OS 验证分开报告。此变更不修改 UI 交互，无需 UI 自动化或 E2E。
