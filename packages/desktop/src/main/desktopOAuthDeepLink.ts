/* oxlint-disable eslint(max-lines) -- Deep Link 路由必须在同一模块内保持协议校验和投递原子性。 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import {
  type Locale,
  type OAuthProviderId,
  type OAuthStateRegistration,
  PlatformChannels,
} from "@zcode/shared";
import {
  extractWorkspaceOpenPath,
  extractShareImportCode,
  extractSessionCitationOpenParams,
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isWorkspaceOpenUrl,
  isShareImportUrl,
  isSessionCitationOpenUrl,
} from "./desktopDeepLinkUrl.js";
import { registerLinuxDeepLinkProtocol } from "./desktopLinuxDeepLinkRegistration.js";
import { runtimeApplicationName } from "./desktopRuntimeEnv.js";

interface DeepLinkWorkspaceGateOptions {
  canOpenWorkspace?: (workspacePath: string) => boolean;
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  onWorkspaceOpenBlocked?: (workspacePath: string) => void;
  /** 业务窗口解析器；必须排除 CUA indicator 等 Main 辅助窗口。 */
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export interface ExternalWorkspaceOpenDialogCopy {
  buttons: [string, string];
  title: string;
  message: string;
  detail: (path: string) => string;
}

interface OAuthRouteTarget {
  windowId: number;
  provider?: OAuthProviderId;
}

const oauthStateToWindow = new Map<string, OAuthRouteTarget>();
const rendererReadyWebContentsIds = new Set<number>();
let pendingDeepLinkUrl: string | null = null;
let pendingPaymentDeepLinkUrl: string | null = null;
let pendingOpenWorkspaceRequest: {
  path: string;
  targetWebContentsId?: number;
} | null = null;
const pendingOpenFilePaths: Array<{ path: string; targetWebContentsId?: number }> = [];
const pendingShareImports: { shareCode: string; targetWebContentsId?: number }[] = [];
const MAX_PENDING_SHARE_IMPORTS = 8;
// 会话引用外部唤起 pending：与 share import 同纪律（绑定目标窗口、随窗口关闭清理）。
const pendingSessionCitationOpens: {
  sessionId: string;
  search: string;
  targetWebContentsId?: number;
}[] = [];
const MAX_PENDING_SESSION_CITATION_OPENS = 8;

function enqueuePendingShareImport(
  payload: { shareCode: string },
  targetWebContentsId?: number,
): void {
  if (
    pendingShareImports.some(
      (item) =>
        item.shareCode === payload.shareCode && item.targetWebContentsId === targetWebContentsId,
    )
  ) {
    return;
  }
  pendingShareImports.push(
    targetWebContentsId === undefined ? { ...payload } : { ...payload, targetWebContentsId },
  );
  if (pendingShareImports.length > MAX_PENDING_SHARE_IMPORTS) {
    pendingShareImports.shift();
  }
}

function enqueuePendingSessionCitationOpen(
  payload: { sessionId: string; search: string },
  targetWebContentsId?: number,
): void {
  if (
    pendingSessionCitationOpens.some(
      (item) =>
        item.sessionId === payload.sessionId &&
        item.search === payload.search &&
        item.targetWebContentsId === targetWebContentsId,
    )
  ) {
    return;
  }
  pendingSessionCitationOpens.push(
    targetWebContentsId === undefined ? { ...payload } : { ...payload, targetWebContentsId },
  );
  if (pendingSessionCitationOpens.length > MAX_PENDING_SESSION_CITATION_OPENS) {
    pendingSessionCitationOpens.shift();
  }
}

export function parseOAuthStateRegistration(payload: unknown): OAuthStateRegistration | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    state?: unknown;
    provider?: unknown;
  };

  if (typeof candidate.state !== "string" || candidate.state.trim() === "") {
    return null;
  }

  if (candidate.provider != null && typeof candidate.provider !== "string") {
    return null;
  }

  return {
    state: candidate.state.trim(),
    ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
  };
}

function focusDeepLinkTargetWindow(targetWindow: BrowserWindow): void {
  // macOS 的 open-url 回调只会把 URL 投递给当前实例，不会自动把窗口带回前台。
  // 之前这里只做了 IPC 转发，用户完成 OAuth 或从系统服务打开目录后仍停留在外部应用。
  // 这里在路由成功后显式激活并聚焦目标窗口，统一多平台回跳体验。
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (process.platform === "darwin") {
    app.show();
  }

  targetWindow.focus();
}

