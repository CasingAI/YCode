import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pane = readFileSync(new URL("../src/v4/SessionPane.tsx", import.meta.url), "utf8");

test("Fork 命令拒绝或提交异常时显示本地化错误提示", () => {
  const forkHandler = pane.slice(pane.indexOf("const handleFork = useCallback("), pane.indexOf("const handleEdit = useCallback("));

  assert.match(forkHandler, /chat\.message\.fork\.failed/);
  assert.match(forkHandler, /\.catch\(\(error: unknown\)/);
  assert.match(forkHandler, /logger\.warn\("\[v4-pane\] fork 提交失败"/);
  assert.match(forkHandler, /ack\.reasonCode \?\? ack\.status/);
});

test("Fork 失败不会导航，成功结果才切换到子会话", () => {
  const forkHandler = pane.slice(pane.indexOf("const handleFork = useCallback("), pane.indexOf("const handleEdit = useCallback("));
  const rejectBranch = forkHandler.indexOf("ack.status !== \"accepted\"");
  const navigation = forkHandler.indexOf("onSessionCreated?.(ack.result.sessionId)");

  assert.notEqual(rejectBranch, -1);
  assert.notEqual(navigation, -1);
  assert.ok(rejectBranch < navigation);
  assert.match(forkHandler, /ack\.result\?\.type === "forkAssistant"/);
});
