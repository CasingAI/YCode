# Spec: 工作区“最后展示的模型”记录（Composer Displayed Model）

命令中心 AI 搜索在浮层打开时要知道“当前工作区现在会拿哪个模型意图跑”。模型切换器在
浮层打开后够不到，而 per-session Composer 草稿又不是工作区级事实（后台窗格、旧会话、
草稿 scope 都可能持有不同选择）。本 spec 定义一份独立的工作区级记录：**前台 Composer
最后一次真正展示出来的模型意图**，它有两种互斥形态：

- 具体模型 `{ selection: ModelSelection }`；
- 模型组意图 `{ modelGroupIntent: ModelGroupIntent }`（`groupId` + `groupNameSnapshot`）。

`readComposerRecent` / `captureComposerRecentSubmission`（最近一次 accepted 发送偏好）
语义不变，本记录与它分开存储、分开读取，互不写回。

## 状态所有者与写入口

| 事实                       | 所有者                                                | 说明                                                 |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| 下一次提交的模型意图       | `useDraftConfigControl`（既有）                       | 本记录只读它派生出的展示值，不反向写入               |
| 最后展示的模型意图         | `packages/ui/src/lib/composerDisplayedModel.ts`       | 唯一读写 API；唯一写入方是 SessionPane 的前台 effect |
| 最近一次 accepted 发送偏好 | `packages/ui/src/lib/composerRecent.ts`（既有，不变） | 只负责发送后偏好，组意图语义不变                     |

- 写入口只有一个：`SessionPane` 的 `useEffect` 读取 `draftConfig.modelSelection` 与
  `draftConfig.modelGroupIntent`，调用 `recordComposerDisplayedModel(workspacePath,
displayed, workspaceIdentity)`。`displayed` 是互斥整体，只能带具体选择或组意图一侧。
- 读入口只有命令中心：`CommandCenterDialog` 调用
  `readComposerDisplayedModel(workspacePath, workspaceIdentity)`。
- 同一个 workspace key 只有一条记录；每次写入整体覆盖，不 merge、不双写、不新增
  只保存 `selection` 的第二条写路径。
- 不新增 App → 命令中心的 sessionId 传参，不新增 Service / RPC / Host 草稿共享。

## 前台判据（唯一）

只有同时满足以下条件的 pane 才允许写入：

```text
foreground = focused && telemetryVisible && !selectionSideChat && !readOnly
```

- `focused`：`V4WorkspaceChatArea` 既有信号
  `foregroundEnabled && focusedPaneId === paneId`。Settings / Files 等覆盖层打开时
  `foregroundEnabled=false`；分屏时只有 focused pane 为 true。
- `telemetryVisible`：pane 是否真实可见（forceMount 的隐藏侧栏 tab 为 false）。
- `selectionSideChat`、`readOnly`：辅助 / 只读视图的 composer 不是工作区模型入口。

后台 pane 的普通重渲染、后台目录刷新、后台会话更新都不满足 `focused`，因此不会抢写。
组重命名只在组意图所在 pane 处于前台时经 `modelSelectionView` 更新写回；后台 pane 的
目录刷新不写。焦点 pane 切换即使意图未改也会重新执行 effect；
`recordComposerDisplayedModel` 按序列化结果去重，不会重复写 localStorage。

## 写入判据

由 `resolveComposerDisplayedModelIntent` 统一判定，按以下顺序取**一侧**：

### 具体模型

具体选择的可用性判据与既有实现一致：

1. Composer 有具体 `modelSelection`。
2. `modelSelectionView` 已 ready，且该 `providerId` 在视图 `providers` 中。
3. 该 provider 在 Composer 模型菜单中可见：与
   `lib/modelSelectionGroups.ts#supportsRegistryApiFormat` 同一规则
   （`api.type` 非空且当前展示 provider 为 ZCode Agent）。
4. 该 `modelId` 在该 provider 的 `models` 中，且不是 `<synthetic>` 占位。
5. `reasoningLevel` 只在该模型档位表接受时才写入；否则只记录 provider/model，
   不把 Composer 实际显示为空的档位写进记录。

不满足任一条（模型视图未就绪、模型失效/下线、空选择）时本侧不产生记录，保留上一次
记录（与既有触发器的“不可选 → 占位文案”降级方向一致）。

