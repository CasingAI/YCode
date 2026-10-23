import { DesktopCommandIds, desktopMenuMessageIds, getDesktopMenuMessage } from "@zcode/shared";
import { Menu } from "lucide-react";
import { DesktopTopOverlayActionButton } from "@/DesktopTopOverlayActionButton.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 工作区和无工作区外壳共用入口；各外壳负责平台显隐，命令与菜单事实仍归 Main。 */
export function DesktopApplicationMenuButton() {
  const platform = usePlatform();
  const { locale } = useZCodeIntl();
  const title = getDesktopMenuMessage(locale, desktopMenuMessageIds.applicationMenu);

  return (
    <DesktopTopOverlayActionButton
      title={title}
      ariaLabel={title}
      testId="desktop-top-nav-application-menu"
      onClick={() => void platform.executeDesktopCommand(DesktopCommandIds.ShowApplicationMenu)}
    >
      <Menu className="size-4" />
    </DesktopTopOverlayActionButton>
  );
}
