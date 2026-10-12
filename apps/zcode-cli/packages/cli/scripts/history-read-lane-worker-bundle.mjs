/**
 * History 只读旁路工作线程的独立 CJS 产物。
 * 桌面 / 远端 / 独立 CLI 跑的是单文件 zcode.cjs，esbuild 会把 import.meta 降成空对象，
 * 不能靠 sibling .js + import.meta.url 拉起线程。工作线程打成 zcode.cjs 同级文件。
 * 见 docs/specs/session-history-tools.md。
 */
import { build } from "esbuild";
import { resolve } from "node:path";

export const HISTORY_READ_LANE_WORKER_BUNDLE_NAME = "history-read-lane-worker.cjs";
export const HISTORY_READ_LANE_WORKER_SEA_ASSET_NAME = "history-read-lane-worker";

/**
 * 注入 CJS bundle 顶部：用 __dirname 找同级工作线程（与 quickjs wasm 同一套定位）。
 * 挂到 globalThis，因为 adapters 代码在 esbuild 模块闭包里看不到 banner 的局部函数。
 */
export const HISTORY_READ_LANE_WORKER_BANNER = `
function __zcodeHistoryReadLaneWorkerUrl() {
  if (__zcodeHistoryReadLaneWorkerUrl.cached) return __zcodeHistoryReadLaneWorkerUrl.cached;
  var path = require("node:path");
  var url = require("node:url");
  var fs = require("node:fs");
  var resolved;
  try {
    var sea = require("node:sea");
    if (sea.isSea()) {
      var os = require("node:os");
      var assetPath = path.join(os.tmpdir(), "zcode-history-read-lane-worker", "${HISTORY_READ_LANE_WORKER_BUNDLE_NAME}");
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      fs.writeFileSync(assetPath, Buffer.from(sea.getRawAsset("${HISTORY_READ_LANE_WORKER_SEA_ASSET_NAME}")));
      resolved = url.pathToFileURL(assetPath);
    }
  } catch (error) {
    resolved = undefined;
  }
  if (!resolved) {
    var sibling = path.join(__dirname, "${HISTORY_READ_LANE_WORKER_BUNDLE_NAME}");
    if (!fs.existsSync(sibling)) {
      throw new Error("History read lane worker entry is missing: " + sibling);
    }
    resolved = url.pathToFileURL(sibling);
  }
  __zcodeHistoryReadLaneWorkerUrl.cached = resolved;
  return resolved;
}
globalThis.__zcodeHistoryReadLaneWorkerUrl = __zcodeHistoryReadLaneWorkerUrl;
`;

export function historyReadLaneWorkerOutfile(cliDirectory) {
  return resolve(cliDirectory, "dist", HISTORY_READ_LANE_WORKER_BUNDLE_NAME);
}

export async function buildHistoryReadLaneWorker({
  cliDirectory,
  minify = false,
  sourcemap = false,
} = {}) {
  const outfile = historyReadLaneWorkerOutfile(cliDirectory);
  await build({
    bundle: true,
    entryPoints: [
      resolve(cliDirectory, "../adapters/src/storage/session-store/history-read-lane-worker.ts"),
    ],
    outfile,
    format: "cjs",
    platform: "node",
    target: "node22",
    minify,
    keepNames: minify,
    sourcemap,
    legalComments: "none",
    logLevel: "info",
  });
  return outfile;
}
