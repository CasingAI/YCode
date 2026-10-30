import type { BrowserClientTransport } from "@zcode/core/browser-client";
export declare const NODE_REPL_BROWSER_BRIDGE_SYMBOL: unique symbol;
export declare const BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Browser is not available in subagent";
/** 宿主注入的 delegated browser grant 只存在于 com.zcode/request-context，绝不从模型参数读取。 */
export declare const BROWSER_SUBAGENT_GRANT_META_KEY = "subagent_browser_grant";
/** delegated child 未获准使用的用户 tab / visibility / 生命周期命令的稳定拒绝前缀。 */
export declare const BROWSER_CAPABILITY_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Browser capability is not available in subagent";
export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
    documentationRoot: string;
    assertAvailable(): void;
}
export declare function readNodeReplBrowserRuntimeBridge(globals: Record<PropertyKey, unknown>): NodeReplBrowserRuntimeBridge;
//# sourceMappingURL=runtime-bridge.d.ts.map