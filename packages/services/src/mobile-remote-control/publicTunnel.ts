/**
 * 公网临时链接的隧道 Provider 契约（纯逻辑）。
 *
 * 与 RPC、Electron、child_process 都无关：这里只回答三件事——
 * 有哪些 Provider、每个 Provider 需要用户准备什么、命令行怎么拼。
 * 桌面端据此 spawn 隧道进程（`packages/desktop/src/host/publicTunnelProcess.ts`），
 * UI 据此渲染下拉与凭据输入区，新增 Provider 只需改 `PUBLIC_TUNNEL_PROVIDERS`
 * 与一个适配器，不动主流程。
 *
 * 浏览器安全：不引入 node 内建模块，可从 `@zcode/services` 根入口导出。
 */

/** 公网隧道 Provider 标识。 */
export type PublicTunnelProviderId = "cloudflare-quick" | "cloudflare-named";

export interface PublicTunnelProviderDescriptor {
  id: PublicTunnelProviderId;
  /** 是否需要用户额外提供凭据（Named Tunnel 需要 tunnel token 与 hostname）。 */
  requiresCredentials: boolean;
  /** 公网域名是否固定不变（Named 由用户自己的域名决定，永久有效）。 */
  stableDomain: boolean;
}

/**
 * Provider 目录。
 *
 * 这是 UI 下拉与凭据区的唯一数据来源：桌面端不认 Provider 名字之外的约定，
 * 也不维护第二份清单。
 */
export const PUBLIC_TUNNEL_PROVIDERS: readonly PublicTunnelProviderDescriptor[] = [
  { id: "cloudflare-quick", requiresCredentials: false, stableDomain: false },
  { id: "cloudflare-named", requiresCredentials: true, stableDomain: true },
];

/** 按 id 查 Provider；未知 id 返回 undefined（调用方据此报错，不静默兜底）。 */
export function findPublicTunnelProvider(
  id: string,
): PublicTunnelProviderDescriptor | undefined {
  return PUBLIC_TUNNEL_PROVIDERS.find((provider) => provider.id === id);
}

