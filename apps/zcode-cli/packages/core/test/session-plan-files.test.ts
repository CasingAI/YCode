import assert from "node:assert/strict";
import test from "node:test";
import {
  ExitPlanModeInputSchema,
  ListPlansOutputSchema,
  SessionEventType,
  createFileSystemError,
  type FileSystemPort,
  type PlanFileWrittenPayload,
  type SessionEvent,
} from "@zcode/contracts";
import {
  buildSessionPlanId,
  listSessionPlanFiles,
  parseSessionPlanFile,
  readLatestPlanFileReferenceEntry,
  readSessionPlanFile,
  resolveSessionPlansDir,
  slugifyPlanTitle,
  writeSessionPlanFile,
} from "../src/runtime/helpers/plan-file-continuity.js";
import { listSessionPlanFileWrittenFacts } from "../src/runtime/methods/plan-files.js";
import { exitPlanModeToolEntry } from "../src/tool/handlers/plan-mode.js";
import { listPlansToolEntry } from "../src/tool/handlers/list-plans.js";
import type { ToolBeforePermissionContext, ToolExecutionContext } from "../src/tool/types.js";
import { executeToolCall } from "../src/tool/executor/call-runner.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import type { PermissionBrokerPort } from "@zcode/contracts";

const WORKSPACE = "/workspace";
const SESSION_ID = "sess_test-123";
const EARLIER = new Date("2026-01-02T03:04:05.678Z");
const LATER = new Date("2026-01-02T03:04:06.678Z");

// ------------------------------------------------------------
// 内存版 fileSystemPort：只实现计划连续性用到的三个方法。
// ------------------------------------------------------------

class MemoryFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  port(): FileSystemPort {
    return {
      writeTextFile: async (request, options) => {
        if (options?.signal?.aborted) {
          // 与真实端口同语义：abort 后写操作以 cancelled 失败
          throw createFileSystemError({
            code: "cancelled",
            message: "write cancelled",
            path: request.path,
          });
        }
        this.registerParents(request.path);
        this.files.set(request.path, request.content);
        return {} as never;
      },
      readTextFile: async (request) => {
        const content = this.files.get(request.path);
        if (content === undefined) {
          throw createFileSystemError({
            code: "not_found",
            message: "missing",
            path: request.path,
          });
        }
        return { content } as never;
      },
      listDirectory: async (request) => {
        if (!this.directories.has(request.path)) {
          throw createFileSystemError({
            code: "not_found",
            message: "missing directory",
            path: request.path,
          });
        }
        const prefix = `${request.path}/`;
        const entries = [...this.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => ({ kind: "file" as const, name: path.slice(prefix.length), path }));
        return {
          entries,
          numEntries: entries.length,
          path: request.path,
          durationMs: 0,
        } as never;
      },
    } as unknown as FileSystemPort;
  }

  planPath(planId: string): string {
    return `${resolveSessionPlansDir({ sessionId: SESSION_ID, workspaceRoot: WORKSPACE })}/${planId}.md`;
  }

  private registerParents(path: string): void {
    const segments = path.split("/");
    for (let index = 2; index < segments.length; index += 1) {
      this.directories.add(segments.slice(0, index).join("/"));
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedPlan(
  port: FileSystemPort,
  toolCallId: string,
  content: string,
  now: Date,
  meta: { overview?: string; title?: string } = {},
): Promise<string> {
  const entry = await writeSessionPlanFile({
    fileSystemPort: port,
    now,
    overview: meta.overview,
    plan: content,
    sessionId: SESSION_ID,
    title: meta.title,
    toolCallId,
    workspaceRoot: WORKSPACE,
  });
  return entry.path;
}

function beforePermissionContext(
  overrides: Partial<ToolBeforePermissionContext> = {},
): ToolBeforePermissionContext {
  return {
    abortSignal: new AbortController().signal,
    fileSystemPort: new MemoryFileSystem().port(),
    mode: "plan",
    sessionId: SESSION_ID,
    toolCallId: "toolu_aaa",
    workspaceRoot: WORKSPACE,
    ...overrides,
  } as ToolBeforePermissionContext;
}

function toolContext(port: FileSystemPort): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    fileSystemPort: port,
    sessionId: SESSION_ID,
    toolCallId: "call_1",
    workspaceRoot: WORKSPACE,
  } as unknown as ToolExecutionContext;
}

