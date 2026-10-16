/**
 * CLI Proxy 运行时服务 —— 桌面 Host 进程内的二进制插件前端。
 *
 * 唯一状态所有者：Host 进程内注册一次。UI 只渲染快照，所有变更经 RPC 落回 Host。
 * "是否需要运行"从供应商配置派生（不存在依赖 provider 时不启动），没有用户显式开关——
 * 这是与远控 `enabled` 用户意图轴的关键差异。
 *
 * 事件顺序：
 *   Host 初始化 → resumeIfEnabled()（启动时一次更新检查）
 *   provider 变化 → refresh() 重算按需启动（需要 → start，否则 stop）
 *   版本切换 → 同端口重启；卸载 active → 回落内置并提示（UI 侧）。
 *
 * 安全边界：只绑 127.0.0.1；管理面 key 与数据面 api-key 独立落盘 0600；
 * 同机同用户进程可见是桌面端固有边界，不做虚假承诺。
 */
/* eslint-disable max-lines -- 运行时 + 账号面（OAuth/模型/额度）同属单一状态所有者，拆文件会制造第二写入路径。 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { Emitter } from "@zcode/rpc";
import { stringify as stringifyYaml } from "yaml";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getDataBaseDir } from "../paths.js";
import { downloadAndInstallRelease, findBinaryInDir } from "./cliProxyInstall.js";
import {
  binaryExists,
  currentCliProxyTarget,
  ensureKeyFile,
  readVersionsState,
  resolveCliProxyLayout,
  resolveCliProxyRoot,
  uninstallCliProxyVersion,
  writeVersionsState,
  type CliProxyLayout,
} from "./cliProxyVersions.js";
import { checkCliProxyUpdates, getNewestVersion, isNewerVersion } from "./cliProxyReleases.js";
import {
  fetchCliProxyModels,
  fetchCliProxyQuota,
  getCliProxyAuthUrl,
  listCliProxyAuthFiles,
  pollCliProxyAuthStatus,
  submitCliProxyAuthCallback,
} from "./cliProxyAccount.js";
import type { CliProxyStatus, ICliProxyService } from "./cliProxy.js";
import type { CliProxyModelSyncResult } from "@zcode/shared";
import {
  ModelConfig,
  ModelInputFormatConfig,
  ModelPropertiesConfig,
  type ProviderId,
} from "@zcode/provider";
import { cliProxyChannelFromTemplateId, isCliProxyProviderTemplateId } from "@zcode/shared";

const logger = createServiceLogger("cliProxyService");

/** 默认监听端口：固定值落盘，EADDRINUSE 才让位（远控同款语义）。 */
export const CLI_PROXY_DEFAULT_PORT = 8317;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "EADDRINUSE";
}

/** 空闲端口探测：绑定 0 后立即释放（远控 lanAccess.pickFreePort 同法）。 */
function pickFreePort(): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolvePromise(port);
        else rejectPromise(new Error("Failed to pick a free port"));
      });
    });
  });
}

