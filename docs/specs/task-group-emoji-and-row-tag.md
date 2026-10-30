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
- **原存储字符不改写**：DB 里存的是用户选中的 Unicode 字符/grapheme；图片文件名映射只在渲染时计算，不把 DB 值改成文件名、codepoint 串或语言相关标签。
- **肤色语义不变**：选择器固定 `skinTone="none"`，不提供肤色选择入口；历史已存的带肤色字符仍按原字符读取和渲染。

### emoji 配置入口

> 修订记录：初版用「16 快捷 emoji 网格＋粘贴输入框」内嵌菜单，用户否决
> （输入 emoji 的方式不可接受）。改为 Instant APP 同款
> [frimousse](https://frimousse.vercel.app) 全量选择器（搜索＋分类＋预览）弹出对话框。
> 二次修订：frimousse 默认解析器从 emojibase CDN（cdn.jsdelivr.net）拉取
> locale 数据、失败时无限「加载中」，用户否决（不可接受网络依赖）。本版改为
> **本地打包数据**：依赖 `emojibase-data`，自写 `resolveEmojiData` 注入本地
> 数据，零网络请求。
> 三次修订：`6adf5f94` 直接在解析器里写带 `with { type: "json" }` 的动态
> import，但 Vite 8（Rolldown）不会解析这种动态 JSON import：产物保留
> `emojibase-data/...` 裸说明符、数据 chunk 成为孤儿，浏览器动态导入失败，
> frimousse 只 `console.error` 并保持 `data = null`，因此仍永久「加载中」。
> 本版改为 **locale wrapper 模块**：`emojibase-data-zh.ts` / `emojibase-data-en.ts`
> 顶层静态 import JSON（带 attributes），解析器只动态 import 这两个 TS 模块。
> 约束：生产产物不得出现 `emojibase-data/` 裸说明符，且 zh/en 数据 chunk
> 必须被入口 chunk 引用；由 Vite 生产构建回归测试守护。
> 四次修订：用户决定**内置官方 Noto Emoji Unicode 18 完整 PNG 72px 资源**，
> 不再使用第三方 `emoji-datasource-google@16` 雪碧图；删除系统 emoji 字体探测
> （旧 canvas 蓝/红像素比较的极性问题整体移除，不靠反转极性继续使用），
> 不做「系统字体支持度」过滤，不以缺图过滤选择器目录。数据仍由本地
> `emojibase-data` 提供，图片全部随应用打包。

分组头三处入口的 emoji 项全部改为**打开 `EmojiPickerDialog`**
（`workspace-grouped-tasks/emoji-picker-dialog.tsx`），不在菜单/下拉内嵌面板：

1. 头部颜色点下拉（`group-item.tsx`）：emoji 区保留当前值预览与「清除」，
   「选择」项打开对话框。
2. 分组右键菜单「更改 Emoji」项：打开对话框；「清除 Emoji」直接清除。
3. 吸顶头（`sticky-group-header.tsx`）镜像同一份。

选择器用 `frimousse`（MIT，无头 React emoji picker，peer `react ^18 || ^19`，
动态 import 懒加载不进首屏包；参考实现 `instant-app/src/ui/emoji-picker-popover.tsx`）。
**表情数据本地化**（`workspace-grouped-tasks/frimousse-local-data.ts`）：

- `packages/ui` 依赖 `emojibase-data`（与 frimousse 默认 CDN 同源同构的数据包）；
  每个 locale 一个 wrapper 模块（`emojibase-data-zh.ts`／`emojibase-data-en.ts`），
  在模块顶层静态 import 对应 `data.json`＋`messages.json`；解析器按 locale
  dynamic import 这两个 TS 模块，保持按语言分块、未用语言不加载。
- 解析器把 emojibase 原始结构转换为 frimousse `EmojiData` 内部结构（分类、标签、
  肤色、国旗标记），口径与 frimousse 默认解析器一致。
- **解析器不做图片可用性过滤，也不做 canvas/字体探测**：zh/en 数据保持
  emojibase 的全量条目；图片缺失或历史未知字符是渲染层兜底问题，不能反向
  裁剪选择器目录。数据集按 locale 内存缓存，重复打开不重复导入。
- **零网络请求**：不访问 emojibase CDN，无 etag revalidation，无 localStorage
  数据缓存；数据与 wrapper 都随构建产物本地加载，离线可用。
- **唯一数据/cache owner**：`frimousse-local-data.ts` 是 locale 数据加载、
  结构转换、按 locale 缓存的唯一所有者；其他模块不得另建 emoji 数据缓存或
  重复转换。

#### 本地图片资源（唯一资源 owner：UI 静态目录）

图片资源唯一存放在 UI 包静态目录：

- `packages/ui/src/assets/noto-emoji/`

来源锁定为官方 Noto Emoji：

- 仓库：`googlefonts/noto-emoji`
- tag：`v2026-09-24-unicode18_0`
- commit：`e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e`
- 非旗帜资源：`2D/png/72` 共 3,736 个
- 旗帜资源：`third_party/region-flags` 共 262 个（源文件使用 ISO 名称，
  入库时按同一 Unicode 文件名规则重命名）
- 合计：**3,998 个 key，缺失 0，总计 16,541,769 字节**
- **固定来源必须干净**：vendor 只接受 commit 精确匹配的本地 checkout；复制或读取
  的受控路径（`2D/png/72`、`third_party/region-flags/png` 及被保留的许可文件）
  不得存在 tracked 修改、删除或 untracked 文件。存在未提交改动时 vendor 直接失败，
  禁止把工作区内容标成固定 upstream。
- 覆盖范围包含肤色变体；不使用第三方 16 版 `emoji-datasource-google` 雪碧图。

统一文件名规则：

```
emoji_u<codepoint1>_<codepoint2>_...png
```

- 每个 code point 使用**小写十六进制**、`padStart(4, "0")`；多个 code point
  用下划线连接。
- 去掉 `FE0F`/`FE0E` 变体选择符，**保留 ZWJ（`200D`）和 tag 字符**。
- 示例：
  - `U+1F680` → `emoji_u1f680.png`
  - `U+1F468 U+200D U+1F469 U+200D U+1F467` →
    `emoji_u1f468_200d_1f469_200d_1f467.png`
  - `#️⃣`（`0023 FE0F 20E3`）→ `emoji_u0023_20e3.png`
  - `U+1F1E8 U+1F1F3`（中国国旗）→ `emoji_u1f1e8_1f1f3.png`
  - `U+2764 U+FE0F` → `emoji_u2764.png`
  - 英格兰 tag 序列 → `emoji_u1f3f4_e0067_e0062_e0065_e006e_e0067_e007f.png`

**资源锁与构建门禁**：

- 同目录维护 `noto-emoji.lock.json`，记录 source repo、tag、commit、
  两个 source collection 的个数、3,998 key、16,541,769 字节、统一文件名规则、
  每个文件的 SHA-256（或等价的目录清单哈希），以及许可标识。
- 资源锁是唯一版本来源；禁止运行时从网络、npm CDN 或系统字体目录取图。
- 构建/测试期执行**全量覆盖校验**（不在运行时）：
  1. 实际目录文件数、字节数、文件名规则和哈希与锁一致；
  2. 将 emojibase zh/en 数据的 base、`skins` 和 `aliases` 归一化为同一 key
     集合，逐一断言存在对应 PNG，当前 missing = 0；
  3. 断言资源 key 无重复、无锁外文件；
  4. 每个文件必须是有效 PNG：PNG 签名、IHDR 长度/类型和正尺寸；vendor 必须
     从固定 commit 的 git tree 解析 mode `120000` 的单层相对 PNG 目标，不能
     复制 `core.symlinks=false` 工作区里的目标文本占位；
  5. vendor 复制前校验受控源路径的 git status，tracked/untracked 改动均拒绝；
  6. 任一条失败阻止构建/合入。
- 图片必须是**独立静态文件**输出，禁止被 Vite `assetsInlineLimit` 内联成
  data URL；否则「图片懒载」和资源锁都会失真。构建配置或导入方式需显式
  排除 `noto-emoji` 目录的内联（具体实现方式由实现代理选择，但产物必须
  保持 3,998 个独立 PNG 文件）。
- 构建生成只读的 **key 索引**（仅字符串集合，不含图片二进制、不读写文件
  系统）；`EmojiGlyph` 用 `BASE_URL + noto-emoji/<key>.png` 拼 URL，图片字节
  仍由 `<img>` 按需请求。
- 许可：Noto Emoji 的图片资源按官方 README 为 Apache-2.0；字体目录为
  OFL-1.1，但本方案不使用字体；`third_party/region-flags` 为公共领域或
  其上游声明的免版权资源。固定 commit 的**完整 README** 按字节原样保留为
  source 证据，`2D/svg/LICENSE` 的 Apache-2.0 原文继续保留。必须在
  `third-party/copied-components.json`、
  `third-party/inventory.json` 与 `THIRD-PARTY-NOTICES.md` 登记对应
  资源根、来源 commit 与许可原文，并运行
  `node scripts/licenses.mjs notices` / `check`。

#### 单 EmojiGlyph 渲染

所有可见的任务组 emoji 统一经 `workspace-grouped-tasks/emoji-glyph.tsx`
的同一个 `EmojiGlyph` 渲染，禁止任何组件直接输出 emoji 字符文本：

- `EmojiGlyph` 用资源 API 的 `emojiAssetUrl` 把原字符归一化为 key 并拼 URL，
  渲染固定尺寸的本地 `<img>`（`loading="lazy"`、`decoding="async"`、
  `alt=""`、`aria-hidden="true"`、`draggable="false"`）；父级
  button/`Badge`/菜单项继续提供文本语义。
- 使用位置：
  - `EmojiPickerPanel` 的网格 `Emoji` 与底部 `ActiveEmoji`；
  - `TaskGroupColorMark`（普通分组头、吸顶头、拖拽 overlay）；
  - `TaskGroupTag`（时间线完整 pill、按项目/置顶 compact 圆）；
  - `CreateGroupDialog` 的 emoji 方块；
  - `group-item.tsx` / `sticky-group-header.tsx` 的「更改 Emoji」菜单项。
- 固定显示尺寸：picker 网格 20px、预览 18px、行 Tag/颜色圆 16px、
  创建对话框 20px、菜单项 16px；emoji 不再用 `text-[15px]`、
  `text-[16px]`、`text-xl` 等字体字号决定大小（无 emoji 时的标题首字
  仍沿用原文本尺寸）。
- **未知历史字符或图片加载失败**：只渲染同尺寸的中性本地图标
  （Lucide `Smile`，由 `EmojiGlyph` 统一兜底），不得回退到系统 emoji
  字符/字体，也不得显示豆腐块。缺字段（`emoji` 为 `undefined`）仍沿用既有
  规则：颜色圆 `Hash`、Tag 首 grapheme、创建对话框 `SmilePlus`、菜单不显示。
- `EmojiGlyph` 只允许持有**组件内瞬时失败态**（用于 `onError` 切换中性图标），
  不进入 Zustand、DB、localStorage/sessionStorage，不构成新的状态 owner；
  失败态按当前 URL 重新挂载，切换 emoji 后不得沿用上一个字符的失败状态。

**加载策略**：

- 语言数据：仍按 locale dynamic import wrapper，未使用语言不加载。
- 图片：key 索引只含字符串；图片字节由 `loading="lazy"` 在进入视口时按需
  请求，启动阶段不预取 3,998 张图，也不在运行时扫描目录。

对话框内：搜索框（zh placeholder）＋
分类虚拟滚动列表＋底部预览；**选中即回调并关闭**，无粘贴输入框。
系统组（cron／闲时）允许配 emoji，但禁止重命名与解散的既有约束保留。

「新建分组对话框」（`CreateGroupDialog`，见 task-flat-menu-move-to-group.md）的
emoji 入口是**名称 Input 左侧的单个正方形方块**（两者共享一行，方块与 Input 同高）：
无 emoji 时虚线边框＋占位图标（lucide `SmilePlus`），有 emoji 时显示
`EmojiGlyph`；点击方块打开同一个 `EmojiPickerDialog`；有 emoji 时方块右上角
常显小 × 角标（独立 button 绝对定位，button 不得嵌套）点击清除——选择与
清除统一在方块一个控件上，不再有「更改 Emoji／清除 Emoji」独立按钮。

失败语义：`updateGroupEmoji` 失败时 hook 回滚乐观视图并 `refresh()` 收敛，toast `taskGroup.emojiFailed`。中英文案新增 `taskGroup.emoji/changeEmoji/clearEmoji/emojiFailed` 与 `taskGroup.createDialog.*`。frimousse 返回单个 emoji，写入前仍走 `normalizeTaskGroupEmojiForWrite` 单 grapheme 归一化（脏值防线保留）。

#### Dialog 宽度与横向溢出

- 真实 `DialogContent` 使用 `sm:max-w-xs`（外壳最大 320px），默认 `p-4` + 1px
  border，**内容盒约 286px**；旧夹具只渲染 320px 裸面板，不能代表真实弹窗。
- 面板根、Search、Viewport、List、Row、Emoji 按钮都必须允许收缩
  （`min-w-0` / `min-h-0` / `max-w-full`），Emoji 按钮内部固定尺寸图片，
  禁止文本 glyph 以 min-content 撑宽 flex/grid。
- 修复只发生在 `emoji-picker-panel.tsx` 与 `emoji-picker-dialog.tsx` 的局部
  用法：不得修改共享 `components/ui/dialog.tsx` 来掩盖本面板的溢出。
- 验收必须在 320px 外壳、286px 内容盒下覆盖 zh/en 两种语言，断言面板、
  Viewport 无横向滚动，页面无横向滚动条。

### 行 Tag 位置

- 时间线行（`variant="timeline"`）：第二行（`TaskListItem.tsx:686-729`）工作区名 `workspaceLabel`（`:688`）同级之后：`[工作区名] [分组Tag] …… 时间 归档按钮`。
- 按项目行与置顶行（`variant="default"`，无独立第二行）：标题行内标题之后、时间元信息之前（`TaskListItem.tsx:758-788` 附近）。
- 无所属组时直接不渲染，不占位，行高不变。
- Tag 只展示、不可点：点击跳转、按组过滤、hover 卡片都不做。

### Tag 形态与坍缩

新组件 `TaskGroupTag`，复用 `Badge` 基类（`components/ui/badge.tsx:7-26`）与 `TASK_GROUP_COLOR_CLASS` 色板，不新建设计语言：

- 完整态（`compact` 缺省）：`[图标段 ＋ 文本段]` pill。图标段＝`EmojiGlyph`
  16px（有 emoji）或标题首字（无 emoji），`shrink-0`；文本段＝组标题
  `truncate`。图片固定尺寸后不再需要 15px 字号和基线位移。
- 紧凑态（`compact`）：圆形 Tag（`rounded-full`），只渲染图标段（16px
  `EmojiGlyph`，无 emoji 则组名首 grapheme）＋组颜色背景；`title` 悬浮显示
  「emoji 组名」全名。由行型静态决定（单行行用紧凑态），不做 JS 宽度测量。
  尺寸 26px；圆整体 `-translate-y-px` 上移 1px（父级标题行盒 `h-6`，26px 圆
  实测偏下，用户拍板）；**图片 glyph 自身不再做 `-translate-y-px`**。
- 分组头颜色圆（`TaskGroupColorMark`）：与紧凑 Tag 同尺寸（26px 圆、
  16px `EmojiGlyph`、无 emoji 时 `Hash` 图标 16px），配了 emoji 的组圆内
  显示图片替代 `#` 图标（分组头下拉触发钮、吸顶头、拖拽 overlay 三处同源）。
  触发按钮同步放到 26px，避免圆被旧 20px 按钮裁剪。分组头标题内不再渲染
  行内 emoji 前缀（曾与圆内 emoji 同时存在 → 同一个火箭出现两次，且两处
  字号受各自容器约束必然一大一小；用户以截图指出后删除）。emoji 的可见
  承载唯一化为颜色圆；`title`/`aria-label` 仍保留「emoji 组名」前缀供悬浮
  提示与读屏。
- 不再使用 Apple Color Emoji 的 ink/size 实测规则（22px→25×26 等）；
  72px 源图缩放到 16px 后四周自然留白，视觉居中由 flex 布局保证。
- 坍缩（纯 CSS，无 JS 测量）：pill 外层 `shrink-0`＋`max-w`，文本段可压缩，
  图标段 `shrink-0` 永不压缩。空间被挤时文本先被挤掉，极窄只剩图标——即
  “不够只剩一字／emoji＋颜色背景”。
- 首字取值：`Intl.Segmenter` 首 grapheme（非首字符，避免切开组合字）。
- `title` 属性保留组全名；右键移动菜单组项（`task-context-menu-content.tsx`
  与扁平菜单 `TaskActionMenuContent.tsx` 两处）：
  - 有 `emoji`：显示 16px `EmojiGlyph`，取代颜色点；不额外加颜色圆/背景，
    该项不构成与分组头颜色圆的重复；
  - 无 `emoji`：保留原 `TaskGroupColorDot` 颜色点规则；
  - 扁平菜单当前组前的勾选/占位不变，`TaskGroupMenuItem` 类型与数据不变。
    `emoji?` 已在类型中，构造点与等值函数不再改动。
    分组头标题本身不再带行内 emoji（见上条）。

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
Dialog 打开
  -> emoji-picker-dialog lazy import panel（既有）
  -> frimousse resolver 按 locale 动态 import 本地 wrapper（既有数据 owner）
  -> EmojiGlyph 从本地 UI 静态目录按需加载图片（loading=lazy）
  -> 用户选择字符
  -> normalizeTaskGroupEmojiForWrite（既有单 grapheme 防线）
  -> services.updateGroupEmoji（既有持久化链路，不改协议）
  -> sqlite task_groups.emoji（唯一真相）
  -> task_meta_changed -> grouped view refresh / TagMap 失效重拉
  -> 时间线、按项目、置顶、分组头、菜单、拖拽全部经同一个 EmojiGlyph 渲染
```

- 唯一真相源：sqlite `task_groups.emoji` 列；行 Tag 无第二份缓存（Map 由
  structure 派生，随失效重建）。
- 本地图片资源是只读静态资产；`frimousse-local-data.ts` 是唯一的数据与
  cache owner；`EmojiGlyph` 只做字符→文件名、`<img>` 绘制和瞬时失败兜底，
  不保存业务状态。
- 不新增 Zustand store、不新增 localStorage/sessionStorage、不新增图片缓存
  owner；浏览器 HTTP 缓存不算应用状态。
- 服务端、协议命令字不动；调用走 `services.zcodeTaskService` 直调。

## 负面边界

- 多标签不做：`task_group_members` 主键 `(workspace_key,task_id)` 决定一会话最多一组。
- 不做 Tag 点击、过滤、跳转、hover 卡片。
- emoji 不进搜索、不进排序、不替代颜色语义（左侧竖线与 `TASK_GROUP_COLORS` 不动）。
- `zcode-protocol*` 不加命令字；`schema-v1.ts` 原文与旧 migration checksum 不动。
- 拖拽入组、重命名、解散、组颜色行为不动；远程 workspace 行的固定归类不动。
- **不以图片缺失过滤目录**，不改写原存储字符，不增加肤色选择，不按系统字体/
  canvas 支持度过滤。
- **不改变本次范围外的非 group 组件规则**：`TaskGroupColorDot`、`Badge`、
  `Dialog`、`Input`、下拉/右键菜单、拖拽等既有非 emoji 语义保持不变；
  本 spec 只替换任务组 emoji 的可见承载。
- **不修改共享 Dialog**；320px 外壳的宽度/裁剪问题只能在
  `emoji-picker-dialog.tsx` 与 `emoji-picker-panel.tsx` 的局部布局修正。
- 不使用第三方 16 版雪碧图、不访问 CDN、不使用系统 emoji 字体作为兜底，
  不把 3,998 张图片内联进 JS。

## 验收

1. 分组头配 emoji（对话框内搜索/分类选一个＋清除），刷新后三处一致，分组头
   左侧颜色圆内显示**本地图片**（同组标题前**不**再重复一份 emoji），右键
   移动菜单与扁平任务菜单的组项有 emoji 时显示同一个 `EmojiGlyph`（无 emoji
   仍显示颜色点）。
2. 时间线行第二行工作区名后出现 Tag；单行按项目行标题后与置顶行标题后出现
   **紧凑圆形** Tag（图片或首字＋组颜色）；圆内图片与圆边留有可见间隙、
   不压边不溢出；无组任务行无 Tag 且行高不变。
3. 收窄侧栏到标题与工作区名被挤：时间线行 Tag 文本先被截断，极窄时只剩首字
   或 emoji 图片＋颜色背景 pill，时间与归档按钮始终可点，控制台无报错。
4. 远端任务、archived 任务行无 Tag；非法 emoji 点确定后 toast 失败且不落库；
   提交失败回滚到操作前。
5. **未知历史字符/图片 404/解码失败**：显示同尺寸中性本地图标（如 Lucide
   `Smile`），不显示系统 emoji、豆腐块或原始字符文本；组件内失败态不写入
   store/DB。
6. **真实 Dialog**：320px 外壳、约 286px 内容盒，zh/en 下 search、网格、
   预览均无横向溢出，Viewport 无横向滚动，页面无横向滚动条；不得通过修改
   共享 Dialog 实现。
7. **懒载与离线**：未打开选择器不加载 frimousse/语言数据；图片只在
   `EmojiGlyph` 进入视口时按需请求；Electron/Desktop（`base: "./"` 的
   `file://` 页面）与 Web（HTTP 静态资源）均能加载；全程无外部网络请求、
   无 canvas 字体探测、无 localStorage/sessionStorage frimousse 键。
8. **构建与资源门禁**：
   - 产物无 `emojibase-data/` 裸 import；zh/en locale chunk 每个至少 100 KB
     且被入口 chunk 相对路径引用；Node 侧 `resolveLocalEmojiData` 对 zh/en
     返回全量 emojibase 条目（不做缺图过滤）。
   - 资源目录与 `noto-emoji.lock.json` 完全一致：3,998 个 PNG、
     16,541,769 字节、tag/commit 正确、每个文件哈希匹配；
     emojibase 数据归一化 key 全覆盖、missing = 0。
   - 3,998 张图片以独立静态文件输出，未被内联；产物无 `cdn.jsdelivr.net`、
     `fonts.googleapis.com` 等外部 URL；构建图可解析。
9. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿；
   新增与回归单测全过。