// ------------------------------------------------------------
// planId 与路径规则
// ------------------------------------------------------------

test("planId：<slug>-<短hash>，同输入确定性、同标题不同调用不撞", () => {
  const first = buildSessionPlanId({ now: EARLIER, title: "测试计划", toolCallId: "toolu_aaa" });
  const same = buildSessionPlanId({ now: EARLIER, title: "测试计划", toolCallId: "toolu_aaa" });
  const otherCall = buildSessionPlanId({ now: EARLIER, title: "测试计划", toolCallId: "toolu_bbb" });
  assert.equal(first, same);
  assert.notEqual(first, otherCall);
  assert.match(first, /^测试计划-[0-9a-f]{8}$/);
});

test("slugifyPlanTitle：Cursor 同款规则，小写化、只替换非法字符与控制字符与空白、中文保留", () => {
  assert.equal(slugifyPlanTitle("Add Hardware Tab to VM Settings"), "add_hardware_tab_to_vm_settings");
  assert.equal(slugifyPlanTitle("缓存验收"), "缓存验收");
  assert.equal(slugifyPlanTitle("a/b:c  d"), "a_b_c_d");
  assert.equal(slugifyPlanTitle("  "), "plan");
  assert.ok(slugifyPlanTitle("x".repeat(200)).length <= 100);
  // 控制字符：NUL 会让 fs 写入失败、ESC 会静默进磁盘，两者都不能进文件名
  // ESC 开头的 slug 前导 `_` 被去首规则删掉；结尾 `[0m` 的 `_` 后还有字符故保留
  assert.equal(slugifyPlanTitle("修复\x00bug"), "修复_bug");
  assert.equal(slugifyPlanTitle("\x1b[31m修复bug\x1b[0m"), "[31m修复bug_[0m");
  assert.equal(slugifyPlanTitle("\x00\x1b\x07"), "plan");
});

test("writeSessionPlanFile：frontmatter 物化标题/概述/创建时间/调用，正文保持纯净", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();

  const first = await seedPlan(port, "toolu_aaa", "# Plan A\n内容 A", EARLIER, {
    overview: "做 A 不做 B。",
    title: "自定义标题",
  });
  const second = await seedPlan(port, "toolu_bbb", "# Plan B\n内容 B", LATER);

  const dir = resolveSessionPlansDir({ sessionId: SESSION_ID, workspaceRoot: WORKSPACE });
  assert.match(first, new RegExp(`^${escapeRegExp(dir)}/自定义标题-[0-9a-f]{8}\\.md$`));
  assert.match(second, new RegExp(`^${escapeRegExp(dir)}/plan_b-[0-9a-f]{8}\\.md$`));
  assert.equal(memory.files.size, 2);

  // 显式 title/overview 进 frontmatter，created/toolCallId 由运行时写入，正文逐字节保留
  const parsedFirst = parseSessionPlanFile(memory.files.get(first)!);
  assert.equal(parsedFirst.title, "自定义标题");
  assert.equal(parsedFirst.overview, "做 A 不做 B。");
  assert.equal(parsedFirst.createdAt, "2026-01-02T03:04:05.678Z");
  assert.equal(parsedFirst.toolCallId, "toolu_aaa");
  assert.equal(parsedFirst.body, "# Plan A\n内容 A");
  // 键序固定 title → overview → created → toolCallId，围栏包裹正文
  const rawLines = memory.files.get(first)!.split("\n");
  assert.equal(rawLines[0], "---");
  assert.ok(rawLines[1]?.startsWith("title: "));
  assert.ok(rawLines[2]?.startsWith("overview: "));
  assert.ok(rawLines[3]?.startsWith("created: "));
  assert.ok(rawLines[4]?.startsWith("toolCallId: "));
  assert.equal(rawLines[5], "---");
  assert.equal(rawLines[6], "# Plan A");

  // 未提供 title/overview 时，frontmatter 物化正文提取出的标题，正文原样
  const parsedSecond = parseSessionPlanFile(memory.files.get(second)!);
  assert.equal(parsedSecond.title, "Plan B");
  assert.equal(parsedSecond.overview, undefined);
  assert.equal(parsedSecond.body, "# Plan B\n内容 B");
});

