export interface ResolveActiveTaskTitleParams {
  /** task meta 的标题（store + query cache + snapshot 三源合并结果）。 */
  metaTitle?: string | null;
  /** v4 sessions-index 的 summary 标题；与 membership 无关，覆盖置顶/归档会话。 */
  sessionsIndexTitle?: string | null;
  /** 是否拿到了 task meta 本身。占位文案要靠它区分 fork 与普通会话。 */
  hasMeta: boolean;
  forkedFromTaskId?: string | null;
  formatMessage: (descriptor: { id: string }) => string;
}

function firstNonBlankTitle(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate?.trim()) {
      // 返回原值而不是 trim 后的结果，避免把侧栏与 Header 之间引入标题文本差异。
      return candidate;
    }
  }
  return null;
}

/**
 * 工作区 Header 标题的取值权威：meta → sessions-index → 占位文案。
 *
 * meta 排在前面是因为重命名时新标题先落 tasks-index，再经 session_title_updated 异步回流到
 * session summary；让 sessions-index 优先会在改名的可见窗口内闪回旧标题。
 *
 * sessions-index 这一层是必须的：置顶/归档会话被 timeline 列表规则（!pinned && !archived）
 * 排除在 query cache 之外，legacy readSession 兜底又对冷会话必然报 Session is not active，
 * 没有这层它们会一起落空，Header 只能显示占位文案。
 */
export function resolveActiveTaskTitle(params: ResolveActiveTaskTitleParams): string {
  const resolvedTitle = firstNonBlankTitle(params.metaTitle, params.sessionsIndexTitle);
  if (resolvedTitle) {
    return resolvedTitle;
  }

  return params.formatMessage({
    id:
      params.hasMeta && params.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.newThread",
  });
}
