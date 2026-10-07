import type { ZCodeTaskMeta } from "@zcode/shared";

export type TaskSearchResultItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
  // 结果项是否已归档（ZCodeTaskListItem.archived 投影），供行内渲染归档徽标。
  archived?: boolean;
};

export type TaskSearchResultRow = {
  key: string;
  task: TaskSearchResultItem;
  searchSnippet?: string;
  snippetIndex?: number;
  // 除行内展示的首条片段外，剩余去重后的命中片段数；0 表示无更多片段。
  extraSnippetCount: number;
};

function normalizeSnippetForDedupe(snippet: string): string {
  return snippet
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function getUniqueTaskSearchSnippets(task: TaskSearchResultItem): string[] {
  const snippets = task.searchSnippets?.length
    ? task.searchSnippets
    : task.searchSnippet
      ? [task.searchSnippet]
      : [];
  const seen = new Set<string>();
  const uniqueSnippets: string[] = [];
  for (const snippet of snippets) {
    const normalized = normalizeSnippetForDedupe(snippet);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueSnippets.push(snippet);
  }

  return uniqueSnippets;
}

/**
 * 会话搜索结果行模型（spec: specs/command-center-search.md「结果展示」）。
 * 一个任务一行：同一任务的多个命中片段合并展示首条，剩余数量交给 extraSnippetCount，
 * 避免「全部」范围的 3 行预览被单个会话的多条片段占满。
 */
export function buildTaskResultRows(params: {
  tasks: readonly TaskSearchResultItem[];
  query: string;
}): TaskSearchResultRow[] {
  // 先按 taskKey 去重合并：同一任务的重复条目（多 source 投影）片段取并集。
  const taskByKey = new Map<string, TaskSearchResultItem>();

  for (const task of params.tasks) {
    const taskKey = `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`;
    const existingTask = taskByKey.get(taskKey);
    if (!existingTask) {
      taskByKey.set(taskKey, task);
      continue;
    }

    taskByKey.set(taskKey, {
      ...existingTask,
      searchSnippets: [
        ...getUniqueTaskSearchSnippets(existingTask),
        ...getUniqueTaskSearchSnippets(task),
      ],
    });
  }

  const rows: TaskSearchResultRow[] = [];
  for (const [taskKey, task] of taskByKey) {
    const snippets = params.query ? getUniqueTaskSearchSnippets(task) : [];
    if (snippets.length === 0) {
      rows.push({ key: taskKey, task, extraSnippetCount: 0 });
      continue;
    }

    // 点击跳转以片段文本优先定位，snippetIndex: 0 仅在片段文本失配时兜底到首个命中。
    rows.push({
      key: taskKey,
      task,
      searchSnippet: snippets[0],
      snippetIndex: 0,
      extraSnippetCount: snippets.length - 1,
    });
  }

  return rows;
}
