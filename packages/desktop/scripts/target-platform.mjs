import process from "node:process";

function normalizeTargetOs(rawOs) {
  const value = (rawOs ?? "").toLowerCase();
  switch (value) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported target OS: ${rawOs}`);
  }
}

function normalizeTargetArch(rawArch) {
  const value = (rawArch ?? "").toLowerCase();
  switch (value) {
    case "x64":
    case "amd64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported target arch: ${rawArch}`);
  }
}

export function getTargetPlatform() {
  const targetOs = process.env.ZCODE_TARGET_OS ?? process.platform;
  const targetArch = process.env.ZCODE_TARGET_ARCH ?? process.arch;
  const os = normalizeTargetOs(targetOs);
  const arch = normalizeTargetArch(targetArch);

  return {
    os,
    arch,
    key: `${os}-${arch}`,
    npmOs: os,
    npmCpu: arch,
    // 部分 Linux optional native 包声明了 libc=glibc。
    // 跨平台 prepare 时如果只传 --os/--cpu，npm 仍会按宿主机 libc 判定为不匹配，导致补装失败。
    npmLibc: os === "linux" ? "glibc" : undefined,
  };
}

export function resolvePlatformKeyForPackagedApp() {
  // 三方收敛到同一口径（依据 spec「内置分发」）：构建期 getTargetPlatform（支持
  // ZCODE_TARGET_OS/ZCODE_TARGET_ARCH 交叉编译覆盖）、打包期 electron-builder 的
  // targetPlatform.key、运行时 resolveBundledCliProxyDir 开发态候选，全部走这里。
  // 运行时未设置覆盖变量时与 process.platform-process.arch 一致，不改变行为。
  return getTargetPlatform().key;
}
