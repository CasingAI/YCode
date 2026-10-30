import { useState } from "react";
import { Smile } from "lucide-react";

import { emojiAssetUrl } from "@/assets/noto-emoji/index.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 任务组 emoji 的唯一可见渲染器：字符 → 本地 Noto PNG key → 固定尺寸图片。
 *
 * 不使用系统 emoji 字体，也不把字符作为文本输出；未知字符或图片加载失败时
 * 统一显示同尺寸的中性本地图标。图片失败态由 key={url} 的内层组件承载：
 * emoji 或 URL 变化会重新挂载，避免切换后沿用上一个字符的失败态。
 */
export function EmojiGlyph({
  emoji,
  size,
  className,
}: {
  emoji: string;
  size: number;
  className?: string;
}) {
  const url = emojiAssetUrl(emoji);
  if (!url) {
    return <EmojiGlyphFallback size={size} className={className} />;
  }
  return <EmojiGlyphImage key={url} url={url} size={size} className={className} />;
}

function EmojiGlyphImage({
  url,
  size,
  className,
}: {
  url: string;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <EmojiGlyphFallback size={size} className={className} />;
  }
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      loading="lazy"
      decoding="async"
      className={cn("block shrink-0 select-none", className)}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}

function EmojiGlyphFallback({ size, className }: { size: number; className?: string }) {
  return (
    <Smile
      aria-hidden="true"
      className={cn("shrink-0 text-foreground-subtle", className)}
      style={{ width: size, height: size }}
    />
  );
}
