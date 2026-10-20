import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  PUBLIC_TUNNEL_PROVIDERS,
  buildPublicAccessUrl,
  buildTunnelArgs,
  buildTunnelConfig,
  decodeTunnelToken,
  findPublicTunnelProvider,
  isTunnelRegisteredLog,
  normalizePublicHostname,
  parseQuickTunnelUrl,
  validatePublicTunnelParams,
} from "@zcode/services";
import { startPublicTunnel } from "../src/host/publicTunnelProcess.js";
import { createFakeTunnelBinary, fakeTunnelSupported } from "./helpers/fakeTunnelBinary.js";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 造一个合法的 Cloudflare 隧道 token：base64 的 {a,t,s}。 */
function makeToken(): string {
  return Buffer.from(
    JSON.stringify({ a: "acct-id", t: "tunnel-id", s: "tunnel-secret" }),
    "utf8",
  ).toString("base64");
}

describe("公网隧道 Provider 目录", () => {
  it("目录里有 Quick 与 Named 两项，凭据需求与域名稳定性由数据表达", () => {
    assert.equal(PUBLIC_TUNNEL_PROVIDERS.length, 2);
    const quick = findPublicTunnelProvider("cloudflare-quick");
    assert.ok(quick);
    assert.equal(quick.requiresCredentials, false);
    assert.equal(quick.stableDomain, false);
    const named = findPublicTunnelProvider("cloudflare-named");
    assert.ok(named);
    assert.equal(named.requiresCredentials, true);
    assert.equal(named.stableDomain, true);
  });

  it("未知 Provider 返回 undefined，不静默兜底", () => {
    assert.equal(findPublicTunnelProvider("nope"), undefined);
  });
});

describe("validatePublicTunnelParams", () => {
  it("Quick 不需要凭据", () => {
    assert.equal(validatePublicTunnelParams({ provider: "cloudflare-quick" }), undefined);
  });

  it("Named 缺 token 或 hostname 都给出可读原因", () => {
    assert.match(
      validatePublicTunnelParams({ provider: "cloudflare-named" }) ?? "",
      /Token/,
    );
    assert.match(
      validatePublicTunnelParams({ provider: "cloudflare-named", token: "t" }) ?? "",
      /域名/,
    );
    assert.equal(
      validatePublicTunnelParams({
        provider: "cloudflare-named",
        token: "t",
        hostname: "h",
      }),
      undefined,
    );
  });

  it("未知 Provider 直接拒绝", () => {
    assert.match(
      validatePublicTunnelParams({ provider: "unknown" as never }) ?? "",
      /Provider/,
    );
  });
});

describe("decodeTunnelToken", () => {
  it("解出账号、隧道与密钥三个字段", () => {
    const decoded = decodeTunnelToken(makeToken());
    assert.equal(decoded.accountTag, "acct-id");
    assert.equal(decoded.tunnelId, "tunnel-id");
    assert.equal(decoded.tunnelSecret, "tunnel-secret");
  });

  it("非法 token 抛可读错误，不抛裸异常", () => {
    assert.throws(() => decodeTunnelToken(""), /Token/);
    assert.throws(() => decodeTunnelToken("not-base64-json"), /Token/);
    // base64 合法但内容缺字段
    const missing = Buffer.from(JSON.stringify({ a: "acct" }), "utf8").toString("base64");
    assert.throws(() => decodeTunnelToken(missing), /字段/);
  });
});

