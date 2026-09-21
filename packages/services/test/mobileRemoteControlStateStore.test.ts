import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFileMobileRemoteControlStateStore } from "@zcode/services/node";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zcode-mobile-state-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("mobile remote control state store", () => {
  it("写盘后可读回，端口与 token 原样保留", async () => {
    const filePath = join(dir, "round-trip.json");
    const store = createFileMobileRemoteControlStateStore(filePath);

    await store.write({ enabled: true, port: 39321, token: "fixed-token" });

    assert.deepEqual(await store.read(), {
      enabled: true,
      port: 39321,
      token: "fixed-token",
    });
    // 落盘格式带 version，便于以后迁移。
    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    assert.equal(raw.version, 1);
  });

  it("文件不存在等价于从未开启", async () => {
    const store = createFileMobileRemoteControlStateStore(join(dir, "missing.json"));
    assert.equal(await store.read(), null);
  });

  it("文件损坏或字段非法都按从未开启处理，不抛错", async () => {
    const brokenPath = join(dir, "broken.json");
    await writeFile(brokenPath, "{ not json");
    assert.equal(await createFileMobileRemoteControlStateStore(brokenPath).read(), null);

    const invalidPortPath = join(dir, "invalid-port.json");
    await writeFile(
      invalidPortPath,
      JSON.stringify({ version: 1, enabled: true, port: "not-a-number" }),
    );
    assert.equal(await createFileMobileRemoteControlStateStore(invalidPortPath).read(), null);
  });

  it("连续写盘串行执行，最后一次生效", async () => {
    const filePath = join(dir, "serialized.json");
    const store = createFileMobileRemoteControlStateStore(filePath);

    // 用户连点开启/重置时两次写盘可能相邻发生，落盘结果必须是最后一次的意图。
    await Promise.all([
      store.write({ enabled: true, port: 40001, token: "first" }),
      store.write({ enabled: false, port: 40001, token: "second" }),
    ]);

    assert.deepEqual(await store.read(), { enabled: false, port: 40001, token: "second" });
  });

  it("停止后仍保留端口与 token", async () => {
    const filePath = join(dir, "stopped.json");
    const store = createFileMobileRemoteControlStateStore(filePath);

    await store.write({ enabled: true, port: 41000, token: "keep-me" });
    await store.write({ enabled: false, port: 41000, token: "keep-me" });

    assert.deepEqual(await store.read(), { enabled: false, port: 41000, token: "keep-me" });
  });
});
