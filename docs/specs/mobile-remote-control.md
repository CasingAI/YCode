# Spec: 桌面端远程控制（Host 局域网直连）

## 目标

让手机或电脑上的浏览器通过局域网直连桌面 App，看到**与桌面同一个工作区、同一个会话**，不依赖任何官方 relay、配对码或隧道。

实现方式是复用仓库既有的"换一种 transport 暴露同一套服务"能力：桌面 Host 已经在用 `MessagePortProtocol` 把服务暴露给 renderer（`packages/desktop/src/host/index.ts` 的 `exposeServicesOnMessagePort`），本次在 Host 进程内再起一个局域网 HTTP + WebSocket 前端，用 `SocketProtocol` 把**同一份** `activeServices` 暴露给手机或电脑上的浏览器，`clientMode` 取 `web-remote-replayable`。

范围限定为**窗口级**：一个桌面窗口一个远控服务，随窗口销毁而停止。不做"桌面关闭后仍可远控"，不做多窗口共享。

## 产品规则

- 入口位于工作区左栏底栏「更多」菜单的第一项；仅在当前 attachment 提供 `mobileRemoteControlService` 时渲染，因此 Web 端与远程 workspace 上不出现这一项（「更多」格子仍在）。细则见 `workspace-shell-chrome-more.md`。
- 「更多」触发器表达"已启用"：`status.enabled` 为 true 时变橙色。这是侧边栏里唯一的远控状态信号，不再使用独立手机图标。
- 浏览器 / Web 端必须能收起并重新展开侧栏：侧栏切换入口在所有环境存在。桌面与网页都由顶部浮层承担（Windows/Linux 桌面用 logo 代替图标）。网页版（`isDesktop=false`）**收起时也不把入口搬进各视图顶栏**——入口换家会换坐标系，展开时整组从指针底下挪走。收起时浮层留在左上，顶栏只留等宽空槽。入口落点与窗口宽度无关；侧栏**用什么形态呈现**才是宽度相关的（窄视口是覆盖式抽屉、宽视口是内联列），细则见 `workspace-shell-responsive-layout.md`。侧栏自身不带折叠控件，这个入口是唯一的折叠/展开开关；窄视口下浮层压在抽屉之上，按钮因此始终可点。
- 侧栏切换、新建任务、更新状态三个入口共用同一份按钮实现（`app-shell/DesktopTopBarActions.tsx`），只由顶部浮层渲染，不在 Header / 面包屑再做第二份。不再渲染任务前进/后退按钮：远端浏览器窗口窄，这两个按钮与主操作拥挤，任务切换由侧栏任务列表和快捷键承担。
- 网页版侧栏收起时入口的落点仍与各视图既有 header 对齐，不另立新 header；顶栏左侧留空槽，标题被推开，不和浮层按钮叠在一起。侧栏切换按钮的屏幕坐标不随显隐变化（行高 48px、左边距 12px、垂直居中），细则见 `workspace-shell-responsive-layout.md`：
  - Chat 视图渲染 `WorkspaceHeader`，收起时主行左侧留空槽（已有任务的视图本来就有这条 header；网页版草稿态本身没有 header，只在这个状态下才补上它来对齐落点，侧栏展开时保持"无 header"的原观感）；
  - automations / plugin-store 参考桌面客户端的 `h-12` 面包屑带（`AutomationsMainBreadcrumbFrame`），网页版也常驻同一条带子，并在左侧固定预留入口落点（按入口组最大宽度算：三个 28px 图标 + 两个 4px 间距）；收起、展开槽位都在，带子宽度一致。
  - 同一时刻只有一份可点入口：真实按钮只在浮层。
  - 桌面 Electron 的浮层与窗口 chrome 不受影响。
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
- 弹窗是「标题 / 可滚动内容 / 操作区」三行：标题与操作区固定，只有中间内容滚动，高度封顶 `100dvh - 2rem`。操作区里「重置 Token」与「开启/停止」同处一行两端对齐，重置的后果说明单独占一整行放在按钮下面——说明文字不与按钮挤在同一行 flex 里，避免被压成窄列、折成多行后与按钮错位。链接带 token，必须完整可见，不允许横向截断。

## 状态所有者与事件顺序

