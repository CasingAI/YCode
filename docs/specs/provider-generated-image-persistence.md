# Spec: Provider 生成图片的持久化与展示

## 目标

将 provider 执行的图片生成结果从模型结果中的 tool result 持久化为 session artifact，并把助手正文中的无效 `attachment:generated-image` 图片引用改写为可读取的 `ycode-artifact://` URI。新 artifact 写入 YCode 数据目录；既有 `zcode-artifact://` URI 继续读取 Zcode 数据目录。最终正文必须在会话历史、持久化 text part、`ModelComplete` 事件和直播投影中一致。

## 产品规则

- Provider-executed tool call 不进入本地工具执行器、accepted 队列或 streaming coordinator；这只表示本地不执行它，不表示丢弃 provider 返回的 tool result。
- Adapter 保留 `ModelTextResult.toolResults` 中 provider 的原始结果。Core runtime 的 `RuntimeModelTextResult` 必须携带此字段；非流式结果沿用 adapter 值，流式结果在 core stream 聚合结束时一并返回。结果通过 tool-call ID 与 tool call 关联，不按数组偶然顺序关联。
- 仅处理明确标记 `providerExecuted` 且名称为 `image_generation` 的工具结果。支持已确认的 `output.result` PNG Base64 形态及合法图片 data URL；严格校验 Base64、MIME 与数据，不为无效或缺失内容创建 artifact。
- 图片字节由现有 `ToolArtifactStore` 持久化为 session-retention data-URL artifact；新写入使用 `ycode-artifact://` 并保存到 `{dataBaseDir}/.ycode/cli/artifacts`，既有 `zcode-artifact://` 按原 URI 读取 `{storageRoot}/cli/artifacts`。不增加独立存储，不写入 SQLite blob，不直接写裸 PNG 后假定现有 UI 可读。
- Artifact URI scheme 是唯一的目录路由依据，不按当前传输协议路由。读写和派生媒体缓存均须保留该 scheme 归属；不得为兼容旧消息移动旧 artifact 或改写其 URI。
- YCode artifact 目录纳入现有存储扫描与 `toolOutputs` 清理类别；Zcode 原目录继续沿用当前扫描与清理行为。
- Core model-step 是 provider 图片结果到最终 Markdown 的唯一投影所有者。按 tool-call ID 和图片顺序将成功保存的 artifact URI 映射到 `attachment:generated-image` 引用。没有可用图片或 artifact 写入失败时，将该引用替换为明确的图片不可用提示，保留正文其他内容。
- 最终正文用于 `state.modelResponse`、assistant history、持久化 text part 与 `ModelComplete.content`。provider 原始历史语义保持不变；不放宽 Markdown sanitizer 白名单，不新增附件列表 UI。
- `ModelCompletePayload.assistantMessageId` 可选，旧事件不变。V4 与 TUI 仅在该 ID 对应的 assistant 正文行/消息已存在时用终态 `content` 替换其正文，不重复追加；无匹配行、旧事件、output-token continuation 均保持兼容。桌面 continuous 与 Web replayable 的投递语义不变。
- Artifact 后续仍受现有工具输出清理策略管理；本规范不改变清理类别、保留期或用户警告。

## 状态所有者与事件顺序

```text
Provider 响应
  ├─ toolCalls + toolResults（按 tool-call ID 关联）
  └─ 原始文本流
        ↓ core model runtime 归一化
RuntimeModelTextResult（携带 toolResults）
        ↓ core model-step 处理 provider 图片
ToolArtifactStore 写入 YCode session-retention data-URL artifact
        ↓ ycode-artifact URI 或不可用提示
统一最终正文
  ├─ assistant history / text part
  └─ ModelComplete(assistantMessageId, content)
        ├─ V4：替换同 ID 正文行
        └─ TUI：替换同 ID 流式消息正文
```

Artifact Store 是图片字节唯一持久化所有者；core model-step 是图片映射与最终正文唯一投影所有者；UI/TUI 只消费完成事件和现有 artifact 读取接口。流式 `text_delta` 是过程态，`ModelComplete.content` 是终态正文。Artifact 写入失败不得导致模型正文或回合失败。

## 验收场景

1. 非流式 provider 的 `image_generation` tool result 被按 ID 关联并持久化，最终 Markdown 引用可由现有附件读取链路显示。
2. 流式 provider 的 tool result 在 stream finish 后保留到 `RuntimeModelTextResult`，与非流式路径得到相同处理结果。
3. 多张图片按 provider tool-call 与图片顺序映射，不错配、不重复写入。
4. 无效 Base64、非图片 MIME、缺失结果及 artifact 写入失败均显示图片不可用提示，不创建伪 artifact，其他正文保留。
5. 非 provider-executed 工具与非 `image_generation` 结果不受影响，provider-executed 调用仍不进入本地执行器。
6. 持久化正文、历史正文与 `ModelComplete.content` 完全一致；V4 与 TUI 在收到原始 delta 后按相同 `assistantMessageId` 替换正文，不生成重复行/消息。
7. 旧 `ModelComplete` 事件、没有匹配正文行、output-token continuation 和冷恢复维持兼容；有效 artifact URI 经现有读取链路可见。
