import type { McpCallToolRequest } from "@zcode/contracts";

// 只有宿主 node_repl 的 js 工具允许携带执行级浏览器授权；第三方 MCP server 不能收到
// 子代理 grant。该判断是传输层的最小暴露面，不是授权判断——grant 是否有效仍只由
// Protocol broker 决定。
const HOST_NODE_REPL_SERVER_NAME = "node_repl";
const HOST_NODE_REPL_TOOL_NAME = "js";

function isHostNodeReplBrowserToolRequest(request: McpCallToolRequest): boolean {
  return (
    request.serverName === HOST_NODE_REPL_SERVER_NAME &&
    request.toolName === HOST_NODE_REPL_TOOL_NAME
  );
}

export function buildMcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // nodeRepl.requestMeta 暴露。ZCode 所有 MCP server 都可忽略这些扩展键；node_repl browser
  // bridge 则以它们作为回到当前 BrowserControlPort session 的唯一关联依据。runtime_scope
  // 不能从 child session id 猜测，必须由实际执行工具的 runtime 显式透传。
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    // 执行级浏览器授权，只由父 runtime 经执行上下文注入；node_repl bridge 用它证明
    // 本次 subagent 请求属于被授权的 child execution。模型参数不能写入该键。
    ...(request.subagentBrowserGrantId && isHostNodeReplBrowserToolRequest(request)
      ? { subagent_browser_grant: request.subagentBrowserGrantId }
      : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.zcode/request-context": requestContext,
  };
}
