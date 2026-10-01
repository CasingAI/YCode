import { Terminal } from "lucide-react";
import type { ModelSelection, UserCommand, ZCodeCommand } from "@zcode/shared";
import { isBuiltinCommand, isPluginCommand, isUserCommand } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import {
  resolveOverrideModelLabel,
  toOverrideModelValue,
} from "@/settings/ModelOverrideControl.js";

export function isEditableUserCommand(command: ZCodeCommand): command is UserCommand {
  return isUserCommand(command) && command.location.source === "zcode";
}

export interface CommandCardBindingDisplayProps {
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionLoading: boolean;
  inheritLabel: string;
}

interface CommandCardProps {
  command: ZCodeCommand;
  onEdit?: (command: ZCodeCommand) => void;
  onToggle?: (command: ZCodeCommand, enabled: boolean) => void;
  isOperating?: boolean;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
  /** 只读绑定展示；可绑定的命令才传，不可绑定的行不展示该区域。 */
  bindingDisplay?: CommandCardBindingDisplayProps;
  binding?: ModelSelection;
}

export function CommandCard({
  command,
  onEdit,
  onToggle,
  isOperating,
  pluginIconItem,
  bindingDisplay,
  binding,
}: CommandCardProps) {
  const { intl } = useZCodeIntl();
  const canActivate =
    (isEditableUserCommand(command) || isBuiltinCommand(command)) &&
    Boolean(onEdit) &&
    !isOperating;
  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors ${canActivate ? "hover:bg-hover" : ""}`}
      {...settingsResourceRowInteraction(canActivate ? () => onEdit?.(command) : undefined)}
    >
      {isPluginCommand(command) && pluginIconItem ? (
        <PluginStoreAvatar
          item={pluginIconItem}
          className="size-9 bg-background"
          fallbackIcon={<Terminal className="size-4" />}
        />
      ) : (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
          aria-hidden="true"
        >
          <Terminal className="size-4" />
        </div>
      )}

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* 内置命令以斜杠前缀展示调用形态，与 / 面板的目录条目一致。 */}
          <span className="truncate text-ui-base font-medium text-foreground">
            {isBuiltinCommand(command) ? `/${command.name}` : command.name}
          </span>
          {!isBuiltinCommand(command) && command.argumentHint ? (
            <span className="text-ui-base text-foreground-subtlest">{command.argumentHint}</span>
          ) : null}
          {isBuiltinCommand(command) ? (
            <span className="text-ui-base text-foreground-subtlest">{command.inputHint}</span>
          ) : null}
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
          {command.description || intl.formatMessage({ id: "settings.commands.noDescription" })}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {/* 列表行只展示当前绑定；修改统一进详情页或编辑表单，避免两处可改互相覆盖。 */}
        {bindingDisplay ? (
          <span className="max-w-52 truncate text-ui-sm text-foreground-subtle">
            {resolveOverrideModelLabel({
              inheritLabel: bindingDisplay.inheritLabel,
              modelGroups: bindingDisplay.modelGroups,
              model: binding ? toOverrideModelValue(binding) : undefined,
            })}
          </span>
        ) : null}
        {isUserCommand(command) && onToggle ? (
          <Switch
            checked={command.enabled}
            onCheckedChange={(enabled) => onToggle(command, enabled)}
            disabled={isOperating}
          />
        ) : null}
      </div>
    </div>
  );
}
