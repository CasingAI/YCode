import { logger } from "@/logger.js";

// 智谱剥离：account:* 套餐身份已下线，侧栏不再有按套餐的来源偏好
//（见 docs/specs/zhipu-special-removal.md）。类型退化为普通字符串，
// 读写函数保留签名兼容既有调用方，语义改为“无偏好”。
export type SidebarUsageCodingPlanProviderId = string;
export type SidebarUsageCodingPlanSourceId = string;

const SIDEBAR_USAGE_CODING_PLAN_PROVIDER_STORAGE_KEY = "zcode:sidebar-usage-coding-plan-provider";

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // WebView 隐私模式或移动端远控容器可能禁用 localStorage。
    // 这里只影响 footer 的 provider 选择记忆，失败时降级为本次默认选择即可。
    logger.warn("[sidebarUsageCodingPlanProviderPreference] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function readSidebarUsageCodingPlanSourcePreference():
  | SidebarUsageCodingPlanSourceId
  | undefined {
  const storage = getLocalStorage();
  if (!storage) {
    return undefined;
  }
  try {
    const value = storage.getItem(SIDEBAR_USAGE_CODING_PLAN_PROVIDER_STORAGE_KEY);
    return value?.trim() ? value : undefined;
  } catch (error) {
    logger.warn("[sidebarUsageCodingPlanProviderPreference] 读取偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function writeSidebarUsageCodingPlanProviderPreference(
  providerId: SidebarUsageCodingPlanSourceId,
): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(SIDEBAR_USAGE_CODING_PLAN_PROVIDER_STORAGE_KEY, providerId);
  } catch (error) {
    logger.warn("[sidebarUsageCodingPlanProviderPreference] 写入偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
