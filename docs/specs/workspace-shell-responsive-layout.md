# Spec: 工作区外壳的窄视口布局（单列 + 覆盖式面板）

## 目标

窄视口下把工作区外壳从「侧栏内联列 + 会话列」的双栏结构改成单列：会话列始终占满宽度，侧栏与右侧 Side Pane 改为覆盖层，由用户按需展开、随时关闭。宽视口（≥768px）的双栏观感逐像素不变。

这条规范同时消除一个此前的设计缺口：外壳原本只有「侧栏显隐」一个布尔状态，没有「呈现形态」这一层，于是「是否显示」被迫兼任布局模式。实现上是靠 `workspace resize` 的副作用去收紧侧栏，而手机首屏不触发 resize，导致窄屏首屏直接铺开双栏、会话列被压到约屏宽一半。

## 产品规则

### 形态判定

- **断点 768px**，与仓库既有的 `max-md:` 用法（`WorkspaceHeaderSections`、`markdown-table`）对齐。判定口径是 `(max-width: 767.98px)`：768px 整宽按宽视口处理。
- **判定只决定形态，不决定显隐。** 两根轴各自独立：
  - `isSidebarVisible`（用户意图，唯一状态源）决定侧栏内容是否显示；
  - 视口宽度决定它「内联占位」还是「覆盖浮层」。
- 窄视口下侧栏初始为收起。之后跟随用户操作，**不在用户切换断点时自动改写用户的显隐意图**——旋转屏幕不应该顶掉用户刚做的选择。
- 桌面 Electron 的窄窗口与 Web 同等生效，不按平台分支。

### 窄视口：侧栏抽屉

- 侧栏从左侧滑入，覆盖在会话列之上，宽度 `min(85vw, 320px)`。
- 展开/收起由 `translate-x` 表达，**抽屉宽度不随显隐变化**；宽度若同时归零，展开就变成挤压动画。
- 抽屉展开时渲染遮罩，点击遮罩即收起侧栏。
- 抽屉自带不透明表面（`bg-background` + 右边框 + 投影）。内联列铺在外壳背景上、不需要底色；抽屉浮在会话之上，缺底色会让两层文字互相叠印。
- **层级不变式：遮罩(z-10) < 抽屉(z-19) < 顶部浮层（`DesktopTopOverlay`，z-20）。** 抽屉刻意压在浮层之下，因此浮层里的侧栏切换按钮在抽屉展开时仍然可点，点它直接收起抽屉。侧栏自身不长出折叠控件，浮层里的入口始终是唯一的折叠/展开开关——这与 `mobile-remote-control.md` 的入口规则一致。
- **会话列内部的定位层必须被内容区关住。** 会话列自带输入区停靠层（z-10）与建议行（z-20），它们本是列内局部层级，但若不建立层叠上下文就会逃逸到根层叠上下文：遮罩(z-10)会因 DOM 顺序落后而被输入区盖住、点不到，抽屉(z-19)也会被 z-20 的建议行压过。因此窄视口给主内容区加 `isolate`，把列内层级关在里面。
- 宽度拖拽手柄在窄视口不渲染：覆盖层没有可拖拽的相邻边界。

### 窄视口：Side Pane

- Side Pane 从右侧滑入，宽度 `min(92vw, 420px)`，同样带点击关闭的遮罩。
- **Side Pane 的层级不能复用侧栏那一组。** 它渲染在主内容区内部，与会话列同处一个层叠上下文，而会话列自带 z-10/z-20，所以遮罩取 z-30、面板包裹层取 z-31，整体压过列内层级；侧栏抽屉在主内容区之外，仍走 shell 级层级。
- Side Pane 用包裹层实现形态切换，**不改变它在 DOM 中的位置**：宽视口包裹层为 `display: contents`（对布局透明，面板继续作为分栏子节点参与测量），窄视口才转成覆盖层。原因是 Browser Guest Host 一旦卸载就会销毁远端浏览器 guest，跨断点缩放不应该让它重载。
- **包裹层在面板收起时必须是惰性的（`pointer-events-none`）。** 包裹层靠自身盒子的显式宽度与 `inset-y-0` 取得尺寸，与内部面板的收起状态无关：面板塌成 0 宽，包裹层仍是满高、`min(92vw,420px)` 宽的透明盒。透明盒照样是命中目标，于是它会在收起状态下吃掉会话列的指针与触摸事件，消息列表划不动、输入区点不到。这和侧栏抽屉收起时带 `pointer-events-none -translate-x-full` 是同一条不变式。
  实现上刻意**只用 `pointer-events-none`**：不加 `translate-*`，因为 `transform` 会成为包裹层内 `position: fixed` 承载层（browser-use 截图 surface）的包含块；也不用 `visibility`/`display`，因为截图 surface 会在 Side Pane 收起时仍要求面板渲染，藏掉会打断自动化截图。
- 底部 Terminal 保持内联纵向分栏，窄视口下不改形态。

### 窄视口：会话列

- 会话列占满视口宽度，主内容区的最小宽度从 `320px` 放宽为 `min-w-0`。
  保留 320px 下限会让「侧栏 + 内容」在窄视口下超出可视宽度，再被外壳的 `overflow-hidden` 裁掉——表现为右侧内容被切断。

### 宽视口（≥768px）

- 双栏结构、侧栏 CSS 变量与 localStorage 宽度持久化、拖拽/键盘 resize、4px 桌面面板间距、圆角与窗控 chrome 全部保持改动前的行为。

## 状态所有者与事件顺序

状态所有者是唯一的，宽度不写状态：

