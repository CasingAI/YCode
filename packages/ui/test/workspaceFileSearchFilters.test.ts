import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  filterWorkspaceFileSearchCandidates,
  hasWorkspaceFileSearchPatterns,
  mapWorkspaceFileEntriesToSearchCandidates,
  parseWorkspaceFileSearchPatterns,
  workspaceFileSearchGlobMatches,
} from "@zcode/shared/workspaceFileSearch";

function entry(
  relativePath: string,
  type: WorkspaceFileEntry["type"] = "file",
): WorkspaceFileEntry {
  const name = relativePath.split("/").pop() ?? relativePath;
  return {
    path: `/ws/${relativePath}`,
    relativePath,
    name,
    type,
  };
}

function list(relativePaths: string[], type: WorkspaceFileEntry["type"] = "file") {
  return mapWorkspaceFileEntriesToSearchCandidates(
    relativePaths.map((relativePath) => entry(relativePath, type)),
  );
}

function filteredPaths(
  relativePaths: string[],
  query: string,
  options: {
    include?: string;
    exclude?: string;
    limit?: number;
    requireQuery?: boolean;
    allowedPaths?: string[];
  },
): string[] {
  return filterWorkspaceFileSearchCandidates(list(relativePaths), query, options).map(
    (candidate) => candidate.relativePath,
  );
}

test("逗号分隔的模式：去首尾空白、忽略空项、保留原始大小写", () => {
  assert.deepEqual(parseWorkspaceFileSearchPatterns(" *.ts , , src/**/*.ps1 ,"), [
    "*.ts",
    "src/**/*.ps1",
  ]);
  assert.deepEqual(parseWorkspaceFileSearchPatterns("   "), []);
  assert.deepEqual(parseWorkspaceFileSearchPatterns(""), []);
  // 反斜杠属于模式本身，解析阶段不改写。
  assert.deepEqual(parseWorkspaceFileSearchPatterns("src\\**\\*.ts"), ["src\\**\\*.ts"]);
});

test("是否进入结果态：只有空白/逗号时不算有效范围", () => {
  assert.equal(hasWorkspaceFileSearchPatterns(), false);
  assert.equal(hasWorkspaceFileSearchPatterns("", " , "), false);
  assert.equal(hasWorkspaceFileSearchPatterns("*.ts"), true);
  assert.equal(hasWorkspaceFileSearchPatterns("", "*.log"), true);
});

