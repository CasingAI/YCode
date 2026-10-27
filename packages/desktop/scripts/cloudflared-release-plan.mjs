/**
 * cloudflared 内置二进制的发布计划（构建期 / 打包期共用的唯一事实）。
 *
 * 依据：docs/specs/mobile-remote-control.md「公网临时链接（隧道 Provider 可选）」。
 * 准备脚本与 electron-builder 打包断言都从这里取，避免两处各写一份平台表。
 */

export const CLOUDFLARED_VERSION = "2026.10.4";
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
    sha256: "fdec0f9a1c726f4c10283fc0cd70e602d510c72887b737270433c81a08c883a9",
    archive: "tgz",
  },
  "darwin-arm64": {
    assetName: "cloudflared-darwin-arm64.tgz",
    sha256: "49e7963072b2ca83fb44c09f4d4a7cda52d390c0c9c6f55bac83454a5bc43910",
    archive: "tgz",
  },
  "linux-x64": {
    assetName: "cloudflared-linux-amd64",
    sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42",
    archive: "raw",
  },
  "linux-arm64": {
    assetName: "cloudflared-linux-arm64",
    sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6",
    archive: "raw",
  },
  "win32-x64": {
    assetName: "cloudflared-windows-amd64.exe",
    sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
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
