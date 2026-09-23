import { useCallback } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAlertDialogStore } from "@/store/alertDialogStore.js";

export function AlertDialogHost() {
  const { intl } = useZCodeIntl();
  const pendingRequest = useAlertDialogStore((state) => state.pendingRequest);
  const settleAlert = useAlertDialogStore((state) => state.settleAlert);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        settleAlert(false);
      }
    },
    [settleAlert],
  );

  return (
    <AlertDialog open={Boolean(pendingRequest)} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="gap-5">
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle>{pendingRequest?.title}</AlertDialogTitle>
          {pendingRequest?.description ? (
            <AlertDialogDescription>{pendingRequest.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:justify-end">
          {/* 取消按钮同时是 Radix 的默认聚焦目标：需要双向选择时回车落在「不丢弃」一侧。 */}
          {pendingRequest?.cancelLabel ? (
            <AlertDialogCancel onClick={() => settleAlert(false)} size="lg" className="h-9">
              {pendingRequest.cancelLabel}
            </AlertDialogCancel>
          ) : null}
          <AlertDialogAction
            onClick={() => settleAlert(true)}
            size="lg"
            className={cn("h-9 justify-between gap-3 sm:min-w-32")}
          >
            <span>
              {pendingRequest?.actionLabel ?? intl.formatMessage({ id: "common.confirm" })}
            </span>
            <span className="text-ui-base text-primary-foreground/60">⏎</span>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
