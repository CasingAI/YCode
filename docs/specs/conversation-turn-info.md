# Spec: 回复工作段信息

## 目标与范围

在会话「已工作 / 工作中 / 已停止」统计栏最右侧增加常驻 `Info` 图标按钮。点击后以模态窗口展示该回复工作段的执行事实，避免把输入区或子会话底栏的当前模型绑定误认为历史回复的实际来源。

本次覆盖 Desktop、Web（含手机远控）和子代理会话，复用共享会话时间线。公开分享页维持现有数据披露范围，不新增信息按钮，不公开内部执行供应商。不会修改模型选择、子代理绑定、重试或请求路由行为。

## 产品规则

1. 入口与原有折叠触发器同处一行，位于其右侧，始终可见，不依赖 hover。按钮有「回复信息」的 tooltip 和无障碍名称，可用键盘激活。
2. 点击信息按钮只打开窗口，不切换工作过程折叠，不发送会话命令、不发起模型请求、不另行读取调试文件或订阅子会话。Esc、关闭按钮和遮罩点击遵循现有 Dialog 行为，关闭后恢复入口焦点。
3. 标题为「回复信息」。内容展示实际调用的供应商 ID 与模型 ID、工作状态、工作时长、工具次数、累计思考时长和 turn ID。ID 保留原始值，可选择复制；长 ID 换行，不撑破手机屏幕。无需额外介绍性副标题。
4. 与统计栏相同，信息范围是当前视觉工作段。accepted guide 在同一 product turn 中建立独立工作段，各段分别展示自己的执行模型与统计。turn ID 用于定位所属 product turn，不把它误称为网络 request ID。
5. 「实际调用模型」只来自运行时模型步骤发出的 `ModelRequest` 的 `providerId/modelId`；冷恢复只来自对应持久化助手消息的执行模型字段。不使用当前 `snapshot.config`、输入草稿、`admissionModelSelection`、模型组意图或 modelChange marker 推测实际调用。
6. 一段内存在多个实际供应商/模型时，按首次发起模型步骤的顺序逐一列出，以 `(providerId, modelId)` 去重。同一模型 ID 来自不同供应商时必须保留两项。模型信息仅归属当前会话自己的前台/子代理模型步骤，不递归混入后代模型，也不混入压缩、标题生成或其他 sidecar 请求。
7. 模型归属使用模型步骤发起时的工作段，不按响应结束时间移动；guide 到达时仍在运行的旧请求留在原段。重复事件和重放不会重复增加模型条目。
8. 新字段缺席、旧助手消息没有完整执行身份，或工作尚未发起模型请求时，实际模型显示「未知」。不得用当前绑定回填。供应商 ID 与模型 ID 均完整才形成一个已知身份。
9. 工作时长和工具/思考统计复用既有工作段事实及其旧快照 direct fallback，不在弹窗新增第二套统计。明确的 0 显示为 0，缺席显示「未知」，不把缺失伪造为 0。运行中窗口随既有快照更新；完成/中断后不继续增长。状态区分工作中、已完成、已停止和失败；轮头为 failed 时，仅该轮最后工作段显示失败，之前已结束的 guide 工作段保持完成，不把失败展示为成功完成。
10. 不展示凭据、请求头、endpoint、提示词、原始响应或私密配置。不声称应用记录的模型 ID 能证明上游服务商内部的真实模型权重。

## 所有者与接口

- **Runtime** 是执行模型的唯一事实所有者。现有 `ModelRequest` 在模型步骤开始时发布实际 `providerId/modelId`，持久化助手消息已经记录同一执行模型。
- **CLI ProductProjection** 负责将该事实物化为 `TurnWorkSegment.executionModels?: ExecutionModelIdentity[]`，只为有效当前会话/turn 的请求更新当前工作段。只新增 additive optional 字段，不改变 v4 wire version、行类型或命令。
- **transcript-hydration** 对每条普通助手消息从 `AssistantMessageInfo.providerId/modelId` 合成同类 `ModelRequest`，再通过同一个 reducer 建立摘要。该事件从此属于 transcript-derived 分类，冷恢复合并不得把旧日志中的重复 ModelRequest 再次记入错误工作段。
- **共享协议** 定义严格的 `ExecutionModelIdentity` schema/type（非空 providerId、modelId）；v4 和 legacy 公共协议入口导出同一契约。
- **UI** 仅在现有工作段投影上透传 `executionModels`。局部 Dialog open 状态由信息按钮组件独占；不写入 Zustand、服务端快照、模型绑定或持久化。UI 不自行缓存或重新推断执行模型。

