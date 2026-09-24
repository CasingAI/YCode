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
// planId 形如 <slug>-<8位hash>：slug 从计划 title 机械推导（Cursor 同款规则），
// hash 只做同名去重；创建时间与 toolCallId 随 frontmatter 落盘，不再进文件名。
const PLAN_SLUG_MAX_CHARS = 100;
const PLAN_SLUG_ILLEGAL_CHARS = /[<>:"/\\|?*]/g;
const PLAN_SLUG_WHITESPACE = /\s+/g;
const PLAN_SLUG_DUPLICATE_UNDERSCORES = /_+/g;
const PLAN_META_PROBE_BYTES = 8_192;
const PLAN_FRONTMATTER_FENCE = "---";
// 标题提取与 UI 的 getPlanDirectoryTitle 同一条规则：首个 H1 优先，否则首个非空文本行。
const PLAN_TITLE_H1_PATTERN = /^\s{0,3}#(?!#)\s+(.+?)\s*#*\s*$/m;
const PLAN_TITLE_LEADING_DECORATION = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/;
export const PLAN_TITLE_MAX_CHARS = 120;

export interface SessionPlanFileEntry {
  planId: string;
  path: string;
  /** frontmatter 的 created（ISO 字符串）；历史无 frontmatter 文件为 undefined，视为最旧。 */
  createdAt: string | undefined;
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
 * planId = <slug>-<8位hash>。slug 从计划 title 机械推导（见 slugifyPlanTitle），
 * hash 是 toolCallId + created 的确定性 32 位哈希（FNV-1a，8 位 hex），只负责
 * 同毫秒同标题的去重，不承载可逆信息。创建时间与 toolCallId 随 frontmatter 落盘。
 */
export function buildSessionPlanId(input: {
  now?: Date;
  title: string;
  toolCallId: string;
}): string {
  const now = input.now ?? new Date();
  const slug = slugifyPlanTitle(input.title);
  const hash = hashPlanFileSuffix(`${input.toolCallId}${now.toISOString()}`);
  return `${slug}-${hash}`;
}

/**
 * slugify：Cursor `PlanStorageService.sanitizeFileName` 同款规则。
 * 只替换 Windows 非法字符与空白为 `_`，中文与其它 Unicode 原样保留；空结果回退 `plan`。
 */
export function slugifyPlanTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(PLAN_SLUG_ILLEGAL_CHARS, "_")
    .replace(PLAN_SLUG_WHITESPACE, "_")
    .replace(PLAN_SLUG_DUPLICATE_UNDERSCORES, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, PLAN_SLUG_MAX_CHARS);
  return slug || "plan";
}

function hashPlanFileSuffix(value: string): string {
  // FNV-1a 32 位：确定性、无依赖，同一次提交重复计算得同一后缀。
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ParsedSessionPlanFile {
  /** frontmatter 之后的计划正文；无 frontmatter 时即原文（仅去 BOM）。 */
  body: string;
  overview: string | undefined;
  title: string | undefined;
  /** 落盘时刻的 ISO 字符串；历史无 frontmatter 文件为 undefined。 */
  createdAt: string | undefined;
  /** 触发本次落盘的 ExitPlanMode 工具调用 id（原始形态）；历史文件为 undefined。 */
  toolCallId: string | undefined;
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
    return { body: normalized, createdAt: undefined, overview: undefined, title: undefined, toolCallId: undefined };
  }
  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === PLAN_FRONTMATTER_FENCE,
  );
  if (endIndex < 0) {
    return { body: normalized, createdAt: undefined, overview: undefined, title: undefined, toolCallId: undefined };
  }

  const body = lines.slice(endIndex + 1).join("\n");
  let meta: unknown;
  try {
    meta = parseYaml(lines.slice(1, endIndex).join("\n"));
  } catch {
    return { body, createdAt: undefined, overview: undefined, title: undefined, toolCallId: undefined };
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { body, createdAt: undefined, overview: undefined, title: undefined, toolCallId: undefined };
  }
  return {
    body,
    createdAt: readPlanMetaString(meta, "created"),
    overview: readPlanMetaString(meta, "overview"),
    title: readPlanMetaString(meta, "title"),
    toolCallId: readPlanMetaString(meta, "toolCallId"),
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
 * frontmatter 键序固定 title → overview → created → toolCallId：同一份计划两次序列化必须
 * 逐字节相同，否则任何按内容寻址或比对的场景都会出现无意义 diff。yaml stringify 自带尾换行。
 * created 与 toolCallId 不进文件名：created 是「最新是哪份」的唯一排序依据（写入即固定，
 * 区别于可被编辑改变的 mtime），toolCallId 是冷恢复反查的键，二者都从文件头读回。
 */
function serializeSessionPlanFile(input: {
  createdAt: string;
  overview: string | undefined;
  plan: string;
  title: string | undefined;
  toolCallId: string;
}): string {
  const meta: Record<string, string> = {};
  if (input.title) meta.title = input.title;
  if (input.overview) meta.overview = input.overview;
  meta.created = input.createdAt;
  meta.toolCallId = input.toolCallId;
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
  const createdAt = now.toISOString();
  // slug 的派生源是物化后的 title（显式输入 ?? 正文提取），与 frontmatter 的 title 同值：
  // 文件名与文件头看到的是同一个标题。
  const title = input.title?.trim() || extractPlanTitleFromBody(input.plan) || undefined;
  const planId = buildSessionPlanId({ now, title: title ?? "plan", toolCallId: input.toolCallId });
  const path = `${join(resolveSessionPlansDir(input), planId)}${PLAN_FILE_EXTENSION}`;
  const overview = input.overview?.trim() || undefined;
  const content = serializeSessionPlanFile({
    createdAt,
    overview,
    plan: input.plan,
    title,
    toolCallId: input.toolCallId,
  });
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
  return { createdAt, path, planId };
}

/** 列出会话的全部计划文件，按 created 升序（无 created 的历史文件视为最旧），最新一条在末尾。目录不存在即空。 */
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
  const files = entries.filter((entry) => entry.kind === "file" && entry.name.endsWith(PLAN_FILE_EXTENSION));
  const withCreated = await Promise.all(
    files.map(async (entry) => ({
      path: entry.path,
      planId: entry.name.slice(0, -PLAN_FILE_EXTENSION.length),
      createdAt: await readPlanFileCreatedAt({
        abortSignal: input.abortSignal,
        fileSystemPort: input.fileSystemPort,
        path: entry.path,
        traceContext: input.traceContext,
      }),
    })),
  );
  return withCreated.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      if (left.createdAt === undefined) return -1;
      if (right.createdAt === undefined) return 1;
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    return left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0;
  });
}

