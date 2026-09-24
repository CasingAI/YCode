# Spec: Web 页面即路径（URL 路由与会话深链）

## 目标

让 Web 版像普通网站一样：**停在哪个页面，地址栏就是哪个 URL，刷新后还停在那里**。手机远控和电脑浏览器共用同一套 `packages/web` 与 `Root`，因此同一套路由同时服务手机远控与普通 Web，不按设备分叉。

路由集合与「我在哪个页面」的三个状态所有者一一对应：

| URL                                          | 页面                                       |
| -------------------------------------------- | ------------------------------------------ |
| `/`                                          | 当前 workspace 的草稿态（没选中任何 task） |
| `/task/<taskId>`                             | 指定会话深链                               |
| `/automations`                               | 自动化主视图                               |
| `/automations/<automationId>`                | 自动化详情                                 |
| `/automations?tab=scheduled\|idle\|workflow` | 自动化的子标签                             |
| `/plugins`                                   | 插件商店                                   |
| `/settings`                                  | 设置                                       |

不新增 Workspace 页面：workspace 从来不是独立页面，URL 里也不出现 workspace。

## 产品规则

- **workspace 不进 URL。** 一个 task 属于哪个 workspace 是它的固有属性，用户也不能把 task 搬到别的 workspace，所以 workspace 是「查出来的」而不是「用户填的」。`/task/<taskId>` 只带 taskId，冷启动时由 taskId 反查归属 workspace。
- **taskId 是 opaque 的。** 不为了 URL 可读性额外建标题到 ID 的 slug 索引：改名、重名会让 slug 失去唯一性，而 `sess_<uuid>` 这类 ID 已经能保证刷新和分享都对得上。导入类 task 另有 `*-import-<uuid>` 形态，同样按 opaque 处理。
- **task 路由的反查必须唯一，且必须按当前 runtime 的 provider 过滤。** tasks 表主键是 `(workspace_key, task_id)`，不是单列 `task_id`。反查命中 0 条（不存在/已删除）或多于 1 条（归属不唯一）都视为无效目标，**不猜 workspace**。provider 由 adapter 按当前 runtime 传入：Web 拿到 taskId 后立刻 `setActiveTaskId`，命中别的 provider 的历史行会让它停在一个当前 runtime 打不开的会话上。
- **反查出的 workspace identity 走行主键投影，不直接透传列值。** 复用 `resolveTaskIndexRowWorkspaceIdentity`：远端 workspace 的 identity 可能只存在于 `workspace_key`，`workspace_identity` 列也可能残留旧远端的值。返回与行主键不一致的 identity 会把实体投影到另一个远端。
- **URL 只是导航意图，不参与鉴权。** `remoteSessionId`、`clientMode`（`web-remote-replayable` / `desktop-continuous`）、attachment scope、可信投递语义仍由 Host/Server 决定，URL 不表达也不提升这些。
- **冷启动以地址栏为准。** 入口先解析 URL 再渲染 Root；深链解析失败时把地址栏改写回 `/` 并落到 workspace 首页，**停在打不开的 URL 上是不可接受的**。
- **首帧不回写地址栏。** Root 的 `initialTaskId` 是在子组件挂载后才落到 store 的，若 UI 在首帧就写地址栏，合法深链会先被抹成 `/` 再 push 回去，白白多出一条历史记录。
- **反查期间不写中间态。** 深链要异步反查 workspace，这段窗口里应用状态还停在旧页面。若照常投影就会把旧会话 push 进 history。`useWebUrlSync` 用 `pendingTaskRoute` 把窗口投影成目标路由；一旦应用路由相对发起时发生变化（说明用户已导航到别处），投影立刻交回应用状态，不被 pending 挡住。
- **打不开的目标要把地址栏纠正回来。** 运行期深链解析失败时不新增 history 条目，用 `replaceState` 把地址栏改回真实视图；否则地址栏停在打不开的 URL 上，直到下一次状态变化才被覆盖。反查回调带请求序号，过期回调无权写应用状态。
- **深链可以指向任何 workspace。** 目标 workspace 没打开过时新建并激活它的 tab，不能只在已打开的 tab 里找。
- **Web 的前进/后退交给浏览器。** Web 下不注册应用内前进/后退快捷键，让浏览器原生行为触发 `popstate`；否则 `preventDefault` 会把浏览器后退吃掉。桌面端保持原样，仍走应用内 `TaskNavigationHistory`。
- **地址栏不携带凭据。** 手机首屏仍是 `/?token=<token>`；深链 path 本身不带凭据，鉴权继续走首屏 query 种下的 cookie——服务端 token 中间件在**文档请求**时就把 `?token=` 写成 HttpOnly cookie，之后 `/ws` 与 `/api/*` 走 cookie。因此导航时清空 query 是正确的，深链失效改写地址栏时也不必保留 token。
- **桌面端完全不受影响。** URL 路由只由 Web 入口打开，桌面 renderer 不注册 `popstate`、不写 `history`、不改快捷键归属。

