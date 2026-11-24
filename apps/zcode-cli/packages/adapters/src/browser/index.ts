import { randomUUID } from "node:crypto";
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserControlExecuteInput,
  BrowserControlListInput,
  BrowserControlPort,
  BrowserErrorCode,
} from "@zcode/contracts";
import {
  lowerProcessPriority,
  type ProcessPriority,
  type ProcessPriorityResult,
} from "@zcode/shared/node";
import type { Browser, BrowserServer } from "playwright-core";
import { createManagedCdpDescriptor } from "./descriptor.js";
import {
  loadPlaywrightChromium,
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
  type BrowserExecutableResolutionOptions,
  type PlaywrightChromiumModule,
} from "./executable.js";
import {
  MANAGED_BROWSER_LAUNCH_ARGS,
  spawnBrowserLaunchHost,
  type BrowserLaunchHost,
  type BrowserLaunchHostFactory,
} from "./launch-host.js";
import { executeManagedPageCommand } from "./page-command.js";
import { abortError, classifyError, hasSideEffects, raceWithAbort } from "./request.js";
import { ManagedCdpSession } from "./session.js";

export interface ManagedCdpBrowserRuntimeOptions extends BrowserExecutableResolutionOptions {
  closeTimeoutMs?: number;
  loadPlaywright?: () => Promise<PlaywrightChromiumModule>;
  /**
   * Linux 专用 idle 启动宿主工厂。测试可注入 fake host；缺省使用自 re-exec 的真实宿主。
   * 非 Linux 平台不会调用。
   */
  launchHost?: BrowserLaunchHostFactory;
  lowerPriority?: (
    pid: number | null | undefined,
    priority: ProcessPriority,
  ) => ProcessPriorityResult;
}

export interface ManagedCdpBrowserRuntime {
  browserControlPort: BrowserControlPort;
  close(): Promise<void>;
}

interface PendingRequest {
  controller: AbortController;
  sessionId: string;
  turnId?: string;
}

interface LaunchedBrowser {
  browser: Browser;
  /**
   * BrowserServer 的统一关闭句柄：Linux 指向 idle 宿主进程，非 Linux 直接包装 BrowserServer。
   * runtime 只通过它回收启动资源，不关心底层是进程还是同进程 server。
   */
  launchHost: BrowserLaunchHost;
}

const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 1_500;

class ManagedCdpBrowserControlPort implements BrowserControlPort {
  readonly #browserId = `cdp:${randomUUID()}`;
  readonly #loadPlaywright: () => Promise<PlaywrightChromiumModule>;
  readonly #options: ManagedCdpBrowserRuntimeOptions;
  readonly #closeTimeoutMs: number;
  readonly #closingSessionIds = new Set<string>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sessionPromises = new Map<string, Promise<ManagedCdpSession>>();
  readonly #sessions = new Map<string, ManagedCdpSession>();
  readonly #lowerPriority: NonNullable<ManagedCdpBrowserRuntimeOptions["lowerPriority"]>;
  readonly #launchHost: BrowserLaunchHostFactory;
  readonly #platform: NodeJS.Platform | string;
  readonly #browserCleanups = new Map<LaunchedBrowser, Promise<void>>();
  #launched: LaunchedBrowser | undefined;
  #disposed = false;
  #generation = 1;
  #launchPromise: Promise<LaunchedBrowser> | undefined;

