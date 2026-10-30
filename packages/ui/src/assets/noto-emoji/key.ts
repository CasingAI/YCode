/**
 * 任务组 emoji 字符到本地 Noto PNG key 的唯一归一化规则。
 *
 * 规则见 `noto-emoji.lock.json` 与 docs/specs/task-group-emoji-and-row-tag.md：
 * - 每个 code point 使用小写十六进制并补足 4 位；
 * - 去掉 FE0F/FE0E 变体选择符；
 * - 保留 ZWJ（200D）、keycap（20E3）和 tag 字符；
 * - 多个 code point 用下划线连接，前缀 `emoji_u`，不含扩展名。
 *
 * 该模块不依赖 React、不访问文件系统，也不判断资源是否存在；
 * 资源成员判断由 `index.ts` 基于构建生成的 key 索引完成。
 */
export function emojiAssetKey(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const codepoints: string[] = [];
  for (const character of value) {
    const codepoint = character.codePointAt(0);
    if (codepoint === undefined || codepoint === 0xfe0f || codepoint === 0xfe0e) {
      continue;
    }
    codepoints.push(codepoint.toString(16).padStart(4, "0"));
  }
  return codepoints.length > 0 ? `emoji_u${codepoints.join("_")}` : null;
}
