# Spec: Web 页面即路径（URL 路由与会话深链）

## 目标

让 Web 版像普通网站一样：**停在哪个页面，地址栏就是哪个 URL，刷新后还停在那里**。手机远控和电脑浏览器共用同一套 `packages/web` 与 `Root`，因此同一套路由同时服务手机远控与普通 Web，不按设备分叉。

路由集合与「我在哪个页面」的状态所有者一一对应：

| URL                                          | 页面                                       |
| -------------------------------------------- | ------------------------------------------ |
| `/`                                          | 当前 workspace 的草稿态（没选中任何 task） |
| `/task/<taskId>`                             | 指定会话深链                               |
| `/automations`                               | 自动化主视图                               |
| `/automations/<automationId>`                | 自动化详情                                 |
| `/automations?tab=scheduled\|idle\|workflow` | 自动化的子标签                             |
| `/plugins`                                   | 插件商店列表                               |
| `/plugins/<pluginId>`                        | 插件商店详情                               |
| `/settings`                                  | 设置默认分区                               |
| `/settings/<section>`                        | 指定设置分区                               |
| `/settings/usage?tab=app\|codingPlan\|codingPlan:<sourceId>` | Usage 子标签                 |
| `/settings/plugin?tab=plugins\|mcps\|skills\|external`      | 插件能力子标签                 |
| `/settings/modelProvider?provider=<id>`                        | 指定模型供应商                 |
| `/files`                                     | 文件主视图                                 |
| `/bots`                                      | Bot 主视图                                 |
| `/bots/<botId>`                              | 指定 Bot 对话                              |

不新增 Workspace 页面：workspace 从来不是独立页面，URL 里也不出现 workspace。

## 产品规则

