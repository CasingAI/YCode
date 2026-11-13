import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";

import { EMPTY_PENDING_GUIDES, projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import {
  buildKnownSessionIdSet,
  isSameDerivedInputScope,
  stabilizeKnownSessionIdSet,
  stabilizePendingGuideProjection,
  type DerivedInputScope,
  type KnownSessionIdSources,
} from "@/v4/sessionPaneDerivedInputs.js";

const scopeA: DerivedInputScope = {
  workspaceIdentity: "ident-1",
  workspacePath: "C:/workspace",
  remoteSessionId: null,
  sessionId: "sess-1",
};
const scopeB: DerivedInputScope = { ...scopeA, workspaceIdentity: "ident-2" };

function queueItem(options: {
  id: string;
  text?: string;
  admitted?: QueueItem["delivery"]["admitted"];
  dispatchState?: QueueItem["dispatch"]["state"];
}): QueueItem {
  return {
    sourceCommandId: `cmd-${options.id}`,
    queueItemId: options.id,
    clientId: "client-test",
    kind: "sendText",
    text: options.text ?? options.id,
    attachments: [],
    delivery: { requested: "auto", admitted: options.admitted ?? "queue" },
    order: { admissionSeq: 1, queuePosition: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: options.dispatchState ?? "queued" },
    admittedAt: 1,
  } as QueueItem;
}

function queueOf(items: QueueItem[], autoDrain = true): QueueState {
  return { items, autoDrain };
}

function guide(id: string, text = id, dispatchState: QueueItem["dispatch"]["state"] = "queued") {
  return queueItem({ id, text, admitted: "guide", dispatchState });
}

function queued(id: string) {
  return queueItem({ id });
}

function knownSources(overrides: Partial<KnownSessionIdSources> = {}): KnownSessionIdSources {
  return {
    sessionScopeReady: true,
    sessionIndexScopeCount: 1,
    hydratingEndpointCount: 0,
    archivedLoading: false,
    sessionIndexItems: [{ taskId: "live-1" }, { taskId: "  live-2  " }],
    taskMetaByEntityKey: { cached: { taskId: "cache-1" } },
    archivedItems: [{ taskId: "archived-1" }],
    sessionId: "current",
    ...overrides,
  };
}

test("空 pendingGuides 复用模块级稳定引用", () => {
  const first = projectPendingGuideQueue(queueOf([queued("q1")]));
  const second = projectPendingGuideQueue(queueOf([queued("q1")], false));
  assert.equal(first.pendingGuides, EMPTY_PENDING_GUIDES);
  assert.equal(second.pendingGuides, EMPTY_PENDING_GUIDES);
});

test("成员对象与顺序未变时复用 pendingGuides，visibleQueue 仍来自当前 queue", () => {
  const g1 = guide("g1");
  const q1 = queued("q1");
  const first = stabilizePendingGuideProjection(null, scopeA, queueOf([g1, q1]));

  const secondQueue = queueOf([g1, q1], false);
  const second = stabilizePendingGuideProjection(first, scopeA, secondQueue);

  assert.equal(second.projection.pendingGuides, first.projection.pendingGuides);
  assert.equal(second.projection.visibleQueue.autoDrain, false);
  assert.deepEqual(
    second.projection.visibleQueue.items.map((item) => item.queueItemId),
    ["q1"],
  );
});

test("guide 内容、dispatch、delivery 或顺序变化立即更新投影", () => {
  const g1 = guide("g1", "原文");
  const q1 = queued("q1");
  const base = stabilizePendingGuideProjection(null, scopeA, queueOf([g1, q1]));

  const changedText = stabilizePendingGuideProjection(
    base,
    scopeA,
    queueOf([{ ...g1, text: "改过的引导" }, q1]),
  );
  assert.notEqual(changedText.projection.pendingGuides, base.projection.pendingGuides);

  const reserved = stabilizePendingGuideProjection(
    changedText,
    scopeA,
    queueOf([guide("g1", "改过的引导", "reserved"), q1]),
  );
  assert.notEqual(reserved.projection.pendingGuides, changedText.projection.pendingGuides);
  assert.equal(reserved.projection.pendingGuides[0]?.dispatch.state, "reserved");

  const promoting = stabilizePendingGuideProjection(
    reserved,
    scopeA,
    queueOf([guide("g1", "改过的引导", "promoting"), q1]),
  );
  assert.notEqual(promoting.projection.pendingGuides, reserved.projection.pendingGuides);

  const deliveredToQueue = stabilizePendingGuideProjection(
    promoting,
    scopeA,
    queueOf([queueItem({ id: "g1", text: "改过的引导" }), q1]),
  );
  assert.equal(deliveredToQueue.projection.pendingGuides, EMPTY_PENDING_GUIDES);
  assert.deepEqual(
    deliveredToQueue.projection.visibleQueue.items.map((item) => item.queueItemId),
    ["g1", "q1"],
  );

  const g2 = guide("g2");
  const ordered = stabilizePendingGuideProjection(deliveredToQueue, scopeA, queueOf([g1, q1, g2]));
  const reordered = stabilizePendingGuideProjection(ordered, scopeA, queueOf([g2, q1, g1]));
  assert.notEqual(reordered.projection.pendingGuides, ordered.projection.pendingGuides);
  assert.deepEqual(
    reordered.projection.pendingGuides.map((item) => item.queueItemId),
    ["g2", "g1"],
  );
});

test("同一 queue 引用跨 scope 不得复用非空 pendingGuides", () => {
  const queue = queueOf([guide("g1"), queued("q1")]);
  const first = stabilizePendingGuideProjection(null, scopeA, queue);
  const otherScope = stabilizePendingGuideProjection(first, scopeB, queue);
  assert.notEqual(otherScope.projection.pendingGuides, first.projection.pendingGuides);
});

test("作用域按字段比较，不使用可能撞车的拼接格式", () => {
  const base: DerivedInputScope = {
    workspacePath: "C:/workspace",
    workspaceIdentity: "  ident-1  ",
    sessionId: "s1",
  };
  assert.equal(isSameDerivedInputScope(base, { ...base, workspaceIdentity: "ident-1" }), true);
  assert.equal(isSameDerivedInputScope(base, { ...base, workspaceIdentity: "ident-2" }), false);
  assert.equal(isSameDerivedInputScope(base, { ...base, workspaceIdentity: undefined }), false);
  assert.equal(isSameDerivedInputScope(base, { ...base, remoteSessionId: "remote-1" }), false);
  assert.equal(isSameDerivedInputScope(base, { ...base, sessionId: "s2" }), false);
  assert.equal(
    isSameDerivedInputScope(
      { ...base, workspaceIdentity: "   " },
      { ...base, workspaceIdentity: undefined },
    ),
    true,
  );
  assert.equal(
    isSameDerivedInputScope(
      { workspacePath: "a", remoteSessionId: "b" },
      { workspacePath: "a\u0000b" },
    ),
    false,
  );
});

test("knownSessionIds 并集保留 live/cache/archived/当前会话与去空白", () => {
  const ids = buildKnownSessionIdSet(knownSources());
  assert.ok(ids);
  assert.deepEqual([...ids].sort(), ["archived-1", "cache-1", "current", "live-1", "live-2"]);
});

test("knownSessionIds 保留 undefined fail-open 与就绪规则", () => {
  assert.equal(buildKnownSessionIdSet(knownSources({ sessionScopeReady: false })), undefined);
  assert.equal(buildKnownSessionIdSet(knownSources({ sessionIndexScopeCount: 0 })), undefined);
  assert.equal(
    buildKnownSessionIdSet(knownSources({ hydratingEndpointCount: 1, archivedLoading: true })),
    undefined,
  );
  assert.ok(
    buildKnownSessionIdSet(knownSources({ hydratingEndpointCount: 1, archivedLoading: false })),
  );
  assert.ok(
    buildKnownSessionIdSet(knownSources({ hydratingEndpointCount: 0, archivedLoading: true })),
  );
  assert.equal(
    buildKnownSessionIdSet(
      knownSources({
        sessionIndexItems: [],
        taskMetaByEntityKey: {},
        archivedItems: [],
        sessionId: null,
      }),
    ),
    undefined,
  );
});

test("knownSessionIds 忽略索引顺序按成员复用，元数据变化不改引用", () => {
  const firstSet = buildKnownSessionIdSet(knownSources());
  assert.ok(firstSet);
  const first = stabilizeKnownSessionIdSet(null, scopeA, firstSet);

  // 索引元数据（lastActivityAt、标题、状态）变化但成员不变：重建 Set 后仍复用旧引用。
  const metadataChanged = buildKnownSessionIdSet(
    knownSources({
      sessionIndexItems: [
        { taskId: "live-1", lastActivityAt: 99, title: "新标题", status: "running" },
        { taskId: "  live-2  ", lastActivityAt: 100 },
      ],
    }),
  );
  const reused = stabilizeKnownSessionIdSet(first, scopeA, metadataChanged);
  assert.equal(reused, first);
  assert.equal(reused.ids, firstSet);

  const reordered = stabilizeKnownSessionIdSet(
    first,
    scopeA,
    new Set(["live-2", "current", "archived-1", "cache-1", "live-1"]),
  );
  assert.equal(reordered, first);
});

test("knownSessionIds 成员增删、undefined 切换立即更新", () => {
  const first = stabilizeKnownSessionIdSet(null, scopeA, new Set(["a", "b"]));
  const added = stabilizeKnownSessionIdSet(first, scopeA, new Set(["a", "b", "c"]));
  assert.notEqual(added, first);
  assert.equal(added.ids?.has("c"), true);

  const removed = stabilizeKnownSessionIdSet(added, scopeA, new Set(["a"]));
  assert.notEqual(removed, added);

  const notReady = stabilizeKnownSessionIdSet(removed, scopeA, undefined);
  assert.notEqual(notReady, removed);
  assert.equal(notReady.ids, undefined);

  const stillNotReady = stabilizeKnownSessionIdSet(notReady, scopeA, undefined);
  assert.equal(stillNotReady, notReady);

  const readyAgain = stabilizeKnownSessionIdSet(stillNotReady, scopeA, new Set(["a"]));
  assert.notEqual(readyAgain, stillNotReady);
});

test("同一 next 引用跨 scope 不得返回旧非空 Set（旧实现回归）", () => {
  const ids = new Set(["a", "b"]);
  const first = stabilizeKnownSessionIdSet(null, scopeA, ids);
  assert.equal(first.ids, ids);

  const otherScope = stabilizeKnownSessionIdSet(first, scopeB, ids);
  assert.notEqual(otherScope.ids, first.ids);
  assert.deepEqual([...(otherScope.ids ?? [])].sort(), ["a", "b"]);
});

test("SessionPane 接线：build memo 纳入 scope，再经稳定 hook 输出", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src/v4/SessionPane.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /buildKnownSessionIdSet\(\{/);
  assert.doesNotMatch(source, /knownSessionIdSources/);
  const memoStart = source.indexOf("const knownSessionIdSet = useMemo");
  const hookStart = source.indexOf("const knownSessionIds = useStableKnownSessionIdSet");
  assert.ok(memoStart >= 0 && hookStart > memoStart);
  const buildMemo = source.slice(memoStart, hookStart);
  for (const dependency of ["workspaceIdentity", "workspacePath", "remoteSessionId", "sessionId"]) {
    assert.match(buildMemo, new RegExp(`\\b${dependency}\\b`), `build memo 必须依赖 ${dependency}`);
  }
});
