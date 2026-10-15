import type { Event } from "@zcode/rpc";
import type { ProviderId } from "@zcode/provider";
import { ServiceChannels, type CliProxyLoginChannel } from "@zcode/shared";
import type {
  CliProxyModelsSnapshot,
  CliProxyQuotaSnapshot,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** CLI Proxy 二进制版本来源：随应用打包的兜底，或用户联网下载。 */
export type CliProxyVersionSource = "bundled" | "downloaded";

/** cliproxy-* provider 的 baseURL 必须指向的本机回环形态（端口回填只认这两类）。 */
export function isCliProxyLoopbackBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(baseUrl.trim());
}

/** 把回环 baseURL 的端口换成实际绑定端口；非回环原样返回（不碰用户自定义地址）。 */
export function withCliProxyActualPort(baseUrl: string, port: number): string {
  const trimmed = baseUrl.trim();
  if (!isCliProxyLoopbackBaseUrl(trimmed)) return baseUrl;
  try {
    const url = new URL(trimmed);
    url.port = String(port);
    return url.toString().replace(/\/$/, "");
  } catch {
    return baseUrl;
  }
}

/** cliproxy-* provider 的稀疏补丁：端口回填与数据面 api-key 投影，字段缺省表示无需变更。 */
export interface CliProxyProviderEndpointPatch {
  readonly baseUrl?: string;
  readonly access?: { readonly type: "api-key"; readonly apiKey: string };
}

/**
 * 计算 cliproxy-* provider 需要的端点投影补丁；无需变更返回 null（调用方据此跳过写入）。
 * 依据（真机 + 脚本复现 2026-10-14）：代理对 /v1 强制校验 access.api-keys（无/错 key 均
 * 401），而 Registry 要求 provider 配置完整——access.apiKey 缺失时 ProviderConfigResolver
 * 直接把该 provider 排除出模型选择器。数据面 api-key 的唯一事实源是 data.key 落盘文件
 * （0600），这里把它和实际端口一起投影到 provider 配置（与端口回填同一范式，幂等）。
 */
export function resolveCliProxyProviderEndpointPatch(
  provider: { readonly baseUrl: string; readonly apiKey?: string | null },
  facts: { readonly port: number; readonly dataKey: string },
): CliProxyProviderEndpointPatch | null {
  const baseUrl = withCliProxyActualPort(provider.baseUrl, facts.port);
  const portChanged = baseUrl !== provider.baseUrl;
  const keyChanged = provider.apiKey !== facts.dataKey;
  if (!portChanged && !keyChanged) return null;
  return {
    ...(portChanged ? { baseUrl } : {}),
    ...(keyChanged ? { access: { type: "api-key" as const, apiKey: facts.dataKey } } : {}),
  };
}

/**
 * 裁决 CLI Proxy 上游出口代理地址（docs/specs/plugin-cli-proxy-binary.md「上游代理」）。
 * 输入是全部 cliproxy-* 提供商的 proxyMode（未写的按 "default"）与全局代理设置：
 * - 任一提供商要求代理（"proxy"，或 "default" 且全局「为全局启用」）即写 proxy-url（代理优先）；
 * - 代理地址未填或无人要求代理 → null（直连，config.yaml 不写 proxy-url）。
 * 粒度是实例级：CLI Proxy 单实例共享一个上游出口，不存在按模型分流。
 */
export function resolveCliProxyUpstreamProxyUrl(
  modes: readonly string[],
  global: { readonly enabled: boolean; readonly address?: string | null },
): string | null {
  if (modes.length === 0) return null;
  const address = global.address?.trim() || "";
  if (!address) return null;
  const wantsProxy = modes.some(
    (mode) => mode === "proxy" || (mode !== "proxy" && mode !== "direct" && global.enabled),
  );
  return wantsProxy ? address : null;
}

export interface CliProxyDownloadedVersion {
  /** active 指针：`${version}-${target}-${archiveSha12}`，与版本目录名一致。 */
  id: string;
  version: string;
  /** `darwin-arm64` 等六元组之一。 */
  target: string;
  archiveSha256: string;
  /** 该版本专属目录绝对路径。 */
  dir: string;
  source: CliProxyVersionSource;
  downloadedAt: string;
}

export type CliProxyRuntimeState = "stopped" | "starting" | "running" | "error";

