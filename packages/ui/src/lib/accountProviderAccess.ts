import type { ProviderSettingsView } from "@zcode/services";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";

export interface EntitledAccountProviderAccess {
  readonly providerId: string;
  readonly access: ZCodeProviderAccountAccess;
  readonly label?: string;
}

// 智谱剥离：zhipu-account 账号体系已下线，provider access 不再有 zhipu-account 类型
//（见 docs/specs/zhipu-special-removal.md）。以下 helper 保留签名供调用方兼容，一律返回 null/空，
// 调用方不得再依赖账号权益做展示分支。
export function resolveEntitledAccountProviderAccess(
  _view: ProviderSettingsView | null | undefined,
  _providerId: string,
): EntitledAccountProviderAccess | null {
  return null;
}

export function resolveAccountProviderInspectionFingerprint(
  _view: ProviderSettingsView | null | undefined,
  _providerId: string,
): string {
  return "";
}

export function resolveEntitledAccountProviderAccessFingerprint(
  _view: ProviderSettingsView | null | undefined,
  _providerId: string,
): string {
  return "";
}

/**
 * 套餐只读查询已随账号体系下线，保留签名兼容调用方，一律返回 null。
 */
export function resolveAccountProviderInspectionAccess(
  _view: ProviderSettingsView | null | undefined,
  _providerId: string,
): EntitledAccountProviderAccess | null {
  return null;
}
