# Spec: Composer 组合输入期间的程序化写入与可编辑态让渡

## 目标

语音输入法（手机听写、桌面语音输入法）在 contenteditable 里通常不是「一个词一次提交」，而是**把整段口述作为一个长组合串持续上屏**，中途不断修正，最后才 `compositionend`。这段时间里编辑器 DOM 里的文字属于浏览器的组合态，Lexical 的 state 只是跟随。

Web 端 composer 有两类动作会在组合进行中**打断浏览器组合**，导致整段已识别文字被丢弃，只剩打断之后重新开始组合的那一小段：

1. **程序化写入编辑器。** 草稿恢复（`restorePersistedComposerDraftIntoInput`）、外部文本预填（`applyExternalTextInsertRequestToComposer`）、队列撤回（`applyComposerRestoreRequestToComposer`）、发送收尾 `clear()`、mention/命令预填，最终都落到 `setText` / `setEditorStateJson` / `setTextWithMentions` / `setMention` / `clear`。这些实现都是 `root.clear()` 后整树重建（或 `editor.setEditorState`）再 `selectEnd()`，正在组合的文本节点被直接删除。
2. **可编辑态翻转。** `EditablePlugin` 每次 `disabled` 变化都同步 `editor.setEditable(!disabled)`，把 `contentEditable` 从 `true` 改成 `false`。`disabled` 由远端快照驱动（`connecting` / `errored` / `draftRuntimeRebuilding` / `queueEditActiveForCurrentComposer` / `quotaBanner.state.blocksSubmit`），会在用户口述期间自行翻转；`draftRuntimeRebuilding` 更是 agent runtime 被回收（CUA helper 就绪、liveness 恢复）时**无人操作也会发生**。

本 spec 规定：composer 的组合态是程序化写入的**排他区**。组合期间不写树、不切可编辑态、不做会切分文本节点的装饰重算；这些动作排队到 `compositionend` 之后执行，且同一目标只应用最后一次请求。

## 产品规则

### 一、组合期间不写树

- 判定口径：**组合态** = 编辑器 root 上 `compositionstart` 之后、`compositionend` 之前，或 `editor.isComposing()` 为真。两者取「或」，不单独依赖任一方：`editor.isComposing()` 在部分浏览器/时序下不可靠，组合事件是明确信号；反过来 `editor.isComposing()` 覆盖嵌套/程序化组合。
- 受约束的写入（全部经 `LexicalChatInput` 的 `editorApiRef` 对外暴露）：`clear`、`setText`、`setTextWithPluginMentions`、`setTextWithMentions`、`setEditorStateJson`、`setMention`、`setSkillMention`、`setSlashCommandMention`、`insertMention`、`prependMentionIfMissing`、`appendText`、`appendFileMention`。
- 排队语义：每个写入按**目标键**登记（文本类共用一个键，`clear` 单独一个键）。组合期间同一键只有最后一次请求有效——草稿恢复连发两次不会被回放两次，也不会先恢复旧值再恢复新值。
- 执行时机：`compositionend` 处理（Lexical 自身组合收尾之后、同一事件内）按登记顺序执行。执行时不再二次判断组合态，否则排队项会被永久丢弃。
- **读不受影响**：`getMarkdown` / `getEditorState` / `getText` 与 `snapshotDraftOfEditor` 照常返回当前值。组合期间 DOM 是事实源，`onChange` 已经把组合文本同步进草稿；读取不做推迟，避免发送门禁、字数显示与草稿落盘拿到过期文本。

### 二、组合期间不切可编辑态

- `EditablePlugin` 收到新的 `editable` 值时先判断组合态：不在组合 → 立即 `setEditable`；在组合 → 只记录目标值，`compositionend` 后应用。
- 多次翻转只保留最后一次（`disabled` 抖动不该在组合结束后留下错误状态）。
- 组件卸载不补应用：卸载后编辑器实例不再被渲染，避免对已卸载 root 写属性。

### 三、组合期间不做会切分节点的装饰重算

- `GoalScopeDecorationPlugin` 的 `normalizeGoalScopeDecoration` 会在 token 处 `splitText`。组合期间跳过，`compositionend` 之后由下一次 TextNode transform 补算（与 `TopLevelCommandPlacementPlugin` 既有的组合态门控同一口径：组合期不动树，结束后补）。
- 装饰是纯视觉，跳过期间只是少一次高亮刷新，不改变 canonical 序列化与发送内容。

### 四、边界与不做的事

- **不改草稿持久化时机**：正文仍在每次 onChange 同步进内存草稿，350ms 防抖补充 Lexical JSON。本 spec 只约束「写回编辑器」，不约束「写草稿」。
- **不改组合态下用户输入的既有行为**：`onChange`、`recordInputLag`、Enter/Backspace 的 `isComposing` 门控、mention/slash 面板重算的既有判定保持原样。
- **不引入 UA 判定**：不使用 `navigator.userAgent` 区分平台，组合事件与 `editor.isComposing()` 在所有平台语义一致。
- **不做「组合态禁止发送」之外的新门禁**：发送键的 `isComposing` 判断已由 `KeyboardPlugin` 与 `PromptHistoryPlugin` 覆盖，本 spec 不新增。

## 状态与事件顺序

```
用户口述（长组合）
  compositionstart（root 监听）
    └─ compositionGate.active = true
  beforeinput(insertCompositionText) / input
    ├─ Lexical 把 DOM 文本同步进 state → TextContentPlugin → onChange → 草稿（照常）
    └─ 任意程序化写入请求（草稿恢复 / 外部预填 / clear / mention）
         └─ runWhenCompositionSettles(editor, key, action)
              active === true → pending[key] = action（同 key 覆盖，只留最后一次）
    └─ editable 变化（disabled 翻转）
         └─ pendingEditable = editable（只留最后一次）
  compositionend（Lexical 收尾后）
    ├─ active = false
    ├─ 若 pendingEditable !== null → editor.setEditable(pendingEditable)
    └─ 按登记顺序执行 pending，清空队列
  之后每次输入
    └─ 组合态为假 → 程序化写入与 setEditable 立即执行（与改动前完全一致）
```

## 验收场景

1. **长组合期间恢复草稿**：组合进行中触发 scope 恢复 → 编辑器内容在组合期间不变；`compositionend` 后只应用最后一次恢复请求，组合文本已随 `onChange` 进入旧 scope 草稿。
2. **组合期间发送收尾**：提交确认回调到达时仍在组合 → `clear()` 排队；组合结束后编辑器清空一次，不发生「先清后补」的闪烁。
3. **组合期间 `disabled` 抖动**：`errored → false → errored` 连续翻转 → 组合期间 `contentEditable` 不变；结束后只应用最后一次目标值。
4. **组合结束后连续写入**：连续两次 `setText` → 排队合并为最后一次，组合文本不被中途回放覆盖。
5. **非组合路径零变化**：`isComposing()` 为假且无组合事件时，所有写入与 `setEditable` 都是同步执行，时序与改动前逐字一致（行内编辑卡的 `initialValue` 回填、explicit 聚焦路径不受影响）。
