# Spec: 桌面端远程控制（Host 局域网直连）

## 目标

让手机或电脑上的浏览器通过局域网直连桌面 App，看到**与桌面同一个工作区、同一个会话**，不依赖任何官方 relay、配对码或隧道。

实现方式是复用仓库既有的"换一种 transport 暴露同一套服务"能力：桌面 Host 已经在用 `MessagePortProtocol` 把服务暴露给 renderer（`packages/desktop/src/host/index.ts` 的 `exposeServicesOnMessagePort`），本次在 Host 进程内再起一个局域网 HTTP + WebSocket 前端，用 `SocketProtocol` 把**同一份** `activeServices` 暴露给手机或电脑上的浏览器，`clientMode` 取 `web-remote-replayable`。

范围限定为**窗口级**：一个桌面窗口一个远控服务，随窗口销毁而停止。不做"桌面关闭后仍可远控"，不做多窗口共享。

## 产品规则

- 入口位于桌面侧边栏底部的设置按钮左侧；仅在当前 attachment 提供 `mobileRemoteControlService` 时渲染，因此 Web 端与远程 workspace 上不出现。
- 入口图标表达"已启用"：`status.enabled` 为 true 时变橙色。这是侧边栏里唯一的远控状态信号。
- 浏览器 / Web 端必须能收起并重新展开侧栏：侧栏切换入口在所有环境存在。桌面由顶部浮层承担（Windows/Linux 桌面用 logo 代替图标）；网页版（`isDesktop=false`）**侧栏展开时同样由浮层承担、与桌面同源，只有侧栏收起时才把入口移进各视图自己的顶部区域**。入口落点的判定只看侧栏是否收起，与窗口宽度无关；侧栏**用什么形态呈现**才是宽度相关的（窄视口是覆盖式抽屉、宽视口是内联列），细则见 `workspace-shell-responsive-layout.md`。侧栏自身不带折叠控件，这个入口是唯一的折叠/展开开关；窄视口下浮层压在抽屉之上，按钮因此始终可点。
- 侧栏切换、新建任务、更新状态三个入口共用同一份按钮实现（`app-shell/DesktopTopBarActions.tsx`），桌面浮层与网页版各顶部区域都从它渲染，不维护第二份。不再渲染任务前进/后退按钮：远端浏览器窗口窄，这两个按钮与主操作拥挤，任务切换由侧栏任务列表和快捷键承担。
- 网页版侧栏收起时入口的落点与各视图既有 header 对齐，不另立新 header；入口组自带 `gap` 与标题留出间距，不被标题或按钮相互挤压：
  - Chat 视图渲染 `WorkspaceHeader`，入口融在其主行左侧，与标题同处左区（已有任务的视图本来就有这条 header；网页版草稿态本身没有 header，只在这个状态下才补上它来承载入口，侧栏展开时保持"无 header"的原观感）；
  - automations / plugin-store 参考桌面客户端的 `h-12` 面包屑带（`AutomationsMainBreadcrumbFrame`），网页版也常驻同一条带子，并在左侧固定预留入口落点（按入口组最大宽度算：三个 28px 图标 + 两个 4px 间距）；侧栏收起时入口落进这个槽，侧栏展开时槽位留白，两种状态下带子宽度一致。
  - 同一时刻只存在一份入口：入口被移走时顶部浮层整组隐藏。
  - 桌面 Electron 的浮层与窗口 chrome 不受影响；网页版侧栏收起时 header 不再为浮层按钮预留左边距。
- 状态分两根轴：
  - `state` 是运行时状态，只有 `stopped` → `starting` → `running`，任意态可因失败进入 `error`；
  - `enabled` 是**用户意图**（落盘）。自动恢复失败时 `enabled` 仍为 true，失败原因由 `errorCode`/`error` 表达。