```text
实际模型步骤 → ModelRequest(providerId/modelId) ──────────────┐
持久化 assistant 执行身份 → 冷恢复合成 ModelRequest ──────────┤
                                                            ↓
                                     CLI ProductProjection（现有 turn/segment owner）
                                                            ↓
                                      TurnWorkSegment.executionModels + usage
                                                            ↓
Desktop continuous：live delta ──────────────────────────────┤
手机 replayable：snapshot + gap repair ───────────────────────┤
                                                            ↓
                                         共享统计栏 [i] → 局部只读 Dialog
```

保留现有 owner/lease、workspaceIdentity、runtime → product turn 映射、stale run 过滤、epoch/revision 和 gap repair。新信息通过现有 snapshot/delta 交付，不增加旁路服务或请求。换会话/工作段时局部窗口随所属组件卸载，不保留跨会话结果。

## 兼容与失败语义

- 旧 CLI/旧快照缺少 `executionModels` 时照常渲染统计栏及按钮，弹窗显示「未知」。新版客户端不得从其他选型字段补值。
- 新 CLI 的 optional 字段可被旧客户端忽略，无需数据库迁移。
- 冷恢复、直播逐事件与 replayable snapshot 必须得到相同的有序模型身份集合；无正文但有工具/思考的模型步骤也必须记录。
- 无效身份、其他 session/过期 turn 的迟到事件、已结束 turn 的 sidecar 请求不改变已有执行身份。
- 公开分享投影显式不复制新字段，维持既有隐私 allow-list。

## 验收场景

1. 子会话绑定为 `commandcode / deepseek/deepseek-v4.1-flash`，实际模型步骤为 `cliproxy-codex / gpt-6-luna`。窗口只显示后者；切换当前选型不改写历史信息。
2. 同段调用相同模型多次只列一项；两供应商使用同一 modelId 时列两项；按首次调用顺序保留。
3. guide 前后模型不同，两条统计栏的窗口分别显示各自工作段模型；guide 前发起的请求不被重新归属。
4. 工具-only、reasoning-only、运行中、成功、中断和失败轮均可显示已知模型；尚无请求或旧消息缺字段显示「未知」。
5. 直播事件序列、持久化助手消息冷恢复、cold merge 后的模型集合一致；重复事件不会重复；其他会话、过期 turn 和 sidecar 不污染。
6. 旧快照缺省字段通过 schema；空 provider/model、错误类型不通过 schema；主协议入口与 v4 入口暴露同一类型与校验。
7. 点击 i 打开正确工作段窗口，原折叠状态不变；Esc/关闭按钮关闭并恢复焦点；键盘 Enter 可打开。桌面/375px 手机宽度、明暗主题均无横向溢出。
8. 缺席指标显示「未知」，明确 0 显示 0；当前绑定与实际模型冲突时不回填、不掩盖。
9. 分享投影不公开执行供应商，分享页不新增按钮。

## 验证入口

- shared protocol schema 测试；CLI projection、transcript hydration 和 cold merge 的定向 node:test。
- UI 纯函数、SSR 内容/接线回归；使用独立临时浏览器夹具验证 modal 的打开、关闭、焦点与窄屏行为，不连接或操作正在运行的 YCode。
- `mise exec -- pnpm typecheck`、`mise exec -- pnpm lint`、`mise exec -- pnpm architecture:check --changed`，以及本次文件的格式检查。
- 若隔离浏览器或其他验证依赖不可用，明确报告跳过，不以 SSR 代替 GUI 交互验收。
