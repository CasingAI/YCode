/**
 * cloudflared 内置二进制的发布计划（构建期 / 打包期共用的唯一事实）。
 *
 * 依据：docs/specs/mobile-remote-control.md「公网临时链接（隧道 Provider 可选）」。
 * 准备脚本与 electron-builder 打包断言都从这里取，避免两处各写一份平台表。
 */

export const CLOUDFLARED_VERSION = "2026.9.1";
export const CLOUDFLARED_REPO = "cloudflare/cloudflared";

/**
 * 上游 release 资产与 sha256（取自 GitHub release asset 的 digest 字段）。
 *
 * - `archive: "tgz"`：压缩包，解压后取同名可执行文件；
 * - `archive: "raw"`：资产本身就是可执行文件。
 * - `null`：上游未发布该平台资产（当前只有 windows-arm64）。
 */
export const CLOUDFLARED_RELEASE_ASSETS = {
  "darwin-x64": {
    assetName: "cloudflared-darwin-amd64.tgz",
    sha256: "ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4",
    archive: "tgz",
  },
  "darwin-arm64": {
    assetName: "cloudflared-darwin-arm64.tgz",
    sha256: "c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe",
    archive: "tgz",
  },
  "linux-x64": {
    assetName: "cloudflared-linux-amd64",
    sha256: "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
    archive: "raw",
  },
  "linux-arm64": {
    assetName: "cloudflared-linux-arm64",
    sha256: "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
    archive: "raw",
  },
  "win32-x64": {
    assetName: "cloudflared-windows-amd64.exe",
    sha256: "2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712",
    archive: "raw",
  },
  // 上游未发布 windows-arm64 资产（只有 386/amd64/msi）。
  "win32-arm64": null,
};

/**
 * 取某个平台 key 的发布计划。
 *
 * - 返回 `null`：该平台上游没有资产 —— 打包时跳过内置，功能降级为"未内置"提示；
 * - 返回 `undefined`：平台 key 不认识 —— 属于配置错误，调用方应当报错。
 */
export function resolveCloudflaredReleasePlan(platformKey) {
  if (!Object.hasOwn(CLOUDFLARED_RELEASE_ASSETS, platformKey)) {
    return undefined;
  }
  return CLOUDFLARED_RELEASE_ASSETS[platformKey];
}

/** 该平台是否内置 cloudflared。 */
export function hasBundledCloudflared(platformKey) {
  return resolveCloudflaredReleasePlan(platformKey) !== null &&
    resolveCloudflaredReleasePlan(platformKey) !== undefined;
}

/** 内置二进制的文件名（Windows 带 .exe）。 */
export function cloudflaredBinaryFileName(platformKey) {
  return platformKey.startsWith("win32") ? "cloudflared.exe" : "cloudflared";
}
