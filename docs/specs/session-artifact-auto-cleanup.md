# 规格：压缩与归档后自动清理会话产物

## 目标

为较大的会话运行产物增加一个全局、默认关闭的自动清理开关。开启后，在上下文压缩成功并且相关会话工作确已空闲时，清理压缩边界之前的可归属产物；会话归档持久化后，在会话空闲时清理该会话的可清理产物。

本功能不清理会话正文、会话数据库、用户发送的图片或用户原始文件；不清理全局日志、配置、插件、共享缓存或无法确认归属的文件。

## 产品规则

- 全局设置 `sessionArtifactAutoCleanupEnabled` 默认 `false`。关闭时不创建待处理清理，也不执行自动清理。
- 开启后同时启用压缩后和归档后的清理，不增加语义重复的子开关。
- 如果用户开启现有的 `modelIoFullRetentionEnabled`，自动清理仍可清命令输出和工具生成结果，但必须保留模型调用轨迹；全量保留是用户对轨迹的显式选择。
- **成功压缩**：仅 `context_compaction.status === "completed"` 且存在有效 `endedAt` 时登记清理。RPC/命令 ACK、开始事件、失败或中断均不代表压缩成功。
- **压缩边界**：以压缩终态的 `endedAt` 为边界。命令输出、工具生成结果和模型调用轨迹只清理 `completedAt < endedAt` 的记录/文件；无法确认边界或时间的对象保留。时间相等按边界后处理，避免误删。
- **归档**：归档状态成功持久化后登记整会话清理。归档不停止会话；正在运行时等待 CLI 侧确认无前台 turn、排队工作、后台工作和写入者后清理。取消归档不恢复已清理产物。
- 归档事件须覆盖单会话归档、工作区批量归档、过期/陈旧批量归档及自动归档；只对实际成功持久化为 archived 的会话登记。
- 用户发送的 inline 图片/PDF可能在 `cli/artifacts/<sessionId>` 外置存储。文件名 `prompt-attachment-…-tool-result-…` 属于用户附件，压缩或归档自动清理必须跳过；会话正文与 input history 所引用的内容保持不变。
- 工具调用生成的 `cli/artifacts/<sessionId>` 结果文件可以清理；清理后，旧工具卡中的完整结果或生成图片可能无法再次打开，但会话正文与工具卡摘要仍保留。
- `cli/exec/<sessionId>` 下的命令完整输出可以清理。
- `cli/debug/model-io-<sessionId>.jsonl` 与 `cli/rollout/model-io-<sessionId>.jsonl` 可以按压缩边界裁剪，归档时可整份删除。压缩裁剪必须按 `completedAt` 过滤，并安全重建保留部分的 delta baseline；进入裁剪流程前必须验证边界存在且有效，已验证的边界在记录过滤中作为必需值使用；JSONL 解析、排序、展开或重写任一步不确定时，保持原文件不变并报告跳过。
- `cli/agents/<sessionId>/**/transcript.jsonl` 仅在目录能按当前父会话精确归属、且 CLI 确认没有活动 writer 时可清理；其余 `agents` 文件不在白名单。
- 不清理 `sessionStore` / `cli/db`、用户指定原路径文件、全局日志、pending checkpoint、workflow 脚本、sandbox、派生媒体缓存及其它未列入白名单的内容。

## 所有权与边界

