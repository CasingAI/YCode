import assert from "node:assert/strict";
import test from "node:test";
import type { TraceContext } from "@zcode/contracts";
import { buildMcpRequestMeta } from "../src/mcp/request-meta.js";

// spec: docs/specs/subagent-browser-use-delegation.md
// grantId 只能从执行上下文进入 MCP request context，与 runtime_scope/session_id 同层；
// 它不能来自模型参数，也必须能让 node_repl bridge 在 Host 侧读到。

const TRACE: TraceContext = {
  traceId: "trace-1" as TraceContext["traceId"],
  sessionId: "subagent_child_1" as TraceContext["sessionId"],
  turnId: "turn-1" as TraceContext["turnId"],
};

test("subagent 浏览器授权写入 request context 顶层与 com.zcode/request-context", () => {
  const meta = buildMcpRequestMeta({
    serverName: "node_repl",
    toolName: "js",
    runtimeScope: "subagent",
    subagentBrowserGrantId: "grant-1",
    trace: TRACE,
  });

  assert.equal(meta.subagent_browser_grant, "grant-1");
  const requestContext = meta["com.zcode/request-context"] as Record<string, unknown>;
  assert.equal(requestContext.runtime_scope, "subagent");
  assert.equal(requestContext.session_id, "subagent_child_1");
  assert.equal(requestContext.subagent_browser_grant, "grant-1");
});

test("非宿主 node_repl js 的 MCP 请求不携带子代理 grant", () => {
  const thirdParty = buildMcpRequestMeta({
    serverName: "third-party",
    toolName: "js",
    runtimeScope: "subagent",
    subagentBrowserGrantId: "grant-1",
    trace: TRACE,
  });
  assert.equal("subagent_browser_grant" in thirdParty, false);
  const thirdPartyContext = thirdParty["com.zcode/request-context"] as Record<string, unknown>;
  assert.equal("subagent_browser_grant" in thirdPartyContext, false);

  const nodeReplOtherTool = buildMcpRequestMeta({
    serverName: "node_repl",
    toolName: "other",
    runtimeScope: "subagent",
    subagentBrowserGrantId: "grant-1",
    trace: TRACE,
  });
  assert.equal("subagent_browser_grant" in nodeReplOtherTool, false);
});

test("没有 grant 时不产生空键", () => {
  const meta = buildMcpRequestMeta({
    serverName: "node_repl",
    toolName: "js",
    runtimeScope: "main",
    trace: TRACE,
  });

  assert.equal("subagent_browser_grant" in meta, false);
  const requestContext = meta["com.zcode/request-context"] as Record<string, unknown>;
  assert.equal("subagent_browser_grant" in requestContext, false);
});