```
UI（底栏「更多」菜单项 / MobileRemoteControlDialog）
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

1. 桌面 App 左栏底栏点「更多」：菜单第一项为远程控制；进入 Web 端或远程 workspace 时该项不出现，「更多」格子仍在。
2. 点击该项 → 弹窗显示开关；开启后展示 `http://<局域网IP>:<端口>/?token=<token>` 与二维码，并有复制按钮；已连接设备数初始为 0；此后「更多」触发器变为橙色。
3. 远端设备（手机或电脑）与桌面同一 Wi-Fi/局域网，扫码或直接打开链接：页面正常加载，展示与桌面相同的工作区与任务列表；在桌面新建/切换任务，远端可见；远端发一条消息，桌面能看到"另一台设备正在发送消息"。
4. 不扫码、直接访问无 token 的 `http://<IP>:<端口>/ws` 或 `/api/server-info` → 401；访问 `http://<IP>:<端口>/?token=<token>` 后 cookie 生效，后续请求正常。
5. 开启状态下关闭窗口再重新打开 App：远控自动恢复监听，端口与 token 与关闭前一致（原链接直接可用，无需重新扫码），入口图标直接是橙色。
6. 点"停止"：链接立即失效（原端口不再可达），远端刷新连不上；再次"开启"仍是同一个端口与同一个 token（同一个链接）。
7. 点"重置 Token"：运行中时新链接与新二维码立即生效，旧链接返回 401、需要重新扫码；未运行时重置后下次开启使用新 token。
8. 未构建 web 产物时开启远控（含重启自动恢复）：弹窗显示明确的构建提示，App 不崩溃，入口仍表示"已启用"以便重试。
9. 网页版顶部入口跟随侧栏状态：**侧栏展开时（无论窗口多宽）**入口留在左上浮层原位、与桌面观感一致，Chat 不出现第二层带子；点浮层里的切换按钮收起侧栏后，入口移到当前视图自己的顶部区域（Chat 是与标题同行的左侧、automations/plugin-store 是与客户端同款 h-12 面包屑带左侧预留的槽位），按钮之间及与标题之间留有正常间距、不叠放，浮层同时消失；再次点该按钮可在原位置重新展开侧栏并恢复浮层——切换按钮的屏幕坐标在两次点击之间不跳。automations / plugin-store 的带子在网页版常驻（与客户端一致），收起/展开只改变槽位里有没有入口，内容与面包屑的位置不发生变化。窄视口下侧栏初始收起，入口直接落在当前视图的顶部区域；点它展开的是覆盖式抽屉，浮层同时回到原位以便再次点按，规则与上面一致。
10. 窄视口（≤768px）的侧栏与 Side Pane 形态：竖屏打开网页版，首屏是单列、会话列占满宽度、看不到侧栏；点浮层切换按钮后侧栏从左滑入覆盖并带遮罩，点遮罩收起；打开 Side Pane 时从右侧覆盖滑入、会话列宽度不变。跨 767px/769px 反复缩放时浏览器 guest 不重载。完整场景见 `workspace-shell-responsive-layout.md`。
11. `pnpm typecheck` 与 `pnpm lint` 通过；新增的 `node --test` 用例通过。
12. 首次扫码或打开带 token 的链接后关闭全部浏览器窗口，再访问同一 Host 的 `/`（不带 token）：无需重新扫码或重新打开链接，页面正常加载并建立 WebSocket；清除站点数据或点击"重置 Token"后按 `web-lite-token-auth.md` 的边界恢复。

# 附录：公网临时链接（隧道 Provider 可选）

## 目标

在既有局域网远控之上，增加一条**用户主动创建**的公网入口：用户点「创建公网链接」→ 选一个隧道 Provider → 桌面端把**同一个**远控服务端口暴露成公网 https 地址。

不依赖官方 relay、不做账号体系、不做配对码。隧道只做端口转发：token、鉴权、会话、附件调度全部复用既有远控服务，隧道不持有任何业务状态。

## 产品规则

### Provider 目录

用户创建公网链接时选择 Provider。Provider 是**并列的两项**，共享同一个服务接口与同一套生命周期语义（起、停、与远控同生共死）；差别在于"怎么把端口暴露出去"与"公网地址从哪来"。

| Provider id        | 名称                     | 用户要准备什么               | 域名                                         | 定位           |
| ------------------ | ------------------------ | ---------------------------- | -------------------------------------------- | -------------- |
| `cloudflare-quick` | Cloudflare 临时隧道      | 什么都不用                   | 随机 `*.trycloudflare.com`，**每次重建都变** | 临时应急通道   |
| `localtunnel`      | localtunnel 固定域名隧道 | 什么都不用（可填一个子域名） | `https://<子域名>.loca.lt`，**固定不变**     | 长期收藏的入口 |