function hasOAuthAuthorizationCode(parsedUrl: URL): boolean {
  return parsedUrl.searchParams.has("code") || parsedUrl.searchParams.has("authCode");
}

export function isValidLocalWorkspaceDirectory(path: string): boolean {
  if (!path || path.includes("\0") || isNetworkWorkspacePath(path) || !isAbsolute(path)) {
    return false;
  }

  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isValidLocalOpenFilePath(path: string): boolean {
  if (!path || path.includes("\0") || isNetworkWorkspacePath(path) || !isAbsolute(path)) {
    return false;
  }
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function enqueuePendingOpenFilePath(path: string, targetWebContentsId?: number): void {
  const existing = pendingOpenFilePaths.find((item) => item.path === path);
  if (existing) {
    if (existing.targetWebContentsId === undefined && targetWebContentsId !== undefined) {
      existing.targetWebContentsId = targetWebContentsId;
    }
    return;
  }
  pendingOpenFilePaths.push(
    targetWebContentsId === undefined ? { path } : { path, targetWebContentsId },
  );
}

/** Route a user-selected OS file to the renderer, buffering it until the main window is ready. */
export function handleOpenFilePath(
  path: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: {
    allowWithoutReadyWindow?: boolean;
    resolveApplicationWindow?: () => BrowserWindow | null;
  } = {},
): boolean {
  if (!isValidLocalOpenFilePath(path)) {
    logger.warn("[open-file] 本地文件路径无效，已忽略", { path });
    return false;
  }
  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  if (targetWindow) {
    const targetWebContentsId = targetWindow.webContents.id;
    if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
      enqueuePendingOpenFilePath(path, targetWebContentsId);
      focusDeepLinkTargetWindow(targetWindow);
      return true;
    }
    targetWindow.webContents.send(PlatformChannels.OpenFilePath, path);
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[open-file] 文件打开请求路由成功", { windowId: targetWebContentsId, path });
    return true;
  }
  if (!options.allowWithoutReadyWindow) return false;
  enqueuePendingOpenFilePath(path);
  logger.info("[open-file] 文件打开请求已缓存，等待主窗口", { path });
  return true;
}

export function isNetworkWorkspacePath(path: string): boolean {
  // 仅当原路径以 // 或 \\ 开头时规范化后才会以 \\ 开头；
  // 单 / 的 Unix 绝对路径不会被误判为 UNC 网络路径。
  const normalized = path.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\") || /^\\\\\?\\UNC\\/iu.test(normalized);
}

export function resolveExternalWorkspaceOpenDialogCopy(
  locale: Locale,
): ExternalWorkspaceOpenDialogCopy {
  // TODO(i18n): 新增 Locale 时把这里收敛成完整 Record<Locale, ...>，
  // 避免未覆盖语言静默回退英文。
  if (locale === "zh-CN") {
    return {
      buttons: ["打开文件夹", "取消"],
      title: "打开外部 YCode 链接？",
      message: "是否在 YCode 中打开此文件夹？",
      detail: (path) => `${path}\n\n只打开你信任来源的文件夹。项目设置可能影响 agent runtime。`,
    };
  }

  return {
    buttons: ["Open folder", "Cancel"],
    title: "Open external YCode link?",
    message: "Open this folder in YCode?",
    detail: (path) =>
      `${path}\n\nOnly open folders from sources you trust. Project settings may affect the agent runtime.`,
  };
}

export function confirmExternalWorkspaceOpen(
  path: string,
  logger: { warn: (...args: unknown[]) => void },
  parentWindow: BrowserWindow | null,
  copy: ExternalWorkspaceOpenDialogCopy = resolveExternalWorkspaceOpenDialogCopy("en-US"),
): boolean {
  const options = {
    type: "warning" as const,
    buttons: copy.buttons,
    defaultId: 1,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail(path),
    noLink: true,
  };
  const response = parentWindow
    ? dialog.showMessageBoxSync(parentWindow, options)
    : dialog.showMessageBoxSync(options);
  const confirmed = response === 0;
  if (!confirmed) {
    logger.warn("[deep-link] 用户取消打开外部链接工作区", { path });
  }
  return confirmed;
}

export function handleOpenWorkspacePath(
  path: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: {
    allowWithoutReadyWindow?: boolean;
    resolveApplicationWindow?: () => BrowserWindow | null;
  } = {},
): boolean {
  if (!isValidLocalWorkspaceDirectory(path)) {
    logger.warn("[deep-link] 打开工作区路径无效，已忽略", { path });
    return false;
  }

  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  if (targetWindow) {
    const targetWebContentsId = targetWindow.webContents.id;
    if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
      pendingOpenWorkspaceRequest = {
        path,
        targetWebContentsId,
      };
      focusDeepLinkTargetWindow(targetWindow);
      // 冷启动 argv deep link 会在主窗口创建后、renderer 注册
      // onOpenWorkspacePath 之前到达。此时直接 webContents.send 会丢 IPC，
      // 必须等 renderer 主动上报 ready 后再投递目录路径。
      logger.warn("[deep-link] 工作区打开请求命中未就绪窗口，先缓存等待 renderer ready", {
        windowId: targetWebContentsId,
        path,
      });
      return true;
    }

    targetWindow.webContents.send(PlatformChannels.OpenWorkspacePath, path);
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] 工作区打开请求路由成功", {
      windowId: targetWebContentsId,
      path,
    });
    return true;
  }

  if (!options.allowWithoutReadyWindow) {
    logger.warn("[deep-link] 工作区打开请求暂未命中窗口，已忽略", { path });
    return false;
  }

  pendingOpenWorkspaceRequest = { path };
  logger.warn("[deep-link] 工作区打开请求暂未命中窗口，先缓存等待 renderer ready", { path });
  return false;
}

