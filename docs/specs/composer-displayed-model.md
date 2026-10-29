# Spec: 工作区“最后展示的模型”记录（Composer Displayed Model）

命令中心 AI 搜索在浮层打开时要知道“当前工作区现在用哪个模型跑”。模型切换器在浮层
打开后够不到，而 per-session Composer 草稿又不是工作区级事实（后台窗格、旧会话、
草稿 scope 都可能持有不同选择）。本 spec 定义一份独立的工作区级记录：**前台 Composer
最后一次真正展示出来的具体可用模型**。

`readComposerRecent` / `captureComposerRecentSubmission`（最近一次 accepted 发送偏好）
语义不变，本记录与它分开存储、分开读取，互不写回。

## 状态所有者与写入口

| 事实                       | 所有者                                                | 说明                                                 |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| 下一次提交的模型意图       | `useDraftConfigControl`（既有）                       | 本记录只读它派生出的展示值，不反向写入               |
| 最后展示的模型             | `packages/ui/src/lib/composerDisplayedModel.ts`       | 唯一读写 API；唯一写入方是 SessionPane 的前台 effect |
| 最近一次 accepted 发送偏好 | `packages/ui/src/lib/composerRecent.ts`（既有，不变） | 只负责发送后偏好                                     |

- 写入口只有一个：`SessionPane` 的 `useEffect` 调用
  `recordComposerDisplayedModel(workspacePath, selection, workspaceIdentity)`。
  该 effect 读取本 pane 的 `draftConfig.modelSelection` 与 `modelSelectionView`，
  条件满足才写。
- 读入口只有命令中心：`CommandCenterDialog` 调用
  `readComposerDisplayedModel(workspacePath, workspaceIdentity)`。
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
焦点 pane 切换即使模型未改也会重新执行 effect；`recordComposerDisplayedModel`
按序列化结果去重，不会重复写 localStorage。

## “真正展示一个具体可用模型”的判据

由 `resolveComposerDisplayedModelSelection` 统一判定，写入前必须通过：

1. Composer 有具体 `modelSelection`（组意图 / 空选择不记录；不编造成员）。
2. `modelSelectionView` 已 ready，且该 `providerId` 在视图 `providers` 中。
3. 该 provider 在 Composer 模型菜单中可见：与
   `lib/modelSelectionGroups.ts#supportsRegistryApiFormat` 同一规则
   （`api.type` 非空且当前展示 provider 为 ZCode Agent）。
4. 该 `modelId` 在该 provider 的 `models` 中，且不是 `<synthetic>` 占位。
5. `reasoningLevel` 只在该模型档位表接受时才写入；否则只记录 provider/model，
   不把 Composer 实际显示为空的档位写进记录。

不满足任一条（模型视图未就绪、模型失效/下线、组意图、空选择）时：本次不写，
保留上一次具体记录。这与既有触发器的“不可选 → 占位文案”降级方向一致，不新增兜底分支。

## 数据与存储

- key：`zcode-composer-displayed-model-v1:<workspaceKey>`，
  其中 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
- value（最小版本化 schema）：

```json
{
  "version": 1,
  "selection": { "providerId": "p1", "modelId": "m1", "options": { "reasoningLevel": "low" } }
}
```

`selection` 用 `modelSelectionSchema` 校验；`options` 可省略。只存结构化
provider/model/options，不存展示名。

## 事件顺序

```text
draftConfig / ModelSelectionView 变化（useDraftConfigControl，唯一 composer owner）
        │
        ▼
SessionPane useEffect（render 后执行）：resolveForegroundDisplayedModelSelection
        │  前台判据不满足 → 直接返回 null，后台 pane 不产生写入
        ▼
resolveComposerDisplayedModelSelection（具体可用模型？）
        │  否 → 本次不写，保留旧记录
        ▼ 是
recordComposerDisplayedModel（workspaceKey；与存储现值相同则跳过）
        │
        ▼
localStorage（Renderer 本地）

命令中心浮层打开
        │
        ▼
readComposerDisplayedModel → 命中则作为 aiSearchModelInput
        │  未命中/坏数据
        ▼
readComposerRecent(...)?.modelSelection（既有最近提交偏好，行为不变）
        │  仍为空
        ▼
useModelSelectionServiceView 的 preferredSelection（既有）
        │  仍为空
        ▼
CLI 配置默认（既有）
```

