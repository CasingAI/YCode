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
}

export interface PublicUrlController {
  /**
   * 创建公网链接。
   *
   * 幂等：已有隧道时直接返回，不换地址、不起第二条隧道。
   * 过程中的状态变化（starting → running/error）经 onStatus 报给宿主。
   */
  create(params: PublicTunnelCreateParams, context: PublicUrlContext): Promise<void>;
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
  // create() 也要串行：弹窗可能被连点，第二次不能起第二条隧道。
  let inFlight: Promise<void> | undefined;

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

  /** 隧道自己退了（进程被 kill、崩溃）：公网入口已经不可达，回落为 stopped。 */
  const handleUnexpectedExit = (provider: PublicTunnelCreateParams["provider"]): void => {
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

  const createInternal = async (
    params: PublicTunnelCreateParams,
    context: PublicUrlContext,
  ): Promise<void> => {
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
      const handle =
        params.provider === "localtunnel"
          ? await startLocaltunnelTunnel({
              port: context.port,
              subdomain: params.subdomain ?? "",
              logger: options.logger,
              ...(options.createLocaltunnelClient
                ? { createClient: options.createLocaltunnelClient }
                : {}),
            })
          : await startCloudflaredTunnel({
              binaryPath: resolveCloudflaredBinary(),
              target: `http://127.0.0.1:${String(context.port)}`,
              logger: options.logger,
              onUnexpectedExit: () => handleUnexpectedExit(params.provider),
            });
      tunnel = handle;
      setStatus({
        provider: params.provider,
        state: "running",
        url: buildPublicAccessUrl(handle.url, token),
      });
    } catch (error) {
      const message = errorMessage(error);
      options.logger.warn("mobile remote control tunnel start failed", { message });
      setStatus({ provider: params.provider, state: "error", error: message });
    }
  };

  const create = (params: PublicTunnelCreateParams, context: PublicUrlContext): Promise<void> => {
    inFlight ??= createInternal(params, context).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const close = async (): Promise<void> => {
    await stopTunnel();
    setStatus(undefined);
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
