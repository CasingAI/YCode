import { Fragment, useRef, useState } from "react";
import {
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  getMenuDisplayShortcutBindings,
  type DesktopMenuEditorState,
  type Locale,
  type ShortcutCommandId,
  type UiCommandId,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import {
  buildFilesWorkbenchMenuItems,
  type FilesWorkbenchMenuItem,
} from "@/files-workbench/filesWorkbenchMenuItems.js";

export interface FilesWorkbenchMenuBarProps {
  state: DesktopMenuEditorState;
  canEdit: boolean;
  canCreateFile: boolean;
  onCommand: (command: UiCommandId) => void;
  onCloseEditor: () => void;
  shortcutLabels: Partial<Record<ShortcutCommandId, string>>;
  isActiveView: boolean;
}

type ActiveMenuProps = Omit<FilesWorkbenchMenuBarProps, "isActiveView">;

function FilesWorkbenchMenuDropdown({
  label,
  locale,
  items,
  open,
  onOpenChange,
  onCommand,
  onCloseEditor,
  shortcutLabels,
}: Pick<ActiveMenuProps, "onCommand" | "onCloseEditor" | "shortcutLabels"> & {
  label: string;
  locale: Locale;
  items: FilesWorkbenchMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const commandSelectedRef = useRef(false);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) commandSelectedRef.current = false;
        onOpenChange(nextOpen);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-7 rounded-md px-2 text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground data-[state=open]:bg-surface-hover data-[state=open]:text-foreground"
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        onCloseAutoFocus={(event) => {
          // 查找、新建或保存对话框已接管焦点；Radix 回焦会把用户重新拉回菜单按钮。
          // Esc 等未执行命令的关闭仍保留默认回焦，支持连续键盘操作。
          if (commandSelectedRef.current) event.preventDefault();
          commandSelectedRef.current = false;
        }}
      >
        {items.map((item) => {
          const shortcutLabel = item.shortcutId
            ? shortcutLabels[item.shortcutId]
            : item.command
              ? getMenuDisplayShortcutBindings(item.command)
                  .map((binding) => formatShortcutBindingLabel(binding))
                  .join(" / ")
              : undefined;
          return (
            <Fragment key={item.messageId}>
              {item.separatorBefore ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={item.disabled}
                onSelect={() => {
                  commandSelectedRef.current = true;
                  if (item.command) onCommand(item.command);
                  else onCloseEditor();
                }}
              >
                {getDesktopMenuMessage(locale, item.messageId)}
                {shortcutLabel ? (
                  <DropdownMenuShortcut>{shortcutLabel}</DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActiveFilesWorkbenchMenuBar(props: ActiveMenuProps) {
  const { locale } = useZCodeIntl();
  const [openMenu, setOpenMenu] = useState<"file" | "edit">();
  const menus = buildFilesWorkbenchMenuItems(props);
  return (
    <div
      role="toolbar"
      aria-label={`${getDesktopMenuMessage(locale, desktopMenuMessageIds.file)} / ${getDesktopMenuMessage(locale, desktopMenuMessageIds.edit)}`}
      data-files-workbench-menu=""
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1 [app-region:no-drag]"
    >
      {(["file", "edit"] as const).map((menu) => (
        <FilesWorkbenchMenuDropdown
          key={menu}
          label={getDesktopMenuMessage(locale, desktopMenuMessageIds[menu])}
          locale={locale}
          items={menus[menu]}
          open={openMenu === menu}
          onOpenChange={(open) =>
            setOpenMenu((current) => (open ? menu : current === menu ? undefined : current))
          }
          onCommand={props.onCommand}
          onCloseEditor={props.onCloseEditor}
          shortcutLabels={props.shortcutLabels}
        />
      ))}
    </div>
  );
}

export function FilesWorkbenchMenuBar({ isActiveView, ...props }: FilesWorkbenchMenuBarProps) {
  // 隐藏的工作台仍保活；卸载菜单子树才能立即移除独立于隐藏层的 portal，并重置展开态。
  return isActiveView ? <ActiveFilesWorkbenchMenuBar {...props} /> : null;
}
