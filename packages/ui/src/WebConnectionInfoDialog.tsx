import { Info } from "lucide-react";
import { TID_WEB_CONNECTION_INFO_DIALOG } from "@zcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useServiceConnection } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WebConnectionInfoContent } from "@/WebConnectionInfoContent.js";

/** 开合为本地状态；内容订阅既有连接快照，不另建连接或轮询。 */
export function WebConnectionInfoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const connection = useServiceConnection();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_WEB_CONNECTION_INFO_DIALOG}
        className="max-h-[calc(100dvh-2rem)] w-[min(420px,calc(100vw-2rem))] overflow-y-auto"
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
            <Info className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "webConnectionInfo.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "webConnectionInfo.description" })}
          </DialogDescription>
        </DialogHeader>
        <WebConnectionInfoContent
          status={connection.status}
          connectionInfo={connection.connectionInfo}
        />
      </DialogContent>
    </Dialog>
  );
}
