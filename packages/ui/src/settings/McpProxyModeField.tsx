import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 单个 MCP server 的出口代理四选一。语义与「模型 → 高级配置 → 网络代理」一致
 * （docs/specs/network-settings.md）：未指定跟随全局开关，使用代理走「网络」分区地址，
 * 系统代理设置走操作系统代理，不使用代理强制直连。
 *
 * 不复用 ModelProxyModeRadioGroup：那个组件带模型编辑器的 personal-override 样式与
 * data-* 钩子，跨 feature 目录搬过来会串味，所以这里自持一份最小实现。
 */
export function McpProxyModeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const options = [
    { value: "default", labelId: "settings.mcp.form.proxyModeDefault" },
    { value: "proxy", labelId: "settings.mcp.form.proxyModeProxy" },
    { value: "system", labelId: "settings.mcp.form.proxyModeSystem" },
    { value: "direct", labelId: "settings.mcp.form.proxyModeDirect" },
  ];
  // 空串 = 未设置，渲染时回落到「未指定」；配置文件不落多余字段。
  const selected = value || "default";

  return (
    <div className="space-y-1.5">
      <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.mcp.form.proxyMode" })}
      </label>
      <div role="radiogroup" data-mcp-proxy-mode="true" className="flex flex-wrap gap-2">
        {options.map((option) => {
          const isSelected = option.value === selected;
          return (
            <Button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              data-selected={isSelected}
              data-mcp-proxy-option={option.value}
              variant="outline"
              size="lg"
              className={cn("gap-2 px-3", isSelected && "border-primary")}
              onClick={() => onChange(option.value)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input-border bg-input",
                )}
              >
                {isSelected ? <span className="size-1.5 rounded-full bg-current" /> : null}
              </span>
              <span>{intl.formatMessage({ id: option.labelId })}</span>
            </Button>
          );
        })}
      </div>
      <p className="text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "settings.mcp.form.proxyModeHint" })}
      </p>
    </div>
  );
}
