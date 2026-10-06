// Agent worktree 建树/拆树/探测助手测试（docs/specs/agent-worktree-isolation.md）。
// 用真实临时 git 仓库验证：建树后用户仓库 HEAD 不变、分支出现在仓库、
// 拆树后 worktree 与分支都消失（验收场景 1/3），失败归类到稳定拒绝码。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  AgentWorktreeError,
  agentWorktreePathFor,
  createAgentWorktree,
  detectAgentWorktree,
  isValidGitBranchName,
  removeAgentWorktree,
} from "../src/git/agent-worktree.js";

const execFileAsync = promisify(execFile);

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-worktree-test-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repoRoot });
  return repoRoot;
}

async function gitHead(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

async function gitBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

test("isValidGitBranchName follows git check-ref-format rejection rules", () => {
  const valid = ["agent/fix-login-bug", "feature.x", "a/b/c", "release-1.0", "中文分支"];
  for (const name of valid) {
    assert.equal(isValidGitBranchName(name), true, `expected valid: ${name}`);
  }
  const invalid = [
    "",
    "-leading-dash",
    ".leading-dot",
    "trailing-dot.",
    "trailing.lock",
    "trailing-slash/",
    "double..dot",
    "brace@{block",
    "double//slash",
    "has space",
    "tilde~caret^",
    "colon:question?star*bracket[",
    "back\\slash",
    "@",
    "segment/.leading-dot",
    "ctrl\x01char",
  ];
  for (const name of invalid) {
    assert.equal(isValidGitBranchName(name), false, `expected invalid: ${JSON.stringify(name)}`);
  }
});

test("agentWorktreePathFor builds a deterministic path under ~/.zcode/worktrees", () => {
  const path = agentWorktreePathFor("/tmp/repo", "session-1");
  assert.ok(path.startsWith(join(homedir(), ".zcode", "worktrees") + "/"));
  assert.equal(path, agentWorktreePathFor("/tmp/repo", "session-1"));
  assert.notEqual(path, agentWorktreePathFor("/tmp/other", "session-1"));
  // 路径片段不落用户仓库内部。
  assert.ok(!path.includes("/tmp/repo/"));
});

test("createAgentWorktree creates branch + worktree without touching user HEAD", async () => {
  const repoRoot = await createTempRepo();
  const headBefore = await gitHead(repoRoot);
  const worktreePath = join(repoRoot, "..", "agent-worktree-test-wt");
  await rm(worktreePath, { recursive: true, force: true });
  try {
    await createAgentWorktree({ branch: "agent/isolated", repoRoot, worktreePath });
    assert.equal(await gitBranchExists(repoRoot, "agent/isolated"), true);
    assert.equal(await gitHead(repoRoot), headBefore, "user repo HEAD must not change");
    const detected = await detectAgentWorktree(worktreePath);
    assert.deepEqual(detected, { branch: "agent/isolated" });
  } finally {
    await removeAgentWorktree({ branch: "agent/isolated", repoRoot, worktreePath });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("createAgentWorktree maps failures to stable rejection reasons", async () => {
  const repoRoot = await createTempRepo();
  const worktreePath = join(repoRoot, "..", "agent-worktree-test-wt-conflict");
  await rm(worktreePath, { recursive: true, force: true });
  try {
    // 非法分支名：本地词法拒绝，不触碰 git。
    await assert.rejects(
      createAgentWorktree({ branch: "-bad", repoRoot, worktreePath }),
      (error: unknown) =>
        error instanceof AgentWorktreeError && error.reason === "invalid_branch_name",
    );
    // 分支已存在：预检命中稳定码。
    await execFileAsync("git", ["branch", "existing"], { cwd: repoRoot });
    await assert.rejects(
      createAgentWorktree({ branch: "existing", repoRoot, worktreePath }),
      (error: unknown) =>
        error instanceof AgentWorktreeError && error.reason === "branch_already_exists",
    );
    // 路径冲突：目标目录已存在。
    const { mkdir } = await import("node:fs/promises");
    await mkdir(worktreePath, { recursive: true });
    await assert.rejects(
      createAgentWorktree({ branch: "agent/ok", repoRoot, worktreePath }),
      (error: unknown) =>
        error instanceof AgentWorktreeError && error.reason === "worktree_path_conflict",
    );
    // 非 git 仓库。
    const notARepo = await mkdtemp(join(tmpdir(), "agent-worktree-norepo-"));
    try {
      await assert.rejects(
        createAgentWorktree({
          branch: "agent/ok",
          repoRoot: notARepo,
          worktreePath: join(notARepo, "wt"),
        }),
        (error: unknown) =>
          error instanceof AgentWorktreeError && error.reason === "not_a_git_repository",
      );
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  } finally {
    await rm(worktreePath, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("removeAgentWorktree removes worktree and branch, and is idempotent", async () => {
  const repoRoot = await createTempRepo();
  const worktreePath = join(repoRoot, "..", "agent-worktree-test-wt-remove");
  await rm(worktreePath, { recursive: true, force: true });
  try {
    await createAgentWorktree({ branch: "agent/gone", repoRoot, worktreePath });
    const removed = await removeAgentWorktree({
      branch: "agent/gone",
      repoRoot,
      worktreePath,
    });
    assert.equal(removed.removedWorktree, true);
    assert.equal(removed.removedBranch, true);
    assert.equal(await gitBranchExists(repoRoot, "agent/gone"), false);
    await assert.rejects(() => import("node:fs/promises").then((fs) => fs.stat(worktreePath)));
    // 幂等：重复拆除不抛错。
    const again = await removeAgentWorktree({ branch: "agent/gone", repoRoot, worktreePath });
    assert.equal(again.removedWorktree, false);
    assert.equal(again.removedBranch, false);
  } finally {
    await rm(worktreePath, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("detectAgentWorktree returns null for missing directory or non-git directory", async () => {
  assert.equal(await detectAgentWorktree(join(tmpdir(), "agent-worktree-definitely-missing-wt")), null);
  const plain = await mkdtemp(join(tmpdir(), "agent-worktree-plain-"));
  try {
    assert.equal(await detectAgentWorktree(plain), null);
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});
