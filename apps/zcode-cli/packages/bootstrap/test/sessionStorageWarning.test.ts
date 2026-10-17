import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createSessionStorageWarningHost } from "../src/zcode-protocol/session-storage-warning.js";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const ROOT_SESSION = "sess_root";
const CHILD_SESSION = "sess_child";
const FORK_SESSION = "sess_fork";

async function writeSizedFile(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 65));
}

test("host scan includes persisted subagent descendants and stores dismissal by root session", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "session-storage-host-"));
  const storageRoot = join(temporaryRoot, ".zcode");
  const stateRoot = join(temporaryRoot, ".ycode");
  try {
    await writeSizedFile(join(storageRoot, "cli", "exec", ROOT_SESSION, "command.bin"), 1024);
    await writeSizedFile(
      join(storageRoot, "cli", "agents", ROOT_SESSION, CHILD_SESSION, "transcript.jsonl"),
      2048,
    );
    await writeSizedFile(
      join(storageRoot, "cli", "artifacts", FORK_SESSION, "fork-output.txt"),
      4096,
    );

    const sessionStore = {
      getSession: async (sessionId: string) =>
        sessionId === ROOT_SESSION ? { id: ROOT_SESSION } : null,
      listSessions: async () => [
        { id: CHILD_SESSION, parentID: ROOT_SESSION, taskType: "subagent_child" },
        { id: FORK_SESSION, parentID: ROOT_SESSION, taskType: "fork" },
      ],
    } as unknown as ZCodeProtocolAgentServerContext["deps"]["sessionStore"];
    const context = {
      deps: {
        sessionStore,
        sessionStorageRoots: [storageRoot],
        sessionStorageWarningStateRoot: stateRoot,
      },
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext;
    const host = createSessionStorageWarningHost(context);

    const initial = await host.readSessionStorageUsage(ROOT_SESSION);
    assert.equal(initial.totalBytes, 3072);
    assert.equal(initial.dismissed, false);
    assert.deepEqual(initial.categories.map(({ categoryId }) => categoryId).sort(), [
      "commandOutputs",
      "subagentTranscripts",
    ]);

    await host.dismissSessionStorageWarning(ROOT_SESSION);
    const afterDismiss = await host.readSessionStorageUsage(ROOT_SESSION);
    assert.equal(afterDismiss.dismissed, true);

    await assert.rejects(host.readSessionStorageUsage("sess_missing"), /fault\.session\.notFound/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("host scan rejects when its deadline expires", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "session-storage-host-timeout-"));
  try {
    const context = {
      deps: {
        sessionStore: {
          getSession: async () => ({ id: ROOT_SESSION }),
          listSessions: async () => [],
        },
        sessionStorageRoots: [join(temporaryRoot, ".zcode")],
        sessionStorageWarningStateRoot: join(temporaryRoot, ".ycode"),
      },
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext;
    const host = createSessionStorageWarningHost(context, {
      scanTimeoutMs: 0,
      beforeFilesystemOperation: () => new Promise(() => {}),
    });
    await assert.rejects(host.readSessionStorageUsage(ROOT_SESSION), /fault\.sessionStorage\.scanTimeout/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("v4 gateway routes usage reads and permanent dismissal through its owning host", async () => {
  const queried: string[] = [];
  const dismissed: string[] = [];
  const host = {
    readSessionStorageUsage: async (sessionId: string) => {
      queried.push(sessionId);
      return {
        sessionId,
        totalBytes: 128,
        categories: [{ categoryId: "commandOutputs" as const, bytes: 128, fileCount: 1 }],
        complete: true,
        errorCount: 0,
        dismissed: false,
      };
    },
    dismissSessionStorageWarning: async (sessionId: string) => {
      dismissed.push(sessionId);
    },
  } as unknown as V4GatewayHost;
  const gateway = new ConversationV4Gateway(host);
  try {
    const result = await gateway.sessionStorageUsage({ sessionId: "sess_remote" });
    assert.equal(result.sessionId, "sess_remote");
    assert.equal(result.totalBytes, 128);
    assert.deepEqual(queried, ["sess_remote"]);

    assert.deepEqual(await gateway.dismissStorageWarning({ sessionId: "sess_remote" }), {
      dismissed: true,
    });
    assert.deepEqual(dismissed, ["sess_remote"]);
    await assert.rejects(
      gateway.sessionStorageUsage({ sessionId: "sess_remote", path: "/tmp/anything" }),
    );
  } finally {
    gateway.dispose();
  }
});
