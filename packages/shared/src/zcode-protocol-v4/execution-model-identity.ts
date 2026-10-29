import { z } from "zod";

/**
 * 一次模型步骤实际使用的执行身份（纯事实）。
 *
 * 只由 Runtime 在模型步骤开始时发布的 `ModelRequest` 与持久化助手消息提供；
 * 不是当前选型、admission 或 modelChange marker。供应商与模型必须同时非空才算
 * 一个已知身份（见 docs/specs/conversation-turn-info.md）。
 */
export const executionModelIdentitySchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
  })
  .strict();

export type ExecutionModelIdentity = z.infer<typeof executionModelIdentitySchema>;
