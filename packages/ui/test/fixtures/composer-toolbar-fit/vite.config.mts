import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defineConfig } from "vite";
import type { PluginOption } from "vite";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

// react 插件复用 packages/web 的依赖，不在 UI 测试里新增依赖或 lock 条目。
const webRequire = createRequire(resolve(REPO_ROOT, "packages/web/package.json"));

async function loadWebPlugin(specifier: string): Promise<(options?: unknown) => PluginOption> {
  const module = await import(pathToFileURL(webRequire.resolve(specifier)).href);
  return module.default;
}

// 独立生产态构建：只服务本夹具与真实 hook 源码，不启动、不连接任何 YCode 服务。
export default defineConfig(async () => {
  const react = await loadWebPlugin("@vitejs/plugin-react");
  return {
    root: HERE,
    base: "./",
    plugins: [react()],
    resolve: {
      alias: [
        {
          find: "@",
          replacement: resolve(REPO_ROOT, "packages/ui/src"),
        },
      ],
    },
    build: {
      outDir:
        process.env.COMPOSER_TOOLBAR_FIT_DIST ??
        resolve(REPO_ROOT, "packages/ui/.tmp-composer-toolbar-fit"),
      emptyOutDir: true,
      sourcemap: false,
      target: "chrome120",
      minify: false,
    },
  };
});
