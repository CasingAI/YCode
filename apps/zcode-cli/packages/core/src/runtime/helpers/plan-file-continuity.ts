import { join } from "node:path";
import {
  CoreErrorType,
  PLAN_MODE_MAX_PLAN_CHARS,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const PLAN_FILE_REFERENCE_MAX_BYTES = PLAN_MODE_MAX_PLAN_CHARS * 4 + 1024;
const PLAN_FILE_EXTENSION = ".md";
// planId 形如 <YYYYMMDD-HHmmssSSS>-<toolCallId>；时间戳段定长，前缀即创建时间。
const PLAN_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})-(.+)$/;

export interface SessionPlanFileEntry {
  planId: string;
  path: string;
}

export interface SessionPlanFileContent {
  content: string;
  path: string;
}

/**
 * 会话计划目录：`.zcode/plans/<sanitize(sessionId)>/`。一会话一目录，目录内一计划一文件，
 * 因此「列一个会话的全部计划」就是列一个目录，「最新一条」就是排序最后一条。
 */
export function resolveSessionPlansDir(input: {
  sessionId: SessionId | string;
  workspaceRoot: string;
}): string {
  return join(
    input.workspaceRoot,
    ".zcode",
    "plans",
    sanitizePlanFileNameSegment(String(input.sessionId), "Session id"),
  );
}

/**
 * planId = <UTC 时间戳>-<toolCallId>。时间戳前缀使文件名字典序 = 时间序，
 * 「最新」不需要解析内容或额外索引；toolCallId 与 UI 计划目录的键对齐
 * （conversationStatusPanel 按 toolCallId 打开详情）。
 */
export function buildSessionPlanId(input: { now?: Date; toolCallId: string }): string {
  return `${formatPlanFileStamp(input.now ?? new Date())}-${sanitizePlanFileNameSegment(
    input.toolCallId,
    "Tool call id",
  )}`;
}

export function parseSessionPlanId(planId: string): {
  createdAt: string | undefined;
  toolCallId: string | undefined;
} {
  const match = PLAN_ID_PATTERN.exec(planId);
  if (!match) return { createdAt: undefined, toolCallId: undefined };
  const [, year, month, day, hour, minute, second, millisecond, toolCallId] = match;
  return {
    createdAt: `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`,
    toolCallId,
  };
}

/**
 * 落盘一次计划提交。由 ExitPlanMode 的 beforePermission 钩子调用——它站在审批门之前，
 * 所以批准与拒绝（v4 UI 的静默拒绝）两种结局下文件都已存在。每次提交写一个新文件，
 * 从不覆盖旧文件。
 */
export async function writeSessionPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  now?: Date;
  plan: string;
  sessionId: SessionId | string;
  toolCallId: string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<SessionPlanFileEntry> {
  if (!input.plan.trim()) {
    throw createCoreError(CoreErrorType.InvalidInput, "ExitPlanMode plan cannot be empty", {
      recoverable: true,
    });
  }

  const planId = buildSessionPlanId({ now: input.now, toolCallId: input.toolCallId });
  const path = `${join(resolveSessionPlansDir(input), planId)}${PLAN_FILE_EXTENSION}`;
  await input.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: input.plan,
      createParents: true,
      encoding: "utf8",
      path,
      trace: input.traceContext,
    },
    { signal: input.abortSignal },
  );
  return { path, planId };
}

/** 列出会话的全部计划文件，按 planId 升序（时间升序），最新一条在末尾。目录不存在即空。 */
export async function listSessionPlanFiles(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<SessionPlanFileEntry[]> {
  let entries;
  try {
    const listed = await input.fileSystemPort.listDirectory(
      { path: resolveSessionPlansDir(input), trace: input.traceContext },
      { signal: input.abortSignal },
    );
    entries = listed.entries;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(PLAN_FILE_EXTENSION))
    .map((entry) => ({
      path: entry.path,
      planId: entry.name.slice(0, -PLAN_FILE_EXTENSION.length),
    }))
    .sort((left, right) => (left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0));
}

/** 读取单个计划文件；not_found 视为不存在（并发清理是良性竞争），其余错误上抛。 */
export async function readSessionPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  maxBytes?: number;
  path: string;
  traceContext?: TraceContext;
}): Promise<SessionPlanFileContent | undefined> {
  try {
    const read = await input.fileSystemPort.readTextFile(
      {
        maxBytes: input.maxBytes ?? PLAN_FILE_REFERENCE_MAX_BYTES,
        path: input.path,
        trace: input.traceContext,
      },
      { signal: input.abortSignal },
    );
    return { content: read.content, path: input.path };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return undefined;
    throw error;
  }
}

/**
 * 压缩后的计划连续性：读最新一份计划原文，作为 plan_file_reference 提醒重新注入。
 * 没有计划文件（从未提交过计划，或目录不可读）时返回 undefined，压缩照常完成。
 */
export async function readLatestPlanFileReferenceEntry(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<RuntimeMessageEntry | undefined> {
  const plans = await listSessionPlanFiles(input);
  const latest = plans.at(-1);
  if (!latest) return undefined;
  const file = await readSessionPlanFile({
    abortSignal: input.abortSignal,
    fileSystemPort: input.fileSystemPort,
    path: latest.path,
    traceContext: input.traceContext,
  });
  if (!file || !file.content.trim()) return undefined;
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFileReference({ planContent: file.content, planFilePath: file.path }),
  );
}

function formatPlanFileReference(input: { planContent: string; planFilePath: string }): string {
  return [
    `A plan file exists from plan mode at: ${input.planFilePath}`,
    "",
    "Plan contents:",
    "",
    input.planContent,
    "",
    "If this plan is relevant to the current work and not already complete, continue working on it.",
  ].join("\n");
}

function sanitizePlanFileNameSegment(value: string, label: string): string {
  const sanitized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `${label} cannot produce a plan file name`,
      {
        recoverable: false,
      },
    );
  }
  return sanitized;
}

function formatPlanFileStamp(date: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}` +
    `-${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}${pad(date.getUTCMilliseconds(), 3)}`
  );
}
