import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * CLI Proxy 提供商的上游出口代理模式（docs/specs/plugin-cli-proxy-binary.md「上游代理」）。
 * 裁决的是 CLI Proxy 进程出网（上游渠道）是否走「网络」分区的代理地址，与模型级
 * proxyMode（YCode→endpoint 一跳）不在同一段链路上；实例级共享，不按模型分流。
 */
export type CliProxyUpstreamProxyMode = "default" | "proxy" | "direct";

const MODE_LABEL_IDS: Record<CliProxyUpstreamProxyMode, string> = {
  default: "settings.modelProvider.cliproxyUpstreamProxy.default",
  proxy: "settings.modelProvider.cliproxyUpstreamProxy.proxy",
  direct: "settings.modelProvider.cliproxyUpstreamProxy.direct",
};

export const CLI_PROXY_UPSTREAM_PROXY_MODES: readonly CliProxyUpstreamProxyMode[] = [
  "default",
  "proxy",
  "direct",
];

export function resolveCliProxyUpstreamProxyModeLabel(
  intl: { formatMessage: (descriptor: { id: string }) => string },
  mode: CliProxyUpstreamProxyMode,
): string {
  return intl.formatMessage({ id: MODE_LABEL_IDS[mode] });
}

export function CliProxyUpstreamProxySelect({
  mode,
  saving = false,
  onModeChange,
}: {
  mode: CliProxyUpstreamProxyMode;
  saving?: boolean;
  onModeChange: (mode: CliProxyUpstreamProxyMode) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "settings.modelProvider.cliproxyUpstreamProxy" });
  const hint = intl.formatMessage({ id: "settings.modelProvider.cliproxyUpstreamProxyHint" });
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-input-border bg-input px-3 py-2">
      <div className="min-w-0">
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        <div className="truncate text-ui-sm text-foreground-subtle" title={hint}>
          {hint}
        </div>
      </div>
      <Select
        value={mode}
        disabled={saving}
        onValueChange={(value) => {
          if (value === "default" || value === "proxy" || value === "direct") onModeChange(value);
        }}
      >
        <SelectTrigger
          className="w-[11rem] shrink-0"
          data-testid="model-provider-cliproxy-upstream-proxy-trigger"
          aria-label={label}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CLI_PROXY_UPSTREAM_PROXY_MODES.map((candidate) => (
            <SelectItem
              key={candidate}
              value={candidate}
              data-testid={`model-provider-cliproxy-upstream-proxy-item-${candidate}`}
            >
              {resolveCliProxyUpstreamProxyModeLabel(intl, candidate)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
