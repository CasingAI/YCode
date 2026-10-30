import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NODE_REPL_BROWSER_BROKER_SOCKET_ENV,
  NODE_REPL_BROWSER_BROKER_TOKEN_ENV,
} from "@zcode/shared/node-repl-browser-broker";
import type { BrowserCommand } from "@zcode/shared";
import { createBrowserBridgeGlobals, type ActiveNodeReplCall } from "../src/browser-bridge.js";
import {
  BROWSER_CAPABILITY_UNAVAILABLE_IN_SUBAGENT_MESSAGE,
  BROWSER_SUBAGENT_GRANT_META_KEY,
  BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE,
  NODE_REPL_BROWSER_BRIDGE_SYMBOL,
  type NodeReplBrowserRuntimeBridge,
} from "../src/runtime-bridge.js";

// 子代理 Browser Use own-tabs 的 Host bridge 契约（docs/specs/subagent-browser-use-delegation.md）：
// main 行为不变；subagent 无 grant 稳定拒绝；有 grant 时 list/execute 携带 grantId；
// 后端拒绝原样上抛；kernel reset 后旧 binding 失效；受限命令不进入 broker。
// 这里用本地假 broker（无 YCode/桌面连接）验证真实 socket 往返与序列化。

const BROKER_TOKEN = "b".repeat(48);

type JsonRecord = Record<string, unknown>;

class FakeBroker {
  readonly requests: JsonRecord[] = [];
  #server: Server | undefined;
  #directory: string | undefined;
  #socketPath = "";

  constructor(
    private readonly respond: (request: JsonRecord) => JsonRecord = (request) => ({
      id: request.id,
      ok: true,
    }),
  ) {}

