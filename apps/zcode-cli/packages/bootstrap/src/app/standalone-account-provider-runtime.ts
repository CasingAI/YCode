import { createHash } from "node:crypto";
import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import {
  createAccountProviderConfigSnapshot,
  ProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import type { ProviderFamilyDomain } from "@zcode/shared";

// 智谱剥离：zhipu-account access 与 Individual Coding Plan 目录已删除，
// standalone 账号体系下线，全部函数保留导出签名供登录流程引用，
// 内部返回空值/抛错占位。删除原因见 docs/specs/zhipu-special-removal.md。

interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  readonly modelId: string;
  readonly providerId: string;
}

export async function readStandaloneCodingPlanProviders(
  _env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return [];
}

export async function resolveStandaloneCodingPlanProvider(
  family: ProviderFamilyDomain,
  _env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneCodingPlanProvider> {
  throw new Error(`Standalone Coding Plan 已下线: ${family}`);
}

export function standaloneAccountIdentityCredentialKey(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) throw new Error("Standalone Account Provider ID 不能为空");
  return `account-provider:${normalized}:identity`;
}

/** Standalone Credential Store 私有键；不得进入 Provider Config、Model 或 Protocol。 */
export function standaloneAccountProviderCredentialKey(input: {
  readonly providerId: string;
  readonly accountIdentity: string;
}): string {
  const providerId = input.providerId.trim();
  const accountIdentity = input.accountIdentity.trim();
  if (!providerId) throw new Error("Standalone Account Provider ID 不能为空");
  if (!accountIdentity) throw new Error("Standalone Account Identity 不能为空");
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

/** 没有账号 Profile 的手工 Key 登录使用稳定、不可逆的连接身份。 */
export function createStandaloneAccountIdentityFromSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new Error("Standalone Account Secret 不能为空");
  return `key-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export async function readStandaloneAccountProviderConfigSnapshot(
  _credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  _env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<AccountProviderConfigSnapshot> {
  return createAccountProviderConfigSnapshot(
    config?.revision ?? "standalone-removed",
    ProviderConfigMap.empty(),
  );
}

export async function hasStandaloneCodingPlanAccess(
  _credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  _env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return false;
}

export function createStandaloneProviderRuntimeHeadersPort(
  _credentialStore: Pick<SharedZCodeCredentialStore, "load" | "loadMany">,
  _env: Readonly<Record<string, string | undefined>>,
): ProviderRuntimeHeadersPort {
  return {
    shouldRefreshBeforeModelRequest() {
      return false;
    },
    async refreshBeforeModelRequest(input) {
      input.abortSignal?.throwIfAborted();
      throw new Error(`Standalone Account Provider 已下线: ${input.providerId.trim()}`);
    },
  };
}
