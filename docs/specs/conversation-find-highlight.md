# Spec: 会话查找与轨迹搜索高亮配色

## 目标

会话内查找、会话引用/搜索结果跳转和模型轨迹搜索共用 CSS Custom Highlight API。
每个高亮背景都必须配一枚语义前景 token，保证任意主题下文字与底色对比度不低于 4.5:1。

## 产品规则

- 背景与前景成对使用，禁止高亮只写背景、让文字沿用页面正文色：
  - 普通命中：`--color-find-highlight` + `--color-find-highlight-foreground`
  - 当前命中：`--color-find-highlight-active` + `--color-find-highlight-active-foreground`
- 会话引用/搜索结果跳转复用“当前命中”的成对配色。
- 模型轨迹搜索与会话内查找使用同一组成对 token，不单独维护色表。
- 四套主题（默认浅色、默认深色、Zai Light、Zai Dark）都必须给出可解析的前景值；
  继承 `:root` 可以，但解析结果必须落在对应主题的实际前景上。
- 暗底与亮底需要相反方向的前景：深色主题的普通命中是深底浅字，亮橙当前命中是亮底深字。
  不得对高亮统一套深色字，也不得用 `filter: invert()` 逐像素反转。
- 普通系统文本选中（`::selection`）不参与本规则，也不因本次配色改动而变化。
- 高亮优先级、3 秒自动清除、引用跳转/搜索顺序、DOM 落点选择和跨端协议均保持不变。

## 状态所有者

主题 token 是配色的唯一所有者，定义在 `packages/ui/src/styles.css` 的四套主题块。
两个高亮模块只消费 CSS 变量，不持有颜色常量，也不新增运行时状态：

```text
styles.css 主题 token
  → ::highlight() 规则（conversationFindHighlightDom / ModelTrajectorySearchHighlight）
  → Highlight Registry 按优先级绘制 base / active / search-result
```

## 接口与兼容

- `::highlight()` 规则的 `color` 使用 `var(--color-find-highlight-foreground, var(--color-foreground))`
  与 `var(--color-find-highlight-active-foreground, var(--color-foreground))`；
  fallback 保持旧行为，避免 token 未加载时文字不可见。
- 不改变 highlight 名称、priority（base 0 / active 1 / search-result 2）、3 秒清除时长，
  不改变 `apply*Highlight` 的入参、返回值或调用顺序。

## 验收场景

1. 四套主题 × 普通命中/当前命中共 8 组“真实背景 + 真实前景”的 WCAG 对比度均 ≥ 4.5:1。
2. 会话查找注入的 base 规则消费 `--color-find-highlight-foreground`；
   active 与 search-result 规则消费 `--color-find-highlight-active-foreground`。
3. 模型轨迹搜索注入的 base/active 规则分别消费上述两枚前景 token。
4. 旧实现（所有高亮统一 `var(--color-foreground)`）在该测试下失败；仅新增字符串而不接真实
   token 的实现不通过。
5. 普通系统选中文本样式不变，高亮清除与跳转行为不变。
