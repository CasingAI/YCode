// 子代理 Fork 身份映射测试的通用夹具；全部使用合成 ID，不含真实会话或 prompt。
import { forkStableConversationAtMessage } from "../../src/runtime/methods/session-fork.js";

export const PARENT_ONE = "sess_fixture_parent_one";
export const PARENT_TWO = "sess_fixture_parent_two";
export const SOURCE_CHILD = "sess_fixture_source_child";
export const SOURCE_AGENT = "agent_fixture_source";
export const VERIFICATION_ENTRY_TYPE = "target_completion_verification";

export function sessionFixture(id: string) {
  return {
    id,
    projectID: "proj_fixture",
    workspaceID: "ws_fixture",
    taskType: "interactive",
    slug: "fixture",
    directory: "/workspace/fixture",
    path: "/workspace/fixture",
    title: "fixture",
    version: "0.0.0-test",
    time: { created: 1, updated: 1 },
  };
}

export function textPart(id: string, sessionID: string, messageID: string, text: string) {
  return { id, sessionID, messageID, type: "text", text, time: { start: 1, end: 1 } };
}

export function parentTranscript(sessionID: string, prefix: string) {
  const promptID = `${prefix}prompt`;
  const answerID = `${prefix}answer`;
  return [
    {
      info: {
        id: promptID,
        sessionID,
        role: "user",
        time: { created: 10 },
        agent: "fixture-agent",
        anchor: { turnId: `${prefix}turn`, origin: "realUser", sourceCommandId: `${prefix}cmd` },
      },
      parts: [textPart(`${prefix}prompt_part`, sessionID, promptID, "fixture prompt")],
    },
    {
      info: {
        id: answerID,
        sessionID,
        role: "assistant",
        parentID: promptID,
        time: { created: 11, completed: 12 },
        agent: "fixture-agent",
        finish: "completed",
        anchor: {
          turnId: `${prefix}turn`,
          orderedMessageIds: [promptID, answerID],
          boundaryMessageId: answerID,
          historyRoundCount: 1,
        },
      },
      parts: [textPart(`${prefix}answer_part`, sessionID, answerID, "fixture answer")],
    },
  ];
}

export function forkTarget(prefix: string) {
  return {
    productTurnId: `${prefix}prompt`,
    transcriptTurnId: `${prefix}turn`,
    orderedMessageIds: [`${prefix}prompt`, `${prefix}answer`],
    boundaryMessageId: `${prefix}answer`,
  };
}

export function createHarness(options: {
  parentId: string;
  parentPrefix: string;
  checkpointGraph: () => unknown;
}) {
  const commits: any[] = [];
  const store = {
    getSession: async (id: string) => sessionFixture(id),
    messages: async () => parentTranscript(options.parentId, options.parentPrefix),
    sessionEntries: async () => [],
    listSessions: async () => [],
    saveSessionEntry: async () => {},
    resolveSubagentForkCheckpointGraph: async () => options.checkpointGraph(),
    commitForkBundle: async (bundle: any) => {
      commits.push(bundle);
      return sessionFixture(bundle.child.id);
    },
  };
  const runtime = {
    sessionId: options.parentId,
    sessionStore: store,
    config: { agentName: "fixture-agent", mode: "yolo" },
    rootTraceContext: { traceId: "trace_fixture" },
    workspaceRoot: "/workspace/fixture",
    workingDirectory: "/workspace/fixture",
    appVersion: "0.0.0-test",
    getSessionModelSelection: () => undefined,
    getSessionModelGroupState: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    createEvent: () => ({}),
    appendEvent: async () => {},
  };
  return { runtime, commits };
}

export function runFork(harness: { runtime: unknown }, prefix: string) {
  return forkStableConversationAtMessage.call(harness.runtime as never, {
    sourceCommandId: `${prefix}fork_cmd`,
    goalBoundary: { kind: "none" },
    target: forkTarget(prefix),
  });
}

export function checkpointNode(options: {
  parentSessionId: string;
  childSessionId: string;
  agentId?: string;
  history: unknown[];
  entries?: unknown[];
}) {
  return {
    checkpoint: {
      checkpointId: `checkpoint_fixture_${options.childSessionId}`,
      parentSessionId: options.parentSessionId,
      agentId: options.agentId ?? SOURCE_AGENT,
      childSessionId: options.childSessionId,
      parentToolCallId: "call_fixture_parent",
      boundaryMessageId: "msg_fixture_boundary",
      history: options.history,
      entries: options.entries ?? [],
      profile: { name: "fixture" },
      agentType: "general-purpose",
      aliases: [],
    },
    history: options.history,
  };
}

export function checkpointGraph(nodes: unknown[]) {
  return { boundaryMessageId: "msg_fixture_boundary", children: nodes };
}

// 合成多锚点形态：初始化 synthetic 消息 + 首条 realUser prompt，
// 两条都带 runtime turn 锚点，prompt 另带 product turn 锚点。
export function childPromptHistory(childSessionId: string) {
  return [
    {
      info: {
        id: "msg_fixture_init",
        sessionID: childSessionId,
        role: "user",
        time: { created: 5 },
        agent: "fixture-agent",
        synthetic: true,
        source: "subagent_message",
        semantics: {
          origin: "system",
          kind: "system_reminder",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        anchor: { turnId: "turn_fixture_child_init", origin: "synthetic" },
      },
      parts: [textPart("prt_fixture_init", childSessionId, "msg_fixture_init", "fixture init")],
    },
    {
      info: {
        id: "msg_fixture_prompt",
        sessionID: childSessionId,
        role: "user",
        time: { created: 6 },
        agent: "fixture-agent",
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
        anchor: {
          turnId: "turn_fixture_child_prompt",
          productTurnId: "msg_fixture_prompt",
          origin: "realUser",
          sourceCommandId: "cmd_fixture_child",
        },
      },
      parts: [
        textPart("prt_fixture_prompt", childSessionId, "msg_fixture_prompt", "fixture sub task"),
      ],
    },
  ];
}

// 实际 checkpoint 形态：首条是 model_change timeline_event assistant，parentID 自指、
// 无 turn 锚点；第二条 realUser prompt 带 runtime/product turn 锚点。
export function realChildCheckpointHistory(childSessionId: string) {
  return [
    {
      info: {
        id: "msg_fixture_init",
        sessionID: childSessionId,
        role: "assistant",
        parentID: "msg_fixture_init",
        time: { created: 5, completed: 5 },
        agent: "fixture-agent",
        finish: "completed",
        semantics: {
          origin: "system",
          kind: "timeline_event",
          uiVisibility: "visible",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
        },
      },
      parts: [
        {
          id: "prt_fixture_init",
          sessionID: childSessionId,
          messageID: "msg_fixture_init",
          type: "timeline",
          timelineType: "model_change",
          display: "separator",
          status: "completed",
          toModel: {
            providerId: "fixture-provider",
            modelId: "fixture-model",
            label: "fixture model",
          },
          time: { start: 5, end: 5 },
        },
      ],
    },
    {
      info: {
        id: "msg_fixture_prompt",
        sessionID: childSessionId,
        role: "user",
        time: { created: 6 },
        agent: "fixture-agent",
        semantics: {
          origin: "real_user",
          kind: "user_prompt",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
        anchor: {
          turnId: "turn_fixture_child_prompt",
          productTurnId: "msg_fixture_prompt",
          origin: "realUser",
          sourceCommandId: "cmd_fixture_child",
        },
      },
      parts: [
        textPart("prt_fixture_prompt", childSessionId, "msg_fixture_prompt", "fixture sub task"),
      ],
    },
  ];
}