- 用户点击"开启"写入 `enabled: true`，只有点击"停止"才写回 `enabled: false`。窗口关闭不改变用户意图。
- App 重启后自动恢复：Host 初始化完成即调用 `resumeIfEnabled()`，沿用落盘的端口与 token 重新监听，远端链接因此不变。
- **端口固定**：首次开启选定并落盘，之后不再变化。固定端口被占用时（另一个 YCode 窗口、或别的程序）本次临时让位到空闲端口，但**不覆盖落盘值**——占用者释放后下次启动仍回到原端口。绑定失败且不是 `EADDRINUSE`（权限、地址不可用等）则如实报 `start-failed`。
- **Token 固定**：只有 `resetToken()` 会换 token。运行中换 token 必须按同端口重建监听（token 在建立监听时就绑定了），因此旧链接、旧 cookie 立即失效，已连接的设备被断开；未运行时只落盘，下次开启生效。
- 鉴权复用服务端既有的 lite token + cookie 机制：`?token=<token>` 首次访问种 cookie，其后 `/api/*` 与 `/ws` 走 cookie/查询参数校验；无 token 访问返回 401。Cookie 按共享 Web 鉴权规格保存一年，关闭浏览器后同一 origin 可继续使用；清除站点数据、Cookie 过期或重置 Token 仍需重新打开有效链接。共享规则见 `web-lite-token-auth.md`。
- 远控首屏链接只表达「连到哪个 Host」，不表达「打开哪个页面」：链接固定是 `/?token=<token>`，会话深链等页面路由见 `web-url-routing.md`。手机与电脑浏览器共用同一套 `packages/web` 页面路由，不按设备分叉。
- 远控通道自身不对远端暴露（否则远端可以关掉自己所在的开关）。
- 未构建 web 产物（`ZCODE_MOBILE_WEB_ROOT` 指向的目录不存在或缺少 `index.html`）时，`start()` 返回明确的构建提示错误，不崩溃、不监听端口。

## 状态所有者与事件顺序

```
UI（WorkspaceSidebarFooter 入口 / MobileRemoteControlDialog）
  └─ useMobileRemoteControl()  ── RPC ──▶ IMobileRemoteControlService (Host)
                                              │ 运行时状态的唯一所有者
                                              │ 落盘状态的唯一所有者（mobile-remote-control.json）
                                              ├─ 启动时 resumeIfEnabled(): enabled → start(窗口初始 workspace)
                                              ├─ start(): ensurePersistedLoaded
                                              │           → token = 落盘值 ?? 新建
                                              │           → 先试落盘端口，EADDRINUSE 才让位
                                              │           → createLanHttpServer(staticRoot=ZCODE_MOBILE_WEB_ROOT)
                                              │           → persist{enabled:true, port, token}
                                              ├─ onWebSocket(socket)
                                              │     → SocketProtocol + ChannelServer
                                              │     → exposeOnChannelServer(活跃服务, overrides,
                                              │           excludeChannelNames=[MobileRemoteControl])
                                              │     → connectedClients++ , 广播
                                              ├─ resetToken(): 换 token 落盘
                                              │     → 运行中：closeListener() + start(同端口)
                                              ├─ stop(): closeListener() + persist{enabled:false}（保留 port/token）
                                              └─ suspend(): closeListener()（保留 enabled，窗口销毁用）
```

- `IMobileRemoteControlService` 是运行时状态的**唯一状态所有者**，只在 Host 进程内注册一次；`mobile-remote-control.json` 是用户意图与固定端口/token 的**唯一持久化所有者**。
- UI 不持有状态：dialog 只渲染 hook 返回的快照，所有变更都必须经 `start`/`stop`/`resetToken` RPC 落到 Host。
- Host 侧窗口销毁走 `runtime.suspend()`，不走 `service.stop()`：后者会把用户意图写成关闭，App 下次启动就没有东西可恢复。
- 远端看到的状态由 Host 的 `activeServices` 决定，不由桌面 renderer 决定；两端共享同一份服务，因此任务列表、会话内容天然一致。

## 接口

- 服务：`packages/services/src/mobile-remote-control/mobileRemoteControl.ts` 定义 `MobileRemoteControlStatus`（含 `enabled`）、`MobileRemoteControlPersistedState` 与 `IMobileRemoteControlService`（`getStatus` / `start` / `stop` / `resetToken` / `onDidChangeStatus`），`createServiceDescriptor` 同名合并。
- 频道：`packages/shared/src/channels.ts` 的 `ServiceChannels.MobileRemoteControl`。
- 纯逻辑：`packages/services/src/mobile-remote-control/lanAccess.ts` 导出 `createAccessToken()`、`pickFreePort()`、`buildLanAccessView()`，与 RPC 无关，可直接 `node:test` 覆盖。
- 落盘：`packages/services/src/mobile-remote-control/mobileRemoteControlStateStore.ts`，默认文件 `{dataBaseDir}/.zcode/v2/mobile-remote-control.json`，内容 `{ version: 1, enabled, port?, token? }`；文件缺失或损坏等价于"从未开启"，写盘串行化 + 原子写。单独一个文件而不是塞进 `setting.json`：token 是可直接访问桌面 Host 的凭据，不该跟着会导出/迁移的通用配置走。
- 浏览器凭据：共享 HTTP 鉴权在首次验证时设置一年期 `zcode_lite_token` HttpOnly Cookie；Cookie 不是 Host 状态，也不进入 `mobile-remote-control.json`，具体期限、撤销和负面边界见 `web-lite-token-auth.md`。
- 复用点：`packages/services/src/collection.ts` 的 `exposeOnChannelServer` 新增 `excludeChannelNames` 选项；`packages/server/src/http.ts` 抽出 `createLanHttpServer`，`createHttpServer` 基于它实现，保证静态服务与鉴权只有一条实现路径。
- 产物根：Host 环境变量 `ZCODE_MOBILE_WEB_ROOT`，由 main 进程在启动 Host 时注入。解析顺序（`desktopRuntimeEnv.ts` 的 `resolveBundledMobileWebRoot`，命中即止）：打包态 `resources/mobile-web`；开发态按产物位置定位的 `<repo>/packages/web/dist`；cwd 兜底 `<cwd>/packages/web/dist` 与 `<cwd>/../web/dist`。都要求目录内有 `index.html`，否则不注入该变量，Host 在 `start()` 时报「未找到远程控制页面的 Web 产物」。开发态因此需要先执行一次 `pnpm --filter @zcode/web build`，且该变量在 main 启动时求值，构建后要重启 dev 才会生效。