  constructor(options: ManagedCdpBrowserRuntimeOptions) {
    this.#options = options;
    this.#loadPlaywright = options.loadPlaywright ?? loadPlaywrightChromium;
    this.#lowerPriority = options.lowerPriority ?? lowerProcessPriority;
    this.#closeTimeoutMs = Math.max(
      1,
      Math.trunc(options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS),
    );
    this.#launchHost =
      options.launchHost ??
      ((context) =>
        spawnBrowserLaunchHost(context, { closeTimeoutMs: this.#closeTimeoutMs }));
    this.#platform = options.platform ?? process.platform;
  }

  async list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]> {
    await this.ensureBrowser(input.signal);
    return [this.descriptor()];
  }

  async execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (input.browserId !== this.#browserId || input.browserGeneration !== this.#generation) {
      return this.errorResult(
        "backend_unavailable",
        `Browser backend '${input.browserId}' generation ${input.browserGeneration} is stale`,
        startedAt,
      );
    }

    const requestId = randomUUID();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(input.signal?.reason ?? abortError());
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();

    // 代理标签页是桌面 IAB 分区能力：CLI headless 的 Playwright 代理是 context 级，
    // 本期不支持 per-tab 代理；在启动浏览器之前就显式报错，而不是拉起浏览器后
    // 再拒绝（对齐共享错误码语义，省一次无意义的浏览器冷启动）。
    if (input.command.method === "newTab" && input.command.proxy === true) {
      return {
        ok: false,
        error: {
          code: "capability_unsupported",
          message:
            "proxy tabs are only supported by the desktop embedded browser (IAB). " +
            "Run the task in the ZCode desktop app or create a normal tab without proxy.",
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      };
    }

    this.#pending.set(requestId, {
      controller,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });

