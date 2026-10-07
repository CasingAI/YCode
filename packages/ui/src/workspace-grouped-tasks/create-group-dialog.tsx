import { useEffect, useRef, useState } from "react";

import type { ZCodeTaskGroupColor } from "@zcode/services";
import { SmilePlus, X } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFlatTaskGroupCreateDialogStore } from "@/store/flatTaskGroupCreateDialogStore.js";
import { TaskGroupColorDot } from "@/workspace-grouped-tasks/colors.js";
import { EmojiPickerDialog } from "@/workspace-grouped-tasks/emoji-picker-dialog.js";
import { TASK_GROUP_COLORS } from "@/workspace-grouped-tasks/types.js";
import { cn } from "@/components/lib/utils.js";

export interface CreateGroupDialogValue {
  title: string;
  color: ZCodeTaskGroupColor;
  emoji?: string;
}

/**
 * 确认值构造：名称留空回填 UI 侧 i18n 默认名（服务端 "New Group" 回落仅兜底），
 * emoji 缺省不下发字段。抽成纯函数便于单测覆盖默认名语义。
 */
export function buildCreateGroupValue(
  draft: { titleDraft: string; color: ZCodeTaskGroupColor; emoji?: string },
  fallbackTitle: string,
): CreateGroupDialogValue {
  return {
    title: draft.titleDraft.trim() || fallbackTitle,
    color: draft.color,
    ...(draft.emoji ? { emoji: draft.emoji } : {}),
  };
}

/**
 * 新建分组对话框：会话右键「新建分组并移入」与分组视图侧栏 # 按钮共用的唯一入口。
 * 一次填好名称／颜色／emoji；取消或关闭不产生任何 RPC（onConfirm 只在确认时触发）。
 * 名称留空时 UI 显式传 i18n 默认名，服务端 "New Group" 回落仅作兜底。
 */
