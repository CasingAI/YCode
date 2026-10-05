/**
 * 宿主合成层失效时的兜底重绘：按平台给出应该绑定的事件名。
 *
 * 依据：带宿主材质的窗口（Windows Acrylic、macOS vibrancy）在 hide/show、遮挡恢复与
 * resize 之后可能继续复用失效的合成 surface —— renderer 与 host 都还活着，画面却停在
 * 上一帧的残影。Windows 上的现象是窗口只剩宿主底色，macOS 上表现为局部文字层停住、
 * 例如新建页问候语只剩一层很淡的字影（已在真实 Chromium 里核对过该页 DOM/CSS 正常：
 * 字号、颜色、opacity、无任何覆盖层，因此与页面样式无关）。
 *
 * 事件集合的差异来自触发路径本身：
 * - macOS 主窗口默认一直 visible，从后台或被遮挡状态重新激活只发 focus/restore，
 *   不发 show，只绑 resized/show 覆盖不到 vibrancy surface 最容易失效的那条路径。
 * - Linux 是 frameless + transparent，没有宿主合成材质，成因与现象都不同，不纳入。
 */
export function resolveWindowCompositingRepaintEvents(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return ["resized", "show"];
  }
  if (platform === "darwin") {
    return ["resized", "show", "restore", "focus"];
  }
  return [];
}
