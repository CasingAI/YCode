# 队列项撤回编辑的附件预览

> 状态：已实现。适用面：`packages/ui` 的 v4 会话输入框、`apps/zcode-cli` 的 v4 附件读取授权。

## 1. 问题

会话运行中发送一条带图片的消息，消息进入队列。点队列项的「编辑」按钮撤回后，消息
回到输入框，但附件 chip 变成一个通用文件图标，而不是原来的图片缩略图。

原因：`AttachmentRef` 只是元信息（`ref` / `fileName` / `mime` / `bytes`），不含图片字节。
撤回编辑时 composer 按元信息重建附件 chip（`restoreSessionOwnedAttachments`），
没有 `objectUrl`，而 composer 的附件渲染完全以 `objectUrl` 为准
（`packages/ui/src/v4/ConversationComposer.tsx`）：没有它时 `mediaType` 会被降级成
`application/octet-stream`，`AttachmentPreview` 于是落到通用文件图标分支。

时间线里已发送消息的图片能正常显示，是因为那一侧会经 `attachmentRead` 把字节读回来
再生成 blob URL（`packages/ui/src/v4/ConversationRowView.tsx`）。撤回编辑缺同一条读取链路。

## 2. 产品规则

- 撤回编辑后，输入框里的附件 chip 必须与当初添加时一致：图片显示缩略图，可点开预览；
  非媒体附件（文本、二进制文档）保持通用文件图标 + 文件名。
- 读不回预览时**不得**伪造内容：附件退回通用文件图标，撤回编辑本身照常完成。
- 撤回编辑的既有语义不变：先由 CLI 权威删除队列项，删除被拒时输入框不恢复任何内容。

## 3. 所有权

| 事实               | 唯一所有者                                           | 出处                                                                    |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| 队列项的附件引用   | CLI 会话投影（`snapshot.queue.items[].attachments`） | `packages/shared/src/zcode-protocol-v4/snapshot.ts`                     |
| 附件字节           | CLI session artifact / 运行时文件系统                | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`               |
| 读取授权           | CLI v4 gateway                                       | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts` |
| composer 附件 chip | `useComposerAttachments` 的附件 store                | `packages/ui/src/v4/composer/useComposerAttachments.ts`                 |

UI 不缓存附件字节，也不自己解析 `ref`；预览一律经 transport 的 `attachmentRead` 读回。

## 4. 读取授权：队列项也是 session 自有事实

`attachmentRead` 的授权判据是「当前 session 的权威事实证明这个 ref 属于本 session」。
已发送消息有 user row 证明；**队列项同样能证明**——队列项是 session 自己的投影，
其中的 `AttachmentRef` 就是本 session 收下过的引用。

因此 gateway 的授权扫描在 user row 之外补一段队列项扫描（`resolveReadableMediaAttachment`），
判据仍是「权威队列项里存在同 `ref` 的附件」，renderer 自报的任意路径不会因此放行。

## 5. 读取时机：必须在删除队列项之前

队列项被删除后，CLI 就不再持有这些引用（core 的 pending input 与事件日志一并丢弃），
授权随即失效。所以撤回编辑的顺序固定为：

1. 读回该队列项媒体附件的预览字节（此时队列项还在，授权成立）；
2. `deleteQueueItem` 删除队列项；
3. 删除成功后把正文、附件与预览一起回填 composer。

删除被拒、pane 已切换会话等提前返回的分支必须回收已生成的预览 URL，不能泄漏。

预览 URL 生成后由 composer 附件 store 接管：chip 被移除或附件区被清空时按既有
`revokeChatComposerAttachment` 路径回收。

## 6. 负面边界

- **不改队列项撤回的判定与顺序语义**：删除仍是权威动作，仍在 ACK 成功后才恢复输入框。
- **不改附件发送路径**：session-owned 附件仍不重新 upload/adopt，引用所有权不变。
- **不改 CLI 附件读协议**：`attachmentRead` 的参数与返回形状不变，只放宽授权判据的
  事实来源（多认队列项这一种 session 自有事实）。
- **不新增协议命令、不新增 renderer 本地队列状态**：预览是队列项既有引用的派生视图。

## 7. 验收

1. 运行中发送一条带图片的消息（进入队列），点队列项「编辑」：输入框恢复正文与附件，
   附件显示图片缩略图，可点开预览；不再显示通用文件图标。
2. 撤回编辑后直接再次发送：附件按原有引用发送，不重复上传，模型能读到图片内容。
3. 队列项带非媒体附件（如 `.md`）时，撤回编辑后仍是文件图标 + 文件名。
4. 附件字节读不回时（例如源文件已被删除），撤回编辑照常完成，附件退回文件图标，
   日志有 `队列附件预览读取失败` 警告。
5. 删除队列项被拒（该项已被并发消费）时，输入框不恢复任何内容，也不残留预览 URL。

单元测试：`packages/ui/test/conversationQueueEditAttachmentPreview.test.ts`
（覆盖可预览 MIME 判据、预览读取与回收、撤回附件 chip 的 `objectUrl` 归属）。