- **workspace 不进 URL。** 一个 task 属于哪个 workspace 是它的固有属性，用户也不能把 task 搬到别的 workspace，所以 workspace 是「查出来的」而不是「用户填的」。`/task/<taskId>` 只带 taskId，冷启动时由 taskId 反查归属 workspace。文件主视图左栏下拉选中哪个工作区、右栏打开了哪些标签，同样不进 URL；`/files` 只表示停在文件这一档。
- **taskId 是 opaque 的。** 不为了 URL 可读性额外建标题到 ID 的 slug 索引：改名、重名会让 slug 失去唯一性，而 `sess_<uuid>` 这类 ID 已经能保证刷新和分享都对得上。导入类 task 另有 `*-import-<uuid>` 形态，同样按 opaque 处理。
- **task 路由的反查必须唯一，且必须按当前 runtime 的 provider 过滤。** tasks 表主键是 `(workspace_key, task_id)`，不是单列 `task_id`。反查命中 0 条（不存在/已删除）或多于 1 条（归属不唯一）都视为无效目标，**不猜 workspace**。provider 由 adapter 按当前 runtime 传入：Web 拿到 taskId 后立刻 `setActiveTaskId`，命中别的 provider 的历史行会让它停在一个当前 runtime 打不开的会话上。
- **反查出的 workspace identity 走行主键投影，不直接透传列值。** 复用 `resolveTaskIndexRowWorkspaceIdentity`：远端 workspace 的 identity 可能只存在于 `workspace_key`，`workspace_identity` 列也可能残留旧远端的值。返回与行主键不一致的 identity 会把实体投影到另一个远端。
- **URL 只是导航意图，不参与鉴权。** `remoteSessionId`、`clientMode`（`web-remote-replayable` / `desktop-continuous`）、attachment scope、可信投递语义仍由 Host/Server 决定，URL 不表达也不提升这些。
- **冷启动以地址栏为准。** 入口先解析 URL 再渲染 Root；深链解析失败时把地址栏改写回 `/` 并落到 workspace 首页，**停在打不开的 URL 上是不可接受的**。
- **连接重试不重新解析启动地址。** `initialWorkspace*` 和 `initialTaskId` 只在页面文档首次启动时解析并消费一次。WebSocket generation 切换只能替换 service target，不能重放旧 bootstrap、改写当前 task URL 或把 `/task/<id>` 降级为 `/`。
- **首帧不回写地址栏。** Root 的 `initialTaskId` 是在子组件挂载后才落到 store 的，若 UI 在首帧就写地址栏，合法深链会先被抹成 `/` 再 push 回去，白白多出一条历史记录。
- **反查期间不写中间态。** 深链要异步反查 workspace，这段窗口里应用状态还停在旧页面。若照常投影就会把旧会话 push 进 history。`useWebUrlSync` 用 `pendingTaskRoute` 把窗口投影成目标路由；一旦应用路由相对发起时发生变化（说明用户已导航到别处），投影立刻交回应用状态，不被 pending 挡住。
- **打不开的目标要把地址栏纠正回来。** 运行期深链解析失败时不新增 history 条目，用 `replaceState` 把地址栏改回真实视图；否则地址栏停在打不开的 URL 上，直到下一次状态变化才被覆盖。反查回调带请求序号，过期回调无权写应用状态。
- **深链可以指向任何 workspace。** 目标 workspace 没打开过时新建并激活它的 tab，不能只在已打开的 tab 里找。
- **Web 的前进/后退交给浏览器。** Web 下不注册应用内前进/后退快捷键，让浏览器原生行为触发 `popstate`；否则 `preventDefault` 会把浏览器后退吃掉。桌面端保持原样，仍走应用内 `TaskNavigationHistory`。
- **地址栏不携带凭据。** 手机首屏仍是 `/?token=<token>`；深链 path 本身不带凭据，鉴权继续走首屏 query 种下的 cookie——服务端 token 中间件在**文档请求**时就把 `?token=` 写成 HttpOnly cookie，之后 `/ws` 与 `/api/*` 走 cookie。因此导航时清空 query 是正确的，深链失效改写地址栏时也不必保留 token。
- **桌面端完全不受影响。** URL 路由只由 Web 入口打开，桌面 renderer 不注册 `popstate`、不写 `history`、不安装离开保护、不改快捷键归属。
- **设置子页是设置页状态的 URL 投影。** section、Usage tab、插件能力 tab 和 provider ID 仍由设置组件持有；`/settings` 继续表示设置默认入口，缺失或不可用的 section/tab/provider 回退到设置页实际选中的有效位置后用 `replaceState` 规范 URL。``plugins`、`mcp`、`skills` 等历史 section 继续通过现有迁移规则归一到当前有效分区；插件商店 scope、搜索内容、滚动位置和一次性 intent 不写入 URL。
- **插件详情只由 plugin ID 定位。** `/plugins/<pluginId>` 只恢复可见详情，不携带 Marketplace scope、return scope、过滤、搜索或滚动状态。目标在插件目录加载后仍不存在时回到列表并以 `replaceState` 写 `/plugins`。
- **离开保护只保护真实未保存编辑。** dirty 判定属于编辑组件或文件 buffer；共享 Web 守卫仅登记 dirty 读取器和异步确认函数，不保存或复制表单/文件内容。没有 dirty blocker 时导航立即通过；存在 dirty blocker 时浏览器返回/前进与应用内路由切换使用同一确认入口，取消则保留 UI、编辑内容和地址栏语义，确认后才运行导航动作。
- **浏览器历史取消必须回到离开前的 entry。** 每个 Web 管理的 history entry 带有模块私有的单调序号；`popstate` 先记住到达 entry 与当前 entry。拒绝离开时通过 `history.go(delta)` 返回原 entry，恢复期间抑制再次应用路由或 `pushState`，不以 `pushState`/`replaceState` 伪造一条新的历史记录。允许离开时直接应用已经到达的 entry，不重复 push。整页导航、地址栏手动输入与页面刷新/关闭由浏览器本身处理。
- **刷新/关闭提示使用原生 beforeunload。** Web 入口启用 URL sync 后，仅当存在 dirty blocker 时挂载 `beforeunload` 监听；监听器只设置 `preventDefault()` 与 `returnValue`，由浏览器决定是否显示原生提示。保存、放弃或编辑器卸载后注销 blocker，并在无 dirty blocker 时撤销监听。编辑视图须在 dirty 从 false/true 转换时通知守卫重算监听；Files 的隐藏保活 buffer 可恢复，切换主视图本身不登记整页 blocker，只在明确关闭或替换 buffer 时使用既有 dirty-close 确认。
- **确认并发导航按 blocker 去重。** 同一轮确认期间若用户发起了更新的离开目标，已确认且仍然注册的 blocker 不重复询问；守卫仍须检查尚未确认及后来新增的 dirty blocker，任一取消都不执行最新目标。
- **页面内部切换也是导航准入。** 设置 section/tab/provider、插件商店详情/列表、任务选择、自动化编辑/工作流详情返回等操作，必须在对应状态 owner 写入新位置前调用共享准入；被拒绝时不更新任何导航历史、workspace tab、URL 或页面状态。
- **无效深链延迟规范化。** 设置 section/tab/provider 与插件 ID 的有效性依赖页面数据时，页面 owner 加载并选出真实 fallback 后通知路由层，用 `replaceState` 纠正地址而不追加 history entry。普通 `/settings` 继续映射为默认设置入口，并在页面给出实际有效 section 后规范为该位置。
- **插件商店目标只有一个应用入口。** 路由同步直接向 App 发起插件商店导航，由 App 唯一派发插件打开 intent；URL 同步 hook 不再并行派发同一插件事件。
- **任务导航准入先于 history/store 写入。** Web 的任务、自动化、插件商店导航 hook 须将全部副作用封装在同一共享准入回调中，不能先 push `TaskNavigationHistory`、激活 workspace tab、改 active task 或 selection，再等待确认。
- **Provider URL 只在 provider 数据 ready 后校验。** 初始 provider ID 在 Provider 导航列表加载后恢复；目标缺失时选择组件既有默认有效 provider 并回报该 provider ID，不能把加载期间的空选择误作无效目标。
- **子路由状态直接由页面 owner 投影。** 设置位置回调在 section、Usage tab、插件能力 tab、provider selection 或目标归一化变化后更新当前完整设置 route；插件商店在详情打开、返回列表和无效目标 fallback 后回报 plugin ID。投影只写导航位置，不复制编辑数据、搜索或 scope。
- **应用内主视图入口先守卫再写入。** `onShowTasks`、设置/文件/Bot tab、automations 与 plugin-store 入口均须由调用方在执行任何 workspace/tab/history/store 更新前进行准入。仅作为原 view 子树内部的临时状态变化不属于离开导航。
- **工作流编辑离开保护只围绕真实草稿。** Saved Workflow detail 复用其 draft/baseline dirty 判定；确认通过其页面现有确认 UI 后才允许 breadcrumb 返回。若当前编辑区没有可复用的确认 UI，不新增平行弹窗；需复用共享产品确认组件。
- **路由状态变化触发 beforeunload 更新。** blocker 注册后 dirty 状态发生变化必须同步通知监听管理器；监听是否安装由所有当前有效 blocker 的 dirty 合取决定。
- **不重复确认已经通过的 blocker。** 一个 `runWebNavigation` 决策将允许的 blocker 记录为已确认，直到 action 执行、导航被取消或决策被取代；弹窗等待期间新注册 blocker 仍必须进入确认队列。
- **浏览器 history 身份不能由路由差值替代。** 当前 entry ID 和 target entry ID 是单调 push 的自有编号，但浏览器前进/后退跨度可能跨越未管理 entry 或多步。拒绝离开时只能在 target 与 origin 都是受管理 entry 且跨度可推断时调用 `history.go(delta)`；否则将原位置通过 `replaceState` 恢复，不伪造 entry。
- **设置内的 tab 切换保护编辑子视图。** 共享守卫只在该设置 section 中确实存在 dirty editor 时登记；退出详情、保存或放弃后 blocker 要及时变 clean/unmount。普通设置导航没有 blocker 时不弹确认。
- **插件商店详情切换本身视为可离开路由。** 插件详情内的列表返回与列表中打开另一个插件都须准入；被取消时不得改变 detailPluginId，也不得回调 URL 投影。
- **历史状态投影须由实际页面状态触发。** `stateRoute` 缺省 section/plugin ID 时不能总投影固定空 route；必须读取 Shell 透传的页面位置。在进入 `popstate` 目标期间抑制状态投影写成新 entry，页面 fallback 完成后规范化原 entry。
- **工作区或主视图卸载会解除对应阻止。** blocker 清理需在 React unmount 后重新评估 beforeunload；已允许离开的 action 执行期间不能把已确认 dirty 状态重新判脏阻塞。
- **设置页面导航参数是唯一事实源。** `initialNavigationPosition` 只应用到设置页首次挂载；后续浏览器回退通过受控导航意图更新 SettingsPage 当前 owner，然后由该 owner 回报实际落点。不能只更新 App 的 `webRoutePosition` 而不更新 SettingsPage 实际显示。
- **插件打开 intent 用于列表内跨页面动作，不用于同一 URL 目标重复通知。** App 开启商店时设置一次 intent；Shell 用 route position 初始化页面，冷启动 intent 与 URL 有冲突时 URL 优先，其它一次性 intent 只处理明确动作如添加市场。
- **浏览器未管理路径 popstate 不由 SPA 守卫接管。** `parseWebRoute` 返回 null 时只处理当前 popstate 造成的 entry 恢复语义；不把它传给应用路由，也不吞掉后续整页导航。
- **Beforeunload 的通知在编辑输入后同步完成。** blocker 读取器不应依赖延迟 effect 才更新 dirty 状态；可用稳定 ref，但 dirty 计算变化后应在同一 render commit 的 layout effect 或同步外部 store 通知监听器。
- **Files 工作台的离开确认必须表达可恢复性。** 若未保存 buffer 在隐藏时会由 FilesEditorStore 保留且能在保存/丢弃后继续编辑，切换到其他主视图本身不是数据丢失；只在离开会销毁/替换 buffer 的明确操作复用已有 dirty-close 流程。不得为常驻隐藏 surface 注册整页 blocker。

## 状态所有者与事件顺序

「我在哪个页面」由这些所有者共同决定，一个都不能新增副本：

| 维度                              | 状态所有者                                                      |
| --------------------------------- | --------------------------------------------------------------- |
| 任务 / 文件 / Bot / 设置          | `tabStore` 主视图投影（设置 / 文件 / Bot 身份、工作区 tab） |
| 哪个会话                          | `zcodeSessionStore` 每个 workspace 的 `activeTaskId`            |
| chat / automations / plugin-store | `App.tsx` 的局部 `useState workspaceMainView`（仅任务主视图下有效） |
| 设置 section / tab / provider      | `SettingsPage` 及对应受控设置子组件                             |
| 插件商店列表 / 详情 plugin ID      | `PluginStorePage`                                               |
| 编辑表单 dirty                     | 对应编辑视图的本地表单与 baseline                               |
| 文件内容 dirty                     | `FilesEditorStore` 的 buffer `text` / `savedText`                |

URL 路由是这些所有者的**投影**，不是另一个状态源。离开守卫只持有 blocker 注册表，不持有脏数据。文件工作台内部的下拉选中与打开标签不投影进 URL。应用内导航必须先经共享守卫准入，再调用既有状态所有者的导航动作；不允许等状态已改变、编辑视图卸载后才确认。对于 Web URL 导航，浏览器 `popstate` 是唯一应用入口；桌面不注册此协调器。.

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
用户请求切换会话 / 主视图 / 设置 / 插件详情
  └─ 共享 Web 离开守卫读取所有已登记 blocker 的 dirty 状态
        ├─ 无 dirty → 执行既有页面导航动作
        └─ 有 dirty → 共享确认 UI
              ├─ 取消 → 不执行动作，状态与地址栏不变
              └─ 确认 → 执行动作
  └─ tabStore / zcodeSessionStore / 页面局部状态更新
  └─ useWebUrlSync 重算 currentRoute
        └─ 目标 location 与当前 location 相同 → 不写
        └─ 否则给 history entry 写入序号并 history.pushState
```

