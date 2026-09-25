import assert from "node:assert/strict";
import test from "node:test";
import { V4_WIRE_PROTOCOL_VERSION, type HelloMessage } from "@zcode/shared/zcode-protocol-v4";
import { isCommandNotSentError, SERVICE_ACCESSOR_CONNECTION } from "@zcode/shared";
import { ensureAgentV4ConnectionHandshake } from "../src/v4/agentV4ConnectionHandshake.js";

interface Attachment {
  helloConversationV4(): Promise<HelloMessage>;
  initializeConversationV4(): Promise<void>;
  helloCalls: number;
  initializeCalls: number;
}

function createAttachment(label: string): Attachment {
  const attachment: Attachment = {
    helloCalls: 0,
    initializeCalls: 0,
    async helloConversationV4() {
      attachment.helloCalls += 1;
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: label,
        clientMode: "web-remote-replayable",
        deliveryProfile: "replayable",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      };
    },
    async initializeConversationV4() {
      attachment.initializeCalls += 1;
    },
  };
  return attachment;
}

test("稳定 facade 跨 attachment 换代时重新执行 V4 握手", async () => {
  const first = createAttachment("first");
  const second = createAttachment("second");
  let current: Attachment | null = first;
  const listeners = new Set<() => void>();
  const service = {
    [SERVICE_ACCESSOR_CONNECTION]: {
      getAttachment: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    helloConversationV4: () => {
      assert.ok(current);
      return current.helloConversationV4();
    },
    initializeConversationV4: () => {
      assert.ok(current);
      return current.initializeConversationV4();
    },
  };

  await Promise.all([
    ensureAgentV4ConnectionHandshake(service),
    ensureAgentV4ConnectionHandshake(service),
  ]);
  assert.equal(first.helloCalls, 1);
  assert.equal(first.initializeCalls, 1);

  current = second;
  for (const listener of listeners) listener();
  await ensureAgentV4ConnectionHandshake(service);
  assert.equal(second.helloCalls, 1);
  assert.equal(second.initializeCalls, 1);
});

test("断线 attachment 为空时握手 fail-closed，不污染上一代缓存", async () => {
  const first = createAttachment("first");
  let current: Attachment | null = first;
  const service = {
    [SERVICE_ACCESSOR_CONNECTION]: {
      getAttachment: () => current,
      subscribe: () => () => {},
    },
    helloConversationV4: () => {
      assert.ok(current);
      return current.helloConversationV4();
    },
    initializeConversationV4: () => {
      assert.ok(current);
      return current.initializeConversationV4();
    },
  };

  await ensureAgentV4ConnectionHandshake(service);
  current = null;
  await assert.rejects(
    ensureAgentV4ConnectionHandshake(service),
    (error: Error) => error.name === "ConnectionClosed" && isCommandNotSentError(error),
  );
  assert.equal(first.helloCalls, 1);
});
