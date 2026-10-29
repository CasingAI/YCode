import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  buildWorkspaceFileSearchIgnoreMatcher,
  buildWorkspaceFileSearchIgnoreTemplate,
  isWorkspaceFileSearchPathIgnored,
  resetWorkspaceFileSearchIgnoreDefaults,
  syncWorkspaceFileSearchIgnoreFromGitignore,
  type WorkspaceFileSearchIgnoreMatcher,
} from "@zcode/shared/workspaceFileIgnore";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * workspace 文件忽略规则的文件生命周期与日志。
 *
 * `.zcodeignore`（workspace root，gitignore 语法）是规则文件的唯一真相源：
 * 首次需要规则而文件不存在时自动创建，内容为 root `.gitignore` 的拷贝（无则默认模板）；
 * 之后 `.gitignore` 的变化不再影响搜索，用户通过设置页编辑或「从 .gitignore 重新同步」。
 * 本模块负责自动创建、读取、原子保存、fail-open 降级与日志；规则构建、转换及匹配由 shared 纯函数提供。
 */

export { WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME, isWorkspaceFileSearchPathIgnored };

const GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "info" | "warn">;

type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

interface WorkspaceFileSearchIgnoreRules {
  matcher: WorkspaceFileSearchIgnoreMatcher;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file：.zcodeignore 已存在；template：尚未创建，content 是保存后将落盘的初始内容预览。 */
  source: "file" | "template";
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * 原子写：目标目录内写临时文件（flush + close）后 rename 替换，参照
 * workspace-hook-mutation.ts 的模式，保证 Runtime/设置页不会观察到半截规则文件。
 */
async function atomicWriteIgnoreFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const tempPath = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 扫描前加载 `.zcodeignore` 规则；含自动创建与 fail-open 降级链：
 * 文件不存在 → 原子创建（.gitignore 拷贝 / 默认模板）；
 * 创建或读取失败（只读 fs、权限）→ 内存使用 .gitignore 内容 → 再失败用内置默认规则。
 * 任何降级只 warn 一次，绝不让 @ 面板因规则文件不可用而扫描失败。
 */
export async function loadWorkspaceFileSearchIgnoreRules(
  rootPath: string,
  logger?: WorkspaceFileIgnoreLogger,
): Promise<WorkspaceFileSearchIgnoreRules> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);

  const degradeToInMemory = async (
    reason: string,
    error: unknown,
  ): Promise<WorkspaceFileSearchIgnoreRules> => {
    const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
      () => null,
    );
    if (gitignoreContent !== null) {
      logger?.warn(
        undefined,
        `[workspace-file-ignore] ${reason}，降级为运行时使用 .gitignore 规则`,
        error,
      );
      return {
        matcher: buildWorkspaceFileSearchIgnoreMatcher(gitignoreContent),
        source: "fallback-gitignore",
      };
    }
    logger?.warn(undefined, `[workspace-file-ignore] ${reason}，降级为内置默认忽略规则`, error);
    const template = buildWorkspaceFileSearchIgnoreTemplate(null);
    return {
      matcher: buildWorkspaceFileSearchIgnoreMatcher(template),
      source: "fallback-builtin",
    };
  };

  let existing: string | null;
  try {
    existing = await readOptionalFile(ignorePath);
  } catch (error) {
    return degradeToInMemory(`读取 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败`, error);
  }
  if (existing !== null) {
    return { matcher: buildWorkspaceFileSearchIgnoreMatcher(existing), source: "file" };
  }

  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const initialContent = buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  try {
    await atomicWriteIgnoreFile(ignorePath, initialContent);
  } catch (error) {
    // 创建失败不影响扫描：初始内容确定性已知，内存中直接按初始内容执行，
    // 来源标记沿用初始内容来源（.gitignore 拷贝 / 内置模板）表达 fail-open 降级。
    logger?.warn(
      undefined,
      `[workspace-file-ignore] 自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败，降级为运行时使用${
        gitignoreContent !== null ? ".gitignore" : "内置默认"
      }规则`,
      error,
    );
    return {
      matcher: buildWorkspaceFileSearchIgnoreMatcher(initialContent),
      source: gitignoreContent !== null ? "fallback-gitignore" : "fallback-builtin",
    };
  }
  logger?.info(
    undefined,
    `[workspace-file-ignore] 已自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}（来源：${
      gitignoreContent !== null ? ".gitignore 拷贝" : "默认模板"
    }）`,
  );
  return {
    matcher: buildWorkspaceFileSearchIgnoreMatcher(initialContent),
    source: gitignoreContent !== null ? "created-from-gitignore" : "created-from-template",
  };
}

/** 设置页读取：文件不存在时返回初始内容预览（source: template），不落盘。 */
export async function readWorkspaceFileSearchIgnore(
  rootPath: string,
): Promise<WorkspaceFileSearchIgnoreContent> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath);
  if (existing !== null) {
    return { content: existing, source: "file" };
  }
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  return {
    content: buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent),
    source: "template",
  };
}

type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
 * sync-gitignore 只重写 gitignore 同步区；reset-defaults 只重置默认排除段；
 * 两者都保留标记之外的用户内容，详见 shared 纯函数的契约。
 */
export async function transformWorkspaceFileSearchIgnore(
  rootPath: string,
  transform: WorkspaceFileSearchIgnoreTransform,
): Promise<{ content: string }> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath).catch(() => null);
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const currentContent = existing ?? buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  const content =
    transform === "sync-gitignore"
      ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, gitignoreContent)
      : resetWorkspaceFileSearchIgnoreDefaults(currentContent, gitignoreContent);
  return { content };
}

/** 设置页保存：原子写整个文件，下次扫描读取即为新内容。 */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}
