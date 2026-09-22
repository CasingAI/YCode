// 窄视口（手机、被拖窄的窗口）断点。取 768 与仓库既有的 max-md 用法
// （WorkspaceHeaderSections 的 max-md:*、markdown-table 的 768 阈值）对齐，
// 避免外壳再引入第二套断点定义。
export const NARROW_VIEWPORT_MAX_WIDTH_PX = 768;

// Tailwind 的 max-md 等价于 max-width: 767.98px。这里显式写出小数而不是 768，
// 保证 768px 整宽按「宽视口」处理，与 CSS 侧的 max-md 判定一致。
export const NARROW_VIEWPORT_MEDIA_QUERY = "(max-width: 767.98px)";

function canMatchNarrowViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

export function readNarrowViewportSnapshot(): boolean {
  if (!canMatchNarrowViewport()) {
    return false;
  }

  return window.matchMedia(NARROW_VIEWPORT_MEDIA_QUERY).matches;
}

// 供 useSyncExternalStore 订阅；函数定义在模块作用域，引用稳定。
export function subscribeNarrowViewport(onStoreChange: () => void): () => void {
  if (!canMatchNarrowViewport()) {
    return () => {};
  }

  const query = window.matchMedia(NARROW_VIEWPORT_MEDIA_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}
