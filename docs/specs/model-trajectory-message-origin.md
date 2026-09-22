# Spec: 模型轨迹的消息来源分类（system prompt vs system reminder）

## 目标

模型调用轨迹查看器把所有 `role: "system"` 的消息一律显示为「系统提示词」。实际上这类消息有两种完全不同的来源：

1. **顶层系统提示**（agent 的固定 system prompt，每轮请求的前缀）；
2. **运行时注入的 system reminder**（runtime 在对话流中间插入的提醒，如权限模式提醒、goal state change 等）。

更严重的是保真问题：mid-conversation reminder 在不符合 provider 合法边界时会被 runtime 降级为 `role: "user"`、正文包裹 `<system-reminder>` 发送（`provider-mid-conversation-system.ts` 的 fallback 路径）。真实 model-io 数据证实了两种形态并存：同一份线上载荷里既有 mid-conversation 的 `system`，也有被降级成 `user` 的 reminder。而轨迹查看器直接读 SDK 输入视图（`record.request.messages`）并把 role 映射成标签，导致「线上以 user 发送的消息被标成系统提示词」，排查 prompt 问题时会被误导。

本改动让轨迹正确区分消息来源，并对注入类消息标注其在**线上载荷**中的实际角色。

## 产品规则

- **消息来源（origin）由 service 层在映射 model-io 时计算**，UI 不自行推断。分类规则：
  - `conversation`：普通对话消息（默认，旧记录缺省时也按此处理）。
  - `system-prompt`：请求开头的**连续前导** system 消息（每条请求自身的固定系统提示，含 sidecar/标题生成等辅助请求的 prompt）。
  - `system-reminder`：运行时注入。两种形态：
    - mid-conversation `system`（前面存在非 system 消息）；
    - `user` 消息且首个文本部分以 `<system-reminder>` 开头（MCS fallback 降级形态；与 `compact-selection.ts` 等既有内部判定一致）。
  - 正文形态随 runtime 演进，分类规则不依赖具体正文：权限档位提醒（`runtime_mode` 源）现为每个 model step 注入的一行 `<mode>Plan|Ask|Agent</mode>` 标签，线上实测以 MCS 降级形态出现（`user` + `<system-reminder>` 包裹）；行为指令本身在请求级 system 参数的静态段中。
- **`<system-reminder>` 前缀判定只作用于消息开头**。真实用户消息中后部附带的 reminder 块（如 context 注入追加在用户原文之后）不改变该消息的对话属性，仍为 `conversation`。
- **线上角色（wireRole）以 model-io 的 `request.body.messages` 为唯一事实来源**。service 层对分类为 `system-reminder` 的消息，按归一化文本在 body 消息列表中做**内容匹配**（不按位置对齐——SDK 视图与线上载荷是 1:N 关系，实测 256:474），命中则取该条线上消息的 role 作为 `wireRole`；未命中或 body 缺失时不设置。匹配只针对 reminder 类消息，且同一条线上消息只消费一次。

## 输入区展示结构（system prompt 与 reminder 不与对话消息混排）

轨迹「输入」区是 prompt 组装视图，不是线上 messages 数组。线上事实（实测）：前导 system prompt 会被提升为请求顶层 `system` 参数（不在 messages 里）；相邻的 user-role 消息会合并为一条 user 消息的多个 content block。因此输入区按以下结构渲染：

- **系统提示词独立成块**：`origin === "system-prompt"` 的消息从消息列表中提出，渲染为输入区顶部的独立「系统提示词」区块（各自可展开），不作为对话消息行参与角色列布局，也不参与后续 delta 的角色行流。
- **reminder 按线上形态归属**：
  - `wireRole === "system"`：线上确实是独立 system 消息（如 GLM 接受对话中段 system），保留独立行。它是有角色的系统消息，标签为「系统消息（运行时注入）」，不能标成 System reminder——否则标签（无独立角色）与位置（独立消息行）自相矛盾。
  - `wireRole === "user"` 或 `wireRole` 未确认（被合并进相邻 user 消息，或记录无线上载荷）：reminder 没有独立角色，**内嵌到所属用户消息行**下渲染（弱化样式），标签「System reminder（运行时注入）」，不再单独占一行。
