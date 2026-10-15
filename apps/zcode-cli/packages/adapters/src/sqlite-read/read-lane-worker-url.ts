/**
 * 沙盒只读 SQLite 查询工作线程入口解析。
 * 桌面 / 远端跑的是 esbuild CJS 单文件 zcode.cjs，import.meta 会被降成空对象；
 * 对 import.meta.url 调 endsWith 会让沙盒 SQLite 查询全部 failed。
 * 见 docs/specs/sandbox-system-tool.md「宿主 SQLite」一节。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 必须与 cli/scripts/sqlite-read-lane-worker-bundle.mjs 的文件名一致。 */
export const SQLITE_READ_LANE_WORKER_BUNDLE_NAME = "sqlite-read-lane-worker.cjs";
/** adapters tsc 出盘的 sibling 文件名。 */
export const SQLITE_READ_LANE_WORKER_SOURCE_NAME = "read-lane-worker.js";
/** 必须与 SEA asset 名一致。 */
export const SQLITE_READ_LANE_WORKER_SEA_ASSET_NAME = "sqlite-read-lane-worker";

const TEST_WORKER_RELATIVE_FROM_SOURCE = "../../dist/sqlite-read/read-lane-worker.js";

export interface SqliteReadLaneWorkerUrlInput {
  metaUrl?: string;
  argv1?: string;
  bundledExists?: (absolutePath: string) => boolean;
  seaWorkerPath?: string;
}

export function resolveSqliteReadLaneWorkerUrl(input: SqliteReadLaneWorkerUrlInput = {}): URL {
  const metaUrl =
    typeof input.metaUrl === "string" && input.metaUrl.length > 0 ? input.metaUrl : undefined;
  // 源文件测试：tsx 无法把 worker 的 .js 说明符映射到 .ts，改拉编译产物。
  if (metaUrl?.endsWith(".ts")) {
    return new URL(TEST_WORKER_RELATIVE_FROM_SOURCE, metaUrl);
  }

  const exists = input.bundledExists ?? existsSync;
  for (const candidate of bundledWorkerCandidates(metaUrl, input.argv1)) {
    if (exists(candidate)) return pathToFileURL(candidate);
  }

  if (typeof input.seaWorkerPath === "string" && input.seaWorkerPath.length > 0) {
    return pathToFileURL(input.seaWorkerPath);
  }

  if (metaUrl) {
    return new URL(`./${SQLITE_READ_LANE_WORKER_SOURCE_NAME}`, metaUrl);
  }

  throw new Error(
    `Sqlite read lane worker entry is missing (${SQLITE_READ_LANE_WORKER_BUNDLE_NAME})`,
  );
}

export function sqliteReadLaneWorkerUrl(): URL {
  const located = readBundledSqliteReadLaneWorkerUrl();
  if (located) return located;
  return resolveSqliteReadLaneWorkerUrl({
    metaUrl: typeof import.meta.url === "string" ? import.meta.url : undefined,
    argv1: process.argv[1],
    seaWorkerPath: materializeSeaSqliteReadLaneWorker(),
  });
}

function readBundledSqliteReadLaneWorkerUrl(): URL | undefined {
  const locator = (globalThis as { __zcodeSqliteReadLaneWorkerUrl?: unknown })
    .__zcodeSqliteReadLaneWorkerUrl;
  if (typeof locator !== "function") return undefined;
  try {
    const located = locator();
    if (located instanceof URL) return located;
    if (typeof located === "string" && located.length > 0) return new URL(located);
  } catch {
    return undefined;
  }
  return undefined;
}

function bundledWorkerCandidates(metaUrl: string | undefined, argv1: string | undefined): string[] {
  const candidates: string[] = [];
  if (typeof argv1 === "string" && argv1.length > 0) {
    candidates.push(join(dirname(resolve(argv1)), SQLITE_READ_LANE_WORKER_BUNDLE_NAME));
  }
  if (metaUrl?.startsWith("file:")) {
    try {
      candidates.push(join(dirname(fileURLToPath(metaUrl)), SQLITE_READ_LANE_WORKER_BUNDLE_NAME));
    } catch {
      // import.meta.url 在 CJS 里可能是残缺值，忽略，改走 argv / SEA。
    }
  }
  return candidates;
}

function materializeSeaSqliteReadLaneWorker(): string | undefined {
  try {
    const href =
      typeof import.meta.url === "string" && import.meta.url.length > 0
        ? import.meta.url
        : pathToFileURL(join(tmpdir(), "sqlite-read-lane-require.js")).href;
    const sea = createRequire(href)("node:sea") as {
      isSea?: () => boolean;
      getRawAsset?: (name: string) => ArrayBuffer;
    };
    if (typeof sea.isSea !== "function" || !sea.isSea()) return undefined;
    if (typeof sea.getRawAsset !== "function") return undefined;
    const dest = join(
      tmpdir(),
      "zcode-sqlite-read-lane-worker",
      SQLITE_READ_LANE_WORKER_BUNDLE_NAME,
    );
    if (existsSync(dest)) return dest;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(sea.getRawAsset(SQLITE_READ_LANE_WORKER_SEA_ASSET_NAME)));
    return dest;
  } catch {
    return undefined;
  }
}
