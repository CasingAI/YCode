import { MousePointer2Icon } from "lucide-react";
import { BrowserTabFavicon } from "@/app-shell/BrowserTabFavicon.js";
import { useBrowserUseOperationActive } from "@/browser-use/useBrowserUseOperationActive.js";
import type { BrowserUseSidePaneTab } from "@/lib/workspaceSidePane.js";

export function BrowserUseTabIcon({ tab }: { tab: BrowserUseSidePaneTab }) {
  const isAgentOperating = useBrowserUseOperationActive(tab.browserUseOperationUntil);

  if (isAgentOperating) {
    return (
      <span
        aria-hidden="true"
        data-browser-use-operation-indicator="active"
        className="browser-use-operation-breathe inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <MousePointer2Icon className="size-3.5" />
      </span>
    );
  }

  if (tab.usesProxy === true) {
    return (
      <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
        <BrowserTabFavicon faviconUrl={tab.faviconUrl} />
        {/* 代理标签页轻量记号：favicon 角标点，布局自解释，不加文字说明。 */}
        <span
          aria-hidden="true"
          data-browser-use-proxy-indicator=""
          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-brand ring-1 ring-background"
        />
      </span>
    );
  }

  return <BrowserTabFavicon faviconUrl={tab.faviconUrl} />;
}
