/**
 * 手机远控 runtime —— 桌面 Host 进程内的局域网前端。
 *
 * 唯一状态所有者：由 Host 持有，窗口级生命周期。start() 起一个局域网 HTTP + WebSocket
 * 服务，把 Host 的**同一份** activeServices 用 SocketProtocol 暴露给手机浏览器，
 * 因此手机看到与桌面同一个工作区、同一个会话。
 *
 * 与 zcode --web / packages/zcode-server-cli 的区别：那两个进程各自 createLocalServices，
 * 手机连上去是"另一个工作区"；这里复用窗口 Host 现有服务与 agent。
 *
 * 端口与 token 都是**固定**的（落盘在 mobileRemoteControlStateStore）：
 * - 手机端链接可以长期收藏，App 重启后自动恢复监听，地址不变；
 * - token 轮换只有 resetToken() 一条路径，原端口被别的程序占用时才换端口。
 */
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ChannelServer,
  Emitter,
  LoggingChannelServer,
  SocketProtocol,
  type IChannelServer,
  type ISocket,
} from "@zcode/rpc";
import { createLanHttpServer, type LanHttpServer } from "@zcode/server";
import {
  IMobileRemoteControlService,
  type MobileRemoteControlErrorCode,
  type MobileRemoteControlPersistedState,
  type MobileRemoteControlStartParams,
  type MobileRemoteControlStatus,
  type ServiceCollection,
} from "@zcode/services";
import {
  buildLanAccessView,
  createAccessToken,
  createFileMobileRemoteControlStateStore,
  listLanAddresses,
  pickFreePort,
  type MobileRemoteControlStateStore,
} from "@zcode/services/node";
import type { ServerRemoteWorkspaceInfo } from "@zcode/shared";

export interface MobileRemoteControlLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface MobileRemoteControlRuntimeOptions {
  /** 当前活跃服务集合；Host 尚未初始化完成时返回 null。 */
  getServices: () => ServiceCollection | null;
  /** web 产物根目录（ZCODE_MOBILE_WEB_ROOT）；未解析到时返回 undefined。 */
  resolveWebRoot: () => string | undefined;
  /**
   * 把活跃服务暴露到这条手机连接上，返回释放函数。
   *
   * 由 Host 提供：复用与 renderer attachment 同一套 overrides 构造，并排除远控通道本身
   * 与跨 Environment 的 provisioning target。
   */
  exposeServices: (server: IChannelServer, services: ServiceCollection) => () => void;
  logger: MobileRemoteControlLogger;
  /** 与 renderer attachment 同一条 RPC 日志通道。 */
  logRpc: (message: string) => void;
  /** 固定端口 / token 的落盘位置；默认写数据目录，单测注入内存实现。 */
  stateStore?: MobileRemoteControlStateStore;
}

export interface MobileRemoteControlRuntime {
  service: IMobileRemoteControlService;
  /**
   * 窗口 Host 初始化完成后调用：上次是开启状态就自动恢复监听。
   *
   * 此刻才调用是因为 exposeServices 依赖 activeServices；失败不抛错，
   * 由状态机落到 error（enabled 保持 true，用户可在弹窗里看到原因并重试）。
   */
  resumeIfEnabled(params?: MobileRemoteControlStartParams): Promise<void>;
  /**
   * 窗口销毁：收回监听与手机连接，但**保留用户意图**。
   *
   * 与 UI 主动"停止"不同，这里不把 enabled 落成 false——否则 App 下次启动就没有东西可恢复。
   * 收回监听后 Host 进程若被复用，service.start() 仍可再次开启。
   */
  suspend(): Promise<void>;
  dispose(): void;
}

interface MobileAttachment {
  dispose(): void;
}

/** stopped 态的固定形状：只有用户意图会变。 */
function idleStatus(enabled: boolean): MobileRemoteControlStatus {
  return { state: "stopped", enabled, lanUrls: [], connectedClients: 0 };
}

