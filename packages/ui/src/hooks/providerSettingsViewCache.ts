/**
 * Provider 设置视图的 renderer 侧持久缓存。
 *
 * 规则见 docs/specs/provider-settings-cached-first.md：每次接受新 View 时落盘，
 * 冷挂载时用缓存立即渲染，第一条新鲜视图无条件覆盖（host 重启后 revision 会回退，
 * 缓存态不做 revision 比较）。持久化失败静默降级。
 */
import type { ProviderSettingsView } from "@zcode/services";

const CACHE_KEY = "zcode.provider-settings-view-cache.v1";

export interface CachedProviderSettingsView {
  readonly savedAt: number;
  readonly view: ProviderSettingsView;
}

export function readCachedProviderSettingsView(): CachedProviderSettingsView | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProviderSettingsView;
    if (typeof parsed?.savedAt !== "number" || !parsed.view || typeof parsed.view !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedProviderSettingsView(view: ProviderSettingsView): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), view }));
  } catch {
    // 隐私模式/配额满：缓存是纯优化，失败静默降级。
  }
}
