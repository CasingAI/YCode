/**
 * 构建期下载上游 release 资产的统一实现（cloudflared / CLI Proxy 共用）。
 *
 * 依据：docs/specs/mobile-remote-control.md「下载策略」、
 *      docs/specs/plugin-cli-proxy-binary.md「内置分发」。
 *
 * 为什么需要这一层：Node 原生 fetch 不认代理环境变量，而 GitHub 直连在部分
 * 网络环境会被重置（实测 ECONNRESET / UND_ERR_CONNECT_TIMEOUT）。单次 fetch
 * 失败只能说明"这一次没连上"，不能判定"下载不到"。因此下载必须：
 *   1. 有代理环境变量时走 curl（curl 原生认代理）；
 *   2. 无代理变量时先 curl 直连（带重试与连接超时），失败再回退 fetch；
 *   3. 全部失败时给出中文错误与处置办法（设置代理环境变量），而不是未捕获异常。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import process from "node:process";

/** fetch 回退通道的重试次数（不含首次）。 */
const FETCH_RETRY_DELAYS_MS = [1000, 3000, 5000];

/**
 * 解析该 URL 应使用的代理地址。
 *
 * - https 优先 `https_proxy`，否则回退 `http_proxy`；
 * - 变量名大小写都认（`https_proxy` 与 `HTTPS_PROXY`）；
 * - 没有可用代理时返回 `null`（走直连）。
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
 */
export function buildCurlArgs(url, dest, capabilities, proxyUrl = null) {
  const args = ["-fsSL"];
  if (capabilities.retryAllErrors) {
    args.push("--retry", "5", "--retry-all-errors");
  } else {
    args.push("--retry", "5");
  }
  if (capabilities.retryDelay) args.push("--retry-delay", "2");
  if (capabilities.connectTimeout) args.push("--connect-timeout", "20");
  if (proxyUrl) args.push("--proxy", proxyUrl);
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
 * 下载一个 release 资产到本地文件。
 *
 * 失败时抛出的错误是中文的，并写明：目标地址、用过的通道、最后一个错误原因、
 * 以及"直连被拒时如何用代理环境变量解决"。
 *
 * `options.runCurl` / `options.fetchImpl` 供单测注入替身使用。
 */
export async function downloadReleaseAsset(url, dest, options = {}) {
  const env = options.env ?? process.env;
  const proxyUrl = resolveProxyUrl(url, env);
  const capabilities = options.capabilities ?? detectCurlCapabilities();
  const runCurl = options.runCurl ?? runCurlProcess;
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = [];

  if (capabilities.available) {
    const viaProxy = proxyUrl ? `curl（代理 ${proxyUrl}）` : "curl（直连）";
    const result = runCurl(buildCurlArgs(url, dest, capabilities, proxyUrl));
    if (result.ok) return dest;
    attempts.push(`${viaProxy}：${result.reason}`);
  } else {
    attempts.push("curl：不可用");
  }

  // 代理环境变量存在却仍下载失败时不再重复走 fetch（fetch 不认代理），
  // 直接把代理通道的失败原因抛出去，避免用一条注定不通的通道刷时间。
  if (proxyUrl) {
    await rm(dest, { force: true });
    throw new Error(
      `下载失败：${url}\n已尝试：${attempts.join("；")}\n` +
        `代理 ${proxyUrl} 未能下载成功，请确认代理可用后重试。`,
    );
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