- Provider 目录是**数据**（`PUBLIC_TUNNEL_PROVIDERS`），UI 直接读它渲染下拉；新增 Provider 只改这张表 + 加一个 launcher，不动主流程。
- 两个 Provider 的差异由目录里的 `requiresSubdomain`（是否需要子域名）与 `stableDomain`（域名是否固定）表达，UI 据此决定是否展开子域名输入区与说明文案。
- 两个 Provider 都**不要账号、不要 token、不要本机装任何东西**。这一档的取舍是：域名能不能固定、链路快不快，而不是要不要注册。

### localtunnel 的固定域名

`localtunnel` 是 MIT 开源、免注册的隧道服务：桌面端主动外连到它的服务器，服务器把公网流量原样转回本机端口（TCP 级中继），因此 HTTP 与 WebSocket 升级都天然透传。

- **子域名先到先得**：名字被别人占着时，服务端不会报错，而是**悄悄改分配一个随机名字**。因此桌面端拿到地址后必须比对，拿到的不是用户要的子域名就算失败并报错（"子域名已被占用"），不能把随机地址当固定域名交出去。
- **服务端长期保留名字**：隧道关闭后子域名仍可被再次占用（实测：客户端退出后约 1–2 分钟，同一子域名可重新拿回）。因此子域名必须**落盘**（`mobile-remote-control.json` 的 `publicSubdomain`），否则用户收藏的链接下次就变了。
- 子域名取值优先级：用户这次填的 > 上次落盘的 > 自动生成（`ycode-` + 8 位随机字符）。自动生成时去掉 `i/l/o/0/1` 这几个在二维码里容易认错的字符。
- 服务端地址有 `https://loca.lt` 与 `https://localtunnel.me` 两个候选，按顺序尝试；只有"连不上"才换下一个，"子域名被占"直接报错。

### 创建与关闭

- 只有远控处于 `running` 时才允许创建公网链接；未开启时按钮禁用并给出提示。理由：隧道转发的目标就是远控服务，远控没开时隧道没有意义。
- **同一时刻最多一个隧道**。`createPublicUrl` 幂等：已有 `running` 隧道时直接返回当前状态，不换地址、不换 Provider。
- 创建过程经过 `starting`：UI 转圈，直到拿到公网 URL（或失败）。
- 关闭公网链接立即生效：终止隧道，公网地址随即不可达。**关闭远控、窗口销毁、App 退出都会连带终止隧道**——不能让用户关掉 App 后公网入口还活着。
- `cloudflared` 子进程意外退出（用户手动 kill、崩溃）时，公网状态回落为 `stopped`，由 Host 广播。localtunnel 没有子进程：它的客户端会自己重连（服务端掐空闲连接时触发），因此连接短暂中断不改变公网状态，只记录日志。

### 链接语义

- 公网链接 = `https://<公网域名>/?token=<现有远控 token>`，与局域网链接**共用同一个 token**。
- 因此 token 的作用域从"局域网"扩大到"公网"。UI 必须把它当敏感信息处理：复制按钮旁明确提示"等同于访问你电脑的凭据"。
- **Quick 的域名每次重建都会变**，UI 必须说明这一点，避免用户按"固定链接"的预期去收藏。
- **localtunnel 的子域名固定**，且会落盘：关掉再开远控、乃至重启 App，公网地址都还是同一个（前提是这个名字没被别人抢走）。

### 隧道目标

隧道一律指向 `http://127.0.0.1:<远控端口>`（localtunnel 是直接连本机端口），不指向 `0.0.0.0`。远控服务绑的是全部网卡，隧道只把本机这一份服务经 HTTPS 暴露出去。

### 与远控状态的关系

公网状态是 `MobileRemoteControlStatus` 上的**一个增量字段**，不是独立状态轴：`public` 存在 ⟹ `state === "running"`。独立状态轴会产生"隧道 running 但服务 stopped"的非法组合。

## 状态所有者与事件顺序

