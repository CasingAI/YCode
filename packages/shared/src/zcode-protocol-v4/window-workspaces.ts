import { z } from "zod";

/**
 * 窗口工作区集合 topic。
 *
 * 与 `CONTROLLER_WORKSPACES_TOPIC` 分开：后者描述"Host 从哪个数据源读任务"
 * （source 事实，按查询被动注册），本 topic 描述"窗口当前打开了哪些工作区"
 * （UI 事实，由窗口权威端主动上报）。两者生命周期与语义都不同，混用会污染
 * source 的重连与下线语义。
 */
export const CONTROLLER_WINDOW_WORKSPACES_TOPIC =
  "controller/window-workspaces" as const;

/** 窗口内单个工作区条目的展示与身份字段。 */
export const windowWorkspaceEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    remoteTarget: z.unknown().optional(),
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    availability: z
      .enum(["available", "unavailable-local-directory"])
      .optional(),
    /** 该工作区当前打开的会话；null 表示停在草稿态。 */
    activeTaskId: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
export type WindowWorkspaceEntry = z.infer<typeof windowWorkspaceEntrySchema>;

/**
 * 窗口外观状态。
 *
 * 主题、界面模式与字号只存在于各端 localStorage，不落 settings.json，
 * 因此镜像端必须从权威端取初始值，否则会出现"桌面深色、手机浅色"。
 */
export const windowAppearanceSchema = z
  .object({
    theme: z.enum(["light", "dark", "zai-light", "zai-dark", "system"]),
    interfaceMode: z.enum(["office", "coding"]),
    uiFontSizePx: z.number().int().positive(),
  })
  .strict();
export type WindowAppearance = z.infer<typeof windowAppearanceSchema>;

/**
 * 窗口工作区集合的全量快照。
 *
 * `revision` 由 Host 分配并保证单调递增；投影端只接受更大的 `revision`，
 * 因此乱序到达的旧快照会被直接丢弃。
 */
export const windowWorkspaceSetStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    entries: z.array(windowWorkspaceEntrySchema),
    /** 当前聚焦的工作区条目；权威端停在设置页等外壳视图时为 null。 */
    activeEntryId: z.string().trim().min(1).nullable(),
    /** 最近一次激活的工作区路径；外壳视图聚焦时仍保留。 */
    activeWorkspacePath: z.string().trim().min(1).nullable(),
    activeWorkspaceIdentity: z.string().trim().min(1).nullable(),
    expandedWorkspacePaths: z.array(z.string()),
    /** 权威端的外观状态；镜像端据此对齐主题、界面模式与字号。 */
    appearance: windowAppearanceSchema.optional(),
  })
  .strict();
export type WindowWorkspaceSetState = z.infer<
  typeof windowWorkspaceSetStateSchema
>;

/** 上报载荷：不含 `revision`，由 Host 在接受后分配。 */
export const windowWorkspaceSetReportSchema = z
  .object({
    clientRevision: z.number().int().nonnegative(),
    entries: z.array(windowWorkspaceEntrySchema),
    activeEntryId: z.string().trim().min(1).nullable(),
    activeWorkspacePath: z.string().trim().min(1).nullable(),
    activeWorkspaceIdentity: z.string().trim().min(1).nullable(),
    expandedWorkspacePaths: z.array(z.string()),
    appearance: windowAppearanceSchema.optional(),
  })
  .strict();
export type WindowWorkspaceSetReport = z.infer<
  typeof windowWorkspaceSetReportSchema
>;

export const windowWorkspaceSetReportResultSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();
export type WindowWorkspaceSetReportResult = z.infer<
  typeof windowWorkspaceSetReportResultSchema
>;

export const windowWorkspaceSetSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    logEpoch: z.string().trim().min(1),
    windowWorkspaces: windowWorkspaceSetStateSchema,
  })
  .strict();
export type WindowWorkspaceSetSnapshot = z.infer<
  typeof windowWorkspaceSetSnapshotSchema
>;

export const windowWorkspaceSetDeltaSchema = z
  .object({
    op: z.literal("window-workspaces.replaced"),
    windowWorkspaces: windowWorkspaceSetStateSchema,
  })
  .strict();
export type WindowWorkspaceSetDelta = z.infer<
  typeof windowWorkspaceSetDeltaSchema
>;
