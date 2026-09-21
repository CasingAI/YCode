import { useState } from "react";
import { Smartphone } from "lucide-react";
import { TID_MOBILE_REMOTE_TRIGGER } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { useMobileRemoteControl } from "@/hooks/useMobileRemoteControl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MobileRemoteControlDialog } from "@/MobileRemoteControlDialog.js";

/**
 * 侧边栏底部的远程控制入口。
 *
 * 只在当前 attachment 真的提供远控服务时渲染（桌面本地窗口 Host）；
 * Web 端与远程 workspace 的 accessor 没有该服务，入口自然不出现。
 */
export function MobileRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const view = useMobileRemoteControl();
  const [open, setOpen] = useState(false);

  if (!view.available) return null;

  const label = intl.formatMessage({ id: "mobileRemote.title" });

  return (
    <>
      <ControlHintTooltip title={label}>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          data-testid={TID_MOBILE_REMOTE_TRIGGER}
          aria-label={label}
          // 已启用（含重启后自动恢复）时图标变橙色：这是侧边栏里唯一的"远控还开着"信号。
          className={cn(view.status.enabled && "text-orange-500 hover:text-orange-500")}
          onClick={() => setOpen(true)}
        >
          <Smartphone className="size-4" />
        </Button>
      </ControlHintTooltip>
      <MobileRemoteControlDialog
        open={open}
        onOpenChange={setOpen}
        view={view}
        onStart={() => {
          // 把桌面当前 workspace 交给 Host，写入 /api/server-info，
          // 让手机打开就落在同一个工作区。
          void view.start(
            workspacePath
              ? { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }
              : undefined,
          );
        }}
      />
    </>
  );
}