export function handleDeepLink(
  url: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: DeepLinkWorkspaceGateOptions = {},
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn("[deep-link] 无法解析 URL:", url);
    return false;
  }

  if (isWorkspaceOpenUrl(parsedUrl)) {
    const workspacePath = extractWorkspaceOpenPath(parsedUrl);
    if (!workspacePath) {
      logger.warn("[deep-link] 工作区打开请求缺少 path，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }

    if (isNetworkWorkspacePath(workspacePath)) {
      // Windows UNC 路径在 statSync 校验阶段就会触发 SMB 认证。
      // deep link 是外部输入，必须在任何文件系统探测前拒绝网络路径。
      logger.warn("[deep-link] 网络工作区路径已拒绝", { path: workspacePath });
      return false;
    }

    if (options.canOpenWorkspace && !options.canOpenWorkspace(workspacePath)) {
      // 强制升级是进程级 gate，workspace deep link 不能先进入缓存/投递路径。
      logger.warn("[deep-link] 工作区打开请求被当前启动 gate 阻止", { path: workspacePath });
      options.onWorkspaceOpenBlocked?.(workspacePath);
      return true;
    }

    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    // zcode://workspace/open 来自浏览器/IM 等外部应用，不能等同于用户在
    // ZCode 内部选择目录；确认必须发生在 statSync 之前，避免项目配置被静默信任。
    if (
      !confirmExternalWorkspaceOpen(workspacePath, logger, targetWindow, options.confirmationCopy)
    ) {
      return true;
    }

    return handleOpenWorkspacePath(workspacePath, logger, {
      allowWithoutReadyWindow: true,
      resolveApplicationWindow: options.resolveApplicationWindow,
    });
  }

  if (isPaymentCallbackUrl(parsedUrl)) {
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      targetWindow.webContents.send(PlatformChannels.PaymentCallback, url);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] 支付回调路由成功", {
        windowId: targetWindow.webContents.id,
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return true;
    }

    pendingPaymentDeepLinkUrl = url;
    logger.warn("[deep-link] 支付回调暂未命中窗口，先缓存等待 renderer ready", {
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  if (isShareImportUrl(parsedUrl)) {
    const shareCode = extractShareImportCode(parsedUrl);
    if (!shareCode) {
      logger.warn("[deep-link] share import code 无效，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }
    const payload = { shareCode };
    // share 分支也必须走 resolveApplicationWindow——聚焦兜底
    // getAllWindows()[0] 会命中 CUA indicator 等辅助窗口；且 pending 队列必须绑定目标窗口，
    // 否则多窗口时导入会投递给先 ready 的 renderer，写入错误 workspace 的 .zcode-share。
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      if (!rendererReadyWebContentsIds.has(targetWindow.webContents.id)) {
        enqueuePendingShareImport(payload, targetWindow.webContents.id);
        focusDeepLinkTargetWindow(targetWindow);
        logger.info("[deep-link] share import 等待 renderer ready", {
          windowId: targetWindow.webContents.id,
        });
        return true;
      }
      targetWindow.webContents.send(PlatformChannels.ShareImport, payload);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] share import 路由成功", {
        windowId: targetWindow.webContents.id,
      });
      return true;
    }
    enqueuePendingShareImport(payload);
    logger.info("[deep-link] share import 等待主窗口");
    return false;
  }

  // 会话引用外部唤起：ycode://session/open?sessionId=<id>&search=…。
  // 工作区沿用当前上下文（不带 workspace 参数）：外部来源不做静默信任，
  // 直接投递 renderer 由应用内跳转复用当前工作区反查（反查不到回退当前区）。
  // 伪造 sessionId 在 extract 层已返回 null，这里直接忽略。
  if (isSessionCitationOpenUrl(parsedUrl)) {
    const params = extractSessionCitationOpenParams(parsedUrl);
    if (!params) {
      logger.warn("[deep-link] 会话引用参数无效，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }
    const payload = { sessionId: params.sessionId, search: params.search };
    // 与 share 分支同纪律：走 resolveApplicationWindow 避开 CUA indicator
    // 等辅助窗口；pending 绑定目标窗口，多窗口时不投错 renderer。
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      if (!rendererReadyWebContentsIds.has(targetWindow.webContents.id)) {
        enqueuePendingSessionCitationOpen(payload, targetWindow.webContents.id);
        focusDeepLinkTargetWindow(targetWindow);
        logger.info("[deep-link] 会话引用等待 renderer ready", {
          windowId: targetWindow.webContents.id,
        });
        return true;
      }
      targetWindow.webContents.send(PlatformChannels.SessionCitationOpen, payload);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] 会话引用路由成功", {
        windowId: targetWindow.webContents.id,
      });
      return true;
    }
    enqueuePendingSessionCitationOpen(payload);
    logger.info("[deep-link] 会话引用等待主窗口");
    return false;
  }

  if (!isOAuthCallbackUrl(parsedUrl)) {
    return false;
  }

  const state = parsedUrl.searchParams.get("state");
  if (!state) {
    logger.warn("[deep-link] OAuth 回调缺少 state，忽略此次回调", {
      protocol: parsedUrl.protocol,
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  const routeTarget = oauthStateToWindow.get(state);
  const targetWindow = routeTarget
    ? BrowserWindow.getAllWindows().find((window) => window.webContents.id === routeTarget.windowId)
    : null;
  const shouldCompleteOAuthRoute = hasOAuthAuthorizationCode(parsedUrl);

  if (targetWindow) {
    targetWindow.webContents.send(PlatformChannels.OAuthCallback, url);
    if (shouldCompleteOAuthRoute) {
      oauthStateToWindow.delete(state);
    }
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] OAuth 回调路由成功", {
      state,
      windowId: targetWindow.webContents.id,
      provider: routeTarget?.provider,
      completed: shouldCompleteOAuthRoute,
    });
    return true;
  }

  pendingDeepLinkUrl = url;
  logger.warn("[deep-link] OAuth 回调未命中目标窗口，先缓存等待 renderer ready", {
    state,
    hasRouteTarget: Boolean(routeTarget),
  });
  return false;
}

