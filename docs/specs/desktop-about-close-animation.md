# Spec: Desktop 关于面板关闭时的淡出顺序

## 目标

关闭关于面板时，面板内容与背板作为同一块表面一起淡出，然后窗口隐藏。全程只有这一拍。不再出现「内容先消失、系统收场动画随后再走」。

## 产品规则

- 关于面板是一个复用窗口：`showAboutDialog` 只创建一次 `BrowserWindow`，之后每次打开复用同一实例；父窗口变化时才重建。
- macOS 上**不用** `modal: true`。父窗口仍可绑定，但面板不是系统 sheet。
- Windows / Linux 在有父窗口时仍用 `modal: true`，用来挡住父窗口；这两端没有 sheet 收场。
- 关闭不销毁窗口：拦截 `close` 后 `hide()`。应用退出时放行。
- 关闭动画由 renderer 拥有：给 `body` 加关闭态，整块背板（含文字、图标、按钮）从完全不透明过渡到全透明，时长 160ms；过渡结束后才 `window.close()`。减弱动态效果时跳过过渡，立刻关窗。
- 每次打开都在隐藏期间重载内容，刷新语言与版本，并复位关闭态。
- 重复触发关闭只生效一次。
- macOS 上每次显示都按父窗口内容区定位：水平居中、贴在内容区顶部，接近原先 sheet 的位置。没有父窗口时居中。
- 背板自己画对话框圆角（16px）。圆角不再依赖系统 sheet。

## 现状与根因

此前把面板做成 `parent` + `modal: true`。Electron 文档写明：macOS 上这会变成挂在父窗口上的 sheet。

Electron 41 的 `NativeWindowMac::Hide()` 对「自己就是 sheet」的窗口固定是：

1. 先 `orderOut`：窗口立刻从屏幕上拿走，内容瞬间没了。
2. 再对父窗口 `endSheet`：系统开始播 sheet 收场。

`Close()` 也是先从父窗口摘掉，再异步 `endSheet`。JS 里无论先淡内容、立刻 `hide()`、或 `preventDefault` 后 `hide()`，都改变不了这两步的先后。所以用户看到的永远是「内容先消失，关闭动画后走」。

「先淡内容再 hide」只是在系统收场前面又加了一拍；「立刻 hide、不淡内容」则让 `orderOut` 把内容瞬间拆掉，空壳再滑走。两条路都撞上同一处原生顺序。

因此 macOS 上不再走 sheet。关闭只保留应用自己的那一拍淡出；`hide()` 发生在已经全透明之后，没有第二段系统动画。

## 状态所有者与事件顺序

```text
main（窗口生命周期）
  → ensureAboutWindow()：复用；darwin 不设 modal
  → 隐藏期间 loadURL
  → darwin：按父窗口内容区定位
  → show() / focus()

renderer（关闭动画）
  → 点击「确定」/ Escape / Enter
  → 加关闭态（整块 opacity 1 → 0，160ms）
  → 过渡结束 → window.close()

main（关闭时序）
  → 拦截 close，preventDefault
  → hide()：窗口已透明，只是收起实例
  → 退出流程放行，窗口销毁
```

- 窗口实例所有者：`aboutWindowRef` / `aboutWindowParent`。
- 关闭动画状态只存在于 renderer 的关闭类名；`closing` 标志保证不可重入。
- macOS 是否作为 sheet 的决策点：`shouldUseAboutWindowModal()`。darwin 恒为否。

## 接口与实现边界

- `packages/desktop/src/main/about.ts`：
  - `shouldUseAboutWindowModal(hasParent, platform)`：仅非 darwin 且有父窗口时为真。
  - `resolveAboutWindowPosition(parentContentBounds, size)`：水平居中、贴内容区顶。
  - `ensureAboutWindow()` 按上面的 modal 决策创建窗口；`close` 仍 `preventDefault` + `hide()`。
  - 每次 `showAboutDialog` 在 `show()` 前定位（有父窗口时）。
- `packages/desktop/src/main/aboutWindow.ts`：背板底色与圆角画在 `body`；`html` 透明。关闭脚本为「加关闭态 → 等淡出 → `window.close()`」。
- 窗口保持 `transparent: true` 与全透明底色。macOS 窗口阴影跟随不透明像素，不额外画 CSS 投影。
- 淡出时长 160ms 只在模板脚本里定义。

## 验收场景

1. 点击「确定」：文字、图标、按钮与背板一起淡出，之后窗口消失；没有「内容先没、再滑走一块空壳」。
2. 按 Escape 或 Enter：与点击「确定」一致。
3. 重复打开：复用同一窗口，语言与版本正确，关闭态已复位；macOS 上位置仍贴在父窗口内容区顶部居中。
4. 淡出期间连点只生效一次。
5. 开启「减弱动态效果」：直接消失，无 160ms 空等。
6. 深浅色主题下背板圆角完整，透明窗口四角不露方块底。
7. 应用退出不被 `close` 拦截挡住。
8. 定向测试、类型检查与 Lint 通过。

## 负面边界

- 不改关于面板的行高、窗口尺寸与文案。
- 不在主进程用 `setOpacity` 做窗口级渐出。
- 不把 macOS 关于面板重新做成 `modal` sheet 来「保留系统收场」——那条原生顺序无法从 JS 纠正。
- 不新增 native addon、preload 或跨进程动画协议。
- 不改图标、版本号取值与上游版本行逻辑。