- **用户回合分组**：连续的 user-role 消息（真实 user 与降级 reminder 混合）归为一个「用户回合」组——组内 `origin === "conversation"` 的第一条为主消息，其余 reminder 按原顺序内嵌其下。组内没有真实 user 消息时（reminder 独立出现在 assistant/tool 之间），保持独立行展示。
- assistant / tool 消息行不变。
- **UI 标签**：
  - `system-prompt` → 「系统提示词」（沿用现有 `modelTrajectory.role.system`）；
  - `system-reminder` → 「System reminder（运行时注入）」；若 `wireRole` 存在且与消息自身 role 不同，追加「线上以 {wireRole} 发送」徽标；
  - 其他 → 现有角色标签。
  - 视觉配色沿用消息实际 role 的样式（不新增配色体系），只改文案与徽标。
- **数据契约为可选字段追加**：`ZCodeModelTrajectoryMessage` 新增 `origin?` / `wireRole?`，旧 model-io 记录与旧 UI 版本兼容（缺省按 `conversation` 与无徽标处理）。

## 接口

- `packages/services/src/session/zcodeTaskService.ts`
  - `ZCodeModelTrajectoryMessageOrigin`：`"conversation" | "system-prompt" | "system-reminder"`。
  - `ZCodeModelTrajectoryMessage` 增加 `origin?: ZCodeModelTrajectoryMessageOrigin`、`wireRole?: string`。
- `packages/services/src/zcode-agent/modelTrajectoryMessageOrigin.ts`（新文件，纯函数，可测）
  - `classifyMessageOrigins(messages)`：按上述规则为映射前的原始消息数组标注 origin。
  - `attachWireRoles(messages, wireMessages)`：内容匹配回填 `wireRole`。
  - `normalizeMessageText(entry)`：`string | 内容块数组 → 纯文本`，供匹配与 `<system-reminder>` 前缀判定共用。
- `packages/services/src/zcode-agent/modelTrajectory.ts`
  - `mapMessages` 消费上述纯函数，输出带 origin / wireRole 的消息。
- `packages/ui/src/ModelTrajectoryPaneParts.tsx`
  - `MessageBlock` 的 roleLabel 选择改为：origin 优先（`system-reminder` 用新 i18n key），wireRole 差异徽标传入 `ExpandableTrajectoryMessage`。

## 状态与所有者

- 无新增运行时状态。origin / wireRole 是 model-io 读取时的一次性派生（projection），所有者是 service 层映射函数；UI 只读。
- model-io 落盘格式不变（`runner-debug.ts` 不动）。

## 验收场景

1. 主会话请求中，请求首条（前导 system）显示在独立「系统提示词」区块，不在消息行流里。
2. mid-conversation 注入的 reminder（线上为 system）显示「系统消息（运行时注入）」独立行，无差异徽标。
3. 被降级、且线上已合并进相邻 user 消息的 reminder（`wireRole` 未确认）内嵌在所属用户消息行下，不单独占行。
4. 线上载荷中 reminder 的 role 与 SDK 视图不一致时（provider 改写），显示「线上以 {role} 发送」徽标。
5. 真实用户消息中后部附带 reminder 块 → 仍显示「用户消息」，无注入标注。
6. 旧 model-io 记录（无 body、无新字段）→ reminder 全部内嵌到相邻用户回合（未确认形态），系统提示词区块照常，不报错。
7. 同文本 reminder 注入多次 → 逐条消费匹配，各自得到正确的 wireRole。
8. 连续 user-role 消息中不存在真实 user 消息时（reminder 独立在 assistant/tool 之间）→ 保持独立行。
