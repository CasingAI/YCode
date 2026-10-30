// 子代理 Browser Use own-tabs：真实 MCP → node_repl host → socket broker → Protocol broker 模拟链路。
//
// 这里不调用 browser-bridge 的私有 helper，而是启动实际的 MCP Server（createNodeReplMcpRuntime）
// 与 MCP Client，通过 InMemoryTransport 发送 tools/call；request context 放在 MCP 请求的
// `_meta["com.zcode/request-context"]` 中，和宿主 adapter 的真实写法一致。Server 内的 REPL
// 通过实际的 Browser bridge 连接本地 socket broker，broker 再把请求交给 Protocol browser
// broker；后者的 requestClient 是页面 backend 替身，因此没有浏览器、UI 或 YCode 进程。
import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { createInProcessNodeReplExecutor, createNodeReplMcpRuntime } from "@zcode/node-repl-host";
import type { BrowserControlPort } from "@zcode/contracts";
import { createNodeReplBrowserBroker } from "../../bootstrap/src/app/node-repl-browser-broker.js";
import { createProtocolBrowserControlBroker } from "../../bootstrap/src/zcode-protocol/browser-control-broker.js";
import type { ZCodeProtocolAgentServerContext } from "../../bootstrap/src/zcode-protocol/server-types.js";

const PARENT = "parent-e2e";
const CHILD = "child-e2e";
const CHILD_2 = "child-e2e-2";
const WORKSPACE = {
  workspacePath: "/workspace/e2e",
  workspaceIdentity: "workspace-e2e",
  remoteSessionId: "remote-e2e",
};
const LIST_CODE = `
const symbol = Object.getOwnPropertySymbols(globalThis).find(
  (item) => item.description === "zcode.node-repl.browser-control-bridge",
);
const bridge = globalThis[symbol];
if (!bridge) throw new Error("browser bridge is not injected");
await bridge.list();
`;
const MAIN_META = { runtime_scope: "main", session_id: PARENT };

interface BackendCall {
  method: string;
  params: Record<string, any>;
}

interface Harness {
  backendCalls: BackendCall[];
  client: Client;
  port: BrowserControlPort;
  callJs(meta: Record<string, unknown>, code: string): Promise<CallToolResult>;
  grant(childSessionId?: string, fencingEpoch?: number): { grantId: string };
}

function sessionRecord() {
  return {
    createdAt: 0,
    updatedAt: 0,
    stateRevision: 0,
    workspace: WORKSPACE,
    deliveryKind: "desktop-continuous",
  };
}

function createBackendCalls() {
  const calls: BackendCall[] = [];
  return { calls };
}

