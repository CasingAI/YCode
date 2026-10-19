const DEEP_LINK_SCHEME = "zcode";
const DEEP_LINK_RE = /\bzcode:(?:\/\/|\/)?[^\s"'<>]+/i;
// 会话引用外部唤起：ycode://session/open?sessionId=<id>&search=<片段>。
// 与 zcode 并存，不替换现有四路路由；session id 放 query（path 段要处理
// 编码与斜杠，query 最稳），只收 sessionId 与 search 两个参数。
const SESSION_CITATION_SCHEME = "ycode";
const SESSION_CITATION_RE = /\bycode:(?:\/\/|\/)?[^\s"'<>]+/i;
const SESSION_OPEN_HOST = "session";
const SESSION_OPEN_ACTION_PATH = "/open";
const DEEP_LINK_ADDITIONAL_DATA_KEY = "deepLinkUrl";
const OPEN_WORKSPACE_ADDITIONAL_DATA_KEY = "openWorkspacePath";
const OPEN_FILE_PATHS_ADDITIONAL_DATA_KEY = "openFilePaths";
const OPEN_WORKSPACE_ARG = "--open-workspace";

function normalizeOAuthCallbackPath(pathname: string): string {
  const withoutTrailingSlash = pathname.replace(/\/+$/, "");
  const normalized = withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
  return `/${normalized.replace(/^\/+/, "")}`;
}

export function isOAuthCallbackUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return false;
  }

  const normalizedPath = normalizeOAuthCallbackPath(parsedUrl.pathname);
  if (OAUTH_CALLBACK_HOSTS.has(parsedUrl.hostname)) {
    return normalizedPath === "/callback";
  }

  if (parsedUrl.hostname) {
    return false;
  }

  const [, host, ...pathParts] = normalizedPath.split("/");
  return Boolean(
    host && OAUTH_CALLBACK_HOSTS.has(host) && `/${pathParts.join("/")}` === "/callback",
  );
}

export function isPaymentCallbackUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return false;
  }

  const normalizedPath = normalizeOAuthCallbackPath(parsedUrl.pathname);
  if (parsedUrl.hostname === PAYMENT_CALLBACK_HOST) {
    return normalizedPath === "/callback";
  }

  if (parsedUrl.hostname) {
    return false;
  }

  const [, host, ...pathParts] = normalizedPath.split("/");
  return Boolean(host === PAYMENT_CALLBACK_HOST && `/${pathParts.join("/")}` === "/callback");
}

export function isWorkspaceOpenUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return false;
  }

  const normalizedPath = normalizeOAuthCallbackPath(parsedUrl.pathname);
  if (parsedUrl.hostname === WORKSPACE_OPEN_HOST) {
    return normalizedPath === "/open";
  }

  if (parsedUrl.hostname) {
    return false;
  }

  const [, host, ...pathParts] = normalizedPath.split("/");
  return Boolean(host === WORKSPACE_OPEN_HOST && `/${pathParts.join("/")}` === "/open");
}

export function extractWorkspaceOpenPath(parsedUrl: URL): string | null {
  if (!isWorkspaceOpenUrl(parsedUrl)) {
    return null;
  }

  const path = parsedUrl.searchParams.get("path");
  return path && path.length > 0 ? path : null;
}

export function isShareImportUrl(parsedUrl: URL): boolean {
  return (
    parsedUrl.protocol === `${DEEP_LINK_SCHEME}:` &&
    parsedUrl.hostname === SHARE_IMPORT_HOST &&
    normalizeOAuthCallbackPath(parsedUrl.pathname) === "/import"
  );
}

export function extractShareImportCode(parsedUrl: URL): string | null {
  if (!isShareImportUrl(parsedUrl)) return null;
  const code = parsedUrl.searchParams.get("code")?.trim();
  return code && /^[A-Za-z0-9._~-]{1,512}$/u.test(code) ? code : null;
}

export interface SessionCitationOpenParams {
  sessionId: string;
  search: string;
}