/** createPublicUrl 的入参。 */
export interface PublicTunnelCreateParams {
  provider: PublicTunnelProviderId;
  /** Named Tunnel 必填：预创建隧道的 token（base64 的 {a,t,s}）。 */
  token?: string;
  /** Named Tunnel 必填：该隧道配置好的公网 hostname。 */
  hostname?: string;
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

/**
 * 校验创建参数。
 *
 * 返回可读错误文案；undefined 表示通过。校验放在契约层，UI 与 Host 用同一套规则，
 * 不会出现"UI 放行但 Host 拒绝"的分裂。
 */
export function validatePublicTunnelParams(
  params: PublicTunnelCreateParams,
): string | undefined {
  const provider = findPublicTunnelProvider(params.provider);
  if (!provider) {
    return `未知的隧道 Provider：${String(params.provider)}`;
  }
  if (!provider.requiresCredentials) {
    return undefined;
  }
  if (!params.token?.trim()) {
    return "缺少隧道 Token：请填写 Cloudflare 隧道 token";
  }
  if (!params.hostname?.trim()) {
    return "缺少公网域名：请填写该隧道配置好的 hostname";
  }
  return undefined;
}

/** tunnel token 解出的凭据字段。 */
export interface DecodedTunnelToken {
  /** Cloudflare 账号标识。 */
  accountTag: string;
  /** 隧道 ID。 */
  tunnelId: string;
  /** 隧道密钥（base64 原文，直接写进 credentials.json）。 */
  tunnelSecret: string;
}

/**
 * 解析 Cloudflare 隧道 token。
 *
 * token 是 base64 的 JSON `{a: 账号ID, t: 隧道ID, s: 隧道密钥}`——它就是全部凭证，
 * 终端用户不需要 Cloudflare 账号登录。解析失败要给出可读原因，不能抛裸异常。
 */
export function decodeTunnelToken(token: string): DecodedTunnelToken {
  const raw = token.trim();
  if (!raw) {
    throw new Error("隧道 Token 为空");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Utf8(raw));
  } catch (error) {
    throw new Error(
      `隧道 Token 格式不正确（应为 base64 编码的 JSON）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("隧道 Token 格式不正确：内容不是对象");
  }
  const record = payload as Record<string, unknown>;
  const accountTag = typeof record.a === "string" ? record.a : "";
  const tunnelId = typeof record.t === "string" ? record.t : "";
  const tunnelSecret = typeof record.s === "string" ? record.s : "";
  if (!accountTag || !tunnelId || !tunnelSecret) {
    throw new Error("隧道 Token 缺少必要字段（需要 a / t / s）");
  }
  return { accountTag, tunnelId, tunnelSecret };
}

/** base64（标准或 URL 安全、可缺填充）解成 UTF-8 文本。 */
function decodeBase64Utf8(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface TunnelConfigOptions {
  tunnelId: string;
  tunnelSecret: string;
  accountTag: string;
  /** 用户在 Cloudflare 账号里配好的公网 hostname。 */
  hostname: string;
  /** 本地转发目标，如 `http://127.0.0.1:53211`。 */
  target: string;
  /** credentials.json 的落地绝对路径；写进 config.yml。 */
  credentialsFile: string;
}

export interface TunnelConfigFiles {
  /** credentials.json 的完整内容。 */
  credentialsJson: string;
  /** config.yml 的完整内容。 */
  configYaml: string;
}

/**
 * 生成 Named Tunnel 的本地配置文件。
 *
 * 为什么必须本地生成：hostname 的 ingress 规则默认写在 Cloudflare 账号的**远端**配置里，
 * 那里的 `service` 写死了端口，而远控端口是随机的。本地 config.yml 覆盖远端配置后，
 * ingress 就能指向本次实际端口。
 *
 * 关键点：**不写 `configVersion`**。写了它 cloudflared 以远端配置为准（端口又被写死），
 * 不写才使用本地配置。
 */
export function buildTunnelConfig(options: TunnelConfigOptions): TunnelConfigFiles {
  const credentialsJson = JSON.stringify({
    AccountTag: options.accountTag,
    TunnelSecret: options.tunnelSecret,
    TunnelID: options.tunnelId,
  });
  const configYaml = [
    `tunnel: ${options.tunnelId}`,
    `credentials-file: ${yamlSingleQuoted(options.credentialsFile)}`,
    "ingress:",
    `  - hostname: ${yamlSingleQuoted(options.hostname)}`,
    `    service: ${yamlSingleQuoted(options.target)}`,
    // cloudflared 要求最后一条 ingress 是 catch-all。
    "  - service: http_status:404",
    "",
  ].join("\n");
  return { credentialsJson, configYaml };
}

/**
 * YAML 单引号字符串。
 *
 * 用单引号而不是双引号：Windows 路径里的反斜杠在 YAML 双引号里是转义符，
 * 单引号里是字面量（只需把单引号本身写成两个）。
 */
function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

/** Named Tunnel 的就绪信号：连接注册成功后 cloudflared 打的这行。 */
export function isTunnelRegisteredLog(line: string): boolean {
  return /registered tunnel connection/i.test(line);
}

export interface TunnelArgsOptions {
  provider: PublicTunnelProviderId;
  /** 本地转发目标。 */
  target: string;
  /** Named Tunnel 的 config.yml 绝对路径。 */
  configPath?: string;
  /** Named Tunnel 的隧道 ID。 */
  tunnelId?: string;
}

/**
 * 拼 cloudflared 的命令行参数。
 *
 * `--config` 与 `--no-autoupdate` 是 `tunnel` 级选项，必须排在 `run` 之前；
 * `--metrics 127.0.0.1:0` 显式指定随机端口，避免与用户自己已在跑的 cloudflared 抢
 * 默认的 metrics 端口。
 */
export function buildTunnelArgs(options: TunnelArgsOptions): string[] {
  if (options.provider === "cloudflare-quick") {
    return ["tunnel", "--url", options.target, "--no-autoupdate", "--metrics", "127.0.0.1:0"];
  }
  if (!options.configPath || !options.tunnelId) {
    throw new Error("Named Tunnel 缺少 config.yml 路径或隧道 ID");
  }
  return [
    "tunnel",
    "--config",
    options.configPath,
    "--no-autoupdate",
    "--metrics",
    "127.0.0.1:0",
    "run",
    options.tunnelId,
  ];
}

/**
 * 归一化用户填写的 hostname。
 *
 * 用户可能直接粘贴带协议或带路径的地址；这里只取主机名部分，
 * 协议固定用 https（隧道出口一定是 https）。
 */
export function normalizePublicHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutPath = withoutScheme.split(/[/?#]/)[0] ?? "";
  return withoutPath.trim().toLowerCase();
}

/** 公网根地址 + 现有远控 token，拼成可直接打开的链接。 */
export function buildPublicAccessUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`;
}
