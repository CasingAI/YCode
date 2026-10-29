import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HISTORY_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/history-read-lane-worker-bundle.mjs";
import { SQLITE_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/sqlite-read-lane-worker-bundle.mjs";
import { SANDBOX_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/sandbox-worker-bundle.mjs";
import { QUICKJS_WASM_FILE_NAME } from "../apps/zcode-cli/packages/cli/scripts/quickjs-wasm-bundle.mjs";
import { readCliVersionSidecar } from "./cli-version-sidecar.mjs";

export function hasReusableDesktopAgentBundle(cliDistDirectory) {
  const requiredAssets = [
    "zcode.cjs",
    QUICKJS_WASM_FILE_NAME,
    HISTORY_READ_LANE_WORKER_BUNDLE_NAME,
    SQLITE_READ_LANE_WORKER_BUNDLE_NAME,
    SANDBOX_WORKER_BUNDLE_NAME,
  ];
  return (
    requiredAssets.every((assetName) => existsSync(resolve(cliDistDirectory, assetName))) &&
    Boolean(readCliVersionSidecar(cliDistDirectory))
  );
}
