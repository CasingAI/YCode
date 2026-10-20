import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 接线断言：纯函数的行为已在 composerAutoFocus.test.ts 覆盖，这里检查真实组件
// 的接线没有把保护再绕回去。
//
// 回归背景：移动端「跳过自动聚焦」曾经是死代码——`focusOptsRef` 把
// `isMobileViewport` 写死为 false，手机端在挂载 / 切会话时就把 DOM 焦点抢到
// contenteditable 上，软键盘随之弹出遮挡界面。判定逻辑本身没错，错的是入参；
// 单测纯函数无法发现入参被写死，所以这里读源码接线。

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

const composerSource = await readSource("../src/v4/ConversationComposer.tsx");
const timelineSource = await readSource("../src/v4/ConversationTimeline.tsx");
const fileSummarySource = await readSource("../src/v4/ConversationFileSummaryPanel.tsx");

/** 收集 AST 里所有 JSX 属性名，用于判断某个属性是否出现在该文件中。 */
function collectJsxAttributeNames(source: string): Set<string> {
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node)) {
      names.add(node.name.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** 收集源码里所有出现的标识符文本，用于粗粒度断言某个符号被引用。 */
function countIdentifierOccurrences(source: string, identifier: string): number {
  const file = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === identifier) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

test("composer 不再把 isMobileViewport 写死为 false", () => {
  // 写死的 `isMobileViewport: false` 会让 resolveComposerAutoFocus 的移动端跳过
  // 分支永远不可达——这正是回归的根因。
  assert.equal(
    /isMobileViewport:\s*false/.test(composerSource),
    false,
    "ConversationComposer 仍把 isMobileViewport 写死为 false，移动端跳过聚焦的保护已失效",
  );
});

test("composer 的移动端判定来自 isCoarseTouchDevice", () => {
  assert.ok(
    /isMobileViewport:\s*isCoarseTouchDevice\(\)/.test(composerSource),
    "ConversationComposer 的 isMobileViewport 没有接上 isCoarseTouchDevice()",
  );
});

test("composer 引入了用户驱动的显式聚焦通道", () => {
  assert.ok(
    countIdentifierOccurrences(composerSource, "requestComposerFocusExplicit") >= 4,
    "requestComposerFocusExplicit 缺少足够的引用点（声明 + 三条用户驱动路径）",
  );
});

test("三条用户驱动路径走显式聚焦，而非环境驱动", () => {
  // 队列撤回恢复 / 外部文本预填 / 代码评论「加到对话」都必须走 explicit，
  // 否则移动端会被跳过规则误伤，用户点了却没聚焦。
  const explicitAssignments = (
    composerSource.match(/requestFocus:\s*requestComposerFocusExplicit/g) ?? []
  ).length;
  assert.equal(
    explicitAssignments,
    3,
    "预期三处 requestFocus 回调都指向 requestComposerFocusExplicit",
  );
});

test("环境驱动的聚焦入口没有被误换成显式通道", () => {
  // 草稿恢复（applyDraft）与 draftFocusVersion 属于环境驱动：移动端应当跳过。
  assert.ok(
    /requestComposerFocus\(\);/.test(composerSource),
    "环境驱动路径没有调用 requestComposerFocus()",
  );
  assert.equal(
    /requestComposerFocusExplicit\(\);/.test(composerSource),
    false,
    "环境驱动路径不应调用 requestComposerFocusExplicit()",
  );
});

test("时间线的折叠触发点调用了移动端焦点让渡", () => {
  assert.ok(
    countIdentifierOccurrences(timelineSource, "blurComposerInputOnMobileToggle") >= 1,
    "ConversationTimeline 的折叠触发点没有调用 blurComposerInputOnMobileToggle()",
  );
});

test("文件摘要面板的折叠触发器补齐了焦点滚动抑制", () => {
  const attributes = collectJsxAttributeNames(fileSummarySource);
  assert.ok(
    attributes.has("onMouseDown"),
    "ConversationFileSummaryPanel 的折叠触发器缺少 onMouseDown",
  );
  assert.ok(
    countIdentifierOccurrences(fileSummarySource, "preventTimelineCollapsibleFocusScroll") >= 1,
    "ConversationFileSummaryPanel 没有引用 preventTimelineCollapsibleFocusScroll",
  );
});
