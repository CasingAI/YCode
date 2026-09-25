# Spec: 键盘快捷键设置中的停止生成命令

## 目标

“设置 → 键盘快捷键”中的所有命令都必须来自 `SHORTCUT_COMMANDS`，并通过现有 `shortcutBindings` 覆盖、搜索、编辑、清除、冲突检测和恢复默认流程管理。

“停止生成”是一个保留型快捷键：固定使用默认的 `Escape`（展示为 `Esc`），不能通过快捷键设置编辑或删除；原操作列改为 Switch，关闭后停止快捷键失效，但停止按钮仍然可用。重新打开 Switch 后恢复默认 Esc。

## 产品规则

### 命令列表与设置控件

- “停止生成”直接显示在现有快捷键表格中，不新增固定快捷键区域或只读行。
- 命令 ID 为 `stopGeneration`，通道为 `window`，作用域为 global，设置控件类型为 `toggle`。
- 默认绑定为 `Escape`，使用现有 `Kbd` 展示为 `Esc`。
- `stopGeneration` 的键帽和作用域只读，不显示键帽编辑按钮、铅笔或清除按钮；原操作列显示 Switch。
- Switch 开启表示停止生成快捷键生效，关闭表示快捷键停用；固定键帽在关闭时仍保留但呈禁用视觉状态，不显示“未分配”占位。
- 其它命令继续使用普通绑定行、录制、清除、抢绑和恢复默认流程。

### Switch 持久化与恢复

- Switch 关闭时写入显式 `shortcutBindings.stopGeneration = []`，表示保留命令当前停用。
- Switch 重新开启时删除 `stopGeneration` 覆盖项，重新得到固定默认 `Escape`。
- 重新开启前检查默认 `Escape` 是否被同作用域其它命令占用；若被占用，保持关闭并提示冲突，不产生同键双动作。
- “全部恢复默认”清除所有覆盖后，停止生成 Switch 自动回到开启状态。
- 旧版可能遗留的非空 `stopGeneration` 覆盖不作为自定义绑定生效；保留型命令的生效表将其归一为固定默认 `Escape`，直到用户关闭 Switch。

### 录制与其它 Esc 语义

- 快捷键录制态按 Escape 仍表示取消录制；本次不把 Escape 重新定义为普通命令的录制结果。
- 其它普通命令仍可以使用 Backspace 恢复默认；停止生成不进入行内录制态。
- Dialog 和其它浮层的事件优先级不变：消费了事件的 Dialog 不触发停止生成。

## 状态所有者与数据流

停止生成的运行时行为仍由当前 SessionPane 拥有，因为停止操作依赖 focused、readOnly、sessionId 和 canStop 状态：

```text
SHORTCUT_COMMANDS(stopGeneration.settingsControl = "toggle")
  + settings.shortcutBindings
  → resolveEffectiveShortcutBindings
  → SessionPane.matchesShortcutBinding
  → focused/readOnly/canStop + dialog 过滤
  → handleStop("shortcut")
  → dispatchCommand("stop")
```

- `SessionPane` 是停止命令的运行时唯一所有者。
- `settings.shortcutBindings` 只拥有保留命令的启用状态以及其它普通命令的可配置覆盖。
- 停止按钮绕过键盘匹配，继续直接调用 `handleStop("button")`。
- `useAppKeyboard` 不添加全局 stop handler，避免丢失 pane owner 语义；没有 handler 的命令由其专用消费方处理。

## 接口

- `packages/shared/src/shortcutCommands.ts`：为命令表增加 `settingsControl`，并把 `stopGeneration` 标记为 `toggle`。
- `packages/ui/src/shortcuts/bindings.ts`：保留型命令只接受显式空覆盖作为停用状态；未覆盖或旧版非空覆盖均解析为固定默认绑定。
- `packages/ui/src/shortcuts/conflicts.ts`：增加保留型 Switch 的覆盖表构造函数；启用前的默认键冲突预检仍由设置 Section 负责。
- `packages/ui/src/settings/ShortcutSettingsSection.tsx`：向保留型行提供启用状态和 Switch 回调，复用默认键冲突预检。
- `packages/ui/src/settings/ShortcutBindingRow.tsx`：为保留型命令固定渲染默认键帽，并在操作列渲染 Switch。
- `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts`：增加 Switch 的无障碍文案。
- 不修改设置服务、协议字段、setting.json 迁移或桌面菜单；命令仍是 window 通道。

## 不变量

- `SHORTCUT_COMMANDS` 是停止生成快捷键的唯一命令事实来源。
- `parseShortcutBinding("Escape")` 合法，裸 `Escape` 只在没有额外主修饰键时命中。
- `stopGeneration` 的自定义非空覆盖不能改变运行时绑定；显式空覆盖明确表示停用。
- Switch 关闭时，SessionPane 不注册停止快捷键监听；停止按钮仍可用。
- 重新开启时若默认 Escape 已被占用，必须保持关闭并提示冲突。
- Dialog 或其他浮层消费停止快捷键时，不触发停止生成。
- 现有其它命令的默认键、作用域、冲突、编辑和录制语义保持不变。

## 负面边界

- 不展示独立“固定快捷键”区，也不保留 `ReadonlyShortcutBindingRow`。
- 不把停止生成 handler 放进 App 全局键盘表，不绕过 SessionPane 的 pane 门禁。
- 不修改停止按钮的点击行为、dispatchCommand 参数、只读分享页或其它 Esc 用途。
- 不把取消弹窗、取消行内编辑、取消快捷键录制、退出引导等行为加入命令表。
- 不修改协议字段、设置服务 API、setting.json 迁移或桌面菜单。
- 不改其它命令的默认键和冲突语义，不引入新的 UI/E2E 测试框架。
- 不执行浏览器、CDP、DevTools、UI 自动化或调试协议验收。

## 验收场景

1. 打开“设置 → 键盘快捷键”：普通列表中出现“停止生成”，固定显示 `Esc`，没有编辑和清除按钮，操作列显示开启状态的 Switch；页面没有独立固定区。
2. 关闭“停止生成”Switch：行仍显示 `Esc` 但呈禁用状态，`shortcutBindings.stopGeneration` 为显式空数组；focused 且可停止的生成会话按 Esc 不停止、不 `preventDefault`。
3. 关闭后点击停止按钮：仍能通过 `dispatchCommand("stop")` 停止生成。
4. 重新打开 Switch：覆盖被删除，Esc 恢复，重新按 Esc 可停止生成。
5. 关闭期间让其它普通命令绑定 Esc，再打开 Switch：提示默认键冲突，Switch 保持关闭，不产生同键双动作。
6. 旧版非空 `stopGeneration` 覆盖存在时：运行时仍使用固定 Esc，Switch 为开启；关闭后可写入空覆盖。
7. 其它命令的编辑、清除、抢绑、组合键搜索和全部恢复默认不回归；全部恢复默认会重新开启停止生成 Switch。
8. 中英文文案、窄屏布局和 Dialog 优先级不回归。
9. 目标代码测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 和本任务文件格式检查通过；不执行浏览器/UI 自动化验收。
