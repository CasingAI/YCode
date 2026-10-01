# 进程显示名

## 当前规则

- 全仓库进程显示名前缀统一为小写 `ycode-`，与产品名对齐：CLI 为 `ycode-cli`，Desktop 侧为 `ycode-host-*`、`ycode-renderer-*`、`ycode-main`、`ycode-gpu`、`ycode-agent-*`。macOS 活动监视器搜索不区分大小写，搜 ycode/Ycode 均可命中。
- 统一用小写而不用 `YCode-`：`packages/shared/src/process-names.ts` 的 `sanitizeProcessNameSegment` 会把大写压成小写，为大小写去动正则会让 provider 名、工作区标签的大小写混入进程名，风险大于收益。
- 进程名长度约束：`process.title` 赋值受 argv 缓冲区长度限制，新名不得比原 argv 空间更长。本次所有改名均为等长替换（`zcode`→`ycode` 均为 5 字符，`ZCode`→`YCode` 均为 5 字符）。
- 进程名、命令名、npm 包名、协议标识四者互相独立，任何一个都不随另一个推导：
  - 进程名 `ycode-*`：`CLI_PROCESS_NAME`、`ZCODE_PROCESS_PREFIX` 系常量，仅用于显示。
  - 命令名 `zcode`：`CLI_COMMAND_NAME` 与 `packages/cli/package.json` 的 `bin`，决定用户输入的命令。
  - 包名 `zcode-cli` / `@zcode/*`：决定 workspace 依赖解析与发布，不可跟随进程名改动。
  - 协议与环境标识：`WORKER_KIND`、`ZCODE_PROCESS_LABEL` 环境变量名、Windows pipe 名 `zcode-node-repl-*`，决定 IPC 对接与运行时判定，不可跟随进程名改动。
- 全仓库唯一按进程名做匹配的逻辑是崩溃遥测的角色归类（`desktopStabilityTelemetry.ts` 的 `zcode-host` / `ycode-host` 与 `zcode-agent` / `ycode-agent` 前缀），其余消费方（资源采样、资源管理器、进程树清理）全部按 pid 或 category。禁止新增按进程名匹配的逻辑。

## 实现位置

- `apps/zcode-cli/packages/cli/src/process-name.ts`：`CLI_COMMAND_NAME` 与 `CLI_PROCESS_NAME` 的唯一定义处，`setCliProcessTitle` 负责赋值；`src/main.ts` 启动时调用（`--prepare-storage` 路径不设置）；`src/run.ts` 的 `zcode doctor --json` 输出 `cli.processName` 与 `runtime.processTitle`。
- `packages/shared/src/process-names.ts`：Desktop 侧全部进程名的格式化来源，前缀常量与 `formatZCode*` 函数；renderer 标题分支依赖窗口标题字面量（主窗口 `YCode`、远控 `YCode - ` 前缀）。
- `packages/desktop/src/main/desktopStabilityTelemetry.ts`：`mapChildProcessGoneToProcessRoleWithName` 按 `host` / `agent` 前缀归类，决定 `process_role` 与 `crashScope`；`process_name` 为三个上报事件的明细字段。
- `packages/desktop/src/main/desktopCronScheduler.ts`：cron 调度器的 `serviceName`；`ZCODE_PROCESS_LABEL` 环境变量值 `scheduler` 非显示名，保持不变。
- `apps/zcode-cli/packages/node-repl-host/src/server.ts`：`NODE_REPL_MCP_PROCESS_TITLE`（`setNodeReplMcpProcessTitle` 赋值）；同文件的 `WORKER_KIND` 为协议判别字段，保持不变。
- `packages/desktop/src/host/index.ts`：`process.title` 赋值（走 formatter 自动跟随）与 `writeHostLog` 的日志前缀字面量。

## 历史说明

- 2026-09-30 CLI 进程名由 `zcode-cli` 改为 `ycode-cli`（仅 `CLI_PROCESS_NAME` 一个常量）。
- 2026-10-01 剩余显示名统一为 `ycode-` 前缀：shared 前缀常量、renderer 标题字面量 `ZCode`→`YCode`、遥测前缀判断、cron `serviceName`、node-repl MCP 标题、host 日志前缀。pipe 名、协议字段、环境变量名、包名、命令名、`bin` 均未改动。
- 遥测断点声明：`process_name` 字段值在发版点必然变化（`zcode-host-*`→`ycode-host-*` 等），历史曲线在此处断裂；`process_role` 维度因同步改了前缀判断而保持连续。仓库内无 dashboard 定义，看板主维度应切到 `process_role`，属仓库外操作。
