import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  buildWorkspaceFileSearchIgnoreMatcher,
  buildWorkspaceFileSearchIgnoreTemplate,
  isWorkspaceFileSearchPathIgnored,
  type WorkspaceFileSearchIgnoreMatcher,
} from "@zcode/shared/workspaceFileIgnore";
import { isFileSystemPortError } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const GITIGNORE_FILE_NAME = ".gitignore";

/**
 * 一次文件撤销计划使用的规则快照。规则加载失败时携带错误信息，由调用方
 * 阻塞本次计划；调用方不得把失败当成空规则继续覆盖。
 */
export type WorkspaceFileRewindIgnoreRules =
  | { matcher: WorkspaceFileSearchIgnoreMatcher }
  | { error: { message: string; path: string } };

function isAbortError(error: unknown, abortSignal: AbortSignal | undefined): boolean {
  if (abortSignal?.aborted) return true;
  if (isFileSystemPortError(error) && error.code === "cancelled") return true;
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

async function readRuleFile(
  this: AgentRuntimeInternal,
  path: string,
  traceContext: TraceContext,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const read = await this.fileSystemPort!.readTextFile(
    { path, trace: traceContext },
    { signal: abortSignal },
  );
  return read.content;
}

/**
 * 只读加载当前 `.zcodeignore`：已存在则直接使用；不存在时按文件服务首次创建
 * 的同一模板（根 `.gitignore` 内容 + 内置默认段）在内存中构建，绝不落盘。
 * 已存在但读取失败时返回错误，由调用方阻塞；取消信号原样向上传播。
 */
export async function loadWorkspaceFileRewindIgnoreRules(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  abortSignal: AbortSignal | undefined,
): Promise<WorkspaceFileRewindIgnoreRules> {
  const ignorePath = resolve(this.workspaceRoot, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  let content: string;
  try {
    content = await readRuleFile.call(this, ignorePath, traceContext, abortSignal);
  } catch (error) {
    if (isAbortError(error, abortSignal)) throw error;
    if (!(isFileSystemPortError(error) && error.code === "not_found")) {
      return {
        error: {
          message: `Failed to read ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          path: ignorePath,
        },
      };
    }
    // 缺失规则文件：根 .gitignore 仅作为初始模板来源；不可用时退回内置模板。
    let gitignoreContent: string | null = null;
    try {
      gitignoreContent = await readRuleFile.call(
        this,
        resolve(this.workspaceRoot, GITIGNORE_FILE_NAME),
        traceContext,
        abortSignal,
      );
    } catch (gitignoreError) {
      if (isAbortError(gitignoreError, abortSignal)) throw gitignoreError;
      gitignoreContent = null;
    }
    content = buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  return { matcher: buildWorkspaceFileSearchIgnoreMatcher(content) };
}

/**
 * 相对路径归一：只有严格位于工作区内的绝对路径才进入规则匹配。
 * 工作区外（含跨盘符返回的绝对 relative）保持原样，避免规则误伤。
 */
function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string | null {
  const relativePath = relative(resolve(workspaceRoot), absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    isAbsolute(relativePath) ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return null;
  }
  return relativePath.split(sep).join("/");
}

export function isWorkspaceFileRewindPathIgnored(
  rules: WorkspaceFileRewindIgnoreRules,
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  if ("error" in rules) return false;
  const relativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
  if (relativePath === null) return false;
  return isWorkspaceFileSearchPathIgnored({ matcher: rules.matcher }, relativePath, "file");
}
