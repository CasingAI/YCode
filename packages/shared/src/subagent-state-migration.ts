import {
  migrateLegacyModelProviderId,
  migrateLegacyOfficialGlmModelId,
} from "./legacy-model-provider-identity.js";
import { parseSubagentMarkdownSelection } from "./subagent-markdown-selection.js";
import type {
  BuiltInSubagentModelSelectionOverrides,
  PluginSubagentModelSelectionOverrides,
} from "./subagents-types.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 遗留翻译名单：只服务缺失正式字段的一次性创建（docs/specs/subagent-state-storage.md）。
 * 名单漏名最坏只丢该名字的遗留默认值，不会再像整表重建那样把已写入的覆盖
 * 在每次读取时清掉——Worker 覆盖反复丢失的根因就是按名单重建。
 */
// Worker（SmartWorker）已废弃（docs/specs/team-mode.md）：遗留覆盖键不导入、
// 不迁移，读取方内存规范化后天然忽略。
const BUILT_IN_IMPORT_NAMES = ["Explore", "general-purpose"] as const;

function importBuiltInSelectionsFromLegacy(
  input: Record<string, unknown>,
): BuiltInSubagentModelSelectionOverrides {
  const selections: BuiltInSubagentModelSelectionOverrides = {};
  for (const name of BUILT_IN_IMPORT_NAMES) {
    const selection = parseSubagentMarkdownSelection({
      model: record(input.builtInModelOverrides)[name],
      thoughtLevel: record(input.builtInThoughtLevelOverrides)[name],
    });
    if (!selection) continue;
    const providerId = selection.providerId.startsWith("builtin:")
      ? migrateLegacyModelProviderId(selection.providerId)
      : selection.providerId;
    selections[name] = providerId
      ? {
          ...selection,
          providerId,
          modelId: migrateLegacyOfficialGlmModelId(selection.providerId, selection.modelId),
        }
      : selection;
  }
  return selections;
}

function importPluginSelectionsFromLegacy(
  input: Record<string, unknown>,
): PluginSubagentModelSelectionOverrides {
  return Object.fromEntries(
    Object.entries(record(input.pluginAgentModelOverrides)).flatMap(([id, model]) => {
      const selection = parseSubagentMarkdownSelection({
        model,
        thoughtLevel: record(input.pluginAgentThoughtLevelOverrides)[id],
      });
      if (!id.startsWith("plugin:") || !selection) return [];
      const providerId = selection.providerId.startsWith("builtin:")
        ? migrateLegacyModelProviderId(selection.providerId)
        : selection.providerId;
      return [
        [
          id,
          providerId
            ? {
                ...selection,
                providerId,
                modelId: migrateLegacyOfficialGlmModelId(selection.providerId, selection.modelId),
              }
            : selection,
        ],
      ];
    }),
  );
}

/**
 * 仅存储迁移入口使用；正式 reader 不得再解释旧双 map 或旧 Provider。
 * 一次性导入边界（docs/specs/subagent-state-storage.md）：正式字段缺失才从遗留双 map
 * 翻译创建；字段存在即原样保留——不重建、不剔除、不校验落盘。读取路径的规范化
 * （schema 校验、未知名过滤）只属于读取方的内存投影，绝不作为整份重写的理由。
 */
export function importSubagentStateSelections(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...input };
  if (!Object.hasOwn(next, "builtInModelSelectionOverrides")) {
    next.builtInModelSelectionOverrides = importBuiltInSelectionsFromLegacy(input);
  }
  if (!Object.hasOwn(next, "pluginAgentModelSelectionOverrides")) {
    next.pluginAgentModelSelectionOverrides = importPluginSelectionsFromLegacy(input);
  }
  return next;
}
