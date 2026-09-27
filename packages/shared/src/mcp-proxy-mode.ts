/**
 * 按 MCP 服务器的出口代理模式（跨层共享单源）。
 *
 * 独立成叶子模块的原因：`mcp.ts` 与 `zcode-protocol/index.ts` 都要引用它，而
 * `mcp.ts` 已经 type-only 引用 `zcode-protocol/index.js`。让协议层改成对 `mcp.ts` 的
 * 值导入会留下一条运行时环的风险；叶子模块（对照 `model-config.ts`）两侧都无依赖。
 *
 * 语义与 `ModelConfig.proxyMode` 逐条对齐（docs/specs/network-settings.md）：
 * - "default"：跟随全局「为全局启用」开关的 gate 结果，与历史行为完全一致；
 * - "proxy"：强制走「网络」分区填写的代理地址，地址未填时直连；
 * - "system"：走操作系统配置的代理，系统未配代理时直连（不解析 PAC）；
 * - "direct"：无视全局开关强制直连，并屏蔽 env 里的代理候选。
 *
 * 三种传输（stdio/http/sse）共用这一个枚举：stdio 子进程同样会被注入
 * HTTP_PROXY/ALL_PROXY，只管 http/sse 会留下一个真实的不一致口子。
 */
export const MCP_PROXY_MODES = ["default", "proxy", "system", "direct"] as const;
export type McpProxyMode = (typeof MCP_PROXY_MODES)[number];

/**
 * 非法枚举值归一为未设置（等价 default），与 isMcpProtocolVersion 同语义：
 * 立即可发现的配置错误不留给连接阶段，config 里的手滑值也不会让 UI 下拉显示空白。
 */
export function isMcpProxyMode(value: unknown): value is McpProxyMode {
  return typeof value === "string" && (MCP_PROXY_MODES as readonly string[]).includes(value);
}
