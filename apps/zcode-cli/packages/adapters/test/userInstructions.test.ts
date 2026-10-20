// 全局用户指令只读 `~/.ycode/AGENTS.md`（docs/specs/global-user-agents-file.md）：
// 旧 `~/.zcode/AGENTS.md` 不再作为来源；用户级与工作区级内容按 user → workspace 顺序拼接。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeContextSourceAdapter } from "../src/context/index.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeAgentsFile(directory: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "AGENTS.md"), content, "utf8");
}

test("全局用户指令从 .ycode 根读取", async () => {
  const home = await createTempDir("user-instructions-home-");
  const workspace = await createTempDir("user-instructions-workspace-");
  try {
    await writeAgentsFile(join(home, ".ycode"), "全局规则");
    const adapter = createNodeContextSourceAdapter({ env: { HOME: home, USERPROFILE: home } });

    const snapshot = await adapter.resolveContextSources({
      workingDirectory: workspace,
      userInstructions: { workingDirectory: workspace, projectRoot: workspace },
    });

    assert.equal(snapshot.userInstructions?.content, "全局规则");
    assert.equal(snapshot.userInstructions?.sources?.length, 1);
    assert.equal(snapshot.userInstructions?.sources?.[0]?.scope, "user");
    assert.equal(
      snapshot.userInstructions?.sources?.[0]?.filePath,
      join(home, ".ycode", "AGENTS.md"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("旧 .zcode 全局指令不再被读取", async () => {
  const home = await createTempDir("user-instructions-legacy-home-");
  const workspace = await createTempDir("user-instructions-legacy-workspace-");
  try {
    await writeAgentsFile(join(home, ".zcode"), "旧全局规则");
    const adapter = createNodeContextSourceAdapter({ env: { HOME: home, USERPROFILE: home } });

    const snapshot = await adapter.resolveContextSources({
      workingDirectory: workspace,
      userInstructions: { workingDirectory: workspace, projectRoot: workspace },
    });

    assert.equal(snapshot.userInstructions, undefined);
    assert.equal(snapshot.diagnostics.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("用户级与工作区级指令按 user → workspace 顺序拼接", async () => {
  const home = await createTempDir("user-instructions-merge-home-");
  const workspace = await createTempDir("user-instructions-merge-workspace-");
  try {
    await writeAgentsFile(join(home, ".ycode"), "全局规则");
    await writeAgentsFile(workspace, "工作区规则");
    const adapter = createNodeContextSourceAdapter({ env: { HOME: home, USERPROFILE: home } });

    const snapshot = await adapter.resolveContextSources({
      workingDirectory: workspace,
      userInstructions: { workingDirectory: workspace, projectRoot: workspace },
    });

    assert.equal(snapshot.userInstructions?.content, "全局规则\n\n工作区规则");
    assert.deepEqual(
      snapshot.userInstructions?.sources?.map((source) => source.scope),
      ["user", "workspace"],
    );
    // 对外展示的路径取工作区级文件。
    assert.equal(snapshot.userInstructions?.filePath, join(workspace, "AGENTS.md"));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