- 副文案与 `startAiHistorySearch` 下发共用同一份 `aiSearchModelInput`；
  `resolveAiSearchModelSelection` 的最低档规则不变。
- 记录只影响命令中心读取，不反向修改 Composer 当前选择或 `composerRecent`。

## 失败与失效

- localStorage 不可用、`getItem/setItem` 抛错、JSON 损坏、`version` 不匹配、
  schema 校验失败：读取返回 `null`，写入静默跳过并记 `warn`；不阻断 Composer、
  不阻塞 UI。
- 记录缺失：命令中心退回既有 `readComposerRecent`；该值也可能是空/坏数据，
  继续沿既有 `preferredSelection` / CLI 默认链路。
- 记录里的模型已从目录移除：命令中心把它当普通 input 交给视图解析，
  视图按既有规则给出 `effectiveSelection` 或退回 `preferredSelection`；
  本记录不做跨版本迁移或“猜模型”。

## 本地边界

- 纯 Renderer localStorage：同一 workspace key 在同一客户端内生效；
  不跨手机 / 桌面 / 多个 Host 同步，不写服务端，不恢复已撤销的 Host 草稿共享。
- key 与 `workspaceIdentity` 对齐；远程 workspace 用 identity 而非路径匹配。
- 不新增 RPC、Service、持久化迁移；每个 workspace key 只保存一条记录。

## 验收场景

1. 前台新建任务 Composer 显示模型 A → 命令中心 AI 搜索副文案与下发都是 A。
2. 切到已有会话（模型 B）→ 记录变为 B；不发送也更新。
3. 分屏两个 pane：focus pane A→B→A，记录跟随焦点 pane 的展示模型；
   后台 pane 的目录 / 会话更新不改记录。
4. 用户改模型且 Composer 展示随之变化 → 记录更新。
5. 切到模型组 / 无可用模型 / 模型视图未就绪：本次不写，命令中心仍用上一次
   具体记录；没有记录时退回 `readComposerRecent`。
6. localStorage 写入抛错或内容损坏：Composer 正常，命令中心不崩溃并走既有回退。
7. 未 focus 的隐藏侧栏 tab 或 Settings 打开期间，任何 Composer 更新都不写记录。

## 验证边界

仓库 `packages/ui/test` 用 `node:test` + `tsx`，没有 jsdom / testing-library，无法在
node 中挂载 React effect；浏览器 fixture 会另起独立浏览器，不在本改动的验证范围。

- 纯函数与组合链路（场景 1、2、5、6 的存储与降级语义）由
  `packages/ui/test/composerDisplayedModel.test.ts`、`aiSearchModelInput.test.ts` 执行：
  覆盖 accepted 发送 A / 前台展示 B 未发送 → 命令中心读 B、视图解析 B、搜索最低档仍 B；
  以及焦点 A→B(未改未发)→A、后台目录/会话更新不抢写、同值去重。
- 接线（场景 3、4、7 的 effect 门与浮层重开）由
  `packages/ui/test/composerDisplayedModelWiring.test.ts` 的源码断言确证：
  SessionPane effect 使用 `focused/visible/readOnly/selectionSideChat`、唯一调用
  `recordComposerDisplayedModel`，命令中心 `aiSearchModelInput` 的 `open` 依赖与
  displayed → recent 顺序。源码断言不是 E2E。
- 真实 GUI 验收（分屏焦点切换、后台目录刷新、Settings/Files 覆盖、副文案与实际下发
  一致）需要手工或浏览器 fixture 执行；本次未执行真实 GUI E2E。
