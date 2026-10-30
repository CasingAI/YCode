import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WEB_SEARCH_PROVIDER_ENDPOINTS, isIndependentWebSearchTemplateId } from "@zcode/shared";
import {
  buildWebSearchSourceCreateInput,
  isWebSearchSourceDraftComplete,
  resolveManuallyAddableSourceTemplates,
  type WebSearchSourceTemplateMeta,
} from "../src/settings/webSearchSourceCatalog.js";

// 独立搜索源目录回归（docs/specs/web-search-provider-capability.md
// 「独立搜索源实例的添加 / 编辑 / 删除」）：目录、配置弹窗与聊天供应商目录
// 都必须由 shared 元数据驱动，不能在 UI 内联 jina 分支或第二份模板名单。

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const sectionSource = read("../src/settings/WebSearchSettingsSection.tsx");
const dialogSource = read("../src/settings/WebSearchSourceDialog.tsx");
const pickerSource = read("../src/settings/model-provider-section/ProviderTemplatePicker.tsx");

function template(
  templateId: string,
  options: {
    label?: string;
    accessType?: string;
    apiKeyManagementUrl?: string;
  } = {},
): WebSearchSourceTemplateMeta {
  const label = options.label ?? templateId;
  return {
    templateId,
    templateNameMap: { "zh-CN": label, "en-US": label },
    config: {
      access: {
        type: options.accessType ?? "api-key",
        ...(options.apiKeyManagementUrl
          ? { apiKeyManagementUrl: options.apiKeyManagementUrl }
          : {}),
      },
    },
  };
}

test("添加目录只展示 independent 且 Key 型的模板，当前仅 jina", () => {
  const options = resolveManuallyAddableSourceTemplates({
    locale: "zh-CN",
    templates: [
      template("jina", {
        label: "Jina",
        apiKeyManagementUrl: "https://jina.ai/api-keys",
      }),
      template("deepseek", { label: "DeepSeek" }),
      template("zai-api", { label: "Z.ai Coding Plan" }),
      template("bigmodel-api", { label: "BigModel Coding Plan" }),
      template("minimax-token-plan", { label: "MiniMax Token Plan" }),
      // 未进入 shared 元数据的新模板不能靠改 UI 元数据混入目录。
      template("future-search", { label: "Future Search" }),
    ],
  });

  assert.deepEqual(options, [
    {
      templateId: "jina",
      label: "Jina",
      accessType: "api-key",
      apiKeyManagementUrl: "https://jina.ai/api-keys",
    },
  ]);
});

test("聊天供应商添加目录的过滤只隐藏 independent 搜索模板", () => {
  const templateIds = Object.keys(WEB_SEARCH_PROVIDER_ENDPOINTS);
  assert.deepEqual(templateIds.filter(isIndependentWebSearchTemplateId), ["jina"]);
  for (const templateId of ["zai-api", "bigmodel-api", "minimax-token-plan", "deepseek"] as const) {
    assert.equal(isIndependentWebSearchTemplateId(templateId), false, templateId);
    assert.equal(WEB_SEARCH_PROVIDER_ENDPOINTS[templateId].source, "chat-provider");
  }
});

test("目录名称与 Key 链接来自模板元数据，非 Key 型 access 模板被排除", () => {
  const options = resolveManuallyAddableSourceTemplates({
    locale: "en-US",
    templates: [
      template("jina", { label: "Jina Reader Search" }),
      template("jina", { label: "Jina", accessType: "chatgpt-plan" }),
    ],
  });
  // 同一模板 id 的两条元数据都命中 shared 的 independent；非 Key 型 access 不进入目录。
  assert.deepEqual(
    options.map((option) => option.label),
    ["Jina Reader Search"],
  );
});

test("创建草稿必须同时提供受允许模板与非空 Key", () => {
  assert.equal(isWebSearchSourceDraftComplete({ templateId: undefined, apiKey: "key" }), false);
  assert.equal(isWebSearchSourceDraftComplete({ templateId: "", apiKey: "key" }), false);
  assert.equal(isWebSearchSourceDraftComplete({ templateId: "jina", apiKey: "" }), false);
  assert.equal(isWebSearchSourceDraftComplete({ templateId: "jina", apiKey: "   " }), false);
  assert.equal(isWebSearchSourceDraftComplete({ templateId: "jina", apiKey: "  k  " }), true);
});

test("创建输入一次性携带模板与 Key，避免先落空实例", () => {
  assert.deepEqual(
    buildWebSearchSourceCreateInput({
      templateId: "jina",
      accessType: "api-key",
      apiKey: "  jina-key  ",
    }),
    {
      templateId: "jina",
      initialConfig: { access: { type: "api-key", apiKey: "jina-key" } },
    },
  );
});

test("设置页与弹窗不内联 jina 模板分支，目录/草稿/创建输入复用纯函数", () => {
  assert.match(sectionSource, /resolveManuallyAddableSourceTemplates\(/);
  assert.match(sectionSource, /buildWebSearchSourceCreateInput\(/);
  // 行设置入口与添加目录共用同一判据，不再单独判断 manuallyAddable。
  assert.match(sectionSource, /canConfigure: sourceTemplates\.some\(/);
  assert.doesNotMatch(sectionSource, /isManuallyAddableWebSearchTemplateId/);
  assert.match(sectionSource, /WebSearchSourceDialog/);
  assert.doesNotMatch(sectionSource, /templateId\s*===\s*["']jina["']/);
  assert.doesNotMatch(sectionSource, /templateId:\s*["']jina["']/);
  assert.doesNotMatch(dialogSource, /["']jina["']/);
  assert.match(pickerSource, /isIndependentWebSearchTemplateId\(/);
});

test("添加按钮只打开表单，创建路径由显式提交触发", () => {
  // 入口 handler 只切换弹窗状态；createPersonalProvider 只出现在提交 handler 中。
  assert.match(sectionSource, /setSourceDialog\(\{\s*mode:\s*["']create["']\s*\}\)/);
  assert.equal(
    sectionSource.match(/createPersonalProvider\(/g)?.length,
    1,
    "创建入口只允许一条写入路径",
  );
  assert.match(sectionSource, /createPersonalProvider\(\s*buildWebSearchSourceCreateInput\(/);
  // 保存/删除仍走既有 useModelProviders 写入路径。
  assert.match(sectionSource, /saveProvider\(/);
  assert.match(sectionSource, /deleteProvider\(/);
});
