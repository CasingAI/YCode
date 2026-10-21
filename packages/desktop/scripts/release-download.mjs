/**
 * 构建期下载上游 release 资产的统一实现（cloudflared / CLI Proxy 共用）。
 *
 * 依据：docs/specs/mobile-remote-control.md「下载策略」、
 *      docs/specs/plugin-cli-proxy-binary.md「内置分发」。
 *
 * 为什么需要这一层：Node 原生 fetch 既不认代理环境变量、也不认系统代理，而
 * GitHub 直连在部分网络环境会被重置（实测 ECONNRESET / UND_ERR_CONNECT_TIMEOUT）。
 * 单次失败只能说明"这一次没连上"，不能判定"下载不到"。因此下载必须：
 *   1. 依次尝试「代理通道 → 直连 curl → 直连 fetch」，任一成功即算完成；
 *   2. 代理来源有优先级：显式代理环境变量 > 本机系统代理设置（Windows 注册表 /
 *      macOS scutil），两者都没有才纯直连；
 *   3. 全部通道失败时给出中文错误与处置办法，而不是未捕获异常堆栈。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import net from "node:net";
import { pipeline } from "node:stream/promises";
import process from "node:process";

/** fetch 回退通道的重试间隔（不含首次尝试）。 */
const FETCH_RETRY_DELAYS_MS = [1000, 3000, 5000];

/** Windows 系统代理所在的注册表路径。 */
const WINDOWS_PROXY_REG_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * 本机常见代理端口（Clash / Clash Verge / v2rayN / SS 等的默认 HTTP 代理端口）。
 *
 * 只在没有显式代理配置、也读不到系统代理设置时才用：探到端口说明本机有代理
 * 在跑，直接拿来用，构建者不需要额外配置任何环境变量。
 */
const LOCAL_PROXY_PORTS = [7890, 7897, 10809, 1080, 8888, 8118, 10808];

/**
 * 解析该 URL 应使用的代理环境变量。
 *
 * - https 优先 `https_proxy`，否则回退 `http_proxy`；
 * - 变量名大小写都认（`https_proxy` 与 `HTTPS_PROXY`）；
 * - 没有可用代理时返回 `null`。
 */
export function resolveProxyUrl(url, env = process.env) {
  const pick = (name) => {
    const value = env[name] ?? env[name.toUpperCase()];
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  const isHttps = url.toLowerCase().startsWith("https:");
  const preferred = isHttps ? pick("https_proxy") : pick("http_proxy");
  return preferred ?? pick("http_proxy") ?? pick("https_proxy");
}

/**
 * 把系统代理里的 `host:port` 或 `http=host:port;https=host:port` 形式
 * 规整成可用的代理地址（补上 `http://` 协议前缀）。
 */
export function normalizeProxyServer(value, isHttps = true) {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw.includes("=")) {
    const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
    const picked =
      parts.find((part) => part.startsWith("https=")) ??
      parts.find((part) => part.startsWith("http=")) ??
      null;
    const endpoint = picked?.slice(picked.indexOf("=") + 1).trim();
    if (!endpoint) return null;
    return endpoint.includes("://") ? endpoint : `http://${endpoint}`;
  }
  void isHttps;
  return raw.includes("://") ? raw : `http://${raw}`;
}

