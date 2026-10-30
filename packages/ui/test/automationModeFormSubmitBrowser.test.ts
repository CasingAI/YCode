import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

// 这里挂载两个真实表单（而不是独立的 helper 控件），覆盖「选择档位 → 点击保存 → onSubmit 载荷」。
// useModelSelectionView 用本地 stub 提供一份 ready 的模型视图，避免测试连接任何 Host 或浏览器扩展。

const sourcePath = (name: string) => JSON.stringify(join(uiRoot, "src", name).replace(/\\/g, "/"));

function modelSelectionStub(): string {
  return `
export const MODEL_SELECTION_VIEW = {
  revision: 1,
  providers: [
    {
      providerId: "glm",
      providerName: "GLM",
      config: { api: { type: "openai-completions" } },
      models: [
        {
          modelId: "m1",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
      ],
    },
  ],
  preferredSelection: { providerId: "glm", modelId: "m1", options: { reasoningLevel: "high" } },
  effectiveSelection: { providerId: "glm", modelId: "m1", options: { reasoningLevel: "high" } },
};

export function useModelSelectionView() {
  return {
    state: { status: "ready", view: MODEL_SELECTION_VIEW },
    selectionFresh: true,
    reload() {},
  };
}
`;
}

function fixtureSource(): string {
  return `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AutomationEditView } from ${sourcePath("settings/AutomationEditView.tsx")};
import { OffPeakEditView } from ${sourcePath("settings/OffPeakEditView.tsx")};
import { MODEL_SELECTION_VIEW } from "@/hooks/useModelSelectionView.js";
import { ZCodeIntlProvider } from ${sourcePath("i18n/IntlProvider.tsx")};
import { TooltipProvider } from ${sourcePath("components/ui/tooltip.tsx")};
import { ServiceProvider } from ${sourcePath("hooks/useServices.tsx")};
import { PlatformProvider } from ${sourcePath("hooks/usePlatform.tsx")};
import { TabStoreProvider, useTabStore } from ${sourcePath("store/TabStoreProvider.tsx")};

const WORKSPACE = "/tmp/automation-mode-project";
const MODEL_SELECTION = { providerId: "glm", modelId: "m1", options: { reasoningLevel: "high" } };

const automationBase = {
  automationId: "automation-1",
  title: "历史定时任务",
  prompt: "整理今天的提交",
  cronExpr: "0 9 * * *",
  scheduleType: "scheduled",
  enabled: true,
  lifecycleStatus: "active",
  workspacePath: WORKSPACE,
  workspaceKey: WORKSPACE,
  modelSelection: MODEL_SELECTION,
};

const AUTOMATIONS = {
  team: { ...automationBase, mode: "team" },
  plan: { ...automationBase, mode: "plan" },
  null: { ...automationBase, mode: null },
};

const offPeakBase = {
  offPeakTaskId: "offpeak-1",
  title: "历史闲时任务",
  prompt: "整理今天的提交",
  status: "queued",
  workspacePath: WORKSPACE,
  modelSelection: MODEL_SELECTION,
};

const OFF_PEAK_TASKS = {
  team: { ...offPeakBase, permissionMode: "team" },
  plan: { ...offPeakBase, permissionMode: "plan" },
  null: { ...offPeakBase, permissionMode: null },
};

const noop = () => undefined;
const services = {
  settingService: {
    get: async () => ({}),
    update: async () => ({}),
  },
  broadcastService: { send: async () => ({}) },
  zcodeAgentService: { syncAppRuntimePreferences: async () => ({}) },
};
const platform = {
  onSettingsChanged: () => () => {},
  syncAppSettings: () => {},
};

function Harness() {
  const ensureWorkspaceTab = useTabStore((state) => state.ensureWorkspaceTab);
  const [scenario, setScenario] = useState("create");
  const [log, setLog] = useState([]);

  useEffect(() => {
    ensureWorkspaceTab(WORKSPACE);
    // 只在本测试自己的 Chromium 中注册本地 workspace，供表单的新建态选择项目。
  }, [ensureWorkspaceTab]);

  const isEditing = scenario !== "create";
  const record = (entry) => setLog((current) => [...current, entry]);
  const submitAutomation = async ({ input }) => {
    record({ form: "automation", mode: "mode" in input ? input.mode : "<omitted>" });
    return true;
  };
  const submitOffPeak = async (input) => {
    record({
      form: "offpeak",
      permissionMode: "permissionMode" in input ? input.permissionMode : "<omitted>",
    });
    return true;
  };

  return <main className="flex flex-col gap-6 p-4">
    <div className="flex flex-wrap gap-2">
      {["create", "team", "plan", "null"].map((name) => (
        <button key={name} data-testid={"scenario-" + name} onClick={() => setScenario(name)}>
          {name}
        </button>
      ))}
    </div>
    <section data-testid="automation-form">
      <AutomationEditView
        key={scenario}
        editing={isEditing ? AUTOMATIONS[scenario] : null}
        scheduleType="scheduled"
        initialDraft={{ title: "新建任务", cronExpr: "0 9 * * *", prompt: "整理今天的提交" }}
        defaultWorkspacePath={WORKSPACE}
        saving={false}
        onSubmit={submitAutomation}
        onBack={noop}
      />
    </section>
    <section data-testid="offpeak-form">
      <OffPeakEditView
        key={scenario}
        editing={isEditing ? OFF_PEAK_TASKS[scenario] : null}
        initialDraft={{ title: "新建闲时任务", prompt: "整理今天的提交" }}
        modelSelectionView={MODEL_SELECTION_VIEW}
        defaultWorkspacePath={WORKSPACE}
        saving={false}
        onBack={noop}
        onSubmit={submitOffPeak}
      />
    </section>
    <pre data-testid="log">{JSON.stringify(log)}</pre>
  </main>;
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="zh-CN"><TooltipProvider>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <TabStoreProvider><Harness /></TabStoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  </TooltipProvider></ZCodeIntlProvider>,
);
`;
}

