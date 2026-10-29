import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import {
  SANDBOX_WORKER_BANNER,
  SANDBOX_WORKER_BUNDLE_NAME,
  SANDBOX_WORKER_SEA_ASSET_NAME,
} from "./sandbox-worker-bundle.mjs";

const requireFromTest = createRequire(import.meta.url);
const WASM_ASSET_NAME = "quickjs-wasm";
const STALE_DIR_NAME = "zcode-sandbox-worker";

const createTempRoot = (t) => {
  const root = mkdtempSync(join(tmpdir(), "zcode-sandbox-worker-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
};

/**
 * 在独立 vm 上下文里执行真实 banner：node:fs / node:path / node:url 用真实模块，
 * node:os.tmpdir 指向测试临时根，node:sea 用可控 fake（不需要真 SEA）。
 */
const loadBanner = ({ tempRoot, sea, siblingDirectory = tempRoot }) => {
  const context = {
    Buffer,
    __dirname: siblingDirectory,
    require: (id) => {
      if (id === "node:sea") {
        if (!sea) throw new Error("Cannot find module 'node:sea'");
        return sea;
      }
      if (id === "node:os") return { tmpdir: () => tempRoot };
      return requireFromTest(id);
    },
  };
  vm.runInNewContext(
    `${SANDBOX_WORKER_BANNER}\nglobalThis.__locate = __zcodeSandboxWorkerAssets;`,
    context,
    {
      filename: "sandbox-worker-banner.cjs",
    },
  );
  return context.__locate;
};

const fakeSea = (assets) => ({
  isSea: () => true,
  getRawAsset: (name) => {
    if (!(name in assets)) {
      throw new Error(`Cannot find asset: ${name}`);
    }
    return assets[name];
  },
});

const assetSet = (label) => ({
  [WASM_ASSET_NAME]: Buffer.from(`wasm:${label}`),
  [SANDBOX_WORKER_SEA_ASSET_NAME]: Buffer.from(`worker:${label}`),
});

const filePathOf = (workerUrl) => fileURLToPath(new URL(workerUrl));

const seedStaleFixedDirectory = (tempRoot) => {
  const staleDirectory = join(tempRoot, STALE_DIR_NAME);
  mkdirSync(staleDirectory, { recursive: true });
  const staleWasm = join(staleDirectory, "quickjs.wasm");
  const staleWorker = join(staleDirectory, SANDBOX_WORKER_BUNDLE_NAME);
  writeFileSync(staleWasm, "stale-wasm");
  writeFileSync(staleWorker, "stale-worker");
  return { staleDirectory, staleWasm, staleWorker };
};

test("目录已有旧内容时不复用固定临时路径", (t) => {
  const tempRoot = createTempRoot(t);
  const { staleDirectory, staleWasm, staleWorker } = seedStaleFixedDirectory(tempRoot);
  const locate = loadBanner({ tempRoot, sea: fakeSea(assetSet("v2")) });

  const assets = locate();
  const workerPath = filePathOf(assets.workerUrl);

  assert.notEqual(workerPath, staleWorker);
  assert.notEqual(assets.wasmPath, staleWasm);
  assert.notEqual(join(workerPath, ".."), staleDirectory);
  assert.equal(readFileSync(workerPath, "utf8"), "worker:v2");
  assert.equal(readFileSync(assets.wasmPath, "utf8"), "wasm:v2");
  // 旧目录保持原样，未被读取也未被覆写。
  assert.equal(readFileSync(staleWorker, "utf8"), "stale-worker");
  assert.equal(readFileSync(staleWasm, "utf8"), "stale-wasm");
});

test("两个不同 bundle 版本各拿各自字节且互不覆写", (t) => {
  const tempRoot = createTempRoot(t);
  const locateV1 = loadBanner({ tempRoot, sea: fakeSea(assetSet("v1")) });
  const locateV2 = loadBanner({ tempRoot, sea: fakeSea(assetSet("v2")) });

  const v1 = locateV1();
  const v2 = locateV2();
  const v1WorkerPath = filePathOf(v1.workerUrl);
  const v2WorkerPath = filePathOf(v2.workerUrl);

  assert.notEqual(v1.workerUrl, v2.workerUrl);
  assert.equal(readFileSync(v1WorkerPath, "utf8"), "worker:v1");
  assert.equal(readFileSync(v1.wasmPath, "utf8"), "wasm:v1");
  assert.equal(readFileSync(v2WorkerPath, "utf8"), "worker:v2");
  assert.equal(readFileSync(v2.wasmPath, "utf8"), "wasm:v2");
  // 后加载的版本没有覆写前一版本目录。
  assert.equal(readFileSync(v1WorkerPath, "utf8"), "worker:v1");
  assert.equal(readFileSync(v1.wasmPath, "utf8"), "wasm:v1");
});

test("缺少单个 SEA asset 时明确失败，不回退旧缓存或同级文件", (t) => {
  const tempRoot = createTempRoot(t);
  const { staleWorker, staleWasm } = seedStaleFixedDirectory(tempRoot);
  const assets = assetSet("v2");
  delete assets[SANDBOX_WORKER_SEA_ASSET_NAME];
  const locate = loadBanner({ tempRoot, sea: fakeSea(assets) });

  assert.throws(() => locate(), /Cannot find asset: sandbox-worker/);
  assert.equal(locate.cached, undefined);
  // 没有静默沿用旧缓存，也没有落到同级文件。
  assert.equal(readFileSync(staleWorker, "utf8"), "stale-worker");
  assert.equal(readFileSync(staleWasm, "utf8"), "stale-wasm");
});

test("wasm 与 worker 落在同一 SEA 物化目录", (t) => {
  const tempRoot = createTempRoot(t);
  const locate = loadBanner({ tempRoot, sea: fakeSea(assetSet("v3")) });

  const assets = locate();
  const workerPath = filePathOf(assets.workerUrl);
  assert.equal(join(workerPath, ".."), join(assets.wasmPath, ".."));
  assert.equal(join(workerPath, "..").startsWith(join(tempRoot, "zcode-sandbox-worker-")), true);
});

test("同一进程重复定位返回同一缓存且只建一个目录", (t) => {
  const tempRoot = createTempRoot(t);
  const locate = loadBanner({ tempRoot, sea: fakeSea(assetSet("v4")) });

  const first = locate();
  const second = locate();

  assert.equal(first, second);
  assert.equal(first.workerUrl, second.workerUrl);
  assert.equal(first.wasmPath, second.wasmPath);
  assert.equal(
    readdirSync(tempRoot).filter((name) => name.startsWith("zcode-sandbox-worker-")).length,
    1,
  );
  assert.equal(readFileSync(filePathOf(first.workerUrl), "utf8"), "worker:v4");
  assert.equal(readFileSync(first.wasmPath, "utf8"), "wasm:v4");
});

test("非 SEA 缺同级 worker 时显式失败", (t) => {
  const tempRoot = createTempRoot(t);
  const locate = loadBanner({ tempRoot, sea: undefined });

  assert.throws(() => locate(), /Sandbox worker entry is missing/);
});
