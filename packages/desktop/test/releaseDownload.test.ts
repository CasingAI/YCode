import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCurlArgs,
  detectCurlCapabilities,
  detectLocalProxyUrl,
  detectSystemProxyUrl,
  downloadReleaseAsset,
  normalizeProxyServer,
  resolveDownloadProxy,
  resolveProxyUrl,
  sha256File,
} from "../scripts/release-download.mjs";

const FULL_CURL = {
  available: true,
  retryAllErrors: true,
  retryDelay: true,
  connectTimeout: true,
};

const MINIMAL_CURL = {
  available: true,
  retryAllErrors: false,
  retryDelay: false,
  connectTimeout: false,
};

/** 不做任何代理探测的选项：让测试只关心被注入的通道。 */
const NO_PROXY = { env: {}, systemProxyUrl: null, localProxyUrl: null };

test("resolveProxyUrl：https 优先 https_proxy", () => {
  assert.equal(
    resolveProxyUrl("https://github.com/x", {
      https_proxy: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:1080",
    }),
    "http://127.0.0.1:7890",
  );
});

test("resolveProxyUrl：没有 https_proxy 时回退 http_proxy", () => {
  assert.equal(
    resolveProxyUrl("https://github.com/x", { http_proxy: "http://127.0.0.1:1080" }),
    "http://127.0.0.1:1080",
  );
});

test("resolveProxyUrl：认大写变量名", () => {
  assert.equal(
    resolveProxyUrl("https://github.com/x", { HTTPS_PROXY: "http://127.0.0.1:7890" }),
    "http://127.0.0.1:7890",
  );
});

test("resolveProxyUrl：没有代理变量时返回 null（走直连）", () => {
  assert.equal(resolveProxyUrl("https://github.com/x", {}), null);
  assert.equal(resolveProxyUrl("https://github.com/x", { https_proxy: "  " }), null);
});

test("normalizeProxyServer：补协议前缀并解析分协议写法", () => {
  assert.equal(normalizeProxyServer("127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(
    normalizeProxyServer("http=127.0.0.1:1080;https=127.0.0.1:7890"),
    "http://127.0.0.1:7890",
  );
  assert.equal(normalizeProxyServer("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyServer("  "), null);
});

test("detectSystemProxyUrl：Windows 读注册表且代理未启用时返回 null", () => {
  const disabled = detectSystemProxyUrl("win32", (() => ({
    status: 0,
    stdout: "    ProxyEnable    REG_DWORD    0x0\n",
    stderr: "",
  })) as never);
  assert.equal(disabled, null);

  const enabled = detectSystemProxyUrl("win32", ((command: string, args: string[]) => {
    if (args.includes("ProxyEnable")) {
      return { status: 0, stdout: "    ProxyEnable    REG_DWORD    0x1\n", stderr: "" };
    }
    return {
      status: 0,
      stdout: "    ProxyServer    REG_SZ    127.0.0.1:7890\n",
      stderr: "",
    };
  }) as never);
  assert.equal(enabled, "http://127.0.0.1:7890");
});

test("detectLocalProxyUrl：探到监听端口就用它", async () => {
  const proxy = await detectLocalProxyUrl(
    [7890, 1080],
    async (port) => port === 1080,
  );
  assert.equal(proxy, "http://127.0.0.1:1080");
});

test("detectLocalProxyUrl：没有端口监听时返回 null", async () => {
  const proxy = await detectLocalProxyUrl([7890, 1080], async () => false);
  assert.equal(proxy, null);
});

test("resolveDownloadProxy：显式环境变量优先于应用代理与本机端口", async () => {
  const resolved = await resolveDownloadProxy("https://github.com/x", {
    env: { https_proxy: "http://127.0.0.1:1", ZCODE_APP_HTTP_PROXY: "http://127.0.0.1:2" },
    systemProxyUrl: "http://127.0.0.1:3",
    localProxyUrl: "http://127.0.0.1:4",
  });
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:1");
  assert.equal(resolved.source, "代理环境变量");
});

test("resolveDownloadProxy：没有环境变量时用应用代理配置", async () => {
  const resolved = await resolveDownloadProxy("https://github.com/x", {
    env: { ZCODE_APP_HTTP_PROXY: "http://127.0.0.1:7890" },
    systemProxyUrl: "http://127.0.0.1:3",
    localProxyUrl: "http://127.0.0.1:4",
  });
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(resolved.source, "应用代理配置");
});

test("resolveDownloadProxy：都没有时回退本机代理端口", async () => {
  const resolved = await resolveDownloadProxy("https://github.com/x", {
    env: {},
    systemProxyUrl: null,
    localProxyUrl: "http://127.0.0.1:7890",
  });
  assert.equal(resolved.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(resolved.source, "本机代理端口");
});

test("resolveDownloadProxy：完全没有代理时走直连", async () => {
  const resolved = await resolveDownloadProxy("https://github.com/x", {
    env: {},
    systemProxyUrl: null,
    localProxyUrl: null,
  });
  assert.equal(resolved.proxyUrl, null);
  assert.equal(resolved.source, "直连");
});

test("buildCurlArgs：完整能力时带重试、退避与连接超时", () => {
  const args = buildCurlArgs("https://example.com/a.exe", "out.exe", FULL_CURL, null);
  assert.ok(args.includes("--retry-all-errors"));
  assert.ok(args.includes("--retry-delay"));
  assert.ok(args.includes("--connect-timeout"));
  assert.equal(args.at(-3), "-o");
  assert.equal(args.at(-2), "out.exe");
  assert.equal(args.at(-1), "https://example.com/a.exe");
});

test("buildCurlArgs：精简 curl 不带不支持的参数", () => {
  const args = buildCurlArgs("https://example.com/a.exe", "out.exe", MINIMAL_CURL, null);
  assert.ok(!args.includes("--retry-all-errors"));
  assert.ok(!args.includes("--retry-delay"));
  assert.ok(!args.includes("--connect-timeout"));
  assert.ok(args.includes("--retry"));
});

test("buildCurlArgs：有代理时强制走代理", () => {
  const args = buildCurlArgs("https://example.com/a", "out", FULL_CURL, "http://127.0.0.1:7890");
  assert.ok(args.includes("--proxy"));
  assert.equal(args[args.indexOf("--proxy") + 1], "http://127.0.0.1:7890");
});

test("buildCurlArgs：直连通道屏蔽 curl 自带的代理环境变量", () => {
  const args = buildCurlArgs("https://example.com/a", "out", FULL_CURL, null, true);
  assert.ok(args.includes("--noproxy"));
  assert.equal(args[args.indexOf("--noproxy") + 1], "*");
  assert.ok(!args.includes("--proxy"));
});

test("detectCurlCapabilities：curl 缺失时标记为不可用", () => {
  const capabilities = detectCurlCapabilities((() => ({
    error: new Error("spawn curl ENOENT"),
    status: null,
    stdout: "",
    stderr: "",
  })) as never);
  assert.equal(capabilities.available, false);
});

test("detectCurlCapabilities：按帮助文本识别可选参数", () => {
  const capabilities = detectCurlCapabilities((() => ({
    status: 0,
    stdout: "  --retry-all-errors  --retry-delay  --connect-timeout <time>",
    stderr: "",
  })) as never);
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.retryAllErrors, true);
  assert.equal(capabilities.retryDelay, true);
  assert.equal(capabilities.connectTimeout, true);
});

test("downloadReleaseAsset：curl 成功时直接落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  const calls: string[][] = [];
  const result = await downloadReleaseAsset("https://example.com/a.bin", dest, {
    ...NO_PROXY,
    capabilities: FULL_CURL,
    runCurl: (args) => {
      calls.push(args);
      return { ok: true };
    },
    fetchImpl: (() => {
      throw new Error("不应走 fetch");
    }) as never,
  });
  assert.equal(result, dest);
  assert.equal(calls.length, 1);
});

test("downloadReleaseAsset：直连 curl 失败时回退 fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  let fetched = false;
  const result = await downloadReleaseAsset("https://example.com/a.bin", dest, {
    ...NO_PROXY,
    capabilities: FULL_CURL,
    runCurl: () => ({ ok: false, reason: "curl 退出码 56" }),
    fetchImpl: (async () => {
      fetched = true;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("payload"));
          controller.close();
        },
      });
      return { ok: true, status: 200, body: stream } as never;
    }) as never,
  });
  assert.equal(result, dest);
  assert.equal(fetched, true);
});

