import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { outputDir } from "./output-dir.mjs";

// 运行时验证：用 Vite 自身的模块管线执行真实 frimousse-local-data.ts，
// 并直接加载生产数据 chunk，确认 resolver 与构建产物都可消费。
// 不替代浏览器交互验证。
const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "../../..");
const DIST = resolve(outputDir);

const { createServer } = await import("vite");

const server = await createServer({
  configFile: join(HERE, "vite.config.mts"),
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const resolverPath = join(
    UI_ROOT,
    "src/workspace-grouped-tasks/frimousse-local-data.ts",
  ).replaceAll("\\", "/");
  const module = await server.ssrLoadModule(`/@fs/${resolverPath}`);

  // resolver 不得走网络：调用期间统计 fetch 次数。
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    return originalFetch(...args);
  };
  try {
    for (const locale of ["zh", "en"]) {
      const data = await module.resolveLocalEmojiData(locale, {});
      assert.equal(data.locale, locale);
      assert.ok(data.categories.length >= 8, `${locale} 分类不完整`);
      assert.ok(data.emojis.length > 1000, `${locale} 表情数量异常: ${data.emojis.length}`);
      const rocket = data.emojis.find((entry) => entry.emoji === "🚀");
      assert.ok(rocket, `${locale} 数据缺少 🚀`);
      console.log(
        `PASS dev resolver ${locale}: categories=${data.categories.length} emojis=${data.emojis.length} rocketLabel=${rocket.label}`,
      );
    }
    assert.equal(fetchCalls, 0, `resolver 触发了 ${fetchCalls} 次网络请求`);
    console.log("PASS dev resolver 未发起任何 fetch 请求");
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await server.close();
}

const assets = await readdir(join(DIST, "assets"));
for (const [locale, expected] of [
  ["zh", "火箭"],
  ["en", "rocket"],
]) {
  const file = assets.find((name) => new RegExp(`^emojibase-data-${locale}-.*\\.js$`).test(name));
  assert.ok(file, `缺少 ${locale} 数据 chunk`);
  const built = await import(pathToFileURL(join(DIST, "assets", file)).href);
  assert.ok(built.data.length > 1000, `${locale} 构建数据条目异常`);
  assert.ok(built.messages.groups.length >= 9, `${locale} 分类消息异常`);
  const labels = built.data.map((entry) => entry.label);
  assert.ok(
    labels.some((label) => label.toLowerCase().includes(expected.toLowerCase())),
    `${locale} 构建数据缺少搜索目标 ${expected}`,
  );
  console.log(
    `PASS prod chunk ${locale}: entries=${built.data.length} groups=${built.messages.groups.length}`,
  );
}
