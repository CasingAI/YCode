# Spec: 执行派生进程树所有权与停止

## 背景与缺陷

现场（2026-11-12）：一个 `run_in_background` 的 Bash 任务在 `TaskStop` 报成功后仍留下整棵 Vite 进程树。原因有四层：

1. Windows 停止只对被跟踪的 root 执行 `taskkill /pid <root> /T /F`。root 先退出或已被中间 shell 替换时，`/T` 找不到后代；`taskkill` 的退出码也不被读取。
2. 任务状态在停止请求时即进入终态，与操作系统里的进程存活状态没有绑定。
3. 执行 Job 以 `killOnJobClose = false` 创建，正常结算只关闭句柄、从不终止作业：root 正常退出后，命令用 `&`/`detached` 放出去的后代既不在停止路径上，也不在结算路径上，成为无人回收的孤儿。
4. Windows 上 Job 是**spawn 之后异步 attach** 的。Node 的 `spawn` 返回时子进程已经开始运行，用户可以在这段窗口里创建孙进程并立刻退出；attach 晚到就只能拿到「root 已退出」或 PID 复用风险，`TaskStop` 之后再也找不到这些进程。

因此“停止成功”只代表请求已发出，而“命令结束”也只代表 root 结束。

## 产品规则

- **每个 execution 拥有整棵派生树。** 一次 `run` / `start` 派生出的所有进程（含 reparent 的孙进程、`detached` 子孙）都属于这次 execution，直到结算为止。
- **正常结算也必须回收未被接管的存活后代。** root 正常退出（前台或正式后台任务的自然结算）时，本次 execution 派生且仍存活的进程必须被终止，不能留给用户一个界面已结束、后台仍在跑的状态。
- **`run_in_background` / `auto_on_timeout` 只是延长 execution 的存活期。** 任务仍处于 active（root 存活或被 execution 持有）期间不得清理；任务一旦自然结算、失败、取消或 adapter 关闭，后代同样必须回收。不存在“root 退出、task 已 completed 但继续后台服务”的语义。
- **shell `&` 不是持久化授权。** 前台命令里的 `&` 只表示该命令的后台执行，命令结算时其后代随树回收。需要跨任务常驻时应使用 `run_in_background`，由任务生命周期显式接管。
- **停止必须覆盖整棵执行树且可复现。** 取消、超时终止、输出上限终止时，本次执行派生且仍存活的进程必须全部终止；重复点击停止、任务已进入终态时，不得出现“界面说停止、进程仍在跑”。
- **作业不可用时不放行命令。** Windows 上无法建立执行作业（原生模块缺失、分配失败、分配超过启动期限）时，本次执行必须返回明确的 `spawn_error`（提示进程树所有权不可用），不得静默退回“spawn 后 attach / taskkill”。root 退出后的 `taskkill /T` 找不到已 reparent 的后代，不能用来宣称完整回收。该判定同样适用于单文件（SEA）CLI。
- **失败要回落而不是阻断。** 非 Windows 平台保留既有进程组与 `ps` 后代快照路径；命令照常执行。

## 状态所有者与事件顺序

Windows：执行 Job 是本次执行进程树的所有者，生命周期跟随 `run()`。

```text
spawn 启动器（最小 Node 宿主，真实命令尚未启动）
  → 并行等待两件事：启动器 ready + 作业分配完成（assign 返回）
  → 两者都成功才经 IPC 放行启动器；任一步失败/超期则中止闸门
  → 启动器 spawn 真实命令（stdio 继承）
      → 真实命令从创建的第一刻就是作业成员，后代继承成员身份
      → 即使中间 shell 退出、后代 reparent 也不脱离

停止请求（cancel / timeout / output_limit / adapter close）
  → TerminateJobObject：终止作业内全部进程
  → 关闭作业句柄
  → 继续沿用既有 terminateProcessTree 作为兜底

正常结算（root 退出，或正式后台任务的自然结束）
  → TerminateJobObject：回收本次执行仍存活的成员
  → 关闭作业句柄

执行仍在 active（保留中的后台任务）
  → 保持作业句柄打开，不终止
```

- 放行的前置条件是**作业分配完成**，而不只是启动器 ready：延迟的 `attachProcessToWindowsJobObject` 若在 ready 之后才完成，命令会先跑起来，快速 root 照样能逃出作业。
- 作业分配有明确的启动期限；超期时中止闸门、精确清理本次启动器，不启动真实命令。晚到的作业控制器必须 `terminate()` + `close()`，且不得因此二次启动命令。
- 作业以 `KILL_ON_JOB_CLOSE` 创建：CLI 进程被强杀时内核关闭句柄，整棵树随之回收，无需依赖任何 JS 清理代码。
- 作业控制器只在执行器进程内持有，不落盘、不进协议、不参与资源管理器采样。
- 作业分配是异步的；分配完成前的停止请求在控制器就绪后补发终止，不因竞态漏杀。
- PID 复用防护沿用执行器现有身份判断：只对本次执行持有的 root 与作业成员发终止。

POSIX：不引入 Job 等价物，复用既有 `detached` 独立进程组。

```text
spawn 真实命令（独立 PGID）
  → root 正常结算 / 停止
      → SIGTERM 进程组 + PPID 后代快照
      → 超时后 SIGKILL
```

