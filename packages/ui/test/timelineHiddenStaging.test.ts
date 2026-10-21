import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HIDDEN_TIMELINE_STAGING_CLASS_NAME } from "../src/v4/timelineHiddenStaging.js";

/**
 * 暗处暂存区的定位契约（docs/specs/conversation-timeline-prepend-blocks.md 第 3/3b/3c 条）。
 *
 * 缺陷本身：暗处容器用固定负偏移（`top: -10000px`）移出可视区。内容比偏移量更高时
 * （超长回合在窄屏上很常见），下半截落回容器上沿以下——画进可见区盖住真实消息，用户
 * 看到的是「加载很久时消息重叠错位」；同时向下溢出会污染滚动几何。
 *
 * 契约：定位由 CSS 按内容高度自算（底边对齐容器上沿，内容向上延伸），隐藏从首次挂载
 * 就生效（保留布局与真实高度，只是不绘制）。本包没有 DOM 渲染环境，契约以类名 token
 * 与源码接线断言覆盖。
 */

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

const stagingTokens = HIDDEN_TIMELINE_STAGING_CLASS_NAME.split(/\s+/).filter(Boolean);

test("定位契约：绝对定位 + 底边对齐容器上沿，内容向上延伸", () => {
  assert.ok(
    stagingTokens.includes("absolute"),
    "脱离文档流才有 bottom：否则暗处内容会进流，把高度算进容器",
  );
  assert.ok(
    stagingTokens.includes("bottom-full"),
    "底边必须恒在容器上沿（bottom: 100%）：内容越长往上延伸越多，无需提前知道高度",
  );
});

test("隐藏契约：保留布局与真实高度，但不绘制", () => {
  assert.ok(
    stagingTokens.includes("invisible"),
    "必须用 visibility: hidden：它保留布局与真实高度，getBoundingClientRect 仍返回真盒",
  );
  assert.ok(!stagingTokens.includes("hidden"), "不能用 display:none：高度归零，暗处实测直接失效");
});

test("时间线源码不再有固定负偏移", () => {
  assert.doesNotMatch(
    timelineSource,
    /top:\s*-\d+/,
    "固定负偏移在内容超过偏移量时会让下半截落回可见区，并向下溢出污染滚动几何",
  );
});

test("两处暗处容器共用同一份定位契约", () => {
  const usages = timelineSource.split("HIDDEN_TIMELINE_STAGING_CLASS_NAME").length - 1;
  assert.ok(
    usages >= 3,
    `预期「1 次导入 + 2 处使用」，实际 ${usages} 次：一处漏改就会单独复现重叠错位`,
  );
  assert.match(
    timelineSource,
    /data-v4-timeline-first-paint-staging="true"[\s\S]{0,400}HIDDEN_TIMELINE_STAGING_CLASS_NAME/,
    "首绘 staging 区必须走暗处定位契约",
  );
  assert.match(
    timelineSource,
    /data-staged-turn=\{staged \? "true" : undefined\}[\s\S]{0,900}HIDDEN_TIMELINE_STAGING_CLASS_NAME/,
    "前插块 staged wrapper 必须走暗处定位契约",
  );
});

test("翻转成 committed 后不得残留隐藏类", () => {
  const start = timelineSource.indexOf('data-staged-turn={staged ? "true" : undefined}');
  assert.notEqual(start, -1, "找不到前插块 staged wrapper");
  const end = timelineSource.indexOf("<ConversationTurnGroup", start);
  assert.notEqual(end, -1, "找不到 staged wrapper 的渲染体");
  const wrapper = timelineSource.slice(start, end);
  const committedBranch = wrapper.slice(wrapper.indexOf(': "w-full"'));
  assert.ok(wrapper.includes("HIDDEN_TIMELINE_STAGING_CLASS_NAME"), "staged 态必须带定位契约");
  assert.ok(
    !committedBranch.includes("HIDDEN_TIMELINE_STAGING_CLASS_NAME"),
    "committed 态不得带隐藏类：翻转那一刻内容必须可见",
  );
});

test("暗处实测仍然存在：修重叠不得改成不量高度", () => {
  // 暗处那一帧量到的高度就是挂载时虚拟列表记账用的高度。绕开暗处（先渲染再搬）
  // 会把「一次就位」打回「先画半截」，也不解决重叠——重叠只靠定位与隐藏解决。
  assert.match(
    timelineSource,
    /const turnKey = child\.getAttribute\("data-staged-turn-key"\);[\s\S]*?getBoundingClientRect\(\)\.height/,
    "首绘暗处必须逐轮实测高度",
  );
  assert.match(
    timelineSource,
    /child\.getAttribute\("data-staged-turn"\) === null\) continue;\s*stagedHeightPx \+= Math\.round\(child\.getBoundingClientRect\(\)\.height\);/,
    "前插块 staged 必须逐轮实测高度",
  );
});