test("glob 从根与深层命中，* 不跨目录、** 跨目录、? 单字符", () => {
  assert.equal(workspaceFileSearchGlobMatches("**/*.ps1", "deploy.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("**/*.ps1", "scripts/build.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("**/*.ps1", "scripts/deep/build.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("**/*.ps1", "scripts/build.psm1"), false);

  // `**/` 允许零层目录：src/**/*.ps1 也命中 src/a.ps1。
  assert.equal(workspaceFileSearchGlobMatches("src/**/*.ps1", "src/a.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("src/**/*.ps1", "src/x/y/a.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("src/**/*.ps1", "lib/a.ps1"), false);

  // 无分隔符的模式匹配任意层级文件名。
  assert.equal(workspaceFileSearchGlobMatches("*.ps1", "a/b/c.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("a?c.txt", "abc.txt"), true);
  assert.equal(workspaceFileSearchGlobMatches("a?c.txt", "abbc.txt"), false);
  assert.equal(workspaceFileSearchGlobMatches("a?c.txt", "a/c.txt"), false);
});

test("glob 兼容 Windows 反斜杠且不区分大小写", () => {
  assert.equal(workspaceFileSearchGlobMatches("**\\overlay-*.ps1", "tools/overlay-a.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("**/overlay-*.ps1", "tools\\overlay-a.ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("SRC/**/*.PS1", "src/a/b.Ps1"), true);
  assert.equal(workspaceFileSearchGlobMatches("src\\*.ps1", "src/a.ps1"), true);
});

test("目录后缀匹配目录本身及其内容，不误匹配同前缀文件", () => {
  assert.equal(
    workspaceFileSearchGlobMatches("src/generated/", "src/generated", { isDirectory: true }),
    true,
  );
  assert.equal(workspaceFileSearchGlobMatches("src/generated/", "src/generated/a.ts"), true);
  assert.equal(workspaceFileSearchGlobMatches("src/generated/", "src/generated/deep/b.ts"), true);
  assert.equal(
    workspaceFileSearchGlobMatches("src/generated/", "src/generated", { isDirectory: false }),
    false,
  );
  assert.equal(workspaceFileSearchGlobMatches("src/generated/", "src/generated-file.ts"), false);

  // **/ 目录后缀同样允许零层。
  assert.equal(workspaceFileSearchGlobMatches("**/generated/", "generated/a.ts"), true);
  assert.equal(workspaceFileSearchGlobMatches("**/generated/", "a/b/generated/x.ts"), true);
});

test("多条包含取并集，排除优先于包含", () => {
  const paths = ["a.ts", "b.js", "c.md", "src/d.ts", "src/d.js"];
  assert.deepEqual(filteredPaths(paths, "", { include: "*.ts, *.js" }).sort(), [
    "a.ts",
    "b.js",
    "src/d.js",
    "src/d.ts",
  ]);
  assert.deepEqual(filteredPaths(paths, "", { include: "*.ts,*.js", exclude: "src/**" }), [
    "a.ts",
    "b.js",
  ]);
  // 排除与包含同时命中时，排除胜出。
  assert.deepEqual(filteredPaths(paths, "", { include: "src/d.ts", exclude: "**/d.ts" }), []);
});

test("关键词与路径条件取交集", () => {
  const paths = ["src/app.ts", "src/app.tsx", "docs/app.md", "src/other.ts"];
  assert.deepEqual(filteredPaths(paths, "app", { include: "*.ts" }).sort(), ["src/app.ts"]);
  assert.deepEqual(filteredPaths(paths, "app", { exclude: "*.ts" }).sort(), [
    "docs/app.md",
    "src/app.tsx",
  ]);
  assert.deepEqual(filteredPaths(paths, "missing", { include: "*.ts" }), []);
});

test("无关键词但有范围时仍列结果；无关键词无范围保持旧行为", () => {
  const paths = ["a.ts", "b.js", "src/c.ts"];
  // 旧行为：requireQuery 时空查询不出结果。
  assert.deepEqual(filteredPaths(paths, "", { requireQuery: true }), []);
  // 新行为：有 include/exclude 时即使 requireQuery 也返回结果。
  assert.deepEqual(filteredPaths(paths, "", { requireQuery: true, include: "*.ts" }).sort(), [
    "a.ts",
    "src/c.ts",
  ]);
  assert.deepEqual(filteredPaths(paths, "", { requireQuery: true, exclude: "*.ts" }), ["b.js"]);
  // 没有 requireQuery 时旧行为仍是默认排序后全量返回。
  assert.deepEqual(filteredPaths(paths, "").sort(), ["a.ts", "b.js", "src/c.ts"]);
});

test("无关键词时目录后缀范围包含目录条目与其内容", () => {
  const candidates = mapWorkspaceFileEntriesToSearchCandidates([
    entry("src", "directory"),
    entry("src/a.ts"),
    entry("lib/b.ts"),
  ]);
  const result = filterWorkspaceFileSearchCandidates(candidates, "", { include: "src/" });
  assert.deepEqual(
    result.map((candidate) => candidate.relativePath),
    ["src/a.ts", "src"],
  );
});

test("范围条件在 1000 条截断前生效，早期不匹配不会挤掉后续匹配", () => {
  const paths: string[] = [];
  for (let index = 0; index < 1000; index += 1) {
    paths.push(`logs/noise-${index}.log`);
  }
  paths.push("target/keep.ts");

  assert.deepEqual(filteredPaths(paths, "", { include: "**/*.ts" }), ["target/keep.ts"]);
  assert.deepEqual(filteredPaths(paths, "", { exclude: "logs/**" }), ["target/keep.ts"]);
  // 关键词交集同样先过滤后截断。
  assert.deepEqual(filteredPaths(paths, "keep", { include: "**/*.ts" }), ["target/keep.ts"]);
});

test("既有模糊搜索和精确路径优先不回归", () => {
  const candidates = list(["README.md", "src/app.tsx", "src/hooks/useFoo.ts"]);

  const fuzzy = filterWorkspaceFileSearchCandidates(candidates, "read");
  assert.equal(fuzzy[0]?.relativePath, "README.md");

  // 精确路径优先于模糊结果，Windows 反斜杠同样按精确路径处理。
  const exact = filterWorkspaceFileSearchCandidates(candidates, "src\\app.tsx");
  assert.equal(exact[0]?.relativePath, "src/app.tsx");
  const exactQuoted = filterWorkspaceFileSearchCandidates(candidates, '"src/app.tsx"');
  assert.equal(exactQuoted[0]?.relativePath, "src/app.tsx");
});

test("allowedPaths 精确门禁在 query/范围/default 各分支都先于 limit 生效", () => {
  const paths: string[] = [];
  for (let index = 0; index < 1000; index += 1) {
    paths.push(`noise-${index}.ts`);
  }
  paths.push("changed/keep.ts");

  // default 分支（无 query 无 scope）：前 1000 条非变更候选不能挤掉变更文件。
  assert.deepEqual(filteredPaths(paths, "", { allowedPaths: ["/ws/changed/keep.ts"] }), [
    "changed/keep.ts",
  ]);
  // query 分支：同样先门禁后 top-K。
  assert.deepEqual(filteredPaths(paths, "ts", { allowedPaths: ["/ws/changed/keep.ts"] }), [
    "changed/keep.ts",
  ]);
  // 范围分支：include 命中全部候选，门禁仍先于截断。
  assert.deepEqual(
    filteredPaths(paths, "", { include: "*.ts", allowedPaths: ["/ws/changed/keep.ts"] }),
    ["changed/keep.ts"],
  );
});

test("allowedPaths 空数组返回空，undefined 不限制", () => {
  const paths = ["a.ts", "b.js"];
  assert.deepEqual(filteredPaths(paths, "", { allowedPaths: [] }), []);
  assert.deepEqual(filteredPaths(paths, "a", { allowedPaths: [] }), []);
  assert.deepEqual(filteredPaths(paths, "", { include: "*.ts", allowedPaths: [] }), []);
  assert.deepEqual(filteredPaths(paths, "", {}).sort(), ["a.ts", "b.js"]);
});

test("allowedPaths 用候选绝对 path 匹配：POSIX 与 Windows 绝对路径", () => {
  const candidates = mapWorkspaceFileEntriesToSearchCandidates([
    { path: "/repo/src/app.ts", relativePath: "src/app.ts", name: "app.ts", type: "file" },
    {
      path: "C:\\Repo\\Src\\Main.ts",
      relativePath: "Src/Main.ts",
      name: "Main.ts",
      type: "file",
    },
  ]);
  const run = (allowedPaths?: string[]) =>
    filterWorkspaceFileSearchCandidates(candidates, "", { allowedPaths }).map(
      (candidate) => candidate.relativePath,
    );

  assert.deepEqual(run(["/repo/src/app.ts"]), ["src/app.ts"]);
  assert.deepEqual(run(["C:\\Repo\\Src\\Main.ts"]), ["Src/Main.ts"]);
  // 分隔符归一与尾部斜杠归一后仍精确命中。
  assert.deepEqual(run(["C:/Repo/Src/Main.ts/"]), ["Src/Main.ts"]);
  // 相对路径不是绝对 key，不能命中；大小写敏感不做跨平台推断。
  assert.deepEqual(run(["src/app.ts"]), []);
  assert.deepEqual(run(["c:/repo/src/main.ts"]), []);
  assert.deepEqual(run(["/repo/src/APP.ts"]), []);
});

test("include/exclude 不改变无范围时的候选数量与顺序", () => {
  const paths = ["b.ts", "a.ts", "zzz.ts", "c.ts"];
  const withoutScope = filteredPaths(paths, "");
  assert.deepEqual(withoutScope, ["b.ts", "a.ts", "zzz.ts", "c.ts"]);
  assert.deepEqual(filteredPaths(paths, "", { include: "" }), withoutScope);
  assert.deepEqual(filteredPaths(paths, "", { exclude: " , " }), withoutScope);
});
