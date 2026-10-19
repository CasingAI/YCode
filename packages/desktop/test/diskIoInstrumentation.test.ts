import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyDiskIoModule, installNodeDiskIoInstrumentation } from "@zcode/shared/node";

test("文件与 SQLite 边界产生内存指标，不泄露路径或 SQL 文本", async () => {
  const filePath = path.join(os.tmpdir(), `ycode-disk-io-${randomUUID()}.log`);
  const streamPath = path.join(os.tmpdir(), `ycode-disk-io-stream-${randomUUID()}.txt`);
  const descriptorPath = path.join(os.tmpdir(), `ycode-disk-io-fd-${randomUUID()}.txt`);
  const sqlSecret = "private-sql-value-must-not-be-recorded";
  const instrumentation = installNodeDiskIoInstrumentation({ intervalMs: 60_000, onBatch: () => {} });
  const database = new DatabaseSync(":memory:");
  try {
    fs.writeFileSync(filePath, "hello");
    assert.equal(fs.readFileSync(filePath, "utf8"), "hello");
    await fsPromises.appendFile(filePath, " world");
    assert.equal(await fsPromises.readFile(filePath, "utf8"), "hello world");
    await new Promise<void>((resolve, reject) => {
      fs.appendFile(filePath, " callback", (error) => (error ? reject(error) : resolve()));
    });
    const callbackRead = await new Promise<string>((resolve, reject) => {
      fs.readFile(filePath, "utf8", (error, value) =>
        error ? reject(error) : resolve(String(value)),
      );
    });
    assert.equal(callbackRead, "hello world callback");
    fs.appendFileSync(filePath, "!");

    const writeStream = fs.createWriteStream(streamPath);
    const writeFinished = once(writeStream, "finish");
    writeStream.end("stream payload");
    await writeFinished;
    const readStream = fs.createReadStream(streamPath);
    let streamedText = "";
    for await (const chunk of readStream) streamedText += chunk.toString();
    assert.equal(streamedText, "stream payload");

    const fd = fs.openSync(descriptorPath, "w+");
    fs.writeSync(fd, "descriptor");
    const descriptorBuffer = Buffer.alloc(Buffer.byteLength("descriptor"));
    const descriptorBytesRead = fs.readSync(fd, descriptorBuffer, 0, descriptorBuffer.length, 0);
    fs.closeSync(fd);
    assert.equal(descriptorBuffer.subarray(0, descriptorBytesRead).toString(), "descriptor");

    // A stream constructed around an existing fd never emits "open". It must not
    // count both the stream and its underlying fs.read/fs.write calls.
    const suppliedWriteFd = fs.openSync(descriptorPath, "w");
    const suppliedWriteStream = fs.createWriteStream(null, { fd: suppliedWriteFd, autoClose: false });
    const suppliedWriteFinished = once(suppliedWriteStream, "finish");
    suppliedWriteStream.end("four");
    await suppliedWriteFinished;
    fs.closeSync(suppliedWriteFd);

    const suppliedReadFd = fs.openSync(descriptorPath, "r");
    const suppliedReadStream = fs.createReadStream(null, { fd: suppliedReadFd, autoClose: false });
    let suppliedReadText = "";
    for await (const chunk of suppliedReadStream) suppliedReadText += chunk.toString();
    fs.closeSync(suppliedReadFd);
    assert.equal(suppliedReadText, "four");

    assert.throws(
      () => fs.appendFileSync(path.join(os.tmpdir(), `missing-${randomUUID()}`, "failed.log"), "drop"),
      { code: "ENOENT" },
    );

    database.exec("CREATE TABLE sample (value TEXT)");
    database.prepare("INSERT INTO sample VALUES (?)").run(sqlSecret);
    assert.equal(database.prepare("SELECT value FROM sample").get()?.value, sqlSecret);

    const batch = instrumentation.flush();
    const logging = batch.groups.find((group) => group.module === "logging");
    const sqlite = batch.groups.find((group) => group.module === "sqlite");
    assert.ok(logging);
    assert.equal(logging.metrics.writeOperations, 5);
    assert.equal(logging.metrics.readOperations, 3);
    assert.equal(logging.metrics.writeBytes, Buffer.byteLength("hello world callback!"));
    assert.equal(
      logging.metrics.readBytes,
      Buffer.byteLength("hello") + Buffer.byteLength("hello world") + Buffer.byteLength("hello world callback"),
    );
    assert.equal(logging.metrics.failedWriteOperations, 1, "日志路径的写入失败会进入失败计数");
    assert.equal(sqlite?.metrics.databaseOperations, 3);
    const filesystem = batch.groups.find((group) => group.module === "filesystem");
    assert.equal(filesystem?.metrics.writeOperations, 3);
    assert.equal(filesystem?.metrics.readOperations, 3);
    assert.equal(
      filesystem?.metrics.writeBytes,
      Buffer.byteLength("stream payload") + Buffer.byteLength("descriptor") + Buffer.byteLength("four"),
    );
    assert.equal(
      filesystem?.metrics.readBytes,
      Buffer.byteLength("stream payload") + Buffer.byteLength("descriptor") + Buffer.byteLength("four"),
    );
    assert.ok(!JSON.stringify(batch).includes(filePath));
    assert.ok(!JSON.stringify(batch).includes(streamPath));
    assert.ok(!JSON.stringify(batch).includes(descriptorPath));
    assert.ok(!JSON.stringify(batch).includes(sqlSecret));
    assert.equal(classifyDiskIoModule("/tmp/logs/ycode.log"), "logging");
    assert.equal(classifyDiskIoModule("/home/user/.zcode/cli/log/zcode-2026-10-18.jsonl"), "logging");
    assert.equal(classifyDiskIoModule("/workspace/sessions/session.jsonl"), "session");
    assert.equal(classifyDiskIoModule("/tmp/state.sqlite"), "sqlite");
  } finally {
    database.close();
    instrumentation.stop({ flushFinal: false });
    fs.rmSync(filePath, { force: true });
    fs.rmSync(streamPath, { force: true });
    fs.rmSync(descriptorPath, { force: true });
  }
});
