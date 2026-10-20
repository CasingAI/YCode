# Spec: 搜索中心（Search Center，⌘P 快速打开）

## 目标

`CmdOrCtrl+p`（macOS ⌘P / Windows·Linux Ctrl+P）全局唤起**搜索中心**：一个独立的顶部居中浮层，
输入即搜当前工作区文件，回车在工作台打开命中的文件。

对齐 VS Code 的 Quick Open（`workbench.action.quickOpen`）——它是**文件**入口，
与 Command Palette（⌘⇧P）是两个平级的浮层，只是共用同一套 QuickPick 外观。

```text
⌘P → 搜索中心浮层 → 输入即搜 → 回车 → 切到文件工作台 → 打开文件 → 编辑器获得焦点
```

## 关键决策：独立于命令中心，但复用命令中心的样子

Y Code 已经有命令中心（`packages/ui/src/command-center/CommandCenterDialog.tsx`，
⌘K / ⌘⇧P 唤起），它是**聚合搜索浮层**：命令 + 会话 + 文件三合一，还带 AI 会话搜索、
搜索历史、「仅标题 / 包含已归档」开关。

「独立」与「复用」说的是两件事，两者不冲突：

- **业务与状态独立**：搜索中心有自己的查询状态、自己的结果列表，不解析命令中心的前缀，
  不写命令中心的搜索历史，不带 AI 搜索，不带范围切换。命令中心的行为、范围 tab、
  搜索历史、AI 后台运行全部不受影响。
- **外观与交互复用**：搜索中心用命令中心同一套浮层外壳——顶部居中定位、宽度、圆角、
  遮罩、搜索框、加载指示、列表选中态、上下键 / 回车 / Esc 交互、平台适配与主题。
  这套外壳抽到 `packages/ui/src/quickpick/QuickPickSearchDialog.tsx`，两个中心共用。

两者的**落点**也必须不同：命令中心的文件区走 `onOpenCodeViewer`（右侧**只读**代码查看器）；
搜索中心要落在工作台编辑器（`filesEditorStore.requestOpenPath`），与文件树点击、
聊天里的文件链接同一条路。

## 产品规则

### 入口

- 快捷键命令 ID `openQuickOpen`，通道 `window`，作用域 global，默认绑定 `CmdOrCtrl+p`。
- `CmdOrCtrl+p` 从系统保留键黑名单移出（原本是浏览器打印键）。
  改绑到别的命令时按「被 app 内命令占用 → 二次确认抢绑」处理，与 app 内其它命令同规则。
- 命令中心入口不受影响：`openCommandCenter` 保持 `CmdOrCtrl+k` 与 `CmdOrCtrl+Shift+p` 双默认。

### 唤起行为

1. 任意主视图（聊天 / 文件 / 设置）下都打开搜索中心浮层。
2. **不切主视图**：底层视图、侧栏搜索词、文件树选中项都不变。
3. **不打开任何文件**：唤起只是打开浮层。
4. 已打开时再按 ⌘P：不再叠一层实例，也不切主视图，只把焦点交回搜索中心自己的输入框并全选查询。
5. 关闭后再打开：以空查询开始。

### 搜索行为

- 输入即搜。空查询时列出当前工作区**已打开**的文件，活动文件排在最前；
  没有已打开文件时只显示输入提示。不把标签顺序伪称为完整的最近访问历史。
- 有关键词时搜当前工作区的文件，结果按共享模糊打分排序（分数越小越靠前：
  前缀命中 → 子串命中 → 子序列命中），只返回文件，不返回目录。
- 加载中显示加载指示，不冒充最终空列表；失败显示可重试的错误；无命中显示无结果文案。
- 不创建不存在的文件。

### 路径识别

用户从终端、编辑器状态栏或文件管理器复制路径粘进搜索框时，系统要能认出
「这就是那个文件的路径」并直接定位到它，而不是把它当关键词丢进模糊搜索。

- 归一化发生在**查询与打分之前**：去首尾空白、去掉首尾成对引号（终端复制常带引号）、
  反斜杠统一成正斜杠。
