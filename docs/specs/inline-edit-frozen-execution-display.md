# Spec: 行内编辑卡冻结执行选择的只读展示

## 目标

编辑历史消息再发送时，`editUserQuery` 是一次换文本的 retry：沿用被编辑轮在 admission 阶段冻结的 `mode` 与 `modelSelection`，不接受新的执行选择。用户在点开编辑框的瞬间看不到这层约束，只能在重发后从权限弹窗或模型切换记录里反推。

本规范定义行内编辑卡对这两个冻结值的**只读展示**：模式徽标常显在左，模型名常显在右并与 rewind、取消、发送键同排。展示层不新增状态、不新增命令、不新增权限写入路径。

本次修订修正两处实现缺陷：

1. 模式文案原先挂在 `@xl/composer` 容器断点上，而行内编辑卡不在该容器子树内，命名容器查询恒为 false，文案在任何宽度下都不显示。
2. 冻结模型名原先被拼成**单个字符串**再交给 `truncate`，而宽度分级只决定「最多能有多宽」，没有「该显示哪几段」这一档。两者叠加的结果是：会话列一窄，标签就从尾部被砍成「OpenCode Go…」，provider 名占了全部预算、模型名反而看不见。底部大输入框在同样宽度下是「供应商让位、模型名保留」，同一轮冻结值在两个输入框里给出两种可读性。

## 产品规则

### 展示内容

- **模式**：从 `admissionMode` 查 `getZCodeAgentAvailableModes()`，命中则显示该模式的本地化标签（Plan / Ask / Agent 等），未命中或旧 snapshot 缺字段时显示「未知模式」占位。图标始终存在，yolo 用警示色。
- **模型**：把 `admissionModelSelection` 编码成选项值，在同一份 `modelSelectionView` 目录里查；命中则复用输入区胶囊的展示规则（`formatModelDisplayName` 排版 + 内置家族不拼 provider 前缀、其余拼 `<providerName>/`），并追加 ` · <档位>` 后缀。档位值是规范值（`high` / `xhigh` / …），**必须查工具条同一张映射表**（`thoughtLevelLabelId`）再本地化，否则中文界面会出现「· high」而大输入框显示「高」；映射表里没有的值原样显示 provider 自己的档位名。目录未就绪、未命中、缺字段一律回落「选择模型」占位，不按当前会话档位回填、不反推 provider 名。
- **模型名必须保持三段结构**（provider 前缀 / 模型名 / 档位后缀），不得预先拼成单串再截断。整串一旦成型，窄列下就只能从尾部砍，砍掉的是刚好还认得出的那部分；分段之后才能按优先级逐段让位。与大输入框胶囊同一条纪律（见 `composer-model-display-name.md` 与 `modelTriggerDisplay.ts` 的结构化前缀约定）。
- 两者都带 tooltip 说明「重发将沿用本轮模式/模型，不可更改」，并以 `aria-disabled` 表达只读语义；不是真禁用态按钮，不参与 tab 序列。模型标签的 tooltip 额外携带**完整标签**（provider + 模型名 + 档位）：窄列下 provider 与档位会被隐藏，完整值只能从这里读到，截断不得导致信息不可得。

### 排列

从左到右固定为：`模式徽标 … 模型名 → rewind → × → 发送`。

- 模式徽标走 `leadingActions`，模型名走 `betweenCancelAndSubmitAction`，取消键用 `cancelPosition="afterBetween"` 排在该插槽之后。
- 模型名必须留在取消键左侧：把标签挪进左侧 `flex-1` 区域虽然能借用空白，但会把「× 紧跟模型名」重新拆开。
- Esc 取消走编辑器独立 keydown，与按钮位置无关。

### 宽度分级：弹性布局 + 按优先级逐段让位

