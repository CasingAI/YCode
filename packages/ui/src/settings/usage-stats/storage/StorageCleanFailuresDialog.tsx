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

export interface StorageCleanFailure {
  path: string;
  code: string;
}

export function StorageCleanFailuresDialog({
  failures,
  onClose,
}: {
  failures: StorageCleanFailure[];
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const open = failures.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "settings.storage.cleanFailuresTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "settings.storage.cleanFailuresDescription" },
              { count: failures.length },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 max-h-[50dvh] space-y-2 overflow-y-auto rounded-md bg-surface p-3">
          {failures.map(({ path, code }, index) => (
            <div key={`${path}:${code}:${index}`} className="break-all text-ui-caption leading-5">
              <div className="font-mono text-foreground">{path}</div>
              <div className="text-foreground-subtle">{code}</div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {intl.formatMessage({ id: "common.close" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
