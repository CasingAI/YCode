export interface CurlCapabilities {
  available: boolean;
  retryAllErrors: boolean;
  retryDelay: boolean;
  connectTimeout: boolean;
}

export interface DownloadReleaseAssetOptions {
  env?: NodeJS.ProcessEnv;
  capabilities?: CurlCapabilities;
  runCurl?: (args: string[]) => { ok: boolean; reason?: string };
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

export function resolveProxyUrl(url: string, env?: NodeJS.ProcessEnv): string | null;
export function detectCurlCapabilities(
  spawn?: typeof import("node:child_process").spawnSync,
): CurlCapabilities;
export function buildCurlArgs(
  url: string,
  dest: string,
  capabilities: CurlCapabilities,
  proxyUrl?: string | null,
): string[];
export function downloadReleaseAsset(
  url: string,
  dest: string,
  options?: DownloadReleaseAssetOptions,
): Promise<string>;
export function sha256File(path: string): Promise<string>;