运行期（浏览器前进/后退 → 应用）：

```
用户按浏览器后退或前进
  └─ 浏览器先移动到目标 history entry 并派发 popstate
  └─ 记录目标 entry 与离开前 entry，解析当前 location
  └─ parseWebRoute(location) ──null──▶ 非本模块页面，忽略并交还浏览器
        └─ 与 currentRoute 相同 → 更新已知 entry，不动视图
        └─ 不同 → 共享离开守卫
              ├─ 无 dirty → 直接 applyRoute(目标)，不 push history
              ├─ dirty + 取消 → history.go(離开前序号 - 目标序号)，恢复原 entry；期间忽略回放 popstate
              └─ dirty + 确认 → applyRoute(目标)，不 push history
                    ├─ settings → 打开 settings tab，再通过 settingsNavigation 意图恢复 section/tab/provider
                    ├─ files / bots → 打开对应主视图，再恢复 botId（files 不恢复内部文件 tab）
                    ├─ plugin-store → 打开插件商店，再恢复 pluginId 详情
                    ├─ automations → 收回 workspace tab → 切自动化视图
                    ├─ home → 收回 workspace tab → startDraft
                    └─ task → 收回 workspace tab → 切 chat
                          ├─ 就是当前会话 → 无需写入
                          └─ 否则 resolveTaskWorkspace（pending 投影挡住中间态写入）
                                ├─ 同 workspace → setActiveTaskId
                                ├─ 跨 workspace → ensureWorkspaceTab + activateTab → setActiveTaskId
                                ├─ 目标无效 → replaceState 回真实视图
                                └─ 解析期间用户已导航 → 丢弃过期回调
```

