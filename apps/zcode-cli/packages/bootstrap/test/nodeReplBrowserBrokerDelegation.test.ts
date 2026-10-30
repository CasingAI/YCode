// node_repl browser broker 回归：token 仍是最外层门槛；subagent 无 grant 稳定拒绝，
// 有 grant 时只把 delegationGrantId 交给 BrowserControlPort（真正授权在 Protocol broker）。
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { BrowserControlPort } from "@zcode/contracts";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "../src/app/node-repl-browser-broker.js";

interface PortCall {
  op: "list" | "execute";
  input: Record<string, unknown>;
}

function createPort(): { port: BrowserControlPort; calls: PortCall[] } {
  const calls: PortCall[] = [];
  const port: BrowserControlPort = {
    async list(input) {
      calls.push({ op: "list", input: input as unknown as Record<string, unknown> });
      return [];
    },
    async execute(input) {
      calls.push({ op: "execute", input: input as unknown as Record<string, unknown> });
      return { ok: true, elapsedMs: 1 };
    },
  };
  return { port, calls };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function callBroker(
  broker: NodeReplBrowserBroker,
  payload: Record<string, unknown>,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = connect(broker.socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("node_repl broker response timed out"));
    }, 3000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function withBroker(
  run: (broker: NodeReplBrowserBroker, calls: PortCall[]) => Promise<void>,
): Promise<void> {
  const { port, calls } = createPort();
  const broker = createNodeReplBrowserBroker({ browserControlPort: port, logger });
  await broker.ready;
  try {
    await run(broker, calls);
  } finally {
    await broker.close();
  }
}

function basePayload(broker: NodeReplBrowserBroker, overrides: Record<string, unknown>) {
  return {
    id: randomUUID(),
    runtimeScope: "main",
    token: broker.token,
    sessionId: "session-1",
    ...overrides,
  };
}

test("token 不匹配时拒绝，且不触达 BrowserControlPort", async () => {
  await withBroker(async (broker, calls) => {
    const response = await callBroker(broker, {
      ...basePayload(broker, { op: "list" }),
      token: "x".repeat(64),
    });
    assert.equal(response.ok, false);
    assert.match(String(response.error), /not authorized/iu);
    assert.equal(calls.length, 0);
  });
});

test("subagent 无 grant 时稳定拒绝，不触达 BrowserControlPort", async () => {
  await withBroker(async (broker, calls) => {
    const response = await callBroker(
      broker,
      basePayload(broker, { op: "list", runtimeScope: "subagent", sessionId: "child-1" }),
    );
    assert.equal(response.ok, false);
    assert.match(String(response.error), /not available in subagent/iu);
    assert.equal(calls.length, 0);

    const executeResponse = await callBroker(
      broker,
      basePayload(broker, {
        op: "execute",
        runtimeScope: "subagent",
        sessionId: "child-1",
        browserId: "browser-a",
        browserGeneration: 1,
        command: { method: "newTab" },
      }),
    );
    assert.equal(executeResponse.ok, false);
    assert.equal(calls.length, 0);
  });
});

test("subagent 带 grant 时把 delegationGrantId 与 child sessionId 传给端口", async () => {
  await withBroker(async (broker, calls) => {
    const grantId = randomUUID();
    const response = await callBroker(
      broker,
      basePayload(broker, {
        op: "list",
        runtimeScope: "subagent",
        sessionId: "child-1",
        grantId,
      }),
    );
    assert.equal(response.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.op, "list");
    assert.equal(calls[0]!.input.sessionId, "child-1");
    assert.equal(calls[0]!.input.delegationGrantId, grantId);
  });
});

test("subagent execute 带 grant 时保留命令并传递 delegationGrantId", async () => {
  await withBroker(async (broker, calls) => {
    const grantId = randomUUID();
    const response = await callBroker(
      broker,
      basePayload(broker, {
        op: "execute",
        runtimeScope: "subagent",
        sessionId: "child-1",
        grantId,
        browserId: "browser-a",
        browserGeneration: 3,
        command: { method: "navigate", url: "https://example.com" },
      }),
    );
    assert.equal(response.ok, true);
    assert.equal(calls.length, 1);
    const input = calls[0]!.input;
    assert.equal(input.sessionId, "child-1");
    assert.equal(input.delegationGrantId, grantId);
    assert.equal(input.browserId, "browser-a");
    assert.equal(input.browserGeneration, 3);
    assert.deepEqual(input.command, { method: "navigate", url: "https://example.com" });
  });
});

test("main 请求路径不变：无 grant 时不附带 delegationGrantId", async () => {
  await withBroker(async (broker, calls) => {
    const response = await callBroker(
      broker,
      basePayload(broker, { op: "list", sessionId: "session-1" }),
    );
    assert.equal(response.ok, true);
    assert.equal(calls[0]!.input.sessionId, "session-1");
    assert.equal("delegationGrantId" in calls[0]!.input, false);
  });
});

test("main 请求即使带伪填 grantId 也不会切换到授权路径", async () => {
  await withBroker(async (broker, calls) => {
    const response = await callBroker(
      broker,
      basePayload(broker, {
        op: "list",
        sessionId: "session-1",
        // 模型/传输层伪填的字段不能改变主代理路径。
        grantId: randomUUID(),
      }),
    );
    assert.equal(response.ok, true);
    assert.equal("delegationGrantId" in calls[0]!.input, false);
  });
});