## 状态所有者与事件顺序

「我在哪个页面」由三个所有者共同决定，一个都不能新增副本：

| 维度                              | 状态所有者                                                      |
| --------------------------------- | --------------------------------------------------------------- |
| settings 还是 workspace           | `tabStore.activeTabId`（设置本身是一个 tab，`SETTINGS_TAB_ID`） |
| 哪个会话                          | `zcodeSessionStore` 每个 workspace 的 `activeTaskId`            |
| chat / automations / plugin-store | `App.tsx` 的局部 `useState workspaceMainView`                   |

URL 路由是这三个所有者的**投影**，不是第四个状态源。

冷启动（会话深链）：

```
浏览器打开 /task/<taskId>
  └─ main.tsx  isWebOAuthCallback?  ──是──▶ OAuth 回调分支（整页）
              isConversationSharePath? ─是──▶ 分享页分支（整页）
  └─ resolveWebBootstrap()  → wsUrl + server-info 的默认 workspace
  └─ connectViaWebSocket(wsUrl)
  └─ applyWebRoute()
        └─ parseWebRoute(pathname) → { kind:"task", taskId }
        └─ zcodeTaskService.resolveTaskWorkspace({ taskId })
              └─ TaskIndexRepo：WHERE task_id = ? AND deleted = 0 AND provider = ? LIMIT 2
        ├─ 命中 1 条 → bootstrap 覆盖为该 workspace 的 path/identity + initialTaskId
        └─ 未命中   → replaceState("/")，沿用 server-info 默认 workspace
  └─ setWebUrlSyncEnabled(true)
  └─ render <Root initialWorkspaceAbsPath / initialWorkspaceIdentity / initialTaskId>
        └─ useRootPlatformEffects：addTab → setActiveTaskId（既有接点，未改）
```

运行期（应用内导航 → 地址栏）：

```
用户在侧栏切换会话 / 切视图 / 开设置
  └─ tabStore 或 zcodeSessionStore 或 App 局部 state 变化
  └─ useWebUrlSync 重算 currentRoute
        └─ 目标 location 与当前 location 相同 → 不写
        └─ 否则 history.pushState
```

运行期（浏览器前进/后退 → 应用）：

```
用户按浏览器后退
  └─ popstate
  └─ parseWebRoute(location) ──null──▶ 非本模块页面，忽略
        └─ 与 currentRoute 相同 → 不动
        └─ 不同 → applyRoute()
              ├─ settings        → tabStore.openSettingsTab()
              ├─ plugin-store    → 收回 workspace tab → 打开插件商店
              ├─ automations     → 收回 workspace tab → 切自动化视图
              ├─ home            → 收回 workspace tab → startDraft
              └─ task            → 收回 workspace tab → 切 chat
                    ├─ 就是当前会话 → 无需写入
                    └─ 否则 resolveTaskWorkspace（pending 投影挡住中间态写入）
                          ├─ 同 workspace → setActiveTaskId
                          ├─ 跨 workspace → ensureWorkspaceTab + activateTab → setActiveTaskId
                          ├─ 目标无效   → replaceState 回真实视图
                          └─ 解析期间用户已导航 → 丢弃过期回调
```

冷启动首帧只应用**非 task、非 home** 的路由（automations / plugins / settings）：这三者是 UI 局部状态，没有任何既有 bootstrap 字段能承载，只能在首帧按 URL 初始化。task 由 Root 的 `initialTaskId` 负责落地（它在本 hook 之前就拿到了反查结果），home 本身就是初始状态，二者都跳过以避免重复应用。

## 接口

- 纯路由模型：`packages/ui/src/lib/webRoute.ts`，导出 `WebRoute` 判别联合、`parseWebRoute(pathname, search)`、`buildWebRouteLocation(route)`、`webRouteEquals(left, right)`。不含 React、不含 store，可直接 `node:test` 覆盖。经 `packages/ui/package.json` 的 `"./web-route"` 导出给 Web 入口引用。
- 能力开关：`packages/ui/src/lib/webUrlSyncControl.ts` 的 `setWebUrlSyncEnabled` / `isWebUrlSyncEnabled`，经 `"./web-url-sync-control"` 导出。与入口的 `setStreamClientId` 同为「入口设置一次、整棵 UI 读取」的进程内能力开关；桌面端永不打开。
- URL 同步：`packages/ui/src/app-shell/useWebUrlSync.ts`。订阅 tabStore 与 `workspaceMainView`/`activeTaskId`，返回 `enabled` 让 `App.tsx` 把前进/后退快捷键让给浏览器。
- 反查服务：`IZCodeTaskService.resolveTaskWorkspace({ taskId })`（`packages/services/src/session/zcodeTaskService.ts`），实现于 `zcodeTaskServiceAdapter.ts`（按当前 runtime 传 `GLM_PROVIDER`），委托 `TaskIndexRepo.resolveTaskWorkspace(taskId, provider)`。`packages/desktop/src/host/index.ts` 的 `createControllerRoutedTaskService` 是 Proxy 包装，未显式拦截的方法自动透传，无需改动。
- 入口接线：`packages/web/src/main.tsx` 的 `applyWebRoute`。

