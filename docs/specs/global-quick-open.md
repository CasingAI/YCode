# Spec: 全局快速打开（Global Quick Open）

## 目标

`CmdOrCtrl+p`（macOS ⌘P / Windows·Linux Ctrl+P）全局唤起「快速打开」：切到文件中心，
把焦点交给文件搜索框，输入即搜工作区文件，回车在 Monaco 编辑器里打开命中的文件。

对齐 VS Code 的 Quick Open（"quickly search and open a file by its name"）——
它是一个**文件**入口，不是命令入口。

```text
⌘P → 文件中心（files 主视图）→ 文件搜索框（聚焦 + 全选）→ 输入即搜 → 回车打开
```

## 关键决策：为什么不接命令中心

Y Code 已经有命令中心（`packages/ui/src/command-center/CommandCenterDialog.tsx`，
⌘K / ⌘⇧P 唤起），它是**聚合搜索浮层**：命令 + 会话 + 文件三合一，还带 AI 会话搜索、
搜索历史、「仅标题 / 包含已归档」开关。⌘P 不复用它，原因：

- 语义不同。命令中心是「不知道要什么，先搜一圈」；快速打开是「我要打开某个文件」。
- 落点不同。命令中心的文件区走 `onOpenCodeViewer`（右侧**只读**代码查看器）；
  快速打开要落在 Monaco 编辑器 tab（`filesEditorStore.requestOpenPath`），
  与文件树点击、聊天里的文件链接同一条路。
- 能力不同。命令中心是浮层，输入框有自己的查询状态机；文件中心本来就有
  工作区文件索引 + 模糊搜索（打分在 Web Worker 里跑），输入即搜是它的原生行为。

因此 ⌘P **不进入命令中心**，也不改动命令中心的任何行为。

## 产品规则

### 入口

- 快捷键命令 ID `openQuickOpen`，通道 `window`，作用域 global，默认绑定 `CmdOrCtrl+p`。
- `CmdOrCtrl+p` 从系统保留键黑名单移出（原本是浏览器打印键）。
  改绑到别的命令时按「被 app 内命令占用 → 二次确认抢绑」处理，与 app 内其它命令同规则。
- 命令中心入口不受影响：`openCommandCenter` 保持 `CmdOrCtrl+k` 与 `CmdOrCtrl+Shift+p` 双默认。

### 唤起行为

1. 切到文件中心（files 主视图）。已在文件视图时不重复切换。
2. 把焦点交给文件资源管理器的搜索框，并**全选**已有内容——
   用户一打字就替换掉上一次的搜索词，不用先手动清空。
3. 不清空搜索框：搜索框里已有的内容是用户自己的搜索意图，⌘P 只接管焦点。

### 搜索行为

- 输入即搜索，沿用文件中心既有能力：工作区文件索引（packed）+ 共享模糊打分，
  打分在 Web Worker 里执行（大仓库不卡主线程）。
- 结果按打分排序（分数越小越靠前：前缀命中 → 子串命中 → 子序列命中）。
- 命中结果回车或点击，在 Monaco 编辑器打开该文件（`filesEditorStore.requestOpenPath`），
  与文件树点击、聊天里的文件链接同一条链路。

### 路径识别

用户从终端、编辑器状态栏或文件管理器复制路径粘进搜索框时，系统要能认出
「这就是那个文件的路径」并直接定位到它，而不是把它当关键词丢进模糊搜索。

- 归一化：去首尾空白、去掉首尾成对引号（终端复制常带引号）、反斜杠统一成正斜杠。
- 精确命中判定：绝对路径与 `entry.path` 完全相等，或相对路径与 `entry.relativePath`
  完全相等（相对路径比较忽略大小写，macOS/Windows 文件系统默认大小写不敏感）。
- 精确命中项**置顶**在结果列表第一位；共享打分器同时给精确命中最低分
  （`getWorkspaceFileSearchCandidateScore` 返回 `-1`），保证它不会被结果条数上限截断。
- 未命中精确路径时按普通模糊搜索处理，不报错、不空列表。

## 状态所有权

聚焦请求是**一次性打开参数**，唯一所有者是 `filesEditorStore`：

```text
⌘P（App 层 useAppKeyboard）
  → filesEditorStore.requestSearchFocus()   // searchFocusRequestId + 1
  → FilesExplorerPane 读 searchFocusRequestId
  → WorkspaceFileTree 消费：搜索框 focus() + select()
```

- `searchFocusRequestId` 是请求号而不是布尔量：请求可能在文件视图挂载前发出，
  挂载后消费同一个请求号依然生效（与 `taskFindFocusRequestId` 同款模式）。
