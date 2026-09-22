# Spec: 启动品牌动画

## 目标

App 图标是 😋 表情（见 `packages/desktop/build/`）。启动加载屏把「正在加载」与「加载完成」表达成两个视觉形态不同的阶段：加载阶段用裸表情字形轮播表示进行中，完成阶段让 App 图标位图（`public/icon_512@2x.png`）弹出收尾。

## 产品规则

### 两阶段语义

- **阶段 1 · 加载**：四帧裸表情字形 😋 → 😜 → 🤪 → 😋 逐帧轮播，单帧 225ms、一轮 900ms，无限循环，直到启动门控就绪。
- **阶段 2 · 结束**：加载就绪后轮播帧直接消失，App 图标位图在同一位置做一次 420ms 的缩放弹出（0.72 → 1.06 → 1），随后静止。
- 两个阶段刻意用不同形态：阶段 1 是**裸字形**（无底板、无描边），阶段 2 才是**带黑色圆角底的图标位图**。图标位图在阶段 1 绝不出现——它静止出现在轮播里时会被读成「表情外面围了一圈很粗的边框」，只有作为弹出收尾才成立。
- 四帧共用同一条时间轴：第 i 帧的动画延迟为 `i × 225ms`（**正延迟**），任一时刻恰好一帧可见，循环处首尾相接、不出现重叠或空窗，可见顺序与帧序书写一致。
- 不要改用负延迟错相位：在 900ms 周期下负延迟会让可见顺序变成第 0、3、2、1 帧，品牌帧停留 450ms，帧序与声明不符。

### 品牌标识形态

- 阶段 1 的品牌标识是**裸表情字形**：不加圆角底板，不加描边，不加底色，不加阴影。
- 阶段 2 的品牌标识是 **App 图标位图本身**：自带黑色圆角底，按 96 × 96 显示、圆角 24px，与图标自身圆角一致。
- **图标位图不叠阴影**：`shadow-xl/20` 之类的阴影会在图标黑底之外再套一圈灰晕，浅色系统材质下加重「粗边框」观感，是阶段 2 观感变差的直接原因之一。Demo（`startup-animation-preview.html`）里的图标同样没有阴影。
- 桌面主窗口背景是透明的，启动壳叠在系统材质上，因此「深色圆角方块」只能作为阶段 2 的瞬时收尾，不能作为常驻形态。

### 时长与卸载

- **不设最短播放时长**：加载就绪即刻切阶段 2，不强制播完一轮，避免为了动画拖慢启动。加载极快时用户仍会看到阶段 2 的 420ms 图标弹出。
- **阶段 2 必须播完才卸载启动屏**：启动门控清除只代表可以进入主界面，启动屏需再保持 420ms 让弹出动画播完，否则阶段 2 会随组件卸载而不可见。

### 适用边界

- 启动门控（`Root.tsx`）用两阶段表情序列。
- **桌面 HTML 启动壳**（`packages/desktop/src/renderer/index.html`）承载阶段 1。它曾经显示 Z 字标，导致用户启动后第一个画面是 Z 字标、随后才跳到表情，品牌断裂；现在它必须与 React 侧显示同一套裸字形轮播。
- **数据库启动屏的静默态**（无迁移、未失败，是每次启动最先经过的一屏）用轮播：它属于「正在加载」语义，且停留通常极短。
- **数据库迁移态与失败态不用循环动画**：迁移可能卡在等待锁或升级上数分钟，失败态还会一直停住，此时使用静态裸字形——长时间高频闪动既干扰阅读又暗示仍在推进。这两条路径也不显示图标位图：它们是「还没就绪」，图标位图只属于阶段 2。
- 引导页（`OccupationOnboardingVisual`）的 Z 字标徽章与扫光效果不在本次范围，保持原样。

### 无障碍

- `prefers-reduced-motion: reduce` 时：轮播降级为静态裸字形（只留首帧），图标弹出的缩放也去掉，改为直接静态显示图标。两种形态仍然保留，只是不发生位移与缩放。

### 视觉连续性

- 三段启动画面——桌面 HTML 启动壳 → 数据库启动屏 → 启动门控——显示同一套裸字形轮播，切换时不出现品牌断裂。
- 阶段 2 只由 React 侧渲染：两个 HTML 壳在 React 首次 commit 后就退场，不承载图标位图。
- 已知限制：HTML 壳与 React 组件的动画各自从元素插入时起算，相位不严格对齐，切换瞬间可能跳变一帧（≤225ms）。两者使用相同帧序与周期时长，使跳变在视觉上不可辨。

## 状态所有者

