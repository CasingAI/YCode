import assert from "node:assert/strict";
import test from "node:test";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";

test("storage warning RPCs require a V4 handshake and carry trusted Web connection context", async () => {
  const calls: unknown[] = [];
  const base = {
    conversationSessionStorageUsageV4: async (params: unknown) => {
      calls.push(params);
      return {
        sessionId: "sess_remote",
        totalBytes: 0,
        categories: [],
        complete: true,
        errorCount: 0,
        dismissed: false,
      };
    },
    dismissConversationStorageWarningV4: async (params: unknown) => {
      calls.push(params);
      return { dismissed: true as const };
    },
  } as unknown as IZCodeAgentService;
  const scope = createZCodeAgentConnectionScope(base, {
    connectionId: "web-storage-warning",
    clientMode: "web-remote-replayable",
  });
  const target = { workspacePath: "/remote/project", sessionId: "sess_remote" };

  try {
    await assert.rejects(
      scope.service.conversationSessionStorageUsageV4(target),
      /fault\.connection\.handshakeRequired/,
    );
    assert.equal(calls.length, 0);

    await scope.service.helloConversationV4();
    await scope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "client-web",
      appVersion: "test",
    });

    await scope.service.conversationSessionStorageUsageV4(target);
    await scope.service.dismissConversationStorageWarningV4(target);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(readTrustedZCodeAgentV4Connection(call), {
        connectionId: "web-storage-warning",
        clientMode: "web-remote-replayable",
      });
    }
  } finally {
    await scope.dispose();
  }
});