  async start(): Promise<void> {
    if (process.platform === "win32") {
      this.#socketPath = `\\\\.\\pipe\\zcode-bridge-test-${randomUUID()}`;
    } else {
      this.#directory = await mkdtemp(join(tmpdir(), "zcode-bridge-test-"));
      this.#socketPath = join(this.#directory, "broker.sock");
    }
    this.#server = createServer((connection) => {
      let buffer = "";
      connection.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as JsonRecord;
        buffer = buffer.slice(newline + 1);
        this.requests.push(request);
        connection.end(`${JSON.stringify(this.respond(request))}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.#socketPath, () => resolve());
    });
    process.env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV] = this.#socketPath;
    process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV] = BROKER_TOKEN;
  }

  async stop(): Promise<void> {
    delete process.env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV];
    delete process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV];
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.#directory) {
      await rm(this.#directory, { recursive: true, force: true });
      this.#directory = undefined;
    }
  }
}

const sessionStub = {
  recordBrowserScreenshot: () => undefined,
  mergeResponseMeta: () => undefined,
} as never;

function createBridge(
  active: ActiveNodeReplCall | undefined,
  generation = 1,
): NodeReplBrowserRuntimeBridge {
  const globals = createBrowserBridgeGlobals({
    documentationRoot: ".",
    generation,
    getActiveCall: () => active,
    // bridge 只把结果元数据合并进当前 REPL session，测试不需要真实 session。
    session: () => sessionStub,
  });
  return globals[NODE_REPL_BROWSER_BRIDGE_SYMBOL] as NodeReplBrowserRuntimeBridge;
}

function activeCall(meta: Record<string, unknown>, generation = 1): ActiveNodeReplCall {
  return {
    generation,
    requestMeta: meta,
    signal: new AbortController().signal,
  };
}

function browserDescriptor(): JsonRecord {
  return {
    id: "iab-1",
    generation: 2,
    type: "iab",
    name: "In-app browser",
    capabilities: {
      browser: [{ id: "visibility", description: "Show or hide the browser pane" }],
      tab: [{ id: "playwright", description: "Playwright tab API" }],
    },
  };
}

function okList(request: JsonRecord): JsonRecord {
  return { id: request.id, ok: true, browsers: [browserDescriptor()] };
}

function okExecute(request: JsonRecord): JsonRecord {
  return { id: request.id, ok: true, result: { ok: true, elapsedMs: 1 } };
}

test("main 会话的 list/execute 不携带 grantId", async () => {
  const broker = new FakeBroker((request) =>
    request.op === "list" ? okList(request) : okExecute(request),
  );
  await broker.start();
  try {
    const bridge = createBridge(activeCall({ runtime_scope: "main", session_id: "sess_parent" }));
    const browsers = await bridge.list();
    assert.equal(browsers[0]?.id, "iab-1");
    assert.equal(browsers[0]?.capabilities.browser?.[0]?.id, "visibility");
    assert.equal(browsers[0]?.apiSupportOverrides, undefined);

    await bridge.execute("iab-1", 2, { method: "navigate", url: "https://example.com" });
    assert.equal(broker.requests.length, 2);
    assert.equal(broker.requests[0]?.runtimeScope, "main");
    assert.equal(broker.requests[0]?.sessionId, "sess_parent");
    assert.equal("grantId" in (broker.requests[0] ?? {}), false);
    assert.equal("grantId" in (broker.requests[1] ?? {}), false);
  } finally {
    await broker.stop();
  }
});

test("subagent 缺少可信 grant 时稳定拒绝且不触达 broker", async () => {
  const broker = new FakeBroker(okList);
  await broker.start();
  try {
    const bridge = createBridge(
      activeCall({ runtime_scope: "subagent", session_id: "sess_child" }),
    );
    await assert.rejects(bridge.list(), new RegExp(BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE));
    await assert.rejects(
      bridge.execute("iab-1", 2, { method: "newTab" }),
      new RegExp(BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE),
    );
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.stop();
  }
});

test("带 grant 的 subagent list/execute 传递 child session 与 grantId，并收敛 API 面", async () => {
  const broker = new FakeBroker((request) =>
    request.op === "list" ? okList(request) : okExecute(request),
  );
  await broker.start();
  try {
    const bridge = createBridge(
      activeCall({
        runtime_scope: "subagent",
        session_id: "sess_child",
        [BROWSER_SUBAGENT_GRANT_META_KEY]: "grant-1",
      }),
    );
    const browsers = await bridge.list();
    const descriptor = browsers[0];
    assert.equal(broker.requests[0]?.runtimeScope, "subagent");
    assert.equal(broker.requests[0]?.sessionId, "sess_child");
    assert.equal(broker.requests[0]?.grantId, "grant-1");
    // own-tabs：user tab 与 visibility 通过既有 capability/override 机制隐藏。
    assert.equal(
      descriptor?.capabilities.browser?.some((item) => item.id === "visibility"),
      false,
    );
    assert.equal(descriptor?.apiSupportOverrides?.["Browser.user"], false);
    assert.equal(descriptor?.apiSupportOverrides?.["BrowserUser.openTabs"], false);
    assert.equal(descriptor?.apiSupportOverrides?.["BrowserUser.claimTab"], false);

    await bridge.execute("iab-1", 2, { method: "navigate", url: "https://example.com" });
    assert.equal(broker.requests[1]?.op, "execute");
    assert.equal(broker.requests[1]?.sessionId, "sess_child");
    assert.equal(broker.requests[1]?.grantId, "grant-1");
  } finally {
    await broker.stop();
  }
});

test("后端拒绝 grant 时 bridge 原样上抛稳定错误", async () => {
  const broker = new FakeBroker((request) => ({
    id: request.id,
    ok: false,
    error: "Browser grant is no longer valid",
  }));
  await broker.start();
  try {
    const bridge = createBridge(
      activeCall({
        runtime_scope: "subagent",
        session_id: "sess_child",
        [BROWSER_SUBAGENT_GRANT_META_KEY]: "grant-revoked",
      }),
    );
    await assert.rejects(bridge.list(), /Browser grant is no longer valid/);
  } finally {
    await broker.stop();
  }
});

test("kernel reset 后旧 binding 立即失效", async () => {
  const bridge = createBridge(
    activeCall({ runtime_scope: "main", session_id: "sess_parent" }, 2),
    1,
  );
  await assert.rejects(bridge.list(), /stale after kernel reset/);
});

test("delegated child 的 user tab / visibility 写入 / 生命周期命令在 Host 层拒绝", async () => {
  const broker = new FakeBroker(okExecute);
  await broker.start();
  try {
    const bridge = createBridge(
      activeCall({
        runtime_scope: "subagent",
        session_id: "sess_child",
        [BROWSER_SUBAGENT_GRANT_META_KEY]: "grant-1",
      }),
    );
    const denied: BrowserCommand[] = [
      { method: "listUserTabs" },
      { method: "claimTab", tabId: "user-tab" },
      { method: "browserVisibilitySet", visible: true },
      { method: "turnEnded" },
      { method: "closeSession" },
    ];
    for (const command of denied) {
      await assert.rejects(
        bridge.execute("iab-1", 2, command),
        new RegExp(`${BROWSER_CAPABILITY_UNAVAILABLE_IN_SUBAGENT_MESSAGE}: ${command.method}`),
      );
    }
    assert.equal(broker.requests.length, 0);

    // 正常 own-tabs 脚本不需要 visibility.set，导航/新 tab/关闭都应继续可用。
    for (const command of [
      { method: "newTab" },
      { method: "navigate", url: "https://example.com" },
      { method: "screenshot" },
      { method: "close", tabId: "tab-1" },
      { method: "browserVisibilityGet" },
    ] as BrowserCommand[]) {
      await bridge.execute("iab-1", 2, command);
    }
    assert.equal(broker.requests.length, 5);
  } finally {
    await broker.stop();
  }
});