test(
  "真实自动化表单从档位选择到保存载荷：默认 yolo、Team 保留、历史值不脏写",
  { timeout: 120_000 },
  async (t) => {
    // 只启动本测试自己的 Chromium 与临时 profile，不连接或操作正在运行的 YCode。
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑真实表单提交测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const [{ build }, { compile }] = await Promise.all([
      import("esbuild"),
      import("@tailwindcss/node"),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "ycode-automation-mode-form-"));
    const modelSelectionPath = join(directory, "useModelSelectionView.ts");
    try {
      const entry = join(directory, "entry.tsx");
      const bundle = join(directory, "fixture.js");
      await Promise.all([
        writeFile(entry, fixtureSource()),
        writeFile(modelSelectionPath, modelSelectionStub()),
      ]);
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
                // 真实表单只通过这个 hook 读取模型候选；stub 让表单在不启动 Host 时可提交。
                if (args.path === "@/hooks/useModelSelectionView.js") {
                  return { path: modelSelectionPath };
                }
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
        viewport: { width: 1080, height: 1400 },
      });
      try {
        const page = await context.newPage();
        // 关闭滚动标签动画，避免 AnimatePresence 在断言瞬间同时保留新旧两个文本。
        await page.emulateMedia({ reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html class="theme-zai-light"><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });

        const automationForm = page.getByTestId("automation-form");
        const offPeakForm = page.getByTestId("offpeak-form");
        const automationTrigger = automationForm.getByTestId("chat-mode-select-trigger");
        const offPeakTrigger = offPeakForm.getByTestId("chat-mode-select-trigger");
        const automationSubmit = automationForm.getByTestId("automation-form-submit");
        const offPeakSubmit = offPeakForm.getByTestId("offpeak-edit-submit");

        const classNames = await page.evaluate(() => [
          ...new Set(
            [...document.querySelectorAll("[class]")].flatMap((element) => [...element.classList]),
          ),
        ]);
        const sourceCss = await readFile(join(uiRoot, "src", "styles.css"), "utf8");
        const compiler = await compile(sourceCss, {
          base: join(uiRoot, "src"),
          onDependency: () => undefined,
        });
        await page.addStyleTag({ content: compiler.build(classNames) });
        await page.addStyleTag({
          content:
            "html,body{margin:0;background:var(--color-background);color:var(--color-foreground)}*{transition:none!important;animation:none!important}",
        });

        const waitForEnabled = async (locator: typeof automationSubmit) => {
          for (let index = 0; index < 100; index += 1) {
            if (await locator.isEnabled()) return;
            await page.waitForTimeout(50);
          }
          throw new Error("表单保存按钮在超时前仍未可用");
        };
        const waitForTrigger = async (locator: typeof automationTrigger, expected: string) => {
          for (let index = 0; index < 100; index += 1) {
            const text = (await locator.textContent())?.trim() ?? "";
            if (text === expected) return;
            await page.waitForTimeout(50);
          }
          throw new Error(`档位触发器未显示 ${expected}`);
        };
        const readLog = async (): Promise<Array<Record<string, string>>> =>
          JSON.parse((await page.getByTestId("log").textContent()) ?? "[]");
        const waitForLogCount = async (count: number) => {
          await page.waitForFunction(
            (expected: number) => {
              const element = document.querySelector('[data-testid="log"]');
              return Boolean(element && JSON.parse(element.textContent ?? "[]").length >= expected);
            },
            count,
            { timeout: 10_000 },
          );
        };
        const submitBoth = async (countAfter: number) => {
          await waitForEnabled(automationSubmit);
          await waitForEnabled(offPeakSubmit);
          await automationSubmit.click();
          await offPeakSubmit.click();
          await waitForLogCount(countAfter);
        };
        const selectMode = async (trigger: typeof automationTrigger, mode: "yolo" | "team") => {
          await trigger.click();
          await page.getByTestId(`chat-mode-select-item-${mode}`).click();
        };

        // 新建默认 Agent：不碰档位直接保存，两个真实表单都在创建载荷里显式带 yolo。
        await waitForTrigger(automationTrigger, "Agent");
        await waitForTrigger(offPeakTrigger, "Agent");
        await submitBoth(2);
        assert.deepEqual(await readLog(), [
          { form: "automation", mode: "yolo" },
          { form: "offpeak", permissionMode: "yolo" },
        ]);

        // 新建时显式选择 Team，保存载荷跟随选择。
        await selectMode(automationTrigger, "team");
        await waitForTrigger(automationTrigger, "Team");
        await selectMode(offPeakTrigger, "team");
        await waitForTrigger(offPeakTrigger, "Team");
        await submitBoth(4);
        assert.deepEqual((await readLog()).slice(2), [
          { form: "automation", mode: "team" },
          { form: "offpeak", permissionMode: "team" },
        ]);

        // 编辑已有 Team 且不碰选择器：更新载荷省略档位，避免无关编辑迁移历史值。
        await page.getByTestId("scenario-team").click();
        await waitForTrigger(automationTrigger, "Team");
        await waitForTrigger(offPeakTrigger, "Team");
        await submitBoth(6);
        assert.deepEqual((await readLog()).slice(4), [
          { form: "automation", mode: "<omitted>" },
          { form: "offpeak", permissionMode: "<omitted>" },
        ]);

        // 历史 plan / NULL 仅展示回退 Agent，未触碰选择器时同样不写回。
        for (const [scenario, expectedIndex] of [
          ["plan", 8],
          ["null", 10],
        ] as const) {
          await page.getByTestId(`scenario-${scenario}`).click();
          await waitForTrigger(automationTrigger, "Agent");
          await waitForTrigger(offPeakTrigger, "Agent");
          await submitBoth(expectedIndex);
          assert.deepEqual((await readLog()).slice(expectedIndex - 2), [
            { form: "automation", mode: "<omitted>" },
            { form: "offpeak", permissionMode: "<omitted>" },
          ]);
        }

        // 编辑时显式改成 Agent：只有用户实际改过的字段才进入更新载荷。
        await page.getByTestId("scenario-team").click();
        await waitForTrigger(automationTrigger, "Team");
        await waitForTrigger(offPeakTrigger, "Team");
        await selectMode(automationTrigger, "yolo");
        await waitForTrigger(automationTrigger, "Agent");
        await selectMode(offPeakTrigger, "yolo");
        await waitForTrigger(offPeakTrigger, "Agent");
        await submitBoth(12);
        assert.deepEqual((await readLog()).slice(10), [
          { form: "automation", mode: "yolo" },
          { form: "offpeak", permissionMode: "yolo" },
        ]);

        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
