import { EmojiPicker } from "frimousse";

import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * frimousse 全量 emoji 选择面板（Instant APP 同款方案）。
 *
 * frimousse 自身从 emojibase CDN 拉取 locale 数据并缓存 localStorage（与
 * instant-app/src/ui/emoji-picker-popover.tsx 行为一致），首次打开需网络，
 * 之后走本地缓存。静态 import frimousse，由 emoji-picker-dialog 的 lazy
 * 边界兜住，不进首屏包。
 */
export function EmojiPickerPanel({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { intl, locale } = useZCodeIntl();
  // frimousse 只区分 zh / en 两套文案，跟随应用语言映射。
  const frimousseLocale = locale === "zh-CN" ? "zh" : "en";

  return (
    <EmojiPicker.Root
      locale={frimousseLocale}
      skinTone="none"
      className="flex h-72 w-full flex-col"
      onEmojiSelect={(entry) => onSelect(entry.emoji)}
    >
      <EmojiPicker.Search
        className="mb-1.5 h-8 w-full shrink-0 rounded-md border border-border bg-transparent px-2 text-ui-sm text-foreground outline-none placeholder:text-foreground-subtlest focus-visible:ring-1 focus-visible:ring-input-border-focused"
        placeholder={intl.formatMessage({ id: "taskGroup.emojiPicker.search" })}
      />
      <EmojiPicker.Viewport className="min-h-0 flex-1">
        <EmojiPicker.Loading className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "taskGroup.emojiPicker.loading" })}
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "taskGroup.emojiPicker.empty" })}
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="px-0.5 pb-0.5"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="bg-popover px-1 py-1 text-ui-xs font-medium text-foreground-subtle"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="flex" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                type="button"
                className="flex flex-1 items-center justify-center rounded text-xl hover:bg-hover data-[active]:bg-hover"
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>
      <EmojiPicker.ActiveEmoji>
        {({ emoji }) => (
          <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-1 text-ui-xs text-foreground-subtle">
            {emoji ? (
              <>
                <span aria-hidden="true" className="text-lg">
                  {emoji.emoji}
                </span>
                <span className="truncate">{emoji.label}</span>
              </>
            ) : (
              <span>{intl.formatMessage({ id: "taskGroup.emojiPicker.previewPlaceholder" })}</span>
            )}
          </div>
        )}
      </EmojiPicker.ActiveEmoji>
    </EmojiPicker.Root>
  );
}
