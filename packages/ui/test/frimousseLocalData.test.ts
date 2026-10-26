import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmojiData,
  filterByFontSupport,
  resolveLocalEmojiData,
} from "../src/workspace-grouped-tasks/frimousse-local-data.js";
import type { EmojiData } from "frimousse";

type EmojiDataEmoji = EmojiData["emojis"][number];

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

function rawEmoji(entry: Partial<Parameters<typeof buildEmojiData>[1][number]> & { emoji: string }) {
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

function emoji(version: number, countryFlag?: true): EmojiDataEmoji {
  return { emoji: "🚀", category: 0, label: "x", version, tags: [], countryFlag };
}

test("filterByFontSupport：版本过滤与国旗门控", () => {
  const emojis = [emoji(0.6), emoji(2), emoji(15), emoji(0.6, true)];
  const full = filterByFontSupport(emojis, { emojiVersion: 2, countryFlags: true });
  assert.deepEqual(
    full.map((entry) => entry.version),
    [0.6, 2, 0.6],
  );
  // 国旗渲染不支持：即便版本达标也剔除。
  const noFlags = filterByFontSupport(emojis, { emojiVersion: 2, countryFlags: false });
  assert.deepEqual(
    noFlags.map((entry) => entry.version),
    [0.6, 2],
  );
  // 显式 emojiVersion（Root prop）优先于探测值。
  const pinned = filterByFontSupport(emojis, { emojiVersion: 2, countryFlags: true }, 0.6);
  assert.deepEqual(
    pinned.map((entry) => entry.version),
    [0.6, 0.6],
  );
});

test("resolveLocalEmojiData：本地数据可用、离线环境（无 DOM）隐藏国旗", async () => {
  const zh = await resolveLocalEmojiData("zh", {});
  assert.equal(zh.locale, "zh");
  assert.ok(zh.categories.length > 5, "分类完整");
  assert.ok(zh.emojis.length > 1000, "全量列表");
  assert.ok(zh.emojis.every((entry) => entry.countryFlag !== true), "node 测试环境无 canvas，国旗按不可渲染处理");
  assert.ok(zh.skinTones.light.length > 0);

  const en = await resolveLocalEmojiData("en-gb", {});
  assert.equal(en.locale, "en", "未打包的 locale 回落 en");
});

test("resolveLocalEmojiData：数据集按 locale 缓存（重复打开不重复转换）", async () => {
  const first = await resolveLocalEmojiData("zh", {});
  const second = await resolveLocalEmojiData("zh", {});
  assert.equal(second.emojis.length, first.emojis.length);
  assert.equal(second.categories.length, first.categories.length);
});

test("resolveLocalEmojiData：预中止信号直接抛出", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => resolveLocalEmojiData("en", { signal: controller.signal }));
});
