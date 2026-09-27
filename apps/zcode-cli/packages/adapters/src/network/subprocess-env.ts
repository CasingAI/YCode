import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
} from "@zcode/shared";

export interface NetworkEgressEnvPolicy {
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
  /**
   * 「网络」分区的原始代理材料（ZCODE_APP_HTTP_PROXY / ZCODE_APP_NO_PROXY），不经全局
   * 开关 gate。字段本身不参与出口决策：只有按 proxyMode 的分支（模型推理、单个 MCP server）
   * 会显式选用它，`httpProxy` 才是跟随全局开关的默认结果。
   */
  appHttpProxy?: string;
  appNoProxy?: string;
  /**
   * 操作系统代理材料（ZCODE_SYSTEM_HTTP_PROXY / ZCODE_SYSTEM_NO_PROXY），由 Host 在 spawn
   * 时解析 scutil / 注册表 / env 得到。同样只供按 proxyMode 的分支使用。
   */
  systemHttpProxy?: string;
  systemNoProxy?: string;
}

interface NetworkEgressEnvOptions {
  network?: NetworkEgressEnvPolicy;
  platform?: NodeJS.Platform;
  sourceEnv?: Record<string, string | undefined>;
  toolEnvPassthrough?: boolean;
}

const ALL_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;
const CA_SOURCE_KEYS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
] as const;
const CA_TARGET_KEYS = CA_SOURCE_KEYS;
const EXPLICIT_CA_SOURCE_KEYS = [ZCODE_AGENT_CA_CERT_ENV_KEY] as const;
const EXPLICIT_NO_PROXY_SOURCE_KEYS = [ZCODE_NO_PROXY_ENV_KEY] as const;

export function applyNetworkEgressEnv(
  env: Record<string, string>,
  options: NetworkEgressEnvOptions,
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.sourceEnv ?? {};
  const network = options.network ?? {};

  deleteEnvKey(env, ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, platform);
  if (options.toolEnvPassthrough !== false) {
    applyToolEnvPassthroughEnv(env, sourceEnv, platform);
  }
  applyProxyEnv(env, sourceEnv, network, platform);
  applyNoProxyEnv(env, sourceEnv, network, platform);
  applyCaEnv(env, sourceEnv, network, platform);
  return env;
}

/**
 * 显式剥掉 env 里的全部代理材料（HTTP(S)_PROXY / ALL_PROXY / NO_PROXY 的所有大小写变体，
 * 以及 ZCode 自家的一次性代理材料 ZCODE_HTTP_PROXY / ZCODE_NO_PROXY）。
 *
 * applyNetworkEgressEnv 只在有地址时「注入」代理 env，从不删除已存在的键，因此
 * 「强制直连」不能靠不传地址实现：sanitizeZCodeRuntimeEnv 剥掉的是父进程继承值，
 * 而 applyProxyEnv 仍会从 sourceEnv[ZCODE_HTTP_PROXY_ENV_KEY] 把一次性材料回填进来。
 * 直连语义要求子进程完全看不到代理材料，必须显式再剥一次。
 *
 * 刻意不碰 ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY：那个 blob 还携带与代理无关的其它透传键，
 * 整体删除会波及非代理用途。
 */
export function stripProxyEnvKeys(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  for (const key of [
    ...ALL_PROXY_KEYS,
    ...NO_PROXY_KEYS,
    ...EXPLICIT_NO_PROXY_SOURCE_KEYS,
    ZCODE_HTTP_PROXY_ENV_KEY,
  ]) {
    deleteEnvKey(env, key, platform);
  }
  return env;
}

function applyToolEnvPassthroughEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  const passthroughEnv = readZCodeToolEnvPassthroughEnv(sourceEnv);
  for (const [key, value] of Object.entries(passthroughEnv)) {
    setEnvKey(env, key, value, platform);
  }
}

function applyProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const configuredProxy = normalizeProxyValue(network.httpProxy);
  if (configuredProxy) {
    for (const key of ALL_PROXY_KEYS) {
      setEnvKey(env, key, configuredProxy, platform);
    }
    return;
  }

  const zcodeProxy = normalizeProxyValue(
    getFirstEnvValue(sourceEnv, [ZCODE_HTTP_PROXY_ENV_KEY], platform),
  );
  if (zcodeProxy) {
    for (const key of ALL_PROXY_KEYS) {
      setEnvKey(env, key, zcodeProxy, platform);
    }
    return;
  }
}

function applyNoProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const noProxy =
    normalizeEnvValue(network.noProxy) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_NO_PROXY_SOURCE_KEYS, platform);
  if (!noProxy) {
    return;
  }
  for (const key of NO_PROXY_KEYS) {
    setEnvKey(env, key, noProxy, platform);
  }
}

function applyCaEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const caCertFile =
    normalizeEnvValue(network.caCertFile) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_CA_SOURCE_KEYS, platform);
  if (!caCertFile) {
    return;
  }
  for (const key of CA_TARGET_KEYS) {
    setEnvKey(env, key, caCertFile, platform);
  }
}

function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = normalizeEnvValue(value);
  if (!trimmed) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getFirstEnvValue(
  env: Record<string, string | undefined>,
  keys: readonly string[],
  platform: NodeJS.Platform,
): string | undefined {
  for (const key of keys) {
    const value = getEnvValue(env, key, platform);
    if (normalizeEnvValue(value)) {
      return value;
    }
  }
  return undefined;
}

function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvKey(env, key, platform);
  env[key] = value;
}

function deleteEnvKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }

  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerKey) {
      delete env[existingKey];
    }
  }
}

function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return env[key];
  }
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
