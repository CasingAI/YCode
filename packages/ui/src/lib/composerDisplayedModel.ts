import { isZCodeAgentProvider, type ZCodeProvider } from "@zcode/shared";
import {
  modelGroupIntentSchema,
  modelSelectionSchema,
  type ModelGroupIntent,
  type ModelSelection,
} from "@zcode/shared/model-selection";
import type { ModelSelectionView } from "@zcode/services";
import { resolveModelGroupDisplayName } from "@/lib/modelSelectionGroups.js";
import { logger } from "@/logger.js";

// 工作区“最后展示的模型意图”（docs/specs/composer-displayed-model.md）：前台 Composer
// 真正展示具体可用模型或模型组意图时写入，命令中心 AI 搜索优先读它。与 composerRecent
// （最近一次 accepted 发送偏好）分开存储、分开读取，互不写回。
// 同一 key / version 只存一条互斥记录：selection 或 modelGroupIntent，整体覆盖不 merge。
const COMPOSER_DISPLAYED_MODEL_KEY_PREFIX = "zcode-composer-displayed-model-v1";
const DISPLAYED_MODEL_RECORD_VERSION = 1;
// Composer 模型胶囊会把协议内部合成模型渲染成占位，不当作展示事实。
const SYNTHETIC_MODEL_ID = "<synthetic>";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 展示事实的两种互斥形态：具体可用模型，或模型组意图（含组名快照）。 */
export type ComposerDisplayedModel =
  | { readonly selection: ModelSelection }
  | { readonly modelGroupIntent: ModelGroupIntent };

interface DisplayedModelRecord {
  readonly version: typeof DISPLAYED_MODEL_RECORD_VERSION;
  readonly selection?: ModelSelection;
  readonly modelGroupIntent?: ModelGroupIntent;
}

type DisplayedModelView = Pick<ModelSelectionView, "providers" | "modelGroups"> | null | undefined;

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
 * 组意图不依赖成员可用性：组为空 / 已删 / 停用 / 目录未就绪都记录组 ID + 名快照，
 * 当前视图里的组名优先，回填规则与 Composer 胶囊一致。不编造成员、不写具体选择。
 */
function resolveDisplayedModelGroupIntent(
  view: DisplayedModelView,
  groupIntent: ModelGroupIntent | null | undefined,
): ComposerDisplayedModel | null {
  if (!groupIntent) return null;
  const parsed = modelGroupIntentSchema.safeParse(groupIntent);
  if (!parsed.success) return null;
  return {
    modelGroupIntent: {
      groupId: parsed.data.groupId,
      groupNameSnapshot:
        resolveModelGroupDisplayName(view, parsed.data) ?? parsed.data.groupNameSnapshot,
    },
  };
}

/**
 * 展示事实的唯一解析入口：具体可用模型优先；本侧不成立且存在组意图时记组
 * （即使目录未就绪）。两者都没有时返回 null，本次不写并保留旧记录。
 */
export function resolveComposerDisplayedModelIntent(params: {
  displayProvider: ZCodeProvider;
  view: DisplayedModelView;
  selection: ModelSelection | null | undefined;
  groupIntent: ModelGroupIntent | null | undefined;
}): ComposerDisplayedModel | null {
  const selection = resolveComposerDisplayedModelSelection({
    displayProvider: params.displayProvider,
    view: params.view,
    selection: params.selection,
  });
  if (selection) return { selection };
  return resolveDisplayedModelGroupIntent(params.view, params.groupIntent);
}

/**
 * 前台判据的唯一实现（docs/specs/composer-displayed-model.md）：
 * focused && visible && 主 Composer（非 selectionSideChat / readOnly）。
 * 后台 pane 的普通重渲染、目录或会话更新都返回 null，不写工作区记录。
 */
export function resolveForegroundDisplayedModel(params: {
  foreground: {
    readonly focused: boolean;
    readonly visible: boolean;
    readonly readOnly: boolean;
    readonly selectionSideChat: boolean;
  };
  displayProvider: ZCodeProvider;
  view: DisplayedModelView;
  selection: ModelSelection | null | undefined;
  groupIntent: ModelGroupIntent | null | undefined;
}): ComposerDisplayedModel | null {
  const { focused, visible, readOnly, selectionSideChat } = params.foreground;
  if (!focused || !visible || readOnly || selectionSideChat) return null;
  return resolveComposerDisplayedModelIntent(params);
}

/**
 * 读取只有一条互斥记录。坏混合数据（同时含两个合法叶子）按既有 composerRecent 规则
 * 优先具体选择；旧 version 1 的只含 selection 记录照常读取。
 */
export function readComposerDisplayedModel(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): ComposerDisplayedModel | null {
  if (!storage) return null;
  const key = resolveComposerDisplayedModelKey(workspacePath, workspaceIdentity);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if ((record as { version?: unknown }).version !== DISPLAYED_MODEL_RECORD_VERSION) {
      return null;
    }
    if ("selection" in record) {
      const selection = modelSelectionSchema.safeParse(
        (record as { selection?: unknown }).selection,
      );
      if (selection.success) return { selection: selection.data };
    }
    if ("modelGroupIntent" in record) {
      const groupIntent = modelGroupIntentSchema.safeParse(
        (record as { modelGroupIntent?: unknown }).modelGroupIntent,
      );
      if (groupIntent.success) return { modelGroupIntent: groupIntent.data };
    }
    return null;
  } catch {
    // 坏存储只影响本偏好；Composer 与命令中心继续走既有回退。
    return null;
  }
}

/** 传入的整体只保留一个合法叶子；异常双值按具体选择单写，绝不留下双字段记录。 */
function normalizeDisplayedModel(displayed: ComposerDisplayedModel): ComposerDisplayedModel | null {
  if ("selection" in displayed && displayed.selection) {
    const selection = modelSelectionSchema.safeParse(displayed.selection);
    if (selection.success) return { selection: selection.data };
  }
  if ("modelGroupIntent" in displayed && displayed.modelGroupIntent) {
    const groupIntent = modelGroupIntentSchema.safeParse(displayed.modelGroupIntent);
    if (groupIntent.success) return { modelGroupIntent: groupIntent.data };
  }
  return null;
}

/** 只由前台 Composer effect 调用；写入失败不能阻断 Composer。 */
export function recordComposerDisplayedModel(
  workspacePath: string,
  displayed: ComposerDisplayedModel | null | undefined,
  workspaceIdentity?: string,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage || !displayed) return;
  const normalized = normalizeDisplayedModel(displayed);
  if (!normalized) return;
  const record: DisplayedModelRecord = {
    version: DISPLAYED_MODEL_RECORD_VERSION,
    ...normalized,
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
