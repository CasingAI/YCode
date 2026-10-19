# Spec: 资源管理器进程行标注来源会话

## 目标

资源管理器的「基础服务」分组里会列出大量 `node` 进程。这些进程多数是 Agent 在某次会话里通过 Bash 拉起的项目进程（dev server、测试进程、构建 worker），但列表里只有进程名和 PID，看不出**是哪一次会话把它拉起来的**。多会话并行时，定位"是谁把内存吃掉了"只能靠猜。

本改动让进程行在名称之后追加会话标注：

```
node · 修复弹窗
```

空间不够时按 CSS 截断，进程名本身始终可见。

## 产品规则

- **只标注独占进程**：进程行带会话，前提是这个进程（及其子树）由**唯一一个**会话发起。共享进程不标。
  - Agent runtime 本身（`ycode-agent-*`）服务同一工作区的多个会话，任何时刻都不能被标成某个会话独占。
  - workspace 隔离的 MCP 连接可能被多个会话共享，共享期间不标。
  - 工具（Bash 等）派生的进程天然独占：它记录的是发起那次执行的会话。
- **会话沿进程树继承**：标注落在"进程根"上，整棵子树继承同一个会话。`zsh -c "pnpm dev"` 拉起的 `node` 子孙与根同属一次会话。
- **展示形态**：会话标题追加在进程名之后，用 `·` 分隔，字号比进程名小一号、颜色更淡；标题过长按容器宽度截断（`truncate`），进程名不截断（`shrink-0`），保证窄窗口下仍能看清"这是个什么进程"。悬停提示为 `会话：<标题>`。
- **无标题时降级**：会话有 id 但拿不到标题（会话未持久化、标题为空）时，只标 id 意义不大，直接不显示会话标注；归属信息仍保留在数据里。
- **插件分组沿用原样**：内置插件 / 社区插件分组第二行仍是插件名，不改成会话；会话标注只追加在进程名后，两行信息互不覆盖。
- **不新增交互**：标注是纯展示，不提供点击跳转、不改变分组与排序（排序仍按 CPU → 内存 → PID）。

## 数据链路

```
CLI 工具执行适配器 spawn
  → 登记 pid → sessionId（进程退出时注销）
CLI MCP 连接池 lease
  → 连接 → owner sessionId 集合
CLI `process/childProcesses`
  → MCP 子进程（带独占 sessionId/sessionTitle）+ toolProcesses（pid → sessionId/sessionTitle）
Host 进程树归属
  → 沿进程树继承会话，产出带 sessionId/sessionTitle 的进程行
桌面 main 合并快照 → 资源管理器窗口
UI 进程行
  → 名称后追加「· 会话标题」
```

## 状态所有者

| 状态 | 所有者 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| pid → sessionId（工具派生） | CLI 进程内 `sessionProcessRegistry` | 进程内存活期，随 CLI 退出消失 | 唯一写入点：执行适配器 spawn 成功后登记、子进程退出时注销 |
| MCP 连接 → owner sessionId | CLI 进程内 MCP 遥测 tracker | 连接存活期 | 复用既有 lease owner 机制，不新增第二份记录 |
| 会话标题 | CLI 持久化 session store | 会话存续期 | CLI 是会话标题的唯一权威；Host 不自己解析标题 |
| 进程 → 会话归属 | 桌面 Host 的进程树归属计算 | 单次采样 | 按进程树现算，不缓存 |

**唯一写入路径**：只有 CLI 侧能写"哪个进程属于哪个会话"。桌面与 UI 只读不改。

## 接口

- 协议（`packages/shared/src/zcode-protocol/index.ts`）
  - `zcodeProcessChildProcessSchema` 新增可选 `sessionId` / `sessionTitle`。
  - 新增 `zcodeProcessToolProcessSchema`（`pid` + `sessionId` + 可选 `sessionTitle`）。
  - `zcodeProcessChildProcessesResultSchema` 新增可选 `toolProcesses`；旧 CLI 不带该字段时按空数组处理。
- 协议（`packages/shared/src/protocol.ts`）
  - `ResourceUsageProcess` 新增可选 `sessionId` / `sessionTitle`。
- CLI（`apps/zcode-cli/packages/adapters/src/exec/session-process-registry.ts`，新增）
  - `registerSessionProcess(pid, sessionId)` / `unregisterSessionProcess(pid)` / `listSessionProcesses()`。
  - 登记簿容量上限 512，超出时淘汰最早一条：归属信息只是展示线索，残留条目不影响正确性。
- CLI（`apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts`）
  - `McpTrackedProcess` 新增可选 `sessionIds`（持有该连接的会话集合）。
- CLI（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/process-child-processes.ts`）
  - `listChildProcesses(tracked, toolProcesses, resolveSessionTitle)` 改为异步；MCP 连接只有在 `sessionIds.length === 1` 时才带会话。
  - `resolveSessionTitle(store, sessionId)` 只读持久化会话行，读不到或标题为空返回 `undefined`。
- 服务（`packages/services/src/process/hostProcessAttribution.ts`，由 `processResourceSampler.ts` 拆出）
  - `HostResourceUsageAgent` 新增 `toolProcesses`。
  - `attributeHostProcessTree()` 维护 `pid → 会话` 映射，沿进程树向下继承；MCP owner 自带会话，工具派生进程根按 pid 命中会话。
- 服务（`packages/services/src/zcode-agent/zcodeAgent.ts`）
  - `ZCodeAgentLocalRuntimeChildProcesses` 新增 `toolProcesses`。
- UI（`packages/ui/src/resource-manager/resourceUsageParts.tsx`）
  - 进程行在名称后追加 `· {sessionTitle}`；i18n 新增 `resourceManager.processSession`（悬停提示）。

## 失败语义

- CLI 侧读不到会话标题、登记簿里没有条目、旧 CLI 不支持新字段：都只表现为"这一行没有会话标注"，不影响进程行的其余信息与指标采样。
- 会话标题读取失败不能影响 `process/childProcesses` 的进程上报——归属信息是展示线索，不是必要字段。
- pid 复用：登记簿按 pid 去重，进程退出即注销；Host 侧按进程树现算归属，进程消失后该行整体消失。

## 不做的事

- 不按会话过滤或分组进程列表（分组仍只有基础服务 / 内置插件 / 社区插件三类）。
- 不追踪任意孙进程的发起者，只登记工具派生的根 pid，其余靠进程树继承。
- 不在桌面侧维护第二份"进程 → 会话"缓存。
- 不给会话标注加点击跳转。

## 验证

- `packages/services/test/resourceUsageProcessSessionAttribution.test.ts`：工具派生进程根与后代继承会话；MCP 独占连接带会话、共享连接不带；无会话信息时不产生会话字段。
- `apps/zcode-cli/packages/adapters/test/sessionProcessRegistry.test.ts`：登记 / 注销 / 非法入参 / 同 pid 覆盖。
- `apps/zcode-cli/packages/bootstrap/test/processChildProcessesSessionAttribution.test.ts`：独占与共享 MCP 的会话上报、工具进程上报、空列表省略字段。
- `packages/ui/test/resourceManagerProcessSession.test.ts`：进程行渲染出会话标题与悬停提示；无会话时不渲染会话标记。
