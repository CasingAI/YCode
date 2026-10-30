import { useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

// 只替换 i18n 服务边界：真实组件里的所有 formatMessage 调用照常执行。
// 固定默认 zh-CN，并支持运行时切到最小 en-US，用于窄屏英文文案布局断言。
export type FixtureLocale = "zh-CN" | "en-US";

const MESSAGES: Record<FixtureLocale, Record<string, string>> = {
  "zh-CN": {
    "filesWorkbench.tabList": "打开的编辑器",
    "filesWorkbench.save": "保存",
    "filesWorkbench.saveAs": "另存为",
    "filesWorkbench.splitRight": "在右侧分屏",
    "filesWorkbench.splitDown": "在下方分屏",
    "filesWorkbench.closeTab": "关闭 {name}",
    "codeViewer.markdownMode": "Markdown",
    "codeViewer.markdownPreview": "预览",
    "codeViewer.markdownSource": "源码",
    "filesWorkbench.markdownMode": "Markdown",
    "filesWorkbench.markdownPreview": "预览",
    "filesWorkbench.markdownSource": "源码",
    "filesWorkbench.previewMarkdown": "预览",
    "filesWorkbench.sourceMarkdown": "源码",
  },
  "en-US": {
    "filesWorkbench.tabList": "Open editors",
    "filesWorkbench.save": "Save",
    "filesWorkbench.saveAs": "Save as",
    "filesWorkbench.splitRight": "Split editor to the right",
    "filesWorkbench.splitDown": "Split editor down",
    "filesWorkbench.closeTab": "Close {name}",
    "codeViewer.markdownMode": "Markdown",
    "codeViewer.markdownPreview": "Preview",
    "codeViewer.markdownSource": "Source",
    "filesWorkbench.markdownMode": "Markdown",
    "filesWorkbench.markdownPreview": "Preview",
    "filesWorkbench.markdownSource": "Source",
    "filesWorkbench.previewMarkdown": "Preview",
    "filesWorkbench.sourceMarkdown": "Source",
  },
};

let currentLocale: FixtureLocale = "zh-CN";
const listeners = new Set<() => void>();

export function getFixtureLocale(): FixtureLocale {
  return currentLocale;
}

export function setFixtureLocale(next: FixtureLocale) {
  if (next !== "zh-CN" && next !== "en-US") return;
  if (next === currentLocale) return;
  currentLocale = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function fallback(locale: FixtureLocale, id: string): string {
  const lower = id.toLowerCase();
  if (locale === "zh-CN") {
    if (lower.includes("source")) return "源码";
    if (lower.includes("preview")) return "预览";
    if (lower.includes("save")) return "保存";
  }
  return id.split(".").at(-1) ?? id;
}

function formatMessage(
  locale: FixtureLocale,
  descriptor: { id: string },
  values?: Record<string, string | number>,
): string {
  let message = MESSAGES[locale][descriptor.id] ?? fallback(locale, descriptor.id);
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, String(value));
  }
  return message;
}

export function useZCodeIntl() {
  const locale = useSyncExternalStore(subscribe, getFixtureLocale, getFixtureLocale);
  const intl = useMemo(
    () => ({
      formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) =>
        formatMessage(locale, descriptor, values),
    }),
    [locale],
  );
  return useMemo(() => ({ intl, locale }), [intl, locale]);
}

export function ZCodeIntlProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
