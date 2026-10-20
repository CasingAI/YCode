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

在既有局域网远控之上，增加一条**用户主动创建**的公网入口：用户点「创建公网链接」→ 选一个隧道 Provider → 桌面端拉起隧道子进程，把**同一个**远控服务端口暴露成公网 https 地址。

不依赖官方 relay、不做账号体系、不做配对码。隧道只做端口转发：token、鉴权、会话、附件调度全部复用既有远控服务，隧道进程不持有任何业务状态。

## 产品规则

### Provider 目录

用户创建公网链接时选择 Provider。Provider 是**并列的两项**，共享同一个 `cloudflared` 二进制、同一套进程生命周期、同一个服务接口；差别只有两处：命令行参数怎么拼、公网 URL 从哪来。

| Provider id | 名称 | 用户要准备什么 | 域名 | 定位 |
|---|---|---|---|---|
| `cloudflare-quick` | Cloudflare 临时隧道 | 什么都不用 | 随机 `*.trycloudflare.com`，**每次重建都变** | 临时应急通道 |
| `cloudflare-named` | Cloudflare 固定域名隧道 | 自己账号里预建好的隧道：tunnel token + 公网 hostname | **永久固定**，可收藏 | 自己的长期入口 |

- Provider 目录是**数据**（`PUBLIC_TUNNEL_PROVIDERS`），UI 直接读它渲染下拉；新增 Provider 只改这张表 + 加一个适配器，不动主流程。
- 两个 Provider 的凭据需求差异由目录里的 `requiresCredentials` 表达，UI 据此决定是否展开凭据输入区。

### 创建与关闭

- 只有远控处于 `running` 时才允许创建公网链接；未开启时按钮禁用并给出提示。理由：隧道转发的目标就是远控服务，远控没开时隧道没有意义。
- **同一时刻最多一个隧道进程**。`createPublicUrl` 幂等：已有 `running` 隧道时直接返回当前状态，不换地址、不换 Provider。
- 创建过程经过 `starting`：UI 转圈，直到拿到公网 URL（或失败）。
- 关闭公网链接立即生效：终止隧道子进程，公网地址随即不可达。**关闭远控、窗口销毁、App 退出都会连带终止隧道**——不能让用户关掉 App 后公网入口还活着。
- 隧道子进程意外退出（用户手动 kill、崩溃）时，公网状态回落为 `stopped`，由 Host 广播。

### 链接语义

- 公网链接 = `https://<公网域名>/?token=<现有远控 token>`，与局域网链接**共用同一个 token**。
- 因此 token 的作用域从"局域网"扩大到"公网"。UI 必须把它当敏感信息处理：复制按钮旁明确提示"等同于访问你电脑的凭据"。
- **Quick 的域名每次重建都会变**，链接**不落盘**、不承诺跨重启可用。UI 必须说明这一点，避免用户按"固定链接"的预期去收藏。
- **Named 的域名由用户自己保证固定**（域名在用户自己的 Cloudflare 账号里）。本方案**不把 tunnel token 落盘**（敏感凭据），用户每次开启远控后重新填一次 token 即可。

### 隧道目标

隧道一律指向 `http://127.0.0.1:<远控端口>`，不指向 `0.0.0.0`。远控服务绑的是全部网卡，隧道只把本机这一份服务经 HTTPS 暴露出去。

### Named Tunnel 的本地配置

Named Tunnel 的 hostname 绑定在 Cloudflare 账号的**远端** ingress 配置里，那里的 `service` 写死了端口，而远控端口是随机的。因此桌面端**本地生成** `config.yml` 与 `credentials.json`：

- tunnel token 是 base64 的 `{a: 账号ID, t: 隧道ID, s: 隧道密钥}`，直接解出 credentials 文件需要的三个字段；
- `config.yml` 写 `tunnel` / `credentials-file` / `ingress`，ingress 的 `service` 指向 `http://127.0.0.1:<本次实际端口>`，最后一条是 catch-all；
- **不写 `configVersion`**：写了它 cloudflared 以远端配置为准（端口就写死了），不写才用本地配置，端口随机才成立。

临时配置写在系统临时目录，隧道关闭时一并清理。

### 与远控状态的关系

公网状态是 `MobileRemoteControlStatus` 上的**一个增量字段**，不是独立状态轴：`public` 存在 ⟹ `state === "running"`。独立状态轴会产生"隧道 running 但服务 stopped"的非法组合。

## 状态所有者与事件顺序

```
UI（MobileRemoteControlDialog 的「公网链接」区块）
  └─ useMobileRemoteControl()  ── RPC ──▶ IMobileRemoteControlService (Host)
                                              │ 运行时状态的唯一所有者
                                              ├─ createPublicUrl({provider, token?, hostname?})
                                              │     1. 校验 state === "running"、provider 参数完整
                                              │     2. publish(public = {provider, state:"starting"})
                                              │     3. 解析 cloudflared 路径（缺失 → public = error）
                                              │     4. Named：写临时 credentials.json + config.yml
                                              │     5. spawn cloudflared，监听 stdout + stderr
                                              │     6. Quick：解析 https://<词>.trycloudflare.com
                                              │        Named：等 "Registered tunnel connection" 日志
                                              │     7. 成功 → publish(public = {provider, state:"running", url})
                                              │        失败/超时 → kill 子进程 → publish(public = error)
                                              ├─ closePublicUrl()
                                              │     1. 终止子进程（SIGTERM → 宽限 → SIGKILL）
                                              │     2. 清理 Named 临时目录
                                              │     3. publish(public = undefined)
                                              └─ stop() / suspend() / dispose()
                                                    → 经 closeListener() 连带终止隧道
```