test("parseSessionPlanFile：frontmatter 损坏时正文可用、元数据为空；无 frontmatter 按原文", () => {
  const broken = parseSessionPlanFile("---\ntitle: [未闭合\n---\n# 正文");
  assert.equal(broken.title, undefined);
  assert.equal(broken.overview, undefined);
  assert.equal(broken.createdAt, undefined);
  assert.equal(broken.toolCallId, undefined);
  assert.equal(broken.body, "# 正文");

  const legacy = parseSessionPlanFile("# 旧计划\n直接正文");
  assert.equal(legacy.body, "# 旧计划\n直接正文");
  assert.equal(legacy.title, undefined);
  assert.equal(legacy.overview, undefined);
  assert.equal(legacy.createdAt, undefined);
  assert.equal(legacy.toolCallId, undefined);
});

test("listSessionPlanFiles：按 created 升序、无 created 的历史文件最旧、忽略非 md、目录不存在返回空", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();
  await seedPlan(port, "toolu_bbb", "# B", LATER);
  await seedPlan(port, "toolu_aaa", "# A", EARLIER);
  memory.files.set(
    `${resolveSessionPlansDir({ sessionId: SESSION_ID, workspaceRoot: WORKSPACE })}/notes.txt`,
    "not a plan",
  );

  const files = await listSessionPlanFiles({
    fileSystemPort: port,
    sessionId: SESSION_ID,
    workspaceRoot: WORKSPACE,
  });
  // 按 created 升序：EARLIER 在前；同 created 时 planId 兜底保证稳定
  assert.equal(files.length, 2);
  assert.equal(files[0]?.createdAt, "2026-01-02T03:04:05.678Z");
  assert.equal(files[1]?.createdAt, "2026-01-02T03:04:06.678Z");
  assert.match(files[0]?.planId ?? "", /^[a-z0-9_-]+-[0-9a-f]{8}$/);

  const empty = await listSessionPlanFiles({
    fileSystemPort: port,
    sessionId: "sess_other",
    workspaceRoot: WORKSPACE,
  });
  assert.deepEqual(empty, []);
});

// ------------------------------------------------------------
// 压缩回注
// ------------------------------------------------------------

test("readLatestPlanFileReferenceEntry：注入最新一份剥掉 frontmatter 的正文", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();
  await seedPlan(port, "toolu_aaa", "# Plan A\n旧计划", EARLIER);
  await seedPlan(port, "toolu_bbb", "# Plan B\n新计划", LATER, {
    overview: "最新一份带元数据。",
    title: "Plan B",
  });

  const entry = await readLatestPlanFileReferenceEntry({
    fileSystemPort: port,
    sessionId: SESSION_ID,
    workspaceRoot: WORKSPACE,
  });

  assert.ok(entry);
  assert.equal(entry.kind, "attachment");
  const metadata = entry.metadata as { source?: string };
  assert.equal(metadata.source, "plan_file_reference");
  // 回注的是剥掉 frontmatter 的正文：有最新一份的计划内容，没有元数据噪音
  assert.match(entry.content, /Plan B/);
  assert.match(entry.content, /新计划/);
  assert.doesNotMatch(entry.content, /旧计划/);
  assert.doesNotMatch(entry.content, /title:|created:|toolCallId:|overview:/);
});

test("readLatestPlanFileReferenceEntry：没有计划时返回 undefined", async () => {
  const entry = await readLatestPlanFileReferenceEntry({
    fileSystemPort: new MemoryFileSystem().port(),
    sessionId: "sess_none",
    workspaceRoot: WORKSPACE,
  });
  assert.equal(entry, undefined);
});

// ------------------------------------------------------------
// ExitPlanMode 的 beforePermission 钩子
// ------------------------------------------------------------

// title/overview 是 ExitPlanMode 的 schema 必填字段；测试输入统一经这个构造，缺字段的提交
// 会在入参校验门被打回（见下方「缺必填字段」用例），到不了 beforePermission。
function validExitPlanModeInput(
  overrides: Partial<{ overview: string; plan: string; title: string }> = {},
): { overview: string; plan: string; title: string } {
  return {
    overview: "一步到位完成提交并落盘。",
    plan: "# Plan\n一步到位",
    title: "测试计划",
    ...overrides,
  };
}