export type CliProxyErrorCode =
  /** 二进制缺失（无内置、无已下载）：需要先下载版本。 */
  | "binary-missing"
  /** 下载/校验/解压/签名失败。 */
  | "install-failed"
  /** 启动监听失败（非 EADDRINUSE，如权限、地址不可用）。 */
  | "start-failed";

export interface CliProxyStatus {
  state: CliProxyRuntimeState;
  /** 是否存在依赖 CLI Proxy 的 provider（按需启动的派生意图）。 */
  needed: boolean;
  versions: CliProxyDownloadedVersion[];
  activeVersionId: string | null;
  port: number | null;
  /** 联网检查到的新版本（用户未确认前不下载、不切换）。 */
  updateAvailable: string | null;
  lastUpdateCheckAt: string | null;
  errorCode?: CliProxyErrorCode;
  error?: string;
}

export interface CliProxyReleaseAsset {
  version: string;
  target: string;
  archiveUrl: string;
  archiveSha256: string;
  archiveSizeBytes?: number;
}

/**
 * 桌面 Host 的 CLI Proxy 二进制插件运行时。
 *
 * 唯一状态所有者：Host 进程内注册一次。UI 只渲染快照，所有变更经 RPC 落回 Host。
 * "是否需要运行"从供应商配置派生（不存在依赖 provider 时不启动），没有用户显式开关。
 */
export interface ICliProxyService {
  getStatus(): Promise<CliProxyStatus>;
  /** 联网检查 GitHub 新 release；只返回版本号，不下载。 */
  checkForUpdates(): Promise<CliProxyStatus>;
  /** 下载并登记一个新版本（版本级"安装"）；不自动切 active。 */
  downloadRelease(asset: CliProxyReleaseAsset): Promise<CliProxyStatus>;
  /** 切换 active 版本；运行中则同端口重启。 */
  selectVersion(id: string): Promise<CliProxyStatus>;
  /**
   * 卸载一个用户下载的版本；内置基础版本不可卸载（调用时报错）。
   * 卸载 active 后回落到最近可用版本（兜底为内置基础版本），UI 需显式提示。
   */
  uninstallVersion(id: string): Promise<{ status: CliProxyStatus; fellBack: boolean }>;
  /** 供应商配置变化后重算按需启动：需要则 start，否则 stop。 */
  refresh(): Promise<CliProxyStatus>;
  /**
   * 渠道账号面（一个账号 = 一个 provider 条目，共享单实例；codex/claude/gemini/
   * antigravity 走浏览器授权，claude/gemini/antigravity 为 beta）。
   * 调用前需保证 running；stopped 时返回 proxy-stopped 类错误，不拉起。
   * OAuth 落盘即被代理热加载，不写 config。额度只被动观测，不轮询。
   */
  getAuthUrl(channel: CliProxyLoginChannel): Promise<{ url: string; state: string }>;
  pollAuthStatus(state: string): Promise<"wait" | "ok">;
  submitAuthCallback(channel: CliProxyLoginChannel, payload: Record<string, string>): Promise<void>;
  fetchModels(channel?: CliProxyLoginChannel): Promise<CliProxyModelsSnapshot>;
  syncModels(providerId: ProviderId): Promise<import("@zcode/shared").CliProxyModelSyncResult>;
  fetchQuota(providerId: string, channel: CliProxyLoginChannel): Promise<CliProxyQuotaSnapshot>;
  listAuthFiles(): Promise<string[]>;
  /**
   * 状态变更事件。
   *
   * 必须声明为事件属性而不是方法：ProxyChannel 按 `on*` 命名约定映射（见远控同款注释）。
   */
  readonly onDidChangeStatus: Event<CliProxyStatus>;
}

export const ICliProxyService = createServiceDescriptor<ICliProxyService>(
  ServiceChannels.CliProxy,
);

/** 仅查询额度快照的窄服务面，可按 attachment 单独授权给手机远控。 */
export interface ICliProxyQuotaService {
  fetchQuota(providerId: string, channel: CliProxyLoginChannel): Promise<CliProxyQuotaSnapshot>;
}
export type CliProxyQuotaService = ICliProxyQuotaService;

export const ICliProxyQuotaService = createServiceDescriptor<ICliProxyQuotaService>(
  ServiceChannels.CliProxyQuota,
);

export function createCliProxyQuotaService(
  service: Pick<ICliProxyService, "fetchQuota">,
): ICliProxyQuotaService {
  return { fetchQuota: (providerId, channel) => service.fetchQuota(providerId, channel) };
}
