/**
 * 沙盒常驻 QuickJS Worker 的独立 CJS 产物（sandbox-worker.cjs）。
 *
 * zcode.cjs 是单文件 CJS bundle，import.meta 被 esbuild 降成空对象，不能靠
 * sibling .js + import.meta.url 拉起 Worker；Worker 入口必须与 bundle 同级。
 * quickjs.wasm 同样随产物分发，路径由主线程经 workerData 显式传给 Worker。
 *
 * 见 docs/specs/sandbox-system-tool.md「Worker 化与同步 FS」。
 */
import { build } from "esbuild";
import { resolve } from "node:path";
import { createQuickjsWasmPlugin } from "./quickjs-wasm-bundle.mjs";

/** 必须与 core/src/sandbox/worker-assets.ts 的文件名一致。 */
export const SANDBOX_WORKER_BUNDLE_NAME = "sandbox-worker.cjs";
/** 必须与 build-sea.mjs 的 asset 名一致。 */
export const SANDBOX_WORKER_SEA_ASSET_NAME = "sandbox-worker";

/**
 * 注入主 bundle 顶部：定位同级 sandbox-worker.cjs 与 quickjs.wasm。
 * 挂到 globalThis，因为 core 代码在 esbuild 模块闭包里看不到 banner 的局部函数。
 * SEA 首次使用时为当前进程建独立临时目录，把本进程内嵌的两个 asset 写入同一目录再使用：
 * 固定路径 + existsSync 会在发布更新后复用旧 worker/wasm，且 asset 缺失时静默沿用旧缓存。
 * 缺任一资产显式抛错，绝不回退到旧文件或主线程 VM。
 */
export const SANDBOX_WORKER_BANNER = `
function __zcodeSandboxWorkerAssets() {
  if (__zcodeSandboxWorkerAssets.cached) return __zcodeSandboxWorkerAssets.cached;
  var path = require("node:path");
  var url = require("node:url");
  var fs = require("node:fs");
  var sea;
  try { sea = require("node:sea"); } catch (error) { sea = undefined; }
  if (sea && typeof sea.isSea === "function" && sea.isSea()) {
    var os = require("node:os");
    function readSeaAsset(name) {
      var bytes = sea.getRawAsset(name);
      if (!bytes || typeof bytes.byteLength !== "number") {
        throw new Error("Sandbox worker SEA asset is missing: " + name);
      }
      return Buffer.from(bytes);
    }
    // 先读齐再落盘：缺 asset 时不留下半套文件；两 asset 必然来自同一 SEA 资产集。
    var wasmBytes = readSeaAsset("quickjs-wasm");
    var workerBytes = readSeaAsset("${SANDBOX_WORKER_SEA_ASSET_NAME}");
    // 每进程独享目录：不同版本 / 多进程各写各的，绝不复用或覆写对方仍在使用的产物。
    var base = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-sandbox-worker-"));
    var seaWasm = path.join(base, "quickjs.wasm");
    var seaWorker = path.join(base, "${SANDBOX_WORKER_BUNDLE_NAME}");
    fs.writeFileSync(seaWasm, wasmBytes);
    fs.writeFileSync(seaWorker, workerBytes);
    __zcodeSandboxWorkerAssets.cached = { workerUrl: url.pathToFileURL(seaWorker).href, wasmPath: seaWasm };
    return __zcodeSandboxWorkerAssets.cached;
  }
  var workerPath = path.join(__dirname, "${SANDBOX_WORKER_BUNDLE_NAME}");
  var wasmPath = path.join(__dirname, "quickjs.wasm");
  if (!fs.existsSync(workerPath)) {
    throw new Error("Sandbox worker entry is missing: " + workerPath);
  }
  if (!fs.existsSync(wasmPath)) {
    throw new Error("Sandbox worker wasm asset is missing: " + wasmPath);
  }
  __zcodeSandboxWorkerAssets.cached = { workerUrl: url.pathToFileURL(workerPath).href, wasmPath: wasmPath };
  return __zcodeSandboxWorkerAssets.cached;
}
globalThis.__zcodeSandboxWorkerAssets = __zcodeSandboxWorkerAssets;
`;

export function sandboxWorkerOutfile(cliDirectory) {
  return resolve(cliDirectory, "dist", SANDBOX_WORKER_BUNDLE_NAME);
}

export async function buildSandboxWorker({ cliDirectory, minify = false, sourcemap = false } = {}) {
  const outfile = sandboxWorkerOutfile(cliDirectory);
  await build({
    bundle: true,
    entryPoints: [resolve(cliDirectory, "../core/src/sandbox/worker/sandbox-worker-entry.ts")],
    outfile,
    format: "cjs",
    platform: "node",
    target: "node22",
    minify,
    keepNames: minify,
    sourcemap,
    legalComments: "none",
    logLevel: "info",
    // quickjs-wasi 默认读 import.meta 的 wasm；Worker 经 workerData 传 wasm，
    // 仍改写定位写法，避免 CJS 下的空 import.meta 触发告警或误读。
    plugins: [createQuickjsWasmPlugin()],
  });
  return outfile;
}
