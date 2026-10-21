import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ServiceCollection } from "@zcode/services";
import type { MobileRemoteControlStatus, PublicTunnelStatus } from "@zcode/services";
import { createMemoryMobileRemoteControlStateStore } from "@zcode/services/node";
import type { LocaltunnelClient } from "localtunnel";
import { createMobileRemoteControlRuntime } from "../src/host/mobileRemoteControlService.js";
import { createFakeTunnelBinary, fakeTunnelSupported } from "./helpers/fakeTunnelBinary.js";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let webRoot: string;

function createRuntime(
  options: {
    tunnelBinaryPath?: string | undefined;
    createLocaltunnelClient?: (options: {
      subdomain: string;
      host: string;
      port: number;
    }) => LocaltunnelClient;
  } = {},
) {
  return createMobileRemoteControlRuntime({
    getServices: () => new ServiceCollection(),
    resolveWebRoot: () => webRoot,
    exposeServices: () => () => undefined,
    logger: silentLogger,
    logRpc: () => undefined,
    stateStore: createMemoryMobileRemoteControlStateStore(),
    resolveTunnelBinaryPath: () => options.tunnelBinaryPath,
    ...(options.createLocaltunnelClient
      ? { createLocaltunnelClient: options.createLocaltunnelClient }
      : {}),
  });
}

/** 假的 localtunnel 客户端：连上就报出公网地址。 */
class FakeLocaltunnelClient extends EventEmitter {
  close(): void {
    // 单测不需要真的断连接。
  }
}

