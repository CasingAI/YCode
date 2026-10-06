import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const timelineSource = readFileSync(
  new URL("../src/v4/ConversationTimeline.tsx", import.meta.url),
  "utf8",
);

const COMPONENT = "ConversationTimelineJumpButton";
const ENTRY_TEST_IDS = ["TID_V4_TIMELINE_LOAD_NEWER", "TID_V4_TIMELINE_BOTTOM"] as const;

/**
 * 「回到最新」与「滚动到底部」曾经是两个入口、两种形态：后者早就抽成集中组件，前者后来
 * 新增时绕过组件内联成带可见文字的药丸钮，于是同一文件里出现第二套视觉基座。className 与
 * 可见文字都测不到纯逻辑，所以这里按仓库既有的源码断言写法钉住接线关系。
 */

/** 取共用组件自身的源码区间（定义，不含其后的调用点）。 */
function componentSource(): string {
  const start = timelineSource.indexOf(`function ${COMPONENT}(`);
  assert.notEqual(start, -1, `找不到共用组件：${COMPONENT}`);
  const end = timelineSource.indexOf("\ninterface ", start);
  assert.notEqual(end, -1, "共用组件之后没有 interface 边界，源码区间无法确定");
  return timelineSource.slice(start, end);
}

/**
 * 取某个 test id 的全部调用点源码。
 *
 * 以 testId 为锚点向两侧扩展，而不是用一个跨字段的长正则：非贪婪匹配会从上一个调用点的
 * 标签起跨过它、把下一个调用点吞进同一条结果里（dock 两个按钮相邻时必现），于是取到的
 * className 是隔壁按钮的，断言会指向错误的分支。
 */
function callSites(symbol: string): string[] {
  const sites: string[] = [];
  let from = 0;
  for (;;) {
    const at = timelineSource.indexOf(`testId={${symbol}}`, from);
    if (at === -1) return sites;
    const start = timelineSource.lastIndexOf(`<${COMPONENT}`, at);
    const end = timelineSource.indexOf("/>", at);
    assert.notEqual(start, -1, `${symbol} 不在共用组件的调用点上`);
    assert.notEqual(end, -1, `${symbol} 所在的调用点没有闭合`);
    sites.push(timelineSource.slice(start, end));
    from = end;
  }
}

/** 取某个 test id 的全部调用点 className。 */
function callSiteClassNames(symbol: string): string[] {
  return callSites(symbol).map((site) => site.match(/className="([^"]*)"/)?.[1] ?? "");
}

test("两个滚动入口共用同一个组件：每个 test id 恰好两处调用，全在组件上", () => {
  for (const symbol of ENTRY_TEST_IDS) {
    // composer dock 与无 dock 两个定位分支各一处；多出来就是又内联了一份视觉。
    assert.equal(callSites(symbol).length, 2, `${symbol} 的调用点数量变了`);
    assert.equal(
      timelineSource.split(`testId={${symbol}}`).length - 1,
      2,
      `${symbol} 出现在共用组件之外的位置`,
    );
  }
  // 旧组件名不得残留：它已被泛化，继续调用意味着有人按旧契约新写了分支。
  assert.equal(
    timelineSource.includes("ConversationBackToBottomButton"),
    false,
    "旧组件名 ConversationBackToBottomButton 仍有残留",
  );
});

test("共用组件内不得出现可见文字：文案只进 aria-label/title", () => {
  const body = componentSource();
  // label 只能作为无障碍名称出现。逐处点名属性名，再核对 `{label}` 总数——
  // 只查「属性名对不对」不够：把 label 顺手当文本渲染出来，药丸钮照样回来了，
  // 而属性名的断言全都会通过。
  assert.deepEqual(
    [...body.matchAll(/([\w-]+)=\{label\}/g)].map((match) => match[1]),
    ["aria-label", "title"],
    "label 只应绑定到 aria-label 与 title",
  );
  assert.equal(
    body.split("{label}").length - 1,
    2,
    "label 出现了无障碍名称之外的引用：渲染体里不允许有可见文字",
  );
  for (const labelId of ["chat.backToLatest", "chat.scrollToBottom"]) {
    assert.equal(
      body.includes(labelId),
      false,
      `组件内不应直接引用 ${labelId}，label 由调用方传入`,
    );
  }
  // 视觉基座内置在组件里，调用方无从覆盖形状。
  assert.match(body, /size="icon"/);
  assert.match(body, /variant="outline"/);
  assert.match(body, /rounded-full bg-card/);
  assert.match(body, /<Icon className="size-4" \/>/);
});

test("调用点 className 只剩定位类：形状、底色、阴影归组件基座", () => {
  for (const symbol of ENTRY_TEST_IDS) {
    for (const value of callSiteClassNames(symbol)) {
      assert.doesNotMatch(value, /shadow-/, `${symbol} 不该再自带 shadow`);
      assert.doesNotMatch(value, /rounded|bg-card/, `${symbol} 不该再带形状或底色`);
      assert.doesNotMatch(value, /whitespace-nowrap|gap-/, `${symbol} 不该再有药丸排版类`);
    }
  }
});

test("两个定位分支层叠一致：四处都带 z-30，dock 分支两个都恢复 pointer-events-auto", () => {
  const all = ENTRY_TEST_IDS.flatMap(callSiteClassNames);
  for (const value of all) {
    assert.match(value, /\bz-30\b/, `调用点缺 z-30：${value}`);
  }
  // dock 外壳是 pointer-events-none 的透明层，按钮必须显式恢复命中，否则点不动。
  for (const symbol of ENTRY_TEST_IDS) {
    const [inDock, outsideDock] = callSiteClassNames(symbol);
    assert.match(inDock, /pointer-events-auto/, `${symbol} 的 dock 分支缺 pointer-events-auto`);
    assert.match(inDock, /bottom-full/, `${symbol} 的 dock 分支应贴 dock 上沿`);
    assert.match(outsideDock, /bottom-3/, `${symbol} 的无 dock 分支应贴 pane 底边`);
    assert.doesNotMatch(
      outsideDock,
      /pointer-events-auto/,
      `${symbol} 的无 dock 分支不需要恢复命中`,
    );
  }
});
