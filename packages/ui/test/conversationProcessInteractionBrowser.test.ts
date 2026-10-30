import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

// 隔离的真实浏览器交互回归：只启动本测试自己的 Chromium 与临时 profile，
// 不连接、不下载、不操作正在运行的 YCode。
//
// 这里的 fixture 不复制折叠算法，而是直接挂载真实 owner 路径：
//   ConversationRow[] → buildConversationTurnRenderUnitFrame() → ConversationTurnGroup
// 前者是时间线使用的同一份 turn 投影，后者是会话消息流真实渲染组件。
// 场景覆盖本次 fix 的两条产品规则：
//   1. EnterPlanMode 成功 / 失败 / 拒绝都是普通工具调用行，不渲染成计划审批卡；
//      CreatePlan 仍独占计划卡。
//   2. Bash → JSVM(Sandbox) → Bash 结束后属于同一个过程段，摘要为
//      「终端 2 次 · 沙盒 1 次」，展开后按原行序看到 Bash 行、沙盒卡、Bash 行，
//      沙盒卡可继续展开看源码与输出。

const sourcePath = (name: string) => JSON.stringify(join(uiRoot, "src", name).replace(/\\/g, "/"));

function fixtureSource(): string {
  return `
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildConversationTurnRenderUnitFrame } from ${sourcePath("v4/conversationTurnRenderUnits.ts")};
import { ConversationTurnGroup } from ${sourcePath("v4/ConversationTurnGroup.tsx")};
import { ZCodeIntlProvider } from ${sourcePath("i18n/IntlProvider.tsx")};
import { TooltipProvider } from ${sourcePath("components/ui/tooltip.tsx")};
import { PlatformProvider } from ${sourcePath("hooks/usePlatform.tsx")};
import { ServiceProvider } from ${sourcePath("hooks/useServices.tsx")};
import { DEFAULT_CODE_PREVIEW_SETTINGS } from ${sourcePath("lib/codePreviewSettings.ts")};

const TURN_ID = "turn-1";

function headerRow(state) {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: TURN_ID,
    origin: "userInput",
    executionKind: "agent",
    state,
    startedAt: 1,
    endedAt: state === "running" ? undefined : 2,
    createdAt: 1,
    createdAtSeq: 1,
  };
}

const USER_ROW = {
  kind: "userInput",
  rowId: 2,
  turnId: TURN_ID,
  createdAt: 2,
  createdAtSeq: 2,
  text: "先出方案再动手",
  origin: "realUser",
};

function toolRow(rowId, toolName, extra = {}) {
  return {
    kind: "toolCall",
    rowId,
    turnId: TURN_ID,
    createdAt: rowId,
    createdAtSeq: rowId,
    toolCallId: "call-" + rowId,
    toolName,
    status: "success",
    inputText: "{}",
    input: {},
    ...extra,
  };
}

const SCENARIOS = {
  enter: () => [
    headerRow("completedSuccess"),
    USER_ROW,
    toolRow(3, "EnterPlanMode"),
    toolRow(4, "EnterPlanMode", {
      status: "error",
      error: { code: "tool_execution_failed", message: "Mode switch rejected by runtime" },
    }),
    toolRow(5, "EnterPlanMode", {
      status: "cancelled",
      permissionDenial: { decision: "deny", reason: "Blocked while automation is running" },
    }),
    toolRow(6, "CreatePlan", {
      inputText: '{"title":"方案","overview":"概述","plan":"# 计划正文"}',
      input: { title: "方案", overview: "概述", plan: "# 计划正文" },
    }),
  ],
  fold: () => [
    headerRow("completedSuccess"),
    USER_ROW,
    toolRow(3, "Bash", {
      inputText: '{"description":"第一条 Bash","command":"pnpm lint"}',
      input: { description: "第一条 Bash", command: "pnpm lint" },
      output: { text: "lint ok" },
    }),
    toolRow(4, "JSVM", {
      inputText: '{"description":"运行沙盒计算","code":"return 6 * 7;"}',
      input: { description: "运行沙盒计算", code: "return 6 * 7;" },
      output: { text: "<console>sandbox output line</console>" },
    }),
    toolRow(5, "Bash", {
      inputText: '{"description":"第二条 Bash","command":"pnpm test"}',
      input: { description: "第二条 Bash", command: "pnpm test" },
      output: { text: "test ok" },
    }),
  ],
};

const CONTEXT = {
  sessionId: "sess-browser-process",
  logEpoch: "epoch-1",
  workspacePath: "/workspace",
  theme: "zai-light",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};

// 行渲染链会读平台与服务；隔离 fixture 只提供不会触达原生能力的空实现。
const PLATFORM = {
  onSettingsChanged: () => () => {},
  syncAppSettings: () => {},
};
const SERVICES = {
  broadcastService: { send: async () => ({}) },
  settingService: { get: async () => ({}), update: async () => ({}) },
  zcodeAgentService: { syncAppRuntimePreferences: async () => ({}) },
  fileService: { readMediaPreview: async () => ({ dataBase64: "", mimeType: "image/png" }) },
};

function Fixture() {
  const [scenario, setScenario] = useState("enter");
  const unit = useMemo(() => {
    const frame = buildConversationTurnRenderUnitFrame(SCENARIOS[scenario](), { nowMs: 1000 });
    return frame.entries[0]?.unit;
  }, [scenario]);
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ServiceProvider services={SERVICES}>
          <PlatformProvider platform={PLATFORM}>
            <main className="mx-auto w-full max-w-3xl p-4">
              <button data-testid="scenario-enter" onClick={() => setScenario("enter")}>enter</button>
              <button data-testid="scenario-fold" onClick={() => setScenario("fold")}>fold</button>
              {unit ? <ConversationTurnGroup unit={unit} context={CONTEXT} /> : null}
            </main>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

test(
  "独立浏览器验证 EnterPlanMode 普通工具行与 Bash→JSVM→Bash 过程折叠交互",
  { timeout: 120_000 },
  async (t) => {
    // 只使用测试自己的 Chromium；找不到就显式跳过，不连接运行中的应用。
    const loaded = await loadChromium();
    if (!loaded) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑过程折叠交互测试");
      return;
    }
    const { chromium, executablePath } = loaded;
    const [{ build }, { compile }] = await Promise.all([
      import("esbuild"),
      import("@tailwindcss/node"),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "ycode-process-browser-"));
    const errors: string[] = [];
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
          ".css": "empty",
          ".png": "dataurl",
          ".svg": "dataurl",
          ".webp": "dataurl",
          ".gif": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
          ".ttf": "dataurl",
          ".mp3": "dataurl",
          ".wav": "dataurl",
          ".ogg": "dataurl",
          ".m4a": "dataurl",
          ".mp4": "dataurl",
          ".webm": "dataurl",
        },
        plugins: [
          {
            name: "ui-source",
            setup(builder) {
              // Vite 风格的 `?url` 导入（如 pdf.js worker）在 esbuild 里没有默认导出：
              // 隔离 fixture 用空串替身，测试不加载这些运行时资源。
              builder.onResolve({ filter: /\?(?:url|raw)$/ }, () => ({
                path: "asset-url-stub",
                namespace: "asset-url-stub",
              }));
              builder.onLoad({ filter: /.*/, namespace: "asset-url-stub" }, () => ({
                contents: "export default '';",
                loader: "js",
              }));
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
        viewport: { width: 1000, height: 900 },
      });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
        await page.setContent(
          '<!doctype html><html><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });
        const turn = page.locator(`section[data-turn-id="turn-1"]`);
        await turn.waitFor({ state: "visible" }).catch(async (error: unknown) => {
          const body = await page.evaluate(() => document.body.innerText.slice(0, 1200));
          throw new Error(
            `时间线未渲染: ${(error as Error).message}\npage errors: ${errors.join(" | ")}\nbody: ${body}`,
          );
        });
        const row = (rowId: number) => page.locator(`[data-row-id="${rowId}"]`);
        // 工具行根节点带 content-visibility:auto，离屏时 innerText 可能为空；
        // 断言 DOM 文本用 textContent，视觉可见性另有单独断言。
        const rowText = (rowId: number) =>
          row(rowId).evaluate((element) => element.textContent ?? "");
        const historyTrigger = page.locator('[data-testid^="chat-assistant-history-trigger-"]');

        // 编译真实 Tailwind 类，保证展开后的盒模型与宽度行为接近应用内表现。
        const classes = await page.evaluate(() => [
          ...new Set(
            [...document.querySelectorAll("[class]")].flatMap((element) => [...element.classList]),
          ),
        ]);
        const sourceCss = await readFile(join(uiRoot, "src", "styles.css"), "utf8");
        const compiler = await compile(sourceCss, {
          base: join(uiRoot, "src"),
          onDependency: () => undefined,
        });
        await page.addStyleTag({ content: compiler.build(classes) });
        await page.addStyleTag({
          content:
            "html,body{margin:0;background:var(--color-background);color:var(--color-foreground)}",
        });

        // 完成态且没有最终正文时，工作段历史默认展开；若实现改了默认值则手动展开，
        // 本用例只关心行本身与折叠交互，不把历史折叠默认态当断言。
        if ((await historyTrigger.getAttribute("data-history-open")) === "false") {
          await historyTrigger.click();
        }
        await row(3).waitFor({ state: "visible" });

        // === 场景 1：EnterPlanMode 是普通工具调用行，不是计划审批卡 ===
        for (const statusLabel of ["已执行", "执行失败", "已拒绝"]) {
          await turn.getByText(statusLabel, { exact: false }).first().waitFor({ state: "visible" });
        }
        for (const rowId of [3, 4, 5]) {
          const text = await row(rowId).innerText();
          assert.match(text, /EnterPlanMode/, `row ${rowId} 应显示工具名`);
          assert.equal(
            await row(rowId)
              .locator('[data-testid="tool-summary-trigger-call-' + rowId + '"]')
              .count(),
            1,
            `row ${rowId} 应是可展开的普通工具行`,
          );
          assert.equal(
            await row(rowId).locator('[data-testid^="tool-summary-trigger"]').count(),
            1,
            `row ${rowId} 只能有一个工具摘要行`,
          );
        }
        assert.match(await row(3).innerText(), /已执行/);
        assert.match(await row(4).innerText(), /执行失败/);
        assert.match(await row(5).innerText(), /已拒绝/);
        for (const rowId of [3, 4, 5]) {
          const text = await row(rowId).innerText();
          assert.equal(text.includes("执行计划"), false, `row ${rowId} 不是计划卡`);
          assert.equal(text.includes("方案"), false, `row ${rowId} 不得吞入计划标题`);
        }

        // CreatePlan 仍然是唯一的计划卡：没有 ToolLayout 摘要触发器，标题与概述直接可见。
        const planRow = row(6);
        await planRow.waitFor({ state: "visible" });
        const planText = await planRow.innerText();
        assert.match(planText, /方案/);
        assert.match(planText, /概述/);
        assert.equal(
          await planRow.locator('[data-testid^="tool-summary-trigger"]').count(),
          0,
          "计划卡不是普通工具摘要行",
        );
        assert.equal(await page.getByText("方案", { exact: true }).count(), 1);

        // === 场景 2：Bash → JSVM → Bash 同一过程段 ===
        await page.getByTestId("scenario-fold").click();
        if ((await historyTrigger.getAttribute("data-history-open")) === "false") {
          await historyTrigger.click();
        }
        const processTrigger = page.locator('[data-testid^="tool-summary-trigger-process:"]');
        await processTrigger.waitFor({ state: "visible" });
        assert.equal(await processTrigger.count(), 1, "Bash/JSVM/Bash 只能折出一行过程行");
        assert.equal((await processTrigger.innerText()).trim(), "终端 2 次 · 沙盒 1 次");
        assert.equal(await processTrigger.getAttribute("aria-expanded"), "false");
        assert.equal(
          await page.locator('[data-testid="tool-summary-trigger-call-4"]').count(),
          0,
          "收起态不挂载沙盒卡内容",
        );

        await processTrigger.click();
        await processTrigger
          .and(page.locator('[aria-expanded="true"]'))
          .waitFor({ state: "visible" });
        for (const rowId of [3, 4, 5]) {
          await row(rowId).waitFor({ state: "visible" });
        }
        const [first, sandboxRow, second] = await Promise.all([
          row(3).boundingBox(),
          row(4).boundingBox(),
          row(5).boundingBox(),
        ]);
        assert.ok(first && sandboxRow && second);
        assert.ok(first.y < sandboxRow.y && sandboxRow.y < second.y, "展开后保持原始行序");
        assert.match(await rowText(3), /第一条 Bash/);
        assert.match(await rowText(4), /沙盒/);
        assert.match(await rowText(4), /运行沙盒计算/);
        assert.match(await rowText(5), /第二条 Bash/);
        assert.equal((await processTrigger.innerText()).trim(), "终端 2 次 · 沙盒 1 次");

        const sandboxTrigger = page.locator('[data-testid="tool-summary-trigger-call-4"]');
        assert.equal(await sandboxTrigger.count(), 1);
        await sandboxTrigger.click();
        await page.waitForFunction(() => {
          const element = document.querySelector('[data-row-id="4"]');
          const text = element?.textContent ?? "";
          return text.includes("return 6 * 7;") && text.includes("sandbox output line");
        });
        const sandboxText = await rowText(4);
        assert.match(sandboxText, /return 6 \* 7;/);
        assert.match(sandboxText, /sandbox output line/);

        // 桌面与手机宽度都保持可读、可展开，且不产生横向溢出。
        for (const width of [1000, 375]) {
          await page.setViewportSize({ width, height: 900 });
          await processTrigger.scrollIntoViewIfNeeded();
          assert.equal(await processTrigger.isVisible(), true, `${width}px 下过程行可见`);
          assert.match(await rowText(4), /return 6 \* 7;/);
          const overflow = await turn.evaluate(
            (element) => element.scrollWidth - element.clientWidth,
          );
          assert.ok(overflow <= 1, `${width}px 下时间线出现横向溢出: ${overflow}`);
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
