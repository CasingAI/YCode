# 手机 Web 自动重连与页面连续性

## 目标

把当前 `/ws` 的一次性 WebSocket 连接改为可观察、可恢复的连接生命周期：已渲染 Root 后断线自动进入可见的重连状态，旧 ChannelClient 的挂起请求 fail-closed，新连接使用新的 service generation 重新建立读取和 projection。连接换代不得卸载 Root、重放首次启动 task、启动草稿或覆盖用户当前导航。

## 状态所有者

`packages/client` 的 WebSocket 连接管理器是 transport 唯一状态所有者，负责：

- 当前 socket、`ChannelClient` 和协议代际；
- `connecting`、`connected`、`reconnecting`、`closed` 状态；
- 有上限的退避计时器和单一在途连接尝试；
- `online`、`focus`、`visibilitychange` 触发的提前重试；
- 连接销毁和所有浏览器事件监听清理。

`ChannelClient` 仍负责协议请求生命周期。连接管理器在当前代际失效时调用 `dispose()`，让所有挂起 Promise 以 `ConnectionClosed` 结束。

`packages/web` 的连接适配层是 UI service 边界，负责：

- 在页面生命周期内保持一个稳定的 `IServiceAccessor` facade；
- 原子切换当前 `RemoteServiceAccess` target；
- 断线期间让新调用 fail-closed；
- 将普通事件和动态事件订阅迁移到新 target，并释放旧 target 订阅；
- 拒绝旧 generation 的迟到结果影响当前 target。

`packages/ui` 的 Root、tab store、session store 和 URL sync 继续拥有页面状态。`SessionDataLayer`、`ConversationProjectionStore` 和 `SessionPane` 不新增 WebSocket 重连分支。

## 事件顺序

```text
socket open
  → ChannelClient Initialize ready
  → 发布 connected 和新 service generation
  → 创建稳定 service facade
  → Root 首次挂载并消费一次 URL bootstrap

当前 socket close/error
  → 旧代际失效
  → 发布 reconnecting
  → facade 清空当前 target，新调用 fail-closed
  → dispose 旧 ChannelClient 和底层事件订阅
  → 保留当前 Root、URL、active task、draft 和 timeline
  → 按退避创建唯一新 socket

新 socket open + Initialize ready
  → 创建新的 RemoteServiceAccess
  → generation + 1
  → 发布 connected
  → facade 原子切换 target，并在新 target 重建事件订阅
  → 必要读取和 projection 自行恢复
  → 不重新消费 initialWorkspace/initialTaskId，不启动草稿
```

close 与 error 可能连续到达，必须由 socket generation/settled 标记去重；旧 socket 的迟到事件不得影响新连接。

## Service attachment 端口与 V4 换代

稳定 facade 不能被当成服务器 attachment。Web 连接适配层为每个 facade service 暴露一个仅存在于 renderer 进程内的 connection port：

- port 的当前 attachment 是该 generation 的底层 `RemoteServiceAccess` service 对象；断线时为 `null`；
- port 订阅只通知“新的非空 attachment 已就绪”，不把断线事件伪装成 runtime 或 workspace 事件；
- port 不序列化、不进入 RPC，也不改变 wire protocol。

V4 握手缓存必须以当前 attachment 身份为键，而不是以稳定 service proxy 为键。attachment 换代后，旧 Promise 只能完成旧代调用或被连接代际拒绝，不能让新代复用 `handshakeComplete`；新代第一次业务 RPC 必须重新执行 `helloConversationV4` 与 `initializeConversationV4`。

attachment 重新就绪还必须使 conversation、sessions-index 和其他 V4 transport 的本地 ownership 失效：清空旧 subscription/decoder/恢复 flight，保持页面层与 store 身份不变，再由各 transport owner 发起新的订阅。不得把旧 attachment 的订阅、ACK 或 command 自动转发到新 attachment。transport replacement 事件不等同于 CLI runtime restart，也不改变 `desktop-continuous` 与 `web-remote-replayable` 的 delivery profile。target 切换时必须先使旧 transport ownership 失效，再迁移普通或动态事件订阅；新 attachment 的 registrar 即使同步推送初始帧，也不得让该帧进入旧 decoder 或旧 subscription。通知期间新建的订阅由 `subscribe()` 自行绑定，不得在迁移段被再绑一次；通知回调里重入 `setTarget` 只保留最后一次换代并在当前切换完成后应用；单个通知回调或上游 `dispose` 抛错不得中断其余订阅迁移。

