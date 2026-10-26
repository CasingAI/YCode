// 子代理 Fork 的 identity 回归（docs/specs/subagent-fork-isolation.md）。
// 覆盖 checkpoint 历史身份重分配、源数据不变与再 Fork 不复用旧身份。
import assert from "node:assert/strict";
import test from "node:test";
import {
  PARENT_ONE,
  PARENT_TWO,
  SOURCE_AGENT,
  SOURCE_CHILD,
  checkpointGraph,
  checkpointNode,
  childPromptHistory,
  createHarness,
  realChildCheckpointHistory,
  runFork,
} from "./helpers/subagent-fork-identity-fixtures.js";

test("生产 checkpoint 形态：assistant 自指初始化与 realUser turn 锚点均可 Fork", async () => {
  const history = realChildCheckpointHistory(SOURCE_CHILD);
  const sourceSnapshot = JSON.stringify(history);
  const harness = createHarness({
    parentId: PARENT_ONE,
    parentPrefix: "p1_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({ parentSessionId: PARENT_ONE, childSessionId: SOURCE_CHILD, history }),
      ]),
  });

  await runFork(harness, "p1_");

  assert.equal(harness.commits.length, 1, "真实形态的检查点必须可以 Fork");
  const copy = harness.commits[0].subagentForks?.[0];
  assert.ok(copy);
  const [initCopy, promptCopy] = copy.history;
  assert.equal(initCopy.info.role, "assistant");
  assert.equal(initCopy.info.parentID, initCopy.info.id, "自指 parentID 必须映射到 child 自身");
  assert.equal(initCopy.info.anchor, undefined, "初始化消息本就没有 turn 锚点");
  assert.notEqual(promptCopy.info.anchor.turnId, "turn_fixture_child_prompt");
  assert.equal(promptCopy.info.anchor.productTurnId, promptCopy.info.id);
  assert.equal(JSON.stringify(history), sourceSnapshot, "源检查点不得被原地修改");
});

test("子代理 checkpoint 的 turn/productTurn 锚点映射为 child-local 身份，源数据不变", async () => {
  const history = childPromptHistory(SOURCE_CHILD);
  const sourceSnapshot = JSON.stringify(history);
  const harness = createHarness({
    parentId: PARENT_ONE,
    parentPrefix: "p1_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({ parentSessionId: PARENT_ONE, childSessionId: SOURCE_CHILD, history }),
      ]),
  });

  await runFork(harness, "p1_");

  assert.equal(harness.commits.length, 1, "成功路径只提交一次 bundle");
  const copy = harness.commits[0].subagentForks?.[0];
  assert.ok(copy, "子代理副本必须进入提交包");
  assert.equal(copy.history.length, 2);
  assert.notEqual(copy.child.id, SOURCE_CHILD);
  assert.notEqual(copy.agentId, SOURCE_AGENT);

  const [initCopy, promptCopy] = copy.history;
  assert.notEqual(initCopy.info.id, "msg_fixture_init");
  assert.notEqual(promptCopy.info.id, "msg_fixture_prompt");
  assert.notEqual(initCopy.parts[0].id, "prt_fixture_init");
  assert.notEqual(promptCopy.parts[0].id, "prt_fixture_prompt");
  for (const message of copy.history) {
    assert.equal(message.info.sessionID, copy.child.id);
    for (const part of message.parts) {
      assert.equal(part.sessionID, copy.child.id);
      assert.equal(part.messageID, message.info.id);
    }
  }

  const sourceTurnIds = new Set(["turn_fixture_child_init", "turn_fixture_child_prompt"]);
  const copiedTurnIds = new Set(
    copy.history.map((message: any) => String(message.info.anchor.turnId)),
  );
  assert.equal(copiedTurnIds.size, 2, "两条消息的 turn 锚点都要重新分配");
  for (const turnId of copiedTurnIds) {
    assert.equal(sourceTurnIds.has(turnId), false, "复制出的 turn 不得复用源身份");
  }
  assert.equal(
    promptCopy.info.anchor.productTurnId,
    promptCopy.info.id,
    "productTurnId 指向持久 messageId 时必须换成 child 的 messageId",
  );
  assert.equal(initCopy.info.anchor.productTurnId, undefined, "初始化消息本就没有 productTurnId");

  assert.equal(JSON.stringify(history), sourceSnapshot, "源检查点及其消息/parts 不得被原地修改");
});

test("再次 Fork 重新分配身份，不复用源分支或上一分支", async () => {
  const history = childPromptHistory(SOURCE_CHILD);
  const first = createHarness({
    parentId: PARENT_ONE,
    parentPrefix: "p1_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({ parentSessionId: PARENT_ONE, childSessionId: SOURCE_CHILD, history }),
      ]),
  });
  await runFork(first, "p1_");
  const firstCopy = first.commits[0].subagentForks?.[0];
  assert.ok(firstCopy);

  const firstMessageIds = new Set(firstCopy.history.map((message: any) => message.info.id));
  const firstPartIds = new Set(
    firstCopy.history.flatMap((message: any) => message.parts.map((part: any) => part.id)),
  );
  const firstTurnIds = new Set(
    firstCopy.history.map((message: any) => String(message.info.anchor.turnId)),
  );

  const second = createHarness({
    parentId: PARENT_TWO,
    parentPrefix: "p2_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({
          parentSessionId: PARENT_TWO,
          childSessionId: firstCopy.child.id,
          agentId: firstCopy.agentId,
          history: firstCopy.history,
          entries: firstCopy.entries,
        }),
      ]),
  });
  await runFork(second, "p2_");
  const secondCopy = second.commits[0].subagentForks?.[0];
  assert.ok(secondCopy);

  assert.notEqual(secondCopy.child.id, firstCopy.child.id);
  assert.notEqual(secondCopy.agentId, firstCopy.agentId);
  for (const message of secondCopy.history) {
    assert.equal(firstMessageIds.has(message.info.id), false, "再 Fork 必须重新分配消息身份");
    const turnId = String(message.info.anchor.turnId);
    assert.equal(firstTurnIds.has(turnId), false, "再 Fork 必须重新分配 turn 身份");
    for (const part of message.parts) {
      assert.equal(firstPartIds.has(part.id), false, "再 Fork 必须重新分配 part 身份");
    }
  }
  const secondPrompt = secondCopy.history[1];
  assert.equal(
    secondPrompt.info.anchor.productTurnId,
    secondPrompt.info.id,
    "productTurnId 必须指向再 Fork 后新的 prompt messageId",
  );
  assert.notEqual(
    secondPrompt.info.anchor.productTurnId,
    firstCopy.history[1].info.anchor.productTurnId,
    "不得复用上一分支的 productTurnId",
  );
  assert.notEqual(
    secondPrompt.info.anchor.productTurnId,
    "msg_fixture_prompt",
    "不得复用源检查点的 prompt 身份",
  );
});
