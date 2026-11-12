# 资源管理器派生进程采样的完整性

## 产品规则

- YCode 自行从操作系统读取 PID、PPID 和资源指标，递归纳入本地宿主派生的 shell、Node.js、Python、构建 worker、Agent、MCP 与工具进程；不要求用户项目上报 PID、接入协议或修改代码。
- 统计口径必须统一：Host 派生过且仍存活的进程，不因中间父进程退出、PPID 断链或 root 已结束而缺席。Windows 上由 Host 自持的统计用 Job Object 维护成员身份，成员与 PPID 树并集纳入；成员身份只决定“算不算 YCode”，CPU/内存仍取自进程表。
- 总量按实际 PID 去重。终端及工具派生的外部程序属于 YCode 工作负载，不能仅因映像名不同而排除。远端进程不加到本机总量，已存在的共享系统服务不因被调用而自动归属。
- 来源会话只是展示信息，不是采集后代或纳入总量的前提。Host 回帖必须接受已有的可选 sessionId、sessionTitle；不能因某个后代带会话字段而拒绝整份资源快照。
- 采样失败、仍在等待或回退旧样本时，整机指标继续展示；YCode 应用合计、进度条和趋势不得把缺失数据当作真实零或完整总量。进程分组中存在未采样成员时，分组合计同样使用占位。页面显示明确的不完整采样说明。
- 保留已有分组、排序、终端能力、会话标注和刷新周期。PID 列表仅代表当前已发现进程，不宣称是不完整时的全部派生进程数。

## 所有权与接口

- `createProcessResourceSampler` 是单个 Host 的操作系统资源差分基线所有者；Windows 继续异步查表，不把 PowerShell 或其他外部查询移入 Electron Main。
- `createWindowsJobMembership` 是单个 Host 的“成员身份”所有者（仅 Windows）：Host 初始化服务时创建不设 `KILL_ON_JOB_CLOSE` 的统计用 Job，并在 CLI、Bash、MCP 等任何后代创建之前把 Host 自身加入；后代自动继承成员身份，中间层退出也不脱离。它只提供存活成员 PID，不提供指标、不参与终止、失败时返回 `undefined` 并由调用方回退。
- `attributeHostProcessTree` 依据 PPID 递归派生进程。CLI 已报告但不在 Host 当前子树下的工具根，与 Agent/MCP 根一样纳入断链补入，保留最近 owner、独占会话继承与 PID 去重。没有历史证据的任意脱离进程不猜测归属；统计 Job 的成员是唯一例外：它们有成员身份证据，按基础服务 `host` 组纳入且不带会话。
- 同一 PID 同时被 PPID 树和 Job 成员命中时只计一次；已知 owner 与会话优先于 Job 的匿名纳入。
- `createHostResourceUsageResponder` 是 Host 单轮采样的唯一所有者；成功、失败均显式回帖。最多一个底层采样，不积压 FIFO；取消后不发布旧结果。
- `resourceManagerHostSampling` 持有 Main 的在途 requestId 与上次成功 Host 结果。900 ms 仅限制展示等待；迟到的匹配回帖仍可更新缓存。尚未交付给任何展示请求的成功结果，下一次刷新可按 complete 消费一次，并启动下一轮单飞采样；已交付的旧值只能作为 stale 回退，不能因每轮都慢于展示等待而永远不显示完整指标。底层请求有独立的有界完成期限，用于丢响应后的取消和重试；不将永远不回应的请求无限锁住，也不按 UI 刷新周期重复启动采样。
- `ResourceUsageSnapshot` 增加可选 `samplingStatus: complete | pending | failed | stale`。缺省兼容旧宿主；客户端仍检查行级 sampled，旧快照有未采样行时也不能作为完整总量展示。
- Host `resource-usage-snapshot-result` 增加可选 `samplingStatus: complete | failed`，缺省兼容为 complete。行结构的可选 sessionId/sessionTitle 与 `HostResourceUsageProcess` 一致，保持严格校验，不开放任意字段。
- Server 复用相同快照状态；进程表失败不能返回看似完整的零用量。Desktop 的 Electron 指标继续留在 Main。

## 事件顺序与恢复