export interface CliProxyServiceOptions {
  /** 判定"是否存在依赖 CLI Proxy 的 provider"：存在 → 需要启动。 */
  hasDependentProviders: () => Promise<boolean> | boolean;
  /** 内置基础版本目录（随应用分发）；缺省时按入口旁 packages 定位。 */
  bundledDir?: string;
  /** 数据根覆盖（单测注入临时目录）。 */
  dataBaseDir?: string;
  /** 更新检查节流：默认每日一次。 */
  updateCheckIntervalMs?: number;
  /**
   * 首启自动下载开关（默认开启）：无可用二进制且需要启动时，doStart 内跑一次
   * 更新检查下载最新版。单测设为 false，保证无网络依赖、可复现 binary-missing。
   */
  bootstrapDownloadOnFirstStart?: boolean;
  /**
   * 首启下载失败后的重试退避间隔（默认 5 分钟）。单测注入 0 即时重试。
   */
  bootstrapRetryCooldownMs?: number;
  /**
   * 更新检查与安装的测试注入点（默认走真实 GitHub 检查与下载）。
   * 生产默认路径的全链单测经此注入 fake，不发网络。
   */
  checkForUpdateReleases?: () => Promise<import("./cliProxyReleases.js").CliProxyUpdateCheck>;
  installReleaseAsset?: (
    layout: CliProxyLayout,
    asset: { version: string; target: string; archiveUrl: string; archiveSha256: string },
  ) => Promise<void>;
  /**
   * 端点投影：启动成功（含 EADDRINUSE 让位）后与运行期 provider 变更时，把实际绑定
   * 端口和数据面 api-key 投影到 cliproxy-* provider（稀疏 overlay，幂等）。
   * 依据（真机实测 2026-10-14）：代理对 /v1 强制校验 access.api-keys，而 Registry 要求
   * provider 配置完整——apiKey 缺失即被排除出模型选择器。端口与密钥的事实来源都是
   * 运行中的服务（data.key 落盘 0600），provider 配置是它们的投影；失败只记日志不挡启动。
   * 未注入时不投影（单测/无 provider 环境）。
   */
  syncProviderEndpoints?: (input: { port: number; dataKey: string }) => Promise<void>;
  /**
   * 裁决上游出口代理地址（docs/specs/plugin-cli-proxy-binary.md「上游代理」）。
   * 启动前与运行期 provider 变更时各调用一次：非空则写进 config.yaml 顶层
   * `proxy-url`（代理热加载生效），null 则不写（直连）。未注入时恒直连。
   */
  resolveUpstreamProxyUrl?: () => Promise<string | null>;
  /** 读取 Provider Settings 配置视图。 */
  getProviderSettings?: () =>
    | Pick<import("../model-provider/providerFacadeServices.js").IProviderSettingsService, "getView">
    | null;
  /** Host 内部写入自动发现模型，不通过 Provider Settings RPC 暴露。 */
  syncDiscoveredProviderModels?: (
    providerId: ProviderId,
    models: readonly {
      readonly modelId: import("@zcode/provider").ModelId;
      readonly config: import("@zcode/provider").ModelConfigObject;
    }[],
  ) => Promise<{ readonly added: number; readonly updated: number }>;
}

interface RunningProcess {
  child: ChildProcess;
  port: number;
}

function idleStatus(needed: boolean): CliProxyStatus {
  return {
    state: "stopped",
    needed,
    versions: [],
    activeVersionId: null,
    port: null,
    updateAvailable: null,
    lastUpdateCheckAt: null,
  };
}

