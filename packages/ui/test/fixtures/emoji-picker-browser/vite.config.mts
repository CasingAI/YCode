import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { notoEmojiAssetsPlugin } from "@zcode/ui/vite/noto-emoji-assets";
import { outputDir } from "./output-dir.mjs";

// 独立 emoji 选择器验证站点：root 只指向本目录，产物写到系统临时目录，
// 不复用、不覆盖 packages/web/dist 或 packages/desktop/out，也不启动 YCode。
const HERE = fileURLToPath(new URL(".", import.meta.url));
const UI_ROOT = resolve(HERE, "../../..");

export default defineConfig(({ command }) => ({
  root: HERE,
  // 生产构建用 "./" 复刻 Desktop file:// / 子路径部署，验证 BASE_URL 的相对资源 URL；
  // 开发态 Vite 不支持相对 base，保持 "/"。
  base: command === "build" ? "./" : "/",
  plugins: [react(), tailwindcss(), notoEmojiAssetsPlugin()],
  resolve: {
    alias: {
      // 与 packages/web/vite.config.ts 相同：UI 源码里的 @/ 指向 packages/ui/src。
      "@": resolve(UI_ROOT, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 43117,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 43118,
    strictPort: true,
  },
  build: {
    outDir: outputDir,
    emptyOutDir: true,
    sourcemap: false,
    // 图片资源由插件逐文件 emit，不经 assetsInlineLimit；这里再禁用内联，
    // 保证夹具产物与生产一致：PNG 始终是独立静态文件。
    assetsInlineLimit: 0,
  },
}));
