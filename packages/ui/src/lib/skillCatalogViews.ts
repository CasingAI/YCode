import type { Locale } from "@zcode/shared";
import type { ConversationStoreStatus } from "@/v4/conversationProjectionStore.js";
import {
  buildSkillDisplayNameCatalog,
  type SkillDisplayNameCandidate,
} from "./skillDisplayName.js";
import { filterSkillsForProvider } from "./skillSourceFilter.js";

/** 会话技能目录条目；`id` 只参与来源过滤，不进入展示。 */
export interface SessionSkillCatalogEntry extends SkillDisplayNameCandidate {
  id?: string;
}

/**
 * SessionPane 从**同一个** `useSkills` 实例派生的两个只读视图（skill-title.md）。
 *
 * `skillDisplayNameByRef` 是三态：undefined 表示目录未就绪/失败/只读不可用，
 * 调用方必须显示中性占位；空表只在 `ready=true` 时出现，代表 authoritative 目录
 * 确认没有可用技能。`knownSkillNames` 共用同一份过滤结果，避免每个视图各发一次
 * `getSkillReferenceCatalog`。
 */
export interface SessionSkillCatalogViews {
  knownSkillNames: ReadonlySet<string> | undefined;
  skillDisplayNameByRef: ReadonlyMap<string, string> | undefined;
}

const UNAVAILABLE_VIEWS: SessionSkillCatalogViews = {
  knownSkillNames: undefined,
  skillDisplayNameByRef: undefined,
};

/**
 * 会话技能目录的启用门槛（skill-title.md）：`getSkillReferenceCatalog` 直接
 * `requireSession`、不负责冷恢复，conversation subscribe ACK 前 runtime 里还没有会话。
 *
 * 只在当前 lease 已 live 且它仍对应当前 session 时启用；切换会话后的过渡帧里旧 lease
 * 可能仍是 live，必须用 `leaseSessionId` 排除。这里只做只读派生，不持有或复制 lease，
 * 也不做定时重试/workspace 回退；subscribe 失败时保持未启用。
 */
export function isSessionSkillCatalogEnabled(options: {
  sessionScopeReady: boolean;
  sessionId: string | null;
  conversationStatus: ConversationStoreStatus;
  leaseSessionId: string | null;
}): boolean {
  return (
    options.sessionScopeReady &&
    Boolean(options.sessionId) &&
    options.conversationStatus === "live" &&
    options.leaseSessionId === options.sessionId
  );
}

export function deriveSessionSkillCatalogViews(options: {
  enabled: boolean;
  ready: boolean;
  skills: readonly SessionSkillCatalogEntry[];
  locale?: Locale;
}): SessionSkillCatalogViews {
  // 只读视图、请求未完成或失败都不产生派生表：错误不能被当作“空目录”，
  // 否则卡片会把原始 ref 当成 authoritative 未命中而提前露出。
  if (!options.enabled || !options.ready) {
    return UNAVAILABLE_VIEWS;
  }
  const skills = filterSkillsForProvider([...options.skills], "glm");
  const knownSkillNames = new Set<string>();
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    if (key) {
      knownSkillNames.add(key);
    }
  }
  return {
    knownSkillNames,
    skillDisplayNameByRef: buildSkillDisplayNameCatalog(skills, options.locale),
  };
}
