import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageId,
  createPartId,
  createSessionId,
  createToolCallId,
  type BackgroundTaskInfo,
  type MessageWithParts,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
} from "@zcode/contracts";
import { projectSessionSubagents } from "../src/zcode-protocol/subagent-session-query.js";

const parentSessionId = createSessionId();
const childSessionId = createSessionId("subagent_legacy");
const parentToolCallId = createToolCallId();
const agentId = "agent_legacy";

function session(id: string, taskType: "interactive" | "subagent_child"): SessionInfo {
  return {
    id: id as SessionInfo["id"],
    projectID: "project_test" as SessionInfo["projectID"],
    taskType,
    slug: id,
    directory: process.cwd(),
    title: id,
    version: "1",
    time: { created: 1, updated: 2 },
  };
}

function legacyAsyncMessages(): MessageWithParts[] {
  const messageID = createMessageId();
  const part: ToolPart = {
    id: createPartId(),
    sessionID: parentSessionId,
    messageID,
    type: "tool",
    callID: parentToolCallId,
    tool: "Agent",
    state: {
      status: "completed",
      input: {
        description: "legacy async",
        prompt: "continue working",
        run_in_background: true,
      },
      output: JSON.stringify({
        status: "async_launched",
        isAsync: true,
        agentId,
        agentType: "general-purpose",
        description: "legacy async",
        prompt: "continue working",
        childSessionId,
        backgroundTaskId: agentId,
        outputFile: "/tmp/legacy-output.txt",
        canReadOutputFile: true,
      }),
      title: "legacy async",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };

  return [
    {
      info: {
        id: messageID,
        sessionID: parentSessionId,
        role: "assistant",
        parentID: createMessageId(),
        time: { created: 1, completed: 2 },
        mode: "build",
        agent: "build",
        path: { cwd: process.cwd(), root: process.cwd() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [part],
    },
  ];
}

function project(parentProjection?: SessionProjection) {
  return projectSessionSubagents({
    revision: 1,
    parentSession: session(parentSessionId, "interactive"),
    messages: legacyAsyncMessages(),
    childSessionsById: new Map([[childSessionId, session(childSessionId, "subagent_child")]]),
    childMessagesById: new Map(),
    childProjectionsById: new Map(),
    ...(parentProjection ? { parentProjection } : {}),
  });
}

test("legacy async Agent without live evidence is readable as lost, not running", () => {
  const projection = project();

  assert.equal(projection.running.length, 0);
  assert.equal(projection.ended.length, 1);
  assert.equal(projection.ended[0]?.status, "lost");
  assert.equal(projection.ended[0]?.agentId, agentId);
});

test("legacy async Agent remains running while a live background task exists", () => {
  const backgroundTask = {
    taskId: agentId,
    taskKind: "subagent",
    toolCallId: parentToolCallId,
    childSessionId,
    status: "running",
    blocked: false,
    startedAt: new Date(1),
  } as BackgroundTaskInfo;
  const parentProjection = {
    backgroundTasks: [backgroundTask],
    activeToolCalls: [],
  } as unknown as SessionProjection;

  const projection = project(parentProjection);

  assert.equal(projection.running.length, 1);
  assert.equal(projection.running[0]?.status, "running");
  assert.equal(projection.ended.length, 0);
});
