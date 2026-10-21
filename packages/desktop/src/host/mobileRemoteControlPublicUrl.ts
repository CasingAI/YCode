/**
 * 公网链接（隧道）的运行时控制器。
 *
 * 从远控运行时里独立出来，是因为隧道有自己的生命周期：**它必须与监听同生共死**
 * （远控停了、窗口销毁了，公网入口不能还开着），但它不是远控状态轴的一部分——
 * 隧道失败绝不能把远控本身打成 error，局域网链接还得继续能用。
 *
 * 因此这里只管三件事：起隧道、停隧道、把「公网这一段的状态」如实报给宿主。
 * Provider 分派也发生在这里：两个 Provider 的差别只在"怎么把端口暴露出去"，
 * 之后的生命周期管理（起、停）是同一套。
 *
 * **创建与关闭不能交叉**：这一点用「生命周期代次」表达——每次创建、每次关闭都推进代次，
 * 在途创建只认自己发起时的代次。关闭一旦推进代次，在途创建的回调就全部失效：
 * 既不能发布 running，也不能把迟到的隧道句柄交给宿主，更不能去动当前隧道的状态。
 * 规则与验收场景见 `docs/specs/mobile-remote-control.md`。
 */
import {
  buildPublicAccessUrl,
  findPublicTunnelProvider,
  validatePublicTunnelParams,
  type PublicTunnelCreateParams,
  type PublicTunnelStatus,
} from "@zcode/services";
import { startCloudflaredTunnel } from "./publicTunnelCloudflared.js";
import {
  startLocaltunnelTunnel,
  type LocaltunnelClientFactory,
} from "./publicTunnelLocaltunnel.js";
import type { PublicTunnelHandle, PublicTunnelLogger } from "./publicTunnelTypes.js";

/** 创建隧道时宿主提供的现场信息；控制器不自己去查远控状态。 */
export interface PublicUrlContext {
  /** 宿主已释放。 */
  disposed: boolean;
  /** 远控是否正在运行（隧道转发的就是它）。 */
  running: boolean;
  /** 远控监听端口；隧道目标端口。 */
  port: number | undefined;
  /** 本次监听的 token；公网链接复用它，公网与局域网因此是同一套凭据。 */
  token: string | undefined;
}

/**
 * 现场信息的读取方式。
 *
 * 用读取函数而不是快照：创建可能被排在一次关闭之后才真正执行，那时远控可能已经停了，
 * 快照里的"运行中"就是假的——照快照去起隧道会得到一条指向死端口的公网入口。
 */
export type PublicUrlContextReader = () => PublicUrlContext;

/** 启动隧道时控制器交给启动器的现场。 */
export interface PublicTunnelStartTarget {
  /** 隧道目标端口（远控监听端口）。 */
  port: number;
  /** 取消信号：关闭时 abort，启动器据此尽快收敛，不让用户干等超时。 */
  signal: AbortSignal;
  /** 隧道进程意外退出时回调；过期回调不得改动当前隧道的状态。 */
  onUnexpectedExit?: () => void;
}

/**
 * 隧道启动器。
 *
 * 默认走内置的两个 launcher；单测注入假启动器，用来复现"隧道迟迟不ready"这类时序。
 */
export type PublicTunnelStarter = (
  params: PublicTunnelCreateParams,
  target: PublicTunnelStartTarget,
) => Promise<PublicTunnelHandle>;

export interface PublicUrlControllerOptions {
  /** 内置 cloudflared 路径；解析不到返回 undefined。 */
  resolveBinaryPath: () => string | undefined;
  logger: PublicTunnelLogger;
  /** 公网这一段状态变化时回调；undefined 表示清空。 */
  onStatus: (next: PublicTunnelStatus | undefined) => void;
  /**
   * localtunnel 客户端工厂；单测注入假客户端，避免真联网。
   *
   * 生产路径不传，走 npm 包。
   */
  createLocaltunnelClient?: LocaltunnelClientFactory;
  /**
   * 隧道启动器；单测注入假启动器。
   *
   * 生产路径不传，走内置的 Provider 分派。
   */
  startTunnel?: PublicTunnelStarter;
}

