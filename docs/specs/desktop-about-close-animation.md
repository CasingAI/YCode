# Spec: Desktop 关于面板关闭时的淡出顺序

## 目标

关闭关于面板时只有一拍：背板、文字、图标、按钮作为同一块表面一起淡出，然后窗口在已经看不见之后收起。不再出现「内容先没、空壳再滑走/再淡」。

## 产品规则

- 关于面板复用同一 `BrowserWindow`；父窗口变化时才重建。关闭只 `hide()`，退出时才真正关掉。
- **macOS 不挂 `parent`，也不设 `modal`。** 定位仍按父窗口内容区计算，但原生窗口彼此独立。Windows / Linux 有父窗口时继续 `parent` + `modal`，用来挡住父窗口。
- macOS 窗口关掉系统圆角和系统阴影：`roundedCorners: false`、`hasShadow: false`。可见圆角只画在背板上，随背板一起淡出。
- 关闭**禁止** `window.close()`。页面改标题发出收起信号，main 监听后 `hide()`。文档不能被卸载。
- 关闭动画由 renderer 拥有：背板加关闭态，整块从完全不透明过渡到全透明，160ms；结束后才发收起信号。减弱动态效果时立刻发信号。
- 每次打开在隐藏期间重载内容，刷新语言与版本，复位关闭态。
- 重复触发只生效一次。
- macOS 每次显示按父窗口内容区水平居中、贴顶。没有参照窗口时居中。

## 现状与根因

用户看到的「内容先消失，再播关闭动画」是**两拍叠在一起**，不是某一拍没写对。来源有三层，前两次修复每次只拆掉一层，所以看起来「改了还是一样」。

1. **系统 sheet。** `parent` + `modal` 在 macOS 上是 sheet。Electron 的 `hide()` 固定先 `orderOut`（内容瞬间没了）再 `endSheet`（空壳收场）。JS 改不了这两步顺序。上一轮已在 darwin 去掉 `modal`，但还挂着 `parent`。
2. **子窗口 + 系统窗口装饰。** 仍挂 `parent` 时，`hide()` 会先从父窗口摘掉子窗口。透明窗口若保留系统圆角和阴影，背板 CSS 淡到全透明之后，阴影和窗口轮廓还在，随后被 `hide()` 带走——观感仍是「内容先没，空壳再走」。
3. **`window.close()`。** 页面调用它会走 Chromium 关页。即便 main 拦截了 `close` 并改 `hide()`，内容层也可能先被卸掉，动画只剩空窗口。

因此 darwin 上窗口必须独立、无系统圆角/阴影；关闭只改标题通知 main `hide()`，绝不 `window.close()`。淡出那一拍是唯一可见动画。

## 状态所有者与事件顺序

```text
main（窗口生命周期）
  → ensureAboutWindow()：复用；darwin 不挂 parent、不 modal
  → 隐藏期间 loadURL
  → 按参照窗口内容区定位（不把参照窗口设为 parent）
  → show() / focus()

renderer（关闭动画）
  → 点击「确定」/ Escape / Enter
  → 加关闭态（整块 opacity 1 → 0，160ms）
  → 过渡结束 → 把 document.title 设为收起信号

main（关闭时序）
  → page-title-updated 匹配收起信号，preventDefault
  → hide()：窗口已透明且无阴影，收起不可见
  → 若收到真正的 close（退出）：放行并销毁
```

- 窗口实例所有者：`aboutWindowRef` / `aboutWindowParent`（darwin 上 parent 引用只用于定位比较，不传给 BrowserWindow）。
- 收起信号常量：`ABOUT_HIDE_SIGNAL`（`ycode-about-hide`），renderer 与 main 共用。
- `closing` 标志保证淡出不可重入。

## 接口与实现边界

- `packages/desktop/src/main/aboutWindow.ts`：导出 `ABOUT_HIDE_SIGNAL`。关闭脚本只改标题，不调用 `window.close()`。
- `packages/desktop/src/main/aboutWindowPlacement.ts`：darwin 不挂 parent、不 modal；定位按参照窗口内容区水平居中、贴顶。
- `packages/desktop/src/main/about.ts`：创建窗口时 darwin 关掉系统圆角和阴影；`page-title-updated` 匹配收起信号后 `hide()`；`close` 仍在退出时放行。
- 不新增 preload、IPC 通道或 native addon。标题信号沿用仓库里其它无 preload 小窗的做法。

## 验收场景

1. 点击「确定」：文字、图标、按钮与背板一起淡出后消失；没有空壳滑走、没有阴影单独再淡一次。
2. 按 Escape 或 Enter：与点击「确定」一致。
3. 重复打开：复用窗口，语言与版本正确，关闭态已复位；macOS 位置仍贴参照窗口内容区顶部居中。
4. 淡出期间连点只生效一次。
5. 开启「减弱动态效果」：直接消失。
6. 深浅色主题下背板圆角完整，四角不露系统方窗。
7. 应用退出不被拦截。
8. 定向测试、类型检查与 Lint 通过。

## 负面边界

- 不改关于面板的行高、内容尺寸与文案。
- 不在主进程用 `setOpacity` 做窗口级渐出。
- 不把 macOS 关于面板重新做成 sheet，也不再给它挂 `parent`。
- 关闭路径不再调用 `window.close()`。
- 不改图标、版本号取值与上游版本行逻辑。
