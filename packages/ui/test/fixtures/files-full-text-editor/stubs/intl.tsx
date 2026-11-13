import { useMemo } from "react";
import type { ReactNode } from "react";

// 只替换 i18n 服务边界：真实组件里的 formatMessage 调用照常执行。
const MESSAGES: Record<string, string> = {
  "filesWorkbench.tabList": "打开的编辑器",
  "filesWorkbench.save": "保存",
  "filesWorkbench.saveAs": "另存为",
  "filesWorkbench.splitRight": "在右侧分屏",
  "filesWorkbench.splitDown": "在下方分屏",
  "filesWorkbench.closeTab": "关闭 {name}",
  "filesWorkbench.loadingFile": "正在加载文件…",
  "filesWorkbench.loadFileError": "加载文件失败",
  "filesWorkbench.fileTooLarge": "文件过大，无法在完整编辑器中打开",
  "filesWorkbench.retryLoadFile": "重试",
  "filesWorkbench.emptyEditor": "选择文件开始编辑",
  "filesWorkbench.externalChanged": "磁盘文件已变化",
  "filesWorkbench.reload": "重新加载",
  "filesWorkbench.keep": "保留",
  "workspaceFileTree.actions.busy": "文件操作进行中",
  "filesWorkbench.saveFailed": "保存 {path} 失败",
};

function formatMessage(
  descriptor: { id: string },
  values?: Record<string, string | number>,
): string {
  let message = MESSAGES[descriptor.id] ?? (descriptor.id.split(".").at(-1) ?? descriptor.id);
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, String(value));
  }
  return message;
}

export function useZCodeIntl() {
  const intl = useMemo(() => ({ formatMessage }), []);
  return useMemo(() => ({ intl, locale: "zh-CN" as const }), [intl]);
}

export function ZCodeIntlProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
