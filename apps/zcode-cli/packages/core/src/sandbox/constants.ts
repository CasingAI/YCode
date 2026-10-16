import { join } from "node:path";

/** 每会话 LocalStorage 上限 5MB；超了这次写入抛配额错，旧数据不动。 */
export const SANDBOX_LOCAL_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;
/** 活实例堆内存硬顶 128MB（不含 LocalStorage）；超了销毁整份实例。 */
export const SANDBOX_HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
/** 沙盒 fs.promises.readFile 单文件上限；超限失败不截断。 */
export const SANDBOX_FS_READ_MAX_BYTES = 16 * 1024 * 1024;
/** 沙盒 SQLite 单次查询超时；超时靠 abort 信号进车道，车道 terminate worker 兜底。 */
export const SANDBOX_SQLITE_QUERY_TIMEOUT_MS = 10_000;
/** 沙盒 SQLite 单次查询行数上限；超限失败不截断（沿用 FS 读超限失败的惯例）。 */
export const SANDBOX_SQLITE_MAX_ROWS = 10_000;
/** 沙盒 SQLite 单次查询结果体积上限（行估算字节和）；超限失败不截断。 */
export const SANDBOX_SQLITE_MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** console 环形缓冲上限（行数）；超了丢最旧的行。 */
export const SANDBOX_CONSOLE_RING_MAX_LINES = 2_000;
/** 单条 console 行文本上限（字节）；超了就地截断。 */
export const SANDBOX_CONSOLE_LINE_MAX_BYTES = 8 * 1024;

/** LocalStorage 落盘文件名（每会话目录下一文件）。 */
export const SANDBOX_LOCAL_STORAGE_FILE_NAME = "local-storage.json";

/**
 * 会话沙盒目录：`<sandboxStorageRoot>/sandbox/<sanitize(sessionId)>/`。
 * 沙盒 LocalStorage 使用独立的 YCode 数据根，不与项目记忆的 ZCode 存储根共用。
 * 存储目录规则按此相对前缀聚合为单独类别。
 */
export function resolveSessionSandboxDir(input: {
  sandboxStorageRoot: string;
  sessionId: string;
}): string {
  return join(input.sandboxStorageRoot, "sandbox", sanitizeSandboxPathSegment(input.sessionId));
}

/** LocalStorage 落盘文件路径（目录 + 固定文件名）。 */
export function resolveSandboxLocalStoragePath(input: {
  sandboxStorageRoot: string;
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
