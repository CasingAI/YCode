// sessions-index 聚合成本分层（mapSessionsIndexScopeMetas）的回归：
// scope 代次不变 → 引用复用零重算；代次变化 → 仅重映射引用变化的 summary；
// 冷缓存时 previous 回退保住手动标题/未读等旧字段；会话删除后缓存无残留。
// 见 docs/specs/sessions-index-activity-flush-coalescing.md。
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  mapSessionsIndexScopeMetas,
  type SessionsIndexStoreLike,
} from "../src/v4/workspaceSessionsIndexMetas.js";

const MAPPING = { workspacePath: "/repo" };
const REVISION_A = "epoch-1:1:live";
const REVISION_B = "epoch-1:2:live";

function summary(overrides: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    workspaceId: "workspace-1",
    title: "任务",
    phase: "running",
    sessionEnded: false,
    hasBackgroundWork: false,
    lastActivityAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function storeOf(
  sessions: SessionSummary[],
): SessionsIndexStoreLike & { sessions: SessionSummary[] } {
  return {
    sessions,
    getSessions: () => sessions,
  };
}

test("代次不变：整份 metas 引用复用，零重算", () => {
  const store = storeOf([summary({ sessionId: "s1" }), summary({ sessionId: "s2" })]);
  const first = mapSessionsIndexScopeMetas(store, REVISION_A, MAPPING, undefined);
  const second = mapSessionsIndexScopeMetas(store, REVISION_A, MAPPING, first);
  assert.equal(second, first, "代次不变必须原样复用缓存条目");
  assert.ok(second.metas[0] === first.metas[0] && second.metas[1] === first.metas[1]);
});

test("单会话 summary 引用变化：仅该条重映射，其余引用复用", () => {
  const s1 = summary({ sessionId: "s1" });
  const s2 = summary({ sessionId: "s2" });
  const store = storeOf([s1, s2]);
  const first = mapSessionsIndexScopeMetas(store, REVISION_A, MAPPING, undefined);

  // 新一帧只替换 s1 的 summary 对象；s2 引用原样保留。
  const s1Next = summary({ sessionId: "s1", lastActivityAt: 2 });
  const storeNext = storeOf([s1Next, s2]);
  const second = mapSessionsIndexScopeMetas(storeNext, REVISION_B, MAPPING, first);
  assert.notEqual(second.metas[0], first.metas[0], "变化的会话必须重映射");
  assert.equal(second.metas[0].updatedAt, 2, "新 meta 携带新活动时间");
  assert.equal(second.metas[1], first.metas[1], "未变化的会话必须引用复用");
});

test("冷缓存的 previous 回退：保住旧 tick 的手动标题", () => {
  const previousMeta = {
    taskId: "s1",
    title: "手动标题",
    titleOverridden: true,
  } as unknown as ZCodeTaskMeta;
  const previousByKey = new Map([["/repo::s1", previousMeta]]);
  const store = storeOf([
    summary({ sessionId: "s1", title: "生成标题", titleSource: "generated" }),
  ]);
  const entry = mapSessionsIndexScopeMetas(store, REVISION_A, MAPPING, undefined, previousByKey);
  assert.equal(
    entry.metas[0]?.title,
    "手动标题",
    "titleSource 非 custom 时沿用 previous 的手动标题",
  );
});

test("重订阅换代（store 实例更换）：同会话 previous 经缓存传播，旧字段不丢", () => {
  const unreadMeta = { taskId: "s1", unreadAt: 42 } as unknown as ZCodeTaskMeta;
  const previousByKey = new Map([["/repo::s1", unreadMeta]]);
  const first = mapSessionsIndexScopeMetas(
    storeOf([summary({ sessionId: "s1" })]),
    REVISION_A,
    MAPPING,
    undefined,
    previousByKey,
  );
  assert.equal(first.metas[0]?.unreadAt, 42);

  // 重订阅后 store 是新实例、summary 也是新对象：previous 必须取缓存里的旧 meta。
  const second = mapSessionsIndexScopeMetas(
    storeOf([summary({ sessionId: "s1" })]),
    REVISION_A,
    MAPPING,
    first,
  );
  assert.notEqual(second, first, "store 实例换代必须重建缓存条目");
  assert.equal(second.metas[0]?.unreadAt, 42, "unreadAt 必须经同会话 previous 保留");
});

test("会话删除：byId 随当次 store 列表重建，无残留", () => {
  const first = mapSessionsIndexScopeMetas(
    storeOf([summary({ sessionId: "s1" }), summary({ sessionId: "s2" })]),
    REVISION_A,
    MAPPING,
    undefined,
  );
  assert.equal(first.byId.size, 2);

  const second = mapSessionsIndexScopeMetas(
    storeOf([summary({ sessionId: "s1" })]),
    REVISION_B,
    MAPPING,
    first,
  );
  assert.equal(second.metas.length, 1);
  assert.equal(second.byId.size, 1, "被删除会话的缓存条目必须随之淘汰");
  assert.equal(second.byId.has("s2"), false);
});

test("store 实例不同而代次串相同：不得复用旧缓存", () => {
  const first = mapSessionsIndexScopeMetas(
    storeOf([summary({ sessionId: "s1" })]),
    REVISION_A,
    MAPPING,
    undefined,
  );
  const second = mapSessionsIndexScopeMetas(
    storeOf([summary({ sessionId: "s1" })]),
    REVISION_A,
    MAPPING,
    first,
  );
  assert.equal(second.store === first.store, false);
  assert.notEqual(second, first, "缓存命中必须同时校验 store 实例");
});
