import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 真实执行 useOptimisticReorder：页面内 deferred promise 控制 persist 的完成/失败时刻。
// 只启动本测试自己的无头浏览器，不连接也不操作正在运行的 YCode。

const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const uiRoot = fileURLToPath(new URL("..", import.meta.url));

async function findChromium(bundledPath: string): Promise<string | undefined> {
  const directories = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  const candidates = [
    process.env.ZCODE_TEST_CHROMIUM_PATH,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    bundledPath,
    ...directories.flatMap((directory) => [
      join(directory, "Google", "Chrome", "Application", "chrome.exe"),
      join(directory, "Chromium", "Application", "chrome.exe"),
    ]),
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 未安装独立浏览器时显式跳过，不连接运行中的应用或下载浏览器。
    }
  }
  return undefined;
}

async function resolveSource(candidate: string): Promise<string | undefined> {
  const stem = candidate.endsWith(".js") ? candidate.slice(0, -3) : candidate;
  for (const file of [
    candidate,
    ...[".ts", ".tsx", ".js", ".json"].map((ext) => `${stem}${ext}`),
  ]) {
    try {
      await access(file);
      return file;
    } catch {
      // 源码的 .js 导入在隔离 fixture 中解析到对应 TypeScript 文件。
    }
  }
  return undefined;
}

const fixtureSource = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useOptimisticReorder } from "@/settings/useOptimisticReorder.js";

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

const deferreds: Deferred[] = [];
const starts: string[][] = [];
const settles: string[][] = [];
const failures: string[] = [];

function persist(ids: readonly string[]): Promise<void> {
  starts.push([...ids]);
  return new Promise<void>((resolve, reject) => {
    deferreds.push({
      resolve: () => {
        settles.push([...ids]);
        resolve();
      },
      reject,
    });
  });
}