// 深链 scheme 双注册：zcode（现有四路）与 ycode（会话引用外部唤起）并存，
// 不替换。任一注册失败只记日志，不阻断另一个。
const DEEP_LINK_SCHEMES = ["zcode", "ycode"] as const;

function registerSingleDeepLinkScheme(
  scheme: string,
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
): boolean {
  if (process.defaultApp && process.argv.length >= 2) {
    const entry = resolve(process.argv[1]!);
    const ok = app.setAsDefaultProtocolClient(scheme, process.execPath, [entry]);
    if (!ok) {
      logger.warn("[deep-link] 注册协议失败（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    } else {
      logger.info("[deep-link] 注册协议成功（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    }
    return ok;
  }

  const ok = app.setAsDefaultProtocolClient(scheme);
  if (!ok) {
    logger.warn("[deep-link] 注册协议失败", { scheme });
  } else {
    logger.info("[deep-link] 注册协议成功", { scheme });
  }
  return ok;
}

export function registerDeepLinkProtocol(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: { iconPath?: string } = {},
) {
  for (const scheme of DEEP_LINK_SCHEMES) {
    registerSingleDeepLinkScheme(scheme, logger);
  }

  if (process.platform === "linux" && app.isPackaged) {
    registerLinuxDeepLinkProtocol({
      executablePath: process.execPath,
      homeDir: app.getPath("home"),
      // .desktop 的 StartupWMClass 必须匹配真实窗口 class，沿用历史身份名；
      // 跟随品牌显示名（app.name）会让 Linux 深链窗口匹配失效。
      productName: runtimeApplicationName,
      iconSourcePath: options.iconPath,
      env: process.env,
      argv: process.argv,
      logger,
    });
  }
}

export function registerOAuthState(windowId: number, registration: OAuthStateRegistration): void {
  oauthStateToWindow.set(registration.state, {
    windowId,
    provider: registration.provider,
  });

  setTimeout(() => oauthStateToWindow.delete(registration.state), 5 * 60 * 1000);
}

export function deliverPendingDeepLink(webContents: WebContents): boolean {
  rendererReadyWebContentsIds.add(webContents.id);

  const hasPendingOAuthCallback = pendingDeepLinkUrl != null;
  // pending share import 绑定目标窗口后，只投递给目标窗口（或冷启动时未绑定目标的
  // 条目）；非目标窗口 ready 时保留条目，否则导入会写进错误窗口的 workspace。
  const undeliveredShareImports: typeof pendingShareImports = [];
  for (const pending of pendingShareImports.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.ShareImport, { shareCode: pending.shareCode });
    } else {
      undeliveredShareImports.push(pending);
    }
  }
  pendingShareImports.push(...undeliveredShareImports);
  // 会话引用 pending 与 share 同纪律：绑定目标窗口的只投递给目标窗口。
  const undeliveredSessionCitationOpens: typeof pendingSessionCitationOpens = [];
  for (const pending of pendingSessionCitationOpens.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.SessionCitationOpen, {
        sessionId: pending.sessionId,
        search: pending.search,
      });
    } else {
      undeliveredSessionCitationOpens.push(pending);
    }
  }
  pendingSessionCitationOpens.push(...undeliveredSessionCitationOpens);
  if (hasPendingOAuthCallback) {
    webContents.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl);
    pendingDeepLinkUrl = null;
  }
  if (pendingPaymentDeepLinkUrl) {
    webContents.send(PlatformChannels.PaymentCallback, pendingPaymentDeepLinkUrl);
    pendingPaymentDeepLinkUrl = null;
  }
  if (
    pendingOpenWorkspaceRequest &&
    (pendingOpenWorkspaceRequest.targetWebContentsId == null ||
      pendingOpenWorkspaceRequest.targetWebContentsId === webContents.id)
  ) {
    webContents.send(PlatformChannels.OpenWorkspacePath, pendingOpenWorkspaceRequest.path);
    pendingOpenWorkspaceRequest = null;
  }
  const undeliveredOpenFilePaths: typeof pendingOpenFilePaths = [];
  for (const pending of pendingOpenFilePaths.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.OpenFilePath, pending.path);
    } else {
      undeliveredOpenFilePaths.push(pending);
    }
  }
  pendingOpenFilePaths.push(...undeliveredOpenFilePaths);
  return hasPendingOAuthCallback;
}

