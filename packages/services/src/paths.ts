/* path 规则集中维护：旧 task 快照与 provider 配置路径仍在这里收口。 */
import { cp, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, win32 } from "node:path";
import { homedir } from "node:os";
import { DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE } from "@zcode/shared";
import { getYCodeIndependentDatabaseMode } from "@zcode/shared/node";

let _dataBaseDir: string | null = null;
export const ZCODE_WINDOWS_APP_INSTALL_DIR_ENV = "ZCODE_WINDOWS_APP_INSTALL_DIR";
const envDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || null;
// 真实主目录一律用 os.homedir()：Windows 的 HOME 常是 MSYS 风格（/c/Users/<name>），
// 直接拼路径会落到 C:\c\Users\<name> 这种错位目录（POSIX 上 os.homedir() 即 $HOME，
// 行为不变）。CLI 侧展开 "~" 用的也是 homedir()，两边必须同源。
const defaultDataBaseDir = homedir();

interface DataBaseDirTargetValidationOptions {
  platform?: NodeJS.Platform | string;
  env?: Record<string, string | undefined>;
  appInstallDir?: string | null;
}

type DataBaseDirTargetValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE;
      forbiddenDir: string;
    };

/** Set the base directory for app data (replaces homedir() prefix). */
export function setDataBaseDir(dir: string | null): void {
  _dataBaseDir = dir?.trim() || null;
}

/** Get the current base directory. Priority: setDataBaseDir() > env ZCODE_DATA_BASE_DIR > homedir(). */
export function getDataBaseDir(): string {
  if (_dataBaseDir) return _dataBaseDir;
  if (envDataBaseDir) return envDataBaseDir;
  // 服务实例会启动后台刷新任务；若每次调用都动态读取 HOME，
  // 测试或宿主切换环境变量后，旧实例可能把数据写到新实例目录。
  return defaultDataBaseDir;
}

/** {dataBaseDir}/.zcode */
export function getZCodeDataRootDir(): string {
  return join(getDataBaseDir(), ".zcode");
}

/**
 * 共享数据根：真实用户主目录下的 .zcode，**不跟随渠道隔离根**。
 *
 * 渠道隔离根（ZCODE_DATA_BASE_DIR）只隔离非数据库数据；任务索引库必须与官方 ZCode、
 * CLI 会话库落在同一个 home，否则每个渠道各持一份任务历史，侧边栏看不到对方的会话
 * （docs/specs/desktop-database-channel-sharing.md）。
 */
function getSharedDataRootDir(): string {
  return join(homedir(), ".zcode");
}

/** 共享数据根下的 v2 目录：任务索引库、automation、off-peak 库的位置。 */
function getSharedAppConfigDir(): string {
  return join(getSharedDataRootDir(), "v2");
}

/** {dataBaseDir}/.ycode：YCode 专属用户配置根（docs/specs/ycode-user-config-isolation.md）。 */
export function getYCodeDataRootDir(): string {
  return join(getDataBaseDir(), ".ycode");
}

/** {dataBaseDir}/.ycode/v2 */
export function getYCodeAppConfigDir(): string {
  return join(getYCodeDataRootDir(), "v2");
}

/** {dataBaseDir}/.ycode/v2/provider_config.json：Provider 个人配置唯一写入目标。 */
export function getPersonalProviderConfigPath(): string {
  return join(getYCodeAppConfigDir(), "provider_config.json");
}

/** {dataBaseDir}/.ycode/v2/tasks-index.sqlite：独立模式下的全新库位置。 */
export function getYCodeTasksIndexDatabasePath(): string {
  return join(getYCodeAppConfigDir(), "tasks-index.sqlite");
}

/**
 * 非项目对话共享的真实工作目录；默认 ~/.zcode/workspace/default。
 *
 * 该目录是共享会话库里的寻址键（会话 cwd）：跟随隔离根会在同一份共享库里留下两条
 * default 谱系，侧边栏多出一个"默认工作区"分组。它是空的暂存目录，共享不泄露数据。
 */
export function getConversationWorkspaceDir(): string {
  if (getYCodeIndependentDatabaseMode()) return join(getZCodeDataRootDir(), "workspace", "default");
  return join(getSharedDataRootDir(), "workspace", "default");
}

/** {dataBaseDir}/.zcode/v2 */
export function getAppConfigDir(): string {
  return join(getZCodeDataRootDir(), "v2");
}

function readEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]?.trim();
  if (direct) {
    return direct;
  }

  const lowerKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(env)) {
    if (candidateKey.toLowerCase() !== lowerKey) {
      continue;
    }
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function normalizeWindowsComparablePath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = win32.normalize(trimmed).replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }

  return win32
    .resolve(normalized)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWindowsPathEqualOrInside(pathValue: string, rootValue: string): boolean {
  const normalizedPath = normalizeWindowsComparablePath(pathValue);
  const normalizedRoot = normalizeWindowsComparablePath(rootValue);
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function collectWindowsForbiddenAppInstallDirs(
  options: Required<Pick<DataBaseDirTargetValidationOptions, "env">> &
    Pick<DataBaseDirTargetValidationOptions, "appInstallDir">,
): string[] {
  const env = options.env;
  const programFiles = readEnvValue(env, "ProgramFiles");
  const programFilesX86 = readEnvValue(env, "ProgramFiles(x86)");
  const programW6432 = readEnvValue(env, "ProgramW6432");
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  const candidates = [
    options.appInstallDir,
    readEnvValue(env, ZCODE_WINDOWS_APP_INSTALL_DIR_ENV),
    programFiles ? win32.join(programFiles, "ZCode") : null,
    programFilesX86 ? win32.join(programFilesX86, "ZCode") : null,
    programW6432 ? win32.join(programW6432, "ZCode") : null,
    localAppData ? win32.join(localAppData, "Programs", "ZCode") : null,
  ];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" ? normalizeWindowsComparablePath(candidate) : null;
    if (!candidate || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(candidate);
  }

  return result;
}

export function validateDataBaseDirTarget(
  targetBaseDir: string,
  options: DataBaseDirTargetValidationOptions = {},
): DataBaseDirTargetValidationResult {
  if ((options.platform ?? process.platform) !== "win32") {
    return { ok: true };
  }

  for (const forbiddenDir of collectWindowsForbiddenAppInstallDirs({
    env: options.env ?? process.env,
    appInstallDir: options.appInstallDir ?? null,
  })) {
    if (isWindowsPathEqualOrInside(targetBaseDir, forbiddenDir)) {
      return {
        ok: false,
        code: DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
        forbiddenDir,
      };
    }
  }

  return { ok: true };
}

export function getExportLogStageDir(): string {
  return join(getZCodeDataRootDir(), "export-log-stage");
}

export function getExportLogDir(): string {
  return join(getZCodeDataRootDir(), "export-log");
}

export function getFeedbackRootDir(): string {
  return join(getZCodeDataRootDir(), "feedback");
}

export function getFeedbackAttachmentDir(): string {
  return join(getFeedbackRootDir(), "attachments");
}

export function getFeedbackLogArchiveDir(): string {
  return join(getFeedbackRootDir(), "logs");
}

export function getGitCheckpointIndexRootDir(): string {
  return join(getZCodeDataRootDir(), "git-checkpoint-index");
}

/**
 * 任务索引库路径。
 *
 * 共享模式：<home>/.zcode/v2/tasks-index.sqlite，**不跟随渠道隔离根**——各渠道必须
 * 共用同一份任务历史（docs/specs/desktop-database-channel-sharing.md）。
 * 独立模式：<dataBaseDir>/.ycode/v2/tasks-index.sqlite，完全隔离。
 */
export function getTasksIndexDatabasePath(): string {
  if (getYCodeIndependentDatabaseMode()) return getYCodeTasksIndexDatabasePath();
  return join(getSharedAppConfigDir(), "tasks-index.sqlite");
}

/** workspace 级身份键：远程优先使用 workspaceIdentity，本地回退 workspacePath。 */
function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 与 ZCode session 持久化一致：使用 workspaceKey 的 SHA-256 前 12 位 */
export function getWorkspaceHash(workspacePath: string, workspaceIdentity?: string): string {
  return createHash("sha256")
    .update(getWorkspaceKey(workspacePath, workspaceIdentity))
    .digest("hex")
    .slice(0, 12);
}

/**
 * ~/.zcode/v2/sessions/{workspaceHash}
 *
 * 会话快照不是数据库，按渠道隔离规则留在 app 配置根（隔离根生效）。
 */
function getTaskSessionDir(workspacePath: string, workspaceIdentity?: string): string {
  return join(getAppConfigDir(), "sessions", getWorkspaceHash(workspacePath, workspaceIdentity));
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json */
export function getLegacyTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.json`);
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.deleted.json */
export function getLegacyDeletedTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.deleted.json`);
}

/**
 * Copy the .zcode/v2 and .ycode/v2 data directories when the user changes the base dir.
 * Excludes setting.json and its transient atomic-write siblings — bootstrap
 * state must only live at the default homedir location.
 */
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  for (const root of [".zcode", ".ycode"]) {
    const oldDir = join(oldBaseDir, root, "v2");
    const newDir = join(newBaseDir, root, "v2");
    try {
      await lstat(oldDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await cp(oldDir, newDir, {
      recursive: true,
      force: false,
      filter: async (source) => {
        const sourceName = basename(source);
        if (sourceName === "setting.json" || sourceName.startsWith("setting.json.")) {
          // setting.json.lock 和 setting.json.*.tmp 由原子写入短暂创建/删除，
          // 复制过程中扫描到已消失的 lock 会触发 ENOENT，并让数据目录迁移失败。
          // 这些文件都属于 bootstrap 写入中间态，不能迁移到新数据根。
          return false;
        }
        if (sourceName === "tasks-index.sqlite" || sourceName.startsWith("tasks-index.sqlite-")) {
          // 任务索引库固定在共享数据根（真实 home），唯一 owner 只有一个；
          // 搬迁时复制一份到新数据根会留下永远不被读取的副本。
          return false;
        }
        // Windows 非提权环境下 fs.cp 无法复制符号链接（EPERM）。
        // 跳过符号链接可避免 Windows 非提权环境下 fs.cp 报 EPERM。
        try {
          if ((await lstat(source)).isSymbolicLink()) return false;
        } catch {
          // lstat 失败时放行，让 cp 自行处理
        }
        return true;
      },
    });
  }
}
