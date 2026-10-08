# Spec: Desktop 关于面板关闭时的淡出顺序

## 目标

关闭关于面板时，面板内容与窗口一起淡出；内容在淡出全程可见，动画走完才销毁窗口。不再出现「内容先消失、动画随后再走」或「内容先变白再渐出」。

## 产品规则

- 关闭由 renderer 内容自身发起：先给文档加 `is-closing`，让整块面板从 `opacity: 1` 过渡到 `0`。
- 淡出时长固定 160ms；淡出结束后 renderer 才调用 `window.close()`，此时窗口内已无可见内容。
- 淡出期间重复触发关闭（按钮连点、Enter 连按）只生效一次，不重启动画、不提前关窗。
- 用户开启「减弱动态效果」时不做淡出，直接关闭，避免无效等待。
- 窗口底色保持全透明（`backgroundColor: "#00000000"`）：即便在「已淡出、尚未销毁」的空档里有渲染帧，透出的也是桌面而非白底。

## 现状与根因

`showAboutDialog` 创建的是 `transparent: true` 的无边框窗口，关闭入口（`.ok-button` 点击、Escape / Enter）此前直接调用 `window.close()`。

`window.close()` 会立即销毁网页内容；窗口级渐出（含系统收起）发生在这之后。于是可见序列变成「内容消失 → 空窗口淡出」：内容没有参与淡出，看起来就是先没了、动画才走。

主进程侧拦截 `close` 事件并用 `win.setOpacity()` 做窗口级渐出的方案不可用：macOS 的半透明窗口不保证响应 `setOpacity`，且窗口级渐出的对象是空窗口本身，仍然解决不了「内容不参与淡出」。因此淡出必须发生在 renderer，作用对象是内容。

## 状态所有者与事件顺序

```text
renderer（关闭动画的唯一所有者）
  → 点击「确定」/ Escape / Enter
  → body 加 is-closing（opacity 1 → 0，160ms）
  → 过渡结束
  → window.close()
  → main 销毁 BrowserWindow
```

- 动画状态只存在于 renderer 的 `is-closing` 类，main 不参与关闭编排。
- main 只负责窗口配置（透明、无边框、禁用调整大小），不拦 `close`、不做定时淡出。
- `closing` 标志位由 renderer 持有，保证淡出不可重入。

## 接口与实现边界

- `packages/desktop/src/main/aboutWindow.ts` 的模板样式新增 `body` 的 `opacity` 过渡与 `is-closing` 终态；`prefers-reduced-motion` 下过渡时长归零。
- 模板脚本的 `closeWindow` 改为「加类 → 等淡出 → `window.close()`」，并加 `closing` 重入保护；`prefers-reduced-motion` 时直接关闭。
- `packages/desktop/src/main/about.ts` 移除 `close` 事件拦截与窗口级淡出，仅保留透明底色配置。
- 淡出时长常量（160ms）在模板脚本内单点定义，不跨进程传递。

## 验收场景

1. 点击「确定」：面板内容与窗口一起淡出，全程看不到内容先消失或先变白的空档。
2. 按 Escape 或 Enter：与点击「确定」表现一致。
3. 淡出期间连点「确定」或连按 Enter：只关一次，动画不重放、不闪烁。
4. 开启「减弱动态效果」后关闭：直接消失，无 160ms 空等。
5. 深浅色主题下淡出表现一致。
6. 定向测试、类型检查与 Lint 通过。

## 负面边界

- 不改关于面板的布局、行高、窗口尺寸与文案。
- 不在 main 进程恢复 `setOpacity` 或 `close` 拦截。
- 不引入 Electron 之外的动画依赖，不新增跨进程事件。
- 不改图标、版本号取值与上游版本行逻辑。
