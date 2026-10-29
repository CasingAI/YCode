import { useId, type FormEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  clampFilesLargeTextPercent,
  type FilesLargeTextNavigationTarget,
} from "@/files-workbench/filesLargeTextNavigation.js";

function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function parseIntegerInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePercentInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || !Number.isFinite(Number(trimmed))) return undefined;
  return clampFilesLargeTextPercent(Number(trimmed));
}

/**
 * 大文本固定块工具栏。输入框状态由 viewer 持有，这里只负责表单解析与导航事件；
 * 模式标签区分可编辑 / 脏 / 当前块只读。
 */
export function FilesLargeTextViewerToolbar({
  canNavigate,
  canGoPrevious,
  canGoNext,
  hasWindow,
  loading,
  percentInput,
  offsetInput,
  searchInput,
  searchLabel,
  editable,
  dirty,
  onPercentInputChange,
  onOffsetInputChange,
  onSearchInputChange,
  onNavigate,
  onRefresh,
  onSearch,
}: {
  canNavigate: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  hasWindow: boolean;
  loading: boolean;
  percentInput: string;
  offsetInput: string;
  searchInput: string;
  searchLabel: string | null;
  editable: boolean;
  dirty: boolean;
  onPercentInputChange: (value: string) => void;
  onOffsetInputChange: (value: string) => void;
  onSearchInputChange: (value: string) => void;
  onNavigate: (target: FilesLargeTextNavigationTarget) => void;
  onRefresh: () => void;
  onSearch: (direction: "next" | "previous") => void;
}) {
  const { intl } = useZCodeIntl();
  // 多分屏可同时挂载多个工具栏；固定 id 会产生重复的 label htmlFor 目标。
  const idPrefix = useId();
  const percentRangeId = `${idPrefix}-percent-range`;
  const percentId = `${idPrefix}-percent`;
  const offsetId = `${idPrefix}-offset`;

  const submitPercent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const percent = parsePercentInput(percentInput);
    if (percent === undefined) return;
    onNavigate({ kind: "percent", percent });
  };

  const submitOffset = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetOffset = parseIntegerInput(offsetInput);
    if (targetOffset === undefined) return;
    onNavigate({ kind: "offset", offset: targetOffset });
  };

  return (
    <TooltipProvider>
      <div
        role="toolbar"
        aria-label={intl.formatMessage({ id: "filesWorkbench.largeText.toolbar" })}
        data-files-large-text-toolbar=""
        className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border px-2 py-1.5"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          <ToolbarButton
            label={intl.formatMessage({ id: "filesWorkbench.largeText.start" })}
            disabled={!canNavigate}
            onClick={() => onNavigate({ kind: "start" })}
          >
            <ChevronsLeft aria-hidden="true" className="size-3" />
            {intl.formatMessage({ id: "filesWorkbench.largeText.startShort" })}
          </ToolbarButton>
          <ToolbarButton
            label={intl.formatMessage({ id: "filesWorkbench.largeText.previous" })}
            disabled={!canGoPrevious}
            onClick={() => onNavigate({ kind: "previous" })}
          >
            <ChevronLeft aria-hidden="true" className="size-3" />
            {intl.formatMessage({ id: "filesWorkbench.largeText.previous" })}
          </ToolbarButton>
          <ToolbarButton
            label={intl.formatMessage({ id: "filesWorkbench.largeText.next" })}
            disabled={!canGoNext}
            onClick={() => onNavigate({ kind: "next" })}
          >
            {intl.formatMessage({ id: "filesWorkbench.largeText.nextShort" })}
            <ChevronRight aria-hidden="true" className="size-3" />
          </ToolbarButton>
          <ToolbarButton
            label={intl.formatMessage({ id: "filesWorkbench.largeText.end" })}
            disabled={!canNavigate}
            onClick={() => onNavigate({ kind: "end" })}
          >
            {intl.formatMessage({ id: "filesWorkbench.largeText.endShort" })}
            <ChevronsRight aria-hidden="true" className="size-3" />
          </ToolbarButton>
        </div>

        <form className="flex min-w-0 flex-wrap items-center gap-1" onSubmit={submitPercent}>
          <label className="sr-only" htmlFor={percentId}>
            {intl.formatMessage({ id: "filesWorkbench.largeText.percent" })}
          </label>
          <input
            id={percentRangeId}
            aria-label={intl.formatMessage({ id: "filesWorkbench.largeText.percentSlider" })}
            type="range"
            min={0}
            max={100}
            step={1}
            value={clampFilesLargeTextPercent(Number(percentInput) || 0)}
            disabled={!canNavigate}
            className="h-6 w-24 min-w-16 accent-brand"
            onChange={(event) => onPercentInputChange(event.target.value)}
            onPointerUp={() => {
              const percent = parsePercentInput(percentInput);
              if (percent !== undefined) onNavigate({ kind: "percent", percent });
            }}
          />
          <Input
            id={percentId}
            aria-label={intl.formatMessage({ id: "filesWorkbench.largeText.percent" })}
            inputMode="numeric"
            value={percentInput}
            disabled={!canNavigate}
            className="h-6 w-14 px-1 text-center text-mobile-input-safe md:text-ui-base"
            onChange={(event) => onPercentInputChange(event.target.value)}
          />
          <span className="text-ui-base text-foreground-subtle" aria-hidden="true">
            %
          </span>
          <Button type="submit" variant="outline" size="xs" disabled={!canNavigate}>
            {intl.formatMessage({ id: "filesWorkbench.largeText.go" })}
          </Button>
        </form>

        <form className="flex min-w-0 flex-wrap items-center gap-1" onSubmit={submitOffset}>
          <label className="sr-only" htmlFor={offsetId}>
            {intl.formatMessage({ id: "filesWorkbench.largeText.offset" })}
          </label>
          <Input
            id={offsetId}
            aria-label={intl.formatMessage({ id: "filesWorkbench.largeText.offset" })}
            inputMode="numeric"
            value={offsetInput}
            disabled={!canNavigate}
            className="h-6 w-24 px-1 font-mono text-mobile-input-safe md:text-ui-base"
            onChange={(event) => onOffsetInputChange(event.target.value)}
          />
          <Button type="submit" variant="outline" size="xs" disabled={!canNavigate}>
            {intl.formatMessage({ id: "filesWorkbench.largeText.go" })}
          </Button>
        </form>

        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span
            data-files-large-text-mode={dirty ? "dirty" : editable ? "editable" : "readonly"}
            className="rounded-sm border border-border px-1.5 py-0.5 text-ui-base text-foreground-subtle"
          >
            {dirty
              ? intl.formatMessage({ id: "filesWorkbench.largeText.dirty" })
              : editable
                ? intl.formatMessage({ id: "filesWorkbench.largeText.editable" })
                : intl.formatMessage({ id: "filesWorkbench.largeText.readonly" })}
          </span>
          <ToolbarButton
            label={intl.formatMessage({ id: "filesWorkbench.largeText.refresh" })}
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn("size-3", loading && "animate-spin motion-reduce:animate-none")}
            />
            {intl.formatMessage({ id: "filesWorkbench.largeText.refresh" })}
          </ToolbarButton>
        </div>

        <form
          className="flex min-w-0 flex-wrap items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch("next");
          }}
        >
          <Input
            aria-label={intl.formatMessage({ id: "filesWorkbench.largeText.searchPlaceholder" })}
            placeholder={intl.formatMessage({
              id: "filesWorkbench.largeText.searchPlaceholder",
            })}
            value={searchInput}
            disabled={!hasWindow}
            className="h-6 w-32 px-1 text-mobile-input-safe md:text-ui-base"
            onChange={(event) => onSearchInputChange(event.target.value)}
          />
          <Button type="submit" variant="outline" size="xs" disabled={!hasWindow}>
            {intl.formatMessage({ id: "filesWorkbench.largeText.search" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={intl.formatMessage({ id: "filesWorkbench.largeText.searchPrevious" })}
            disabled={!hasWindow}
            onClick={() => onSearch("previous")}
          >
            <ChevronLeft aria-hidden="true" className="size-3" />
          </Button>
          <span
            className="text-ui-base text-foreground-subtle"
            data-files-large-text-search-result=""
          >
            {searchLabel ?? intl.formatMessage({ id: "filesWorkbench.largeText.searchScoped" })}
          </span>
        </form>
      </div>
    </TooltipProvider>
  );
}
