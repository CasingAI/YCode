# Web 端资源管理器

## 产品规则

- 资源管理器是**宿主能力**：宿主进程负责采样整机指标与自身进程树，客户端只负责呈现。宿主不提供采样能力时，客户端不渲染入口，避免出现点了没有反应的菜单项。
- 入口可达性按宿主能力判定，不按客户端类型判定，与「存储管理」入口同一条规则（见 `web-storage-management.md`）：Desktop、独立 Web 与手机远控连的是同一个宿主，宿主有采样能力就该能看到入口。
- Desktop 保持现状：入口打开独立 Electron 窗口（`DesktopCommandIds.OpenResourceManager`），窗口与指标口径不变。
- 独立 Web 打开独立浏览器窗口（`/resource-manager` 路由），复用同一份 `ResourceManagerApp` UI，不新写一套界面。
- Web 端数据口径：整机 CPU 与内存取自**宿主所在机器**；「YCode 进程」= 宿主进程树（Server 进程、CLI Agent、插件与 MCP 子进程），沿用桌面的分组口径（基础服务 / 内置插件 / 社区插件）与来源会话标注。
- 磁盘 I/O 页按宿主能力展示：未提供磁盘遥测接口时不显示该页签，也不显示「资源管理器接口不可用」红色故障或伪造数据。窄屏使用「概览优先」布局，见 resource-manager-responsive.md。本轮不把桌面 Electron 侧的磁盘遥测搬到 Server，也不为 Web 新造一套磁盘采样口径。
- 不新增 Agent、Local Host 或远程会话；Web 通过现有 WS/RPC 读取宿主快照，不让浏览器自己读本机进程表。

## 所有权与接口

```text
Web 资源管理器窗口 ── WS/RPC getSnapshot ── Server 唯一 ResourceUsageService
                                                        │
                                        createProcessResourceSampler（整机进程表）
                                        attributeHostProcessTree（归属 + 会话）
                                        os.cpus()/os.totalmem（系统指标）
```

- **唯一 owner：** 宿主进程内的 `ResourceUsageService`（`packages/services/src/process/resourceUsage`）。它持有系统 CPU 的差分基线与采样器；客户端只发请求，不缓存第二份快照，也不在浏览器里读进程表。
- **RPC 契约：** `IResourceUsageService.getSnapshot(): Promise<ResourceUsageSnapshot>`，通道名 `ServiceChannels.ResourceUsage`。返回结构复用 `packages/shared` 既有的 `ResourceUsageSnapshot`，不另立一套快照类型。
- **平台桥：** `IPlatformService.openResourceManager?()`，方法存在即表示当前宿主提供资源管理器。Desktop 实现转发现有桌面命令；Web 实现在宿主提供采样服务时才挂载。
- **采样归属：** 进程树根是宿主进程自身；CLI Agent 与其插件、MCP、工具子进程沿用 `attributeHostProcessTree` 的归属与会话继承规则，Web 与桌面用同一套归属实现，不复制一份。
- Desktop 的 Electron 进程指标（`app.getAppMetrics`）留在 Main 侧，不下沉到 Server；Web 端因此不显示 Chromium 进程行。

## 时序与恢复

```text
窗口打开 → 首次 getSnapshot → 按刷新间隔串行轮询 → 卸载即停
采样失败 → 快照缺失或保留上一帧 → 页面显示错误文案 → 下一轮重试
```

- 轮询串行：上一轮未返回时不叠加新请求，与桌面窗口的节奏一致。
- 系统 CPU 为两次采样差分，首轮无基线时返回 0，不伪造峰值。
- 快照是完整替换语义：客户端拿到新快照即整体覆盖，不做增量拼接，因此断线重连后不需要修补间隙。
- 宿主进程退出或服务未注册时，入口不渲染；窗口直接访问 `/resource-manager` 时显示不可用说明，不静默空白。

## 验收与测试

1. 宿主提供采样服务时，Web 端底栏「更多」菜单与帮助菜单出现资源管理器入口，点击打开 `/resource-manager` 独立窗口。
2. 独立窗口的 CPU 与内存页展示整机指标、宿主进程树分组与来源会话标注；刷新间隔选择器沿用现有控件。
3. 宿主未提供采样服务时，入口不渲染，不出现点击无反应的菜单项。
4. 没有磁盘遥测接口时不显示磁盘 I/O 页签，初始指定该页签时回退到 CPU，不显示伪造数据或整页故障。
5. Desktop 的资源管理器窗口、指标口径与菜单入口不变。
6. 服务单测覆盖：宿主进程自身计入进程树、进程行归属分组、系统内存口径、采样失败时的降级返回。

验证必须执行相关自动化测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。未经明确授权不使用 UI 自动化、CDP 或调试协议操作 YCode；未执行的 GUI E2E 如实记录，不记作通过。

## 连接与 UI 收口（接线实现）

- `createLocalServices` 装配 `ResourceUsageService`，进程树根默认取 `process.pid`；Agent 服务通过惰性 getter 注入，避免装配期的循环依赖。
- 客户端 `RemoteServiceAccess` 暴露 `resourceUsageService`；Web 的 `WebApp` 把它适配成平台桥，宿主没有该服务时桥为 `undefined`。
- Web 的 `/resource-manager` 是独立页面：单独建立 WS 连接、只渲染 `ResourceManagerApp`，不启动 workspace shell，避免为一个只读面板拉起整套应用状态。
- 桌面菜单与帮助菜单统一走 `platform.openResourceManager`，不再各自判断客户端类型；桌面的实现仍然是既有桌面命令。
