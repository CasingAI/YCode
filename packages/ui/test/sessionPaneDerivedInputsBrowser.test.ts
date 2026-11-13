// 独立生产态浏览器回归：挂载真实 useStablePendingGuideProjection /
// useStableKnownSessionIdSet，用 React.memo 子组件的实际 render 次数验证引用稳定。
// 只启动测试自己的 Chromium、临时 profile 与本地 fixture；不连接、不操作运行中的 YCode。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadChromium, uiRoot } from "./helpers/chromiumFixture.js";

function modulePath(relative: string): string {
  return JSON.stringify(join(uiRoot, "src", "v4", relative).replace(/\\/g, "/"));
}

function fixtureSource(): string {
  return `
import { memo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useStableKnownSessionIdSet,
  useStablePendingGuideProjection,
} from ${modulePath("sessionPaneDerivedInputs.ts")};
import { EMPTY_PENDING_GUIDES } from ${modulePath("pendingGuideProjection.ts")};

const runtime = {
  renderCounts: { pending: 0, visible: 0, ids: 0 },
  refs: { current: null, pending: null, visible: null, ids: null },
  state: null,
  setInput: null,
  bump: null,
  commit: 0,
  last: null,
};

function makeItem(id, admitted, dispatch, text) {
  return {
    sourceCommandId: "cmd-" + id,
    queueItemId: id,
    clientId: "client-browser",
    kind: "sendText",
    text: text || id,
    attachments: [],
    delivery: { requested: "auto", admitted },
    order: { admissionSeq: 1, queuePosition: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: dispatch },
    admittedAt: 1,
  };
}

function makeQueue(items, autoDrain) {
  return { items, autoDrain: autoDrain !== false };
}

const seed = {
  makeItem,
  makeQueue,
  ids: (values) => new Set(values),
  g1: makeItem("g1", "guide", "queued", "引导一"),
  q1: makeItem("q1", "queue", "queued", "队列一"),
  g2: makeItem("g2", "guide", "queued", "引导二"),
};
const initialIds = new Set(["sess-a", "sess-b"]);
runtime.state = {
  scope: {
    workspaceIdentity: "ident-1",
    workspacePath: "C:/workspace",
    remoteSessionId: null,
    sessionId: "sess-1",
  },
  queue: makeQueue([seed.g1, seed.q1]),
  ids: initialIds,
  meta: 0,
};

const PendingProbe = memo(function PendingProbe(props) {
  runtime.renderCounts.pending += 1;
  runtime.refs.pending = props.items;
  return null;
});
const VisibleProbe = memo(function VisibleProbe(props) {
  runtime.renderCounts.visible += 1;
  runtime.refs.visible = props.queue;
  return null;
});
const IdsProbe = memo(function IdsProbe(props) {
  runtime.renderCounts.ids += 1;
  runtime.refs.ids = props.ids;
  return null;
});

function Fixture() {
  const [input, setInput] = useState(runtime.state);
  const [, setTick] = useState(0);
  runtime.state = input;
  runtime.setInput = setInput;
  runtime.bump = () => setTick((value) => value + 1);
  runtime.commit += 1;

  const projection = useStablePendingGuideProjection(input.scope, input.queue);
  const ids = useStableKnownSessionIdSet(input.scope, input.ids);
  runtime.refs.current = { projection, ids };

  return (
    <>
      <PendingProbe items={projection ? projection.pendingGuides : EMPTY_PENDING_GUIDES} />
      <VisibleProbe queue={projection ? projection.visibleQueue : null} />
      <IdsProbe ids={ids} />
      <div data-testid="ready">ready</div>
    </>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);

globalThis.__fixtureRuntime = runtime;
globalThis.__fixture = {
  seed,
  apply(patch) {
    runtime.state = { ...runtime.state, ...patch };
    runtime.setInput(runtime.state);
  },
  scope(patch) {
    runtime.state = {
      ...runtime.state,
      scope: { ...runtime.state.scope, ...patch },
    };
    runtime.setInput(runtime.state);
  },
  bump() {
    runtime.bump();
  },
  mark() {
    const current = runtime.refs.current || {};
    runtime.last = {
      pending: current.projection ? current.projection.pendingGuides : null,
      visible: current.projection ? current.projection.visibleQueue : null,
      ids: current.ids,
    };
  },
  read() {
    const current = runtime.refs.current || {};
    const projection = current.projection;
    const ids = current.ids;
    const last = runtime.last || {};
    return {
      pendingSame: projection ? projection.pendingGuides === last.pending : null,
      pendingIsEmpty: projection ? projection.pendingGuides === EMPTY_PENDING_GUIDES : null,
      visibleSame: projection ? projection.visibleQueue === last.visible : null,
      idsSame: ids === last.ids,
      idsUndefined: ids === undefined,
      idsSize: ids === undefined ? null : ids.size,
      pendingIds: projection ? projection.pendingGuides.map((item) => item.queueItemId) : null,
      visibleIds: projection ? projection.visibleQueue.items.map((item) => item.queueItemId) : null,
      visibleAutoDrain: projection ? projection.visibleQueue.autoDrain : null,
      renderCounts: { ...runtime.renderCounts },
    };
  },
};
`;
}

