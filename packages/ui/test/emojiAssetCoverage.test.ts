import assert from "node:assert/strict";
import test from "node:test";

import {
  emojiAssetKey,
  emojiAssetUrl,
  hasEmojiAsset,
  NOTO_EMOJI_ASSET_COUNT,
  NOTO_EMOJI_ASSET_KEYS,
} from "../src/assets/noto-emoji/index.js";
import {
  loadNotoEmojiAssets,
  notoEmojiAssetsPlugin,
  resolveNotoEmojiAssetRoot,
} from "../vite/notoEmojiAssetsPlugin.js";

// 资源锁与 emojibase 覆盖门禁：读取真实目录、真实哈希与已安装 zh/en 数据。
// 该测试失败即表示资源目录、锁或数据版本不再一致，不能在运行时用缺图兜底掩盖。
test("Noto emoji 资源锁、文件名与 emojibase zh/en 全覆盖", { timeout: 120_000 }, async () => {
  const assets = await loadNotoEmojiAssets();
  assert.equal(assets.length, 3998);
  assert.equal(new Set(assets.map((asset) => asset.key)).size, 3998);
  assert.equal(
    assets.reduce((total, asset) => total + asset.bytes.byteLength, 0),
    16_541_769,
  );

  assert.equal(NOTO_EMOJI_ASSET_COUNT, 3998);
  assert.equal(NOTO_EMOJI_ASSET_KEYS.length, 3998);
  assert.equal(new Set(NOTO_EMOJI_ASSET_KEYS).size, 3998);
  assert.deepEqual(
    NOTO_EMOJI_ASSET_KEYS,
    assets.map((asset) => asset.key),
  );
  assert.ok(NOTO_EMOJI_ASSET_KEYS.every((key) => /^emoji_u[0-9a-f]+(_[0-9a-f]+)*$/.test(key)));
});

test("构建插件 emit 与开发态使用同一扁平文件名", { timeout: 120_000 }, async () => {
  const plugin = notoEmojiAssetsPlugin();
  (plugin.configResolved as (config: { command: string; root: string }) => void)({
    command: "build",
    root: process.cwd(),
  });
  const emitted: { fileName?: string }[] = [];
  const context = {
    emitFile: (file: { fileName?: string }) => emitted.push(file),
  };
  await (plugin.buildStart as () => Promise<void>).call(context);
  await (plugin.generateBundle as () => Promise<void>).call(context);
  assert.equal(emitted.length, 3998);
  assert.equal(new Set(emitted.map((file) => file.fileName)).size, 3998);
  assert.ok(
    emitted.every((file) =>
      /^noto-emoji\/emoji_u[0-9a-f]+(_[0-9a-f]+)*\.png$/.test(file.fileName ?? ""),
    ),
  );
});

test("emoji key 规则：小写补 4 位、去变体选择符、保留 ZWJ/Keycap/Tag", () => {
  assert.equal(emojiAssetKey("🚀"), "emoji_u1f680");
  assert.equal(emojiAssetKey("❤"), "emoji_u2764");
  assert.equal(emojiAssetKey("❤️"), "emoji_u2764");
  assert.equal(emojiAssetKey("❤︎"), "emoji_u2764");
  assert.equal(emojiAssetKey("👨‍👩‍👧"), "emoji_u1f468_200d_1f469_200d_1f467");
  assert.equal(emojiAssetKey("#️⃣"), "emoji_u0023_20e3");
  assert.equal(emojiAssetKey("🇨🇳"), "emoji_u1f1e8_1f1f3");
  assert.equal(emojiAssetKey("🏴󠁧󠁢󠁥󠁮󠁧󠁿"), "emoji_u1f3f4_e0067_e0062_e0065_e006e_e0067_e007f");
  assert.equal(emojiAssetKey(""), null);
});

test("URL API 只返回索引内资源，未知字符不拼路径", () => {
  assert.equal(emojiAssetUrl("🚀"), "./noto-emoji/emoji_u1f680.png");
  assert.equal(emojiAssetUrl("❤️"), "./noto-emoji/emoji_u2764.png");
  assert.equal(emojiAssetUrl("🇨🇳"), "./noto-emoji/emoji_u1f1e8_1f1f3.png");
  assert.equal(emojiAssetUrl("A"), null);
  assert.equal(emojiAssetUrl(""), null);
  assert.equal(hasEmojiAsset("🚀"), true);
  assert.equal(hasEmojiAsset("A"), false);
  assert.equal(resolveNotoEmojiAssetRoot().endsWith("noto-emoji"), true);
});