- **阶段真值**：`Root.tsx` 的启动门控 `isStartupRenderBlocked` 与退出保持期 state。组件不自持阶段状态，只按 props 渲染。
- **唯一写入路径**：门控翻转 → 进入退出保持期（420ms）→ 卸载启动屏。不新增第二条控制路径。
- **两个静态 HTML 壳**（`packages/desktop/src/renderer/index.html`、`packages/web/index.html`）无法 import 常量，其 CSS 必须与 UI 侧保持一致，改动时三处同步。
- **常量**：帧序、帧长 225ms、周期 900ms、结束 420ms 在 `packages/ui/src/root/startupBrandTiming.ts` 集中定义。

时序：

```
启动                              就绪
 │                                 │
 ├─ 桌面 HTML 启动壳                │
 │   └─ 阶段 1 表情轮播(循环)        │
 │                                 │
 ├─ isStartupRenderBlocked = true  │
 │   └─ RootStartupLoading          │
 │       └─ 阶段 1 表情轮播(循环)    │
 │                                 ├─ 门控 = false
 │                                 ├─ 退出保持期 = true
 │                                 │   └─ 阶段 2 图标弹出 420ms
 │                                 └─ 退出保持期 = false → 卸载启动屏
```

## 接口

- `RootStartupLoading` 的 `brand`（`"emojiSequence"` | `"staticFace"`，默认 `emojiSequence`）与 `brandSettled`（boolean，仅 `emojiSequence` 有意义）。`Root.tsx` 实例传 `brandSettled={退出保持期}`；`GlobalDatabaseStartupLoading` 静默态用默认值，迁移/失败态传 `brand="staticFace"`。
- 阶段 2 的图标位图取自 `public/icon_512@2x.png`（`new URL(..., import.meta.url)` 解析，与 `UpdateStatusDialog` 的用法一致）。同一个组件实例内**不换图**：阶段 1 与阶段 2 是两套形态，不是同一张图的两个状态。
- **阶段 → 形态的映射是纯逻辑**：`packages/ui/src/root/startupBrandPresentation.ts` 的 `resolveStartupBrandPresentation(brand, settled)` 返回 `{ faces, cycling, badgeVisible }`，组件只按它写 `data-cycling` / `data-badge`，CSS 只按这两个属性写动效。字形与图标不会同时出现在一个 presentation 里（`packages/ui/test/startupBrandPresentation.test.ts` 钉住这条）。
- 样式在 `packages/ui/src/root/startupBrandSequence.css`（`.startup-brand__face` 轮播字形、`.startup-brand__badge` 阶段 2 图标位图），与引导页的 `onboardingLogoSweep.css` 并列。
- 退出保持期的时序由 `packages/ui/src/root/startupBrandExitHold.ts` 的纯状态机描述，`useStartupBrandExitHold` 只做 React 接线；`packages/ui/test/startupBrandExitHold.test.ts` 覆盖门控翻转、保持期内回退、播完结束等路径。
- 桌面 HTML 启动壳的退场握手：轮播是无限动画，不会触发 `animationend`，因此壳不再等待动画结束，只等 React 首次 commit 的 `zcode-react-startup-ready`（另有 3000ms 兜底），再走 `body.zcode-startup-ready` 与 500ms 后移除 `#loading` 的既有路径。
- `Root.tsx` 的 `canEnterNativeThemeSyncSurface` 改判「启动壳是否可见」而不是门控值：保持期内启动壳仍在屏幕上，此时同步主题会改写它的背景。
- `ZCodeStartupLogoBadge`（Z 字标）保留给引导页，不在本次范围。

## 验收场景

1. 冷启动桌面端 → 第一个画面就是裸字形表情轮播，不出现 Z 字标；就绪后轮播消失、App 图标弹出收尾，随后进入主界面。
2. 加载极快（<225ms）→ 仍完整看到阶段 2 的 420ms 图标弹出，随后进入主界面。
3. 加载很慢（数秒）→ 阶段 1 持续轮播，任一时刻恰好一帧可见，无重叠或空窗。
4. 数据库静默屏 → 裸字形轮播；迁移态与失败态 → 静态裸字形，无动画，也不出现图标位图。
5. 系统开启「减少动态效果」→ 轮播降级为静态裸字形，阶段 2 直接静态显示图标位图，全程无位移与缩放。
6. Web 首屏（JS 执行前）→ 裸字形轮播；React 接管后动画连续，无白底或双 loading 跳变。
7. 启动屏存在期间不出现可交互的元素抢先露出——阶段 2 播完才卸载。
8. 阶段 1 的字形外不出现黑色方块、描边或底色，浅色系统材质下同样成立。
9. 阶段 2 的图标位图外不出现额外描边或阴影投影：浅色系统材质下只呈现图标自带的黑色圆角底，不再多一圈灰晕。