行内编辑卡传 `trailingFlexible`（见接口一节）：工具条 leading 外层从 `flex-1` 收成 `shrink-0`（只装模式徽标），trailing 从 `ml-auto shrink-0` 换成 `min-w-0 flex-1`；冻结标签根节点再 `flex-1`，于是标签向左伸展吃掉工具条中部空白。标签没有 `max-w-*` 上限——弹性和行内卡自身 `max-w-xl`（576px）封顶就是上限，宽列时完整标签能显示多少显示多少。模型名内段是标签里唯一的弹性收缩段（`min-w-0 truncate`），挤压只砍模型名；rewind / × / 发送是固定宽度按钮，永远钉在右侧，不会被顶出卡外。标签内容一律右对齐（`justify-end`）：贴着 rewind 按钮向左伸展，剩下的空白留在模式徽标与标签之间——与底部大输入框的模型胶囊同一条纪律（胶囊是 trailing 区的右钉元素，中部空白永远在它左边）。`justify-start` 在这里是错的：它把模型名推到徽标边、空白留在标签与按钮之间，看起来“吃掉了空白”，实际是把标签和按钮撕成了两截（真机截图翻车过）。模型名段刻意不用 `flex-1`：伸展吃空白是根节点的事，模型名段一旦伸展会把档位后缀推到右边缘、屏幕上出现断裂（窄列实测翻车过）。工具条行内编辑卡用垂直居中（`trailingFlexible` 时 `items-center`）：工具条里唯一的 32px 元素是取消键（`icon-lg`），其余标签/按钮都是 28px（`h-7`/`icon-md`），`items-end` 会让它们底对齐、视觉上标签偏上；大输入框不传 `trailingFlexible`，保持 `items-end` 不变。

四段的可读性按「模型名 > 档位后缀 > provider 前缀 > 模式文案」排序，会话列变窄时从后往前让位：

| 会话列     | 模式文案       | provider 前缀 | 档位后缀 | 模型名                         |
| ---------- | -------------- | ------------- | -------- | ------------------------------ |
| < 480px    | 隐藏（纯图标） | 隐藏          | 隐藏     | 弹性填满剩余宽度，只剩它可截断 |
| 480–1023px | 显示           | 隐藏          | 原子显示 | 弹性填满剩余宽度               |
| ≥ 1024px   | 显示           | 显示          | 原子显示 | 弹性填满剩余宽度               |

- **provider 前缀默认 `hidden`、≥1024px 起 `inline`**，写法与大输入框胶囊的 `hidden @2xl/composer:inline` 同构。1024px 是纯政策位：行内卡在会话列约 635px 即到达自身 576px 封顶，此后卡片几何不再变化，阈值设多高都不影响卡片，只决定「多宽才配显示身份信息」；624–1023px 的全部空间归模型名。用「默认隐藏 + 断点显示」而不是 `@max-[1023px]` 隐藏，避免边界上两条规则同时命中。
- **模式文案隐藏阈值 480px**：让出的约 60px 归模型名，窄列下模型名才不会被截成「Space Bunn…」。
- **档位后缀是原子段**：`shrink-0` 不可压缩，要么完整显示 `· 最高`，要么在 <480px 整段隐藏——不允许被截成无意义的 `· ...`。与模型名之间的间距用 `ml-1`，不依赖会被折叠的字符串前导空格（后缀是独立 flex 子项，块首空格会被浏览器吃掉，`Free· 最高` 的粘连即由此来）。被隐藏时完整值仍可从 tooltip 读到。
- 算术余量（卡片内边距 32px、工具条间距 12px、rewind/×/发送 84px + trailing 间距 18px）：360px 会话列下模型名约 182px 可用；480px 约 242px；卡片封顶后约 338px。窄列下 `Space Bunny Free · 最高`（约 200px）可能仍放不下——此时只截模型名段，后缀保持完整，这是符合优先级的取舍。
- **之前两轮为什么没修好**：第一轮把问题当成「宽度不够」，加了 `max-w` 阶梯；第二轮把文案拆成三段、但标签仍锁在 trailing 的 `shrink-0` 容器里，上限只能是自己的 `max-w`。真正的死结是标签够不着中部空白——空白在 leading 的 `flex-1` 里，两者不连通，标签在 144px 里再怎么分段也不够用。

### 断点必须挂在 `conversation` 容器

行内编辑卡位于会话流内，祖先是 `SessionPane` 的 `@container/conversation`。`@container/composer` 只声明在底部大输入框与设置页自动化输入框上，行内卡与它们是兄弟而非父子；命名容器查询在没有同名祖先时恒为 false，挂了等于永久隐藏。

