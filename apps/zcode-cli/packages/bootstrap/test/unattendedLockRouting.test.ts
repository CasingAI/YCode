import assert from "node:assert/strict";
import test from "node:test";
import { startPromptTurn } from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

// 路由层只负责标记「这是不是真实人工新消息」：
// - sendText / 编辑重发：带 unlocksUnattendedModeSwitch；
// - 队列提升、retry、compact、自动化派发：不带，Core 因而保持锁。
// 最终的归因优先与写盘顺序由 Core 的无人值守锁单测兜底。

function buildHarness() {
  const captured: Array<Record<string, unknown>> = [];
  const record = {
    app: {
      sessionId: "session-routing",
      sendInput: async (_input: unknown, options: Record<string, unknown>) => {
        captured.push(options);
        return {
          kind: "queued",
          pendingInputId: "pending-1",
          queueLength: 1,
          turnId: "turn-1",
        };
      },
    },
    workspace: { workspacePath: "/tmp/workspace" },
  } as unknown as V4SessionRecordView;
  const host = {
    getRecord: (sessionId: string) => (sessionId === "session-routing" ? record : undefined),
  } as unknown as V4CommandCoreHost;
  return { captured, host, record };
}

test("人工新消息经 startPromptTurn 明确传递解锁标记", async () => {
  const { captured, host, record } = buildHarness();

  await startPromptTurn(host, record, {
    content: "继续",
    inputId: "command-1",
    unlocksUnattendedModeSwitch: true,
  });

  assert.equal(captured[0]!.unlocksUnattendedModeSwitch, true);
});

test("队列提升 / retry 等内部重发不传解锁标记", async () => {
  const { captured, host, record } = buildHarness();

  await startPromptTurn(host, record, {
    content: "排队消息",
    inputId: "command-1",
    requireIdle: true,
  });

  assert.equal(captured[0]!.unlocksUnattendedModeSwitch, undefined);
});

test("自动化归因与解锁标记并存时两者都照传，由 Core 归因优先裁决", async () => {
  const { captured, host, record } = buildHarness();

  await startPromptTurn(host, record, {
    content: "定时任务",
    inputId: "automation-run-1",
    automationId: "automation-run-1",
    unlocksUnattendedModeSwitch: true,
  });

  assert.equal(captured[0]!.unlocksUnattendedModeSwitch, true);
  assert.equal(captured[0]!.automationId, "automation-run-1");
});
