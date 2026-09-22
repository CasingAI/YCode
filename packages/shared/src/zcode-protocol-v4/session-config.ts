import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

// ── config──

/**
 * 会话语言值域。单独导出是为了让投影种子等「从 runtime 的宽松 string 收窄回协议值域」
 * 的地方复用同一个枚举，而不是各自再写一份字面量。
 */
export const sessionLanguageSchema = z.enum(["zh-CN", "en-US"]);

export const sessionConfigStateSchema = z.object({
  /** Session 接受并持久化的稀疏选择意图；provider/model/thought 仅为 UI effective 投影。 */
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // 思考档位是当前模型的能力，不是 workspace/UI 偏好。
  // default 仅用于兼容旧快照；新 agent 必须从 runtime 投影实际集合。
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // additive（冻结面演进，同 meta 的裁决口径）：agent 协作模式（core CollaborationMode）。
  // 必须带 default 才不破坏旧快照/旧发送端的解析；投影经 SessionModeChanged 事件更新。
  // 宽度保持 string：升级前的 build / edit / auto 仍要从这里读进来再归一。
  mode: z.string().default("yolo"),
  // 会话语言：创建时快照的界面语言（解析后的实际语言），之后不变。
  // 故意 optional 且**不给 default**：旧快照没有该字段，给默认值等于凭空断言
  // 「这个旧会话是中文/英文」，而正确语义是「未知」——消费方（Bash 字段提示）
  // 读不到时必须回退通用文案，不能凭当前全局界面语言补值。
  language: sessionLanguageSchema.optional(),
  // 权限轴已收敛为单值 mode；这两个布尔位只做旧快照/旧事件的读取兼容，由 mode 单向派生，
  // 任何发送端都不得独立设置。
  planEnabled: z.boolean().optional(),
  readOnlyEnabled: z.boolean().optional(),
  /** 明确审批结果；草稿按 interactionId 消费一次，普通 mode 更新不重置它。 */
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /** 最近工具转换的关联，供草稿定向同步；不新增可见历史事件。 */
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;