/**
 * 会话引用外部唤起判定：`ycode://session/open?sessionId=<id>&search=…`。
 * 形态跟仓库现有深链约定对齐（host 为域、path 为动作）。sessionId 必填且
 * 严格校验格式（非空、无空白与 URL 分隔符）；search 可缺席。
 */
export function isSessionCitationOpenUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== `${SESSION_CITATION_SCHEME}:`) {
    return false;
  }
  if (parsedUrl.hostname !== SESSION_OPEN_HOST) {
    return false;
  }
  return normalizeOAuthCallbackPath(parsedUrl.pathname) === SESSION_OPEN_ACTION_PATH;
}

export function extractSessionCitationOpenParams(parsedUrl: URL): SessionCitationOpenParams | null {
  if (!isSessionCitationOpenUrl(parsedUrl)) return null;
  const sessionId = parsedUrl.searchParams.get("sessionId")?.trim() ?? "";
  // 伪造 sessionId 的外部链接直接忽略，不崩溃不跳转。
  if (!sessionId || /[\s/?#]/.test(sessionId)) return null;
  const search = parsedUrl.searchParams.get("search")?.trim() ?? "";
  return { sessionId, search };
}

function decodeDeepLinkCandidate(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? null : decoded;
  } catch {
    return null;
  }
}

function expandDecodedDeepLinkCandidates(value: string): string[] {
  const candidates = [value];
  let current = value;

  for (let index = 0; index < 3; index++) {
    const decoded = decodeDeepLinkCandidate(current);
    if (!decoded || candidates.includes(decoded)) {
      break;
    }

    candidates.push(decoded);
    current = decoded;
  }

  return candidates;
}

function buildArgCandidates(args: readonly string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    if (!seen.has(value)) {
      candidates.push(value);
      seen.add(value);
    }
  };

  for (const arg of args) {
    addCandidate(arg);
  }

  for (let start = 0; start < args.length; start++) {
    let joined = "";
    for (let end = start; end < Math.min(args.length, start + 5); end++) {
      joined += args[end] ?? "";
      if (end > start) {
        addCandidate(joined);
      }
    }
  }

  return candidates;
}

function extractFromCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  const match = trimmed.match(DEEP_LINK_RE) ?? trimmed.match(SESSION_CITATION_RE);
  return match?.[0].replace(/&amp;/gi, "&").replace(/\\([&=?:/])/g, "$1") ?? null;
}

function isCompleteDeepLinkUrl(value: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return false;
  }

  if (isOAuthCallbackUrl(parsedUrl)) {
    return parsedUrl.searchParams.has("state");
  }

  if (isPaymentCallbackUrl(parsedUrl)) {
    return (
      parsedUrl.searchParams.has("provider") &&
      parsedUrl.searchParams.has("channel") &&
      parsedUrl.searchParams.has("status")
    );
  }

  if (isWorkspaceOpenUrl(parsedUrl)) {
    return parsedUrl.searchParams.has("path");
  }

  if (isShareImportUrl(parsedUrl)) {
    return extractShareImportCode(parsedUrl) !== null;
  }

  if (isSessionCitationOpenUrl(parsedUrl)) {
    return extractSessionCitationOpenParams(parsedUrl) !== null;
  }

  return true;
}

export function extractDeepLinkUrlFromArgs(args: readonly string[]): string | null {
  let fallbackMatch: string | null = null;

  for (const arg of buildArgCandidates(args)) {
    for (const candidate of expandDecodedDeepLinkCandidates(arg)) {
      const match = extractFromCandidate(candidate);
      if (match) {
        // Debian/xdg 的协议回调可能被浏览器或桌面门户多次编码，
        // 也可能把 query 片段拆成相邻 argv。这里先生成有限候选再多轮解码，
        // 避免浏览器确认“打开 ZCode”后主进程拿不到完整回调 URL。
        if (isCompleteDeepLinkUrl(match)) {
          return match;
        }
        fallbackMatch ??= match;
      }
    }
  }

  return fallbackMatch;
}

