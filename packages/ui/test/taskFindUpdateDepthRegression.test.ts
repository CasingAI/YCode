import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  changeTaskFindSelection,
  createTaskFindNavigationState,
  navigateTaskFindSelection,
} from "../src/quickpick/taskFindNavigationState.js";

test("查找回传同样的 query / activeIndex 时保留状态对象身份，避免 App 更新反馈环", () => {
  const initial = createTaskFindNavigationState();
  assert.equal(changeTaskFindSelection(initial, "", -1), initial);
  const found = changeTaskFindSelection(initial, "hello", 2);
  assert.notEqual(found, initial);
  assert.equal(changeTaskFindSelection(found, "hello", 2), found);
  assert.notEqual(changeTaskFindSelection(found, "hello", 1), found);
  assert.notEqual(changeTaskFindSelection(found, "new", 2), found);
});

test("重复导航即使命中项没变也必须刷新 navigationRequestId", () => {
  const initial = createTaskFindNavigationState();
  const selected = changeTaskFindSelection(initial, "hello", 0);
  const firstJump = navigateTaskFindSelection(selected, "hello", 0);
  const secondJump = navigateTaskFindSelection(firstJump, "hello", 0);
  assert.equal(firstJump.navigationRequestId, selected.navigationRequestId + 1);
  assert.equal(secondJump.navigationRequestId, firstJump.navigationRequestId + 1);
  assert.equal(changeTaskFindSelection(secondJump, "hello", 0), secondJump);
});

test("会话快照为空时 SessionPane 不向 ConversationTimeline 传入每轮新建的数组", () => {
  const source = readFileSync(new URL("../src/v4/SessionPane.tsx", import.meta.url), "utf8");
  assert.match(
    source,
    /const EMPTY_CONVERSATION_ROWS: ConversationSnapshot\["rows"\]\["window"\] = \[\];/,
  );
  assert.match(source, /rows=\{timelineSnapshot\?\.rows\.window \?\? EMPTY_CONVERSATION_ROWS\}/);
  assert.doesNotMatch(source, /rows=\{timelineSnapshot\?\.rows\.window \?\? \[\]\}/);
});
