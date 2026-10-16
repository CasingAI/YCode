/**
 * 存储独立清理对话框：勾选要清理的内容 + 选择时间范围，确认后一次清理。
 * 对话框只持有草稿态（勾选集合、时间范围），确认后才把命令发给存储服务。
 */
import { Loader2 } from "lucide-react";
import { useState } from "react";
import {
  STORAGE_CLEAN_DIALOG_CATEGORY_IDS,
  STORAGE_CLEAN_DIALOG_DEFAULT_CHECKED,
  STORAGE_CLEAN_DIALOG_DEFAULT_RANGE,
  type StorageCategoryId,
  type StorageCleanAgeRange,
  TID_SETTINGS_STORAGE_CLEANUP_ACCEPT,
  TID_SETTINGS_STORAGE_CLEANUP_CANCEL,
  TID_SETTINGS_STORAGE_CLEANUP_CHECK,
  TID_SETTINGS_STORAGE_CLEANUP_DIALOG,
  TID_SETTINGS_STORAGE_CLEANUP_RANGE,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import {
  STORAGE_CATEGORY_ICONS,
  storageCategoryDescriptionId,
  storageCategoryTitleId,
  type StorageCategoryTotal,
} from "./storageCategoryPresentation.js";

export interface StorageCleanupSelection {
  categoryIds: StorageCategoryId[];
  ageRange: StorageCleanAgeRange;
  /** 按会话清（sandbox 类展开多选）：选中的 entryKey 前缀；缺席为整类。 */
  entryKeys?: string[];
}

const CLEANUP_RANGES: StorageCleanAgeRange[] = ["24hours", "7days", "30days", "all"];

export function StorageCleanupDialog({
  open,
  categories,
  sandboxEntries,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  categories: StorageCategoryTotal[];
  /** sandbox 类的会话下钻明细（跨根合并后的 entryKey + 占用）；缺席时该类只整类清。 */
  sandboxEntries?: Array<{ key: string; bytes: number }>;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (selection: StorageCleanupSelection) => void;
}) {
  const { intl } = useZCodeIntl();
  const [checked, setChecked] = useState<ReadonlySet<StorageCategoryId>>(
    () => new Set(STORAGE_CLEAN_DIALOG_DEFAULT_CHECKED),
  );
  const [range, setRange] = useState<StorageCleanAgeRange>(STORAGE_CLEAN_DIALOG_DEFAULT_RANGE);
  // 沙盒按会话清：选中的 entryKey 集合；空 = 该类整类清。切换类别勾选时不同步清空
  // （草稿态保留选择），确认时只在 sandbox 被勾选时携带。
  const [checkedSandboxKeys, setCheckedSandboxKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const byId = new Map(categories.map((category) => [category.id, category]));
  const dialogCategories = STORAGE_CLEAN_DIALOG_CATEGORY_IDS.map((id) => byId.get(id)).filter(
    (category): category is StorageCategoryTotal => category !== undefined,
  );
  const checkedCount = dialogCategories.filter((category) => checked.has(category.id)).length;

  const toggle = (id: StorageCategoryId, value: boolean) => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleConfirm = () => {
    if (checkedCount === 0 || pending) return;
    // 按会话清只在 sandbox 单类时携带 entryKeys（服务侧多类别循环下其它类别无匹配
    // 前缀即整类保留，调用方保证只传 sandbox；见 storageService clean 注释）。
    const sandboxOnly =
      dialogCategories.filter((category) => checked.has(category.id)).length === 1 &&
      checked.has("sandbox");
    const entryKeys =
      sandboxOnly && checkedSandboxKeys.size > 0 ? [...checkedSandboxKeys] : undefined;
    onConfirm({
      categoryIds: dialogCategories
        .filter((category) => checked.has(category.id))
        .map((category) => category.id),
      ageRange: range,
      ...(entryKeys === undefined ? {} : { entryKeys }),
    });
  };

  const toggleSandboxKey = (key: string, value: boolean) => {
    setCheckedSandboxKeys((previous) => {
      const next = new Set(previous);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!pending ? onOpenChange(next) : undefined)}>
      <DialogContent
        data-testid={TID_SETTINGS_STORAGE_CLEANUP_DIALOG}
        className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-hidden p-0"
      >
        <div className="flex max-h-[calc(100dvh-2rem)] min-h-0 min-w-0 flex-col gap-5 overflow-hidden p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.storage.cleanupTitle" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.storage.cleanupDescription" })}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 min-w-0 space-y-1 overflow-y-auto overscroll-contain pr-1">
            {dialogCategories.map((category) => {
              const Icon = STORAGE_CATEGORY_ICONS[category.id];
              const isChecked = checked.has(category.id);
              return (
                <label
                  key={category.id}
                  className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover"
                >
                  <Checkbox
                    data-testid={testId(TID_SETTINGS_STORAGE_CLEANUP_CHECK, category.id)}
                    checked={isChecked}
                    disabled={pending}
                    onCheckedChange={(value) => toggle(category.id, value === true)}
                    className="mt-1"
                    aria-label={intl.formatMessage({ id: storageCategoryTitleId(category.id) })}
                  />
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-ui-base font-medium text-foreground">
                        {intl.formatMessage({ id: storageCategoryTitleId(category.id) })}
                      </span>
                      <span className="shrink-0 text-ui-caption tabular-nums text-foreground-subtle">
                        {formatBytes(category.bytes)}
                      </span>
                    </span>
                    <span className="block text-ui-caption leading-5 text-foreground-subtle">
                      {intl.formatMessage({ id: storageCategoryDescriptionId(category.id) })}
                    </span>
                    {category.id === "toolOutputs" && isChecked ? (
                      <span className="block pt-0.5 text-ui-caption leading-5 text-warning">
                        {intl.formatMessage({ id: "settings.storage.cleanupToolOutputsWarning" })}
                      </span>
                    ) : null}
                    {category.id === "sandbox" && isChecked && (sandboxEntries ?? []).length > 0 ? (
                      <span className="block space-y-1 pt-1">
                        <span className="block text-ui-caption leading-5 text-foreground-subtle">
                          {intl.formatMessage({ id: "settings.storage.cleanupSandboxHint" })}
                        </span>
                        {(sandboxEntries ?? []).map((entry) => {
                          const sessionLabel = entry.key.split("/").at(-1) ?? entry.key;
                          const entryChecked = checkedSandboxKeys.has(entry.key);
                          return (
                            <label
                              key={entry.key}
                              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-hover"
                            >
                              <Checkbox
                                data-testid={testId(
                                  TID_SETTINGS_STORAGE_CLEANUP_CHECK,
                                  `sandbox:${entry.key}`,
                                )}
                                checked={entryChecked}
                                disabled={pending}
                                onCheckedChange={(value) =>
                                  toggleSandboxKey(entry.key, value === true)
                                }
                                aria-label={sessionLabel}
                              />
                              <span className="min-w-0 flex-1 truncate font-mono text-ui-caption text-foreground">
                                {sessionLabel}
                              </span>
                              <span className="shrink-0 text-ui-caption tabular-nums text-foreground-subtle">
                                {formatBytes(entry.bytes)}
                              </span>
                            </label>
                          );
                        })}
                        <span className="block text-ui-caption leading-5 text-foreground-subtle">
                          {checkedSandboxKeys.size === 0
                            ? intl.formatMessage({
                                id: "settings.storage.cleanupSandboxAll",
                              })
                            : intl.formatMessage(
                                { id: "settings.storage.cleanupSandboxSelected" },
                                { count: checkedSandboxKeys.size },
                              )}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.storage.cleanupRange" })}
            </div>
            <div role="radiogroup" className="flex flex-wrap gap-2">
              {CLEANUP_RANGES.map((item) => {
                const selected = range === item;
                return (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={testId(TID_SETTINGS_STORAGE_CLEANUP_RANGE, item)}
                    disabled={pending}
                    onClick={() => setRange(item)}
                    className={
                      selected
                        ? "rounded-full border border-primary bg-primary/10 px-3 py-1.5 text-ui-base font-medium text-foreground"
                        : "rounded-full border border-card-border bg-card px-3 py-1.5 text-ui-base text-foreground-subtle hover:bg-surface-hover"
                    }
                  >
                    {intl.formatMessage({ id: `settings.storage.cleanupRange.${item}` })}
                  </button>
                );
              })}
            </div>
            <div className="text-ui-caption leading-5 text-foreground-subtle">
              {intl.formatMessage({
                id:
                  range === "all"
                    ? "settings.storage.cleanupAllWarning"
                    : "settings.storage.cleanupProtectNote",
              })}
            </div>
          </div>

          <DialogFooter className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              data-testid={TID_SETTINGS_STORAGE_CLEANUP_CANCEL}
              disabled={pending}
              onClick={() => onOpenChange(false)}
              className="h-9 px-4"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_SETTINGS_STORAGE_CLEANUP_ACCEPT}
              disabled={pending || checkedCount === 0}
              onClick={handleConfirm}
              className="h-9 px-4"
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {pending
                ? intl.formatMessage({ id: "settings.storage.cleaning" })
                : intl.formatMessage({ id: "settings.storage.clean" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