function backendResponse(call: BackendCall): unknown {
  if (call.method === "interaction/browserList") {
    return {
      browsers: [
        {
          id: "iab-1",
          generation: 2,
          type: "iab",
          name: "In-app browser",
          capabilities: {
            browser: [{ id: "visibility", description: "Show or hide the browser pane" }],
            tab: [{ id: "playwright", description: "Playwright tab API" }],
          },
        },
      ],
    };
  }
  return { ok: true, elapsedMs: 1 };
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const sessions = new Map<string, any>([[PARENT, sessionRecord()]]);
  const { calls } = createBackendCalls();
  const context = {
    deps: {},
    appRuntimePreferences: {},
    v4Interactions: {},
    sessions,
    notify: () => undefined,
    requestClient: async (method: string, params: Record<string, any>) => {
      const call = { method, params };
      calls.push(call);
      return backendResponse(call);
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  const port = createProtocolBrowserControlBroker(context);
  const broker = createNodeReplBrowserBroker({
    browserControlPort: port,
    logger: logger as never,
  });
  const runtime = createNodeReplMcpRuntime({ executeJs: createInProcessNodeReplExecutor() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "browser-delegation-e2e", version: "1.0.0" });
  await broker.ready;
  process.env.ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET = broker.socketPath;
  process.env.ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN = broker.token;
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run({
      backendCalls: calls,
      client,
      port,
      async callJs(meta, code) {
        return await client.callTool({
          name: "js",
          arguments: { code },
          _meta: { "com.zcode/request-context": meta },
        });
      },
      grant(childSessionId = CHILD, fencingEpoch = 1) {
        return port.subagentDelegation!.grant({
          parentSessionId: PARENT,
          childSessionId,
          agentId: `agent-${childSessionId}`,
          executionFence: {
            childSessionId,
            fencingEpoch,
            ownerRuntimeId: "owner-e2e",
          },
        });
      },
    });
  } finally {
    await client.close().catch(() => undefined);
    runtime.dispose();
    await broker.close();
    delete process.env.ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET;
    delete process.env.ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN;
  }
}

function resultText(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function parseList(result: CallToolResult): any[] {
  const text = resultText(result).trim();
  const body = text.startsWith("=>") ? text.slice(2).trim() : text;
  return JSON.parse(body) as any[];
}

function executeCode(command: Record<string, unknown>): string {
  return `
const symbol = Object.getOwnPropertySymbols(globalThis).find(
  (item) => item.description === "zcode.node-repl.browser-control-bridge",
);
const bridge = globalThis[symbol];
if (!bridge) throw new Error("browser bridge is not injected");
await bridge.execute("iab-1", 2, ${JSON.stringify(command)});
"execute-ok";
`;
}

test("main 经真实 MCP 调用保持原 API 与父 session", async () => {
  await withHarness(async (harness) => {
    // 顶层 _meta 伪造 grant 也不能改变 main 路径；bridge 只从可信 request-context 读取。
    const list = await harness.callJs(
      { ...MAIN_META, subagent_browser_grant: "forged-main-grant" },
      LIST_CODE,
    );
    assert.notEqual(list.isError, true, resultText(list));
    const [browser] = parseList(list);
    assert.equal(browser?.id, "iab-1");
    assert.equal(
      browser?.capabilities?.browser?.some((item: any) => item.id === "visibility"),
      true,
    );
    assert.equal(browser?.apiSupportOverrides, undefined);

    const listCall = harness.backendCalls[0]!;
    assert.equal(listCall.method, "interaction/browserList");
    assert.equal(listCall.params.sessionId, PARENT);
    assert.equal("grantId" in listCall.params, false);
    assert.equal("delegationGrantId" in listCall.params, false);

    // 主代理仍可执行 child 被禁止的命令，证明收敛只作用于 delegated subagent。
    const execute = await harness.callJs(MAIN_META, executeCode({ method: "listUserTabs" }));
    assert.notEqual(execute.isError, true, resultText(execute));
    assert.match(resultText(execute), /execute-ok/u);
    const executeCall = harness.backendCalls[1]!;
    assert.equal(executeCall.method, "interaction/browserExecute");
    assert.equal(executeCall.params.sessionId, PARENT);
    assert.equal(executeCall.params.command.method, "listUserTabs");
  });
});

test("带 grant 的 child 保留 child sessionId，并按 own-tabs 收敛 API", async () => {
  await withHarness(async (harness) => {
    const grant = harness.grant(CHILD);
    const childMeta = {
      runtime_scope: "subagent",
      session_id: CHILD,
      subagent_browser_grant: grant.grantId,
    };
    const list = await harness.callJs(childMeta, LIST_CODE);
    assert.notEqual(list.isError, true, resultText(list));
    const [browser] = parseList(list);
    assert.deepEqual(browser?.capabilities?.browser, []);
    assert.deepEqual(browser?.capabilities?.tab, [
      { id: "playwright", description: "Playwright tab API" },
    ]);
    assert.deepEqual(browser?.apiSupportOverrides, {
      "Browser.user": false,
      "BrowserUser.openTabs": false,
      "BrowserUser.claimTab": false,
    });
    // grantId 是执行凭据，不得出现在模型可见结果里。
    assert.equal(resultText(list).includes(grant.grantId), false);

    const listCall = harness.backendCalls[0]!;
    assert.equal(listCall.method, "interaction/browserList");
    assert.equal(listCall.params.sessionId, CHILD);
    // 授权凭据只用于 Protocol 侧校验，不能下发给 backend/Main。
    assert.equal("grantId" in listCall.params, false);
    assert.equal("delegationGrantId" in listCall.params, false);
    // 页面 owner 是 child，但 workspace 快照来自父 record，避免跨 workspace/remote 串线。
    assert.equal(listCall.params.workspaceKey, WORKSPACE.workspaceIdentity);
    assert.equal(listCall.params.remoteSessionId, WORKSPACE.remoteSessionId);

    const execute = await harness.callJs(
      childMeta,
      executeCode({ method: "navigate", url: "https://example.com" }),
    );
    assert.notEqual(execute.isError, true, resultText(execute));
    const executeCall = harness.backendCalls[1]!;
    assert.equal(executeCall.method, "interaction/browserExecute");
    assert.equal(executeCall.params.sessionId, CHILD);
    assert.equal(executeCall.params.browserId, "iab-1");
    assert.deepEqual(executeCall.params.command, {
      method: "navigate",
      url: "https://example.com",
    });

    // 另一个 child 的 grant 只路由到自己的 session，不共享 owner。
    const grant2 = harness.grant(CHILD_2);
    const list2 = await harness.callJs(
      {
        runtime_scope: "subagent",
        session_id: CHILD_2,
        subagent_browser_grant: grant2.grantId,
      },
      LIST_CODE,
    );
    assert.notEqual(list2.isError, true, resultText(list2));
    assert.equal(harness.backendCalls[2]!.params.sessionId, CHILD_2);
  });
});

test("revoke 或无效 grant 在 Protocol broker 拒绝，且不触达页面 backend", async () => {
  await withHarness(async (harness) => {
    const grant = harness.grant(CHILD);
    const meta = {
      runtime_scope: "subagent",
      session_id: CHILD,
      subagent_browser_grant: grant.grantId,
    };
    const before = await harness.callJs(meta, LIST_CODE);
    assert.notEqual(before.isError, true, resultText(before));
    const callsAfterSuccess = harness.backendCalls.length;

    harness.port.subagentDelegation!.revoke({
      grantId: grant.grantId,
      childSessionId: CHILD,
      executionFence: {
        childSessionId: CHILD,
        fencingEpoch: 1,
        ownerRuntimeId: "owner-e2e",
      },
    });
    const revoked = await harness.callJs(meta, LIST_CODE);
    assert.equal(revoked.isError, true);
    assert.match(resultText(revoked), /Browser is not available for this subagent execution/u);
    assert.equal(harness.backendCalls.length, callsAfterSuccess);

    const unknown = await harness.callJs(
      { ...meta, subagent_browser_grant: "unknown-grant" },
      LIST_CODE,
    );
    assert.equal(unknown.isError, true);
    assert.match(resultText(unknown), /Browser is not available for this subagent execution/u);
    assert.equal(harness.backendCalls.length, callsAfterSuccess);

    // grant 与 child session 绑定：别的 child 复用同一 grant 也失败。
    const grant2 = harness.grant(CHILD_2);
    const mismatched = await harness.callJs(
      {
        runtime_scope: "subagent",
        session_id: CHILD,
        subagent_browser_grant: grant2.grantId,
      },
      LIST_CODE,
    );
    assert.equal(mismatched.isError, true);
    assert.match(resultText(mismatched), /Browser is not available for this subagent execution/u);
    assert.equal(harness.backendCalls.length, callsAfterSuccess);
  });
});

test("delegated child 的受限命令经真实 MCP 拒绝，正常 own-tabs 仍可用", async () => {
  await withHarness(async (harness) => {
    const grant = harness.grant(CHILD);
    const meta = {
      runtime_scope: "subagent",
      session_id: CHILD,
      subagent_browser_grant: grant.grantId,
    };
    const denied = [
      { method: "listUserTabs" },
      { method: "claimTab", tabId: "user-tab" },
      { method: "browserVisibilitySet", visible: true },
      { method: "turnEnded" },
      { method: "closeSession" },
    ];
    for (const command of denied) {
      const result = await harness.callJs(meta, executeCode(command));
      assert.equal(result.isError, true, `${command.method} must be rejected`);
      assert.match(
        resultText(result),
        new RegExp(`Browser capability is not available in subagent: ${command.method}`, "u"),
      );
    }
    assert.equal(harness.backendCalls.length, 0);

    // 正常脚本不需要 visibility.set；navigate 继续走 socket 与 Protocol broker。
    const navigate = await harness.callJs(
      meta,
      executeCode({ method: "navigate", url: "https://example.com" }),
    );
    assert.notEqual(navigate.isError, true, resultText(navigate));
    assert.equal(harness.backendCalls.length, 1);
    assert.equal(harness.backendCalls[0]!.params.sessionId, CHILD);
  });
});

test("缺少可信 metadata grant 时稳定拒绝，顶层 MCP meta 不能替代", async () => {
  await withHarness(async (harness) => {
    const childMeta = { runtime_scope: "subagent", session_id: CHILD };
    const missing = await harness.callJs(childMeta, LIST_CODE);
    assert.equal(missing.isError, true);
    assert.equal(resultText(missing).trim(), "Browser is not available in subagent");
    assert.equal(harness.backendCalls.length, 0);

    const grant = harness.grant(CHILD);
    // grant 只认 com.zcode/request-context；顶层 _meta 是第三方可扩展字段。
    const topLevel = await harness.client.callTool({
      name: "js",
      arguments: { code: LIST_CODE },
      _meta: {
        "com.zcode/request-context": childMeta,
        subagent_browser_grant: grant.grantId,
      },
    });
    assert.equal(topLevel.isError, true);
    assert.equal(resultText(topLevel).trim(), "Browser is not available in subagent");
    assert.equal(harness.backendCalls.length, 0);
  });
});
