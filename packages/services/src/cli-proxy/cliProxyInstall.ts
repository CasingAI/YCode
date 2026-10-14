/**
 * CLI Proxy 资产下载与安装 helper。
 *
 * 下载直写与 server-cli ReleaseDownloader 同语义（.part 临时文件、sha256 强校验），
 * 但 services 不能依赖 server-cli（依赖方向），故在此收敛最小实现。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { ProxyAgent, type Dispatcher } from "undici";
import {
  installCliProxyArchive,
  releaseDirId,
  type CliProxyLayout,
} from "./cliProxyVersions.js";
import type { CliProxyReleaseAsset } from "./cliProxy.js";

export async function findBinaryInDir(dir: string): Promise<string | null> {
  const visit = async (current: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lowered = entry.name.toLowerCase();
      if (lowered.includes("cliproxy") || lowered.includes("cli-proxy"))
        return join(current, entry.name);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await visit(join(current, entry.name));
      if (found) return found;
    }
    return null;
  };
  return visit(dir);
}

async function fetchArchiveToFile(
  url: string,
  temporary: string,
  expectedSha256: string,
): Promise<void> {
  await mkdir(dirname(temporary), { recursive: true });
  const dispatcher = resolveDownloadProxyDispatcher(url);
  const response = await fetchWithDispatcher(url, dispatcher);
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
  await pipeline(body, createWriteStream(temporary));
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(temporary)) digest.update(chunk as Buffer);
  const actual = digest.digest("hex");
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    await rm(temporary, { force: true });
    throw new Error(`下载校验失败：期望 ${expectedSha256}，实际 ${actual}`);
  }
}

/**
 * 标准代理环境变量（HTTPS_PROXY/HTTP_PROXY，大小写均可；NO_PROXY 匹配则直连）。
 *
 * 本机直连 github.com 被拒、需经本地代理（如 localhost:7890）的网络下，
 * 应用内下载若不支持这些变量必失败——此处是下载链路的唯一代理入口。
 * 纯函数：读 env、判 NO_PROXY、返回 ProxyAgent 或 undefined（直连）。
 */
export function resolveDownloadProxyDispatcher(
  requestUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
  if (matchesNoProxy(url.hostname, noProxy)) return undefined;
  const proxy =
    url.protocol === "https:"
      ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
      : (env.HTTP_PROXY ?? env.http_proxy ?? env.HTTPS_PROXY ?? env.https_proxy);
  const proxyUrl = proxy?.trim();
  if (!proxyUrl) return undefined;
  try {
    return new ProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

function matchesNoProxy(hostname: string, noProxy: string): boolean {
  const host = hostname.toLowerCase();
  return noProxy.split(/[\s,]+/).some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;
    const normalized = rule.replace(/^\./, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

async function fetchWithDispatcher(url: string, dispatcher: Dispatcher | undefined) {
  if (!dispatcher) return fetch(url, { redirect: "follow" });
  const { fetch: undiciFetch } = await import("undici");
  try {
    return (await undiciFetch(url, { redirect: "follow", dispatcher })) as unknown as Response;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

/** 下载资产 → 校验 → 解压安装 → 清临时文件；不切 active。 */
export async function downloadAndInstallRelease(
  layout: CliProxyLayout,
  asset: CliProxyReleaseAsset,
): Promise<void> {
  const temporary = join(
    layout.root,
    ".downloads",
    `${releaseDirId(asset.version, asset.target, asset.archiveSha256)}.part`,
  );
  await fetchArchiveToFile(asset.archiveUrl, temporary, asset.archiveSha256);
  try {
    await installCliProxyArchive({
      layout,
      archivePath: temporary,
      version: asset.version,
      target: asset.target,
      archiveSha256: asset.archiveSha256,
    });
  } finally {
    await rm(temporary, { force: true });
  }
}
