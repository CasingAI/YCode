import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderConfigService,
  ProviderTemplate,
  ProviderTemplateMap,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { cliProxyChannelFromTemplateId } from "@zcode/shared";
import { resolveCliProxyProviderEndpointPatch } from "../src/cli-proxy/cliProxy.js";
import {
  resolveCliProxyCredentialChannels,
  runCliProxyCredentialMirror,
} from "../src/cli-proxy/cliProxyMirror.js";

// 集成回归（真链路，非 mock）：凭据镜像引擎 → ProviderConfigService → Registry。
// 锁两条真机教训：
// 1. 种子条目在端点投影（端口/data.key）之前配置不完整，必须被 Registry 排除；
//    投影之后必须能进模型选择器（resolveCliProxyProviderEndpointPatch 链路）。
// 2. 隐藏/恢复走 visibility 稀疏 overlay，不整条替换配置。

/** 复用仓库内置模型规则全集（通配兜底提供模型完备性，与线上一致）。 */
function builtinModelRules(): ModelConfigRules {
  const raw = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    config: {
      modelConfigRules: {
        modelRules: Array<{ modelMatch: string; config: Record<string, unknown> }>;
        modelApiRules: Array<{
          modelMatch: string;
          apiTypeMatch: string;
          config: Record<string, unknown>;
        }>;
        providerSiteRules: Array<{
          modelMatch: string;
          apiTypeMatch?: string;
          baseUrlMatch: string;
          config: Record<string, unknown>;
        }>;
        templateModelRules: Array<{
          templateId: string;
          modelId: string;
          config: Record<string, unknown>;
        }>;
        builtinProviderModelRules: Array<{
          providerId: string;
          modelId: string;
          config: Record<string, unknown>;
        }>;
      };
    };
  };
  const m = raw.config.modelConfigRules;
  return new ModelConfigRules([
    ...m.modelRules.map((rule) => ({
      type: "model" as const,
      modelMatch: rule.modelMatch,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.modelApiRules.map((rule) => ({
      type: "model-api" as const,
      modelMatch: rule.modelMatch,
      apiTypeMatch: rule.apiTypeMatch,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.providerSiteRules.map((rule) => ({
      type: "provider-site" as const,
      modelMatch: rule.modelMatch,
      apiTypeMatch: rule.apiTypeMatch,
      baseUrlMatch: rule.baseUrlMatch,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.templateModelRules.map((rule) => ({
      type: "template-model" as const,
      templateId: rule.templateId,
      modelId: rule.modelId,
      config: ModelConfig.fromData(rule.config),
    })),
    ...m.builtinProviderModelRules.map((rule) => ({
      type: "provider-model" as const,
      providerId: rule.providerId,
      modelId: rule.modelId,
      config: ModelConfig.fromData(rule.config),
    })),
  ]);
}

class StaticSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #snapshot: ProviderConfigLayerSnapshot;
  constructor(snapshot: ProviderConfigLayerSnapshot) {
    this.#snapshot = snapshot;
  }
  async read(): Promise<ProviderConfigLayerSnapshot> {
    return this.#snapshot;
  }
  onDidChange(): () => void {
    return () => undefined;
  }
}

class MemoryPersonalRepository implements PersonalProviderConfigRepository {
  readonly #listeners = new Set<(reason: string) => void>();
  #revision = 0;
  #snapshot: ProviderConfigLayerSnapshot;
  constructor(snapshot: Omit<ProviderConfigLayerSnapshot, "revision">) {
    this.#snapshot = Object.freeze({ ...snapshot, revision: "personal-0" });
  }
  async read(): Promise<ProviderConfigLayerSnapshot> {
    return this.#snapshot;
  }
  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async update(
    transform: (
      current: ProviderConfigLayerSnapshot,
    ) => Omit<ProviderConfigLayerSnapshot, "revision">,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#revision += 1;
    this.#snapshot = Object.freeze({
      ...transform(this.#snapshot),
      revision: `personal-${this.#revision}`,
    });
    for (const listener of this.#listeners) listener("test");
    return this.#snapshot;
  }
}

/** 与 config/provider/zcode-builtin.json 的 cliproxy-codex 模板同构（真配置）。 */
function builtinSnapshot(): ProviderConfigLayerSnapshot {
  return {
    revision: "builtin-1",
    providers: ProviderConfigMap.empty(),
    providerTemplates: new ProviderTemplateMap([
      [
        "cliproxy-codex",
        new ProviderTemplate({
          templateId: "cliproxy-codex",
          templateNameMap: { "zh-CN": "Codex", "en-US": "Codex" },
          config: new ProviderConfig({
            access: new ApiKeyAccessConfig({
              type: "api-key",
              apiKeyManagementUrl: "https://chatgpt.com/codex",
            }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "http://127.0.0.1:8317/v1",
            }),
          }),
        }),
      ],
    ]),
    models: builtinModelRules(),
    discoveredModelRules: ModelConfigRules.empty(),
  };
}

function createService() {
  const repository = new MemoryPersonalRepository({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    discoveredModelRules: ModelConfigRules.empty(),
  });
  const service = new ProviderConfigService({
    zcodeBuiltinSource: new StaticSource(builtinSnapshot()),
    personalRepository: repository,
  });
  return { repository, service };
}

function channelTemplates(snapshot: ProviderConfigSnapshot) {
  return snapshot.zcodeBuiltinProviderTemplates.entries().flatMap(([templateId]) => {
    const channel = cliProxyChannelFromTemplateId(templateId);
    return channel ? [{ channel, templateId }] : [];
  });
}

async function personalEntries(service: ProviderConfigService) {
  const snapshot = await service.read();
  return {
    snapshot,
    providers: snapshot.personalProviders.rules().map((rule) => ({
      providerId: rule.providerId,
      templateId: rule.templateId ?? null,
    })),
  };
}

async function resolveRegistry(service: ProviderConfigService) {
  const snapshot = await service.read();
  return {
    snapshot,
    resolution: new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: snapshot.zcodeBuiltinProviders,
      zcodeBuiltinProviderTemplates: snapshot.zcodeBuiltinProviderTemplates,
      personalProviders: snapshot.personalProviders,
      zcodeBuiltinModelRules: snapshot.zcodeBuiltinModelRules,
      personalModels: snapshot.personalModels,
      accountProviders: ProviderConfigMap.empty(),
    }),
  };
}

test("镜像全链：种子 → Registry 排除 → 端点投影进 Registry → 模型同步 → 隐藏/恢复", async () => {
  const { service } = createService();
  const templates = channelTemplates(await service.read());
  assert.deepEqual(templates, [{ channel: "codex", templateId: "cliproxy-codex" }]);

  // 真实文件名样本 → 渠道识别。
  assert.deepEqual(resolveCliProxyCredentialChannels(["codex-77bf18ea-user@gmail.com-pro.json"]), [
    "codex",
  ]);

  const modelIds = ["gpt-6", "gpt-6-codex"];
  const ports = {
    createProviderFromTemplate: (templateId: string) =>
      service.createPersonalProvider({ templateId }),
    // 直连 ProviderConfigService（Host 走 facade，多一层 parse/成员解析，落地写入同源）：
    // overlay 入参必须是 ProviderConfig 实例；addPersonalModel 第 4 参是 membership，
    // useRecommendedConfig 在第 5 位（facade 层才收窄成 4 参）。
    saveProviderVisibility: (providerId: string, visibility: "visible" | "hidden") =>
      service.savePersonalProviderOverlay(providerId, new ProviderConfig({ visibility })),
    syncModels: async (providerId: string) => {
      for (const modelId of modelIds) {
        await service.addPersonalModel(providerId, modelId, ModelConfig.fromData({}), undefined, true);
      }
    },
    refreshVisibleProviderCapabilities: async () => {},
  };

  // 1) startup 种子。
  const seeded = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: ["codex"],
    channelTemplates: templates,
    providers: [],
    state: { version: 1, channels: {} },
    ports,
  });
  const providerId = seeded.nextState.channels.codex?.providerId;
  assert.ok(providerId);

  // 2) 端点投影前：配置不完整（无 apiKey）→ Registry 排除（真机根因回归）。
  {
    const { snapshot, resolution } = await resolveRegistry(service);
    const rule = snapshot.personalProviders.getRule(providerId);
    assert.ok(rule, "种子条目必须写入个人层");
    assert.equal(rule.templateId, "cliproxy-codex");
    assert.equal(
      resolution.registryProviders.some((p) => p.providerId === providerId),
      false,
      "投影前不得进入模型选择器",
    );
  }

  // 3) 端点投影（Host syncEndpoints 同款）：生效配置取自 Resolver（与视图
  // effectiveConfig 同源，模板 overlay 已合并），补 data.key 后进 Registry。
  const { providers } = await personalEntries(service);
  const mirrorRun = await runCliProxyCredentialMirror({
    phase: "running",
    channels: ["codex"],
    channelTemplates: templates,
    providers,
    state: seeded.nextState,
    ports,
  });
  {
    const { resolution } = await resolveRegistry(service);
    const effective = resolution.resolvedProviders.find((p) => p.providerId === providerId);
    assert.ok(effective);
    const patch = resolveCliProxyProviderEndpointPatch(
      {
        baseUrl: effective.config.api?.baseUrl ?? "",
        apiKey: effective.config.access?.apiKey ?? null,
      },
      { port: 18317, dataKey: "sk-data-key" },
    );
    assert.ok(patch, "端点事实变化时必须产生补丁");
    // 低层服务要求类实例（facade 的 parse 层才收普通对象）；可见性等标量字段可直接给。
    await service.savePersonalProviderOverlay(
      providerId,
      new ProviderConfig({
        ...(patch.baseUrl ? { api: new ProviderApiConfig({ baseUrl: patch.baseUrl }) } : {}),
        ...(patch.access
          ? { access: new ApiKeyAccessConfig({ type: "api-key", apiKey: patch.access.apiKey }) }
          : {}),
      }),
    );
    const after = await resolveRegistry(service);
    const entry = after.resolution.registryProviders.find((p) => p.providerId === providerId);
    assert.ok(entry, "投影后必须进入模型选择器");
    assert.equal(entry.config.access?.apiKey, "sk-data-key");
    assert.deepEqual(entry.models.map((model) => model.modelId).sort(), [...modelIds].sort());
  }

  // 4) running 镜像：动态模型已补齐并记账。
  assert.equal(mirrorRun.nextState.channels.codex?.modelsSynced, true);
  {
    const { snapshot } = await resolveRegistry(service);
    const modelList = snapshot.personalProviders.get(providerId)?.toJSON().personalModelIds;
    assert.deepEqual([...(modelList ?? [])].sort(), [...modelIds].sort());
  }

  // 5) 凭据消失 → 隐藏（visibility 稀疏 overlay，不整条替换）；凭据回来 → 恢复。
  const hidden = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: [],
    channelTemplates: templates,
    providers: (await personalEntries(service)).providers,
    state: mirrorRun.nextState,
    ports,
  });
  {
    const { snapshot } = await resolveRegistry(service);
    assert.equal(snapshot.personalProviders.get(providerId)?.toJSON().visibility, "hidden");
  }
  const restored = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: ["codex"],
    channelTemplates: templates,
    providers: (await personalEntries(service)).providers,
    state: hidden.nextState,
    ports,
  });
  {
    const { snapshot } = await resolveRegistry(service);
    assert.equal(snapshot.personalProviders.get(providerId)?.toJSON().visibility, "visible");
    assert.equal(restored.nextState.channels.codex?.hidden, undefined);
  }

  // 6) 用户删除条目 → withdraw，凭据仍在也不再自动重建。
  await service.deletePersonalProvider(providerId);
  const withdrawn = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: ["codex"],
    channelTemplates: templates,
    providers: (await personalEntries(service)).providers,
    state: restored.nextState,
    ports,
  });
  assert.deepEqual(withdrawn.actions, [{ kind: "withdraw", channel: "codex", providerId }]);
  assert.equal(withdrawn.nextState.channels.codex?.withdrawn, true);
  const noReseed = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: ["codex"],
    channelTemplates: templates,
    providers: (await personalEntries(service)).providers,
    state: withdrawn.nextState,
    ports,
  });
  assert.deepEqual(noReseed.actions, [], "withdrawn 后永不重新种子");
});
