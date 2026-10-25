# Web 存储管理

## 产品规则

- Desktop、独立 Web 和桌面手机远控均提供「数据与统计 › 存储」，支持扫描、分类明细、按类别与时间范围清理、二次确认、结果反馈与清理后重扫。
- 该分区同时承载与存储相关的用户开关：模型调用轨迹记录、会话产物自动清理，以及会话产物占用提示开关（`sessionStorageWarningEnabled`，默认开启，语义见 `session-storage-warning.md`）。开关统一走宿主设置服务 `AppSettings`，不在分区内另建持久真值。
- 分区内容拆成两个同级 tab，与分区标题同行，用设置页统一的 pill 分段控件（与「使用统计 › 应用用量」同一视觉）：
  - 「占用统计」：本机数据根的占用汇总、磁盘卡片、分类明细与清理入口。默认 tab，进入分区即展示。
  - 「存储选项」：上述三个存储相关开关。
  - 两个 tab 的内容互斥渲染，同一时刻只挂载一个面板；切换 tab 不改变开关真值，也不丢失已保存的宿主扫描快照。
- 管理对象是当前连接宿主上的 YCode 数据根，不是访问网页的手机/电脑磁盘。根由宿主解析，客户端不得指定任意扫描根或删除路径。
- 保留 `storage-cleanup-dialog.md` 的类别、时间范围、活动保护、不可恢复确认及部分失败语义。Web 不降低这些限制。
- 「在系统文件管理器中显示」为独立可选能力：Desktop 保留，Web 不显示。不能因缺少原生文件管理器而隐藏整个管理页。
- 不增加 SSH/WSL/Docker 文件操作协议，不把远端路径转交本机文件系统；不另起 Agent 或 Local Host。

## 所有权与接口

```text
桌面设置页 ─ IPC ──────────────────────┐
                                      ├─ Main 唯一 StorageService → Worker/fs
手机 Web ─ 已认证 WS/RPC ─ Window Host 转发 ┘

独立 Web ─ 现有 WS/RPC ─ Server 唯一 StorageService → Node adapters
```

- 扫描任务、最近快照与清理均由现有 StorageService 持有。Host 与浏览器仅转发或投影，不复制业务缓存或创建第二份扫描服务。
- tab 选择态的唯一所有者是设置页（`SettingsPage`）：它持有当前 tab 并把 `activeTab` 传给分区，分区只按 `activeTab` 渲染对应面板，不另存一份选择态，也不做持久化。
- 面板只读宿主快照：切到「存储选项」时占用面板卸载，随之取消未完成的扫描；切回「占用统计」时读取宿主最近快照并重新发起扫描。
- 独立 Server 在服务装配层持有唯一实例，随服务集合释放；Desktop 继续由 Main 持有进程级实例。
- 公共 RPC 契约提供 startScan、cancelScan、getSnapshot、clean 与 onScanProgress；本地 dispose 不暴露为远程管理命令。
- RPC 请求校验根 ID、类别、范围和请求形状。清理目标始终由宿主类别目录与清理计划解析，不接受绝对删除路径。
- Main↔Host 新消息具有严格类型与运行时校验，通过 requestId 关联应答。Host 退出时释放订阅并结算未完成调用，不自动重发清理。

## 时序与恢复

```text
面板进入 → 订阅进度 → 读宿主快照 → 发起扫描 → jobId 关联完整快照/终态
用户确认 → 一次 clean 请求 → 宿主取消旧扫描/清理 → 反馈 → 新扫描
断线 → 旧代失效 → 重连/重绑 → 读取宿主快照 → 显式新扫描
```

- 单 owner 同时只有一份扫描；新扫描替换旧扫描。取消必须携带 jobId，旧面板/旧 attachment 关闭不能取消后来客户端的任务。
- RPC attachment 仅持有自己发起的 jobId 用于释放，不持有第二份快照；多个 attachment 共用同一服务。
- UI 必须处理终态早于 startScan 响应以及请求返回前面板卸载的情况。旧 job、旧连接代际与旧面板请求结果不得覆盖当前状态。
- Desktop 沿用连续 IPC 事件；Web 为可恢复链路，通过完整宿主快照修复断线间隙，不伪造进度回放。jobId 在 owner 生命周期内不可与旧代任务混淆。
- clean 不进入离线队列、自动重试或恢复重放。响应丢失表示结果未知；重连后扫描核对，不推断未删除也不重复提交。
- 部分失败不回滚已删除文件；显示成功数与失败数。文件逻辑大小不等于释放的物理空间。

## 验收与测试

1. Web 默认与动态设置列表均显示存储；computerUse 等其他平台边界不变。
2. 独立 Web 的 RPC 使用临时数据目录完成扫描、订阅、快照、清理和重扫，不访问真实用户目录。
3. 手机请求经 Host 转发命中 Main 与 Desktop 共用的唯一实例；关联应答、进度转发和释放正确。
4. 非法请求、未知根、不可清理类别以及越界条目失败；原有保护规则不变。
5. 两个客户端相继启动扫描，前者关闭不会取消后者；快速终态不会造成永久 loading。
6. Web 重连后重绑事件并恢复快照；旧代事件被丢弃，清理不重发。
7. Web 明细无原生 reveal 按钮；Desktop 有能力时仍显示。
8. 存储分区默认显示「占用统计」；切到「存储选项」只显示三个开关，切回后仍能看到占用汇总；两个 tab 的切换器与分区标题同行，样式与「使用统计」的应用用量 pill 一致。
9. E2E 场景：Web 打开设置 → 存储 → 扫描/分类明细 → 清理对话框 → 选择范围/类别 → 二次确认 → 结果 → 重扫刷新。手机窄屏下底部操作可触达；扫描中断线重连可恢复。

验证必须执行相关自动化测试、pnpm typecheck、pnpm lint、pnpm architecture:check --changed。未经明确授权不使用 UI 自动化、CDP 或调试协议操作 YCode；未执行的 GUI E2E 如实记录，不记作通过。

## 连接与 UI 收口（接线实现）

- `Main` 初始化时为每个 Window Host 建立一个消息关联转发器，但只调用同一个进程级 `getMainStorageService()`；Host 的 `createLocalServices` 注入 Main 桥服务，严禁在 Host 再创建独立磁盘扫描 owner。
- Desktop 本地 Renderer 原有 IPC 不改；手机的 WebSocket attachment 从 Host 的服务集合取得 storage channel。每个 attachment 只取消其自身 jobId，关闭后不影响后续新扫描。
- 独立 Web 和手机共享 `WebApp` 的 storage adapter：只传 `startScan/cancelScan/getSnapshot/clean/subscribeScanProgress`，没有 reveal；连接代际改变时销毁旧订阅、重读 owner 快照，禁止重发 clean。
- 仅 Web 默认设置列表展示 storage；原生 reveal 按钮需要当前桥显式有 `revealPath` 才渲染。缺桥时仅显示不可用说明。
- 如果 owner 的扫描终态先于 startScan 响应，UI 在拿到 jobId 后需核对服务端 snapshot，以免永远停留在 scanning；面板卸载前未返回的 jobId 一律在结果返回时精确取消。
