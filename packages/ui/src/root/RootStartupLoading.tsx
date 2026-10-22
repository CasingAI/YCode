import type { CSSProperties, ReactNode } from "react";
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
