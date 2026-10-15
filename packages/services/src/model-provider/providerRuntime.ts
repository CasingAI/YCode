import {
  NodeModelSelectionConfigRepository,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import {
  ProviderRegistryService,
  ProviderSettingsFacade,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSettingsMutationTarget,
  type ProviderSource,
} from "@zcode/provider";
import {
  createProviderConfigRuntime,
  type ProviderConfigRuntime,
  type ProviderConfigRuntimeOptions,
} from "./providerConfigRuntime.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createModelSelectionService,
  createProviderSettingsService,
  type IModelSelectionService,
  type IProviderSettingsService,
  type ModelSelectionConfiguredDefaultSource,
  type ProviderSettingsConnectivityTester,
} from "./providerFacadeServices.js";

export interface ProviderRuntimeOptions extends ProviderConfigRuntimeOptions {
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
}

export interface ProviderRuntimeDependencies {
  readonly configRuntime: ProviderConfigRuntime;
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly disposeAccountSource?: () => void;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly modelSelectionConfiguredDefaultSource?: ModelSelectionConfiguredDefaultSource;
  readonly disposeModelSelectionConfiguredDefaultSource?: () => void;
}

interface RefreshableProviderSource<TSnapshot> extends ProviderSource<TSnapshot> {
  refresh?(reason: string): Promise<TSnapshot>;
}

/**
 * 普通 API Provider 可以在账号能力尚未装配时独立运行。
 * Account Provider 由当前 Built-in revision 对齐的 access.entitled=false Overlay 显式 fail-closed。
 */
export class EmptyAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly configSource: ProviderSource<ProviderConfigSnapshot>) {}

  async read(): Promise<AccountProviderConfigSnapshot> {
    return createFailClosedAccountProviderConfigSnapshot(await this.configSource.read());
  }

  onDidChange(): () => void {
    return () => {};
  }
}

/** 组装一个进程内共享的 Provider Config、Registry 与 Facade。 */
export class ProviderRuntime {
  readonly configService: ProviderConfigRuntime["configService"];
  readonly registryService: ProviderRegistryService;
  readonly providerSettings: IProviderSettingsService;
  readonly modelSelection: IModelSelectionService;
  readonly #configRuntime: ProviderConfigRuntime;
  readonly #disposeAccountSource?: () => void;
  readonly #disposeBuiltinRecovery: () => void;
  readonly #modelSelectionRuntime: IModelSelectionService & { dispose(): void };
  readonly #disposeModelSelectionConfiguredDefaultSource?: () => void;
  #startPromise: ReturnType<ProviderRegistryService["start"]> | null = null;
  #disposed = false;

  constructor(dependencies: ProviderRuntimeDependencies) {
    this.#configRuntime = dependencies.configRuntime;
    this.#disposeAccountSource = dependencies.disposeAccountSource;
    this.#disposeModelSelectionConfiguredDefaultSource =
      dependencies.disposeModelSelectionConfiguredDefaultSource;
    this.configService = this.#configRuntime.configService;
    const accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot> =
      dependencies.accountSource ?? new EmptyAccountProviderConfigSource(this.configService);
    this.#disposeBuiltinRecovery = this.#configRuntime.onDidCheckZCodeBuiltin(async () => {
      const [config, account] = await Promise.all([
        this.configService.read(),
        accountSource.read(),
      ]);
      if (!this.#disposed && config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision) {
        await accountSource.refresh?.("builtin-account-recovery");
      }
    });
    this.registryService = new ProviderRegistryService({
      configSource: this.configService,
      accountSource,
    });
    const mutations = createSettingsMutationTarget(
      this.#configRuntime,
      this.registryService,
      accountSource,
    );
    const ensureReady = () => this.start();
    const settingsFacade = new ProviderSettingsFacade(this.registryService, mutations);
    this.providerSettings = createProviderSettingsService(
      settingsFacade,
      ensureReady,
      dependencies.testConnectivity,
    );
    this.#modelSelectionRuntime = createModelSelectionService(
      createNodeModelSelectionFacade(this.registryService),
      ensureReady,
      dependencies.modelSelectionConfiguredDefaultSource,
    );
    this.modelSelection = this.#modelSelectionRuntime;
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("ProviderRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    // settings 首屏 getView 会 await start()；分段计时用于定位启动链路慢的环节。
    // 惰性创建 logger：顶层实例化会碰 process.pid（见 refreshSources 内同款注释）。
    const runtimeStartedAt = Date.now();
    const startPromise = this.#configRuntime
      .start()
      .then(() => {
        createServiceLogger("provider-runtime").info(
          undefined,
          `config runtime start took ${Date.now() - runtimeStartedAt}ms`,
        );
        return { registryStartedAt: Date.now() };
      })
      .then(({ registryStartedAt }) =>
        this.registryService.start().then(() => ({ registryStartedAt })),
      )
      .then(({ registryStartedAt }) => {
        createServiceLogger("provider-runtime").info(
          undefined,
          `registry start took ${Date.now() - registryStartedAt}ms, total ${
            Date.now() - runtimeStartedAt
          }ms`,
        );
      });
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeBuiltinRecovery();
    this.#modelSelectionRuntime.dispose();
    this.registryService.dispose();
    this.#disposeAccountSource?.();
    this.#disposeModelSelectionConfiguredDefaultSource?.();
    this.#configRuntime.dispose();
  }
}

