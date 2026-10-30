import type { Locale, SkillScope } from "@zcode/shared";
import { resolveBuiltinSkillTitle } from "./builtinSkillI18n.js";

/** 展示名解析需要的最小技能字段；SkillSummary 满足该结构。 */
export interface SkillDisplayNameCandidate {
  name: string;
  title?: string;
  description: string;
  path: string;
  scope: SkillScope;
  pluginName?: string;
}

function resolveTitleForSkill(
  skill: SkillDisplayNameCandidate,
  locale?: Locale,
): string | undefined {
  // 内置技能先走本地化标题；frontmatter title 单语言，作为其余技能的显示名来源。
  return resolveBuiltinSkillTitle(skill, locale) ?? skill.title?.trim() ?? undefined;
}

/**
 * 技能列表行 / mention 菜单共用的展示标签：本地化标题 > title > name。
 * 返回的标签只用于展示；mention markdown 与技能匹配始终使用 name。
 */
export function resolveSkillListLabel(skill: SkillDisplayNameCandidate, locale?: Locale): string {
  return resolveTitleForSkill(skill, locale) ?? skill.name;
}

/**
 * 由会话技能目录构建「引用 → 展示名」查找表（skill-title.md）。
 * 键同时收录精确形态与折叠小写形态：Skill 工具输入是精确的 `plugin:skill`/`name`，
 * 但目录里的 name 是用户可写的展示名，可能含大写（与 useSessionSkillCatalogViews 的口径一致）。
 *
 * 目录未就绪时调用方应传 undefined 表示「不可用」；卡片主标题必须再经
 * `resolveSkillCardPrimaryLabel` 区分未就绪与 authoritative 未命中，不能把 undefined
 * 当成空表。
 */
export function buildSkillDisplayNameCatalog(
  skills: readonly SkillDisplayNameCandidate[],
  locale?: Locale,
): ReadonlyMap<string, string> {
  const catalog = new Map<string, string>();
  for (const skill of skills) {
    const label = resolveTitleForSkill(skill, locale) ?? skill.name;
    const refs = new Set([skill.name]);
    if (skill.pluginName) {
      refs.add(`${skill.pluginName}:${skill.name}`);
    }
    for (const ref of refs) {
      catalog.set(ref, label);
      catalog.set(ref.toLowerCase(), label);
    }
  }
  return catalog;
}

/**
 * 解析 Skill 卡片输入的展示标签：查表命中返回展示名，未命中原样返回输入。
 * 历史会话里已禁用/卸载的技能查不到是正常态，调用方不得据此报错（skill-title.md）。
 */
export function resolveSkillDisplayName(
  rawSkillRef: string,
  catalog: ReadonlyMap<string, string> | undefined,
): string {
  if (!catalog) {
    return rawSkillRef;
  }
  const ref = rawSkillRef.trim();
  return catalog.get(ref) ?? catalog.get(ref.toLowerCase()) ?? rawSkillRef;
}

/**
 * Skill 卡片主标题（skill-title.md）：目录未就绪、请求失败或只读不可用时返回
 * undefined，让卡片显示中性占位；只有已完成的 authoritative 目录（包括空表）未命中
 * 才回退原始 ref。不能直接复用 `resolveSkillDisplayName` 的 undefined 分支，否则冷首帧
 * 会先露出机器标识再替换成友好名。
 */
export function resolveSkillCardPrimaryLabel(
  rawSkillRef: string,
  catalog: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!catalog) {
    return undefined;
  }
  return resolveSkillDisplayName(rawSkillRef, catalog);
}
