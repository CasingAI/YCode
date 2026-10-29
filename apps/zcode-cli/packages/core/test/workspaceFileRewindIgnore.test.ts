import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { FileSystemPortError, RewindScope, SessionEventType } from "@zcode/contracts";
import type { SessionEvent } from "@zcode/contracts";
import {
  WORKSPACE_CHECKPOINT_CONTENT_TYPE,
  stringifyWorkspaceCheckpointArtifact,
} from "../src/runtime/helpers/index.js";
import {
  applyWorkspaceFileRewind,
  previewWorkspaceFileRewind,
} from "../src/runtime/methods/file-rewind.js";

// 平台无关的绝对路径：不沿用 POSIX "/ws" 基线，避免 Windows 盘符/分隔符干扰。
const WS_ROOT = resolve(process.cwd(), "workspace-ignore-test-root");
const OUTSIDE_ROOT = resolve(WS_ROOT, "..", "workspace-ignore-test-outside");
const IGNORE_PATH = join(WS_ROOT, ".zcodeignore");
const GITIGNORE_PATH = join(WS_ROOT, ".gitignore");

function wsPath(...segments: string[]): string {
  return join(WS_ROOT, ...segments);
}

type CheckpointFileSpec = {
  path: string;
  afterContent?: string;
  beforeContent: string | null;
  structuredPatch?: unknown[];
};

type CheckpointSpec = {
  checkpointId: string;
  messageId: string;
  toolName: string;
  file: CheckpointFileSpec;
  unreadable?: boolean;
};

function makeHarness() {
  const files = new Map<string, string>();
  const readErrors = new Map<string, Error>();
  const readPaths: string[] = [];
  const written: Array<{ path: string; content: string }> = [];
  const removed: string[] = [];
  const artifacts = new Map<string, string>();
  const events: SessionEvent[] = [];
  const appended: SessionEvent[] = [];
  let seq = 0;

  const addCheckpoint = (spec: CheckpointSpec) => {
    const snapshotRef = `artifact://${spec.checkpointId}`;
    seq += 1;
    events.push({
      id: `evt-${seq}`,
      type: SessionEventType.CheckpointCreated,
      payload: {
        checkpointId: spec.checkpointId,
        messageId: spec.messageId,
        targetMessageId: spec.messageId,
        scope: RewindScope.Workspace,
        snapshotRef,
        diffRef: snapshotRef,
        fileCount: 1,
      },
    } as unknown as SessionEvent);
    if (spec.unreadable) return;
    const candidate: Parameters<typeof stringifyWorkspaceCheckpointArtifact>[0] = {
      ...(spec.file.afterContent !== undefined ? { content: spec.file.afterContent } : {}),
      filePath: spec.file.path,
      originalFile: spec.file.beforeContent,
      structuredPatch: (spec.file.structuredPatch ?? []) as Parameters<
        typeof stringifyWorkspaceCheckpointArtifact
      >[0]["structuredPatch"],
    };
    artifacts.set(
      snapshotRef,
      stringifyWorkspaceCheckpointArtifact(candidate, {
        toolCallId: `call-${spec.checkpointId}`,
        toolName: spec.toolName,
      } as Parameters<typeof stringifyWorkspaceCheckpointArtifact>[1]),
    );
  };

  const runtime = {
    sessionId: "sess-rewind-ignore",
    workspaceRoot: WS_ROOT,
    rootTraceContext: { traceId: "trace-rewind-ignore", turnId: "turn-1" },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    eventStore: {
      getEvents: async () => events,
    },
    artifactStore: {
      readToolResultArtifact: async ({ uri }: { uri: string }) => {
        const content = artifacts.get(uri);
        if (content === undefined) throw new Error(`artifact not found: ${uri}`);
        return { content };
      },
      writeToolResultArtifact: async (input: { content: string; contentType: string }) => {
        assert.equal(input.contentType, WORKSPACE_CHECKPOINT_CONTENT_TYPE);
        seq += 1;
        const uri = `artifact://snapshot-${seq}`;
        artifacts.set(uri, input.content);
        return { uri };
      },
    },
    fileSystemPort: {
      readTextFile: async ({ path }: { path: string }, options?: { signal?: AbortSignal }) => {
        readPaths.push(path);
        if (options?.signal?.aborted) {
          throw new FileSystemPortError({ code: "cancelled", path, message: `cancelled: ${path}` });
        }
        const failed = readErrors.get(path);
        if (failed) throw failed;
        const content = files.get(path);
        if (content === undefined) {
          throw new FileSystemPortError({
            code: "not_found",
            path,
            message: `not found: ${path}`,
          });
        }
        return { content };
      },
      writeTextFile: async ({ path, content }: { path: string; content: string }) => {
        written.push({ path, content });
        files.set(path, content);
      },
      removeFile: async ({ path }: { path: string }) => {
        removed.push(path);
        files.delete(path);
      },
    },
    createEvent: (type: SessionEventType, payload: unknown, trace?: { turnId?: string }) => {
      seq += 1;
      return {
        id: `evt-${seq}`,
        type,
        payload,
        sessionId: "sess-rewind-ignore",
        turnId: trace?.turnId,
      };
    },
    appendEvent: async (event: unknown) => {
      appended.push(event as SessionEvent);
      events.push(event as SessionEvent);
    },
  };

  return {
    runtime,
    files,
    readErrors,
    readPaths,
    written,
    removed,
    artifacts,
    events,
    appended,
    addCheckpoint,
  };
}