离开保护注册到准入与页面生命周期：

```
dirty 编辑组件 / 文件 store
  └─ blocker 注册 { isDirty, confirmLeave }
       ├─ beforeunload：至少一个 dirty → 浏览器原生确认
       └─ 应用内导航或 popstate：共享守卫按注册顺序确认 dirty blocker
            ├─ 任一取消 → 不执行目标动作；popstate 则 history.go 恢复原 entry
            └─ 全部确认 → 执行目标动作 / applyRoute
  └─ 保存 / 放弃 / unmount → blocker 注销或 dirty 变 false
```

冷启动首帧只应用**非 task、非 home** 的路由（automations / plugins / settings / files / bots）：这些是 UI 局部状态，没有任何既有 bootstrap 字段能承载，只能在首帧按 URL 初始化。task 由 Root 的 `initialTaskId` 负责落地（它在本 hook 之前就拿到了反查结果），home 本身就是初始状态，二者都跳过以避免重复应用。

**工作区 bootstrap 不得踩掉冷启动 URL。** App 里的 URL 同步 effect 先于 Root 的 `addTab` / `startDraft` 跑完时，会先 `openBotsTab`（或 settings/files 等），随后父级再激活 workspace tab，主视图被打回任务草稿，地址栏再被投影成 `/`——刷新 `/bots/<id>` 就会永远掉回新建任务页。`useWebUrlSync` 必须把冷启动目标挂成 pending：在应用状态与目标一致之前，地址栏不得被中间态写成 `/`，并且在被踩后重放 `applyRoute`，直到 Bot/设置/文件等主视图真正落地或用户已经主动切到别的非 home 页。

