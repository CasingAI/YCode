// 过程段内部的「同文件 + 同动作 + 同终态」合并。
// 纯投影：只读已物化的 ToolCallRow，不改行数据、持久化或协议。
// 合并项仍保留组内全部原始行，展开后由调用方按原序逐条渲染。
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { getToolCallActivityTarget } from "@/lib/toolCallActivity.js";
import {
  isPlainRecord,
  readRawToolCallChanges,
  type EditOperationKind,
  type RawToolCallFileSummary,
} from "@/ToolCallBlocks/fileSummaryTypes.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import type { ConversationAssistantWorkChildItem } from "@/v4/conversationAssistantWorkItems.js";
import type { ProcessBucket } from "@/v4/conversationProcess.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

export type FileActivityBucket = "file-read" | "directory-list" | "changes";
export type FileActivityStatus = "success" | "error" | "cancelled" | "denied";

export interface ConversationFileActivityRenderItem {
  kind: "fileActivity";
  /** 锚定组内首行：流式追加同文件调用时不重建组件与展开态。 */
  key: string;
  rowId: number;
  bucket: FileActivityBucket;
  /** 展示用原始路径（保留组内首行的写法）。 */
  path: string;
  status: FileActivityStatus;
  rows: ToolCallRow[];
}

export type ConversationProcessChildItem =
  | ConversationAssistantWorkChildItem
  | ConversationFileActivityRenderItem;

interface FileActivityKey {
  bucket: FileActivityBucket;
  path: string;
  status: FileActivityStatus;
  token: string;
}

function isFileActivityBucket(bucket: ProcessBucket | null): bucket is FileActivityBucket {
  return bucket === "file-read" || bucket === "directory-list" || bucket === "changes";
}

/**
 * 路径归一只做分隔符与首尾空白处理，不做绝对/相对路径换算。
 * 拿不到唯一路径的调用保持逐条，避免把不同文件误合并。
 */
export function normalizeFileActivityPath(path: string): string {
  return path.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function readFileActivityStatus(row: ToolCallRow): FileActivityStatus | null {
  if (row.permissionDenial) {
    return "denied";
  }
  switch (row.status) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      // 输入生成、等待审批、运行中都不参与合并：这些行还在变化，合并会隐藏进度。
      return null;
  }
}

function readReadTargetPath(row: ToolCallRow, bucket: FileActivityBucket): string | null {
  if (bucket === "changes") {
    return null;
  }
  // 与 classifyProcessRow 使用同一套目标提取：不在这里另写路径字段表。
  const target = getToolCallActivityTarget(
    {
      toolName: row.toolName,
      kind: row.kind,
      input: row.input,
      output: row.output?.text,
    },
    bucket,
  );
  return target?.trim() || null;
}

function collectStringPath(value: unknown, paths: string[]) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) paths.push(trimmed);
}

function readPathFields(value: unknown, paths: string[]) {
  if (!isPlainRecord(value)) return;
  for (const key of [
    "path",
    "filePath",
    "file_path",
    "targetPath",
    "target_path",
    "filename",
    "file",
  ]) {
    collectStringPath(value[key], paths);
  }
}

function readDisplayFilePaths(display: unknown, paths: string[]) {
  if (!isPlainRecord(display)) return;
  const inner = isPlainRecord(display.display) ? display.display : display;
  if (inner.kind === "file_diff") {
    collectStringPath(inner.filePath ?? inner.file_path ?? inner.path, paths);
    return;
  }
  if (inner.kind !== "file_diffs" || !Array.isArray(inner.files)) return;
  for (const file of inner.files) {
    if (isPlainRecord(file)) {
      collectStringPath(file.filePath ?? file.file_path ?? file.path, paths);
    }
  }
}

function readChangeKeys(value: unknown, paths: string[]) {
  if (!isPlainRecord(value)) return;
  for (const key of Object.keys(value)) {
    collectStringPath(key, paths);
  }
}

/**
 * 写入类工具的目标路径：只读 input / raw changes / display，不构建 diff。
 * 返回去重后的原始写法；多路径（多文件 patch）由调用方判定为不可合并。
 */
