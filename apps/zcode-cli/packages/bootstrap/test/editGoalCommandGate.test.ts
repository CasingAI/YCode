import assert from "node:assert/strict";
import test from "node:test";
// handlers/index.js 必须先进来：goal-compact → session-flow → prompt-turn → session-residency
// 回到 handlers/index 构成既有循环，先导入 barrel 才能让 handler 表在被 spread 前完成初始化。
import "../src/zcode-protocol-v4/commands/handlers/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import { forkEditRetryHandlers } from "../src/zcode-protocol-v4/commands/handlers/fork-edit-retry.js";

const { editUserQuery, retryTurn } = forkEditRetryHandlers;

// 编辑路径命令身份重判（specs/message-history-edit.md 规则 32）：editUserQuery 不再
// 盲信旧行 intent.kind，按新文本 goal token 重判——普通消息编辑成 /goal 要真的落目标
// 并起续跑；goal 门禁（附件/档位/空目标）必须前置到 rewind 之前，拒绝不留半程状态；
// retryTurn 沿用旧行身份，goal 行重发行为不变。

const SESSION_ID = "edit-goal-gate";

interface Harness {
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  calls: string[];
  rewound: boolean;
  cancelledReasons: string[];
  sentTexts: string[];
  setTargetPayloads: Array<Record<string, unknown>>;
}

function buildHarness(options: {
  sessionMode: "plan" | "readonly" | "yolo";
  editTarget: {
    kind: "sendText" | "sendGoalCommand";
    text: string;
    mode?: "plan" | "readonly" | "yolo";
    attachments?: Array<{ ref?: string; fileName: string; mime: string; bytes: number }>;
  };
}): Harness {
  const calls: string[] = [];
  let currentMode: "plan" | "readonly" | "yolo" = options.sessionMode;
  const state: Harness = {
    calls,
    rewound: false,
    cancelledReasons: [],
    sentTexts: [],
    setTargetPayloads: [],
    record: {
      app: {
        sessionId: SESSION_ID,
        getMode: () => currentMode,
        getModel: () => "openai/gpt-5",
        readTarget: async () => null,
        setTarget: async (payload: Record<string, unknown>) => {
          calls.push("setTarget");
          state.setTargetPayloads.push(payload);
        },
        updateTargetStatus: async () => null,
        continueActiveTarget: async () => {
          calls.push("continueActiveTarget");
        },
        sendInput: async (input: { text: string }) => {
          calls.push("sendInput");
          state.sentTexts.push(input.text);
          return { kind: "queued" };
        },
        runtime: {
          getSessionModelSelection: () => ({ providerId: "openai", modelId: "gpt-5" }),
          getPlanEnabled: () => currentMode === "plan",
          getReadOnlyEnabled: () => currentMode === "readonly",
          setExecutionState: async ({ mode: nextMode }: { mode?: string }) => {
            calls.push(`setExecutionState:${nextMode ?? "keep"}`);
            if (nextMode) currentMode = nextMode as typeof currentMode;
          },
          rewindConversationToMessage: async () => {
            state.rewound = true;
            calls.push("rewind");
            // RewindStrategy.ActiveChain 的枚举值（contracts/src/rewind）。
            return { strategy: "active_chain" };
          },
          releaseForegroundPromotionLease: () => {},
        },
      },
      traceContext: { queryId: "query-1" },
      workspace: { workspacePath: "/tmp/workspace" },
      persistence: "immediate",
    } as unknown as V4SessionRecordView,
    host: null as unknown as V4CommandCoreHost,
  };
  state.host = {
    getRecord: (sessionId: string) => (sessionId === SESSION_ID ? state.record : undefined),
    ensureModelReady: async () => {},
    resolveRowActionTarget: () => ({
      ok: true,
      action: "editUserQuery",
      messageId: "msg-assistant-1",
      editTarget: {
        entityId: "entity-1",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user-1",
        coveredByStableCompact: false,
        intent: {
          kind: options.editTarget.kind,
          text: options.editTarget.text,
          sourceCommandId: "cmd-origin",
          clientId: "client-1",
          ...(options.editTarget.mode ? { mode: options.editTarget.mode } : {}),
          ...(options.editTarget.attachments
            ? { attachments: options.editTarget.attachments }
            : {}),
        },
      },
      row: { rowId: 1, entityId: "entity-1", turnId: "turn-1" },
    }),
    cancelInputCommand: async (_sessionId: string, _queueItemId: string, reason: string) => {
      state.cancelledReasons.push(reason);
    },
    afterLegacyStateMutation: async () => {},
  } as unknown as V4CommandCoreHost;
  return state;
}