- 精确命中判定：绝对路径与 `entry.path` 语义相等，或相对路径与 `entry.relativePath`
  语义相等（比较忽略大小写，macOS/Windows 文件系统默认大小写不敏感；路径分隔符等价）。
- 精确命中项**置顶**在结果列表第一位；共享打分器同时给精确命中最低分
  （`getWorkspaceFileSearchCandidateScore` 返回 `-1`），保证它不会被结果条数上限截断。
- 未命中精确路径时按普通模糊搜索处理，不报错、不空列表。
- 打开时使用服务返回的实际路径，不按客户端系统猜测远端路径或大小写。

### 确认与取消

- 回车或点击结果：关闭浮层 → 切到文件工作台 → 走 `filesEditorStore.requestOpenPath`
  打开目标文件 → 目标编辑器就绪后获得焦点。文本文件进入 Monaco，其他文件沿用工作台已有预览能力。
- Esc 或点击遮罩：只关闭浮层并恢复原焦点，**不切视图、不产生打开请求**。
- Esc 不得误停后台会话的生成（沿用浮层事件的停止生成屏蔽规则）。
- 取消时的焦点恢复不得覆盖确认后的编辑器焦点。

## 状态所有权

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| 当前打开哪一种搜索浮层 | App | 命令中心与搜索中心互斥，避免两个模态层叠加 |
| 本次查询与结果列表 | 搜索中心 | 不写入文件树状态，也不写命令中心历史 |
| 候选选择 | cmdk | 上下键只移动候选选择 |
| 文件索引与匹配事实 | 文件服务 | Host 侧有界搜索，Renderer 不下载全量索引 |
| 已打开文件与编辑器状态 | `filesEditorStore` | 不建立第二份打开文件列表 |
| 打开后的编辑器聚焦意图 | `filesEditorStore` | 与打开请求同一次写入，编辑器就绪时消费 |

```text
⌘P
  → App 打开搜索中心
  → 浮层自己的输入框获得焦点
  → 工作区文件服务返回候选
  → 上下键只移动候选选择
      ├─ 取消：关闭浮层，恢复原焦点，原视图不变
      └─ 确认：沿用 requestOpenPath（带聚焦意图）
                 → 切到文件工作台
                 → 现有打开链路加载或激活目标文件
                 → 目标编辑器就绪后获得焦点
```

切换工作区、连接实例变化、关闭浮层或新查询到来时，旧响应不能进入当前结果，
也不能被回车误打开。隔离键使用 `workspaceIdentity?.trim() || workspacePath`，
同时保留 `remoteSessionId` 和连接实例边界；远端未就绪时不回落到本机搜索。

## 接口

- `packages/shared/src/shortcutCommands.ts`：`openQuickOpen` 命令与 ID（保留）。
- `packages/shared/src/workspaceFileSearch.ts`：
  - 新增查询归一化（去空白、去成对引号、统一分隔符），在打分与过滤之前生效；
  - 精确路径命中判定（返回 `-1`），比较对路径分隔符等价。
- `packages/services/src/file/file.ts`：`WorkspaceFileSearchParams` 增加可选条目类型过滤，
  在 Host 的 top-K 截断之前生效，默认行为不变（现有文件 mention 仍可返回目录）。
- `packages/ui/src/quickpick/QuickPickSearchDialog.tsx`（新增）：无业务依赖的共享搜索浮层外壳，
  命令中心与搜索中心共用。
- `packages/ui/src/search-center/SearchCenterDialog.tsx`（新增）：搜索中心业务。
- `packages/ui/src/search-center/searchCenterState.ts`（新增）：浮层互斥状态与选中/取消意图的纯函数，
  不依赖 React，便于单测。
- `packages/ui/src/search-center/useSearchCenterFileSearch.ts`（新增）：防抖 + 有界结果的文件搜索，
  旧响应不进当前结果。
- `packages/ui/src/search-center/searchCenterOpenedFiles.ts`（新增）：空查询时的已打开文件列表，
  数据直接来自 `filesEditorStore`，不维护第二份状态。
