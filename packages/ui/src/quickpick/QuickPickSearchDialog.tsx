import type { ReactNode, RefObject } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { Command, CommandDialog, CommandList } from "@/components/ui/command.js";
import {
  quickPickCommandClassName,
  quickPickTopDialogClassName,
  quickPickTopListClassName,
} from "@/quickpick/quickPickStyles.js";

/**
 * 顶部居中的搜索浮层外壳。
 *
 * 命令中心（⌘K / ⌘⇧P）与搜索中心（⌘P）共用这一层：浮层位置、宽度、最大高度、圆角、
 * 遮罩、搜索框、加载指示、列表容器与键盘交互全部一致，两个中心只在业务上彼此独立。
 *
 * 这里刻意不引入任何业务状态：查询由调用方持有，工具栏 / 页脚用插槽承载，
 * 避免命令中心的范围栏、AI 回答、搜索历史被塞进共享组件。
 */
export interface QuickPickSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 无障碍标题（视觉上隐藏）。 */
  title: string;
  /** 无障碍描述（视觉上隐藏）。 */
  description: string;
  placeholder: string;
  /** 受控查询。 */
  value: string;
  onValueChange: (value: string) => void;
  /** 搜索框右侧的加载指示。 */
  loading?: boolean;
  /** 搜索行下方的工具栏（命令中心的范围栏等）。 */
  toolbar?: ReactNode;
  /** 列表下方的页脚（命令中心的搜索历史等）。 */
  footer?: ReactNode;
  /** 列表内容。 */
  children: ReactNode;
  /** 搜索框引用：调用方需要重新聚焦 / 全选时使用。 */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** 浮层关闭时的焦点处理：取消走默认恢复，确认打开文件时阻止恢复以免覆盖编辑器焦点。 */
  onCloseAutoFocus?: (event: Event) => void;
}

export function QuickPickSearchDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  value,
  onValueChange,
  loading = false,
  toolbar,
  footer,
  children,
  inputRef,
  onCloseAutoFocus,
}: QuickPickSearchDialogProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      className={quickPickTopDialogClassName}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <Command shouldFilter={false} loop className={quickPickCommandClassName}>
        <div className="border-b border-border px-2 pt-2 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-full border border-input-border bg-input px-2.5 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
            <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            <CommandPrimitive.Input
              ref={inputRef}
              value={value}
              onValueChange={onValueChange}
              placeholder={placeholder}
              className="min-w-0 flex-1 bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
            />
            {loading ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin text-foreground-subtlest" />
            ) : null}
          </div>
          {toolbar ? (
            <div className="-mx-1 mt-1.5 flex items-center gap-1 px-1 pb-0.5">{toolbar}</div>
          ) : null}
        </div>
        <CommandList className={quickPickTopListClassName}>{children}</CommandList>
        {footer}
      </Command>
    </CommandDialog>
  );
}