- 自动清理的文件操作唯一 owner 是写入这些文件的 CLI 进程。Host 只能提交带 workspace identity、session ID 和清理边界的会话级请求；Renderer、StorageService 和 Host 不直接访问 CLI 或远程文件系统。
- Host 通过新增 V4 `conversation/sessionArtifactCleanup` mutation RPC 向对应 CLI 发起清理请求；该 RPC 只使用现存可信连接，不经 `v4/command`，不触发会话冷恢复。远程 workspace 必须按 `workspaceIdentity` 与 `remoteSessionId` 路由；连接不可信、目标不匹配或 owner 不可达时保留文件。
- CLI 清理只操作当前应用实例明确注入的存储根：执行输出与模型轨迹使用当前 `storage.dir` 根；工具结果同时考虑该根下的旧 `cli/artifacts` 和当前 `ycodeDataBaseDir/.ycode/cli/artifacts` 写入根。protocol server 的 `sessionStorageRoots` 还包含 `.ycode` 用于只读扫描，不能通过数组顺序推导删除根。模型轨迹 writer 与清理器必须共用当前 `modelIoDir`；未知或不可解析的自定义根 fail closed。
- CLI 仅可操作精确 session ID 对应的路径白名单；拒绝路径分隔符、父路径段、符号链接和根目录越界。检查每个存储路径祖先，任何 session 目录或中间目录为 symlink 时不跟随、不删除目标。请求仅含 session ID、清理模式、可选压缩边界及是否保留模型轨迹，不接受任意路径。
- CLI 在删除前由 runtime 同步取得会话清理排他租约，并在同一临界段再次确认当前会话没有运行时 owned work；若忙、状态查询失败或已有清理租约则 fail closed。租约持有期间，runtime command drain 暂停；新 prompt/sidecar work 在文件操作完成后才可启动。租约释放后唤醒已排队命令。CLI 协议 operation lease 只防止 session 回收，不替代此 runtime admission 临界区。
- 清理成功压缩轨迹时，必须从文件头按写入顺序逐条展开 `full`/`delta` 记录，确保 delta 的 offset、count 和数组长度一致。遇到 `tail`、缺失基线、元数据矛盾或任一记录不可展开时，不改写原文件；第一条保留记录的可展开 collections 写回完整数组并标记 `full`，不能把 delta 片段伪装成完整 baseline。
- 文件系统没有独立的工具结果完成时间，`mtime < endedAt` 只在 CLI 持有排他租约、确认所有 runtime owned work 已结束后作为命令输出/工具结果边界证据；边界无效、mtime 不可用或路径所有权无法确认时保留。
- `create-app` 的 `ycodeDataBaseDir/.ycode/cli/artifacts/<sessionId>` 是当前写入根：仅清理白名单中的一般工具结果文件；凡命中 `prompt-attachment-` 前缀的文件均保护。历史 `storage.dir/cli/artifacts/<sessionId>` 只作为旧写入根处理。
- 仅限 artifacts 和 exec session 目录的顶层普通文件；不递归进入未知子目录。`agents` transcript 需先证明 parent/child 归属及 writer 生命周期，本次实现不触及该树。

## runtime 清理互斥顺序

```text
RPC 持有 SessionResidentPool operation lease
  → runtime 同步检查 idle 并取得 session-artifact cleanup lease
  → runtime 暂停命令 drain，新 sidecar work 在 lease 后等待
  → CLI 复核 owned work 并操作白名单文件
  → runtime 释放 lease，恢复 command drain 与等待中的 sidecar
  → RPC 释放 SessionResidentPool operation lease
```

租约获取与 busy 检查必须是同一同步执行片，任何新 runtime work 在启动写入前要么被排队等待租约释放，要么作为 owned work 使 lease 获取失败；不得出现“检查 idle 后 await 文件 IO、同时接受新的文件 writer”的窗口。

- Host 待处理清理队列唯一 owner 为 task service adapter，key 为 `resolveWorkspaceKey(target) + sessionId`。压缩边界合并保留最早有效边界，归档模式优先；每次设置关闭时清空待处理队列。调用可信 V4 路由成功且 CLI 返回非 busy 结果后移除请求；busy、断连或状态未知时保留，ready 事件即使无 prompt/runtime command 也需唤醒队列。
- 归档状态写入索引失败时不得先发布 overlay 或登记清理；成功归档只登记实际返回/确认已持久化为 archived 的会话。

## 存储与生命周期所有权

```text
CLI runtime owns admission / busy / cleanup lease
        │ synchronous lease + final busy check
        ▼
CLI adapter owns file allowlist / boundary / atomic trajectory rewrite
        ▲
Host task adapter owns pending triggers and workspace/session routing
        │ trusted existing-only V4 mutation RPC
        └───────────────────────────────────────────────
```

压缩成功事件按结构化 `context_compaction.status === "completed"` 与有效 `endedAt` 触发；归档仅在 task index 持久化成功后触发。两者都等待对应 CLI session ready，再经 `existing-only` 可信连接送达，不激活冷会话。