```text
Host 启动（初始化服务，早于任何 CLI/Bash spawn）
  → 创建统计用 Job（不设 kill-on-close，允许 breakaway）
  → 把 Host 自身加入 Job
  → 原生能力不可用时静默回退，不影响 Host 启动

资源管理器串行刷新
  → Main 为各 Host 建立唯一 requestId
  → Host 并行读取 OS 进程表、Job 成员 PID 与 Agent 来源元数据
  → 按 PPID 归属所有后代；Job 成员中未被 PPID 树覆盖的 PID 作为孤儿根补入并继续向下归属
  → 来源信息仅用于分组和会话标注；孤儿行归基础服务且不带会话
  → 严格校验成功/失败回帖，匹配 Host + requestId
  → Main 合并 Electron 指标，标记 complete / pending / failed / stale
  → UI 完整替换快照；仅完整指标进入 YCode 合计和趋势

展示等待结束 → 返回 pending 或 stale，不另开同一 Host 采样
迟到成功回帖 → 更新同一 owner 缓存 → 下次刷新可见
失败 / 完成期限结束 → 显式失败并释放请求 → 下次刷新重试
窗口关闭 / Host 退出 → 取消在途、清缓存 → 旧 requestId 不得写回新生命周期
```

- UI 不持有第二份进程归属事实，不新增轮询或持久化状态。
- 本改动不改变会话、owner/lease、workspace identity、Desktop continuous 或 Web replayable 链路；两种客户端读取的都是宿主快照，重连后完整替换。
- Windows 的统计 Job 只用于成员纳入，不读取其 CPU/内存、不参与终止、不设置 `KILL_ON_JOB_CLOSE`，也不向终止链路提供信息。Bash 停止仍使用每次执行自己的 Job 回收整棵树，见 `windows-bash-process-tree-stop.md`。
- 统计 Job 随 Host 进程生命周期存在：Host 重启后无法追溯上一个 Host 派生的进程。非 Windows、原生模块不可用、嵌套作业分配失败时回退为 PPID 树，不阻断采样，也不把这种情况判为采样失败。
- 显式 breakaway 的进程会脱离统计成员身份；周期采样不能保证捕获两次采样之间已退出的短命进程，不能宣称这部分历史用量已精确计入。Job 只说明“由本 Host 派生”，不说明属于哪个会话。

## 验收与测试

1. Host 下 shell → npm/Node.js → worker，无项目上报、无会话字段，所有存活后代被纳入且只计一次；已报告但脱离 Host 当前子树的工具根及后代仍保留 owner 和会话。
2. 中间父进程已退出、PPID 指向失效 PID 时，统计 Job 中仍存活的成员及其存活后代被纳入，归基础服务且不带会话；同一 PID 不重复计数，已知 owner 不被匿名纳入覆盖。
3. 非 Windows 或成员枚举失败时归属结果与改造前一致，不抛错、不把本轮判为失败。
4. Host 回帖的 sessionId/sessionTitle 通过实际 Main 使用的严格 schema；非法未知字段仍拒绝。
5. Windows 采样测试覆盖输出解析、累积 CPU 单位、逻辑核归一化、失败和取消。避免逐行 PowerShell 管道输出的额外开销，查询仍有界，错误不得当作成功的部分表。
6. Main 回归覆盖慢回帖写入缓存、在途不重复请求、失败不伪装完整空列表、丢响应后的有界恢复、关闭/重开后旧结果隔离。
7. Server 进程表失败返回 failed 状态；后续成功恢复 complete，不固化零值。
8. 中英文、CPU/内存、宽窄屏均显示不完整说明与合计占位，不完整 YCode 样本不绘制为零用量趋势；完整样本恢复原数值和排序。
9. 运行相关单测、pnpm typecheck、pnpm lint、定向格式检查和 pnpm architecture:check --changed，区分本次与已有失败。
10. GUI E2E 场景：窗口打开后等待采样、切换指标、带会话的工具进程、慢采样恢复、关闭重开；未经授权不操作正在运行的 YCode、不使用 CDP/DevTools/UI 自动化。本轮以组件/协议/链路测试与只读 OS 查询验证，未执行的 GUI 场景明确报告。