test(
  "真实派生 hook：无关更新保持引用、真实 guide/session 变化立即失效、作用域不串用",
  { timeout: 120_000 },
  async (t) => {
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑派生稳定性测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-session-derived-"));
    try {
      const entry = join(directory, "entry.tsx");
      const bundle = join(directory, "fixture.js");
      await writeFile(entry, fixtureSource());
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        target: ["chrome120"],
        logLevel: "silent",
        nodePaths: [join(uiRoot, "node_modules"), join(uiRoot, "..", "..", "node_modules")],
        define: { "process.env.NODE_ENV": '"production"' },
      });

      const context = await chromium.launchPersistentContext(join(directory, "profile"), {
        executablePath,
        headless: true,
        viewport: { width: 600, height: 400 },
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });
        await page.getByTestId("ready").waitFor();

        const settle = () =>
          page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
              ),
          );
        const read = () => page.evaluate(() => globalThis.__fixture.read());
        const mark = () => page.evaluate(() => globalThis.__fixture.mark());
        const apply = async (patch: () => void) => {
          await page.evaluate(patch);
          await settle();
        };

        const initial = await read();
        assert.deepEqual(initial.pendingIds, ["g1"]);
        assert.deepEqual(initial.visibleIds, ["q1"]);
        assert.equal(initial.idsSize, 2);
        assert.deepEqual(initial.renderCounts, { pending: 1, visible: 1, ids: 1 });

        // 无关父级重渲染：派生引用不变，三个 memo 子组件都不新增 render。
        await mark();
        await apply(() => globalThis.__fixture.bump());
        let state = await read();
        assert.equal(state.pendingSame, true, "无关更新保持 pendingGuides 引用");
        assert.equal(state.visibleSame, true, "无关更新保持 visibleQueue 引用");
        assert.equal(state.idsSame, true, "无关更新保持 knownSessionIds 引用");
        assert.deepEqual(state.renderCounts, { pending: 1, visible: 1, ids: 1 });

        // queue 包装对象变化、成员对象与顺序未变：pendingGuides 复用，visibleQueue 用当前 queue。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({
            queue: fixtureSeed.makeQueue([fixtureSeed.g1, fixtureSeed.q1], false),
          });
        });
        state = await read();
        assert.equal(state.pendingSame, true, "成员与顺序未变时复用 pendingGuides");
        assert.equal(state.visibleSame, false, "visibleQueue 必须来自当前 queue");
        assert.equal(state.visibleAutoDrain, false);
        assert.deepEqual(state.visibleIds, ["q1"]);
        assert.equal(state.renderCounts.pending, 1);
        assert.equal(state.renderCounts.visible, 2);
        assert.equal(state.renderCounts.ids, 1);

        // dispatch reserved / promoting 变化：新对象立即更新。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          fixtureSeed.g1Reserved = fixtureSeed.makeItem("g1", "guide", "reserved", "引导一");
          globalThis.__fixture.apply({
            queue: fixtureSeed.makeQueue([fixtureSeed.g1Reserved, fixtureSeed.q1]),
          });
        });
        state = await read();
        assert.equal(state.pendingSame, false);
        assert.deepEqual(state.pendingIds, ["g1"]);
        assert.equal(state.renderCounts.pending, 2);

        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          fixtureSeed.g1Promoting = fixtureSeed.makeItem("g1", "guide", "promoting", "引导一");
          globalThis.__fixture.apply({
            queue: fixtureSeed.makeQueue([fixtureSeed.g1Promoting, fixtureSeed.q1]),
          });
        });
        state = await read();
        assert.equal(state.pendingSame, false);
        assert.equal(state.renderCounts.pending, 3);

        // 真实内容变化立即更新。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          fixtureSeed.g1Changed = fixtureSeed.makeItem("g1", "guide", "queued", "改过的引导");
          globalThis.__fixture.apply({
            queue: fixtureSeed.makeQueue([fixtureSeed.g1Changed, fixtureSeed.q1]),
          });
        });
        state = await read();
        assert.equal(state.pendingSame, false);
        assert.equal(state.renderCounts.pending, 4);

        // 删除 guide：回到稳定空数组；新的无 guide queue 仍复用同一个空数组。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({ queue: fixtureSeed.makeQueue([fixtureSeed.q1]) });
        });
        state = await read();
        assert.equal(state.pendingIsEmpty, true);
        assert.equal(state.renderCounts.pending, 5);

        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({ queue: fixtureSeed.makeQueue([fixtureSeed.q1]) });
        });
        state = await read();
        assert.equal(state.pendingSame, true, "空 pendingGuides 跨 queue 包装对象保持引用");
        assert.equal(state.renderCounts.pending, 5);

        // guide → queue：pending 清空，visibleQueue 立即包含该项。
        const visibleBeforeDelivery = (await read()).renderCounts.visible;
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          fixtureSeed.g1AsQueue = fixtureSeed.makeItem("g1", "queue", "queued", "引导一");
          globalThis.__fixture.apply({
            queue: fixtureSeed.makeQueue([fixtureSeed.g1AsQueue, fixtureSeed.q1]),
          });
        });
        state = await read();
        assert.equal(state.pendingIsEmpty, true);
        assert.deepEqual(state.visibleIds, ["g1", "q1"]);
        assert.equal(state.renderCounts.pending, 5);
        assert.equal(state.renderCounts.visible, visibleBeforeDelivery + 1);

        // 顺序变化立即更新（成员集合相同但顺序不同）。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({
            queue: fixtureSeed.makeQueue([fixtureSeed.q1, fixtureSeed.g1Changed, fixtureSeed.g2]),
          });
        });
        state = await read();
        assert.deepEqual(state.pendingIds, ["g1", "g2"]);
        const countAfterOrdered = state.renderCounts.pending;

        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({
            queue: fixtureSeed.makeQueue([fixtureSeed.q1, fixtureSeed.g2, fixtureSeed.g1Changed]),
          });
        });
        state = await read();
        assert.deepEqual(state.pendingIds, ["g2", "g1"]);
        assert.equal(state.pendingSame, false);
        assert.equal(state.renderCounts.pending, countAfterOrdered + 1);

        // pending guide 作用域改变：即使 queue 对象引用相同，也不复用旧投影。
        await mark();
        await apply(() => {
          globalThis.__fixture.scope({ workspaceIdentity: "ident-2" });
        });
        state = await read();
        assert.equal(state.pendingSame, false, "工作区/会话作用域变化不得复用 pendingGuides");

        // ── knownSessionIds ──
        const idsCount = async () => (await read()).renderCounts.ids;

        // 同成员、不同顺序的新 Set：复用旧引用，memo 子组件不重渲染。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({ ids: fixtureSeed.ids(["sess-b", "sess-a"]) });
        });
        state = await read();
        assert.equal(state.idsSame, true, "成员顺序变化不重建集合引用");
        assert.equal(await idsCount(), 2);

        // 元数据变化（父级重渲染）不改引用。
        await mark();
        await apply(() => {
          globalThis.__fixture.apply({ meta: 1 });
        });
        state = await read();
        assert.equal(state.idsSame, true);
        assert.equal(await idsCount(), 2);

        // 成员增删立即更新。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({ ids: fixtureSeed.ids(["sess-a", "sess-b", "sess-c"]) });
        });
        state = await read();
        assert.equal(state.idsSame, false);
        assert.equal(state.idsSize, 3);
        assert.equal(await idsCount(), 3);

        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({ ids: fixtureSeed.ids(["sess-a"]) });
        });
        state = await read();
        assert.equal(state.idsSame, false);
        assert.equal(await idsCount(), 4);

        // undefined fail-open 与就绪切换都要更新引用。
        await mark();
        await apply(() => {
          globalThis.__fixture.apply({ ids: undefined });
        });
        state = await read();
        assert.equal(state.idsSame, false);
        assert.equal(state.idsUndefined, true);
        assert.equal(await idsCount(), 5);

        await mark();
        await apply(() => {
          globalThis.__fixture.bump();
        });
        state = await read();
        assert.equal(state.idsSame, true, "undefined 状态在无关更新下保持引用");
        assert.equal(await idsCount(), 5);

        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.apply({ ids: fixtureSeed.ids(["sess-a"]) });
        });
        state = await read();
        assert.equal(state.idsUndefined, false);
        assert.equal(state.idsSame, false);
        assert.equal(await idsCount(), 6);

        // 来源与 next 引用固定、仅 scope 变化：旧实现会直接复用同一个非空 Set。
        await mark();
        await apply(() => {
          globalThis.__fixture.scope({ workspaceIdentity: "ident-3" });
        });
        state = await read();
        assert.equal(state.idsSame, false, "同一 next 引用跨 scope 必须返回新 Set");
        assert.equal(state.idsSize, 1);
        assert.equal(await idsCount(), 7);

        // 作用域变化：同成员的新 Set 不得复用旧集合。
        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.scope({ sessionId: "sess-2" });
          globalThis.__fixture.apply({ ids: fixtureSeed.ids(["sess-a"]) });
        });
        state = await read();
        assert.equal(state.idsSame, false, "会话作用域变化不得复用 knownSessionIds");
        assert.equal(await idsCount(), 8);

        await mark();
        await apply(() => {
          const { seed: fixtureSeed } = globalThis.__fixture;
          globalThis.__fixture.scope({ remoteSessionId: "remote-1" });
          globalThis.__fixture.apply({ ids: fixtureSeed.ids(["sess-a"]) });
        });
        state = await read();
        assert.equal(state.idsSame, false, "远程作用域变化不得复用 knownSessionIds");
        assert.equal(await idsCount(), 9);

        assert.deepEqual(errors, []);
        t.diagnostic(
          `derived stability render counts: ${JSON.stringify((await read()).renderCounts)}`,
        );
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
