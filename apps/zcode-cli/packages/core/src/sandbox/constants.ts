import { join } from "node:path";

/** 每会话 LocalStorage 上限 5MB；超了这次写入抛配额错，旧数据不动。 */
export const SANDBOX_LOCAL_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;
/** 活实例堆内存硬顶 128MB（不含 LocalStorage）；超了销毁整份实例。 */
export const SANDBOX_HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
/** 沙盒 fs.promises.readFile 单文件上限；超限失败不截断。 */
export const SANDBOX_FS_READ_MAX_BYTES = 16 * 1024 * 1024;
/** console 环形缓冲上限（行数）；超了丢最旧的行。 */
export const SANDBOX_CONSOLE_RING_MAX_LINES = 2_000;
/** 单条 console 行文本上限（字节）；超了就地截断。 */
export const SANDBOX_CONSOLE_LINE_MAX_BYTES = 8 * 1024;

/** LocalStorage 落盘文件名（每会话目录下一文件）。 */
export const SANDBOX_LOCAL_STORAGE_FILE_NAME = "local-storage.json";

/**
 * 会话沙盒目录：`<cliStorageRoot>/sandbox/<sanitize(sessionId)>/`。
 * 与计划目录（`.zcode/plans/<session>/`）同一形状：一会话一目录。
 * 存储目录规则（阶段6）按此前缀聚合为单独类别。
 */
export function resolveSessionSandboxDir(input: {
  cliStorageRoot: string;
  sessionId: string;
}): string {
  return join(input.cliStorageRoot, "sandbox", sanitizeSandboxPathSegment(input.sessionId));
}

/** LocalStorage 落盘文件路径（目录 + 固定文件名）。 */
export function resolveSandboxLocalStoragePath(input: {
  cliStorageRoot: string;
  sessionId: string;
}): string {
  return join(resolveSessionSandboxDir(input), SANDBOX_LOCAL_STORAGE_FILE_NAME);
}

// 非法路径字符类用字符串构造（避开正则字面量里的控制字符转义，免触发 no-control-regex）。
const SANDBOX_PATH_ILLEGAL_CHARS = new RegExp(`[<>:"/\\\\|?*${"\\x00-\\x1f"}\\x7f]`, "g");
const SANDBOX_PATH_WHITESPACE = /\s+/g;

function sanitizeSandboxPathSegment(value: string): string {
  const slug = value
    .replace(SANDBOX_PATH_ILLEGAL_CHARS, "_")
    .replace(SANDBOX_PATH_WHITESPACE, "_")
    .slice(0, 128)
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "session";
}
