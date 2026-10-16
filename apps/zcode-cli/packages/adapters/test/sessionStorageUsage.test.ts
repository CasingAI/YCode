import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  dismissSessionStorageWarning,
  isSessionStorageWarningDismissed,
  scanSessionStorageUsage,
} from "../src/storage/session-storage-usage.js";

async function writeSizedFile(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 65));
}

test("session storage scan includes scoped session and subagent files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-storage-usage-"));
  const zcodeRoot = join(root, ".zcode");
  const ycodeRoot = join(root, ".ycode");
  try {
    await writeSizedFile(join(zcodeRoot, "cli", "exec", "sess_parent", "command.bin"), 1024);
    await writeSizedFile(join(zcodeRoot, "cli", "exec", "sess_child", "command.bin"), 2048);
    await writeSizedFile(join(zcodeRoot, "cli", "exec", "sess_other", "ignored.bin"), 8192);
    await writeSizedFile(
      join(ycodeRoot, "cli", "artifacts", "sess_parent", "tool-result.txt"),
      128,
    );
    await writeSizedFile(
      join(ycodeRoot, "cli", "agents", "sess_parent", "agent_1", "transcript.jsonl"),
      512,
    );
    await writeSizedFile(
      join(ycodeRoot, "cli", "agents", "sess_parent", "agent_1", "output.txt"),
      64,
    );
    await writeSizedFile(join(zcodeRoot, "cli", "sandbox", "sess_child", "world.sqlite"), 256);
    await writeSizedFile(join(zcodeRoot, "cli", "debug", "model-io-sess_parent.jsonl"), 32);
    await writeSizedFile(join(zcodeRoot, "cli", "debug", "model-io-sess_parent_extra.jsonl"), 1024);
    await writeSizedFile(
      join(zcodeRoot, "cli", "image-cache", "ycode-artifact-sess_parent", "image.png"),
      128,
    );
    await writeSizedFile(join(zcodeRoot, "cli", "log", "zcode.log"), 4096);
    await writeSizedFile(join(zcodeRoot, "cli", "db", "db.sqlite"), 4096);
    await writeSizedFile(join(root, "workspace", "project.txt"), 4096);

    const usage = await scanSessionStorageUsage({
      storageRoots: [zcodeRoot, ycodeRoot],
      sessionIds: ["sess_parent", "sess_child"],
    });
    const byCategory = new Map(usage.categories.map((category) => [category.categoryId, category]));

    assert.equal(usage.complete, true);
    assert.equal(usage.errorCount, 0);
    assert.equal(byCategory.get("commandOutputs")?.bytes, 3072);
    assert.equal(byCategory.get("commandOutputs")?.fileCount, 2);
    assert.equal(byCategory.get("toolOutputs")?.bytes, 192);
    assert.equal(byCategory.get("subagentTranscripts")?.bytes, 512);
    assert.equal(byCategory.get("sandbox")?.bytes, 256);
    assert.equal(byCategory.get("modelTrajectory")?.bytes, 32);
    assert.equal(byCategory.get("temporaryCaches")?.bytes, 128);
    assert.equal(usage.totalBytes, 4192);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dismissal is persisted per session outside the measured artifact roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-storage-dismiss-"));
  const stateRoot = join(root, ".ycode");
  try {
    assert.equal(await isSessionStorageWarningDismissed(stateRoot, "sess_1"), false);
    await dismissSessionStorageWarning(stateRoot, "sess_1");
    assert.equal(await isSessionStorageWarningDismissed(stateRoot, "sess_1"), true);
    assert.equal(await isSessionStorageWarningDismissed(stateRoot, "sess_2"), false);
    const markersDir = join(stateRoot, "cli", "state", "storage-warning-dismissed");
    const [markerName] = await readdir(markersDir);
    assert.ok(markerName.endsWith(".marker"));
    assert.equal(await readFile(join(markersDir, markerName), "utf8"), "dismissed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