function createSettingsMutationTarget(
  configRuntime: ProviderConfigRuntime,
  registryService: ProviderRegistryService,
  accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot>,
): ProviderSettingsMutationTarget {
  const configService = configRuntime.configService;
  return {
    createPersonalProvider: (input) => configService.createPersonalProvider(input),
    savePersonalProviderOverlay: (providerId, config, membership, metadata) =>
      configService.savePersonalProviderOverlay(providerId, config, membership, metadata),
    deletePersonalProvider: (providerId) => configService.deletePersonalProvider(providerId),
    reorderPersonalProviders: (providerIds, providerGroupOrder) =>
      configService.reorderPersonalProviders(providerIds, providerGroupOrder),
    reorderPersonalModels: (providerId, modelIds, membership) =>
      configService.reorderPersonalModels(providerId, modelIds, membership),
    // 手工四参数转发曾丢掉新增的配置模式；直接绑定完整签名，避免装配层截断写入意图。
    addPersonalModel: configService.addPersonalModel.bind(configService),
    renamePersonalModel: (providerId, currentModelId, nextModelId, membership) =>
      configService.renamePersonalModel(providerId, currentModelId, nextModelId, membership),
    deletePersonalModel: (providerId, modelId, membership) =>
      configService.deletePersonalModel(providerId, modelId, membership),
    setPersonalModelEnabled: (providerId, modelId, enabled, membership) =>
      configService.setPersonalModelEnabled(providerId, modelId, enabled, membership),
    // 模型组与 Provider/Model 共用同一 configService 事务边界（docs/specs/model-group.md）。
    createPersonalModelGroup: (input) => configService.createPersonalModelGroup(input),
    renamePersonalModelGroup: (groupId, name) =>
      configService.renamePersonalModelGroup(groupId, name),
    deletePersonalModelGroup: (groupId) => configService.deletePersonalModelGroup(groupId),
    reorderPersonalModelGroups: (groupIds) => configService.reorderPersonalModelGroups(groupIds),
    setPersonalModelGroupMembers: (groupId, memberOrder) =>
      configService.setPersonalModelGroupMembers(groupId, memberOrder),
    setPersonalModelGroupEnabled: (groupId, enabled) =>
      configService.setPersonalModelGroupEnabled(groupId, enabled),
    setPersonalModelGroupsPrimary: (isPrimary) =>
      configService.setPersonalModelGroupsPrimary(isPrimary),
    savePersonalModelDraft: (
      providerId,
      originalModelId,
      nextModelId,
      config,
      expectedPersonalRevision,
      useRecommendedConfig,
      membership,
    ) =>
      configService.savePersonalModelDraft(
        providerId,
        originalModelId,
        nextModelId,
        config,
        expectedPersonalRevision,
        useRecommendedConfig,
        membership,
      ),
    refresh: (reason) => registryService.refresh(reason),
    refreshSources: async (reason) => {
      // 顶层调用 createServiceLogger 会碰 process.pid（deepseekBalanceService 同款教训），
      // 在刷新路径内惰性创建。
      const providerConfigLog = createServiceLogger("provider-config");
      // 内置远端配置刷新失败（如 CDN 配置过不了当前 schema，真机复现 2026-10-14：
      // "ZCode Built-in cdn: invalid schema at providerRules.0.config.group"）不得让
      // 整个 refresh 失败：runtime 已保留当前生效配置并回落内置，设置页必须能用，
      // 否则供应商管理整体瘫痪（UI 卡在加载中、依赖判定拿不到 view）。失败只降级记日志。
      const builtinRefresh = await configRuntime
        .refreshZCodeBuiltin({ force: true })
        .then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const accountRefresh = await (accountSource.refresh?.(reason) ?? Promise.resolve()).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const snapshot = await registryService.refresh(reason);
      // 账号源失败仍保持原语义：显式抛错（账号权益是执行事实，静默降级会放大成误判）。
      if (!accountRefresh.ok) throw accountRefresh.error;
      if (!builtinRefresh.ok) {
        providerConfigLog.warn("ZCode Built-in 远端刷新失败，沿用当前配置", {
          error: builtinRefresh.error,
        });
      }
      return snapshot;
    },
  };
}

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  const { accountSource, testConnectivity, ...configRuntimeOptions } = options;
  const configRuntime = createProviderConfigRuntime(configRuntimeOptions);
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: configRuntime.personalRepository,
  });
  return createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource,
    testConnectivity,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
  });
}

export function createProviderRuntimeFromConfigRuntime(
  dependencies: ProviderRuntimeDependencies,
): ProviderRuntime {
  return new ProviderRuntime(dependencies);
}
