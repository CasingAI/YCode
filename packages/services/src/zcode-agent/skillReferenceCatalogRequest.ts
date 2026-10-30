import {
  zcodeProtocolMethods,
  zcodeSkillsReferenceCatalogResultSchema,
  type ZCodeSkillsReferenceCatalogParams,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";
import { readRuntimeCapabilities } from "./independentPlanSupport.js";

/**
 * title 是 capability 协商后的 opt-in：只有新 Agent 明确声明支持时才发送 includeTitle，
 * 旧 Agent 的 strict params 不会收到未知字段（docs/specs/skill-reference-catalog-title.md）。
 */
export function buildSkillReferenceCatalogParams(
  workspace: ZCodeWorkspaceRef,
  sessionId: string | undefined,
  capabilities: { skillReferenceCatalogTitle?: boolean } | undefined,
): ZCodeSkillsReferenceCatalogParams {
  return {
    workspace,
    ...(sessionId ? { sessionId } : {}),
    ...(capabilities?.skillReferenceCatalogTitle === true ? { includeTitle: true } : {}),
  };
}

export async function requestSkillReferenceCatalog(
  client: Pick<ZCodeProtocolClient, "request">,
  workspace: ZCodeWorkspaceRef,
  sessionId: string | undefined,
) {
  // 探测失败按旧 Agent 处理：catalog 读取本身不应被可选展示字段阻断。
  const capabilities = await readRuntimeCapabilities(client).catch(() => undefined);
  return client.request(
    zcodeProtocolMethods.skillsReferenceCatalog,
    buildSkillReferenceCatalogParams(workspace, sessionId, capabilities),
    zcodeSkillsReferenceCatalogResultSchema,
  );
}
