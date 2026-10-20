import { desktopMenuMessageIds, getDesktopMenuMessage, type Locale } from "@zcode/shared";

/**
 * 菜单文案：按应用语言取菜单条目标题。
 *
 * 顶层菜单不用 Electron 的 editMenu / windowMenu role，否则文案会跟着系统语言走，
 * 和应用内语言混用后出现中英混排。
 */
export function getDesktopMenuLabel(
  locale: Locale,
  id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds],
) {
  return getDesktopMenuMessage(locale, id);
}
