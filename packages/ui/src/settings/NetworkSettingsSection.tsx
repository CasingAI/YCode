import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** No Proxy 规则统一为 trim 后的英文逗号分隔；与服务层 normalizeSettingsPatch 的空串语义保持一致。 */
export function normalizeNoProxyRules(noProxy: string): string {
  return noProxy
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
}

export function NetworkSettingsSection({
  httpProxyEnabled = false,
  httpProxy = "",
  httpProxyNoProxy = "",
  httpProxyCaCertPath = "",
  onHttpProxyEnabledChange = async () => {},
  onHttpProxyChange = async () => {},
  onHttpProxyNoProxyChange = async () => {},
  onHttpProxyCaCertPathChange = async () => {},
}: {
  httpProxyEnabled?: boolean;
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  onHttpProxyEnabledChange?: (enabled: boolean) => Promise<void>;
  onHttpProxyChange?: (httpProxy: string) => Promise<void>;
  onHttpProxyNoProxyChange?: (noProxy: string) => Promise<void>;
  onHttpProxyCaCertPathChange?: (caCertPath: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();

  const [localHttpProxy, setLocalHttpProxy] = useState(httpProxy);

  useEffect(() => {
    setLocalHttpProxy(httpProxy);
  }, [httpProxy]);

  const normalizedHttpProxy = localHttpProxy.trim();
  const isHttpProxyDirty = normalizedHttpProxy !== httpProxy;

  const handleHttpProxySave = useCallback(async () => {
    await onHttpProxyChange(normalizedHttpProxy);
  }, [normalizedHttpProxy, onHttpProxyChange]);

  const [localHttpProxyNoProxy, setLocalHttpProxyNoProxy] = useState(httpProxyNoProxy);

  useEffect(() => {
    setLocalHttpProxyNoProxy(httpProxyNoProxy);
  }, [httpProxyNoProxy]);

  const normalizedHttpProxyNoProxy = normalizeNoProxyRules(localHttpProxyNoProxy);
  const isHttpProxyNoProxyDirty = normalizedHttpProxyNoProxy !== httpProxyNoProxy;

  const handleHttpProxyNoProxySave = useCallback(async () => {
    await onHttpProxyNoProxyChange(normalizedHttpProxyNoProxy);
  }, [normalizedHttpProxyNoProxy, onHttpProxyNoProxyChange]);

  const [localHttpProxyCaCertPath, setLocalHttpProxyCaCertPath] = useState(httpProxyCaCertPath);

  useEffect(() => {
    setLocalHttpProxyCaCertPath(httpProxyCaCertPath);
  }, [httpProxyCaCertPath]);

  const normalizedHttpProxyCaCertPath = localHttpProxyCaCertPath.trim();
  const isHttpProxyCaCertPathDirty = normalizedHttpProxyCaCertPath !== httpProxyCaCertPath;

  const handleHttpProxyCaCertPathSave = useCallback(async () => {
    await onHttpProxyCaCertPathChange(normalizedHttpProxyCaCertPath);
  }, [normalizedHttpProxyCaCertPath, onHttpProxyCaCertPathChange]);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.network.proxyTitle" })}
          </h3>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.network.proxyDescription" })}
          </p>
        </div>
        <SettingsGroupCard>
          {/* 填写代理地址与启用代理是两个独立概念：只有打开「为全局启用」，下方代理才会实际生效。 */}
          <SettingsRow
            label={intl.formatMessage({ id: "settings.httpProxyEnabled" })}
            description={intl.formatMessage({
              id: "settings.httpProxyEnabledDescription",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "settings.httpProxyEnabled" })}
                checked={httpProxyEnabled}
                onCheckedChange={(checked) => {
                  void onHttpProxyEnabledChange(checked);
                }}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.httpProxy" })}
            description={intl.formatMessage({ id: "settings.httpProxyDescription" })}
            control={
              <Button
                type="button"
                size="lg"
                disabled={!isHttpProxyDirty}
                onClick={() => void handleHttpProxySave()}
              >
                {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
              </Button>
            }
            detail={
              <Input
                size="lg"
                value={localHttpProxy}
                placeholder={intl.formatMessage({
                  id: "settings.httpProxyPlaceholder",
                })}
                onChange={(event) => {
                  setLocalHttpProxy(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isHttpProxyDirty) {
                    void handleHttpProxySave();
                  }
                }}
                className="max-w-[520px] font-mono"
              />
            }
          />
          {/* No Proxy 与 HTTP 代理共同决定同一出口策略，必须贴在代理地址下面。*/}
          <SettingsRow
            label={intl.formatMessage({ id: "settings.httpProxyNoProxy" })}
            description={intl.formatMessage({
              id: "settings.httpProxyNoProxyDescription",
            })}
            control={
              <Button
                type="button"
                size="lg"
                disabled={!isHttpProxyNoProxyDirty}
                onClick={() => void handleHttpProxyNoProxySave()}
              >
                {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
              </Button>
            }
            detail={
              <Input
                size="lg"
                value={localHttpProxyNoProxy}
                placeholder={intl.formatMessage({
                  id: "settings.httpProxyNoProxyPlaceholder",
                })}
                onChange={(event) => {
                  setLocalHttpProxyNoProxy(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isHttpProxyNoProxyDirty) {
                    void handleHttpProxyNoProxySave();
                  }
                }}
                className="max-w-[520px] font-mono"
              />
            }
          />
        </SettingsGroupCard>
      </section>

      {/* 自定义证书与代理是两个独立能力：直连场景也需要它，不放进「网络代理」分类、不受开关影响。 */}
      <section className="space-y-3">
        <div>
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.network.certificateTitle" })}
          </h3>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.network.certificateDescription" })}
          </p>
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.httpProxyCaCertPath" })}
            description={intl.formatMessage({
              id: "settings.httpProxyCaCertPathDescription",
            })}
            control={
              <Button
                type="button"
                size="lg"
                disabled={!isHttpProxyCaCertPathDirty}
                onClick={() => void handleHttpProxyCaCertPathSave()}
              >
                {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
              </Button>
            }
            detail={
              <Input
                size="lg"
                value={localHttpProxyCaCertPath}
                placeholder={intl.formatMessage({
                  id: "settings.httpProxyCaCertPathPlaceholder",
                })}
                onChange={(event) => {
                  setLocalHttpProxyCaCertPath(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isHttpProxyCaCertPathDirty) {
                    void handleHttpProxyCaCertPathSave();
                  }
                }}
                className="max-w-[520px] font-mono"
              />
            }
          />
        </SettingsGroupCard>
      </section>
    </div>
  );
}