## 已有机制保留不动

- 服务端 SPA fallback（`packages/server/src/http.ts`）：未知非 API/WS 路径已经返回 `index.html`，`/task/**` 无需服务端改动即可命中页面。
- `/share`、`/cn/share` 与 `/share/callback`（`packages/web/src/share/conversationShareRoute.ts`）：分享页与 OAuth 回调在入口的 pathname 分流里优先级最高，不受新路由影响。
- `/api/*`、`/ws`、`/ws/host`、`/ws/remote/:id`（`http.ts`）：transport / service 路由，与页面 URL 无关。
- `TaskNavigationHistory` 数据结构与 `setActiveTaskId` 的入栈副作用：桌面端仍消费，Web 不消费但不删除。
- `buildAccessUrl`（`packages/services/src/mobile-remote-control/lanAccess.ts`）：手机首屏链接仍是 `/?token=<token>`，不携带深链目标。

## 负面边界

- 不引入 React Router / TanStack Router / wouter。实现就是 pathname 解析加 `pushState`。
- 不新增 Workspace 页面，workspace 不进 URL。
- 不做跨设备 active task 实时同步（桌面切会话不推 URL 到手机），这是独立能力，本次不含。
- 不改 remote workspace（SSH/WSL/Docker）与 `createWebPlatform().connectRemote` 的「不支持」实现。
- 不做可读 slug。
- 不改桌面端导航行为与快捷键归属。
- 不把 `taskNavHistory` 从 store 移除；Web 只是不再消费它。

## 已知限制

- 本检出没有 React 渲染测试基建（无 vitest/playwright，也没有包定义 `test` script），交互部分不承诺 E2E 覆盖。路由的解析/序列化/往返由 `node --test` 覆盖（`packages/ui/test/webRoute.test.ts`），反查的身份归一化、provider 过滤、软删除与归属歧义由 `packages/services/test/taskIndexResolveWorkspace.test.ts` 覆盖；`popstate` 应用、反查窗口与快捷键让位靠下面的手动验收场景验证。
- 桌面端存在「设置 tab 激活但一个 workspace tab 都没有」的状态，此时 `Root` 直接渲染 `SettingsPage` 而不挂载 `App`，URL 同步随之缺席。Web 引导总会取 `server-info.workspaces[0]`，实际不会触发；该状态下的 URL 不同步本次不额外处理。
- 深链目标无效时（不存在、已删除、归属不唯一、provider 不匹配）只把地址栏改写回真实视图并记录告警，不弹 UI 提示。落地是 workspace 首页草稿态。
- 浏览器 `popstate` 不承载跨页面的整页加载语义：前进/后退到 `/share/**` 这类由整页分支处理的路径时，路由模块会忽略该事件（`parseWebRoute` 返回 null），不会接管成 SPA 导航。

## 验收场景

1. 在同一 Host 的浏览器打开 `/task/<真实 taskId>`：直接落到该会话；F5 刷新仍停在同一会话；地址栏保持 `/task/<id>`。
2. 侧栏切换会话：地址栏同步变化；浏览器后退/前进：视图跟着切回/切前，地址栏与视图一致；后退时 history 里不出现被反查窗口挤进来的中间条目。
3. 切到 Automations（含子标签与详情）、Plugin Store、Settings：地址栏各自变化；刷新后仍停在该页。
4. 打开 `/task/不存在的 id`：冷启动时地址栏被改回 `/` 并落到 workspace 首页；运行期后退到无效深链时地址栏被 `replaceState` 纠正回真实视图。两者都不白屏、不抛未捕获异常，控制台有告警。
5. 深链指向一个当前没打开的 workspace：该 workspace 的 tab 被新建并激活，落到目标会话。
6. 桌面端启动、切会话、Cmd/Ctrl+[ / ] 行为与改动前完全一致（Electron 窗口内不出现 URL 变化）。
7. `/share/<code>`、`/cn/share/<code>`、`/share/callback?...` 行为与改动前一致。
8. 手机首屏 `http://<IP>:<端口>/?token=<token>` 仍能正常进入；导航后地址栏不再保留 `?token=`，但鉴权不中断（cookie 已由首屏文档请求种下）。
9. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过（lint warning 数与改动前基线一致），新增的 `node --test` 用例通过。
