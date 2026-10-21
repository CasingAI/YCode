import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PUBLIC_TUNNEL_PROVIDERS,
  buildLocaltunnelOptions,
  buildPublicAccessUrl,
  buildTunnelArgs,
  findPublicTunnelProvider,
  generateLocaltunnelSubdomain,
  isExpectedLocaltunnelUrl,
  normalizeLocaltunnelSubdomain,
  parseQuickTunnelUrl,
  validatePublicTunnelParams,
} from "@zcode/services";
import { startCloudflaredTunnel } from "../src/host/publicTunnelCloudflared.js";
import { createFakeTunnelBinary, fakeTunnelSupported } from "./helpers/fakeTunnelBinary.js";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("公网隧道 Provider 目录", () => {
  it("目录里只有 Quick 与 localtunnel 两项，域名稳定性由数据表达", () => {
    assert.equal(PUBLIC_TUNNEL_PROVIDERS.length, 2);
    const quick = findPublicTunnelProvider("cloudflare-quick");
    assert.ok(quick);
    assert.equal(quick.requiresSubdomain, false);
    assert.equal(quick.stableDomain, false);
    const localtunnel = findPublicTunnelProvider("localtunnel");
    assert.ok(localtunnel);
    assert.equal(localtunnel.requiresSubdomain, true);
    assert.equal(localtunnel.stableDomain, true);
  });

  it("未知 Provider 返回 undefined，不静默兜底", () => {
    assert.equal(findPublicTunnelProvider("nope"), undefined);
  });
});

describe("validatePublicTunnelParams", () => {
  it("Quick 不需要子域名", () => {
    assert.equal(validatePublicTunnelParams({ provider: "cloudflare-quick" }), undefined);
  });

  it("localtunnel 的子域名留空是合法的：宿主会沿用已保存的或自动生成", () => {
    assert.equal(validatePublicTunnelParams({ provider: "localtunnel" }), undefined);
    assert.equal(
      validatePublicTunnelParams({ provider: "localtunnel", subdomain: "  " }),
      undefined,
    );
  });

  it("localtunnel 的子域名非法时给出可读原因", () => {
    assert.match(
      validatePublicTunnelParams({ provider: "localtunnel", subdomain: "Bad_Name" }) ?? "",
      /子域名/,
    );
    assert.match(
      validatePublicTunnelParams({ provider: "localtunnel", subdomain: "-lead" }) ?? "",
      /子域名/,
    );
    assert.equal(
      validatePublicTunnelParams({ provider: "localtunnel", subdomain: "my-fixed-name" }),
      undefined,
    );
  });

  it("未知 Provider 直接拒绝", () => {
    assert.match(validatePublicTunnelParams({ provider: "unknown" as never }) ?? "", /服务商/);
  });
});

describe("localtunnel 子域名", () => {
  it("归一化去掉空白并转小写", () => {
    assert.equal(normalizeLocaltunnelSubdomain("  My-Name  "), "my-name");
  });

  it("自动生成 ycode- 前缀加 8 位字符，只含不易认错的字符", () => {
    const generated = generateLocaltunnelSubdomain(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    assert.match(generated, /^ycode-[a-z0-9]{8}$/);
    // 只查随机段：前缀 "ycode-" 本身含有 o。
    const suffix = generated.slice("ycode-".length);
    assert.equal(suffix.includes("i"), false);
    assert.equal(suffix.includes("l"), false);
    assert.equal(suffix.includes("o"), false);
    assert.equal(suffix.includes("0"), false);
    assert.equal(suffix.includes("1"), false);
  });

  it("同样的随机字节生成同样的子域名", () => {
    const bytes = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    assert.equal(
      generateLocaltunnelSubdomain(bytes),
      generateLocaltunnelSubdomain(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])),
    );
  });

  it("客户端入参带上端口、子域名与服务地址", () => {
    assert.deepEqual(
      buildLocaltunnelOptions({ port: 53211, subdomain: "my-name", host: "https://loca.lt" }),
      { port: 53211, subdomain: "my-name", host: "https://loca.lt" },
    );
  });
});

describe("isExpectedLocaltunnelUrl", () => {
  it("首段主机名与请求的子域名一致才算命中", () => {
    assert.equal(isExpectedLocaltunnelUrl("https://my-name.loca.lt", "my-name"), true);
    assert.equal(isExpectedLocaltunnelUrl("https://other-name.loca.lt", "my-name"), false);
    assert.equal(isExpectedLocaltunnelUrl("https://my-name.localtunnel.me", "my-name"), true);
  });

  it("地址不合法或子域名为空时不算命中", () => {
    assert.equal(isExpectedLocaltunnelUrl("not-a-url", "my-name"), false);
    assert.equal(isExpectedLocaltunnelUrl("https://my-name.loca.lt", ""), false);
  });
});

describe("cloudflared 输出解析", () => {
  it("Quick 从输出里解析临时域名", () => {
    assert.equal(
      parseQuickTunnelUrl(
        "2026-01-01T00:00:00Z INF Your quick Tunnel has been created!  Visit it at https://abc-def.trycloudflare.com",
      ),
      "https://abc-def.trycloudflare.com",
    );
    assert.equal(parseQuickTunnelUrl("nothing here"), undefined);
  });
});

describe("buildTunnelArgs", () => {
  it("Quick 用 --url 指向本地目标", () => {
    assert.deepEqual(buildTunnelArgs("http://127.0.0.1:1"), [
      "tunnel",
      "--url",
      "http://127.0.0.1:1",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:0",
    ]);
  });
});

describe("buildPublicAccessUrl", () => {
  it("公网链接带同一个远控 token", () => {
    assert.equal(
      buildPublicAccessUrl("https://abc.trycloudflare.com", "tok en/1"),
      "https://abc.trycloudflare.com/?token=tok%20en%2F1",
    );
  });
});

describe("startCloudflaredTunnel", () => {
  it("二进制不存在时给出可读错误", async () => {
    await assert.rejects(
      startCloudflaredTunnel({
        binaryPath: "/nonexistent/cloudflared",
        target: "http://127.0.0.1:1",
        logger: silentLogger,
      }),
      /隧道进程/,
    );
  });

  it("起来后拿到公网地址，stop 后进程退出", { skip: !fakeTunnelSupported }, async () => {
    const binaryPath = await createFakeTunnelBinary("quick");
    const handle = await startCloudflaredTunnel({
      binaryPath,
      target: "http://127.0.0.1:1",
      logger: silentLogger,
    });
    try {
      assert.equal(handle.url, "https://fake.trycloudflare.com");
    } finally {
      await handle.stop();
    }
  });

  it("信号已经取消时直接失败，不拉起子进程", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      startCloudflaredTunnel({
        binaryPath: "/nonexistent/cloudflared",
        target: "http://127.0.0.1:1",
        logger: silentLogger,
        signal: controller.signal,
      }),
      /已取消/,
    );
  });

  it(
    "启动途中被取消时立刻失败，不等启动超时",
    { skip: !fakeTunnelSupported },
    async () => {
      const binaryPath = await createFakeTunnelBinary("silent");
      const controller = new AbortController();
      const starting = startCloudflaredTunnel({
        binaryPath,
        target: "http://127.0.0.1:1",
        logger: silentLogger,
        signal: controller.signal,
      });
      controller.abort();
      await assert.rejects(starting, /已取消/);
    },
  );
});
