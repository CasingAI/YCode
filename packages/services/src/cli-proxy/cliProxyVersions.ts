/**
 * CLI Proxy 二进制版本管理：多版本保留 + 用户选 active + 内置兜底。
 *
 * 目录布局（沿用 server-cli releaseInstaller 的 `<version>-<target>-<sha12>` 思路，
 * 根目录改到二进制插件专属目录）：
 *   {dataBaseDir}/.zcode/cli-proxy/
 *     releases/<version>-<target>-<archiveSha12>/   用户下载的版本（多版本保留）
 *     bundled/<version>-<target>/                   内置基础版本（随应用分发，不可卸载）
 *     versions.json                                 已下载清单 + active 指针（唯一持久化所有者）
 *     auth/                                          OAuth 凭据目录（oauth.auth-dir，一账号一 JSON）
 *     management.key / data.key                      独立落盘令牌（0600；管理面 key 不进
 *                                                    provider 配置，data.key 会投影到依赖
 *                                                    provider 的 access.apiKey，见 cliProxy.ts）
 *     config.yaml                                   代理配置
 *
 * 与 server-cli ReleaseManager 的差异：这里需要多版本保留 + 用户可选 active，
 * server-cli 现只有单 current.json 指针，属本模块新写。
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { CliProxyDownloadedVersion, CliProxyVersionSource } from "./cliProxy.js";

export type CliProxyTarget = `${"darwin" | "win32" | "linux"}-${"arm64" | "x64"}`;

export function currentCliProxyTarget(): CliProxyTarget {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${arch}`;
}

/** 上游资产名：`CLIProxyAPI_8.0.27_darwin_aarch64.tar.gz`（aarch64/amd64/windows 非 node 命名）。 */
export function cliProxyAssetName(version: string, target: CliProxyTarget): string {
  const [platform, arch] = target.split("-") as ["darwin" | "win32" | "linux", "arm64" | "x64"];
  const upstreamPlatform = platform === "win32" ? "windows" : platform;
  const upstreamArch = arch === "arm64" ? "aarch64" : "amd64";
  const extension = platform === "win32" ? "zip" : "tar.gz";
  const tag = version.startsWith("v") ? version.slice(1) : version;
  return `CLIProxyAPI_${tag}_${upstreamPlatform}_${upstreamArch}.${extension}`;
}

export function resolveCliProxyRoot(dataBaseDir?: string): string {
  const base = dataBaseDir?.trim() || process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return resolve(base, ".zcode", "cli-proxy");
}

export interface CliProxyLayout {
  root: string;
  releasesDir: string;
  bundledDir: string;
  versionsFile: string;
  managementKeyFile: string;
  dataKeyFile: string;
  configFile: string;
  /** OAuth 凭据目录（config.yaml 的 oauth.auth-dir）：收敛进数据目录（2026-10-14 用户拍板，功能未上线无兼容包袱）。 */
  authDir: string;
}

export function resolveCliProxyLayout(root = resolveCliProxyRoot()): CliProxyLayout {
  return {
    root,
    releasesDir: join(root, "releases"),
    bundledDir: join(root, "bundled"),
    versionsFile: join(root, "versions.json"),
    managementKeyFile: join(root, "management.key"),
    dataKeyFile: join(root, "data.key"),
    configFile: join(root, "config.yaml"),
    authDir: join(root, "auth"),
  };
}


const versionsFileSchema = z.object({
  version: z.literal(1),
  activeVersionId: z.string().min(1).nullable(),
  versions: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      target: z.string().min(1),
      archiveSha256: z.string().regex(/^[a-f0-9]{64}$/i),
      dir: z.string().min(1),
      source: z.enum(["bundled", "downloaded"]),
      downloadedAt: z.string().min(1),
    }),
  ),
});

export interface CliProxyVersionsState {
  activeVersionId: string | null;
  versions: CliProxyDownloadedVersion[];
}

