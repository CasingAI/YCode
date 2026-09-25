# 远程 Workspace 重连的导航连续性

## 目标

远程 workspace 重连只恢复连接和 workspace/session 事实，不把 transport 恢复解释为“重新进入 workspace”或“新建对话”。用户显式从历史打开 workspace 时可以导航，但异步重连结果不得覆盖用户在等待期间完成的会话、草稿或 tab 切换。

## 状态所有者

`packages/ui/src/root/useRemoteWorkspaceHistory.ts` 拥有远程 workspace 历史、重连状态和重连入口策略：

- 普通侧栏/自动重连使用 silent recovery；
- 历史记录显式打开使用 explicit navigation；
- 发起时捕获用户导航意图，完成时在唯一导航写入点前校验。

`reconnectRemoteWorkspaceHistoryEntry.ts` 只执行一次恢复事务：

```text
历史 session
  → 建立新 remote session
  → 规范化 workspacePath/workspaceIdentity
  → 校验 workspace 未被移除
  → bind path/identity 与 tab metadata
  → 按导航策略决定是否 activate
  → 持久化 connected
  → 刷新 pinned/timeline 列表
```

`tabStore` 与 `zcodeSessionStore` 继续拥有 active tab、active task 和草稿。helper 不新增导航状态副本。

## 产品规则

- 普通侧栏重连、共享 Host sibling 重连和仅恢复 transport 的路径不得调用 `activateTabByPath` 或 `onWorkspaceActivated`。
- 历史记录、显式打开 workspace 等用户明确要求打开目标的路径可以激活 workspace，并沿用当前显式打开后启动草稿的行为。
- 显式导航意图至少包含发起时的 `activeTabId`、workspace path/identity、active task id 和草稿 focus version。
- 恢复完成时任一导航字段变化都视为用户已经做出新选择：只恢复 session/tab metadata 和读取，不激活目标、不启动草稿。
- 恢复事务写入 tab metadata 时必须使用不改变 active tab/path/identity 的 ensure 写入；只有 intent guard 通过后，`activateTabByPath` 才能成为唯一的导航写入点。
- `shouldKeepReconnectedWorkspace` 继续判断目标 workspace 是否仍存在；导航 intent guard 只判断用户是否已经导航，两者不能互相替代。
- 校验与 `activateTabByPath` 必须相邻且同步执行，中间不得再插入 await。

## 事件顺序

### Silent recovery

```text
用户点击侧栏重连
  → capture reconnect request
  → connect/canonicalize/bind
  → upsert remoteSessionId
  → 写 connected history
  → 刷新 pinned/timeline
  → 当前 tab/task/draft 始终不变
```

### Explicit navigation

```text
用户从历史打开 workspace A
  → capture active tab/task/draft intent
  → connect/canonicalize/bind
  → intent 仍匹配
      → activate A
      → onWorkspaceActivated(A)
  → intent 已变化
      → 不激活、不启动草稿
  → 写 connected history并刷新读取
```

## 失败与取消

以下现有语义保持不变：

- workspace 在重连期间被移除时回收新 session，不重新加入 tab；
- connect、canonical path、identity bind 或持久化失败时写 `failed` history；
- 桌面侧栏重连继续 toast 后收敛为失败；
- 手机 Web RPC 重连可按调用方要求抛出失败；
- SSH sibling、pending request id 和 credentials override 语义不变；
- 失败不得触发 activate、startDraft 或回滚到重连前的 transient target。

## Delivery 边界

- Desktop 保持 `desktop-continuous`，本改动只修 renderer 导航副作用，不改变 Host/Agent 连续投递。
- 手机 Web 保持 `web-remote-replayable`，本改动不增加 ACK/replay，不把 remote session 恢复等同于 command replay。
- `workspaceIdentity?.trim() || workspacePath` 继续用于隔离；workspacePath 继续用于执行和展示。

## 明确不做

- 不改变用户主动新建对话、切换 task、打开 workspace 或删除 tab 的入口。
- 不通过 timeout、延迟激活或整页 reload 掩盖竞态。
- 不清空 tab/session store 来避免晚到写入。
- 不在 helper 内新增第二个 active task/draft 状态源。
- 不改变 remote command recovery、ACK 或 PendingCommandRegistry。

## 验收场景

1. 当前停在 task A 时从侧栏重连同一 remote workspace：连接恢复后仍停在 A，草稿和滚动状态不变。
2. 当前 workspace 没有 active task 时重连：不自动创建新对话。
3. 重连等待期间用户切到 task B、切换 tab 或点击新建：恢复完成后不回弹、不覆盖新选择。
4. 用户从历史显式打开 workspace，且等待期间没有导航：仍激活目标并进入草稿。
5. workspace 在等待期间被关闭：新 session 仍被回收，不重新加入 tab。
6. 重连失败仍写 failed history，并保持桌面 toast/手机 RPC 的现有差异。