describe("buildTunnelConfig", () => {
  it("credentials 文件含三个字段，config 指向目标端口且不写 configVersion", () => {
    const files = buildTunnelConfig({
      tunnelId: "tunnel-id",
      tunnelSecret: "tunnel-secret",
      accountTag: "acct-id",
      hostname: "remote.example.com",
      target: "http://127.0.0.1:53211",
      credentialsFile: "/tmp/zcode-tunnel/credentials.json",
    });
    const credentials = JSON.parse(files.credentialsJson) as Record<string, string>;
    assert.equal(credentials.AccountTag, "acct-id");
    assert.equal(credentials.TunnelSecret, "tunnel-secret");
    assert.equal(credentials.TunnelID, "tunnel-id");

    assert.match(files.configYaml, /^tunnel: tunnel-id$/m);
    assert.match(files.configYaml, /credentials-file: '\/tmp\/zcode-tunnel\/credentials\.json'/);
    assert.match(files.configYaml, /- hostname: 'remote\.example\.com'/);
    assert.match(files.configYaml, /service: 'http:\/\/127\.0\.0\.1:53211'/);
    // 写了 configVersion 就会以远端配置为准（端口被写死），随机端口就不成立了。
    assert.equal(files.configYaml.includes("configVersion"), false);
    // catch-all 必须在最后。
    assert.match(files.configYaml.trimEnd(), /- service: http_status:404$/);
  });

  it("Windows 路径用单引号，反斜杠不被当成转义符", () => {
    const files = buildTunnelConfig({
      tunnelId: "tunnel-id",
      tunnelSecret: "s",
      accountTag: "a",
      hostname: "remote.example.com",
      target: "http://127.0.0.1:1",
      credentialsFile: "C:\\Users\\me\\AppData\\Local\\Temp\\t\\credentials.json",
    });
    assert.match(files.configYaml, /credentials-file: 'C:\\Users\\me/);
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

  it("Named 认连接注册成功的日志", () => {
    assert.equal(
      isTunnelRegisteredLog("2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0"),
      true,
    );
    assert.equal(isTunnelRegisteredLog("unrelated"), false);
  });
});

describe("buildTunnelArgs", () => {
  it("Quick 用 --url 指向本地目标", () => {
    assert.deepEqual(buildTunnelArgs({ provider: "cloudflare-quick", target: "http://127.0.0.1:1" }), [
      "tunnel",
      "--url",
      "http://127.0.0.1:1",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:0",
    ]);
  });

  it("Named 的 --config 排在 run 之前，隧道 ID 在最后", () => {
    const args = buildTunnelArgs({
      provider: "cloudflare-named",
      target: "http://127.0.0.1:1",
      configPath: "/tmp/config.yml",
      tunnelId: "tunnel-id",
    });
    assert.ok(args.indexOf("--config") < args.indexOf("run"));
    assert.equal(args[args.length - 1], "tunnel-id");
  });

  it("Named 缺配置路径直接抛错", () => {
    assert.throws(
      () => buildTunnelArgs({ provider: "cloudflare-named", target: "http://127.0.0.1:1" }),
      /config/,
    );
  });
});

describe("normalizePublicHostname 与 buildPublicAccessUrl", () => {
  it("hostname 去掉协议与路径", () => {
    assert.equal(normalizePublicHostname(" https://Remote.Example.com/path "), "remote.example.com");
    assert.equal(normalizePublicHostname("remote.example.com"), "remote.example.com");
  });

  it("公网链接带同一个远控 token", () => {
    assert.equal(
      buildPublicAccessUrl("https://abc.trycloudflare.com", "tok en/1"),
      "https://abc.trycloudflare.com/?token=tok%20en%2F1",
    );
  });
});

describe("startPublicTunnel", () => {
  it("二进制不存在时给出可读错误", async () => {
    await assert.rejects(
      startPublicTunnel({
        binaryPath: "/nonexistent/cloudflared",
        provider: "cloudflare-quick",
        target: "http://127.0.0.1:1",
        logger: silentLogger,
      }),
      /隧道进程/,
    );
  });

  it("Quick 起来后拿到公网地址，stop 后进程退出", { skip: !fakeTunnelSupported }, async () => {
    const binaryPath = await createFakeTunnelBinary("quick");
    const handle = await startPublicTunnel({
      binaryPath,
      provider: "cloudflare-quick",
      target: "http://127.0.0.1:1",
      logger: silentLogger,
    });
    try {
      assert.equal(handle.url, "https://fake.trycloudflare.com");
    } finally {
      await handle.stop();
    }
  });

  it("Named 用用户自己的 hostname 作为公网地址，停止后清理临时配置", { skip: !fakeTunnelSupported }, async () => {
    const binaryPath = await createFakeTunnelBinary("named");
    const before = await readdir(tmpdir());
    const handle = await startPublicTunnel({
      binaryPath,
      provider: "cloudflare-named",
      target: "http://127.0.0.1:1",
      token: makeToken(),
      hostname: "https://remote.example.com",
      logger: silentLogger,
    });
    try {
      assert.equal(handle.url, "https://remote.example.com");
    } finally {
      await handle.stop();
    }
    const after = await readdir(tmpdir());
    const leftovers = after.filter(
      (name) => name.startsWith("zcode-tunnel-") && !before.includes(name),
    );
    assert.deepEqual(leftovers, []);
  });
});