export function CreateGroupDialog({
  open,
  onOpenChange,
  mode,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** createAndMove：右键菜单入口，确认按钮文案不同；两者创建行为一致。 */
  mode: "create" | "createAndMove";
  pending?: boolean;
  onConfirm: (value: CreateGroupDialogValue) => void;
}) {
  const { intl } = useZCodeIntl();
  const [titleDraft, setTitleDraft] = useState("");
  const [color, setColor] = useState<ZCodeTaskGroupColor>("gray");
  const [emoji, setEmoji] = useState<string | undefined>(undefined);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const compositionActiveRef = useRef(false);

  // 每次打开重置为默认值：对话框是「新建」入口，不保留上次草稿。
  useEffect(() => {
    if (open) {
      setTitleDraft("");
      setColor("gray");
      setEmoji(undefined);
      setEmojiPickerOpen(false);
    }
  }, [open]);

  const submit = () => {
    if (pending) {
      return;
    }
    onConfirm(
      buildCreateGroupValue(
        { titleDraft, color, emoji },
        intl.formatMessage({ id: "taskGroup.defaultTitle" }),
      ),
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && pending) {
            // 创建请求进行中不允许误关，避免「对话框没了、请求还在飞」的无反馈状态。
            return;
          }
          onOpenChange(nextOpen);
        }}
      >
        <DialogContent className="max-w-md overflow-hidden rounded-2xl p-0">
          <div className="flex min-w-0 flex-col gap-5 p-6">
            <DialogHeader className="space-y-2">
              <DialogTitle>
                {intl.formatMessage({ id: "taskGroup.createDialog.title" })}
              </DialogTitle>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-4">
              {/* emoji 方块＋名称共享一行：选择与清除统一在方块一个控件上——
                  无 emoji 虚线占位、点击打开选择器；有 emoji 显示 emoji，
                  右上角常显 × 角标清除（独立 button，button 不嵌套）。 */}
              <div className="flex min-w-0 items-center gap-2">
                <div className="relative shrink-0">
                  <button
                    type="button"
                    aria-label={intl.formatMessage({ id: "taskGroup.emoji" })}
                    title={intl.formatMessage({ id: "taskGroup.emoji" })}
                    className={cn(
                      "flex size-10 items-center justify-center rounded-lg border text-xl leading-none hover:bg-hover",
                      emoji ? "border-border" : "border-dashed border-border",
                    )}
                    onClick={() => setEmojiPickerOpen(true)}
                  >
                    {emoji ?? <SmilePlus className="size-5 text-foreground-subtlest" />}
                  </button>
                  {emoji ? (
                    <button
                      type="button"
                      aria-label={intl.formatMessage({ id: "taskGroup.clearEmoji" })}
                      title={intl.formatMessage({ id: "taskGroup.clearEmoji" })}
                      className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-foreground-subtlest text-background hover:bg-foreground-subtle"
                      onClick={() => setEmoji(undefined)}
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                </div>
                <Input
                  autoFocus
                  className="min-w-0 flex-1"
                  value={titleDraft}
                  size="lg"
                  placeholder={intl.formatMessage({ id: "taskGroup.createDialog.namePlaceholder" })}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onCompositionEnd={() => {
                    compositionActiveRef.current = false;
                  }}
                  onCompositionStart={() => {
                    compositionActiveRef.current = true;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      if (
                        isImeComposingKeyEvent({
                          compositionActive: compositionActiveRef.current,
                          nativeEvent: event.nativeEvent,
                        })
                      ) {
                        // 中文输入法 Enter 是候选确认，不是提交。
                        return;
                      }
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
              </div>
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="radiogroup"
                aria-label={intl.formatMessage({ id: "taskGroup.color" })}
              >
                {TASK_GROUP_COLORS.map((colorOption) => (
                  <button
                    key={colorOption}
                    type="button"
                    role="radio"
                    aria-checked={color === colorOption}
                    className={`flex size-7 items-center justify-center rounded-full ${
                      color === colorOption
                        ? "bg-hover ring-1 ring-input-border-focused"
                        : "hover:bg-hover"
                    }`}
                    onClick={() => setColor(colorOption)}
                  >
                    <TaskGroupColorDot color={colorOption} />
                  </button>
                ))}
              </div>
            </div>
            <DialogFooter className="flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-10 min-w-0 px-5"
                onClick={() => onOpenChange(false)}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                size="lg"
                className="h-10 min-w-0 px-5"
                disabled={pending}
                onClick={submit}
              >
                {intl.formatMessage({
                  id:
                    mode === "createAndMove"
                      ? "taskGroup.createDialog.createAndMove"
                      : "taskGroup.createDialog.create",
                })}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
      <EmojiPickerDialog
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onSelect={(nextEmoji) => setEmoji(nextEmoji)}
      />
    </>
  );
}

/**
 * 「新建分组并移入」的全局宿主（AlertDialogHost 同模式）：挂在 RootShell。
 * 菜单内容组件随菜单关闭即卸载，对话框不能挂在菜单内容里——否则点确认的
 * 瞬间菜单关闭、对话框还没渲染就被卸载（用户实测「完全没反应」的根因）。
 * 打开方经 flatTaskGroupCreateDialogStore 注册确认闭包，本 Host 消费。
 */
export function CreateGroupDialogHost() {
  const open = useFlatTaskGroupCreateDialogStore((state) => state.open);
  const pending = useFlatTaskGroupCreateDialogStore((state) => state.pending);
  const confirmHandler = useFlatTaskGroupCreateDialogStore((state) => state.confirmHandler);
  const closeCreateGroupDialog = useFlatTaskGroupCreateDialogStore(
    (state) => state.closeCreateGroupDialog,
  );

  return (
    <CreateGroupDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeCreateGroupDialog();
        }
      }}
      mode="createAndMove"
      pending={pending}
      onConfirm={(value) => confirmHandler?.(value)}
    />
  );
}
