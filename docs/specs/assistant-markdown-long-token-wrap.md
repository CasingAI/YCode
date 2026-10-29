# Spec: 助手 Markdown 正文中的无空格长 token 换行

## 目标

助手回复的 Markdown 正文在消息列内显示时，无空格长 token（典型如 Windows 绝对路径
`C:\Users\...\ExportedProject\Assets\Resource\...`、长 URL、长行内代码）必须换行，不得
横向溢出消息列后被裁剪。

现状：正文根容器只有字号、行高和首尾 margin 规则，没有 `overflow-wrap`。CSS 默认断行规则
把反斜杠和路径分隔符当作普通字符，不提供断行机会；中文正文能换行只是因为 CJK 按字断行。
因此中文消息正常、纯路径消息被截断。本 spec 把断行规则收敛到正文根容器一处，由行内元素
继承，不引入全局 CSS 或新依赖。

## 产品规则

1. 助手 Markdown 正文（`MessageResponse`）中的普通段落，遇到无空格长 token 时在消息列
   宽度内换行，内容不得横向溢出消息列。
2. 行内代码（反引号包裹的 `code`）中的无空格长 token 同样在消息列内换行。
3. 普通中文、短文本、拉丁文词组的既有换行行为不变；不在词内制造额外的无意义断点。
4. Markdown 渲染异常时的纯文本降级路径保持既有 `whitespace-pre-wrap break-words`，
   不得因为本次改动丢失该行为。
5. 代码块（围栏代码）的换行仍由既有 `wrapLongLines` / 换行按钮控制，本 spec 不改代码块
   语义。
6. 不引入新的全局 CSS 规则，也不引入新的运行时依赖。

## 状态所有者与接口

- 纯样式层，无状态所有者；不新增 store、hook、context 或协议字段。
- 断行规则的唯一落点是 `MessageResponse` 正文根容器的 `responseClassName`
  （`packages/ui/src/components/ai-elements/message.tsx`），加入 Tailwind 的
  `break-words`（`overflow-wrap: break-word`）。
- `overflow-wrap` 是可继承属性，故行内 `code`、`a`、`strong` 等后代元素自动继承，
  不在各 renderer 上重复声明。
- 行内 `code` 渲染器不得覆盖为 `whitespace-nowrap` 之类阻止换行的样式。
- `MessageResponseMarkdownBoundary` 的降级 `fallbackClassName` 继续包含
  `whitespace-pre-wrap break-words`，本次不改。

## 验收场景

1. 渲染只包含一条长 Windows 绝对路径的助手消息：根容器 class 列表包含 `break-words`，
   路径在消息列内换行，不横向溢出、不被裁剪。
2. 渲染行内反引号包裹的长路径：行内 `code` 元素存在，且不带 `whitespace-nowrap` 等
   阻止换行的类；长路径在消息列内换行。
3. 渲染普通中文段落和短英文文本：换行结果与改动前一致，未出现词内异常断行。
4. Markdown 渲染异常进入纯文本降级：降级容器仍带 `whitespace-pre-wrap break-words`。
5. `pnpm typecheck`、`pnpm lint` 通过；新增 `node:test` 用例通过。
