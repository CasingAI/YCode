import assert from "node:assert/strict";
import test from "node:test";
import {
  ExitPlanModeInputSchema,
  ListPlansOutputSchema,
  createFileSystemError,
  type FileSystemPort,
} from "@zcode/contracts";
import {
  buildSessionPlanId,
  listSessionPlanFiles,
  parseSessionPlanFile,
  parseSessionPlanId,
  readLatestPlanFileReferenceEntry,
  readSessionPlanFile,
  resolveSessionPlansDir,
  writeSessionPlanFile,
} from "../src/runtime/helpers/plan-file-continuity.js";
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

test("planId：UTC 时间戳前缀使字典序即时间序，parse 还原创建时间与 toolCallId", () => {
  const earlier = buildSessionPlanId({ now: EARLIER, toolCallId: "toolu_aaa" });
  const later = buildSessionPlanId({ now: LATER, toolCallId: "toolu_bbb" });
  assert.ok(earlier < later, `${earlier} should sort before ${later}`);

  const parsed = parseSessionPlanId(earlier);
  assert.equal(parsed.toolCallId, "toolu_aaa");
  assert.equal(parsed.createdAt, "2026-01-02T03:04:05.678Z");
  assert.equal(parseSessionPlanId("unparsable").createdAt, undefined);
});

test("writeSessionPlanFile：frontmatter 物化标题/概述，正文保持纯净", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();

  const first = await seedPlan(port, "toolu_aaa", "# Plan A\n内容 A", EARLIER, {
    overview: "做 A 不做 B。",
    title: "自定义标题",
  });
  const second = await seedPlan(port, "toolu_bbb", "# Plan B\n内容 B", LATER);

  const dir = resolveSessionPlansDir({ sessionId: SESSION_ID, workspaceRoot: WORKSPACE });
  assert.equal(first, `${dir}/20260102-030405678-toolu_aaa.md`);
  assert.equal(second, `${dir}/20260102-030406678-toolu_bbb.md`);
  assert.equal(memory.files.size, 2);

  // 显式 title/overview 进 frontmatter，正文逐字节保留
  const parsedFirst = parseSessionPlanFile(memory.files.get(first)!);
  assert.equal(parsedFirst.title, "自定义标题");
  assert.equal(parsedFirst.overview, "做 A 不做 B。");
  assert.equal(parsedFirst.body, "# Plan A\n内容 A");
  // 键序固定 title → overview，围栏包裹正文；created 不存在（文件名拥有创建时间）
  const rawLines = memory.files.get(first)!.split("\n");
  assert.equal(rawLines[0], "---");
  assert.ok(rawLines[1]?.startsWith("title: "));
  assert.ok(rawLines[2]?.startsWith("overview: "));
  assert.equal(rawLines[3], "---");
  assert.equal(rawLines[4], "# Plan A");

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
  assert.equal(broken.body, "# 正文");

  const legacy = parseSessionPlanFile("# 旧计划\n直接正文");
  assert.equal(legacy.body, "# 旧计划\n直接正文");
  assert.equal(legacy.title, undefined);
  assert.equal(legacy.overview, undefined);
});

test("listSessionPlanFiles：升序返回、忽略非 md 文件、目录不存在返回空", async () => {
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
  assert.deepEqual(
    files.map((file) => file.planId),
    [
      "20260102-030405678-toolu_aaa",
      "20260102-030406678-toolu_bbb",
    ],
  );

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
  assert.doesNotMatch(entry.content, /title:|created:|overview:/);
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

// ------------------------------------------------------------
// ListPlans 工具
// ------------------------------------------------------------

test("ListPlans：无计划会话返回空清单", async () => {
  const output = await listPlansToolEntry.handler({}, toolContext(new MemoryFileSystem().port()));
  assert.deepEqual(output.plans, []);
  assert.equal((output as { latest: unknown }).latest, null);
  ListPlansOutputSchema.parse(output);
});

test("ListPlans：返回按时间排序的清单与最新正文，标题取首个 H1", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();
  await seedPlan(port, "toolu_aaa", "## 草稿不算标题\n旧计划", EARLIER);
  await seedPlan(port, "toolu_bbb", "# Plan B\n新计划", LATER, {
    overview: "新计划的概述。",
  });

  const output = (await listPlansToolEntry.handler({}, toolContext(port))) as {
    plans: Array<{
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
  assert.equal(output.latest.planId, "20260102-030406678-toolu_bbb");
  // latest.content 只含剥掉 frontmatter 的正文
  assert.equal(output.latest.content, "# Plan B\n新计划");
  assert.equal(output.latest.overview, "新计划的概述。");
  ListPlansOutputSchema.parse(output);
});

test("ListPlans：历史无 frontmatter 文件回退正文提取，overview 为 null", async () => {
  const memory = new MemoryFileSystem();
  const port = memory.port();
  // 先经 seedPlan 建目录，再手工放一份历史格式（无 frontmatter）且时间更新的文件，让 latest 落在它身上
  await seedPlan(port, "toolu_older", "# 更早的计划", EARLIER);
  memory.files.set(
    `${resolveSessionPlansDir({ sessionId: SESSION_ID, workspaceRoot: WORKSPACE })}/20260102-030407678-toolu_old.md`,
    "# 旧计划\n没有 frontmatter",
  );

  const output = (await listPlansToolEntry.handler({}, toolContext(port))) as {
    plans: Array<{ overview: string | null; title: string | null }>;
    latest: { content: string } | null;
  };

  assert.equal(output.plans.length, 2);
  assert.equal(output.plans[0]?.title, "更早的计划");
  assert.equal(output.plans[1]?.title, "旧计划");
  assert.equal(output.plans[1]?.overview, null);
  // 无 frontmatter 的历史文件：content = 原文，不剥也不迁移
  assert.equal(output.latest?.content, "# 旧计划\n没有 frontmatter");
});

// ------------------------------------------------------------
// 执行器集成：v4 UI 静默拒绝路径
// ------------------------------------------------------------

test("集成：ExitPlanMode 被拒绝（plan_exit_denied）后计划文件仍然落盘", async () => {
  const memory = new MemoryFileSystem();
  const registry = createToolRegistry();
  registry.register(exitPlanModeToolEntry);
  // 复现 v4 UI 的静默拒绝：broker 收到计划批准请求后直接回 decline
  const deps = {
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission: async () => ({ decision: "deny", reason: "declined" }),
    } as unknown as PermissionBrokerPort,
    emitEvent: async () => {},
    sessionId: SESSION_ID,
    defaultTimeoutMs: 5_000,
    fileSystemPort: memory.port(),
    getWorkingDirectory: () => WORKSPACE,
    getWorkspaceRoot: () => WORKSPACE,
    getMode: () => "plan",
    maxConcurrency: 1,
    readFileState: new Map(),
  } as unknown as ToolExecutorDeps;

  const result = await executeToolCall(
    deps,
    new BackgroundTaskTracker(deps),
    {
      id: "toolu_plan_1",
      name: "ExitPlanMode",
      input: {
        overview: "压缩后也要能找回完整计划。",
        plan: "# 集成计划\n压缩后也要能找回",
        title: "集成计划",
      },
    },
  );

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
  assert.equal(parseSessionPlanId(files[0]!.planId).toolCallId, "toolu_plan_1");
});
