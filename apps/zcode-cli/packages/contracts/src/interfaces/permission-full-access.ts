import { z } from "zod";

export const PERMISSION_FULL_ACCESS_ENTRY = "runtime/permission_full_access";

/** 持久化 receipt 是授权重试事实源；损坏时拒绝重试，不能按当前队列重新扩大授权范围。 */
export const permissionFullAccessReceiptSchema = z
  .object({
    interactionId: z.string().min(1),
    event: z
      .object({
        id: z.string().min(1),
        sessionId: z.string().min(1),
        traceId: z.string().min(1),
        turnId: z.string().optional(),
        type: z.literal("session_mode_changed"),
        timestamp: z.coerce.date(),
        sequenceNumber: z.number().int().nonnegative(),
        payload: z
          .object({
            mode: z.literal("yolo"),
            // 以下四个字段都是升级前落盘 receipt 的兼容面：旧 receipt 写的是四档 mode
            // 加两个叠加位，新写只写 mode。payload 是 strict schema，字段留着才能让旧
            // receipt 继续解析并重试，所以是 optional 而不是删除。
            planEnabled: z.boolean().optional(),
            previousMode: z.enum(["plan", "readonly", "yolo", "build", "edit", "auto"]),
            previousPlanEnabled: z.boolean().optional(),
            readOnlyEnabled: z.boolean().optional(),
            previousReadOnlyEnabled: z.boolean().optional(),
            source: z.literal("command"),
            permissionGrant: z
              .object({
                interactionId: z.string().min(1),
                queueItemIds: z.array(z.string().min(1)),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (receipt) => receipt.interactionId === receipt.event.payload.permissionGrant.interactionId,
    {
      message: "Permission grant identity mismatch",
    },
  );
