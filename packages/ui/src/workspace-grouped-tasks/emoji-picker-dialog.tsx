import { lazy, Suspense } from "react";

import { normalizeTaskGroupEmojiForWrite } from "@zcode/services";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// frimousse（含数据加载逻辑）动态 import，不进首屏包；首次打开对话框才加载。
const EmojiPickerPanel = lazy(() =>
  import("@/workspace-grouped-tasks/emoji-picker-panel.js").then((module) => ({
    default: module.EmojiPickerPanel,
  })),
);

/**
 * 分组 emoji 选择对话框：Instant APP 同款——弹出对话框，从全量表情面板
 * （搜索＋分类＋预览）里选一个。选中即回调并关闭；写入前仍走
 * normalizeTaskGroupEmojiForWrite 单 grapheme 归一化（脏值防线，正常选中的
 * 单个 emoji 不受影响）。
 */
export function EmojiPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (emoji: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "taskGroup.emojiPicker.title" })}</DialogTitle>
        </DialogHeader>
        {open ? (
          <Suspense
            fallback={
              <div className="flex h-72 items-center justify-center text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "taskGroup.emojiPicker.loading" })}
              </div>
            }
          >
            <EmojiPickerPanel
              onSelect={(emoji) => {
                const normalized = normalizeTaskGroupEmojiForWrite(emoji);
                if (normalized) {
                  onSelect(normalized);
                }
                onOpenChange(false);
              }}
            />
          </Suspense>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