    let dispatched = false;
    try {
      if (controller.signal.aborted) throw abortError();
      await this.ensureBrowser(controller.signal);
      const session = await this.ensureSession(input.sessionId);
      if (controller.signal.aborted) throw abortError();
      dispatched = true;
      const partial = await raceWithAbort(
        this.executeSessionCommand(session, input.command),
        controller.signal,
      );
      return await this.withMeta(session, input.command, partial, startedAt);
    } catch (error) {
      const code = classifyError(error);
      return this.errorResult(
        code,
        error instanceof Error ? error.message : String(error),
        startedAt,
        code === "cancelled" && dispatched && hasSideEffects(input.command)
          ? "uncertain"
          : undefined,
      );
    } finally {
      input.signal?.removeEventListener("abort", forwardAbort);
      this.#pending.delete(requestId);
    }
  }

  async turnEnded(input: BrowserControlListInput): Promise<void> {
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === input.sessionId && pending.turnId === input.turnId) {
        pending.controller.abort(abortError());
      }
    }
  }

  async closeSession(input: BrowserControlListInput): Promise<void> {
    this.#closingSessionIds.add(input.sessionId);
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === input.sessionId) pending.controller.abort(abortError());
    }
    const creating = this.#sessionPromises.get(input.sessionId);
    if (creating) {
      const settled = await waitForPromise(creating, this.#closeTimeoutMs);
      if (!settled) {
        // late launch/context 创建完成后仍需再次回收；closingSessionIds 防止它重新登记 session。
        void creating.then(
          async () => {
            if (this.#sessions.size === 0) await this.closeBrowser();
          },
          async () => {
            if (this.#sessions.size === 0) await this.closeBrowser();
          },
        );
      }
    }
    const session = this.#sessions.get(input.sessionId);
    this.#sessions.delete(input.sessionId);
    if (session) await waitForPromise(session.close(), this.#closeTimeoutMs);
    if (this.#sessions.size === 0) await this.closeBrowser();
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const launchPromise = this.#launchPromise;
    for (const pending of this.#pending.values()) pending.controller.abort(abortError());
    this.#pending.clear();
    this.#closingSessionIds.clear();
    await Promise.all(
      [...this.#sessionPromises.values()].map(async (promise) => {
        await waitForPromise(promise, this.#closeTimeoutMs);
      }),
    );
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => {
        await waitForPromise(session.close(), this.#closeTimeoutMs);
      }),
    );
    this.#sessions.clear();
    await this.closeBrowser();
    // Playwright launch 可能仍在异步创建子进程；只关闭当前实例会漏掉迟到进程。
    if (launchPromise) {
      await waitForPromise(
        launchPromise.then(async (launched) => this.closeBrowserInstance(launched)),
        this.#closeTimeoutMs,
      );
    }
    // 意外断连可能已先启动 server 清理；close() 也要有界等待它，避免提前返回。
    await Promise.all(
      [...this.#browserCleanups.values()].map(async (closing) => {
        await waitForPromise(closing, this.#closeTimeoutMs);
      }),
    );
  }

  private descriptor(): BrowserBackendDescriptor {
    return createManagedCdpDescriptor(this.#browserId, this.#generation);
  }

  private async ensureBrowser(signal?: AbortSignal): Promise<Browser> {
    if (this.#disposed) throw new Error("Managed CDP browser runtime is closed");
    if (signal?.aborted) throw abortError();
    if (this.#launched?.browser.isConnected()) return this.#launched.browser;
    this.#launchPromise ??= (async (): Promise<LaunchedBrowser> => {
      let playwright: PlaywrightChromiumModule;
      try {
        playwright = await this.#loadPlaywright();
      } catch (error) {
        throw new Error(
          "Managed headless Chromium is unavailable: failed to load the pinned Playwright runtime.",
          { cause: error },
        );
      }

      const launched =
        this.#platform === "linux"
          ? await this.launchWithIdleHost(playwright)
          : await this.launchInProcess(playwright);

      if (this.#disposed) {
        await this.closeBrowserInstance(launched);
        throw new Error("Managed CDP browser runtime is closed");
      }
      const { browser } = launched;
      browser.on("disconnected", () => {
        if (this.#launched?.browser !== browser) return;
        const disconnected = this.#launched;
        this.#launched = undefined;
        this.#sessions.clear();
        this.#generation += 1;
        // 连接意外断开时浏览器进程可能仍存活，仍需关闭宿主/server。
        void this.closeBrowserInstance(disconnected);
      });
      this.#launched = launched;
      return launched;
    })().finally(() => {
      this.#launchPromise = undefined;
    });
    const launched = signal
      ? await raceWithAbort(this.#launchPromise, signal)
      : await this.#launchPromise;
    if (signal?.aborted) {
      await this.closeBrowserInstance(launched);
      throw abortError();
    }
    return launched.browser;
  }

  /**
   * Linux：浏览器由专用 idle 宿主创建。宿主在加载 Playwright 前已自降，Chromium 的
   * zygote/launcher 和 renderer 从 idle 主线程继承 nice 19；父进程只 connect。
   */
  private async launchWithIdleHost(
    playwright: PlaywrightChromiumModule,
  ): Promise<LaunchedBrowser> {
    let host: BrowserLaunchHost;
    try {
      host = await this.#launchHost({
        executablePath: this.#options.executablePath,
        args: [...MANAGED_BROWSER_LAUNCH_ARGS],
      });
    } catch (error) {
      throw launchFailedError(error);
    }

    let browser: Browser;
    try {
      browser = await playwright.chromium.connect(host.wsEndpoint);
    } catch (error) {
      // 宿主独占 BrowserServer；连接失败时由宿主关闭 server 并退出。
      await waitForPromise(host.close(), this.#closeTimeoutMs);
      throw launchFailedError(error);
    }
    return { browser, launchHost: host };
  }

  /**
   * Windows/macOS：进程内 launch。Windows 的 Idle 优先级类和 macOS 的进程级 nice
   * 会覆盖根进程及后代，因此在 connect 之前按公开的 BrowserServer.process() 设置根 PID。
   */
  private async launchInProcess(playwright: PlaywrightChromiumModule): Promise<LaunchedBrowser> {
    const executablePath = resolveInstalledBrowserExecutable(playwright, this.#options);
    let server: BrowserServer;
    try {
      server = await playwright.chromium.launchServer({
        executablePath,
        headless: true,
        // Playwright 缺省 host 时 Node 会绑定 ::/0.0.0.0；控制端口只允许回环。
        host: "127.0.0.1",
        args: [...MANAGED_BROWSER_LAUNCH_ARGS],
      });
    } catch (error) {
      // 底层 Playwright 错误可能包含临时 profile/CDP endpoint；对外只保留可操作分类，cause 供调试。
      throw launchFailedError(error);
    }

    // 在 connect 和任何 context/page/导航创建之前降低浏览器根进程；
    // 之后由该根进程派生的 renderer/utility 通常继承 idle。
    // lowerProcessPriority 自身不抛出；这里再兜底，避免优先级问题阻断浏览器启动。
    try {
      this.#lowerPriority(server.process().pid, "idle");
    } catch {
      // 优先级只是尽力而为，浏览器仍可继续连接；清理仍由 server/browser 负责。
    }

    const wsEndpoint = server.wsEndpoint();
    let browser: Browser;
    try {
      browser = await playwright.chromium.connect(wsEndpoint);
    } catch (error) {
      // connected Browser.close() 不会终止 launchServer 启动的进程，必须显式关闭 server。
      await waitForPromise(server.close(), this.#closeTimeoutMs);
      throw launchFailedError(error);
    }
    return {
      browser,
      launchHost: createServerLaunchHost(server, wsEndpoint, this.#closeTimeoutMs),
    };
  }

  private async ensureSession(sessionId: string): Promise<ManagedCdpSession> {
    if (this.#closingSessionIds.has(sessionId)) {
      throw new Error(`Browser session '${sessionId}' is closing`);
    }
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const creating = this.#sessionPromises.get(sessionId);
    if (creating) return await creating;

    const promise = (async () => {
      const browser = await this.ensureBrowser();
      const generation = this.#generation;
      const context = await browser.newContext({
        acceptDownloads: false,
        viewport: { width: 1280, height: 720 },
      });
      if (
        this.#disposed ||
        this.#closingSessionIds.has(sessionId) ||
        this.#launched?.browser !== browser ||
        this.#generation !== generation ||
        !browser.isConnected()
      ) {
        await waitForPromise(context.close(), this.#closeTimeoutMs);
        throw new Error("Managed CDP browser context became unavailable during creation");
      }
      const session = new ManagedCdpSession(context);
      this.#sessions.set(sessionId, session);
      return session;
    })();
    this.#sessionPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.#sessionPromises.get(sessionId) === promise) {
        this.#sessionPromises.delete(sessionId);
      }
    }
  }

  private async executeSessionCommand(
    session: ManagedCdpSession,
    command: BrowserCommand,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    switch (command.method) {
      case "list":
        return { ok: true, tabs: await session.listTabs() };
      case "newTab": {
        const tab = await session.createTab();
        return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
      }
      case "activateTab": {
        const tab = await session.activateTab(command.tabId);
        return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
      }
      case "close":
        await session.closeTab(command.tabId);
        return { ok: true };
      case "browserViewportSet":
        await session.setViewport(command.tabId, { width: command.width, height: command.height });
        return { ok: true };
      case "browserViewportReset":
        await session.setViewport(command.tabId, null);
        return { ok: true };
      case "getDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        const type = dialog?.type();
        return {
          ok: true,
          dialog:
            dialog && type && ["alert", "confirm", "prompt", "beforeunload"].includes(type)
              ? {
                  type: type as "alert" | "confirm" | "prompt" | "beforeunload",
                  message: dialog.message(),
                  ...(dialog.defaultValue() ? { defaultPrompt: dialog.defaultValue() } : {}),
                }
              : null,
        };
      }
      case "handleDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        if (!dialog) throw new Error("No JavaScript dialog is pending for this tab");
        if (command.accept) await dialog.accept(command.promptText);
        else await dialog.dismiss();
        session.clearDialog(tab.id);
        return { ok: true };
      }
      case "nameSession":
        return { ok: true };
      case "listUserTabs":
        return { ok: true, userTabs: [] };
      case "browserVisibilityGet":
      case "browserVisibilitySet":
      case "capabilities":
      case "claimTab":
      case "finalize":
      case "finalizeTabs":
      case "markDeliverable":
      case "markHandoff":
      case "turnEnded":
      case "closeSession":
      case "cancelRequest":
        return {
          ok: false,
          error: {
            code: "capability_unsupported",
            message: `Browser command '${command.method}' is unavailable in managed headless CDP`,
          },
        };
      default: {
        const tab = await session.ensureTab("tabId" in command ? command.tabId : undefined);
        return await executeManagedPageCommand(tab.page, command);
      }
    }
  }

  private async withMeta(
    session: ManagedCdpSession,
    command: BrowserCommand,
    partial: Omit<BrowserCommandResult, "elapsedMs">,
    startedAt: number,
  ): Promise<BrowserCommandResult> {
    const tabId = "tabId" in command ? command.tabId : session.activeTabId;
    const active = tabId ? await session.ensureTab(tabId).catch(() => undefined) : undefined;
    return {
      ...partial,
      elapsedMs: Date.now() - startedAt,
      meta: {
        browserUse: true,
        backendType: "cdp",
        browserId: this.#browserId,
        browserGeneration: this.#generation,
        openTabIds: session.tabIds,
        ...(active ? { tabId: active.id, currentUrl: active.page.url(), lifecycle: "active" } : {}),
      },
    };
  }

  private errorResult(
    code: BrowserErrorCode,
    message: string,
    startedAt: number,
    sideEffect?: "uncertain",
  ): BrowserCommandResult {
    return {
      ok: false,
      error: { code, message, ...(sideEffect ? { sideEffect } : {}) },
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async closeBrowser(): Promise<void> {
    const launched = this.#launched;
    this.#launched = undefined;
    if (launched) await this.closeBrowserInstance(launched);
  }

  private closeBrowserInstance(launched: LaunchedBrowser): Promise<void> {
    const existing = this.#browserCleanups.get(launched);
    if (existing) return existing;
    // 意外断连和主动 close 可能同时触发；同一个浏览器实例只允许一条清理路径。
    // 先登记再执行，避免清理过程中同步触发的第二次调用绕过去重。
    const closing = Promise.resolve()
      .then(async () => this.closeBrowserResources(launched))
      .finally(() => {
        this.#browserCleanups.delete(launched);
      });
    this.#browserCleanups.set(launched, closing);
    return closing;
  }

  private async closeBrowserResources(launched: LaunchedBrowser): Promise<void> {
    const { browser, launchHost } = launched;
    // connected Browser.close() 只断开连接，不会终止 launchServer 启动的浏览器；
    // 必须再关闭 BrowserServer/宿主，否则浏览器进程会在连接关闭后残留。
    try {
      if (browser.isConnected()) {
        // WebSocket/SSE 页面可能让 Playwright 的 context/browser close 永不 settle。
        // adapter 只能有限等待；外层 session cleanup 和 CLI watchdog 会继续回收其它资源。
        await waitForPromise(browser.close(), this.#closeTimeoutMs);
      }
    } catch {
      // close 的同步异常也不能阻止 server 回收。
    }
    try {
      await waitForPromise(launchHost.close(), this.#closeTimeoutMs);
    } catch {
      // 清理是尽力而为；不改变调用方的取消/退出结果。
    }
  }
}

export function createManagedCdpBrowserRuntime(
  options: ManagedCdpBrowserRuntimeOptions = {},
): ManagedCdpBrowserRuntime {
  const normalizedOptions = {
    ...options,
    executablePath: validateExplicitBrowserExecutable(options.executablePath, options.platform),
  };
  const port = new ManagedCdpBrowserControlPort(normalizedOptions);
  return {
    browserControlPort: port,
    close: async () => port.close(),
  };
}

export {
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
} from "./executable.js";
export type { BrowserExecutableResolutionOptions, PlaywrightChromiumModule } from "./executable.js";
export { isAllowedManagedBrowserUrl } from "./page-command.js";
export { MANAGED_BROWSER_LAUNCH_ARGS } from "./launch-host.js";

function launchFailedError(cause: unknown): Error {
  return new Error(
    "Managed headless Chromium is unavailable: launch failed. " +
      "Verify the browser executable and OS sandbox/runtime dependencies.",
    { cause },
  );
}

/**
 * 非 Linux 的进程内路径：把公开的 BrowserServer 句柄包装成与宿主相同的关闭接口。
 * close 只执行一次；并发/重复调用复用同一个 promise。
 */
function createServerLaunchHost(
  server: BrowserServer,
  wsEndpoint: string,
  closeTimeoutMs: number,
): BrowserLaunchHost {
  let closing: Promise<void> | undefined;
  return {
    wsEndpoint,
    close() {
      closing ??= waitForPromise(server.close(), closeTimeoutMs).then(() => undefined);
      return closing;
    },
  };
}

function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(completed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
