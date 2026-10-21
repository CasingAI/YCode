export interface CurlCapabilities {
  available: boolean;
  retryAllErrors: boolean;
  retryDelay: boolean;
  connectTimeout: boolean;
}

export interface DownloadProxyResolution {
  proxyUrl: string | null;
  source: string;
}

export interface DownloadReleaseAssetOptions {
  env?: NodeJS.ProcessEnv;
  capabilities?: CurlCapabilities;
  runCurl?: (args: string[]) => { ok: boolean; reason?: string };
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
  systemProxyUrl?: string | null;
  localProxyUrl?: string | null;
}

export function resolveProxyUrl(url: string, env?: NodeJS.ProcessEnv): string | null;
export function normalizeProxyServer(value: string | undefined | null, isHttps?: boolean): string | null;
export function detectSystemProxyUrl(
  platform?: NodeJS.Platform,
  spawn?: typeof import("node:child_process").spawnSync,
): string | null;
export function probeLocalPort(port: number, timeoutMs?: number): Promise<boolean>;
export function detectLocalProxyUrl(
  ports?: number[],
  probe?: (port: number) => Promise<boolean>,
): Promise<string | null>;
export function resolveDownloadProxy(
  url: string,
  options?: DownloadReleaseAssetOptions,
): Promise<DownloadProxyResolution>;
export function detectCurlCapabilities(
  spawn?: typeof import("node:child_process").spawnSync,
): CurlCapabilities;
export function buildCurlArgs(
  url: string,
  dest: string,
  capabilities: CurlCapabilities,
  proxyUrl?: string | null,
  direct?: boolean,
): string[];
export function downloadReleaseAsset(
  url: string,
  dest: string,
  options?: DownloadReleaseAssetOptions,
): Promise<string>;
export function sha256File(path: string): Promise<string>;
