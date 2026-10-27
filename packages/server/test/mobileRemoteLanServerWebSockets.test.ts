import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import {
  createLanHttpServer,
  type LanHttpServer,
  type LanWebSocketRequestContext,
} from "../src/http.js";

const TOKEN = "test_token-123";
const zcodeLiteTokenCookieName = "zcode_lite_token";

interface StartedServer {
  lan: LanHttpServer;
  port: number;
  /** 最近一次命中端点的请求上下文。 */
  requests: LanWebSocketRequestContext[];
  /** 最近一次命中的端点 path。 */
  matchedPaths: string[];
}

/** 起一个 loopback 服务；端口由内核分配，结束时必须 close。 */
async function startServer(
  createOptions: (helpers: {
    requests: LanWebSocketRequestContext[];
    matchedPaths: string[];
  }) => Parameters<typeof createLanHttpServer>[0],
): Promise<StartedServer> {
  let listenPort = 0;
  const requests: LanWebSocketRequestContext[] = [];
  const matchedPaths: string[] = [];
  const lan = createLanHttpServer({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    serverInfo: { authRequired: true, workspaces: [] },
    ...createOptions({ requests, matchedPaths }),
    onListening: ({ port }) => {
      listenPort = port;
    },
  });
  await lan.ready;
  return { lan, port: listenPort, requests, matchedPaths };
}

function cookieHeader(token = TOKEN): string {
  return `${zcodeLiteTokenCookieName}=${token}`;
}

interface HandshakeResult {
  status: number;
  socket?: WebSocket;
}

/**
 * 完成或拒绝一次 WebSocket 握手。
 *
 * `open` 时保留 socket，由调用方关闭；拒绝时返回 HTTP 状态码。
 */
function handshake(
  url: string,
  headers: Record<string, string> = { cookie: cookieHeader() },
): Promise<HandshakeResult> {
  return new Promise<HandshakeResult>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve({ status: 101, socket }));
    socket.once("unexpected-response", (_request, response) => {
      socket.terminate();
      resolve({ status: response.statusCode ?? 0 });
    });
    socket.once("error", () => {
      // unexpected-response 和 error 可能同时到达；已经 resolve 时忽略。
    });
    socket.once("close", () => {
      // 服务端在 onConnection 里主动关闭时，仍应让调用方拿到握手结果。
    });
    setTimeout(() => reject(new Error(`handshake timed out: ${url}`)), 2000).unref();
  });
}

/** 等待 onConnection 回调记录到请求上下文；回调与 open 事件顺序不保证。 */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for value");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("createLanHttpServer 多 WebSocket 端点", () => {
  it("按注册顺序响应多个端点，并传递 path+query 与 Origin", async () => {
    const server = await startServer(({ requests, matchedPaths }) => ({
      webSockets: [
        {
          path: "/ws/one",
          onConnection: (socket, request) => {
            matchedPaths.push("/ws/one");
            requests.push(request);
            socket.dispose();
          },
        },
        {
          path: "/ws/rtc",
          requireSameOrigin: true,
          onConnection: (socket, request) => {
            matchedPaths.push("/ws/rtc");
            requests.push(request);
            socket.dispose();
          },
        },
      ],
    }));
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const first = await handshake(`ws://127.0.0.1:${server.port}/ws/one?rtcId=abc`, {
        cookie: cookieHeader(),
        origin,
      });
      assert.equal(first.status, 101);
      first.socket?.terminate();
      await waitFor(() => (server.requests.length === 1 ? true : undefined));
      assert.deepEqual(server.requests[0], { url: "/ws/one?rtcId=abc", origin });
      assert.deepEqual(server.matchedPaths, ["/ws/one"]);

      const second = await handshake(`ws://127.0.0.1:${server.port}/ws/rtc?rtcId=abc`, {
        cookie: cookieHeader(),
        origin,
      });
      assert.equal(second.status, 101);
      second.socket?.terminate();
      await waitFor(() => (server.requests.length === 2 ? true : undefined));
      assert.deepEqual(server.requests[1], { url: "/ws/rtc?rtcId=abc", origin });
      assert.deepEqual(server.matchedPaths, ["/ws/one", "/ws/rtc"]);
    } finally {
      await server.lan.close();
    }
  });

  it("原单个 webSocket 回调仍可用，并允许只声明 socket 参数", async () => {
    const received: string[] = [];
    const server = await startServer(() => ({
      webSocket: {
        path: "/ws",
        onConnection(socket) {
          received.push("connected");
          socket.dispose();
        },
      },
    }));
    try {
      const result = await handshake(`ws://127.0.0.1:${server.port}/ws?rtcId=legacy`);
      assert.equal(result.status, 101);
      result.socket?.terminate();
      await waitFor(() => (received.length === 1 ? true : undefined));
      assert.deepEqual(received, ["connected"]);
    } finally {
      await server.lan.close();
    }
  });

  it("新增端点仍受 token 保护", async () => {
    const server = await startServer(() => ({
      webSockets: [{ path: "/ws/rtc", requireSameOrigin: true, onConnection: () => undefined }],
    }));
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const anonymous = await handshake(`ws://127.0.0.1:${server.port}/ws/rtc`, { origin });
      assert.equal(anonymous.status, 401);
      const wrongCookie = await handshake(`ws://127.0.0.1:${server.port}/ws/rtc`, {
        cookie: cookieHeader("wrong"),
        origin,
      });
      assert.equal(wrongCookie.status, 401);
    } finally {
      await server.lan.close();
    }
  });
});

