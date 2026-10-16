# Subagent 附件透传（Agent 派活 / SendMessage 续聊带图片）

## 目标

主 Agent 在派活（Agent 工具）和续聊（SendMessage 工具）时，能把图片（附件）
传给 Sub Agent，使子代理模型真正看到 image content block，而不是只看到
一段文字描述。

## 状态所有者

| 事实 | 唯一 owner |
| --- | --- |
| 工具入参的附件形状（provider 可见） | contracts `AgentAttachmentSchema`（`tools/agent-attachment.ts`） |
| 端口边界的附件形状（协议安全） | contracts `SubagentAttachment`（`interfaces/subagent.port.ts`） |
| core 内运行时附件形状 | core `TurnAttachment`（`agent/turn-state.ts`） |
| 附件解析为模型 content block | `resolveTurnAttachments`（`runtime/helpers/attachments.ts`），唯一解析入口 |
| child 首轮执行 | `runtime/methods/subagent.ts` 的 `executeTurn(prompt, attachments)` 调用点 |
| 终态续跑的执行请求 | `subagent/runner.ts` 的 `continuationRequest` |
| 运行中转向的消息文本 | `subagent/message-steering.ts` 的 `formatSubagentCoordinatorMessage` + `RuntimeTaskPendingMessage.attachments` |

contracts 包不能 import core；core 侧把 `SubagentAttachment` 映射为
`TurnAttachment` / `PendingTurnAttachment` 后再使用。

## 接口

- `AgentInputSchema` 新增可选字段 `attachments: z.array(AgentAttachmentSchema).max(8).optional()`。
- `SendMessageInputSchema` 新增同名字段（`.strict()` 保持不变）。
- `AgentAttachmentSchema`（`.strict()`）：`type: "image" | "file" | "pdf"`，
  可选 `path` / `content` / `filename` / `mimeType` / `sizeBytes`。
- `SubagentRunRequest.attachments?: SubagentAttachment[]`，
  `SubagentSendMessageRequest.attachments?: SubagentAttachment[]`。
- `RuntimeTaskPendingMessage.attachments?: SubagentAttachment[]`（core 内复用
  contracts 类型，保证排队消息不丢附件）。
- `ExploreSubagentRuntimeRequest.attachments?`（core 内 `TurnAttachment[]`），
  由 runner 从 `SubagentRunRequest` 映射后传入。

## 行为规则

1. 派活链路：Agent handler → `SubagentPort.run(request)` → runner →
   `ExploreSubagentRuntimeRequest` → `childRuntime.executeTurn(prompt, attachments)`。
2. 终态续跑链路：SendMessage handler → `sendMessage(request)` →
   `continuationRequest`（带上 `request.attachments`）→ `executeTurn`。
3. 运行中转向量路：`steerTurn` 的 `TurnSteerInput.attachments` 本就存在，
   message sink 把排队消息的附件一起传入；排队消费（`flushPendingMessages`）
   走同一 sink，不另起分支。
4. 非法附件不新增崩溃路径：无 `path`/`content` 的 image、伪造的 pdf 正文等，
   由既有 `resolveTurnAttachments` 降级为 placeholder 或 path reference。
   对 video/PDF 降级时，`file part.url` 始终为字符串；只有合法的 artifact URI 可保留，
   不把内联 data URL（含 base64 正文）写入降级后的 part。媒体派生路径仅接受有 URI 的
   durable artifact inline source，或有路径的 local file source。
5. `type: "url"` 不作为图片 part，只会解析为 `resource_link`；工具 schema
   的枚举不含 `url`，避免模型误用。

## 验收场景

- 图片附件经 Agent 工具透传后到达 `executeTurn` 第二参数。
- 图片附件经 SendMessage 终态续跑后到达 `executeTurn` 第二参数。
- 无 path/content 的非法 image 附件降级不崩（`resolveTurnAttachments` 返回
  placeholder，不抛错）。
- video/PDF placeholder 对有效 artifact URI 保留 URI；对无效/缺失 content 使用安全 fallback，
  且 `url` 始终是字符串、不泄露内联 data URL。
- inline media source 缺少 URI 时不可物化；合法 artifact URI 与 local file path 仍按现有规则处理。
- `pnpm typecheck`、`pnpm lint` 通过；新增测试覆盖上述三条。
