import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCurlArgs,
  detectCurlCapabilities,
  downloadReleaseAsset,
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
    env: {},
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

test("downloadReleaseAsset：curl 失败时回退 fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  let fetched = false;
  const result = await downloadReleaseAsset("https://example.com/a.bin", dest, {
    env: {},
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

test("downloadReleaseAsset：全部通道失败时给出中文错误与代理提示", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  await assert.rejects(
    downloadReleaseAsset("https://example.com/a.bin", dest, {
      env: {},
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

test("downloadReleaseAsset：配置了代理时不再走不认代理的 fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-release-download-"));
  const dest = join(dir, "asset.bin");
  let fetchCalled = false;
  await assert.rejects(
    downloadReleaseAsset("https://example.com/a.bin", dest, {
      env: { https_proxy: "http://127.0.0.1:7890" },
      capabilities: FULL_CURL,
      runCurl: () => ({ ok: false, reason: "curl 退出码 7" }),
      fetchImpl: (() => {
        fetchCalled = true;
        throw new Error("不应调用");
      }) as never,
    }),
    (error: Error) => {
      assert.match(error.message, /代理/);
      return true;
    },
  );
  assert.equal(fetchCalled, false);
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
