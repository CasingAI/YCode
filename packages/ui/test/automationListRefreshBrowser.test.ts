// 自动化列表周期刷新的行为测试：在测试自己的 Chromium 中挂载真实 hook，
// 覆盖周期、空列表、失焦/可见性、保活表面重新激活、清理与请求合并。
// 不连接、不操作正在运行的 YCode；没有独立 Chromium 时显式跳过。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadChromium, uiRoot } from "./helpers/chromiumFixture.js";

const INTERVAL_MS = 200;

function hookPath(): string {
  return JSON.stringify(
    join(uiRoot, "src", "hooks", "useActiveSurfaceRefresh.ts").replace(/\\/g, "/"),
  );
}

function fixtureSource(): string {
  return `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useActiveSurfaceRefresh } from ${hookPath()};

// 两类列表都为空的场景：刷新入口仍必须被调用，周期刷新不是按任务数短路。
const runtime = {
  scheduledCalls: 0,
  offPeakCalls: 0,
  holdRefresh: false,
  pendingResolvers: [],
  setActive: null,
  initialActive: true,
  intervalMs: ${INTERVAL_MS},
  manualCompleted: 0,
  callManualRefresh: null,
};
globalThis.__runtime = runtime;

function refreshAutomationLists() {
  runtime.scheduledCalls += 1;
  runtime.offPeakCalls += 1;
  if (!runtime.holdRefresh) return Promise.resolve();
  return new Promise((resolve) => runtime.pendingResolvers.push(resolve));
}

function Fixture() {
  const [active, setActive] = useState(() => runtime.initialActive !== false);
  useEffect(() => {
    runtime.setActive = setActive;
    return () => {
      runtime.setActive = null;
    };
  }, []);
  const refreshNow = useActiveSurfaceRefresh({
    active,
    refresh: refreshAutomationLists,
    intervalMs: runtime.intervalMs,
  });
  useEffect(() => {
    runtime.callManualRefresh = () => {
      const promise = refreshNow();
      void promise.then(() => {
        runtime.manualCompleted += 1;
      });
      return promise;
    };
    return () => {
      runtime.callManualRefresh = null;
    };
  }, [refreshNow]);
  return <div data-testid="ready">ready</div>;
}

let currentRoot = createRoot(document.getElementById("root"));
let mounted = true;
currentRoot.render(<Fixture />);
globalThis.__unmount = () => {
  if (!mounted) return;
  mounted = false;
  currentRoot.unmount();
};
// 以「挂载时不可见」重新挂载，验证首次激活也立即刷新，不必等一个周期。
// 用较长的周期确保激活后的第一个请求不可能来自定时器。
globalThis.__remount = (initialActive, intervalMs = ${INTERVAL_MS}) => {
  if (mounted) {
    mounted = false;
    currentRoot.unmount();
  }
  runtime.initialActive = initialActive;
  runtime.intervalMs = intervalMs;
  currentRoot = createRoot(document.getElementById("root"));
  currentRoot.render(<Fixture />);
  mounted = true;
};
`;
}