/**
 * 只读文件头（frontmatter 探测预算内）取 created。读失败视为历史文件（undefined，
 * 排序时最旧），不让单个坏文件拖累整次列举——与 readSessionPlanFile 的 not_found 兜底同理。
 */
async function readPlanFileCreatedAt(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  path: string;
  traceContext?: TraceContext;
}): Promise<string | undefined> {
  const file = await readSessionPlanFile({
    abortSignal: input.abortSignal,
    fileSystemPort: input.fileSystemPort,
    maxBytes: PLAN_META_PROBE_BYTES,
    path: input.path,
    traceContext: input.traceContext,
  });
  if (!file) return undefined;
  return parseSessionPlanFile(file.content).createdAt;
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
 * 每个文件的文件头（frontmatter 的 `toolCallId`）记录了触发落盘的调用；与 ListPlans 读的是
 * 同一份目录。无 frontmatter 的历史文件无法反查调用，会被跳过（消费方按 toolCallId 匹配
 * 失败即忽略，不会错挂到别的调用上）。
 */
export async function readSessionPlanFileWrittenFacts(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<SessionPlanFileWrittenFact[]> {
  const plans = await listSessionPlanFiles(input);
  const facts = await Promise.all(
    plans.map(async (plan) => {
      const file = await readSessionPlanFile({
        abortSignal: input.abortSignal,
        fileSystemPort: input.fileSystemPort,
        maxBytes: PLAN_META_PROBE_BYTES,
        path: plan.path,
        traceContext: input.traceContext,
      });
      const toolCallId = file ? parseSessionPlanFile(file.content).toolCallId : undefined;
      return toolCallId ? [{ planId: plan.planId, toolCallId, path: plan.path }] : [];
    }),
  );
  return facts.flat();
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