export interface PublicUrlController {
  /**
   * 创建公网链接。
   *
   * 幂等：已有隧道时直接返回，不换地址、不起第二条隧道。
   * 过程中的状态变化（starting → running/error）经 onStatus 报给宿主。
   */
  create(params: PublicTunnelCreateParams, readContext: PublicUrlContextReader): Promise<void>;
  /** 关闭公网链接：终止隧道并清空状态。 */
  close(): Promise<void>;
  /** 宿主停止/销毁：终止隧道并清空状态（与 close 同一套终止逻辑）。 */
  dispose(): Promise<void>;
  /** 当前公网状态；没有隧道时是 undefined。 */
  readonly status: PublicTunnelStatus | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPublicUrlController(
  options: PublicUrlControllerOptions,
): PublicUrlController {
  let tunnel: PublicTunnelHandle | undefined;
  let current: PublicTunnelStatus | undefined;
  // 生命周期代次：每次创建与每次关闭都推进一次。
  // 在途创建只认自己发起时的代次——代次一旦被关闭推进，它的回调就失效了。
  let generation = 0;
  // 在途创建：弹窗可能被连点，第二次不能起第二条隧道。
  let pending: { promise: Promise<void>; abort: AbortController } | undefined;
  // 在途关闭：关闭过程中的新创建要排在它后面，不能与关闭交叉。
  let closing: Promise<void> | undefined;

  const setStatus = (next: PublicTunnelStatus | undefined): void => {
    current = next;
    options.onStatus(next);
  };

  /** 终止隧道进程并清掉句柄；没有隧道时是空操作。 */
  const stopTunnel = async (): Promise<void> => {
    const nextTunnel = tunnel;
    tunnel = undefined;
    if (!nextTunnel) return;
    await nextTunnel.stop().catch((error: unknown) => {
      options.logger.warn("mobile remote control tunnel stop failed", {
        message: errorMessage(error),
      });
    });
  };

  /**
   * 隧道自己退了（进程被 kill、崩溃）：公网入口已经不可达，回落为 stopped。
   *
   * 代次已过期的回调不碰当前隧道：那条隧道早被关闭作废了，它的退出与现在这条无关。
   */
  const handleUnexpectedExit = (
    provider: PublicTunnelCreateParams["provider"],
    gen: number,
  ): void => {
    if (gen !== generation) return;
    tunnel = undefined;
    setStatus({ provider, state: "stopped" });
  };

  /**
   * cloudflared 二进制路径。
   *
   * 只在 Cloudflare 这条路径上要求它：localtunnel 不需要任何本地二进制，
   * 因此不能因为缺二进制就把它也堵死。
   */
  const resolveCloudflaredBinary = (): string => {
    const binaryPath = options.resolveBinaryPath();
    if (!binaryPath) {
      throw new Error("未找到内置 cloudflared 二进制，无法创建公网链接");
    }
    return binaryPath;
  };

  /**
   * 默认启动器：按 Provider 分派到两个 launcher。
   *
   * 分派在这里是因为"怎么把端口暴露出去"是 Provider 的差别；
   * "起来之后怎么管"是控制器的事，两边不混。
   */
  const defaultStarter: PublicTunnelStarter = async (params, target) => {
    if (params.provider === "localtunnel") {
      return startLocaltunnelTunnel({
        port: target.port,
        subdomain: params.subdomain ?? "",
        logger: options.logger,
        signal: target.signal,
        ...(options.createLocaltunnelClient
          ? { createClient: options.createLocaltunnelClient }
          : {}),
      });
    }
    return startCloudflaredTunnel({
      binaryPath: resolveCloudflaredBinary(),
      target: `http://127.0.0.1:${String(target.port)}`,
      logger: options.logger,
      signal: target.signal,
      ...(target.onUnexpectedExit ? { onUnexpectedExit: target.onUnexpectedExit } : {}),
    });
  };

  const startTunnel = options.startTunnel ?? defaultStarter;

  const createInternal = async (
    params: PublicTunnelCreateParams,
    gen: number,
    signal: AbortSignal,
    readContext: PublicUrlContextReader,
  ): Promise<void> => {
    // 代次已经变了：这次请求被关闭作废了，连状态都不该报。
    if (gen !== generation) return;
    const context = readContext();
    if (context.disposed) {
      setStatus({ provider: params.provider, state: "error", error: "窗口 Host 已释放" });
      return;
    }
    if (!context.running || !context.token || context.port === undefined) {
      setStatus({ provider: params.provider, state: "error", error: "请先开启远程控制" });
      return;
    }
    // 幂等：已经有隧道在跑就不换地址、不换 Provider。
    if (tunnel) return;
    const invalid = validatePublicTunnelParams(params);
    if (invalid) {
      setStatus({ provider: params.provider, state: "error", error: invalid });
      return;
    }
    if (!findPublicTunnelProvider(params.provider)) {
      setStatus({
        provider: params.provider,
        state: "error",
        error: `未知的隧道服务商：${params.provider}`,
      });
      return;
    }
    const token = context.token;
    setStatus({ provider: params.provider, state: "starting" });
    try {
      const handle = await startTunnel(params, {
        port: context.port,
        signal,
        onUnexpectedExit: () => handleUnexpectedExit(params.provider, gen),
      });
      if (gen !== generation) {
        // 迟到的隧道：这次创建已经被关闭作废了。句柄就地回收（终止进程），
        // 不交给宿主，也不发布 running——用户看到的仍然是"没有公网链接"。
        await handle.stop().catch((error: unknown) => {
          options.logger.warn("mobile remote control stale tunnel stop failed", {
            message: errorMessage(error),
          });
        });
        return;
      }
      tunnel = handle;
      setStatus({
        provider: params.provider,
        state: "running",
        url: buildPublicAccessUrl(handle.url, token),
      });
    } catch (error) {
      if (gen !== generation) {
        // 已作废：这次失败不该复活公网状态（关闭已经清空过了）。
        return;
      }
      const message = errorMessage(error);
      options.logger.warn("mobile remote control tunnel start failed", { message });
      setStatus({ provider: params.provider, state: "error", error: message });
    }
  };

  const create = (
    params: PublicTunnelCreateParams,
    readContext: PublicUrlContextReader,
  ): Promise<void> => {
    // 关闭进行中：排在关闭之后执行，不与关闭交叉。
    if (closing) {
      return closing.then(() => create(params, readContext));
    }
    // 弹窗可能被连点：第二次沿用同一次创建，不另起一条隧道。
    if (pending) return pending.promise;
    const gen = ++generation;
    const abort = new AbortController();
    const promise = createInternal(params, gen, abort.signal, readContext).finally(() => {
      if (pending?.promise === promise) pending = undefined;
    });
    pending = { promise, abort };
    return promise;
  };

  /**
   * 关闭的固定动作顺序：作废在途创建 → 取消正在进行的启动 → 等它收尾 → 停隧道 → 清状态。
   *
   * 等它收尾是关键：迟到的隧道句柄由创建方就地回收，关闭返回之后不允许还有隧道活着。
   */
  const runClose = async (): Promise<void> => {
    // 代次推进：在途创建立刻失效——它的回调不再有权发布状态或接管隧道。
    generation += 1;
    const pendingCreate = pending;
    // 取消正在进行的启动：否则要等它自己走完 30 秒超时。
    pendingCreate?.abort.abort();
    if (pendingCreate) {
      await pendingCreate.promise.catch(() => undefined);
    }
    // 隧道必须与监听同生共死：这里先停隧道，宿主才敢去关监听。
    await stopTunnel();
    setStatus(undefined);
  };

  const close = (): Promise<void> => {
    closing ??= runClose().finally(() => {
      closing = undefined;
    });
    return closing;
  };

  return {
    create,
    close,
    dispose: close,
    get status() {
      return current;
    },
  };
}
