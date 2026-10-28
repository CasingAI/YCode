import { LoaderCircle, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  countWorkspaceFileTreeSearchFilters,
  type WorkspaceFileTreeSearchState,
} from "@/workspace-file-tree/workspaceFileTreeSearchModel.js";

/**
 * 文件树常驻搜索栏与可折叠筛选面板。
 *
 * 所有值都由 WorkspaceFileTree 持有；收起只改变 filtersExpanded，不清除条件，
 * 因此入口徽标可以在折叠态持续显示生效条件数量。
 */
export function WorkspaceFileTreeSearchHeader({
  state,
  gitStatusAvailable,
  filtering = false,
  onChange,
  onClearFilters,
}: {
  state: WorkspaceFileTreeSearchState;
  gitStatusAvailable: boolean;
  filtering?: boolean;
  onChange: (patch: Partial<WorkspaceFileTreeSearchState>) => void;
  onClearFilters: () => void;
}) {
  const { intl } = useZCodeIntl();
  const filterCount = countWorkspaceFileTreeSearchFilters(state);
  const filtersLabel =
    filterCount > 0
      ? intl.formatMessage({ id: "workspaceFileTree.searchFiltersActive" }, { count: filterCount })
      : intl.formatMessage({ id: "workspaceFileTree.searchFilters" });

  return (
    <div className="shrink-0 px-2 pb-2">
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
          <Input
            type="text"
            size="default"
            value={state.query}
            className="h-7 bg-transparent pl-7 pr-7 text-mobile-input-safe focus-visible:bg-input-focused md:text-ui-base"
            placeholder={intl.formatMessage({
              id: "workspaceFileTree.searchPlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "workspaceFileTree.searchLabel",
            })}
            onChange={(event) => onChange({ query: event.currentTarget.value })}
          />
          {state.query.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
              aria-label={intl.formatMessage({
                id: "workspaceFileTree.clearSearch",
              })}
              title={intl.formatMessage({
                id: "workspaceFileTree.clearSearch",
              })}
              onClick={() => onChange({ query: "" })}
            >
              <X className="size-3" />
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={state.filtersExpanded}
          aria-label={filtersLabel}
          title={filtersLabel}
          data-testid="workspace-file-search-filter-trigger"
          className={cn(
            "h-7 shrink-0 gap-1 px-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
            (state.filtersExpanded || filterCount > 0) && "bg-selected text-foreground",
          )}
          onClick={() => onChange({ filtersExpanded: !state.filtersExpanded })}
        >
          {filtering ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <SlidersHorizontal className="size-3.5" />
          )}
          <span>{intl.formatMessage({ id: "workspaceFileTree.searchFilters" })}</span>
          {filterCount > 0 ? (
            <span
              className="min-w-4 rounded-full bg-surface-hover px-1 text-center text-ui-xs leading-4"
              data-testid="workspace-file-search-filter-count"
            >
              {filterCount}
            </span>
          ) : null}
        </Button>
      </div>
      {state.filtersExpanded ? (
        <div
          className="mt-1.5 space-y-2 rounded-lg border border-border bg-surface p-2"
          data-testid="workspace-file-search-filters"
        >
          <label className="block space-y-1">
            <span className="block text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "workspaceFileTree.searchInclude" })}
            </span>
            <Input
              type="text"
              size="default"
              value={state.include}
              className="h-7 bg-transparent text-mobile-input-safe focus-visible:bg-input-focused md:text-ui-base"
              placeholder={intl.formatMessage({
                id: "workspaceFileTree.searchIncludePlaceholder",
              })}
              onChange={(event) => onChange({ include: event.currentTarget.value })}
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "workspaceFileTree.searchExclude" })}
            </span>
            <Input
              type="text"
              size="default"
              value={state.exclude}
              className="h-7 bg-transparent text-mobile-input-safe focus-visible:bg-input-focused md:text-ui-base"
              placeholder={intl.formatMessage({
                id: "workspaceFileTree.searchExcludePlaceholder",
              })}
              onChange={(event) => onChange({ exclude: event.currentTarget.value })}
            />
          </label>
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "workspaceFileTree.searchPatternHint" })}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="flex items-center gap-1.5 text-ui-base text-foreground-subtle">
              <Checkbox
                checked={state.includeIgnored}
                onCheckedChange={(checked) => onChange({ includeIgnored: checked === true })}
              />
              {intl.formatMessage({ id: "workspaceFileTree.searchIncludeIgnored" })}
            </label>
            {gitStatusAvailable ? (
              <label className="flex items-center gap-1.5 text-ui-base text-foreground-subtle">
                <Checkbox
                  checked={state.changedOnly}
                  onCheckedChange={(checked) => onChange({ changedOnly: checked === true })}
                />
                {intl.formatMessage({ id: "workspaceFileTree.searchChangedOnly" })}
              </label>
            ) : null}
            {filterCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                onClick={onClearFilters}
              >
                {intl.formatMessage({ id: "workspaceFileTree.searchClearFilters" })}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {filtering ? intl.formatMessage({ id: "workspaceFileTree.filtering" }) : null}
      </span>
    </div>
  );
}
