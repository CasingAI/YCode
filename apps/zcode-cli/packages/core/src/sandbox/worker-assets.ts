// ============================================================
// Sandbox Worker 资产定位（worker 入口 + quickjs.wasm）
// ============================================================
// 生产产物里 import.meta 被 esbuild 降成空对象，不能靠它找 sibling；
// CLI 入口 banner 注入 __zcodeSandboxWorkerAssets()（SEA 物化 / 同级文件）。
// 源文件测试（tsx）直接指向 ./worker/sandbox-worker-entry.ts，由 tsx 加载。
// 缺任一资产显式抛错，绝不静默回退主线程 VM。

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 必须与 cli/scripts/quickjs-wasm-bundle.mjs 的文件名一致。 */
const QUICKJS_WASM_FILE_NAME = "quickjs.wasm";

/** 必须与 cli/scripts/sandbox-worker-bundle.mjs 的文件名一致。 */
export const SANDBOX_WORKER_BUNDLE_NAME = "sandbox-worker.cjs";
/** 必须与 SEA asset 名一致。 */
export const SANDBOX_WORKER_SEA_ASSET_NAME = "sandbox-worker";
/** tsx 源文件模式的 Worker 引导（Worker 内显式注册 tsx 后再加载 .ts 入口）。 */
export const SANDBOX_WORKER_TSX_BOOTSTRAP_RELATIVE = "./worker/tsx-worker-bootstrap.mjs";
/** tsc 出盘的 sibling 入口（编译后测试/嵌入场景）。 */
export const SANDBOX_WORKER_MODULE_RELATIVE = "./worker/sandbox-worker-entry.js";

export interface SandboxWorkerAssets {
  workerUrl: URL;
  wasmPath: string;
}

export interface ResolveSandboxWorkerAssetsInput {
  metaUrl?: string;
  workerUrl?: URL;
  wasmPath?: string;
  fileExists?: (absolutePath: string) => boolean;
}

export function resolveSandboxWorkerAssets(
  input: ResolveSandboxWorkerAssetsInput = {},
): SandboxWorkerAssets {
  const exists = input.fileExists ?? existsSync;
  if (input.workerUrl && input.wasmPath) {
    return { workerUrl: input.workerUrl, wasmPath: input.wasmPath };
  }

  const bannerAssets = readBannerAssets(exists);
  if (bannerAssets) {
    return {
      workerUrl: input.workerUrl ?? bannerAssets.workerUrl,
      wasmPath: input.wasmPath ?? bannerAssets.wasmPath,
    };
  }

  const metaUrl =
    typeof input.metaUrl === "string" && input.metaUrl.length > 0
      ? input.metaUrl
      : typeof import.meta.url === "string" && import.meta.url.length > 0
        ? import.meta.url
        : undefined;
  if (!metaUrl) {
    throw new Error(
      `Sandbox worker assets are unavailable (${SANDBOX_WORKER_BUNDLE_NAME} + ${QUICKJS_WASM_FILE_NAME})`,
    );
  }

  const wasmPath = input.wasmPath ?? resolveWasmPath(metaUrl);
  // 源文件测试：tsx 不能把 worker 入口的 .js 说明符映射回 .ts；且 Worker
  // 不会自动沿用主线程的 tsx 加载器，走一个显式注册的引导文件。
  if (metaUrl.endsWith(".ts")) {
    return {
      workerUrl: input.workerUrl ?? new URL(SANDBOX_WORKER_TSX_BOOTSTRAP_RELATIVE, metaUrl),
      wasmPath,
    };
  }

  if (input.workerUrl) return { workerUrl: input.workerUrl, wasmPath };

  // tsc 出盘的同目录 sibling 入口（未打包的嵌入场景）。
  const moduleUrl = new URL(SANDBOX_WORKER_MODULE_RELATIVE, metaUrl);
  if (moduleUrl.protocol === "file:" && exists(fileURLToPath(moduleUrl))) {
    return { workerUrl: moduleUrl, wasmPath };
  }

  // 打包产物：入口与 wasm 必须与 bundle 同级。
  if (metaUrl.startsWith("file:")) {
    const directory = dirname(fileURLToPath(metaUrl));
    const bundledWorker = resolve(directory, SANDBOX_WORKER_BUNDLE_NAME);
    const bundledWasm = resolve(directory, QUICKJS_WASM_FILE_NAME);
    if (!exists(bundledWorker)) {
      throw new Error(`Sandbox worker entry is missing: ${bundledWorker}`);
    }
    if (!exists(bundledWasm)) {
      throw new Error(`Sandbox worker wasm asset is missing: ${bundledWasm}`);
    }
    return { workerUrl: new URL(`./${SANDBOX_WORKER_BUNDLE_NAME}`, metaUrl), wasmPath: bundledWasm };
  }

  throw new Error(
    `Sandbox worker assets are unavailable (${SANDBOX_WORKER_BUNDLE_NAME} + ${QUICKJS_WASM_FILE_NAME})`,
  );
}

function resolveWasmPath(metaUrl: string): string {
  try {
    const requireFromSource = createRequire(metaUrl);
    // 与构建期 quickjs-wasm-bundle.mjs 同一套定位：包内 quickjs.wasm。
    const packageJson = requireFromSource.resolve("quickjs-wasi/package.json");
    return resolve(dirname(packageJson), QUICKJS_WASM_FILE_NAME);
  } catch (error) {
    throw new Error(
      `Sandbox worker wasm asset is unavailable for ${metaUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function readBannerAssets(exists: (absolutePath: string) => boolean): SandboxWorkerAssets | undefined {
  const locator = (globalThis as { __zcodeSandboxWorkerAssets?: unknown }).__zcodeSandboxWorkerAssets;
  if (typeof locator !== "function") return undefined;
  let located: unknown;
  try {
    located = locator();
  } catch (error) {
    throw new Error(
      `Sandbox worker assets are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!located || typeof located !== "object") {
    throw new Error("Sandbox worker asset locator returned an invalid value");
  }
  const record = located as { workerUrl?: unknown; wasmPath?: unknown };
  if (typeof record.workerUrl !== "string" || typeof record.wasmPath !== "string") {
    throw new Error("Sandbox worker asset locator returned an invalid value");
  }
  if (!exists(record.wasmPath)) {
    throw new Error(`Sandbox worker wasm asset is missing: ${record.wasmPath}`);
  }
  return { workerUrl: new URL(record.workerUrl), wasmPath: record.wasmPath };
}
