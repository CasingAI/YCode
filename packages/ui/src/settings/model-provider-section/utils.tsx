import type { ReactNode } from "react";
import { PackageIcon } from "lucide-react";
import { ProviderLogo } from "./ProviderLogo.js";
import { type ModelProviderNavItem } from "./constants.js";

export function createCustomProviderNodeKey(id: string): string {
  return `custom:${id}`;
}

// 智谱剥离：preset/codingPlan/teamPlan 节点 key 已下线，保留函数签名兼容旧引用，
// 统一映射到 custom 节点（见 docs/specs/zhipu-special-removal.md）。
export function createPresetProviderNodeKey(id: string): string {
  return createCustomProviderNodeKey(id);
}

export function createCodingPlanProviderNodeKey(id: string): string {
  return createCustomProviderNodeKey(id);
}

export function resolveModelProviderNavLogo(item: ModelProviderNavItem) {
  return "provider" in item ? item.provider?.config.logo : undefined;
}

export function renderModelProviderNavIcon(item: ModelProviderNavItem): ReactNode {
  if ("provider" in item && item.provider) {
    return <ProviderLogo logo={resolveModelProviderNavLogo(item)} className="size-4" />;
  }
  return <PackageIcon className="size-4 shrink-0" />;
}

export function fuzzyMatch(text: string, query: string): boolean {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const queryParts = normalizedQuery.split(/\s+/).filter(Boolean);
  return queryParts.every((part) => {
    let searchIndex = 0;
    for (const char of part) {
      const foundIndex = normalizedText.indexOf(char, searchIndex);
      if (foundIndex < 0) {
        return false;
      }
      searchIndex = foundIndex + 1;
    }
    return true;
  });
}

export function handleEndpointSuggestionPopoverOpenAutoFocus({
  keepInputFocus,
  preventDefault,
  focusInput,
}: {
  keepInputFocus: boolean;
  preventDefault: () => void;
  focusInput: () => void;
}): boolean {
  if (!keepInputFocus) {
    return false;
  }

  preventDefault();
  focusInput();
  return true;
}

export function resolveEndpointSuggestionOpenRequest({
  nowMs,
  suppressOpenUntilMs,
}: {
  nowMs: number;
  suppressOpenUntilMs: number;
}): { shouldOpen: boolean } {
  return { shouldOpen: nowMs >= suppressOpenUntilMs };
}
