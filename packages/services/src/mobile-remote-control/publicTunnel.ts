/**
 * 公网临时链接的隧道 Provider 契约（纯逻辑）。
 *
 * 与 RPC、Electron、child_process 都无关：这里只回答三件事——
 * 有哪些 Provider、每个 Provider 需要用户准备什么、公网地址从哪来。
 * 桌面端据此把远控端口暴露到公网（`packages/desktop/src/host/` 下的两个 launcher），
 * UI 据此渲染下拉与子域名输入区；新增 Provider 只需改 `PUBLIC_TUNNEL_PROVIDERS`
 * 与一个 launcher，不动主流程。
 *
 * 浏览器安全：不引入 node 内建模块，可从 `@zcode/services` 根入口导出。
 */

/** 公网隧道 Provider 标识。 */
export type PublicTunnelProviderId = "cloudflare-quick" | "localtunnel";

export interface PublicTunnelProviderDescriptor {
  id: PublicTunnelProviderId;
  /**
   * 公网域名是否固定不变。
   *
   * localtunnel 的子域名由服务端长期保留（名字与 URL 绑定，隧道关闭后名字仍在），
   * 所以它算固定域名；Cloudflare Quick Tunnel 每次重建都是随机域名。
   */
  stableDomain: boolean;
  /** 是否需要一个公网子域名（用户可填，留空则沿用已保存的或自动生成一个）。 */
  requiresSubdomain: boolean;
}

/**
 * Provider 目录。
 *
 * 这是 UI 下拉与子域名输入区的唯一数据来源：桌面端不认 Provider 名字之外的约定，
 * 也不维护第二份清单。
 */
export const PUBLIC_TUNNEL_PROVIDERS: readonly PublicTunnelProviderDescriptor[] = [
  { id: "cloudflare-quick", stableDomain: false, requiresSubdomain: false },
  { id: "localtunnel", stableDomain: true, requiresSubdomain: true },
];

/** 按 id 查 Provider；未知 id 返回 undefined（调用方据此报错，不静默兜底）。 */
export function findPublicTunnelProvider(id: string): PublicTunnelProviderDescriptor | undefined {
  return PUBLIC_TUNNEL_PROVIDERS.find((provider) => provider.id === id);
}

/** createPublicUrl 的入参。 */
export interface PublicTunnelCreateParams {
  provider: PublicTunnelProviderId;
  /**
   * localtunnel 的公网子域名。
   *
   * 留空表示"用上次保存的，没有就自动生成一个"——由宿主决定，UI 只负责收集。
   */
  subdomain?: string;
}

export type PublicTunnelState = "starting" | "running" | "error" | "stopped";

/** 公网链接状态；挂在 `MobileRemoteControlStatus.public` 上，不是独立状态轴。 */
export interface PublicTunnelStatus {
  provider: PublicTunnelProviderId;
  state: PublicTunnelState;
  /**
   * 公网地址（**含 token**），与 `MobileRemoteControlStatus.accessUrl` 同一语义：
   * 手机可直接打开的地址。running 时存在。
   */
  url?: string;
  /** 失败原因（可读文案）；error 时存在。 */
  error?: string;
}

/** DNS label 规则：小写字母、数字、连字符，且不能以连字符开头/结尾。 */
const LOCALTUNNEL_SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 校验创建参数。
 *
 * 返回可读错误文案；undefined 表示通过。校验放在契约层，UI 与 Host 用同一套规则，
 * 不会出现"UI 放行但 Host 拒绝"的分裂。
 */
export function validatePublicTunnelParams(params: PublicTunnelCreateParams): string | undefined {
  const provider = findPublicTunnelProvider(params.provider);
  if (!provider) {
    return `未知的隧道服务商：${String(params.provider)}`;
  }
  if (!provider.requiresSubdomain) {
    return undefined;
  }
  const subdomain = params.subdomain?.trim();
  // 空着是合法的：宿主会用已保存的子域名，没有就自动生成一个。
  if (!subdomain) return undefined;
  if (!LOCALTUNNEL_SUBDOMAIN_PATTERN.test(normalizeLocaltunnelSubdomain(subdomain))) {
    return "公网子域名只能包含小写字母、数字和连字符，且不能以连字符开头或结尾";
  }
  return undefined;
}

