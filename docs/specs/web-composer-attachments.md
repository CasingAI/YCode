# Spec: Web 端 Composer 附件上传

## 目标

明确聊天输入框（composer）附件在 Web 端（无本地文件路径的平台）的支持范围、上传语义与失败表现。修复两个缺口：二进制文档在 Web 端被序列化层静默丢弃（报「附件缺少可读取内容」）；上传成功后非媒体附件的内容没有 agent 可消费的面。

上传链路本身（浏览器 `<input type="file">` → base64 分块上传事务 → WS → server → CLI artifact）为桌面与 Web 共用，本 spec 只约定平台差异分支与消费语义，不改传输协议。

## 产品规则

### 平台分支

- 平台判定唯一依据是 `IPlatformService.canSelectFilePath`：为 false（Web）时文件选择走浏览器 `<input type="file">`，附件只有浏览器 `File`，**没有 `localPath`**；为 true（桌面）时保持 `localPath` 零上传路径不变。
- Web 端不存在任何「把本地路径交给 agent」的合法路径：agent 进程与用户文件不在同一台机器上，凡是内容型附件必须把字节传到 CLI 侧。

### 支持矩阵（无 localPath 时）

| 类型 | 行为 | 上限 |
| --- | --- | --- |
| `image/*` | inline base64 上传（既有） | 20MiB，超限 `OversizedInlineImageAttachmentError` |
| `video/*` | inline base64 上传（既有） | `PROTOCOL_V4_LIMITS.attachmentMaxBytes`，超限 `OversizedInlineVideoAttachmentError` |
| `application/pdf` | inline base64 上传（既有） | 20MiB，超限 `OversizedInlinePdfAttachmentError` |
| 文本类（`isTextLikeAttachment`） | `textContent` 上传，64Ki 字符截断（既有） | 截断即止 |
| **其它任意文件（二进制文档）** | **inline base64 上传（本次新增）** | 20MiB，超限 `OversizedInlineFileAttachmentError`（本次新增） |

- 大小上限统一为 `PROTOCOL_V4_LIMITS.attachmentMaxBytes`（20MiB），与上传事务 `proto.payloadTooLarge` 边界一致；序列化层先拦，避免整文件 base64 编码后才被协议拒绝。
- 20MiB 以上、需要 agent 消费的大文件属另一档产品能力（远端寄存），本次不做。

### 失败语义

- 结构化超限错误在 UI 层按当前 locale 格式化（`chat.attachments.oversizedInlineFile`），与 image/video/pdf 超限文案同构。
- 超限错误属**非瞬态**：chip 直接 failed，不进入自动重试（`isTransientAttachmentUploadError` 黑名单覆盖）。
- 「无内容可发即丢弃」是防御分支：本次之后正常路径（任意 mime、有 File）都能产出内容，该分支保留兜底并继续告警。

### 非安全上下文（http 远程访问）的 checksum

- Web 端常通过 `http://<局域网/远程地址>` 打开（非安全上下文），此时 `globalThis.crypto.subtle` 与 `crypto.randomUUID` 不存在（WebCrypto 仅限安全上下文；仓库已知约束，先例见 `useTaskSessionFilePath` 注释）。
- 上传事务的 begin 需要全量 `sha256:<小写 hex>` 校验值（CLI 侧 `attachment-upload-registry` 逐字节比对）。安全上下文优先 WebCrypto 原生计算；`subtle` 缺失时**必须回退内置纯 JS SHA-256**，输出格式与 CLI 校验一致，禁止抛 `fault.attachment.checksumUnavailable`（该 fault 曾导致 http 访问下图片/文本/二进制全部附件在开传前失败）。
- `uploadId` 生成沿用既有 `getRandomValues` 兜底（非安全上下文可用），不改。

### 粘贴长文本

- 桌面优先 `IPlatformService.createTempTextAttachment` 落临时文件（沿用 localPath 链路）。
- 平台不支持（Web）或创建失败时，**回退为直接构造 `textContent` 附件**（文件名沿用按日期生成的剪贴板文件名），不再向用户报「当前平台不支持临时文本附件」。`textContent` 与 `dataBase64` 在 `uploadComposerAttachment` 同走 put 事务，两条产出路径等价。

### agent 消费面（CLI 侧）

- 上传产物统一是 session retention 的 data-URL artifact（`zcode-artifact://`）。
- `image/*` / `video/*` / `application/pdf` 继续投影成 provider 原生输入块。
- 其它 mime 的 prompt 附件：占位文本**必须附带物化后的可读绝对路径**（CLI 把 artifact 字节落成物理缓存文件），agent 用现有 Read/Bash 工具按路径读取内容；无物化路径的旧占位文本只作为兜底。
- 桌面 localPath 附件维持现状：占位文本含原路径，agent 直接读用户文件，不经过 artifact。

### 状态所有者

- chip 上传状态：`composerAttachmentUploadStore`（scope key = `workspaceIdentity?.trim() || workspacePath` + scopeId），唯一所有者。
- 上传事务：`attachmentUploadTransaction`（begin/chunk/commit/abort，384KiB 分块）。
- 上传产物：CLI `artifactStore`（data-URL artifact）＋非媒体物化缓存文件。
- 模型投影：`filePartToContentBlock`（`packages/core/src/agent/file-part-hydration.ts`）。

## 接口

- `serializeChatComposerAttachment`（`packages/ui/src/lib/chatAttachments.ts`）：无 localPath 的普通文件产出 `{ kind: "file", dataBase64, mimeType, sizeBytes }`；文本类维持 `textContent`。
- `OversizedInlineFileAttachmentError`（`packages/ui/src/lib/chatAttachmentErrors.ts`）：结构化超限错误，携带 `filename` / `sizeBytes` / `maxSizeBytes`。
- `writePromptAttachment`（`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`）：非媒体 mime 额外物化物理缓存文件；返回 ref 不变，物化路径经 artifact metadata 供投影读取。
- `filePartToContentBlock`（`apps/zcode-cli/packages/core/src/agent/file-part-hydration.ts`）：占位文本拼接物化路径。

## 验收场景

1. Web 端（`canSelectFilePath=false`）上传图片 / PDF / 文本类文件 → chip `ready`，可随消息发送（既有行为，回归不破）。
2. Web 端上传 xlsx/zip 等二进制文档（≤20MiB）→ chip `ready`；agent 回复能体现文件内容（经物化路径读取）。
3. Web 端上传 >20MiB 的二进制文档 → chip 立即 failed，展示本地化「文件过大」文案，不自动重试。
4. Web 端粘贴超过 15,000 字符文本 → 生成文本附件（无临时文件平台不再报错），可正常发送。
5. 桌面端拖拽/选择本地文件 → 行为与改动前完全一致（localPath 零上传、路径直读）。
6. 超大图片 / 视频 / PDF 的既有超限文案与降级策略不变化。
7. **非安全上下文**（无 `crypto.subtle`）上传图片 / 文本 / 二进制 → 不抛 `fault.attachment.checksumUnavailable`，begin 携带的 `sha256:<hex>` 与 CLI 侧 Node crypto 对同一字节计算结果一致，事务正常 commit。
8. 安全上下文（https / localhost）checksum 仍走 WebCrypto 原生路径，行为不变。
