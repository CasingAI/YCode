/**
 * 设置页「数据与统计 › 存储」分区。
 * 数据来自 useStorageUsage（main 进程 StorageService 经 IPlatformService.storage 桥的投影）；
 * 本组件只持有 UI 选择态：选中的磁盘、打开的类别明细、待确认的清理目标。
 */
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  groupStorageRootsByVolume,
  STORAGE_MORE_ENTRIES_PATH,
  type StorageCategoryId,
  type StorageCleanResult,
  type StorageManagementBridge,
  type StorageRootId,
  TID_SETTINGS_STORAGE_CLEANUP_OPEN,
  TID_SETTINGS_STORAGE_RESCAN,
  TID_SETTINGS_STORAGE_SECTION,
  TID_SETTINGS_STORAGE_STATUS,
  TID_SETTINGS_STORAGE_TOTAL,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useStorageUsage } from "./useStorageUsage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { StorageCategoryDetail } from "./StorageCategoryDetail.js";
import { StorageCategoryList } from "./StorageCategoryList.js";
import {
  StorageCleanupDialog,
  type StorageCleanupSelection,
} from "./StorageCleanupDialog.js";
import { StorageCleanConfirmDialog } from "./StorageCleanConfirmDialog.js";
import { StorageDiskCard } from "./StorageDiskCard.js";
import { buildStorageLegend, sumCategoriesAcrossRoots } from "./storageCategoryPresentation.js";

