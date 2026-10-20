import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { LocaltunnelClient } from "localtunnel";
import {
  startLocaltunnelTunnel,
  type LocaltunnelClientFactory,
} from "../src/host/publicTunnelLocaltunnel.js";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 假的 localtunnel 客户端：够用即可（事件 + close）。 */
class FakeClient extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

interface FakeOptions {
  subdomain: string;
  host: string;
  port: number;
}

/**
 * 造一个客户端工厂。
 *
 * 真实客户端是"同步建好、异步就绪"：先拿到名字，稍后才把隧道连上。
 * 这里用微任务复现这个时序，避免测试把两件事混成一件。
 */
function createFactory(script: (client: FakeClient, options: FakeOptions) => void): {
  factory: LocaltunnelClientFactory;
  clients: FakeClient[];
} {
  const clients: FakeClient[] = [];
  const factory: LocaltunnelClientFactory = (options) => {
    const client = new FakeClient();
    clients.push(client);
    queueMicrotask(() => script(client, options));
    return client as unknown as LocaltunnelClient;
  };
  return { factory, clients };
}

describe("startLocaltunnelTunnel", () => {
  it("拿到与请求一致的子域名时返回公网地址", async () => {
    const { factory, clients } = createFactory((client, options) => {
      client.emit("url", `https://${options.subdomain}.loca.lt`);
    });

    const handle = await startLocaltunnelTunnel({
      port: 53211,
      subdomain: "my-name",
      logger: silentLogger,
      hosts: ["https://loca.lt"],
      createClient: factory,
    });
    try {
      assert.equal(handle.url, "https://my-name.loca.lt");
    } finally {
      await handle.stop();
    }
    assert.equal(clients[0]?.closed, true);
  });

  it("子域名被别人占走时明确失败，不把随机地址当固定域名交出去", async () => {
    const { factory, clients } = createFactory((client) => {
      client.emit("url", "https://random-name.loca.lt");
    });

    await assert.rejects(
      startLocaltunnelTunnel({
        port: 53211,
        subdomain: "my-name",
        logger: silentLogger,
        hosts: ["https://loca.lt"],
        createClient: factory,
      }),
      /已被占用/,
    );
    // 失败的客户端必须被关掉，不能留下悬空的转发连接。
    assert.equal(clients[0]?.closed, true);
  });

  it("服务地址连不上时换下一个地址", async () => {
    const triedHosts: string[] = [];
    const factory: LocaltunnelClientFactory = (options) => {
      triedHosts.push(options.host);
      if (options.host === "https://loca.lt") {
        throw new Error("connect ECONNREFUSED");
      }
      const client = new FakeClient();
      queueMicrotask(() => client.emit("url", `https://${options.subdomain}.loca.lt`));
      return client as unknown as LocaltunnelClient;
    };

    const handle = await startLocaltunnelTunnel({
      port: 53211,
      subdomain: "my-name",
      logger: silentLogger,
      hosts: ["https://loca.lt", "https://localtunnel.me"],
      createClient: factory,
    });
    try {
      assert.deepEqual(triedHosts, ["https://loca.lt", "https://localtunnel.me"]);
      assert.equal(handle.url, "https://my-name.loca.lt");
    } finally {
      await handle.stop();
    }
  });

  it("子域名被占时不换地址重试（换了也是另一个随机名字）", async () => {
    const triedHosts: string[] = [];
    const { factory } = createFactory((client) => {
      client.emit("url", "https://random-name.loca.lt");
    });
    const wrapped: LocaltunnelClientFactory = (options) => {
      triedHosts.push(options.host);
      return factory(options);
    };

    await assert.rejects(
      startLocaltunnelTunnel({
        port: 53211,
        subdomain: "my-name",
        logger: silentLogger,
        hosts: ["https://loca.lt", "https://localtunnel.me"],
        createClient: wrapped,
      }),
      /已被占用/,
    );
    assert.deepEqual(triedHosts, ["https://loca.lt"]);
  });

  it("客户端一直没就绪时按超时失败，不无限等待", async () => {
    const factory: LocaltunnelClientFactory = () => {
      const client = new FakeClient();
      return client as unknown as LocaltunnelClient;
    };

    await assert.rejects(
      startLocaltunnelTunnel({
        port: 53211,
        subdomain: "my-name",
        logger: silentLogger,
        hosts: ["https://loca.lt"],
        timeoutMs: 20,
        createClient: factory,
      }),
      /超时/,
    );
  });

  it("没有子域名时直接失败，不去连服务", async () => {
    let called = false;
    const factory: LocaltunnelClientFactory = () => {
      called = true;
      const client = new FakeClient();
      return client as unknown as LocaltunnelClient;
    };

    await assert.rejects(
      startLocaltunnelTunnel({
        port: 53211,
        subdomain: "  ",
        logger: silentLogger,
        hosts: ["https://loca.lt"],
        createClient: factory,
      }),
      /子域名/,
    );
    assert.equal(called, false);
  });

  it("stop 之后客户端被关闭，且重复 stop 不会出错", async () => {
    const { factory, clients } = createFactory((client, options) => {
      client.emit("url", `https://${options.subdomain}.loca.lt`);
    });

    const handle = await startLocaltunnelTunnel({
      port: 53211,
      subdomain: "my-name",
      logger: silentLogger,
      hosts: ["https://loca.lt"],
      createClient: factory,
    });
    await handle.stop();
    await handle.stop();
    assert.equal(clients[0]?.closed, true);
  });
});
