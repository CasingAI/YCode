/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";

/**
 * 把 `ws` 库的 WebSocket 适配成 RPC 的 `ISocket`。
 */
function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface LanHttpServerOptions {
  port: number;
  host?: string;
  /** 非空时启用 lite token 鉴权：`/api/*` 与 `/ws*` 无有效 token 一律 401。 */
  token?: string;
  staticRoot?: string;
  spaFallback?: boolean;
  /** `/api/server-info` 的返回体来源。 */
  serverInfo?: HttpServerOptions;
  /**
   * 受同一 token 保护的 WebSocket 端点：升级完成后把适配好的 socket 交给调用方，
   * 由调用方决定挂哪套服务。桌面手机远控走这条路径，不需要依赖 `ws` / hono 类型。
   */
  webSocket?: {
    path: string;
    onConnection: (socket: ISocket) => void;
  };
  /**
   * 追加自定义路由（`/api/*`、多个 WebSocket 端点等），在静态 fallback 之前注册；
   * 需要 WebSocket 时用回调里的 `upgradeWebSocket`。仅 packages/server 内部使用。
   */
  configureApp?: (app: Hono, helpers: { upgradeWebSocket: UpgradeWebSocket }) => void;
  onListening?: (info: { port: number; host: string }) => void;
}

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];

export interface LanHttpServer {
  /** 传给 `serve` 的 Node http server（尚未保证已 listening）。 */
  server: ReturnType<typeof serve>;
  /** listening 后 resolve，绑定失败时 reject（例如 EADDRINUSE）。 */
  ready: Promise<void>;
  /** 关闭监听并断开既有连接；幂等。 */
  close: () => Promise<void>;
}

/**
 * 局域网 HTTP 前端：静态 web 产物 + lite token 鉴权 + `/api/server-info` + 自定义路由。
 *
 * 从 `createHttpServer` 抽出，让桌面 Host 能用同一套鉴权与静态服务把 web 产物托管给手机，
 * 而不用维护第二条静态/鉴权实现。鉴权顺序固定为：token 中间件 → 自定义路由 → 静态 fallback，
 * 保证 SPA fallback 永远不会绕过受保护路径。
 */
export function createLanHttpServer(options: LanHttpServerOptions): LanHttpServer {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const serverInfoOptions = options.serverInfo ?? {};
  const token = options.token?.trim();

  if (token) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, token);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(serverInfoOptions)));

  if (options.webSocket) {
    const { path, onConnection } = options.webSocket;
    app.get(
      path,
      upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          onConnection(wrapWebSocket(ws.raw as WebSocket));
        },
      })),
    );
  }

  options.configureApp?.(app, { upgradeWebSocket });

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port });
  injectWebSocket(server);

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const reportListening = () => {
      const address = server.address();
      const listenPort = typeof address === "object" && address ? address.port : options.port;
      const listenHost = options.host?.trim() || "localhost";
      options.onListening?.({ port: listenPort, host: listenHost });
      resolveReady();
    };
    server.once("listening", reportListening);
    server.once("error", (error) => rejectReady(error));
    // serve() 可能已经完成 listen（同步路径），此时不会再发 listening 事件。
    if (server.listening) {
      reportListening();
    }
  });
  // 调用方可能只把 server 交给别处而从不 await ready；这里吞掉 rejection，
  // 真正的失败由 await ready 的调用方处理，避免未处理拒绝把进程带崩。
  ready.catch(() => {});

  return {
    server,
    ready,
    close: () =>
      new Promise<void>((resolveClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close(() => resolveClose());
        // 已经建立的手机连接不随 close 断开，必须显式销毁，否则 stop() 后手机仍持有会话。
        // http2 server 没有该方法，所以按可选能力调用。
        const closeAllConnections = (server as { closeAllConnections?: () => void })
          .closeAllConnections;
        closeAllConnections?.call(server);
      }),
  };
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const hostCapabilities = createHostCapabilityStore();

  const lan = createLanHttpServer({
    port,
    host: options.host,
    token: options.authToken,
    staticRoot: options.staticRoot,
    spaFallback: options.spaFallback,
    serverInfo: options,
    onListening: ({ port: listenPort, host: listenHost }) => {
      log(`http://${listenHost}:${listenPort}`);
    },
    configureApp: (app, { upgradeWebSocket }) => {
      app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

      // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
      // 都不能再把自己提升为 trusted host。
      app.get(
        "/ws",
        upgradeWebSocket(() => ({
          onOpen(_event, ws) {
            setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
          },
        })),
      );

      const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
        },
      }));
      app.use("/ws/host", async (c, next) => {
        const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
        if (!hostCapabilities.consume(capability)) {
          return c.json({ error: "Invalid or expired host capability" }, 401);
        }
        await next();
      });
      app.get("/ws/host", upgradeTrustedHostWebSocket);

      // Web 模式下发起远程连接
      app.post("/api/connect-remote", async (c) => {
        const rawBody = await c.req.json();
        const parsedBody = remoteTargetSchema.safeParse(rawBody);
        if (!parsedBody.success) {
          return c.json(
            { error: `Invalid request body: ${formatZodError(parsedBody.error)}` },
            400,
          );
        }
        const body = parsedBody.data;

        try {
          const backend = await createRemoteBackend(body);
          const connection = await connectRemote(backend);
          const id = generateId();
          remoteConnections.set(id, connection);

          return c.json({ id });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, 500);
        }
      });

      // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
      app.get(
        "/ws/remote/:id",
        upgradeWebSocket((c) => {
          const id = c.req.param("id");
          return {
            onOpen(_event, ws) {
              if (!id) {
                ws.close(4000, "Missing remote connection id");
                return;
              }
              const connection = remoteConnections.get(id);
              if (!connection) {
                ws.close(4004, "Remote connection not found");
                return;
              }
              // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
              remoteConnections.delete(id);

              // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
              const remoteServices = new ServiceCollection()
                .register(IFileService, connection.services.fileService)
                .register(IGitService, connection.services.gitService)
                .register(ISystemService, connection.services.systemService)
                .register(ITerminalService, connection.services.terminalService);

              setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
            },
          };
        }),
      );
    },
  });

  return lan.server;
}
