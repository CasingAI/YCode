// QuickJS 引擎 wasm 的构建期定位。
//
// quickjs-wasi 默认用 `new URL('../quickjs.wasm', import.meta.url)` 读引擎 wasm；该写法只在
// 未打包 ESM 下成立，esbuild 打成单文件 CJS 后 import.meta 被降级成空对象，运行时抛
// `TypeError [ERR_INVALID_URL]`（所有 Sandbox 调用在引擎初始化阶段即失败）。
//
// 这里在构建期把这一处改写为调用 bundle 顶部的定位函数，读取随产物分发的真实 wasm：
// plain CLI 与桌面取 bundle 同级 `quickjs.wasm`；SEA 取内嵌 asset，首次使用时物化。
// 规则见 docs/specs/sandbox-system-tool.md「引擎选型」。

import { createRequire } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const QUICKJS_INDEX_FILTER = /quickjs-wasi[\\/]dist[\\/]index\.js$/;
const WASM_URL_SOURCE = "new URL('../quickjs.wasm', import.meta.url)";
const WASM_URL_REPLACEMENT = "__zcodeQuickjsWasmUrl()";

/** SEA asset 名（build-sea.mjs 与运行时 banner 必须一致）。 */
export const QUICKJS_WASM_ASSET_NAME = "quickjs-wasm";
export const QUICKJS_WASM_FILE_NAME = "quickjs.wasm";

/** esbuild 插件：把 quickjs-wasi 的 wasm 定位改写为产物内定位函数。 */
export function createQuickjsWasmPlugin() {
  return {
    name: "zcode-quickjs-wasm-locate",
    setup(builder) {
      builder.onLoad({ filter: QUICKJS_INDEX_FILTER }, async (args) => {
        const { readFile } = await import("node:fs/promises");
        const source = await readFile(args.path, "utf8");
        if (!source.includes(WASM_URL_SOURCE)) {
          throw new Error(
            `[quickjs-wasm] ${args.path} 未找到预期的 wasm 定位写法，请核对 quickjs-wasi 版本`,
          );
        }
        return { contents: source.replace(WASM_URL_SOURCE, WASM_URL_REPLACEMENT), loader: "js" };
      });
    },
  };
}

/** 经 @zcode/core 的依赖解析定位 quickjs-wasi 包内 quickjs.wasm 的绝对路径。 */
export function resolveQuickjsWasmSource({ cliDirectory }) {
  const coreRequire = createRequire(resolve(cliDirectory, "../core/dist/index.js"));
  return resolve(dirname(coreRequire.resolve("quickjs-wasi/package.json")), QUICKJS_WASM_FILE_NAME);
}

/** 把 quickjs.wasm 拷进目标目录（plain CLI / 桌面的 bundle 同级）。 */
export async function stageQuickjsWasm({ sourcePath, targetDir }) {
  await mkdir(targetDir, { recursive: true });
  const destination = resolve(targetDir, QUICKJS_WASM_FILE_NAME);
  await copyFile(sourcePath, destination);
  return destination;
}

/**
 * 注入 bundle 顶部的定位函数（CJS banner：require / __filename / __dirname 合法）。
 * plain CLI 与桌面取同级文件；SEA 取内嵌 asset 物化到临时目录。首次调用后缓存。
 */
export const QUICKJS_WASM_BANNER = `
function __zcodeQuickjsWasmUrl() {
  if (__zcodeQuickjsWasmUrl.cached) return __zcodeQuickjsWasmUrl.cached;
  var path = require("node:path");
  var url = require("node:url");
  var resolved;
  try {
    var sea = require("node:sea");
    if (sea.isSea()) {
      var fs = require("node:fs");
      var os = require("node:os");
      var assetPath = path.join(os.tmpdir(), "zcode-quickjs-wasm", "quickjs.wasm");
      fs.mkdirSync(path.dirname(assetPath), { recursive: true });
      fs.writeFileSync(assetPath, Buffer.from(sea.getRawAsset("quickjs-wasm")));
      resolved = url.pathToFileURL(assetPath);
    }
  } catch (error) {
    resolved = undefined;
  }
  if (!resolved) resolved = url.pathToFileURL(path.join(__dirname, "quickjs.wasm"));
  __zcodeQuickjsWasmUrl.cached = resolved;
  return resolved;
}
`;
