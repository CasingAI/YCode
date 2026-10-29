import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  buildWorkspaceFileSearchIgnoreMatcher,
  buildWorkspaceFileSearchIgnoreTemplate,
  isWorkspaceFileSearchPathIgnored,
  resetWorkspaceFileSearchIgnoreDefaults,
  syncWorkspaceFileSearchIgnoreFromGitignore,
} from "@zcode/shared/workspaceFileIgnore";

const SYNC_MARKER = "# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====";
const DEFAULTS_MARKER =
  "# ----- ↑ 以上为 ZCode 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----";
const CUSTOM_HINT = "# 自定义规则写在下方（本行提示可删除）";

function withCustomRule(content: string, rule: string): string {
  return content.replace(CUSTOM_HINT, `${CUSTOM_HINT}\n${rule}`);
}

test("public entry exposes the ignore file name and a template that includes .git", () => {
  assert.equal(WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME, ".zcodeignore");

  const template = buildWorkspaceFileSearchIgnoreTemplate(null);
  assert.ok(template.includes(".git/"));
  assert.ok(template.includes("node_modules/"));
  assert.ok(template.includes("文件撤销"));
  assert.ok(template.includes("不限制 Agent 直接文件访问、不影响上传"));
  assert.ok(template.includes(SYNC_MARKER));
  assert.ok(template.includes(DEFAULTS_MARKER));

  const matcher = buildWorkspaceFileSearchIgnoreMatcher(template);
  const rules = { matcher };
  assert.equal(isWorkspaceFileSearchPathIgnored(rules, ".git/stage-mine.mjs", "file"), true);
  assert.equal(isWorkspaceFileSearchPathIgnored(rules, "node_modules/pkg/index.js", "file"), true);
});

test("template merges .gitignore without duplicating declared defaults", () => {
  const template = buildWorkspaceFileSearchIgnoreTemplate("node_modules/\n*.log");
  const lines = template.split("\n");

  assert.equal(lines.filter((line) => line === "node_modules/").length, 1);
  assert.ok(template.includes("*.log"));

  const [gitignoreSection = "", defaultsSection = ""] = [
    template.slice(0, template.indexOf(SYNC_MARKER)),
    template.slice(
      template.indexOf(SYNC_MARKER) + SYNC_MARKER.length,
      template.indexOf(DEFAULTS_MARKER),
    ),
  ];
  assert.ok(gitignoreSection.includes("node_modules/"));
  assert.equal(defaultsSection.includes("node_modules/"), false);
  assert.ok(defaultsSection.includes(".git/"));
});

test("section transforms only rewrite their own partition", () => {
  const original = withCustomRule(buildWorkspaceFileSearchIgnoreTemplate("dist/\n"), "secret/");

  const synced = syncWorkspaceFileSearchIgnoreFromGitignore(original, "build/\n");
  assert.ok(synced.includes("build/"));
  assert.equal(synced.includes("dist/"), false);
  assert.ok(synced.includes("secret/"));
  assert.ok(synced.includes(".git/"));
  assert.ok(synced.includes("node_modules/"));

  const defaultsRemoved = original.replace("node_modules/\n", "");
  assert.equal(defaultsRemoved.includes("node_modules/"), false);
  const reset = resetWorkspaceFileSearchIgnoreDefaults(defaultsRemoved, null);
  assert.ok(reset.includes("dist/"));
  assert.ok(reset.includes("secret/"));
  assert.ok(reset.includes("node_modules/"));
  assert.equal(reset.includes("build/"), false);
});

test("custom negation follows gitignore declaration order", () => {
  const rules = { matcher: buildWorkspaceFileSearchIgnoreMatcher("*.log\n!important.log\n") };

  assert.equal(isWorkspaceFileSearchPathIgnored(rules, "debug.log", "file"), true);
  assert.equal(isWorkspaceFileSearchPathIgnored(rules, "important.log", "file"), false);
  assert.equal(isWorkspaceFileSearchPathIgnored(rules, "nested/debug.log", "file"), true);
});

test("directory rules use directory semantics, including unrecoverable children", () => {
  const directoryRules = { matcher: buildWorkspaceFileSearchIgnoreMatcher("build/\n") };
  assert.equal(isWorkspaceFileSearchPathIgnored(directoryRules, "build", "directory"), true);
  assert.equal(isWorkspaceFileSearchPathIgnored(directoryRules, "build", "file"), false);
  assert.equal(isWorkspaceFileSearchPathIgnored(directoryRules, "build/out.js", "file"), true);

  const parentNegation = {
    matcher: buildWorkspaceFileSearchIgnoreMatcher("logs/\n!logs/keep.log\n"),
  };
  assert.equal(isWorkspaceFileSearchPathIgnored(parentNegation, "logs", "directory"), true);
  assert.equal(isWorkspaceFileSearchPathIgnored(parentNegation, "logs/keep.log", "file"), true);
});

test("existing content is authoritative and does not gain default exclusions", () => {
  const emptyRules = { matcher: buildWorkspaceFileSearchIgnoreMatcher("") };
  assert.equal(isWorkspaceFileSearchPathIgnored(emptyRules, ".git/config", "file"), false);
  assert.equal(isWorkspaceFileSearchPathIgnored(emptyRules, "node_modules/x.js", "file"), false);

  const customRules = { matcher: buildWorkspaceFileSearchIgnoreMatcher("*.tmp\n") };
  assert.equal(isWorkspaceFileSearchPathIgnored(customRules, "scratch.tmp", "file"), true);
  assert.equal(isWorkspaceFileSearchPathIgnored(customRules, ".git/config", "file"), false);
});
