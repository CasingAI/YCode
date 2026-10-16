/**
 * CLI Proxy 上游 release 检查：GitHub Releases API + checksums.txt。
 *
 * 上游 `router-for-me/CLIProxyAPI` 的资产形态（实测 v8.0.27）：
 *   CLIProxyAPI_8.0.27_darwin_aarch64.tar.gz / linux_amd64 / windows_amd64.zip 等
 *   + checksums.txt（`<sha256>  <filename>` 每行）。
 * API 未认证时可能限流：失败只记日志、不抛错，调用方按"无更新"处理。
 */
import { z } from "zod";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  cliProxyAssetName,
  currentCliProxyTarget,
  type CliProxyTarget,
} from "./cliProxyVersions.js";
import type { CliProxyReleaseAsset } from "./cliProxy.js";

const logger = createServiceLogger("cliProxyReleases");

const githubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  assets: z.array(
    z.object({
      name: z.string().min(1),
      browser_download_url: z.string().url(),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

export const CLI_PROXY_RELEASE_REPO = "router-for-me/CLIProxyAPI";

function normalizeVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function compareVersions(left: string, right: string): number {
  return normalizeVersion(left).localeCompare(normalizeVersion(right), undefined, {
    numeric: true,
  });
}

export function isNewerVersion(candidate: string, current: string | null): boolean {
  if (!current) return true;
  return compareVersions(candidate, current) > 0;
}

/** 返回版本列表中语义上最高的版本；locale 字典序会误排 8.0.9 与 8.0.10。 */
export function getNewestVersion(versions: string[]): string | null {
  return versions.reduce<string | null>(
    (newest, version) => (newest === null || compareVersions(version, newest) > 0 ? version : newest),
    null,
  );
}

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub API failed: HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`checksums.txt download failed: HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/** 解析 checksums.txt：`<sha256><空格><文件名>` 每行，返回 文件名→sha256。 */
export function parseChecksumsFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (match?.[1] && match[2]) entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
}

export interface CliProxyUpdateCheck {
  latestVersion: string | null;
  asset: CliProxyReleaseAsset | null;
}

/**
 * 检查上游最新 release，返回可下载资产（当前平台）。
 * 网络失败/限流返回空结果，不抛错（更新检查不能挡启动）。
 */
export async function checkCliProxyUpdates(options?: {
  repo?: string;
  target?: CliProxyTarget;
}): Promise<CliProxyUpdateCheck> {
  const repo = options?.repo ?? CLI_PROXY_RELEASE_REPO;
  const target = options?.target ?? currentCliProxyTarget();
  try {
    const release = githubReleaseSchema.parse(
      await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`),
    );
    const version = normalizeVersion(release.tag_name);
    const assetName = cliProxyAssetName(version, target);
    const asset = release.assets.find((entry) => entry.name === assetName);
    if (!asset) {
      logger.warn("cli-proxy release has no asset for target", { version, target });
      return { latestVersion: version, asset: null };
    }
    // sha256 以 checksums.txt 为准（可信来源），不信任下载内容自證。
    const checksumsAsset = release.assets.find((entry) => entry.name === "checksums.txt");
    let archiveSha256: string | undefined;
    if (checksumsAsset) {
      const checksums = parseChecksumsFile(await fetchText(checksumsAsset.browser_download_url));
      archiveSha256 = checksums.get(assetName);
    }
    if (!archiveSha256) {
      logger.warn("cli-proxy checksums.txt missing asset entry", { version, assetName });
      return { latestVersion: version, asset: null };
    }
    return {
      latestVersion: version,
      asset: {
        version,
        target,
        archiveUrl: asset.browser_download_url,
        archiveSha256,
        ...(asset.size === undefined ? {} : { archiveSizeBytes: asset.size }),
      },
    };
  } catch (error) {
    // 未认证限流/断网：更新检查降级为无更新，不挡启动。
    logger.warn("cli-proxy update check failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { latestVersion: null, asset: null };
  }
}
