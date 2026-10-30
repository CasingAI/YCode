import type { ApiKeyAccessConfigObject, ProviderTemplateLocale } from "@zcode/provider";
import { resolveProviderTemplateName } from "@zcode/provider";
import {
  isIndependentWebSearchTemplateId,
  type WebSearchCapableProviderTemplateId,
} from "@zcode/shared";

/**
 * 独立搜索源目录（docs/specs/web-search-provider-capability.md
 * 「独立搜索源实例的添加 / 编辑 / 删除」）。
 *
 * 是否允许手动添加的唯一事实是 `@zcode/shared` 的 `source: "independent"`；
 * 名称、Key 管理链接与 access 类型来自内置模板元数据。这里只做两者的投影，
 * 不维护第二份模板名单，也不内联具体模板 id。
 *
 * 本页当前只支持 Key 型 access（`api-key` / `zhipu-coding-plan-api-key`）；
 * 账号型模板不进入目录，也不提供本页设置入口，不为其预置额外抽象。
 */
export interface WebSearchSourceTemplateMeta {
  readonly templateId: string;
  readonly templateNameMap: {
    readonly "zh-CN"?: string;
    readonly "en-US"?: string;
  };
  readonly config: {
    readonly access?: {
      readonly type?: string;
      readonly apiKeyManagementUrl?: string | null;
    } | null;
  };
}

export interface WebSearchSourceTemplateOption {
  readonly templateId: WebSearchCapableProviderTemplateId;
  readonly label: string;
  readonly accessType: ApiKeyAccessConfigObject["type"];
  readonly apiKeyManagementUrl?: string;
}

function isApiKeyTemplateAccess(
  access: WebSearchSourceTemplateMeta["config"]["access"],
): access is NonNullable<WebSearchSourceTemplateMeta["config"]["access"]> & {
  type: ApiKeyAccessConfigObject["type"];
} {
  return access?.type === "api-key" || access?.type === "zhipu-coding-plan-api-key";
}

/** 「添加搜索源」目录：独立模板 × Key 型 access 的模板元数据。 */
export function resolveManuallyAddableSourceTemplates(params: {
  templates: readonly WebSearchSourceTemplateMeta[];
  locale: ProviderTemplateLocale;
}): WebSearchSourceTemplateOption[] {
  return params.templates.flatMap((template) => {
    if (!isIndependentWebSearchTemplateId(template.templateId)) return [];
    const access = template.config.access;
    if (!isApiKeyTemplateAccess(access)) return [];
    return [
      {
        templateId: template.templateId,
        label: resolveProviderTemplateName(template.templateId, template, params.locale),
        accessType: access.type,
        ...(access.apiKeyManagementUrl ? { apiKeyManagementUrl: access.apiKeyManagementUrl } : {}),
      },
    ];
  });
}

/** 添加表单草稿必须同时有受允许模板与非空 Key；点击入口本身不产生实例。 */
export function isWebSearchSourceDraftComplete(input: {
  templateId: string | undefined;
  apiKey: string;
}): boolean {
  return Boolean(input.templateId?.trim()) && input.apiKey.trim().length > 0;
}

/** 创建输入一次性携带模板与 Key，避免先持久化空实例再补 Key。 */
export function buildWebSearchSourceCreateInput(input: {
  templateId: WebSearchCapableProviderTemplateId;
  accessType: ApiKeyAccessConfigObject["type"];
  apiKey: string;
}): {
  templateId: WebSearchCapableProviderTemplateId;
  initialConfig: {
    access: {
      type: ApiKeyAccessConfigObject["type"];
      apiKey: string;
    };
  };
} {
  return {
    templateId: input.templateId,
    initialConfig: {
      access: { type: input.accessType, apiKey: input.apiKey.trim() },
    },
  };
}
