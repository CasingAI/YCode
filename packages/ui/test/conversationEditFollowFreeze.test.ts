import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// specs/message-history-edit.md 规则 42：编辑期间冻结时间线跟随。
// ui 包测试为源码断言式（无组件渲染/jsdom），这里锁定接线要点防回退：
// 冻结 prop 的存在与传递、自动源被拦、显式回底豁免、进入前跟随记忆与用户接管不恢复。
// 行为级（真实滚动、虚拟化卸载）表达不了，如实止于源码层。

test("规则 42：Timeline 接受 followSuspended 冻结 prop，默认不冻结", () => {
  const timeline = read("../src/v4/ConversationTimeline.tsx");
  assert.match(timeline, /followSuspended\?: boolean;/);
  assert.match(timeline, /followSuspended = false,/);
});

test("规则 42：SessionPane 把编辑开合态传给 Timeline，切会话走正常退出路径", () => {
  const pane = read("../src/v4/SessionPane.tsx");
  // 开卡/关卡即 editingRowId 非空/置空；切会话时同一 state 先行回落为 null，
  // 冻结随正常退出路径解除，不在旧会话残留。
  assert.match(pane, /followSuspended=\{editingRowId !== null\}/);
  assert.match(pane, /setEditingRowId\(null\);\n {2}\}, \[sessionId\]\);/);
});

test("规则 42：自动贴底被冻结拦截，显式回底与记忆恢复豁免", () => {
  const timeline = read("../src/v4/ConversationTimeline.tsx");
  // 唯一的自动 choke 点：非 force 调用在冻结期间直接返回。
  assert.match(timeline, /if \(!options\?\.force && followSuspendedRef\.current\) return;/);
  // 用户显式「回到底部」与中部窗口「回到最新」不受冻结拦截。
  assert.match(timeline, /scrollToBottom\(\{ force: true \}\);/);
  // 会话记忆恢复是位置恢复不是跟随吸底，同样豁免。
  const restoreBlock =
    timeline.split("wasPinnedToBottom === true")[1]?.split("restoreScrollMemory(restoredState);")[0] ??
    "";
  assert.ok(
    restoreBlock.includes("scrollToBottom({ force: true })"),
    "记忆恢复贴底必须豁免冻结，否则切会话会停在顶部",
  );
});

test("规则 42：进入记下是否跟随，退出按进入前状态恢复，用户接管不恢复", () => {
  const timeline = read("../src/v4/ConversationTimeline.tsx");
  // 进入冻结：记下当时跟随态并解除跟随（后续内容增长走 hold）。
  assert.match(timeline, /suspendedFollowingBeforeRef\.current = followingRef\.current;/);
  // 退出：进入前跟随且用户未接管 → 恢复跟随并贴底；否则保持不动。
  assert.match(
    timeline,
    /if \(suspendedFollowingBeforeRef\.current && !suspendedUserTookOverRef\.current\) \{\n[\s\S]*?commitFollowing\(true\);/,
  );
  // 冻结期间的用户上滚意图即接管标记。
  assert.match(
    timeline,
    /if \(intent === "awayFromBottom" && followSuspendedRef\.current\) \{\n[\s\S]*?suspendedUserTookOverRef\.current = true;/,
  );
});

test("规则 42：冻结期间回到底部按钮语义不变（解除跟随即展示）", () => {
  const timeline = read("../src/v4/ConversationTimeline.tsx");
  // 进入冻结即 commitFollowing(false)，按钮经既有 shouldShowBackToBottom 点亮，
  // 不新增按钮语义；退出恢复跟随时 commitFollowing(true) 熄灭。
  assert.match(timeline, /setBackToBottomVisible\(shouldShowBackToBottom\(following, unitsRef\.current\.length\)\)/);
});

test("规则 42：切会话时冻结态作废，不把新会话拽到底部", () => {
  const timeline = read("../src/v4/ConversationTimeline.tsx");
  // 进入冻结记下当时会话（sessionKey 即 sessionId，切会话必变，不新造概念）。
  assert.match(timeline, /suspendedSessionKeyRef\.current = sessionKey;/);
  // 退出恢复前先校验会话一致；不等则只清标记、不恢复跟随不贴底。
  assert.match(
    timeline,
    /if \(suspendedSessionKeyRef\.current !== sessionKey\) \{\n[\s\S]*?return;\n {4}\}/,
  );
  const guardBlock =
    timeline.match(
      /if \(suspendedSessionKeyRef\.current !== sessionKey\) \{([\s\S]*?)\n {4}\}/,
    )?.[1] ?? "";
  assert.ok(
    !guardBlock.includes("commitFollowing(true)"),
    "会话不一致时不得恢复跟随",
  );
  assert.ok(!guardBlock.includes("scrollToBottom"), "会话不一致时不得贴底");
});
