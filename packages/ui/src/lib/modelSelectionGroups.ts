import {
  isZCodeAgentProvider,
  zcodeProviderAccountAccessSchema,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectionGroupView } from "@zcode/provider";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

/** 模型组条目值编码（docs/specs/model-group.md）：与 provider/model 编码分开命名空间。 */
export const MODEL_GROUP_SELECT_VALUE_PREFIX = "model-group:";

export function encodeModelGroupSelectValue(groupId: string): string {
  return `${MODEL_GROUP_SELECT_VALUE_PREFIX}${groupId}`;
}

/** 组条目出自同一份视图时，组 ID 即组身份；名快照只做展示回填，不参与匹配。 */
export function decodeModelGroupSelectValue(value: string): string | null {
  if (!value.startsWith(MODEL_GROUP_SELECT_VALUE_PREFIX)) return null;
  const groupId = value.slice(MODEL_GROUP_SELECT_VALUE_PREFIX.length).trim();
  return groupId ? groupId : null;
}

/** 在候选视图里找组条目对应的组；用于触发器组名展示与快照回填。 */
export function findModelGroupView(
  view: Pick<ModelSelectionView, "modelGroups"> | null | undefined,
  groupId: string,
): ModelSelectionGroupView | null {
  if (!view || !groupId) return null;
  return view.modelGroups?.find((group) => group.groupId === groupId) ?? null;
}

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

function supportsRegistryApiFormat(
  selectedProvider: ZCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 仅剩 glm（ZCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
  return isZCodeAgentProvider(selectedProvider);
}

export function buildRegistryModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
): ModelSelectGroup[] {
  void labels;
  const groups = view.providers.flatMap((provider) => {
    if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

    const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    // 智谱剥离：账号套餐分组展示已下线，组名一律用 provider 自身名称（见 docs/specs/zhipu-special-removal.md）。
    void accountAccess;
    void labels;

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: provider.providerName?.trim() || provider.providerId,
        // 一级展开只看 Primary 标记：账号套餐徽章保留，但不再绑定展开。
        ...(provider.isPrimary === true ? { directItems: true } : {}),
        items: provider.models.map(({ modelId, config }) => ({
          key: `registry-provider:${provider.providerId}:${modelId}`,
          value: encodeCustomModelValue(provider.providerId, modelId),
          name: modelId,
          ...(shouldShowModelVisionBadge(
            modelId,
            config.properties?.inputFormat?.supportsImage,
            provider.config.access,
          )
            ? { supportsVisionInput: true }
            : {}),
        })),
      },
    ];
  });
  // Primary 组置前，组内与组间仍沿用传入的供应商顺序；设置页列表顺序不受影响。
  const primaryGroups = groups.filter((group) => group.directItems === true);
  const ordinaryGroups = groups.filter((group) => group.directItems !== true);
  return [...primaryGroups, ...ordinaryGroups];
}

/**
 * 停用组由 Facade 预过滤（projectModelSelectionGroups）；成员可用性只影响执行，
 * 不把组整个隐藏。此投影不直接渲染，菜单层级统一由 withModelGroupSection 决定。
 */
export function buildModelGroupSelectGroups(
  view: Pick<ModelSelectionView, "modelGroups"> | null | undefined,
): ModelSelectGroup[] {
  const modelGroupViews = view?.modelGroups ?? [];
  return modelGroupViews.map(
    (group): ModelSelectGroup => ({
      key: encodeModelGroupSelectValue(group.groupId),
      label: group.name,
      items: [
        {
          key: encodeModelGroupSelectValue(group.groupId),
          value: encodeModelGroupSelectValue(group.groupId),
          name: group.name,
        },
      ],
    }),
  );
}

/**
 * registry 分组 + 模型组分节的唯一拼装入口（docs/specs/model-group.md）。
 * sectionPrimary（view.modelGroupsPrimary）只决定整节一二级，不参与可执行判定：
 * 为 true 时把全部组平铺进一个置顶的本地化「模型组」分节；为 false 时整节收进
 * 一个二级「模型组」菜单。两种形态共用同一份可选条目，选择值编码与顺序不变。
 */
export function withModelGroupSection(params: {
  registryGroups: ModelSelectGroup[];
  view: Pick<ModelSelectionView, "modelGroups" | "modelGroupsPrimary"> | null | undefined;
  /** 一级分节与二级菜单共用的标题；调用方传入本地化「模型组」。 */
  groupSectionLabel: string;
  /** 整节置顶覆盖：缺省跟随 view.modelGroupsPrimary；表单传 false 恒收进二级菜单。 */
  sectionPrimary?: boolean;
}): ModelSelectGroup[] {
  const modelGroupGroups = buildModelGroupSelectGroups(params.view);
  if (modelGroupGroups.length === 0) return params.registryGroups;
  // 模型组本身是可选条目，不能各自成为分节，否则会渲染同名标题和选项。
  const section: ModelSelectGroup = {
    key: "model-groups",
    label: params.groupSectionLabel,
    items: modelGroupGroups.flatMap((group) => group.items),
  };
  if ((params.sectionPrimary ?? params.view?.modelGroupsPrimary === true) === true) {
    return [{ ...section, directItems: true }, ...params.registryGroups];
  }
  return [...params.registryGroups, section];
}

/**
 * 设置表单（子智能体/命令）的分组构造：registry + 组分节，组恒收进二级菜单。
 * 原因：表单侧标签参数一致，收拢到一处避免各自手拼（本次修复的依据）。
 */
export function buildSettingsFormModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView,
  formatMessage: (id: string) => string,
): ModelSelectGroup[] {
  const registryGroups = buildRegistryModelSelectGroups(selectedProvider, view, {
    startPlanBadgeLabel: formatMessage("settings.modelProvider.connectionMode.startPlanBadge"),
    apiKeyLabel: formatMessage("settings.modelProvider.apiKey"),
    codingPlanLabel: formatMessage("settings.modelProvider.connectionMode.codingPlan"),
  });
  return withModelGroupSection({
    registryGroups,
    view,
    groupSectionLabel: formatMessage("chat.toolbar.model.groupSection"),
    // 表单不置顶：组恒收进二级「模型组」菜单，不跟随整节 Primary（Composer 才置顶）。
    sectionPrimary: false,
  });
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  // 智谱剥离：账号套餐分组展示已下线，保留函数签名供既有调用方兼容，统一返回 providerId 本名。
  void labels;
  return { label: providerId };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
