# Spec: 分组 emoji 配置与任务行分组 Tag

## 目标

两件事一次做完：给分组加可配置的 `emoji` 字段（含选择入口）；在时间线行、按项目列表行、置顶行三处任务行的工作区名后面显示所属组的 Tag；空间不足时 Tag 坍缩到只剩一个字，有 emoji 则只剩 emoji＋颜色背景。

> 正交语义修订：置顶（pinned）与分组是正交维度——置顶管「排在哪里」
> （置顶区在所有视图模式下常驻），分组管「属于哪里」。
> 置顶行与单行按项目行打 compact 圆形 Tag（只渲染图标段），双行时间线行保持完整 pill。

## 产品规则

### emoji 存取

- `ZCodeTaskGroup` 新增可选 `emoji?: string`；sqlite `task_groups` 新增 `emoji TEXT` 列（经 `0004_group_emoji` migration 幂等加列，`schema-v1.ts` 原文与旧 migration checksum 绝不动）。
- 存的是**单个 grapheme cluster**（`Intl.Segmenter` 切分取首个），空字符串即清除（存 NULL/空串，读出为 `undefined`）。
- 写前校验：首 grapheme 必须含扩展象形文字（`\p{Extended_Pictographic}`）或为区域指示符对／ZWJ 序列；多字符输入只取首个合法 grapheme，无合法 grapheme 则拒绝写入并 toast `taskGroup.emojiFailed`。
- 读侧兜底：历史脏数据（多字符、非 emoji 文本）**只读不写**，按空处理，不在读路径回写 DB。
- emoji 不参与标题搜索（`searchable_text` 口径不动）、不参与排序、不参与颜色语义；分组头 `title` 字符串本身不动（emoji 独立字段，不拼进 title，避免污染搜索与重命名）。

### emoji 配置入口

