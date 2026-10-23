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

const { editUserQuery } = forkEditRetryHandlers;

// 编辑重发的模型组裁决（docs/specs/model-group.md「编辑历史消息的组语义」）：
// - 组不可用（已删 / 无可用成员）在 rewind 之前拒绝：blocked + reasonCode，历史不截断；
// - 组可用：rewind 成功后写会话组钉死，重发 intent 同时携带组身份（配置意图层）
//   与钉死成员（实际模型）；
// - 编辑卡改选具体模型（payload 无组意图）且会话已有组钉死：rewind 后退出组意图。

const SESSION_ID = "edit-model-group";

interface GroupConfig {
  groupId: string;
  name: string;
  memberOrder: Array<{ providerId: string; modelId: string; reasoningLevel?: string }>;
}

interface Harness {
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  calls: string[];
  rewound: boolean;
  cancelledReasons: string[];
  sentIntents: Array<Record<string, unknown>>;
  appliedGroupStates: Array<unknown>;
  sessionModelSelection: { providerId: string; modelId: string } | undefined;
}

function buildHarness(options: {
  groups: GroupConfig[];
  modelOptions: Array<{ ref: { providerId: string; modelId: string } }>;
  initialGroupState?: { intent: { groupId: string; groupNameSnapshot: string }; pickSeed: string };
}): Harness {
  const calls: string[] = [];
  const state: Harness = {
    calls,
    rewound: false,
    cancelledReasons: [],
    sentIntents: [],
    appliedGroupStates: options.initialGroupState ? [options.initialGroupState] : [],
    sessionModelSelection: { providerId: "openai", modelId: "gpt-5" },
    record: {
      app: {
        sessionId: SESSION_ID,
        getMode: () => "yolo",
        getModel: () => "openai/gpt-5",
        listModels: () =>
          options.modelOptions.map((option) => ({
            ...option,
            reasoning: { levels: [{ value: "low" }, { value: "high" }], defaultLevel: "low" },
          })),
        listModelGroups: async () => options.groups,
        sendInput: async (_input: { text: string }, sendOptions?: { intent?: unknown }) => {
          calls.push("sendInput");
          state.sentIntents.push(sendOptions?.intent ?? {});
          return { kind: "queued" };
        },
        runtime: {
          getSessionModelSelection: () => state.sessionModelSelection,
          getPlanEnabled: () => false,
          getReadOnlyEnabled: () => false,
          getSessionModelGroupState: () => state.appliedGroupStates.at(-1) ?? undefined,
          applySessionModelGroupState: async (next: unknown) => {
            state.appliedGroupStates.push(next);
            calls.push(next ? "groupState:write" : "groupState:clear");
          },
          setSessionModelSelection: (selection: { providerId: string; modelId: string }) => {
            state.sessionModelSelection = selection;
            calls.push(`setModel:${selection.providerId}/${selection.modelId}`);
          },
          emitModelSelected: async (payload: { previousModelSelection: unknown }) => {
            calls.push(`modelSelected:prev=${payload.previousModelSelection === null ? "null" : "known"}`);
          },
          rewindConversationToMessage: async () => {
            state.rewound = true;
            calls.push("rewind");
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
          kind: "sendText",
          text: "原始问题",
          sourceCommandId: "cmd-origin",
          clientId: "client-1",
          mode: "yolo",
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

const FAST_GROUP: GroupConfig = {
  groupId: "model-group:fast",
  name: "快速模型",
  memberOrder: [
    { providerId: "glm", modelId: "glm-5.3-flash" },
    { providerId: "minimax", modelId: "minimax-m3.1-flash-free" },
  ],
};

function catalogOf(groups: GroupConfig[]) {
  const refs = new Set(
    groups.flatMap((group) =>
      group.memberOrder.map((member) => `${member.providerId}/${member.modelId}`),
    ),
  );
  return [...refs].map((key) => {
    const [providerId, modelId] = key.split("/");
    return { ref: { providerId, modelId } };
  });
}

test("编辑卡选组：rewind 后写会话组钉死，重发 intent 同时带组身份与钉死成员", async () => {
  const h = buildHarness({ groups: [FAST_GROUP], modelOptions: catalogOf([FAST_GROUP]) });
  const result = await editUserQuery(
    h.host,
    editEnvelope({
      newText: "改写后的提问",
      mode: "yolo",
      modelGroupIntent: { groupId: "model-group:fast", groupNameSnapshot: "快速模型" },
    }),
  );
  assert.deepEqual(result, {
    type: "editUserQuery",
    disposition: "rewind",
    sessionId: SESSION_ID,
  });
  assert.equal(h.rewound, true);
  // 顺序：rewind 成功后才写组状态，再发模型事件与重发（拒绝前置 + 提交后置）。
  const rewindIndex = h.calls.indexOf("rewind");
  const writeIndex = h.calls.indexOf("groupState:write");
  assert.ok(rewindIndex >= 0 && writeIndex > rewindIndex, `calls: ${h.calls.join(",")}`);
  // 会话组状态写入该组；钉死成员写进会话模型选择。
  const groupState = h.appliedGroupStates.at(-1) as {
    intent?: { groupId?: string };
    pickSeed?: string;
  };
  assert.equal(groupState?.intent?.groupId, "model-group:fast");
  assert.ok(groupState?.pickSeed);
  const pinned = h.sentIntents.at(-1)?.modelSelection as { providerId: string; modelId: string };
  assert.ok(
    pinned && FAST_GROUP.memberOrder.some(
      (member) => member.providerId === pinned.providerId && member.modelId === pinned.modelId,
    ),
    `钉死成员必须来自组名单: ${JSON.stringify(pinned)}`,
  );
  const intentGroup = h.sentIntents.at(-1)?.modelGroupIntent as { groupId?: string };
  assert.equal(intentGroup?.groupId, "model-group:fast");
});

test("组已删：blocked/modelGroup.deleted，rewind 未发生、组状态未写", async () => {
  const h = buildHarness({ groups: [], modelOptions: catalogOf([FAST_GROUP]) });
  const result = await editUserQuery(
    h.host,
    editEnvelope({
      newText: "改写后的提问",
      mode: "yolo",
      modelGroupIntent: { groupId: "model-group:fast", groupNameSnapshot: "快速模型" },
    }),
  );
  assert.deepEqual(result, {
    type: "editUserQuery",
    disposition: "blocked",
    sessionId: SESSION_ID,
    reasonCode: "modelGroup.deleted",
  });
  assert.equal(h.rewound, false);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.cancelledReasons, ["modelGroup.deleted"]);
});

test("组无可用成员：blocked/modelGroup.noMembers，rewind 未发生", async () => {
  // 组在，但成员全部不在目录里（不可解析）。
  const h = buildHarness({
    groups: [FAST_GROUP],
    modelOptions: [{ ref: { providerId: "openai", modelId: "gpt-5" } }],
  });
  const result = await editUserQuery(
    h.host,
    editEnvelope({
      newText: "改写后的提问",
      mode: "yolo",
      modelGroupIntent: { groupId: "model-group:fast", groupNameSnapshot: "快速模型" },
    }),
  );
  assert.equal((result as { reasonCode?: string }).reasonCode, "modelGroup.noMembers");
  assert.equal(h.rewound, false);
  assert.deepEqual(h.calls, []);
});

test("编辑卡改选具体模型：rewind 后退出会话组钉死，重发按具体模型", async () => {
  const h = buildHarness({
    groups: [FAST_GROUP],
    modelOptions: catalogOf([FAST_GROUP]),
    initialGroupState: { intent: { groupId: "model-group:fast", groupNameSnapshot: "快速模型" }, pickSeed: "seed-1" },
  });
  await editUserQuery(
    h.host,
    editEnvelope({
      newText: "改写后的提问",
      mode: "yolo",
      modelSelection: { providerId: "openai", modelId: "gpt-5" },
    }),
  );
  assert.equal(h.rewound, true);
  const rewindIndex = h.calls.indexOf("rewind");
  const clearIndex = h.calls.indexOf("groupState:clear");
  assert.ok(clearIndex > rewindIndex, `清组钉死必须发生在 rewind 之后: ${h.calls.join(",")}`);
  assert.equal(h.appliedGroupStates.at(-1), undefined);
  const intentGroup = h.sentIntents.at(-1)?.modelGroupIntent;
  assert.equal(intentGroup, undefined);
});

test("无组介入且会话无组钉死：不写组状态（旧行为不变）", async () => {
  const h = buildHarness({ groups: [FAST_GROUP], modelOptions: catalogOf([FAST_GROUP]) });
  await editUserQuery(
    h.host,
    editEnvelope({
      newText: "改写后的提问",
      mode: "yolo",
      modelSelection: { providerId: "openai", modelId: "gpt-5" },
    }),
  );
  assert.equal(h.rewound, true);
  assert.ok(!h.calls.includes("groupState:write"));
  assert.ok(!h.calls.includes("groupState:clear"));
});
