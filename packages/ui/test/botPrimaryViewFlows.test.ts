import assert from "node:assert/strict";
import test from "node:test";
import { botNotesDisplayPath } from "@zcode/shared";
import {
  emptyBotRosterSnapshot,
  hasVisibleBots,
  hideBot,
  insertCreatedBot,
  listedVisibleBots,
  pinBot,
  pinnedVisibleBots,
  unpinBot,
} from "../src/bots/botRosterLogic.js";
import { BOT_NONE_WORKSPACE, type BotRecord } from "../src/bots/botRosterTypes.js";
import { BOTS_TAB_ID, resolveWorkspaceShellPrimaryView } from "../src/store/tabStore.js";
import { parseWebRoute } from "../src/lib/webRoute.js";

function person(id: string, name = id): BotRecord {
  return {
    id,
    name,
    emoji: "🤖",
    background: "hi",
    workspaceKey: BOT_NONE_WORKSPACE,
    hideComposerModelPicker: true,
    hidden: false,
    createdAt: 1,
    updatedAt: 1,
    working: false,
    unread: false,
  };
}

test("底栏 Bot 档与 Web 地址对齐", () => {
  assert.equal(
    resolveWorkspaceShellPrimaryView({ id: BOTS_TAB_ID, kind: "bots", label: "bots" }),
    "bots",
  );
  assert.deepEqual(parseWebRoute("/bots"), { kind: "bots" });
  assert.deepEqual(parseWebRoute("/bots/bot_a"), { kind: "bots", botId: "bot_a" });
});

test("创建、置顶互斥、第四个弹回、隐藏不是真删", () => {
  let snapshot = insertCreatedBot(emptyBotRosterSnapshot(), person("a", "Ada"));
  snapshot = insertCreatedBot(snapshot, person("b", "Bea"));
  snapshot = insertCreatedBot(snapshot, person("c", "Cara"));
  snapshot = insertCreatedBot(snapshot, person("d", "Dee"));
  const pinA = pinBot(snapshot, "a");
  assert.equal(pinA.ok, true);
  snapshot = pinA.ok ? pinA.snapshot : snapshot;
  const pinB = pinBot(snapshot, "b");
  snapshot = pinB.ok ? pinB.snapshot : snapshot;
  const pinC = pinBot(snapshot, "c");
  snapshot = pinC.ok ? pinC.snapshot : snapshot;
  const fourth = pinBot(snapshot, "d");
  assert.equal(fourth.ok, false);
  if (fourth.ok) {
    return;
  }
  assert.equal(fourth.reason, "full");
  assert.deepEqual(
    pinnedVisibleBots(snapshot).map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    listedVisibleBots(snapshot).map((item) => item.id),
    ["d"],
  );
  snapshot = unpinBot(snapshot, "a");
  snapshot = hideBot(snapshot, "d");
  assert.equal(hasVisibleBots(snapshot), true);
  assert.equal(snapshot.bots.some((item) => item.id === "d" && item.hidden), true);
  assert.equal(
    listedVisibleBots(snapshot).some((item) => item.id === "d"),
    false,
  );
});

test("笔记路径按人落在用户数据目录", () => {
  assert.equal(botNotesDisplayPath("bot_a"), "~/.zcode/bots/bot_a/memory.md");
});
