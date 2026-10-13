import assert from "node:assert/strict";
import test from "node:test";
import {
  bindBotSession,
  emptyBotRosterSnapshot,
  filterBotsByName,
  hasVisibleBots,
  hideBot,
  insertCreatedBot,
  listedVisibleBots,
  pinBot,
  pinnedVisibleBots,
  reorderIds,
  reusableBotSessionId,
  setActiveBot,
  shouldHousekeepBot,
  unpinBot,
} from "../src/bots/botRosterLogic.js";
import { BOT_NONE_WORKSPACE, type BotRecord } from "../src/bots/botRosterTypes.js";

function bot(id: string, name = id): BotRecord {
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

test("创建后出现在列表，不在置顶", () => {
  const snapshot = insertCreatedBot(emptyBotRosterSnapshot(), bot("a", "Ada"));
  assert.equal(hasVisibleBots(snapshot), true);
  assert.deepEqual(
    listedVisibleBots(snapshot).map((item) => item.id),
    ["a"],
  );
  assert.deepEqual(pinnedVisibleBots(snapshot), []);
  assert.equal(snapshot.activeBotId, "a");
});

test("置顶最多三个，第四个失败且名册不变", () => {
  let snapshot = emptyBotRosterSnapshot();
  for (const id of ["a", "b", "c", "d"]) {
    snapshot = insertCreatedBot(snapshot, bot(id));
  }
  for (const id of ["a", "b", "c"]) {
    const pinned = pinBot(snapshot, id);
    assert.equal(pinned.ok, true);
    if (pinned.ok) {
      snapshot = pinned.snapshot;
    }
  }
  const overflow = pinBot(snapshot, "d");
  assert.equal(overflow.ok, false);
  if (!overflow.ok) {
    assert.equal(overflow.reason, "full");
  }
  assert.deepEqual(snapshot.pinOrder, ["a", "b", "c"]);
  assert.deepEqual(
    listedVisibleBots(snapshot).map((item) => item.id),
    ["d"],
  );
});

test("置顶与列表互斥；拖回列表恢复行", () => {
  let snapshot = insertCreatedBot(emptyBotRosterSnapshot(), bot("a"));
  const pinned = pinBot(snapshot, "a");
  assert.equal(pinned.ok, true);
  if (pinned.ok) {
    snapshot = pinned.snapshot;
  }
  assert.equal(listedVisibleBots(snapshot).length, 0);
  snapshot = unpinBot(snapshot, "a");
  assert.deepEqual(
    listedVisibleBots(snapshot).map((item) => item.id),
    ["a"],
  );
});

test("隐藏不是真删：记录仍在，名册与置顶不再出现", () => {
  let snapshot = insertCreatedBot(emptyBotRosterSnapshot(), bot("a"));
  const pinned = pinBot(snapshot, "a");
  if (pinned.ok) {
    snapshot = pinned.snapshot;
  }
  snapshot = hideBot(snapshot, "a");
  assert.equal(hasVisibleBots(snapshot), false);
  assert.equal(snapshot.bots[0]?.hidden, true);
  assert.deepEqual(snapshot.pinOrder, []);
  assert.equal(snapshot.activeBotId, undefined);
});

test("打开某人即清未读；按名搜索", () => {
  let snapshot = insertCreatedBot(emptyBotRosterSnapshot(), {
    ...bot("a", "Ada"),
    unread: true,
  });
  snapshot = insertCreatedBot(snapshot, bot("b", "Ben"));
  snapshot = setActiveBot(snapshot, "a");
  assert.equal(snapshot.bots.find((item) => item.id === "a")?.unread, false);
  assert.deepEqual(
    filterBotsByName(snapshot.bots, "be").map((item) => item.id),
    ["b"],
  );
});

test("置顶区内换序", () => {
  assert.deepEqual(reorderIds(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
});

test("闲置家务只在有会话、未占线、超过空闲窗口时触发", () => {
  const idle = { ...bot("a"), sessionId: "sess_botsess_1", working: false, hidden: false, updatedAt: 1 };
  assert.equal(shouldHousekeepBot(idle, 1 + 15 * 60 * 1000), true);
  assert.equal(shouldHousekeepBot({ ...idle, working: true }, 1 + 15 * 60 * 1000), false);
  assert.equal(shouldHousekeepBot({ ...idle, sessionId: undefined }, 1 + 15 * 60 * 1000), false);
  assert.equal(shouldHousekeepBot({ ...idle, sessionId: "sess_ordinary" }, 1 + 15 * 60 * 1000), false);
});

test("名册只绑定岗位会话 id，普通任务会话 id 丢掉", () => {
  assert.equal(reusableBotSessionId("sess_botsess_abc"), "sess_botsess_abc");
  assert.equal(reusableBotSessionId("sess_ordinary"), undefined);
  assert.equal(reusableBotSessionId(undefined), undefined);
  let snapshot = insertCreatedBot(emptyBotRosterSnapshot(), bot("a", "Ada"));
  snapshot = bindBotSession(snapshot, "a", "sess_ordinary");
  assert.equal(snapshot.bots[0]?.sessionId, undefined);
  snapshot = bindBotSession(snapshot, "a", "sess_botsess_abc");
  assert.equal(snapshot.bots[0]?.sessionId, "sess_botsess_abc");
});

test("闲置家务只在有会话、未占线、超过空闲窗口时触发", () => {
  const idle = { ...bot("a"), sessionId: "sess_botsess_1", working: false, hidden: false, updatedAt: 1 };
  assert.equal(shouldHousekeepBot(idle, 1 + 15 * 60 * 1000), true);
  assert.equal(shouldHousekeepBot({ ...idle, working: true }, 1 + 15 * 60 * 1000), false);
  assert.equal(shouldHousekeepBot({ ...idle, sessionId: undefined }, 1 + 15 * 60 * 1000), false);
  assert.equal(shouldHousekeepBot({ ...idle, sessionId: "sess_ordinary" }, 1 + 15 * 60 * 1000), false);
});

test("名册只绑定岗位会话 id，普通任务会话 id 丢掉", () => {
  assert.equal(reusableBotSessionId("sess_botsess_abc"), "sess_botsess_abc");
  assert.equal(reusableBotSessionId("sess_ordinary"), undefined);
  assert.equal(reusableBotSessionId(undefined), undefined);
  let snapshot = insertCreatedBot(emptyBotRosterSnapshot(), bot("a", "Ada"));
  snapshot = bindBotSession(snapshot, "a", "sess_ordinary");
  assert.equal(snapshot.bots[0]?.sessionId, undefined);
  snapshot = bindBotSession(snapshot, "a", "sess_botsess_abc");
  assert.equal(snapshot.bots[0]?.sessionId, "sess_botsess_abc");
});