因此行内卡的响应式规则一律使用 `/conversation` 变体，禁止使用 `/composer` 变体。大输入框内部的 `V4ComposerModeControls`、`V4ComposerToolbar` 挂 `/composer` 是正确的，不受此约束。

## 状态所有者与数据流

冻结值的唯一所有者是 CLI admission：入队时 `ConversationInputIntent` 自包含 `mode` 与 `modelSelection`，此后 queue / guide / runtime / transcript 只携带、不重建。UI 是纯读方。

```
输入提交 → CommandInbox admission（冻结 mode/modelSelection）
  → editUserQuery（只换 text，其余逐字段沿用）
  → TurnStarted 投影把 intent 冻结值写入 row.admissionMode / admissionModelSelection
  → SessionPane 把同一份 modelSelectionView 注入行渲染上下文
  → ConversationRowView 只读展示（本次改动的全部范围）
```

`ConversationInputIntent` 仍是执行真值；row 上的两个字段是它的**投影副本**，仅供展示与旧 snapshot 回放，不得被 UI 回写。

## 接口

- `packages/shared/src/zcode-protocol-v4/rows.ts`：`UserInputRow.admissionMode` / `admissionModelSelection`，均可选，旧 snapshot 缺省时显示「未知模式」/「选择模型」占位。
- `packages/ui/src/v4/conversationEditFrozenDisplay.ts`：承载四条展示 class 决策（模式文案可见性、provider 前缀可见性、档位后缀可见性、模型名宽度阶梯）与三段解析（`resolveFrozenModelSegments`，内部调 `resolveV4ModelTriggerDisplay` 拿结构化前缀，再由 `formatFrozenLevelSuffix` 单独产出后缀），全部是可被 `node --test` 覆盖的纯决策点。`buildRegistryModelSelectGroups` 留在组件里调用后传入，本模块不引目录构建链，保持 `node --test` 可直接加载。
- `packages/ui/src/v4/modelChangeThoughtLabel.ts`：档位后缀的拼装与模型切换分隔线共用同一处（`formatFrozenLevelSuffix` 以空基串调用 `formatModelChangeThoughtLabel`，得到 ` · <档位>`），同一轮的档位在分隔线与冻结标签上必须是同一个词。
- `packages/ui/src/chat-input-toolbar/thoughtLevelLabelIds.ts`：本次从 `thoughtLevelOptions.ts` 拆出的无依赖叶子模块，持有档位值 → 词条 id 的唯一映射表。拆分原因：工具条那份还要提供 `getThoughtLevelLabel`，那条链经 `display.js` 拖进 provider 图标等资源，工具条之外的消费方（子代理模型标签、行内编辑卡）无法只引它做纯逻辑测试。`thoughtLevelOptions.ts` 继续转出 `thoughtLevelLabelId`，既有调用方不改。
- `packages/ui/src/prompt-editor/ChatPromptEditor.tsx`：`cancelPosition?: "beforeBetween" | "afterBetween"`，缺省 `beforeBetween` 保持现状；`trailingFlexible?: boolean`，缺省 `false`——为 `true` 时 leading 外层 `flex-1` 换 `shrink-0`、trailing `ml-auto shrink-0` 换 `min-w-0 flex-1`，其余类名逐字不变。正式大输入框与设置页自动化输入框不传，布局零变化；只有行内编辑卡传 `true`。

## 不变量

- 展示层只读：行内卡不发任何命令，不引入第二条 `mode` 写入路径。
- 展示名只在展示层派生，不得写回配置、目录、协议或请求参数。
- 档位用词只有一处实现：任何要显示思考档位的位置都查 `thoughtLevelLabelId` 这张表，不得直接显示规范值，也不得各自复制映射。
- **冻结标签按段让位，不整串截断**：模型名是最后让位的一段，也是标签里唯一可被截断的段；provider 前缀与档位后缀各自独立可见性，不得拼进同一个文本节点再交给 `truncate`。
- **后缀不可截断、间距用 margin**：档位后缀带 `shrink-0`，与模型名之间用 `ml-1`，不依赖字符串前导空格。
- **隐藏不许丢信息**：任何被宽度隐藏的段，完整值都必须能从 tooltip 读到。
- 目录未就绪时回落占位，不猜测、不按当前会话档位回填。
- 断点容器名与组件的真实祖先一致（行内卡 = `conversation`）。
- 正式大输入框的布局与响应式行为不受本规范影响。

