export type CommandCenterSearchScope = "all" | "commands" | "conversations" | "files";

export interface CommandCenterSearchHistoryEntry {
  query: string;
  scope: CommandCenterSearchScope;
  updatedAt: number;
}

const COMMAND_CENTER_HISTORY_LIMIT = 20;
const COMMAND_CENTER_HISTORY_KEY_PREFIX = "zcode-command-center-search-history:";

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getHistoryKey(workspaceKey: string): string {
  return `${COMMAND_CENTER_HISTORY_KEY_PREFIX}${workspaceKey}`;
}

function isCommandCenterSearchHistoryEntry(
  value: unknown,
): value is CommandCenterSearchHistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<CommandCenterSearchHistoryEntry>;
  return (
    typeof entry.query === "string" &&
    typeof entry.updatedAt === "number" &&
    (entry.scope === "all" ||
      entry.scope === "commands" ||
      entry.scope === "conversations" ||
      entry.scope === "files")
  );
}

export function readCommandCenterSearchHistory(
  workspaceKey: string,
): CommandCenterSearchHistoryEntry[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    const parsed = JSON.parse(storage.getItem(getHistoryKey(workspaceKey)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(isCommandCenterSearchHistoryEntry).slice(0, COMMAND_CENTER_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeCommandCenterSearchHistory(
  workspaceKey: string,
  entries: CommandCenterSearchHistoryEntry[],
) {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(
      getHistoryKey(workspaceKey),
      JSON.stringify(entries.slice(0, COMMAND_CENTER_HISTORY_LIMIT)),
    );
  } catch {
    // 搜索历史只是快捷入口，localStorage 不可用时不应阻断命令中心主流程。
  }
}

export function pushCommandCenterSearchHistory(params: {
  workspaceKey: string;
  query: string;
  scope: CommandCenterSearchScope;
}): CommandCenterSearchHistoryEntry[] {
  const query = params.query.trim();
  if (!query || query === ">" || query === "#" || query === "@") {
    return readCommandCenterSearchHistory(params.workspaceKey);
  }

  const nextEntry: CommandCenterSearchHistoryEntry = {
    query,
    scope: params.scope,
    updatedAt: Date.now(),
  };
  const dedupeKey = query.toLocaleLowerCase();
  const entries = [
    nextEntry,
    ...readCommandCenterSearchHistory(params.workspaceKey).filter(
      (entry) => entry.query.toLocaleLowerCase() !== dedupeKey,
    ),
  ].slice(0, COMMAND_CENTER_HISTORY_LIMIT);
  writeCommandCenterSearchHistory(params.workspaceKey, entries);
  return entries;
}

export function clearCommandCenterSearchHistory(workspaceKey: string) {
  writeCommandCenterSearchHistory(workspaceKey, []);
}

// 「包含已归档」开关的持久化：与搜索历史分 key，按 workspaceKey 隔离。
// 与「仅标题」刻意不同——仅标题是单次查询偏好（弹窗关闭即重置），
// 包含已归档是搜索习惯，一旦用户开启就跨弹窗记住（specs/command-center-search.md）。
const COMMAND_CENTER_INCLUDE_ARCHIVED_KEY_PREFIX = "zcode-command-center-include-archived:";

function getIncludeArchivedKey(workspaceKey: string): string {
  return `${COMMAND_CENTER_INCLUDE_ARCHIVED_KEY_PREFIX}${workspaceKey}`;
}

export function readCommandCenterIncludeArchived(workspaceKey: string): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }

  try {
    return storage.getItem(getIncludeArchivedKey(workspaceKey)) === "true";
  } catch {
    return false;
  }
}

export function writeCommandCenterIncludeArchived(workspaceKey: string, value: boolean) {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(getIncludeArchivedKey(workspaceKey), value ? "true" : "false");
  } catch {
    // 与搜索历史同款容错：localStorage 不可用时不阻断命令中心主流程。
  }
}
