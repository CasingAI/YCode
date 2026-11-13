import type { ReactNode } from "react";

function pushToast(message: string): number {
  const root = globalThis as typeof globalThis & { __fullTextE2E?: { toasts?: string[] } };
  root.__fullTextE2E ??= {};
  root.__fullTextE2E.toasts ??= [];
  root.__fullTextE2E.toasts.push(message);
  return root.__fullTextE2E.toasts.length;
}

// 只替换通知服务边界，避免真实 ToastProvider 依赖。
export function toast(message: string): number {
  return pushToast(String(message));
}

export function Toaster({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