```
UI（MobileRemoteControlDialog 的「公网链接」区块）
  └─ useMobileRemoteControl()  ── RPC ──▶ IMobileRemoteControlService (Host)
                                              │ 运行时状态的唯一所有者
                                              ├─ createPublicUrl({provider, subdomain?})
                                              │     1. 校验 state === "running"、provider 参数完整
                                              │     2. localtunnel：定子域名（用户填 > 落盘 > 生成）并落盘
                                              │     3. publish(public = {provider, state:"starting"})
                                              │     4. cloudflare-quick：解析 cloudflared 路径（缺失 → public = error）
                                              │     5. cloudflare-quick：spawn cloudflared，解析 stdout + stderr 里的
                                              │        https://<词>.trycloudflare.com
                                              │        localtunnel：连客户端，等 'url' 事件，再比对子域名
                                              │     6. 成功 → publish(public = {provider, state:"running", url})
                                              │        失败/超时 → 回收隧道 → publish(public = error)
                                              ├─ closePublicUrl()
                                              │     1. 终止隧道（cloudflared：SIGTERM → 宽限 → SIGKILL；
                                              │        localtunnel：关闭客户端，断开全部转发连接）
                                              │     2. publish(public = undefined)
                                              └─ stop() / suspend() / dispose()
                                                    → 经 closeListener() 连带终止隧道
```

- 不变式：`public` 存在 ⟹ `state === "running"`；同一时刻最多一个隧道。
- UI 不持有公网状态：全部经 `onDidChangeStatus` 事件回流。

## 接口

- 契约：`packages/services/src/mobile-remote-control/publicTunnel.ts` 定义 `PublicTunnelProviderId`、`PUBLIC_TUNNEL_PROVIDERS`、`PublicTunnelCreateParams`、`PublicTunnelStatus`，以及纯函数 `parseQuickTunnelUrl()`、`buildTunnelArgs()`、`normalizeLocaltunnelSubdomain()`、`generateLocaltunnelSubdomain()`、`buildLocaltunnelOptions()`、`isExpectedLocaltunnelUrl()`、`validatePublicTunnelParams()`。与 RPC、Electron 无关，可直接 `node:test` 覆盖。
- 服务：`IMobileRemoteControlService` 提供 `createPublicUrl(params)` 与 `closePublicUrl()`；`MobileRemoteControlStatus` 增加 `public?: PublicTunnelStatus`。
- 落盘：`MobileRemoteControlPersistedState` 增加 `publicSubdomain?`；`mobile-remote-control.json` 的 schema 升到 **version 2**，读时兼容 version 1（缺 `publicSubdomain` 等价于"还没定过子域名"），写时一律写 version 2。
- 桌面端：
  - `packages/desktop/src/host/publicTunnelTypes.ts`：`PublicTunnelHandle`、`PublicTunnelLogger`（两个 launcher 的公共形状）。
  - `packages/desktop/src/host/publicTunnelCloudflared.ts`：spawn cloudflared、解析输出、终止子进程。
  - `packages/desktop/src/host/publicTunnelLocaltunnel.ts`：起 localtunnel 客户端、等 `url` 事件、比对子域名、关闭客户端。
  - `packages/desktop/src/host/mobileRemoteControlPublicUrl.ts`：Provider 分派与生命周期（起、停、状态回报）。
  - `packages/desktop/src/host/mobileRemoteControlService.ts`：子域名的决定与落盘（落盘状态的唯一所有者在这里）。
- 二进制：`packages/desktop/scripts/prepare-cloudflared.mjs` 沿用 `prepare-cli-proxy.mjs` 的下载 + sha256 校验 + 解压 + macOS ad-hoc 签名 + `VERSION` 标记范式，产物在 `bundled-tools/<platform-key>/cloudflared/`；`electron-builder.config.js` 的 `extraResources` 收录，打包期缺资产即失败；运行时由 `desktopRuntimeEnv.ts` 的 `resolveBundledRuntimeToolBinaryPath` 解析。localtunnel 不需要任何本地二进制。
- **下载策略（cloudflared 与 CLI Proxy 共用一套实现）**：由 `packages/desktop/scripts/release-download.mjs` 统一承担，两个准备脚本不再各写一份下载逻辑。规则：①有代理环境变量（`http_proxy`/`https_proxy`/`HTTP_PROXY`/`HTTPS_PROXY`）时**强制走 curl**（Node 原生 fetch 不认代理变量）；②无代理变量时**先 curl 直连**（带重试与连接超时），curl 不可用或失败再回退 Node `fetch`（自带重试与退避）；③curl 的可选参数（`--retry-all-errors`/`--retry-delay`/`--connect-timeout`）按本机 curl 能力探测后再拼装，兼容精简版 curl；④全部通道失败时**抛中文错误并中断构建**，错误信息写明用过的通道与"直连 GitHub 被拒时设置代理环境变量"的处置办法，**不得以未捕获异常堆栈的形式失败**。依据：GitHub 直连在部分网络环境会被重置（实测 `ECONNRESET`/`UND_ERR_CONNECT_TIMEOUT`），单次无重试的 fetch 不足以判定"下载不到"。
- 依赖：`packages/desktop` 依赖 `localtunnel@2.0.2`（MIT）。它上游的 `axios@0.21.4` 有已知 CVE，根 `pnpm.overrides` 统一顶到 `^1.13.6`（与该客户端的用法兼容，已实测）。
- 心跳：`packages/rpc` 的 `SocketProtocol.sendKeepAlive()` 发零负载 KeepAlive 帧；`packages/client` 的 WebSocket 连接在握手完成后每 20 秒发一次。对端 `SocketProtocol` 会丢弃非 Regular 帧，`PersistentProtocol` 已识别 KeepAlive，两端都不需要额外改动。

