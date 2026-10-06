// Agent worktree 建树/拆树助手（docs/specs/agent-worktree-isolation.md）。
//
// 只做 git 进程调用与错误归因：不向 UI 透出 git stderr 文案，所有失败折叠成
// 协议稳定拒绝词表（AgentWorktreeAttachRejectedReason）。用户工作区语义
// （身份路径、HEAD、脏文件）由调用方持有；本模块保证任何失败都不改 repoRoot。
//
// 预留给 workflow `isolation: "worktree"` 复用：入口都以显式 repoRoot/worktreePath
// 为参数，不感知会话概念。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentWorktreeAttachRejectedReason } from "@zcode/shared/zcode-protocol-v4";

const execFileAsync = promisify(execFile);

/** 建树超时：正常毫秒级完成；超时按 create_failed 收口，不重试掩盖同步问题。 */
const GIT_TIMEOUT_MS = 30_000;

export class AgentWorktreeError extends Error {
  constructor(
    readonly reason: AgentWorktreeAttachRejectedReason,
    message: string,
  ) {
    super(message);
    this.name = "AgentWorktreeError";
  }
}

/** 本地实现 git check-ref-format 的拒绝规则；合法分支名才能进 worktree add。 */
export function isValidGitBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith("-") || name.startsWith(".") || name.endsWith(".")) return false;
  if (name.endsWith(".lock") || name.endsWith("/")) return false;
  if (name === "@") return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (/[\s~^:?*[\]\\]/.test(name)) return false;
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  return name.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

/** 仓库指纹 = 规范化绝对路径的短哈希；同一路径跨进程稳定，不含随机量。 */
export function agentWorktreeRepoFingerprint(repoRoot: string): string {
  return createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
}

/** worktree 根：~/.zcode/worktrees/<仓库指纹>/<sessionId>。不建在用户仓库内部。 */
export function agentWorktreeBaseDir(): string {
  return join(homedir(), ".zcode", "worktrees");
}

/** sessionId 可能含文件系统不安全字符（取决于生成器版本），统一消毒后作目录名。 */
function sanitizeSessionIdForPath(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function agentWorktreePathFor(repoRoot: string, sessionId: string): string {
  return join(
    agentWorktreeBaseDir(),
    agentWorktreeRepoFingerprint(repoRoot),
    sanitizeSessionIdForPath(sessionId),
  );
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; code: number | undefined; stderr: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    const code = typeof err.code === "number" ? err.code : undefined;
    return { ok: false, code, stderr: err.stderr ?? err.message ?? String(error) };
  }
}

/**
 * 从当前 HEAD 建新分支并挂 linked worktree。成功前不改用户仓库的任何状态
 * （worktree add 本身原子；预检只用于把常见失败翻译成稳定码）。
 */
export async function createAgentWorktree(input: {
  repoRoot: string;
  branch: string;
  worktreePath: string;
}): Promise<void> {
  const { branch, repoRoot, worktreePath } = input;
  if (!isValidGitBranchName(branch)) {
    throw new AgentWorktreeError("invalid_branch_name", `invalid git branch name: ${branch}`);
  }
  const inside = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new AgentWorktreeError("not_a_git_repository", `${repoRoot} is not a git work tree`);
  }
  const branchExists = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.ok) {
    throw new AgentWorktreeError("branch_already_exists", `branch already exists: ${branch}`);
  }
  try {
    await stat(worktreePath);
    throw new AgentWorktreeError(
      "worktree_path_conflict",
      `worktree path already exists: ${worktreePath}`,
    );
  } catch (error) {
    if (error instanceof AgentWorktreeError) throw error;
    // stat 失败 = 路径不存在，正是我们需要的空位。
  }
  await mkdir(dirname(worktreePath), { recursive: true });
  const add = await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath]);
  if (!add.ok) {
    // 竞态兜底：预检与 add 之间分支/路径被占用。按 stderr 关键词归类（仅分类，不上抛文案）。
    const stderr = add.stderr.toLowerCase();
    if (stderr.includes("already exists") && stderr.includes("branch")) {
      throw new AgentWorktreeError("branch_already_exists", `branch already exists: ${branch}`);
    }
    if (stderr.includes("already exists") || stderr.includes("already registered")) {
      throw new AgentWorktreeError("worktree_path_conflict", `worktree path conflict: ${worktreePath}`);
    }
    throw new AgentWorktreeError(
      "create_failed",
      `git worktree add failed (code=${add.code ?? "unknown"})`,
    );
  }
}

/**
 * 拆树并删除该会话创建的分支。尽力清理、幂等：每一步失败都不阻断下一步，
 * 返回实际完成情况供调用方记日志。
 */
export async function removeAgentWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
}): Promise<{ removedWorktree: boolean; removedBranch: boolean }> {
  const { branch, repoRoot, worktreePath } = input;
  let removedWorktree = false;
  let removedBranch = false;
  const remove = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  removedWorktree = remove.ok;
  if (!remove.ok) {
    // worktree remove 失败（目录被手动删过等）后 prune 元数据，避免残留注册表。
    await runGit(repoRoot, ["worktree", "prune"]);
  }
  const branchDelete = await runGit(repoRoot, ["branch", "-D", branch]);
  removedBranch = branchDelete.ok;
  // --force 之后目录应已消失；兜底清理残留（路径由本模块构造，非用户数据）。
  await rm(worktreePath, { recursive: true, force: true });
  return { removedWorktree, removedBranch };
}

/**
 * 冷恢复探测：worktree 目录存在且仍是可用 git 工作树 → 返回当前分支。
 * 目录不存在 / 不是 git 树 → null（调用方回退原工作区执行根）。
 */
export async function detectAgentWorktree(
  worktreePath: string,
): Promise<{ branch: string } | null> {
  try {
    await stat(worktreePath);
  } catch {
    return null;
  }
  const head = await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return null;
  const branch = head.stdout.trim();
  return branch.length > 0 ? { branch } : null;
}
