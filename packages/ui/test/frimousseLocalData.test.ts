import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildEmojiData,
  resolveLocalEmojiData,
} from "../src/workspace-grouped-tasks/frimousse-local-data.js";
import { emojiAssetUrl } from "../src/assets/noto-emoji/index.js";
import rawEn from "emojibase-data/en/data.json" with { type: "json" };

interface RawEntry {
  emoji: string;
  skins?: { emoji: string }[];
}

// 口径对齐 frimousse 默认解析器：component 组被剔除、无 group 的条目（肤色部件）不进列表。
const rawMessages = {
  groups: [
    { key: "smileys-emotion", message: "笑脸与情感", order: 0 },
    { key: "component", message: "组件", order: 2 },
  ],
  subgroups: [
    { key: "country-flag", message: "国家旗帜", order: 98 },
    { key: "other", message: "其他", order: 1 },
  ],
  skinTones: [
    { key: "light", message: "较浅肤色" },
    { key: "dark", message: "较深肤色" },
  ],
};

function rawEmoji(
  entry: Partial<Parameters<typeof buildEmojiData>[1][number]> & { emoji: string },
) {
  return entry;
}

test("buildEmojiData：转换口径与 frimousse 默认解析器一致", () => {
  const data = buildEmojiData(
    "zh",
    [
      rawEmoji({
        emoji: "🚀",
        label: "火箭",
        version: 0.6,
        group: 5,
        subgroup: 56,
        tags: ["太空"],
      }),
      // 国旗条目：subgroup 命中 country-flag → countryFlag 标记。
      rawEmoji({ emoji: "🇨🇳", label: "旗: 中国", version: 0.6, group: 9, subgroup: 98 }),
      // component（无 group）被过滤。
      rawEmoji({ emoji: "🏻", label: "肤色部件", version: 0.6 }),
    ],
    rawMessages,
  );

  assert.equal(data.locale, "zh");
  assert.deepEqual(
    data.categories,
    [{ index: 0, label: "笑脸与情感" }],
    "component 组被剔除、标签首字母大写",
  );
  assert.equal(data.skinTones.light, "较浅肤色");
  assert.equal(data.emojis.length, 2);
  assert.equal(data.emojis[0].emoji, "🚀");
  assert.equal(data.emojis[0].category, 5);
  assert.deepEqual(data.emojis[0].tags, ["太空"]);
  assert.equal(data.emojis[1].countryFlag, true);
});

test("buildEmojiData：肤色变体映射为 frimousse 键、多肤色条目进 aliases", () => {
  const data = buildEmojiData(
    "en",
    [
      {
        emoji: "👍",
        label: "thumbs up",
        version: 0.6,
        group: 1,
        skins: [
          { emoji: "👍🏻", tone: 1 },
          { emoji: "👍🏿", tone: 5 },
          { emoji: "👨🏻‍🤝‍👨🏼", tone: [1, 2] },
        ],
      },
    ],
    rawMessages,
  );

  assert.deepEqual(data.emojis[0].skins, { light: "👍🏻", dark: "👍🏿" });
  assert.deepEqual(data.emojis[0].aliases, ["👨🏻‍🤝‍👨🏼"]);
});

test("resolveLocalEmojiData：Node 无 DOM 也返回全量数据，国旗与新 emoji 不被过滤", async () => {
  const zh = await resolveLocalEmojiData("zh", {});
  assert.equal(zh.locale, "zh");
  assert.ok(zh.categories.length > 5, "分类完整");
  assert.ok(zh.emojis.length > 1900, "全量列表");
  assert.ok(zh.skinTones.light.length > 0);

  assert.ok(
    zh.emojis.some((entry) => entry.emoji === "🇨🇳"),
    "国旗在无 DOM 环境仍保留",
  );
  assert.ok(
    zh.emojis.some((entry) => entry.emoji === "🫫" && entry.version === 18),
    "Unicode 18 新 emoji 未被字体探测过滤",
  );

  const en = await resolveLocalEmojiData("en-gb", {});
  assert.equal(en.locale, "en", "未打包的 locale 回落 en");
});

test("真实 emojibase zh/en 数据与 3998 个本地图片 key 完整对应", async () => {
  // 原始数据（含肤色、性别变体与多肤色别名）合计 3998 个不同 emoji，和资源锁一致。
  const rawValues = (rawEn as RawEntry[]).flatMap((entry) => [
    entry.emoji,
    ...(entry.skins ?? []).map((skin) => skin.emoji),
  ]);
  const rawUnique = [...new Set(rawValues)];
  assert.equal(rawUnique.length, 3998, "emojibase 原始数据应覆盖完整资源集");
  assert.deepEqual(
    rawUnique.filter((value) => emojiAssetUrl(value) === null),
    [],
    "本地图片资源不得缺图",
  );

  // frimousse 可见目录（base＋单肤色＋多肤色别名）同样不允许出现缺图。
  const data = await resolveLocalEmojiData("en", {});
  const visible = data.emojis.flatMap((entry) => [
    entry.emoji,
    ...Object.values(entry.skins ?? {}),
    ...(entry.aliases ?? []),
  ]);
  assert.ok(visible.length > 3900);
  assert.deepEqual(
    [...new Set(visible)].filter((value) => emojiAssetUrl(value) === null),
    [],
    "选择器可见条目不得缺图",
  );
  assert.ok(emojiAssetUrl("🇨🇳"), "国家旗帜资源存在");
  assert.ok(emojiAssetUrl("🫫"), "Unicode 18 新 emoji 资源存在");
});

test("解析器不依赖 DOM/canvas 或系统字体探测", () => {
  const source = readFileSync(
    new URL("../src/workspace-grouped-tasks/frimousse-local-data.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /CanvasRenderingContext2D|document\.createElement|getContext\(|measureText|getImageData/,
  );
  assert.doesNotMatch(source, /detectEmojiFontSupport|filterByFontSupport|EmojiFontSupport/);
  assert.doesNotMatch(source, /EMOJI_FONT_STACK|rendersInColor/);
});

test("resolveLocalEmojiData：数据集按 locale 缓存（重复打开返回同一对象）", async () => {
  const first = await resolveLocalEmojiData("zh", {});
  const second = await resolveLocalEmojiData("zh", {});
  assert.equal(second, first);
});

test("resolveLocalEmojiData：预中止信号直接抛出", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => resolveLocalEmojiData("en", { signal: controller.signal }));
});