test("downloadReleaseAsset：代理通道成功时不再走直连", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  const calls: string[][] = [];
  const result = await downloadReleaseAsset("https://example.com/a.bin", dest, {
    env: {},
    systemProxyUrl: null,
    localProxyUrl: "http://127.0.0.1:7890",
    capabilities: FULL_CURL,
    runCurl: (args) => {
      calls.push(args);
      return { ok: true };
    },
    fetchImpl: (() => {
      throw new Error("不应走 fetch");
    }) as never,
  });
  assert.equal(result, dest);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.includes("--proxy"));
});

test("downloadReleaseAsset：代理通道失败后仍会尝试直连", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  const calls: string[][] = [];
  const result = await downloadReleaseAsset("https://example.com/a.bin", dest, {
    env: {},
    systemProxyUrl: null,
    localProxyUrl: "http://127.0.0.1:7890",
    capabilities: FULL_CURL,
    runCurl: (args) => {
      calls.push(args);
      return { ok: calls.length === 2 };
    },
    fetchImpl: (() => {
      throw new Error("不应走 fetch");
    }) as never,
  });
  assert.equal(result, dest);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.includes("--proxy"));
  assert.ok(calls[1]?.includes("--noproxy"));
});

test("downloadReleaseAsset：全部通道失败时给出中文错误与代理提示", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  await assert.rejects(
    downloadReleaseAsset("https://example.com/a.bin", dest, {
      ...NO_PROXY,
      capabilities: FULL_CURL,
      runCurl: () => ({ ok: false, reason: "curl 退出码 56" }),
      fetchImpl: (() => {
        throw new Error("ECONNRESET");
      }) as never,
      retryDelaysMs: [],
    }),
    (error: Error) => {
      assert.match(error.message, /下载失败/);
      assert.match(error.message, /HTTPS_PROXY/);
      return true;
    },
  );
});

test("downloadReleaseAsset：失败信息里写明用过的通道", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  await assert.rejects(
    downloadReleaseAsset("https://example.com/a.bin", dest, {
      env: {},
      systemProxyUrl: null,
      localProxyUrl: "http://127.0.0.1:7890",
      capabilities: FULL_CURL,
      runCurl: () => ({ ok: false, reason: "curl 退出码 7" }),
      fetchImpl: (() => {
        throw new Error("ECONNRESET");
      }) as never,
      retryDelaysMs: [],
    }),
    (error: Error) => {
      assert.match(error.message, /本机代理端口/);
      assert.match(error.message, /直连/);
      return true;
    },
  );
});

test("sha256File：算出小写十六进制摘要", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "abc", "utf8");
  assert.equal(
    await sha256File(file),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(await readFile(file, "utf8"), "abc");
});
