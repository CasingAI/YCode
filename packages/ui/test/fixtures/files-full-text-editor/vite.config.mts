import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import type { PluginOption } from "vite";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const UI_ROOT = resolve(HERE, "../../..");
const WEB_PACKAGE = resolve(UI_ROOT, "../web/package.json");

// react / tailwind 的 Vite 插件属于 packages/web 的依赖，从 Web 包显式解析，
// 避免依赖 workspace 里偶然的 hoist；不新增 ui 依赖或 lock 条目。
const webRequire = createRequire(WEB_PACKAGE);

async function loadWebPlugin(specifier: string): Promise<(options?: unknown) => PluginOption> {
  const module = await import(pathToFileURL(webRequire.resolve(specifier)).href);
  return module.default;
}

/**
 * 独立站点：挂载真实 FilesEditorGroupPane / filesEditorStore / FilesMonacoEditor。
 *
 * 只替换服务边界（i18n、settings、toast、logger、应用 store、平台、非文本预览）。
 * 不 alias Monaco 或大文本查看器到替代实现；真实 Monaco 从 monaco-editor 打包。
 */
export default defineConfig(async () => {
  const [react, tailwindcss] = await Promise.all([
    loadWebPlugin("@vitejs/plugin-react"),
    loadWebPlugin("@tailwindcss/vite"),
  ]);
  return {
    root: HERE,
    // Monaco 的 worker 与动态 chunk 需要绝对根路径；测试服务只挂在本机临时端口。
    base: "/",
    publicDir: resolve(UI_ROOT, "../web/public"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: /^@\/i18n\/IntlProvider\.js$/, replacement: resolve(HERE, "stubs/intl.tsx") },
        { find: /^@\/hooks\/useSettingService\.js$/, replacement: resolve(HERE, "stubs/settings.ts") },
        { find: /^@\/components\/ui\/toast\.js$/, replacement: resolve(HERE, "stubs/toast.tsx") },
        { find: /^@\/logger\.js$/, replacement: resolve(HERE, "stubs/logger.ts") },
        { find: /^@\/store\/StoreProvider\.js$/, replacement: resolve(HERE, "stubs/store.tsx") },
        { find: /^@\/hooks\/usePlatform\.js$/, replacement: resolve(HERE, "stubs/platform.ts") },
        // 只替换本场景不会挂载的非文本分支；完整正文的 Monaco 分支保持真实实现。
        { find: /^@\/PreviewPane\.js$/, replacement: resolve(HERE, "stubs/preview-pane.tsx") },
        {
          find: /^@\/files-workbench\/FilesLargeTextViewer\.js$/,
          replacement: resolve(HERE, "stubs/large-text-viewer.tsx"),
        },
        { find: /^@\//, replacement: `${resolve(UI_ROOT, "src")}/` },
      ],
    },
    define: {
      __ZCODE_ENV__: JSON.stringify("test"),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify("zcode"),
      __ZCODE_VERSION__: JSON.stringify("0.0.0-fixture"),
      __ZCODE_UPSTREAM_VERSION__: JSON.stringify("0.0.0"),
      __ZCODE_COMMIT__: JSON.stringify("fixture"),
      __ZCODE_BUILD_TIME__: JSON.stringify("0"),
      __ZCODE_EXPECTED_CLI_VERSION__: JSON.stringify(""),
    },
    worker: {
      format: "es",
    },
    build: {
      outDir: process.env.FILES_FULL_TEXT_E2E_DIST || resolve(HERE, "dist"),
      emptyOutDir: true,
      target: "chrome120",
      sourcemap: false,
      chunkSizeWarningLimit: 8192,
    },
  };
});