function queryWindowsRegistryValue(spawn, valueName) {
  const result = spawn("reg", ["query", WINDOWS_PROXY_REG_KEY, "/v", valueName], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  const matched = new RegExp(`${valueName}\\s+REG_\\S+\\s+(.+)`).exec(result.stdout ?? "");
  return matched ? matched[1].trim() : null;
}

function detectWindowsSystemProxy(spawn) {
  const enabled = queryWindowsRegistryValue(spawn, "ProxyEnable");
  if (!enabled || !/0x1$/i.test(enabled)) return null;
  const server = queryWindowsRegistryValue(spawn, "ProxyServer");
  return normalizeProxyServer(server);
}

function detectDarwinSystemProxy(spawn) {
  const result = spawn("scutil", ["--proxy"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const text = result.stdout ?? "";
  const enabled = /HTTPSEnable\s*:\s*1/.test(text) || /HTTPEnable\s*:\s*1/.test(text);
  if (!enabled) return null;
  const host = /HTTPSProxy\s*:\s*(\S+)/.exec(text)?.[1] ?? /HTTPProxy\s*:\s*(\S+)/.exec(text)?.[1];
  const port = /HTTPSPort\s*:\s*(\d+)/.exec(text)?.[1] ?? /HTTPPort\s*:\s*(\d+)/.exec(text)?.[1];
  if (!host || !port) return null;
  return `http://${host}:${port}`;
}

/**
 * 读取本机系统代理设置（Windows 走注册表，macOS 走 scutil；Linux 只认环境变量）。
 *
 * 目的是让用户**什么都不用配**就能把构建期下载走通：系统里已经开好的代理
 * （Clash / v2rayN / 公司代理）会被自动使用；没有就返回 `null` 走直连。
 */
export function detectSystemProxyUrl(platform = process.platform, spawn = spawnSync) {
  try {
    if (platform === "win32") return detectWindowsSystemProxy(spawn);
    if (platform === "darwin") return detectDarwinSystemProxy(spawn);
    return null;
  } catch {
    // 探测失败不是致命问题：拿不到代理就走直连。
    return null;
  }
}

/** 探测 127.0.0.1 上某个端口是否有进程在监听。 */
export function probeLocalPort(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * 找出本机在跑的代理端口（Clash / v2rayN 等的默认端口）。
 *
 * 命中即用：使用者不需要在系统里挂代理、也不需要设环境变量，构建期下载
 * 照样能走通。端口全部不通时返回 `null`，调用方走直连。
 */
export async function detectLocalProxyUrl(ports = LOCAL_PROXY_PORTS, probe = probeLocalPort) {
  const results = await Promise.all(
    ports.map(async (port) => ({ port, open: await probe(port) })),
  );
  const hit = results.find((item) => item.open);
  return hit ? `http://127.0.0.1:${hit.port}` : null;
}

/**
 * 探测本机 curl 的可用性与可选参数支持情况。
 *
 * 精简版 curl（busybox 等）不支持 `--retry-all-errors` / `--retry-delay`，
 * 老版本 curl 也不支持，按能力拼装参数才不会直接失败退出。
 */
export function detectCurlCapabilities(spawn = spawnSync) {
  const result = spawn("curl", ["--help"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { available: false, retryAllErrors: false, retryDelay: false, connectTimeout: false };
  }
  const help = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    available: true,
    retryAllErrors: help.includes("--retry-all-errors"),
    retryDelay: help.includes("--retry-delay"),
    connectTimeout: help.includes("--connect-timeout"),
  };
}

/**
 * 拼装 curl 下载参数（纯函数，便于单测）。
 *
 * @param {string} url 资源地址
 * @param {string} dest 落盘路径
 * @param {ReturnType<typeof detectCurlCapabilities>} capabilities 本机 curl 能力
 * @param {string | null} proxyUrl 代理地址；非空时强制走代理
 * @param {boolean} direct 是否强制直连（屏蔽 curl 自带的代理环境变量）
 */
export function buildCurlArgs(url, dest, capabilities, proxyUrl = null, direct = false) {
  const args = ["-fsSL"];
  if (capabilities.retryAllErrors) {
    args.push("--retry", "5", "--retry-all-errors");
  } else {
    args.push("--retry", "5");
  }
  if (capabilities.retryDelay) args.push("--retry-delay", "2");
  if (capabilities.connectTimeout) args.push("--connect-timeout", "20");
  if (proxyUrl) {
    args.push("--proxy", proxyUrl);
  } else if (direct) {
    // 不给代理时必须显式屏蔽环境变量里的代理，否则"直连通道"其实还是走代理。
    args.push("--noproxy", "*");
  }
  args.push("-o", dest, url);
  return args;
}

function runCurlProcess(args) {
  const result = spawnSync("curl", args, { stdio: "inherit" });
  if (result.error) {
    return { ok: false, reason: `curl 不可用：${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `curl 退出码 ${result.status ?? "未知"}` };
  }
  return { ok: true };
}

async function downloadWithFetch(url, dest, fetchImpl, retryDelaysMs = FETCH_RETRY_DELAYS_MS) {
  let lastError = "未知错误";
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(response.body, createWriteStream(dest));
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < retryDelaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
  }
  return { ok: false, reason: lastError };
}

/**
 * 决定本次下载走哪个代理地址。
 *
 * 优先级：显式代理环境变量 → 仓库内已有的代理材料（`ZCODE_APP_HTTP_PROXY` /
 * `ZCODE_SYSTEM_HTTP_PROXY`）→ 本机系统代理设置 → 本机常见代理端口。
 * 都没有则返回 `null`（直连）。
 */
export async function resolveDownloadProxy(url, options = {}) {
  const env = options.env ?? process.env;
  const envProxy = resolveProxyUrl(url, env);
  if (envProxy) return { proxyUrl: envProxy, source: "代理环境变量" };
  const appProxy = (env.ZCODE_APP_HTTP_PROXY ?? env.ZCODE_SYSTEM_HTTP_PROXY)?.trim();
  if (appProxy) return { proxyUrl: appProxy, source: "应用代理配置" };
  if (options.systemProxyUrl !== undefined) {
    if (options.systemProxyUrl) return { proxyUrl: options.systemProxyUrl, source: "系统代理设置" };
  } else {
    const systemProxy = detectSystemProxyUrl();
    if (systemProxy) return { proxyUrl: systemProxy, source: "系统代理设置" };
  }
  if (options.localProxyUrl !== undefined) {
    if (options.localProxyUrl) return { proxyUrl: options.localProxyUrl, source: "本机代理端口" };
  } else {
    const localProxy = await detectLocalProxyUrl();
    if (localProxy) return { proxyUrl: localProxy, source: "本机代理端口" };
  }
  return { proxyUrl: null, source: "直连" };
}

/**
 * 下载一个 release 资产到本地文件。
 *
 * 通道顺序：代理（按优先级自动发现）→ 直连 curl → 直连 fetch。
 * 任一通道成功即返回；全部失败时抛中文错误，列出用过的通道与处置办法。
 *
 * `options.runCurl` / `options.fetchImpl` / `options.systemProxyUrl` /
 * `options.localProxyUrl` 供单测注入。
 */
export async function downloadReleaseAsset(url, dest, options = {}) {
  const { proxyUrl, source } = await resolveDownloadProxy(url, options);
  const capabilities = options.capabilities ?? detectCurlCapabilities();
  const runCurl = options.runCurl ?? runCurlProcess;
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = [];

  if (capabilities.available) {
    if (proxyUrl) {
      const result = runCurl(buildCurlArgs(url, dest, capabilities, proxyUrl));
      if (result.ok) return dest;
      attempts.push(`curl（代理 ${proxyUrl}，来源：${source}）：${result.reason}`);
    }
    // 直连通道：即使配了代理也再试一次，避免"配了代理但代理没开"直接卡死构建。
    const direct = runCurl(buildCurlArgs(url, dest, capabilities, null, true));
    if (direct.ok) return dest;
    attempts.push(`curl（直连）：${direct.reason}`);
  } else {
    attempts.push("curl：不可用");
  }

  const fetchResult = await downloadWithFetch(
    url,
    dest,
    fetchImpl,
    options.retryDelaysMs ?? FETCH_RETRY_DELAYS_MS,
  );
  if (fetchResult.ok) return dest;
  attempts.push(`fetch（直连）：${fetchResult.reason}`);
  await rm(dest, { force: true });
  throw new Error(
    `下载失败：${url}\n已尝试：${attempts.join("；")}\n` +
      "若本机直连 GitHub 被拒（连接重置/超时），请设置代理环境变量后重试：" +
      "例如 PowerShell 用 $env:HTTPS_PROXY='http://127.0.0.1:7890'。",
  );
}

/** 计算文件 sha256（小写十六进制）。 */
export async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex").toLowerCase();
}
