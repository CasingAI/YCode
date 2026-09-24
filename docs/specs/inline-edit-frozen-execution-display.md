# Spec: 行内编辑卡冻结执行选择的只读展示

## 目标

编辑历史消息再发送时，`editUserQuery` 是一次换文本的 retry：沿用被编辑轮在 admission 阶段冻结的 `mode` 与 `modelSelection`，不接受新的执行选择。用户在点开编辑框的瞬间看不到这层约束，只能在重发后从权限弹窗或模型切换记录里反推。

本规范定义行内编辑卡对这两个冻结值的**只读展示**：模式徽标常显在左，模型名常显在右并与 rewind、取消、发送键同排。展示层不新增状态、不新增命令、不新增权限写入路径。

本次修订修正一处实现缺陷：模式文案原先挂在 `@xl/composer` 容器断点上，而行内编辑卡不在该容器子树内，命名容器查询恒为 false，文案在任何宽度下都不显示。

## 产品规则

### 展示内容

- **模式**：从 `admissionMode` 查 `getZCodeAgentAvailableModes()`，命中则显示该模式的本地化标签（Plan / Ask / Agent 等），未命中或旧 snapshot 缺字段时显示「未知模式」占位。图标始终存在，yolo 用警示色。
- **模型**：把 `admissionModelSelection` 编码成选项值，在同一份 `modelSelectionView` 目录里查；命中则复用输入区胶囊的展示规则（`formatModelDisplayName` 排版 + 内置家族不拼 provider 前缀、其余拼 `<providerName>/`），并追加 ` · <档位>` 后缀。档位值是规范值（`high` / `xhigh` / …），**必须查工具条同一张映射表**（`thoughtLevelLabelId`）再本地化，否则中文界面会出现「· high」而大输入框显示「高」；映射表里没有的值原样显示 provider 自己的档位名。目录未就绪、未命中、缺字段一律回落「选择模型」占位，不按当前会话档位回填、不反推 provider 名。
- 两者都带 tooltip 说明「重发将沿用本轮模式/模型，不可更改」，并以 `aria-disabled` 表达只读语义；不是真禁用态按钮，不参与 tab 序列。

### 排列

从左到右固定为：`模式徽标 … 模型名 → rewind → × → 发送`。

- 模式徽标走 `leadingActions`，模型名走 `betweenCancelAndSubmitAction`，取消键用 `cancelPosition="afterBetween"` 排在该插槽之后。
- 模型名必须留在取消键左侧：把标签挪进左侧 `flex-1` 区域虽然能借用空白，但会把「× 紧跟模型名」重新拆开。
- Esc 取消走编辑器独立 keydown，与按钮位置无关。

### 宽度分级跟随会话列

- **模式文案常显**，只保留 `truncate` 作为兜底；会话列窄于 360px 时回落为纯图标，与 `ToolSummaryRow` 的 `@max-[360px]/conversation:hidden` 同一口径。
- **模型名上限随会话列递增**：`max-w-28` → 624px 起 `max-w-48` → 864px 起 `max-w-72` → 1280px 起 `max-w-80`。行内卡自身 `max-w-xl`（576px）仍是最终天花板，最大一档 320px 加上 rewind/×/发送与内边距仍在卡内，因此放宽上限不会把发送键顶出卡外。基础档 112px 是极窄列的算术余量：360px 会话列减去卡片内边距与工具条间距后约 316px，「模式徽标 + 模型名 + 三个尾部按钮」刚好放得下。
- 尾部动作区是 `ml-auto shrink-0`，左侧 `leadingActions` 才是 `flex-1`。模型名借不到左侧空白，**它自己的 `max-w-*` 是唯一生效的约束**——这正是不能只删上限、必须给上限分档的原因。

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
- `packages/ui/src/v4/conversationEditFrozenDisplay.ts`：本次新增。承载两条展示 class 决策（模式文案可见性、模型名宽度阶梯）与模型名 + 档位后缀的拼装（`formatFrozenModelLabelWithLevel`，内部查 `thoughtLevelLabelId`），作为可被 `node --test` 覆盖的纯决策点。
- `packages/ui/src/chat-input-toolbar/thoughtLevelLabelIds.ts`：本次从 `thoughtLevelOptions.ts` 拆出的无依赖叶子模块，持有档位值 → 词条 id 的唯一映射表。拆分原因：工具条那份还要提供 `getThoughtLevelLabel`，那条链经 `display.js` 拖进 provider 图标等资源，工具条之外的消费方（子代理模型标签、行内编辑卡）无法只引它做纯逻辑测试。`thoughtLevelOptions.ts` 继续转出 `thoughtLevelLabelId`，既有调用方不改。
- `packages/ui/src/prompt-editor/ChatPromptEditor.tsx`：`cancelPosition?: "beforeBetween" | "afterBetween"`，缺省 `beforeBetween` 保持现状；正式大输入框不传，行为零变化。

## 不变量

- 展示层只读：行内卡不发任何命令，不引入第二条 `mode` 写入路径。
- 展示名只在展示层派生，不得写回配置、目录、协议或请求参数。
- 档位用词只有一处实现：任何要显示思考档位的位置都查 `thoughtLevelLabelId` 这张表，不得直接显示规范值，也不得各自复制映射。
- 目录未就绪时回落占位，不猜测、不按当前会话档位回填。
- 断点容器名与组件的真实祖先一致（行内卡 = `conversation`）。
- 正式大输入框的布局与响应式行为不受本规范影响。

## 负面边界

- **不加可编辑控件**：不给 `editUserQuery` 加 `mode` 字段，不做 handler 覆盖，不新增权限写入路径。改权限真值是独立的高风险议题。
- **不展示思考档位控件**：`reasoningLevel` 只作为模型名后缀出现，不做可点击的档位切换。
- **不动队列编辑路径**：只覆盖已进入时间线的历史消息行内编辑。
- **不改 provider 前缀规则**：OpenCode 聚合网关是否该拼前缀是目录命中与模型 id 自带厂商段的独立议题，不在本次范围。
- **不拓宽行内卡本身**：卡体仍 `max-w-xl`，与用户气泡的 36rem 封顶保持一致。
- **不改 i18n key、不改协议字段**：本轮只调整布局 class。

## 验收场景

1. 点开一条历史消息编辑：底部从左到右为「模式徽标（含 Plan/Ask/Agent 文案）… 模型名（含本地化档位后缀，如「· 高」）→ rewind → × → 发送」，模式文案可见，档位用词与大输入框档位控件一致。
2. 会话列拉宽到 1280px 以上：模型名可用宽度增大，长模型名（如带 provider 前缀与档位后缀者）不再被 192px 截断。
3. 会话列窄于 360px：模式文案隐藏为纯图标，模型名收窄到 `max-w-28`，发送键不被顶出卡外；360px 整宽时模式文案仍可见且一行放得下。
4. 按 Esc 退出编辑态；点 × 取消，draft 回滚行为与改动前一致。
5. 旧 snapshot（无 `admissionMode` / `admissionModelSelection`）：显示「未知模式」/「选择模型」占位，不报错、不按当前会话档位回填。
6. 目录未就绪时打开编辑：模型名显示占位，目录就绪后自动解析为真实名称。
7. 正式大输入框：底部无 × 按钮，模式控件与模型胶囊的响应式行为与改动前逐像素一致。
8. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；新增 `node --test` 用例通过。

验收命令（沿用仓库既有约定）：

```
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/conversationEditFrozenDisplay.test.ts
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/thoughtLevelLabelIds.test.ts
TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test apps/zcode-cli/packages/bootstrap/test/admissionFrozenRowFields.test.ts
```
