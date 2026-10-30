import { EmojiPicker } from "frimousse";

import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { EmojiGlyph } from "@/workspace-grouped-tasks/emoji-glyph.js";

import { resolveLocalEmojiData } from "./frimousse-local-data.js";

/**
 * frimousse 全量 emoji 选择面板（Instant APP 同款方案）。
 *
 * 表情数据本地注入（frimousse-local-data.ts，依赖 emojibase-data）：frimousse
 * 默认会从 emojibase CDN 拉 locale 数据，CDN 不可达时无限「加载中」，已否决；
 * 现在零网络请求，「加载中」只覆盖本地子包导入的一瞬。静态 import frimousse，
 * 由 emoji-picker-dialog 的 lazy 边界兜住，不进首屏包。
 */
export function EmojiPickerPanel({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { intl, locale } = useZCodeIntl();
  // frimousse 只区分 zh / en 两套文案，跟随应用语言映射。
  const frimousseLocale = locale === "zh-CN" ? "zh" : "en";

  return (
    <EmojiPicker.Root
      locale={frimousseLocale}
      resolveEmojiData={resolveLocalEmojiData}
      skinTone="none"
      className="flex h-72 w-full min-w-0 flex-col"
      onEmojiSelect={(entry) => onSelect(entry.emoji)}
    >
      <EmojiPicker.Search
        className="mb-1.5 h-8 w-full min-w-0 shrink-0 rounded-md border border-border bg-transparent px-2 text-ui-sm text-foreground outline-none placeholder:text-foreground-subtlest focus-visible:ring-1 focus-visible:ring-input-border-focused"
        placeholder={intl.formatMessage({ id: "taskGroup.emojiPicker.search" })}
      />
      <EmojiPicker.Viewport className="min-h-0 min-w-0 flex-1">
        <EmojiPicker.Loading className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "taskGroup.emojiPicker.loading" })}
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "taskGroup.emojiPicker.empty" })}
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="min-w-0 px-0.5 pb-0.5"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="min-w-0 bg-popover px-1 py-1 text-ui-xs font-medium text-foreground-subtle"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="flex min-w-0" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                type="button"
                className="flex h-8 min-w-0 flex-1 items-center justify-center rounded hover:bg-hover data-[active]:bg-hover"
                {...props}
              >
                <EmojiGlyph emoji={emoji.emoji} size={20} />
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>
      <EmojiPicker.ActiveEmoji>
        {({ emoji }) => (
          <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 border-t border-border px-1 text-ui-xs text-foreground-subtle">
            {emoji ? (
              <>
                <EmojiGlyph emoji={emoji.emoji} size={18} className="shrink-0" />
                <span className="min-w-0 truncate">{emoji.label}</span>
              </>
            ) : (
              <span className="min-w-0 truncate">
                {intl.formatMessage({ id: "taskGroup.emojiPicker.previewPlaceholder" })}
              </span>
            )}
          </div>
        )}
      </EmojiPicker.ActiveEmoji>
    </EmojiPicker.Root>
  );
}
