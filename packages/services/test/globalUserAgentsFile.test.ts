// 开机迁移把 `~/.claude/CLAUDE.md` 复制到 `~/.ycode/AGENTS.md`
// （docs/specs/global-user-agents-file.md）：旧 `~/.zcode/AGENTS.md` 不再作为目标，
// 也不被读取。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ISettingService } from "../src/setting/setting.js";
import { createSettingsSyncService } from "../src/settings-sync/settingsSyncService.js";

function createService() {
  return createSettingsSyncService({ settingService: {} as ISettingService });
}

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "global-agents-file-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(home, { recursive: true, force: true });
  }
}

test("迁移目标路径为 .ycode 根下的 AGENTS.md", async () => {
  await withTempHome(async (home) => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "claude 规则", "utf8");

    const status = await createService().getClaudeAgentsFileMigrationStatus({});

    assert.equal(status.targetPath, join(home, ".ycode", "AGENTS.md"));
    assert.equal(status.sourcePath, join(home, ".claude", "CLAUDE.md"));
    assert.equal(status.sourceExists, true);
    assert.equal(status.targetExists, false);
  });
});

test("复制只写 .ycode 根，不产生旧的 .zcode 文件", async () => {
  await withTempHome(async (home) => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "claude 规则", "utf8");

    const result = await createService().copyClaudeAgentsFileToZcodeAgentsFile({});

    assert.equal(result.status, "copied");
    assert.equal(result.targetPath, join(home, ".ycode", "AGENTS.md"));
    assert.equal(await readFile(join(home, ".ycode", "AGENTS.md"), "utf8"), "claude 规则");
    await assert.rejects(readFile(join(home, ".zcode", "AGENTS.md"), "utf8"));
  });
});
