import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BASH_READONLY_POLICY_VERSION,
  isReadOnlyBashCommand,
} from "@zcode/shared/node/bash-readonly";
import { isRuntimeReadOnlyBashCommand } from "../src/tool/handlers/bash-semantics.js";

// 迁移一致性：CLI 侧 isRuntimeReadOnlyBashCommand 只是共享实现的别名，
// 两者对同一命令集判定必须一致；规则内容变更时同步递增 POLICY_VERSION。

test("只读命令放行：git status/log/diff", () => {
  for (const command of ["git status", "git log --oneline", "git diff"]) {
    assert.equal(isReadOnlyBashCommand(command), true, command);
    assert.equal(isRuntimeReadOnlyBashCommand(command), true, command);
  }
});

test("写命令拒绝：reset/rm/重定向/env 赋值", () => {
  const denied = [
    "git reset --hard",
    "rm -rf /tmp/x",
    "echo hi > /tmp/x",
    "FOO=bar git status",
    "git status && rm -rf /tmp/x",
    "git status && git reset --hard",
  ];
  for (const command of denied) {
    assert.equal(isReadOnlyBashCommand(command), false, command);
    assert.equal(isRuntimeReadOnlyBashCommand(command), false, command);
  }
});

test("解析失败按拒绝处理", () => {
  for (const command of ["", "   ", "echo $(rm -rf /)", "git status | tee /tmp/x"]) {
    assert.equal(isReadOnlyBashCommand(command), false, JSON.stringify(command));
  }
});

test("白名单版本号存在，供 harness 缓存失效", () => {
  assert.equal(typeof BASH_READONLY_POLICY_VERSION, "number");
});

// git 全局参数：安全前缀剥除后仍由子命令 safeFlags 兜底；带值前缀要额外校验目标目录。
// 这里用真实临时目录构造工作区，因为 -C 判定依赖 realpath 与 .git 探测。
function createWorkspaceWithGitFixture() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "bash-readonly-workspace-"));
  const gitDir = join(workspaceRoot, ".git");
  mkdirSync(join(gitDir, "objects"), { recursive: true });
  mkdirSync(join(gitDir, "refs"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(workspaceRoot, "packages", "ui"), { recursive: true });
  return { workspaceRoot, workingDirectory: workspaceRoot };
}

const outsideDirectory = mkdtempSync(join(tmpdir(), "bash-readonly-outside-"));

test("git -C 指向工作区内目录时放行：分号写法、粘连写法、多次 -C", () => {
  const context = createWorkspaceWithGitFixture();
  const allowed = [
    `git -C ${context.workspaceRoot} status --short --branch`,
    `git -C${context.workspaceRoot} status`,
    "git -C . status",
    "git -C packages/ui log --oneline",
    `git -C ${context.workspaceRoot} -C packages/ui status`,
  ];
  for (const command of allowed) {
    assert.equal(isReadOnlyBashCommand(command, context), true, command);
    assert.equal(isRuntimeReadOnlyBashCommand(command, context), true, command);
  }
});

test("git -C 指向工作区外或不存在的目录时拒绝", () => {
  const context = createWorkspaceWithGitFixture();
  const denied = [
    `git -C ${outsideDirectory} status`,
    "git -C .. status",
    "git -C packages/../.. status",
    "git -C packages/nonexistent status",
    "git -C ../../.. status",
    "git -C / status",
  ];
  for (const command of denied) {
    assert.equal(isReadOnlyBashCommand(command, context), false, command);
    assert.equal(isRuntimeReadOnlyBashCommand(command, context), false, command);
  }
});

test("git -C 缺运行时上下文时按拒绝处理", () => {
  for (const command of ["git -C . status", "git -C/tmp status"]) {
    assert.equal(isReadOnlyBashCommand(command), false, command);
    assert.equal(isRuntimeReadOnlyBashCommand(command), false, command);
  }
  // 缺 workspaceRoot 也无法判边界，同样拒绝。
  assert.equal(
    isReadOnlyBashCommand("git -C . status", { workingDirectory: process.cwd() }),
    false,
  );
});

test("剥离 -C 前缀不放行写子命令参数", () => {
  const context = createWorkspaceWithGitFixture();
  const denied = [
    "git -C . reset --hard",
    "git -C . clean -fd",
    "git -C . commit -m x",
    "git -C . checkout other",
    "git -C .",
  ];
  for (const command of denied) {
    assert.equal(isReadOnlyBashCommand(command, context), false, command);
  }
});

