import type { EmojiData, EmojiDataResolver } from "frimousse";

// frimousse 未导出条目类型，从 EmojiData 派生。
type EmojiDataEmoji = EmojiData["emojis"][number];

// frimousse 默认解析器从 emojibase CDN（cdn.jsdelivr.net）拉 locale 数据：首次打开
// 需要网络，CDN 不可达时只 console.error、UI 停留在「加载中」，国内网络环境下
// 等于功能不可用（用户明确否决网络依赖）。本模块改为本地注入：依赖 emojibase-data
// 数据包（与 CDN 同源同构），按 locale dynamic import 拆子包，零网络请求。
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

/** 系统 emoji 字体支持度（探测结果，与 frimousse 默认解析器同口径）。 */
export interface EmojiFontSupport {
  /** 系统能彩色渲染的最高 emoji 版本，超出会渲染成豆腐块/黑白字形。 */
  emojiVersion: number;
  /** 国旗对（区域指示符）能否彩色渲染——旧字形字体经常不支持。 */
  countryFlags: boolean;
}

const EMOJI_FONT_STACK =
  "'Apple Color Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', 'Android Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', EmojiSymbols, sans-serif";

/**
 * 2×2 canvas 上分别用蓝/红填充绘制 emoji：彩色 emoji 字体会忽略 fillStyle 两次输出
 * 相同彩色像素，黑白/豆腐字形则跟随 fillStyle——像素不同即支持彩色渲染。
 */
function rendersInColor(emoji: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  } catch {
    return false;
  }
  if (!context) {
    return false;
  }
  const size = 2;
  context.canvas.width = size;
  context.canvas.height = size;
  context.font = `2px ${EMOJI_FONT_STACK}`;
  context.textBaseline = "middle";
  if (context.measureText(emoji).width >= size * 2) {
    return false;
  }
  context.fillStyle = "#00f";
  context.fillText(emoji, 0, 0);
  const blue = context.getImageData(0, 0, size, size).data;
  context.clearRect(0, 0, size, size);
  context.fillStyle = "#f00";
  context.fillText(emoji, 0, 0);
  const red = context.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size * 4; i += 4) {
    if (blue[i] !== red[i] || blue[i + 1] !== red[i + 1] || blue[i + 2] !== red[i + 2]) {
      return true;
    }
  }
  return false;
}

function detectEmojiFontSupport(emojis: EmojiDataEmoji[]): EmojiFontSupport {
  const sampleByVersion = new Map<number, string>();
  for (const entry of emojis) {
    if (!sampleByVersion.has(entry.version)) {
      sampleByVersion.set(entry.version, entry.emoji);
    }
  }
  const versions = [...sampleByVersion.keys()].sort((a, b) => b - a);
  const countryFlags = rendersInColor("🇪🇺");
  for (const version of versions) {
    if (rendersInColor(sampleByVersion.get(version) as string)) {
      return { emojiVersion: version, countryFlags };
    }
  }
  return { emojiVersion: versions[0] ?? 0, countryFlags };
}

/**
 * 按字体支持度过滤：超出可渲染版本的条目去掉；国旗额外受旗帜渲染探测约束。
 * emojiVersion 显式传入时以其为准（Root 的 emojiVersion prop 语义）。
 */
export function filterByFontSupport(
  emojis: EmojiDataEmoji[],
  support: EmojiFontSupport,
  emojiVersion?: number,
): EmojiDataEmoji[] {
  const maxVersion = emojiVersion ?? support.emojiVersion;
  return emojis.filter((entry) => {
    const withinVersion = entry.version <= maxVersion;
    return entry.countryFlag ? withinVersion && support.countryFlags : withinVersion;
  });
}

async function loadRawDataset(locale: LocalLocale): Promise<{ emojis: RawEmoji[]; messages: RawMessages }> {
  // 带 import attributes 的 JSON 动态导入：Node ≥22 与 Vite 均原生支持。
  // specifier 必须是静态字符串（Vite 才能按 locale 拆独立子包，未使用的语言不加载）。
  const loaders: Record<LocalLocale, () => Promise<{ emojis: RawEmoji[]; messages: RawMessages }>> = {
    zh: async () => {
      const [data, messages] = await Promise.all([
        import("emojibase-data/zh/data.json", { with: { type: "json" } }),
        import("emojibase-data/zh/messages.json", { with: { type: "json" } }),
      ]);
      return { emojis: data.default as RawEmoji[], messages: messages.default as RawMessages };
    },
    en: async () => {
      const [data, messages] = await Promise.all([
        import("emojibase-data/en/data.json", { with: { type: "json" } }),
        import("emojibase-data/en/messages.json", { with: { type: "json" } }),
      ]);
      return { emojis: data.default as RawEmoji[], messages: messages.default as RawMessages };
    },
  };
  return loaders[locale]();
}

interface LocalDataset {
  data: EmojiData;
  support: EmojiFontSupport;
}

const datasetByLocale = new Map<LocalLocale, Promise<LocalDataset>>();

function getDataset(locale: LocalLocale): Promise<LocalDataset> {
  let dataset = datasetByLocale.get(locale);
  if (!dataset) {
    dataset = loadRawDataset(locale).then(({ emojis, messages }) => {
      const data = buildEmojiData(locale, emojis, messages);
      return { data, support: detectEmojiFontSupport(data.emojis) };
    });
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
 * 数据集（转换＋支持度探测）按 locale 内存缓存，重复打开对话框不重复导入。
 */
export const resolveLocalEmojiData: EmojiDataResolver = (locale, options) => {
  options.signal?.throwIfAborted();
  const normalized = normalizeLocale(locale);
  return getDataset(normalized).then(({ data, support }) => ({
    ...data,
    emojis: filterByFontSupport(data.emojis, support, options.emojiVersion),
  }));
};
