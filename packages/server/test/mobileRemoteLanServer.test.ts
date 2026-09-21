import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { createLanHttpServer, type LanHttpServer } from "../src/http.js";

const TOKEN = "test_token-123";
const zcodeLiteTokenCookieName = "zcode_lite_token";

let staticRoot: string;
/** 静态根之外的诱饵文件名，用于验证目录逃逸被拦。 */
const outsideSecretName = "zcode-outside-secret.txt";

async function writeStaticFixture(root: string): Promise<void> {
  await writeFile(join(root, "index.html"), "<!doctype html><title>mobile</title>");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "app.js"), "console.log('app');");
  await writeFile(join(root, "..", outsideSecretName), "top-secret");
}

/** 起一个带 token 的局域网服务，返回实际监听端口。 */
async function startServer(overrides: { staticRoot?: string; token?: string } = {}) {
  let listenPort = 0;
  const lan: LanHttpServer = createLanHttpServer({
    port: 0,
    host: "127.0.0.1",
    ...(overrides.token === undefined ? { token: TOKEN } : { token: overrides.token }),
    staticRoot: overrides.staticRoot ?? staticRoot,
    serverInfo: { authRequired: true, name: "ZCode Desktop", workspaces: [] },
    // 与桌面 Host 相同：注册了 /ws，通过鉴权的升级请求才会被接受。
    webSocket: { path: "/ws", onConnection: () => undefined },
    onListening: ({ port }) => {
      listenPort = port;
    },
  });
  await lan.ready;
  return { lan, port: listenPort, baseUrl: `http://127.0.0.1:${listenPort}` };
}

/** 返回 101 表示握手成功，否则返回服务端回绝的 HTTP 状态码。 */
function connectWebSocket(url: string, headers?: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, headers ? { headers } : undefined);
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    // 鉴权失败时 Hono 直接回 HTTP 401，不会升级成 WebSocket。
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    socket.once("error", reject);
  });
}

before(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-web-"));
  await writeStaticFixture(staticRoot);
});

after(async () => {
  await rm(staticRoot, { recursive: true, force: true });
  await rm(join(staticRoot, "..", outsideSecretName), { force: true });
});

describe("createLanHttpServer 鉴权", () => {
  it("静态入口可匿名访问，但带 token 时顺便种下 cookie", async () => {
    const { lan, baseUrl } = await startServer();
    try {
      const anonymous = await fetch(`${baseUrl}/`);
      assert.equal(anonymous.status, 200);
      assert.match(anonymous.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(anonymous.headers.get("set-cookie"), null);

      const withToken = await fetch(`${baseUrl}/?token=${TOKEN}`);
      assert.equal(withToken.status, 200);
      assert.match(withToken.headers.get("set-cookie") ?? "", /zcode_lite_token=/);
    } finally {
      await lan.close();
    }
  });

  it("无 token 访问 /api/server-info 返回 401，带 token 返回 200", async () => {
    const { lan, baseUrl } = await startServer();
    try {
      const denied = await fetch(`${baseUrl}/api/server-info`);
      assert.equal(denied.status, 401);

      const allowed = await fetch(`${baseUrl}/api/server-info?token=${TOKEN}`);
      assert.equal(allowed.status, 200);
      const body = (await allowed.json()) as { name?: string; authRequired?: boolean };
      assert.equal(body.name, "ZCode Desktop");
      assert.equal(body.authRequired, true);
    } finally {
      await lan.close();
    }
  });

  it("cookie 生效后不再需要查询串里的 token", async () => {
    const { lan, baseUrl } = await startServer();
    try {
      const bootstrap = await fetch(`${baseUrl}/?token=${TOKEN}`);
      const cookieHeader = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0];
      assert.ok(cookieHeader.startsWith(`${zcodeLiteTokenCookieName}=`));

      const withCookie = await fetch(`${baseUrl}/api/server-info`, {
        headers: { cookie: cookieHeader },
      });
      assert.equal(withCookie.status, 200);
    } finally {
      await lan.close();
    }
  });

  it("token 不匹配时 /api/* 仍是 401", async () => {
    const { lan, baseUrl } = await startServer();
    try {
      const wrongToken = await fetch(`${baseUrl}/api/server-info?token=wrong`);
      assert.equal(wrongToken.status, 401);

      const wrongCookie = await fetch(`${baseUrl}/api/server-info`, {
        headers: { cookie: `${zcodeLiteTokenCookieName}=wrong` },
      });
      assert.equal(wrongCookie.status, 401);
    } finally {
      await lan.close();
    }
  });

  it("空 token 表示不鉴权（仅供 loopback 本地使用）", async () => {
    const { lan, baseUrl } = await startServer({ token: "" });
    try {
      const response = await fetch(`${baseUrl}/api/server-info`);
      assert.equal(response.status, 200);
    } finally {
      await lan.close();
    }
  });
});

describe("createLanHttpServer /ws", () => {
  it("无 token 的 WebSocket 握手被拒（401），带 token 能建立连接", async () => {
    const { lan, port } = await startServer();
    try {
      assert.equal(await connectWebSocket(`ws://127.0.0.1:${port}/ws`), 401);
      assert.equal(
        await connectWebSocket(`ws://127.0.0.1:${port}/ws`, {
          cookie: `${zcodeLiteTokenCookieName}=${TOKEN}`,
        }),
        101,
      );
    } finally {
      await lan.close();
    }
  });

  it("升级成功的 socket 交给 onConnection，回调拿到连接", async () => {
    const received: string[] = [];
    let listenPort = 0;
    const lan = createLanHttpServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      serverInfo: { authRequired: true, workspaces: [] },
      webSocket: {
        path: "/ws",
        onConnection: (socket) => {
          received.push("connected");
          socket.dispose();
        },
      },
      onListening: ({ port }) => {
        listenPort = port;
      },
    });
    await lan.ready;
    try {
      const status = await connectWebSocket(`ws://127.0.0.1:${listenPort}/ws`, {
        cookie: `${zcodeLiteTokenCookieName}=${TOKEN}`,
      });
      assert.equal(status, 101);
      assert.deepEqual(received, ["connected"]);
    } finally {
      await lan.close();
    }
  });
});

describe("createLanHttpServer 静态产物", () => {
  it("命中真实文件，未知路径回退 index.html", async () => {
    const { lan, baseUrl } = await startServer();
    try {
      const asset = await fetch(`${baseUrl}/assets/app.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);
      assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

      const spa = await fetch(`${baseUrl}/workspace/some/deep/path`);
      assert.equal(spa.status, 200);
      assert.match(await spa.text(), /mobile/);
    } finally {
      await lan.close();
    }
  });

  it("不允许读出静态根之外的路径", async () => {
    const { lan, baseUrl } = await startServer();
    try {
      // 用编码过的 %2f 让 .. 逃过 fetch/URL 的路径规范化，真正落到服务端的目录校验上。
      const escaped = await fetch(`${baseUrl}/%2e%2e%2f${outsideSecretName}`);
      assert.equal(escaped.status, 404);
      assert.ok(!(await escaped.text()).includes("top-secret"));

      // 未编码的 ../ 会被 URL 规范化成根内路径，此时只会走 SPA fallback，同样读不到根外文件。
      const normalized = await fetch(`${baseUrl}/../${outsideSecretName}`);
      assert.ok(!(await normalized.text()).includes("top-secret"));
    } finally {
      await lan.close();
    }
  });

  it("close() 之后端口不再可连，且可重复调用", async () => {
    const { lan, baseUrl } = await startServer();
    await lan.close();
    await lan.close();
    await assert.rejects(fetch(`${baseUrl}/api/server-info`));
  });
});
