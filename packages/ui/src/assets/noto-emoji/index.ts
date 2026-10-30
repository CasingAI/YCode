/**
 * Noto emoji 本地资源 URL API（纯 TS，不依赖 React）。
 *
 * 资源由构建插件输出为 `noto-emoji/<key>.png`；这里只根据已生成的 key 索引
 * 返回 URL，未知字符返回 null，绝不按调用方输入拼任意路径。调用方（EmojiGlyph）
 * 对 null 或图片加载失败统一显示本地中性图标。
 */
import { emojiAssetKey } from "./key.js";
import { NOTO_EMOJI_ASSET_COUNT, NOTO_EMOJI_ASSET_KEYS } from "./keys.js";

export { emojiAssetKey, NOTO_EMOJI_ASSET_COUNT, NOTO_EMOJI_ASSET_KEYS };

const ASSET_KEYS: ReadonlySet<string> = new Set(NOTO_EMOJI_ASSET_KEYS);
// Desktop 使用 base="./"，Web 可能部署在子路径；空 BASE_URL 回退到相对路径。
const BASE_URL =
  typeof import.meta.env?.BASE_URL === "string" && import.meta.env.BASE_URL.length > 0
    ? import.meta.env.BASE_URL
    : "./";
const ASSET_BASE_URL = `${BASE_URL.replace(/\/?$/, "/")}noto-emoji/`;

/** 字符是否有对应的打包图片；不存在时调用方走中性图标兜底。 */
export function hasEmojiAsset(value: string): boolean {
  const key = emojiAssetKey(value);
  return key !== null && ASSET_KEYS.has(key);
}

/** 已知 key 返回本地静态资源 URL；未知字符返回 null。 */
export function emojiAssetUrl(value: string): string | null {
  const key = emojiAssetKey(value);
  return key !== null && ASSET_KEYS.has(key) ? `${ASSET_BASE_URL}${key}.png` : null;
}