function editEnvelope(payload: Record<string, unknown>) {
  return {
    commandId: "cmd-edit-1",
    sessionId: SESSION_ID,
    clientId: "client-1",
    payload: { target: { rowId: 1, entityId: "entity-1" }, workspaceMode: "preserve", ...payload },
  } as never;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Agent 档把普通消息编辑成 /goal：回退该轮、落目标、起续跑，目标不含 token", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: { kind: "sendText", text: "原始问题", mode: "yolo" },
  });
  const result = await editUserQuery(
    h.host,
    editEnvelope({ newText: "/goal 修复登录", mode: "yolo" }),
  );
  assert.equal(h.rewound, true);
  assert.deepEqual(h.cancelledReasons, []);
  const payload = h.setTargetPayloads[0] ?? {};
  assert.equal(payload.objective as string, "修复登录");
  assert.ok(!String(payload.objective).includes("/goal"));
  const intent = payload.intent as { kind?: string; text?: string } | undefined;
  assert.equal(intent?.kind, "sendGoalCommand");
  assert.equal(intent?.text, "修复登录");
  // 落库形态（goal-command-scope-and-decoration.md「落库形态」）：编辑原文作为
  // displayText 保真传入——气泡补芯片与编辑卡预填芯片都依赖落库文本含 token。
  assert.equal(payload.displayText, "/goal 修复登录");
  await flush();
  assert.ok(h.calls.includes("continueActiveTarget"));
  assert.deepEqual(result, { type: "editUserQuery", disposition: "rewind", sessionId: SESSION_ID });
});

test("载荷档位受限：blocked/planGoal，且 rewind 与写目标都没有发生", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: { kind: "sendText", text: "原始问题", mode: "yolo" },
  });
  const result = await editUserQuery(
    h.host,
    editEnvelope({ newText: "/goal 修复登录", mode: "plan" }),
  );
  assert.deepEqual(result, {
    type: "editUserQuery",
    disposition: "blocked",
    sessionId: SESSION_ID,
    reasonCode: "guard.planGoalMutuallyExclusive",
  });
  assert.equal(h.rewound, false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.cancelledReasons, ["guard.planGoalMutuallyExclusive"]);
});

test("会话档受限且载荷未声明档位：按会话档 fail-closed（协议直连同规）", async () => {
  const h = buildHarness({
    sessionMode: "readonly",
    editTarget: { kind: "sendText", text: "原始问题" },
  });
  const result = await editUserQuery(h.host, editEnvelope({ newText: "/goal 修复登录" }));
  assert.equal(
    (result as { reasonCode?: string }).reasonCode,
    "guard.readOnlyGoalMutuallyExclusive",
  );
  assert.equal(h.rewound, false);
});

test("带附件的 goal 编辑：blocked/attachments，先于档位判定", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: {
      kind: "sendText",
      text: "原始问题",
      mode: "yolo",
      attachments: [{ ref: "att-1", fileName: "a.png", mime: "image/png", bytes: 3 }],
    },
  });
  const result = await editUserQuery(
    h.host,
    editEnvelope({ newText: "/goal 修复登录", mode: "yolo" }),
  );
  assert.equal((result as { reasonCode?: string }).reasonCode, "guard.goalAttachmentsBlocked");
  assert.equal(h.rewound, false);
  assert.deepEqual(h.calls, []);
});