## 重试规则

- 首次连接未 ready 就失败：拒绝 managed connection 的初始 Promise，由现有 `WebBootstrapErrorScreen` 展示。
- 已建立 Root 后：使用 `0、1、2、5、10、30 秒` 退避，30 秒为上限并持续重试。连接只有在完成 Initialize 后持续稳定达到 30 秒，才重置失败计数；刚握手就断开的连接必须继续推进退避，不能形成 0 秒热循环。
- 手动重试、`online`、重新获得焦点和页面重新可见可以取消等待并立即尝试一次，但不能绕过单连接锁或重置退避次数。
- socket 从创建到 `open` 以及 `open` 后到 ChannelClient Initialize ready 都有有界超时；任一阶段超时都按一次连接失败处理，销毁当前代际后进入下一次退避。
- `dispose()` 后进入 `closed`，不得再创建 socket 或定时器。
- 旧 generation 中尚未完成的调用不得转发到新 generation；用户或上层恢复流程必须显式决定是否重新发起。

### 前台恢复

移动端浏览器切后台会冻结页面：定时器不再触发，socket 可能被系统静默掐掉，而 Web 端没有任何存活性检测（见「明确不做」），于是状态会卡在过期的 `connected`。此时 `retryNow()` 的 connected 早退会把回前台事件整个吞掉，页面看上去是活的、实际已经不可用。

因此可见性由 `packages/client` 的前台监听器单独持有：

- `visibilitychange`（hidden）与 `pagehide` 记录隐藏时刻；`visibilitychange`（visible）与 `pageshow` 计算隐藏时长。必须同时监听 `pageshow`，因为 iOS 从 BFCache 恢复只发 `pageshow`。
- 隐藏时长超过 `FOREGROUND_RECONNECT_THRESHOLD_MS`（8 秒）时**无条件销毁当前代际并重建**，不再受「状态为 connected 不重试」限制。此时主动 teardown 必须复用失败处理的 settled 去重，避免与真实 `close` 事件重复计一次失败。
- 未超过阈值时维持轻量路径：仅在状态非 `connected` 时取消等待立即尝试一次。
- 阈值经 `WebSocketConnectionOptions.foregroundReconnectThresholdMs` 注入，默认 8 秒；测试必须传小值，不依赖真实等待。

### 计数语义

`WebSocketConnectionSnapshot.attempt` 是退避阶梯的内部输入，不是给用户看的进度。手机切后台通常远短于 30 秒稳定期，该计数会在整个页面生命周期内单调累加，渲染出来等于「你切 App 的次数」。

因此 UI **不得渲染 `attempt`**。需要表达「不对劲」时改用两个有意义的信号：剩余等待时间（`nextRetryAt` 带来的倒计时）和断开持续时长（`disconnectedAt` 带来的分级）。计数值本身保留在快照里供日志与调试。

## Service 代际与 UI

每次新连接 ready 都创建新的 `RemoteServiceAccess`，底层 service 对象身份必须随 generation 换代。页面中的 React Root、`ServiceProvider` 消费树、tab/session store、active task、composer draft、timeline 和滚动状态属于页面生命周期，不以 WebSocket generation 为 key。

Web 入口在首次 service 到达后创建稳定 facade。后续连接只替换 facade 的 target；消费者通过 generation/status 元数据重新渲染，但不得通过 Root key 整树重挂载。断线期间保留页面外壳与已加载内容，连接状态条显示重试；RPC 写操作和新读取必须等待新 target，不把整个页面切回 loading 或 `inert`。

### 连接状态条

状态条始终显示连接管理器此刻的动作阶段。连接管理器是重试定时器、在途尝试和快照的唯一所有者；UI 只根据快照投影阶段，并通过现有 `retryNow()` 请求跳过剩余等待。

| 状态                     | 进入条件                                     | 顶部进度条             | 胶囊                                                 | 操作             |
| ------------------------ | -------------------------------------------- | ---------------------- | ---------------------------------------------------- | ---------------- |
| 首次连接                 | 初始状态为 `connecting`                      | 无                     | 正在连接…                                            | 无               |
| 短暂断线                 | 断线少于 `BLIP_GRACE_MS`（800ms）            | 无                     | 隐藏；宽限期内恢复时不闪恢复提示                     | 无               |
| 等待重试                 | `reconnecting` 且 `nextRetryAt` 在未来       | 随剩余时间收缩         | 连接已断开，{seconds} 秒后自动重试                   | 显示「立即重试」 |
| 连接尝试中               | `reconnecting` 且 `nextRetryAt` 为空或已到期 | 无                     | 正在重新连接…                                        | 无               |
| 尝试失败、等待下一次重试 | 连接管理器再次安排重试                       | 按新等待重新从满宽收缩 | 连接已断开，{seconds} 秒后自动重试                   | 显示「立即重试」 |
| 已恢复                   | transport 发布 `connected` 且断线提示曾可见  | 无                     | 连接已恢复，闪现 `RECOVERED_FLASH_MS`（800ms）后消失 | 无               |

