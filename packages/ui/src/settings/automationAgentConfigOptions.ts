import type { ZCodeConfigOption, ZCodeProvider } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  withModelGroupSection,
  type ModelProviderGroupLabelOptions,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveV4ModelTriggerLabel } from "@/v4/composer/modelTriggerDisplay.js";

// 定时任务表单必须是纯本地草稿，不能借用 workspace 默认配置写接口来获取选项；
// 否则仅打开或取消编辑也会改掉当前项目和 draft session 的运行配置。

/** 自动化任务只开放 Agent / Team，两档都不需要人工逐步确认；新建默认 Agent。 */
export const AUTOMATION_DEFAULT_MODE = "yolo";
export type AutomationModeValue = "yolo" | "team";
export const AUTOMATION_MODE_VALUES = [
  "yolo",
  "team",
] as const satisfies readonly AutomationModeValue[];

/**
 * 历史 automations.mode / off_peak_tasks.permission_mode 可能是 NULL 或旧档位。
 * 这里只做展示与初始草稿回退，不写回存储；旧 bare 按既有规则视为 Team，其余回退 Agent。
 */
export function resolveAutomationModeValue(value: unknown): AutomationModeValue {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "team" || normalized === "bare" ? "team" : AUTOMATION_DEFAULT_MODE;
}

/**
 * 创建始终写入选中的档位；更新只有用户实际碰过选择器才写，
 * 避免仅改标题 / 提示词 / 时间时把历史 NULL 或旧值迁移成 yolo。
 */
export function shouldSubmitAutomationMode(params: {
  isEditing: boolean;
  touched: boolean;
}): boolean {
  return !params.isEditing || params.touched;
}

/** 新建任务必须把目标 Host 的 preferredSelection 固化为具体模型，而不是保存虚拟“默认模型”。 */
export function resolveAutomationPreferredModelValue(
  view: Pick<ModelSelectionView, "preferredSelection">,
): string | null {
  const preferred = view.preferredSelection;
  return preferred ? encodeCustomModelValue(preferred.providerId, preferred.modelId) : null;
}

export function buildAutomationModelSelectGroups(params: {
  selectedProvider: ZCodeProvider;
  labels: ModelProviderGroupLabelOptions;
  registrySelectionView: ModelSelectionView;
  /** 二级收纳时的节标题；调用方按各自 i18n 传「模型组」。缺省不拼组分节。 */
  groupSectionLabel?: string;
}): ModelSelectGroup[] {
  const registryGroups = buildRegistryModelSelectGroups(
    params.selectedProvider,
    params.registrySelectionView,
    params.labels,
  );
  // 模型组分节（docs/specs/model-group.md）：与 Composer 共用 withModelGroupSection；
  // 表单不置顶，组收进二级「模型组」菜单。停用组由 Facade 预过滤。
  if (!params.groupSectionLabel) return registryGroups;
  return withModelGroupSection({
    registryGroups,
    view: params.registrySelectionView,
    groupSectionLabel: params.groupSectionLabel,
  });
}

export function buildAutomationModeOption(
  currentValue: string | null | undefined,
): ZCodeConfigOption {
  const modeValue = resolveAutomationModeValue(currentValue);
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: modeValue,
    options: AUTOMATION_MODE_VALUES.map((value) => ({ value, name: value })),
  };
}

function findDirectModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  for (const group of modelGroups) {
    const item = group.items.find((candidate) => candidate.value === modelValue);
    if (item) return item;
  }
  return null;
}

export function resolveAutomationModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  const direct = findDirectModelItem(modelGroups, modelValue);
  if (direct) {
    // 模型组条目（docs/specs/model-group.md）：触发器展示组名；档位/提交链路按组意图走，
    // 调用方对组值走组提交分支（门禁放行，不写具体模型）。
    return direct;
  }

  const separator = modelValue.indexOf("/");
  const qualifiedProviderId = separator > 0 ? modelValue.slice(0, separator) : null;
  const qualifiedModelId = separator > 0 ? modelValue.slice(separator + 1) : modelValue;
  const modelMatches = modelGroups.flatMap((group) =>
    group.items.filter((item) => {
      const decoded = decodeCustomModelValue(item.value);
      return decoded?.modelName === qualifiedModelId;
    }),
  );
  if (qualifiedProviderId) {
    const providerMatches = modelMatches.filter(
      (item) => decodeCustomModelValue(item.value)?.providerId === qualifiedProviderId,
    );
    if (providerMatches.length === 1) return providerMatches[0] ?? null;
  }
  // 历史 automation 可能只保存纯模型名；同名模型跨 provider 时不能猜测来源。
  // workspace runtime 也可能返回 zcode-openai-compatible/model 这类包装值，provider 对不上时
  // 只有模型名全局唯一才允许回填菜单项，避免默认模型丢失对应的 think 元数据。
  return modelMatches.length === 1 ? (modelMatches[0] ?? null) : null;
}

export function resolveAutomationModelTriggerLabel(params: {
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelValue: string;
  fallbackLabel: string;
}): string {
  const selectedItem = resolveAutomationModelItem(params.modelGroups, params.modelValue);
  if (!selectedItem) {
    const decodedModel = decodeCustomModelValue(params.modelValue);
    if (decodedModel?.modelName) {
      // 仅展示层保留历史模型名；模型不回填到当前候选列表，也不改变保存或派发逻辑。
      return decodedModel.modelName;
    }

    const separator = params.modelValue.indexOf("/");
    return separator > 0
      ? params.modelValue.slice(separator + 1)
      : params.modelValue.trim() || params.fallbackLabel;
  }

  const selectedModel = decodeCustomModelValue(selectedItem.value);
  const providerId = selectedModel?.providerId;
  const providerName =
    params.modelSelectionView?.providers.find((provider) => provider.providerId === providerId)
      ?.providerName ?? undefined;

  // Automations 曾自行截断 provider/model 协议值，只显示最后一级模型名，
  // 导致同一模型在会话侧和定时任务侧身份文案不一致。这里直接复用会话侧规则，
  // 同时保留内置 family 与失效值的统一裁剪语义。
  return resolveV4ModelTriggerLabel({
    modelGroups: params.modelGroups,
    normalizedValue: selectedItem.value,
    fallbackLabel: params.fallbackLabel,
    providerId,
    providerName,
  });
}

export function buildAutomationThoughtLevelOption(
  runtimeOption: ZCodeConfigOption | undefined,
  currentValue: string,
): ZCodeConfigOption | null {
  const options = runtimeOption?.options ?? [];
  if (options.length === 0) return null;
  const validCurrentValue = options.some((option) => option.value === currentValue);
  // 原因：候选刷新不是用户选择，不能把失效档位改成默认/最高档并保存。
  const resolvedValue = validCurrentValue ? currentValue : "";

  return {
    id: "thought_level",
    name: runtimeOption?.name ?? "Effort",
    category: "thought_level",
    type: "select",
    currentValue: resolvedValue,
    options: options.map((option) => ({ ...option })),
  };
}
