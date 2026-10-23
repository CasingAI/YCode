import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createAssistantSectionReadingRowKey } from "../src/store/assistantSectionReadingStore.js";

const [readerSource, timelineSource] = await Promise.all(
  ["AssistantSectionReading", "ConversationTimeline"].map(async (name) =>
    ts.createSourceFile(
      `${name}.tsx`,
      await readFile(new URL(`../src/v4/${name}.tsx`, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ),
  ),
);

function bindExpression<T>(
  source: ts.SourceFile,
  match: (node: ts.Node) => boolean,
  bindings: Record<string, unknown>,
): T {
  let expression: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (match(node)) expression = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, "实际布局回调存在");
  const { outputText } = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn callback;`)(
    ...Object.values(bindings),
  ) as T;
}

function createHarness() {
  const scopeKey = "completion-layout-scope";
  const rowKey = '["turn-a",42,"entity-a"]';
  const root = {
    scrollTop: 120,
    contains: (node: unknown) => node === row,
    getBoundingClientRect: () => ({ top: 0, bottom: 600, left: 0, right: 800 }),
  };
  const row = {
    top: 80,
    bottom: 1200,
    getBoundingClientRect() {
      return { top: this.top, bottom: this.bottom, left: 0, right: 800 };
    },
  };
  const navigation = {
    closest: () => row,
    getBoundingClientRect: () => ({ height: 96 }),
  };
  const assistantReadingLayoutRef = {
    current: {
      scopeKey,
      rows: new Map<string, { version: string | null; heightPx: number; settled: boolean }>(),
    },
  };
  const programmaticReasons: string[] = [];
  const lastObservedScrollTopRef = { current: root.scrollTop };
  let mountedRow: unknown = row;
  const preserve = bindExpression<(report: Record<string, unknown>) => void>(
    timelineSource!,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.name.getText(timelineSource) === "preserveAssistantReadingPosition",
    {
      useCallback: (callback: unknown) => callback,
      assistantReadingLayoutRef,
      scrollRef: { current: root },
      findMountedTimelineRowElement: () => mountedRow,
      markProgrammaticScroll: (reason: string) => programmaticReasons.push(reason),
      lastObservedScrollTopRef,
      syncTurnNavigatorViewport: () => {},
    },
  );
  const document = { version: "v1", sections: [{ id: "one" }, { id: "two" }] };
  const report = (
    options: {
      document?: typeof document;
      mode?: string;
      scopeKey?: string;
      rowKey?: string;
      navigation?: typeof navigation;
    } = {},
  ) => {
    const currentDocument = options.document;
    // 每次重建组件局部 ref，覆盖 Live 子树结束后移入历史虚拟行的真实生命周期。
    const effect = bindExpression<() => void>(
      readerSource!,
      (node) =>
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText(readerSource) === "useLayoutEffect" &&
        node.getText(readerSource).includes("preserveReadingPosition"),
      {
        document: currentDocument,
        mode: options.mode ?? "continuous",
        scopeKey: options.scopeKey ?? scopeKey,
        rowKey: options.rowKey ?? rowKey,
        rowId: 42,
        navigationRef: { current: options.navigation ?? navigation },
        panelRef: { current: {} },
        turnRunning: currentDocument === undefined,
        turnWasRunningRef: { current: currentDocument === undefined },
        previousDocumentRef: { current: currentDocument },
        preserveReadingPosition: preserve,
      },
    );
    effect();
  };
  const settleUnmountedCompletion = () => {
    const effect = bindExpression<() => void>(
      timelineSource!,
      (node) =>
        ts.isArrowFunction(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText(timelineSource) === "useLayoutEffect" &&
        node.getText(timelineSource).includes("assistantReadingLayoutRef") &&
        node.getText(timelineSource).includes("renderUnits"),
      {
        assistantReadingLayoutRef,
        assistantReadingScopeKey: scopeKey,
        assistantSectionReadingEnabled: true,
        scrollRef: { current: root },
        findMountedTimelineRowElement: () => mountedRow,
        createAssistantSectionReadingRowKey,
        renderUnits: [
          {
            turnId: "turn-a",
            isRunning: false,
            header: { state: "completedSuccess" },
            latestAssistantTextRow: { rowId: 42, entityId: "entity-a", state: "complete" },
          },
        ],
      },
    );
    effect();
  };
  return {
    scopeKey,
    rowKey,
    root,
    row,
    navigation,
    assistantReadingLayoutRef,
    programmaticReasons,
    lastObservedScrollTopRef,
    document,
    report,
    settleUnmountedCompletion,
    hideMountedRow: () => {
      mountedRow = null;
    },
    showMountedRow: () => {
      mountedRow = row;
    },
  };
}

test("Live 完成后跨历史行重挂，只补偿一次真实头部插入", () => {
  const h = createHarness();
  h.report();
  h.report({ document: h.document });
  h.report({ document: h.document });

  assert.equal(h.root.scrollTop, 216);
  assert.equal(h.lastObservedScrollTopRef.current, 216);
  assert.deepEqual(h.programmaticReasons, ["assistant-section-layout"]);
});

test("视口外完成先消费布局，之后滚回或重挂不补做旧位移", () => {
  const h = createHarness();
  h.report();
  h.row.top = 800;
  h.report({ document: h.document });
  assert.equal(h.assistantReadingLayoutRef.current.rows.get(h.rowKey)?.heightPx, 96);
  h.row.top = 80;
  h.report({ document: h.document });

  assert.equal(h.root.scrollTop, 120);
  assert.deepEqual(h.programmaticReasons, []);
});

test("首次冷打开分页仅登记头部，切换全文不误补偿", () => {
  const h = createHarness();
  h.report({ document: h.document, mode: "paged" });
  h.report({ document: h.document, mode: "full" });
  assert.equal(h.assistantReadingLayoutRef.current.rows.get(h.rowKey)?.heightPx, 96);
  assert.equal(h.root.scrollTop, 120);
});

test("运行时卸载后在未挂载状态完成，滚回只登记头部而不补做旧布局", () => {
  const h = createHarness();
  h.report();
  h.hideMountedRow();
  h.settleUnmountedCompletion();
  assert.equal(h.assistantReadingLayoutRef.current.rows.get(h.rowKey)?.settled, true);
  h.showMountedRow();
  h.report({ document: h.document });

  assert.equal(h.root.scrollTop, 120);
  assert.equal(h.assistantReadingLayoutRef.current.rows.get(h.rowKey)?.heightPx, 96);
});

test("已显示头部的正文换代及普通重渲染不重复补偿", () => {
  const h = createHarness();
  h.report({ document: h.document });
  h.report({ document: { ...h.document, version: "v2" } });
  h.report({ document: { ...h.document, version: "v2" } });
  assert.equal(h.root.scrollTop, 216);
  assert.equal(h.assistantReadingLayoutRef.current.rows.get(h.rowKey)?.version, "v2");
});

test("staging 或已卸载旧副本不能消费正式行的完成布局", () => {
  const h = createHarness();
  h.hideMountedRow();
  h.report({ document: h.document });
  assert.equal(h.assistantReadingLayoutRef.current.rows.size, 0);
  assert.equal(h.root.scrollTop, 120);
});

test("过期 scope 报告被拒绝，完整 row key 隔离同 rowId 的不同正文身份", () => {
  const h = createHarness();
  h.report({ document: h.document, scopeKey: "stale-scope" });
  assert.equal(h.assistantReadingLayoutRef.current.rows.size, 0);
  h.report({ document: h.document });
  h.report({ document: h.document, rowKey: '["turn-b",42,"entity-b"]' });
  assert.equal(h.assistantReadingLayoutRef.current.rows.size, 2);
});

test("失败或没有分节文档时不产生头部插入及滚动", () => {
  const h = createHarness();
  h.report({ mode: "full" });
  h.report({ mode: "full" });
  assert.equal(h.root.scrollTop, 120);
  assert.equal(h.assistantReadingLayoutRef.current.rows.get(h.rowKey)?.heightPx, 0);
});
