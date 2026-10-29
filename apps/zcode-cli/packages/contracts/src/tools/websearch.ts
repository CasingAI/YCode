// ============================================================
// WebSearch Tool - provider-visible wrapper and schema definitions
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { ToolContractDeclaration } from "./contract.js";

const WebSearchProviderInputSchema = z
  .object({
    query: z.string().min(2).describe("The search query to use"),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe("Only include search results from these domains"),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe("Never include search results from these domains"),
  })
  .strict();

export const WebSearchInputSchema = WebSearchProviderInputSchema.refine(
  (input) => !(input.allowed_domains?.length && input.blocked_domains?.length),
  {
    message: "allowed_domains and blocked_domains cannot both be specified",
    path: ["blocked_domains"],
  },
);

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export const WebSearchInputJsonSchema = toToolJsonSchema(WebSearchProviderInputSchema);

export const WebSearchSourceSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().min(1),
  })
  .strict();

export type WebSearchSource = z.infer<typeof WebSearchSourceSchema>;

export const WebSearchResultItemSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().min(1),
    pageAge: z.string().optional(),
    // 独立搜索 API（DeepSeek/MiniMax 等）返回的摘要；原生 web_search 时代没有该字段。
    snippet: z.string().optional(),
  })
  .strict();

export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

const WebSearchModelUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    serverToolUse: z
      .object({
        webSearchRequests: z.number().optional(),
        webFetchRequests: z.number().optional(),
      })
      .optional(),
  })
  .strict();

export const WebSearchOutputSchema = z
  .object({
    query: z.string(),
    results: z.array(WebSearchResultItemSchema),
    sources: z.array(WebSearchSourceSchema),
    summary: z.string().optional(),
    durationMs: z.number().nonnegative(),
    webSearchRequests: z.number().int().nonnegative().optional(),
    modelUsage: WebSearchModelUsageSchema.optional(),
  })
  .strict();

export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

export const WebSearchOutputJsonSchema = toToolJsonSchema(WebSearchOutputSchema);

export const WEBSEARCH_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "web_search",
  executionMode: "client",
  inputSchema: WebSearchInputJsonSchema,
  outputSchema: WebSearchOutputJsonSchema,
  permission: {
    permission: "websearch",
    reason:
      "WebSearch performs read-only web searches through the user's configured search provider API",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input", "network"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 10_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
    preview: {
      maxLines: 30,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 60_000,
    maxMs: 120_000,
    allowCallOverride: true,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "WebSearch was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "full",
    recordOutput: "summary",
  },
};
