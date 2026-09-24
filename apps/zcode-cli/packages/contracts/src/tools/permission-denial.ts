import { z } from "zod";

export const PERMISSION_DENIAL_MAX_REASON_CHARS = 4_096;

export const permissionDenialSourceSchema = z.enum([
  "policy",
  "permission",
  "preToolHook",
  "permissionError",
]);

export const permissionDenialOutcomeSchema = z
  .object({
    decision: z.literal("deny"),
    reason: z.string().trim().min(1).max(PERMISSION_DENIAL_MAX_REASON_CHARS),
    source: permissionDenialSourceSchema.optional(),
    requestId: z.string().trim().min(1).max(256).optional(),
    ruleId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export type PermissionDenialSource = z.infer<typeof permissionDenialSourceSchema>;
export type PermissionDenialOutcome = z.infer<typeof permissionDenialOutcomeSchema>;