test("beforePermission：plan 模式落盘，其他模式不落盘", async () => {
  const hook = exitPlanModeToolEntry.beforePermission;
  assert.ok(hook);

  const memory = new MemoryFileSystem();
  const input = ExitPlanModeInputSchema.parse(validExitPlanModeInput());
  await hook(input, beforePermissionContext({ fileSystemPort: memory.port(), mode: "plan" }));
  assert.equal(memory.files.size, 1);

  await hook(input, beforePermissionContext({ fileSystemPort: memory.port(), mode: "yolo" }));
  assert.equal(memory.files.size, 1, "非 plan 模式不得写入");
});

test("ExitPlanModeInputSchema：缺 title/overview 的提交在校验门被打回", () => {
  // 必填由校验闭环强制，不依赖模型自觉；缺失的错误会回给模型补齐重试
  assert.equal(ExitPlanModeInputSchema.safeParse({ plan: "# Plan" }).success, false);
  assert.equal(
    ExitPlanModeInputSchema.safeParse({ overview: "概述", plan: "# Plan" }).success,
    false,
  );
  assert.equal(ExitPlanModeInputSchema.safeParse({ plan: "# Plan", title: "标题" }).success, false);
  assert.equal(ExitPlanModeInputSchema.safeParse(validExitPlanModeInput()).success, true);
});

test("beforePermission：title/overview 随输入进入 frontmatter", async () => {
  const hook = exitPlanModeToolEntry.beforePermission;
  assert.ok(hook);

  const memory = new MemoryFileSystem();
  const input = ExitPlanModeInputSchema.parse({
    overview: "收口缓存验收清单。",
    plan: "# 计划\n正文",
    title: "缓存验收",
  });
  await hook(input, beforePermissionContext({ fileSystemPort: memory.port() }));

  const [file] = [...memory.files.values()];
  const parsed = parseSessionPlanFile(file!);
  assert.equal(parsed.title, "缓存验收");
  assert.equal(parsed.overview, "收口缓存验收清单。");
  assert.equal(parsed.body, "# 计划\n正文");
});

test("beforePermission：落盘失败不影响调用，取消才上抛", async () => {
  const hook = exitPlanModeToolEntry.beforePermission;
  assert.ok(hook);
  const input = ExitPlanModeInputSchema.parse(
    validExitPlanModeInput({ plan: "# Plan", title: "落盘失败" }),
  );

  const deniedPort = {
    writeTextFile: async () => {
      throw createFileSystemError({ code: "permission_denied", message: "denied" });
    },
  } as unknown as FileSystemPort;
  await hook(input, beforePermissionContext({ fileSystemPort: deniedPort }));

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(
    hook(input, beforePermissionContext({ abortSignal: abortController.signal })),
    /ExitPlanMode was cancelled/,
  );
});

// 落盘事实要能离开 beforePermission：UI 的路径唯一来源是执行器据此发布的事件，
// 钩子不回报就等于「看不到路径」。没有既成事实时（非 plan 模式、落盘失败）不能回报，
// 否则执行器会为一次没落盘的调用发布路径。
test("beforePermission：落盘成功回报路径与 planId，无事实时不回报", async () => {
  const hook = exitPlanModeToolEntry.beforePermission;
  assert.ok(hook);
  const input = ExitPlanModeInputSchema.parse(validExitPlanModeInput({ title: "回报事实" }));

  const memory = new MemoryFileSystem();
  const outcome = await hook(
    input,
    beforePermissionContext({ fileSystemPort: memory.port(), toolCallId: "toolu_plan_report" }),
  );
  const [filePath] = [...memory.files.keys()];
  assert.equal(outcome?.planFile?.path, filePath);
  assert.match(outcome?.planFile?.planId ?? "", /^回报事实-[0-9a-f]{8}$/);

  assert.equal(
    await hook(input, beforePermissionContext({ fileSystemPort: memory.port(), mode: "yolo" })),
    undefined,
    "非 plan 模式不落盘，也就没有事实可回报",
  );
  assert.equal(
    await hook(
      input,
      beforePermissionContext({
        fileSystemPort: {
          writeTextFile: async () => {
            throw createFileSystemError({ code: "permission_denied", message: "denied" });
          },
        } as unknown as FileSystemPort,
      }),
    ),
    undefined,
    "落盘失败不回报",
  );
});

