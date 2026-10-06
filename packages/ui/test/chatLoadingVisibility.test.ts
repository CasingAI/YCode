import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
  shouldShowTurnChatLoading,
} from "../src/v4/chatLoadingVisibility.js";

// 底部转圈是会话级信号（docs/specs/conversation-chat-running-indicator.md）：
// 显隐判据回答「这个会话还在跑吗」，只认会话控制面，与窗口里有没有 turnHeader、
// 末轮是哪一轮无关；放置约束回答「亮在哪个单元」，只有窗口末轮允许挂。
// 第一版两层合一（isLastTurn && isRunning），跳转换窗一次就熄灭一次；
// 改成纯 sessionRunning 又删过了头，连尾时每轮都亮（双转圈）。两层必须并存。

function toolRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    kind: "toolCall",
    rowId: 10,
    turnId: "turn-1",
    status: "ok",
    toolName: "Bash",
    ...overrides,
  } as unknown as ConversationRow;
}

function markerRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    kind: "timelineMarker",
    rowId: 11,
    turnId: "turn-1",
    marker: { type: "compact", status: "running" },
    ...overrides,
  } as unknown as ConversationRow;
}

const base = {
  isLastTurn: true,
  blockedByActiveWork: false,
  blockedByInteraction: false,
  sessionRunning: true,
  rows: [] as readonly ConversationRow[],
};

test("会话终态不显示转圈，哪怕窗口末轮自己写着 running", () => {
  assert.equal(shouldShowTurnChatLoading({ ...base, sessionRunning: false }), false);
  assert.equal(
    shouldShowTurnChatLoading({
      ...base,
      sessionRunning: false,
      rows: [toolRow({ status: "running" })],
    }),
    false,
  );
});

test("非末轮不亮：转圈槽逐轮渲染，放置约束缺了就连尾时每轮都亮（双转圈回归）", () => {
  // 判据只负责显隐（会话在跑吗）；「挂在哪一轮」由 isLastTurn 给出。删掉它，
  // 共享的 sessionRunning 会让窗口里每个转圈槽同时亮起。
  assert.equal(shouldShowTurnChatLoading({ ...base, isLastTurn: false }), false);
  assert.equal(
    shouldShowTurnChatLoading({
      ...base,
      isLastTurn: false,
      rows: [toolRow({ status: "running" })],
    }),
    false,
  );
});

test("运行中只由会话控制面决定，不看轮自己的状态", () => {
  // 窗口末轮是谁、轮的 turnHeader 写着什么，都不参与显隐判定——这正是要收口的地方；
  // isLastTurn 只作放置约束，不把显隐拉回窗口内容。
  assert.equal(shouldShowTurnChatLoading(base), true);
  assert.equal(
    shouldShowTurnChatLoading({ ...base, rows: [toolRow({ status: "complete" })] }),
    true,
  );
});

test("等待用户操作 / activeWork 接管时转圈让位", () => {
  assert.equal(shouldShowTurnChatLoading({ ...base, blockedByInteraction: true }), false);
  assert.equal(shouldShowTurnChatLoading({ ...base, blockedByActiveWork: true }), false);
});

test("行级 fallback：权限确认与维护型行在场时不闪回", () => {
  // 投影事实（pendingInteractions / activeWorks）可能晚于行状态到达，
  // 这两种行先到时必须已经不显示，否则底部转圈会在弹窗前后闪一下。
  assert.equal(
    shouldShowTurnChatLoading({ ...base, rows: [toolRow({ status: "pendingApproval" })] }),
    false,
  );
  assert.equal(shouldShowTurnChatLoading({ ...base, rows: [markerRow()] }), false);
  assert.equal(
    shouldShowTurnChatLoading({
      ...base,
      rows: [markerRow({ marker: { type: "compact", status: "completed" } })],
    }),
    true,
  );
});

test("阻塞项判定沿用既有规则：权限 / AskUserQuestion、compact / goalVerifier", () => {
  assert.equal(
    hasChatLoadingBlockingInteraction([{ payload: { kind: "permission" } }] as never),
    true,
  );
  assert.equal(
    hasChatLoadingBlockingInteraction([
      { payload: { kind: "userInput", toolName: "AskUserQuestion" } },
    ] as never),
    true,
  );
  // ExitPlanMode 等其它 userInput 语义不接管进度反馈。
  assert.equal(
    hasChatLoadingBlockingInteraction([
      { payload: { kind: "userInput", toolName: "ExitPlanMode" } },
    ] as never),
    false,
  );
  assert.equal(hasChatLoadingBlockingActiveWork([{ kind: "compact" }] as never), true);
  assert.equal(hasChatLoadingBlockingActiveWork([{ kind: "subagent" }] as never), false);
});

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

test("两个落点互斥：轮内位置按 canLoadNewer 取反，脱尾位置按 detachedChatRunning 取反", () => {
  // 同一个会话运行态有两种落点。不在「下发给轮内」这一侧按 canLoadNewer 取反，
  // 脱尾时就会在中部那一轮末尾挂出一个转圈，而消息层底部还有一个——两个转圈，
  // 而且那个挂在一轮早已完成的旧轮上，等于谎报「那一轮在跑」。
  assert.match(
    timelineSource,
    /sessionRunning:\s*sessionChatRunning\s*&&\s*!canLoadNewer/,
    "下发给轮内的运行态必须排除脱尾窗口",
  );
  assert.match(
    timelineSource,
    /const detachedChatRunning =\s*\n?\s*canLoadNewer && sessionChatRunning && !chatLoadingBlocked;/,
    "消息层底部的转圈必须要求脱尾窗口",
  );
});

const turnGroupSource = readFileSync(
  new URL("../src/v4/ConversationTurnGroup.tsx", import.meta.url),
  "utf8",
);

test("轮内每个判定调用点都必须传 isLastTurn：放置约束是逐调用点的事，漏一处就是一处双转圈", () => {
  // 转圈槽逐轮渲染、谓词被多处调用，只断言第一处管不住其它处——这里逐个调用点
  // 扫描，任何一处丢了 isLastTurn（双转圈回归的形状）都直接失败。
  const anchor = "shouldShowTurnChatLoading({";
  const offsets: number[] = [];
  for (
    let index = turnGroupSource.indexOf(anchor);
    index !== -1;
    index = turnGroupSource.indexOf(anchor, index + anchor.length)
  ) {
    offsets.push(index);
  }
  assert.ok(offsets.length > 0, "找不到 shouldShowTurnChatLoading 的调用点");
  for (const start of offsets) {
    const callEnd = turnGroupSource.indexOf("});", start);
    assert.notEqual(callEnd, -1, "shouldShowTurnChatLoading 的调用没有闭合");
    const call = turnGroupSource.slice(start, callEnd);
    assert.match(
      call,
      /isLastTurn:\s*unit\.isLastTurn/,
      `调用点（偏移 ${start}）缺 isLastTurn 放置约束：${call}`,
    );
  }
});
