import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelSelectionView } from "@zcode/services";
import { ServiceProvider } from "../src/hooks/useServices.js";
import {
  buildProviderQuotaConfigs,
  resolveProviderQuotaSource,
  type ProviderQuotaConfigs,
  type ProviderQuotaSourceKind,
} from "../src/v4/providerQuotaSource.js";
import {
  SUBAGENT_PROVIDER_QUOTA_TEST_ID,
  SubagentProviderQuotaSection,
} from "../src/v4/SubagentProviderQuotaSection.js";

// 只构造额度匹配需要的 providerId/templateId；其余目录字段与额度无关。
function makeView(
  providers: ReadonlyArray<{ providerId: string; templateId: string }>,
): ModelSelectionView {
  return {
    revision: 7,
    providers: providers.map((provider) => ({
      ...provider,
      providerName: provider.providerId,
      config: {},
      models: [],
    })),
  } as unknown as ModelSelectionView;
}

const TEMPLATE_CASES: ReadonlyArray<[string, ProviderQuotaSourceKind]> = [
  ["opencode-go-claude", "opencode-go"],
  ["cliproxy-codex", "cliproxy"],
  ["deepseek", "deepseek"],
  ["minimax-token-plan", "minimax"],
  ["openrouter", "openrouter"],
  ["commandcode", "commandcode"],
  ["opencode-zen-claude", "opencode-zen"],
  ["zai-api", "zhipu"],
];

test("provider 额度来源按 templateId 匹配，并覆盖主 composer 既有来源", () => {
  for (const [templateId, kind] of TEMPLATE_CASES) {
    const source = resolveProviderQuotaSource({
      providerId: "provider-1",
      modelSelectionView: makeView([
        { providerId: "provider-other", templateId: "cliproxy-codex" },
        { providerId: "provider-1", templateId },
      ]),
    });
    assert.equal(source?.kind, kind, `templateId=${templateId} 应解析为 ${kind}`);
    assert.equal(source?.providerId, "provider-1");
    assert.equal(source?.templateId, templateId);
  }
});

test("provider 缺失、不在目录或模板不受支持时不产生额度来源", () => {
  const view = makeView([{ providerId: "known", templateId: "openai-api" }]);
  for (const input of [
    { providerId: "", modelSelectionView: view },
    { providerId: "   ", modelSelectionView: view },
    { providerId: null, modelSelectionView: view },
    { providerId: "known", modelSelectionView: view },
    { providerId: "missing", modelSelectionView: view },
    { providerId: "known", modelSelectionView: null },
  ]) {
    assert.equal(
      resolveProviderQuotaSource(input),
      null,
      `provider=${JSON.stringify(input.providerId)} 不应产生额度来源`,
    );
  }
});

test("额度 config 由同一个来源构造，只带对应面板字段", () => {
  const source = resolveProviderQuotaSource({
    providerId: "provider-1",
    modelSelectionView: makeView([{ providerId: "provider-1", templateId: "cliproxy-codex" }]),
  });
  assert.ok(source);
  const withManage = buildProviderQuotaConfigs({
    source,
    onManage: () => undefined,
    configRevision: 9,
  });
  assert.equal(Object.keys(withManage).length, 1);
  assert.deepEqual(withManage.cliProxyQuota, {
    providerId: "provider-1",
    onManage: withManage.cliProxyQuota?.onManage,
  });
  assert.equal(typeof withManage.cliProxyQuota?.onManage, "function");

  // 只读面板不传 onManage：config 不带该字段，标题行不会出现管理入口。
  const readOnly = buildProviderQuotaConfigs({ source, configRevision: 9 });
  assert.equal(Object.prototype.hasOwnProperty.call(readOnly.cliProxyQuota, "onManage"), false);

  const goSource = resolveProviderQuotaSource({
    providerId: "provider-go",
    modelSelectionView: makeView([{ providerId: "provider-go", templateId: "opencode-go-claude" }]),
  });
  assert.ok(goSource);
  const goConfigs = buildProviderQuotaConfigs({ source: goSource, configRevision: 9 });
  assert.equal(goConfigs.openCodeUsage?.configRevision, 9);
  assert.equal(buildProviderQuotaConfigs({ source: null }).openCodeUsage, undefined);
});

const CONFIG_KEY_BY_KIND: Record<ProviderQuotaSourceKind, keyof ProviderQuotaConfigs> = {
  "opencode-go": "openCodeUsage",
  cliproxy: "cliProxyQuota",
  deepseek: "deepSeekBalance",
  minimax: "minimaxQuota",
  openrouter: "openRouterBalance",
  commandcode: "commandCodeQuota",
  "opencode-zen": "openCodeZenBalance",
  zhipu: "zhipuQuota",
};

const TITLE_ID_BY_KIND: Record<ProviderQuotaSourceKind, string> = {
  "opencode-go": "chat.opencodeUsage.title",
  cliproxy: "chat.cliproxyQuota.title",
  deepseek: "settings.modelProvider.deepseekBalance.title",
  minimax: "settings.modelProvider.minimaxQuota.title",
  openrouter: "settings.modelProvider.openrouterBalance.title",
  commandcode: "settings.modelProvider.commandCodeQuota.title",
  "opencode-zen": "settings.modelProvider.opencodeZenBalance.title",
  zhipu: "settings.usage.quotaTitle",
};

