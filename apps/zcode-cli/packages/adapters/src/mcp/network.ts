import { accessSync, constants } from "node:fs";
import { delimiter, posix, win32 } from "node:path";
import type { McpProxyMode } from "@zcode/contracts";
import { sanitizeZCodeRuntimeEnv } from "@zcode/shared";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import {
  applyNetworkEgressEnv,
  stripProxyEnvKeys,
  type NetworkEgressEnvPolicy,
} from "../network/subprocess-env.js";

export type { NetworkEgressEnvPolicy };

/**
 * 单个 MCP server 解析后的出口策略。由 resolveMcpNetwork 从 proxyMode + 全局 network 得出，
 * 两种传输（http/sse 的 fetch、stdio 的子进程 env）共用同一份判定。
 */
export interface McpResolvedNetwork {
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
  /**
   * 强制直连置位：屏蔽 env 里的代理候选。fetch 侧传空 env（否则 resolveProxyForRequest
   * 仍会从 ZCODE_HTTP_PROXY 捡回地址），stdio 侧显式剥掉代理键。
   */
  ignoreProxyEnv?: boolean;
  /**
   * 用户显式选了走代理、但运行时拿不到任何可用地址。带这个标记时 ignoreProxyEnv 同时置位，
   * 保证解析结果在行为上仍是直连（不会误连到别处），但调用方能把它判成配置错误，
   * 而不是让用户在超时后收到「请检查网络」的误导提示。
   */
  missingProxyAddress?: "proxy" | "system";
}

/**
 * 按 MCP server 的 proxyMode → 该 server 的出口代理（docs/specs/network-settings.md）。
 * 语义与模型的 resolveModelTransportNetwork 逐条对齐，但不复用它：MCP 还要额外处理
 * stdio 子进程 env 的注入/剥离，两者的产出形状与消费方式都不同。
 *
 * - "direct"：强制直连，无视全局开关与 env 代理候选；
 * - "proxy"：走「网络」分区填写的代理地址（appHttpProxy 材料）。CLI standalone 没有
 *   ZCODE_APP_* env 时回落 network.httpProxy（其自身语义即启用）；
 * - "system"：走操作系统配置的代理（systemHttpProxy 材料）。无材料（系统未配代理或
 *   standalone CLI）则直连，不被应用代理或 env 候选劫持；
 * - "default"/缺省：跟随全局 gate 后的 httpProxy（含 env 候选兜底），与历史行为完全一致。
 *
 * "proxy" / "system" 是用户显式选择，拿不到地址时属配置错误：返回直连结果并打上
 * missingProxyAddress 标记，由调用方报出可执行的提示，不能静默降级——静默直连会让
 * 一次配置遗漏伪装成网络不可达，用户按提示查网络永远查不出问题。
 *
 * 走代理的模式下各自的 No Proxy 规则仍然生效。自定义证书与代理模式无关，任何模式都照传。
 */
export function resolveMcpNetwork(
  proxyMode: McpProxyMode | undefined,
  network: NetworkEgressEnvPolicy | undefined,
): McpResolvedNetwork {
  // 证书与代理模式无关，任何模式都照传；没有配置时不产出这个键，保持返回值形状干净。
  const ca = network?.caCertFile ? { caCertFile: network.caCertFile } : {};
  if (proxyMode === "direct") {
    return { ...ca, ignoreProxyEnv: true };
  }
  if (proxyMode === "system") {
    const httpProxy = network?.systemHttpProxy;
    if (!httpProxy) {
      return { ...ca, ignoreProxyEnv: true, missingProxyAddress: "system" };
    }
    return { ...ca, httpProxy, noProxy: network?.systemNoProxy };
  }
  if (proxyMode === "proxy") {
    const httpProxy = network?.appHttpProxy ?? network?.httpProxy;
    if (!httpProxy) {
      return { ...ca, ignoreProxyEnv: true, missingProxyAddress: "proxy" };
    }
    return { ...ca, httpProxy, noProxy: network?.appNoProxy ?? network?.noProxy };
  }
  return { ...ca, httpProxy: network?.httpProxy, noProxy: network?.noProxy };
}

export function buildMcpStdioEnv(options: {
  env?: NodeJS.ProcessEnv;
  network?: McpResolvedNetwork;
}): Record<string, string> {
  const sourceEnv = options.env ?? process.env;
  const withNetworkEnv = applyNetworkEgressEnv(
    sanitizeZCodeRuntimeEnv(filterStringEnv(sourceEnv)),
    {
      network: options.network,
      sourceEnv,
    },
  );
  const withNodePath = prependRunningNodeDirectory(withNetworkEnv);
  // direct 必须显式再剥一次代理键：applyNetworkEgressEnv 只会注入不会删除，
  // 不剥就等于仍把代理地址交给了子进程。
  return options.network?.ignoreProxyEnv ? stripProxyEnvKeys(withNodePath) : withNodePath;
}

export function createMcpTransportFetch(options: {
  env?: NodeJS.ProcessEnv;
  network?: McpResolvedNetwork;
}): typeof globalThis.fetch {
  return createNetworkProxyFetch({
    caCertFile: options.network?.caCertFile,
    // direct 模式置空 env，屏蔽 resolveProxyForRequest 的 ZCODE_HTTP_PROXY 候选；
    // 非 direct 仍传真实 env，那条兜底候选是既有行为的一部分。
    env: options.network?.ignoreProxyEnv ? {} : (options.env ?? process.env),
    httpProxy: options.network?.httpProxy,
    noProxy: options.network?.noProxy,
  });
}

function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

interface RunningNodePathOptions {
  execPath: string;
  isExecutable: (path: string) => boolean;
  platform: NodeJS.Platform;
}

const DEFAULT_RUNNING_NODE_PATH_OPTIONS: RunningNodePathOptions = {
  execPath: process.execPath,
  isExecutable: isExecutableFile,
  platform: process.platform,
};

function prependRunningNodeDirectory(
  env: Record<string, string>,
  options: RunningNodePathOptions = DEFAULT_RUNNING_NODE_PATH_OPTIONS,
): Record<string, string> {
  const pathApi = options.platform === "win32" ? win32 : posix;
  const pathDelimiter = options.platform === "win32" ? ";" : delimiter;
  const executableName = pathApi.basename(options.execPath).toLowerCase();
  if (executableName !== "node" && executableName !== "node.exe") {
    return env;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const nodeDirectory = pathApi.dirname(options.execPath);
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (pathEntries.some((entry) => arePathEntriesEqual(entry, nodeDirectory, options.platform))) {
    return env;
  }

  const nodeExecutableName = options.platform === "win32" ? "node.exe" : "node";
  if (pathEntries.some((entry) => options.isExecutable(pathApi.join(entry, nodeExecutableName)))) {
    return env;
  }

  // remote Agent 由 ~/.zcode/server/node 启动，但登录环境 PATH 不含该目录，
  // Plugin manifest 中标准的 command: "node" 因此无法启动 MCP。复用当前 Agent 的 Node
  // 目录可保持插件配置跨本地/SSH/WSL/Docker 可移植，同时不覆盖插件显式注入的环境。
  return {
    ...env,
    [pathKey]: currentPath ? `${nodeDirectory}${pathDelimiter}${currentPath}` : nodeDirectory,
  };
}

function arePathEntriesEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalize = (value: string) => {
    const normalized = pathApi.normalize(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
