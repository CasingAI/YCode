# 窗口工作区镜像：手机远控端与桌面端对等

## 目标

手机（或电脑浏览器）通过桌面 App 的远控服务接入后，两端看到的工作区列表、当前激活的工作区、当前激活的会话、侧栏展开态必须完全一致；任一端做的结构操作，另一端立即产生同样的效果。

会话内容、对话流、主题与语言这类"事实源已在 Host 内共享"的状态不在本 spec 范围内；本 spec 补齐**窗口结构状态**与**未发送草稿**这两条缺失的同步链路。

## 状态所有者

`packages/ui/src/store/tabStore.ts` 的 tabStore 是窗口结构状态的唯一所有者：

- 打开的工作区集合（`tabs`）、顺序、当前激活项（`activeTabId` / `activeWorkspacePath` / `activeWorkspaceIdentity`）、侧栏展开态（`expandedWorkspacePaths`）都由它持有；
- 手机远控端不再独立持有这份状态，它持有的是同一份状态的**投影**；
- 写路径只有一条：所有结构操作最终都在桌面窗口的 tabStore 上执行。

`packages/desktop/src/host/windowHostControllerProjection.ts` 持有投影的**副本与分发**，不是所有者：

- 它缓存最近一次上报的全量快照，供后加入的 attachment 立即订阅；
- 它按 `revision` 分配单调递增值并发布帧；
- 它不接受来自客户端的直接写入，写入只来自桌面 renderer 的上报。

`activeTaskId` 由 `packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts` 的 workspace 分片持有，随同一份快照一起上报与投影。

## 草稿（未发送输入）的共享

未发送的输入此前只存在各端自己的 localStorage 里，物理隔离：手机写了半句话桌面看不到，桌面写的草稿手机也看不到。

草稿改为存在 **Host 侧的共享服务**（`IComposerDraftService`，频道 `composer-draft`）：

- 桌面窗口与手机远控端连的是同一个 Host，服务实例因此只有一份，两端读写的是同一条记录，不需要额外的同步协议；
- 草稿内容由 UI 侧定义（`payload`），服务只负责搬运与定序，不解释内容；
- 落盘按工作区分文件（`{appConfigDir}/composer-drafts/<hash>.json`），单个工作区最多保留 50 条草稿，超出按 `updatedAt` 淘汰最旧的；
- 落盘带 800ms 去抖：输入停顿期间会连续写同一份草稿，只需跟上最后一份。内存副本与变更事件是即时的，另一端因此能立刻看到，不受去抖影响；
- 草稿是用户数据，不进 `setting.json`，也不跟随通用配置导出与迁移。

冲突裁决（`shouldApplySharedComposerDraft`，纯函数）：

1. **自己写的记录不应用**——那是本端自己的回声。
2. **正文与本地草稿相同的不应用**——内容已经一致，重复应用只会引发"应用 → 回写 → 再应用"的写入回环。
3. **本地编辑器还有未保存输入时不应用**——正在打字时不能被另一端覆盖。
4. 其余情况才应用远端版本。

裁决结果就是"最后写入者赢"，但打字中的一端不会被另一端打断：被跳过的远端版本会在下一次同步时由本端的新写入取代。

## 产品规则

- 桌面窗口是权威端，手机远控端是镜像端。镜像端不做本地乐观改写，任何结构操作都以命令形式提交给权威端，等权威端回传新快照后再落地。
- 命令有独立回执。镜像端不能靠"有没有收到更大的快照"判断命令是否被执行：切换到已经激活的会话这类命令不改变窗口结构，也就没有新快照，用它判断会误报"桌面端无响应"。
- 命令回执超时（桌面窗口关闭、renderer 未挂载、连接中断）时，镜像端显示"桌面端无响应"提示。镜像端本来就不做乐观改写，因此没有需要回滚的悬空状态。
- 权威端上报的是**全量快照**，不做增量合并。窗口内工作区数量为个位数，全量的成本可以忽略，全量能消除一整类增量顺序与合并错误。
- 快照携带 `revision`（Host 分配，单调递增）与 `clientRevision`（上报方分配，单调递增）。Host 只接受 `clientRevision` 更大的上报；镜像端只接受 `revision` 更大的快照。
- 权威端不订阅本 topic。权威端是唯一生产者，订阅会引入回环。
- 命令与快照走两条方向相反的通道：命令只由镜像端发出，快照只由权威端发出，两者不交叉，因此不需要额外的来源标记来防回环。
- 镜像端不再写入 `settings.lastWorkspaceSession` / `lastActiveTabIndex` / `recentProjects`。这三个键是桌面窗口的持久化事实，写入方唯一。
- 镜像端不再从 `settings.lastWorkspaceSession` 恢复窗口结构。它只从 Host 的快照恢复，也不自行 bootstrap 初始工作区。
- 手机端与桌面端在偏好类状态（语言、主题、字号、界面模式）上以桌面为准：主题/界面模式/字号随窗口快照一起下发并落地，语言以桌面 `setting.json` 为准（`preferSettingServiceLocale`）。
- 多窗口下，手机镜像的是它所连接的那一个桌面窗口。桌面端沿用既有 `activateOrSetWorkspace` 语义：同一个目录不重复开在多个窗口。工作区已在**其它**桌面窗口打开时，权威端激活那个窗口并把这一结果回传，镜像端提示"已在其它窗口打开"，不静默无反应。
- 远程 workspace（SSH/WSL/Docker）tab 镜像后只在桌面端可操作，手机端只读展示。