const MANAGE_ID_BY_KIND: Record<ProviderQuotaSourceKind, string> = {
  "opencode-go": "chat.opencodeUsage.manage",
  cliproxy: "chat.cliproxyQuota.manage",
  deepseek: "chat.deepseekBalance.manage",
  minimax: "chat.minimaxQuota.manage",
  openrouter: "chat.openrouterBalance.manage",
  commandcode: "chat.commandCodeQuota.manage",
  "opencode-zen": "chat.opencodeZenBalance.manage",
  zhipu: "chat.minimaxQuota.manage",
};

const intlStub = {
  formatMessage: ({ id }: { id: string }) => `#${id}`,
} as never;

// 面板内既有 hook 通过 ServiceProvider 读取服务；SSR 不跑 effect，只需承载
// 各 service 的对象引用即可让面板首帧渲染。
const quotaServices = {
  opencodeUsageService: {},
  deepSeekBalanceService: {},
  miniMaxQuotaService: {},
  openRouterBalanceService: {},
  commandCodeQuotaService: {},
} as never;

function renderSection(providerId: string, view: ModelSelectionView | null) {
  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: quotaServices },
      createElement(SubagentProviderQuotaSection, {
        providerId,
        modelSelectionView: view,
        intl: intlStub,
        locale: "zh-CN",
        separated: true,
      }),
    ),
  );
}

// 主 composer 与子代理共用同一个来源函数：同一 provider/templateId 必须得到同一结果，
// 且只由传入的 providerId 决定，不受目录中其他 provider 的模板影响。
test("额度来源只认传入的 provider，与目录中其他 provider 互不影响", () => {
  const view = makeView([
    { providerId: "main-deepseek", templateId: "deepseek" },
    { providerId: "child-cliproxy", templateId: "cliproxy-codex" },
  ]);
  assert.equal(
    resolveProviderQuotaSource({ providerId: "child-cliproxy", modelSelectionView: view })?.kind,
    "cliproxy",
  );
  assert.equal(
    resolveProviderQuotaSource({ providerId: "main-deepseek", modelSelectionView: view })?.kind,
    "deepseek",
  );
  // 父会话 provider 在子代理目录中不存在时不得借用其他条目。
  assert.equal(
    resolveProviderQuotaSource({ providerId: "parent-only", modelSelectionView: view }),
    null,
  );
});

test("主 composer 的额度 config 与来源一一对应，且保留 onManage", () => {
  for (const [templateId, kind] of TEMPLATE_CASES) {
    const source = resolveProviderQuotaSource({
      providerId: "provider-1",
      modelSelectionView: makeView([{ providerId: "provider-1", templateId }]),
    });
    assert.ok(source);
    const configs = buildProviderQuotaConfigs({
      source,
      onManage: () => undefined,
      configRevision: 3,
    });
    assert.deepEqual(Object.keys(configs), [CONFIG_KEY_BY_KIND[kind]]);
    const config = configs[CONFIG_KEY_BY_KIND[kind]];
    assert.equal(config?.providerId, "provider-1");
    assert.equal(typeof config?.onManage, "function");
  }
});

test("子代理额度段复用既有面板；8 种来源都渲染对应标题且无管理按钮", () => {
  for (const [templateId, kind] of TEMPLATE_CASES) {
    const markup = renderSection(
      "provider-1",
      makeView([{ providerId: "provider-1", templateId }]),
    );
    assert.ok(
      markup.includes(`data-testid="${SUBAGENT_PROVIDER_QUOTA_TEST_ID}"`),
      `${kind} 应渲染额度段容器`,
    );
    assert.ok(markup.includes(`#${TITLE_ID_BY_KIND[kind]}`), `${kind} 应渲染自身面板标题`);
    // 只读面板不传 onManage：不能出现“配置/管理”入口。
    assert.ok(!markup.includes(`#${MANAGE_ID_BY_KIND[kind]}`), `${kind} 不应渲染管理入口`);
    if (kind === "zhipu") {
      // 智谱面板首帧没有快照时会展示既有的“刷新”按钮；这是数据刷新，不是管理入口。
      assert.ok(markup.includes(`aria-label="#sidebar.usage.plan.refresh"`));
    } else {
      assert.ok(!/<button[\s>]/.test(markup), `${kind} 只读面板不应渲染按钮`);
    }
  }
});

test("找不到来源时不渲染任何额度内容", () => {
  for (const [providerId, view] of [
    ["provider-1", makeView([{ providerId: "provider-1", templateId: "openai-api" }])],
    ["provider-1", makeView([])],
    ["provider-1", null],
    ["", makeView([{ providerId: "provider-1", templateId: "cliproxy-codex" }])],
  ] as const) {
    assert.equal(renderSection(providerId, view), "");
  }
});

// 接线断言：SSR 只能渲染到关闭态触发器，弹层正文的接线用源码断言补齐。
test("主 composer 与 footer 都接共享 resolver，不各自维护模板判定", () => {
  const read = (relativePath: string) =>
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
  const toolbar = read("../src/v4/composer/V4ComposerToolbar.tsx");
  assert.ok(toolbar.includes("resolveProviderQuotaSource"));
  assert.ok(toolbar.includes("buildProviderQuotaConfigs"));
  // 旧的 8 份按模板逐项判定已删除，避免与 resolver 漂移。
  assert.ok(!toolbar.includes("isCliProxyProviderTemplateId("));
  assert.ok(!toolbar.includes("isZhipuTemplateId("));
});
