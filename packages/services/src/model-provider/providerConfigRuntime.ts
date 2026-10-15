import {
  NodeProviderConfigRuntime,
  type PersonalProviderConfigRecoveryEvent,
  type NodeProviderConfigRuntimeOptions,
} from "@zcode/provider-node";
import type { ModelProviderConfig } from "./legacyModelProviderSerialized.js";
import { getPersonalProviderConfigPath } from "../paths.js";
import { importLegacyPersonalProviderConfig } from "./legacyPersonalProviderConfigImporter.js";

export interface ProviderConfigRuntimeOptions {
  readonly zcodeBuiltinFilePath: string;
  readonly zcodeBuiltinActiveFilePath?: string;
  readonly zcodeBuiltinRemote?: NodeProviderConfigRuntimeOptions["zcodeBuiltinRemote"];
  readonly zcodeBuiltinEnvironment?: NodeProviderConfigRuntimeOptions["zcodeBuiltinEnvironment"];
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath?: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly readLegacyProviders?: () => Promise<readonly ModelProviderConfig[]>;
  readonly watch?: boolean;
}

/**
 * Services 装配层默认使用 YCode 个人配置，缺失时独立初始化。
 * 旧配置导入仅供显式调用方使用；生产启动不装配该入口。
 */
export class ProviderConfigRuntime {
  readonly configService: NodeProviderConfigRuntime["configService"];
  readonly #runtime: NodeProviderConfigRuntime;

  constructor(options: ProviderConfigRuntimeOptions) {
    const runtimeOptions: NodeProviderConfigRuntimeOptions = {
      zcodeBuiltinFilePath: options.zcodeBuiltinFilePath,
      zcodeBuiltinActiveFilePath: options.zcodeBuiltinActiveFilePath,
      zcodeBuiltinRemote: options.zcodeBuiltinRemote,
      zcodeBuiltinEnvironment: options.zcodeBuiltinEnvironment,
      onZCodeBuiltinRefreshError: options.onZCodeBuiltinRefreshError,
      onPersonalConfigRecovery: options.onPersonalConfigRecovery,
      onPersonalConfigPollingError: options.onPersonalConfigPollingError,
      personalFilePath: options.personalFilePath ?? getPersonalProviderConfigPath(),
      personalPollingIntervalMs: options.personalPollingIntervalMs,
      watch: options.watch,
      ...(options.readLegacyProviders
        ? {
            importLegacy: async () =>
              importLegacyPersonalProviderConfig({
                legacyProviders: await options.readLegacyProviders!(),
              }),
          }
        : {}),
    };
    this.#runtime = new NodeProviderConfigRuntime(runtimeOptions);
    this.configService = this.#runtime.configService;
  }

  start(): Promise<void> {
    return this.#runtime.start();
  }

  get personalRepository(): NodeProviderConfigRuntime["personalRepository"] {
    return this.#runtime.personalRepository;
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#runtime.resolveZCodeBuiltinActiveFilePath();
  }

  refreshZCodeBuiltin(options?: { readonly force?: boolean }) {
    return this.#runtime.refreshZCodeBuiltin(options);
  }

  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    return this.#runtime.onDidCheckZCodeBuiltin(listener);
  }

  dispose(): void {
    this.#runtime.dispose();
  }
}

export function createProviderConfigRuntime(
  options: ProviderConfigRuntimeOptions,
): ProviderConfigRuntime {
  return new ProviderConfigRuntime(options);
}
