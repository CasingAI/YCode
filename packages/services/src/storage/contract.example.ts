import type { IStorageService } from "./contract.js";

export async function readStorageUsage(service: IStorageService) {
  return service.getSnapshot();
}
