import {
  ArrowUpDown,
  ChevronDown,
  Clock3,
  Folder,
  Hash,
  MessageCircleCheck,
  MessageCirclePlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SidebarTaskOrganizeBy, SidebarTaskSortBy } from "@/lib/sidebarTaskPreferences.js";

interface SidebarTaskMenuIntl {
  formatMessage: (descriptor: { id: string }) => string;
}

interface SidebarTaskMenuLabelProps {
  children?: ReactNode;
}

interface SidebarTaskMenuRadioGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  children?: ReactNode;
}

interface SidebarTaskMenuRadioItemProps {
  value: string;
  children?: ReactNode;
}

export interface SidebarTaskMenuPrimitives {
  Label: ComponentType<SidebarTaskMenuLabelProps>;
  RadioGroup: ComponentType<SidebarTaskMenuRadioGroupProps>;
  RadioItem: ComponentType<SidebarTaskMenuRadioItemProps>;
}

interface SidebarTaskViewOption {
  labelId: string;
  Icon: LucideIcon;
}

const TASK_VIEW_OPTIONS: Record<SidebarTaskOrganizeBy, SidebarTaskViewOption> = {
  grouped: {
    labelId: "workspaceSidebar.organizeGrouped",
    Icon: Hash,
  },
  project: {
    labelId: "workspaceSidebar.organizeByProject",
    Icon: Folder,
  },
  chronological: {
    labelId: "workspaceSidebar.organizeChronologicalList",
    Icon: Clock3,
  },
};

const TASK_VIEW_ORDER: SidebarTaskOrganizeBy[] = ["grouped", "project", "chronological"];

const TASK_SORT_OPTIONS: Record<SidebarTaskSortBy, SidebarTaskViewOption> = {
  updated: {
    labelId: "workspaceSidebar.sortByUpdated",
    Icon: MessageCircleCheck,
  },
  created: {
    labelId: "workspaceSidebar.sortByCreated",
    Icon: MessageCirclePlus,
  },
};

const TASK_SORT_ORDER: SidebarTaskSortBy[] = ["updated", "created"];

function isSidebarTaskOrganizeBy(value: string): value is SidebarTaskOrganizeBy {
  return value === "grouped" || value === "project" || value === "chronological";
}

function isSidebarTaskSortBy(value: string): value is SidebarTaskSortBy {
  return value === "created" || value === "updated";
}

export function WorkspaceSidebarTaskViewMenuContent({
  intl,
  value,
  onValueChange,
  Label,
  RadioGroup,
  RadioItem,
}: {
  intl: SidebarTaskMenuIntl;
  value: SidebarTaskOrganizeBy;
  onValueChange: (value: SidebarTaskOrganizeBy) => void;
} & SidebarTaskMenuPrimitives) {
  return (
    <>
      <Label>{intl.formatMessage({ id: "workspaceSidebar.organize" })}</Label>
      <RadioGroup
        value={value}
        onValueChange={(nextValue) => {
          if (isSidebarTaskOrganizeBy(nextValue)) {
            onValueChange(nextValue);
          }
        }}
      >
        {TASK_VIEW_ORDER.map((optionValue) => {
          const option = TASK_VIEW_OPTIONS[optionValue];
          return (
            <RadioItem key={optionValue} value={optionValue}>
              <option.Icon className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: option.labelId })}
            </RadioItem>
          );
        })}
      </RadioGroup>
    </>
  );
}

export function WorkspaceSidebarTaskSortMenuContent({
  intl,
  value,
  onValueChange,
  Label,
  RadioGroup,
  RadioItem,
}: {
  intl: SidebarTaskMenuIntl;
  value: SidebarTaskSortBy;
  onValueChange: (value: SidebarTaskSortBy) => void;
} & SidebarTaskMenuPrimitives) {
  return (
    <>
      <Label>{intl.formatMessage({ id: "workspaceSidebar.sortBy" })}</Label>
      <RadioGroup
        value={value}
        onValueChange={(nextValue) => {
          if (isSidebarTaskSortBy(nextValue)) {
            onValueChange(nextValue);
          }
        }}
      >
        {TASK_SORT_ORDER.map((optionValue) => {
          const option = TASK_SORT_OPTIONS[optionValue];
          return (
            <RadioItem key={optionValue} value={optionValue}>
              <option.Icon className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: option.labelId })}
            </RadioItem>
          );
        })}
      </RadioGroup>
    </>
  );
}

export function WorkspaceSidebarTaskViewMenu({
  value,
  onValueChange,
}: {
  value: SidebarTaskOrganizeBy;
  onValueChange: (value: SidebarTaskOrganizeBy) => void;
}) {
  const { intl } = useZCodeIntl();
  const currentOption = TASK_VIEW_OPTIONS[value];
  const CurrentIcon = currentOption.Icon;
  const accessibleName = intl.formatMessage({ id: "workspaceSidebar.organize" });

  return (
    <DropdownMenu>
      <ControlHintTooltip title={accessibleName}>
        <span className="inline-flex">
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-1.5 text-ui-sm font-medium text-foreground-subtle hover:text-foreground"
              aria-label={accessibleName}
            >
              <CurrentIcon className="size-3.5" aria-hidden="true" />
              <span>{intl.formatMessage({ id: currentOption.labelId })}</span>
              <ChevronDown className="size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </span>
      </ControlHintTooltip>
      <DropdownMenuContent align="start" className="w-48 min-w-48">
        <WorkspaceSidebarTaskViewMenuContent
          intl={intl}
          value={value}
          onValueChange={onValueChange}
          Label={DropdownMenuLabel}
          RadioGroup={DropdownMenuRadioGroup}
          RadioItem={DropdownMenuRadioItem}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceSidebarTaskSortMenu({
  value,
  onValueChange,
}: {
  value: SidebarTaskSortBy;
  onValueChange: (value: SidebarTaskSortBy) => void;
}) {
  const { intl } = useZCodeIntl();
  const accessibleName = intl.formatMessage({ id: "workspaceSidebar.sortBy" });

  return (
    <DropdownMenu>
      <ControlHintTooltip title={accessibleName}>
        <span className="inline-flex">
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              aria-label={accessibleName}
            >
              <ArrowUpDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </span>
      </ControlHintTooltip>
      <DropdownMenuContent align="end" className="w-48 min-w-48">
        <WorkspaceSidebarTaskSortMenuContent
          intl={intl}
          value={value}
          onValueChange={onValueChange}
          Label={DropdownMenuLabel}
          RadioGroup={DropdownMenuRadioGroup}
          RadioItem={DropdownMenuRadioItem}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
