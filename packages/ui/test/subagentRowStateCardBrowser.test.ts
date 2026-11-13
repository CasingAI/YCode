import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

// 独立浏览器验证未配对 SubagentRow 状态卡的点击级行为：
// 有 childSessionId + 宿主回调时，真实点击打开既有 subagent-session 请求；
// 只读（无回调）与缺身份时不可点，但标题与状态照常渲染。
// 只启动测试自己的 Chromium 与临时 profile，不连接、不注入、不操作正在运行的 YCode。

const AGENT_ID = "agent_470ab270-ee39-421b-b722-221dc8a31835";
const CHILD_SESSION_ID = "sess_child_001";
const TITLE = "复核 Description 截断改动";

const sourcePath = (name: string) => JSON.stringify(join(uiRoot, "src", name).replace(/\\/g, "/"));

function fixtureSource(): string {
  return `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationRowView } from ${sourcePath("v4/ConversationRowView.tsx")};
import { ZCodeIntlProvider } from ${sourcePath("i18n/IntlProvider.tsx")};
import { TooltipProvider } from ${sourcePath("components/ui/tooltip.tsx")};
import { DEFAULT_CODE_PREVIEW_SETTINGS } from ${sourcePath("lib/codePreviewSettings.ts")};

const AGENT_ID = ${JSON.stringify(AGENT_ID)};
const CHILD_SESSION_ID = ${JSON.stringify(CHILD_SESSION_ID)};
const TITLE = ${JSON.stringify(TITLE)};

globalThis.__opens = [];
globalThis.__sendOpens = [];

// 三个场景共用同一行的可见内容，只切换宿主注入面与 childSessionId。
const SCENARIOS = {
  interactive: { childSessionId: CHILD_SESSION_ID, withCallback: true },
  readonly: { childSessionId: CHILD_SESSION_ID, withCallback: false },
  missingChild: { childSessionId: undefined, withCallback: true },
};

// 会话身份可解析但标题索引没有目标标题：卡片与打开请求都走本地化目标名。
function SendMessageFixture() {
  const row = {
    kind: "toolCall",
    rowId: 77,
    turnId: "turn-1",
    entityId: "tool_send_message_1",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "send-message-row",
    toolName: "SendMessage",
    status: "success",
    inputText: "{}",
    input: { to: AGENT_ID, summary: "补充上下文", message: "继续检查" },
  };
  const context = {
    workspacePath: "/workspace",
    theme: "system",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    sessionId: "sess_parent_001",
    rootSessionId: "sess_parent_001",
    agentTitleByIdentity: new Map(),
    agentSessionByIdentity: new Map([
      [AGENT_ID, { childSessionId: CHILD_SESSION_ID, subagentType: "codeReview" }],
    ]),
    onOpenSubagentSession: (request) => {
      globalThis.__sendOpens.push(request);
    },
  };
  return <ConversationRowView row={row} context={context} />;
}

function Fixture() {
  const [scenario, setScenario] = useState("interactive");
  const config = SCENARIOS[scenario];
  const row = {
    kind: "subagent",
    rowId: 7,
    turnId: "turn-1",
    entityId: AGENT_ID,
    subagentType: "general-purpose",
    status: "running",
    summaryText: "",
    createdAt: 1,
    createdAtSeq: 1,
    ...(config.childSessionId ? { childSessionId: config.childSessionId } : {}),
  };
  const context = {
    workspacePath: "/workspace",
    theme: "system",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    sessionId: "sess_parent_001",
    rootSessionId: "sess_parent_001",
    agentTitleByIdentity: new Map([[AGENT_ID, TITLE]]),
    ...(config.withCallback
      ? {
          onOpenSubagentSession: (request) => {
            globalThis.__opens.push(request);
          },
        }
      : {}),
  };
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <main className="mx-auto w-full max-w-3xl p-4">
          <button data-testid="scenario-interactive" onClick={() => setScenario("interactive")}>interactive</button>
          <button data-testid="scenario-readonly" onClick={() => setScenario("readonly")}>readonly</button>
          <button data-testid="scenario-missing-child" onClick={() => setScenario("missingChild")}>missing</button>
          <ConversationRowView row={row} context={context} />
          <SendMessageFixture />
        </main>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
`;
}

