import {
  ApiKeyAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ModelId,
  type ProviderId,
} from "./config/index.js";
import type {
  AccountProviderResolveInput,
  AccountProviderResolver,
} from "./account-provider-service.js";
import type {
  AccountProviderState,
  AccountProviderUnavailableReason,
} from "./account-provider-state.js";

export type AccountProviderConnectionResult = {
  /** 账号/组织身份变化后禁止沿用旧快照；仅用于本轮解析，不进入配置。 */
  readonly resetPrevious?: boolean;
  readonly current?: boolean;
  readonly connectionKey?: string;
  readonly effectiveAt?: number;
} & (
  | {
      readonly providerId: ProviderId;
      readonly status: "available" | "pending";
      readonly models?: readonly ModelId[];
    }
  | {
      readonly providerId: ProviderId;
      readonly status: "unavailable" | "unknown";
      /** 仅在 status === "unavailable" 时携带；unknown 表示本轮无法判定原因。 */
      readonly unavailableReason?: AccountProviderUnavailableReason;
    }
);

export interface ResolveAccountProviderConfigsInput {
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly connections: readonly AccountProviderConnectionResult[];
}

export type AccountProviderConnectionResolver = (
  input: Omit<AccountProviderResolveInput, "previousProviders">,
) => Promise<readonly AccountProviderConnectionResult[]>;

// 智谱剥离：zhipu-account 权益投影已删除，entitled 统一为 false，占位等待后续接入层重建。
// 删除原因：Zhipu account 供应商体系下线，定义层不再维护 zhipu-account access。
export function createAccountProviderConfigResolver(
  resolveConnections: AccountProviderConnectionResolver,
): AccountProviderResolver {
  return async (input) => {
    const connections = await resolveConnections({
      configRevision: input.configRevision,
      configuredProviders: input.configuredProviders,
      reasons: input.reasons ?? [],
    });
    const providers = resolveAccountProviderConfigs({
      configuredProviders: input.configuredProviders,
      previousProviders: input.previousProviders,
      connections,
    });
    const states: Record<string, AccountProviderState> = {};
    for (const connection of connections) {
      const previous = connection.resetPrevious
        ? undefined
        : input.previousStates?.[connection.providerId];
      // unknown 仅保留上次展示事实；current 始终来自本轮选择，不能复活旧连接。
      // 原因字段与 availability 同规则：unknown 沿用上一轮，避免一次网络抖动把
      // "明确无权益"降级成原因未知。
      const unavailableReason =
        connection.status === "unknown" && previous
          ? previous.unavailableReason
          : connection.status === "unavailable"
            ? connection.unavailableReason
            : undefined;
      states[connection.providerId] = Object.freeze({
        ...(connection.status === "unknown" ? previous : {}),
        availability:
          connection.status === "unknown" && previous ? previous.availability : connection.status,
        entitled: false,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        ...(connection.current === undefined ? {} : { current: connection.current }),
        connectionKey: connection.connectionKey,
        ...(connection.effectiveAt === undefined ? {} : { effectiveAt: connection.effectiveAt }),
      });
    }
    return Object.freeze({ providers, states: Object.freeze(states) });
  };
}

/** 把账号连接结果转换为 Registry 使用的第三层 Account Provider Config。 */
// 智谱剥离：zhipu-account 约束分支已删除，仅保留连接结果到空 Overlay 的投影。
export function resolveAccountProviderConfigs(
  input: ResolveAccountProviderConfigsInput,
): ProviderConfigMap {
  const connectionByProviderId = indexConnections(input.configuredProviders, input.connections);
  const resolved: Array<readonly [ProviderId, ProviderConfig]> = [];
  for (const [providerId] of input.configuredProviders.entries()) {
    const connection = connectionByProviderId.get(providerId);
    if (!connection) continue;

    if (connection.status === "available" || connection.status === "pending") {
      if (connection.status === "available" && connection.models) {
        const models = normalizeModelIds(connection.models);
        resolved.push([
          providerId,
          new ProviderConfig({
            access: new ApiKeyAccessConfig(),
            builtinModelIds: models,
          }),
        ]);
        continue;
      }
      resolved.push([providerId, new ProviderConfig({ access: new ApiKeyAccessConfig() })]);
      continue;
    }

    if (connection.status === "unavailable") {
      resolved.push([providerId, createEntitlementOverlay()]);
      continue;
    }

    const previous = connection.resetPrevious ? undefined : input.previousProviders.get(providerId);
    if (previous) {
      resolved.push([providerId, previous]);
    } else {
      resolved.push([providerId, createEntitlementOverlay()]);
    }
  }

  return new ProviderConfigMap(resolved);
}

function createEntitlementOverlay(): ProviderConfig {
  return new ProviderConfig({ access: new ApiKeyAccessConfig() });
}

function indexConnections(
  configuredProviders: ProviderConfigMap,
  connections: readonly AccountProviderConnectionResult[],
): ReadonlyMap<ProviderId, AccountProviderConnectionResult> {
  const result = new Map<ProviderId, AccountProviderConnectionResult>();
  for (const connection of connections) {
    if (result.has(connection.providerId)) {
      throw new Error(`重复 Account Provider 连接结果: ${connection.providerId}`);
    }
    const configured = configuredProviders.get(connection.providerId);
    if (!configured) {
      throw new Error(`Account 连接指向未配置 Provider: ${connection.providerId}`);
    }
    result.set(connection.providerId, connection);
  }
  return result;
}

function normalizeModelIds(values: readonly ModelId[] | null | undefined): readonly ModelId[] {
  const result: ModelId[] = [];
  for (const value of values ?? []) {
    const modelId = value.trim();
    if (!modelId) continue;
    result.push(modelId);
  }
  return Object.freeze(result);
}
