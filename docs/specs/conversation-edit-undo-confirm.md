# Spec: 编辑撤销确认走通用确认框

## 目标

中间轮 / 末轮编辑提交前的「撤销并重发」确认不再使用定制弹窗，改走全局通用确认框（`ConfirmDialogHost` + `useConfirmDialogStore`）。有可恢复文件时不再渲染文件清单，只在描述里提示文件数量，并用通用框自带的 `checkbox` 副选项表达「是否同时恢复文件」。顺带继承通用框的键盘手势（`Enter` 确认 / `Esc` 关闭）与按钮上的 `esc` / `⏎` 提示。

## 现状与根因

定制弹窗 `EditTruncateConfirmDialog`（`packages/ui/src/v4/ConversationRowView.tsx`）直接套底层 Radix `Dialog`，无 `onKeyDown`、无 `autoFocus`、按钮无快捷键提示，所以 `Enter` 无反应。它之所以存在，是因为它多做了两件通用框表达不了的事：逐行渲染 `preview.safeFiles` 文件清单，以及底部三按钮（取消 / 不动文件 / 含文件恢复）。通用框只有标题 + 纯文本描述 + 取消 / 确认两按钮，但自带 `checkbox` 副选项（`ConfirmDialogRequest.checkbox`，已有推荐模型开关在用），足以把「是否恢复文件」从平级第三按钮降级为 Checkbox，于是定制弹窗的存在理由消失。

## 产品规则

1. 提交先做 `previewFileRewind` 三态分流（`resolveEditFileRewindDialogDecision` 不变）：`conversationOnly` → 纯对话确认；`withFiles` → 带 Checkbox 的确认；`conflict` → 原冲突弹窗 `ConversationFileRewindDialog`，三选语义不变。
2. 无文件：`requestConfirmation({ title: 撤销并重发, description: 中间轮 N 轮文案 / 末轮重生成文案, confirmLabel: 撤销并重发, confirmVariant: "destructive", testId: TID_V4_EDIT_UNDO_CONFIRM_DIALOG })`。`true` 才提交（`preserve`），`false` 则清掉暂存不提交。
3. 有可恢复文件（`safeFiles.length = N`）：`requestChoice({ ...同上, description: 对话后果 + 文件数量提示, checkbox: { label: 同时恢复 N 个文件 } })`。`confirm` 且勾选 → `workspaceMode: "rewind"`；`confirm` 未勾选 → `"preserve"`；`cancel` / `dismiss`（含单例占位被直接 resolve）一律清掉 `pendingSubmit / pendingFileRewind / fileRewindPreview`，不提交。
4. Checkbox 默认不勾选（通用框无默认勾选能力，不为此改通用组件）。即默认语义为「不动文件」，与之前主按钮默认「含文件恢复」相反——这是收敛的明确代价，opt-in 更保守。
5. `preview` 不可用（无 `entityId` / 接口缺失）或 `preview` 失败：降级为规则 2 的纯对话确认，不阻塞编辑。
6. 键盘手势继承通用框：`Enter` 确认（Checkbox 聚焦时保留焦点语义，不劫持）、`Esc` / 点遮罩关闭。`Undo & Send` 确认按钮 `autoFocus`，按钮带 `esc` / `⏎` 提示。
7. `Checkbox → workspaceMode` 映射由纯函数 `resolveUndoWorkspaceMode(restoreChecked: boolean): "rewind" | "preserve"` 承载（`conversationEditFileRewindDialog.ts`），便于单测。

## 状态所有权

- 确认框的打开 / 结算状态唯一 owner 是 `useConfirmDialogStore`（全局单例）。行组件不再持有 `undoConfirmOpen` 本地开关。
- `pendingSubmit`（待提交文本）、`pendingFileRewind` / `fileRewindPreview`（冲突路径用）仍归行组件所有；通用框关闭后由行组件负责清理。
- `ConversationProjectionStore` / 提交后 `blocked` 兜底链路不动。

## 事件顺序

```text
编辑卡 ↑ 提交
  → setPendingSubmit({text})
  → previewFileRewind? 无 → 通用纯对话确认 → confirm? handleSubmitEdit(text, preserve) : 清理
  → previewFileRewind? 有 → await preview
      → conversationOnly → 通用纯对话确认（同上）
      → withFiles → 通用 Checkbox 确认 → confirm? handleSubmitEdit(text, checked?rewind:preserve) : 清理
      → conflict → 原冲突弹窗（pendingFileRewind/conflictPreview 置位，setConflictOpen(true)）
      → preview 失败 → 通用纯对话确认（同上）
提交后 blocked（preview 已变化）→ 原冲突兜底路径不变
```

## 失败语义

- 通用框单例被占用（已有 pending 请求）：`requestChoice` 直接 resolve `dismiss`，按规则 3 的 dismiss 处理——清理暂存、不提交，不抛错。
- 组件在等待确认期间被卸载 / 编辑卡被动关闭：确认结果返回后若 `onEdit` 已不可用则不提交；取消路径只做状态清理。

## 负面边界

- `ConversationFileRewindDialog` 冲突三选（unsafe / ignored、`external_modified` 覆盖）不碰。
- `ConfirmDialog.tsx` / `confirmDialogStore.ts` 一行不改：不加默认勾选、不加第三按钮、不加自定义内容插槽。
- `preview` 获取链路、`resolveEditFileRewindDialogDecision`、提交后 `blocked` 兜底不动；`PermissionDialog` / `ElicitationDialog` 等其他弹窗不动。
- 不再展示逐文件清单（路径 + 操作数）；文件数量只进描述与 Checkbox 文案。

## 迁移边界

- 删除 `EditTruncateConfirmDialog` 组件及其 `undoConfirmOpen` 状态；删除文案 `filesTitle / confirmWithFiles / confirmKeepFiles`（中英）；删除 `TID_V4_EDIT_UNDO_CONFIRM` / `TID_V4_EDIT_UNDO_CONFIRM_KEEP_FILES`，`TID_V4_EDIT_UNDO_CONFIRM_DIALOG` 改为通用请求的 `testId` 继续使用。
- 新增文案 `chat.edit.undoConfirm.descriptionWithFiles`（文件数量后缀）与 `chat.edit.undoConfirm.restoreFiles`（Checkbox 标签），中英各一条。
- `conversationEditFileRewindDialog.test.ts` 不变（决策函数没动）；新增 `resolveUndoWorkspaceMode` 单测。

## 验收标准

1. 中间轮无文件：通用确认框标题「撤销并重发」，描述含 N 轮、无 Checkbox；`Enter` 提交重发，`Esc` / 取消 / 点遮罩关闭且不提交；取消按钮有 `esc`、确认按钮有 `⏎` 且自动聚焦。
2. 有可恢复文件：描述提示文件数量、不列清单，有「同时恢复 N 个文件」Checkbox 默认不勾选；直接确认 → 对话重发且文件不动；勾选后确认 → 含文件恢复。
3. 冲突文件：行为不变，仍弹原冲突弹窗。
4. `preview` 失败：降级为纯对话确认，不阻塞编辑。
5. `pnpm typecheck`、`pnpm lint` 通过；`packages/ui` 相关单测通过。
