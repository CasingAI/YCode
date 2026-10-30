import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { emojiAssetUrl, hasEmojiAsset } from "../../../src/assets/noto-emoji/index.js";
import { ZCodeIntlProvider } from "../../../src/i18n/IntlProvider.js";
import { maybeStartAutorun } from "./autorun.js";
import { TaskGroupColorMark } from "../../../src/workspace-grouped-tasks/colors.js";
import { EmojiPickerDialog } from "../../../src/workspace-grouped-tasks/emoji-picker-dialog.js";
import { TaskGroupTag } from "../../../src/workspace-grouped-tasks/task-group-tag.js";
import "./fixture.css";

// 与生产入口 emoji-picker-dialog.tsx 相同：EmojiPickerDialog 内部经 lazy 边界
// 加载面板，emojibase locale 数据仍走运行时动态导入，覆盖生产构建的按需分包。
// 本夹具不复制 Dialog 外壳，直接渲染真实 EmojiPickerDialog，因此 320px 外壳、
// p-4 + border 的真实内容盒与横向溢出都能被验证。

// 内嵌浏览器面板离屏渲染时不产生动画帧（实测 2 秒内 rAF 回调 0 次），而 frimousse
// 依赖 rAF 提交可视区测量结果，会一直停在「加载中」。这里仅在测试夹具用定时器
// 模拟 60fps 帧循环，生产代码和真实可见窗口不受影响。
if (typeof window !== "undefined") {
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((handle: number) =>
    window.clearTimeout(handle)) as typeof window.cancelAnimationFrame;
}

/** 本地资源中没有对应 PNG 的字符；真实 EmojiGlyph 应显示中性本地图标。 */
const UNKNOWN_EMOJI = "\u{10FFFD}";
const KNOWN_EMOJI = "\u{1F680}";

interface E2ERequest {
  kind: string;
  url: string;
  initiatorType?: string;
}

declare global {
  interface Window {
    __e2eRequests?: E2ERequest[];
    __e2eConsoleErrors?: string[];
  }
}

function DialogHarness({
  id,
  title,
  locale,
}: {
  id: string;
  title: string;
  locale: "zh-CN" | "en-US";
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectionCount, setSelectionCount] = useState(0);

  const group = selected
    ? {
        id: `${id}-group`,
        title: locale === "zh-CN" ? "本地资源验证组" : "Local asset group",
        color: "blue" as const,
        emoji: selected,
      }
    : null;
  const unknownGroup = {
    id: `${id}-unknown-group`,
    title: locale === "zh-CN" ? "未知字符" : "Unknown glyph",
    color: "gray" as const,
    emoji: UNKNOWN_EMOJI,
  };
  const knownAssetUrl = emojiAssetUrl(KNOWN_EMOJI);
  const knownAssetAvailable = hasEmojiAsset(KNOWN_EMOJI);
  const unknownAssetAvailable = hasEmojiAsset(UNKNOWN_EMOJI);

  return (
    <ZCodeIntlProvider initialLocale={locale}>
      <section
        data-testid={`${id}-section`}
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background p-3"
      >
        <h2 className="text-ui-base font-semibold text-foreground">{title}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`${id}-toggle`}
            className="rounded-md border border-border px-2 py-1 text-ui-sm text-foreground hover:bg-hover"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "关闭表情面板" : "打开表情面板"}
          </button>
          <span className="text-ui-xs text-foreground-subtle">selected:</span>
          <output data-testid={`${id}-selected`} className="text-ui-base">
            {selected ?? ""}
          </output>
          <span className="text-ui-xs text-foreground-subtle">count:</span>
          <span data-testid={`${id}-count`} className="text-ui-base">
            {selectionCount}
          </span>
        </div>

        {/* 选中后展示真实 TaskGroupTag（完整 pill + 紧凑圆）与 TaskGroupColorMark，
            三处都应由 EmojiGlyph 渲染本地 PNG。 */}
        <div
          data-testid={`${id}-tag-slot`}
          data-selected={selected ?? ""}
          className="flex min-h-6 min-w-0 items-center gap-2"
        >
          {group ? (
            <>
              <TaskGroupTag group={group} />
              <TaskGroupTag group={group} compact />
              <TaskGroupColorMark color={group.color} emoji={group.emoji} />
            </>
          ) : null}
        </div>

        {/* 固定渲染未知字符：EmojiGlyph 必须回落到中性本地图标，不得输出原字符。 */}
        <div
          data-testid={`${id}-fallback-slot`}
          data-unknown-char={UNKNOWN_EMOJI}
          className="flex min-h-6 min-w-0 items-center gap-2"
        >
          <TaskGroupTag group={unknownGroup} compact />
          <TaskGroupColorMark color={unknownGroup.color} emoji={unknownGroup.emoji} />
        </div>

        {/* 直接验证 URL 清单与 BASE_URL：不依赖组件内部实现。 */}
        <div className="flex min-w-0 items-center gap-2">
          <img
            data-testid={`${id}-asset-known`}
            src={knownAssetUrl ?? ""}
            alt=""
            aria-hidden="true"
            className="size-4"
          />
          <output data-testid={`${id}-asset-flags`} className="hidden">
            {JSON.stringify({ knownAssetUrl, knownAssetAvailable, unknownAssetAvailable })}
          </output>
        </div>

        <EmojiPickerDialog
          open={open}
          onOpenChange={setOpen}
          onSelect={(emoji) => {
            setSelected(emoji);
            setSelectionCount((count) => count + 1);
          }}
        />
      </section>
    </ZCodeIntlProvider>
  );
}

function App() {
  return (
    <main className="flex min-h-screen min-w-0 flex-col gap-4 p-6">
      <h1 className="text-ui-lg font-semibold">EmojiPickerDialog E2E fixture</h1>
      <div className="flex min-w-0 flex-wrap items-start gap-6">
        <DialogHarness id="zh" title="中文 IntlProvider" locale="zh-CN" />
        <DialogHarness id="en" title="English IntlProvider" locale="en-US" />
      </div>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("missing #root");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// ?autorun=1 时由页面自己驱动真实交互并输出 PASS/FAIL；正常打开不受影响。
maybeStartAutorun();
