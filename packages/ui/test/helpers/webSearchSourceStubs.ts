// 隔离 fixture 的 Host/Service 边界替身。模板目录、候选识别、表单元数据与
// 弹窗交互全部走生产源码；这里只替换 useModelProviders、settings、intl、
// confirm 与 logger，避免连接真实 Host 或运行中的应用。

export const intlStub = `
const messages: Record<string, string> = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.delete": "Delete",
  "settings.webSearch.addSource": "Add search provider",
  "settings.webSearch.addTitle": "Add search provider",
  "settings.webSearch.addAction": "Add",
  "settings.webSearch.enabled": "Enable web search",
  "settings.webSearch.enabledDescription": "Enabled description",
  "settings.webSearch.activeBadge": "Active",
  "settings.webSearch.orderHint": "Order hint",
  "settings.webSearch.noKey": "No API key",
  "settings.webSearch.billingPerCall": "Per call",
  "settings.webSearch.billingPlan": "In plan",
  "settings.webSearch.moveUp": "Move up",
  "settings.webSearch.moveDown": "Move down",
  "settings.webSearch.dragHandle": "Drag to reorder",
  "settings.webSearch.refreshing": "Refresh",
  "settings.webSearch.emptyTitle": "No search providers",
  "settings.webSearch.emptyHint": "Empty hint",
  "settings.webSearch.openProviders": "Open provider settings",
  "settings.webSearch.sourceSettingsOpen": "Search provider settings",
  "settings.webSearch.sourceSettingsTitle": "{name}",
  "settings.webSearch.sourceSettingsDescription": "Key and proxy apply to this instance only.",
  "settings.webSearch.sourceTemplate": "Provider type",
  "settings.webSearch.apiKey": "API Key",
  "settings.webSearch.getKey": "Get an API key",
  "settings.webSearch.proxy": "Outbound proxy",
  "settings.webSearch.proxy.default": "Follow network settings",
  "settings.webSearch.proxy.proxy": "Use proxy",
  "settings.webSearch.proxy.direct": "Direct connection",
  "settings.webSearch.deleteTitle": "Delete search provider",
  "settings.webSearch.deleteDescription": "Delete {name} and its key and proxy settings.",
  "settings.webSearch.saveFailed": "Could not save the search provider. Try again.",
  "settings.webSearch.deleteFailed": "Could not delete the search provider. Try again.",
};

export function useZCodeIntl() {
  return {
    locale: "en-US",
    intl: {
      formatMessage(
        descriptor: { id: string },
        values?: Record<string, string | number>,
      ): string {
        let message = messages[descriptor.id] ?? descriptor.id;
        for (const [key, value] of Object.entries(values ?? {})) {
          message = message.replaceAll("{" + key + "}", String(value));
        }
        return message;
      },
    },
  };
}
`;

export const providerStub = `
export function isApiKeyAccess<T extends { readonly type: string }>(
  access: T | null | undefined,
): access is Extract<T, { readonly type: "api-key" | "zhipu-coding-plan-api-key" }> {
  return access?.type === "api-key" || access?.type === "zhipu-coding-plan-api-key";
}

export function resolveProviderTemplateName(
  templateId: string,
  template: { templateNameMap: { "zh-CN"?: string; "en-US"?: string } },
  locale: "zh-CN" | "en-US",
): string {
  return template.templateNameMap[locale]?.trim() || template.templateNameMap["en-US"]?.trim() || templateId;
}

export function resolveProviderDisplayMode(rule: {
  displayMode?: "expanded" | "submenu" | "hidden";
  isPrimary?: boolean;
}): "expanded" | "submenu" | "hidden" {
  if (rule.displayMode !== undefined) return rule.displayMode;
  return rule.isPrimary === true ? "expanded" : "submenu";
}
`;

export const loggerStub = `
function record(level: string, args: unknown[]) {
  (globalThis as any).__ws.logs.push(level + ": " + args.map((arg) => String(arg)).join(" "));
}
export const logger = {
  debug: (...args: unknown[]) => record("debug", args),
  info: (...args: unknown[]) => record("info", args),
  warn: (...args: unknown[]) => record("warn", args),
  error: (...args: unknown[]) => record("error", args),
};
`;

export const confirmStub = `
export function useConfirmDialog() {
  return async () => (globalThis as any).__ws.confirmResult;
}
`;

export const settingsPartsStub = `
import type { ReactNode } from "react";

export function SettingsGroupCard({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

export function SettingsRow({
  label,
  description,
  control,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div>
      <span>{label}</span>
      <span>{description}</span>
      {control}
    </div>
  );
}
`;

export const settingsStub = `
export function useSettings() {
  return {
    settings: (globalThis as any).__ws.settings,
    update: async (patch: unknown) => {
      (globalThis as any).__ws.updateCalls.push(patch);
      (globalThis as any).__ws.settings = {
        ...(globalThis as any).__ws.settings,
        ...(patch as Record<string, unknown>),
      };
    },
  };
}
`;

export const modelProvidersStub = `
import { useEffect, useMemo, useState } from "react";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";

type AnyProvider = Record<string, any>;

const probe = () => (globalThis as any).__ws;
let providers: AnyProvider[] = [];
const listeners = new Set<() => void>();

export function resetModelProviders(next: AnyProvider[]) {
  providers = next;
}

export function getModelProviders(): AnyProvider[] {
  return providers;
}

function emit() {
  for (const listener of listeners) listener();
}

export function replaceModelProviders(next: AnyProvider[]) {
  providers = next;
  emit();
}

function makeView(list: AnyProvider[]) {
  return {
    revision: 1,
    providerTemplates: [],
    providerOrder: [],
    providerGroupOrder: [],
    providers: list,
    modelGroups: [],
    modelGroupsPrimary: false,
  };
}

export function useModelProviders() {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const modelProviders = useMemo(
    () => projectProviderSettingsViewToFormProviders(makeView(providers)),
    [providers],
  );
  const createPersonalProvider = async (input: unknown) => {
    probe().createCalls.push(JSON.parse(JSON.stringify(input)));
    const result = await probe().createImpl(input);
    providers = [...providers, result.provider];
    emit();
    return { providerId: result.providerId, view: makeView(providers) };
  };
  const saveProvider = async (provider: any) => {
    probe().saveCalls.push(JSON.parse(JSON.stringify(provider)));
    await probe().saveImpl(provider);
    providers = providers.map((entry) =>
      entry.providerId === provider.providerId
        ? {
            ...entry,
            personalConfig: provider.personalConfig,
            effectiveConfig: { ...entry.effectiveConfig, ...provider.personalConfig },
            proxyMode: provider.proxyModeUpdate ?? entry.proxyMode,
          }
        : entry,
    );
    emit();
    return projectProviderSettingsViewToFormProviders(makeView(providers));
  };
  const deleteProvider = async (providerId: string) => {
    probe().deleteCalls.push(providerId);
    await probe().deleteImpl(providerId);
    providers = providers.filter((entry) => entry.providerId !== providerId);
    emit();
  };
  return {
    modelProviders,
    providerTemplates: probe().templates,
    loading: Boolean(probe().loading),
    reload: async () => {},
    createPersonalProvider,
    saveProvider,
    deleteProvider,
  };
}
`;