## 负面边界

- **不加可编辑控件**：不给 `editUserQuery` 加 `mode` 字段，不做 handler 覆盖，不新增权限写入路径。改权限真值是独立的高风险议题。
- **不展示思考档位控件**：`reasoningLevel` 只作为模型名后缀出现，不做可点击的档位切换。
- **不动队列编辑路径**：只覆盖已进入时间线的历史消息行内编辑。
- **不改 provider 前缀规则**：OpenCode 聚合网关是否该拼前缀是目录命中与模型 id 自带厂商段的独立议题，不在本次范围。本次只让已存在的前缀在窄列可被隐藏。
- **不拓宽行内卡本身**：卡体仍 `max-w-xl`，与用户气泡的 36rem 封顶保持一致。
- **不接 `useComposerToolbarFit`**：该 hook 的 `available`/`content` 是 leading 侧几何，而冻结标签在 `ml-auto shrink-0` 的 trailing；要让它参与测量，得先给模式徽标与 rewind 定义「折叠成什么」的语义（`data-composer-compact` 的 CSS 消费方目前只在大输入框的 `V4ComposerModeControls` / `V4ComposerCuaEntry`），那是独立议题。行内卡沿用本文件既有的 `conversation` 断点阶梯口径。
- **不引入 `RollingToolbarLabel`**：它带 `AnimatePresence` 滚动动画，服务于模型切换；冻结值在挂载期不变。
- **不改 i18n key、不改协议字段**：tooltip 复用既有 `chat.edit.frozenModel.tooltip` 作 description，完整标签作 title。

## 验收场景

1. 点开一条历史消息编辑：底部从左到右为「模式徽标（含 Plan/Ask/Agent 文案）… 模型名（含本地化档位后缀，如「· 高」）→ rewind → × → 发送」，模式文案可见，档位用词与大输入框档位控件一致。
2. **带档位的一轮 + 窄会话列（约 390px）**：标签显示 `Space Bunny Free · 最高` 并向左伸展吃掉中部空白，不出现 provider，不出现 `· ...`，rewind/×/发送钉在右侧；若模型名过长，只截模型名段，后缀保持完整。
3. 同一轮把会话列拉到 ≥1024px：完整显示 `OpenCode Go/Space Bunny Free · 最高`——provider 回来且不被截断（卡内空间够时无省略号）。
4. 会话列 <480px：模式文案收为纯图标、档位后缀隐藏，模型名单独占满剩余宽度。
5. 任意宽度 hover 冻结标签：tooltip 同时给出完整标签与「重发将沿用本轮模型，不可更改」。
6. 无 `admissionModelSelection.options.reasoningLevel` 的轮次：标签只有 provider / 模型名，不带 `·`，不出现悬空分隔符。
7. 正式大输入框与设置页自动化输入框：改前改后 DOM/截图对比一致（`trailingFlexible` 缺省关闭的证明）。
8. 按 Esc 退出编辑态；点 × 取消，draft 回滚行为与改动前一致。
9. 旧 snapshot（无 `admissionMode` / `admissionModelSelection`）：显示「未知模式」/「选择模型」占位，不分段、不报错、不按当前会话档位回填。
10. 目录未就绪时打开编辑：模型名显示占位，目录就绪后自动解析为真实名称。
11. 正式大输入框：底部无 × 按钮，模式控件与模型胶囊的响应式行为与改动前逐像素一致。
12. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；`node --test` 用例通过；用 vite + `@tailwindcss/vite` 编译验证 `@min-[1024px]/conversation` 规则真实生成（无静默失效）。

验收命令（沿用仓库既有约定）：

```
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/conversationEditFrozenDisplay.test.ts
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/modelTriggerDisplay.test.ts
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/thoughtLevelLabelIds.test.ts
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test apps/zcode-cli/packages/bootstrap/test/admissionFrozenRowFields.test.ts
```