> 修订记录：初版用「16 快捷 emoji 网格＋粘贴输入框」内嵌菜单，用户否决
> （输入 emoji 的方式不可接受）。本版统一改为 Instant APP 同款
> [frimousse](https://frimousse.vercel.app) 全量选择器（搜索＋分类＋预览）弹出对话框。

分组头三处入口的 emoji 项全部改为**打开 `EmojiPickerDialog`**
（`workspace-grouped-tasks/emoji-picker-dialog.tsx`），不在菜单/下拉内嵌面板：

1. 头部颜色点下拉（`group-item.tsx`）：emoji 区保留当前值预览与「清除」，
   「选择」项打开对话框。
2. 分组右键菜单「更改 Emoji」项：打开对话框；「清除 Emoji」直接清除。
3. 吸顶头（`sticky-group-header.tsx`）镜像同一份。

选择器用 `frimousse`（MIT，无头 React emoji picker，peer `react ^18 || ^19`，
自带 zh locale 与表情数据，动态 import 懒加载不进首屏包；参考实现
`instant-app/src/ui/emoji-picker-popover.tsx`）。对话框内：搜索框（zh placeholder）＋
分类虚拟滚动列表＋底部预览；**选中即回调并关闭**，无粘贴输入框。
系统组（cron／闲时）允许配 emoji，但禁止重命名与解散的既有约束保留。

「新建分组对话框」（`CreateGroupDialog`，见 task-flat-menu-move-to-group.md）的
emoji 入口是**名称 Input 左侧的单个正方形方块**（两者共享一行，方块与 Input 同高）：
无 emoji 时虚线边框＋占位图标（lucide `SmilePlus`），有 emoji 时显示 emoji；
点击方块打开同一个 `EmojiPickerDialog`；有 emoji 时方块右上角常显小 × 角标
（独立 button 绝对定位，button 不得嵌套）点击清除——选择与清除统一在方块一个控件上，
不再有「更改 Emoji／清除 Emoji」独立按钮。

失败语义：`updateGroupEmoji` 失败时 hook 回滚乐观视图并 `refresh()` 收敛，toast `taskGroup.emojiFailed`。中英文案新增 `taskGroup.emoji/changeEmoji/clearEmoji/emojiFailed` 与 `taskGroup.createDialog.*`。frimousse 返回单个 emoji，写入前仍走 `normalizeTaskGroupEmojiForWrite` 单 grapheme 归一化（脏值防线保留）。

### 行 Tag 位置

- 时间线行（`variant="timeline"`）：第二行（`TaskListItem.tsx:686-729`）工作区名 `workspaceLabel`（`:688`）同级之后：`[工作区名] [分组Tag] …… 时间 归档按钮`。
- 按项目行与置顶行（`variant="default"`，无独立第二行）：标题行内标题之后、时间元信息之前（`TaskListItem.tsx:758-788` 附近）。
- 无所属组时直接不渲染，不占位，行高不变。
- Tag 只展示、不可点：点击跳转、按组过滤、hover 卡片都不做。

### Tag 形态与坍缩

新组件 `TaskGroupTag`，复用 `Badge` 基类（`components/ui/badge.tsx:7-26`）与 `TASK_GROUP_COLOR_CLASS` 色板，不新建设计语言：

- 完整态（`compact` 缺省）：`[图标段 ＋ 文本段]` pill。图标段＝emoji（有）或标题首字（无），显式 15px（继承 Badge 的 `text-ui-xs` 时 emoji 位图字形只有 ~11px 几乎不可读，用户实测反馈「火箭太小」），与文本段保持行内基线对齐不加位移；文本段＝组标题 `truncate`。
- 紧凑态（`compact`）：圆形 Tag（`rounded-full`），只渲染图标段（emoji，无则组名首 grapheme）＋组颜色背景；`title` 悬浮显示「emoji 组名」全名。由行型静态决定（单行行用紧凑态），不做 JS 宽度测量。尺寸 26px、图标字号 16px（见下方实测依据）。垂直居中：父级标题行盒 `h-6`（24px），26px 圆实测渲染偏下，圆整体 `-translate-y-px` 上移 1px（用户拍板；此前给字形加位移是修反了方向，已撤销——该动的是圆，不是字形）。
- 分组头颜色圆（`TaskGroupColorMark`）：与紧凑 Tag 同尺寸（26px 圆、emoji 字号 16px、无 emoji 时 `Hash` 图标 16px），配了 emoji 的组圆内显示 emoji 替代 `#` 图标（分组头下拉触发钮、吸顶头、拖拽 overlay 三处同源）。触发按钮同步放到 26px，避免圆被旧 20px 按钮裁剪。分组头标题内不再渲染行内 emoji 前缀（曾与圆内 emoji 同时存在 → 同一个火箭出现两次，且两处字号受各自容器约束必然一大一小；用户以截图指出后删除）。emoji 的可见承载唯一化为颜色圆；`title`/`aria-label` 仍保留「emoji 组名」前缀供悬浮提示与读屏。
- 圆内 emoji 字号 16px 的实测依据（Apple Color Emoji 是位图字体，`font-size` 与 ink bbox 不是 1:1）：22px→ink 25×26px（＝26px 圆内径，零边距，所以用户截图里圆内火箭「超出圆盘」）；20px→24×25；18px→23×24；17px→23×23；16px→22×22（四周留 2px）；14px→20×20。DPR1/DPR2 实测 ink 尺寸相同，可迁移到 Retina。取 16px；该字号下 ink 中心比 line box 中心低 1px（位图字形 ascent 大于 descent），圆内 emoji span 再 `-translate-y-px` 回正视觉居中。
- 坍缩（纯 CSS，无 JS 测量）：pill 外层 `shrink-0`＋`max-w`，文本段可压缩，图标段 `shrink-0` 永不压缩。空间被挤时文本先被挤掉，极窄只剩图标——即“不够只剩一字／emoji＋颜色背景”。
- 首字取值：`Intl.Segmenter` 首 grapheme（非首字符，避免切开组合字）。
- `title` 属性保留组全名；右键移动菜单组项显示 emoji（`TaskGroupMenuItem` 加 `emoji?`，构造点与等值函数同步）——该项左侧没有颜色圆，不构成重复；分组头标题本身不再带行内 emoji（见上条）。

### Tag 数据源

- 新建共享 hook（如 `useTaskGroupTagMap`）：入参本地 workspace tabs，内部一次 `listGroupedTaskViewStructure` 建 `Map<entityKey, ZCodeTaskGroup>`（key＝`buildTaskWorkspaceKey＋taskId`，与 `useFlatTaskGroupMenu.ts:98-109` 同构）；失效时机与 `membershipVersion`／`task_meta_changed` 对齐；远端 scopes 不查。
- 三处 section（时间线、按项目经 `WorkspaceSidebarItem`、置顶区）各挂一次，行级只做 `map.get` 查表。**禁止**在行内逐行复用 `useFlatTaskGroupMenu`（N 行 N 次 RPC）。
- `MemoTaskItem` 加可选 `groupTag?: {id,title,color,emoji?}｜null` 与 `groupTagCompact?: boolean`，
  比较函数 `areTaskListItemPropsEqual:113-137` 加等值分支（Tag 只比四字段、compact 比值，不比对象身份），否则 memo 击穿。
- 行型决定形态：置顶行（`WorkspacePinnedTasksSection`）与单行按项目行（`TaskList.tsx`，`variant="default"`）
  传 `groupTagCompact`——空间窄，直接圆形形态，不再依赖挤压坍缩；
  双行时间线行（`WorkspaceTimelineTasksSection.tsx`，`variant="timeline"`）维持完整 pill（纯 CSS 坍缩兜底保留）。

### 排除口径

分组与置顶正交：凡持有 membership 的任务行都打 Tag（含置顶，置顶行用 compact 圆形形态）。
一律不打 Tag 的：远端任务（`remoteSessionId`／remote store 行）、`archived`、带 `workspaceIdentity` 的任务。
归档区（`WorkspaceArchivedTasksFlatSection`）口径为 archived，不打 Tag。

## 状态所有者与事件顺序

```
配 emoji：分组头菜单 → updateGroupEmoji 乐观改 view → updateTaskGroupEmoji
        → task_meta_changed → grouped 视图 refresh；三处行经 TagMap 失效重拉收敛
读 Tag：section 挂 hook → listGroupedTaskViewStructure 一次 → Map 查表 → 行渲染
```

- 唯一真相源：sqlite `task_groups.emoji` 列；行 Tag 无第二份缓存（Map 由 structure 派生，随失效重建）。
- 服务端、协议命令字不动；调用走 `services.zcodeTaskService` 直调。

## 负面边界

- 多标签不做：`task_group_members` 主键 `(workspace_key,task_id)` 决定一会话最多一组。
- 不做 Tag 点击、过滤、跳转、hover 卡片。
- emoji 不进搜索、不进排序、不替代颜色语义（左侧竖线与 `TASK_GROUP_COLORS` 不动）。
- `zcode-protocol*` 不加命令字；`schema-v1.ts` 原文与旧 migration checksum 不动。
- 拖拽入组、重命名、解散、组颜色行为不动；远程 workspace 行的固定归类不动。

## 验收

1. 分组头配 emoji（对话框内搜索/分类选一个＋清除），刷新后三处一致，分组头左侧颜色圆内显示 emoji（同组标题前**不**再重复一份 emoji），右键移动菜单组项带 emoji。
2. 时间线行第二行工作区名后出现 Tag；单行按项目行标题后与置顶行标题后出现**紧凑圆形** Tag（emoji 或首字＋组颜色）；圆内 emoji 与圆边留有可见间隙、不压边不溢出；无组任务行无 Tag 且行高不变。
3. 收窄侧栏到标题与工作区名被挤：时间线行 Tag 文本先被截断，极窄时只剩首字或 emoji＋颜色背景 pill，时间与归档按钮始终可点，控制台无报错。
4. 远端任务、archived 任务行无 Tag；非法 emoji 点确定后 toast 失败且不落库；提交失败回滚到操作前。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿；新增与回归单测全过。
