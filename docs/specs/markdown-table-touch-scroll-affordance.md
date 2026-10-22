# Spec: 触屏端 Markdown 表格的横向滚动常驻提示

## 目标

手机远控（`http://<desktop-ip>:58059/task/<taskId>`）里，assistant 正文中的 Markdown 表格横向溢出时被直接裁掉，且**没有任何可发现的横向滚动入口**：

- 表格内容超出容器宽度后，右侧单元格被视口边界截断（例：`yield 文本生成（含 "full transcript are preserved" 说明）` 在 390px 视口下被截成 `…are preser`）。
- 桌面端那条常驻的虚拟滚动条在触屏上**永远不显示**。
- 原生滚动条又被 `!scrollbar-hide` 整条移除。
- 唯一的溢出提示是右侧那一道 24px 的边缘阴影，强度只有 15% 黑色渐变，在深色主题下几乎不可见。

结果：用户在手机上既看不出「右边还有内容」，也没有一条能拖动的滚动条可以拉。触屏端能滚动，但**滚动这条能力不可发现**。

本 spec 让触屏端常驻一条可见、可拖动的横向滚动条，使溢出成为可发现、可操作的事实；桌面端行为不变。

## 产品规则

### 适用范围

- 只作用于 `MarkdownTable`（`packages/ui/src/components/ai-elements/markdown-table.tsx`）的**虚拟横向滚动条**。表格本体的排版、折行、列宽规则都不在本 spec 范围内。
- 桌面端（`hover: hover`）行为**完全不变**：滚动条仍然是 hover 表格框时淡入、离开时淡出。

### 触屏端常驻

- **判据走媒体查询 `(hover: none)`，不走 JS 状态。** 与仓库既有触屏常驻先例同源（`ConversationRowView.tsx`、`ConversationTurnGroup.tsx`、`WorkspacePurposeSection.tsx`）。理由与消息操作行一致：**降噪只对有 hover 的设备有意义**，手机远控既没有指针悬停也没有 Tab 键，`group-hover/*` 永不匹配，`opacity-0` 会永久停在那里。
  - 不引入 store、hook 或 renderer 状态，也不必处理运行中插拔触摸设备后的重算：变体由 CSS 在每次样式求值时实时匹配。
- **常驻条件是「这张表确实横向溢出」，不是「设备是触屏」。** 滚动条的可见性仍由既有的 `virtualScrollbarVisible`（表格宽度超过可视槽宽）裁决；触屏变体只负责在已判定溢出时不要再等 hover。若表格不溢出，触屏端同样不显示这条滚动条——不制造无意义的控件。
- **两条变体同时生效，缺一不可。**
  - `[@media(hover:none)]:opacity-100`：让滚动条在触屏端可见。
  - `[@media(hover:none)]:pointer-events-auto`：让滚动条**可拖动**。仅加 `opacity-100` 会得到一条看得见但拖不动的死条，触屏用户仍然无法把内容拉出来。
- **命中区在触屏端要够大。** 桌面端 12px 高的 thumb 对手指来说太窄。触屏端把轨道加高到 20px、thumb 加高到 16px，视觉上仍是一条细杆，但手指能稳定按住。

### 桌面端降噪基线不得被顶掉

- `opacity-0` 基线、`group-hover/markdown-table-frame:opacity-100`、`group-hover/markdown-table-frame:pointer-events-auto` 三者必须保留。触屏变体只增加触屏路径的显形，不动桌面路径。
- 触屏变体必须排在 `opacity-0` 之后：Tailwind 把变体排在基础工具类之后，顺序反了媒体查询里的 `opacity-100` 会被后面的 `opacity-0` 盖掉，表现为「类名加了但仍然看不见」。

### 边缘阴影不作为唯一提示

- `MarkdownTableEdgeShadow` 保持原样（仍由 `scrollLeft` 驱动、仍是纯视觉装饰）。它给出「右边还有内容」的弱提示，但**不能**承担可操作性。
- 不因为新增常驻滚动条就移除边缘阴影：桌面端 hover 之前仍需要那道弱提示。

### 不得引入的副作用

