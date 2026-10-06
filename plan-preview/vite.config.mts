import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = dirname(new URL(import.meta.url).pathname);
const req = createRequire(import.meta.url);
const pkgRoot = (name: string) => dirname(req.resolve(`${name}/package.json`));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(here, "../packages/ui/src"),
      react: pkgRoot("react"),
      "react-dom": pkgRoot("react-dom"),
      "lucide-react": pkgRoot("lucide-react"),
    },
    dedupe: ["react", "react-dom", "lucide-react"],
  },
  server: { port: 5199, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 全内联：产物是一个自包含的 HTML，双击即可打开，不需要起服务器。
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