## 接口

### 协议（`packages/shared/src/zcode-protocol-v4/`）

新增独立 topic，不复用 `CONTROLLER_WORKSPACES_TOPIC`：

```text
CONTROLLER_WINDOW_WORKSPACES_TOPIC = "controller/window-workspaces"
```

`CONTROLLER_WORKSPACES_TOPIC` 描述的是"Host 从哪个数据源读任务"（source 事实），本 topic 描述的是"窗口打开了哪些工作区"（UI 事实），两者语义与生命周期不同，混用会污染 source 的重连与下线语义。

快照载荷（`packages/shared/src/zcode-protocol-v4/window-workspaces.ts`）：

```ts
windowWorkspaceEntrySchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().min(1).optional(),
  remoteSessionId: z.string().min(1).optional(),
  remoteTarget: z.unknown().optional(),
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  availability: z.enum(["available", "unavailable-local-directory"]).optional(),
  // 该工作区当前打开的会话；null 表示停在草稿态。
  activeTaskId: z.string().min(1).nullable().optional(),
});

windowAppearanceSchema = z.object({
  theme: z.enum(["light", "dark", "zai-light", "zai-dark", "system"]),
  interfaceMode: z.enum(["office", "coding"]),
  uiFontSizePx: z.number().int().positive(),
});

windowWorkspaceSetStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  entries: z.array(windowWorkspaceEntrySchema),
  activeEntryId: z.string().min(1).nullable(),
  activeWorkspacePath: z.string().min(1).nullable(),
  activeWorkspaceIdentity: z.string().min(1).nullable(),
  expandedWorkspacePaths: z.array(z.string()),
  appearance: windowAppearanceSchema.optional(),
});
```

条目 id 直接复用权威端 tabStore 的 tab id，镜像端按同一 id 建 tab，这样命令里的
`entryId` 在两端指向同一个工作区。

`activeTaskId` 挂在条目上而不是单独的映射表：会话状态本来就是按工作区分桶的，
每个工作区条目自带当前打开的会话即可表达"切走再切回仍停在原会话"。

`expandedWorkspacePaths` 沿用 tabStore 的既有口径（按路径记录展开态），
不引入第二套 identity 口径。

`appearance` 承载主题、界面模式与字号。这三项只存在于各端 localStorage，
不落 `settings.json`，因此只能由权威端随窗口快照一起下发。

帧结构复用 `createControllerFrameSchema`：snapshot 帧载荷为 `{ protocolVersion: 1, logEpoch, windowWorkspaces }`，delta 帧只有一条 op `window-workspaces.replaced`。

`createControllerFrameSchema` 的 topic 参数必须是**泛型**（`Topic extends WindowHostControllerTopic`）：topic 一旦退化成联合类型，各帧的 `topic` 字段就无法按主题收窄，订阅端只能靠 `as` 强转。

### 服务（`packages/services/src/window-controller/windowController.ts`）

`IWindowControllerService` 增加一个方法：

```ts
reportWindowWorkspaceSet(report: {
  clientRevision: number;
  entries: WindowWorkspaceEntry[];
  activeEntryId: string | null;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  expandedWorkspacePaths: string[];
  appearance?: WindowAppearance;
}): Promise<{ revision: number }>;
```

返回被接受的 `revision`。`clientRevision` 不大于上次接受值时返回上次的结果，不发布新帧（幂等）。

### 命令通道

沿用 `IBroadcastService` 的既有广播机制，不新增 RPC 服务：

```text
channel: "state:window-command"
```

载荷为带 `commandId` 的判别联合（`packages/shared/src/window-commands.ts`）：

