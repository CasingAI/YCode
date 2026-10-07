import { useRef } from "react";
import type { ReactNode } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 设置页共享详情头：标题区 + 右侧 `...` 菜单（重命名 + 红色删除）。
 * 文案与回调全部由调用方传入，本组件不写死任何供应商/模型组 key。
 */
export function SettingsDetailHeaderMenu({
  title,
  titleTestId,
  leading,
  trailing,
  renameLabel,
  onRename,
  onDelete,
  deleteTestId,
  menuTestId,
  disabled,
}: {
  title: string;
  titleTestId?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  renameLabel: string;
  onRename: () => void;
  onDelete?: () => void;
  deleteTestId?: string;
  menuTestId?: string;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const renameRequestedRef = useRef(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {leading}
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold" data-testid={titleTestId}>
          {title}
        </h3>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {trailing}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid={menuTestId}
              disabled={disabled}
              aria-label={intl.formatMessage({ id: "common.more" })}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              // 重命名后的焦点交给输入框，不能被菜单关闭时重新抢回触发按钮。
              if (renameRequestedRef.current) {
                event.preventDefault();
                renameRequestedRef.current = false;
              }
            }}
          >
            <DropdownMenuItem
              onSelect={() => {
                renameRequestedRef.current = true;
                onRename();
              }}
            >
              <Pencil className="size-3.5" />
              {renameLabel}
            </DropdownMenuItem>
            {onDelete ? <DropdownMenuSeparator /> : null}
            {onDelete ? (
              <DropdownMenuItem
                variant="destructive"
                data-testid={deleteTestId}
                onSelect={onDelete}
              >
                <Trash2 className="size-3.5" />
                {intl.formatMessage({ id: "common.delete" })}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
