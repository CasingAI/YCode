import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveBotNotesAbsolutePath } from "../src/tool/handlers/bot-memory.js";

test("岗位笔记落在用户数据目录按人一份", () => {
  const previousHome = process.env.ZCODE_HOME;
  const previousBase = process.env.ZCODE_DATA_BASE_DIR;
  delete process.env.ZCODE_HOME;
  delete process.env.ZCODE_DATA_BASE_DIR;
  try {
    assert.equal(resolveBotNotesAbsolutePath("bot_a"), join(homedir(), ".zcode", "bots", "bot_a", "memory.md"));
  } finally {
    if (previousHome !== undefined) {
      process.env.ZCODE_HOME = previousHome;
    }
    if (previousBase !== undefined) {
      process.env.ZCODE_DATA_BASE_DIR = previousBase;
    }
  }
});