```ts
type WindowCommand =
  | { type: "open-workspace"; workspacePath: string; workspaceIdentity?: string; activateTaskId?: string }
  | { type: "ensure-workspace"; workspacePath: string; workspaceIdentity?: string }
  | { type: "close-workspace"; entryId: string }
  | { type: "activate-workspace"; entryId: string }
  | { type: "reorder-workspaces"; fromIndex: number; toIndex: number }
  | { type: "set-workspace-expanded"; workspacePath: string; expanded: boolean }
  | { type: "activate-task"; workspacePath: string; workspaceIdentity?: string; taskId: string | null };
```

`open-workspace` 携带可选的 `activateTaskId`：打开工作区本身是 "workspace-only" 意图（会清掉该工作区当前会话），深链到某个会话时必须把两件事合成一条命令，否则两条命令之间的顺序竞争会让"打开"落在"激活"之后，把刚激活的会话又清回草稿。

回执走独立 channel：

```text
channel: "state:window-command-ack"
payload: { commandId: string; ok: boolean; error?: string; outcome?: "applied" | "opened-in-other-window" }
```

回执与命令分开 channel，权威端的命令监听器因此不会把自己的回执当成新命令再执行一次。

`outcome` 表达"命令执行了，但没有落在被镜像的这个窗口"：桌面端沿用跨窗口激活语义把工作区交给了另一个窗口（`opened-in-other-window`）。镜像端据此提示用户，其余情况一律是 `applied`。缺省视为 `applied`，旧回执不影响新链路。

广播是同一 Host 内的单向直达（`packages/services/src/broadcast/broadcastService.ts` 的 `send` 会 `emitter.fire` 给同 Host 的所有订阅者），`state:theme` / `state:locale` 已是这一机制的既成范式。

### 能力协商

服务端通过 `/api/server-info` 暴露 `capabilities.windowWorkspaceMirror`：

- 桌面 Host 内置的局域网前端（手机远控）声明为 true；
- 独立 `zcode-server` 不暴露 `IWindowControllerService`，因此不可能声明为 true。

Web 端据此决定自己是不是镜像端（`packages/web/src/main.tsx` 的 `resolveWebBootstrap`）。

## 事件顺序

### 权威端上报

```text
桌面 tabStore 变化
  → debounce 50ms
  → 取当前 tabs / active / expanded / activeTaskId / appearance
  → 内容签名比对（结构未变则不上报）
  → clientRevision += 1
  → reportWindowWorkspaceSet
  → Host 校验 clientRevision
  → Host 分配 revision 并缓存快照
  → Host 向该 topic 的订阅者发布替换帧
  → 镜像端收到帧
  → revision 校验
  → applyMirroredWorkspaceSet + applyMirroredActiveTaskId + 对齐外观
```

### 镜像端提交命令

```text
镜像端用户操作
  → 生成 commandId
  → broadcastService.send(state:window-command)
  → 权威端收到命令（按 commandId 去重）
  → 权威端串行执行对应 tabStore / session store 写入
  → 权威端回执 state:window-command-ack
  → tabStore 变化
  → 走"权威端上报"链路
  → 镜像端收到新快照并收敛
```

权威端的命令执行是**串行队列**：打开工作区是异步流程（要跨进程确认目录、预热草稿），并发执行会让"打开"落在"激活会话"之后。

## 失败与取消

- 镜像端发送命令后回执超时：镜像端显示"桌面端无响应"提示。镜像端不做乐观改写，因此没有需要回滚的状态；用户再次操作仍会重试并带回执。
- 权威端收到无法执行的命令（例如 `close-workspace` 的 `entryId` 已不存在）：回执 `ok: false`，不产生快照变化。
- Host 收到 `clientRevision` 不大于上次接受值的上报：不发布新帧，返回上次 `revision`。
- 手机断线重连：重新订阅 topic 即可拿到全量快照，期间在手机侧的操作不会补发。这是镜像语义的既定取舍。
- 桌面窗口关闭：Host 随窗口销毁，手机端连接断开，由既有的连接状态界面提示；命令回执超时也会触发"桌面端无响应"提示。

## Delivery 边界

`clientMode` 与 `deliveryProfile` 是两件事，本 spec 把它们解耦：

- `clientMode`（`desktop-continuous` / `web-remote-replayable`）回答"这是不是本机桌面"：权限弹窗、本地终端、telemetry、远端媒体预览都按它判定，远控端必须留在 `web-remote-replayable`。
- `deliveryProfile`（`continuous` / `replayable`）决定会话行可见性与流式路径：桌面用 `continuous`，`inputText` / `output.text` / `summaryText` 的流式细节逐段下发；`replayable` 只发最终 `text`。

