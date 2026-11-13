import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import type { PluginOption } from "vite";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

// react / tailwind 的 Vite 插件属于 packages/web 的依赖，从 Web 包显式解析，
// 不在 UI 测试里新增依赖或 lock 条目。
const webRequire = createRequire(resolve(REPO_ROOT, "packages/web/package.json"));

async function loadWebPlugin(specifier: string): Promise<(options?: unknown) => PluginOption> {
  const module = await import(pathToFileURL(webRequire.resolve(specifier)).href);
  return module.default;
}

// 独立生产态构建：只服务夹具自己和真实 node_modules 里的 Radix 包，
// 不启动、不连接任何 YCode 服务，也不复用 packages/web 的产物。
export default defineConfig(async () => {
  const [react, tailwindcss] = await Promise.all([
    loadWebPlugin("@vitejs/plugin-react"),
    loadWebPlugin("@tailwindcss/vite"),
  ]);
  return {
    root: HERE,
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        {
          find: "@radix-cjs/select",
          replacement: resolve(REPO_ROOT, "node_modules/@radix-ui/react-select/dist/index.js"),
        },
        {
          find: "@radix-cjs/scroll-area",
          replacement: resolve(REPO_ROOT, "node_modules/@radix-ui/react-scroll-area/dist/index.js"),
        },
      ],
    },
    build: {
      outDir:
        process.env.RADIX_VIEWPORT_DIST ?? resolve(REPO_ROOT, "packages/ui/.tmp-radix-viewport"),
      emptyOutDir: true,
      sourcemap: false,
      target: "chrome120",
      minify: false,
    },
  };
});
