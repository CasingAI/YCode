// Composer Skill 只读 catalog。
// 与 Skills Settings 管理接口分离：这里的 sessionId 决定 authority，不提供启停/删除能力。
import {
  zcodeSkillsReferenceCatalogParamsSchema,
  type ZCodeSkillReferenceCatalogEntry,
  type ZCodeSkillsReferenceCatalogResult,
} from "@zcode/shared";
import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import { listZCodeSkills } from "../skills.js";
import {
  parseParams,
  ProtocolRequestError,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export async function getSkillReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSkillsReferenceCatalogResult> {
  const params = parseParams(zcodeSkillsReferenceCatalogParamsSchema, rawParams);
  const includeTitle = params.includeTitle === true;
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const outcome = await record.app.getSkillCatalog();
    return toResult(context, "session", outcome, includeTitle);
  }

  // 旧 UI cache 只在 workspace 首次挂载时扫描，用户从文件系统手动新增
  // Skill 后，新建对话仍停在旧快照。草稿请求在 Agent 侧复用 CLI 正式发现配置，
  // 每次新打开引用面板都读取当前 workspace catalog。
  const outcome = await listZCodeSkills({
    env: context.deps.env,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return toResult(context, "workspace", outcome, includeTitle);
}

function toResult(
  context: ZCodeProtocolAgentServerContext,
  authority: ZCodeSkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
  includeTitle: boolean,
): ZCodeSkillsReferenceCatalogResult {
  assertCatalogScanAvailable(context, authority, outcome);
  return {
    authority,
    skills: outcome.skills.map((skill) => toReferenceCatalogEntry(skill, includeTitle)),
  };
}

// 空表 + skill_scan_failed 表示扫描本身失败（如 runtime 发现 whole-scan catch），
// 与「真实空目录」不同：返回成功空表会让 UI 把技能卡片降级成原始 ID。
// 单项无效 SKILL / 读取失败的普通 warning 不在此拒绝，只要还有可用技能就继续投影。
function assertCatalogScanAvailable(
  context: ZCodeProtocolAgentServerContext,
  authority: ZCodeSkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
): void {
  if (outcome.skills.length > 0) return;
  const scanFailure = outcome.diagnostics.find(
    (diagnostic) => diagnostic.code === "skill_scan_failed",
  );
  if (!scanFailure) return;
  context.logger?.warn("Skill reference catalog unavailable: scan failed", {
    authority,
    diagnosticCode: scanFailure.code,
    event: "zcode_protocol.skills_reference_catalog.scan_failed",
    module: "bootstrap.zcode_protocol",
    ...(scanFailure.path ? { path: scanFailure.path } : {}),
  });
  throw new ProtocolRequestError(-32603, `Skill catalog unavailable: ${scanFailure.message}`);
}

function toReferenceCatalogEntry(
  skill: SkillMetadata,
  includeTitle: boolean,
): ZCodeSkillReferenceCatalogEntry {
  const scope =
    skill.source === "plugin" ? "plugin" : skill.scope === "project" ? "workspace" : "user";
  return {
    // `glm:` 是现有 UI provider 过滤契约；路径使同名不同来源仍有稳定行身份。
    id: `glm:${scope}:${skill.path}`,
    name: skill.name,
    // title 已由发现阶段按 skill-title.md 归一；这里只按 capability opt-in 透传。
    ...(includeTitle && skill.title ? { title: skill.title } : {}),
    description: skill.description,
    path: skill.path,
    scope,
    enabled: true,
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  };
}