export function readFileWriteTargetPaths(row: ToolCallRow): string[] {
  const legacy = toolCallRowToLegacyNode(row).toolCall;
  const candidates: string[] = [];
  readPathFields(legacy.input, candidates);
  readChangeKeys(isPlainRecord(legacy.raw) ? legacy.raw.changes : undefined, candidates);
  const { rawInputChanges, rawOutputChanges } = readRawToolCallChanges(legacy.raw);
  readChangeKeys(rawInputChanges, candidates);
  readChangeKeys(rawOutputChanges, candidates);
  readDisplayFilePaths(legacy.raw, candidates);

  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const key = normalizeFileActivityPath(candidate);
    if (key && !unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

interface ResolvedFileActivity {
  key: FileActivityKey;
  row: ToolCallRow;
}

function resolveFileActivityKey(
  node: ConversationAssistantWorkChildItem,
  bucket: ProcessBucket | null,
): ResolvedFileActivity | null {
  if (node.kind !== "row" || node.row.kind !== "toolCall") return null;
  if (!isFileActivityBucket(bucket)) return null;

  const row = node.row;
  const status = readFileActivityStatus(row);
  if (!status) return null;

  const paths =
    bucket === "changes"
      ? readFileWriteTargetPaths(row)
      : [readReadTargetPath(row, bucket)].filter((path): path is string => path !== null);
  if (paths.length !== 1) return null;

  const path = paths[0]!;
  const pathKey = normalizeFileActivityPath(path);
  if (!pathKey) return null;

  return {
    row,
    key: {
      bucket,
      path,
      status,
      token: `${bucket}\u0000${pathKey}\u0000${status}`,
    },
  };
}

/**
 * 把连续同键的读取/列目录/编辑节点替换成一条文件活动项。
 * 非候选节点原样保留；单条候选不生成合并项，避免多一层无意义折叠。
 */
export function mergeFileActivityNodes(
  nodes: readonly ConversationAssistantWorkChildItem[],
  resolveBucket: (node: ConversationAssistantWorkChildItem) => ProcessBucket | null,
): ConversationProcessChildItem[] {
  const merged: ConversationProcessChildItem[] = [];
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index]!;
    const resolved = resolveFileActivityKey(node, resolveBucket(node));
    if (!resolved) {
      merged.push(node);
      index += 1;
      continue;
    }

    const rows: ToolCallRow[] = [resolved.row];
    let next = index + 1;
    while (next < nodes.length) {
      const candidate = nodes[next]!;
      const candidateResolved = resolveFileActivityKey(candidate, resolveBucket(candidate));
      if (!candidateResolved || candidateResolved.key.token !== resolved.key.token) break;
      rows.push(candidateResolved.row);
      next += 1;
    }

    if (rows.length < 2) {
      merged.push(node);
      index += 1;
      continue;
    }

    const first = rows[0]!;
    merged.push({
      kind: "fileActivity",
      key: `fileActivity:${first.rowId}`,
      rowId: first.rowId,
      bucket: resolved.key.bucket,
      path: resolved.key.path,
      status: resolved.key.status,
      rows,
    });
    index = next;
  }

  return merged;
}

export interface FileActivityChangeSummary {
  changeStat: { added: number; removed: number } | null;
  operationKinds: EditOperationKind[];
  actionLabels: RawToolCallFileSummary["actionLabel"][];
}

/**
 * 聚合一次合并行内同文件调用的 diff 统计。
 * 只在合并行真正渲染时调用，避免流式期间为未展开的组反复解析 patch。
 */
export function summarizeFileActivityChanges(
  rows: readonly ToolCallRow[],
  path: string,
): FileActivityChangeSummary {
  const pathKey = normalizeFileActivityPath(path);
  let added = 0;
  let removed = 0;
  let hasStat = false;
  const operationKinds = new Set<EditOperationKind>();
  const actionLabels: RawToolCallFileSummary["actionLabel"][] = [];

  for (const row of rows) {
    const legacy = toolCallRowToLegacyNode(row).toolCall;
    for (const summary of readRawToolCallFileSummaries(legacy.raw, legacy)) {
      if (normalizeFileActivityPath(summary.path) !== pathKey) continue;
      operationKinds.add(summary.operationKind);
      actionLabels.push(summary.actionLabel);
      if (summary.changeStat) {
        added += summary.changeStat.added;
        removed += summary.changeStat.removed;
        hasStat = true;
      }
    }
  }

  return {
    changeStat: hasStat ? { added, removed } : null,
    operationKinds: [...operationKinds],
    actionLabels,
  };
}