describe("createLanHttpServer 同 Origin 门禁", () => {
  it("Origin host 与请求 Host 完全一致才升级", async () => {
    const server = await startServer(() => ({
      webSockets: [
        { path: "/ws/rtc", requireSameOrigin: true, onConnection: (socket) => socket.dispose() },
      ],
    }));
    try {
      const url = `ws://127.0.0.1:${server.port}/ws/rtc`;
      const same = await handshake(url, {
        cookie: cookieHeader(),
        origin: `http://127.0.0.1:${server.port}`,
      });
      assert.equal(same.status, 101);
      same.socket?.terminate();

      const missing = await handshake(url, { cookie: cookieHeader() });
      assert.equal(missing.status, 403);

      const crossHost = await handshake(url, {
        cookie: cookieHeader(),
        origin: "http://evil.example.com",
      });
      assert.equal(crossHost.status, 403);

      // 端口也是 host 的一部分：同地址不同端口不能复用授权。
      const crossPort = await handshake(url, {
        cookie: cookieHeader(),
        origin: `http://127.0.0.1:${server.port + 1}`,
      });
      assert.equal(crossPort.status, 403);

      // 非 URL 的 Origin（浏览器 sandbox/null）一律拒绝。
      const nullOrigin = await handshake(url, {
        cookie: cookieHeader(),
        origin: "null",
      });
      assert.equal(nullOrigin.status, 403);
    } finally {
      await server.lan.close();
    }
  });

  it("允许 TLS 隧道回源到本地 HTTP：协议不同但 host 相同仍通过", async () => {
    const server = await startServer(() => ({
      webSockets: [
        { path: "/ws/rtc", requireSameOrigin: true, onConnection: (socket) => socket.dispose() },
      ],
    }));
    try {
      const result = await handshake(`ws://127.0.0.1:${server.port}/ws/rtc`, {
        cookie: cookieHeader(),
        // 隧道入口是 https，反代到本地 http；只比较 host。
        origin: `https://127.0.0.1:${server.port}`,
      });
      assert.equal(result.status, 101);
      result.socket?.terminate();
    } finally {
      await server.lan.close();
    }
  });

  it("不信任 forwarded-host：只认实际请求 Host", async () => {
    const server = await startServer(() => ({
      webSockets: [
        { path: "/ws/rtc", requireSameOrigin: true, onConnection: (socket) => socket.dispose() },
      ],
    }));
    try {
      const result = await handshake(`ws://127.0.0.1:${server.port}/ws/rtc`, {
        cookie: cookieHeader(),
        origin: "https://tunnel.example.com",
        "x-forwarded-host": "tunnel.example.com",
      });
      assert.equal(result.status, 403);
    } finally {
      await server.lan.close();
    }
  });

  it("未声明 requireSameOrigin 的端点保持原行为", async () => {
    const server = await startServer(() => ({
      webSockets: [{ path: "/ws/plain", onConnection: (socket) => socket.dispose() }],
    }));
    try {
      const result = await handshake(`ws://127.0.0.1:${server.port}/ws/plain`, {
        cookie: cookieHeader(),
        origin: "http://evil.example.com",
      });
      assert.equal(result.status, 101);
      result.socket?.terminate();
    } finally {
      await server.lan.close();
    }
  });

  it("close() 回收所有 webSockets 端点连接", async () => {
    const server = await startServer(() => ({
      webSockets: [
        { path: "/ws/a", onConnection: () => undefined },
        { path: "/ws/b", onConnection: () => undefined },
      ],
    }));
    const clients: WebSocket[] = [];
    try {
      for (const path of ["/ws/a", "/ws/b"]) {
        const result = await handshake(`ws://127.0.0.1:${server.port}${path}`);
        assert.equal(result.status, 101);
        assert.ok(result.socket);
        clients.push(result.socket);
      }
      await server.lan.close();
      await Promise.all(
        clients.map(
          (client) =>
            new Promise<void>((resolve, reject) => {
              if (client.readyState === WebSocket.CLOSED) {
                resolve();
                return;
              }
              client.once("close", () => resolve());
              client.once("error", reject);
            }),
        ),
      );
    } finally {
      for (const client of clients) client.terminate();
      await server.lan.close();
    }
  });
});
