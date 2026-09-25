import { isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  CoreErrorType,
  PLAN_MODE_MAX_PLAN_CHARS,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type MessageWithParts,
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
// 控制字符（NUL 会让 fs 写入直接失败、ESC 等会静默进磁盘）并入非法字符类一次清掉；
// 匹配控制字符正是本行的目的，故豁免 no-control-regex。
// oxlint-disable-next-line eslint/no-control-regex
const PLAN_SLUG_ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const PLAN_SLUG_WHITESPACE = /\s+/g;
const PLAN_SLUG_DUPLICATE_UNDERSCORES = /_+/g;
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
 * slugify：Cursor `PlanStorageService.sanitizeFileName` 同款规则，另加控制字符清理。
 * 只替换 Windows 非法字符、控制字符与空白为 `_`，中文与其它 Unicode 原样保留；空结果回退 `plan`。
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

export interface SessionPlanForkCopyResult {
  copied: SessionPlanFileWrittenFact[];
  paths: string[];
}

/**
 * 将 Fork 复制前缀中实际出现的 ExitPlanMode 计划复制到 child 会话目录。
 * 复制是幂等的：目标内容已一致时直接复用；目标内容不一致时拒绝覆盖。
 */
export async function copySessionPlanFilesForFork(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  messages: readonly MessageWithParts[];
  parentSessionId: SessionId | string;
  childSessionId: SessionId | string;
  toolCallIdMap: ReadonlyMap<string, string>;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<SessionPlanForkCopyResult> {
  const reachableToolCallIds = new Set<string>();
  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.tool === "ExitPlanMode") {
        reachableToolCallIds.add(part.callID);
      }
    }
  }
  if (reachableToolCallIds.size === 0) return { copied: [], paths: [] };

  const sourcePlans = await listSessionPlanFiles({
    abortSignal: input.abortSignal,
    fileSystemPort: input.fileSystemPort,
    sessionId: input.parentSessionId,
    traceContext: input.traceContext,
    workspaceRoot: input.workspaceRoot,
  });
  const copied: SessionPlanFileWrittenFact[] = [];
  const paths: string[] = [];
  try {
    for (const source of sourcePlans) {
      const sourceFile = await readSessionPlanFile({
        abortSignal: input.abortSignal,
        fileSystemPort: input.fileSystemPort,
        path: source.path,
        readWholeFile: true,
        traceContext: input.traceContext,
      });
      if (!sourceFile) continue;
      const sourceMeta = parseSessionPlanFile(sourceFile.content);
      if (
        !sourceMeta.createdAt ||
        !sourceMeta.toolCallId ||
        !reachableToolCallIds.has(sourceMeta.toolCallId)
      ) {
        continue;
      }
      const childToolCallId = input.toolCallIdMap.get(sourceMeta.toolCallId);
      if (!childToolCallId) continue;
      const content = serializeSessionPlanFile({
        createdAt: sourceMeta.createdAt,
        overview: sourceMeta.overview,
        plan: sourceMeta.body,
        title: sourceMeta.title,
        toolCallId: childToolCallId,
      });
      const path = join(
        resolveSessionPlansDir({ sessionId: input.childSessionId, workspaceRoot: input.workspaceRoot }),
        `${source.planId}${PLAN_FILE_EXTENSION}`,
      );
      const existing = await readSessionPlanFile({
        abortSignal: input.abortSignal,
        fileSystemPort: input.fileSystemPort,
        path,
        readWholeFile: true,
        traceContext: input.traceContext,
      });
      const existingMeta = existing ? parseSessionPlanFile(existing.content) : undefined;
      const canRefreshToolCallId =
        existingMeta?.toolCallId !== undefined &&
        existingMeta.createdAt === sourceMeta.createdAt &&
        existingMeta.title === sourceMeta.title &&
        existingMeta.overview === sourceMeta.overview &&
        existingMeta.body === sourceMeta.body;
      if (existing && existing.content !== content && !canRefreshToolCallId) {
        throw createCoreError(
          CoreErrorType.InvalidStateTransition,
          "Fork plan target already exists with different content",
          {
            context: {
              parentSessionId: String(input.parentSessionId),
              childSessionId: String(input.childSessionId),
              planId: source.planId,
            },
            recoverable: true,
          },
        );
      }
      if (!existing || existing.content !== content) {
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
        paths.push(path);
      }
      copied.push({ path, planId: source.planId, toolCallId: childToolCallId });
    }
    return { copied, paths };
  } catch (error) {
    await removeSessionPlanFilesForFork({
      fileSystemPort: input.fileSystemPort,
      paths,
      traceContext: input.traceContext,
    });
    throw error;
  }
}

export interface SessionPlanForkCleanupResult {
  failedPaths: string[];
}

export async function removeSessionPlanFilesForFork(input: {
  fileSystemPort: FileSystemPort;
  paths: readonly string[];
  traceContext?: TraceContext;
}): Promise<SessionPlanForkCleanupResult> {
  const failedPaths: string[] = [];
  for (const path of input.paths) {
    try {
      await input.fileSystemPort.removeFile({ missingOk: true, path, trace: input.traceContext });
    } catch {
      failedPaths.push(path);
    }
  }
  return { failedPaths };
}


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

/** 读取计划 frontmatter 中的 created。读失败视为历史文件（undefined，排序时最旧）。 */
async function readPlanFileCreatedAt(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  path: string;
  traceContext?: TraceContext;
}): Promise<string | undefined> {
  try {
    const file = await readSessionPlanFile({
      abortSignal: input.abortSignal,
      fileSystemPort: input.fileSystemPort,
      path: input.path,
      traceContext: input.traceContext,
    });
    if (!file) return undefined;
    return parseSessionPlanFile(file.content).createdAt;
  } catch (error) {
    // 注释承诺的降级：单份计划读不出来只让它排最旧，不失败整次列举。
    // 用户取消仍然上抛，否则会静默地跑完一次没人要的列举。
    if (isFileSystemPortError(error) && error.code === "cancelled") throw error;
    return undefined;
  }
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
  readWholeFile?: boolean;
  traceContext?: TraceContext;
}): Promise<SessionPlanFileContent | undefined> {
  try {
    const read = await input.fileSystemPort.readTextFile(
      {
        maxBytes: input.readWholeFile ? undefined : input.maxBytes ?? PLAN_FILE_REFERENCE_MAX_BYTES,
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
 * 压缩后的计划连续性：只提示最新计划的工作区相对路径。
 * 计划正文由模型按需通过 ListPlans 或 Read 取回，避免把计划全文重新塞回压缩上下文。
 */
export async function readLatestPlanFilePathEntry(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<RuntimeMessageEntry | undefined> {
  let plans: SessionPlanFileEntry[];
  try {
    plans = await listSessionPlanFiles(input);
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "cancelled") throw error;
    return undefined;
  }
  const latest = plans.at(-1);
  if (!latest) return undefined;
  const relativePath = relative(input.workspaceRoot, latest.path);
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFilePathReference(relativePath.split(sep).join("/")),
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

function formatPlanFilePathReference(planFilePath: string): string {
  return [
    `A plan file from plan mode is available at: ${planFilePath}`,
    "Use ListPlans or Read if the plan is relevant to the current work.",
  ].join("\n");
}