规则：

- UI 阶段由连接管理器快照中的 `status` 与 `nextRetryAt` 决定：未来的 `nextRetryAt` 表示等待；为空或已到期表示连接尝试已开始。不要从累计 `attempt` 或总断线时长推导阶段。等待文案不猜测失败原因，也不区分初次断开和后续尝试失败。
- 顶部进度条只在有未来重试定时器时出现。倒计时到期后，连接管理器启动尝试并清除 `nextRetryAt`，UI 同步撤下线条并显示「正在重新连接…」。
- 失败后连接管理器直接进入下一次退避；不要另加失败停留状态或由 UI 启动第二个重试定时器。零秒退避应直接呈现连接尝试，不显示假的「1 秒后重试」。
- 「立即重试」只在有未来重试定时器时出现，点击即清除该等待并调用现有 `retryNow()`；新的快照到达后立即显示连接尝试中。已有连接尝试时不显示可点击但无效的操作。
- 断线持续时间不覆盖当前阶段，也不据此断言网络故障或要求用户介入。UI 不展示累计 `attempt`。
- 宽限期内恢复时不闪恢复胶囊；只有宽限期结束后胶囊实际展示过，本次恢复才显示短暂成功提示。
- 成功提示不带进度条和重试按钮。这里的「连接已恢复」只表示 WebSocket 与 ChannelClient Initialize 就绪，不承诺当前会话同步或 Agent 任务已完成。
- 状态条以 overlay 形式浮在内容之上，不得推挤页面布局——推挤会让聊天列表在每次重连时跳动。细条与胶囊描边走主题 CSS 变量（`--connection-banner-border`），深浅色各一值；不能用 Tailwind 的 `dark:` 变体，它跟随的是系统偏好而不是应用主题。
- Web 端样式必须从 `packages/web/src/web.css` 进入。该文件在 `@import "@zcode/ui/styles.css"` 之外显式声明 `@source "./**/*.{ts,tsx}"`：UI 的样式入口用 `source(".")` 把扫描根固定在 `packages/ui/src`，不补这条声明时 Web 端独有的类（任意值、只在本包出现的 opacity 修饰符与层级）会静默不进产物，表现为「类名在、样式不在」且不报错。
- 胶囊带操作按钮时，按钮右端圆弧必须与胶囊右端圆弧同心（右内边距由两者高度推导），否则两段弧心错开，缝隙会从中间往上下两端忽宽忽窄。
- `connecting` 必须有独立分支，不得复用恢复态文案，否则会渲染出「连接已恢复」这种与事实相反的提示。

### 就绪状态分工

工作区服务解析必须区分两个状态，不能用一个 `rpcReady` 同时控制挂载和请求：

- `targetReady` 表示 workspace attachment/target 已经解析到可识别的服务对象。它在 `local-ready` 与 `remote-ready` 为真，在 `remote-waiting` 为假；外层 WebSocket 暂时断线不会把它改成假。
- `rpcReady` 表示当前 transport target 可用且 workspace target 已就绪，可以发起新的读取、订阅或 mutation。它由 `targetReady && transport.rpcReady` 派生；断线期间为假。

`V4ConversationProvider` 和 `V4PaneConversationProvider` 只用 `targetReady` 决定是否挂载会话数据层，因此 transport 重连期间 provider、composer、timeline 和 pane 的局部状态保持连续。它们的 RPC 仍通过稳定 facade；断线时 facade fail-closed，不能把请求转发到新代或自动重放 mutation。composer 与 command dispatch 还必须同时读取当前 workspace target 的 `rpcReady`：外层 WebSocket 或远程 target 任一未就绪时，不得新建 envelope 或写入 unknown 账本。设置页、通知、插件目录等会主动发请求的消费者继续使用 `rpcReady`，在断线期间暂停新请求。