test(
  "自动化列表周期刷新覆盖空列表、焦点、可见性、重新激活、清理与请求合并",
  { timeout: 90_000 },
  async (t) => {
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑列表刷新测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-automation-list-refresh-"));
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
        await page.evaluate(() => {
          let visibility = "visible";
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => visibility,
          });
          Object.defineProperty(document, "hidden", {
            configurable: true,
            get: () => visibility === "hidden",
          });
          globalThis.__setVisibility = (next) => {
            visibility = next;
            document.dispatchEvent(new Event("visibilitychange"));
          };
        });
        await page.addScriptTag({ path: bundle });
        await page.getByTestId("ready").waitFor();

        const read = () =>
          page.evaluate(() => {
            const runtime = globalThis.__runtime;
            return {
              scheduled: runtime.scheduledCalls,
              offPeak: runtime.offPeakCalls,
            };
          });
        const waitForCalls = async (minimum: number) => {
          await page.waitForFunction(
            (expected) =>
              globalThis.__runtime.scheduledCalls >= expected &&
              globalThis.__runtime.offPeakCalls >= expected,
            minimum,
            { timeout: 3_000 },
          );
        };
        const setActive = (active: boolean) =>
          page.evaluate((next) => globalThis.__runtime.setActive(next), active);
        const dispatchFocus = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
        const setVisibility = (next: "visible" | "hidden") =>
          page.evaluate((value) => globalThis.__setVisibility(value), next);
        const setHoldRefresh = (hold: boolean) =>
          page.evaluate((value) => {
            globalThis.__runtime.holdRefresh = value;
          }, hold);
        const resolvePending = () =>
          page.evaluate(() => {
            const resolvers = globalThis.__runtime.pendingResolvers;
            globalThis.__runtime.pendingResolvers = [];
            for (const resolve of resolvers) resolve();
          });

        // 首次挂载只交给 initialize，不额外立刻请求；空列表照常进入周期。
        await page.waitForTimeout(60);
        assert.deepEqual(await read(), { scheduled: 0, offPeak: 0 });
        await waitForCalls(2);

        // 失活即停止，重新激活立即刷新并恢复周期。
        await setActive(false);
        await page.waitForTimeout(50);
        const beforeDeactivate = await read();
        await page.waitForTimeout(INTERVAL_MS * 2);
        assert.deepEqual(await read(), beforeDeactivate);
        await setActive(true);
        await waitForCalls(beforeDeactivate.scheduled + 1);
        await waitForCalls(beforeDeactivate.scheduled + 2);

        // 窗口聚焦立即刷新。
        const beforeFocus = await read();
        await dispatchFocus();
        await waitForCalls(beforeFocus.scheduled + 1);

        // document 隐藏时暂停；恢复可见立即刷新并恢复周期。
        await setVisibility("hidden");
        const beforeHidden = await read();
        await page.waitForTimeout(INTERVAL_MS * 2);
        assert.deepEqual(await read(), beforeHidden);
        await setVisibility("visible");
        await waitForCalls(beforeHidden.scheduled + 1);
        await waitForCalls(beforeHidden.scheduled + 2);

        // 隐藏期间 active false→true 也不得刷新（激活分支不能绕过隐藏暂停）；
        // 恢复可见时立即刷新并恢复周期。
        await setVisibility("hidden");
        const beforeHiddenActivation = await read();
        await setActive(false);
        await setActive(true);
        await page.waitForTimeout(INTERVAL_MS * 2);
        assert.deepEqual(await read(), beforeHiddenActivation);
        await setVisibility("visible");
        await waitForCalls(beforeHiddenActivation.scheduled + 1);
        await waitForCalls(beforeHiddenActivation.scheduled + 2);

        // 刷新在途时再次触发只合并为一次尾随刷新，不堆叠请求。
        await setHoldRefresh(true);
        const beforeOverlap = await read();
        await dispatchFocus();
        await page.waitForFunction(
          (expected) => globalThis.__runtime.scheduledCalls === expected,
          beforeOverlap.scheduled + 1,
          { timeout: 3_000 },
        );
        await dispatchFocus();
        await page.waitForTimeout(INTERVAL_MS * 2);
        assert.equal((await read()).scheduled, beforeOverlap.scheduled + 1);
        await setHoldRefresh(false);
        await resolvePending();
        await page.waitForFunction(
          (expected) => globalThis.__runtime.scheduledCalls === expected,
          beforeOverlap.scheduled + 2,
          { timeout: 3_000 },
        );

        // 卸载后定时器与监听全部清理。
        await page.evaluate(() => globalThis.__unmount());
        const beforeUnmount = await read();
        await page.waitForTimeout(INTERVAL_MS * 3);
        assert.deepEqual(await read(), beforeUnmount);

        // 手动刷新与自动触发共用单飞：空闲时立即刷新；在途时并入当前请求，不重复发请求。
        // 用长周期排除定时器干扰，确保这一次只能由手动入口发起。
        await page.evaluate(() => globalThis.__remount(true, 60_000));
        await page.waitForFunction(
          () => typeof globalThis.__runtime.callManualRefresh === "function",
        );
        await setHoldRefresh(true);
        const beforeManual = await read();
        // 手动入口返回被合并刷新的 Promise；evaluate 不要 await 它（刷新被故意挂起）。
        await page.evaluate(() => {
          void globalThis.__runtime.callManualRefresh();
        });
        await page.waitForFunction(
          (expected) => globalThis.__runtime.scheduledCalls >= expected,
          beforeManual.scheduled + 1,
          { timeout: 3_000 },
        );
        await page.evaluate(() => {
          void globalThis.__runtime.callManualRefresh();
        });
        await page.waitForTimeout(80);
        assert.equal((await read()).scheduled, beforeManual.scheduled + 1);
        await setHoldRefresh(false);
        await resolvePending();
        await page.waitForFunction(() => globalThis.__runtime.manualCompleted >= 1, null, {
          timeout: 3_000,
        });

        // 以不可见状态挂载（保活层被设置/文件视图覆盖）：不轮询；
        // 首次激活立即刷新，而不是等一个周期。
        await page.evaluate(() => globalThis.__unmount());
        await page.evaluate(() => globalThis.__remount(false, 60_000));
        const beforeInactiveMount = await read();
        await page.waitForTimeout(INTERVAL_MS * 3);
        assert.deepEqual(await read(), beforeInactiveMount);
        await setActive(true);
        await page.waitForFunction(
          (expected) => globalThis.__runtime.scheduledCalls >= expected,
          beforeInactiveMount.scheduled + 1,
          { timeout: 1_000 },
        );

        // 首次挂载时 document 已隐藏：不立即请求；恢复可见立即刷新。
        await page.evaluate(() => globalThis.__unmount());
        await setVisibility("hidden");
        await page.evaluate(() => globalThis.__remount(true, 60_000));
        await page.waitForFunction(
          () => typeof globalThis.__runtime.callManualRefresh === "function",
        );
        const beforeHiddenMount = await read();
        await page.waitForTimeout(INTERVAL_MS * 2);
        assert.deepEqual(await read(), beforeHiddenMount);
        await setVisibility("visible");
        await page.waitForFunction(
          (expected) => globalThis.__runtime.scheduledCalls >= expected,
          beforeHiddenMount.scheduled + 1,
          { timeout: 1_000 },
        );

        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
