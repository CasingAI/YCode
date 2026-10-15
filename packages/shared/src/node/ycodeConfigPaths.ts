import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const YCODE_INDEPENDENT_DATABASE_ENV = "YCODE_INDEPENDENT_DATABASE";

export function resolveYCodeHomeDir(env = process.env): string {
  return (
    env.ZCODE_DESKTOP_HOME_DIR?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  );
}

export function resolveYCodeSettingsFile(homeDir = resolveYCodeHomeDir()): string {
  return join(homeDir, ".ycode", "v2", "setting.json");
}

export function resolveYCodeSubagentStatePath(
  storageRoot: string,
  homeDir = resolveYCodeHomeDir(),
): string {
  const root = resolve(storageRoot);
  return root === resolve(homeDir, ".zcode")
    ? join(homeDir, ".ycode", "v2", "agents-state.json")
    : join(root, ".ycode", "v2", "agents-state.json");
}

async function readYCodeStartupSettings(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(
      await readFile(resolveYCodeSettingsFile(resolveYCodeHomeDir(env)), "utf8"),
    );
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    return {};
  }
}

export async function resolveYCodeStartupDataBaseDir(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = env.ZCODE_DATA_BASE_DIR?.trim();
  if (explicit) return explicit;
  const settings = await readYCodeStartupSettings(env);
  return typeof settings.dataBaseDir === "string" && settings.dataBaseDir.trim()
    ? settings.dataBaseDir.trim()
    : resolveYCodeHomeDir(env);
}

let startupDatabaseMode: Promise<boolean> | undefined;
let independentDatabase = false;

export function initializeYCodeDatabaseMode(): Promise<boolean> {
  // 开关只在首次启动读取；后续 Agent 必须继承 Host 的有效模式，不能读取待重启偏好。
  startupDatabaseMode ??= (async () => {
    const inherited = process.env[YCODE_INDEPENDENT_DATABASE_ENV];
    if (inherited !== undefined) {
      if (inherited !== "true" && inherited !== "false")
        throw new Error("Invalid YCode database mode");
      independentDatabase = inherited === "true";
    } else {
      const settings = await readYCodeStartupSettings(process.env);
      independentDatabase = settings.useIndependentDatabase === true;
    }
    process.env[YCODE_INDEPENDENT_DATABASE_ENV] = String(independentDatabase);
    return independentDatabase;
  })();
  return startupDatabaseMode;
}

export function getYCodeIndependentDatabaseMode(): boolean {
  return independentDatabase;
}

export function resolveYCodeSessionDatabasePath(
  configured: string,
  homeDir = resolveYCodeHomeDir(),
): string {
  return independentDatabase && configured === "~/.zcode/cli/db/db.sqlite"
    ? join(homeDir, ".ycode", "cli", "db", "db.sqlite")
    : configured;
}
