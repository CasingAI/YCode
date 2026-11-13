# Host 生命周期进程清理（Windows Job 容器）

## 背景与产品规则

- 自动清理派生进程是基本功能：用户关闭窗口、Host 异常退出或被杀后，本 Host 派生且仍存活的进程不得继续留在系统里。
- 资源管理器只负责**统计**：它读取 Host 生命周期 Job 的存活成员 PID，用 PPID 树与成员并集归属，不触发任何终止。
- Host 生命周期 Job 同时承担 Windows 上单个 Host 的**容器清理**：作业以 `KILL_ON_JOB_CLOSE` 创建，Host 自身是成员，后代在创建时继承成员身份。句柄只在 Host 进程真正退出时由操作系统关闭，内核随即终止整个作业。
- 正常结算与停止仍由每次执行自己的 Job 负责：Bash / run / start 的 root 正常退出、`TaskStop`、超时和取消路径都回收本次执行树，见 `windows-bash-process-tree-stop.md`。本规范的容器 Job 是兜底，不是这些路径的替代。
- 容器 Job 只覆盖本 Host 派生的后代。它不追溯 Host 启动前已在运行的进程，也不接管其他实例或共享系统服务。

## 状态所有者与事件顺序

```text
Host 启动（initializeServices，早于任何 CLI/Bash spawn）
  → createWindowsJobMembership({ killOnJobClose: true })
      → CreateJobObjectW
      → SetInformationJobObject(LIMIT_FLAGS = BREAKAWAY_OK | KILL_ON_JOB_CLOSE)
      → AssignProcessToJobObject(当前 Host)
  → 保存 membership 句柄；此后 spawn 的后代自动成为成员
  → 失败（非 Windows / koffi 不可用 / create 或 assign 失败）
      → 返回 undefined，回退 PPID 树统计
      → 记录一次 warn 诊断，明确清理保证已降级

每个 execution（normal settlement / stop / timeout / cancel）
  → 执行层自己的 Job 负责终止整棵执行树（见 windows-bash-process-tree-stop.md）

Host 退出
  正常退出：Host 进程结束 → 内核关闭 Job 句柄 → KILL_ON_JOB_CLOSE 终止残留成员
  异常退出/被杀：同上，内核回收句柄 → 残留成员被终止
  Main 异常退出/被强制终止（Windows / Electron 41 实证）
    → Electron 内核同时终止其 UtilityProcess（Host），Host 不依赖应用层信号
    → Host 进程对象结束 → OS 关闭 Job 句柄 → KILL_ON_JOB_CLOSE 终止残留成员
  Host 仍存活时：不调用 membership.close()
```

**Main 退出跟随的证据边界**：`process.parentPort` 不是 Node IPC，`process.disconnect` / `disconnect` 事件不能作为 Host 跟随 Main 退出的依据。Electron 41 上的独立 fixture（新 spawn、无窗口、隔离 userData）验证：强制终止 Main 后，其 `utilityProcess.fork` 的 child 会自动退出；不加入心跳超时来掩盖该同步语义。因此 Host 的 kill-on-close 保证在 Main 崩溃/被强杀路径上成立。

- **唯一所有者**：每个 Host 进程最多一个容器 Job，由 Host 初始化时创建并保存在 Host 模块级变量；不新建第二 Job、不建跨 Host registry。
- **绝不在 dispose 阶段 close 该 Job**：Host 资源回收（窗口关闭、服务 dispose）时 Host 仍要执行存储收尾、日志 flush 等逻辑；若此时关闭 kill-on-close 句柄，内核会立刻杀掉 Host 自身，反而妨碍正常清理。句柄只在 Host 进程结束时由 OS 关闭。
- **幂等**：`close()` 重复调用无副作用；initializeServices 重复进入只创建一次（`??=` 语义）。
- **不追溯**：Host 重启后无法枚举或清理上一个 Host 的成员；旧进程若仍在运行不属于本 Host 的容器成员。
- 失败不回退到“静默无保证”：要么建立容器 Job，要么显式记录一次降级诊断；诊断不含原生内部路径、句柄值或凭据，且不按采样 tick 重复输出。

