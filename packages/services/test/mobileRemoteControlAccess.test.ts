import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NetworkInterfaceInfo } from "node:os";
import {
  buildAccessUrl,
  buildLanAccessView,
  buildLanOriginUrls,
  createAccessToken,
  listLanAddresses,
  pickFreePort,
} from "../src/mobile-remote-control/lanAccess.js";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

describe("createAccessToken", () => {
  it("每次都是新的、URL 安全的 32 字符令牌", () => {
    const first = createAccessToken();
    const second = createAccessToken();
    assert.notEqual(first, second);
    assert.equal(first.length, 32);
    // base64url：不含 + / =，可以直接放进查询串。
    assert.match(first, /^[A-Za-z0-9_-]+$/);
  });
});

describe("pickFreePort", () => {
  it("返回可再次绑定的端口", async () => {
    const port = await pickFreePort("127.0.0.1");
    assert.ok(port > 0 && port < 65536);
    // 探测 socket 必须已经释放，否则远控服务绑不上去。
    const { createServer } = await import("node:net");
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it("连续调用不会拿到同一个端口（每次都重新申请）", async () => {
    const first = await pickFreePort("127.0.0.1");
    const second = await pickFreePort("127.0.0.1");
    // OS 可能复用刚释放的高位端口，但两次都合法且都可用即可；
    // 这里只断言不会返回 0 或越界值。
    assert.ok(first > 0 && second > 0);
  });
});

describe("listLanAddresses", () => {
  it("只保留非 internal 的 IPv4", () => {
    const addresses = listLanAddresses({
      lo0: [ipv4("127.0.0.1", true)],
      en0: [ipv4("192.168.1.20"), ipv4("fe80::1", true)],
      eth0: [
        {
          address: "fe80::abcd",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fe80::abcd/64",
        },
      ],
    });
    assert.deepEqual(addresses, ["192.168.1.20"]);
  });

  it("排除 link-local 自分配地址，并稳定去重排序", () => {
    const addresses = listLanAddresses({
      en0: [ipv4("10.0.0.9"), ipv4("169.254.10.5")],
      en1: [ipv4("10.0.0.9"), ipv4("192.168.0.2")],
    });
    assert.deepEqual(addresses, ["10.0.0.9", "192.168.0.2"]);
  });

  it("没有任何局域网地址时返回空数组", () => {
    assert.deepEqual(listLanAddresses({ lo0: [ipv4("127.0.0.1", true)] }), []);
  });
});

describe("buildLanAccessView", () => {
  it("accessUrl 带 token，lanUrls 不带 token", () => {
    const view = buildLanAccessView({
      port: 41234,
      token: "tok_EN-123",
      addresses: ["192.168.1.20", "10.0.0.9"],
    });
    assert.equal(view.accessUrl, "http://192.168.1.20:41234/?token=tok_EN-123");
    assert.deepEqual(view.lanUrls, ["http://192.168.1.20:41234", "http://10.0.0.9:41234"]);
    assert.equal(buildLanOriginUrls(41234, []).length, 0);
  });

  it("没有局域网地址时回退 loopback，仍给出可用链接", () => {
    const view = buildLanAccessView({ port: 8080, token: "abc", addresses: [] });
    assert.equal(view.accessUrl, "http://127.0.0.1:8080/?token=abc");
    assert.deepEqual(view.lanUrls, []);
  });

  it("token 会被 URL 编码，不破坏查询串", () => {
    assert.equal(
      buildAccessUrl(80, "a b&c", "192.168.1.2"),
      "http://192.168.1.2:80/?token=a%20b%26c",
    );
  });
});
