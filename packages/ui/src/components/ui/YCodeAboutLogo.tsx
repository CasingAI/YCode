import { cn } from "@/components/lib/utils.js";
import ycodeLogoUrl from "@/assets/ycode-logo.png";

// YCode 品牌 logo：吐舌笑脸，与官网 icon 同款。欢迎屏与引导页共用。
export function YCodeAboutLogo({ className }: { className?: string }) {
  return (
    <img
      src={ycodeLogoUrl}
      alt="YCode"
      className={cn("shrink-0 select-none", className)}
      draggable={false}
    />
  );
}