/** 归一化用户填写的子域名：去空白、转小写。 */
export function normalizeLocaltunnelSubdomain(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 子域名随机字符表。
 *
 * 去掉了 i / l / o / 0 / 1 这几个在小字号和二维码里容易认错的字符——
 * 公网链接是要被扫二维码的，认错一个字符就等于链接打不开。
 */
const LOCALTUNNEL_SUBDOMAIN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * 自动生成一个公网子域名，如 `ycode-7k2mq9x4`。
 *
 * 随机源由调用方注入（桌面端传 `node:crypto` 的 randomBytes），本文件因此仍是
 * browser-safe，可在纯逻辑测试里用固定字节断言输出。
 */
export function generateLocaltunnelSubdomain(random: Uint8Array): string {
  let suffix = "";
  for (const byte of random) {
    // 字母表长度 32 整除 256，取模没有偏置。
    suffix += LOCALTUNNEL_SUBDOMAIN_ALPHABET[byte % 32] ?? "a";
  }
  return `ycode-${suffix}`;
}

/**
 * localtunnel 服务的候选地址。
 *
 * 官方落地页用的域名是 `loca.lt`，而 npm 客户端的默认 host 是 `localtunnel.me`；
 * 两个都留着，桌面端按顺序尝试，第一个不通就用下一个。
 */
export const LOCALTUNNEL_HOST_CANDIDATES: readonly string[] = [
  "https://loca.lt",
  "https://localtunnel.me",
];

/** localtunnel 客户端的入参（对应 npm 包 `localtunnel` 的选项）。 */
export interface LocaltunnelOptions {
  /** 本地转发目标端口（远控服务监听的端口）。 */
  port: number;
  /** 公网子域名。 */
  subdomain: string;
  /** 服务端地址。 */
  host: string;
}

/** 组装 localtunnel 客户端入参。 */
export function buildLocaltunnelOptions(options: {
  port: number;
  subdomain: string;
  host: string;
}): LocaltunnelOptions {
  return { port: options.port, subdomain: options.subdomain, host: options.host };
}

/**
 * 判断拿到的公网地址是不是用户要的那个子域名。
 *
 * localtunnel 的子域名是"先到先得"：名字被别人占用时，服务端不会报错，而是
 * **悄悄分配一个随机名字**。不校验就会把一个随机地址当成固定域名交出去，
 * 用户下次打开收藏的链接却发现域名变了——所以这里必须显式比对。
 */
export function isExpectedLocaltunnelUrl(url: string, subdomain: string): boolean {
  const expected = normalizeLocaltunnelSubdomain(subdomain);
  if (!expected) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const [label] = hostname.split(".");
    return label === expected;
  } catch {
    return false;
  }
}

/**
 * 从 cloudflared 输出里解析 Quick Tunnel 的公网地址。
 *
 * cloudflared 打印形如 `Your quick Tunnel has been created! Visit it at https://xxx.trycloudflare.com`，
 * stdout 与 stderr 都可能出现，所以两路都要喂进来。
 */
export function parseQuickTunnelUrl(line: string): string | undefined {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
  return match?.[0];
}

/**
 * 拼 cloudflared 的命令行参数。
 *
 * `--no-autoupdate` 与 `--metrics` 是 `tunnel` 级选项，必须排在 `run` 之前；
 * `--metrics 127.0.0.1:0` 显式指定随机端口，避免与用户自己已在跑的 cloudflared 抢
 * 默认的 metrics 端口。
 */
export function buildTunnelArgs(target: string): string[] {
  return ["tunnel", "--url", target, "--no-autoupdate", "--metrics", "127.0.0.1:0"];
}

/** 公网根地址 + 现有远控 token，拼成可直接打开的链接。 */
export function buildPublicAccessUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`;
}
