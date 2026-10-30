import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";
import type { PluginOption } from "vite";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const UI_ROOT = resolve(HERE, "../../..");
const WEB_PACKAGE = resolve(UI_ROOT, "../web/package.json");

// react / tailwind 的 Vite 插件属于 packages/web 的依赖，不是 @zcode/ui 的依赖。
// 从 Web 包显式解析，避免依赖 workspace 里偶然的 hoist；不新增 ui 依赖或 lock 条目。
const webRequire = createRequire(WEB_PACKAGE);

async function loadWebPlugin(specifier: string): Promise<(options?: unknown) => PluginOption> {
  const module = await import(pathToFileURL(webRequire.resolve(specifier)).href);
  return module.default;
}

// 独立站点：root 只指向本夹具，产物写到系统临时目录；
// 不启动、不连接任何 YCode 服务，也不复用 packages/web 的构建产物。
export default defineConfig(async () => {
  const [react, tailwindcss] = await Promise.all([
    loadWebPlugin("@vitejs/plugin-react"),
    loadWebPlugin("@tailwindcss/vite"),
  ]);
  return {
    root: HERE,
    base: "./",
    // 复用 Web 客户端自己的公开图标资产，避免文件类型图标 404 干扰运行时断言。
    publicDir: resolve(UI_ROOT, "../web/public"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        // 只替换服务/重量级渲染边界，其余 @/ 仍指向真实 UI 源码。
        {
          find: /^@\/i18n\/IntlProvider\.js$/,
          replacement: join(HERE, "stubs/intl.tsx"),
        },
        {
          find: /^@\/hooks\/useSettingService\.js$/,
          replacement: join(HERE, "stubs/settings.ts"),
        },
        {
          find: /^@\/components\/ui\/toast\.js$/,
          replacement: join(HERE, "stubs/toast.tsx"),
        },
        {
          find: /^@\/logger\.js$/,
          replacement: join(HERE, "stubs/logger.ts"),
        },
        {
          find: /^@\/store\/StoreProvider\.js$/,
          replacement: join(HERE, "stubs/store.tsx"),
        },
        {
          find: /^@\/hooks\/usePlatform\.js$/,
          replacement: join(HERE, "stubs/platform.ts"),
        },
        {
          find: /^@\/files-workbench\/FilesMonacoEditor\.js$/,
          replacement: join(HERE, "stubs/source-editor.tsx"),
        },
        {
          find: /^@\/files-workbench\/FilesLargeTextViewer\.js$/,
          replacement: join(HERE, "stubs/large-text-viewer.tsx"),
        },
        {
          find: /^@\/PreviewPane\.js$/,
          replacement: join(HERE, "stubs/preview-pane.tsx"),
        },
        { find: /^@\//, replacement: `${resolve(UI_ROOT, "src")}/` },
      ],
    },
    build: {
      outDir: process.env.FILES_MD_E2E_DIST || join(tmpdir(), "zcode-files-md-e2e-dist"),
      emptyOutDir: true,
      target: "chrome120",
      sourcemap: false,
    },
  };
});
