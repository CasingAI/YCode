# Spec: Windows Bash 进程树停止

## 背景与缺陷

现场（2026-11-12）：一个 `run_in_background` 的 Bash 任务在 `TaskStop` 报成功后仍留下整棵 Vite 进程树。原因有两层：

1. Windows 停止只对被跟踪的 root 执行 `taskkill /pid <root> /T /F`。root 先退出或已被中间 shell 替换时，`/T` 找不到后代；`taskkill` 的退出码也不被读取。
2. 任务状态在停止请求时即进入终态，与操作系统里的进程存活状态没有绑定。

因此“停止成功”只代表请求已发出。用户既看不到残留进程（它们已脱离当前 Host 子树），也无法从界面再次关闭。

## 产品规则

- **停止必须覆盖整棵执行树。** 用户对后台 Bash 或前台 Bash 发起取消、超时终止、输出上限终止时，本次执行派生且仍存活的进程必须全部终止，包括已经 reparent 的孙进程。
- **停止结果必须可复现。** 停止按钮重复点击、任务已进入终态时，不得出现“界面说停止、进程仍在跑”的状态。
- **正常完成不改变既有的 `&` 语义。** 命令正常退出后，由命令自身放到后台的进程继续存活，不由 YCode 顺手杀掉；这与前台 timeout 转后台的既有设计一致。
- **失败要回落而不是阻断。** 原生 Job Object 不可用（非 Windows、原生模块加载失败、作业分配失败）时，保留既有 `taskkill /T /F` 路径，命令照常执行。

## 状态所有者与事件顺序

Windows Job Object 是本次执行进程树的所有者，生命周期跟随 `run()`：

```text
spawn 成功
  → 读取作业控制器（killOnJobClose = false）
  → 将 root 进程分配进作业
      → 后代进程继承作业成员身份，即使之后 reparent 也不脱离

停止请求（cancel / timeout 终止 / output_limit / adapter close）
  → TerminateJobObject：终止作业内全部进程
  → 关闭作业句柄
  → 继续沿用既有 terminateProcessTree 作为兜底

正常退出 / 结算
  → 只关闭作业句柄，不终止作业
  → 命令自身留在后台的进程保持存活
```

- 作业控制器只在执行器进程内持有，不落盘、不进协议、不参与资源管理器采样。
- `killOnJobClose = false`：CLI 异常退出时保持现状，不额外连带杀死用户命令放到后台的进程。
- 作业分配是异步的；分配完成前发生的停止请求会在控制器就绪后补发终止，不因竞态漏杀。
- PID 复用防护沿用执行器现有身份判断：只对本次执行持有的 root 与作业成员发终止。

## 接口与不变量

- `attachProcessToWindowsJobObject(pid, { killOnJobClose })`：新增 `killOnJobClose`，默认 `true`，保持 MCP stdio 传输的既有行为；Bash 执行传 `false`。
- `NodeExecutionAdapterOptions.windowsJobObjectFactory`：可注入作业控制器工厂，供测试替换原生能力；默认实现使用 Job Object。
- 作业终止与句柄关闭都幂等：重复请求不抛错，不影响命令结果。
- 执行结果、退出码、输出与既有状态机不变；本改动只补上停止时真正发生的进程终止。

## 负面边界

- 不引入全机进程登记表，不改变资源管理器的采样口径。
- 不追踪历史上已经脱离的进程；本规范只约束本次执行存活的树。
- 不改变 timeout 转后台语义，不改变前台 Bash 工具卡、后台面板与任务状态文案。
- 不在非 Windows 平台改变进程组与信号语义。

## 验收与测试

1. Windows 上注入假作业控制器：停止后台任务时调用 `terminate()` 且随后 `close()`。
2. 正常完成的执行只 `close()`，不 `terminate()`。
3. 作业控制器为 `undefined` 时退化为既有 `taskkill` 路径，执行结果不变。
4. `killOnJobClose` 默认保持 MCP 的 `KILL_ON_JOB_CLOSE` 标志；Bash 传 `false` 时不设置该标志。
5. 重复停止不重复终止、不抛错。
6. 运行适配器测试、`pnpm typecheck` 与 `pnpm lint`；GUI 场景需用户授权后才操作运行中的 YCode。
