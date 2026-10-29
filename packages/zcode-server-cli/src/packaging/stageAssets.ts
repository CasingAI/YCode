import { access, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const HISTORY_READ_LANE_WORKER_BUNDLE_NAME = "history-read-lane-worker.cjs";
export const SQLITE_READ_LANE_WORKER_BUNDLE_NAME = "sqlite-read-lane-worker.cjs";
/** 必须与 cli/scripts/sandbox-worker-bundle.mjs 的文件名一致。 */
export const SANDBOX_WORKER_BUNDLE_NAME = "sandbox-worker.cjs";
/** 必须与 cli/scripts/quickjs-wasm-bundle.mjs 的文件名一致。 */
export const QUICKJS_WASM_FILE_NAME = "quickjs.wasm";

export interface AgentBundleAssets {
  bundlePath: string;
  historyReadLaneWorkerPath: string;
  sqliteReadLaneWorkerPath: string;
  sandboxWorkerPath: string;
  quickjsWasmPath: string;
}

export function resolveAgentBundleAssets(distDir: string): AgentBundleAssets {
  return {
    bundlePath: join(distDir, "zcode.cjs"),
    historyReadLaneWorkerPath: join(distDir, HISTORY_READ_LANE_WORKER_BUNDLE_NAME),
    sqliteReadLaneWorkerPath: join(distDir, SQLITE_READ_LANE_WORKER_BUNDLE_NAME),
    sandboxWorkerPath: join(distDir, SANDBOX_WORKER_BUNDLE_NAME),
    quickjsWasmPath: join(distDir, QUICKJS_WASM_FILE_NAME),
  };
}

export async function assertAgentBundleAssetsExist(assets: AgentBundleAssets): Promise<void> {
  for (const assetPath of Object.values(assets)) {
    await access(assetPath);
  }
}

export async function stageAgentBundleAssets(
  assets: AgentBundleAssets,
  runtimeDir: string,
): Promise<void> {
  await assertAgentBundleAssetsExist(assets);
  await mkdir(runtimeDir, { recursive: true });
  await Promise.all([
    cp(assets.bundlePath, join(runtimeDir, "zcode.cjs"), { dereference: true }),
    cp(assets.historyReadLaneWorkerPath, join(runtimeDir, HISTORY_READ_LANE_WORKER_BUNDLE_NAME), {
      dereference: true,
    }),
    cp(assets.sqliteReadLaneWorkerPath, join(runtimeDir, SQLITE_READ_LANE_WORKER_BUNDLE_NAME), {
      dereference: true,
    }),
    cp(assets.sandboxWorkerPath, join(runtimeDir, SANDBOX_WORKER_BUNDLE_NAME), {
      dereference: true,
    }),
    cp(assets.quickjsWasmPath, join(runtimeDir, QUICKJS_WASM_FILE_NAME), {
      dereference: true,
    }),
  ]);
}
