import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

const CANCEL_ANCHOR = "prependCommitGateRef.current?.cancel()";

/**
 * 取锚点所在 effect 的依赖数组文本。
 *
 * 这条缺陷在两套 effect 的**依赖集合失联**上，纯逻辑层测不到：闸门丢掉请求的行为本身
 * 没错（cancel 的语义就是丢弃），错的是「丢弃它的 effect」和「重新挂上它的 effect」
 * 监听的不是同一组依赖。所以这里按仓库既有的源码断言写法钉住接线关系。
 */
function depsAfter(anchor: string, from = 0): string[] {
  const start = timelineSource.indexOf(anchor, from);
  assert.notEqual(start, -1, `找不到锚点：${anchor}`);
  const depsStart = timelineSource.indexOf("}, [", start);
  assert.notEqual(depsStart, -1, `${anchor} 所在 effect 没有依赖数组`);
  const depsEnd = timelineSource.indexOf("]);", depsStart);
  assert.notEqual(depsEnd, -1, `${anchor} 的依赖数组没有闭合`);
  return timelineSource
    .slice(depsStart + 4, depsEnd)
    .replace(/^\[/, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

test("重新求值 effect 必须监听 windowEpoch：换代不改前四项，漏掉就没有人补挂请求", () => {
  // 放行条件并入填充条件后第一参数成了多行表达式，锚点只取调用头。
  const deps = depsAfter("gate.request(");
  assert.ok(deps.includes("windowEpoch"), `换代必须重新求值，实际依赖：${JSON.stringify(deps)}`);
  assert.ok(deps.includes("hasPendingOlder"), "缓冲状态变化仍要重新求值");
  // staging 期间 pendingOlder 是首绘补齐事务，不是「用户上滚到顶要前插」：那批行由
  // runFirstPaintMount 落窗口，既不走闸门也不登记 committed turn id。
  assert.ok(
    deps.includes("stagingActive"),
    `staging 切换必须重新求值，实际依赖：${JSON.stringify(deps)}`,
  );
  // 填充条件并入闸门（turn-window-fill 规则 11）：高度测量与中断信号变化必须重新求值，
  // 否则填充完成后没人补挂请求，占位块与滚动锁挂在已就绪的缓冲上永不解除。
  assert.ok(deps.includes("prependFillStagedHeightPx"), "staged 实测高度变化必须重新求值");
  assert.ok(deps.includes("olderFillInterruptedSeq"), "中断信号必须重新求值");
});

test("作废待提交请求只属于换会话：每个 cancel 调用点都不得挂在换窗依赖上", () => {
  // 逐个调用点检查而不是只看第一个：把 cancel 挪进换窗复位 effect 后，调用点数量与
  // 顺序都会变，只认第一个锚点会漏判。锚点含 `?`，只能用字符串查找而非正则。
  const offsets: number[] = [];
  for (
    let index = timelineSource.indexOf(CANCEL_ANCHOR);
    index !== -1;
    index = timelineSource.indexOf(CANCEL_ANCHOR, index + CANCEL_ANCHOR.length)
  ) {
    offsets.push(index);
  }
  assert.ok(offsets.length > 0, "找不到作废请求的调用点");
  for (const start of offsets) {
    const deps = depsAfter(CANCEL_ANCHOR, start);
    assert.ok(
      deps.includes("sessionKey"),
      `作废请求必须由换会话驱动，实际依赖：${JSON.stringify(deps)}`,
    );
    assert.equal(
      deps.includes("windowEpoch"),
      false,
      `作废请求挂上换窗会在换代时丢掉待提交请求且无人补挂，实际依赖：${JSON.stringify(deps)}`,
    );
  }
});
