import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
const PLAN_FRONTMATTER_FENCE = "---";
// 标题提取与 UI 的 getPlanDirectoryTitle 同一条规则：首个 H1 优先，否则首个非空文本行。
const PLAN_TITLE_H1_PATTERN = /^\s{0,3}#(?!#)\s+(.+?)\s*#*\s*$/m;
const PLAN_TITLE_LEADING_DECORATION = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/;
export const PLAN_TITLE_MAX_CHARS = 120;

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

export interface ParsedSessionPlanFile {
  /** frontmatter 之后的计划正文；无 frontmatter 时即原文（仅去 BOM）。 */
  body: string;
  overview: string | undefined;
  title: string | undefined;
}

/**
 * 计划文件 = YAML frontmatter（title/overview/created）+ 正文，frontmatter 由运行时写入。
 * 解析失败（YAML 损坏、围栏不闭合）不让整份计划失效：正文取围栏之后的部分，元数据视为不存在，
 * 标题由消费方走提取回退。历史无 frontmatter 的文件在这里自然落到 body = 原文。
 */
export function parseSessionPlanFile(content: string): ParsedSessionPlanFile {
  const normalized = content.replace(/^\uFEFF/u, "");
  const lines = normalized.split(/\r?\n/u);
  if (lines[0]?.trim() !== PLAN_FRONTMATTER_FENCE) {
    return { body: normalized, overview: undefined, title: undefined };
  }
  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === PLAN_FRONTMATTER_FENCE,
  );
  if (endIndex < 0) {
    return { body: normalized, overview: undefined, title: undefined };
  }

  const body = lines.slice(endIndex + 1).join("\n");
  let meta: unknown;
  try {
    meta = parseYaml(lines.slice(1, endIndex).join("\n"));
  } catch {
    return { body, overview: undefined, title: undefined };
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { body, overview: undefined, title: undefined };
  }
  return {
    body,
    overview: readPlanMetaString(meta, "overview"),
    title: readPlanMetaString(meta, "title"),
  };
}

/** 计划标题提取：首个 H1 优先，否则首个非空文本行（去前缀装饰）。与 UI getPlanDirectoryTitle 同规则。 */
export function extractPlanTitleFromBody(body: string): string | undefined {
  const h1 = PLAN_TITLE_H1_PATTERN.exec(body)?.[1]?.trim();
  if (h1) return truncatePlanTitle(h1);
  for (const line of body.split(/\r?\n/u)) {
    const title = line.replace(PLAN_TITLE_LEADING_DECORATION, "").trim();
    if (title) return truncatePlanTitle(title);
  }
  return undefined;
}

function truncatePlanTitle(title: string): string | undefined {
  const truncated = title.length > PLAN_TITLE_MAX_CHARS ? title.slice(0, PLAN_TITLE_MAX_CHARS) : title;
  return truncated || undefined;
}

function readPlanMetaString(meta: object, key: string): string | undefined {
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * frontmatter 键序固定 title → overview：同一份计划两次序列化必须逐字节相同，
 * 否则任何按内容寻址或比对的场景都会出现无意义 diff。yaml stringify 自带尾换行。
 * 不写 created：创建时间的唯一所有者是文件名（planId 时间戳前缀），不重复这份事实。
 */
function serializeSessionPlanFile(input: {
  overview: string | undefined;
  plan: string;
  title: string | undefined;
}): string {
  const meta: Record<string, string> = {};
  if (input.title) meta.title = input.title;
  if (input.overview) meta.overview = input.overview;
  if (Object.keys(meta).length === 0) return input.plan;
  return `${PLAN_FRONTMATTER_FENCE}\n${stringifyYaml(meta)}${PLAN_FRONTMATTER_FENCE}\n${input.plan}`;
}

/**
 * 落盘一次计划提交。由 ExitPlanMode 的 beforePermission 钩子调用——它站在审批门之前，
 * 所以批准与拒绝（v4 UI 的静默拒绝）两种结局下文件都已存在。每次提交写一个新文件，
 * 从不覆盖旧文件。文件 = 运行时生成的 frontmatter（title/overview/created）+ 计划正文。
 */
export async function writeSessionPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  now?: Date;
  overview?: string;
  plan: string;
  sessionId: SessionId | string;
  title?: string;
  toolCallId: string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<SessionPlanFileEntry> {
  if (!input.plan.trim()) {
    throw createCoreError(CoreErrorType.InvalidInput, "ExitPlanMode plan cannot be empty", {
      recoverable: true,
    });
  }

  const now = input.now ?? new Date();
  const planId = buildSessionPlanId({ now, toolCallId: input.toolCallId });
  const path = `${join(resolveSessionPlansDir(input), planId)}${PLAN_FILE_EXTENSION}`;
  // frontmatter 的 title 物化「显式输入 ?? 正文提取」的解析结果，保证文件自描述：
  // 即使正文没有干净 H1，外部工具也能读到标题。
  const title = input.title?.trim() || extractPlanTitleFromBody(input.plan) || undefined;
  const overview = input.overview?.trim() || undefined;
  const content = serializeSessionPlanFile({ overview, plan: input.plan, title });
  await input.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content,
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

/** 一次计划落盘：哪个工具调用、落了哪份、落在哪。 */
export interface SessionPlanFileWrittenFact {
  planId: string;
  toolCallId: string;
  path: string;
}

/**
 * 「哪个调用落了哪份计划」的**持久**来源。
 *
 * 内存事件里的 `plan_file_written` 只在进程内存活：重启后冷恢复只能从 transcript 重放，
 * 而 transcript 不记录落盘路径（拒绝审批时连工具输出都没有）。于是这里从计划目录重推导——
 * planId 自带 toolCallId，文件名就是「哪个调用」的答案；与 ListPlans 读的是同一份目录。
 *
 * 返回值里的 toolCallId 是文件名字段，即已经 sanitize 过的形态；含特殊字符的调用 id
 * 会因此对不上工具行（消费方按 toolCallId 匹配失败即忽略），不会错挂到别的调用上。
 */
export async function readSessionPlanFileWrittenFacts(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<SessionPlanFileWrittenFact[]> {
  const plans = await listSessionPlanFiles(input);
  return plans.flatMap((plan) => {
    const toolCallId = parseSessionPlanId(plan.planId).toolCallId;
    return toolCallId ? [{ planId: plan.planId, toolCallId, path: plan.path }] : [];
  });
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
 * 压缩后的计划连续性：读最新一份计划，把剥掉 frontmatter 的正文作为 plan_file_reference
 * 提醒重新注入（元数据对模型是噪音，title/overview 走结构化字段）。没有计划文件
 * （从未提交过计划，或目录不可读）时返回 undefined，压缩照常完成。
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
  const { body } = parseSessionPlanFile(file.content);
  if (!body.trim()) return undefined;
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFileReference({ planContent: body, planFilePath: file.path }),
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
