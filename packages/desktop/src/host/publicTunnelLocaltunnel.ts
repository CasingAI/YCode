/**
 * localtunnel 隧道管理 —— 桌面 Host 侧。
 *
 * localtunnel 是一个 MIT 开源、免注册的隧道服务：客户端主动外连到它的服务器，
 * 服务器再把公网流量原样转回本机端口（TCP 级中继），因此 HTTP 与 WebSocket 升级
 * 都能透传，NAT 后也能用。它不需要账号、不需要 token，也不需要在本机装任何东西。
 *
 * 与 Cloudflare Quick Tunnel 的关键差别：**子域名可以固定**。服务端会长期保留名字，
 * 同一个子域名下次还能拿回来，因此公网地址可以长期收藏。
 *
 * 但"先到先得"是它的硬规则：名字被别人占着时，服务端不会报错，而是**悄悄换一个
 * 随机名字**。不校验就会把随机地址当成固定域名交出去，所以拿到地址后必须比对。
 */
import {
  buildLocaltunnelOptions,
  isExpectedLocaltunnelUrl,
  LOCALTUNNEL_HOST_CANDIDATES,
  type LocaltunnelOptions,
} from "@zcode/services";
import localtunnel, { type LocaltunnelClient } from "localtunnel";
import type { PublicTunnelHandle, PublicTunnelLogger } from "./publicTunnelTypes.js";

/** 启动超时：超过这个时间还没就绪就判定失败并回收客户端。 */
const DEFAULT_START_TIMEOUT_MS = 30_000;

/**
 * 客户端工厂：**同步**返回客户端对象。
 *
 * 必须同步：客户端是事件源，监听器要能比事件更早挂上。
 * 若工厂返回 Promise，调用方要等一次微任务才能拿到客户端，
 * 期间客户端发出的 'url' 事件就丢了（隧道因此永远等不到地址）。
 */
export type LocaltunnelClientFactory = (options: LocaltunnelOptions) => LocaltunnelClient;

interface LocaltunnelTunnelOptions {
  /** 远控服务监听的本地端口。 */
  port: number;
  /** 期望的公网子域名；服务端给别的名字就算失败。 */
  subdomain: string;
  logger: PublicTunnelLogger;
  timeoutMs?: number;
  /** 服务端地址候选，按顺序尝试。 */
  hosts?: readonly string[];
  /** 客户端工厂；默认走 npm 包。 */
  createClient?: LocaltunnelClientFactory;
}

/**
 * 启动失败。`retryable` 区分"这个服务地址连不上"（换下一个地址继续试）
 * 与"子域名被别人占了"（换地址也没用，直接报错）。
 */
class LocaltunnelStartupError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LocaltunnelStartupError";
  }
}

/**
 * 建立 localtunnel 隧道。
 *
 * 依次尝试候选服务地址：只有"连不上"才换下一个；子域名被占是确定性失败，
 * 换地址重试只会再拿一个随机名字，直接报错让用户改子域名。
 */
export async function startLocaltunnelTunnel(
  options: LocaltunnelTunnelOptions,
): Promise<PublicTunnelHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const hosts = options.hosts ?? LOCALTUNNEL_HOST_CANDIDATES;
  const factory = options.createClient ?? createLocaltunnelClient;
  let lastError: unknown;
  for (const host of hosts) {
    try {
      return await openLocaltunnel(host, options, factory, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof LocaltunnelStartupError && error.retryable;
      options.logger.warn("localtunnel host failed", {
        host,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!retryable) throw error;
    }
  }
  throw new LocaltunnelStartupError(
    `无法连接 localtunnel 服务：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    false,
  );
}

/** 打开一个服务地址上的隧道，并校验拿到的确实是用户要的子域名。 */
async function openLocaltunnel(
  host: string,
  options: LocaltunnelTunnelOptions,
  factory: LocaltunnelClientFactory,
  timeoutMs: number,
): Promise<PublicTunnelHandle> {
  if (!options.subdomain.trim()) {
    throw new LocaltunnelStartupError("缺少公网子域名", false);
  }
  const clientOptions = buildLocaltunnelOptions({
    port: options.port,
    subdomain: options.subdomain,
    host,
  });
  let client: LocaltunnelClient;
  try {
    // 工厂必须同步返回：监听器要在任何事件之前挂上。
    client = factory(clientOptions);
  } catch (error) {
    // 客户端工厂抛错（例如连不上服务）属于"这个地址不行"，换下一个地址继续试。
    throw new LocaltunnelStartupError(
      `连接 ${host} 失败：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }

  // 隧道真正可用要等 TCP 通道建好（客户端在 'url' 事件里给出地址）。
  let url: string;
  try {
    url = await waitForTunnelUrl(client, timeoutMs, host);
  } catch (error) {
    client.close();
    throw error;
  }

  if (!isExpectedLocaltunnelUrl(url, options.subdomain)) {
    client.close();
    throw new LocaltunnelStartupError(
      `公网子域名「${options.subdomain}」已被占用，服务端改分配了「${firstLabel(url)}」`,
      false,
    );
  }

  options.logger.info("localtunnel started", { url, subdomain: options.subdomain });
  // 隧道建立后的错误不再致命：localtunnel 客户端自己会重连（服务端掐空闲连接时会
  // 触发 'dead' → 重开）。这里只记录，让用户从"打不开"而不是从"状态消失"感知问题。
  client.on("error", (error: Error) => {
    options.logger.warn("localtunnel client error", { message: error.message });
  });
  let stopped = false;
  return {
    url,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      client.close();
    },
  };
}

/**
 * npm 包的真实客户端工厂。
 *
 * 用回调形式而不是 Promise 形式：回调形式**同步**返回客户端对象，
 * 因此可以在任何事件发生之前就把监听挂上。Promise 形式要等一次微任务，
 * 中间存在一个"事件已触发但还没人听"的窗口。
 */
const createLocaltunnelClient: LocaltunnelClientFactory = (options) => {
  const client = localtunnel(options, (error) => {
    // npm 包把"服务端拒绝"交给回调，不发事件；这里转成 'error' 事件，
    // 让等待方用同一条路径处理失败。
    if (error) client.emit("error", error);
  });
  // 兜底监听：EventEmitter 没有 'error' 监听者时会抛未捕获异常，足以把 Host 进程带崩。
  // 真正的错误处理交给调用方自己的监听器，这里只是不让进程崩。
  client.on("error", () => {});
  return client;
};

/** 等客户端给出公网地址（'url' 事件在 TCP 通道建好后触发）。 */
function waitForTunnelUrl(
  client: LocaltunnelClient,
  timeoutMs: number,
  host: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new LocaltunnelStartupError(`连接 ${host} 超时（${timeoutMs / 1000} 秒）`, true));
    }, timeoutMs);

    const onUrl = (url: string): void => {
      cleanup();
      resolve(url);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new LocaltunnelStartupError(`隧道建立失败：${error.message}`, true));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("url", onUrl);
      client.off("error", onError);
    };

    client.once("url", onUrl);
    client.once("error", onError);
  });
}

/** 取地址里的第一段主机名（子域名）。 */
function firstLabel(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] ?? url;
  } catch {
    return url;
  }
}