## 接口与不变量

- `createWindowsJobMembership({ killOnJobClose, onDiagnostic })`：
  - `killOnJobClose` 缺省 `false`，保持纯统计语义；其他调用方的行为与统计结果不变。
  - `killOnJobClose: true` 时 `LIMIT_FLAGS` 额外置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
  - `assignSelf` 抛错可能发生在内核已把 Host 加入作业之后：`killOnJobClose: true` 时不得 close 该句柄（否则立刻终止 Host），句柄保留至进程退出由 OS 关闭；`killOnJobClose: false` 的统计 Job、以及 `assignSelf` 明确返回 false（内核未加入自身）的路径仍关闭句柄，避免泄漏。
  - `onDiagnostic({ stage: "create" | "assign" | "query", reason })` 在原生不可用、创建/加入失败、首次成员枚举失败时各调用一次。
- `WindowsJobMembership.listPids()` 仍返回存活成员或 `undefined`，不影响归属兜底。
- Host `index.ts` 初始化时显式传入 `killOnJobClose: true` 与一个 warn 级诊断回调（使用 Host 现有 logger）。
- 桌面打包必须保证 `koffi` 运行时存在：Host 通过它以外部模块方式加载 `kernel32.dll`。`koffi` 必须进入 `app.asar` 或 `app.asar.unpacked` 的相对路径解析范围，其 `.node` 原生文件按 native 策略 unpack。

## 负面边界

- 不新增全机进程登记表，不改变资源管理器的采样口径、分组和会话归属。
- 不改变 `desktop-continuous` 与 `web-remote-replayable` 恢复语义，不改变 owner/lease 与跨 Host 路由。
- 不替代执行层 per-execution Job；两者职责不同：执行层回收单次执行树，Host 容器回收整个 Host 派生树（仅在 Host 退出时触发）。
- 不保证捕获显式 `CREATE_BREAKAWAY_FROM_JOB` 逃出容器的进程；不宣称这类进程被清理。
- 非 Windows 平台没有 Job 容器，清理依赖进程组与执行层路径，本规范不新增 POSIX 兜底机制。

## 验收与测试

1. `createWindowsJobMembership` 默认不设置 `KILL_ON_JOB_CLOSE`：用注入 api 断言传入的 limit flags 只含 `BREAKAWAY_OK`，统计语义与其他 caller 不变。
2. `killOnJobClose: true` 时断言 limit flags 含 `KILL_ON_JOB_CLOSE`（Windows 真机 Job 上验证）。
3. 原生不可用或 create/assign 失败时返回 `undefined`，`onDiagnostic` 恰好调用一次，且 reason 不含内部路径。
4. Windows 真实 fixture：创建一个隔离的 owner 进程（本测试自建，记录其精确 PID），其派生孙进程脱离父链仍在运行；owner 结束后孙进程仍在；宿主容器 Job 的关闭/内核回收路径最终终止这些自建进程。测试只操作自己创建的 fixture PID，绝不终止测试 runner 或任何已有进程；不把 runner 本身加入 kill-on-close 的测试 Job。
5. Host 初始化以 `killOnJobClose: true` 创建容器 Job；dispose/窗口关闭路径不调用其 `close()`。
6. 打包校验：`koffi` 出现在 `REQUIRED_ASAR_RUNTIME_MODULES` 与 bundle 的 `requiredRuntimeModules`；native 策略断言 `koffi.node` 为 unpack 状态。
7. Main 跟随退出实证：独立 Electron fixture（无窗口、隔离 userData）记录 Main 与 utility child 精确 PID；控制器只终止自己新建的 Main，断言 utility child 自动退出。fixture 只清理自身 PID，不触碰运行中的 YCode，也不新增心跳 timeout。
8. 运行 `pnpm typecheck`、`pnpm lint`、定向单测与 `pnpm architecture:check --changed`，区分本次与已有失败。