## 已知限制

- **Quick Tunnel 无 SLA**，且实测：网络中断 10–15 分钟后 Cloudflare 会删除该 quick tunnel 的服务端注册记录，域名**永久**失效，而 `cloudflared` 进程还在原地无限重试（"假在线"）。因此 Quick 只能定位成"临时应急通道"，不能承诺稳定。
- **localtunnel 无 SLA**：公益服务，没有可用性承诺。
- **localtunnel 的子域名是抢占式的**：名字在保留期内被抢走时，本次创建会明确失败（不会悄悄换成随机域名）；抢走后旧链接会指向别人的隧道，需要换一个子域名。
- **localtunnel 链路慢**：实测单请求 ttfb 约 3–4 秒、TLS 握手 2–5 秒，且服务端限 `max_conn_count = 2`——页面资源会排队加载，手机端首屏可能明显慢于局域网直连；偶发 502。
- **约 120 秒的空闲断连**：隧道服务端会掐掉长时间没有流量的连接。应用层心跳（20 秒一次）已能覆盖手机端在线时的情形；但手机切后台、页面被浏览器冻结时定时器会被挂起，心跳停摆，连接仍可能被掐断，此时手机回到前台需要刷新页面。
- **公网可达性未验证**：两个 Provider 的公网域名在部分网络环境（含中国大陆）的可达性需要真机实测。这是本方案最大的不确定项。
- **Cookie 缺 `Secure` 属性**：`packages/server/src/http.ts` 的 `setLiteTokenCookie` 未设 `Secure`。走 HTTPS 公网隧道时该属性应当补上；本次不改鉴权实现，仅在此登记为待办。
- **静态首页匿名可访问**：`isTokenProtectedPath` 只保护 `/ws` 与 `/api/*`。局域网场景可接受，公网暴露前应收紧；本次不改，仅登记为待办。

## 验收场景

13. 开启远控后，「公网链接」区块出现 Provider 下拉，默认选中「Cloudflare 临时隧道」，有「创建公网链接」按钮。
14. 远控未开启时，「创建公网链接」按钮禁用并提示先开启远控。
15. 选 Quick 点创建：按钮转圈，几秒内出现 `https://<随机词>.trycloudflare.com/?token=<token>` 与二维码；复制按钮能复制完整链接。
16. 下拉只有两项：Cloudflare 临时隧道、localtunnel 固定域名隧道；选 localtunnel 时展开「公网子域名」输入框。
17. 选 localtunnel、留空子域名点创建：出现 `https://ycode-<随机>.loca.lt/?token=<token>` 与二维码；子域名已落盘。
18. 选 localtunnel、填一个**已被占用**的子域名点创建：明确报错"子域名已被占用"，不给出随机地址。
19. 选 localtunnel、填非法子域名（如含大写或下划线）：本地直接拦下并提示，不发起创建。
20. 关掉公网链接再重新创建 localtunnel：子域名与链接与上次一致。
21. 点「关闭公网链接」：隧道终止，公网地址立即不可达，弹窗回到未创建状态。
22. 远控处于 running 时点「停止」：隧道一并终止，公网地址不可达。
23. 关闭窗口 / 退出 App：隧道一并终止（用 `ps` 确认无遗留 `cloudflared` 子进程）。
24. 隧道启动失败（cloudflared 缺失或参数错误）：弹窗显示明确错误，**不影响**远控本身仍然 running，局域网链接照常可用。
25. 已 running 时重复点创建：不换地址、不起第二个隧道。
26. `pnpm typecheck` 与 `pnpm lint` 通过；新增的 `node --test` 用例通过。
27. 真机：手机用蜂窝网络（非同一 Wi-Fi）打开公网链接，页面正常加载、任务列表与桌面一致；关闭公网链接后同一链接不可达。
