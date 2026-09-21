import { existsSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchDesktopElectron } from "./launchDesktopElectron.mjs";

const root = resolve(import.meta.dirname, "..");
const mainBundle = resolve(root, "out/main/index.js");
const buildReadyMarkers = [
  { name: "main", path: resolve(root, "out/.main-build-ready") },
  { name: "host", path: resolve(root, "out/.host-build-ready") },
  { name: "preload", path: resolve(root, "out/.preload-build-ready") },
];
const waitLogIntervalMs = 3_000;

function probeHttpUrl(url) {
  return new Promise((resolveProbe) => {
    const req = request(url, { method: "HEAD", timeout: 1_000 }, (res) => {
      res.resume();
      resolveProbe({ ok: true });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        reason: `${error.code ? `${error.code} ` : ""}${error.message}`,
      });
    });
    req.end();
  });
}

// Wait for both Vite dev server and main bundle to be ready
async function waitForReady() {
  // desktop 的 tsup 实际是 main/host/preload 三个独立 watch 构建。
  // 之前任意一个构建成功就可能放行，Electron 会在其余产物还未稳定时启动，读到半完成的 ESM/CJS 文件。
  // 现在必须等待三个构建各自写入 ready 标记，再额外确认 main bundle 已产出。
  let lastBuildWaitLogAt = 0;
  while (true) {
    const missingMarkers = buildReadyMarkers
      .filter((marker) => !existsSync(marker.path))
      .map((marker) => marker.name);
    const hasMainBundle = existsSync(mainBundle);
    if (missingMarkers.length === 0 && hasMainBundle) {
      break;
    }
    const now = Date.now();
    if (now - lastBuildWaitLogAt >= waitLogIntervalMs) {
      // dev 启动卡在等待阶段时，终端最后一行常停在 tsup watch 日志，开发者无法判断缺哪个条件。
      // 这里定期打印等待状态，让 marker 或 main bundle 缺失能直接从日志定位。
      console.log(
        `[dev] Waiting for build artifacts... missingMarkers=${
          missingMarkers.join(",") || "none"
        } mainBundle=${hasMainBundle ? "ready" : "missing"}`,
      );
      lastBuildWaitLogAt = now;
    }
    await sleep(300);
  }

  // Wait for Vite dev server
  // Vite 在不同本机 DNS/IPv6 配置下可能只监听 localhost/::1 或 127.0.0.1 其中之一。
  // 这里轮询多个 loopback 地址，避免 dev 脚本和 Vite 实际监听地址不一致导致 Electron 永远不启动。
  const viteUrls = ["http://localhost:5174", "http://127.0.0.1:5174", "http://[::1]:5174"];
  let lastViteWaitLogAt = 0;
  while (true) {
    const failures = [];
    for (const viteUrl of viteUrls) {
      const result = await probeHttpUrl(viteUrl);
      if (result.ok) {
        return viteUrl;
      }
      failures.push(`${viteUrl}: ${result.reason}`);
    }
    const now = Date.now();
    if (now - lastViteWaitLogAt >= waitLogIntervalMs) {
      console.log(`[dev] Waiting for Vite dev server... ${failures.join(" | ")}`);
      lastViteWaitLogAt = now;
    }
    await sleep(300);
  }
}

const rendererUrl = await waitForReady();

// 有 rendererUrl 表示 renderer 走 Vite dev server；启动、进程组回收与退出码处理
// 统一由 launchDesktopElectron 承担，prebuilt 启动复用同一实现。
await launchDesktopElectron({ desktopRoot: root, rendererUrl, label: "dev" });
