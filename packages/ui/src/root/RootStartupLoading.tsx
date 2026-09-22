import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { resolveStartupBrandPresentation } from "@/root/startupBrandPresentation.js";
import { STARTUP_BRAND_FACE_FRAME_MS } from "@/root/startupBrandTiming.js";
import "@/root/startupBrandSequence.css";

// 阶段 2 的收尾形态：App 图标位图本身。与 UpdateStatusDialog 用同一个资源。
const zcodeAppIconUrl = new URL("../../../../public/icon_512@2x.png", import.meta.url).href;

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
  /**
   * `emojiSequence` 用两阶段品牌动画（裸字形轮播 → App 图标弹出）；
   * `staticFace` 只显示静态字形，用于可能长时间停留或停在失败态的启动屏。
   */
  brand?: "emojiSequence" | "staticFace";
  /** 仅 `emojiSequence` 有效：加载已就绪，进入阶段 2。 */
  brandSettled?: boolean;
}

export function RootStartupLoading({
  label,
  children,
  busy = true,
  brand = "emojiSequence",
  brandSettled = false,
}: RootStartupLoadingProps) {
  const presentation = resolveStartupBrandPresentation(brand, brandSettled);
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <div
        className="startup-brand"
        data-cycling={presentation.cycling ? "true" : "false"}
        data-badge={presentation.badgeVisible ? "true" : "false"}
      >
        <div className="startup-brand__stage">
          {presentation.faces.map((face, index) => (
            <span
              key={`${face}-${index}`}
              aria-hidden="true"
              className="startup-brand__face"
              // 正延迟错开相位：四帧共用同一条时间轴，第 i 帧在 i*225ms 后进入自己的循环。
              // 用负延迟会把可见顺序倒过来（第 3 帧先于第 2 帧出现），帧序与声明不符。
              style={
                {
                  "--startup-brand-phase": `${index * STARTUP_BRAND_FACE_FRAME_MS}ms`,
                } as CSSProperties
              }
            >
              {face}
            </span>
          ))}
          {/* 阶段 2 才可见，阶段 1 与静态态由 CSS 保持透明：图标自带黑色圆角底，
              混在轮播里会被读成「表情外面围了一圈粗边框」。 */}
          <img
            src={zcodeAppIconUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="startup-brand__badge"
          />
        </div>
      </div>
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function ZCodeStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return (
    <div className="relative flex size-24 items-center justify-center rounded-3xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-xl/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-[rgba(255,255,255,0.1)] before:content-['']">
      <ZCodeStartupLogo className="h-auto w-14" animated={animated} />
    </div>
  );
}

function ZCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="118"
      height="100"
      fill="none"
      viewBox="0 0 256 218"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      {animated ? (
        <animate
          attributeName="opacity"
          begin="3s"
          dur="1.8s"
          repeatCount="indefinite"
          values="1;0.4;1"
        />
      ) : null}
      <path
        fill="currentColor"
        d="M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z"
      />
      <path fill="currentColor" d="M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z" />
      <path
        fill="currentColor"
        d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z"
      />
    </svg>
  );
}