function trimArgValue(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1);
  }

  if (/^[A-Za-z]:(?:\\.*)?["']$/.test(trimmed)) {
    // Windows Explorer 的 Drive\shell 菜单会把 C:\ 代入 "%1"。
    // 部分 argv 解析链会把末尾反斜杠和闭合引号折叠成尾引号，这里只修正盘符绝对路径。
    return `${trimmed.slice(0, -1)}\\`;
  }

  return trimmed;
}

export function extractOpenWorkspacePathFromArgs(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === OPEN_WORKSPACE_ARG) {
      const value = args[index + 1];
      const path = value ? trimArgValue(value) : "";
      if (path) {
        return path;
      }
      continue;
    }

    if (arg.startsWith(`${OPEN_WORKSPACE_ARG}=`)) {
      const path = trimArgValue(arg.slice(OPEN_WORKSPACE_ARG.length + 1));
      if (path) {
        return path;
      }
    }
  }

  return null;
}

function isAbsoluteLocalFileArgument(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Parse only the file arguments supplied by the OS; callers must omit the executable and dev entrypoint. */
export function extractOpenFilePathsFromArgs(args: readonly string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") continue;
    if (arg === OPEN_WORKSPACE_ARG) {
      index += 1;
      continue;
    }
    if (arg.startsWith(`${OPEN_WORKSPACE_ARG}=`) || arg.startsWith("-")) continue;
    const path = trimArgValue(arg);
    if (
      !isAbsoluteLocalFileArgument(path) ||
      path.includes("\0") ||
      /^(?:zcode|ycode):/i.test(path)
    ) {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function createDeepLinkSingleInstanceData(
  args: readonly string[],
  options: { isPackaged?: boolean } = {},
): Record<string, string> {
  const url = extractDeepLinkUrlFromArgs(args);
  const openWorkspacePath = extractOpenWorkspacePathFromArgs(args);
  // Packaged Electron receives [app, file...]; dev receives [electron, main.js, file...].
  const fileArgsStart = options.isPackaged ? 1 : 2;
  const openFilePaths = extractOpenFilePathsFromArgs(args.slice(fileArgsStart));
  return {
    ...(url ? { [DEEP_LINK_ADDITIONAL_DATA_KEY]: url } : {}),
    ...(openWorkspacePath ? { [OPEN_WORKSPACE_ADDITIONAL_DATA_KEY]: openWorkspacePath } : {}),
    ...(openFilePaths.length > 0
      ? { [OPEN_FILE_PATHS_ADDITIONAL_DATA_KEY]: JSON.stringify(openFilePaths) }
      : {}),
  };
}

export function extractDeepLinkUrlFromSingleInstanceData(additionalData: unknown): string | null {
  if (!additionalData || typeof additionalData !== "object") {
    return null;
  }

  const value = (additionalData as Record<string, unknown>)[DEEP_LINK_ADDITIONAL_DATA_KEY];
  if (typeof value !== "string") {
    return null;
  }

  return extractDeepLinkUrlFromArgs([value]);
}

export function extractOpenWorkspacePathFromSingleInstanceData(
  additionalData: unknown,
): string | null {
  if (!additionalData || typeof additionalData !== "object") {
    return null;
  }

  const value = (additionalData as Record<string, unknown>)[OPEN_WORKSPACE_ADDITIONAL_DATA_KEY];
  if (typeof value !== "string") {
    return null;
  }

  return extractOpenWorkspacePathFromArgs([`${OPEN_WORKSPACE_ARG}=${value}`]);
}

export function extractOpenFilePathsFromSingleInstanceData(additionalData: unknown): string[] {
  if (!additionalData || typeof additionalData !== "object") return [];
  const value = (additionalData as Record<string, unknown>)[OPEN_FILE_PATHS_ADDITIONAL_DATA_KEY];
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return [];
    return extractOpenFilePathsFromArgs(parsed);
  } catch {
    return [];
  }
}
