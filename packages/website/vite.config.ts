import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 官网是纯静态站：hash 路由 + 相对 base，产物可以放在任意路径下托管。
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
