# Spec: 对话底部运行态转圈

## 目标

底部转圈只回答一件事：**这个会话还在跑吗**。它是会话级信号，不是窗口内容级的——用户在长会话中部读历史、或用轮导航跳到几屏之前时，转圈依然如实显示「会话在跑」。

## 现状与根因

第一版判据 `isLastTurn && isRunning`，两者都从**窗口内渲染单元**派生：`isLastTurn` 是「当前窗口最后一轮」（`conversationTurnRenderUnits.ts` 的 `index === total - 1`），`isRunning` 主要读该轮 `turnHeader.state`。

由此产生两处错误：

- 跳转换窗（`loadWindowAround`）把窗口搬到中部后，窗口末轮是一轮早已完成的旧轮 → 转圈消失，而会话尾部正在跑；
- 冷快照尾窗可能裁掉 `turnHeader`，`resolveTurnRunning` 只能回退到行状态/sessionPhase 猜测，转圈在同一条真实运行态上时亮时灭。

改为纯 `sessionRunning` 判定时又删过了头：`TurnChatLoadingSlot` 是**逐轮**渲染的，`sessionRunning` 是窗口共享的单值，于是窗口连尾时窗口里每一轮都亮起转圈——「会话在跑」退化成了「每轮都在跑」。根因是把两层判据合并成了一个：**显隐判据**（转圈该不该亮，答会话状态）与**放置约束**（亮在哪个单元，答渲染位置）必须分开。

会话级权威信号一直在协议里：`snapshot.session.control.phase`（`running` / `prewarming`，另有派生量 `sessionEnded` / `canStop`）。

## 产品规则

1. **运行态只由会话控制面给出**：`sessionRunning = snapshot.session.control.phase ∈ {running, prewarming}`。窗口里有没有 `turnHeader`、窗口末轮是哪一轮，都不参与判定。
2. 转圈的显隐 = `sessionRunning` 且未被下列阻塞项接管：
   - 等待用户操作（权限确认、`AskUserQuestion`）——弹窗/问答卡已经是唯一进度反馈；
   - activeWork（compact、goalVerifier 等）与维护型行（compact/goalVerify 标记为 running）。
     两类阻塞项沿用 `hasChatLoadingBlockingInteraction` / `hasChatLoadingBlockingActiveWork` 的既有判定，不新增。
3. **渲染位置与全局唯一**：任何时刻整个消息层**至多一个**转圈。
   - 窗口连尾时：恰好一个，挂在窗口**末轮**内容末尾——放置约束是 `isLastTurn`（`conversationTurnRenderUnits.ts` 的 `index === total - 1`），非末轮一律不渲染轮内转圈槽；
   - 窗口脱尾（`contiguousToTail === false`）时：恰好一个，渲染在消息层底部——最后一个可见单元之下、后续补页提示之上，不依附任何具体轮次。
   两条路径互斥由一个开关保证：Timeline 下发 context 时把 `sessionRunning` 与 `!canLoadNewer` 取合——脱尾时轮内的显隐一律拿到 false，转圈因此只可能出现在消息层底部；连尾时反之。位置约束（`isLastTurn`）与显隐判据（`sessionRunning`）是两层，缺任何一个都会破坏唯一性：缺前者连尾时每轮都亮，缺后者跳转后转圈熄灭。
4. `data-*` 诊断属性同步：`data-chat-running` 由 sessionRunning 派生，不再由窗口末轮派生。
5. 转圈不参与滚动锚定、测高补偿与 inset 记账的任何判据。

## 状态所有权

- `ConversationProjectionStore` / 协议：会话控制面（`session.control.phase`）是唯一 owner。
- `SessionPane`：读 store 计算 `sessionRunning`，经 `ConversationRowRenderContext` 下发。
- `ConversationTurnGroup` / `ConversationTimeline`：只消费并决定渲染位置。

## 事件顺序

```text
snapshot / delta 更新 → SessionPane 算 sessionRunning
  → context 下发
  → 窗口含尾轮：末轮内容末尾出转圈；窗口脱尾：消息层底部出转圈
等待授权 / activeWork 接管 → 转圈消失（交互 UI 接管进度反馈）
会话终态（completed*）→ 转圈消失
```

## 负面边界

- 不改协议：`session.control.phase` 已是既有字段，UI 不自造运行态。
- 不动 `turnHeader.state` 在轮内语义（`isRunning`、终态展开规则）上的用法——那些是**轮**的属性，不是会话的。
- 不把阻塞项判定改成新规则、不新增 loading 样式或动画。
- 不用「脱尾时也没有转圈」来回避位置问题：转圈回答的是会话状态，用户在中部读历史时它必须还在。
- `isLastTurn` / `isRunning` 是**轮**的属性：前者在本 spec 里只作为轮内转圈的放置约束（只有窗口末轮允许挂轮内转圈槽），后者的轮内语义（终态展开规则、工时折叠、live tail 切分、运行中计时）保持不动。两者都不参与会话级**显隐**判定。

## 验收

1. 打开正在跑的会话：末轮末尾出现转圈；会话结束转圈消失。
2. 正在跑时用轮导航跳到 10 轮之前：底部转圈仍可见；跳回尾部后位置恢复。
3. 运行中弹出权限确认：转圈消失，授权完成后按运行态恢复。
4. 已完成会话冷启动（尾窗裁掉 turnHeader）：无转圈（终态优先）。
5. 窗口脱尾时轮内不出现转圈，消息层底部出现且只有一个。
6. 窗口连尾且会话在跑时，整个消息层恰好一个转圈、位于末轮内容末尾；更早的轮不得出现转圈槽亮起。
7. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `packages/ui` 测试通过。
