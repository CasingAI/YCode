import { z } from "zod";

/**
 * 内置支持独立搜索 API 的供应商模板（docs/specs/web-search-provider-capability.md）。
 * 设置页识别与 CLI 执行解析共用这份名单，它是搜索源识别的唯一事实源；
 * 新增搜索源时只改这里与 zcode-builtin.json 的模板，不允许出现第二份名单。
 *
 * `jina` 是唯一的「独立搜索源」模板：不绑定聊天模型，实例只能从网络搜索设置页
 * 手动添加（可重复）；其余四项与聊天供应商模板共用实例。
 */
export const WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS = [
  "zai-api",
  "bigmodel-api",
  "minimax-token-plan",
  "deepseek",
  "jina",
] as const;

export type WebSearchCapableProviderTemplateId =
  (typeof WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS)[number];

export const webSearchEndpointKindSchema = z.enum(["rest", "mcp"]);
export type WebSearchEndpointKind = z.infer<typeof webSearchEndpointKindSchema>;

/** 搜索端点描述：与模板绑定，CLI 执行时按 provider 的 templateId/baseUrl 解析。 */
export interface WebSearchEndpointDescriptor {
  kind: WebSearchEndpointKind;
  endpoint: string;
  /** MCP 搜索工具名；REST 端点没有。 */
  toolName?: string;
  /**
   * 未初始化排序时的派生优先级：数值越小越靠前。
   * 套餐内计费的搜索源排前，按量计费（DeepSeek、Jina）排后。
   */
  defaultPriority: number;
  /** 计费归属；设置页据此展示提示文案。 */
  billing: "plan" | "per-call";
}

export const WEB_SEARCH_PROVIDER_ENDPOINTS: Record<
  WebSearchCapableProviderTemplateId,
  WebSearchEndpointDescriptor
> = {
  "zai-api": {
    billing: "plan",
    defaultPriority: 0,
    endpoint: "https://api.z.ai/api/mcp/web_search_prime/mcp",
    kind: "mcp",
    toolName: "webSearchPrime",
  },
  "bigmodel-api": {
    billing: "plan",
    defaultPriority: 1,
    endpoint: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    kind: "mcp",
    toolName: "webSearchPrime",
  },
  "minimax-token-plan": {
    billing: "plan",
    defaultPriority: 2,
    endpoint: "https://api.minimaxi.com/v1/coding_plan/search",
    kind: "rest",
  },
  deepseek: {
    billing: "per-call",
    defaultPriority: 3,
    endpoint: "https://api.deepseek.com/v1/tools/search",
    kind: "rest",
  },
  jina: {
    billing: "per-call",
    defaultPriority: 4,
    // Reader Search API：POST {endpoint}{encodeURIComponent(query)}，query 在路径上，
    // 选项走 body；URL 末尾的斜杠由适配器负责拼接，不在这里带。
    endpoint: "https://s.jina.ai/",
    kind: "rest",
  },
};

/**
 * templateId 缺失时的 baseUrl 签名回退。
 * 只收录无歧义的签名：BigModel/Z.ai 仅 Coding Plan 模板走 /api/anthropic 前缀，
 * 标准模板走 /api/paas/v4，可区分；MiniMax 的标准模板与 Token Plan 模板共用
 * 同一 baseUrl，签名无法区分，因此不进回退表（只能靠 templateId 识别）。
 */
const WEB_SEARCH_PROVIDER_BASE_URL_SIGNATURES: readonly {
  baseUrlPrefix: string;
  templateId: WebSearchCapableProviderTemplateId;
}[] = [
  { baseUrlPrefix: "https://api.z.ai/api/anthropic", templateId: "zai-api" },
  { baseUrlPrefix: "https://open.bigmodel.cn/api/anthropic", templateId: "bigmodel-api" },
  { baseUrlPrefix: "https://api.deepseek.com/anthropic", templateId: "deepseek" },
];

export function isWebSearchCapableTemplateId(
  templateId: string | null | undefined,
): templateId is WebSearchCapableProviderTemplateId {
  return (
    templateId !== null &&
    templateId !== undefined &&
    (WEB_SEARCH_CAPABLE_PROVIDER_TEMPLATE_IDS as readonly string[]).includes(templateId)
  );
}

/**
 * 解析一个 provider 实例对应的搜索源模板。
 * 先看 templateId，再看 baseUrl 签名回退；都命不中则该 provider 不是搜索源。
 */
export function resolveWebSearchTemplateId(input: {
  templateId?: string | null;
  apiBaseUrl?: string | null;
}): WebSearchCapableProviderTemplateId | undefined {
  if (isWebSearchCapableTemplateId(input.templateId)) {
    return input.templateId;
  }
  const baseUrl = input.apiBaseUrl?.trim().replace(/\/+$/u, "");
  if (!baseUrl) return undefined;
  return WEB_SEARCH_PROVIDER_BASE_URL_SIGNATURES.find((signature) =>
    baseUrl.startsWith(signature.baseUrlPrefix),
  )?.templateId;
}

/**
 * 把已识别的搜索源候选按固定优先级派生默认排序：
 * 同优先级内按 providerId 稳定排序，保证 UI 与 CLI 派生结果一致。
 */
export function deriveDefaultWebSearchProviderOrder(
  candidates: readonly {
    providerId: string;
    templateId: WebSearchCapableProviderTemplateId;
  }[],
): string[] {
  return [...candidates]
    .sort(
      (left, right) =>
        WEB_SEARCH_PROVIDER_ENDPOINTS[left.templateId].defaultPriority -
          WEB_SEARCH_PROVIDER_ENDPOINTS[right.templateId].defaultPriority ||
        left.providerId.localeCompare(right.providerId),
    )
    .map((candidate) => candidate.providerId);
}

/**
 * 应用用户排序到当前候选：
 * - `order === undefined` 表示用户从未整理过排序，走固定优先级派生；
 * - 否则以保存的顺序为准，剔除已不存在的候选，把新出现的候选追加尾部。
 * UI 展示与 CLI 执行共用，保证两侧看到的激活项一致。
 */
export function resolveWebSearchProviderOrder(input: {
  order: readonly string[] | undefined;
  candidates: readonly {
    providerId: string;
    templateId: WebSearchCapableProviderTemplateId;
  }[];
}): string[] {
  const detectedIds = input.candidates.map((candidate) => candidate.providerId);
  if (input.order === undefined) {
    return deriveDefaultWebSearchProviderOrder(input.candidates);
  }
  const detected = new Set(detectedIds);
  const ordered = input.order.filter((providerId) => detected.has(providerId));
  for (const providerId of detectedIds) {
    if (!ordered.includes(providerId)) {
      ordered.push(providerId);
    }
  }
  return ordered;
}
