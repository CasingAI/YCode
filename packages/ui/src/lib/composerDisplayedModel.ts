import { isZCodeAgentProvider, type ZCodeProvider } from "@zcode/shared";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import type { ModelSelectionView } from "@zcode/services";
import { logger } from "@/logger.js";

// 工作区“最后展示的模型”（docs/specs/composer-displayed-model.md）：前台 Composer
// 真正展示一个具体可用模型时写入，命令中心 AI 搜索优先读它。与 composerRecent
// （最近一次 accepted 发送偏好）分开存储、分开读取，互不写回。
const COMPOSER_DISPLAYED_MODEL_KEY_PREFIX = "zcode-composer-displayed-model-v1";
const DISPLAYED_MODEL_RECORD_VERSION = 1;
// Composer 模型胶囊会把协议内部合成模型渲染成占位，不当作展示事实。
const SYNTHETIC_MODEL_ID = "<synthetic>";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface DisplayedModelRecord {
  readonly version: typeof DISPLAYED_MODEL_RECORD_VERSION;
  readonly selection: ModelSelection;
}

function resolveComposerDisplayedModelKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${COMPOSER_DISPLAYED_MODEL_KEY_PREFIX}:${workspaceKey}`;
}

/**
 * Composer 胶囊此刻是否真的展示出一个具体可用模型。
 * 规则与 `lib/modelSelectionGroups.ts#supportsRegistryApiFormat` 一致：模型菜单只展示
 * api 格式可用的 ZCode Agent provider；目录未就绪、模型不在视图、组意图 / 空选择
 * 都只显示占位，不是可用的展示事实，不写记录也不编造成员。
 */
export function resolveComposerDisplayedModelSelection(params: {
  displayProvider: ZCodeProvider;
  view: Pick<ModelSelectionView, "providers"> | null | undefined;
  selection: ModelSelection | null | undefined;
}): ModelSelection | null {
  const { displayProvider, view, selection } = params;
  if (!view || !selection) return null;
  const providerId = selection.providerId?.trim();
  const modelId = selection.modelId?.trim();
  if (!providerId || !modelId) return null;
  if (modelId.toLocaleLowerCase() === SYNTHETIC_MODEL_ID) return null;
  if (!isZCodeAgentProvider(displayProvider)) return null;
  const provider = view.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) return null;
  if (!provider.config.api?.type) return null;
  const model = provider.models.find((candidate) => candidate.modelId === modelId);
  if (!model) return null;

  // 档位表不接受的档位在 Composer 里显示为空；只记录实际展示的档位。
  const reasoningLevel = selection.options?.reasoningLevel?.trim();
  const reasoningValues = model.config.optionSpecs?.reasoningLevel?.values ?? [];
  return {
    providerId,
    modelId,
    ...(reasoningLevel && reasoningValues.includes(reasoningLevel)
      ? { options: { reasoningLevel } }
      : {}),
  };
}

/**
 * 前台判据的唯一实现（docs/specs/composer-displayed-model.md）：
 * focused && visible && 主 Composer（非 selectionSideChat / readOnly）。
 * 后台 pane 的普通重渲染、目录或会话更新都返回 null，不写工作区记录。
 */
export function resolveForegroundDisplayedModelSelection(params: {
  foreground: {
    readonly focused: boolean;
    readonly visible: boolean;
    readonly readOnly: boolean;
    readonly selectionSideChat: boolean;
  };
  displayProvider: ZCodeProvider;
  view: Pick<ModelSelectionView, "providers"> | null | undefined;
  selection: ModelSelection | null | undefined;
}): ModelSelection | null {
  const { focused, visible, readOnly, selectionSideChat } = params.foreground;
  if (!focused || !visible || readOnly || selectionSideChat) return null;
  return resolveComposerDisplayedModelSelection({
    displayProvider: params.displayProvider,
    view: params.view,
    selection: params.selection,
  });
}

export function readComposerDisplayedModel(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): ModelSelection | null {
  if (!storage) return null;
  const key = resolveComposerDisplayedModelKey(workspacePath, workspaceIdentity);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (
      (record as { version?: unknown }).version !== DISPLAYED_MODEL_RECORD_VERSION ||
      !("selection" in record)
    ) {
      return null;
    }
    const selection = modelSelectionSchema.safeParse((record as { selection?: unknown }).selection);
    if (!selection.success) return null;
    return selection.data;
  } catch {
    // 坏存储只影响本偏好；Composer 与命令中心继续走既有回退。
    return null;
  }
}

/** 只由前台 Composer effect 调用；写入失败不能阻断 Composer。 */
export function recordComposerDisplayedModel(
  workspacePath: string,
  selection: ModelSelection | null | undefined,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage || !selection) return;
  const parsed = modelSelectionSchema.safeParse(selection);
  if (!parsed.success) return;
  const record: DisplayedModelRecord = {
    version: DISPLAYED_MODEL_RECORD_VERSION,
    selection: parsed.data,
  };
  const serialized = JSON.stringify(record);
  const key = resolveComposerDisplayedModelKey(workspacePath, workspaceIdentity);
  try {
    // 先对齐存储现值：焦点/pane 切换重复求值时，同值不重复写。
    if ((storage.getItem(key) ?? "") === serialized) return;
    storage.setItem(key, serialized);
  } catch (error) {
    logger.warn("[ComposerDisplayedModel] 保存最后展示的模型失败", {
      workspacePath,
      workspaceIdentity,
      error,
    });
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
