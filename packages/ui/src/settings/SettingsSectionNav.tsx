import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Rocket, type LucideIcon } from "lucide-react";
import { TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

export interface SettingsSectionNavItem {
  readonly id: SettingsSectionId;
  readonly icon: LucideIcon;
  readonly titleId: string;
}

export interface SettingsSectionNavGroup {
  readonly id: string;
  readonly titleId: string;
  readonly sections: readonly SettingsSectionNavItem[];
}

export function SettingsSectionNav({
  groups,
  activeSection,
  onSelectSection,
  onOpenOnboarding,
}: {
  groups: readonly SettingsSectionNavGroup[];
  activeSection: SettingsSectionId;
  onSelectSection: (id: SettingsSectionId) => void;
  onOpenOnboarding: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <nav
      aria-label={intl.formatMessage({ id: "settings.navLabel" })}
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3"
    >
      <div className="space-y-4">
        {groups.map((group) => {
          const groupLabel = intl.formatMessage({ id: group.titleId });
          const groupLabelId = `settings-sidebar-group-${group.id}`;

          return (
            <div key={group.id} role="group" aria-labelledby={groupLabelId} className="space-y-1">
              <div id={groupLabelId} className="px-2.5 pb-1 text-ui-sm font-medium text-foreground-subtlest">
                {groupLabel}
              </div>
              {group.sections.map(({ id, icon: Icon, titleId }) => {
                const isActive = activeSection === id;
                const label = intl.formatMessage({ id: titleId });

                return (
                  <SettingsSidebarButton
                    key={id}
                    icon={Icon}
                    label={label}
                    active={isActive}
                    aria-current={isActive ? "page" : undefined}
                    data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                    onClick={() => {
                      onSelectSection(id);
                    }}
                  >
                    <span className="truncate text-ui-base text-foreground">{label}</span>
                  </SettingsSidebarButton>
                );
              })}
            </div>
          );
        })}
      </div>

      <SettingsSidebarButton
        icon={Rocket}
        label={intl.formatMessage({ id: "settings.onboarding" })}
        className="mt-4 border border-dashed border-border hover:border-border-hover"
        onClick={onOpenOnboarding}
      >
        <span className="text-ui-base text-foreground">
          {intl.formatMessage({ id: "settings.onboarding" })}
        </span>
      </SettingsSidebarButton>
    </nav>
  );
}

function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
          active
            ? "bg-surface-hover text-foreground"
            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1">{children}</span>
      </button>
    </ControlHintTooltip>
  );
}
