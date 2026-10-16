import { Loader2 } from "lucide-react";
import {
  type StorageCategoryId,
  TID_SETTINGS_STORAGE_CONFIRM_ACCEPT,
  TID_SETTINGS_STORAGE_CONFIRM_CANCEL,
  TID_SETTINGS_STORAGE_CONFIRM_DIALOG,
} from "@zcode/shared";
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { storageCategoryTitleId } from "./storageCategoryPresentation.js";

export interface StorageCleanConfirmTarget {
  categoryId: StorageCategoryId;
  bytes: number;
}

export function StorageCleanConfirmDialog({
  target,
  permanent = false,
  pending,
  onCancel,
  onConfirm,
}: {
  target: StorageCleanConfirmTarget | null;
  permanent?: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => (!open && !pending ? onCancel() : undefined)}
    >
      <AlertDialogContent data-testid={TID_SETTINGS_STORAGE_CONFIRM_DIALOG}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target
              ? intl.formatMessage(
                  { id: permanent ? "settings.storage.confirmPermanentTitle" : "settings.storage.confirmTitle" },
                  {
                    category: intl.formatMessage({
                      id: storageCategoryTitleId(target.categoryId),
                    }),
                  },
                )
              : null}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? [
                  permanent
                    ? intl.formatMessage({ id: "settings.storage.confirmPermanentWarning" })
                    : intl.formatMessage({
                        id: `settings.storage.confirmDescription.${target.categoryId}`,
                      }),
                  !permanent && target.categoryId === "backups"
                    ? intl.formatMessage(
                        { id: "settings.storage.confirmSize" },
                        { size: formatBytes(target.bytes) },
                      )
                    : null,
                ]
                    .filter(Boolean)
                    .join(" ")
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid={TID_SETTINGS_STORAGE_CONFIRM_CANCEL} disabled={pending}>
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid={TID_SETTINGS_STORAGE_CONFIRM_ACCEPT}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({ id: "settings.storage.clean" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
