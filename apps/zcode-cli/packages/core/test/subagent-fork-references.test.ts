// 子代理 Fork 的引用映射回归（docs/specs/subagent-fork-isolation.md）。
// 覆盖 timeline/compaction/附件/verifier 引用，以及不可映射引用与预分配失败的原子拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import {
  PARENT_ONE,
  SOURCE_AGENT,
  SOURCE_CHILD,
  VERIFICATION_ENTRY_TYPE,
  checkpointGraph,
  checkpointNode,
  childPromptHistory,
  createHarness,
  runFork,
} from "./helpers/subagent-fork-identity-fixtures.js";

test("timeline、compaction、已完成工具附件与 verifier 引用映射一致", async () => {
  const history = [
    ...childPromptHistory(SOURCE_CHILD),
    {
      info: {
        id: "msg_fixture_answer",
        sessionID: SOURCE_CHILD,
        role: "assistant",
        parentID: "msg_fixture_prompt",
        time: { created: 7, completed: 8 },
        agent: "fixture-agent",
        finish: "completed",
        anchor: {
          turnId: "turn_fixture_child_prompt",
          orderedMessageIds: ["msg_fixture_prompt", "msg_fixture_answer"],
          boundaryMessageId: "msg_fixture_answer",
          goalBoundary: {
            kind: "snapshot",
            target: {
              targetID: "target_fixture_goal",
              sessionID: SOURCE_CHILD,
              title: "fixture goal",
              status: "active",
              time: { created: 1, updated: 1 },
              activeInputId: null,
              activeRunStartedAtMs: null,
              activeRunLastSeenAtMs: null,
            },
            verificationEntryIds: ["verifier_fixture_entry"],
          },
        },
      },
      parts: [
        {
          id: "prt_fixture_tool",
          sessionID: SOURCE_CHILD,
          messageID: "msg_fixture_answer",
          type: "tool",
          callID: "call_fixture_tool",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: "ok",
            title: "fixture tool",
            metadata: {},
            time: { start: 7, end: 8 },
            attachments: [
              {
                id: "prt_fixture_attachment",
                sessionID: SOURCE_CHILD,
                messageID: "msg_fixture_answer",
                type: "file",
                mime: "text/plain",
                filename: "fixture.txt",
                url: "file:///fixture.txt",
              },
            ],
          },
        },
        {
          id: "prt_fixture_timeline",
          sessionID: SOURCE_CHILD,
          messageID: "msg_fixture_answer",
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          anchorMessageId: "msg_fixture_prompt",
          anchorTurnId: "turn_fixture_child_prompt",
          sourceCommandId: "cmd_fixture_child",
          parentSessionId: "sess_fixture_source_parent",
          targetMessageId: "msg_fixture_prompt",
          restoredFileCount: 0,
          time: { start: 7, end: 7 },
        },
        {
          id: "prt_fixture_compact",
          sessionID: SOURCE_CHILD,
          messageID: "msg_fixture_answer",
          type: "compaction",
          summaryMessageId: "msg_fixture_prompt",
          tail_start_id: "msg_fixture_prompt",
          compactBoundary: {
            turnId: "turn_fixture_child_compact",
            lastSummarizedMessageId: "msg_fixture_prompt",
            summaryMessageIds: ["msg_fixture_prompt"],
            attachmentMessageIds: ["msg_fixture_answer"],
            hookResultMessageIds: ["msg_fixture_answer"],
            preservedSegment: {
              headMessageId: "msg_fixture_prompt",
              anchorMessageId: "msg_fixture_answer",
              tailMessageId: "msg_fixture_answer",
            },
          },
        },
        {
          id: "prt_fixture_verification",
          sessionID: SOURCE_CHILD,
          messageID: "msg_fixture_answer",
          type: "timeline",
          timelineType: "goal_verification",
          display: "separator",
          status: "completed",
          anchorMessageId: "msg_fixture_answer",
          anchorTurnId: "turn_fixture_child_prompt",
          targetId: "target_fixture_goal",
          verificationId: "verify_fixture_goal",
          time: { start: 7, end: 7 },
        },
      ],
    },
  ];
  const entries = [
    {
      id: "verifier_fixture_entry",
      sessionID: SOURCE_CHILD,
      type: VERIFICATION_ENTRY_TYPE,
      time: { created: 9, updated: 9 },
      data: {
        eventId: "evt_fixture_verifier",
        payload: {
          targetId: "target_fixture_goal",
          verificationId: "verify_fixture_goal",
          anchorAssistantMessageId: "msg_fixture_answer",
          anchorTurnId: "turn_fixture_child_prompt",
        },
      },
    },
  ];
  const sourceSnapshot = JSON.stringify({ history, entries });
  const harness = createHarness({
    parentId: PARENT_ONE,
    parentPrefix: "p1_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({
          parentSessionId: PARENT_ONE,
          childSessionId: SOURCE_CHILD,
          history,
          entries,
        }),
      ]),
  });

  await runFork(harness, "p1_");

  const copy = harness.commits[0].subagentForks?.[0];
  assert.ok(copy);
  const [, promptCopy, answerCopy] = copy.history;
  const [toolCopy, timelineCopy, compactCopy, verificationCopy] = answerCopy.parts as any[];

  // 已完成工具附件：callID 与附件 part 身份都要重分配并归属 child。
  assert.notEqual(toolCopy.callID, "call_fixture_tool");
  assert.notEqual(toolCopy.state.attachments[0].id, "prt_fixture_attachment");
  assert.equal(toolCopy.state.attachments[0].sessionID, copy.child.id);
  assert.equal(toolCopy.state.attachments[0].messageID, answerCopy.info.id);

  // timeline 本地锚点。
  assert.equal(timelineCopy.anchorMessageId, promptCopy.info.id);
  assert.equal(timelineCopy.anchorTurnId, promptCopy.info.anchor.turnId);
  assert.notEqual(timelineCopy.anchorTurnId, "turn_fixture_child_prompt");

  // compaction 的所有 message / turn 引用。
  assert.equal(compactCopy.summaryMessageId, promptCopy.info.id);
  assert.equal(compactCopy.tail_start_id, promptCopy.info.id);
  assert.equal(compactCopy.compactBoundary.lastSummarizedMessageId, promptCopy.info.id);
  assert.deepEqual(compactCopy.compactBoundary.summaryMessageIds, [promptCopy.info.id]);
  assert.deepEqual(compactCopy.compactBoundary.attachmentMessageIds, [answerCopy.info.id]);
  assert.deepEqual(compactCopy.compactBoundary.hookResultMessageIds, [answerCopy.info.id]);
  assert.deepEqual(compactCopy.compactBoundary.preservedSegment, {
    headMessageId: promptCopy.info.id,
    anchorMessageId: answerCopy.info.id,
    tailMessageId: answerCopy.info.id,
  });
  assert.notEqual(compactCopy.compactBoundary.turnId, "turn_fixture_child_compact");

  // 历史 Goal 快照：target、verification 与 verifier entry 引用保持同一套 child 身份。
  const verifierCopy = copy.entries.find((entry: any) => entry.type === VERIFICATION_ENTRY_TYPE);
  assert.ok(verifierCopy, "被引用的 verifier entry 必须随包复制");
  assert.notEqual(verifierCopy.id, "verifier_fixture_entry");
  assert.equal(verifierCopy.sessionID, copy.child.id);
  assert.notEqual(verifierCopy.data.payload.targetId, "target_fixture_goal");
  assert.equal(verifierCopy.data.payload.targetId, verificationCopy.targetId);
  assert.notEqual(verifierCopy.data.payload.verificationId, "verify_fixture_goal");
  assert.equal(verifierCopy.data.payload.verificationId, verificationCopy.verificationId);
  assert.equal(verifierCopy.data.payload.anchorAssistantMessageId, answerCopy.info.id);
  assert.equal(verifierCopy.data.payload.anchorTurnId, answerCopy.info.anchor.turnId);
  assert.equal(answerCopy.info.anchor.goalBoundary.target.targetID, verificationCopy.targetId);
  assert.equal(
    answerCopy.info.anchor.goalBoundary.target.sessionID,
    copy.child.id,
    "历史 Goal 快照的 sessionID 必须是 child-local",
  );
  assert.deepEqual(answerCopy.info.anchor.goalBoundary.verificationEntryIds, [verifierCopy.id]);

  assert.equal(
    JSON.stringify({ history, entries }),
    sourceSnapshot,
    "源检查点与 verifier entry 不得被原地修改",
  );
});

