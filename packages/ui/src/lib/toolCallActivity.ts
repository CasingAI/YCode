import { normalizeZCodeToolName } from "@zcode/shared";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { readToolMetadata } from "@/lib/readToolMetadata.js";

export type ToolCallActivity =
  | "file-search"
  | "file-find"
  | "directory-list"
  | "file-read"
  | "web-search"
  | "web-read"
  | "unknown";

export interface ToolCallActivityInput {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  raw?: unknown;
  output?: unknown;
  status?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolCallActivityRunning(toolCall: ToolCallActivityInput): boolean {
  if (toolCall.status != null) {
    return toolCall.status === "in_progress" || toolCall.status === "running";
  }
  return isRecord(toolCall.raw) && toolCall.raw.v4Status === "running";
}

export function classifyToolCallActivity({
  toolName,
  kind,
  input,
  raw,
  output,
}: ToolCallActivityInput): ToolCallActivity {
  // 标题和 URL 都可能来自用户输入，不得用展示文本推断工具访问的是网页还是文件。
  const identity = resolveToolCallIdentity({ toolName, kind, input, raw });
  switch (normalizeZCodeToolName(identity.toolName)) {
    case "Grep":
      return "file-search";
    case "Glob":
      return "file-find";
    case "WebSearch":
    case "web_search":
      return "web-search";
    case "WebFetch":
      return "web-read";
    case "Read":
      return readToolMetadata(input, raw, output).entryType === "directory"
        ? "directory-list"
        : "file-read";
  }
  if (identity.source !== "legacy-kind") return "unknown";
  if (identity.family === "file-read") {
    return readToolMetadata(input, raw, output).entryType === "directory"
      ? "directory-list"
      : "file-read";
  }
  if (identity.family === "search" && isRecord(input) && typeof input.type === "string") {
    const type = input.type.trim();
    if (/^web[-_ ]?search$/i.test(type)) return "web-search";
    if (/^web[-_ ]?fetch$/i.test(type)) return "web-read";
    if (/^(?:glob|file[-_ ]?find)$/i.test(type)) return "file-find";
    if (/^(?:grep|file[-_ ]?search)$/i.test(type)) return "file-search";
    if (/^(?:list_files|directory|dir|folder)$/i.test(type)) return "directory-list";
  }
  return "unknown";
}

export function getToolCallActivityTarget(
  toolCall: ToolCallActivityInput,
  activity: ToolCallActivity = classifyToolCallActivity(toolCall),
): string | null {
  const { input } = toolCall;
  if (activity === "file-read" || activity === "directory-list") {
    return readToolMetadata(input, toolCall.raw, toolCall.output).path ?? null;
  }
  if (typeof input === "string") return input.trim() || null;
  if (!isRecord(input)) return null;
  const keys =
    activity === "web-read"
      ? ["url"]
      : activity === "web-search"
        ? ["query", "search_query", "searchQuery", "prompt"]
        : activity === "file-find" || activity === "file-search"
          ? ["pattern", "query", "path"]
          : [
              "query",
              "search_query",
              "searchQuery",
              "pattern",
              "path",
              "filePath",
              "file_path",
              "url",
              "prompt",
              "target",
              "name",
            ];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