## 接口

- 纯路由模型：`packages/ui/src/lib/webRoute.ts`，导出 `WebRoute` 判别联合、`parseWebRoute(pathname, search)`、`buildWebRouteLocation(route)`、`webRouteEquals(left, right)`。设置子路由 ID 由 `settingsNavigation.ts` 校验/归一；URL 规范值为 `usage?tab=app|codingPlan|codingPlan:<sourceId>`、`plugin?tab=plugins|mcps|skills|external`、`modelProvider?provider=<providerId>`。不含 React、不含 store，可直接 `node:test` 覆盖。经 `packages/ui/package.json` 的 `"./web-route"` 导出给 Web 入口引用。
- Web 离开守卫：`packages/ui/src/lib/webNavigationGuard.ts` 提供 blocker 注册、脏状态检查、异步导航准入和 `beforeunload` 安装；`useWebUrlSync` 独占 History entry 管理与浏览器 `popstate` 仲裁。守卫只在 `isWebUrlSyncEnabled()` 为 true 时启用。
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
- 桌面端存在「设置 tab 激活但一个 workspace tab 都没有」的状态，此时 `Root` 渲染无项目退化设置页而不挂载 `App`，URL 同步随之缺席。Web 引导总会取 `server-info.workspaces[0]`，实际不会触发；该状态下的 URL 不同步本次不额外处理。有项目时设置是外壳主视图，不再盖覆盖层。
- 深链目标无效时（不存在、已删除、归属不唯一、provider 不匹配）只把地址栏改写回真实视图并记录告警，不弹 UI 提示。落地是 workspace 首页草稿态。
- 浏览器 `popstate` 不承载跨页面的整页加载语义：前进/后退到 `/share/**` 这类由整页分支处理的路径时，路由模块会忽略该事件（`parseWebRoute` 返回 null），不会接管成 SPA 导航。