test("引用落在可证明历史之外：Fork 失败且不提交", async () => {
  const history = [
    ...childPromptHistory(SOURCE_CHILD),
    {
      info: {
        id: "msg_fixture_answer",
        sessionID: SOURCE_CHILD,
        role: "assistant",
        parentID: "msg_fixture_prompt",
        time: { created: 7, completed: 8 },
        agent: "fixture-agent",
        finish: "completed",
        anchor: {
          turnId: "turn_fixture_child_prompt",
          orderedMessageIds: ["msg_fixture_prompt", "msg_fixture_answer"],
          boundaryMessageId: "msg_fixture_answer",
        },
      },
      parts: [
        {
          id: "prt_fixture_timeline",
          sessionID: SOURCE_CHILD,
          messageID: "msg_fixture_answer",
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          anchorMessageId: "msg_fixture_outside",
          anchorTurnId: "turn_fixture_child_prompt",
          time: { start: 7, end: 7 },
        },
      ],
    },
  ];
  const harness = createHarness({
    parentId: PARENT_ONE,
    parentPrefix: "p1_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({ parentSessionId: PARENT_ONE, childSessionId: SOURCE_CHILD, history }),
      ]),
  });

  await assert.rejects(runFork(harness, "p1_"), (error: Error & { cause?: unknown }) => {
    assert.match(error.message, /msg_fixture_outside/, "必须保留具体失败原因");
    assert.match(error.message, new RegExp(SOURCE_AGENT), "必须标明子代理");
    assert.ok(error.cause instanceof Error, "原始错误必须保留为 cause");
    assert.match(error.cause.message, /msg_fixture_outside/);
    return true;
  });
  assert.equal(harness.commits.length, 0, "失败不得进入原子提交，不能留下半成品");
});