- `StorageService` 与 `docs/specs/storage-cleanup-dialog.md` 继续只负责用户显式触发的本地磁盘扫描/清理；本功能不把自动清理塞进按类别全局删除路径，也不改变其合同。
- 压缩和归档请求按 `workspaceIdentity + sessionId` 合并；压缩保留最早待处理边界，归档清理强于压缩清理。重复事件与重试必须幂等。
- CLI 响应应区分已删除、已跳过和失败，使用稳定原因码；日志不写文件正文、附件内容、凭据或敏感模型请求内容。

## 生命周期与事件顺序

```text
成功压缩 timeline (endedAt) ─┐
                             ├→ Host 按 workspaceIdentity + sessionId 合并待清理请求
归档索引持久化成功 ──────────┘                         ↓
                                           对应 CLI 会话 ready
                                                        ↓
                                   CLI 复核 owned work 与文件 writer 已结束
                                                        ↓
                                   CLI 按路径白名单与压缩边界执行清理
                                                        ↓
                                      返回删除/跳过/失败的稳定结果
```

- Syncer 的 terminal 表示回合收口，不能证明运行时锁释放；ready 事件表示活动锁释放。Host 在 ready 前不提交清理请求。
- ready 之后，CLI 仍需用 runtime 的 owned-work 权威状态复核后台工作；有活动工作时保留/延后请求，不用固定延时猜测。
- Host 待处理状态不替代 CLI 的运行时事实。请求丢失、owner 断开或状态未知时保留文件；后续归档或 ready 事件可以安全重试。
- `StorageService` 与 `docs/specs/storage-cleanup-dialog.md` 继续只负责用户显式触发的本地磁盘扫描/清理；本功能不把自动清理塞进按类别全局删除路径，也不改变其合同。

## 范围外的高占用内容

只读目录统计曾显示 `.zcode` 中主要占用来自 `cli/exec`、`cli/db`、日志、模型轨迹和工具结果。数据库、日志及插件调试数据有不同生命周期，不应因为某个会话压缩或归档而清理；其容量治理另行设计。

## 验收场景

1. 设置默认关闭；关闭时，无论压缩或归档均不删除文件。
2. 开启后，压缩失败/中断/缺少 `endedAt` 均不清理；成功压缩只清边界之前的命令输出和工具结果，保留边界后文件。
3. `prompt-attachment-…` 图片/PDF附件与数据库里的会话正文在压缩和归档后仍可读取；一般工具结果可按规则清理。
4. 压缩轨迹裁剪后，现有模型轨迹读取器能正确还原保留记录；任一 delta 无法安全展开/重建时，原文件保持不变并报告跳过。
5. 开启 `modelIoFullRetentionEnabled` 时，其它类别仍可自动清理，但模型轨迹保持不变。
6. 归档时若会话或后台工作仍在运行，不删除；CLI 确认完全空闲后清理。取消归档不恢复产物，会话仍可打开、续聊。
7. 单会话、批量、stale 和自动归档都只对索引持久化成功的会话触发；重复触发不会越界删除或重复计数。
8. 远程 owner 不可达、workspace identity 不匹配、session ID 非法、路径越界、文件为 symlink、状态或时间未知时，保留对应文件并返回稳定跳过原因。
9. `cli/db`、用户原始文件、日志、checkpoint、workflow、sandbox、共享缓存和其它白名单外路径始终不受影响。

## 验证

- CLI adapters 单测覆盖路径白名单、session ID 校验、附件文件保护、symlink 防护、压缩边界、归档整清、活动 writer、文件操作失败和模型轨迹 delta 重建/失败保留。
- Host 测试覆盖压缩成功/失败、ready 时序、持久归档的单条/批量/stale/auto 路径、workspace 路由、重复请求和设置关闭。
- 设置测试覆盖默认关闭、启停持久化、`modelIoFullRetentionEnabled` 优先级。
- UI 存储设置测试覆盖系统开关的中英文文案、默认状态和更新。
- 不操作正在运行的 YCode；执行仓库要求的 `pnpm typecheck`、`pnpm lint`、目标包测试及 `pnpm architecture:check --changed`。
