# Spec: 全局命令面板（Global Command Palette）

## 目标

在 Y Code 全局提供 VSCode 风格的命令面板入口，三条快捷键共用同一个命令中心浮层
（`packages/ui/src/command-center/CommandCenterDialog.tsx`），区别只在「打开时的初始范围」：

| 快捷键 | 快捷键命令 ID | 初始范围 | 语义 |
| --- | --- | --- | --- |
| `CmdOrCtrl+k` | `openCommandCenter` | `all` | 聚合搜索：命令 + 会话 + 文件（保持现状） |
| `CmdOrCtrl+p` | `openQuickOpen` | `files` | 快速打开：只搜工作区文件，回车在代码查看器打开该文件 |
| `CmdOrCtrl+Shift+p` | `openCommandPalette` | `commands` | 命令面板：只列应用命令 |

`CmdOrCtrl+p` 在 VSCode 里是「Go to File…」，`CmdOrCtrl+Shift+p` 是「Command Palette…」。
本 spec 把这两个入口落到 Y Code 已有的命令中心上，不新做浮层、不新做索引。

## 产品规则

### 入口与范围

- 三条入口都是应用级（跨 workspace）入口，与命令中心现有定位一致，不跟随当前 workspace 收敛。
- 初始范围只决定打开那一刻的范围 tab。用户仍可在浮层内手动切范围 tab；输入前缀
  （`>` = 命令、`#` = 会话、`@` = 文件）仍然优先于手动 tab（沿用 `specs/command-center-search.md` 的范围规则）。
- 浮层关闭时手动范围重置为 `all`（沿用既有语义）；下次打开时落到触发它的快捷键对应的初始范围。
  因此「Cmd+P 打开 → 切到命令 tab → 关闭 → 再按 Cmd+K 打开」回到 `all`，不残留上次的范围。
- 浮层已打开时再按另一条入口快捷键：不关闭重开，直接把范围切到新入口对应的范围
  （`Cmd+P` 打开后按 `Cmd+Shift+p` → 切到命令范围）。

### 快捷键命令表

- `SHORTCUT_COMMANDS`（`packages/shared/src/shortcutCommands.ts`）新增两条 `window` 通道、`global` 作用域命令：
  - `openQuickOpen`，默认绑定 `["CmdOrCtrl+p"]`
  - `openCommandPalette`，默认绑定 `["CmdOrCtrl+Shift+p"]`
- `openCommandCenter` 的默认绑定收窄为 `["CmdOrCtrl+k"]`。`CmdOrCtrl+Shift+p` 从
  `openCommandCenter` 移交给 `openCommandPalette`，同键不允许两条命令同时生效
  （否则一次按键触发两个入口）。
- 三条命令都出现在「设置 → 键盘快捷键」列表里，沿用普通绑定行的改键、清除、抢绑、
  组合键搜索与恢复默认流程。覆盖语义是整组替换，沿用 `resolveEffectiveShortcutBindings`。
- `CmdOrCtrl+p` 从系统保留键黑名单（`packages/ui/src/shortcuts/conflicts.ts`）移出：
  它原本是浏览器打印键，现在由 `openQuickOpen` 占用。用户把别的命令改绑到 `CmdOrCtrl+p`
  时按「被 app 内命令占用 → 二次确认抢绑」处理，与其它 app 内命令同规则，不再按保留键直接拒绝。
- 抢绑走的是「从占用者生效表里移除该绑定」，被抢命令因此少一条默认绑定而不是整组失效。

### 快速打开（`files` 范围）的文件匹配

- 文件匹配复用共享模糊打分实现（`packages/shared/src/workspaceFileSearch.ts` 的
  `mapWorkspaceFileEntriesToSearchCandidates` + `filterWorkspaceFileSearchCandidates`），
  与 `@` 文件候选、文件树搜索同一套打分与排序语义，命令中心不再维护第二份子串匹配。
- 打分对 `name` / `relativePath` / `path` 三路取最优，前缀命中优于子串命中，子串命中优于子序列命中。
- 候选映射（entry → candidate）在工作区文件索引加载后做一次（memo），不随每次键入重建。
- 结果条数上限沿用 `COMMAND_CENTER_FILE_RESULT_LIMIT`（80），排序即打分顺序。

### 打开文件的行为

- 命中文件行后回车，沿用命令中心既有的 `onOpenCodeViewer({ type: "file" })` 链路在代码查看器打开该文件，
  不新开文件树选中态、不新开编辑器 tab。

## 状态所有权

命令中心浮层的范围状态仍由 `CommandCenterDialog` 独占；App 层只持有一份「本次打开用哪个初始范围」的
打开意图，并作为 prop 传下去，不在 App 侧另存一份范围投影。