export function clearOAuthRoutesForWindow(windowId: number): void {
  rendererReadyWebContentsIds.delete(windowId);
  if (pendingOpenWorkspaceRequest?.targetWebContentsId === windowId) {
    pendingOpenWorkspaceRequest = null;
  }
  for (let index = pendingOpenFilePaths.length - 1; index >= 0; index -= 1) {
    if (pendingOpenFilePaths[index]!.targetWebContentsId === windowId) {
      pendingOpenFilePaths.splice(index, 1);
    }
  }
  // pending share import 绑定目标窗口后，目标窗口关闭必须同步清理，
  // 否则队列条目永不过期，可能投递给后续 ready 的其他窗口（错误 workspace）。
  for (let index = pendingShareImports.length - 1; index >= 0; index -= 1) {
    if (pendingShareImports[index]!.targetWebContentsId === windowId) {
      pendingShareImports.splice(index, 1);
    }
  }
  // 目标窗口关闭同步清理会话引用 pending，否则条目永不过期、可能投错窗口。
  for (let index = pendingSessionCitationOpens.length - 1; index >= 0; index -= 1) {
    if (pendingSessionCitationOpens[index]!.targetWebContentsId === windowId) {
      pendingSessionCitationOpens.splice(index, 1);
    }
  }

  for (const [state, routeTarget] of oauthStateToWindow) {
    if (routeTarget.windowId === windowId) {
      oauthStateToWindow.delete(state);
    }
  }
}