export function createCliProxyService(options: CliProxyServiceOptions): ICliProxyService & {
  resumeIfEnabled(): Promise<void>;
  suspend(): Promise<void>;
  dispose(): void;
} {
  const layout: CliProxyLayout = resolveCliProxyLayout(
    resolveCliProxyRoot(options.dataBaseDir ?? getDataBaseDir()),
  );
  const changed = new Emitter<CliProxyStatus>();
  let status: CliProxyStatus = idleStatus(false);
  let running: RunningProcess | undefined;
  let persistedPort = CLI_PROXY_DEFAULT_PORT;
  let lastUpdateCheckAt: string | null = null;
  let updateAvailable: string | null = null;
  let disposed = false;
  let startInFlight: Promise<CliProxyStatus> | undefined;
  let updateCheckInFlight: Promise<CliProxyStatus> | undefined;
  // 首启下载失败不永久锁死：记录上次尝试时间，下次 refresh 距上次超过退避间隔
  //（5 分钟）可再试——断网恢复后自愈，同时不变成每次 refresh 都发请求的高频重试。
  // 启动期更新检查只记成功：resumeIfEnabled 跑成功后 doStart 复用结果；
  // 失败不置位，下次 doStart 仍可再查（依据：docs/specs/plugin-cli-proxy-binary.md）。
  let lastBootstrapAttemptAt: number | null = null;
  let startupUpdateCheckDone = false;
  let dailyTimer: NodeJS.Timeout | undefined;
  // 当前 config.yaml 里已写入的上游代理地址；undefined 表示尚未写过一个值。
  let appliedUpstreamProxyUrl: string | null | undefined = undefined;

  const publish = (next: CliProxyStatus): CliProxyStatus => {
    status = next;
    changed.fire(next);
    return status;
  };

  const fail = (code: NonNullable<CliProxyStatus["errorCode"]>, detail: string): CliProxyStatus => {
    logger.warn("cli-proxy failed", { code, detail });
    return publish({ ...status, state: "error", errorCode: code, error: detail });
  };

  /** active 版本的二进制目录：用户版本优先，兜底内置基础版本。 */
  const resolveActiveBinaryDir = async (): Promise<string | null> => {
    const state = await readVersionsState(layout);
    const active = state.versions.find((version) => version.id === state.activeVersionId);
    if (active && (await binaryExists(active.dir))) return active.dir;
    if (options.bundledDir && (await binaryExists(options.bundledDir))) return options.bundledDir;
    return null;
  };

  const syncStatusFromDisk = async (): Promise<void> => {
    const state = await readVersionsState(layout);
    // 内置兜底未登记时：若 bundled 目录可用，登记为不可卸载的内置版本。
    if (
      options.bundledDir &&
      (await binaryExists(options.bundledDir)) &&
      !state.versions.some((version) => version.source === "bundled")
    ) {
      const target = currentCliProxyTarget();
      const entry = {
        id: `bundled-${target}`,
        version: "bundled",
        target,
        archiveSha256: "0".repeat(64),
        dir: options.bundledDir,
        source: "bundled" as const,
        downloadedAt: new Date(0).toISOString(),
      };
      const versions = [...state.versions, entry];
      await writeVersionsState(layout, {
        activeVersionId: state.activeVersionId ?? entry.id,
        versions,
      });
      state.versions = versions;
      state.activeVersionId = state.activeVersionId ?? entry.id;
    }
    publish({
      ...status,
      versions: state.versions,
      activeVersionId: state.activeVersionId,
      updateAvailable,
      lastUpdateCheckAt,
    });
  };

  const writeProxyConfig = async (
    port: number,
    upstreamProxyUrl: string | null = appliedUpstreamProxyUrl ?? null,
  ): Promise<void> => {
    const managementKey = await ensureKeyFile(layout.managementKeyFile);
    const dataKey = await ensureKeyFile(layout.dataKeyFile);
    // 管理面 key 与数据面 api-key 独立落盘 0600；管理面 key 不进 provider 配置。
    // 数据面 api-key 会在启动后经 syncProviderEndpoints 投影到依赖 provider 的
    // access.apiKey（代理强制校验，且 Registry 完整性要求该字段存在，见选项注释）。
    // 管理面必须设 secret-key（留空则整个管理面 404）；allow-remote:false 只允许本机。
    // v8 嵌套结构（真二进制 8.0.27 实测）：顶层 config-version: 8，监听在 server 段；
    // 启动参数只有 --config（无 --port），端口只走配置文件。
    const config = {
      "config-version": 8,
      server: { host: "127.0.0.1", port },
      management: { "secret-key": managementKey, "allow-remote": false },
      access: { "api-keys": [dataKey] },
      // OAuth 凭据目录收敛进数据目录（2026-10-14 用户拍板）；社区默认位置由
      // migrateLegacyCliProxyAuthFiles 在启动前一次性搬移过来。
      oauth: { "auth-dir": layout.authDir },
      // 上游出口代理（codex 等渠道出网走它）；null/空表示直连，不写该键。
      ...(upstreamProxyUrl ? { "proxy-url": upstreamProxyUrl } : {}),
    };
    await mkdir(layout.authDir, { recursive: true });
    await mkdir(dirname(layout.configFile), { recursive: true });
    await writeFile(layout.configFile, stringifyYaml(config), { encoding: "utf8", mode: 0o600 });
    await chmod(layout.configFile, 0o600);
  };

  // 上游代理地址裁决的安全包装：回调缺失/失败都回落 null（直连），不挡启动。
  const resolveUpstreamProxyUrlSafe = async (): Promise<string | null> => {
    if (!options.resolveUpstreamProxyUrl) return null;
    try {
      return (await options.resolveUpstreamProxyUrl()) || null;
    } catch (error) {
      logger.warn("cli-proxy upstream proxy resolve failed", { message: errorMessage(error) });
      return null;
    }
  };

  // 端点投影（端口 + 数据面 api-key）唯一入口：启动成功与运行期 provider 变更都走这里，
  // 投影是幂等的（补丁为 null 即不写），失败只记日志不挡启动/刷新。
  const syncEndpoints = async (port: number): Promise<void> => {
    if (!options.syncProviderEndpoints) return;
    try {
      await options.syncProviderEndpoints({ port, dataKey: await ensureKeyFile(layout.dataKeyFile) });
    } catch (error) {
      logger.warn("cli-proxy provider endpoint sync failed", { message: errorMessage(error) });
    }
  };

  const stopProcess = async (): Promise<void> => {
    const current = running;
    running = undefined;
    if (!current) return;
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        current.child.kill("SIGKILL");
        resolvePromise();
      }, 5000);
      current.child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      current.child.kill("SIGTERM");
    });
    logger.info("cli-proxy process stopped", { port: current.port });
  };

  const spawnAndWaitReady = async (
    binaryPath: string,
    port: number,
    upstreamProxyUrl: string | null,
  ): Promise<number | null> => {
    if (disposed) return null;
    // 端口只走配置文件（真二进制无 --port 参数）：每次 spawn 前重写，
    // 空闲端口让位时新端口才能生效。
    await writeProxyConfig(port, upstreamProxyUrl);
    return new Promise<number | null>((resolvePromise) => {
      // 真二进制（8.0.27 --help 实测）没有 --port：只有 --config，端口只走配置文件。
      const child = spawn(binaryPath, ["--config", layout.configFile], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      const settle = (value: number | null): void => {
        if (settled) return;
        settled = true;
        if (value === null) {
          child.kill("SIGKILL");
          resolvePromise(null);
          return;
        }
        // 端口冲突时真二进制先打印就绪行、约 1s 后才 bind 失败退出：
        // 延迟确认，进程仍存活才算启动成功，否则走空闲端口让位。
        setTimeout(() => {
          if (disposed || child.exitCode !== null || exitedCode !== undefined) {
            child.kill("SIGKILL");
            if (!disposed)
              logger.warn("cli-proxy exited shortly after ready", {
                code: child.exitCode ?? exitedCode,
                output: output.slice(-500),
              });
            resolvePromise(null);
            return;
          }
          running = { child, port: value };
          resolvePromise(value);
        }, 2000).unref?.();
      };
      let output = "";
      let exitedCode: number | null | undefined;
      const onData = (chunk: unknown): void => {
        output += String(chunk);
        // 真实就绪信号（8.0.27 实测）：
        //   API server started successfully on: 127.0.0.1:18317
        // 必须全行匹配：旧的":数字"宽松匹配会把 --help 用法文本里的数字误判为端口。
        // 注意端口冲突时它先打印就绪行、随后 bind 失败退出：settle 前必须确认进程未退出。
        const match = output.match(/API server started successfully on:\s*\S+:(\d{2,5})/);
        if (match?.[1] && exitedCode === undefined && child.exitCode === null)
          settle(Number(match[1]));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", (error) => {
        if (!isAddressInUse(error))
          logger.warn("cli-proxy spawn error", { message: errorMessage(error) });
        settle(null);
      });
      child.once("exit", (code) => {
        exitedCode = code;
        if (code !== 0 && code !== null)
          logger.warn("cli-proxy exited during start", { code, output: output.slice(-500) });
        settle(null);
      });
      setTimeout(() => settle(null), 10_000);
    });
  };

  const listenWithFallback = async (
    binaryPath: string,
    port: number,
    upstreamProxyUrl: string | null,
  ): Promise<number | null> => {
    const attempt = await spawnAndWaitReady(binaryPath, port, upstreamProxyUrl);
    if (attempt !== null) return attempt;
    // EADDRINUSE 才让位到空闲端口（远控同款语义），且不覆盖落盘端口。
    logger.warn("cli-proxy port in use, falling back to a free port", { port });
    return spawnAndWaitReady(binaryPath, await pickFreePort(), upstreamProxyUrl);
  };

  const doStart = async (): Promise<CliProxyStatus> => {
    await stopProcess();
    publish({ ...status, state: "starting" });
    let binaryDir = await resolveActiveBinaryDir();
    // 首启兜底（依据：docs/specs/plugin-cli-proxy-binary.md「首启二进制来源」）：
    // 桌面构建实际未打包内置二进制，bundledDir 兜底走不到；新机器首次需要启动时，
    // 在这里主动跑一次更新检查下载最新版（无 active 时首装即 active），再重试启动。
    // 只在退避间隔外再试（lastBootstrapAttemptAt），后续 start 不再高频触网。
    // bootstrapDownloadOnFirstStart: false 可整体关闭（单测 hermetic 用）；
    // 否则失败走退避重试，断网恢复后自愈。
    const bootstrapCooldownMs = options.bootstrapRetryCooldownMs ?? 5 * 60 * 1000;
    const now = Date.now();
    const cooldownElapsed =
      lastBootstrapAttemptAt === null || now - lastBootstrapAttemptAt >= bootstrapCooldownMs;
    if (!binaryDir && cooldownElapsed && options.bootstrapDownloadOnFirstStart !== false) {
      lastBootstrapAttemptAt = now;
      try {
        // resumeIfEnabled 的启动检查已覆盖则不再重发请求，只重查落盘。
        if (!startupUpdateCheckDone) await runUpdateCheck();
        else await syncStatusFromDisk();
      } catch (error) {
        logger.warn("cli-proxy bootstrap download failed", { message: errorMessage(error) });
      }
      binaryDir = await resolveActiveBinaryDir();
    }
    if (!binaryDir) {
      return fail("binary-missing", "无可用 CLI Proxy 二进制（无内置、无已下载版本）");
    }
    const binaryPath = await findBinaryInDir(binaryDir);
    if (!binaryPath) {
      return fail("binary-missing", `CLI Proxy 二进制缺失：${binaryDir}`);
    }
    const upstreamProxyUrl = await resolveUpstreamProxyUrlSafe();
    const actualPort = await listenWithFallback(binaryPath, persistedPort, upstreamProxyUrl);
    if (actualPort === null) {
      return fail("start-failed", "CLI Proxy 启动监听失败");
    }
    appliedUpstreamProxyUrl = upstreamProxyUrl;
    logger.info("cli-proxy started", { port: actualPort });
    // 端口让位/密钥轮换后 provider 配置若还是旧值会连不上或 401：按运行事实投影一次。
    await syncEndpoints(actualPort);
    return publish({
      ...status,
      state: "running",
      port: actualPort,
      errorCode: undefined,
      error: undefined,
    });
  };

  const startInternal = (): Promise<CliProxyStatus> => {
    startInFlight ??= doStart().finally(() => {
      startInFlight = undefined;
    });
    return startInFlight;
  };

  const stopInternal = async (): Promise<CliProxyStatus> => {
    await stopProcess();
    logger.info("cli-proxy stopped");
    return publish({
      ...status,
      state: "stopped",
      port: null,
      errorCode: undefined,
      error: undefined,
    });
  };

  const downloadReleaseInternal = async (asset: {
    version: string;
    target: string;
    archiveUrl: string;
    archiveSha256: string;
  }): Promise<void> => {
    // 测试注入优先：生产默认路径的全链单测用 fake 安装代替真实下载。
    if (options.installReleaseAsset) {
      await options.installReleaseAsset(layout, asset);
      return;
    }
    await downloadAndInstallRelease(layout, asset);
  };

  const runUpdateCheck = async (markStartupDone = false): Promise<CliProxyStatus> => {
    updateCheckInFlight ??= (async () => {
      // 检查成功语义（依据：docs/specs/plugin-cli-proxy-binary.md）：
      // 只有真正取到上游 latestVersion 才记为成功；断网/限流返回空结果不置位，
      // 下次 doStart 仍可再查——首启断网恢复后自愈，不永久锁死。
      let checkSucceeded = false;
      try {
        const { latestVersion, asset } = options.checkForUpdateReleases
          ? await options.checkForUpdateReleases()
          : await checkCliProxyUpdates();
        if (latestVersion) checkSucceeded = true;
        lastUpdateCheckAt = new Date().toISOString();
        if (latestVersion && asset) {
          const state = await readVersionsState(layout);
          const target = currentCliProxyTarget();
          // 只有当前平台且可探测到真实二进制的版本才是可用版本和更新基线。
          const usableVersions = await Promise.all(
            state.versions
              .filter((version) => version.target === target)
              .map(async (version) =>
                (await findBinaryInDir(version.dir)) ? version : null,
              ),
          );
          const usable = usableVersions.filter((version) => version !== null);
          // 未登记的内置目录同样参与基线；内置版本登记由 syncStatusFromDisk 负责。
          const bundledBinary = options.bundledDir
            ? await findBinaryInDir(options.bundledDir)
            : null;
          if (bundledBinary && !usable.some((version) => version.source === "bundled")) {
            usable.push({
              id: `bundled-${target}`,
              version: "bundled",
              target,
              archiveSha256: "0".repeat(64),
              dir: options.bundledDir!,
              source: "bundled",
              downloadedAt: "",
            });
          }
          const newest = getNewestVersion(
            usable.map((version) => version.version).filter((version) => version !== "bundled"),
          );
          updateAvailable = isNewerVersion(latestVersion, newest) ? latestVersion : null;
          // 当前 target 上仅当真实二进制存在才算已安装；无效同号登记不得阻断下载。
          const alreadyInstalled = usable.some(
            (version) => version.target === target && version.version === latestVersion,
          );
          if (updateAvailable && !alreadyInstalled) {
            try {
              await downloadReleaseInternal(asset);
            } catch (error) {
              logger.warn("cli-proxy auto-download failed", { message: errorMessage(error) });
            }
            await syncStatusFromDisk();
          }
        }
      } catch (error) {
        logger.warn("cli-proxy update check failed", { message: errorMessage(error) });
      } finally {
        updateCheckInFlight = undefined;
        // 只在检查成功时记启动期已检查：失败保持 false，下次 doStart 仍可再查。
        if (markStartupDone && checkSucceeded) startupUpdateCheckDone = true;
      }
      await syncStatusFromDisk();
      return status;
    })();
    return updateCheckInFlight;
  };

  const scheduleDailyCheck = (): void => {
    if (dailyTimer) return;
    const interval = options.updateCheckIntervalMs ?? 24 * 60 * 60 * 1000;
    dailyTimer = setInterval(() => {
      void runUpdateCheck();
    }, interval);
    dailyTimer.unref?.();
  };

  const service: ICliProxyService = {
    async getStatus() {
      await syncStatusFromDisk();
      return status;
    },
    async checkForUpdates() {
      return runUpdateCheck();
    },
    async downloadRelease(asset) {
      try {
        await downloadReleaseInternal(asset);
      } catch (error) {
        return fail("install-failed", errorMessage(error));
      }
      await syncStatusFromDisk();
      return status;
    },
    async selectVersion(id) {
      const state = await readVersionsState(layout);
      if (!state.versions.some((version) => version.id === id)) {
        return fail("install-failed", `未知版本：${id}`);
      }
      await writeVersionsState(layout, { activeVersionId: id, versions: state.versions });
      await syncStatusFromDisk();
      // 运行中切换：同端口重启。
      if (status.state === "running") await startInternal();
      return status;
    },
    async uninstallVersion(id) {
      try {
        const { fellBack } = await uninstallCliProxyVersion(layout, id);
        await syncStatusFromDisk();
        if (status.state === "running") await startInternal();
        return { status, fellBack };
      } catch (error) {
        fail("install-failed", errorMessage(error));
        return { status, fellBack: false };
      }
    },
    async refresh() {
      const needed = await options.hasDependentProviders();
      publish({ ...status, needed });
      if (disposed) return status;
      // 根因修复：error 不是终态——启动失败（binary-missing/start-failed）后，
      // 后续 provider 变更/重试必须能再次 start，否则一次失败就永久卡死。
      if (needed && (status.state === "stopped" || status.state === "error"))
        return startInternal();
      if (!needed && status.state !== "stopped") return stopInternal();
      // 运行中新增依赖 provider 时不会走 doStart：补一次端点投影，
      // 否则后加的 provider 拿不到数据面 api-key，永远进不了模型选择器。
      if (needed && status.state === "running" && status.port !== null) {
        await syncEndpoints(status.port);
        // 上游代理模式变化：重写 config.yaml（代理 watch 热加载，无需重启进程）。
        const nextProxyUrl = await resolveUpstreamProxyUrlSafe();
        if (nextProxyUrl !== appliedUpstreamProxyUrl) {
          await writeProxyConfig(status.port, nextProxyUrl);
          appliedUpstreamProxyUrl = nextProxyUrl;
          logger.info("cli-proxy upstream proxy switched", {
            proxyUrl: nextProxyUrl ?? "(direct)",
          });
        }
      }
      return status;
    },
    async getAuthUrl(channel) {
      // 登录前保证实例在跑：按需启动的判定只走 provider 配置（模板已创建即需要）。
      // error 态同样重试（同 refresh）；拉起后仍非 running 则直接报 proxy-stopped，
      // UI 按码渲染为代理未启动文案，不让用户停在无反馈的 starting。
      if (status.state === "stopped" || status.state === "error") {
        const needed = await options.hasDependentProviders();
        publish({ ...status, needed });
        if (needed) await startInternal();
      }
      // 拉起失败（无二进制/监听失败）时 port 为 null：明确报 proxy-stopped，
      // 而不是让管理面请求以空端口发出去再报含糊的网络错。
      if (status.state !== "running" || status.port === null) {
        throw new Error("proxy-stopped");
      }
      const { url, state } = await getCliProxyAuthUrl({ layout, port: status.port }, channel);
      return { url, state };
    },
    async pollAuthStatus(state) {
      return pollCliProxyAuthStatus({ layout, port: status.port }, state);
    },
    async submitAuthCallback(channel, payload) {
      await submitCliProxyAuthCallback({ layout, port: status.port }, channel, payload);
    },
    async fetchModels(channel = "codex") {
      return fetchCliProxyModels({ layout, port: status.port }, "default", channel);
    },
    async syncModels(providerId: ProviderId): Promise<CliProxyModelSyncResult> {
      const settings = options.getProviderSettings?.();
      if (!settings) throw new Error("Provider Settings 服务不可用");
      const view = await settings.getView();
      const provider = view.providers.find((candidate) => candidate.providerId === providerId);
      if (!provider || !isCliProxyProviderTemplateId(provider.templateId)) {
        throw new Error(`目标不是 CLI Proxy Provider: ${providerId}`);
      }
      const channel = cliProxyChannelFromTemplateId(provider.templateId);
      if (!channel) throw new Error(`无法识别 CLI Proxy Provider 渠道: ${providerId}`);
      const snapshot = await fetchCliProxyModels({ layout, port: status.port }, providerId, channel);
      if (snapshot.stale) throw new Error(snapshot.error ?? "CLI Proxy 模型名单不可用");
      const models = snapshot.models.map((model) => ({
        modelId: model.id,
        config: new ModelConfig({
          properties:
            model.capabilities?.contextWindow === undefined &&
            !model.capabilities?.inputModalities?.includes("image")
              ? undefined
              : new ModelPropertiesConfig({
                  ...(model.capabilities.contextWindow === undefined
                    ? {}
                    : { contextWindow: model.capabilities.contextWindow }),
                  ...(model.capabilities.inputModalities?.includes("image")
                    ? { inputFormat: new ModelInputFormatConfig({ supportsImage: true }) }
                    : {}),
                }),
        }),
      }));
      const syncDiscoveredProviderModels = options.syncDiscoveredProviderModels;
      if (!syncDiscoveredProviderModels) throw new Error("CLI Proxy 模型同步写入端口不可用");
      const result = await syncDiscoveredProviderModels(providerId, models);
      return {
        ...result,
        capabilitiesUpdated: !snapshot.capabilitiesStale,
        capabilitiesError: snapshot.capabilitiesError ?? null,
      };
    },
    async fetchQuota(providerId, channel) {
      return fetchCliProxyQuota({ layout, port: status.port }, providerId, channel);
    },
    async listAuthFiles() {
      return listCliProxyAuthFiles();
    },
    onDidChangeStatus: changed.event,
  };

  return {
    ...service,
    async resumeIfEnabled() {
      await syncStatusFromDisk();
      scheduleDailyCheck();
      // 启动时一次更新检查（走现有更新提示通道：状态里的 updateAvailable）。
      // markStartupDone=true：doStart 的首启下载复用本次结果，不再重发请求。
      // 不 await：检查/追新下载慢或挂起时不得推迟按需启动（真机复现 2026-10-14：
      // 上游 8.0.28 > 内置 8.0.27 触发追新下载，await 卡在下载上，refresh 永远
      // 跑不到，依赖 provider 已存在代理也永不启动）。doStart 内部的更新检查经
      // updateCheckInFlight 去重复用同一个 in-flight promise，不会并发请求。
      void runUpdateCheck(true).catch((error) => {
        logger.warn("cli-proxy startup update check failed", { message: errorMessage(error) });
      });
      await service.refresh();
    },
    async suspend() {
      await stopProcess();
      publish({ ...status, state: "stopped", port: null });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(dailyTimer);
      const settle = (): void => changed.dispose();
      void stopProcess().then(settle, settle);
    },
  };
}
