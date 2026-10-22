# Spec: 正文折叠卡箭头方向

## 目标

消息正文里的 Markdown `<details>` 折叠卡，头部左侧有一个 chevron 箭头，指示这张卡是收起还是展开。

本 spec 规定该箭头的方向语义：**箭头指向内容铺开的方向**——收起时指向右（›），展开时指向下（⌄）。

## 背景

正文折叠卡此前用 `ChevronDownIcon` + `rotate-180` 实现，得到的是「收起 ⌄ / 展开 ⌃」：

- 收起态画下箭头，用户看到的是「已经铺开了」的暗示，与卡片实际状态相反；
- 展开态箭头朝上，而正文实际在头部下方铺开，箭头指了个空方向。

同一屏里还存在另一类折叠入口（文件变更摘要、思考卡），用的是「收起 › / 展开 ⌄」。正文折叠卡与它们并排出现时，两种箭头语言同时可见，收起态一个朝右一个朝下，读起来像两个不同的交互控件。

## 产品规则

### 方向语义

- 收起态：箭头朝右（›），表示「点我向侧边展开」。
- 展开态：箭头朝下（⌄），表示「内容已在下方铺开」。
- 状态切换必须改变箭头的朝向，不能只改透明度或字色；否则用户看不出这一组是开着的。

### 实现约定

- 统一用 `ChevronRightIcon` 作为基础图形：收起态不旋转，展开态加 `rotate-90` 旋转 90° 得到朝下的箭头。
- 旋转用 `transition-transform` + `duration-200`，与折叠区 `grid-rows` 过渡的时长一致，展开/收起时箭头与内容同步运动。
- 箭头的尺寸、字色与折叠卡头部其余元素保持一致，不随展开状态改变。

### 适用范围

本 spec 约束**正文折叠卡**（`MarkdownDetails`）头部的箭头。

同目录下的工具调用卡（`ToolHeader`、`SandboxHeader`、`TaskTrigger`）头部箭头位于标题右侧，与正文折叠卡的左置箭头不属同一呈现形态，本次不改动。

## 状态所有者与不变式

- 展开状态的唯一所有者不变：`MarkdownDetails` 内部的 `expanded` state。箭头方向只读取该状态，不新增状态、事件或订阅。
- 箭头方向由 `expanded` 派生，渲染是纯函数：同一个 `expanded` 值必然得到同一个箭头朝向。
- 不变式：只改箭头的图形与朝向，不改折叠卡的展开/收起行为、`aria-expanded`、`aria-controls`、时间线折叠触发器槽位与分组规则。

## 接口

- `packages/ui/src/components/ai-elements/markdown-details.tsx`
  - 头部箭头由 `ChevronDownIcon` 改为 `ChevronRightIcon`；展开态的 class 由 `rotate-180` 改为 `rotate-90`。
- 无协议、持久化、远程恢复或跨模块接口变化。

## 验收场景

1. 正文出现一个 `<details>`，默认收起：卡片头部左侧的箭头朝右。
2. 点击卡片头部展开：箭头在 200ms 内旋转 90°，最终朝下，与下方铺开的正文同向。
3. 再次点击收起：箭头转回朝右。
4. 连续多个 `<details>` 合并成一张卡片时，各块头部的箭头方向一致，都遵循同一套收起 › / 展开 ⌄ 语义。
5. 展开态下 `aria-expanded="true"` 不变，折叠区正文正常铺开。
6. 与同屏的文件变更摘要等折叠入口并排时，两者的收起态箭头朝向一致（都朝右）。

## 负面边界

- 不改折叠卡的默认收起行为与 `open` 初始状态语义。
- 不改折叠卡头部按钮的交互、时间线折叠触发器槽位与滚动锚点。
- 不改连续折叠块合并成一张卡片的分组规则。
- 不改工具调用卡（`tool` / `sandbox` / `task`）头部箭头的形态。
- 不改 Markdown 解析与流式分块逻辑，不改 i18n 文案。

## 验证

- 定向回归测试：
  - `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/markdown-details.test.ts`
  - `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/markdown-details-render.test.ts`
- 静态检查：`pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`
- 仓库没有真实浏览器 E2E 基建，箭头旋转的动画过程与最终朝向仍需在桌面与手机宽度下人工回归。