function Fixture() {
  const [authoritative, setAuthoritative] = useState(["a", "b", "c"]);
  const { renderedIds, commit } = useOptimisticReorder({ authoritativeIds: authoritative, persist });
  (globalThis as any).__reorder = {
    starts,
    settles,
    failures,
    deferredCount: () => deferreds.length,
    commit: (ids: string[]) => {
      void commit(ids).catch((error: unknown) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
    },
    settle: (index: number, ok: boolean) => {
      const deferred = deferreds[index];
      if (!deferred) throw new Error("missing deferred " + index);
      if (ok) deferred.resolve();
      else deferred.reject(new Error("persist failed"));
    },
    setAuthoritative,
  };
  return (
    <ul data-testid="reorder-order">
      {renderedIds.map((id) => (
        <li key={id} data-id={id}>{id}</li>
      ))}
    </ul>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
`;

test(
  "独立浏览器执行 useOptimisticReorder 的 pending/串行/回退语义",
  {
    timeout: 120_000,
  },
  async (t) => {
    const { chromium } = desktopRequire("playwright-core") as typeof import("playwright-core");
    const executablePath = await findChromium(chromium.executablePath());
    if (!executablePath) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑乐观排序执行测试");
      return;
    }
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-web-search-reorder-"));
    const bundle = join(directory, "fixture.js");
    try {
      await writeFile(join(directory, "entry.tsx"), fixtureSource);
      await build({
        entryPoints: [join(directory, "entry.tsx")],
        outfile: bundle,
        bundle: true,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        target: ["chrome120"],
        logLevel: "silent",
        nodePaths: [join(uiRoot, "node_modules"), join(uiRoot, "..", "..", "node_modules")],
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
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }

    let browser: import("playwright-core").Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath, headless: true });
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const load = async () => {
        await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
        await page.addScriptTag({ path: bundle });
        await page.waitForSelector('[data-testid="reorder-order"] li');
      };
      const readOrder = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid="reorder-order"] li')).map((element) =>
            element.getAttribute("data-id"),
          ),
        );
      const expectOrder = async (expected: string[], label: string) => {
        await page.waitForFunction(
          (want) =>
            Array.from(document.querySelectorAll('[data-testid="reorder-order"] li'))
              .map((element) => element.getAttribute("data-id"))
              .join("|") === want.join("|"),
          expected,
        );
        assert.deepEqual(await readOrder(), expected, label);
      };
      const readProbe = () =>
        page.evaluate(() => {
          const probe = (globalThis as any).__reorder;
          return {
            starts: probe.starts.map((ids: string[]) => [...ids]),
            settles: probe.settles.map((ids: string[]) => [...ids]),
            failures: [...probe.failures],
            deferredCount: probe.deferredCount(),
          };
        });
      const commit = (ids: string[]) =>
        page.evaluate((next) => (globalThis as any).__reorder.commit(next), ids);
      const settle = (index: number, ok: boolean) =>
        page.evaluate((input) => (globalThis as any).__reorder.settle(input.index, input.ok), {
          index,
          ok,
        });

      await t.test("persist 悬而未决时顺序已切换，连续 commit 串行并保留最新 pending", async () => {
        await load();
        await expectOrder(["a", "b", "c"], "初始顺序应为权威顺序");

        await commit(["c", "a", "b"]);
        await expectOrder(["c", "a", "b"], "末项置顶后不等待 persist 完成即应换序");
        let probe = await readProbe();
        assert.deepEqual(probe.starts, [["c", "a", "b"]], "应只启动一笔持久化");
        assert.deepEqual(probe.settles, [], "持久化尚未完成");
        assert.equal(probe.deferredCount, 1);

        await commit(["b", "c", "a"]);
        await expectOrder(["b", "c", "a"], "连续排序应显示最新 pending");
        probe = await readProbe();
        assert.equal(probe.starts.length, 1, "第二笔必须等第一笔持久化结束后再启动");
        assert.equal(probe.deferredCount, 1);

        await settle(0, true);
        await page.waitForFunction(() => (globalThis as any).__reorder.starts.length === 2);
        probe = await readProbe();
        assert.deepEqual(probe.starts, [
          ["c", "a", "b"],
          ["b", "c", "a"],
        ]);
        assert.deepEqual(probe.settles, [["c", "a", "b"]]);
        await expectOrder(["b", "c", "a"], "第一笔完成后仍显示最新的第二笔 pending");

        await settle(1, true);
        await page.waitForFunction(() => (globalThis as any).__reorder.settles.length === 2);
        await expectOrder(["b", "c", "a"], "权威未回读前继续保留最新 pending");

        await page.evaluate(() => (globalThis as any).__reorder.setAuthoritative(["b", "c", "a"]));
        await expectOrder(["b", "c", "a"], "权威回读同序后清 pending 但顺序不变");
      });

      await t.test("最新一笔失败时回退权威顺序并记录错误", async () => {
        await load();
        await commit(["c", "a", "b"]);
        await expectOrder(["c", "a", "b"], "失败前先按 pending 换序");
        await settle(0, false);
        await expectOrder(["a", "b", "c"], "最新 pending 失败应回退权威顺序");
        const probe = await readProbe();
        assert.deepEqual(probe.failures, ["persist failed"], "失败应被抛出并记录");
      });

      await t.test("过期失败不得清除最新的 pending", async () => {
        await load();
        await commit(["c", "a", "b"]);
        await expectOrder(["c", "a", "b"], "第一笔 pending");
        await commit(["b", "c", "a"]);
        await expectOrder(["b", "c", "a"], "第二笔 pending");

        await settle(0, false);
        await page.waitForFunction(() => (globalThis as any).__reorder.starts.length === 2);
        const probe = await readProbe();
        assert.deepEqual(probe.failures, ["persist failed"]);
        await expectOrder(["b", "c", "a"], "第一笔迟到失败不能回退最新 pending");

        await settle(1, true);
        await page.waitForFunction(() => (globalThis as any).__reorder.settles.length === 1);
        await expectOrder(["b", "c", "a"], "第二笔成功且权威未回读时顺序保持");
        assert.deepEqual(pageErrors, [], "页面不应出现未捕获错误");
      });
    } finally {
      await browser?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
