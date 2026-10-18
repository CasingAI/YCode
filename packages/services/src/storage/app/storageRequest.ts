import {
  storageCleanRequestSchema,
  type StorageCleanRequest,
} from "@zcode/shared";

export function validateStorageCleanRequest(
  request: StorageCleanRequest,
): void {
  storageCleanRequestSchema.parse(request);
}