- **不改表格排版。** 单元格折行、列宽、表格本体滚动容器的行为都不动。`max-w-md`(448px) 的列宽上限在 390px 视口下仍大于视口，表格仍需横向滚动——这是表格语义，本 spec 不改。
- **不与外壳侧栏右滑手势争夺触摸。** 侧栏手势的让位规则（`docs/specs/workspace-shell-swipe-gesture.md` 第 5 条）沿用现状：沿 `composedPath()` 找到「`overflow-x` 是 `auto`/`scroll` 且内容确实超宽」的祖先就放弃手势。表格的滚动 viewport 命中该条件，横向滑动归表格。
  - 新增的触屏常驻滚动条位于表格框**下方**、不在表格滚动 viewport 内部，因此不会改变这条让位判定：手指起手在表格内容上仍归表格滚动；起手在滚动条上时滚动条才接管。
- **不改虚拟滚动位置语义。** thumb 拖动、轨道点击跳转、`commitVirtualScrollLeft` 的统一映射逻辑都不动；本 spec 只改「什么时候看得见、能不能按到」。

## 状态所有者与事件顺序

```
MarkdownTable 渲染
  └─ virtualScrollbarVisible（表格宽 > 可视槽宽）——唯一的可见性裁决，未变
       ├─ 桌面（hover: hover）
       │    └─ opacity-0 → group-hover/markdown-table-frame 时 opacity-100（淡入）
       └─ 触屏（hover: none）
            └─ [@media(hover:none)]:opacity-100 常驻（不再等 hover）
                 └─ [@media(hover:none)]:pointer-events-auto → thumb 可拖动
                      └─ 拖动 → commitVirtualScrollLeft → viewport.scrollLeft
```

- 可见性真相仍只有 `virtualScrollbarVisible` 一处，触屏变体不新增 React 状态。
- 滚动位置真相仍只有 `virtualScrollLeft` / `viewport.scrollLeft` 一处（`commitVirtualScrollLeft` 统一入口），本 spec 不新增第二条滚动路径。

## 接口

- `packages/ui/src/components/ai-elements/markdown-table.tsx`：
  - 虚拟滚动条容器（`virtualScrollbarWrapperRef`）的 className 增加 `[@media(hover:none)]:opacity-100`。
  - 轨道（`virtualScrollTrackRef`）的 className 增加 `[@media(hover:none)]:pointer-events-auto`、`[@media(hover:none)]:h-5`；thumb 增加 `[@media(hover:none)]:h-4`。
- 不新增导出、不改公共 API、不新增文件。

## 已知限制

- **触屏端表格仍需横向滑动才能看完**，本 spec 只保证「可发现 + 可拖动」，不保证「一屏看全」。把宽表格在手机上重排成卡片列表是另一件事（涉及表格语义变更），不在本 spec 范围。
- **`(hover: none)` 覆盖的是混合设备**：带触摸屏的笔记本同时有鼠标时，媒体查询按主指针判定；这类设备上滚动条会常驻而不是 hover 淡入。这是可接受的降级，与仓库既有的消息操作行触屏常驻策略一致。
- **iOS Safari 的原生滚动条本来就没有**，本 spec 依赖的是自绘的虚拟滚动条，不受影响。

## 验收场景

1. 手机竖屏（约 390px）打开远控任务页，滚到一张横向溢出的 Markdown 表格：表格框**下方常驻一条可见的横向滚动条**，不需要 hover、不需要先点任何东西。
2. 同一张表：用手指按住滚动条上的滑块左右拖动，表格内容随之横向移动，滑块位置与内容进度一致。
3. 同一张表：用手指直接在表格内容上左右滑动，表格横向滚动，外壳侧栏不打开（沿用 `workspace-shell-swipe-gesture.md` 验收场景 5）。
4. 同一张表：手指按在滚动条上拖动时，不会顺带把整个会话页面横向拖走（`pointer-events-auto` 接管该区域）。
5. 桌面浏览器（1280px，有 hover）打开同一张表：滚动条**默认不可见**，鼠标悬停表格框时淡入、移开后淡出，与改动前一致。
6. 桌面浏览器里一张不横向溢出的窄表：任何时候都不显示滚动条。
7. 手机竖屏打开一张**不横向溢出**的窄表：不显示滚动条（触屏变体不制造多余控件）。
8. `pnpm typecheck`、`pnpm lint` 通过；新增的 `node --test` 用例通过。