- 不变式：`public` 存在 ⟹ `state === "running"`；同一时刻最多一个隧道进程。
- UI 不持有公网状态：全部经 `onDidChangeStatus` 事件回流。

## 接口

- 契约：`packages/services/src/mobile-remote-control/publicTunnel.ts` 定义 `PublicTunnelProviderId`、`PUBLIC_TUNNEL_PROVIDERS`、`PublicTunnelCreateParams`、`PublicTunnelStatus`，以及纯函数 `decodeTunnelToken()`、`buildTunnelConfig()`、`parseQuickTunnelUrl()`、`buildTunnelArgs()`。与 RPC 无关，可直接 `node:test` 覆盖。
- 服务：`IMobileRemoteControlService` 增加 `createPublicUrl(params)` 与 `closePublicUrl()`；`MobileRemoteControlStatus` 增加 `public?: PublicTunnelStatus`。
- 进程管理：`packages/desktop/src/host/publicTunnelProcess.ts`，负责 spawn、解析输出、终止子进程，Provider 分派只在这里发生。
- 二进制：`packages/desktop/scripts/prepare-cloudflared.mjs` 沿用 `prepare-cli-proxy.mjs` 的下载 + sha256 校验 + 解压 + macOS ad-hoc 签名 + `VERSION` 标记范式，产物在 `bundled-tools/<platform-key>/cloudflared/`；`electron-builder.config.js` 的 `extraResources` 收录，打包期缺资产即失败；运行时由 `desktopRuntimeEnv.ts` 的 `resolveBundledRuntimeToolBinaryPath` 解析。
- 落盘：`mobile-remote-control.json` **不新增字段**（schema 不动，避免版本升级与迁移逻辑）。公网链接不跨重启保留。

## 已知限制

- **Quick Tunnel 无 SLA**，且实测：网络中断 10–15 分钟后 Cloudflare 会删除该 quick tunnel 的服务端注册记录，域名**永久**失效，而 `cloudflared` 进程还在原地无限重试（"假在线"）。因此 Quick 只能定位成"临时应急通道"，不能承诺稳定。
- **Named Tunnel 需要用户自备 Cloudflare 资产**：账号、预创建隧道、DNS 记录、ingress hostname 都在用户那边，YCode 侧只收一个 token。它换来的是域名永久固定，代价是**不是零配置体验**。
- **公网可达性未验证**：`*.trycloudflare.com` 在部分网络环境（含中国大陆）的可达性需要真机实测。这是本方案最大的不确定项。
- **125 秒空闲断连**：Cloudflare 边缘的 Proxy Read Timeout 对两个 Provider 都成立，Named 同样会断。应用层心跳不在本次范围内（属于既有 `packages/rpc` 的独立议题）。
- **Cookie 缺 `Secure` 属性**：`packages/server/src/http.ts` 的 `setLiteTokenCookie` 未设 `Secure`。走 HTTPS 公网隧道时该属性应当补上；本次不改鉴权实现，仅在此登记为待办。
- **静态首页匿名可访问**：`isTokenProtectedPath` 只保护 `/ws` 与 `/api/*`。局域网场景可接受，公网暴露前应收紧；本次不改，仅登记为待办。

## 验收场景

13. 开启远控后，「公网链接」区块出现 Provider 下拉，默认选中「Cloudflare 临时隧道」，有「创建公网链接」按钮。
14. 远控未开启时，「创建公网链接」按钮禁用并提示先开启远控。
15. 选 Quick 点创建：按钮转圈，几秒内出现 `https://<随机词>.trycloudflare.com/?token=<token>` 与二维码；复制按钮能复制完整链接。
16. 选 Named 时展开两个输入框（tunnel token、hostname）；缺任一项点创建 → 明确报错，不启动隧道进程。
17. 选 Named 点创建（token 与 hostname 正确）：出现 `https://<hostname>/?token=<token>` 与二维码。
18. 点「关闭公网链接」：隧道进程终止，公网地址立即不可达，弹窗回到未创建状态。
19. 远控处于 running 时点「停止」：隧道进程一并终止，公网地址不可达。
20. 关闭窗口 / 退出 App：隧道进程一并终止（用 `ps` 确认无遗留 `cloudflared` 子进程）。
21. 隧道启动失败（cloudflared 缺失或参数错误）：弹窗显示明确错误，**不影响**远控本身仍然 running，局域网链接照常可用。
22. 已 running 时重复点创建：不换地址、不起第二个隧道进程。
23. `pnpm typecheck` 与 `pnpm lint` 通过；新增的 `node --test` 用例通过。
24. 真机：手机用蜂窝网络（非同一 Wi-Fi）打开公网链接，页面正常加载、任务列表与桌面一致；关闭公网链接后同一链接不可达。