type Harness = ReturnType<typeof makeHarness>;
type RewindOptions = Parameters<typeof previewWorkspaceFileRewind>[1];

function preview(harness: Harness, options: RewindOptions = {}) {
  return previewWorkspaceFileRewind.call(
    harness.runtime as never,
    options,
  ) as unknown as ReturnType<typeof previewWorkspaceFileRewind>;
}

function apply(harness: Harness, options: RewindOptions = {}) {
  return applyWorkspaceFileRewind.call(harness.runtime as never, options) as unknown as ReturnType<
    typeof applyWorkspaceFileRewind
  >;
}

test("已忽略的 .git 旧 checkpoint：preview 三类清单全空且 apply 不写盘", async () => {
  const harness = makeHarness();
  harness.files.set(IGNORE_PATH, ".git/\n");
  harness.files.set(wsPath(".git", "stage-mine.mjs"), "external-change");
  harness.addCheckpoint({
    checkpointId: "cp-git",
    messageId: "msg-1",
    toolName: "Write",
    file: {
      path: ".git/stage-mine.mjs",
      afterContent: "tool-write",
      beforeContent: "original",
    },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(result.safeFiles, []);
  assert.deepEqual(result.unsafeFiles, []);
  assert.deepEqual(result.ignoredFiles, []);
  assert.equal(result.canApply, false);

  const applied = await apply(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(applied.applied, false);
  assert.equal(harness.files.get(wsPath(".git", "stage-mine.mjs")), "external-change");
  assert.deepEqual(harness.written, [], "被忽略文件不得写入");
  assert.deepEqual(harness.removed, [], "被忽略文件不得删除");
});

test("混合 apply：只恢复源码，忽略文件不读不写", async () => {
  const harness = makeHarness();
  const ignoredPath = wsPath(".git", "stage.mjs");
  const sourcePath = wsPath("src", "index.ts");
  harness.files.set(IGNORE_PATH, ".git/\n");
  harness.files.set(ignoredPath, "external");
  harness.files.set(sourcePath, "after-src");
  harness.addCheckpoint({
    checkpointId: "cp-git",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: ".git/stage.mjs", afterContent: "tool", beforeContent: "before-git" },
  });
  harness.addCheckpoint({
    checkpointId: "cp-src",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/index.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  const applied = await apply(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(applied.applied, true);
  assert.equal(harness.files.get(sourcePath), "before-src");
  assert.equal(harness.files.get(ignoredPath), "external");
  assert.deepEqual(
    harness.written.map((entry) => entry.path),
    [sourcePath],
    "只有未忽略的源码被恢复",
  );
  assert.equal(harness.readPaths.includes(ignoredPath), false, "被忽略文件不应读磁盘状态");
});

test("相对 checkpoint 路径同样按规则过滤", async () => {
  const harness = makeHarness();
  harness.files.set(IGNORE_PATH, "nested/\n");
  harness.files.set(wsPath("nested", "skip.txt"), "external");
  harness.addCheckpoint({
    checkpointId: "cp-relative",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "nested/skip.txt", afterContent: "tool", beforeContent: "original" },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(result.safeFiles, []);
  assert.deepEqual(result.unsafeFiles, []);
  assert.deepEqual(result.ignoredFiles, []);
});

test("缺规则文件时使用 .gitignore + 内置模板，且不创建 .zcodeignore", async () => {
  const harness = makeHarness();
  harness.files.set(GITIGNORE_PATH, "custom-out/\n");
  harness.files.set(wsPath(".git", "x.mjs"), "external");
  harness.files.set(wsPath("custom-out", "a.js"), "external");
  harness.addCheckpoint({
    checkpointId: "cp-builtin",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: ".git/x.mjs", afterContent: "tool", beforeContent: "original" },
  });
  harness.addCheckpoint({
    checkpointId: "cp-gitignore",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "custom-out/a.js", afterContent: "tool", beforeContent: "original" },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(result.safeFiles, []);
  assert.deepEqual(result.unsafeFiles, []);
  assert.deepEqual(result.ignoredFiles, []);
  assert.equal(harness.files.has(IGNORE_PATH), false, "预检不得创建规则文件");
  assert.equal(
    harness.readPaths.filter((path) => path === IGNORE_PATH).length,
    1,
    "每次计划只读一次 .zcodeignore",
  );
  assert.ok(harness.readPaths.includes(GITIGNORE_PATH), "缺失规则时读取根 .gitignore");
});

test("preview 后规则由忽略变为包含时，apply 使用新规则恢复文件", async () => {
  const harness = makeHarness();
  const sourcePath = wsPath("src", "main.ts");
  harness.files.set(IGNORE_PATH, "src/\n");
  harness.files.set(sourcePath, "after-src");
  harness.addCheckpoint({
    checkpointId: "cp-ignore-to-include",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/main.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  const before = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(before.safeFiles, []);
  assert.deepEqual(before.unsafeFiles, []);

  harness.files.set(IGNORE_PATH, "\n");
  const result = await apply(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(result.applied, true);
  assert.equal(harness.files.get(sourcePath), "before-src");
});

test("preview 后规则由包含变为忽略时，apply 不恢复文件", async () => {
  const harness = makeHarness();
  const sourcePath = wsPath("src", "main.ts");
  harness.files.set(IGNORE_PATH, "\n");
  harness.files.set(sourcePath, "after-src");
  harness.addCheckpoint({
    checkpointId: "cp-include-to-ignore",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/main.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  const before = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(before.safeFiles.length, 1);

  harness.files.set(IGNORE_PATH, "src/\n");
  const result = await apply(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(result.applied, false);
  assert.deepEqual(result.preview.safeFiles, []);
  assert.deepEqual(result.preview.unsafeFiles, []);
  assert.equal(harness.files.get(sourcePath), "after-src");
  assert.deepEqual(harness.written, []);
});

test("缺少 .zcodeignore 和 .gitignore 时使用内置默认且不落盘", async () => {
  const harness = makeHarness();
  harness.files.set(wsPath(".git", "x.mjs"), "external");
  harness.files.set(wsPath("src", "main.ts"), "after-src");
  harness.addCheckpoint({
    checkpointId: "cp-builtin-only",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: ".git/x.mjs", afterContent: "tool", beforeContent: "original" },
  });
  harness.addCheckpoint({
    checkpointId: "cp-source-default",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/main.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(
    result.safeFiles.map((file) => file.path),
    [wsPath("src", "main.ts")],
  );
  assert.deepEqual(result.unsafeFiles, []);
  assert.equal(harness.files.has(IGNORE_PATH), false);
  assert.equal(harness.readPaths.includes(GITIGNORE_PATH), true);
  assert.deepEqual(harness.written, []);
});

test(".gitignore 非 not_found 读取失败时使用内置默认且不落盘", async () => {
  const harness = makeHarness();
  harness.readErrors.set(
    GITIGNORE_PATH,
    new FileSystemPortError({
      code: "permission_denied",
      path: GITIGNORE_PATH,
      message: "permission denied",
    }),
  );
  harness.files.set(wsPath(".git", "x.mjs"), "external");
  harness.files.set(wsPath("src", "main.ts"), "after-src");
  harness.addCheckpoint({
    checkpointId: "cp-gitignore-error-builtin",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: ".git/x.mjs", afterContent: "tool", beforeContent: "original" },
  });
  harness.addCheckpoint({
    checkpointId: "cp-gitignore-error-source",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/main.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(
    result.safeFiles.map((file) => file.path),
    [wsPath("src", "main.ts")],
  );
  assert.deepEqual(result.unsafeFiles, []);
  assert.equal(harness.files.has(IGNORE_PATH), false);
  assert.deepEqual(harness.written, []);
});

test("反选规则生效，规则变化后立即重算（不缓存）", async () => {
  const harness = makeHarness();
  const debugLog = wsPath("debug.log");
  const importantLog = wsPath("important.log");
  harness.files.set(IGNORE_PATH, "*.log\n!important.log\n");
  harness.files.set(debugLog, "external-debug");
  harness.files.set(importantLog, "external-important");
  harness.addCheckpoint({
    checkpointId: "cp-debug",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "debug.log", afterContent: "tool-debug", beforeContent: "before-debug" },
  });
  harness.addCheckpoint({
    checkpointId: "cp-important",
    messageId: "msg-1",
    toolName: "Write",
    file: {
      path: "important.log",
      afterContent: "tool-important",
      beforeContent: "before-important",
    },
  });

  const first = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(
    first.unsafeFiles.map((file) => file.path),
    [importantLog],
    "反选文件回到候选，debug.log 被排除",
  );
  assert.equal(first.unsafeFiles[0]?.reason, "external_modified");

  harness.files.set(IGNORE_PATH, "\n");
  const second = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(
    second.unsafeFiles.map((file) => file.path).sort(),
    [debugLog, importantLog].sort(),
    "规则更新后不沿用上一次判断",
  );
});

test("未忽略的外部修改仍报告 external_modified", async () => {
  const harness = makeHarness();
  harness.files.set(IGNORE_PATH, "ignored/\n");
  harness.files.set(wsPath("src", "main.ts"), "external");
  harness.addCheckpoint({
    checkpointId: "cp-src",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/main.ts", afterContent: "tool", beforeContent: "original" },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(result.unsafeFiles.length, 1);
  assert.equal(result.unsafeFiles[0]?.reason, "external_modified");
});

test("Bash 路径：匹配规则时排除，未匹配时保留 bash_ignored 阻塞", async () => {
  const harness = makeHarness();
  harness.files.set(IGNORE_PATH, "node_modules/\n");
  harness.addCheckpoint({
    checkpointId: "cp-bash-ignored",
    messageId: "msg-1",
    toolName: "Bash",
    file: { path: "node_modules/pkg.js", afterContent: "tool", beforeContent: null },
  });
  harness.addCheckpoint({
    checkpointId: "cp-bash-kept",
    messageId: "msg-1",
    toolName: "Bash",
    file: { path: "scripts/build.sh", afterContent: "tool", beforeContent: null },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(
    result.ignoredFiles.map((file) => file.path),
    [wsPath("scripts/build.sh")],
    "仅未匹配规则的 Bash 路径进入 ignoredFiles",
  );
  assert.equal(result.ignoredFiles[0]?.reason, "bash_ignored");
  assert.equal(result.canApply, false);
});

test("被忽略路径优先于 unsupported checkpoint", async () => {
  const harness = makeHarness();
  harness.files.set(IGNORE_PATH, "vendor/\n");
  harness.files.set(wsPath("vendor", "lib.js"), "external");
  harness.addCheckpoint({
    checkpointId: "cp-unsupported",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "vendor/lib.js", beforeContent: null },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(result.safeFiles, []);
  assert.deepEqual(result.unsafeFiles, [], "忽略路径不应产生 unsupported 冲突");
  assert.deepEqual(result.ignoredFiles, []);
});

test("整个 checkpoint 不可读仍阻塞，不能按路径猜测忽略", async () => {
  const harness = makeHarness();
  harness.files.set(IGNORE_PATH, ".git/\n");
  harness.addCheckpoint({
    checkpointId: "cp-unreadable",
    messageId: "msg-1",
    toolName: "Write",
    unreadable: true,
    file: { path: ".git/x.mjs", afterContent: "tool", beforeContent: null },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(result.canApply, false);
  assert.equal(result.unsafeFiles.length, 1);
  assert.equal(result.unsafeFiles[0]?.reason, "checkpoint_unreadable");
});

test("规则文件已存在但不可读：返回 file_read_failed 且不写盘", async () => {
  const harness = makeHarness();
  const sourcePath = wsPath("src", "a.ts");
  harness.files.set(IGNORE_PATH, ".git/\n");
  harness.files.set(sourcePath, "after-src");
  harness.readErrors.set(
    IGNORE_PATH,
    new FileSystemPortError({
      code: "permission_denied",
      path: IGNORE_PATH,
      message: "permission denied",
    }),
  );
  harness.addCheckpoint({
    checkpointId: "cp-src",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/a.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(result.canApply, false);
  assert.equal(result.safeFiles.length, 0);
  assert.equal(result.unsafeFiles.length, 1);
  assert.equal(result.unsafeFiles[0]?.reason, "file_read_failed");
  assert.equal(result.unsafeFiles[0]?.path, IGNORE_PATH, "错误路径指向规则文件");
  assert.equal(harness.readPaths.includes(sourcePath), false, "规则不可读时不应继续读取候选文件");

  const applied = await apply(harness, { targetMessageIds: ["msg-1"] });
  assert.equal(applied.applied, false);
  assert.deepEqual(harness.written, [], "规则不可读不得写盘");
});

test("overwrite 模式下规则 permission_denied 阻塞，且不写文件或持久化快照", async () => {
  const harness = makeHarness();
  const sourcePath = wsPath("src", "a.ts");
  harness.files.set(IGNORE_PATH, "src/\n");
  harness.files.set(sourcePath, "external");
  harness.readErrors.set(
    IGNORE_PATH,
    new FileSystemPortError({
      code: "permission_denied",
      path: IGNORE_PATH,
      message: "permission denied",
    }),
  );
  harness.addCheckpoint({
    checkpointId: "cp-overwrite-read-failure",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/a.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  const result = await apply(harness, {
    conflictMode: "overwrite",
    anchorMessageId: "msg-0",
    targetMessageIds: ["msg-1"],
  });
  assert.equal(result.applied, false);
  assert.equal(result.preview.unsafeFiles.length, 1);
  assert.equal(result.preview.unsafeFiles[0]?.reason, "file_read_failed");
  assert.equal(harness.files.get(sourcePath), "external");
  assert.deepEqual(harness.written, [], "不得写恢复文件或快照文件");
  assert.equal(
    harness.appended.some((event) => event.type === SessionEventType.CheckpointCreated),
    false,
    "规则不可读时不得写入覆盖前快照 checkpoint",
  );
});

test("规则读取取消会传播，不降级为读取失败", async () => {
  const harness = makeHarness();
  harness.files.set(wsPath("src", "a.ts"), "after-src");
  harness.readErrors.set(
    IGNORE_PATH,
    Object.assign(new Error("aborted by caller"), { name: "AbortError" }),
  );
  harness.addCheckpoint({
    checkpointId: "cp-src",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/a.ts", afterContent: "after-src", beforeContent: "before-src" },
  });
  const controller = new AbortController();

  await assert.rejects(
    () => preview(harness, { targetMessageIds: ["msg-1"], abortSignal: controller.signal }),
    /aborted by caller/,
  );
});

test("FileSystemPortError(cancelled) 来自 .zcodeignore 时传播", async () => {
  const harness = makeHarness();
  harness.files.set(wsPath("src", "a.ts"), "after-src");
  harness.readErrors.set(
    IGNORE_PATH,
    new FileSystemPortError({ code: "cancelled", path: IGNORE_PATH, message: "ignore cancelled" }),
  );
  harness.addCheckpoint({
    checkpointId: "cp-ignore-cancelled",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/a.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  await assert.rejects(() => preview(harness, { targetMessageIds: ["msg-1"] }), /ignore cancelled/);
});

test("FileSystemPortError(cancelled) 来自 fallback .gitignore 时传播", async () => {
  const harness = makeHarness();
  harness.readErrors.set(
    GITIGNORE_PATH,
    new FileSystemPortError({
      code: "cancelled",
      path: GITIGNORE_PATH,
      message: "gitignore cancelled",
    }),
  );
  harness.files.set(wsPath("src", "a.ts"), "after-src");
  harness.addCheckpoint({
    checkpointId: "cp-gitignore-cancelled",
    messageId: "msg-1",
    toolName: "Write",
    file: { path: "src/a.ts", afterContent: "after-src", beforeContent: "before-src" },
  });

  await assert.rejects(
    () => preview(harness, { targetMessageIds: ["msg-1"] }),
    /gitignore cancelled/,
  );
});

test("工作区外路径不按工作区规则排除", async () => {
  const harness = makeHarness();
  const outsidePath = resolve(OUTSIDE_ROOT, "cache.tmp");
  harness.files.set(IGNORE_PATH, "*.tmp\n");
  harness.files.set(outsidePath, "after-outside");
  harness.addCheckpoint({
    checkpointId: "cp-outside",
    messageId: "msg-1",
    toolName: "Write",
    file: {
      path: outsidePath,
      afterContent: "after-outside",
      beforeContent: "before-outside",
    },
  });

  const result = await preview(harness, { targetMessageIds: ["msg-1"] });
  assert.deepEqual(
    result.safeFiles.map((file) => file.path),
    [outsidePath],
    "工作区外路径保持原有候选，不因名称匹配规则而消失",
  );
});
