import type { BrowserClientTransport } from "@zcode/core/browser-client";

export const NODE_REPL_BROWSER_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.browser-control-bridge");
export const BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Browser is not available in subagent";
/** 宿主注入的 delegated browser grant 只存在于 com.zcode/request-context，绝不从模型参数读取。 */
export const BROWSER_SUBAGENT_GRANT_META_KEY = "subagent_browser_grant";
/** delegated child 未获准使用的用户 tab / visibility / 生命周期命令的稳定拒绝前缀。 */
export const BROWSER_CAPABILITY_UNAVAILABLE_IN_SUBAGENT_MESSAGE =
  "Browser capability is not available in subagent";

export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
  documentationRoot: string;
  assertAvailable(): void;
}

export function readNodeReplBrowserRuntimeBridge(
  globals: Record<PropertyKey, unknown>,
): NodeReplBrowserRuntimeBridge {
  const bridge = globals[NODE_REPL_BROWSER_BRIDGE_SYMBOL];
  if (!bridge || typeof bridge !== "object") {
    throw new Error(
      "Browser runtime bridge is unavailable. Use Browser from a ZCode desktop or shared-host session.",
    );
  }
  return bridge as NodeReplBrowserRuntimeBridge;
}
