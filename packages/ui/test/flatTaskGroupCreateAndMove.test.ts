import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ZCodeGroupedTaskViewStructure, ZCodeTaskGroup } from "@zcode/services";
import {
  resolveFlatSubmitBase,
  runFlatCreateAndMove,
  type FlatCreateAndMoveDeps,
  type FlatGroupStructureLoad,
} from "../src/lib/flatTaskGroupCreateAndMove.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// docs/specs/task-flat-menu-move-to-group.md：「新建分组并移入」的提交编排与基线解析。
// 回归背景：确认闭包原先在确认时刻回读菜单内容组件的展示 state，
// 而菜单关闭会清空它、菜单内容组件卸载会丢弃回填——基线必然为 null，
// 用户看到「分组数据未就绪，请重开菜单重试」。

function structure(groupId = "g1"): ZCodeGroupedTaskViewStructure {
  return {
    groups: [{ id: groupId, title: "组一", color: "blue", createdAt: 1, updatedAt: 1 }],
    members: [],
    topLevelOrders: [{ type: "group", groupId, sortOrder: 1 }],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

test("基线解析：同 scope 的请求句柄可用时直接用它，不再拉第二次结构", async () => {
  let fetchCalls = 0;
  const load: FlatGroupStructureLoad = {
    scopeKey: "/ws",
    promise: Promise.resolve(structure()),
  };
  const base = await resolveFlatSubmitBase({
    load,
    scopeKey: "/ws",
    fetchStructure: () => {
      fetchCalls += 1;
      return Promise.resolve(structure());
    },
  });
  assert.equal(base?.groups[0]?.id, "g1");
  assert.equal(fetchCalls, 0);
});

test("基线解析：请求在菜单关闭（组件卸载）之后才 resolve，仍能拿到基线", async () => {
  const request = deferred<ZCodeGroupedTaskViewStructure>();
  const load: FlatGroupStructureLoad = { scopeKey: "/ws", promise: request.promise };
  let fetchCalls = 0;
  const pending = resolveFlatSubmitBase({
    load,
    scopeKey: "/ws",
    fetchStructure: () => {
      fetchCalls += 1;
      return Promise.resolve(structure());
    },
  });
  // 菜单已关闭、组件已卸载，回填被丢弃——但请求本身没被取消。
  request.resolve(structure("g-after-close"));
  const base = await pending;
  assert.equal(base?.groups[0]?.id, "g-after-close");
  assert.equal(fetchCalls, 0);
});

test("基线解析：请求句柄的 scope 与提交目标不一致时按当前 scope 现拉，不串 scope", async () => {
  let fetchCalls = 0;
  const load: FlatGroupStructureLoad = {
    scopeKey: "/other-ws",
    promise: Promise.resolve(structure("other-group")),
  };
  const base = await resolveFlatSubmitBase({
    load,
    scopeKey: "/ws",
    fetchStructure: () => {
      fetchCalls += 1;
      return Promise.resolve(structure("current-group"));
    },
  });
  assert.equal(base?.groups[0]?.id, "current-group");
  assert.equal(fetchCalls, 1);
});

test("基线解析：没有请求句柄时按当前 scope 现拉一次", async () => {
  let fetchCalls = 0;
  const base = await resolveFlatSubmitBase({
    load: null,
    scopeKey: "/ws",
    fetchStructure: () => {
      fetchCalls += 1;
      return Promise.resolve(structure());
    },
  });
  assert.equal(base?.groups[0]?.id, "g1");
  assert.equal(fetchCalls, 1);
});

test("基线解析：请求失败时回落到现拉，现拉也失败才判为基线不可用", async () => {
  const failedLoad: FlatGroupStructureLoad = {
    scopeKey: "/ws",
    promise: Promise.reject(new Error("rpc failed")),
  };
  let fetchCalls = 0;
  const recovered = await resolveFlatSubmitBase({
    load: failedLoad,
    scopeKey: "/ws",
    fetchStructure: () => {
      fetchCalls += 1;
      return Promise.resolve(structure("g-fallback"));
    },
  });
  assert.equal(recovered?.groups[0]?.id, "g-fallback");
  assert.equal(fetchCalls, 1);

  const unavailable = await resolveFlatSubmitBase({
    load: failedLoad,
    scopeKey: "/ws",
    fetchStructure: () => Promise.reject(new Error("rpc failed again")),
  });
  assert.equal(unavailable, null);
});

interface Recorder {
  calls: string[];
  deps: FlatCreateAndMoveDeps;
}

const NEW_GROUP: ZCodeTaskGroup = {
  id: "g-new",
  title: "新组",
  color: "green",
  createdAt: 10,
  updatedAt: 10,
};

const VALUE = { title: "新组", color: "green" as const };

function recorder(overrides: Partial<FlatCreateAndMoveDeps> = {}): Recorder {
  const calls: string[] = [];
  const deps: FlatCreateAndMoveDeps = {
    createGroup: async () => {
      calls.push("create");
      return NEW_GROUP;
    },
    submitMove: async () => {
      calls.push("submit");
    },
    verifyMove: async () => {
      calls.push("verify");
      return true;
    },
    ...overrides,
  };
  return { calls, deps };
}

test("编排：基线缺失时不建组、不提交，直接判基线不可用", async () => {
  const { calls, deps } = recorder();
  const outcome = await runFlatCreateAndMove({ base: null, value: VALUE, deps });
  assert.equal(outcome.status, "structureUnavailable");
  assert.deepEqual(calls, []);
});

test("编排：建组 → 移入（基含新组）→ 回查复核，成功即 moved", async () => {
  const { calls, deps } = recorder();
  const submitted: Array<{ target: string; base: ZCodeGroupedTaskViewStructure }> = [];
  const outcome = await runFlatCreateAndMove({
    base: structure(),
    value: VALUE,
    deps: {
      ...deps,
      submitMove: async (targetGroupId, base) => {
        calls.push("submit");
        submitted.push({ target: targetGroupId, base });
      },
    },
  });
  assert.equal(outcome.status, "moved");
  assert.deepEqual(calls, ["create", "submit", "verify"]);
  assert.equal(submitted[0]?.target, "g-new");
  // 新组必须进入提交基线：全量提交会重写顶层排序，漏提交的组会被抹掉。
  assert.equal(submitted[0]?.base.groups.length, 2);
  assert.ok(
    submitted[0]?.base.topLevelOrders.some(
      (order) => order.type === "group" && order.groupId === "g-new",
    ),
    "新组必须带进顶层排序",
  );
});

test("编排：建组失败即停，不再发移动请求", async () => {
  const { calls, deps } = recorder({
    createGroup: async () => {
      calls.push("create");
      throw new Error("create failed");
    },
  });
  const outcome = await runFlatCreateAndMove({ base: structure(), value: VALUE, deps });
  assert.equal(outcome.status, "createFailed");
  assert.deepEqual(calls, ["create"]);
});

test("编排：移动提交抛错判 moveFailed（组可能已建、任务未移）", async () => {
  const { calls, deps } = recorder({
    submitMove: async () => {
      calls.push("submit");
      throw new Error("submit failed");
    },
  });
  const outcome = await runFlatCreateAndMove({ base: structure(), value: VALUE, deps });
  assert.equal(outcome.status, "moveFailed");
  assert.deepEqual(calls, ["create", "submit"]);
});

test("编排：复核未生效判 moveNotSettled（服务端静默跳过不可见引用）", async () => {
  const { calls, deps } = recorder({
    verifyMove: async () => {
      calls.push("verify");
      return false;
    },
  });
  const outcome = await runFlatCreateAndMove({ base: structure(), value: VALUE, deps });
  assert.equal(outcome.status, "moveNotSettled");
  assert.deepEqual(calls, ["create", "submit", "verify"]);
});

test("编排：复核抛错同样按移动失败处理", async () => {
  const { calls, deps } = recorder({
    verifyMove: async () => {
      calls.push("verify");
      throw new Error("verify failed");
    },
  });
  const outcome = await runFlatCreateAndMove({ base: structure(), value: VALUE, deps });
  assert.equal(outcome.status, "moveFailed");
  assert.deepEqual(calls, ["create", "submit", "verify"]);
});

// ui 包测试为源码断言式（无组件渲染/jsdom），下面锁定 hook 接线防回退：
// 确认路径必须 await 打开菜单时那次结构请求，不能再回读随菜单关闭被清空的展示 state。

test("hook：结构请求句柄入 ref，确认路径 await 它而非读展示 state", () => {
  const hook = read("../src/hooks/useFlatTaskGroupMenu.ts");
  assert.match(hook, /structureLoadRef\.current = \{ scopeKey, promise: request \};/);
  assert.match(hook, /await resolveFlatSubmitBase\(\{/);
  const createBlock = hook.split("const runCreateGroupAndMove")[1]?.split("if (!eligible)")[0] ?? "";
  assert.ok(createBlock.length > 0, "应能定位到建组确认闭包");
  assert.ok(
    !createBlock.includes("structureRef"),
    "建组确认闭包不得回读随菜单关闭被清空的展示 state",
  );
});

test("hook：建组与移动环节的失败分别提示，不再混为一谈", () => {
  const hook = read("../src/hooks/useFlatTaskGroupMenu.ts");
  assert.match(hook, /outcome\.status === "createFailed"[\s\S]{0,200}taskGroup\.createFailed/);
  assert.match(
    hook,
    /outcome\.status === "structureUnavailable"[\s\S]{0,300}taskGroup\.structureNotReady/,
  );
  assert.match(hook, /taskGroup\.updateFailed/);
});