### 模型组意图

组意图不做成员可用性裁决，**即使组为空 / 已删除 / 已停用 / 目录尚未就绪也必须记录**：

1. `draftConfig.modelGroupIntent.groupId` 非空（schema 校验）。
2. 组名按 `resolveModelGroupDisplayName(view, intent)` 解析：当前视图
   `view.modelGroups` 里的组名优先，组不在视图（已删 / 停用 / 目录未就绪）时用
   `groupNameSnapshot`。与 `V4ComposerToolbar` 的组胶囊展示同一规则。
3. 只记录组身份与名快照，不编造组内成员、不猜档位、不写入 `modelSelection`。
4. 组名重命名由前台 pane 的视图更新触发整体覆盖；后台 pane 不抢写。

写入侧永远只写一个叶子。若调用方异常传入两侧，按具体选择单写（与读取坏混合数据的
既有“具体优先”一致），不得留下双字段记录。

## 数据与存储

- key 与 version 不变：`zcode-composer-displayed-model-v1:<workspaceKey>`，
  其中 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
- value（version 1，互斥整体，二选一）：

```json
{
  "version": 1,
  "selection": { "providerId": "p1", "modelId": "m1", "options": { "reasoningLevel": "low" } }
}
```

```json
{ "version": 1, "modelGroupIntent": { "groupId": "g1", "groupNameSnapshot": "省钱组" } }
```

- `selection` 用 `modelSelectionSchema` 校验，`modelGroupIntent` 用
  `modelGroupIntentSchema` 校验；`options` 可省略。只存结构化身份，不存展示名
  （组的 `groupNameSnapshot` 是协议既有字段，属于组意图身份的一部分）。
- 向后兼容：旧 version 1 的只含 `selection` 记录按具体模型照常读取；新代码不单独
  写这种结构之外的第二种 key 或第二条记录。

## 事件顺序

```text
draftConfig（modelSelection | modelGroupIntent，二者互斥；useDraftConfigControl 唯一 owner）
        │
        ▼
SessionPane useEffect（render 后执行）：resolveForegroundDisplayedModel
        │  前台判据不满足 → 直接返回 null，后台 pane 不产生写入
        ▼
resolveComposerDisplayedModelIntent
        │  具体模型可用 → { selection }
        │  否则组意图存在 → { modelGroupIntent: 组 ID + 当前名/名快照 }
        │  都没有 → 本次不写，保留旧记录
        ▼
recordComposerDisplayedModel（workspaceKey；整体覆盖；与存储现值相同则跳过）
        │
        ▼
localStorage（Renderer 本地，一条记录）
```

```text
命令中心浮层打开
        │
        ▼
readComposerDisplayedModel → { selection } | { modelGroupIntent }
        │  未命中/坏数据
        ▼
readComposerRecent(...) 完整偏好（具体选择或组意图，行为不变）
        │  仍为空
        ▼
useModelSelectionServiceView 的 preferredSelection（既有，仅具体选择）
        │  仍为空
        ▼
CLI 配置默认（既有）
```

- `resolveAiSearchModelInput(displayed, recent)` 的优先级：
  displayed 具体 → displayed 组 → recent 具体 → recent 组 → 空。
  即“最后展示的组”整体优先于“最近一次发送的具体模型”；displayed 缺失才用 recent。
- 组意图只取同 workspace 的 `ModelSelectionView.modelGroups` 目录做组名回填；
  `ModelSelectionViewInput` 仍只接受 `{ selection }`，不扩服务输入、不在 UI 选成员。
- 副文案与 `startAiHistorySearch` 下发共用同一份 `aiSearchModelInput`；具体选择的
  最低档规则不变，组意图原样下发，由 CLI 权威裁决实际成员。
- 记录只影响命令中心读取，不反向修改 Composer 当前选择或 `composerRecent`。

## 失败与失效

- localStorage 不可用、`getItem/setItem` 抛错、JSON 损坏、`version` 不匹配、
  schema 校验失败：读取返回 `null`，写入静默跳过并记 `warn`；不阻断 Composer、
  不阻塞 UI。