```text
键盘事件
  → useAppKeyboard（快捷键内核匹配生效表）
  → App.handleOpenCommandCenter(scope)：写打开意图（scope）+ 置 open
  → CommandCenterDialog.open 翻转 → 同步 manualScope = initialScope
  → 既有 activeScope 派生（显式前缀 > manualScope）→ 既有分区渲染
```

- 快捷键命令表 `SHORTCUT_COMMANDS` 是快捷键的唯一事实来源；生效表由
  `resolveEffectiveShortcutBindings`（默认绑定 + 用户覆盖）计算。
- `manualScope` 的唯一所有者是 `CommandCenterDialog`；App 不读、不写、不缓存范围状态。
- 打开意图（scope）由 App 持有，随浮层开合同步；这是「一次性打开参数」，不是范围事实。

## 接口

- `packages/shared/src/shortcutCommands.ts`：新增 `openQuickOpen`、`openCommandPalette` 两条命令与 ID；
  `openCommandCenter` 默认绑定收窄为 `["CmdOrCtrl+k"]`。
- `packages/ui/src/shortcuts/conflicts.ts`：保留键黑名单移出 `CmdOrCtrl+p`。
- `packages/ui/src/command-center/CommandCenterDialog.tsx`：新增 `initialScope` prop（缺省 `all`），
  打开/切换时同步 `manualScope`；文件分区改用共享模糊打分。
- `packages/ui/src/App.tsx`：登记 `openQuickOpen` / `openCommandPalette` 两个 window 通道 handler，
  持有并下发打开意图 scope。
- `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts`：新增两条命令的设置页文案。

## 不变量

- 同一物理键组合在同一时刻只属于一条命令（`CmdOrCtrl+Shift+p` 归 `openCommandPalette` 独有）。
- 打开意图 scope 不覆盖用户显式输入的前缀：`>`/`#`/`@` 仍然优先于初始范围。
- 关闭浮层后手动范围回到 `all`，不跨次打开残留。
- 文件匹配只有一份实现：命令中心、文件树、`@` 候选共用 `workspaceFileSearch` 的打分与排序。
- `CmdOrCtrl+p` 不再是保留键，但仍受占用检测与抢绑二次确认保护，不产生同键双动作。
- 命令中心既有能力（会话搜索、AI 搜索、搜索历史、仅标题/包含已归档开关）不回归。

## 负面边界

- 不新做独立浮层、独立页面或独立搜索索引；三个入口复用同一个命令中心。
- 不改命令中心既有分区语义：会话分区的 AND 关键词匹配、snippet 规则、搜索历史写入规则不变。
- 不改桌面应用菜单（`desktopApplicationMenu.ts`）：不新增「Go to File…」菜单项，
  快捷键由 renderer 窗口通道分发，菜单 accelerator 体系不扩张。
- 不改协议字段、设置服务 API、`setting.json` 迁移。
- 不引入浏览器 / CDP / DevTools / UI 自动化验收。

## 验收场景

1. 在任意 workspace 焦点下按 `Cmd/Ctrl+P`：命令中心浮层打开，范围 tab 落在「文件」，
   输入关键词后只出现文件结果分区，回车在代码查看器打开该文件。
2. 按 `Cmd/Ctrl+Shift+P`：浮层打开，范围 tab 落在「操作」，只列应用命令，输入关键词可过滤。
3. 按 `Cmd/Ctrl+K`：浮层打开，范围 tab 落在「全部」，行为与改动前一致（命令 + 会话 + 文件）。
4. 浮层已打开（`files` 范围）时按 `Cmd/Ctrl+Shift+P`：浮层不关闭重开，范围切到「操作」。
5. `Cmd/Ctrl+P` 打开 → 手动切到「操作」→ 关闭 → 再按 `Cmd/Ctrl+K` 打开：范围回到「全部」，不残留。
6. `Cmd/Ctrl+P` 打开 → 输入 `>`：显式前缀生效，范围切到「操作」，与初始范围无关。
7. 在「设置 → 键盘快捷键」里把「打开设置」改绑到 `Cmd/Ctrl+P`：提示该键已被「快速打开」占用，
   二次确认后抢绑成功，「快速打开」不再响应 `Cmd/Ctrl+P`，不出现同键双动作。
8. 在「设置 → 键盘快捷键」里把「快速打开」的键清空：`Cmd/Ctrl+P` 不再打开浮层，
   其它入口不受影响。
9. 文件搜索输入 `mdc` 这类非连续子串的关键词：能命中 `markdown-code.ts` 这类文件（模糊匹配），
   排序按打分（更短的匹配路径排前面）。
10. 现有命令中心能力不回归：会话搜索、仅标题 / 包含已归档开关、搜索历史、AI 搜索行为不变。
11. 中英文文案、窄屏布局与浮层优先级不回归。
12. 目标代码测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
