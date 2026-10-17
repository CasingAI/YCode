import { z } from "zod";
import { STORAGE_CATEGORY_IDS } from "../storage.js";

export const v4ConversationSessionStorageParamsSchema = z
  .object({ sessionId: z.string().trim().min(1).max(256) })
  .strict();
export type V4ConversationSessionStorageParams = z.infer<
  typeof v4ConversationSessionStorageParamsSchema
>;

export const v4ConversationSessionStorageCategorySchema = z
  .object({
    categoryId: z.enum(STORAGE_CATEGORY_IDS),
    bytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationSessionStorageCategory = z.infer<
  typeof v4ConversationSessionStorageCategorySchema
>;

export const v4ConversationSessionStorageResultSchema = z
  .object({
    sessionId: z.string().min(1),
    totalBytes: z.number().int().nonnegative(),
    categories: z.array(v4ConversationSessionStorageCategorySchema),
    complete: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    dismissed: z.boolean(),
  })
  .strict();
export type V4ConversationSessionStorageResult = z.infer<
  typeof v4ConversationSessionStorageResultSchema
>;

export const v4ConversationDismissStorageWarningResultSchema = z
  .object({ dismissed: z.literal(true) })
  .strict();
export type V4ConversationDismissStorageWarningResult = z.infer<
  typeof v4ConversationDismissStorageWarningResultSchema
>;

export const v4SessionArtifactCleanupParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256),
    mode: z.enum(["before", "archived"]),
    before: z.string().datetime({ offset: true }).optional(),
    preserveModelTrajectory: z.boolean(),
  })
  .strict();
export type V4SessionArtifactCleanupParams = z.infer<
  typeof v4SessionArtifactCleanupParamsSchema
>;

export const v4SessionArtifactCleanupSkippedReasonSchema = z.enum([
  "invalid_session_id",
  "busy_or_unknown",
  "attachment_protected",
  "symlink_skipped",
  "boundary_unknown",
  "trajectory_unrewritable",
  "full_retention",
  "io_error",
]);
export type V4SessionArtifactCleanupSkippedReason = z.infer<
  typeof v4SessionArtifactCleanupSkippedReasonSchema
>;

export const v4SessionArtifactCleanupResultSchema = z
  .object({
    sessionId: z.string().min(1),
    deletedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    skippedReasons: z.array(v4SessionArtifactCleanupSkippedReasonSchema),
  })
  .strict();
export type V4SessionArtifactCleanupResult = z.infer<
  typeof v4SessionArtifactCleanupResultSchema
>;
