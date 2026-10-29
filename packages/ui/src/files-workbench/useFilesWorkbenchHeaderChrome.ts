import { useLayoutEffect, type RefObject } from "react";
import {
  resolveFilesWorkbenchHeaderChrome,
  type FilesWorkbenchHeaderChrome,
} from "@/files-workbench/filesWorkbenchHeaderChrome.js";

const HEADER_CHROME_PROPERTIES = [
  ["--files-workbench-header-leading-inset", "leadingInsetPx"],
  ["--files-workbench-header-trailing-inset", "trailingInsetPx"],
] as const;

/**
 * 观察 Web 文件工作台顶带与全局操作组、窗控的真实矩形。
 *
 * 平台 padding 会平移按钮但不改变按钮尺寸，所以连承载 padding 的父层一起观察；
 * 只在投影变化时写对应顶带节点的 CSS 变量，不进入 Zustand 或持久化。
 */
export function observeFilesWorkbenchHeaderChrome(header: HTMLElement): () => void {
  const scope = header.closest<HTMLElement>("[data-workspace-shell]");
  const actions = scope?.querySelector<HTMLElement>("[data-workspace-caption-actions]");
  const controls = scope?.querySelector<HTMLElement>("[data-files-workbench-window-controls]");
  const view = header.ownerDocument.defaultView;
  let previous: FilesWorkbenchHeaderChrome | undefined;
  let disposed = false;

  const measure = () => {
    if (disposed) return;
    const row = header.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const controlsRect = controls?.getBoundingClientRect();
    const chrome = resolveFilesWorkbenchHeaderChrome({
      row,
      leadingBlocker: actionsRect,
      trailingBlocker: controlsRect,
    });
    if (previous) {
      for (const [property, key] of HEADER_CHROME_PROPERTIES) {
        if (previous[key] !== chrome[key]) header.style.setProperty(property, `${chrome[key]}px`);
      }
    } else {
      for (const [property, key] of HEADER_CHROME_PROPERTIES) {
        header.style.setProperty(property, `${chrome[key]}px`);
      }
    }
    previous = chrome;
  };

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  const targets = new Set<HTMLElement>([header]);
  if (actions) targets.add(actions);
  if (actions?.parentElement) targets.add(actions.parentElement);
  if (controls) targets.add(controls);
  for (const target of targets) observer?.observe(target);
  view?.addEventListener("resize", measure);
  measure();

  return () => {
    disposed = true;
    observer?.disconnect();
    view?.removeEventListener("resize", measure);
    for (const [property] of HEADER_CHROME_PROPERTIES) header.style.removeProperty(property);
    previous = undefined;
  };
}

export function useFilesWorkbenchHeaderChrome({
  headerRef,
  isDesktop,
  isActiveView,
}: {
  headerRef: RefObject<HTMLElement | null>;
  isDesktop: boolean;
  isActiveView: boolean;
}): void {
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header || isDesktop || !isActiveView) return;
    return observeFilesWorkbenchHeaderChrome(header);
  }, [headerRef, isDesktop, isActiveView]);
}
