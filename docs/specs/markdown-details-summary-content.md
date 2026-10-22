# Spec: Markdown 折叠块 summary 内容归位

## 目标

Markdown 正文里的 `<details>` 折叠块渲染成卡片：头部按钮显示 summary 文本，正文区显示折叠内容。

模型输出里 `<summary>` 漏写闭合标签很常见。浏览器解析器遇到块级标签不会提前闭合 summary，而是一直挂到 `</details>` 才收口，于是 summary 之后的所有块级内容（表格、列表、代码块）都变成 summary 的子节点。渲染层再把 summary 的全部子节点提成卡片标题，这些块级内容就落进标题按钮的 `truncate` 容器：右侧列被裁掉、末行不可见，且无法横向查看。

本 spec 规定：折叠块的 summary 只承载标题文本；误挂到 summary 下的块级内容必须归位到同一个折叠块的正文区。

## 产品规则

### 内容归属

- `<summary>` 只承载标题文本（行内内容）与标题形态的 heading（h1-h6）。
- 表格、列表、代码块、引用、分割线等块级内容不允许出现在 summary 内。出现时，这些内容被移出 summary，放到同一个 `<details>` 内、紧跟 summary 之后。
- 归位不改变内容的顺序、文本与结构，只改变它在折叠块内的归属层级。
- 归位只对折叠块生效：正文里的普通段落、列表不经过这条规则。

### 合法结构不受影响

- `<summary>标题</summary>` 闭合正常时，折叠块结构与渲染结果保持原样。
- summary 内的 heading 属于合法标题形态，保持在标题里，不被搬走。
- 归位后 summary 没有可展示的标题文本时，折叠卡头部走既有的兜底标题文案。

### 与既有折叠块规则的关系

- 分组规则（`docs/specs/markdown-details-grouping.md`）只管视觉合并，不感知内容归属。
- 折叠块的展开状态所有者不变：仍是 `MarkdownDetails` 内部的 `expanded` state。
- 表格本身的渲染与横向滚动能力不变：归位后表格回到折叠正文区，走项目自有的 `MarkdownTable`，恢复横向滚动与虚拟滚动条。

## 状态所有者与不变式

- 内容归属的所有者是解析层的 rehype 树结构，由归位插件一次性改写；React 组件不感知、不新增状态、事件或订阅。
- 不变式：归位只调整块级内容在折叠块内的父子关系，不改变折叠块的展开/收起语义、可访问性属性与折叠区结构。

## 接口

- `packages/ui/src/lib/detailsSummaryContentRehypePlugin.ts`（新增）
  - `detailsSummaryContentRehypePlugin`：rehype 插件，把 summary 下的非法块级内容搬到同一 details 内、紧跟 summary 之后。
  - 必须挂在 `rehype-raw` 之后执行：原始 Markdown 里的 `<details>` / `<summary>` 起初只是 HTML 字符串，要先被解析成真实节点才谈得上搬运子节点。
- `packages/ui/src/components/ai-elements/message.tsx`
  - 折叠卡正文渲染链路（`messageRehypePlugins`）在 `rehype-raw` 之后插入归位插件。
- 无协议、持久化、远程恢复或跨模块接口变化。

## 验收场景

1. 折叠块写成 `<details>` + 未闭合的 `<summary>标题` + 表格：表格渲染在折叠正文区，标题按钮里只有标题文本。
2. 表格归位后列数、行数与原文一致，末行与末列内容都不丢。
3. 折叠块写成合法的 `<summary>标题</summary>` + 表格：结构与渲染结果不变。
4. summary 里带 heading：heading 留在标题里，块级内容仍归位到正文区。
5. summary 之后没有块级内容：折叠块结构完全不变。

## 负面边界

- 不改折叠块的展开/收起行为、默认收起语义与 `open` 初始状态。
- 不改折叠块头部按钮的交互与时间线折叠触发器槽位。
- 不改 Markdown 源文本，不在模型输出层做修正。
- 不改表格自身的渲染、列宽与横向滚动实现。
- 不引入对 summary 之外元素的结构改写。

## 验证

- 定向回归测试：
  - `packages/ui/test/markdown-details-summary-content.test.ts`：真实会话畸形原文的渲染回归 + 归位插件单测。
  - `packages/ui/test/markdown-details-render.test.ts`、`packages/ui/test/markdown-details.test.ts`：折叠块既有渲染回归。
- 静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`。
- 仓库没有真实浏览器 E2E 基建，归位后的实际观感仍需在桌面与手机宽度下人工回归。
