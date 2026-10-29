import type { FileTextWindow } from "@zcode/shared";
import type {
  FilesLargeTextWindowOwner,
  FilesLargeTextWindowReader,
  FilesLargeTextWindowSnapshot,
  FilesLargeTextWindowWatch,
} from "@/files-workbench/filesLargeTextWindowTypes.js";

/**
 * buffer 作用域的唯一窗口 entry。请求编排、seed、失败通知与租约流程
 * 共享同一份 entry 结构。
 */
export interface FilesLargeTextWindowEntry {
  owner: FilesLargeTextWindowOwner;
  generation: number;
  requestSeq: number;
  refCount: number;
  activeCount: number;
  snapshot: FilesLargeTextWindowSnapshot;
  listeners: Set<() => void>;
  readWindow: FilesLargeTextWindowReader;
  watch?: FilesLargeTextWindowWatch;
  stopWatch?: () => void;
  /** 外部文件变化序号；请求期间变化时不得用迟到结果替换旧窗口。 */
  changeSeq: number;
  initialTotalBytes?: number;
  /** 编辑草稿基准版本；有值时读取必须带 expectedVersion。 */
  expectedVersion?: string;
  /** 最近一次请求的块索引；失败清空块后重试仍回到同一块。 */
  requestedBlockIndex?: number;
  /** 有界探针序号；后发探针结果覆盖先发结果，不参与块请求序号。 */
  probeSeq: number;
  probeInFlight?: { window: FileTextWindow; requestSeq: number; probeSeq: number };
}

export function createFilesLargeTextWindowEntry(params: {
  owner: FilesLargeTextWindowOwner;
  generation: number;
  readWindow: FilesLargeTextWindowReader;
  initialTotalBytes?: number;
  watch?: FilesLargeTextWindowWatch;
  snapshot: FilesLargeTextWindowSnapshot;
}): FilesLargeTextWindowEntry {
  return {
    owner: params.owner,
    generation: params.generation,
    requestSeq: 0,
    refCount: 0,
    activeCount: 0,
    snapshot: params.snapshot,
    listeners: new Set(),
    readWindow: params.readWindow,
    watch: params.watch,
    changeSeq: 0,
    initialTotalBytes: params.initialTotalBytes,
    probeSeq: 0,
  };
}