/** 只有"端口被占用"才值得让位换端口；其它绑定失败（权限、地址不可用）如实报错。 */
function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "EADDRINUSE";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createMobileRemoteControlRuntime(
  options: MobileRemoteControlRuntimeOptions,
): MobileRemoteControlRuntime {
  const changed = new Emitter<MobileRemoteControlStatus>();
  const attachments = new Set<MobileAttachment>();
  const stateStore = options.stateStore ?? createFileMobileRemoteControlStateStore();
  let status: MobileRemoteControlStatus = idleStatus(false);
  let lan: LanHttpServer | undefined;
  let workspace: ServerRemoteWorkspaceInfo | undefined;
  // 记录最近一次 start 的入参：resetToken() 要在同端口重建监听，必须沿用同一个 workspace。
  let startParams: MobileRemoteControlStartParams | undefined;
  // 落盘状态的内存副本，唯一权威来源；写盘失败只影响下次启动能否自动恢复，不影响本次运行。
  let persisted: MobileRemoteControlPersistedState = { enabled: false };
  let persistedLoaded: Promise<void> | undefined;
  // start() 并发去重：弹窗可能被连点，第二次不能起第二个监听。
  let startInFlight: Promise<MobileRemoteControlStatus> | undefined;
  let disposed = false;

  const publish = (next: MobileRemoteControlStatus): MobileRemoteControlStatus => {
    status = next;
    changed.fire(next);
    return status;
  };

  /**
   * 读一次落盘状态（进程内只读一次）。
   *
   * 读失败/坏文件按"从未开启"处理：远控不能因为一个坏文件挡住 Host 启动。
   */
  const ensurePersistedLoaded = (): Promise<void> => {
    persistedLoaded ??= (async () => {
      try {
        const loaded = await stateStore.read();
        if (loaded) persisted = loaded;
      } catch (error) {
        options.logger.warn("mobile remote control state read failed", {
          message: errorMessage(error),
        });
      }
      // 让 getStatus() 之外的订阅者也能看到落盘的用户意图（renderer 在 Host 启动后才订阅）。
      if (status.state === "stopped" && status.enabled !== persisted.enabled) {
        publish(idleStatus(persisted.enabled));
      }
    })();
    return persistedLoaded;
  };

  const persistState = async (next: MobileRemoteControlPersistedState): Promise<void> => {
    persisted = next;
    try {
      await stateStore.write(next);
    } catch (error) {
      options.logger.warn("mobile remote control state write failed", {
        message: errorMessage(error),
      });
    }
  };

  const fail = (code: MobileRemoteControlErrorCode, detail: string): MobileRemoteControlStatus => {
    options.logger.warn("mobile remote control start failed", { code, detail });
    return publish({
      state: "error",
      // 失败不改用户意图：自动恢复失败时 enabled 仍为 true，弹窗里显示原因即可。
      enabled: persisted.enabled,
      lanUrls: [],
      connectedClients: 0,
      errorCode: code,
      error: detail,
    });
  };

  const setConnectedClients = (next: number): void => {
    if (status.state !== "running") return;
    publish({ ...status, connectedClients: Math.max(0, next) });
  };

  /**
   * 一条手机 WebSocket = 一个独立的 ChannelServer。
   *
   * 与 renderer attachment 平级：同一份 activeServices，只是 transport 换成 WS。
   */
  const attachMobileConnection = (socket: ISocket): void => {
    const services = options.getServices();
    if (!services) {
      socket.dispose();
      return;
    }
    const protocol = new SocketProtocol(socket);
    const rawServer = new ChannelServer(protocol, "host");
    const server = new LoggingChannelServer(rawServer, options.logRpc);
    const disposeOverrides = options.exposeServices(server, services);
    let closed = false;
    const attachment: MobileAttachment = {
      dispose() {
        if (closed) return;
        closed = true;
        attachments.delete(attachment);
        // stop() 主动断开手机时 socket 还在；onClose 触发时它已经关了，dispose 幂等。
        socket.dispose();
        rawServer.dispose();
        disposeOverrides();
      },
    };
    attachments.add(attachment);
    socket.onClose(() => {
      attachment.dispose();
      setConnectedClients(attachments.size);
    });
    setConnectedClients(attachments.size);
    options.logger.info(`mobile remote control client attached, clients=${attachments.size}`);
  };

  const resolveWebRoot = async (): Promise<string | undefined> => {
    const root = options.resolveWebRoot()?.trim();
    if (!root) return undefined;
    // 只认 index.html 存在：让"未构建 web 产物"在开启时就明确失败，而不是让手机打开 404 页面。
    try {
      const indexStat = await stat(join(root, "index.html"));
      return indexStat.isFile() ? root : undefined;
    } catch {
      return undefined;
    }
  };

  /** 只回收监听与手机连接，不动落盘状态；stop() 与 resetToken() 共用。 */
  const closeListener = async (): Promise<void> => {
    const nextLan = lan;
    lan = undefined;
    if (nextLan) {
      await nextLan.close().catch((error: unknown) => {
        options.logger.warn("mobile remote control close failed", {
          message: errorMessage(error),
        });
      });
    }
    // 关监听不会断开已建立的连接，必须显式释放每条 attachment，否则手机仍持有会话。
    for (const attachment of Array.from(attachments)) {
      attachment.dispose();
    }
    attachments.clear();
  };

  const doStart = async (
    params?: MobileRemoteControlStartParams,
  ): Promise<MobileRemoteControlStatus> => {
    await ensurePersistedLoaded();
    publish({ state: "starting", enabled: persisted.enabled, lanUrls: [], connectedClients: 0 });
    const services = options.getServices();
    if (!services) {
      return fail("start-failed", "Host services 尚未就绪");
    }
    startParams = params;
    const workspacePath = params?.workspacePath?.trim();
    const workspaceIdentity = params?.workspaceIdentity?.trim();
    workspace = workspacePath
      ? {
          path: workspacePath,
          label: basename(workspacePath) || workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        }
      : undefined;

    const staticRoot = await resolveWebRoot();
    if (!staticRoot) {
      return fail(
        "web-root-missing",
        "未找到手机端 Web 产物（ZCODE_MOBILE_WEB_ROOT 未指向含 index.html 的目录）",
      );
    }

    // 端口与 token 都沿用落盘值：手机端链接因此跨重启稳定。
    const token = persisted.token ?? createAccessToken();
    const addresses = listLanAddresses();
    // 真实绑定端口只有 listening 之后才确定：请求的端口可能被占用后让位，pickFreePort 的结果也可能
    // 被别的进程抢占，所以用 onListening 回调把实际端口捞出来，不能想当然认为等于入参。
    // 此前这里漏了这一步（tryListen 只返回 server，调用方读 started.port 得到 undefined），
    // 链接会拼成 `http://<ip>:undefined/`，落盘也写不进端口，"固定端口"形同虚设。
    const listenOn = (
      port: number,
    ): { server: LanHttpServer; boundPort: () => number | undefined } => {
      let boundPort: number | undefined;
      const server = createLanHttpServer({
        port,
        // 绑全部网卡：多网卡（有线 + 无线 + VPN）时由用户在弹窗里选能连通的那个地址。
        host: "0.0.0.0",
        token,
        staticRoot,
        serverInfo: {
          // authRequired 必须显式给：createServerInfo 默认读的是 ZCODE_SERVER_TOKEN 环境变量，
          // 在桌面 Host 里那是空的，会让手机误判"无需鉴权"。
          authRequired: true,
          serverId: `zcode-desktop-${process.pid}`,
          name: "ZCode Desktop",
          workspaces: workspace ? [workspace] : [],
        },
        webSocket: { path: "/ws", onConnection: attachMobileConnection },
        onListening: (info) => {
          boundPort = info.port;
        },
      });
      return { server, boundPort: () => boundPort };
    };
    const tryListen = async (
      port: number,
    ): Promise<
      { ok: true; server: LanHttpServer; port: number } | { ok: false; error: unknown }
    > => {
      const attempt = listenOn(port);
      try {
        // createLanHttpServer 先回调 onListening 再 resolve ready，所以这里端口已经确定；
        // 兜底退回请求端口，保证任何情况下都不会把 undefined 写进链接和落盘状态。
        await attempt.server.ready;
        return { ok: true, server: attempt.server, port: attempt.boundPort() ?? port };
      } catch (error) {
        await attempt.server.close().catch(() => {});
        return { ok: false, error };
      }
    };

    let started = persisted.port === undefined ? undefined : await tryListen(persisted.port);
    if (started && !started.ok) {
      if (!isAddressInUse(started.error)) {
        return fail("start-failed", errorMessage(started.error));
      }
      // 固定端口被占用（另一个 YCode 窗口、或别的程序）：本次临时让位到空闲端口。
      // 让位结果**不覆盖落盘端口**——手机端链接的稳定性优先，占用者走了下次就回到原端口。
      options.logger.warn("mobile remote control port in use, falling back to a free port", {
        port: persisted.port,
      });
      started = undefined;
    }
    if (!started) {
      const attempt = await tryListen(await pickFreePort());
      if (!attempt.ok) {
        return fail("start-failed", errorMessage(attempt.error));
      }
      started = attempt;
    }
    const nextLan = started.server;
    const startedPort = started.port;

    if (disposed) {
      // 启动过程中窗口被关闭：立刻收回监听，不能留下无人管的端口。
      await nextLan.close().catch(() => {});
      return status;
    }
    lan = nextLan;

    const view = buildLanAccessView({ port: startedPort, token, addresses });
    // 用户意图、固定端口与 token 一起落盘；端口只在首次确定时写入，之后不因临时占用漂移。
    await persistState({ enabled: true, port: persisted.port ?? startedPort, token });
    options.logger.info(
      `mobile remote control started, port=${startedPort}, addresses=${addresses.length}`,
    );
    return publish({
      state: "running",
      enabled: true,
      accessUrl: view.accessUrl,
      lanUrls: view.lanUrls,
      port: startedPort,
      connectedClients: 0,
    });
  };

  const startInternal = (
    params?: MobileRemoteControlStartParams,
  ): Promise<MobileRemoteControlStatus> => {
    startInFlight ??= doStart(params).finally(() => {
      startInFlight = undefined;
    });
    return startInFlight;
  };

  const stop = async (): Promise<MobileRemoteControlStatus> => {
    await ensurePersistedLoaded();
    await closeListener();
    workspace = undefined;
    startParams = undefined;
    // 端口与 token 保持不变（手机端链接固定），这里只把用户意图落成关闭。
    await persistState({
      enabled: false,
      ...(persisted.port === undefined ? {} : { port: persisted.port }),
      ...(persisted.token === undefined ? {} : { token: persisted.token }),
    });
    options.logger.info("mobile remote control stopped");
    return publish(idleStatus(false));
  };

  const resetToken = async (): Promise<MobileRemoteControlStatus> => {
    await ensurePersistedLoaded();
    const token = createAccessToken();
    const wasRunning = status.state === "running" || status.state === "starting";
    await persistState({ ...persisted, token });
    options.logger.info("mobile remote control token rotated", { wasRunning });
    if (!wasRunning) {
      // 未运行：新 token 下次开启时才用得上，不必动监听。
      return publish({ ...status, enabled: persisted.enabled });
    }
    // 运行中：token 在建立监听时就绑定了，换 token 必须重建监听。
    // 沿用 startParams，端口优先复用，因此换完 token 地址只有 token 部分变化。
    await closeListener();
    return startInternal(startParams);
  };

  const resumeIfEnabled = async (params?: MobileRemoteControlStartParams): Promise<void> => {
    await ensurePersistedLoaded();
    if (disposed || !persisted.enabled) {
      return;
    }
    if (status.state !== "stopped") {
      return;
    }
    options.logger.info("mobile remote control auto-restoring previous enabled state");
    await startInternal(params);
  };

  const suspend = async (): Promise<void> => {
    await closeListener();
    workspace = undefined;
    startParams = undefined;
    // 监听已收回，状态必须跟着回落，否则 Host 进程被复用后新的 renderer 会看到
    // "running 但端口没人听"的假状态；enabled 保持用户意图（true），下次启动自动恢复。
    publish(idleStatus(persisted.enabled));
  };

  const runtime: MobileRemoteControlRuntime = {
    service: {
      async getStatus() {
        await ensurePersistedLoaded();
        return status;
      },
      async start(params?: MobileRemoteControlStartParams) {
        if (disposed) {
          return fail("start-failed", "窗口 Host 已释放");
        }
        await ensurePersistedLoaded();
        if (status.state === "running") {
          return status;
        }
        return startInternal(params);
      },
      async stop() {
        await ensurePersistedLoaded();
        // enabled 也是 stop() 的职责：suspend() 之后监听没了但用户意图还在，
        // 此时点"停止"必须把意图落成关闭，否则下次启动又自动开回来。
        if (status.state === "stopped" && !lan && attachments.size === 0 && !persisted.enabled) {
          return status;
        }
        return stop();
      },
      resetToken,
      // 事件属性：直接给出 Emitter 的 event，ProxyChannel.fromService 会按 on* 约定注册为事件。
      onDidChangeStatus: changed.event,
    },
    resumeIfEnabled,
    suspend,
    dispose() {
      if (disposed) return;
      disposed = true;
      const settle = () => changed.dispose();
      // 窗口销毁只收回监听，**不写 enabled=false**：用户意图必须留在盘上，
      // 下次启动 resumeIfEnabled() 才会把远控自动恢复成同一个地址。
      void suspend().then(settle, settle);
    },
  };
  return runtime;
}