test("历史快照引用的 verifier entry 缺失：Fork 失败且不提交", async () => {
  const history = childPromptHistory(SOURCE_CHILD).map((message) =>
    message.info.id === "msg_fixture_prompt"
      ? {
          ...message,
          info: {
            ...message.info,
            anchor: {
              ...(message.info.anchor as Record<string, unknown>),
              goalBoundary: {
                kind: "snapshot",
                target: {
                  targetID: "target_fixture_goal",
                  sessionID: SOURCE_CHILD,
                  title: "fixture goal",
                  status: "active",
                  time: { created: 1, updated: 1 },
                  activeInputId: null,
                  activeRunStartedAtMs: null,
                  activeRunLastSeenAtMs: null,
                },
                verificationEntryIds: ["verifier_fixture_missing"],
              },
            },
          },
        }
      : message,
  );
  const harness = createHarness({
    parentId: PARENT_ONE,
    parentPrefix: "p1_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({
          parentSessionId: PARENT_ONE,
          childSessionId: SOURCE_CHILD,
          history,
          entries: [],
        }),
      ]),
  });

  await assert.rejects(runFork(harness, "p1_"), (error: Error & { cause?: unknown }) => {
    assert.match(error.message, /verifier_fixture_missing/, "必须保留具体失败原因");
    assert.match(error.message, new RegExp(SOURCE_AGENT), "必须标明子代理");
    assert.ok(error.cause instanceof Error, "原始错误必须保留为 cause");
    assert.match(error.cause.message, /verifier_fixture_missing/);
    return true;
  });
  assert.equal(harness.commits.length, 0, "失败不得进入原子提交，不能留下半成品");
});

test("身份预分配读取已完成附件失败：Fork 失败、不提交并保留 cause", async () => {
  const history = [
    ...childPromptHistory(SOURCE_CHILD),
    {
      info: {
        id: "msg_fixture_answer",
        sessionID: SOURCE_CHILD,
        role: "assistant",
        parentID: "msg_fixture_prompt",
        time: { created: 7, completed: 8 },
        agent: "fixture-agent",
        finish: "completed",
        anchor: { turnId: "turn_fixture_child_prompt" },
      },
      parts: [
        {
          id: "prt_fixture_tool",
          sessionID: SOURCE_CHILD,
          messageID: "msg_fixture_answer",
          type: "tool",
          callID: "call_fixture_tool",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: "ok",
            title: "fixture tool",
            metadata: {},
            time: { start: 7, end: 8 },
            get attachments(): never {
              throw new Error("fixture_damaged_attachments");
            },
          },
        },
      ],
    },
  ];
  const harness = createHarness({
    parentId: PARENT_ONE,
    parentPrefix: "p1_",
    checkpointGraph: () =>
      checkpointGraph([
        checkpointNode({ parentSessionId: PARENT_ONE, childSessionId: SOURCE_CHILD, history }),
      ]),
  });

  await assert.rejects(runFork(harness, "p1_"), (error: Error & { cause?: unknown }) => {
    assert.match(error.message, /fixture_damaged_attachments/, "必须保留具体失败原因");
    assert.match(error.message, new RegExp(SOURCE_AGENT), "必须标明子代理");
    assert.ok(error.cause instanceof Error, "原始错误必须保留为 cause");
    assert.match(error.cause.message, /fixture_damaged_attachments/);
    return true;
  });
  assert.equal(harness.commits.length, 0, "失败不得进入原子提交，不能留下半成品");
});
