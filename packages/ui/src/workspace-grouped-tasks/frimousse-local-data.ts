import type { EmojiData, EmojiDataResolver } from "frimousse";

// frimousse 未导出条目类型，从 EmojiData 派生。
type EmojiDataEmoji = EmojiData["emojis"][number];

// frimousse 默认解析器从 emojibase CDN（cdn.jsdelivr.net）拉 locale 数据：首次打开
// 需要网络，CDN 不可达时只 console.error、UI 停留在「加载中」，国内网络环境下
// 等于功能不可用（用户明确否决网络依赖）。本模块改为本地注入：依赖 emojibase-data
// 数据包（与 CDN 同源同构），按 locale dynamic import 包装模块，零网络请求。
// 转换与过滤口径移植自 frimousse 默认解析器（v0.4 dist），保持行为一致。

/** emojibase data.json 单条目（按解析器消费口径裁剪的最小结构）。 */
interface RawEmoji {
  emoji: string;
  label: string;
  version: number;
  group?: number;
  subgroup?: number;
  tags?: string[];
  skins?: RawSkin[];
}

interface RawSkin {
  emoji: string;
  /** 数字＝单肤色变体，数组＝多肤色（握手等）变体；无 tone 的是性别变体。 */
  tone?: number | number[];
}

/** emojibase messages.json（按解析器消费口径裁剪）。 */
interface RawMessages {
  groups: { key: string; message: string; order: number }[];
  subgroups: { key: string; message: string; order: number }[];
  skinTones: { key: string; message: string }[];
}

/** 面板语言只映射出 zh / en 两个 frimousse locale，其余一律回落 en。 */
type LocalLocale = "zh" | "en";

const TONE_KEYS = ["light", "medium-light", "medium", "medium-dark", "dark"] as const;

function normalizeLocale(locale: string): LocalLocale {
  return locale === "zh" ? "zh" : "en";
}

function capitalize(text: string): string {
  // 按码点取首字，避免 label 以 emoji 类字符开头时切开代理对。
  const [first = "", ...rest] = Array.from(text);
  return first.toUpperCase() + rest.join("");
}

// frimousse 声明的 skins Record 要求五键齐全，实际数据存在只有子集变体的条目
// （其运行时也是 reduce 逐步构建），这里按 Partial 构建、赋值处单点断言。
type SkinToneKey = Exclude<keyof EmojiData["skinTones"], never>;
type EmojiSkins = Partial<Record<SkinToneKey, string>>;

function skinsToRecord(skins?: RawSkin[]): EmojiSkins | undefined {
  return skins
    ?.filter((skin): skin is RawSkin & { tone: number } => typeof skin.tone === "number")
    .reduce<EmojiSkins>((acc, skin) => {
      const key = TONE_KEYS[skin.tone - 1];
      if (key) {
        acc[key] = skin.emoji;
      }
      return acc;
    }, {});
}

function aliasesFromSkins(skins?: RawSkin[]): string[] | undefined {
  const aliases = skins?.filter((skin) => Array.isArray(skin.tone)).map((skin) => skin.emoji);
  return aliases?.length ? aliases : undefined;
}

/**
 * emojibase 原始结构 → frimousse EmojiData（对应 frimousse 默认解析器的 fetch 转换）：
 * 分类剔除 component、标签首字母大写、标记国旗条目、肤色映射为 frimousse 键。
 */
export function buildEmojiData(
  locale: LocalLocale,
  rawEmojis: RawEmoji[],
  rawMessages: RawMessages,
): EmojiData {
  const flagSubgroup = rawMessages.subgroups.find(
    (subgroup) => subgroup.key === "country-flag" || subgroup.key === "subdivision-flag",
  );
  const categories = rawMessages.groups
    .filter((group) => group.key !== "component")
    .map((group) => ({ index: group.order, label: capitalize(group.message) }));
  const skinTones = Object.fromEntries(
    rawMessages.skinTones.map((tone) => [tone.key, capitalize(tone.message)]),
  ) as EmojiData["skinTones"];
  // 无 group 的条目是 component（肤色/ZWJ 部件），不进选择列表。
  const emojis: EmojiDataEmoji[] = rawEmojis
    .filter((entry): entry is RawEmoji & { group: number } => typeof entry.group === "number")
    .map((entry) => ({
      emoji: entry.emoji,
      category: entry.group,
      version: entry.version,
      label: capitalize(entry.label),
      tags: entry.tags ?? [],
      countryFlag: flagSubgroup && entry.subgroup === flagSubgroup.order ? true : undefined,
      skins: skinsToRecord(entry.skins) as EmojiDataEmoji["skins"],
      aliases: aliasesFromSkins(entry.skins),
    }));
  return { locale, emojis, categories, skinTones };
}

async function loadRawDataset(
  locale: LocalLocale,
): Promise<{ emojis: RawEmoji[]; messages: RawMessages }> {
  // wrapper 模块顶层静态 import JSON：Vite 8（Rolldown）会保留带 attributes 的
  // 动态 JSON import 裸说明符，浏览器运行时解析失败。这里只动态 import TS 模块，
  // 由构建器把每个 locale 的 JSON 内联成可被引用的独立 chunk，保持按语言拆包。
  const loaders: Record<LocalLocale, () => Promise<{ data: unknown; messages: unknown }>> = {
    zh: () => import("./emojibase-data-zh.js"),
    en: () => import("./emojibase-data-en.js"),
  };
  const { data, messages } = await loaders[locale]();
  return { emojis: data as RawEmoji[], messages: messages as RawMessages };
}

const datasetByLocale = new Map<LocalLocale, Promise<EmojiData>>();

function getDataset(locale: LocalLocale): Promise<EmojiData> {
  let dataset = datasetByLocale.get(locale);
  if (!dataset) {
    dataset = loadRawDataset(locale).then(({ emojis, messages }) =>
      buildEmojiData(locale, emojis, messages),
    );
    datasetByLocale.set(locale, dataset);
    // 本地子包导入失败（构建产物损坏一类）不缓存 rejection，下次打开重试，
    // 避免一次异常把该语言永久钉死在「加载中」。
    dataset.catch(() => datasetByLocale.delete(locale));
  }
  return dataset;
}

/**
 * frimousse 的本地数据解析器（resolveEmojiData 注入）。
 * 数据来自打包内的 emojibase-data，不访问 CDN、无 localStorage 缓存；
 * 数据集按 locale 内存缓存，重复打开对话框不重复导入。不做 canvas/系统字体
 * 探测，也不按图片是否存在裁剪目录——完整度由构建期资源锁保证。
 */
export const resolveLocalEmojiData: EmojiDataResolver = (locale, options) => {
  options.signal?.throwIfAborted();
  return getDataset(normalizeLocale(locale));
};