// 冷恢复的第二来源：重启后内存事件已失、transcript 不记路径，只能从计划目录重推导。
// 这个读口在运行时上（workspaceRoot 与计划子目录是它的知识），所以单独锁住「无 FS 通道即空」。
test("listSessionPlanFileWrittenFacts：读运行时自有的计划目录，无文件系统通道返回空", async () => {
  const memory = new MemoryFileSystem();
  await seedPlan(memory.port(), "toolu_hydrate", "# 计划\n正文", EARLIER);

  const facts = await listSessionPlanFileWrittenFacts.call({
    fileSystemPort: memory.port(),
    sessionId: SESSION_ID,
    workspaceRoot: WORKSPACE,
  } as never);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.toolCallId, "toolu_hydrate");
  assert.equal(facts[0]?.path, memory.planPath(facts[0]!.planId));

  assert.deepEqual(
    await listSessionPlanFileWrittenFacts.call({
      sessionId: SESSION_ID,
      workspaceRoot: WORKSPACE,
    } as never),
    [],
    "没有文件系统通道时没有这条来源，返回空而不是抛错",
  );
});

// ------------------------------------------------------------
// ListPlans 工具
// ------------------------------------------------------------

test("ListPlans：无计划会话返回空清单", async () => {
  const output = await listPlansToolEntry.handler({}, toolContext(new MemoryFileSystem().port()));
  assert.deepEqual(output.plans, []);
  assert.equal((output as { latest: unknown }).latest, null);
  ListPlansOutputSchema.parse(output);
});

test("ListPlans：返回按 created 排序的清单与最新正文，createdAt 取文件头", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();
  await seedPlan(port, "toolu_aaa", "## 草稿不算标题\n旧计划", EARLIER);
  await seedPlan(port, "toolu_bbb", "# Plan B\n新计划", LATER, {
    overview: "新计划的概述。",
  });

  const output = (await listPlansToolEntry.handler({}, toolContext(port))) as {
    plans: Array<{
      createdAt: string | null;
      overview: string | null;
      planId: string;
      title: string | null;
      isLatest: boolean;
    }>;
    latest: {
      content: string;
      overview: string | null;
      planId: string;
      title: string | null;
    } | null;
  };

  assert.equal(output.plans.length, 2);
  assert.equal(output.plans[0]?.isLatest, false);
  assert.equal(output.plans[1]?.isLatest, true);
  // 首个非空行是 `## 草稿不算标题`，按 UI 同一条规则应剥掉井号作为标题
  assert.equal(output.plans[0]?.title, "草稿不算标题");
  assert.equal(output.plans[0]?.overview, null);
  assert.equal(output.plans[1]?.title, "Plan B");
  assert.equal(output.plans[1]?.overview, "新计划的概述。");

  assert.ok(output.latest);
  assert.equal(output.latest.planId, output.plans[1]?.planId);
  assert.equal(output.plans[0]?.createdAt, "2026-01-02T03:04:05.678Z");
  assert.equal(output.plans[1]?.createdAt, "2026-01-02T03:04:06.678Z");
  // latest.content 只含剥掉 frontmatter 的正文
  assert.equal(output.latest.content, "# Plan B\n新计划");
  assert.equal(output.latest.overview, "新计划的概述。");
  ListPlansOutputSchema.parse(output);
});

test("ListPlans：历史无 frontmatter 文件回退正文提取，排最旧、createdAt 为 null", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();
  // 先经 seedPlan 建目录，再手工放一份历史格式（无 frontmatter、无 created）的文件：
  // 它按规则排在最旧，不抢 latest
  await seedPlan(port, "toolu_older", "# 更早的计划", EARLIER);
  memory.files.set(
    `${resolveSessionPlansDir({ sessionId: SESSION_ID, workspaceRoot: WORKSPACE })}/legacy-plan.md`,
    "# 旧计划\n没有 frontmatter",
  );

  const output = (await listPlansToolEntry.handler({}, toolContext(port))) as {
    plans: Array<{ createdAt: string | null; overview: string | null; title: string | null }>;
    latest: { content: string } | null;
  };

  assert.equal(output.plans.length, 2);
  assert.equal(output.plans[0]?.title, "旧计划");
  assert.equal(output.plans[0]?.createdAt, null);
  assert.equal(output.plans[0]?.overview, null);
  assert.equal(output.plans[1]?.title, "更早的计划");
  // 新文件：content = 剥 frontmatter 的正文
  assert.equal(output.latest?.content, "# 更早的计划");
});

