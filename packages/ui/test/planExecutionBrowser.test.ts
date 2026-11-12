import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

// 隔离浏览器回归：只启动本测试自己的 Chromium 与临时 profile，
// 不连接、不下载、不操作正在运行的 YCode，也不使用 CDP/DevTools 对现有应用。
//
// fixture 不复制计划卡渲染或执行顺序，而是挂载真实 owner 路径：
//   ConversationRow[] → buildConversationTurnRenderUnitFrame() → ConversationTurnGroup
// 点击真实计划卡的「执行计划」按钮后，走 SessionPane 同一个 executePlanSubmission
// （解析目标 → 同步切草稿 → 发送），发送侧用真实 createComposerSubmissionConfig
// 冻结 submission。断言的是提交载荷 mode，而不是另写一套平行 handler。
//
// 覆盖 docs/specs/plan-card-execute.md 规则 21-22 的浏览器侧行为：
//   Plan 内 Team 目标 → 提交 team；冷快照 → yolo；旧字段 yolo → yolo；
//   readonly 不恢复；Team 执行后再次点击旧卡仍是 Team；非 Plan 草稿优先级。

const sourcePath = (name: string) => JSON.stringify(join(uiRoot, "src", name).replace(/\\/g, "/"));

function fixtureSource(): string {
  return `
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildConversationTurnRenderUnitFrame } from ${sourcePath("v4/conversationTurnRenderUnits.ts")};
import { ConversationTurnGroup } from ${sourcePath("v4/ConversationTurnGroup.tsx")};
import { executePlanSubmission } from ${sourcePath("lib/planExecutionMode.ts")};
import { createComposerSubmissionConfig } from ${sourcePath("v4/composer/composerSubmissionConfig.ts")};
import { ZCodeIntlProvider } from ${sourcePath("i18n/IntlProvider.tsx")};
import { TooltipProvider } from ${sourcePath("components/ui/tooltip.tsx")};
import { PlatformProvider } from ${sourcePath("hooks/usePlatform.tsx")};
import { ServiceProvider } from ${sourcePath("hooks/useServices.tsx")};
import { DEFAULT_CODE_PREVIEW_SETTINGS } from ${sourcePath("lib/codePreviewSettings.ts")};

const TURN_ID = "turn-1";

// 真实提交配置需要一份可校验的模型视图；只用于让 createComposerSubmissionConfig
// 走通真实路径，不参与本用例断言。
const DRAFT_SELECTION = {
  providerId: "test-provider",
  modelId: "test-model",
  options: { reasoningLevel: "low" },
};
const MODEL_VIEW = {
  revision: 1,
  providers: [
    {
      providerId: "test-provider",
      providerName: "Test",
      templateId: "test-template",
      isPrimary: false,
      models: [
        {
          modelId: "test-model",
          config: { optionSpecs: { reasoningLevel: { values: ["low"] } } },
        },
      ],
    },
  ],
};

const SCENARIOS = {
  "plan-team": { snapshot: { mode: "plan", planExecuteMode: "team" }, draft: "plan" },
  "plan-cold": { snapshot: { mode: "plan" }, draft: "team" },
  "plan-legacy-yolo": { snapshot: { mode: "plan", planExecuteMode: "yolo" }, draft: "team" },
  "not-plan-readonly": { snapshot: { mode: "readonly" }, draft: "plan" },
  "not-plan-draft-yolo": { snapshot: { mode: "team" }, draft: "yolo" },
  "not-plan-draft-missing": { snapshot: { mode: "team" }, draft: undefined },
};

function headerRow() {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: TURN_ID,
    origin: "userInput",
    executionKind: "agent",
    state: "completedSuccess",
    startedAt: 1,
    endedAt: 2,
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

const PLAN_ROW = {
  kind: "toolCall",
  rowId: 3,
  turnId: TURN_ID,
  createdAt: 3,
  createdAtSeq: 3,
  toolCallId: "call-plan",
  toolName: "CreatePlan",
  status: "success",
  inputText: '{"title":"方案","overview":"概述","plan":"# 计划正文"}',
  input: { title: "方案", overview: "概述", plan: "# 计划正文" },
};

const CONTEXT = {
  sessionId: "sess-browser-plan-execute",
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
  const [scenario, setScenario] = useState("plan-team");
  const [snapshot, setSnapshot] = useState(SCENARIOS[scenario].snapshot);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [draftMode, setDraftMode] = useState(SCENARIOS[scenario].draft);
  const draftRef = useRef(draftMode);
  draftRef.current = draftMode;
  const [payload, setPayload] = useState("");
  const [events, setEvents] = useState([]);

  const unit = useMemo(() => {
    const frame = buildConversationTurnRenderUnitFrame(
      [headerRow(), USER_ROW, PLAN_ROW],
      { nowMs: 1000 },
    );
    return frame.entries[0]?.unit;
  }, []);

  const applyScenario = (name) => {
    const next = SCENARIOS[name];
    setScenario(name);
    setSnapshot(next.snapshot);
    snapshotRef.current = next.snapshot;
    setDraftMode(next.draft);
    draftRef.current = next.draft;
    setPayload("");
    setEvents([]);
  };

  // 模拟 runtime 接纳「执行计划」后离开 Plan：会话档变 Team，草稿保持 Team。
  const leavePlan = () => {
    const next = { mode: "team" };
    setSnapshot(next);
    snapshotRef.current = next;
  };

  const context = {
    ...CONTEXT,
    onExecutePlan: () => {
      executePlanSubmission({
        snapshotConfig: snapshotRef.current,
        draftMode: draftRef.current,
        switchMode: (mode) => {
          draftRef.current = mode;
          setDraftMode(mode);
          setEvents((current) => [...current, "switch:" + mode]);
        },
        sendText: () => {
          const submission = createComposerSubmissionConfig(
            { mode: draftRef.current, modelSelection: DRAFT_SELECTION },
            MODEL_VIEW,
          );
          setEvents((current) => [...current, "send:" + draftRef.current]);
          setPayload(JSON.stringify({ mode: submission ? submission.mode : null }));
        },
      });
    },
  };

  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ServiceProvider services={SERVICES}>
          <PlatformProvider platform={PLATFORM}>
            <main className="mx-auto w-full max-w-3xl p-4">
              {Object.keys(SCENARIOS).map((name) => (
                <button key={name} data-testid={"scenario-" + name} onClick={() => applyScenario(name)}>
                  {name}
                </button>
              ))}
              <button data-testid="runtime-left-plan" onClick={leavePlan}>runtime-left-plan</button>
              <div data-testid="draft-mode">{String(draftMode)}</div>
              <div data-testid="events">{JSON.stringify(events)}</div>
              <pre data-testid="payload">{payload}</pre>
              {unit ? <ConversationTurnGroup unit={unit} context={context} /> : null}
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
  "独立浏览器验证计划卡执行目标的提交 mode（Team / 冷快照 / 旧卡 / readonly / 草稿优先级）",
  { timeout: 120_000 },
  async (t) => {
    // 只使用测试自己的 Chromium；找不到就显式跳过，不连接运行中的应用。
    const loaded = await loadChromium();
    if (!loaded) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑计划执行回归");
      return;
    }
    const { chromium, executablePath } = loaded;
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-plan-execute-browser-"));
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
          ".svg": "dataurl",
          ".png": "dataurl",
          ".jpg": "dataurl",
          ".webp": "dataurl",
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
          '<!doctype html><html class="theme-zai-light"><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });

        const planRow = page.locator('[data-row-id="3"]');
        await planRow.waitFor({ state: "visible" }).catch(async (error: unknown) => {
          const body = await page.evaluate(() => document.body.innerText.slice(0, 1200));
          throw new Error(
            `计划卡未渲染: ${(error as Error).message}\npage errors: ${errors.join(" | ")}\nbody: ${body}`,
          );
        });
        // 确认挂载的是真实计划卡，「执行计划」来自卡片底部按钮。
        assert.match(await planRow.innerText(), /方案/);
        assert.match(await planRow.innerText(), /概述/);
        const executeButton = planRow.getByRole("button", { name: "执行计划" });
        const readPayload = async () => JSON.parse(await page.getByTestId("payload").innerText());
        const readEvents = async () =>
          JSON.parse(await page.getByTestId("events").innerText());
        const readDraft = async () => (await page.getByTestId("draft-mode").innerText()).trim();
        const run = async (scenario: string) => {
          await page.getByTestId(`scenario-${scenario}`).click();
          await executeButton.click();
        };

        // Plan 内 Team 目标：提交 team，先切档后发送，顺序在同一同步栈。
        await executeButton.click();
        assert.deepEqual(await readPayload(), { mode: "team" });
        assert.deepEqual(await readEvents(), ["switch:team", "send:team"]);
        assert.equal(await readDraft(), "team");

        // 重复点击旧卡：runtime 已离开 Plan（会话 Team、草稿 Team），仍提交 team，不降 Agent。
        await page.getByTestId("runtime-left-plan").click();
        await executeButton.click();
        assert.deepEqual(await readPayload(), { mode: "team" });
        assert.ok(!(await readEvents()).includes("switch:yolo"));

        // 冷快照：Plan 内 planExecuteMode 缺席按 yolo，忽略草稿里的 team。
        await run("plan-cold");
        assert.deepEqual(await readPayload(), { mode: "yolo" });
        assert.deepEqual(await readEvents(), ["switch:yolo", "send:yolo"]);

        // 旧字段显式 yolo：仍按快照权威 yolo。
        await run("plan-legacy-yolo");
        assert.deepEqual(await readPayload(), { mode: "yolo" });

        // 非 Plan + 草稿 plan：回退会话档；readonly 不恢复，最终 yolo。
        await run("not-plan-readonly");
        assert.deepEqual(await readPayload(), { mode: "yolo" });
        assert.equal(await readDraft(), "yolo");

        // 非 Plan 草稿 yolo 优先于会话 Team。
        await run("not-plan-draft-yolo");
        assert.deepEqual(await readPayload(), { mode: "yolo" });

        // 非 Plan 草稿缺失：回退会话 Team。
        await run("not-plan-draft-missing");
        assert.deepEqual(await readPayload(), { mode: "team" });

        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