`initialWorkspaceAbsPath`、`initialWorkspaceIdentity` 和 `initialTaskId` 是页面首次启动的一次性 bootstrap。连接换代不得再次调用 `addTab`、`setActiveTaskId` 或 `startDraft`。真正的页面重新加载仍按 `web-url-routing.md` 重新解析地址栏并消费一次 bootstrap。

重连保留当前 URL 和已有 task 深链，不使用 `location.reload()`。`useWebUrlSync` 继续把 tab/session/App 状态投影为 URL，不新增第四套导航状态。

## 失败语义

- 断线前的普通读取如果属于旧 target，按旧 ChannelClient 生命周期结束；不能自动改成新 target 调用。
- 断线期间发起的调用明确返回连接关闭错误；调用方可以刷新 projection，但不得自动重发 mutation。
- 重连成功后由现有 snapshot/list/订阅 owner 重新读取权威事实；不从旧代事件缓存透明重放业务操作。
- transport 错误由连接状态呈现，render/service invariant 错误仍由 ErrorBoundary 呈现，两者不得混用。

## 明确不做

- 不接入 `PersistentProtocol` 或 `RemoteAgentConnection` 的 ACK/replay 语义。
- 不修改 server 或桌面 Host 的 wire protocol。
- 不透明重放任意 RPC、命令、文件写入或设置更新。
- 不用刷新页面、Root key 或 SessionPane 空状态掩盖连接问题。
- 不承诺恢复未持久化的浏览器草稿。
- 不让 `packages/ui` 直接依赖 WebSocket 连接管理器或读取浏览器全局对象。

## 验收场景

1. 在 `/task/A` 保留未发送草稿、侧栏和滚动位置后断开并恢复 WebSocket：页面不白屏，Root 与现有 conversation provider 不卸载，仍停在 A，草稿和局部状态不丢。
2. 从 `/task/A` 切到 `/task/B` 后重连：仍停在 B，不回到首次启动 task，也不自动进入 `/` 草稿态。
3. 重连期间切换 task 或新建对话：恢复后不回弹、不覆盖用户的新选择。
4. 断线期间 `targetReady` 保持为真但 `rpcReady` 为假：会话 Provider 保持挂载，主动发起的 RPC 不越过 facade 的 fail-closed 边界。
5. 旧 generation 的挂起 RPC 和迟到事件不抵达新 target；新调用只在 ready 后路由到当前 target。
6. 普通事件与动态事件在 target 切换后只有一份当前订阅，旧订阅被释放。
7. 首次连接失败仍展示 bootstrap error；已连接后的断线继续自动退避并允许手动 retry。
8. 同一页面 facade 跨两个 WebSocket generation：第二代第一次 V4 调用重新完成 hello/clientHello，conversation 与 sessions-index 都建立新 subscription；第一代迟到 ACK、帧和 command 不得进入第二代。
9. attachment 换代期间 provider、Root、tab、composer 和 timeline 保持挂载；transport 只清理旧 ownership 并恢复订阅，不重新消费 bootstrap 或自动重放 mutation。
10. 手机切后台超过 8 秒后回前台：即使断线期间状态仍是 `connected`，也立即创建新 socket 并换代；正在连接期间不渲染顶部进度条。
11. 切后台不足 8 秒立刻回来：不重建连接，页面无任何状态条闪现。
12. 从 BFCache 恢复（只发 `pageshow`）：走同一条强制重连路径，不依赖 `visibilitychange`。
13. 等待退避时：顶部进度条与胶囊倒数同步收缩；等待期间可点「立即重试」跳过等待。
14. 倒计时到期：进度条消失、胶囊立即显示「正在重新连接…」，不再出现等待文案或可点击重试按钮。
15. 本次尝试再次失败：直接回到等待阶段，文案说明断开和下一次重试时间，进度条从新等待起点收缩。
16. 手动跳过等待后：只启动一次连接尝试；进行中明确显示连接状态，不因用户点击而重复创建 socket。
17. 等待时间为零或已到期：不显示「1 秒后重试」或满宽进度条，直接显示连接尝试中。
18. 断开超过 15 秒：仍按快照显示等待或连接尝试阶段；不因总时长改变文案、按钮或自动重试行为。
19. 连接尝试成功：WebSocket 与 Initialize 就绪后显示「连接已恢复」800ms 并消失；该提示不承诺会话同步或 Agent 任务状态。
20. 断线不足 800ms 并恢复：胶囊和成功提示都不闪现。
21. 首次连接失败：仍是整页 bootstrap error；不出现重连计数或等待态形态。