| 状态               | 所有者                                                        | 说明                                    |
| ------------------ | ------------------------------------------------------------- | --------------------------------------- |
| 侧栏显隐           | `packages/ui/src/hooks/useAppPanels.ts` 的 `isSidebarVisible` | 用户意图，纯内存态。只有初始值读视口    |
| 侧栏呈现形态       | 从视口派生，不落状态                                          | `resolveWorkspaceSidebarPresentation()` |
| 侧栏内联宽度       | `WorkspaceShellLayout` 的 `workspaceSidebarPanelWidthPx`      | localStorage 持久化，仅宽视口可写       |
| Side Pane 开合     | `App.tsx` 的 `isSidePaneOpen`（`!isSidePaneCollapsed`）       | 本次不改                                |
| Browser Guest 挂载 | React 树位置                                                  | 跨断点不改变其 DOM 位置                 |

```
视口宽度变化
  └─ useIsNarrowViewport()（matchMedia change → useSyncExternalStore）
       └─ resolveWorkspaceSidebarPresentation({ isNarrowViewport })
            ├─ inline → 内联列 + 拖拽手柄 + 内容 min-w-[320px]
            └─ drawer → absolute 覆盖层 + 遮罩 + 内容 min-w-0
```

- 形态变化只重算 className / CSS 变量，不写入 `isSidebarVisible`，因此宽度变化永远不会和用户意图互相覆盖。
- 本轮保留 `WorkspaceShellLayout` 既有的 conversation 宽度自动收起策略（360px / 480px）不动。它在窄视口下天然成为空操作：抽屉与 Side Pane 都是绝对定位的覆盖层，不占布局宽度，conversation 的实测宽度不再被挤窄。

## 接口

- `packages/ui/src/lib/narrowViewport.ts`：`NARROW_VIEWPORT_MAX_WIDTH_PX`、`NARROW_VIEWPORT_MEDIA_QUERY`、`readNarrowViewportSnapshot()`、`subscribeNarrowViewport()`。
- `packages/ui/src/hooks/useIsNarrowViewport.ts`：`useSyncExternalStore` 包装，无 window 环境返回 `false`。
- `packages/ui/src/app-shell/workspaceShellResponsiveLayout.ts`：形态与 class 判定的纯函数，不含 DOM 读取。
- `packages/ui/src/WorkspaceHeader.tsx` 的 `simplifyForNarrowRemote`：本次接上真实判定。它此前带默认值 `false` 却没有任何调用方赋值，配套的 `max-md:` 收窄与 `hideMobileUnsupportedActions` 因此从未生效。

## 已知限制

本检出没有 React 渲染测试基建（无 vitest/playwright，也没有包定义 `test` script），交互部分不承诺 E2E 覆盖。形态判定被刻意抽成纯函数，用 `node --test` 覆盖；遮罩、动画、Guest 存活等交互仍靠手动验收。

- **视口宽度只在首帧决定侧栏初始显隐。** 之后宽度变化只切换形态，不写 `isSidebarVisible`。因此「先窄后宽」（窗口以窄尺寸打开再最大化，或视口在首帧之后才稳定）会保留收起状态，需要用户点一次浮层开关；这是「宽度不覆盖用户意图」的代价，换来旋转屏幕/拖拽窗口不会和用户操作打架。
- **会话输入区工具栏（`V4ComposerToolbar`）的窄屏排布仍是欠账。** 它的 `isMobileViewport` 本次刻意不接线（属于移动端交互增强，不是布局形态），窄视口下模型名与「管理模型」等标签仍会挤在一起。这不在本次范围内。
- 本检出没有可复现的浏览器 guest 环境，跨断点的 Guest 存活（场景 7）未在真实浏览器中验证。

## 验收场景

1. 手机竖屏（约 440px）打开网页版工作区：首屏是单列，会话列占满宽度，看不到侧栏。
2. 点左上浮层的切换按钮：侧栏从左侧滑入覆盖内容，带半透明遮罩；点遮罩收起，会话恢复满宽。
3. 抽屉展开状态下，浮层里的侧栏切换按钮仍在左上原位且可点，点它直接收起抽屉。
4. 440px 下会话里的长文本、文件卡片、改动统计（`+650` 一行）完整可见，右侧无截断。
5. 窄视口打开 Side Pane：从右侧覆盖滑入，会话列宽度不变；遮罩覆盖整屏（含输入区与建议行，点它们不会穿透到会话）；关闭后恢复满宽。
6. 窄视口下 Side Pane 收起时，会话列可正常上下滚动，输入区与消息内按钮可点击——收起的覆盖层不得吃掉指针与触摸事件。
7. 先打开一个浏览器 tab，把视口从 1280px 拖到 700px 再拖回 1280px：浏览器 guest 不重载（无白屏、无重新加载）。
8. 断点边界：767px 是抽屉、769px 是内联列，两个宽度下都能正常新建任务、切换任务、发消息。
9. 窄视口下 `WorkspaceHeader` 的 `max-md:` 收窄生效，标题与操作按钮不叠放、不溢出。
10. 1280px 视口：双栏观感与改动前一致；侧栏宽度可拖拽、刷新后宽度保持。
11. `pnpm typecheck`、`pnpm lint`、`pnpm verify:pre-push`、`pnpm architecture:check --changed` 通过；新增的 `node --test` 用例通过。

验收命令（沿用仓库既有约定，`.js` 说明符指向 `.ts` 源文件，需要 tsx 与 UI 包的路径别名）：

```
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/workspaceShellResponsiveLayout.test.ts
```