/** 等条件成立；用于等异步状态广播，不靠固定 sleep。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("等待条件成立超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

before(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "zcode-mobile-root-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>mobile</title>");
});

after(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

describe("公网链接的运行时行为", () => {
  it("远控未开启时创建公网链接只报公网这一段的错，不影响远控状态", async () => {
    const runtime = createRuntime();
    try {
      const status = await runtime.service.createPublicUrl({ provider: "cloudflare-quick" });
      assert.equal(status.state, "stopped");
      assert.equal(status.public?.state, "error");
      assert.match(status.public?.error ?? "", /远程控制/);
    } finally {
      runtime.dispose();
    }
  });

  it("内置二进制缺失时公网报明确错误，远控本身仍然 running", async () => {
    const runtime = createRuntime();
    try {
      await runtime.service.start();
      const status = await runtime.service.createPublicUrl({ provider: "cloudflare-quick" });
      assert.equal(status.state, "running");
      assert.ok(status.accessUrl);
      assert.equal(status.public?.state, "error");
      assert.match(status.public?.error ?? "", /cloudflared/);
    } finally {
      runtime.dispose();
    }
  });

  it("localtunnel 子域名非法时不启动隧道，只报公网这一段的错", async () => {
    let called = false;
    const runtime = createRuntime({
      createLocaltunnelClient: () => {
        called = true;
        return new FakeLocaltunnelClient() as unknown as LocaltunnelClient;
      },
    });
    try {
      await runtime.service.start();
      const status = await runtime.service.createPublicUrl({
        provider: "localtunnel",
        subdomain: "Bad_Name",
      });
      assert.equal(status.state, "running");
      assert.equal(status.public?.state, "error");
      assert.match(status.public?.error ?? "", /子域名/);
      assert.equal(called, false);
    } finally {
      runtime.dispose();
    }
  });

  it("没有隧道时关闭公网链接是空操作", async () => {
    const runtime = createRuntime();
    try {
      await runtime.service.start();
      const status = await runtime.service.closePublicUrl();
      assert.equal(status.state, "running");
      assert.equal(status.public, undefined);
    } finally {
      runtime.dispose();
    }
  });

  it("创建成功后公网链接带同一个 token，重复创建幂等", { skip: !fakeTunnelSupported }, async () => {
    const binaryPath = await createFakeTunnelBinary();
    const runtime = createRuntime({ tunnelBinaryPath: binaryPath });
    try {
      const started = await runtime.service.start();
      const created = await runtime.service.createPublicUrl({ provider: "cloudflare-quick" });
      assert.equal(created.state, "running");
      assert.equal(created.public?.state, "running");
      assert.ok(created.public?.url);
      // 公网链接与局域网链接是同一套凭据。
      const lanToken = new URL(started.accessUrl ?? "").searchParams.get("token");
      const publicToken = new URL(created.public?.url ?? "").searchParams.get("token");
      assert.equal(publicToken, lanToken);

      const again = await runtime.service.createPublicUrl({ provider: "cloudflare-quick" });
      assert.equal(again.public?.url, created.public?.url);
    } finally {
      runtime.dispose();
    }
  });

  it("localtunnel 的子域名落盘，重开远控后还是同一个地址", async () => {
    const requested: string[] = [];
    const runtime = createRuntime({
      createLocaltunnelClient: (options) => {
        requested.push(options.subdomain);
        const client = new FakeLocaltunnelClient();
        queueMicrotask(() => client.emit("url", `https://${options.subdomain}.loca.lt`));
        return client as unknown as LocaltunnelClient;
      },
    });
    try {
      await runtime.service.start();
      const created = await runtime.service.createPublicUrl({
        provider: "localtunnel",
        subdomain: "my-fixed-name",
      });
      assert.equal(created.public?.state, "running");
      assert.match(created.public?.url ?? "", /^https:\/\/my-fixed-name\.loca\.lt\/\?token=/);

      // 关掉再开：子域名沿用落盘值，公网地址不变。
      await runtime.service.closePublicUrl();
      await runtime.service.stop();
      await runtime.service.start();
      const again = await runtime.service.createPublicUrl({ provider: "localtunnel" });
      assert.equal(again.public?.state, "running");
      assert.match(again.public?.url ?? "", /^https:\/\/my-fixed-name\.loca\.lt\/\?token=/);
      assert.deepEqual(requested, ["my-fixed-name", "my-fixed-name"]);
    } finally {
      runtime.dispose();
    }
  });

  it(
    "关闭公网链接后隧道终止、公网状态清空，远控照常可用",
    { skip: !fakeTunnelSupported },
    async () => {
      const binaryPath = await createFakeTunnelBinary();
      const runtime = createRuntime({ tunnelBinaryPath: binaryPath });
      try {
        await runtime.service.start();
        const created = await runtime.service.createPublicUrl({ provider: "cloudflare-quick" });
        assert.equal(created.public?.state, "running");

        const closed = await runtime.service.closePublicUrl();
        assert.equal(closed.state, "running");
        assert.equal(closed.public, undefined);
      } finally {
        runtime.dispose();
      }
    },
  );

  it("停止远控会连带终止隧道，公网状态一起清空", { skip: !fakeTunnelSupported }, async () => {
    const binaryPath = await createFakeTunnelBinary();
    const runtime = createRuntime({ tunnelBinaryPath: binaryPath });
    try {
      await runtime.service.start();
      const created = await runtime.service.createPublicUrl({ provider: "cloudflare-quick" });
      assert.equal(created.public?.state, "running");

      const stopped = await runtime.service.stop();
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.public, undefined);
    } finally {
      runtime.dispose();
    }
  });

  it("状态广播里带着公网这一段，UI 不用另开一条通道", async () => {
    const runtime = createRuntime();
    const seen: MobileRemoteControlStatus[] = [];
    const subscription = runtime.service.onDidChangeStatus((next) => seen.push(next));
    try {
      await runtime.service.start();
      await runtime.service.createPublicUrl({ provider: "cloudflare-quick" });
      assert.ok(seen.length > 0);
      assert.ok(seen.some((item) => item.public?.state === "error"));
    } finally {
      subscription.dispose();
      runtime.dispose();
    }
  });

  it("关闭公网链接时，正在创建的隧道被取消，不会事后复活", async () => {
    let closedCount = 0;
    const client = new FakeLocaltunnelClient();
    client.close = (): void => {
      closedCount += 1;
    };
    const runtime = createRuntime({
      createLocaltunnelClient: () => client as unknown as LocaltunnelClient,
    });
    try {
      await runtime.service.start();
      const seen: PublicTunnelStatus[] = [];
      const subscription = runtime.service.onDidChangeStatus((next) => {
        if (next.public) seen.push(next.public);
      });
      // 客户端一直不 ready：这次创建停在 starting。
      const creating = runtime.service.createPublicUrl({
        provider: "localtunnel",
        subdomain: "race-name",
      });
      await waitFor(() => seen.some((item) => item.state === "starting"));

      const closed = await runtime.service.closePublicUrl();
      assert.equal(closed.public, undefined);
      // 客户端被关掉：这次创建没留下悬空的隧道。
      assert.equal(closedCount, 1);
      await creating;

      const status = await runtime.service.getStatus();
      assert.equal(status.public, undefined);
      // 被作废的创建不发布 running，也不发布 error。
      assert.ok(!seen.some((item) => item.state === "running"));
      assert.ok(!seen.some((item) => item.state === "error"));
      subscription.dispose();
    } finally {
      runtime.dispose();
    }
  });

  it("远控停止时，正在创建的公网链接被取消，不会事后复活", async () => {
    let closedCount = 0;
    const client = new FakeLocaltunnelClient();
    client.close = (): void => {
      closedCount += 1;
    };
    const runtime = createRuntime({
      createLocaltunnelClient: () => client as unknown as LocaltunnelClient,
    });
    try {
      await runtime.service.start();
      const seen: PublicTunnelStatus[] = [];
      const subscription = runtime.service.onDidChangeStatus((next) => {
        if (next.public) seen.push(next.public);
      });
      const creating = runtime.service.createPublicUrl({
        provider: "localtunnel",
        subdomain: "race-name",
      });
      await waitFor(() => seen.some((item) => item.state === "starting"));

      const stopped = await runtime.service.stop();
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.public, undefined);
      assert.equal(closedCount, 1);
      await creating;

      const status = await runtime.service.getStatus();
      assert.equal(status.public, undefined);
      assert.ok(!seen.some((item) => item.state === "running"));
      subscription.dispose();
    } finally {
      runtime.dispose();
    }
  });
});