- POSIX 的「同组后代」就是 `&`、pipeline、xargs 等仍在同一 PGID 里的进程；已自行 `setsid` 脱离进程组的进程不在所有权范围内（与 Windows 的 `DETACHED_PROCESS` 一致）。
- 保留中的后台任务在 root 退出后不清理；任务结算、取消、adapter 关闭时清理。

## 接口与不变量

- `attachProcessToWindowsJobObject(pid, { killOnJobClose })`：默认 `true`。MCP stdio 传输与执行 Job 都依赖关闭句柄即回收。
- `NodeExecutionAdapterOptions.windowsJobObjectFactory`：可注入作业控制器工厂，供测试替换原生能力；默认实现使用 Job Object。这是内部测试接缝，不通过 CLI/协议暴露给用户。
- `windows-job-launcher.ts`：Windows 启动闸门。先启动最小 Node 启动器，spawn 后用 IPC 握手：启动器发出 `ready` 之前真实命令不存在；**宿主必须同时等到启动器 `ready` 与作业分配完成**，才发出 `run`，启动器这时才 spawn 真实命令，并以 `spawned` / `spawn-error` 回报启动结局，以 `exiting` 保证退出码通告先于自身退出送达。真实命令的 cwd、env、shell、stdio、退出码语义与原实现一致。
- 启动器复用 CLI 内部命令分派（与 `__zcode-browser-host` 同机制）：SEA 单文件以 `process.execPath __zcode-job-launcher` 自 re-exec，非 SEA 继续用 `--eval`。两条路径都走同一 IPC 屏障，因此 SEA 不再是残缺形态。`runJobLauncherCommand` 由 adapters 公开入口导出，CLI 只在 `main.ts` 分派处引用，不跨包私有路径。
- 宿主为启动器注入的 `ELECTRON_RUN_AS_NODE` 与 Node 预加载选项（`NODE_OPTIONS` 等）只作用于 wrapper，绝不覆盖目标环境：真实命令的 env 经 IPC 原样传给启动器，`NODE_OPTIONS` 等用户值原样可见，且不会被 wrapper 提前执行一遍。既有执行环境清洗（例如从子进程环境剔除 `ELECTRON_RUN_AS_NODE`）仍按原规则生效，启动器不改变它。
- 启动结局与退出码分离：真实命令根本没起来时（可执行文件不存在、权限不足）必须还原为 `spawn_error` 与原始错误信息，不能表现为启动器退出 127；命令自身以 127 退出仍是 `failed` + 退出码 127。
- Windows 上连启动器本身都起不来（`spawn` 同步失败）时同样返回 `spawn_error`（提示进程树所有权不可用），不退化为直接 spawn。
- 作业终止与句柄关闭都幂等：重复请求不抛错，不影响命令结果。
- 执行结果、退出码、输出与既有状态机不变；本改动只改变进程树回收时机与覆盖范围。

## 负面边界

- 不引入全机进程登记表，不改变资源管理器的采样口径。
- 不追踪历史上已经脱离的进程；本规范只约束本次执行存活的树。
- 不改变 remote / session 边界：手机远控与 `web-remote-replayable` 复用同一执行端口，不新增恢复语义。
- 不改变 timeout 转后台语义，不改变前台 Bash 工具卡、后台面板与任务状态文案。
- Host 级的跨进程兜底仍由 Host 进程负责，不在本规范内。
- 不在非 Windows 平台改变信号与退出码语义。

## 验收与测试

1. Windows 前台正常完成：命令派生 `detached` 孙进程后退出，孙进程必须被回收（真实进程回归）。
2. 正式后台任务 root 存活期间，root 与孙进程都必须存活；`cancelBackgroundTask` 后两者都必须终止。
3. 正式后台任务 root 先退出：任务结算后不得留下孙进程。
4. `adapter.close()` 停止仍在运行的后台树。
5. 执行器进程被强杀（kill-on-close 句柄随内核关闭）：root 与孙进程都不得残留。
6. 快速退出：root 在启动后立刻派生孙进程并退出，孙进程仍必须被回收（验证启动闸门，而非 attach 竞态）。
7. 延迟作业分配：工厂延迟 200ms 完成时，真实命令的启动时间必须晚于 assign 完成时间；期间 cancel/settlement 不得留下孙进程。
8. 作业工厂永不 settle：执行与 `adapter.close()` 都在启动期限内结束，返回明确 `spawn_error`，且真实命令从未启动。
9. 注入假作业控制器：停止时 `terminate()` + `close()`；正常结算同样 `terminate()` + `close()`；幂等。
10. POSIX 正常结算回收同组后代。
11. 启动失败语义：不可执行文件返回 `spawn_error`（含原始 ENOENT 等信息），命令自身非零退出码（含 127）返回 `failed` 并保留退出码；`cwd`、`$PWD`、env overlay、stdin、退出码与 shell 形态保持一致；用户设置的 `NODE_OPTIONS` 原样出现在目标命令环境里，且其预加载模块只执行一次。
12. 运行适配器测试、`pnpm typecheck` 与 `pnpm lint`；GUI 场景需用户授权后才操作运行中的 YCode。
