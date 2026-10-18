import { z } from "zod";
import { STORAGE_CATEGORY_IDS } from "./storage.js";

export const storageCleanRequestSchema = z
  .object({
    rootId: z.enum(["home", "dataBaseDir", "ycodeHome", "ycodeDataBaseDir"]),
    categoryId: z.enum(STORAGE_CATEGORY_IDS).optional(),
    categoryIds: z
      .array(z.enum(STORAGE_CATEGORY_IDS))
      .min(1)
      .max(STORAGE_CATEGORY_IDS.length)
      .optional(),
    ageRange: z.enum(["24hours", "7days", "30days", "all"]).optional(),
    olderThanMs: z.number().finite().nonnegative().optional(),
    entryKeys: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (key) =>
              !key.startsWith("/") &&
              !key.includes("\\") &&
              key
                .split("/")
                .every((part) => !!part && part !== "." && part !== ".."),
          ),
      )
      .optional(),
  })
  .strict();
const pathError = z.object({ path: z.string(), code: z.string() }).strict();
export const storageSnapshotSchema = z
  .object({
    jobId: z.string().min(1),
    status: z.enum(["scanning", "complete", "cancelled", "failed"]),
    startedAt: z.number().finite(),
    finishedAt: z.number().finite().optional(),
    roots: z.array(
      z
        .object({
          id: z.enum(["home", "dataBaseDir", "ycodeHome", "ycodeDataBaseDir"]),
          path: z.string(),
          bytes: z.number().nonnegative(),
          fileCount: z.number().nonnegative(),
          volume: z
            .object({
              deviceId: z.string(),
              mountPoint: z.string(),
              totalBytes: z.number(),
              freeBytes: z.number(),
            })
            .strict()
            .nullable(),
          categories: z.array(
            z
              .object({
                id: z.enum(STORAGE_CATEGORY_IDS),
                bytes: z.number().nonnegative(),
                fileCount: z.number().nonnegative(),
                cleanability: z.enum(["none", "safe", "confirm"]),
                entries: z.array(
                  z
                    .object({
                      relativePath: z.string(),
                      bytes: z.number().nonnegative(),
                      fileCount: z.number().nonnegative(),
                    })
                    .strict(),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    errors: z.array(pathError),
  })
  .strict();
export const storageHostRequestSchema = z
  .object({
    type: z.literal("storage-request"),
    requestId: z.string().min(1),
    command: z.discriminatedUnion("method", [
      z.object({ method: z.literal("startScan") }).strict(),
      z.object({ method: z.literal("getSnapshot") }).strict(),
      z
        .object({ method: z.literal("cancelScan"), jobId: z.string().min(1) })
        .strict(),
      z
        .object({
          method: z.literal("clean"),
          request: storageCleanRequestSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export const storageHostResultSchema = z
  .object({
    type: z.literal("storage-result"),
    requestId: z.string().min(1),
    outcome: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(false), error: z.string() }).strict(),
      z
        .object({
          ok: z.literal(true),
          result: z.union([
            z.object({ jobId: z.string().min(1) }).strict(),
            storageSnapshotSchema,
            z.null(),
            z
              .object({
                deletedCount: z.number().nonnegative(),
                skippedCount: z.number().nonnegative(),
                failures: z.array(pathError),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export const storageHostProgressSchema = z
  .object({
    type: z.literal("storage-progress"),
    snapshot: storageSnapshotSchema,
  })
  .strict();
export type StorageHostRequest = z.infer<typeof storageHostRequestSchema>;
export type StorageHostResult = z.infer<typeof storageHostResultSchema>;
export type StorageHostProgress = z.infer<typeof storageHostProgressSchema>;