- 坏混合记录同时含合法 `selection` 与合法 `modelGroupIntent`：按既有
  `composerRecent` 规则优先具体选择，不把组意图抬到 recent 具体之前。
- 记录缺失：命令中心退回既有 `readComposerRecent`；该值也可能是空/坏数据，
  继续沿既有 `preferredSelection` / CLI 默认链路。
- 记录里的具体模型已从目录移除：命令中心把它当普通 input 交给视图解析，
  视图按既有规则给出 `effectiveSelection` 或退回 `preferredSelection`；
  本记录不做跨版本迁移或“猜模型”。
- 记录里的组已删除 / 停用 / 无可用成员：UI 不回落旧具体，也不改写成成员；
  照常把组意图下发给 CLI，由 CLI 在 admission 拒绝（`modelGroup.deleted` /
  `modelGroup.noMembers`），浮层展示 ACK 的 `message`。

## 本地边界

- 纯 Renderer localStorage：同一 workspace key 在同一客户端内生效；
  不跨手机 / 桌面 / 多个 Host 同步，不写服务端，不恢复已撤销的 Host 草稿共享。
- key 与 `workspaceIdentity` 对齐；远程 workspace 用 identity 而非路径匹配。
- 不新增 RPC、Service、持久化迁移；每个 workspace key 只保存一条互斥记录。
- `desktop-continuous` 与 `web-remote-replayable` 两条 delivery 语义不变。

## 验收场景

1. 前台新建任务 Composer 显示具体模型 A → 命令中心 AI 搜索副文案与下发都是 A。
2. 切到已有会话（模型 B）→ 记录变为 B；不发送也更新。
3. 分屏两个 pane：focus pane A→B→A，记录跟随焦点 pane 的展示模型；
   后台 pane 的目录 / 会话更新不改记录。
4. 用户改模型且 Composer 展示随之变化 → 记录更新。
5. 用户选择模型组 G（即使组为空 / 已删除 / 已停用 / 目录未就绪）→ 记录变为
   `{ groupId, groupNameSnapshot }`，覆盖旧的具体记录，不写入任何成员模型。
6. 组重命名且组意图所在 pane 在前台 → 记录中的组名随当前视图更新；
   后台 pane 的目录刷新不抢写。
7. 未选具体模型且无组意图（无可用模型 / 视图未就绪）→ 本次不写，命令中心仍用
   上一次记录；没有记录时退回 `readComposerRecent`。
8. localStorage 写入抛错或内容损坏：Composer 正常，命令中心不崩溃并走既有回退。
9. 未 focus 的隐藏侧栏 tab 或 Settings 打开期间，任何 Composer 更新都不写记录。
10. 旧 version 1 只含 `selection` 的记录仍被读取为具体模型；坏混合记录优先具体。

## 验证边界

仓库 `packages/ui/test` 用 `node:test` + `tsx`，没有 jsdom / testing-library，无法在
node 中挂载 React effect；浏览器 fixture 会另起独立浏览器，不在本改动的验证范围。

- 纯函数与组合链路（场景 1、2、5、6、7、8、10 的存储与降级语义）由
  `packages/ui/test/composerDisplayedModel.test.ts`、`aiSearchModelInput.test.ts` 执行：
  覆盖旧 v1 兼容、组 roundtrip / identity / 去重、组与具体互相覆盖、空组/删组快照、
  displayed 组优先 recent 具体、recent 组回退。具体模型的最低档规则由
  `packages/ui/test/aiSearchModelLevel.test.ts` 覆盖，不回归。
- 接线（场景 3、4、9 的 effect 门与浮层重开）由
  `packages/ui/test/composerDisplayedModelWiring.test.ts` 的源码断言确证：
  SessionPane effect 同时读取 `draftConfig.modelSelection` 与
  `draftConfig.modelGroupIntent`、使用 `focused/visible/readOnly/selectionSideChat`、
  唯一调用 `recordComposerDisplayedModel`；命令中心 `aiSearchModelInput` 的 `open`
  依赖与 displayed → recent 顺序。源码断言不是 E2E。
- 真实 GUI 验收（分屏焦点切换、后台目录刷新、Settings/Files 覆盖、组选择/重命名、
  副文案与实际下发一致）需要手工或浏览器 fixture 执行；本次未执行真实 GUI E2E。
