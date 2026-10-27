import { useMemo } from "react";
import { useSkills } from "@/hooks/useSkills.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { buildSkillDisplayNameCatalog } from "@/lib/skillDisplayName.js";

/**
 * 会话技能名白名单（小写集合），供消息气泡判定裸 `$name` 是否可以画成技能芯片。
 *
 * 气泡的分词器此前只看 `INLINE_MENTION_TOKEN_PATTERN`，不看技能目录，于是 `cost is
 * $100 today` 里的金额也会被染成技能芯片。这里给出当前会话真实可用的技能名，
 * 未命中的裸 token 按普通文本原样显示。
 *
 * 两条约束决定了这里的过滤口径：
 *
 * 1. 必须复用 `filterSkillsForProvider`：`$` 面板（`useSkillsMentionProvider`）也走这个
 *    过滤，非 ZCode 来源的技能面板里根本选不到。白名单若比面板宽，就会出现「气泡染色了
 *    但面板里选不到」的不一致。
 * 2. 名字比较统一小写：目录项 `name` 是用户可写的展示名，可能含大写；`$` 面板的同名
 *    折叠（`mapSkillsToMentionItemsForTest`）用的也是小写 key。
 *
 * 目录未就绪或拉取失败时返回 `undefined`，调用方据此退回修复前的显示：宁可暂时多染色，
 * 也不能让真实技能芯片整批消失。
 *
 * 只能在列表/会话级调用一次。逐条消息挂 `useSkills` 会按消息数放大 RPC——该接口
 * （`getSkillReferenceCatalog`）没有缓存层，每次都是真实请求。
 */
export function useSkillNameWhitelist(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
}): ReadonlySet<string> | undefined {
  const { skills, loading, error } = useSkills({
    workspacePath: options.workspacePath,
    workspaceIdentity: options.workspaceIdentity,
    sessionId: options.sessionId,
    enabled: options.enabled,
  });

  return useMemo(() => {
    // loading 期间 skills 为空，此时返回 undefined 而非空集：空集会把所有裸 `$name`
    // 判成未知技能，目录到达后集体变芯片，出现可见的闪烁与误判。
    if (!options.enabled || loading || error) return undefined;
    const names = new Set<string>();
    for (const skill of filterSkillsForProvider(skills, "glm")) {
      const key = skill.name.trim().toLowerCase();
      if (key) names.add(key);
    }
    return names;
  }, [error, loading, options.enabled, skills]);
}

/**
 * 会话级「技能引用 → 展示名」查找表（skill-title.md）：
 * 键为 `name` 与 `plugin:name`（精确与小写两种形态），值为本地化标题/frontmatter title。
 *
 * 与 `useSkillNameWhitelist` 同源同约束：复用 `filterSkillsForProvider` 口径、
 * 只能在 pane 级调用一次（`getSkillReferenceCatalog` 无缓存层）、目录未就绪时返回
 * undefined 让 Skill 卡片回退原始输入，不得让卡片报错或闪烁。
 */
export function useSkillDisplayNameCatalog(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
}): ReadonlyMap<string, string> | undefined {
  const { locale } = useZCodeIntl();
  const { skills, loading, error } = useSkills({
    workspacePath: options.workspacePath,
    workspaceIdentity: options.workspaceIdentity,
    sessionId: options.sessionId,
    enabled: options.enabled,
  });

  return useMemo(() => {
    if (!options.enabled || loading || error) return undefined;
    return buildSkillDisplayNameCatalog(filterSkillsForProvider(skills, "glm"), locale);
  }, [error, loading, locale, options.enabled, skills]);
}
