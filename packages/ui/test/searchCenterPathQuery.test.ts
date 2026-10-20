import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  areSearchCenterPathsEqual,
  buildSearchCenterPathCandidateRow,
  resolveSearchCenterPathQuery,
} from "../src/search-center/searchCenterPathQuery.js";
import { resolveSearchCenterRows } from "../src/search-center/searchCenterState.js";

test("粘贴绝对路径：判定为路径并给出可直接打开的绝对路径", () => {
  const resolved = resolveSearchCenterPathQuery("/Users/john/.zcode/AGENTS.md");
  assert.equal(resolved.looksLikePath, true);
  assert.equal(resolved.absolutePath, "/Users/john/.zcode/AGENTS.md");
});

test("粘贴带引号的绝对路径：先去掉引号再判定", () => {
  const resolved = resolveSearchCenterPathQuery('"/Users/john/notes/a.md"');
  assert.equal(resolved.looksLikePath, true);
  assert.equal(resolved.absolutePath, "/Users/john/notes/a.md");
});

test("粘贴 Windows 绝对路径：保留原有分隔符，不被改写成 POSIX 路径", () => {
  const resolved = resolveSearchCenterPathQuery("C:\\Users\\john\\notes\\a.md");
  assert.equal(resolved.looksLikePath, true);
  assert.equal(resolved.absolutePath, "C:\\Users\\john\\notes\\a.md");
});

test("粘贴 UNC 路径：判定为路径", () => {
  const resolved = resolveSearchCenterPathQuery("\\\\server\\share\\a.md");
  assert.equal(resolved.looksLikePath, true);
  assert.equal(resolved.absolutePath, "\\\\server\\share\\a.md");
});

test("粘贴 ~ 路径：用当前 Host 的 home 展开", () => {
  const resolved = resolveSearchCenterPathQuery("~/.zcode/AGENTS.md", "/Users/john");
  assert.equal(resolved.looksLikePath, true);
  assert.equal(resolved.absolutePath, "/Users/john/.zcode/AGENTS.md");
});

test("粘贴 ~ 路径但还没有 home：判定为路径，展开不了时不编造路径", () => {
  const resolved = resolveSearchCenterPathQuery("~/.zcode/AGENTS.md");
  assert.equal(resolved.looksLikePath, true);
  assert.equal(resolved.absolutePath, null);
});

test("粘贴相对路径：不当作路径，交给工作区索引的模糊与精确匹配", () => {
  const resolved = resolveSearchCenterPathQuery("src/app.tsx");
  assert.equal(resolved.looksLikePath, false);
  assert.equal(resolved.absolutePath, null);
});

test("空输入不是路径", () => {
  const resolved = resolveSearchCenterPathQuery("   ");
  assert.equal(resolved.looksLikePath, false);
  assert.equal(resolved.absolutePath, null);
});

test("路径等价比较：分隔符等价、忽略大小写、忽略结尾分隔符", () => {
  assert.equal(areSearchCenterPathsEqual("/Users/john/a.md", "/Users/john/a.md"), true);
  assert.equal(areSearchCenterPathsEqual("/Users/john/a.md", "\\Users\\john\\a.md"), true);
  assert.equal(areSearchCenterPathsEqual("/Users/john/a.md", "/Users/john/A.md"), true);
  assert.equal(areSearchCenterPathsEqual("/Users/john/a.md", "/Users/john/b.md"), false);
});

test("直接打开候选：文件名取末段，路径本身作为目录线索", () => {
  const row = buildSearchCenterPathCandidateRow("/Users/john/.zcode/AGENTS.md");
  assert.equal(row.name, "AGENTS.md");
  assert.equal(row.path, "/Users/john/.zcode/AGENTS.md");
  assert.equal(row.relativePath, "/Users/john/.zcode/AGENTS.md");
});

test("粘贴路径的候选置顶，并和工作区索引里的同一个文件去重", () => {
  const candidate = buildSearchCenterPathCandidateRow("/Users/john/.zcode/AGENTS.md");
  const rows = resolveSearchCenterRows({
    trimmedQuery: "/Users/john/.zcode/AGENTS.md",
    resultsQuery: "/Users/john/.zcode/AGENTS.md",
    entries: [
      { path: "/Users/john/.zcode/AGENTS.md", name: "AGENTS.md", relativePath: ".zcode/AGENTS.md" },
      { path: "/Users/john/notes/AGENTS.md", name: "AGENTS.md", relativePath: "notes/AGENTS.md" },
    ],
    openedFiles: [],
    pathCandidate: candidate,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.path, "/Users/john/.zcode/AGENTS.md");
  assert.equal(rows[1]?.path, "/Users/john/notes/AGENTS.md");
});

test("结果还没落定时不给候选：粘贴路径也不能提前可回车", () => {
  const candidate = buildSearchCenterPathCandidateRow("/Users/john/.zcode/AGENTS.md");
  const rows = resolveSearchCenterRows({
    trimmedQuery: "/Users/john/.zcode/AGENTS.md",
    resultsQuery: "/Users/john/.zco",
    entries: [],
    openedFiles: [],
    pathCandidate: candidate,
  });
  assert.deepEqual(rows, []);
});

test("空查询仍然只列已打开文件，不列路径候选", () => {
  const candidate = buildSearchCenterPathCandidateRow("/Users/john/.zcode/AGENTS.md");
  const rows = resolveSearchCenterRows({
    trimmedQuery: "",
    resultsQuery: "",
    entries: [],
    openedFiles: [{ path: "/Users/john/a.md", name: "a.md", relativePath: "a.md" }],
    pathCandidate: candidate,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.path, "/Users/john/a.md");
});

test("搜索中心提供路径相关的中英文文案", () => {
  assert.equal(zhCN["searchCenter.section.path"], "路径");
  assert.equal(enUS["searchCenter.section.path"], "Path");
  assert.ok(zhCN["searchCenter.pathMissing"]);
  assert.ok(enUS["searchCenter.pathMissing"]);
  assert.ok(zhCN["searchCenter.pathIsDirectory"]);
  assert.ok(enUS["searchCenter.pathIsDirectory"]);
});
