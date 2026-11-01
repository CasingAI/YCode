import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow } from "../src/v4/conversationTurnRenderUnits.js";
import type { ConversationAssistantWorkChildItem } from "../src/v4/conversationAssistantWorkItems.js";
import {
  mergeFileActivityNodes,
  normalizeFileActivityPath,
  readFileWriteTargetPaths,
  summarizeFileActivityChanges,
} from "../src/v4/conversationFileActivity.js";

// 同文件同动作合并的纯投影：路径归一、目标提取、聚合统计与连续分组。

function editRow(options: {
  rowId: number;
  path?: string;
  changes?: Record<string, { additions: number; deletions: number }>;
  status?: ToolCallRow["status"];
}): ToolCallRow {
  const path = options.path;
  const display = options.changes
    ? {
        kind: "file_diffs",
        files: Object.entries(options.changes).map(([filePath, stat]) => ({
          filePath,
          additions: stat.additions,
          deletions: stat.deletions,
          structuredPatch: [],
        })),
      }
    : path
      ? {
          kind: "file_diff",
          filePath: path,
          additions: 1,
          deletions: 0,
          structuredPatch: [],
        }
      : undefined;
  return {
    kind: "toolCall",
    rowId: options.rowId,
    turnId: "turn-1",
    createdAt: options.rowId,
    createdAtSeq: options.rowId,
    toolCallId: `call-${options.rowId}`,
    toolName: "Edit",
    status: options.status ?? "success",
    inputText: "",
    input: path ? { file_path: path, old_string: "before", new_string: "after" } : {},
    ...(display ? { output: { text: "", display } } : {}),
  };
}

function childItem(row: AssistantWorkRow): ConversationAssistantWorkChildItem {
  return {
    kind: "row",
    key: `row:${"rowId" in row ? row.rowId : 0}`,
    row,
  };
}

const resolveEditBucket = (node: ConversationAssistantWorkChildItem) =>
  node.kind === "row" && node.row.kind === "toolCall" && node.row.toolName === "Edit"
    ? ("changes" as const)
    : null;

test("路径归一处理空白、分隔符与末尾斜杠", () => {
  assert.equal(normalizeFileActivityPath("  /tmp/a.ts/  "), "/tmp/a.ts");
  assert.equal(normalizeFileActivityPath(String.raw`\tmp\a.ts`), "/tmp/a.ts");
  assert.equal(normalizeFileActivityPath(""), "");
});

test("写入目标路径从输入与 display 提取并按归一化路径去重", () => {
  const row: ToolCallRow = {
    ...editRow({ rowId: 1, path: "/tmp/a.ts" }),
  };
  assert.deepEqual(readFileWriteTargetPaths(row), ["/tmp/a.ts"]);
});

test("多文件 display 返回多个目标路径，交给调用方判定不可合并", () => {
  const row = editRow({
    rowId: 1,
    changes: {
      "/tmp/a.ts": { additions: 1, deletions: 0 },
      "/tmp/b.ts": { additions: 2, deletions: 3 },
    },
  });
  assert.deepEqual(readFileWriteTargetPaths(row).sort(), ["/tmp/a.ts", "/tmp/b.ts"]);
});

test("拿不到路径的写入行不产生目标", () => {
  const row = editRow({ rowId: 1 });
  assert.deepEqual(readFileWriteTargetPaths(row), []);
});

test("聚合统计只累加同一文件的增删行数", () => {
  const rows = [
    editRow({ rowId: 1, path: "/tmp/a.ts" }),
    editRow({ rowId: 2, path: "/tmp/a.ts" }),
    editRow({ rowId: 3, path: "/tmp/b.ts" }),
  ];
  // 第三条是不同文件，但通过 display 显式给统计，验证路径过滤。
  rows[0] = {
    ...rows[0]!,
    output: {
      text: "",
      display: {
        kind: "file_diff",
        filePath: "/tmp/a.ts",
        additions: 2,
        deletions: 1,
        structuredPatch: [],
      },
    },
  };
  rows[1] = {
    ...rows[1]!,
    output: {
      text: "",
      display: {
        kind: "file_diff",
        filePath: "/tmp/a.ts",
        additions: 3,
        deletions: 4,
        structuredPatch: [],
      },
    },
  };

  const summary = summarizeFileActivityChanges(rows, String.raw`\tmp\a.ts`);
  assert.deepEqual(summary.changeStat, { added: 5, removed: 5 });
  assert.deepEqual(summary.operationKinds, ["edit"]);
  assert.equal(summary.actionLabels.length, 2);
});

test("无 diff 统计时 changeStat 为 null", () => {
  const summary = summarizeFileActivityChanges([editRow({ rowId: 1 })], "/tmp/a.ts");
  assert.equal(summary.changeStat, null);
});

test("连续同文件同终态合并成一条，保留全部原始行", () => {
  const merged = mergeFileActivityNodes(
    [childItem(editRow({ rowId: 1, path: "/tmp/a.ts" })), childItem(editRow({ rowId: 2, path: "/tmp/a.ts" }))],
    resolveEditBucket,
  );

  assert.equal(merged.length, 1);
  const item = merged[0]!;
  assert.ok(item.kind === "fileActivity");
  assert.equal(item.path, "/tmp/a.ts");
  assert.equal(item.status, "success");
  assert.deepEqual(
    item.rows.map((row) => row.rowId),
    [1, 2],
  );
});

test("终态不同不合并，运行中的行保持逐条", () => {
  const merged = mergeFileActivityNodes(
    [
      childItem(editRow({ rowId: 1, path: "/tmp/a.ts", status: "error" })),
      childItem(editRow({ rowId: 2, path: "/tmp/a.ts" })),
      childItem(editRow({ rowId: 3, path: "/tmp/a.ts", status: "running" })),
      childItem(editRow({ rowId: 4, path: "/tmp/a.ts", status: "running" })),
    ],
    resolveEditBucket,
  );

  assert.deepEqual(
    merged.map((item) => (item.kind === "fileActivity" ? item.status : "row")),
    ["row", "row", "row", "row"],
  );
});

test("非连续的同文件调用不被跨节点合并", () => {
  const merged = mergeFileActivityNodes(
    [
      childItem(editRow({ rowId: 1, path: "/tmp/a.ts" })),
      childItem(editRow({ rowId: 2, path: "/tmp/b.ts" })),
      childItem(editRow({ rowId: 3, path: "/tmp/a.ts" })),
    ],
    resolveEditBucket,
  );

  assert.equal(merged.length, 3);
});

test("非候选行原样保留在合并序列中", () => {
  const bashRow: ToolCallRow = {
    kind: "toolCall",
    rowId: 2,
    turnId: "turn-1",
    createdAt: 2,
    createdAtSeq: 2,
    toolCallId: "call-2",
    toolName: "Bash",
    status: "success",
    inputText: "",
    input: { command: "ls" },
  };
  const merged = mergeFileActivityNodes(
    [
      childItem(editRow({ rowId: 1, path: "/tmp/a.ts" })),
      childItem(bashRow),
      childItem(editRow({ rowId: 3, path: "/tmp/a.ts" })),
    ],
    resolveEditBucket,
  );

  assert.equal(merged.length, 3);
  assert.equal(merged[1]?.kind, "row");
});