test(
  "未配对 SubagentRow 状态卡：真实点击打开既有子会话侧栏，只读与缺身份不可点",
  { timeout: 120_000 },
  async (t) => {
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑未配对子代理行交互测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-subagent-state-card-"));
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
          ".svg": "dataurl",
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".webp": "dataurl",
          ".woff": "dataurl",
          ".woff2": "dataurl",
          ".ttf": "dataurl",
          ".mp3": "dataurl",
          ".wav": "dataurl",
        },
        plugins: [
          {
            name: "ui-source",
            setup(builder) {
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
        viewport: { width: 1000, height: 800 },
      });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });

        const card = page.locator('[data-row-id="7"]');
        await card.waitFor({ state: "visible", timeout: 15_000 });

        await t.test("卡片显示本地化状态与索引标题，不出现裸英文类型行", async () => {
          const text = await card.evaluate((element) => element.textContent ?? "");
          assert.match(text, /子智能体/);
          assert.match(text, new RegExp(TITLE));
          assert.match(text, /运行中/);
          assert.equal(text.includes(AGENT_ID), false);
          assert.equal(text.includes("general-purpose · running"), false);
        });

        await t.test("点击整行打开既有子会话侧栏请求，标题与卡片一致", async () => {
          const action = card.locator(
            `[data-testid="v4-subagent-open-side-pane-${CHILD_SESSION_ID}"]`,
          );
          await action.waitFor({ state: "visible", timeout: 5_000 });
          assert.equal(await action.getAttribute("role"), "button");
          await action.click();
          const opens = await page.evaluate(() => globalThis.__opens);
          assert.equal(opens.length, 1, "一次点击只能打开一次");
          const [request] = opens;
          assert.equal(request.childSessionId, CHILD_SESSION_ID);
          assert.equal(request.parentSessionId, "sess_parent_001");
          assert.equal(request.rootSessionId, "sess_parent_001");
          assert.equal(request.subagentType, "general-purpose");
          assert.equal(request.title, TITLE);
        });

        await t.test("键盘 Enter 与 Space 同样触发打开", async () => {
          await page.evaluate(() => {
            globalThis.__opens.length = 0;
          });
          const action = card.locator(
            `[data-testid="v4-subagent-open-side-pane-${CHILD_SESSION_ID}"]`,
          );
          await action.focus();
          await page.keyboard.press("Enter");
          await page.keyboard.press(" ");
          const opens = await page.evaluate(() => globalThis.__opens);
          assert.equal(opens.length, 2, "Enter 与 Space 各打开一次");
        });

        await t.test("只读视图无回调时不可点，但状态仍可见", async () => {
          await page.evaluate(() => {
            globalThis.__opens.length = 0;
          });
          await page.getByTestId("scenario-readonly").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid^="v4-subagent-open-side-pane-"]') === null,
          );
          const text = await card.evaluate((element) => element.textContent ?? "");
          assert.match(text, /运行中/);
          assert.match(text, new RegExp(TITLE));
          await card.click();
          const opens = await page.evaluate(() => globalThis.__opens);
          assert.equal(opens.length, 0, "只读视图点击不得打开侧栏");
        });

        await t.test("缺 childSessionId 时不可点且状态仍渲染", async () => {
          await page.evaluate(() => {
            globalThis.__opens.length = 0;
          });
          await page.getByTestId("scenario-missing-child").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid^="v4-subagent-open-side-pane-"]') === null,
          );
          const text = await card.evaluate((element) => element.textContent ?? "");
          assert.match(text, /运行中/);
          await card.click();
          const opens = await page.evaluate(() => globalThis.__opens);
          assert.equal(opens.length, 0, "无身份时点击不得打开侧栏");
        });

        await t.test("SendMessage 无索引标题时卡片与打开请求都使用本地化目标名", async () => {
          const sendCard = page.locator('[data-row-id="77"]');
          await sendCard.waitFor({ state: "visible", timeout: 10_000 });
          const text = await sendCard.evaluate((element) => element.textContent ?? "");
          assert.match(text, /目标子智能体/);
          assert.equal(text.includes("codeReview"), false);
          assert.equal(text.includes(AGENT_ID), false);

          await sendCard
            .locator(`[data-testid="v4-send-message-open-side-pane-${CHILD_SESSION_ID}"]`)
            .click();
          const opens = await page.evaluate(() => globalThis.__sendOpens);
          assert.equal(opens.length, 1, "一次点击只能打开一次");
          const [request] = opens;
          assert.equal(request.title, "目标子智能体");
          assert.equal(request.subagentType, "codeReview");
          assert.equal(request.childSessionId, CHILD_SESSION_ID);
          assert.equal(request.parentSessionId, "sess_parent_001");
        });

        assert.deepEqual(errors, [], "页面不得抛错");
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
