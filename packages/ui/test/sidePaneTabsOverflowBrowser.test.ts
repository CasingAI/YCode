import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

// 真实浏览器验证 useSidePaneTabsOverflow：只启动测试自己的 Chromium 与临时 profile，
// 不连接、不注入、不操作正在运行的 YCode。
// fixture 复刻侧栏最小结构：viewport / content / 新增按钮（内容末尾或右侧栏），
// 标签宽度固定 60px、间距 4px、按钮 28px，正好对应 resolveSidePaneTabsOverflow 的预算。

const TAB_WIDTH_PX = 60;
const ADD_WIDTH_PX = 28;
const GAP_PX = 4;
const BASELINE_WIDTH_PX = 320;

function sourcePath(relative: string): string {
  return JSON.stringify(join(uiRoot, "src", relative).replace(/\\/g, "/"));
}

function fixtureSource(): string {
  return `
import { useMemo, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { useSidePaneTabsOverflow } from ${sourcePath("app-shell/useSidePaneTabsOverflow.ts")};

const TAB_WIDTH = ${TAB_WIDTH_PX};
const ADD_WIDTH = ${ADD_WIDTH_PX};
const GAP = ${GAP_PX};

const initialStore = { ids: ["a", "b", "c", "d"], titles: {}, width: ${BASELINE_WIDTH_PX}, hidden: false };
let store = { ...initialStore, revision: 0 };
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return store;
}

globalThis.__setStore = (patch) => {
  store = { ...store, ...patch, revision: store.revision + 1 };
  emit();
};

globalThis.__resetStore = () => {
  store = { ...initialStore, revision: store.revision + 1 };
  emit();
};

const counters = {
  scrollWidth: 0,
  clientWidth: 0,
  addRect: 0,
  created: 0,
  disconnected: 0,
  observed: 0,
};
globalThis.__counters = counters;
globalThis.__resetGeometryCounts = () => {
  counters.scrollWidth = 0;
  counters.clientWidth = 0;
  counters.addRect = 0;
};

// 统计 observer 生命周期：同一批 DOM 节点上可见性/标题变化只应失效几何，
// 不应重新构造或 disconnect observer。
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class CountingResizeObserver extends NativeResizeObserver {
  constructor(callback) {
    super(callback);
    counters.created += 1;
  }

  observe(...args) {
    counters.observed += 1;
    return super.observe(...args);
  }

  disconnect() {
    counters.disconnected += 1;
    return super.disconnect();
  }
};

function instrumentViewport(element) {
  if (!element || element.__instrumented) return;
  element.__instrumented = true;
  const scrollWidthGetter = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth").get;
  const clientWidthGetter = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth").get;
  Object.defineProperty(element, "scrollWidth", {
    configurable: true,
    get() {
      counters.scrollWidth += 1;
      return scrollWidthGetter.call(element);
    },
  });
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    get() {
      counters.clientWidth += 1;
      return clientWidthGetter.call(element);
    },
  });
}

function instrumentAddButton(element) {
  if (!element || element.__instrumented) return;
  element.__instrumented = true;
  const rect = element.getBoundingClientRect.bind(element);
  element.getBoundingClientRect = () => {
    counters.addRect += 1;
    return rect();
  };
}

function Fixture() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const visibleTabs = useMemo(
    () => snapshot.ids.map((id) => ({ id, title: snapshot.titles[id] ?? id })),
    [snapshot.revision],
  );
  const { isOverflowing, maskEdges } = useSidePaneTabsOverflow({
    viewportRef,
    contentRef,
    tabCount: visibleTabs.length,
    visibleTabs,
    invalidationKey: "owner",
    enabled: true,
  });

  const addButton = (
    <button
      data-side-pane-add-tab-trigger=""
      ref={instrumentAddButton}
      style={{ flex: "0 0 auto", width: ADD_WIDTH, height: 28, padding: 0, border: "none", boxSizing: "border-box" }}
    >
      +
    </button>
  );

  return (
    <div
      data-side-pane=""
      data-overflowing={String(isOverflowing)}
      data-mask-left={String(maskEdges.left)}
      data-mask-right={String(maskEdges.right)}
      style={{
        display: snapshot.hidden ? "none" : "flex",
        width: snapshot.width,
        height: 48,
        boxSizing: "border-box",
      }}
    >
      <div
        ref={(element) => {
          viewportRef.current = element;
          instrumentViewport(element);
        }}
        data-viewport=""
        style={{
          display: "flex",
          flex: "1 1 0",
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          boxSizing: "border-box",
        }}
      >
        <div
          ref={contentRef}
          data-content=""
          style={{ display: "flex", width: "100%", flex: "0 0 auto", gap: GAP, boxSizing: "border-box" }}
        >
          {visibleTabs.map((tab) => (
            <div
              key={tab.id}
              data-tab=""
              style={{
                flex: "0 0 " + TAB_WIDTH + "px",
                width: TAB_WIDTH,
                height: 28,
                overflow: "hidden",
                boxSizing: "border-box",
              }}
            >
              {tab.title}
            </div>
          ))}
          {!isOverflowing ? addButton : null}
        </div>
      </div>
      <div data-rail="" style={{ display: "flex", flex: "0 0 auto", width: isOverflowing ? ADD_WIDTH : 0 }}>
        {isOverflowing ? addButton : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

async function waitFrames(page: any, frames: number): Promise<void> {
  await page.evaluate(async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame(null)));
    }
  }, frames);
}

async function readOverflow(page: any): Promise<boolean> {
  return (await page.getAttribute("[data-side-pane]", "data-overflowing")) === "true";
}

async function readMask(page: any): Promise<{ left: boolean; right: boolean }> {
  return {
    left: (await page.getAttribute("[data-side-pane]", "data-mask-left")) === "true",
    right: (await page.getAttribute("[data-side-pane]", "data-mask-right")) === "true",
  };
}

async function readAddButtonParent(page: any): Promise<string> {
  return page.evaluate(() => {
    const button = document.querySelector("[data-side-pane-add-tab-trigger]");
    if (!button) return "missing";
    return button.parentElement?.hasAttribute("data-rail") ? "rail" : "content";
  });
}

async function setStore(page: any, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((value) => {
    (globalThis as any).__setStore(value);
  }, patch);
}

async function resetStore(page: any): Promise<void> {
  await page.evaluate(() => {
    (globalThis as any).__resetStore();
  });
  await waitFrames(page, 3);
}

async function waitForOverflow(page: any, expected: boolean): Promise<void> {
  await page.waitForFunction(
    (value: boolean) =>
      document.querySelector("[data-side-pane]")?.getAttribute("data-overflowing") ===
      String(value),
    expected,
    { timeout: 5000 },
  );
}

test(
  "侧栏 tabs overflow hook：真实浏览器几何、mask 与 observer 生命周期",
  { timeout: 180_000 },
  async (t) => {
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑侧栏 tabs 浏览器测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-sidepane-tabs-overflow-"));
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
        loader: {
          ".svg": "dataurl",
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".webp": "dataurl",
          ".mp3": "dataurl",
          ".wav": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
        },
        plugins: [
          {
            name: "ui-source",
            setup(builder) {
              builder.onResolve({ filter: /^@\// }, async (args) => {
                const path = await resolveSource(resolve(uiRoot, "src", args.path.slice(2)));
                return path ? { path } : undefined;
              });
              builder.onResolve({ filter: /\.js$/ }, async (args) => {
                if (!args.path.startsWith(".")) return undefined;
                const path = await resolveSource(resolve(args.resolveDir, args.path));
                return path ? { path } : undefined;
              });
            },
          },
        ],
      });

      const context = await chromium.launchPersistentContext(join(directory, "profile"), {
        executablePath,
        headless: true,
        viewport: { width: 1200, height: 800 },
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html class="theme-zai-light"><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addStyleTag({
          content: "html,body,#root{margin:0} body{overflow:hidden}",
        });
        await page.addScriptTag({ path: bundle });
        await page.locator("[data-side-pane]").waitFor({ timeout: 15_000 });
        await waitFrames(page, 3);

        await t.test("临界宽度 ±2px：60px 预算与 1px 容差临界处不振荡", async () => {
          // 4 个 tab：内容预算 4*60 + 3*4 + 4 + 28 = 284。判 overflow 的条件是
          // 284 > viewport + 1，因此 282 溢出、283 起不溢出。
          await resetStore(page);
          for (const [width, expected] of [
            [281, true],
            [282, true],
            [283, false],
            [284, false],
          ] as const) {
            await setStore(page, { width });
            await waitForOverflow(page, expected);
            for (let frame = 0; frame < 8; frame += 1) {
              await waitFrames(page, 1);
              assert.equal(await readOverflow(page), expected, `width=${width} 时不得振荡`);
            }
            assert.equal(
              await readAddButtonParent(page),
              expected ? "rail" : "content",
              `width=${width} 时新增按钮位置必须与 overflow 一致`,
            );
          }
        });

        await t.test("overflow 翻转后等真实 DOM 提交再重测，不在 setState 后读旧布局", async () => {
          await resetStore(page);
          await waitForOverflow(page, false);
          await waitFrames(page, 3);

          // 翻转发生前清零计数：按钮换边后的下一轮几何测量必须真实发生，且读取的是
          // 已提交的新 DOM（按钮已不在 content 内、viewport 少掉按钮宽度）。
          await page.evaluate(() => {
            (globalThis as any).__resetGeometryCounts();
          });
          await setStore(page, { width: 270 });
          await waitForOverflow(page, true);
          await waitFrames(page, 4);

          const counters = await page.evaluate(() => ({ ...(globalThis as any).__counters }));
          assert.ok(counters.scrollWidth > 0, "翻转后必须重新测量几何");
          assert.equal(await readAddButtonParent(page), "rail");
          // 换边后的测量没有再次翻转：同帧读取的是提交后的布局，而不是旧的 content 结构。
          assert.equal(await readOverflow(page), true);
        });

        await t.test("标签增删、重排与标题变化只失效几何，不重建 observer", async () => {
          await resetStore(page);
          const initialCounters = await page.evaluate(() => ({
            ...(globalThis as any).__counters,
          }));
          assert.equal(initialCounters.created, 1, "绑定后只应创建一个 ResizeObserver");
          assert.equal(initialCounters.disconnected, 0);

          // 重排：成员与结构不变，仅数组身份变化。
          await setStore(page, { ids: ["d", "c", "b", "a"] });
          await waitFrames(page, 3);
          assert.equal(await readOverflow(page), false);

          // 标题变化：tab 宽度固定 60px，几何结果必须保持，但 hook 仍应接受失效通知。
          await setStore(page, { titles: { d: "a much longer replacement title" } });
          await waitFrames(page, 3);
          assert.equal(await readOverflow(page), false);

          // 增删：新增到 8 个后溢出，关闭回 2 个后恢复。
          await setStore(page, { ids: ["a", "b", "c", "d", "e", "f", "g", "h"] });
          await waitForOverflow(page, true);
          assert.equal(await readAddButtonParent(page), "rail");
          await setStore(page, { ids: ["a", "b"] });
          await waitForOverflow(page, false);
          assert.equal(await readAddButtonParent(page), "content");

          const counters = await page.evaluate(() => ({ ...(globalThis as any).__counters }));
          assert.equal(counters.created, 1, "标签变化不得重建 ResizeObserver");
          assert.equal(counters.disconnected, 0, "标签变化不得 disconnect observer");
        });

        await t.test("稳定尺寸下普通滚动只读 scrollLeft 和有效几何缓存", async () => {
          await resetStore(page);
          await setStore(page, { width: 260 });
          await waitForOverflow(page, true);
          await waitFrames(page, 3);
          assert.equal(await readAddButtonParent(page), "rail");

          await page.evaluate(() => {
            (globalThis as any).__resetGeometryCounts();
            const viewport = document.querySelector("[data-viewport]");
            viewport.scrollLeft = 10;
            viewport.dispatchEvent(new Event("scroll"));
          });
          await waitFrames(page, 3);

          const counters = await page.evaluate(() => ({ ...(globalThis as any).__counters }));
          assert.equal(counters.scrollWidth, 0, "普通滚动不得读取 scrollWidth");
          assert.equal(counters.clientWidth, 0, "普通滚动不得读取 clientWidth");
          assert.equal(counters.addRect, 0, "普通滚动不得读取新增按钮矩形");
          assert.deepEqual(await readMask(page), { left: true, right: true });
        });

        await t.test("零宽隐藏不更新按钮位置，恢复可见后重新测量", async () => {
          await resetStore(page);
          assert.equal(await readOverflow(page), false);
          const before = await readAddButtonParent(page);
          assert.equal(before, "content");

          // display:none 时 clientWidth 为 0：即使标签数量已经会溢出，也不能据此移动按钮。
          await setStore(page, { hidden: true });
          await waitFrames(page, 3);
          await setStore(page, { ids: ["a", "b", "c", "d", "e", "f", "g", "h"] });
          await waitFrames(page, 4);
          assert.equal(await readOverflow(page), false, "零宽时不得更新 overflow 按钮位置");

          await setStore(page, { hidden: false });
          await waitForOverflow(page, true);
          assert.equal(await readAddButtonParent(page), "rail");
        });

        await t.test("两端 mask 与 active smooth scroll 不被 mask 调度取消", async () => {
          await resetStore(page);
          await setStore(page, { width: 260 });
          await waitForOverflow(page, true);
          await waitFrames(page, 3);

          assert.deepEqual(
            await readMask(page),
            { left: false, right: true },
            "起点只显示右端 mask",
          );

          // 模拟 active tab 的 smooth scrollBy：mask 调度只跟随位置更新，不得取消滚动。
          await page.evaluate(() => {
            const viewport = document.querySelector("[data-viewport]");
            viewport.scrollBy({ left: 40, behavior: "smooth" });
          });
          await page.waitForFunction(
            () => (document.querySelector("[data-viewport]")?.scrollLeft ?? 0) >= 19,
            undefined,
            { timeout: 5000 },
          );
          await waitFrames(page, 3);
          const scrollLeft = await page.evaluate(
            () => document.querySelector("[data-viewport]")?.scrollLeft ?? 0,
          );
          const maxScrollLeft = await page.evaluate(() => {
            const viewport = document.querySelector("[data-viewport]");
            return Math.max(0, viewport.scrollWidth - viewport.clientWidth);
          });
          assert.ok(scrollLeft > 0, "smooth scroll 未被 mask 调度取消");
          assert.equal(await readOverflow(page), true, "滚动过程不得改变 overflow 判定");
          assert.deepEqual(
            await readMask(page),
            { left: scrollLeft > 1, right: scrollLeft < maxScrollLeft - 1 },
            "mask 必须跟随最终真实 scrollLeft",
          );
        });

        assert.deepEqual(errors, [], "页面不得出现运行时异常");
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