// ------------------------------------------------------------
// 执行器集成：v4 UI 静默拒绝路径
// ------------------------------------------------------------

// 复现 v4 UI 的静默拒绝：broker 收到计划批准请求后直接回 decline。
// onEvent 收集执行器发布的事件——拒绝路径没有工具输出，也没有 toolCallResult 事件，
// 落盘路径只能从事件通道读到，所以这条链路必须能观察到事件本身。
function planModeExecutorDeps(
  memory: MemoryFileSystem,
  onEvent: (event: SessionEvent) => void = () => {},
): ToolExecutorDeps {
  const registry = createToolRegistry();
  registry.register(exitPlanModeToolEntry);
  return {
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission: async () => ({ decision: "deny", reason: "declined" }),
    } as unknown as PermissionBrokerPort,
    emitEvent: async (event: SessionEvent) => {
      onEvent(event);
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: 5_000,
    fileSystemPort: memory.port(),
    getWorkingDirectory: () => WORKSPACE,
    getWorkspaceRoot: () => WORKSPACE,
    getMode: () => "plan",
    maxConcurrency: 1,
    readFileState: new Map(),
  } as unknown as ToolExecutorDeps;
}

test("集成：ExitPlanMode 被拒绝（plan_exit_denied）后计划文件仍然落盘", async () => {
  const memory = new MemoryFileSystem();
  const deps = planModeExecutorDeps(memory);

  const result = await executeToolCall(deps, new BackgroundTaskTracker(deps), {
    id: "toolu_plan_1",
    name: "ExitPlanMode",
    input: {
      overview: "压缩后也要能找回完整计划。",
      plan: "# 集成计划\n压缩后也要能找回",
      title: "集成计划",
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.turnControl?.reason, "plan_exit_denied");

  // 核心断言：文件在审批门之前已落盘，拒绝不丢计划；正文从 frontmatter 之后原样可读
  const files = await listSessionPlanFiles({
    fileSystemPort: memory.port(),
    sessionId: SESSION_ID,
    workspaceRoot: WORKSPACE,
  });
  assert.equal(files.length, 1);
  const plan = await readSessionPlanFile({
    fileSystemPort: memory.port(),
    path: files[0]!.path,
  });
  assert.equal(parseSessionPlanFile(plan?.content ?? "").body, "# 集成计划\n压缩后也要能找回");
  assert.equal(parseSessionPlanFile(plan?.content ?? "").toolCallId, "toolu_plan_1");
  assert.match(files[0]!.planId, /^集成计划-[0-9a-f]{8}$/);
});

// 拒绝路径是「路径看不见」的成因：工具输出为空，UI 只能靠事件。这条用例锁住落盘 → 事件这一段，
// 投影那一半由 bootstrap 的 planFileWrittenProjection 用例覆盖。
test("集成：落盘事实以 plan_file_written 事件发布，键是原始 toolCallId", async () => {
  const memory = new MemoryFileSystem();
  const events: SessionEvent[] = [];
  const deps = planModeExecutorDeps(memory, (event) => events.push(event));

  const result = await executeToolCall(deps, new BackgroundTaskTracker(deps), {
    id: "toolu_plan_2",
    name: "ExitPlanMode",
    input: { overview: "路径要进 UI。", plan: "# 集成计划\n路径要进 UI", title: "路径事件" },
  });
  assert.equal(result.success, false);

  const planEvents = events.filter((event) => event.type === SessionEventType.PlanFileWritten);
  assert.equal(planEvents.length, 1, "落盘一次只发一条，拒绝路径上没有其它事件");
  const payload = planEvents[0]!.payload as PlanFileWrittenPayload;
  // 键是原始 toolCallId（UI 工具行按它匹配），路径是运行时自有的落盘位置
  assert.equal(payload.toolCallId, "toolu_plan_2");
  assert.equal(payload.planFilePath, [...memory.files.keys()][0]);
  assert.match(payload.planId, /^路径事件-[0-9a-f]{8}$/);
});
