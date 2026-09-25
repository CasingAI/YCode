import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_ACCESSOR_CONNECTION } from "@zcode/shared";
import { createAgentConversationTransport } from "../src/v4/agentConversationTransport.js";
import { createAgentSessionsIndexTransport } from "../src/v4/agentSessionsIndexTransport.js";

function createConnectionPort(current: { attachment: object | null }) {
  const listeners = new Set<() => void>();
  return {
    port: {
      [SERVICE_ACCESSOR_CONNECTION]: {
        getAttachment: () => current.attachment,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    attach(attachment: object) {
      current.attachment = attachment;
      for (const listener of listeners) listener();
    },
  };
}

test("conversation transport 在新 attachment 到达时通知 store 重新订阅", () => {
  const state = { attachment: {} as object | null };
  const connection = createConnectionPort(state);
  const service = {
    ...connection.port,
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const transport = createAgentConversationTransport(service as never, {
    workspacePath: "/workspace/attachment",
  });
  const reasons: Array<string | undefined> = [];
  const off = transport.onRuntimeRestart((reason) => reasons.push(reason));

  connection.attach({});
  assert.deepEqual(reasons, ["transportReplaced"]);
  off();
});

test("sessions-index transport 也在新 attachment 到达时通知 store", () => {
  const state = { attachment: {} as object | null };
  const connection = createConnectionPort(state);
  const service = {
    ...connection.port,
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
  };
  const transport = createAgentSessionsIndexTransport(service as never, {
    workspacePath: "/workspace/attachment",
  });
  const reasons: Array<string | undefined> = [];
  const off = transport.onRuntimeRestart((reason) => reasons.push(reason));

  connection.attach({});
  assert.deepEqual(reasons, ["transportReplaced"]);
  off();
});
