import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type SessionEntryInfo,
  type SessionId,
  type SessionEvent,
  type SessionInfo,
} from "@zcode/contracts";
import { conversationTopic, type ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

// 接线回归：底栏显示的模式来自 detached child hydration 的 configSeed。
// 上一个修复只读了会话行 permission.mode（runner 原子创建恒为空），种子恒为 undefined，
// 子会话快照停在默认 yolo，底栏因此永远显示 Agent。这里走真实
// createConversationV4Gateway → v4-bridge.loadPersistedEvents → gateway 订阅链路，
// 断言 runtime/execution_state 条目真的被投影成 snapshot.config.mode。

const PARENT_ID = "sess-mode-seed-parent";
const CHILD_ID = "sess-mode-seed-child";

function executionStateEntry(data: unknown): SessionEntryInfo {
  return {
    id: "entry-execution-state",
    sessionID: CHILD_ID as SessionId,
    type: "runtime/execution_state",
    time: { created: 0, updated: 0 },
    data,
  };
}

function childSession(permissionMode?: string): SessionInfo {
  return {
    id: CHILD_ID as SessionId,
    projectID: "project-test",
    parentID: PARENT_ID as SessionId,
    taskType: "subagent_child",
    slug: CHILD_ID,
    directory: "C:/ws/test",
    path: "C:/ws/test",
    title: "child",
    version: "test",
    ...(permissionMode === undefined ? {} : { permission: { mode: permissionMode } }),
    time: { created: 0, updated: 0 },
  } as unknown as SessionInfo;
}

function parentRecord(
  options: {
    childEvents?: readonly SessionEvent[];
  } = {},
): ZCodeProtocolSessionRecord {
  const childEvents = options.childEvents ?? [];
  return {
    app: {
      runtime: {
        listSessionPlanFileWrittenFacts: async () => [],
        getSessionModelSelection: () => undefined,
        getProjection: async () => ({ status: "idle", backgroundTasks: [] }),
        getSessionLanguage: () => undefined,
      },
      // 父会话是 team：子会话无模式数据时绝不能借到它。
      getMode: () => "team",
      getModelOption: () => undefined,
      listModels: () => [],
      readToolResultArtifact: async () => ({ content: "" }),
    },
    eventStore: {
      getEvents: async () => [...childEvents],
      // 与持久事件日志一致的水位：hydration 需要知道快照时刻的 raw cursor。
      getLatestSequenceNumber: async () =>
        childEvents.reduce((maximum, item) => Math.max(maximum, item.sequenceNumber), 0),
    },
    taskType: "interactive",
    persistence: "immediate",
    workspace: { workspacePath: "C:/ws/test", workspaceKey: "C:/ws/test" },
    createdAt: 0,
    updatedAt: 0,
    stateRevision: 0,
    traceContext: { traceId: "trace-mode-seed", spanId: "span-mode-seed" },
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: false,
    modelContextBudgetStrategy: "default",
  } as unknown as ZCodeProtocolSessionRecord;
}

function makeGateway(input: {
  permissionMode?: string;
  entries?: readonly SessionEntryInfo[];
  withSessionEntries?: boolean;
  childEvents?: readonly SessionEvent[];
}): { context: ZCodeProtocolAgentServerContext; gateway: ConversationV4Gateway } {
  const child = childSession(input.permissionMode);
  const sessionStore = {
    getSession: async (sessionId: SessionId) => (String(sessionId) === CHILD_ID ? child : null),
    messages: async () => [],
    readTarget: async () => null,
    listSessions: async () => [],
    ...(input.withSessionEntries === false
      ? {}
      : {
          sessionEntries: async (query: { sessionID: SessionId; type?: string }) =>
            (input.entries ?? []).filter(
              (entry) => query.type === undefined || entry.type === query.type,
            ),
        }),
  };
  const context = {
    deps: { sessionStore },
    sessions: new Map([
      [PARENT_ID, parentRecord(input.childEvents ? { childEvents: input.childEvents } : {})],
    ]),
    v4Interactions: {},
    notify: () => {},
    requestClient: async () => {
      throw new Error("unexpected requestClient call");
    },
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoRecordingEnabled: false,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
      automationEnabled: false,
      webSearchEnabled: false,
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  const gateway = createConversationV4Gateway(context);
  context.v4Gateway = gateway;
  return { context, gateway };
}

let rawSequence = 0;
function event(type: SessionEventType, payload: unknown): SessionEvent {
  rawSequence += 1;
  return {
    id: `evt-mode-seed-${String(rawSequence)}`,
    sessionId: CHILD_ID as SessionId,
    turnId: "turn-mode-seed",
    type,
    timestamp: new Date(0),
    traceId: "trace-mode-seed",
    sequenceNumber: rawSequence,
    payload,
  } as unknown as SessionEvent;
}

function ingestDetached(gateway: ConversationV4Gateway, childEvent: SessionEvent): void {
  gateway.ingestDetachedLiveSession(CHILD_ID, childEvent, PARENT_ID);
}

async function subscribeConversation(
  gateway: ConversationV4Gateway,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): Promise<void> {
  await gateway.subscribe({
    topic: conversationTopic(CHILD_ID),
    connectionId: "connection-mode-seed",
    clientMode,
  });
}

interface GatewayPublisherAccess {
  publishers: Map<string, { getSnapshot(): ConversationSnapshot }>;
}

function snapshotOf(gateway: ConversationV4Gateway): ConversationSnapshot {
  const snapshot = (gateway as unknown as GatewayPublisherAccess).publishers
    .get(CHILD_ID)
    ?.getSnapshot();
  assert.ok(snapshot, "订阅后应有子会话 publisher 快照");
  return snapshot;
}

test("runner 式预建 child（permission 为空 + execution_state readonly）经真实 bridge 投影为 readonly", async () => {
  const { gateway } = makeGateway({ entries: [executionStateEntry({ mode: "readonly" })] });
  try {
    ingestDetached(gateway, event(SessionEventType.SessionCreated, { contextWindow: 200_000 }));
    await subscribeConversation(gateway, "desktop-continuous");

    const snapshot = snapshotOf(gateway);
    assert.equal(snapshot.sessionId, CHILD_ID);
    assert.equal(snapshot.config.mode, "readonly");
    assert.notEqual(snapshot.config.mode, "team", "不得借用父会话 team 档");
  } finally {
    gateway.dispose();
  }
});

test("general-purpose yolo 与显式 readonly 都按 execution_state 真实档位投影", async () => {
  for (const mode of ["yolo", "readonly"] as const) {
    const { gateway } = makeGateway({ entries: [executionStateEntry({ mode })] });
    try {
      ingestDetached(gateway, event(SessionEventType.SessionCreated, { contextWindow: 200_000 }));
      await subscribeConversation(gateway, "desktop-continuous");
      assert.equal(snapshotOf(gateway).config.mode, mode);
    } finally {
      gateway.dispose();
    }
  }
});

test("持久事件 SessionModeChanged 优先于 hydration 模式种子", async () => {
  const created = event(SessionEventType.SessionCreated, { contextWindow: 200_000 });
  // 事件是已发生事实，execution_state 条目只是 hydration 的初始种子；
  // 冷恢复事件日志里的 SessionModeChanged 必须压过 readonly 种子。
  const modeChanged = event(SessionEventType.SessionModeChanged, {
    mode: "plan",
    previousMode: "readonly",
    source: "command",
  });
  const { gateway } = makeGateway({
    entries: [executionStateEntry({ mode: "readonly" })],
    childEvents: [created, modeChanged],
  });
  try {
    // 让 detached child 先被视为 live，订阅才会进入 hydration 重建而非冷恢复激活。
    ingestDetached(gateway, created);
    await subscribeConversation(gateway, "desktop-continuous");

    assert.equal(snapshotOf(gateway).config.mode, "plan");
  } finally {
    gateway.dispose();
  }
});

test("冷恢复参数化两种 delivery 都用 execution_state 条目播种模式", async () => {
  for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
    const { gateway: liveGateway } = makeGateway({
      entries: [executionStateEntry({ mode: "readonly" })],
    });
    // 真实的 runtime 激活不在本测试范围；复用 bridge 构造出的 host，只把 resume 换成
    // 已恢复（无消息）的结果，仍走真实 v4-bridge.loadPersistedEvents 与冷 hydration 路径。
    const host = (liveGateway as unknown as { host: V4GatewayHost }).host;
    let resumeCalls = 0;
    const coldGateway = new ConversationV4Gateway({
      ...host,
      resumePersistedSession: async () => {
        resumeCalls += 1;
        return { status: "resumed", persistedMessages: [] };
      },
    });
    try {
      await subscribeConversation(coldGateway, clientMode);

      assert.equal(resumeCalls, 1, "冷订阅应走 resume 再 hydration");
      assert.equal(snapshotOf(coldGateway).config.mode, "readonly");
    } finally {
      coldGateway.dispose();
      liveGateway.dispose();
    }
  }
});

test("子会话没有任何模式数据时不借用父会话 team，保持投影默认档", async () => {
  const { gateway } = makeGateway({});
  try {
    ingestDetached(gateway, event(SessionEventType.SessionCreated, { contextWindow: 200_000 }));
    await subscribeConversation(gateway, "desktop-continuous");

    const snapshot = snapshotOf(gateway);
    assert.notEqual(snapshot.config.mode, "team", "无数据时不得借用父会话 team");
    assert.equal(snapshot.config.mode, "yolo");
  } finally {
    gateway.dispose();
  }
});

test("旧数据 only permission.mode=bare 在真实接线中迁移为 team", async () => {
  const { gateway } = makeGateway({ permissionMode: "bare", withSessionEntries: false });
  try {
    ingestDetached(gateway, event(SessionEventType.SessionCreated, { contextWindow: 200_000 }));
    await subscribeConversation(gateway, "desktop-continuous");

    assert.equal(snapshotOf(gateway).config.mode, "team");
  } finally {
    gateway.dispose();
  }
});