- `packages/ui/src/files-workbench/filesEditorStore.ts`：
  - 删除 `searchFocusRequestId` / `requestSearchFocus`；
  - 新增打开后的编辑器聚焦意图（`editorFocusRequest`）。
- `packages/ui/src/files-workbench/FilesWorkbenchSurface.tsx`、
  `FilesEditorGroupPane.tsx`、`FilesMonacoEditor.tsx`：消费聚焦意图，编辑器就绪时获得焦点。
- `packages/ui/src/App.tsx`：登记 `openQuickOpen` handler（打开搜索中心），并托管两个浮层的互斥状态。
- `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts`：搜索中心文案。

## 不变量

- 同一物理键组合在同一时刻只属于一条命令（`CmdOrCtrl+p` 归 `openQuickOpen` 独有）。
- 快捷键命令表 `SHORTCUT_COMMANDS` 是快捷键的唯一事实来源。
- 打开文件只有一条落点链路：`filesEditorStore.requestOpenPath` → 工作台编辑器。
- 文件打分只有一份实现：文件树搜索、`@` 文件候选、命令中心文件区、搜索中心共用
  `workspaceFileSearch` 的打分与排序。
- 精确路径命中一定排在结果第一位。
- 命令中心的行为、范围 tab、搜索历史、AI 搜索不受本 spec 影响。
- 命令中心与搜索中心不会同时打开。

## 负面边界

- 不把搜索中心接到命令中心，不给命令中心加「初始范围」参数，不共用查询状态。
- 不做符号跳转（`:func` / `@symbol`）、不做 Git 提交跳转、不做行号跳转。
- 不做文件正文搜索、不做跨工作区搜索。
- 不做工作区外文件的打开：路径识别只在当前工作区索引内命中。
- 不改命令中心自身的聚合搜索语义与 AI 会话搜索。
- 不改桌面应用菜单（不新增「Go to File…」菜单项），快捷键由 renderer 窗口通道分发。
- 不改协议字段、设置服务 API、`setting.json` 迁移。
- 不引入浏览器 / CDP / DevTools / UI 自动化验收。

## 验收场景

1. 任意视图下按 `Cmd/Ctrl+P`：出现与命令中心同款的独立浮层；底层主视图、侧栏查询和文件树选择不变。
2. 在浮层输入 `app`：结果按模糊打分列出工作区文件，回车在文件工作台打开该文件。
3. 输入 `mdc`：能命中 `markdown-code.ts` 这类非连续子串的文件（共享模糊打分）。
4. 粘贴一个工作区内的绝对路径：该文件被识别为精确命中并排在结果第一位，回车打开它。
5. 粘贴一个工作区内的相对路径（`src/hooks/useFoo.ts`）：同样被识别并置顶。
6. 粘贴带引号的路径（终端复制常见形态 `"src/a.ts"`）：引号被去掉后正确识别。
7. 粘贴 Windows 风格路径（`src\a.ts`）：分隔符归一后正确识别。
8. 粘贴一个工作区内不存在的路径：按普通模糊搜索处理，不报错、不空列表。
9. 浮层已打开时再按 `Cmd/Ctrl+P`：不叠加实例，焦点回到输入框且查询被全选。
10. 关闭后再打开：查询为空；空查询时列出已打开文件，活动文件在前。
11. 按 Esc：浮层关闭、焦点回到原处，不切视图、不产生打开请求、后台生成不被停止。
12. 在「设置 → 键盘快捷键」里把「打开设置」改绑到 `Cmd/Ctrl+P`：提示该键已被「快速打开」
    占用，二次确认后抢绑成功，不出现同键双动作。
13. `Cmd/Ctrl+K` 与 `Cmd/Ctrl+Shift+P` 仍打开命令中心，行为与改动前一致；两个中心不同时打开。
14. 命令中心的会话搜索、AI 搜索、搜索历史、「仅标题 / 包含已归档」开关不回归。
15. 目标代码测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