过去两者绑在一起（`deliveryProfileFor(clientMode)`），手机因此天然少看到桌面的一半流式细节。现在：

- `deliveryProfile` 成为可信连接上下文（`ZCodeAgentV4ConnectionContext.deliveryProfile`）上的独立字段，由 Host attachment 注入，经 `readTrustedZCodeAgentV4Connection` 传给下游；
- 手机远控 attachment 显式声明 `continuous`（`packages/desktop/src/host/mobileRemoteControlConnection.ts`）；
- 未声明时按 `clientMode` 回落旧口径（`defaultDeliveryProfileForClientMode`），既有连接行为不变。

**解耦只发生在订阅请求上，hello 保持旧口径**。既有客户端的 `helloMessageSchema` 把 `clientMode` 与 `deliveryProfile` 绑死（必须匹配），新 Host 一旦在 hello 里报出与 `clientMode` 不同的档位，旧版 web 客户端会在握手阶段直接解析失败——不是少看到一点流式细节，而是整个远控连不上。因此：

- hello 里的 `deliveryProfile` 始终是"该 clientMode 的默认交付档位"，`helloMessageSchema` 的绑定校验保持不变；
- 实际档位由订阅请求（`v4ConversationSubscribeParamsSchema.deliveryProfile`）单独携带；
- 该字段**只在与 clientMode 默认推导不同时才发送**（`deliveryProfileParams`）。CLI 侧的参数 schema 是 strict 的，旧 CLI 收到不认识的键会直接 parse 失败、整条订阅挂掉；而"与默认值相同"根本不需要传，CLI 自己就能推导出同一个值。这样旧 CLI 只会在一种情况下看到新字段——远控端显式声明 continuous，而远控连的是同一个 Host 管的本机 CLI，与 Host 同一次构建，不存在版本错配。

断点续传与 delivery profile 无关：resume / snapshot 由 `base.logEpoch` 与 `base.seq` 裁决，切换档位不影响续传语义。

窗口结构快照与 CLI 流式投递无关，不受 delivery profile 影响。

## 明确不做

- 不做多窗口之间的 tab 合并或跨窗口 tab 镜像。
- 不改远控传输方式，不引入 relay、配对码或隧道。
- 不改 SSH/WSL/Docker 远程 workspace 的连接、重连与凭据语义。
- 不在 Host 侧重建远程 tab 的生命周期。远程 tab 的 `remoteSessionId` / `remoteTarget` 绑定仍由桌面端 `useRemoteWorkspaceHistory` 负责，Host 只镜像结果。
- 不把远端 tab 变成手机端可写：镜像端对远程 workspace 只读（`allowRemoteWorkspace={false}`），远程连接的建立、凭据与重连语义仍只在桌面端。
- 不通过 timeout 或整页 reload 掩盖同步竞态。

## 验收场景

1. 手机打开一个新目录：桌面侧栏出现该工作区行，手机侧栏的集合、顺序、激活态与桌面一致。
2. 手机新建目录并在其中对话：桌面出现该工作区，能看到对话内容，能接着说。
3. 桌面关闭一个工作区：手机侧栏同步消失。
4. 桌面拖拽调整工作区顺序：手机侧栏顺序同步。
5. 手机切换会话：桌面切到同一会话，标题栏与列表高亮一致。
6. 手机切换工作区：桌面切到同一工作区。
7. 桌面重启：手机自动重连并重新拿到全量快照。
8. 桌面端无响应：手机在命令回执超时后显示"桌面端无响应"提示，不静默无反应。
9. 两端同时使用：手机不再写 `settings.lastWorkspaceSession` / `recentProjects`，桌面重启后恢复的是桌面自己的窗口状态。
10. 语言、主题、字号在手机刷新后与桌面一致，不出现"桌面中文、手机英文"。
11. 手机刷新页面后不会恢复到上一次的手机端本地 tab：窗口结构完全来自桌面快照。
12. 手机输入半句话后切回桌面：桌面输入框里是同一段文字；桌面继续输入，手机侧同步更新。
13. 手机打开一个已在其它桌面窗口打开的目录：桌面激活那个窗口，手机端提示"已在其它窗口打开"，不静默无反应。
14. 手机端与桌面端看到的流式细节一致：模型输出的 `output.text`、工具入参的 `inputText`、摘要的 `summaryText` 在手机侧同样逐段出现。
