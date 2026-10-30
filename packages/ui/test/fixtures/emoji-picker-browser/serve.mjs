import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import { outputDir } from "./output-dir.mjs";

// 生产构建的本地静态服务：只读 outputDir，端口独立（43118），
// 不依赖也不启动 YCode 的任何服务。
const ROOT = resolve(outputDir);
const PORT = Number(process.env.EMOJI_E2E_PORT) || 43118;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".bcmap": "application/octet-stream",
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const relative = normalize(urlPath).replace(/^([/\\])+/, "");
    let filePath = join(ROOT, relative);
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = join(filePath, "index.html");
      }
    } catch {
      // 带扩展名的资源缺失必须 404；不能回退 index.html 掩盖缺 chunk。
      if (extname(relative)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      filePath = join(ROOT, "index.html");
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[emoji-e2e] production preview: http://127.0.0.1:${PORT}/`);
});