## 已知限制

本检出**没有 E2E 基建**：没有 playwright/vitest 配置，没有任何包定义 `test` script，`packages/desktop` 也没有 e2e 目录。因此交互部分不承诺 E2E 覆盖，改由下面的手动验收场景覆盖，单测只覆盖可脱离 Electron 运行的纯逻辑、落盘状态机与 HTTP/WS 行为。

## 验收场景

1. 桌面 App 侧边栏底部：设置按钮左侧出现远程控制按钮；进入 Web 端或远程 workspace 时该按钮不出现。
2. 点击按钮 → 弹窗显示开关；开启后展示 `http://<局域网IP>:<端口>/?token=<token>` 与二维码，并有复制按钮；已连接设备数初始为 0；此后入口图标变为橙色。
3. 远端设备（手机或电脑）与桌面同一 Wi-Fi/局域网，扫码或直接打开链接：页面正常加载，展示与桌面相同的工作区与任务列表；在桌面新建/切换任务，远端可见；远端发一条消息，桌面能看到"另一台设备正在发送消息"。
4. 不扫码、直接访问无 token 的 `http://<IP>:<端口>/ws` 或 `/api/server-info` → 401；访问 `http://<IP>:<端口>/?token=<token>` 后 cookie 生效，后续请求正常。
5. 开启状态下关闭窗口再重新打开 App：远控自动恢复监听，端口与 token 与关闭前一致（原链接直接可用，无需重新扫码），入口图标直接是橙色。
6. 点"停止"：链接立即失效（原端口不再可达），远端刷新连不上；再次"开启"仍是同一个端口与同一个 token（同一个链接）。
7. 点"重置 Token"：运行中时新链接与新二维码立即生效，旧链接返回 401、需要重新扫码；未运行时重置后下次开启使用新 token。
8. 未构建 web 产物时开启远控（含重启自动恢复）：弹窗显示明确的构建提示，App 不崩溃，入口仍表示"已启用"以便重试。
9. 网页版顶部入口跟随侧栏状态：**侧栏展开时（无论窗口多宽）**入口留在左上浮层原位、与桌面观感一致，Chat 不出现第二层带子；点浮层里的切换按钮收起侧栏后，入口移到当前视图自己的顶部区域（Chat 是与标题同行的左侧、automations/plugin-store 是与客户端同款 h-12 面包屑带左侧预留的槽位），按钮之间及与标题之间留有正常间距、不叠放，浮层同时消失；再次点该按钮可在原位置重新展开侧栏并恢复浮层。automations / plugin-store 的带子在网页版常驻（与客户端一致），收起/展开只改变槽位里有没有入口，内容与面包屑的位置不发生变化。窄视口下侧栏初始收起，入口直接落在当前视图的顶部区域；点它展开的是覆盖式抽屉，浮层同时回到原位以便再次点按，规则与上面一致。
10. 窄视口（≤768px）的侧栏与 Side Pane 形态：竖屏打开网页版，首屏是单列、会话列占满宽度、看不到侧栏；点浮层切换按钮后侧栏从左滑入覆盖并带遮罩，点遮罩收起；打开 Side Pane 时从右侧覆盖滑入、会话列宽度不变。跨 767px/769px 反复缩放时浏览器 guest 不重载。完整场景见 `workspace-shell-responsive-layout.md`。
11. `pnpm typecheck` 与 `pnpm lint` 通过；新增的 `node --test` 用例通过。
12. 首次扫码或打开带 token 的链接后关闭全部浏览器窗口，再访问同一 Host 的 `/`（不带 token）：无需重新扫码或重新打开链接，页面正常加载并建立 WebSocket；清除站点数据或点击"重置 Token"后按 `web-lite-token-auth.md` 的边界恢复。