export async function readVersionsState(layout: CliProxyLayout): Promise<CliProxyVersionsState> {
  let raw: string;
  try {
    raw = await readFile(layout.versionsFile, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      return { activeVersionId: null, versions: [] };
    throw error;
  }
  try {
    const parsed = versionsFileSchema.parse(JSON.parse(raw));
    return {
      activeVersionId: parsed.activeVersionId,
      versions: parsed.versions.map((entry) => ({
        ...entry,
        source: entry.source as CliProxyVersionSource,
      })),
    };
  } catch {
    // 写坏的文件按空清单处理：内置兜底仍可被重新登记，不挡启动。
    return { activeVersionId: null, versions: [] };
  }
}

export async function writeVersionsState(
  layout: CliProxyLayout,
  state: CliProxyVersionsState,
): Promise<void> {
  await mkdir(dirname(layout.versionsFile), { recursive: true });
  const temporary = `${layout.versionsFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, layout.versionsFile);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** 版本目录名：`<version>-<target>-<archiveSha12>`，与 server-cli releaseId 同构。 */
export function releaseDirId(version: string, target: string, archiveSha256: string): string {
  return `${version}-${target}-${archiveSha256.slice(0, 12).toLowerCase()}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} failed (${code}): ${stderr}`));
    });
  });
}

/**
 * 上游 tar.gz 内是裸二进制：解压后找到可执行文件，保证可执行位。
 *
 * zip 路径走同进程解压会强制 0o600（server-cli componentCache.ts:163 的已知行为），
 * 因此对二进制资产统一：tar.gz 由系统 tar 保留 0o755；解压后仍显式 chmod 0o755 兜底。
 */
export async function installCliProxyArchive(options: {
  layout: CliProxyLayout;
  archivePath: string;
  version: string;
  target: string;
  archiveSha256: string;
}): Promise<CliProxyDownloadedVersion> {
  const { layout } = options;
  const actual = await sha256File(options.archivePath);
  if (actual.toLowerCase() !== options.archiveSha256.toLowerCase()) {
    throw new Error(
      `CLI Proxy archive checksum mismatch: expected ${options.archiveSha256}, received ${actual}`,
    );
  }
  const id = releaseDirId(options.version, options.target, options.archiveSha256);
  const dir = join(layout.releasesDir, id);
  await mkdir(layout.releasesDir, { recursive: true, mode: 0o700 });
  const incoming = `${dir}.incoming-${process.pid}-${Date.now()}`;
  await rm(incoming, { recursive: true, force: true });
  try {
    await mkdir(incoming, { recursive: true });
    if (options.archivePath.toLowerCase().endsWith(".zip")) {
      await run("unzip", ["-q", resolve(options.archivePath), "-d", incoming], incoming);
    } else {
      await run("tar", ["-xzf", resolve(options.archivePath), "-C", incoming], incoming);
    }
    const binaryPath = await locateCliProxyBinary(incoming);
    // 解压路径可能丢执行位（zip 强制 0o600）：显式 chmod 兜底。
    await chmod(binaryPath, 0o755);
    await ensureAdHocSignature(binaryPath);
    await rm(dir, { recursive: true, force: true });
    await rename(incoming, dir);
  } catch (error) {
    await rm(incoming, { recursive: true, force: true });
    throw error;
  }
  const downloadedAt = new Date().toISOString();
  const entry: CliProxyDownloadedVersion = {
    id,
    version: options.version,
    target: options.target,
    archiveSha256: options.archiveSha256.toLowerCase(),
    dir,
    source: "downloaded",
    downloadedAt,
  };
  const state = await readVersionsState(layout);
  const versions = [...state.versions.filter((version) => version.id !== id), entry];
  // 根因修复：此前无 active 时首个下载版本必须直接成为 active，
  // 否则自动下载永远用不上，启动永久报 binary-missing。
  await writeVersionsState(layout, {
    activeVersionId: state.activeVersionId ?? id,
    versions,
  });
  return entry;
}

async function locateCliProxyBinary(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isFile()) {
      const lowered = entry.name.toLowerCase();
      if (lowered.includes("cliproxy") || lowered.includes("cli-proxy")) return absolute;
    }
  }
  // 单层嵌套目录兜底（如资产内带顶层文件夹）。
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      return await locateCliProxyBinary(join(dir, entry.name));
    } catch {
      // 继续找下一个目录。
    }
  }
  // 实在找不到：目录内唯一可执行文件兜底。
  const candidates: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) candidates.push(absolute);
    }
  };
  await visit(dir);
  if (candidates.length === 1 && candidates[0]) return candidates[0];
  throw new Error(`CLI Proxy binary not found in archive: ${dir}`);
}

/**
 * Apple Silicon 上未签名的 arm64 二进制会被内核拒绝执行（与 quarantine 无关）。
 * 处理：ad-hoc 签名（`codesign -s -`）；非 macOS 直接跳过。
 * 不做去 quarantine，也不开启 LSFileQuarantineEnabled（见 spec）。
 */
export async function ensureAdHocSignature(binaryPath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await run("codesign", ["-s", "-", "--force", binaryPath], dirname(binaryPath));
  } catch (error) {
    throw new Error(
      `CLI Proxy ad-hoc sign failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 卸载一个用户下载的版本：只删该版本目录与登记。内置基础版本不可卸载。
 * 返回回落后的 active id（卸载 active 时回落到最近可用版本），调用方据此显式提示。
 */
export async function uninstallCliProxyVersion(
  layout: CliProxyLayout,
  id: string,
): Promise<{ fellBack: boolean; activeVersionId: string | null }> {
  const state = await readVersionsState(layout);
  const entry = state.versions.find((version) => version.id === id);
  if (!entry) throw new Error(`CLI Proxy version not found: ${id}`);
  if (entry.source === "bundled") throw new Error("内置基础版本不可卸载");
  await rm(entry.dir, { recursive: true, force: true });
  const versions = state.versions.filter((version) => version.id !== id);
  let activeVersionId = state.activeVersionId;
  let fellBack = false;
  if (activeVersionId === id) {
    // 回落：最近下载的用户版本优先，兜底内置基础版本。
    const fallback = [...versions].sort((left, right) =>
      right.downloadedAt.localeCompare(left.downloadedAt),
    )[0];
    activeVersionId = fallback?.id ?? null;
    fellBack = true;
  }
  await writeVersionsState(layout, { activeVersionId, versions });
  return { fellBack, activeVersionId };
}

/** 0600 独立落盘令牌：不存在则生成。 */
export async function ensureKeyFile(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const key = randomBytes(24).toString("base64url");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${key}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return key;
}

export async function readKeyFileIfExists(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    return undefined;
  }
}

export async function binaryExists(dir: string): Promise<boolean> {
  try {
    await locateCliProxyBinary(dir);
    return true;
  } catch {
    try {
      await stat(dir);
      return false;
    } catch {
      return false;
    }
  }
}
