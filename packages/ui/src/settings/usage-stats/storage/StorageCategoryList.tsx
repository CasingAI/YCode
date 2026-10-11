import { ChevronRight } from "lucide-react";
import {
  type StorageCategoryId,
  TID_SETTINGS_STORAGE_CATEGORY_ROW,
  TID_SETTINGS_STORAGE_CATEGORY_SIZE,
  testId,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import {
  STORAGE_CATEGORY_ICONS,
  storageCategoryDescriptionId,
  storageCategoryTitleId,
  type StorageCategoryTotal,
} from "./storageCategoryPresentation.js";

export function StorageCategoryList({
  categories,
  onOpen,
}: {
  categories: StorageCategoryTotal[];
  onOpen: (id: StorageCategoryId) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-card">
      {categories.map((category) => {
        const Icon = STORAGE_CATEGORY_ICONS[category.id];
        return (
          <div
            key={category.id}
            className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
          >
            <button
              type="button"
              data-testid={testId(TID_SETTINGS_STORAGE_CATEGORY_ROW, category.id)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => onOpen(category.id)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: storageCategoryTitleId(category.id),
                  })}
                </span>
                <span
                  data-testid={testId(TID_SETTINGS_STORAGE_CATEGORY_SIZE, category.id)}
                  className="block text-ui-caption tabular-nums text-foreground-subtle"
                  title={intl.formatMessage({
                    id: storageCategoryDescriptionId(category.id),
                  })}
                >
                  {formatBytes(category.bytes)}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtlest hover:bg-surface-hover"
              aria-label={intl.formatMessage({
                id: storageCategoryTitleId(category.id),
              })}
              onClick={() => onOpen(category.id)}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
