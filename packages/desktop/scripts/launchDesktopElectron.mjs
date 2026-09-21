import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { prepareDevElectronAppBundle } from "./devElectronAppBundle.mjs";

const require = createRequire(import.meta.url);
// macOS 上 Electron 不总是可靠响应 SIGINT/SIGTERM：先给整棵进程组一个宽限窗口，再强制清理。
const shutdownGraceMs = 1_500;
const shutdownHardExitMs = 5_000;

/**
 * 解析项目内安装的 Electron 二进制。
 *
 * Windows 下直接 `spawn("electron")` 完全依赖 PATH 里恰好能找到本地 bin。
 * 在 pnpm + PowerShell 场景里，子进程经常只拿到 node 可执行而拿不到 electron 命令，
 * 导致启动脚本卡在 ENOENT。这里显式解析当前项目安装的 Electron 二进制，
 * 避免跨 shell / 跨平台时 PATH 语义不一致。
 */
export function resolveLocalElectronBinary() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageRoot = resolve(electronPackageJsonPath, "..");

  if (process.platform === "win32") {
    return resolve(electronPackageRoot, "dist", "electron.exe");
  }

  if (process.platform === "darwin") {
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }

  return resolve(electronPackageRoot, "dist", "electron");
}

/**
 * 解析实际要执行的 Electron 命令。
 *
 * macOS 命令行启动的 raw Electron 没有 CFBundleURLTypes，LaunchServices 会把
 * zcode:// 交给一个没有项目入口的 Electron 默认壳。给本地启动副本补齐产品
 * Info.plist 后，线上 Share 页面无需感知 Dev，仍可把链接投递给已运行的实例。
 * 非 darwin 直接返回原二进制。
 */
export async function resolveDesktopElectronCommand({ desktopRoot, electronBinary }) {
  if (process.platform !== "darwin" || !existsSync(electronBinary)) {
    return { command: electronBinary, appPath: null };
  }

  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackage = JSON.parse(await readFile(electronPackageJsonPath, "utf8"));
  const devBundle = await prepareDevElectronAppBundle({
    electronAppPath: resolve(electronBinary, "../../.."),
    runtimeRoot: resolve(desktopRoot, "../../.zcode-runtime/desktop-dev"),
    electronVersion: electronPackage.version,
    arch: process.arch,
  });

  return { command: devBundle.executablePath, appPath: devBundle.appPath };
}

/**
 * 启动桌面 Electron 进程，并接管开发进程树的信号回收。
 *
 * `rendererUrl` 有值表示 renderer 走 Vite dev server；无值表示加载已构建的
 * `out/renderer`。后者必须确保子进程环境里没有 `ELECTRON_RENDERER_URL`：
 * 只要该变量存在，未打包的 main 就会去加载开发服务器页面（见 desktopHostProcess.ts）。
 *
 * 调用方不需要 await 子进程退出；Electron 的事件循环句柄会让进程保持存活，
 * 关闭窗口时本函数注册的 handler 会带着 Electron 的退出码结束当前进程。
 */
export async function launchDesktopElectron({
  desktopRoot,
  rendererUrl,
  label = "desktop",
  env = process.env,
  electronBinary = resolveLocalElectronBinary(),
  log = console.log,
}) {
  const spawnEnv = { ...env };
  if (rendererUrl) {
    spawnEnv.ELECTRON_RENDERER_URL = rendererUrl;
  } else {
    delete spawnEnv.ELECTRON_RENDERER_URL;
  }

  log(`[${label}] Starting Electron...`);
  // 解析不到项目内 Electron 时保留 PATH 兜底，避免本地安装不完整时直接 ENOENT。
  const executable = existsSync(electronBinary) ? electronBinary : "electron";
  const { command, appPath } = await resolveDesktopElectronCommand({
    desktopRoot,
    electronBinary: executable,
  });
  if (appPath) {
    log(`[${label}] Prepared macOS YCode Dev bundle: ${appPath}`);
  }

  const electron = spawn(command, ["."], {
    cwd: desktopRoot,
    stdio: "inherit",
    env: spawnEnv,
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  let electronClosed = false;
  let shuttingDown = false;
  let forceKillTimer;
  let hardExitTimer;

  function signalElectronTree(signal) {
    if (electronClosed || !electron.pid) {
      return;
    }

    if (process.platform === "win32") {
      electron.kill(signal);
      return;
    }

    try {
      process.kill(-electron.pid, signal);
    } catch {
      electron.kill(signal);
    }
  }

  function forceKillElectronTree() {
    if (electronClosed || !electron.pid) {
      return;
    }

    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }

    signalElectronTree("SIGKILL");
  }

  function shutdownFromSignal(signal) {
    if (shuttingDown) {
      forceKillElectronTree();
      return;
    }

    shuttingDown = true;
    log(`[${label}] Received ${signal}, stopping Electron...`);
    // 上层包装进程（concurrently / 终端 Ctrl+C）只会结束本进程这一层，
    // Electron 在 macOS 上不会可靠响应 SIGINT/SIGTERM，之前会被 orphan 到 ppid=1
    // 继续占用端口和日志。这里把 Electron 放进独立进程组并由本函数统一回收，
    // 超时后强制清掉整棵开发进程树。
    signalElectronTree("SIGTERM");
    forceKillTimer = setTimeout(forceKillElectronTree, shutdownGraceMs);
    hardExitTimer = setTimeout(() => process.exit(0), shutdownHardExitMs);
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => shutdownFromSignal(signal));
  }

  electron.on("error", (error) => {
    console.error(`[${label}] Failed to start Electron:`, error);
    process.exit(1);
  });

  electron.on("close", (code, signal) => {
    electronClosed = true;
    clearTimeout(forceKillTimer);
    clearTimeout(hardExitTimer);
    if (shuttingDown) {
      process.exit(0);
    }
    process.exit(code ?? (signal ? 1 : 0));
  });

  return electron;
}
