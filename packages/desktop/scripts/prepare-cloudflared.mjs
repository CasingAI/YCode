#!/usr/bin/env node
// cloudflared 内置二进制准备：构建期从上游 release 下载目标平台资产，
// sha256 校验后取出可执行文件到 bundled-tools/<platform>-<arch>/cloudflared/。
//
// 依据：docs/specs/mobile-remote-control.md「公网临时链接（隧道 Provider 可选）」。
// 版本钉死 2026.9.1；二进制不进 git（bundled-tools 已在 .gitignore）。
// macOS 做可执行位 + ad-hoc 签名，未签名 arm64 会被内核拒绝执行。
//
// 上游没有 windows-arm64 资产：该平台跳过准备（不是构建失败），
// 运行时创建公网链接会明确提示"未找到内置 cloudflared"。
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
import {
  CLOUDFLARED_REPO,
  CLOUDFLARED_VERSION,
  cloudflaredBinaryFileName,
  resolveCloudflaredReleasePlan,
} from "./cloudflared-release-plan.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");

function binaryFileName(targetKey) {
  return cloudflaredBinaryFileName(targetKey);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex").toLowerCase();
}

function proxyEnvFor(url) {
  // Node 原生 fetch 不认代理环境变量；本机直连 github 被拒时必须走代理
  // （与 prepare-cli-proxy 同法）。有代理变量时改用 curl（原生认代理）。
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

async function findBinary(dir, expectedName) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === expectedName) {
      return join(dir, entry.name);
    }
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      return await findBinary(join(dir, entry.name), expectedName);
    } catch {
      // 继续找下一个目录。
    }
  }
  throw new Error(`压缩包内未找到 ${expectedName} 二进制：${dir}`);
}

function runOrThrow(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`命令失败：${command} ${args.join(" ")}`);
}

const target = getTargetPlatform();
const targetKey = target.key;
// 三方对账入口：构建期/打包期/运行时全部收敛到同一 key（依据 spec「内置分发」）。
console.log(`[prepare:cloudflared] 目标平台 key=${targetKey}（os=${target.os} arch=${target.arch}）`);
const release = resolveCloudflaredReleasePlan(targetKey);
if (release === undefined) {
  throw new Error(`cloudflared 暂不支持目标平台：${targetKey}`);
}
if (release === null) {
  // 上游没有该平台的资产：不是构建失败（公网链接只是可选能力），
  // 但必须说清楚，否则后面"公网链接不可用"会变成无头案。
  console.log(
    `[prepare:cloudflared] 上游未发布 ${targetKey} 的二进制，跳过准备（该平台将无法创建公网链接）`,
  );
  process.exit(0);
}

const outDir = join(desktopRoot, "bundled-tools", targetKey, "cloudflared");
const outBinary = join(outDir, binaryFileName(targetKey));
const versionFile = join(outDir, "VERSION");

// 缓存命中也必须与钉死版本比对（VERSION 标记缺失或版本不符就重新下载），
// 否则旧二进制会绕过上方的 sha256 期望、被静默打进安装包。
try {
  const st = await stat(outBinary);
  const executable =
    st.isFile() && (targetKey.startsWith("win32") || (st.mode & 0o111) !== 0);
  const stampedVersion = await readFile(versionFile, "utf8").catch(() => null);
  if (executable && stampedVersion?.trim() === CLOUDFLARED_VERSION) {
    console.log(
      `[prepare:cloudflared] 已就绪（${CLOUDFLARED_VERSION}），跳过下载：${outBinary}`,
    );
    process.exit(0);
  }
  console.log(
    `[prepare:cloudflared] 缓存失效（version=${stampedVersion?.trim() ?? "缺失"} 期望=${CLOUDFLARED_VERSION}），重新下载`,
  );
} catch (error) {
  // 不存在则继续下载；VERSION 读取失败已在上方兜底为失效。
  if (error instanceof Error && !/ENOENT/.test(error.message)) throw error;
}

const assetUrl = `https://github.com/${CLOUDFLARED_REPO}/releases/download/${CLOUDFLARED_VERSION}/${release.assetName}`;
const workDir = join(tmpdir(), `cloudflared-bundled-${Date.now()}`);
mkdirSync(workDir, { recursive: true });
try {
  const assetPath = join(workDir, release.assetName);
  console.log(`[prepare:cloudflared] 下载 ${assetUrl}`);
  await downloadToFile(assetUrl, assetPath);
  const actualSha = await sha256File(assetPath);
  if (actualSha !== release.sha256.toLowerCase()) {
    throw new Error(`cloudflared 校验失败：期望 ${release.sha256}，实际 ${actualSha}`);
  }
  let found = assetPath;
  if (release.archive === "tgz") {
    const extractDir = join(workDir, "extract");
    mkdirSync(extractDir, { recursive: true });
    runOrThrow("tar", ["-xzf", assetPath, "-C", extractDir], workDir);
    found = await findBinary(extractDir, "cloudflared");
  }
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
  await writeFile(versionFile, `${CLOUDFLARED_VERSION}\n`, "utf8");
  console.log(`[prepare:cloudflared] 就绪：${outBinary}`);
} finally {
  rmSync(workDir, { force: true, recursive: true });
}
