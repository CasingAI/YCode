#!/usr/bin/env node
// CLI Proxy 内置二进制准备：构建期从上游 release 下载目标平台资产，
// sha256 校验后解压可执行文件到 bundled-tools/<platform>-<arch>/cli-proxy/。
//
// 依据：docs/specs/plugin-cli-proxy-binary.md「内置分发」。
// 版本钉死 8.0.27（真机验证过）；二进制不进 git（bundled-tools 已在 .gitignore）。
// macOS 做可执行位 + ad-hoc 签名，未签名 arm64 会被内核拒绝执行。
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");

const CLI_PROXY_VERSION = "8.0.27";
const CLI_PROXY_REPO = "router-for-me/CLIProxyAPI";

// 上游 checksums.txt 实测值（构建期再拉取核对，不一致则失败）。
const EXPECTED_SHA256 = {
  "darwin-arm64": "d9bf58db6e07d0f587a248abc4a1099178fbec1d659d874c961d8caf3495a09e",
  "darwin-x64": "8ca6317fe7560a0452d2835f296a6360de8bc88099670c68635fd1cf4132c8d5",
  "linux-arm64": "5ef174b13320d2061dc33cb0ee3db31dbbf2cd947ab2e02edd5b16ac035e8b2a",
  "linux-x64": "82d38c89a62a2787f91e244595e0e76e52d6caaf2aa3d1a19b617e554c72b449",
  "win32-x64": "ac6867818696aefe299c8bac1730f831cbb127f0854acca1b1aebb0110a5dc53",
  "win32-arm64": "2787715038fc75a938f79567523ded1f984e1d75610df9c21830dcd8583bbe41",
};

function upstreamAssetName(version, targetKey) {
  const [platform, arch] = targetKey.split("-");
  const upstreamPlatform = platform === "win32" ? "windows" : platform;
  const upstreamArch = arch === "arm64" ? "aarch64" : "amd64";
  const extension = platform === "win32" ? "zip" : "tar.gz";
  return `CLIProxyAPI_${version}_${upstreamPlatform}_${upstreamArch}.${extension}`;
}

function binaryFileName(targetKey) {
  return targetKey.startsWith("win32") ? "cli-proxy-api.exe" : "cli-proxy-api";
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex").toLowerCase();
}

function proxyEnvFor(url) {
  // Node 原生 fetch 不认代理环境变量；本机直连 github 被拒时必须走代理
  // （依据 spec「下载需支持标准代理环境变量」）。有代理变量时改用 curl（原生认代理）。
  const lower = url.toLowerCase().startsWith("https:") ? "https_proxy" : "http_proxy";
  const pick = (name) => process.env[name] ?? process.env[name.toUpperCase()];
  return pick(lower) ?? pick("http_proxy") ?? pick("https_proxy") ?? null;
}

async function downloadToFile(url, dest) {
  if (proxyEnvFor(url)) {
    runOrThrow("curl", ["-fsSL", "--retry", "3", "-o", dest, url], process.cwd());
    return;
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${url}`);
  const { createWriteStream: cws } = await import("node:fs");
  await pipeline(response.body, cws(dest));
}

async function findBinary(dir) {
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isFile()) {
        const lowered = entry.name.toLowerCase();
        if (lowered.includes("cliproxy") || lowered.includes("cli-proxy")) return absolute;
      }
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        return await visit(join(current, entry.name));
      } catch {
        // 继续找下一个目录。
      }
    }
    throw new Error(`压缩包内未找到 CLI Proxy 二进制：${dir}`);
  };
  return visit(dir);
}

function runOrThrow(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`命令失败：${command} ${args.join(" ")}`);
}

const target = getTargetPlatform();
const targetKey = target.key;
// 三方对账入口：构建期/打包期/运行时全部收敛到同一 key（依据 spec「内置分发」）。
console.log(`[prepare:cli-proxy] 目标平台 key=${targetKey}（os=${target.os} arch=${target.arch}）`);
const expectedSha = EXPECTED_SHA256[targetKey];
if (!expectedSha) throw new Error(`CLI Proxy 暂不支持目标平台：${targetKey}`);
const outDir = join(desktopRoot, "bundled-tools", targetKey, "cli-proxy");
const outBinary = join(outDir, binaryFileName(targetKey));
const versionFile = join(outDir, "VERSION");

// 缓存命中也必须与钉死版本比对（VERSION 标记缺失或版本不符就重新下载），
// 否则旧二进制会绕过上方的 sha256 期望、被静默打进安装包。
try {
  const st = await stat(outBinary);
  const executable =
    st.isFile() && (targetKey.startsWith("win32") || (st.mode & 0o111) !== 0);
  const stampedVersion = await readFile(versionFile, "utf8").catch(() => null);
  if (executable && stampedVersion?.trim() === CLI_PROXY_VERSION) {
    console.log(`[prepare:cli-proxy] 已就绪（${CLI_PROXY_VERSION}），跳过下载：${outBinary}`);
    process.exit(0);
  }
  console.log(
    `[prepare:cli-proxy] 缓存失效（version=${stampedVersion?.trim() ?? "缺失"} 期望=${CLI_PROXY_VERSION}），重新下载`,
  );
} catch (error) {
  // 不存在则继续下载；VERSION 读取失败已在上方兜底为失效。
  if (error instanceof Error && !/ENOENT/.test(error.message)) throw error;
}

const assetName = upstreamAssetName(CLI_PROXY_VERSION, targetKey);
const assetUrl = `https://github.com/${CLI_PROXY_REPO}/releases/download/v${CLI_PROXY_VERSION}/${assetName}`;
const workDir = join(tmpdir(), `cliproxy-bundled-${Date.now()}`);
mkdirSync(workDir, { recursive: true });
try {
  const archivePath = join(workDir, assetName);
  console.log(`[prepare:cli-proxy] 下载 ${assetUrl}`);
  await downloadToFile(assetUrl, archivePath);
  const actualSha = await sha256File(archivePath);
  if (actualSha !== expectedSha.toLowerCase()) {
    throw new Error(`CLI Proxy 校验失败：期望 ${expectedSha}，实际 ${actualSha}`);
  }
  const extractDir = join(workDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    runOrThrow("unzip", ["-q", archivePath, "-d", extractDir], workDir);
  } else {
    runOrThrow("tar", ["-xzf", archivePath, "-C", extractDir], workDir);
  }
  const found = await findBinary(extractDir);
  rmSync(outDir, { force: true, recursive: true });
  mkdirSync(outDir, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  await copyFile(found, outBinary);
  if (!targetKey.startsWith("win32")) {
    await chmod(outBinary, 0o755);
    // macOS 未签名 arm64 会被内核拒绝执行：ad-hoc 签名（codesign -s -）。
    if (target.os === "darwin") {
      runOrThrow("codesign", ["-s", "-", "--force", outBinary], outDir);
    }
  }
  // 下载成功（sha256 已在上方校验）后再落盘版本标记；缺失即缺资产，打包期断言会阻断。
  await writeFile(versionFile, `${CLI_PROXY_VERSION}\n`, "utf8");
  console.log(`[prepare:cli-proxy] 就绪：${outBinary}`);
} finally {
  rmSync(workDir, { force: true, recursive: true });
}