export function StorageSection({
  bridge,
  active,
}: {
  /** IPlatformService.storage；缺省表示当前环境不支持本地存储统计 */
  bridge: StorageManagementBridge | undefined;
  /** tab 是否处于激活态：激活才扫描，切走即取消 */
  active: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { snapshot, scanning, rescan, clean } = useStorageUsage({
    bridge,
    enabled: active,
  });
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [detailCategory, setDetailCategory] = useState<StorageCategoryId | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  // 备份勾选后沿用现有二次确认：先收草稿，确认框通过后才真正清理整组。
  const [pendingSelection, setPendingSelection] = useState<StorageCleanupSelection | null>(null);

  const groups = useMemo(() => groupStorageRootsByVolume(snapshot?.roots ?? []), [snapshot]);
  // 选中卷在渲染期派生：用户点过的 key 失效（重扫后卷变化）时自动回落到第一张卡片，不用 effect 回写 state。
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? groups[0] ?? null;
  const categories = useMemo(
    () => (selectedGroup ? sumCategoriesAcrossRoots(selectedGroup.roots) : []),
    [selectedGroup],
  );
  // 沙盒按会话清：跨根合并 sandbox 类的下钻明细（entryKey + 占用），供清理对话框展开多选。
  const sandboxEntries = useMemo(() => {
    if (!selectedGroup) return [];
    const merged = new Map<string, number>();
    for (const root of selectedGroup.roots) {
      const sandbox = root.categories.find((category) => category.id === "sandbox");
      for (const entry of sandbox?.entries ?? []) {
        if (entry.relativePath === STORAGE_MORE_ENTRIES_PATH) continue;
        merged.set(entry.relativePath, (merged.get(entry.relativePath) ?? 0) + entry.bytes);
      }
    }
    return [...merged.entries()]
      .map(([key, bytes]) => ({ key, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [selectedGroup]);
  const totalBytes = (snapshot?.roots ?? []).reduce((sum, root) => sum + root.bytes, 0);
  const status = scanning ? "scanning" : (snapshot?.status ?? "idle");

  const runCleanup = useCallback(
    async (selection: StorageCleanupSelection) => {
      if (!selectedGroup) return;
      setCleaning(true);
      try {
        // 同一卷上可能有两个根（home 与自定义数据路径）：逐根清理同一组类别。
        const rootIds: StorageRootId[] = selectedGroup.roots.map((root) => root.id);
        let merged: StorageCleanResult = {
          freedBytes: 0,
          deletedCount: 0,
          skippedCount: 0,
          failures: [],
        };
        for (const rootId of rootIds) {
          const result = await clean({
            rootId,
            categoryIds: selection.categoryIds,
            olderThanMs: selection.olderThanMs,
            ...(selection.entryKeys === undefined ? {} : { entryKeys: selection.entryKeys }),
          });
          merged = {
            freedBytes: merged.freedBytes + result.freedBytes,
            deletedCount: merged.deletedCount + result.deletedCount,
            skippedCount: merged.skippedCount + result.skippedCount,
            failures: [...merged.failures, ...result.failures],
          };
        }
        if (merged.deletedCount === 0 && merged.failures.length === 0) {
          toast(intl.formatMessage({ id: "settings.storage.cleanNothing" }));
        } else if (merged.failures.length > 0) {
          toast(
            intl.formatMessage(
              { id: "settings.storage.cleanPartial" },
              {
                size: formatBytes(merged.freedBytes),
                count: merged.failures.length,
              },
            ),
          );
        } else {
          toast(
            intl.formatMessage(
              { id: "settings.storage.cleanSuccess" },
              { size: formatBytes(merged.freedBytes) },
            ),
          );
        }
      } catch (error) {
        // 清理失败只记类别组，不记单个类别：一次确认发出的是一组类别。
        logger.error("[storage] cleanup failed", {
          categoryIds: selection.categoryIds,
          error,
        });
        toast(intl.formatMessage({ id: "settings.storage.cleanFailed" }));
      } finally {
        setCleaning(false);
        setCleanupOpen(false);
        setPendingSelection(null);
      }
    },
    [clean, intl, selectedGroup],
  );

  // 备份勾选后沿用现有二次确认：先收草稿，确认框通过后才真正清理整组。
  const backupsBytes = categories.find((item) => item.id === "backups")?.bytes ?? 0;

  const handleCleanupConfirm = useCallback(
    (selection: StorageCleanupSelection) => {
      if (selection.categoryIds.includes("backups")) {
        setPendingSelection(selection);
        return;
      }
      void runCleanup(selection);
    },
    [runCleanup],
  );

  const busy = cleaning;

  if (!bridge) {
    return (
      <div
        data-testid={TID_SETTINGS_STORAGE_SECTION}
        className="rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive"
      >
        {intl.formatMessage({ id: "settings.storage.unavailable" })}
      </div>
    );
  }

  return (
    <div data-testid={TID_SETTINGS_STORAGE_SECTION} className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "settings.storage.summaryTotal" })}
          </div>
          <div
            data-testid={TID_SETTINGS_STORAGE_TOTAL}
            className="text-ui-xl font-semibold tabular-nums text-foreground"
          >
            {formatBytes(totalBytes)}
          </div>
        </div>
        <div
          data-testid={TID_SETTINGS_STORAGE_STATUS}
          data-state={status}
          className="flex items-center gap-1.5 text-ui-caption text-foreground-subtle"
        >
          {scanning ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {scanning
            ? intl.formatMessage({ id: "settings.storage.scanning" })
            : snapshot?.finishedAt
              ? intl.formatMessage(
                  { id: "settings.storage.lastScanned" },
                  {
                    time: formatDateTime(snapshot.finishedAt),
                  },
                )
              : snapshot?.status === "failed"
                ? intl.formatMessage({ id: "settings.storage.failed" })
                : intl.formatMessage({ id: "settings.storage.idle" })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_SETTINGS_STORAGE_CLEANUP_OPEN}
            disabled={scanning || busy}
            onClick={() => setCleanupOpen(true)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.storage.cleanup" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_SETTINGS_STORAGE_RESCAN}
            disabled={scanning || busy}
            onClick={() => void rescan()}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.storage.rescan" })}
          </Button>
        </div>
      </div>

      {snapshot && snapshot.errors.length > 0 ? (
        <div className="text-ui-caption text-warning">
          {intl.formatMessage({ id: "settings.storage.errors" }, { count: snapshot.errors.length })}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          {groups.map((group, index) => (
            <StorageDiskCard
              key={group.key}
              group={group}
              index={index}
              legend={buildStorageLegend(sumCategoriesAcrossRoots(group.roots))}
              selected={group.key === selectedGroup?.key}
              selectable={groups.length > 1}
              onSelect={() => {
                setSelectedGroupKey(group.key);
                setDetailCategory(null);
              }}
            />
          ))}
          {/* 估算说明紧跟磁盘卡片，和它解释的数字放在一起，而不是沉到页面底部 */}
          <div className="px-1 text-ui-caption text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.storage.estimate" })}
          </div>
        </div>
        <div className="min-w-0">
          {selectedGroup && detailCategory ? (
            <StorageCategoryDetail
              categoryId={detailCategory}
              roots={selectedGroup.roots}
              onBack={() => setDetailCategory(null)}
              onReveal={(absolutePath) => bridge?.revealPath(absolutePath) ?? Promise.resolve()}
            />
          ) : (
            <StorageCategoryList categories={categories} onOpen={setDetailCategory} />
          )}
        </div>
      </div>

      <StorageCleanupDialog
        open={cleanupOpen}
        categories={categories}
        sandboxEntries={sandboxEntries}
        pending={busy}
        onOpenChange={setCleanupOpen}
        onConfirm={handleCleanupConfirm}
      />

      <StorageCleanConfirmDialog
        target={pendingSelection ? { categoryId: "backups", bytes: backupsBytes } : null}
        pending={busy}
        onCancel={() => setPendingSelection(null)}
        onConfirm={() => {
          if (pendingSelection) void runCleanup(pendingSelection);
        }}
      />
    </div>
  );
}