test("危险全局参数继续拒绝，含 =-粘连与短参数粘连", () => {
  const context = createWorkspaceWithGitFixture();
  const denied = [
    "git -c alias.x='rm -rf /' status",
    "git -calias.x=foo status",
    "git --config-env=core.editor=evil status",
    "git --git-dir=/tmp/other.git status",
    "--git-dir=/tmp/other.git status",
    "git --work-tree=/tmp status",
    "git --exec-path=/tmp log",
    "git --attr-source=/tmp diff",
    "git --bare status",
    "git --namespace=/tmp log",
    "git --super-prefix=/tmp log",
    "git --shallow-file=/tmp/xx status",
    "git --some-new-global status",
  ];
  for (const command of denied) {
    assert.equal(isReadOnlyBashCommand(command, context), false, command);
  }
});

test("无值安全全局参数放行", () => {
  const context = createWorkspaceWithGitFixture();
  const allowed = [
    "git --no-pager status",
    "git --paginate log --oneline",
    "git --no-pager --paginate status",
  ];
  for (const command of allowed) {
    assert.equal(isReadOnlyBashCommand(command, context), true, command);
  }
});

test("无值参数与 -C 混用时两种顺序都放行", () => {
  const context = createWorkspaceWithGitFixture();
  for (const command of ["git -C . --no-pager status", "git --no-pager -C . status"]) {
    assert.equal(isReadOnlyBashCommand(command, context), true, command);
  }
});

test("符号链接指向工作区外时拒绝", () => {
  const context = createWorkspaceWithGitFixture();
  symlinkSync(outsideDirectory, join(context.workspaceRoot, "escape-link"), "dir");
  // realpath 归一后逃出工作区，必须拒绝。
  assert.equal(isReadOnlyBashCommand("git -C escape-link status", context), false);
  assert.equal(isReadOnlyBashCommand("git -C escape-link/. status", context), false);
});

test("第二个 -C 逃出工作区时整条拒绝", () => {
  const context = createWorkspaceWithGitFixture();
  assert.equal(isReadOnlyBashCommand("git -C . -C /tmp status", context), false);
  assert.equal(isReadOnlyBashCommand("git -C packages -C .. status", context), false);
});

test("-C 的值形态异常时拒绝", () => {
  const context = createWorkspaceWithGitFixture();
  const denied = [
    // 值以 - 开头，git 会把它当下一个全局参数，等于没给 -C 值。
    "git -C --git-dir=/tmp status",
    "git -C -- status",
    // 值含控制字符：git 自己会把 `-C "a\nb"` 拆成两个目录依次切换。
    "git -C $'packages\\n/etc' status",
    // -C 缺值。
    "git -C",
  ];
  for (const command of denied) {
    assert.equal(isReadOnlyBashCommand(command, context), false, command);
  }
});

test("安全前缀与危险全局参数混用时仍拒绝", () => {
  const context = createWorkspaceWithGitFixture();
  for (const command of [
    "git -C . --config-env=core.editor=evil status",
    "git --no-pager -C . --exec-path=/tmp log",
    "git -C . -calias.x=evil status",
  ]) {
    assert.equal(isReadOnlyBashCommand(command, context), false, command);
  }
});

test("仅大小写不同的目录在大小写敏感文件系统上不视为同一目录", () => {
  // canonicalPath 复用了为 .git 目标比较准备的小写化归一；边界判定必须绕开它，
  // 否则 Linux 上 `git -C /tmp/WS` 会通过 `/tmp/ws` 的边界检查。
  const context = createWorkspaceWithGitFixture();
  assert.equal(
    isReadOnlyBashCommand(`git -C ${context.workspaceRoot.toUpperCase()} status`, context),
    true,
    "工作区自身的大小写变体必须仍算工作区内",
  );

  const sibling = `${context.workspaceRoot}-sibling`;
  mkdirSync(join(sibling, ".git", "objects"), { recursive: true });
  mkdirSync(join(sibling, ".git", "refs"), { recursive: true });
  writeFileSync(join(sibling, ".git", "HEAD"), "ref: refs/heads/main\n");
  assert.equal(
    isReadOnlyBashCommand(`git -C ${sibling} status`, context),
    false,
    "工作区外的兄弟目录必须拒绝",
  );
});