## 验收场景

1. 在同一 Host 的浏览器打开 `/task/<真实 taskId>`：直接落到该会话；F5 刷新仍停在同一会话；地址栏保持 `/task/<id>`。
2. 侧栏切换会话：地址栏同步变化；浏览器后退/前进：视图跟着切回/切前，地址栏与视图一致；后退时 history 里不出现被反查窗口挤进来的中间条目。
3. 切到 Automations（含子标签与详情）、Plugin Store、Settings、Bot（含 `/bots/<id>`）：地址栏各自变化；刷新后仍停在该页，不得掉回 `/` 新建任务草稿。
4. 刷新 `/settings/<section>`、Usage tab、插件能力 tab、`/settings/modelProvider?provider=<id>` 和 `/plugins/<pluginId>`：有效目标恢复对应组件的实际选中状态；provider、source、section 或 plugin 不存在/不可用时落到对应页面的有效 fallback，并以 `replaceState` 纠正 URL。浏览器前进/后退同时恢复这些子页面位置。
5. 打开 `/task/不存在的 id`：冷启动时地址栏被改回 `/` 并落到 workspace 首页；运行期后退到无效深链时地址栏被 `replaceState` 纠正回真实视图。两者都不白屏、不抛未捕获异常，控制台有告警。
5. 深链指向一个当前没打开的 workspace：该 workspace 的 tab 被新建并激活，落到目标会话。
6. 桌面端启动、切会话、Cmd/Ctrl+[ / ] 行为与改动前完全一致（Electron 窗口内不出现 URL 变化）。
7. `/share/<code>`、`/cn/share/<code>`、`/share/callback?...` 行为与改动前一致。
8. 手机首屏 `http://<IP>:<端口>/?token=<token>` 仍能正常进入；导航后地址栏不再保留 `?token=`，但鉴权不中断（cookie 已由首屏文档请求种下）。
9. 在干净状态下，浏览器返回/前进和应用内切换不弹确认；在自动化、闲时任务、保存工作流详情或文件 buffer 有未保存更改时，取消离开后视图、内容和 URL 保持不变，确认后才应用目标；刷新/关闭仅在 dirty 时由浏览器原生提示。
10. 保存或放弃后 dirty blocker 注销；之后离开不再弹确认。桌面端不安装守卫。
11. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过（lint warning 数与改动前基线一致），新增的测试用例通过。
12. 在 `/task/A` 与 `/task/B` 间切换后触发 WebSocket 重连：地址栏和 UI 都保持重连前的 task；首次启动时使用过的 `initialTaskId` 不会再次覆盖当前导航。
