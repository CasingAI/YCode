import { useLayoutEffect, type RefObject } from "react";
import type { FilesEditorLayoutNode } from "@/files-workbench/filesEditorLayout.js";
import {
  resolveFilesWorkbenchTabChrome,
  type FilesWorkbenchTabChrome,
} from "@/files-workbench/filesWorkbenchTabChrome.js";

const TAB_CHROME_PROPERTIES = [
  ["--files-tabbar-leading-inset", "leadingInsetPx"],
  ["--files-tabbar-trailing-inset", "trailingInsetPx"],
  ["--files-tabbar-top-inset", "topInsetPx"],
  ["--files-tabbar-height", "heightPx"],
] as const;

/** 一个观察器派生所有编辑器组的局部避让；布局变量只属于对应 Tab 节点。 */
export function observeFilesWorkbenchTabChrome(surface: HTMLElement): () => void {
  const scope = surface.closest<HTMLElement>("[data-workspace-shell]");
  const actions = scope?.querySelector<HTMLElement>("[data-workspace-caption-actions]");
  const controls = surface.querySelector<HTMLElement>("[data-files-workbench-window-controls]");
  const rows = Array.from(surface.querySelectorAll<HTMLElement>('[role="tablist"]'));
  const view = surface.ownerDocument.defaultView;
  const previous = new Map<HTMLElement, FilesWorkbenchTabChrome>();
  let disposed = false;
  const measure = () => {
    if (disposed) return;
    const surfaceRect = surface.getBoundingClientRect();
    const scopeRect = scope?.getBoundingClientRect() ?? surfaceRect;
    const actionsRect = actions?.getBoundingClientRect();
    const controlsRect = controls?.getBoundingClientRect();
    // 左侧占用从窗口作用域左沿起算，包含交通灯的前置安全区；
    // 浮层外盒还含侧栏和 Windows 尾部 padding，不能拿整个浮层来挤压标签。
    const leadingBlocker =
      actionsRect && actionsRect.right > actionsRect.left && actionsRect.bottom > actionsRect.top
        ? {
            left: scopeRect.left,
            right: actionsRect.right + 8,
            top: scopeRect.top,
            bottom: actionsRect.bottom + 4,
          }
        : undefined;
    const trailingBlocker =
      controlsRect &&
      controlsRect.right > controlsRect.left &&
      controlsRect.bottom > controlsRect.top
        ? {
            left: controlsRect.left - 8,
            right: surfaceRect.right,
            top: surfaceRect.top,
            bottom: controlsRect.bottom + 4,
          }
        : undefined;
    // 先读完全部矩形再写样式，避免某组的局部下移改变同一轮剩余组的读取结果。
    const projections = rows.map((row) => ({
      row,
      chrome: resolveFilesWorkbenchTabChrome({
        row: row.getBoundingClientRect(),
        leadingBlocker,
        trailingBlocker,
      }),
    }));
    for (const { row, chrome } of projections) {
      const last = previous.get(row);
      for (const [property, key] of TAB_CHROME_PROPERTIES) {
        if (last?.[key] !== chrome[key]) row.style.setProperty(property, `${chrome[key]}px`);
      }
      previous.set(row, chrome);
    }
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  const targets = new Set<HTMLElement>(rows);
  targets.add(surface);
  if (actions) targets.add(actions);
  // 平台 padding 平移按钮但不改变按钮本身大小，必须一起观察承载 padding 的父层。
  if (actions?.parentElement) targets.add(actions.parentElement);
  if (controls) targets.add(controls);
  for (const target of targets) observer?.observe(target);
  view?.addEventListener("resize", measure);
  measure();

  return () => {
    disposed = true;
    observer?.disconnect();
    view?.removeEventListener("resize", measure);
    for (const row of rows) {
      for (const [property] of TAB_CHROME_PROPERTIES) row.style.removeProperty(property);
    }
    previous.clear();
  };
}

export function useFilesWorkbenchTabChrome({
  surfaceRef,
  layoutRoot,
  isDesktop,
  isActiveView,
}: {
  surfaceRef: RefObject<HTMLElement | null>;
  layoutRoot: FilesEditorLayoutNode;
  isDesktop: boolean;
  isActiveView: boolean;
}): void {
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !isDesktop || !isActiveView) return;
    return observeFilesWorkbenchTabChrome(surface);
  }, [surfaceRef, layoutRoot, isDesktop, isActiveView]);
}
