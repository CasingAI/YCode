import assert from "node:assert/strict";
import test from "node:test";
import { parseBotRosterSnapshot } from "../src/bots/botRosterPersistence.js";

test("脏 JSON 回退空名册", () => {
  const empty = parseBotRosterSnapshot("{not json");
  assert.equal(empty.bots.length, 0);
  assert.equal(parseBotRosterSnapshot(null).version, 1);
});
