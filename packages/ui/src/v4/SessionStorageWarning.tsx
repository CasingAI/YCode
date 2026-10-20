import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, HardDrive, Loader2, X } from "lucide-react";
import type {
  BackgroundWorkSummary,
  SessionPhase,
  V4ConversationSessionStorageResult,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
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
import { storageCategoryTitleId } from "@/settings/usage-stats/storage/storageCategoryPresentation.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import {
  backgroundWorkStatuses,
  findCompletedBackgroundWorkIds,
  shouldScanForSessionStorageWarning,
  shouldShowSessionStorageWarning,
  type SessionStorageManagementBlockReason,
} from "@/v4/sessionStorageWarningModel.js";

export function SessionStorageWarning({
  sessionId,
  sessionPhase,
  backgroundWorks,
  canManageStorage,
  storageBlockedReason = null,
  onOpenStorageManagement,
}: {
  sessionId: string;
  sessionPhase: SessionPhase;
  backgroundWorks: readonly BackgroundWorkSummary[];
  canManageStorage: boolean;
  storageBlockedReason?: SessionStorageManagementBlockReason | null;
  onOpenStorageManagement: () => void;
}) {
  const { sessionStorageUsage, dismissStorageWarning } = useV4Conversation();
  const { intl } = useZCodeIntl();
  // 两种禁用原因说法不同：宿主没有存储能力，和会话产物不在宿主数据根上。
  const storageBlockedMessageId =
    storageBlockedReason === "remoteWorkspaceSession"
      ? "chat.sessionStorageWarning.storageRemoteHost"
      : "chat.sessionStorageWarning.storageUnavailable";
  const [usage, setUsage] = useState<V4ConversationSessionStorageResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsUsage, setDetailsUsage] = useState<V4ConversationSessionStorageResult | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsFailed, setDetailsFailed] = useState(false);
  const [dismissPending, setDismissPending] = useState(false);
  const [dismissFailed, setDismissFailed] = useState(false);
  const autoScanFlight = useRef(false);
  const queuedAutoScan = useRef(false);
  const autoScanCallback = useRef<() => void>(() => {});
  const autoRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const previousSessionPhase = useRef(sessionPhase);
  const firstPhaseObservation = useRef(true);
  const previousWorkStatuses = useRef(backgroundWorkStatuses(backgroundWorks));

  const runAutomaticScan = useCallback(() => {
    if (autoScanFlight.current) {
      queuedAutoScan.current = true;
      return;
    }
    const requestId = ++autoRequestId.current;
    autoScanFlight.current = true;
    void sessionStorageUsage({ sessionId })
      .then((result) => {
        if (requestId !== autoRequestId.current || result.sessionId !== sessionId) return;
        setUsage(result);
        if (result.dismissed) setDismissed(true);
      })
      .catch((error: unknown) => {
        if (requestId !== autoRequestId.current) return;
        setUsage(null);
        logger.warn("[session-storage-warning] 自动扫描失败", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      })
      .finally(() => {
        autoScanFlight.current = false;
        if (queuedAutoScan.current) {
          queuedAutoScan.current = false;
          queueMicrotask(() => autoScanCallback.current());
        }
      });
  }, [sessionId, sessionStorageUsage]);
  autoScanCallback.current = runAutomaticScan;

  const runDetailsScan = useCallback(async () => {
    const requestId = ++detailRequestId.current;
    setDetailsLoading(true);
    setDetailsFailed(false);
    setDetailsUsage(null);
    try {
      const result = await sessionStorageUsage({ sessionId });
      if (requestId !== detailRequestId.current || result.sessionId !== sessionId) return;
      setDetailsUsage(result);
      setUsage(result);
      if (result.dismissed) setDismissed(true);
    } catch (error) {
      if (requestId !== detailRequestId.current) return;
      setDetailsFailed(true);
      logger.warn("[session-storage-warning] 详情扫描失败", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    } finally {
      if (requestId === detailRequestId.current) setDetailsLoading(false);
    }
  }, [sessionId, sessionStorageUsage]);

  useEffect(() => {
    const shouldScan = shouldScanForSessionStorageWarning(
      previousSessionPhase.current,
      sessionPhase,
      firstPhaseObservation.current,
    );
    previousSessionPhase.current = sessionPhase;
    firstPhaseObservation.current = false;
    if (shouldScan) runAutomaticScan();
  }, [runAutomaticScan, sessionPhase]);

  useEffect(() => {
    const completed = findCompletedBackgroundWorkIds(previousWorkStatuses.current, backgroundWorks);
    previousWorkStatuses.current = backgroundWorkStatuses(backgroundWorks);
    if (completed.length > 0) runAutomaticScan();
  }, [backgroundWorks, runAutomaticScan]);

  const handleDismiss = useCallback(async () => {
    setDismissPending(true);
    setDismissFailed(false);
    try {
      await dismissStorageWarning({ sessionId });
      setDismissed(true);
      setUsage((current) => (current ? { ...current, dismissed: true } : current));
    } catch (error) {
      setDismissFailed(true);
      toast(intl.formatMessage({ id: "chat.sessionStorageWarning.dismissFailed" }));
      logger.warn("[session-storage-warning] 永久关闭失败", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    } finally {
      setDismissPending(false);
    }
  }, [dismissStorageWarning, intl, sessionId]);

  const openDetails = useCallback(() => {
    setDetailsOpen(true);
    void runDetailsScan();
  }, [runDetailsScan]);

  const handleOpenStorageManagement = useCallback(() => {
    setDetailsOpen(false);
    onOpenStorageManagement();
  }, [onOpenStorageManagement]);

  const visible = !dismissed && shouldShowSessionStorageWarning(usage);

  return (
    <>
      {visible ? (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-40 flex justify-center">
          <div
            className="pointer-events-auto flex w-full max-w-3xl items-center gap-3 rounded-xl border border-warning/30 bg-background/95 px-3 py-2.5 text-warning shadow-lg backdrop-blur"
            data-testid="session-storage-warning"
            role="alert"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-ui-base font-medium">
              {intl.formatMessage({ id: "chat.sessionStorageWarning.banner" })}
            </span>
            <Button
              className="shrink-0"
              disabled={dismissPending}
              onClick={openDetails}
              size="sm"
              variant="outline"
            >
              {intl.formatMessage({ id: "chat.sessionStorageWarning.details" })}
            </Button>
            <Button
              aria-label={intl.formatMessage({ id: "chat.sessionStorageWarning.dismiss" })}
              className="size-8 shrink-0 p-0 text-warning hover:text-warning"
              disabled={dismissPending}
              onClick={() => void handleDismiss()}
              size="icon"
              title={intl.formatMessage({
                id: dismissFailed
                  ? "chat.sessionStorageWarning.dismissFailed"
                  : "chat.sessionStorageWarning.dismiss",
              })}
              variant="ghost"
            >
              {dismissPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <X className="size-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "chat.sessionStorageWarning.title" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "chat.sessionStorageWarning.description" })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-ui-xs text-muted-foreground">
            {intl.formatMessage({ id: "settings.storage.estimate" })}
          </p>
          <div className="space-y-4" aria-busy={detailsLoading}>
            {detailsLoading ? (
              <div className="flex items-center gap-2 py-4 text-ui-base text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {intl.formatMessage({ id: "chat.sessionStorageWarning.scanning" })}
              </div>
            ) : detailsFailed ? (
              <p className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-ui-base text-destructive">
                {intl.formatMessage({ id: "chat.sessionStorageWarning.scanFailed" })}
              </p>
            ) : detailsUsage ? (
              <>
                {!detailsUsage.complete ? (
                  <p className="rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-ui-base text-warning">
                    {intl.formatMessage(
                      { id: "chat.sessionStorageWarning.incomplete" },
                      { count: detailsUsage.errorCount },
                    )}
                  </p>
                ) : null}
                <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-3">
                  <span className="font-medium text-foreground">
                    {intl.formatMessage({ id: "chat.sessionStorageWarning.total" })}
                  </span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {formatBytes(detailsUsage.totalBytes)}
                  </span>
                </div>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {detailsUsage.categories.length > 0 ? (
                    detailsUsage.categories.map((category) => (
                      <div
                        className="flex items-center justify-between gap-4 px-3 py-2.5 text-ui-base"
                        key={category.categoryId}
                      >
                        <span className="min-w-0 truncate text-foreground">
                          {intl.formatMessage({
                            id: storageCategoryTitleId(category.categoryId),
                          })}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {formatBytes(category.bytes)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="px-3 py-3 text-ui-base text-muted-foreground">{formatBytes(0)}</p>
                  )}
                </div>
              </>
            ) : null}
          </div>
          {!canManageStorage ? (
            <p className="text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: storageBlockedMessageId })}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={!canManageStorage}
              onClick={handleOpenStorageManagement}
              title={
                canManageStorage ? undefined : intl.formatMessage({ id: storageBlockedMessageId })
              }
              variant="outline"
            >
              <HardDrive className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "chat.sessionStorageWarning.manageStorage" })}
            </Button>
            <Button onClick={() => setDetailsOpen(false)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