test("裸 /goal 无目标正文：blocked/emptyObjective", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: { kind: "sendText", text: "原始问题", mode: "yolo" },
  });
  const result = await editUserQuery(h.host, editEnvelope({ newText: "/goal", mode: "yolo" }));
  assert.equal((result as { reasonCode?: string }).reasonCode, "emptyObjective");
  assert.equal(h.rewound, false);
});

test("goal 行删掉 token：回归普通文本重发，不碰目标", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: { kind: "sendGoalCommand", text: "旧目标", mode: "yolo" },
  });
  await editUserQuery(h.host, editEnvelope({ newText: "改成普通问题", mode: "yolo" }));
  assert.equal(h.rewound, true);
  assert.deepEqual(h.setTargetPayloads, []);
  assert.deepEqual(h.sentTexts, ["改成普通问题"]);
});

test("goal 行保留 token 改目标：目标更新为 token 之后的正文", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: { kind: "sendGoalCommand", text: "旧目标", mode: "yolo" },
  });
  await editUserQuery(h.host, editEnvelope({ newText: "/goal 新目标", mode: "yolo" }));
  assert.equal(h.rewound, true);
  assert.equal(h.setTargetPayloads[0]?.objective as string, "新目标");
  assert.equal(h.setTargetPayloads[0]?.displayText, "/goal 新目标");
  assert.deepEqual(h.sentTexts, []);
});

test("句中 goal 编辑：目标取 token 后正文，落库可见文本保留前文原文", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: { kind: "sendText", text: "原始问题", mode: "yolo" },
  });
  await editUserQuery(h.host, editEnvelope({ newText: "先看下日志 /goal 修复登录", mode: "yolo" }));
  assert.equal(h.setTargetPayloads[0]?.objective as string, "修复登录");
  // displayText 必须是编辑原文而非构造形态——前文由回显 leadingText 承载，
  // 构造 `/goal <objective>` 会把用户原文静默抹掉。
  assert.equal(h.setTargetPayloads[0]?.displayText, "先看下日志 /goal 修复登录");
});

test("旧行 admission 冻结在受限档、本次提交声明 yolo：先落档再写目标（拒绝前置不被旧值误杀）", async () => {
  const h = buildHarness({
    sessionMode: "readonly",
    editTarget: { kind: "sendText", text: "原始问题", mode: "readonly" },
  });
  await editUserQuery(h.host, editEnvelope({ newText: "/goal 修复登录", mode: "yolo" }));
  await flush();
  // 门禁按载荷档位前置放行后：rewind → 落档（yolo）→ 写目标 → 续跑，
  // 后半程不再被会话旧档（readonly）二次拒绝，即无半程状态。
  assert.deepEqual(h.calls, [
    "rewind",
    "setExecutionState:yolo",
    "setTarget",
    "continueActiveTarget",
  ]);
});

test("retry goal 行：沿用旧行身份重发目标，不做新文本重判", async () => {
  const h = buildHarness({
    sessionMode: "yolo",
    editTarget: { kind: "sendGoalCommand", text: "旧目标", mode: "yolo" },
  });
  await retryTurn(h.host, {
    commandId: "cmd-retry-1",
    sessionId: SESSION_ID,
    clientId: "client-1",
    payload: { target: { rowId: 1, entityId: "entity-1" } },
  } as never);
  assert.equal(h.rewound, true);
  assert.equal(h.setTargetPayloads[0]?.objective as string, "旧目标");
  // retry 不带编辑原文：displayText 缺省，由落库单点（session-facade）构造
  // `/goal <objective>`，handler 层不得自行拼前缀。
  assert.equal("displayText" in (h.setTargetPayloads[0] ?? {}), false);
  assert.deepEqual(h.sentTexts, []);
});
