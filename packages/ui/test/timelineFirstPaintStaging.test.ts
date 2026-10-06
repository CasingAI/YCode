import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

/**
 * 首绘 staging 管线的接线断言（docs/specs/conversation-timeline-turn-window-fill.md）。
 *
 * 这条管线的判据都落在组件里，行为测试要整套 DOM + store 才能跑；真正会咬人的又是接线
 * 本身——某一处忘了把虚拟列表置空，用户就会看到半截；忘了让 prepend 锚定让位，落点会
 * 被钉在暗处那一帧的坐标上。两条都是「代码读起来对、跑起来错」的缺陷，用源码断言钉住。
 */

test("暗处那一帧先算行再算单元：跨边界那一轮必须是完整一轮", () => {
  // 拼「补齐缓冲的轮 + 窗口的轮」两份单元，边界轮会被量两次、每次都是半截高度；
  // 拼行再一次性建帧，边界轮才是提交后窗口里那个完整高度，turn key 也逐一对应。
  assert.match(
    timelineSource,
    /const firstPaintRows = useMemo\(\(\) => \{[\s\S]*?return \[\.\.\.pendingOlderRows, \.\.\.rows\];/,
    "首绘帧必须由 [补齐缓冲行, 窗口行] 合成",
  );
  assert.match(
    timelineSource,
    /const firstPaintStagedUnits = useMemo\(\(\) => \{[\s\S]*?buildConversationTurnRenderUnitFrame\(firstPaintRows,/,
    "首绘帧必须用合成后的行一次建帧",
  );
});

test("staging 期间可见区为空：虚拟列表、live tail 与前插块容器同时置空", () => {
  // 三处任意一处漏掉，用户就会在补齐期间看到内容——那正是「先画半截」的产品缺陷。
  assert.match(
    timelineSource,
    /const \{ virtualizedUnits, liveUnit, liveUnitIndex \} = useMemo\(\(\) => \{\s*if \(stagingActive\) \{\s*return \{\s*virtualizedUnits: EMPTY_TURN_UNITS,\s*liveUnit: null,\s*liveUnitIndex: null,/,
    "staging 期间虚拟列表与 live tail 必须同时置空",
  );
  assert.match(
    timelineSource,
    /const blockUnitCount = stagingActive\s*\?\s*0\s*:/,
    "staging 期间前插块容器必须为空：同一批轮出现在两个容器里会撞 key",
  );
});

test("暗处量到的每一轮都写进测高缓存，屏外那一屏因此不为 0", () => {
  // 不写缓存的后果只发生在屏外：挂载后虚拟列表按 estimateSize 记这些轮的高度，
  // 量过的值被丢掉就只能用估算补，尾巴会在挂载那一帧动。
  assert.match(
    timelineSource,
    /const turnKey = child\.getAttribute\("data-staged-turn-key"\);[\s\S]*?heightCacheRef\.current\?\.set\(turnKey, height\);/,
    "暗处逐轮实测高度必须写入测高缓存",
  );
  assert.match(
    timelineSource,
    /if \(turnKey !== null && height > 0\)/,
    "缓存只收非零高度，零高度必须被拒",
  );
});

test("首绘挂载帧对 prepend 锚定免补偿：落点由跟随态决定", () => {
  assert.match(
    timelineSource,
    /initialMountCommitRef\.current = true;\s*setFirstPaintMount\(\{/,
    "挂载必须先立标记再记窗口，否则下一帧的 prepend effect 已经跑完了",
  );
  assert.match(
    timelineSource,
    /if \(initialMountCommitRef\.current\) \{[\s\S]*?prependAnchorRef\.current = \{ firstRowId: nextFirstRowId, totalSize: nextTotalSize \};\s*return;/,
    "prepend effect 必须在首绘挂载帧整段让位，只对齐基线不写 scrollTop",
  );
});

test("staging 期间两条预取与滚动记忆恢复都不放行", () => {
  const prefetchNewer = timelineSource.indexOf("const maybePrefetchNewer");
  assert.notEqual(prefetchNewer, -1);
  assert.match(
    timelineSource.slice(prefetchNewer, prefetchNewer + 400),
    /if \(stagingActiveRef\.current\) return;/,
    "向下预取在 staging 期间必须让位",
  );
  const prefetchOlder = timelineSource.indexOf("const maybePrefetchOlder");
  assert.notEqual(prefetchOlder, -1);
  assert.match(
    timelineSource.slice(prefetchOlder, prefetchOlder + 900),
    /if \(stagingActiveRef\.current\) return;/,
    "向上预取在 staging 期间必须让位：补齐由首绘管线自己驱动",
  );
  assert.match(
    timelineSource,
    /if \(stagingActiveRef\.current\) \{\s*\/\/[\s\S]*?pendingScrollMemoryReplayRef\.current = state;\s*return;/,
    "滚动记忆在 staging 期间写入会被钳成 0，必须挂起并在挂载后重放",
  );
  assert.match(
    timelineSource,
    /if \(stagingActiveRef\.current\) \{\s*\/\/[\s\S]*?pendingQueryTargetRef\.current = target;\s*return;/,
    "query 定位在 staging 期间写不进可滚的流，必须记下并在挂载后重放",
  );
});

test("实测高度按窗口身份记账：换代不继承旧窗口的测量结果", () => {
  // 裸数值高度在换代后的第一次补齐判定就会读到旧窗口的实测值，新窗口看似
  // 「已够一屏」而跳过补齐直接挂载。与 firstPaintMount / firstPaintFillDeadline
  // 同一套身份记账：写入带身份，判定校验身份，不匹配按 0（未排版）处理。
  assert.match(
    timelineSource,
    /const \[firstPaintStagedHeight, setFirstPaintStagedHeight\] = useState<\{\s*sessionKey: string;\s*windowEpoch: number;\s*heightPx: number;\s*\} \| null>\(null\);/,
    "高度 state 必须携带窗口身份",
  );
  assert.match(
    timelineSource,
    /firstPaintStagedHeight\.sessionKey === sessionKey &&\s*firstPaintStagedHeight\.windowEpoch === windowEpoch\s*\?\s*firstPaintStagedHeight\.heightPx\s*:\s*0;/,
    "补齐判定必须校验身份，不匹配按 0 处理",
  );
});

test("帧基线按窗口身份就地作废：换代后第一次暗处建帧不得 diff 旧窗口", () => {
  // 建帧跑在渲染期（memo 里读 previousFrame），effect 里清 ref 晚一拍，所以守卫
  // 必须在读出处之前就地比对身份并作废两个帧基线。
  assert.match(
    timelineSource,
    /stagedFrameOwnerRef\.current = \{ sessionKey, windowEpoch \};\s*firstPaintFrameRef\.current = undefined;\s*pendingMeasureFrameRef\.current = undefined;/,
    "换代必须先作废首绘帧与前插帧基线，再进 memo 建帧",
  );
});

test("staging 期间不建前插块的帧：暗处中间态不得写进 pendingMeasureFrameRef", () => {
  const memoStart = timelineSource.indexOf("const stagedPrependUnits = useMemo(");
  assert.notEqual(memoStart, -1, "找不到 stagedPrependUnits memo");
  const depsStart = timelineSource.indexOf("}, [", memoStart);
  assert.notEqual(depsStart, -1);
  const memoBody = timelineSource.slice(memoStart, depsStart);
  assert.match(
    memoBody,
    /if \(stagingActive \|\| stagedPageSplit\.blockRows\.length === 0\) return EMPTY_TURN_UNITS;/,
    "staging 期间必须先于建帧早退，块容器此刻是空的",
  );
  const depsEnd = timelineSource.indexOf("]);", depsStart);
  assert.notEqual(depsEnd, -1);
  const deps = timelineSource.slice(depsStart + 4, depsEnd);
  assert.ok(
    deps.includes("stagingActive"),
    `stagingActive 翻假后必须重新求值补上帧，实际依赖：${JSON.stringify(deps)}`,
  );
});

test("测量 effect 里视口高度同步先于暗处容器判空：容器缺席不减尺", () => {
  const viewportSync = timelineSource.indexOf("setFirstPaintViewportHeightPx((current) =>");
  const containerCheck = timelineSource.indexOf("const container = firstPaintStagingRef.current;");
  assert.notEqual(viewportSync, -1, "找不到视口高度同步");
  assert.notEqual(containerCheck, -1, "找不到暗处容器判空");
  assert.ok(
    viewportSync < containerCheck,
    "视口同步必须先于容器判空：scrollRef 不依赖暗处容器，跳过同步会让补齐判定拿 0 当尺子",
  );
});
