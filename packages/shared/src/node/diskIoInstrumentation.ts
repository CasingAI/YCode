import {
  createDiskIoTracker,
  type DiskIoInstrumentationOptions,
  type NodeDiskIoInstrumentation,
} from "./diskIoInstrumentationTracker.js";
import { installDiskIoFilePatches } from "./diskIoFileInstrumentation.js";
import { installDiskIoSqlitePatches } from "./diskIoSqliteInstrumentation.js";
import { syncBuiltinEsmExports } from "./diskIoInstrumentationShared.js";

let installedController: NodeDiskIoInstrumentation | undefined;

export { classifyDiskIoModule } from "./diskIoInstrumentationShared.js";
export type { DiskIoInstrumentationOptions, NodeDiskIoInstrumentation };

/** 在 Main、Host、Agent 的启动边界调用；所有指标只在当前进程内存中聚合。 */
export function installNodeDiskIoInstrumentation(
  options: DiskIoInstrumentationOptions,
): NodeDiskIoInstrumentation {
  if (installedController) {
    installedController.setBatchHandler(options.onBatch);
    return installedController;
  }
  const tracker = createDiskIoTracker(options);
  installDiskIoFilePatches(tracker);
  installDiskIoSqlitePatches(tracker);
  // 让通过 ESM 命名导入的 node:fs API 也指向包装后的函数。
  syncBuiltinEsmExports();
  installedController = tracker;
  return tracker;
}