- 搜索词本身归文件树（`fileSearchQuery`），本 spec 不新增第二份搜索状态。
- 命中的文件在 Monaco 编辑器里的打开状态归 `filesEditorStore`，本 spec 不碰。

## 接口

- `packages/shared/src/shortcutCommands.ts`：新增 `openQuickOpen` 命令与 ID。
- `packages/shared/src/workspaceFileSearch.ts`：`getWorkspaceFileSearchCandidateScore`
  增加精确路径命中判定（返回 `-1`）。
- `packages/ui/src/shortcuts/conflicts.ts`：保留键黑名单移出 `CmdOrCtrl+p`。
- `packages/ui/src/files-workbench/filesEditorStore.ts`：新增 `searchFocusRequestId`
  与 `requestSearchFocus()`。
- `packages/ui/src/files-workbench/FilesExplorerPane.tsx`：把聚焦请求号传给文件树。
- `packages/ui/src/workspace-file-tree/types.ts`：`WorkspaceFileTreeProps` 新增
  `searchFocusRequestId`。
- `packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx`：消费请求号，聚焦并全选搜索框。
- `packages/ui/src/workspace-file-tree/workspaceFilePathMatch.ts`（新增）：路径归一化与
  精确命中查找（纯函数）。
- `packages/ui/src/workspace-file-tree/useWorkspaceFileSearchIndex.ts`：把精确命中项置顶。
- `packages/ui/src/App.tsx`：登记 `openQuickOpen` handler（切视图 + 发起聚焦请求）。
- `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts`：新增命令的设置页文案。

## 不变量

- 同一物理键组合在同一时刻只属于一条命令（`CmdOrCtrl+p` 归 `openQuickOpen` 独有）。
- 快捷键命令表 `SHORTCUT_COMMANDS` 是快捷键的唯一事实来源。
- 打开文件只有一条落点链路：`filesEditorStore.requestOpenPath` → Monaco 编辑器。
- 文件打分只有一份实现：文件中心搜索、`@` 文件候选、命令中心文件区共用
  `workspaceFileSearch` 的打分与排序。
- 精确路径命中一定排在结果第一位。
- 命令中心的行为、范围 tab、搜索历史、AI 搜索不受本 spec 影响。

## 负面边界

- 不新起浮层、不做独立面板；⌘P 落在文件中心既有 UI 上。
- 不把快速打开接到命令中心，不给命令中心加「初始范围」参数。
- 不做符号跳转（`:func` / `@symbol`）、不做 Git 提交跳转、不做行号跳转。
- 不做工作区外文件的打开：路径识别只在当前工作区索引内命中。
- 不改命令中心自身的聚合搜索语义与 AI 会话搜索。
- 不改桌面应用菜单（不新增「Go to File…」菜单项），快捷键由 renderer 窗口通道分发。
- 不改协议字段、设置服务 API、`setting.json` 迁移。
- 不引入浏览器 / CDP / DevTools / UI 自动化验收。

## 验收场景

1. 任意视图下按 `Cmd/Ctrl+P`：切到文件中心，文件搜索框获得焦点且已有内容被全选。
2. 在搜索框输入 `app`：结果按模糊打分列出工作区文件，回车在 Monaco 编辑器打开该文件。
3. 输入 `mdc`：能命中 `markdown-code.ts` 这类非连续子串的文件（共享模糊打分）。
4. 粘贴一个工作区内的绝对路径：该文件被识别为精确命中并排在结果第一位，回车打开它。
5. 粘贴一个工作区内的相对路径（`src/hooks/useFoo.ts`）：同样被识别并置顶。
6. 粘贴带引号的路径（终端复制常见形态 `"src/a.ts"`）：引号被去掉后正确识别。
7. 粘贴一个工作区内不存在的路径：按普通模糊搜索处理，不报错、不空列表。
8. 搜索框已有内容时按 `Cmd/Ctrl+P`：内容不被清空，但被全选，直接打字即替换。
9. 在「设置 → 键盘快捷键」里把「打开设置」改绑到 `Cmd/Ctrl+P`：提示该键已被「快速打开」
   占用，二次确认后抢绑成功，不出现同键双动作。
10. `Cmd/Ctrl+K` 与 `Cmd/Ctrl+Shift+P` 仍打开命令中心，行为与改动前一致。
11. 命令中心的会话搜索、AI 搜索、搜索历史、「仅标题 / 包含已归档」开关不回归。
12. 目标代码测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
